import { assert, assertEquals } from "@std/assert";
import { generateToolRequest, runTool, ToolContext } from "@/tools/tool.ts";
import { testTools } from "./doubles.ts";

const context: ToolContext = {
  conversationId: "test-conversation",
  approval: "pending",
  emit: () => {},
};
const approved: ToolContext = { ...context, approval: "approved" };

Deno.test("tool request has the OpenAI function schema", () => {
  const title = generateToolRequest().find((tool) =>
    tool.type === "function" && tool.function.name === "set_title"
  );

  assertEquals(title, {
    type: "function",
    function: {
      name: "set_title",
      description: "Set the title of the current conversation",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "New title for the conversation. Must be between 3 and 64 characters.",
          },
        },
        required: ["title"],
      },
    },
  });
});

Deno.test("the model is never offered a fake tool", () => {
  const names = generateToolRequest().map((tool) =>
    tool.type === "function" ? tool.function.name : ""
  );

  assert(!names.includes("get_weather"), "get_weather is a stub, not a tool");
  assert(!names.includes("send_email"), "sending mail is not implemented yet");
});

Deno.test("a tool that needs approval isn't run until approved", async () => {
  assertEquals(
    await runTool(
      "send_email",
      context,
      '{"to":"a@b.c","subject":"hi"}',
      testTools(),
    ),
    { status: "pendingApproval" },
  );
});

Deno.test("an approved tool that needs approval runs", async () => {
  assertEquals(
    await runTool(
      "send_email",
      approved,
      '{"to":"a@b.c","subject":"hi"}',
      testTools(),
    ),
    { status: "ok", content: 'Email "hi" sent to a@b.c' },
  );
});

Deno.test("malformed arguments return an error result", async () => {
  const result = await runTool("share_folder", context, '{"path": "Par');
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
  assert(names.includes("clean_links"));
  assert(names.includes("send_file"));
});

Deno.test("send_file rejects a bad path without touching Nextcloud", async () => {
  assertEquals(
    (await runTool("send_file", approved, '{"path":""}')).status,
    "error",
  );
  assertEquals(
    (await runTool("send_file", approved, '{"path":"../etc/passwd"}')).status,
    "error",
  );
});

Deno.test("send_file waits for approval", async () => {
  assertEquals(
    (await runTool("send_file", context, '{"path":"a.pdf"}')).status,
    "pendingApproval",
  );
});

Deno.test("file tools are advertised to the model", () => {
  const names = generateToolRequest().map((tool) =>
    tool.type === "function" ? tool.function.name : ""
  );
  for (
    const name of [
      "list_files",
      "find_files",
      "read_file",
      "write_file",
      "create_folder",
      "move_file",
      "delete_file",
    ]
  ) {
    assert(names.includes(name), `${name} is missing`);
  }
});

Deno.test("file tools reject bad arguments without calling out", async () => {
  assertEquals(
    (await runTool("list_files", context, '{"path":".."}')).status,
    "error",
  );
  assertEquals(
    (await runTool("find_files", context, '{"path":"../etc"}')).status,
    "error",
  );
  assertEquals(
    (await runTool("read_file", context, '{"path":""}')).status,
    "error",
  );
  assertEquals(
    (await runTool("write_file", context, '{"path":"Notes/a.md"}')).status,
    "error",
  );
  assertEquals(
    (await runTool("create_folder", context, '{"path":".."}')).status,
    "error",
  );
  assertEquals(
    (await runTool("move_file", context, '{"from":"a"}')).status,
    "error",
  );
});

Deno.test("delete_file waits for approval", async () => {
  assertEquals(
    (await runTool("delete_file", context, '{"path":"old.txt"}')).status,
    "pendingApproval",
  );
});

Deno.test("share_folder advertises the link lifetime", () => {
  const share = generateToolRequest().find((tool) =>
    tool.type === "function" && tool.function.name === "share_folder"
  ) as {
    function: { parameters: { properties: Record<string, unknown> } };
  } | undefined;

  assertEquals(share?.function.parameters.properties.expires_in_days, {
    type: "number",
    description:
      'Only for mode "link": whole number of days the link stays valid, 1-365. Default 7.',
  });
});

Deno.test("clean_links rejects an unknown scope without calling out", async () => {
  assertEquals(
    (await runTool("clean_links", approved, '{"scope":"everything"}')).status,
    "error",
  );
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
