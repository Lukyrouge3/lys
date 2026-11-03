import { GuildTextBasedChannel } from "discord.js";
import { logger } from "@/utils/logger.ts";
import { ChatAdapter } from "@/chat/session.ts";

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

// Shows "typing…" while the agent runs and sends its text at each turn end.
// Call done() once the run is over to stop typing and wait for the sends.
export async function createReply(
  channel: GuildTextBasedChannel,
): Promise<ChatAdapter & { done: () => Promise<void> }> {
  await channel.sendTyping();
  const typing = setInterval(
    () => channel.sendTyping().catch(() => {}),
    TYPING_REFRESH_MS,
  );

  let sending = Promise.resolve();
  let text = "";

  return {
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
    async done() {
      clearInterval(typing);
      await sending;
    },
  };
}
