import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
} from "discord.js";
import { getAgent } from "@/config/agentConfig.ts";
import { logger } from "@/utils/logger.ts";
import { getOpenAIClient } from "@/llm/provider.ts";
import { createConversation, getLastConversation } from "@/llm/conversation.ts";
import { createUserMessage, toModelMessage } from "@/llm/message.ts";
import { generateToolRequest } from "@/tools/tool.ts";
import { runAgent } from "@/agent/agent.ts";

const tools = generateToolRequest();

const DISCORD_MAX_LENGTH = 2000;
// Discord shows "typing…" for about 10 seconds per call
const TYPING_REFRESH_MS = 8000;

function splitMessage(text: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += DISCORD_MAX_LENGTH) {
    parts.push(text.slice(i, i + DISCORD_MAX_LENGTH));
  }
  return parts;
}

export async function discordChat(
  agentName: string,
  options?: { messageCount?: number },
) {
  const token = Deno.env.get("DISCORD_TOKEN");
  const ownerId = Deno.env.get("DISCORD_OWNER_ID");
  if (!token || !ownerId) {
    throw new Error("DISCORD_TOKEN and DISCORD_OWNER_ID must be set");
  }

  const agentConfig = await getAgent(agentName);
  logger.info(`Loaded agent config: ${agentConfig.name}`);

  const provider = agentConfig.provider;
  logger.info(`Using provider: ${provider.name} (${provider.id})`);

  let conversation = await getLastConversation(options?.messageCount);
  logger.info(`Using conversation: ${conversation.name} (${conversation.id})`);
  const openai = await getOpenAIClient(provider);
  const messages = conversation.messages.reverse().map((msg) =>
    toModelMessage(msg)
  ).flat();

  async function handle(message: Message) {
    const channel = message.channel;
    if (!channel.isSendable()) return;

    if (message.content.trim().toLowerCase() === "/new") {
      conversation = await createConversation("Discord Conversation");
      messages.length = 0;
      logger.info(
        `Created new conversation: ${conversation.name} (${conversation.id})`,
      );
      await channel.send("Started a new conversation.");
      return;
    }

    const msg = await createUserMessage(message.content, conversation.id);
    messages.push(...toModelMessage(msg));

    await channel.sendTyping();
    const typing = setInterval(
      () => channel.sendTyping().catch(() => {}),
      TYPING_REFRESH_MS,
    );

    let text = "";
    let sending = Promise.resolve();
    try {
      await runAgent({
        openai,
        agentConfig,
        tools,
        messages,
        conversationId: conversation.id,
        trigger: "discord",
        provider,
        streamHandler: (chunk) => {
          text += chunk;
        },
        onTurnStart: () => {
          text = "";
        },
        onTurnEnd: () => {
          const reply = text.trim();
          if (!reply) return;
          sending = sending.then(async () => {
            for (const part of splitMessage(reply)) {
              await channel.send(part);
            }
          });
        },
      });
    } finally {
      clearInterval(typing);
      await sending;
    }
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    // DM channels aren't cached until first use, so allow partial ones
    partials: [Partials.Channel],
  });

  // Handle one message at a time so turns never interleave
  let queue = Promise.resolve();

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;
    if (message.author.id !== ownerId) return;
    if (!message.channel.isDMBased()) return;

    queue = queue.then(() => handle(message)).catch((err) => {
      logger.error(`Failed to handle Discord message: ${err}`);
      if (message.channel.isSendable()) {
        message.channel.send("Something went wrong, check the logs.").catch(
          () => {},
        );
      }
    });
  });

  client.once(Events.ClientReady, (ready) => {
    logger.info(`Logged in to Discord as ${ready.user.tag}`);
  });

  await client.login(token);
}
