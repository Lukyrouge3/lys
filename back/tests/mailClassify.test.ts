import { assertEquals } from "@std/assert";
import OpenAI from "@openai/openai";
import {
  askAgent,
  classifyDocumentWith,
  classifyMail,
  classifyPrompt,
  classifyRequest,
  classifyWith,
  documentPrompt,
  documentRequest,
  parseCategory,
  parseImportance,
  parseVerdict,
  resetClassifyStateForTests,
  setClassifyClockForTests,
} from "@/mail/classify.ts";
import type { MailEvent } from "@/mail/watcher.ts";

const mail: MailEvent = {
  accountId: "acc-1",
  account: "lys",
  folder: "INBOX",
  uid: 3,
  from: "Ana <ana@example.com>",
  subject: "Lunch?",
  date: new Date("2026-11-17T09:00:00Z"),
  preview: "Are you free at 13:00?",
};

function fakeOpenAI(answer: string | null) {
  const requests: unknown[] = [];
  const openai = {
    chat: {
      completions: {
        create: (request: unknown) => {
          requests.push(request);
          return Promise.resolve({
            choices: [{ message: { content: answer } }],
            usage: { prompt_tokens: 11, completion_tokens: 1 },
          });
        },
      },
    },
  } as unknown as OpenAI;
  return { openai, requests };
}

Deno.test("one word answers map to a label", () => {
  assertEquals(parseImportance("important"), "important");
  assertEquals(parseImportance(" NOISE\n"), "noise");
  assertEquals(parseImportance("normal"), "normal");
});

Deno.test("a chatty answer still finds its label", () => {
  assertEquals(parseImportance("This one is important."), "important");
});

Deno.test("an unusable answer defaults to normal", () => {
  assertEquals(parseImportance(""), "normal");
  assertEquals(parseImportance("no idea"), "normal");
  assertEquals(parseImportance("44"), "normal");
});

Deno.test("a two-line answer carries both the label and the topic", () => {
  assertEquals(
    parseVerdict("important\nlunch on Friday\n"),
    { importance: "important", topic: "lunch on Friday" },
  );
});

Deno.test("a label and topic on one line still split", () => {
  assertEquals(
    parseVerdict("important: lunch on Friday"),
    { importance: "important", topic: "lunch on Friday" },
  );
});

Deno.test("a topic is kept without its final stop", () => {
  assertEquals(
    parseVerdict("IMPORTANT\nlunch on Friday.").topic,
    "lunch on Friday",
  );
});

Deno.test("an unimportant mail carries no topic", () => {
  assertEquals(parseVerdict("noise"), { importance: "noise", topic: "" });
});

Deno.test("an unusable answer carries no topic", () => {
  assertEquals(parseVerdict(""), { importance: "normal", topic: "" });
  assertEquals(parseVerdict("no idea"), { importance: "normal", topic: "" });
});

Deno.test("the classifier is asked for a topic behind its label", () => {
  const system = classifyRequest("test-model", mail).messages[0].content
    .replace(/\s+/g, " ");
  assertEquals(system.includes("Answer with two lines"), true);
  assertEquals(
    system.includes("Leave line 2 empty for normal and noise"),
    true,
  );
});

Deno.test("the prompt carries sender, subject, date and body", () => {
  const prompt = classifyPrompt(mail);
  assertEquals(prompt.includes("From: Ana <ana@example.com>"), true);
  assertEquals(prompt.includes("Subject: Lunch?"), true);
  assertEquals(prompt.includes("2026-11-17"), true);
  assertEquals(prompt.endsWith("Are you free at 13:00?"), true);
});

Deno.test("a long body is cut before the model sees it", () => {
  const prompt = classifyPrompt({ ...mail, preview: "y".repeat(2000) });
  assertEquals(prompt.endsWith("y".repeat(800)), true);
});

Deno.test("an empty body is stated explicitly", () => {
  assertEquals(
    classifyPrompt({ ...mail, preview: "" }).endsWith("(no body text)"),
    true,
  );
});

Deno.test("the model's answer decides the importance, the topic and usage", async () => {
  const { openai, requests } = fakeOpenAI(
    "important\nlunch on Friday",
  );
  const result = await classifyWith(openai, "test-model", mail);

  assertEquals(result.importance, "important");
  assertEquals(result.topic, "lunch on Friday");
  assertEquals(result.inputTokens, 11);
  assertEquals(requests.length, 1);
});

Deno.test("a missing answer falls back to normal", async () => {
  const { openai } = fakeOpenAI(null);
  assertEquals(
    (await classifyWith(openai, "test-model", mail)).importance,
    "normal",
  );
});

const document = {
  filename: "invoice-0042.pdf",
  mime: "application/pdf",
  from: "Ana <ana@example.com>",
  subject: "Your bill",
  preview: "Payment due by Friday.",
};

Deno.test("document categories are matched word by word", () => {
  assertEquals(parseCategory("invoice"), "invoice");
  assertEquals(parseCategory("TRAVEL"), "travel");
  assertEquals(parseCategory("This is a medical report."), "medical");
});

Deno.test("plurals are understood", () => {
  assertEquals(parseCategory("invoices"), "invoice");
  assertEquals(parseCategory("taxes"), "tax");
});

Deno.test("an unknown category becomes other", () => {
  assertEquals(parseCategory(""), "other");
  assertEquals(parseCategory("souvenir"), "other");
  assertEquals(parseCategory("42"), "other");
});

Deno.test("the document prompt carries name, type and context", () => {
  const prompt = documentPrompt(document);
  assertEquals(prompt.includes("File: invoice-0042.pdf"), true);
  assertEquals(prompt.includes("Type: application/pdf"), true);
  assertEquals(prompt.includes("Subject: Your bill"), true);
  assertEquals(prompt.endsWith("Payment due by Friday."), true);
});

Deno.test("the document prompt keeps medical bills out of insurance", () => {
  const system = documentRequest("test-model", document).messages[0].content
    .replace(/\s+/g, " ");
  assertEquals(
    system.includes(
      "A bill for medical care is medical even when it is addressed to an insurer",
    ),
    true,
  );
  assertEquals(system.includes("medical ones"), true);
});

Deno.test("the model's answer picks the document category", async () => {
  const { openai } = fakeOpenAI("invoice");
  assertEquals(
    await classifyDocumentWith(openai, "test-model", document),
    "invoice",
  );
});

Deno.test("a document answer without a category becomes other", async () => {
  const { openai } = fakeOpenAI(null);
  assertEquals(
    await classifyDocumentWith(openai, "test-model", document),
    "other",
  );
});

Deno.test("a negation in the first line does not invert the verdict", () => {
  assertEquals(parseImportance("not noise, it is important"), "important");
  assertEquals(parseImportance("not important, just normal"), "normal");
  assertEquals(
    parseVerdict("not noise, it is important"),
    { importance: "important", topic: "" },
  );
  assertEquals(parseCategory("not an invoice, a receipt"), "receipt");
  assertEquals(parseCategory("not medical, a travel booking"), "travel");
});

Deno.test("only the first line is the verdict", () => {
  // Line 2 is a topic slot, not a second chance at the label.
  assertEquals(parseImportance("noise\nimportant"), "noise");
  assertEquals(parseImportance("not noise\nimportant"), "normal");
  assertEquals(parseImportance("no idea\nimportant"), "normal");
});

function failingAsk(): typeof askAgent {
  return (() =>
    Promise.reject(new Error("provider down"))) as unknown as typeof askAgent;
}

Deno.test("a transient classifier failure is retried once", async () => {
  resetClassifyStateForTests();
  let calls = 0;
  const ask = ((
    _trigger: string,
    _request: (model: string) => unknown,
    parse: (answer: string) => unknown,
  ) => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("provider down"));
    return Promise.resolve(parse("important\nlunch on Friday"));
  }) as unknown as typeof askAgent;

  assertEquals(
    await classifyMail(mail, ask),
    { importance: "important", topic: "lunch on Friday" },
  );
  assertEquals(calls, 2);
});

Deno.test("a persistent failure fails open once, then rate-limits", async () => {
  resetClassifyStateForTests();
  let now = 1_000_000;
  setClassifyClockForTests(() => now);

  try {
    assertEquals(
      await classifyMail(mail, failingAsk()),
      { importance: "important", topic: "could not be classified" },
    );

    // Second outage in the same window must not become a second alarm.
    assertEquals(
      await classifyMail(mail, failingAsk()),
      { importance: "normal", topic: "" },
    );

    now += 15 * 60_000;
    assertEquals(
      await classifyMail(mail, failingAsk()),
      { importance: "important", topic: "could not be classified" },
    );
  } finally {
    setClassifyClockForTests(null);
    resetClassifyStateForTests();
  }
});
