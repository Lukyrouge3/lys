import { assert, assertEquals } from "@std/assert";
import { JOB_PROFILE } from "@/jobs/profile.ts";
import { parseRank, rankRequest } from "@/jobs/rank.ts";

const job = {
  title: "Junior Software Engineer",
  company: "Acme",
  location: "Geneva",
  description: "TypeScript and SvelteKit.",
};

Deno.test("the request carries the profile and the posting", () => {
  const request = rankRequest("test-model", job);

  assertEquals(request.model, "test-model");
  assertEquals(request.max_tokens, 2048);
  assertEquals(request.temperature, 0);

  const system = request.messages[0].content;
  assert(system.includes("rank: apply|maybe|skip"));
  assert(system.includes("reason:"));

  const user = request.messages[1].content;
  assert(user.includes(JOB_PROFILE));
  assert(user.includes("Title: Junior Software Engineer"));
  assert(user.includes("Company: Acme"));
  assert(user.includes("Location: Geneva"));
  assert(user.endsWith("TypeScript and SvelteKit."));
});

Deno.test("the request leaves room for a reasoning model to think", () => {
  const request = rankRequest("test-model", job);
  assert(request.max_tokens >= 2048);
});

Deno.test("a missing location is stated, not left blank", () => {
  const user = rankRequest("test-model", { ...job, location: null })
    .messages[1].content;
  assert(user.includes("Location: unknown"));
});

Deno.test("a ten-thousand-character description is cut to 4000", () => {
  const user = rankRequest("test-model", {
    ...job,
    description: "x".repeat(10_000),
  }).messages[1].content;

  assert(user.includes("x".repeat(4000)));
  assertEquals(user.includes("x".repeat(4001)), false);
  assertEquals(user.endsWith("…"), true);
});

Deno.test("a well-formed answer is read as rank and reason", () => {
  assertEquals(parseRank("rank: apply\nreason: Strong match."), {
    rank: "apply",
    reason: "Strong match.",
  });
});

Deno.test("the rank line is case-insensitive", () => {
  assertEquals(parseRank("RANK: MAYBE\nREASON: Worth a look."), {
    rank: "maybe",
    reason: "Worth a look.",
  });
});

Deno.test("extra whitespace around the lines is ignored", () => {
  assertEquals(parseRank("  rank:   skip  \n  reason:   Not this one.  "), {
    rank: "skip",
    reason: "Not this one.",
  });
});

Deno.test("a missing reason is an empty string", () => {
  assertEquals(parseRank("rank: apply"), { rank: "apply", reason: "" });
});

Deno.test("an unknown or missing rank is null", () => {
  assertEquals(parseRank(""), null);
  assertEquals(parseRank("apply"), null);
  assertEquals(parseRank("rank: strong\nreason: nope"), null);
  assertEquals(parseRank("rank: apply extra\nreason: nope"), null);
});

Deno.test("a negated rank is not read as the keyword", () => {
  assertEquals(parseRank("rank: not skip\nreason: fine"), null);
});

Deno.test("a reason mentioning another rank does not decide the rank", () => {
  assertEquals(
    parseRank("rank: apply\nreason: This is not a skip."),
    { rank: "apply", reason: "This is not a skip." },
  );
});

Deno.test("a long reason is capped at 140 characters", () => {
  const answer = `rank: maybe\nreason: ${"y".repeat(200)}`;
  assertEquals(parseRank(answer)?.reason.length, 140);
});
