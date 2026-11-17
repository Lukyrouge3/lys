import { assertEquals } from "@std/assert";
import {
  addToolCallDeltas,
  generateStreamRequest,
  StreamedToolCall,
} from "@/llm/stream.ts";
import { AgentConfig } from "@/config/agentConfig.ts";

const agentConfig: AgentConfig = {
  name: "test",
  model: "test-model",
  systemPrompt: "You are a test.",
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
  assertEquals(request.messages[0], { role: "system", content: "You are a test." });
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
