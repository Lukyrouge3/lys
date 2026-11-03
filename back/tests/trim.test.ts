import { assertEquals } from "@std/assert";
import OpenAI from "@openai/openai";
import { estimateTokens, trimHistory } from "@/llm/trim.ts";

type ModelMessage = OpenAI.Chat.ChatCompletionMessageParam;

const user = (content: string): ModelMessage => ({ role: "user", content });
const assistant = (content: string): ModelMessage => ({
  role: "assistant",
  content,
});
const toolCall: ModelMessage = {
  role: "assistant",
  content: "",
  tool_calls: [{
    id: "a",
    type: "function",
    function: { name: "get_weather", arguments: "{}" },
  }],
};
const toolResult: ModelMessage = {
  role: "tool",
  tool_call_id: "a",
  content: "sunny",
};

Deno.test("history that fits is kept as is", () => {
  const messages = [user("hi"), assistant("hey"), user("sup")];
  assertEquals(trimHistory(messages, 10_000), messages);
});

Deno.test("the oldest messages are dropped first", () => {
  const messages = [
    user("x".repeat(300)),
    assistant("y".repeat(300)),
    user("recent"),
  ];
  assertEquals(trimHistory(messages, 50), [user("recent")]);
});

Deno.test("a tool call and its result are dropped together", () => {
  const messages = [user("weather?"), toolCall, toolResult, user("thanks")];
  const budget = estimateTokens([user("thanks")]) +
    estimateTokens([toolCall, toolResult]);

  const result = trimHistory(messages, budget);

  assertEquals(result, [user("thanks")]);
});

Deno.test("history never starts with an orphan tool result or assistant", () => {
  const messages = [toolResult, assistant("hey"), user("hi"), assistant("yo")];
  assertEquals(trimHistory(messages, 10_000), [user("hi"), assistant("yo")]);
});

Deno.test("the last message is kept even if it's over budget", () => {
  const big = user("z".repeat(1000));
  assertEquals(trimHistory([user("old"), big], 1), [big]);
});
