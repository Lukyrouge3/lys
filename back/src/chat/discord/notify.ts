import type { Client } from "discord.js";
import type { MailEvent } from "@/mail/watcher.ts";

const NOTICE_CHARS = 200;

/** Discord reads "Name <address>" as masked content, so a notice shows the name only. */
export function senderName(from: string): string {
  const name = from.split("<")[0].trim();
  if (name && !name.includes("@")) return name;
  return from.match(/[\w.+-]+@[\w.-]+/)?.[0] ?? "unknown sender";
}

/** Cuts on a space so a notice never ends in the middle of a word. */
export function cutNotice(text: string, limit = NOTICE_CHARS): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const space = head.lastIndexOf(" ");
  const cut = space > limit / 2 ? head.slice(0, space) : head;
  return `${cut.trimEnd()}…`;
}

/**
 * A nudge, not a copy of the mail: what it is about, who sent it, and that it
 * wants attention. The subject stands in when the classifier named no topic.
 */
export function formatMailNotice(mail: MailEvent, topic = ""): string {
  const about = cutNotice(topic.trim() || mail.subject, NOTICE_CHARS).replace(
    /[.!?\s]+$/,
    "",
  );
  const what = about ? ` about ${about}` : "";
  return `📬 There is an important mail${what} from ${
    senderName(mail.from)
  } requiring your attention!`;
}

export async function dmOwner(client: Client, content: string): Promise<void> {
  const ownerId = Deno.env.get("DISCORD_OWNER_ID");
  if (!ownerId) throw new Error("DISCORD_OWNER_ID must be set");
  const owner = await client.users.fetch(ownerId);
  await owner.send(content);
}
