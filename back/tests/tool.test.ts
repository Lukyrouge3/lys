import { assert, assertEquals } from "@std/assert";
import { generateToolRequest, runTool, ToolContext } from "@/tools/tool.ts";

const context: ToolContext = {
  conversationId: "test-conversation",
  approval: "pending",
  emit: () => {},
};
const approved: ToolContext = { ...context, approval: "approved" };

Deno.test("tool request has the OpenAI function schema", () => {
  const weather = generateToolRequest().find((tool) =>
    tool.type === "function" && tool.function.name === "get_weather"
  );

  assertEquals(weather, {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
    },
  });
});

Deno.test("a tool that needs approval isn't run until approved", async () => {
  assertEquals(
    await runTool("send_email", context, '{"to":"a@b.c","subject":"hi"}'),
    { status: "pendingApproval" },
  );
});

Deno.test("an approved tool that needs approval runs", async () => {
  const result = await runTool(
    "send_email",
    approved,
    '{"to":"a@b.c","subject":"hi"}',
  );
  assertEquals(result.status, "ok");
});

Deno.test("an approved tool runs and returns its content", async () => {
  const result = await runTool("get_weather", context, '{"city":"Paris"}');
  assertEquals(result.status, "ok");
  if (result.status === "ok") {
    assertEquals(JSON.parse(result.content).city, "Paris");
  }
});

Deno.test("malformed arguments return an error result", async () => {
  const result = await runTool("get_weather", context, '{"city": "Par');
  assertEquals(result.status, "error");
});

Deno.test("an unknown tool returns an error result", async () => {
  assertEquals(await runTool("nope", context, "{}"), {
    status: "error",
    content: "Tool nope not found",
  });
});

Deno.test("memory tools are advertised to the model", () => {
  const names = generateToolRequest().map((tool) =>
    tool.type === "function" ? tool.function.name : ""
  );
  assert(names.includes("recall_memory"));
  assert(names.includes("save_memory"));
});

Deno.test("memory tools reject empty arguments without calling out", async () => {
  assertEquals((await runTool("recall_memory", context, "{}")).status, "error");
  assertEquals((await runTool("save_memory", context, "{}")).status, "error");
});

Deno.test("save_memory rejects whitespace and oversized facts", async () => {
  const blank = await runTool("save_memory", context, '{"content":"   "}');
  assertEquals(blank.status, "error");

  const huge = await runTool(
    "save_memory",
    context,
    JSON.stringify({ content: "x".repeat(2001) }),
  );
  assertEquals(huge.status, "error");
  assert(huge.status === "error" && huge.content.includes("2001"));
});

Deno.test("set_title returns an error result for an invalid title", async () => {
  assertEquals(
    (await runTool("set_title", context, '{"title":" a "}')).status,
    "error",
  );
  assertEquals(
    (await runTool("set_title", context, '{"title":42}')).status,
    "error",
  );
});
