import { Client, Events, GatewayIntentBits, Message } from "discord.js";
import { logger } from "@/utils/logger.ts";
import { ChatSession, getChatSession } from "@/chat/session.ts";
import { getAgent } from "@/config/agentConfig.ts";
import { createConversation, getConversation } from "@/llm/conversation.ts";

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

  const agent = await getAgent(agentName);

  const sessions = new Map<
    string,
    ChatSession
  >();

  async function handle(message: Message<true>) {
    const channel = message.channel;
    if (!channel.isSendable()) return;

    await channel.sendTyping();
    const typing = setInterval(
      () => channel.sendTyping().catch(() => {}),
      TYPING_REFRESH_MS,
    );

    let sending = Promise.resolve();
    let text = "";

    try {
      let session = sessions.get(message.channel.id);
      if (!session) {
        logger.debug(
          `Cache miss for channel ${message.channel.id}`,
        );
        let conversation = await getConversation(
          "discord",
          message.channel.id,
          options?.messageCount,
        );
        if (!conversation) {
          conversation = await createConversation(
            message.channel.name || "Discord Conversation",
            "discord",
            message.channel.id,
          );
          logger.info(
            `Created new conversation: ${conversation.name} (${conversation.id})`,
          );
        }

        session = await getChatSession(agent, conversation, "discord");
        sessions.set(message.channel.id, session);
      }

      await session.send(message.content, {
        onEvent: (event) => {
          switch (event.type) {
            case "chunk":
              text += event.text;
              break;
            case "turnStart":
              text = "";
              break;
            case "turnEnd": {
              const reply = text.trim();
              if (!reply) break;
              sending = sending.then(async () => {
                for (const part of splitMessage(reply)) {
                  await channel.send(part);
                }
              });
              break;
            }
            case "titleChanged":
              // Not awaited: renames are limited to 2 per 10 minutes per channel
              channel.setName(event.title).catch((err) =>
                logger.error(`Failed to rename channel: ${err}`)
              );
              break;
          }
        },
      });
    } finally {
      clearInterval(typing);
      await sending;
    }
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // Handle one message at a time so turns never interleave
  let queue = Promise.resolve();

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;
    if (message.author.id !== ownerId) return;
    if (!message.inGuild() || !message.channel.isTextBased()) return;

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
