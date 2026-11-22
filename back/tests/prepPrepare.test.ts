import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { FactBank } from "@/prep/factbank.ts";
import { familyNameOf, prepareApplication } from "@/prep/prepare.ts";
import type {
  PrepChatRequest,
  PrepDeps,
  PrepJobInput,
  PrepLlm,
} from "@/prep/types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const JOB: PrepJobInput = {
  title: "Product Engineer",
  company: "The Flex",
  location: "Biel/Bienne, Switzerland",
  url: "https://example.test/jobs/42",
  description: "Build the Base360.ai product. React and TypeScript.",
};

const FACTS: FactBank = {
  files: [{
    name: "contact",
    content: "| Field | Value |\n| --- | --- |\n| Name | Torrenté Florian |",
  }],
  text:
    "## contact\n| Field | Value |\n| --- | --- |\n| Name | Torrenté Florian |",
};

const TEMPLATES = { cv: "BASE CV", cover: "BASE COVER" };
const GOOD_CV = "CV of Torrenté Florian";
const GOOD_COVER = "Dear hiring team, Torrenté Florian";

function writeAnswer(
  cv: string = GOOD_CV,
  cover: string = GOOD_COVER,
  notes = "| Requirement | Evidence | Gap |\n| --- | --- | --- |",
): string {
  return [
    "language: en",
    "===== notes.md =====",
    notes,
    "===== cv.typ =====",
    cv,
    "===== cover.typ =====",
    cover,
  ].join("\n");
}

type FakeCall = { trigger: string; request: PrepChatRequest };

function fakeLlm(writes: string[], verifies: string[] = []) {
  const calls: FakeCall[] = [];
  const llm: PrepLlm = <T>(
    trigger: string,
    build: (model: string) => PrepChatRequest,
    parse: (answer: string) => T,
  ): Promise<T> => {
    const request = build("fake-model");
    calls.push({ trigger, request });

    const queue = trigger === "prep:verify" ? verifies : writes;
    const answer = queue.shift();
    if (answer === undefined) {
      return Promise.reject(new Error(`no fake answer queued for ${trigger}`));
    }
    return Promise.resolve(parse(answer));
  };
  return { llm, calls };
}

function makeDeps(
  writes: string[],
  verifies: string[] = [],
  overrides: Partial<PrepDeps> = {},
) {
  const { llm, calls } = fakeLlm(writes, verifies);
  const compiles: string[] = [];

  const deps: PrepDeps = {
    llm,
    compile: (options) => {
      compiles.push(options.source);
      if (options.source.includes("BROKEN")) {
        return Promise.reject(new Error("error: expected expression"));
      }
      return Promise.resolve({
        pdf: encoder.encode(options.source),
        warnings: options.source.includes("WARN") ? ["unused import"] : [],
      });
    },
    pageCount: (pdf) =>
      Promise.resolve(decoder.decode(pdf).includes("PAGES2") ? 2 : 1),
    text: (pdf) => Promise.resolve(decoder.decode(pdf)),
    loadFacts: () => Promise.resolve(FACTS),
    loadTemplates: () => Promise.resolve(TEMPLATES),
    now: () => 0,
    ...overrides,
  };

  return { deps, calls, compiles };
}

Deno.test("a clean run comes back ready", async () => {
  const { deps, calls } = makeDeps([writeAnswer()], ["verdict: ok"]);

  const result = await prepareApplication(JOB, deps);

  assertEquals(result.status, "ready");
  assertEquals(result.language, "en");
  assertEquals(result.gaps, []);
  assertStringIncludes(result.notes, "| Requirement | Evidence | Gap |");
  assertEquals(result.cvTyp, GOOD_CV);
  assertEquals(result.coverTyp, GOOD_COVER);
  assert(result.cvPdf.length > 0);
  assert(result.coverPdf.length > 0);
  assertEquals(calls.map((call) => call.trigger), [
    "prep:write",
    "prep:verify",
  ]);
});

Deno.test("a compile error triggers a repair round", async () => {
  const { deps, calls } = makeDeps(
    [writeAnswer("BROKEN CV"), writeAnswer()],
    ["verdict: ok"],
  );

  const result = await prepareApplication(JOB, deps);

  assertEquals(result.status, "ready");
  assertEquals(calls.map((call) => call.trigger), [
    "prep:write",
    "prep:write",
    "prep:verify",
  ]);
  const repair = calls[1].request.messages.map((m) => m.content).join("\n");
  assertStringIncludes(repair, "The previous attempt was rejected");
  assertStringIncludes(repair, "does not compile");
});

Deno.test("a page overflow twice ends in review with the gap", async () => {
  const overflowing = writeAnswer("CV PAGES2 Torrenté Florian");
  const { deps, calls } = makeDeps([overflowing, overflowing, overflowing]);

  const result = await prepareApplication(JOB, deps);

  assertEquals(result.status, "review");
  const gaps = result.gaps.join("\n");
  assertStringIncludes(gaps, "page count 2");
  assertStringIncludes(gaps, "cut content, do not shrink type below 10pt");
  assertEquals(calls.map((call) => call.trigger), [
    "prep:write",
    "prep:write",
    "prep:write",
  ]);
  assert(result.cvPdf.length > 0, "the last compiled PDF is kept");
});

Deno.test("the verifier lists unsupported claims and the run goes to review", async () => {
  const { deps } = makeDeps(
    [writeAnswer()],
    [
      "verdict: issues\nunsupported: AWS experience | the bank has no AWS row",
    ],
  );

  const result = await prepareApplication(JOB, deps);

  assertEquals(result.status, "review");
  assertEquals(result.gaps, [
    "AWS experience | the bank has no AWS row",
  ]);
});

Deno.test("a garbage verifier answer is review, never a silent pass", async () => {
  const { deps } = makeDeps([writeAnswer()], [
    "I checked it and it seems fine.",
  ]);

  const result = await prepareApplication(JOB, deps);

  assertEquals(result.status, "review");
  assertEquals(result.gaps, ["verifier gave no usable answer"]);
});

Deno.test("an unparsable writer gets one retry and then throws", async () => {
  const { deps, calls, compiles } = makeDeps([
    "no format here",
    "still not the format",
  ]);

  await assertRejects(
    () => prepareApplication(JOB, deps),
    Error,
    "unusable answer",
  );

  assertEquals(calls.map((call) => call.trigger), ["prep:write", "prep:write"]);
  assertEquals(compiles, []);
});

Deno.test("the total wall-clock budget rejects", async () => {
  const hang: PrepLlm = <T>(
    _trigger: string,
    _build: (model: string) => PrepChatRequest,
    _parse: (answer: string) => T,
  ): Promise<T> => new Promise<T>(() => {});

  const previous = Deno.env.get("PREP_TIMEOUT_MS");
  Deno.env.set("PREP_TIMEOUT_MS", "40");
  try {
    const { deps } = makeDeps([], [], { llm: hang });
    await assertRejects(
      () => prepareApplication(JOB, deps),
      Error,
      "timed out",
    );
  } finally {
    if (previous === undefined) Deno.env.delete("PREP_TIMEOUT_MS");
    else Deno.env.set("PREP_TIMEOUT_MS", previous);
  }
});

Deno.test("the family name comes from the contact name row", () => {
  assertEquals(
    familyNameOf({
      files: [{ name: "contact", content: "| Name | Torrenté Florian |" }],
      text: "",
    }),
    "Torrenté",
  );
  assertEquals(
    familyNameOf({
      files: [{ name: "contact", content: "Name: Torrenté, Florian" }],
      text: "",
    }),
    "Torrenté",
  );
  assertEquals(familyNameOf({ files: [], text: "" }), null);
});
