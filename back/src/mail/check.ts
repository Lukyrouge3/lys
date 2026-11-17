// Live check for one mail account: connect, show INBOX state and the last few
// messages, then optionally wait for new mail. Read-only: it never writes to
// MailFolder, so it is safe to run against a real mailbox.
//
//   deno task mail:check [accountName] [--idle seconds]
import { getMailAccount, openImap } from "@/mail/account.ts";

const args = Deno.args.filter((arg) => !arg.startsWith("--"));
const idleAt = Deno.args.indexOf("--idle");
const idleSeconds = idleAt >= 0 ? Number(Deno.args[idleAt + 1] ?? 30) : 0;

const account = await getMailAccount(args[0]);
if (!account) {
  console.error(
    `No enabled mail account${args[0] ? ` named "${args[0]}"` : ""} in the database.\n` +
      "Add one to prisma/seed.json and run: deno task db:seed",
  );
  Deno.exit(1);
}

console.log(
  `${account.name} <${account.address}> via ${account.imapHost}:${account.imapPort}`,
);

const client = await openImap(account);
try {
  const boxes = await client.list();
  console.log(`Mailboxes: ${boxes.map((box) => box.path).join(", ")}`);

  const lock = await client.getMailboxLock("INBOX");
  try {
    const box = client.mailbox;
    if (!box) throw new Error("INBOX could not be opened");
    console.log(
      `INBOX uidValidity=${box.uidValidity} uidNext=${box.uidNext} messages=${box.exists}`,
    );

    const uids = await client.search({}, { uid: true });
    const recent = Array.isArray(uids) ? uids.slice(-5) : [];
    if (recent.length > 0) {
      console.log("Last messages:");
      for await (
        const msg of client.fetch(recent.join(","), {
          uid: true,
          envelope: true,
        }, { uid: true })
      ) {
        const from = msg.envelope?.from?.map((a) => a.address).join(", ");
        const date = msg.envelope?.date
          ? new Date(msg.envelope.date).toISOString()
          : "?";
        console.log(
          `  ${msg.uid}  ${date}  ${from}  ${msg.envelope?.subject ?? "(no subject)"}`,
        );
      }
    }

    if (idleSeconds > 0) {
      console.log(`Waiting ${idleSeconds}s for new mail...`);
      const before = box.exists;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, idleSeconds * 1000);
        client.on("exists", (data) => {
          if (data.count <= before) return;
          clearTimeout(timer);
          console.log(`New mail: INBOX has ${data.count} messages`);
          resolve();
        });
      });
    }
  } finally {
    lock.release();
  }
} finally {
  await client.logout();
}
