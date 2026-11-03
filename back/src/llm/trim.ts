import OpenAI from "@openai/openai";

type ModelMessage = OpenAI.Chat.ChatCompletionMessageParam;

// Rough on purpose: works for any provider, and 3 (not 4) leaves a margin
// for emojis, non-English text and JSON
const CHARS_PER_TOKEN = 3;

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

// Drops the oldest messages until the history fits the budget.
// A tool call and its results are dropped together, the history always
// starts with a user message, and the last message group is always kept.
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
  return groups.slice(start).flat();
}
