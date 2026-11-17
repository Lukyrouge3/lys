import type { Client } from "discord.js";
import type { MailEvent } from "@/mail/watcher.ts";

const NOTICE_CHARS = 300;

export function formatMailNotice(mail: MailEvent): string {
  const lines = [`📬 ${mail.from}: ${mail.subject}`];
  if (mail.preview) lines.push(mail.preview.slice(0, NOTICE_CHARS));
  return lines.join("\n");
}

export async function dmOwner(client: Client, content: string): Promise<void> {
  const ownerId = Deno.env.get("DISCORD_OWNER_ID");
  if (!ownerId) throw new Error("DISCORD_OWNER_ID must be set");
  const owner = await client.users.fetch(ownerId);
  await owner.send(content);
}
