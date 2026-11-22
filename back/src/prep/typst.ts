// Typst and PDF plumbing for application prep, run in-process: the bot image
// carries the pinned Typst 0.15.1 static binary plus the fonts and vendored
// @preview packages that produced the owner's reference CV (see
// assets/typst/README.md). On the host, ~/job/typst runs the same binary in
// its own image with `--network none`; here the package cache is made
// read-only, so a package missing from vendor/ fails instead of being
// downloaded. The py/pdf tools come from poppler-utils, like inspect.sh.
import { dirname, join } from "node:path";
import { withTimeout } from "@/utils/timeout.ts";

export type CompileOptions = {
  /** The .typ document to compile. */
  source: string;
  /** Further files written beside it, keyed by relative path. */
  extraFiles?: Record<string, string>;
};

export type CompileResult = {
  pdf: Uint8Array;
  /** Typst's warnings, one message per entry, without the source excerpt. */
  warnings: string[];
};

const COMPILE_TIMEOUT_MS = 60_000;
const PDF_TIMEOUT_MS = 30_000;
const STDERR_LIMIT = 2000;

/** The directory holding fonts/, vendor/ and base/ (env TYPST_ASSETS). */
export function typstAssetsDir(): string {
  const dir = Deno.env.get("TYPST_ASSETS")?.trim() ||
    join(Deno.cwd(), "assets", "typst");
  return dir.replace(/\/+$/, "");
}

/** The typst CLI to run (env TYPST_BIN, default `typst` on PATH). */
export function typstBinary(): string {
  return Deno.env.get("TYPST_BIN")?.trim() || "typst";
}

/**
 * Compiles one document into a PDF. The source never touches the repository:
 * it is written into a fresh temp directory together with `extraFiles`, and
 * that directory is removed whatever happens.
 */
export async function compileTypst(
  { source, extraFiles = {} }: CompileOptions,
): Promise<CompileResult> {
  const assets = typstAssetsDir();
  const fonts = join(assets, "fonts");
  const vendor = join(assets, "vendor");
  // Nonetheless create the directory: typst wants it to exist.
  const dir = await Deno.makeTempDir({ prefix: "prep-typst-" });
  const cache = join(dir, "package-cache");

  try {
    await Deno.writeTextFile(join(dir, "main.typ"), source);
    for (const [name, content] of Object.entries(extraFiles)) {
      const path = join(dir, safeRelative(name));
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, content);
    }

    await Deno.mkdir(cache);
    // No --network flag exists for `typst compile`; a cache directory nobody
    // may write to gives the same guarantee. Restored before removal below.
    await Deno.chmod(cache, 0o555);

    const typst = typstBinary();
    const { code, stderr } = await run(typst, [
      "compile",
      "--root",
      dir,
      "--font-path",
      fonts,
      "--package-path",
      vendor,
      "--package-cache-path",
      cache,
      "main.typ",
      "main.pdf",
    ], {
      cwd: dir,
      timeoutMs: COMPILE_TIMEOUT_MS,
      missing:
        `typst not found: tried "${typst}", set TYPST_BIN to the typst 0.15.1 binary (the bot image installs it at /usr/local/bin/typst).`,
    });

    if (code !== 0) {
      throw new Error(
        `typst compile failed (exit ${code}):\n${stderrExcerpt(stderr)}`,
      );
    }

    return {
      pdf: await Deno.readFile(join(dir, "main.pdf")),
      warnings: parseWarnings(stderr),
    };
  } finally {
    try {
      await Deno.chmod(cache, 0o755);
    } catch {
      // The compile may have failed before the cache existed.
    }
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Typst prints `warning: <message>` and then an indented excerpt of the
 * source, so only the first line of each warning is a message.
 */
export function parseWarnings(stderr: string): string[] {
  const warnings: string[] = [];
  for (const line of stderr.split("\n")) {
    const match = /^warning: (.*)$/.exec(line.trimEnd());
    if (match) warnings.push(match[1].trim());
  }
  return warnings;
}

/** A stderr dump short enough to put in an error message. */
export function stderrExcerpt(
  stderr: string,
  limit = STDERR_LIMIT,
): string {
  const text = stderr.trim();
  if (!text) return "(no stderr)";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (truncated, ${
    text.length - limit
  } more characters)`;
}

/** Page count of a compiled PDF, through `pdfinfo`. */
export async function pdfPageCount(pdf: Uint8Array): Promise<number> {
  const info = await withPdfFile(pdf, "pdfinfo", [], [], "pdfinfo");
  const match = /^Pages:\s+(\d+)\s*$/m.exec(info);
  if (!match) {
    throw new Error(`pdfinfo printed no page count:\n${stderrExcerpt(info)}`);
  }
  return Number(match[1]);
}

/** The text of a compiled PDF, through `pdftotext -layout` (as inspect.sh). */
export function pdfText(pdf: Uint8Array): Promise<string> {
  return withPdfFile(pdf, "pdftotext", ["-layout"], ["-"], "pdftotext");
}

async function withPdfFile(
  pdf: Uint8Array,
  bin: string,
  argsBefore: string[],
  argsAfter: string[],
  label: string,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "prep-pdf-" });
  try {
    const file = join(dir, "document.pdf");
    await Deno.writeFile(file, pdf);
    const { code, stdout, stderr } = await run(bin, [
      ...argsBefore,
      file,
      ...argsAfter,
    ], {
      timeoutMs: PDF_TIMEOUT_MS,
      missing:
        `${bin} not found: install poppler-utils (the bot image does); ${label} reads compiled PDFs.`,
    });
    if (code !== 0) {
      throw new Error(
        `${label} failed (exit ${code}):\n${stderrExcerpt(stderr)}`,
      );
    }
    return stdout;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Extra files may live in subfolders, but never outside the temp directory. */
function safeRelative(name: string): string {
  if (!name || name.startsWith("/") || name.split("/").includes("..")) {
    throw new Error(`Invalid extra file name: "${name}".`);
  }
  return name;
}

type RunOptions = {
  cwd?: string;
  timeoutMs: number;
  /** Error text when the binary is not installed. */
  missing: string;
};

/** Runs a binary, keeps its streams, and never waits longer than `timeoutMs`. */
async function run(
  bin: string,
  args: string[],
  { cwd, timeoutMs, missing }: RunOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
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
    if (error instanceof Deno.errors.NotFound) throw new Error(missing);
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
    return await withTimeout(
      collected,
      timeoutMs,
      `${bin} ${args[0] ?? ""}`.trim(),
    );
  } catch (error) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    throw error;
  }
}
