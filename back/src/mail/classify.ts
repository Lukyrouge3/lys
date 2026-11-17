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

Judge by the content, not only the sender. If you cannot tell, answer normal.`;

const MAX_PREVIEW_CHARS = 800;

export function parseImportance(answer: string): Importance {
  const match = answer.toLowerCase().match(/\b(important|normal|noise)\b/);
  return (match?.[1] as Importance) ?? "normal";
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

export function classifyRequest(model: string, mail: MailEvent) {
  return {
    model,
    messages: [
      { role: "system" as const, content: SYSTEM_PROMPT },
      { role: "user" as const, content: classifyPrompt(mail) },
    ],
    max_tokens: 4,
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
    classifyRequest(model, mail),
  );
  return {
    importance: parseImportance(response.choices[0]?.message?.content ?? ""),
    inputTokens: response.usage?.prompt_tokens,
    outputTokens: response.usage?.completion_tokens,
  };
}

/** Fail-open: a broken classifier means "normal", never a missed important mail. */
export async function classifyMail(mail: MailEvent): Promise<Importance> {
  const agent = await getAgent(
    Deno.env.get("MAIL_CLASSIFIER_AGENT") ?? "lys",
  );
  const openai = await getOpenAIClient(agent.provider);
  const request = classifyRequest(agent.model, mail);
  const start = performance.now();

  try {
    const result = await classifyWith(openai, agent.model, mail);
    await prisma.llmCall.create({
      data: {
        providerId: agent.providerId,
        model: agent.model,
        trigger: "mail:classify",
        status: "Ok",
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: Math.round(performance.now() - start),
        request: request as unknown as Prisma.InputJsonValue,
        response: { importance: result.importance },
      },
    });
    return result.importance;
  } catch (err) {
    logger.warn(`Mail classification failed: ${err}`);
    await prisma.llmCall.create({
      data: {
        providerId: agent.providerId,
        model: agent.model,
        trigger: "mail:classify",
        status: "Error",
        latencyMs: Math.round(performance.now() - start),
        request: request as unknown as Prisma.InputJsonValue,
        error: String(err),
      },
    }).catch(() => {});
    return "normal";
  }
}
