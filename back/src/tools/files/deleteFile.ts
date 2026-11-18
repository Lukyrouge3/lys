import type { Tool, ToolContext } from "@/tools/tool.ts";
import { nextcloud } from "@/files/nextcloud.ts";
import { normalizePath } from "@/files/paths.ts";
import type { DavEntry } from "@/files/format.ts";
import { deleteLedgerPaths, syncLedger } from "@/mail/ledger.ts";

export class DeleteFileTool implements Tool {
  name = "delete_file";
  description =
    "Delete a file from your Nextcloud, or a folder when recursive is true. Deleting is permanent and needs the user's approval. Prefer moving a file somewhere safe if you are unsure. Documents filed from an email also lose their mail ledger entry.";
  arguments = { path: "string", recursive: "boolean" };
  argumentDescriptions = {
    path: 'Path to delete, e.g. "Downloads/old.pdf".',
    recursive:
      "Set true to delete a folder and everything inside it. Required for folders.",
  };
  requiredArguments = ["path"];
  // Permanent: the owner decides first
  requireApproval = true;

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const path = normalizePath(args.path);
    const dav = nextcloud();

    if (!(await dav.exists(path))) {
      throw new Error(`Nothing deleted: "${path}" does not exist.`);
    }

    const entry = await dav.stat(path) as DavEntry;
    if (entry.type === "directory" && args.recursive !== true) {
      throw new Error(
        `Nothing deleted: "${path}" is a folder. Pass recursive true to delete it and everything inside.`,
      );
    }

    await dav.deleteFile(path);
    const ledger = await syncLedger(
      () => deleteLedgerPaths(path),
      "removed",
    );
    return `Deleted "${path}".${ledger}`;
  }
}
