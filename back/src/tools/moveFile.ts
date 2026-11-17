import type { Tool, ToolContext } from "@/tools/tool.ts";
import { nextcloud } from "@/files/nextcloud.ts";
import { normalizePath } from "@/files/paths.ts";

export class MoveFileTool implements Tool {
  name = "move_file";
  description =
    "Move or rename a file or folder in your Nextcloud. Missing parent folders at the destination are created. Refuses to overwrite something that already exists.";
  arguments = { from: "string", to: "string" };
  argumentDescriptions = {
    from: 'Current path, e.g. "Downloads/report.pdf".',
    to: 'New path, e.g. "Mail/2026/report.pdf".',
  };
  requiredArguments = ["from", "to"];
  requireApproval = false;

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const from = normalizePath(args.from);
    const to = normalizePath(args.to);
    const dav = nextcloud();

    if (!(await dav.exists(from))) {
      throw new Error(`Nothing moved: "${from}" does not exist.`);
    }
    if (await dav.exists(to)) {
      throw new Error(
        `Nothing moved: "${to}" already exists. Choose another name.`,
      );
    }

    const parent = to.slice(0, to.lastIndexOf("/"));
    if (parent && !(await dav.exists(parent))) {
      await dav.createDirectory(parent, { recursive: true });
    }

    await dav.moveFile(from, to);
    return `Moved "${from}" to "${to}".`;
  }
}
