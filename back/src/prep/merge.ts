// Merges several PDFs into one with poppler's `pdfunite`, the same way
// typst.ts drives pdfinfo and pdftotext. A part that is not a readable PDF is
// dropped with a reason instead of taking the whole merge down: the owner's
// attachments are uploaded by hand, so one broken scan must not hide the rest.
import { join } from "node:path";
import { pdfPageCount, stderrExcerpt } from "@/prep/typst.ts";
import { withTimeout } from "@/utils/timeout.ts";

export type MergePart = {
  name: string;
  bytes: Uint8Array;
};

export type MergeSkipped = {
  name: string;
  reason: string;
};

export type MergeResult = {
  pdf: Uint8Array;
  skipped: MergeSkipped[];
};

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/** Runs one pdfunite invocation; injected in tests so they need no binary. */
export type MergeRunner = (
  bin: string,
  args: string[],
  cwd: string,
) => Promise<RunResult>;

export type MergeDeps = {
  /** Injected in tests; the real poppler binary otherwise. */
  runner?: MergeRunner;
  /** A readability probe for one part; pdfinfo through typst.ts by default. */
  pageCount?: (pdf: Uint8Array) => Promise<number>;
};

const MERGE_TIMEOUT_MS = 60_000;
const HEADER_PROBE_BYTES = 1024;

/** The pdfunite CLI to run (env PDFUNITE_BIN, default `pdfunite` on PATH). */
export function pdfuniteBinary(): string {
  return Deno.env.get("PDFUNITE_BIN")?.trim() || "pdfunite";
}

/**
 * Validates every part, writes the readable ones into a fresh temp directory,
 * and merges them in the given order. When the combined call fails anyway (a
 * damaged file pdfinfo accepted), parts are merged one at a time so only the
 * offender is skipped.
 */
export async function mergePdfs(
  parts: MergePart[],
  { runner = runPdfunite, pageCount = pdfPageCount }: MergeDeps = {},
): Promise<MergeResult> {
  const bin = pdfuniteBinary();
  const skipped: MergeSkipped[] = [];
  const valid: MergePart[] = [];

  for (const part of parts) {
    if (part.bytes.length === 0) {
      skipped.push({ name: part.name, reason: "the file is empty" });
      continue;
    }
    if (!looksLikePdf(part.bytes)) {
      skipped.push({
        name: part.name,
        reason: "not a PDF (the %PDF- header is missing)",
      });
      continue;
    }
    try {
      const pages = await pageCount(part.bytes);
      if (!Number.isFinite(pages) || pages < 0) {
        throw new Error(`pdfinfo reported an invalid page count (${pages})`);
      }
    } catch (error) {
      skipped.push({
        name: part.name,
        reason: `unreadable PDF: ${errorText(error)}`,
      });
      continue;
    }
    valid.push(part);
  }

  if (valid.length === 0) {
    const why = skipped.length > 0
      ? `every part was skipped: ${describeSkipped(skipped)}`
      : "no parts were given";
    throw new Error(`No valid PDF to merge: ${why}.`);
  }

  const dir = await Deno.makeTempDir({ prefix: "prep-merge-" });
  try {
    const files: { name: string; file: string }[] = [];
    for (let index = 0; index < valid.length; index++) {
      const file = `part-${String(index).padStart(4, "0")}.pdf`;
      await Deno.writeFile(join(dir, file), valid[index].bytes);
      files.push({ name: valid[index].name, file });
    }

    const combined = await runner(bin, [
      ...files.map((entry) => entry.file),
      "merged.pdf",
    ], dir);
    if (combined.code === 0) {
      return {
        pdf: await Deno.readFile(join(dir, "merged.pdf")),
        skipped,
      };
    }

    // Fall back to pairwise merges, so one file pdfunite rejects does not lose
    // the others. Pre-validation already dropped the obvious bad parts.
    const merged = await mergeOneByOne(bin, files, dir, runner, skipped);
    if (merged === null) {
      throw new Error(
        `pdfunite could not merge any of the ${valid.length} readable PDFs: ${
          stderrExcerpt(combined.stderr)
        }`,
      );
    }
    return { pdf: merged, skipped };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** True when the first bytes carry the PDF signature (allowing a small prefix). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const probe = new TextDecoder().decode(
    bytes.subarray(0, HEADER_PROBE_BYTES),
  );
  return probe.includes("%PDF-");
}

/**
 * Merges the written parts two at a time, dropping a part whose merge fails.
 * Returns null when even the first readable part could not be copied.
 */
async function mergeOneByOne(
  bin: string,
  files: { name: string; file: string }[],
  dir: string,
  runner: MergeRunner,
  skipped: MergeSkipped[],
): Promise<Uint8Array | null> {
  let current: Uint8Array | null = null;

  for (const { name, file } of files) {
    if (current === null) {
      const single = await runner(bin, [file, "single.pdf"], dir);
      if (single.code !== 0) {
        skipped.push({
          name,
          reason: `pdfunite could not read it: ${stderrExcerpt(single.stderr)}`,
        });
        continue;
      }
      current = await Deno.readFile(join(dir, "single.pdf"));
      continue;
    }

    await Deno.writeFile(join(dir, "current.pdf"), current);
    const pairwise = await runner(bin, ["current.pdf", file, "next.pdf"], dir);
    if (pairwise.code !== 0) {
      skipped.push({
        name,
        reason: `pdfunite could not merge it: ${
          stderrExcerpt(pairwise.stderr)
        }`,
      });
      continue;
    }
    current = await Deno.readFile(join(dir, "next.pdf"));
  }

  return current;
}

async function runPdfunite(
  bin: string,
  args: string[],
  cwd: string,
): Promise<RunResult> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(bin, {
      args,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `pdfunite not found: tried "${bin}". Install poppler-utils or set PDFUNITE_BIN to the pdfunite binary.`,
      );
    }
    throw error;
  }

  const collected = (async () => {
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: status.code, stdout, stderr };
  })();

  try {
    return await withTimeout(collected, MERGE_TIMEOUT_MS, "pdfunite");
  } catch (error) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    throw error;
  }
}

function describeSkipped(skipped: MergeSkipped[]): string {
  return skipped.map((entry) => `${entry.name} (${entry.reason})`).join(", ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
