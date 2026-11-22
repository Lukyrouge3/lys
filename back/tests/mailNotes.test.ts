import { assertEquals } from "@std/assert";
import prisma from "@/db.ts";
import { recordMailNote } from "@/mail/notes.ts";
import type { MailEvent } from "@/mail/watcher.ts";
import { closeDb, truncate } from "./db.ts";

const mail: MailEvent = {
  accountId: "placeholder",
  account: "test",
  folder: "INBOX",
  uid: 42,
  from: "Ana <ana@example.com>",
  subject: "Invoice 42",
  date: new Date("2026-11-17T09:00:00Z"),
  preview: "Payment due by Friday.",
};

Deno.test({
  name: "recordMailNote",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await truncate("MailNote", "MailAccount", "Secret");
    const secret = await prisma.secret.create({
      data: { name: "mail-password", value: "unused" },
    });
    const account = await prisma.mailAccount.create({
      data: {
        name: "test",
        address: "me@example.ch",
        imapHost: "imap.example.ch",
        smtpHost: "smtp.example.ch",
        username: "me",
        passwordId: secret.id,
      },
    });

    try {
      await t.step(
        "a classified mail is recorded with its verdict",
        async () => {
          await recordMailNote(account.id, mail, {
            importance: "important",
            topic: "invoice 42, due Friday",
          });

          const rows = await prisma.mailNote.findMany();
          assertEquals(rows.length, 1);
          assertEquals(rows[0].accountId, account.id);
          assertEquals(rows[0].folder, "INBOX");
          assertEquals(rows[0].uid, 42);
          assertEquals(rows[0].from, mail.from);
          assertEquals(rows[0].subject, mail.subject);
          assertEquals(rows[0].importance, "important");
          assertEquals(rows[0].topic, "invoice 42, due Friday");
          assertEquals(
            rows[0].receivedAt.toISOString(),
            mail.date!.toISOString(),
          );
        },
      );

      await t.step(
        "seeing the same mail again updates rather than duplicates",
        async () => {
          await recordMailNote(account.id, {
            ...mail,
            subject: "Invoice 42 (updated)",
          }, { importance: "normal", topic: "" });

          const rows = await prisma.mailNote.findMany();
          assertEquals(rows.length, 1);
          assertEquals(rows[0].subject, "Invoice 42 (updated)");
          assertEquals(rows[0].importance, "normal");
          assertEquals(rows[0].topic, "");
        },
      );

      await t.step("a mail without a date is stamped now", async () => {
        const before = Date.now();
        await recordMailNote(account.id, { ...mail, uid: 43, date: null }, {
          importance: "noise",
          topic: "",
        });
        const row = await prisma.mailNote.findFirst({ where: { uid: 43 } });
        const received = row?.receivedAt.getTime() ?? 0;
        assertEquals(received >= before, true);
        assertEquals(received <= Date.now() + 1000, true);
      });
    } finally {
      await closeDb();
    }
  },
});
