import { assertEquals } from "@std/assert";
import { toMailEvent, uidRange } from "@/mail/watcher.ts";

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
