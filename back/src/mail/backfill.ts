// Save attachments from mail that arrived before the watcher existed, or while
// it was down. Idempotent: anything already in the ledger is skipped by hash,
// and MailFolder state is left alone.
//
//   deno task mail:backfill [--account name] [--limit 200]
//   --limit 0 walks the whole INBOX
import prisma from "@/db.ts";
import { getMailAccount, openImap } from "@/mail/account.ts";
import { storeAttachments } from "@/mail/documents.ts";
import { parseMail, toMailEvent } from "@/mail/watcher.ts";

function option(name: string): string | undefined {
  const at = Deno.args.indexOf(name);
  return at >= 0 ? Deno.args[at + 1] : undefined;
}

const account = await getMailAccount(option("--account"));
if (!account) {
  console.error("No enabled mail account in the database.");
  Deno.exit(1);
}

const limit = Number(option("--limit") ?? 200);
console.log(
  `Backfilling ${account.address}, ${
    limit > 0 ? `newest ${limit}` : "all"
  } messages`,
);

const client = await openImap(account);
let messages = 0;
let found = 0;
let stored = 0;

try {
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = await client.search({}, { uid: true });
    const all = Array.isArray(uids) ? uids : [];
    const selected = limit > 0 ? all.slice(-limit) : all;
    if (selected.length === 0) console.log("INBOX is empty");

    for await (
      const msg of client.fetch(selected.join(","), {
        uid: true,
        envelope: true,
        source: true,
      }, { uid: true })
    ) {
      const { preview, attachments } = await parseMail(msg.source);
      if (attachments.length === 0) continue;

      messages++;
      found += attachments.length;
      const mail = toMailEvent(account, "INBOX", msg, preview);
      const saved = await storeAttachments(mail, attachments);
      stored += saved;
      console.log(
        `#${msg.uid} ${mail.subject}: ${saved}/${attachments.length} saved`,
      );
    }
  } finally {
    lock.release();
  }
} finally {
  await client.logout().catch(() => {});
  await prisma.$disconnect();
}

console.log(
  `${stored} of ${found} attachments saved from ${messages} messages`,
);
