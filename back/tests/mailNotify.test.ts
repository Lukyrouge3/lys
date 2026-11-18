import { assertEquals } from "@std/assert";
import {
  cutNotice,
  formatMailNotice,
  senderName,
} from "@/chat/discord/notify.ts";
import type { MailEvent } from "@/mail/watcher.ts";

const mail: MailEvent = {
  accountId: "acc-1",
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
    "📬 Ana: Lunch?\nAre you free at 13:00?",
  );
});

Deno.test("a notice without a body stays one line", () => {
  assertEquals(
    formatMailNotice({ ...mail, preview: "" }),
    "📬 Ana: Lunch?",
  );
});

Deno.test("the address is dropped, Discord would eat the angle brackets", () => {
  assertEquals(senderName("Ana <ana@example.com>"), "Ana");
});

Deno.test("a bare address is shown as is", () => {
  assertEquals(senderName("ana@example.com"), "ana@example.com");
});

Deno.test("an empty sender is unknown", () => {
  assertEquals(senderName(""), "unknown sender");
});

Deno.test("a long body is cut to the notice limit", () => {
  const notice = formatMailNotice({ ...mail, preview: "z".repeat(2000) });
  assertEquals(notice.split("\n")[1].length, 1001); // 1000 chars plus the ellipsis
});

Deno.test("a cut notice ends on a word, not in the middle of one", () => {
  const body = "mot ".repeat(500);
  const cut = cutNotice(body);
  assertEquals(cut.endsWith("mot…"), true);
  assertEquals(cut.length, 1000);
});

Deno.test("a body under the limit is kept whole", () => {
  assertEquals(
    cutNotice("Bonjour, veuillez trouver ci-joint."),
    "Bonjour, veuillez trouver ci-joint.",
  );
});
