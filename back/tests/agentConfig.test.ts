import { assertEquals, assertThrows } from "@std/assert";
import { loadAgentConfig } from "@/config/agentConfig.ts";

function withConfig(name: string, config: unknown, fn: () => void) {
  const path = `./config/agents/${name}.json`;
  Deno.writeTextFileSync(path, JSON.stringify(config));
  try {
    fn();
  } finally {
    Deno.removeSync(path);
  }
}

Deno.test("missing system prompt falls back to the default", () => {
  withConfig("__test_default", {
    name: "test",
    model: "m",
    provider: "p",
  }, () => {
    const config = loadAgentConfig("__test_default");
    assertEquals(config.name, "test");
    assertEquals(config.systemPrompt.length > 0, true);
  });
});

Deno.test("a custom system prompt is kept", () => {
  withConfig("__test_custom", {
    name: "test",
    model: "m",
    provider: "p",
    systemPrompt: "custom",
  }, () => {
    assertEquals(loadAgentConfig("__test_custom").systemPrompt, "custom");
  });
});

Deno.test("an invalid config throws", () => {
  withConfig("__test_invalid", { name: "x" }, () => {
    assertThrows(() => loadAgentConfig("__test_invalid"));
  });
});
