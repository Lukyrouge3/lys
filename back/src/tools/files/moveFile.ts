import type { Tool, ToolContext } from "@/tools/tool.ts";
import { nextcloud } from "@/files/nextcloud.ts";
import { normalizePath, parentOf } from "@/files/paths.ts";
import { moveLedgerPaths, syncLedger } from "@/mail/ledger.ts";

export class MoveFileTool implements Tool {
  name = "move_file";
  description =
    "Move or rename a file or folder in your Nextcloud. Missing parent folders at the destination are created. Refuses to overwrite something that already exists. A document filed from an email has its mail ledger entry moved with it.";
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

    const parent = parentOf(to);
    if (parent && !(await dav.exists(parent))) {
      await dav.createDirectory(parent, { recursive: true });
    }

    await dav.moveFile(from, to);
    const ledger = await syncLedger(
      () => moveLedgerPaths(from, to),
      "updated",
    );
    return `Moved "${from}" to "${to}".${ledger}`;
  }
}
