import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  compileTypst,
  parseWarnings,
  pdfPageCount,
  pdfText,
  stderrExcerpt,
} from "@/prep/typst.ts";
import { loadBaseTemplates } from "@/prep/factbank.ts";

// Local installs may lack Typst; the image always has it. The probe runs once,
// sync, so the compile tests can be skipped instead of failing.
const hasTypst = (() => {
  try {
    return new Deno.Command("typst", {
      args: ["--version"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
})();

const WARNING_STDERR = `warning: unknown font family: nonexistent font
  ┌─ main.typ:1:16
  │
1 │ #set text(font: "Nonexistent Font", size: 11pt)
  │                 ^^^^^^^^^^^^^^^^^^

warning: unused import: fa-link
`;

Deno.test("warnings are the message lines, not the source excerpts", () => {
  assertEquals(parseWarnings(WARNING_STDERR), [
    "unknown font family: nonexistent font",
    "unused import: fa-link",
  ]);
});

Deno.test("stderr without warnings yields none", () => {
  assertEquals(parseWarnings(""), []);
  assertEquals(
    parseWarnings("error: expected expression\n  ┌─ main.typ:1:8\n"),
    [],
  );
});

Deno.test("long stderr is cut down for the error message", () => {
  const excerpt = stderrExcerpt("x".repeat(5000));

  assert(excerpt.length < 2100, `excerpt is ${excerpt.length} chars`);
  assertStringIncludes(excerpt, "truncated");
  assertEquals(excerpt.startsWith("x".repeat(2000)), true);
});

Deno.test("short stderr is kept as-is, blank stderr is named", () => {
  assertEquals(stderrExcerpt("  boom  \n"), "boom");
  assertEquals(stderrExcerpt("   "), "(no stderr)");
});

Deno.test("a missing typst binary names the pin", async () => {
  const previous = Deno.env.get("TYPST_BIN");
  Deno.env.set("TYPST_BIN", "/nonexistent/typst-for-tests");
  try {
    const error = await assertRejects(
      () => compileTypst({ source: "Hello" }),
      Error,
    );
    assertStringIncludes(error.message, "TYPST_BIN");
    assertStringIncludes(error.message, "/nonexistent/typst-for-tests");
  } finally {
    if (previous === undefined) Deno.env.delete("TYPST_BIN");
    else Deno.env.set("TYPST_BIN", previous);
  }
});

Deno.test({
  ignore: !hasTypst,
  name: "the base cv compiles to one page",
  async fn() {
    const { cv } = await loadBaseTemplates();
    const { pdf, warnings } = await compileTypst({ source: cv });

    assertEquals(warnings, []);
    assertEquals(await pdfPageCount(pdf), 1);
    assert(pdf.length > 1000, `pdf is ${pdf.length} bytes`);
  },
});

Deno.test({
  ignore: !hasTypst,
  name: "extra files land beside the source",
  async fn() {
    const { pdf } = await compileTypst({
      source: '#include "part.typ"\n',
      extraFiles: { "part.typ": "Hello from the extra file\n" },
    });

    assertStringIncludes(await pdfText(pdf), "Hello from the extra file");
  },
});

Deno.test({
  ignore: !hasTypst,
  name: "a warning is captured without failing the compile",
  async fn() {
    const { pdf, warnings } = await compileTypst({
      source: '#set text(font: "No Such Font", size: 11pt)\nHello\n',
    });

    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "unknown font family");
    assert(pdf.length > 0);
  },
});

Deno.test({
  ignore: !hasTypst,
  name: "a broken source fails with typst's stderr",
  async fn() {
    await assertRejects(
      () => compileTypst({ source: "#let x = \n" }),
      Error,
      "expected expression",
    );
  },
});
