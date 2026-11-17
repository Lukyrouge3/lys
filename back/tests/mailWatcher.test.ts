import { assertEquals } from "@std/assert";
import { parseMail, toMailEvent, uidRange } from "@/mail/watcher.ts";

const account = { id: "acc-1", name: "lys" };
const date = new Date("2026-11-17T09:00:00Z");

Deno.test("an envelope with a name becomes a readable sender", () => {
  assertEquals(
    toMailEvent(account, "INBOX", {
      uid: 7,
      envelope: {
        subject: "  Lunch?  ",
        date,
        from: [{ name: "Ana", address: "ana@example.com" }],
      },
    }),
    {
      accountId: "acc-1",
      account: "lys",
      folder: "INBOX",
      uid: 7,
      from: "Ana <ana@example.com>",
      subject: "Lunch?",
      date,
      preview: "",
    },
  );
});

Deno.test("an address without a name is shown as is", () => {
  assertEquals(
    toMailEvent(account, "INBOX", {
      uid: 8,
      envelope: { from: [{ address: "bot@example.com" }] },
    }).from,
    "bot@example.com",
  );
});

Deno.test("a bare envelope gets fallbacks", () => {
  const mail = toMailEvent(account, "INBOX", { uid: 9, envelope: null });
  assertEquals(mail.from, "(unknown sender)");
  assertEquals(mail.subject, "(no subject)");
  assertEquals(mail.date, null);
});

Deno.test("a broken date becomes null", () => {
  assertEquals(
    toMailEvent(account, "INBOX", {
      uid: 10,
      envelope: { date: "not a date" },
    }).date,
    null,
  );
});

Deno.test("the fetch range ends at uidNext minus one", () => {
  assertEquals(uidRange(5, 10), "5:9");
});

Deno.test("nothing is fetched when the folder is fully read", () => {
  assertEquals(uidRange(10, 10), null);
  assertEquals(uidRange(12, 10), null);
});

const encoder = new TextEncoder();

Deno.test("the preview is the plain text body, whitespace collapsed", async () => {
  const raw = [
    "From: Ana <ana@example.com>",
    "Subject: Lunch?",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Are you free   at 13:00?",
    "",
    "Ana",
  ].join("\r\n");

  assertEquals(
    (await parseMail(encoder.encode(raw))).preview,
    "Are you free at 13:00? Ana",
  );
});

Deno.test("the preview is cut to the limit", async () => {
  const raw = [
    "Subject: Long",
    "Content-Type: text/plain",
    "",
    "x".repeat(50),
  ].join("\r\n");
  assertEquals((await parseMail(encoder.encode(raw), 10)).preview.length, 10);
});

Deno.test("a message without source has no preview or attachments", async () => {
  assertEquals(await parseMail(undefined), { preview: "", attachments: [] });
  assertEquals(await parseMail(new Uint8Array()), {
    preview: "",
    attachments: [],
  });
});

Deno.test("source without headers is treated as plain text", async () => {
  assertEquals(
    (await parseMail(encoder.encode("not an email"))).preview,
    "not an email",
  );
});

const withAttachment = [
  "From: Ana <ana@example.com>",
  "Subject: Invoice",
  'Content-Type: multipart/mixed; boundary="part"',
  "",
  "--part",
  "Content-Type: text/plain",
  "",
  "Here is the invoice.",
  "--part",
  'Content-Type: application/pdf; name="invoice.pdf"',
  'Content-Disposition: attachment; filename="invoice.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQK",
  "--part",
  'Content-Type: image/png; name="logo.png"',
  'Content-Disposition: inline; filename="logo.png"',
  "Content-ID: <logo>",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgo=",
  "--part--",
].join("\r\n");

Deno.test("attachments are parsed and inline parts are skipped", async () => {
  const { preview, attachments } = await parseMail(
    encoder.encode(withAttachment),
  );

  assertEquals(preview, "Here is the invoice.");
  assertEquals(attachments.length, 1);
  assertEquals(attachments[0].filename, "invoice.pdf");
  assertEquals(attachments[0].mime, "application/pdf");
  assertEquals(attachments[0].content.byteLength > 0, true);
});
