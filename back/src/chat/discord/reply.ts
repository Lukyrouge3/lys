import { GuildTextBasedChannel } from "discord.js";
import { Buffer } from "node:buffer";
import { logger } from "@/utils/logger.ts";
import { ChatAdapter } from "@/chat/session.ts";
import { AgentEvent } from "@/agent/events.ts";
import { buildApprovalRequest } from "@/chat/discord/approval.ts";

const DISCORD_MAX_LENGTH = 2000;
// Discord shows "typing…" for about 10 seconds per call
const TYPING_REFRESH_MS = 8000;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type Fence = { start: number; end: number; lang: string };

/** The code fences in the text, with UTF-16 offsets of their markers. */
function fences(text: string): Fence[] {
  const result: Fence[] = [];
  let open: { start: number; lang: string } | null = null;
  for (const match of text.matchAll(/^```(.*)$/gm)) {
    if (!open) {
      open = { start: match.index, lang: match[1].trim().slice(0, 20) };
      continue;
    }
    result.push({
      start: open.start,
      end: match.index + match[0].length,
      lang: open.lang,
    });
    open = null;
  }
  return result;
}

/**
 * Splits on grapheme clusters, so an emoji or a surrogate pair is never cut in
 * half, and every chunk stays within Discord's 2000 UTF-16 code units.
 * Best effort for code blocks: when a split lands inside a fence, the chunk is
 * closed and the next one reopens it, so the markdown stays readable.
 */
export function splitMessage(text: string): string[] {
  const ranges = fences(text);
  const segments: Array<{ text: string; index: number }> = [];
  let offset = 0;
  for (const { segment } of segmenter.segment(text)) {
    segments.push({ text: segment, index: offset });
    offset += segment.length;
  }

  const insideFence = (index: number) =>
    ranges.find((fence) => index > fence.start && index < fence.end);

  const parts: string[] = [];
  let current = "";
  for (const { text: segment, index } of segments) {
    const fence = insideFence(index);
    // Leave room to close a code fence on this chunk, if there is one open.
    const limit = fence
      ? DISCORD_MAX_LENGTH - "\n```".length
      : DISCORD_MAX_LENGTH;
    if (current.length + segment.length > limit) {
      if (fence) {
        parts.push(`${current}\n\`\`\``);
        current = `\`\`\`${fence.lang}\n`;
      } else {
        parts.push(current);
        current = "";
      }
    }
    current += segment;
  }
  if (current) parts.push(current);
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
      case "approvalRequested":
        this.sendApprovalRequest(event);
        break;
    }
  }

  async done() {
    clearInterval(this.typing);
    await this.sending;
  }

  /**
   * Queues one send behind the previous ones. A failure is logged and then
   * swallowed, so the next send still runs instead of being skipped.
   */
  private enqueue(task: () => Promise<unknown>) {
    this.sending = this.sending.then(task).then(() => {}, (err) => {
      logger.error(`Failed to send to Discord: ${err}`);
    });
  }

  // Uploads the file as a native attachment. Rejects on failure so the tool
  // can report it (and never mint a public link); the queue keeps going.
  async sendFile(file: { name: string; data: Uint8Array }): Promise<void> {
    const upload = this.sending.then(() =>
      this.channel.send({
        files: [{ attachment: Buffer.from(file.data), name: file.name }],
      })
    );
    this.sending = upload.then(() => {}, () => {});
    await upload;
  }

  private sendText() {
    const reply = this.text.trim();
    if (!reply) return;
    // One task per part: a rejected part is logged and the rest still go out.
    for (const part of splitMessage(reply)) {
      this.enqueue(() => this.channel.send(part));
    }
  }

  private rename(title: string) {
    // Not awaited: renames are limited to 2 per 10 minutes per channel
    this.channel.setName(title).catch((err) =>
      logger.error(`Failed to rename channel: ${err}`)
    );
  }

  private sendApprovalRequest(
    event: Extract<AgentEvent, { type: "approvalRequested" }>,
  ) {
    this.enqueue(() => this.channel.send(buildApprovalRequest(event)));
  }
}
