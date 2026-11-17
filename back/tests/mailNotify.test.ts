import { assertEquals } from "@std/assert";
import { formatMailNotice } from "@/chat/discord/notify.ts";
import type { MailEvent } from "@/mail/watcher.ts";

const mail: MailEvent = {
  account: "lys",
  folder: "INBOX",
  uid: 1,
  from: "Ana <ana@example.com>",
  subject: "Lunch?",
  date: null,
  preview: "Are you free at 13:00?",
};

Deno.test("a notice shows sender, subject and a short body", () => {
  assertEquals(
    formatMailNotice(mail),
    "📬 Ana <ana@example.com>: Lunch?\nAre you free at 13:00?",
  );
});

Deno.test("a notice without a body stays one line", () => {
  assertEquals(
    formatMailNotice({ ...mail, preview: "" }),
    "📬 Ana <ana@example.com>: Lunch?",
  );
});

Deno.test("a long body is cut in the notice", () => {
  const notice = formatMailNotice({ ...mail, preview: "z".repeat(500) });
  assertEquals(notice.split("\n")[1].length, 300);
});
