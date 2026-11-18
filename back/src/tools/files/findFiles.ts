import type { Tool, ToolContext } from "@/tools/tool.ts";
import { nextcloud } from "@/files/nextcloud.ts";
import { normalizeFolder } from "@/files/paths.ts";
import { type DavEntry, entryPath, formatPathEntry } from "@/files/format.ts";

const MAX_RESULTS = 100;

export class FindFilesTool implements Tool {
  name = "find_files";
  description =
    'Search under a folder in your Nextcloud by file name. Supports glob patterns like "*.pdf" or "invoice*". A deep search can be slow on very large folders, so narrow the path when you can.';
  arguments = { path: "string", pattern: "string" };
  argumentDescriptions = {
    path: 'Folder to search in, e.g. "Mail/2026". Omit for the whole account.',
    pattern: 'Glob to match file names, e.g. "*.pdf". Defaults to "*".',
  };
  requiredArguments = [];
  requireApproval = false;

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const folder = normalizeFolder(args.path);
    const pattern = typeof args.pattern === "string"
      ? args.pattern.trim() || "*"
      : "*";

    const entries = await nextcloud().getDirectoryContents(folder || "/", {
      deep: true,
      glob: pattern,
    }) as DavEntry[] | { data: DavEntry[] };

    const list = Array.isArray(entries) ? entries : entries.data;
    if (list.length === 0) {
      return folder
        ? `No files matching "${pattern}" under "${folder}".`
        : `No files matching "${pattern}".`;
    }

    const sorted = [...list].sort((a, b) =>
      entryPath(a).localeCompare(entryPath(b))
    );
    const shown = sorted.slice(0, MAX_RESULTS);
    const lines = shown.map(formatPathEntry);
    if (sorted.length > shown.length) {
      lines.push(`… and ${sorted.length - shown.length} more matches.`);
    }
    return lines.join("\n");
  }
}
