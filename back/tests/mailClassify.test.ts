import { assertEquals } from "@std/assert";
import OpenAI from "@openai/openai";
import {
  classifyDocumentWith,
  classifyPrompt,
  classifyWith,
  documentPrompt,
  parseCategory,
  parseImportance,
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

Deno.test("the model's answer decides the importance and usage is kept", async () => {
  const { openai, requests } = fakeOpenAI("important");
  const result = await classifyWith(openai, "test-model", mail);

  assertEquals(result.importance, "important");
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
