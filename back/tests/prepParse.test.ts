import { assertEquals } from "@std/assert";
import { parseVerify, parseWrite } from "@/prep/parse.ts";

function answer(
  {
    language = "en",
    notes = "| Req | Row |",
    cv = "CV BODY",
    cover = "COVER BODY",
  } = {},
): string {
  return [
    `language: ${language}`,
    "===== notes.md =====",
    notes,
    "===== cv.typ =====",
    cv,
    "===== cover.typ =====",
    cover,
  ].join("\n");
}

Deno.test("a well-formed write answer is read", () => {
  assertEquals(parseWrite(answer()), {
    language: "en",
    notes: "| Req | Row |",
    cvTyp: "CV BODY",
    coverTyp: "COVER BODY",
  });
});

Deno.test("leading and trailing blank lines are tolerated", () => {
  const parsed = parseWrite(`\n\n  \n${answer()}\n\n\n`);
  assertEquals(parsed?.language, "en");
  assertEquals(parsed?.cvTyp, "CV BODY");
});

Deno.test("a markdown fence wrapped around a block is stripped", () => {
  const parsed = parseWrite(answer({
    cv: '```typ\n#import "x": *\nHello\n```',
    cover: "```\nDear team\n```",
  }));

  assertEquals(parsed?.cvTyp, '#import "x": *\nHello');
  assertEquals(parsed?.coverTyp, "Dear team");
});

Deno.test("a fence on one side only is left alone", () => {
  const parsed = parseWrite(answer({ cv: "```typ\nCV BODY" }));
  assertEquals(parsed?.cvTyp, "```typ\nCV BODY");
});

Deno.test("a missing block is not an answer", () => {
  const text = [
    "language: en",
    "===== notes.md =====",
    "notes",
    "===== cv.typ =====",
    "cv",
  ].join("\n");

  assertEquals(parseWrite(text), null);
});

Deno.test("a bad or misplaced language line is not an answer", () => {
  assertEquals(parseWrite(answer({ language: "de" })), null);
  assertEquals(parseWrite(`Here you go:\n${answer()}`), null);
  assertEquals(parseWrite(""), null);
});

Deno.test("a duplicated block is unusable", () => {
  const text = `${answer()}\n===== cv.typ =====\ncv again`;
  assertEquals(parseWrite(text), null);
});

Deno.test("an indented delimiter is content, not structure", () => {
  const text = answer().replace(
    "===== cover.typ =====",
    "  ===== cover.typ =====",
  );
  assertEquals(parseWrite(text), null);
});

Deno.test("a clean verdict passes", () => {
  assertEquals(parseVerify("verdict: ok"), { ok: true, unsupported: [] });
  assertEquals(parseVerify("\nverdict: ok\n"), { ok: true, unsupported: [] });
});

Deno.test("issues list every unsupported claim", () => {
  const verdict = parseVerify([
    "verdict: issues",
    "unsupported: AWS experience | no AWS row in the bank",
    "unsupported: shipped to 30 customers | the bank says internal only",
  ].join("\n"));

  assertEquals(verdict, {
    ok: false,
    unsupported: [
      "AWS experience | no AWS row in the bank",
      "shipped to 30 customers | the bank says internal only",
    ],
  });
});

Deno.test("issues without a single line is unusable, never a pass", () => {
  assertEquals(parseVerify("verdict: issues"), null);
  assertEquals(parseVerify("verdict: issues\nlooks fine to me"), null);
});

Deno.test("negated, duplicated or absent verdicts are unusable", () => {
  assertEquals(parseVerify("verdict: not ok"), null);
  assertEquals(parseVerify("not ok"), null);
  assertEquals(parseVerify("verdict: ok\nverdict: issues"), null);
});

Deno.test("the whole answer is not keyword-searched", () => {
  assertEquals(
    parseVerify("I checked everything and it all looks ok to me."),
    null,
  );
  assertEquals(
    parseVerify("This is not ok. verdict: issues is what I would say."),
    null,
  );
});

Deno.test("garbage is unusable", () => {
  assertEquals(parseVerify(""), null);
  assertEquals(parseVerify("unsupported: something"), null);
});
