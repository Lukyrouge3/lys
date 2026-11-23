import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "node:path";
import { mergePdfs, type MergeRunner, pdfuniteBinary } from "@/prep/merge.ts";
import { pdfPageCount } from "@/prep/typst.ts";

const encoder = new TextEncoder();

const hasPoppler = (() => {
  const probe = (name: string) => {
    try {
      new Deno.Command(name, {
        args: ["-v"],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).outputSync();
      return true;
    } catch {
      return false;
    }
  };
  return probe("pdfunite") && probe("pdfinfo");
})();

/**
 * A minimal, genuinely valid one-page PDF. The xref offsets are computed, so
 * poppler accepts it without a repair pass.
 */
function tinyPdf(): Uint8Array {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
  ];
  let text = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let index = 0; index < bodies.length; index++) {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${bodies[index]}\nendobj\n`;
  }
  const xref = text.length;
  text += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    text += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  text += `trailer\n<< /Size ${
    bodies.length + 1
  } /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(text);
}

/** Writes the concatenation of the input files, as pdfunite would a PDF. */
function fakeRunner(seen: string[] = []): MergeRunner {
  return async (_bin, args, cwd) => {
    seen.push(args.join(" "));
    const inputs = args.slice(0, -1);
    const chunks: Uint8Array[] = [];
    for (const input of inputs) {
      chunks.push(await Deno.readFile(join(cwd, input)));
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      output.set(chunk, at);
      at += chunk.length;
    }
    await Deno.writeFile(join(cwd, args[args.length - 1]), output);
    return { code: 0, stdout: "", stderr: "" };
  };
}

Deno.test("merge: invalid parts are skipped and the rest keep their order", async () => {
  const seen: string[] = [];
  const result = await mergePdfs([
    { name: "a.pdf", bytes: encoder.encode("%PDF-A-1") },
    { name: "empty.pdf", bytes: new Uint8Array() },
    { name: "notes.pdf", bytes: encoder.encode("just text") },
    { name: "bad.pdf", bytes: encoder.encode("%PDF-BAD") },
    { name: "c.pdf", bytes: encoder.encode("%PDF-C-3") },
  ], {
    runner: fakeRunner(seen),
    pageCount: (pdf) => {
      const text = new TextDecoder().decode(pdf);
      if (text.includes("BAD")) return Promise.reject(new Error("broken"));
      return Promise.resolve(1);
    },
  });

  assertEquals(result.skipped.map((entry) => entry.name), [
    "empty.pdf",
    "notes.pdf",
    "bad.pdf",
  ]);
  assertStringIncludes(result.skipped[0].reason, "empty");
  assertStringIncludes(result.skipped[1].reason, "%PDF-");
  assertStringIncludes(result.skipped[2].reason, "unreadable");
  assertEquals(new TextDecoder().decode(result.pdf), "%PDF-A-1%PDF-C-3");
  assertEquals(seen.length, 1);
});

Deno.test("merge: nothing readable is a clear error", async () => {
  const error = await assertRejects(
    () =>
      mergePdfs([{ name: "x.pdf", bytes: encoder.encode("nope") }], {
        runner: fakeRunner(),
        pageCount: () => Promise.resolve(1),
      }),
    Error,
  );
  assertStringIncludes(error.message, "No valid PDF to merge");
  assertStringIncludes(error.message, "x.pdf");
});

Deno.test("merge: no parts at all is a clear error", async () => {
  await assertRejects(
    () => mergePdfs([]),
    Error,
    "No valid PDF to merge",
  );
});

Deno.test("merge: a missing binary names PDFUNITE_BIN", async () => {
  const previous = Deno.env.get("PDFUNITE_BIN");
  Deno.env.set("PDFUNITE_BIN", "/nonexistent/pdfunite-for-tests");
  try {
    assertEquals(pdfuniteBinary(), "/nonexistent/pdfunite-for-tests");
    const error = await assertRejects(
      () =>
        mergePdfs([
          { name: "a.pdf", bytes: encoder.encode("%PDF-A") },
          { name: "b.pdf", bytes: encoder.encode("%PDF-B") },
        ], { pageCount: () => Promise.resolve(1) }),
      Error,
    );
    assertStringIncludes(error.message, "PDFUNITE_BIN");
    assertStringIncludes(error.message, "/nonexistent/pdfunite-for-tests");
  } finally {
    if (previous === undefined) Deno.env.delete("PDFUNITE_BIN");
    else Deno.env.set("PDFUNITE_BIN", previous);
  }
});

Deno.test("merge: a bad part does not lose the others in the fallback", async () => {
  // The combined call fails; the pairwise path copies the good parts.
  const runner: MergeRunner = async (_bin, args, cwd) => {
    const outputName = args[args.length - 1];
    if (outputName === "merged.pdf") {
      return { code: 1, stdout: "", stderr: "combined failure" };
    }
    const inputs = args.slice(0, -1);
    const chunks: Uint8Array[] = [];
    for (const name of inputs) {
      const bytes = await Deno.readFile(join(cwd, name));
      if (new TextDecoder().decode(bytes).includes("BAD")) {
        return { code: 1, stdout: "", stderr: "bad part" };
      }
      chunks.push(bytes);
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      output.set(chunk, at);
      at += chunk.length;
    }
    await Deno.writeFile(join(cwd, args[args.length - 1]), output);
    return { code: 0, stdout: "", stderr: "" };
  };

  const result = await mergePdfs([
    { name: "a.pdf", bytes: encoder.encode("%PDF-A") },
    { name: "bad.pdf", bytes: encoder.encode("%PDF-BAD") },
    { name: "c.pdf", bytes: encoder.encode("%PDF-C") },
  ], {
    runner,
    pageCount: () => Promise.resolve(1),
  });

  assertEquals(result.skipped.map((entry) => entry.name), ["bad.pdf"]);
  assertStringIncludes(result.skipped[0].reason, "bad part");
  assertEquals(new TextDecoder().decode(result.pdf), "%PDF-A%PDF-C");
});

Deno.test({
  ignore: !hasPoppler,
  name: "merge: pdfunite really merges two tiny valid PDFs",
  async fn() {
    const result = await mergePdfs([
      { name: "one.pdf", bytes: tinyPdf() },
      { name: "two.pdf", bytes: tinyPdf() },
    ]);
    assert(result.pdf.length > 100);
    assertEquals(new TextDecoder().decode(result.pdf.subarray(0, 5)), "%PDF-");
    assertEquals(await pdfPageCount(result.pdf), 2);
    assertEquals(result.skipped, []);
  },
});
