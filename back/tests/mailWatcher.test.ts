import { assertEquals } from "@std/assert";
import { mailPreview, toMailEvent, uidRange } from "@/mail/watcher.ts";

const date = new Date("2026-11-17T09:00:00Z");

Deno.test("an envelope with a name becomes a readable sender", () => {
  assertEquals(
    toMailEvent("lys", "INBOX", {
      uid: 7,
      envelope: {
        subject: "  Lunch?  ",
        date,
        from: [{ name: "Ana", address: "ana@example.com" }],
      },
    }),
    {
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
    toMailEvent("lys", "INBOX", {
      uid: 8,
      envelope: { from: [{ address: "bot@example.com" }] },
    }).from,
    "bot@example.com",
  );
});

Deno.test("a bare envelope gets fallbacks", () => {
  const mail = toMailEvent("lys", "INBOX", { uid: 9, envelope: null });
  assertEquals(mail.from, "(unknown sender)");
  assertEquals(mail.subject, "(no subject)");
  assertEquals(mail.date, null);
});

Deno.test("a broken date becomes null", () => {
  assertEquals(
    toMailEvent("lys", "INBOX", {
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
    await mailPreview(encoder.encode(raw)),
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
  assertEquals((await mailPreview(encoder.encode(raw), 10)).length, 10);
});

Deno.test("a message without source has no preview", async () => {
  assertEquals(await mailPreview(undefined), "");
  assertEquals(await mailPreview(new Uint8Array()), "");
});

Deno.test("source without headers is treated as plain text", async () => {
  assertEquals(await mailPreview(encoder.encode("not an email")), "not an email");
});
