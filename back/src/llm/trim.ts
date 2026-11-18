import OpenAI from "@openai/openai";

type ModelMessage = OpenAI.Chat.ChatCompletionMessageParam;

// Rough on purpose: works for any provider, and 3 (not 4) leaves a margin
// for emojis, non-English text and JSON
const CHARS_PER_TOKEN = 3;

/** Appended to content that was cut to fit the window. */
export const TRUNCATED = "\n…[truncated]";

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

/**
 * Cutting whole messages out is not always enough: one tool result can be
 * larger than the window on its own. Cut the longest text until the request
 * fits, on copies, so the session keeps what it had.
 */
function fitMessages(
  messages: ModelMessage[],
  budget: number,
): ModelMessage[] {
  const kept = messages.map((message) => ({ ...message }));
  // The text without its marker, so repeated rounds can only shrink it
  const texts = kept.map((message) =>
    typeof message.content === "string" ? message.content : null
  );

  for (let round = 0; round < 20; round++) {
    const over = estimateTokens(kept) - budget;
    if (over <= 0) break;

    let victim = -1;
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (text === null || text.length === 0) continue;
      if (victim === -1 || text.length > (texts[victim] as string).length) {
        victim = i;
      }
    }
    if (victim === -1) break;

    const text = texts[victim] as string;
    const keep = Math.max(0, text.length - over * CHARS_PER_TOKEN);
    texts[victim] = text.slice(0, keep);
    kept[victim].content = keep > 0
      ? `${texts[victim]}${TRUNCATED}`
      : TRUNCATED;
  }

  return kept;
}

// Drops the oldest messages until the history fits the budget.
// A tool call and its results are dropped together, the history always
// starts with a user message, and the last message group is always kept -
// cut down if it does not fit by itself.
export function trimHistory(
  messages: ModelMessage[],
  budget: number,
): ModelMessage[] {
  const groups: ModelMessage[][] = [];
  for (const msg of messages) {
    if (msg.role === "tool" && groups.length > 0) groups.at(-1)!.push(msg);
    else groups.push([msg]);
  }

  let total = groups.reduce((sum, group) => sum + estimateTokens(group), 0);
  let start = 0;
  while (
    start < groups.length - 1 &&
    (total > budget || groups[start][0].role !== "user")
  ) {
    total -= estimateTokens(groups[start]);
    start++;
  }
  return fitMessages(groups.slice(start).flat(), budget);
}
