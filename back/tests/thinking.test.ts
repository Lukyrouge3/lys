import { assertEquals } from "@std/assert";
import { withThinking } from "@/llm/thinking.ts";

Deno.test("a thinking level is appended in parentheses", () => {
  assertEquals(
    withThinking("claude-haiku-5-5", "low"),
    "claude-haiku-5-5(low)",
  );
  assertEquals(
    withThinking("claude-haiku-5-5", "2048"),
    "claude-haiku-5-5(2048)",
  );
  assertEquals(
    withThinking("claude-haiku-5-5", "none"),
    "claude-haiku-5-5(none)",
  );
});

Deno.test("surrounding whitespace in the level is dropped", () => {
  assertEquals(withThinking("m", " low "), "m(low)");
});

Deno.test("an empty or missing level leaves the model alone", () => {
  assertEquals(withThinking("m"), "m");
  assertEquals(withThinking("m", ""), "m");
  assertEquals(withThinking("m", "   "), "m");
});

Deno.test("a model that already carries a suffix is not suffixed twice", () => {
  assertEquals(withThinking("m(high)", "low"), "m(high)");
  assertEquals(withThinking("m(none)", "low"), "m(none)");
});
