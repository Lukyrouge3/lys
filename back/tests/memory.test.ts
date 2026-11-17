import { assertEquals } from "@std/assert";
import {
  buildRecallQuery,
  buildRetainBatch,
  formatMemories,
  type RetainRow,
} from "@/memory.ts";

Deno.test("a self-contained message is used as the query", () => {
  assertEquals(
    buildRecallQuery("What did we decide about the Lisbon trip?"),
    "What did we decide about the Lisbon trip?",
  );
});

Deno.test("a vague follow-up is anchored to the previous message", () => {
  assertEquals(
    buildRecallQuery(
      "what about the second one?",
      "Where should we eat in Lisbon?",
    ),
    "Where should we eat in Lisbon? — what about the second one?",
  );
});

Deno.test("a short message is anchored even without a pronoun", () => {
  assertEquals(
    buildRecallQuery("and the hotel?", "Booked the flights for May."),
    "Booked the flights for May. — and the hotel?",
  );
});

Deno.test("a short first message is left alone", () => {
  assertEquals(buildRecallQuery("hello"), "hello");
});

Deno.test("the chat timestamp prefix is stripped", () => {
  assertEquals(
    buildRecallQuery("[11/15/2026, 10:31:00 AM] Where do I work?", undefined),
    "Where do I work?",
  );
});

Deno.test("queries are capped below the API's 500-token limit", () => {
  const query = buildRecallQuery("x".repeat(5000));
  assertEquals(query.length, 1500);
});

Deno.test("no memories formats to an empty string", () => {
  assertEquals(formatMemories([]), "");
});

Deno.test("memories are formatted as a bullet list", () => {
  assertEquals(
    formatMemories([
      { text: "Prefers Vue over React", type: "observation" },
      { text: "Lives in Lisbon", type: "world" },
    ]),
    "What you remember about them from earlier conversations:\n" +
      "- Prefers Vue over React\n" +
      "- Lives in Lisbon",
  );
});

function row(id: string, content: string, minutes = 0): RetainRow {
  return {
    id,
    role: "user",
    content,
    createdAt: new Date(Date.UTC(2026, 10, 15, 10, minutes)),
  };
}

Deno.test("a batch stops at the character budget", () => {
  const batch = buildRetainBatch(
    [
      row("a", "x".repeat(100)),
      row("b", "y".repeat(100)),
      row("c", "z".repeat(100)),
    ],
    450, // two messages with their overhead
  );
  assertEquals(batch.transcript.map((m) => m.content.length), [100, 100]);
  assertEquals(batch.ids, ["a", "b"]);
});

Deno.test("messages past the budget wait for the next batch", () => {
  const batch = buildRetainBatch(
    [row("a", "x".repeat(300)), row("b", "y".repeat(300))],
    450,
  );
  assertEquals(batch.ids, ["a"]);
});

Deno.test("empty turns cost no budget but are still marked", () => {
  const batch = buildRetainBatch(
    [row("a", ""), row("b", "  "), row("c", "hello")],
    450,
  );
  assertEquals(batch.transcript.length, 1);
  assertEquals(batch.ids, ["a", "b", "c"]);
});

Deno.test("one oversized message is cut instead of stalling", () => {
  const batch = buildRetainBatch([row("a", "x".repeat(500))], 200);
  assertEquals(batch.ids, ["a"]);
  assertEquals(batch.transcript[0].content.length, 100);
  assertEquals(batch.transcript[0].timestamp, "2026-11-15T10:00:00.000Z");
});
