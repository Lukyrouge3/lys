import { assertEquals, assertThrows } from "@std/assert";
import { generateToolRequest, runTool } from "@/tools/tool.ts";

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

Deno.test("runTool runs the tool by name", async () => {
  const result = JSON.parse(await runTool("get_weather", { city: "Paris" }));
  assertEquals(result.city, "Paris");
});

Deno.test("runTool throws for an unknown tool", () => {
  assertThrows(() => runTool("nope", {}), Error, "Tool nope not found");
});
