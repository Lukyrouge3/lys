import type { MailEvent } from "@/mail/watcher.ts";
import { senderName } from "@/chat/discord/notify.ts";

const PREVIEW_CHARS = 200;

/** The first part of the draft on one line, long enough to judge it at a glance. */
export function draftPreview(body: string, limit = PREVIEW_CHARS): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit).trimEnd()}…`;
}

export function formatDraftNotice(
  mail: Pick<MailEvent, "subject" | "from">,
  body: string,
): string {
  const subject = mail.subject.replace(/\s+/g, " ").trim() || "(no subject)";
  const head = `✍️ Draft reply ready for "${subject}" from ${
    senderName(mail.from)
  }`;
  const preview = draftPreview(body);
  return preview ? `${head}\n${preview}` : head;
}
