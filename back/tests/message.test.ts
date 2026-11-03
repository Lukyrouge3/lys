import { assertEquals } from "@std/assert";
import OpenAI from "@openai/openai";
import { toModelMessage } from "@/llm/message.ts";
import { Message, ToolCall } from "@/generated/prisma/client.ts";

const createdAt = new Date("2026-10-27T10:00:00Z");

function message(
  fields: Partial<Message>,
  toolCalls: Partial<ToolCall>[] = [],
): Message & { toolCalls: ToolCall[] } {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    role: "assistant",
    content: "",
    createdAt,
    llmCallId: null,
    ...fields,
    toolCalls: toolCalls.map((call, i) => ({
      id: `tc-${i}`,
      apiId: `api-${i}`,
      name: "get_weather",
      arguments: "{}",
      result: null,
      createdAt,
      messageId: "msg-1",
      approval: null,
      decidedAt: null,
      ...call,
    })),
  };
}

Deno.test("user messages get the timestamp prefix", () => {
  assertEquals(toModelMessage(message({ role: "user", content: "hi" })), [
    { role: "user", content: `[${createdAt.toLocaleString()}] hi` },
  ]);
});

Deno.test("assistant messages without tool calls pass through", () => {
  assertEquals(toModelMessage(message({ content: "hello" })), [
    { role: "assistant", content: "hello" },
  ]);
});

Deno.test("assistant tool calls become the call followed by one tool message each", () => {
  const result = toModelMessage(message({ content: "" }, [
    { apiId: "a", arguments: '{"city":"Paris"}', result: "sunny" },
    { apiId: "b", arguments: '{"city":"Lyon"}', result: "rainy" },
  ]));

  assertEquals(result, [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "a",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
        {
          id: "b",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Lyon"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "a", content: "sunny" },
    { role: "tool", tool_call_id: "b", content: "rainy" },
  ]);
});

Deno.test("a tool call without a result yields an empty tool message", () => {
  const result = toModelMessage(message({}, [{ apiId: "a" }]));
  assertEquals(result[1], { role: "tool", tool_call_id: "a", content: "" });
});

Deno.test("broken tool call arguments are sent as an empty object", () => {
  const result = toModelMessage(message({}, [
    { apiId: "a", arguments: '{"title": "Alien', result: "Error: bad JSON" },
  ])) as OpenAI.Chat.ChatCompletionAssistantMessageParam[];

  const call = result[0]
    .tool_calls![0] as OpenAI.Chat.ChatCompletionMessageFunctionToolCall;
  assertEquals(call.function.arguments, "{}");
});
