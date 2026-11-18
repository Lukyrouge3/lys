import type { Tool, ToolContext } from "@/tools/tool.ts";
import { nextcloud } from "@/files/nextcloud.ts";
import { normalizePath } from "@/files/paths.ts";
import type { DavEntry } from "@/files/format.ts";

export class CreateFolderTool implements Tool {
  name = "create_folder";
  description =
    "Create a folder in your Nextcloud. Missing parent folders are created too. Does nothing if the folder already exists.";
  arguments = { path: "string" };
  argumentDescriptions = {
    path: 'Folder to create, e.g. "Mail/2026/invoices".',
  };
  requiredArguments = ["path"];
  requireApproval = false;

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const path = normalizePath(args.path);
    const dav = nextcloud();

    if (await dav.exists(path)) {
      const entry = await dav.stat(path) as DavEntry;
      if (entry.type === "directory") {
        return `Folder "${path}" already exists.`;
      }
      throw new Error(
        `Nothing created: "${path}" is a file. Use another name.`,
      );
    }

    await dav.createDirectory(path, { recursive: true });
    return `Created folder "${path}".`;
  }
}
