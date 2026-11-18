import OpenAI from "@openai/openai";
import prisma from "@/db.ts";
import { getAgent } from "@/config/agentConfig.ts";
import { getOpenAIClient } from "@/llm/provider.ts";
import type { Prisma } from "@/generated/prisma/client.ts";
import type { MailEvent } from "@/mail/watcher.ts";
import { logger } from "@/utils/logger.ts";

export type Importance = "important" | "normal" | "noise";

const SYSTEM_PROMPT =
  `You sort incoming mail for one person who only wants to be interrupted when it matters.

Answer with exactly one word:
- important: personal mail from a real person, work, money, bills, invitations, deadlines, anything that needs a reply or an action soon, or time-sensitive news.
- normal: legitimate mail that can wait: receipts, confirmations, account notices, updates to things they use.
- noise: newsletters, marketing, promotions, automated notifications, social media, spam.

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

export function parseImportance(answer: string): Importance {
  const match = answer.toLowerCase().match(/\b(important|normal|noise)\b/);
  return (match?.[1] as Importance) ?? "normal";
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

export function parseCategory(answer: string): DocumentCategory {
  for (const token of answer.toLowerCase().match(/[a-z]+/g) ?? []) {
    if ((DOCUMENT_CATEGORIES as readonly string[]).includes(token)) {
      return token as DocumentCategory;
    }
    if (PLURALS[token]) return PLURALS[token];
  }
  return "other";
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

export type Classification = {
  importance: Importance;
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
    importance: parseImportance(response.choices[0]?.message?.content ?? ""),
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

async function askAgent<T>(
  trigger: string,
  request: (model: string) => ChatRequest,
  parse: (answer: string) => T,
): Promise<T> {
  const agent = await getAgent(Deno.env.get("MAIL_CLASSIFIER_AGENT") ?? "lys");
  const openai = await getOpenAIClient(agent.provider);
  const payload = request(agent.model);
  const start = performance.now();

  try {
    const response = await openai.chat.completions.create(
      payload as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    );
    const answer = response.choices[0]?.message?.content ?? "";
    await prisma.llmCall.create({
      data: {
        providerId: agent.providerId,
        model: agent.model,
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
        model: agent.model,
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

/** Fail-open: a broken classifier means "normal", never a missed important mail. */
export async function classifyMail(mail: MailEvent): Promise<Importance> {
  try {
    return await askAgent(
      "mail:classify",
      (model) => classifyRequest(model, mail),
      parseImportance,
    );
  } catch {
    return "normal";
  }
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
    );
  } catch {
    return "other";
  }
}
