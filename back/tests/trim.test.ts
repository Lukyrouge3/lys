import { assert, assertEquals } from "@std/assert";
import OpenAI from "@openai/openai";
import { estimateTokens, trimHistory, TRUNCATED } from "@/llm/trim.ts";

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

Deno.test("the last message is kept, cut down to the budget", () => {
  const big = user("z".repeat(10_000));

  const result = trimHistory([user("old"), big], 100);

  assertEquals(result.length, 1);
  assert(estimateTokens(result) <= 100);
  assert((result[0].content as string).endsWith(TRUNCATED.trim()));
});

Deno.test("the longest message gives up its content first", () => {
  const messages = [
    user("what's in the log?"),
    toolCall,
    { ...toolResult, content: "y".repeat(5000) },
  ];
  const budget = estimateTokens(messages) - 500;

  const result = trimHistory(messages, budget);

  // Dropping the pair is not possible - it is the last group - so its result
  // is what gets cut, and the call and its result stay together.
  assertEquals(result.map((message) => message.role), ["assistant", "tool"]);
  assert(estimateTokens(result) <= budget);
  assert((result[1].content as string).length < 5000);
});

Deno.test("trimming does not eat the caller's history", () => {
  const messages = [user("keep me ".repeat(2000))];

  trimHistory(messages, 50);

  assertEquals((messages[0].content as string).length, 16_000);
});
