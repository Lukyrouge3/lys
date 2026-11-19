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

Deno.test("a notice says what the mail is about and who sent it", () => {
  assertEquals(
    formatMailNotice(mail, "lunch on Friday"),
    "📬 There is an important mail about lunch on Friday from Ana requiring your attention!",
  );
});

Deno.test("a notice never repeats the body of the mail", () => {
  const notice = formatMailNotice(mail, "lunch on Friday");
  assertEquals(notice.includes(mail.preview), false);
});

Deno.test("a topic with a full stop does not get a double stop", () => {
  assertEquals(
    formatMailNotice(mail, "lunch on Friday."),
    "📬 There is an important mail about lunch on Friday from Ana requiring your attention!",
  );
});

Deno.test("without a topic the subject stands in", () => {
  assertEquals(
    formatMailNotice(mail),
    "📬 There is an important mail about Lunch from Ana requiring your attention!",
  );
});

Deno.test("a long topic is cut on a word, not in the middle of one", () => {
  const notice = formatMailNotice(mail, "mot ".repeat(500));
  const topic = notice.split(" about ")[1].split(" from ")[0];
  assertEquals(topic.endsWith("mot…"), true);
  assertEquals(topic.length, 200);
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

Deno.test("a cut notice ends on a word, not in the middle of one", () => {
  const body = "mot ".repeat(500);
  const cut = cutNotice(body);
  assertEquals(cut.endsWith("mot…"), true);
  assertEquals(cut.length, 200);
});

Deno.test("a body under the limit is kept whole", () => {
  assertEquals(
    cutNotice("Bonjour, veuillez trouver ci-joint."),
    "Bonjour, veuillez trouver ci-joint.",
  );
});
