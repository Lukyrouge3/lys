import type { Tool, ToolContext } from "@/tools/tool.ts";
import { nextcloud } from "@/files/nextcloud.ts";
import { normalizeFolder } from "@/files/paths.ts";
import { type DavEntry, formatEntry } from "@/files/format.ts";

const MAX_ENTRIES = 200;

export class ListFilesTool implements Tool {
  name = "list_files";
  description =
    "List the contents of a folder in your Nextcloud. Use it to see what is there before reading, moving, or sharing a file.";
  arguments = { path: "string" };
  argumentDescriptions = {
    path: 'Folder path, e.g. "Mail/2026". Omit or use "/" for the top level.',
  };
  requiredArguments = [];
  requireApproval = false;

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const folder = normalizeFolder(args.path);
    const entries = await nextcloud().getDirectoryContents(folder || "/") as
      | DavEntry[]
      | { data: DavEntry[] };

    const list = Array.isArray(entries) ? entries : entries.data;
    if (list.length === 0) {
      return folder ? `"${folder}" is empty.` : "The top level is empty.";
    }

    const sorted = [...list].sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.basename.localeCompare(b.basename);
    });
    const shown = sorted.slice(0, MAX_ENTRIES);
    const lines = shown.map(formatEntry);
    if (sorted.length > shown.length) {
      lines.push(`… and ${sorted.length - shown.length} more.`);
    }
    return lines.join("\n");
  }
}
