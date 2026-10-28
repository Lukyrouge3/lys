import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
} from "discord.js";
import { logger } from "@/utils/logger.ts";
import { createChatSession } from "@/chat/session.ts";

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

  const session = await createChatSession(agentName, {
    trigger: "discord",
    conversationName: "Discord Conversation",
    messageCount: options?.messageCount,
  });

  async function handle(message: Message) {
    const channel = message.channel;
    if (!channel.isSendable()) return;

    if (message.content.trim().toLowerCase() === "/new") {
      await session.newConversation();
      await channel.send("Started a new conversation.");
      return;
    }

    await channel.sendTyping();
    const typing = setInterval(
      () => channel.sendTyping().catch(() => {}),
      TYPING_REFRESH_MS,
    );

    let text = "";
    let sending = Promise.resolve();
    try {
      await session.send(message.content, {
        onChunk: (chunk) => {
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
