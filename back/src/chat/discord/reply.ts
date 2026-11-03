import { GuildTextBasedChannel } from "discord.js";
import { logger } from "@/utils/logger.ts";
import { ChatAdapter } from "@/chat/session.ts";
import { AgentEvent } from "@/agent/events.ts";

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
// Call start() before the run, and done() once it's over to stop typing and
// wait for the sends.
export class DiscordReply implements ChatAdapter {
  private text = "";
  private sending = Promise.resolve();
  private typing?: ReturnType<typeof setInterval>;

  constructor(private channel: GuildTextBasedChannel) {}

  async start() {
    await this.channel.sendTyping();
    this.typing = setInterval(
      () => this.channel.sendTyping().catch(() => {}),
      TYPING_REFRESH_MS,
    );
  }

  onEvent(event: AgentEvent) {
    switch (event.type) {
      case "chunk":
        this.text += event.text;
        break;
      case "turnStart":
        this.text = "";
        break;
      case "turnEnd":
        this.sendText();
        break;
      case "titleChanged":
        this.rename(event.title);
        break;
    }
  }

  async done() {
    clearInterval(this.typing);
    await this.sending;
  }

  private sendText() {
    const reply = this.text.trim();
    if (!reply) return;
    this.sending = this.sending.then(async () => {
      for (const part of splitMessage(reply)) {
        await this.channel.send(part);
      }
    });
  }

  private rename(title: string) {
    // Not awaited: renames are limited to 2 per 10 minutes per channel
    this.channel.setName(title).catch((err) =>
      logger.error(`Failed to rename channel: ${err}`)
    );
  }
}
