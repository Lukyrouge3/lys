import OpenAI from "@openai/openai";
import prisma from "@/db.ts";
import { getAgent } from "@/config/agentConfig.ts";
import { getOpenAIClient } from "@/llm/provider.ts";
import { withThinking } from "@/llm/thinking.ts";
import type { Prisma } from "@/generated/prisma/client.ts";
import type { MailEvent } from "@/mail/watcher.ts";
import { logger } from "@/utils/logger.ts";

export type Importance = "important" | "normal" | "noise";

const SYSTEM_PROMPT =
  `You sort incoming mail for one person who only wants to be interrupted when it matters.

Answer with two lines and nothing else.

Line 1 is exactly one word:
- important: personal mail from a real person, work, money, bills, invitations, deadlines, anything that needs a reply or an action soon, or time-sensitive news.
- normal: legitimate mail that can wait: receipts, confirmations, account notices, updates to things they use.
- noise: newsletters, marketing, promotions, automated notifications, social media, spam.

Line 2 says what an important mail is about, as a short noun phrase of at most twelve words: the thing itself, not the greeting, no sender name, no full stop. It is read in one glance to decide whether to stop what one is doing, so for a bill it names the amount and the due date, for an invitation the event and the day. Leave line 2 empty for normal and noise.

Judge by the content, not only the sender. A message from a real person is never noise, even when it is just a greeting or a thanks. If you cannot tell, answer normal.`;

export const DOCUMENT_CATEGORIES = [
  "invoice",
  "receipt",
  "contract",
  "insurance",
  "medical",
  "tax",
  "travel",
  "identity",
  "other",
] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

const DOCUMENT_PROMPT =
  `You file one attachment from an email into the folder where its owner will look for it later.

Answer with exactly one word, from this list:
${DOCUMENT_CATEGORIES.join(", ")}

- invoice: bills to pay, except medical ones
- receipt: proof of a purchase or payment
- contract: agreements, terms, subscriptions
- insurance: policies and coverage letters that are not about health care
- medical: results, prescriptions, appointments, and bills for care from a doctor, practice, lab, hospital, pharmacy or health insurer
- tax: declarations, tax office letters
- travel: tickets, bookings, boarding passes
- identity: passports, IDs, certificates, diplomas
- other: anything that does not fit

Judge by the file name, its type and the mail around it, but what the document
is about decides: who sends it or pays it only breaks a tie. A bill for medical
care is medical even when it is addressed to an insurer and looks like an
invoice. If you cannot tell, answer other.`;

const MAX_PREVIEW_CHARS = 800;

type ChatRequest = {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  max_tokens: number;
  temperature: number;
};

/**
 * Words that invert the label right after them. The prompt asks for a bare
 * label, but models sometimes answer "not noise, it is important"; reading the
 * first match anywhere turned that into noise. Negation is checked on the
 * clause the label belongs to, so the second, affirmative label still wins.
 */
const NEGATIONS = new Set([
  "not",
  "no",
  "never",
  "none",
  "neither",
  "nor",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "don't",
  "doesn't",
  "didn't",
  "cannot",
  "can't",
  "won't",
  "wouldn't",
  "shouldn't",
  "pas",
  "jamais",
  "aucun",
  "aucune",
  "rien",
  "n'est",
]);

/** Articles and adverbs that may sit between a negation and its label. */
const NEGATION_FILLERS = new Set([
  "a",
  "an",
  "the",
  "really",
  "very",
  "so",
  "that",
  "particularly",
  "especially",
]);

/**
 * The prompt's first line is the one word that answers the question. Only that
 * line is read, and a label is ignored when the nearest word before it negates
 * it. Scanning the whole answer was how "not noise, it is important" became
 * noise.
 */
function labelInFirstLine(
  answer: string,
  labelOf: (token: string) => string | null,
): string | null {
  const first = answer
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0) ?? "";

  for (const clause of first.toLowerCase().split(/[,;:.!?()[\]{}—–]+/)) {
    const tokens = clause.match(/[\p{L}']+/gu) ?? [];
    for (let i = 0; i < tokens.length; i++) {
      const label = labelOf(tokens[i]);
      if (!label) continue;

      let before = i - 1;
      while (before >= 0 && NEGATION_FILLERS.has(tokens[before])) before--;
      if (before >= 0 && NEGATIONS.has(tokens[before])) continue;
      return label;
    }
  }
  return null;
}

const IMPORTANCE_WORDS = new Set(["important", "normal", "noise"]);

export function parseImportance(answer: string): Importance {
  const label = labelInFirstLine(
    answer,
    (token) => IMPORTANCE_WORDS.has(token) ? token : null,
  );
  return (label as Importance | null) ?? "normal";
}

/** The importance, and for an important mail what it is about. */
export type MailVerdict = {
  importance: Importance;
  topic: string;
};

const LABEL_LINE = /^(important|normal|noise)\b[\s:.;–—-]*/i;

/**
 * Reads the two-line answer. The importance comes from the first line only; a
 * model that puts the label and the topic on that line is understood too. An
 * answer with no usable first line is without a topic, and the notice falls
 * back to the subject.
 */
export function parseVerdict(answer: string): MailVerdict {
  const lines = answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0] ?? "";
  const label = first.match(LABEL_LINE);
  const rest = label ? first.slice(label[0].length).trim() : "";
  const others = label ? lines.slice(1) : [];

  return {
    importance: parseImportance(answer),
    topic: [rest, ...others].join(" ").replace(/[.!?\s]+$/, "").trim(),
  };
}

const PLURALS: Record<string, DocumentCategory> = {
  invoices: "invoice",
  receipts: "receipt",
  contracts: "contract",
  insurances: "insurance",
  medicals: "medical",
  taxes: "tax",
  travels: "travel",
  identities: "identity",
};

const CATEGORY_WORDS = new Set<string>(DOCUMENT_CATEGORIES);

function categoryOf(token: string): DocumentCategory | null {
  if (CATEGORY_WORDS.has(token)) return token as DocumentCategory;
  return PLURALS[token] ?? null;
}

export function parseCategory(answer: string): DocumentCategory {
  return (labelInFirstLine(answer, categoryOf) as DocumentCategory | null) ??
    "other";
}

export function classifyPrompt(mail: MailEvent): string {
  return [
    `From: ${mail.from}`,
    `Subject: ${mail.subject}`,
    `Received: ${mail.date?.toISOString() ?? "unknown"}`,
    "",
    mail.preview.slice(0, MAX_PREVIEW_CHARS) || "(no body text)",
  ].join("\n");
}

export function classifyRequest(model: string, mail: MailEvent): ChatRequest {
  return {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: classifyPrompt(mail) },
    ],
    max_tokens: 512,
    temperature: 0,
  };
}

export type DocumentInput = {
  filename: string;
  mime: string;
  from: string;
  subject: string;
  preview: string;
};

export function documentPrompt(input: DocumentInput): string {
  return [
    `File: ${input.filename}`,
    `Type: ${input.mime}`,
    `From: ${input.from}`,
    `Subject: ${input.subject}`,
    "",
    input.preview.slice(0, 400) || "(no body text)",
  ].join("\n");
}

export function documentRequest(
  model: string,
  input: DocumentInput,
): ChatRequest {
  return {
    model,
    messages: [
      { role: "system", content: DOCUMENT_PROMPT },
      { role: "user", content: documentPrompt(input) },
    ],
    max_tokens: 512,
    temperature: 0,
  };
}

export type Classification = MailVerdict & {
  inputTokens?: number;
  outputTokens?: number;
};

export async function classifyWith(
  openai: OpenAI,
  model: string,
  mail: MailEvent,
): Promise<Classification> {
  const response = await openai.chat.completions.create(
    classifyRequest(
      model,
      mail,
    ) as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  );
  return {
    ...parseVerdict(response.choices[0]?.message?.content ?? ""),
    inputTokens: response.usage?.prompt_tokens,
    outputTokens: response.usage?.completion_tokens,
  };
}

export async function classifyDocumentWith(
  openai: OpenAI,
  model: string,
  input: DocumentInput,
): Promise<DocumentCategory> {
  const response = await openai.chat.completions.create(
    documentRequest(
      model,
      input,
    ) as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  );
  return parseCategory(response.choices[0]?.message?.content ?? "");
}

export async function askAgent<T>(
  trigger: string,
  request: (model: string) => ChatRequest,
  parse: (answer: string) => T,
  agentName?: string,
  thinking?: string,
): Promise<T> {
  const agent = await getAgent(
    agentName ?? Deno.env.get("MAIL_CLASSIFIER_AGENT") ?? "lys",
  );
  const openai = await getOpenAIClient(agent.provider);
  const model = withThinking(agent.model, thinking);
  const payload = request(model);
  const start = performance.now();

  try {
    const response = await openai.chat.completions.create(
      payload as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    );
    const answer = response.choices[0]?.message?.content ?? "";
    await prisma.llmCall.create({
      data: {
        providerId: agent.providerId,
        model,
        trigger,
        status: "Ok",
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        latencyMs: Math.round(performance.now() - start),
        request: payload as unknown as Prisma.InputJsonValue,
        response: { answer },
      },
    });
    return parse(answer);
  } catch (err) {
    logger.warn(`${trigger} failed: ${err}`);
    await prisma.llmCall.create({
      data: {
        providerId: agent.providerId,
        model,
        trigger,
        status: "Error",
        latencyMs: Math.round(performance.now() - start),
        request: payload as unknown as Prisma.InputJsonValue,
        error: String(err),
      },
    }).catch(() => {});
    throw err;
  }
}

/**
 * A provider outage must not silently skip an important mail, but it must not
 * turn every mail in the outage into an alarm either. After the retry fails the
 * first mail is treated as important and at most one such fail-open notice is
 * produced every 15 minutes; later failures in that window return normal and
 * log a warning.
 */
const FAIL_OPEN_INTERVAL_MS = 15 * 60_000;
let lastFailOpenAt = Number.NEGATIVE_INFINITY;
let clock: () => number = Date.now;

/** Test hook: the fail-open rate limit is module state. */
export function setClassifyClockForTests(read: (() => number) | null): void {
  clock = read ?? Date.now;
}

/** Test hook: clears the fail-open window. */
export function resetClassifyStateForTests(): void {
  lastFailOpenAt = Number.NEGATIVE_INFINITY;
  clock = Date.now;
}

/** Thinking level for the mail calls; unset keeps the provider default. */
function mailThinking(): string | undefined {
  return Deno.env.get("MAIL_THINKING")?.trim() || undefined;
}

export async function classifyMail(
  mail: MailEvent,
  ask: typeof askAgent = askAgent,
): Promise<MailVerdict> {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await ask(
        "mail:classify",
        (model) => classifyRequest(model, mail),
        parseVerdict,
        undefined,
        mailThinking(),
      );
    } catch (err) {
      failure = err;
      if (attempt === 0) {
        logger.warn(`Mail classification failed, retrying once: ${err}`);
      }
    }
  }

  const now = clock();
  if (now - lastFailOpenAt >= FAIL_OPEN_INTERVAL_MS) {
    lastFailOpenAt = now;
    logger.warn(
      `Mail could not be classified (${failure}); treating it as important`,
    );
    return { importance: "important", topic: "could not be classified" };
  }

  logger.warn(
    `Mail could not be classified (${failure}); already failed open recently, treating it as normal`,
  );
  return { importance: "normal", topic: "" };
}

/** Fail-open: an unfiled attachment lands in "other" instead of being dropped. */
export async function classifyDocument(
  input: DocumentInput,
): Promise<DocumentCategory> {
  try {
    return await askAgent(
      "mail:document",
      (model) => documentRequest(model, input),
      parseCategory,
      undefined,
      mailThinking(),
    );
  } catch {
    return "other";
  }
}
