import { assert, assertEquals } from "@std/assert";
import {
  addToolCallDeltas,
  generateStreamRequest,
  StreamedToolCall,
  usableToolCalls,
} from "@/llm/stream.ts";
import { AgentConfig } from "@/config/agentConfig.ts";

const agentConfig: AgentConfig = {
  name: "test",
  model: "test-model",
  systemPrompt: "You are a test.",
  contextWindow: 8192,
  maxReplyTokens: 1024,
};

Deno.test("tool call arguments split across chunks are concatenated", () => {
  const toolCalls: StreamedToolCall[] = [];
  addToolCallDeltas(toolCalls, [{
    index: 0,
    id: "call-1",
    function: { name: "get_weather", arguments: "" },
  }]);
  addToolCallDeltas(toolCalls, [{ index: 0, function: { arguments: '{"ci' } }]);
  addToolCallDeltas(toolCalls, [{
    index: 0,
    function: { arguments: 'ty":"Paris"}' },
  }]);

  assertEquals(toolCalls, [
    { id: "call-1", name: "get_weather", arguments: '{"city":"Paris"}' },
  ]);
});

Deno.test("interleaved tool calls are kept apart by index", () => {
  const toolCalls: StreamedToolCall[] = [];
  addToolCallDeltas(toolCalls, [{
    index: 0,
    id: "a",
    function: { name: "first", arguments: "{" },
  }]);
  addToolCallDeltas(toolCalls, [{
    index: 1,
    id: "b",
    function: { name: "second", arguments: "{" },
  }]);
  addToolCallDeltas(toolCalls, [{ index: 0, function: { arguments: "}" } }]);
  addToolCallDeltas(toolCalls, [{ index: 1, function: { arguments: "}" } }]);

  assertEquals(toolCalls, [
    { id: "a", name: "first", arguments: "{}" },
    { id: "b", name: "second", arguments: "{}" },
  ]);
});

Deno.test("chunks without tool calls change nothing", () => {
  const toolCalls: StreamedToolCall[] = [];
  addToolCallDeltas(toolCalls, undefined);
  addToolCallDeltas(toolCalls, []);
  assertEquals(toolCalls, []);
});

Deno.test("a skipped index does not leave a hole", () => {
  const toolCalls: StreamedToolCall[] = [];
  addToolCallDeltas(toolCalls, [
    { index: 0, id: "a", function: { name: "first", arguments: "{}" } },
    { index: 2, id: "c", function: { name: "third", arguments: "{}" } },
  ]);

  // Iterating the array used to yield undefined for the hole at index 1
  assertEquals(
    usableToolCalls(toolCalls).map((call) => call.name),
    ["first", "third"],
  );
});

Deno.test("calls the provider never finished are dropped", () => {
  const incomplete: StreamedToolCall[] = [
    { id: "a", name: "first", arguments: "{}" },
    { id: "", name: "", arguments: "" }, // placeholder left by a skipped index
    { id: "", name: "second", arguments: "{}" }, // no id: cannot be answered
    { id: "d", name: "", arguments: "{}" }, // no name: cannot be run
  ];

  assertEquals(usableToolCalls(incomplete), [
    { id: "a", name: "first", arguments: "{}" },
  ]);
});

Deno.test("request starts with the system prompt", () => {
  const request = generateStreamRequest(agentConfig, [], [
    { role: "user", content: "hi" },
  ]);
  assertEquals(request.model, "test-model");
  assertEquals(request.messages, [
    { role: "system", content: "You are a test." },
    { role: "user", content: "hi" },
  ]);
  assertEquals(request.stream, true);
});

Deno.test("remembered facts go in a second system message", () => {
  const request = generateStreamRequest(
    agentConfig,
    [],
    [{ role: "user", content: "hi" }],
    "What you remember about them:\n- Hates mushrooms",
  );
  assertEquals(request.messages, [
    { role: "system", content: "You are a test." },
    {
      role: "system",
      content: "What you remember about them:\n- Hates mushrooms",
    },
    { role: "user", content: "hi" },
  ]);
});

Deno.test("no memory context means no extra message", () => {
  const request = generateStreamRequest(
    agentConfig,
    [],
    [{ role: "user", content: "hi" }],
    "",
  );
  assertEquals(request.messages.length, 2);
  assertEquals(request.messages[0], {
    role: "system",
    content: "You are a test.",
  });
});

Deno.test("request leaves out tools when there are none", () => {
  const request = generateStreamRequest(agentConfig, []);
  assertEquals("tools" in request, false);
});

Deno.test("request includes tools when given", () => {
  const tools = [{
    type: "function" as const,
    function: { name: "x", parameters: {} },
  }];
  assertEquals(generateStreamRequest(agentConfig, tools).tools, tools);
});

Deno.test("the reply limit comes from the agent", () => {
  const request = generateStreamRequest(
    { ...agentConfig, maxReplyTokens: 2048 },
    [],
  );
  assertEquals(request.max_tokens, 2048);
});

Deno.test("a bigger context window keeps more history", () => {
  const history = Array.from({ length: 40 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: "x".repeat(800),
  }));

  const small = generateStreamRequest(
    { ...agentConfig, contextWindow: 8192 },
    [],
    history,
  );
  const big = generateStreamRequest(
    { ...agentConfig, contextWindow: 65536 },
    [],
    history,
  );

  assert(big.messages.length > small.messages.length);
});
