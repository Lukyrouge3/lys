import type { Tool, ToolContext } from "@/tools/tool.ts";
import { nextcloud } from "@/files/nextcloud.ts";
import { normalizePath } from "@/files/paths.ts";
import type { DavEntry } from "@/files/format.ts";

// Keep one read to roughly a fifth of the context window. At ~3 chars per
// token, contextWindow * 0.6 chars is about 20% of the tokens.
export function readLimit(contextWindow?: number): number {
  const window = contextWindow ?? 8192;
  return Math.min(120_000, Math.max(8_000, Math.floor(window * 0.6)));
}

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonl",
  "csv",
  "tsv",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "log",
  "html",
  "htm",
  "xml",
  "css",
  "js",
  "mjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rb",
  "go",
  "rs",
  "sh",
  "sql",
  "ics",
  "vcf",
]);

function isText(entry: DavEntry): boolean {
  const mime = entry.mime ?? "";
  if (mime.startsWith("text/")) return true;
  if (/^application\/(json|xml|yaml|x-yaml|javascript|x-sh)/.test(mime)) {
    return true;
  }
  const dot = entry.basename.lastIndexOf(".");
  const extension = dot === -1
    ? ""
    : entry.basename.slice(dot + 1).toLowerCase();
  return TEXT_EXTENSIONS.has(extension);
}

export class ReadFileTool implements Tool {
  name = "read_file";
  description =
    "Read a text file from your Nextcloud. Use it to quote or summarize a document, check a note, or see what a file contains before changing it. Binary files can't be read; send those with send_file.";
  arguments = { path: "string" };
  argumentDescriptions = {
    path: 'Path to the file, e.g. "Notes/todo.md".',
  };
  requiredArguments = ["path"];
  requireApproval = false;

  async run(
    context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const path = normalizePath(args.path);
    const dav = nextcloud();

    if (!(await dav.exists(path))) {
      throw new Error(`Nothing read: "${path}" does not exist.`);
    }

    const entry = await dav.stat(path) as DavEntry;
    if (entry.type === "directory") {
      throw new Error(
        `Nothing read: "${path}" is a folder. Use list_files to see inside it.`,
      );
    }
    if (!isText(entry)) {
      throw new Error(
        `Nothing read: "${path}" is not a text file${
          entry.mime ? ` (${entry.mime})` : ""
        }. Use send_file to send it to the user.`,
      );
    }

    const content = await dav.getFileContents(path, {
      format: "text",
    }) as string;

    const maxChars = readLimit(context.contextWindow);
    if (content.length <= maxChars) return content;
    return `${
      content.slice(0, maxChars)
    }\n\n[truncated: showing the first ${maxChars} of ${content.length} characters]`;
  }
}
