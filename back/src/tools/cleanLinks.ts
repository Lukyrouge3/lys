import { Tool, ToolContext } from "@/tools/tool.ts";
import { deleteShare, isExpired, listShares } from "@/files/share.ts";

// OCS share_type 3 is a public link
const LINK_SHARE_TYPE = 3;

export type CleanScope = "expired" | "all";

export function parseScope(value: unknown): CleanScope {
  if (value === undefined || value === null || value === "") return "expired";
  if (value === "expired" || value === "all") return value;
  throw new Error(
    'Nothing cleaned: scope must be "expired" (links past their expiry) or "all" (every public link).',
  );
}

export class CleanLinksTool implements Tool {
  name = "clean_links";
  description =
    'Remove public share links from your Nextcloud. By default only links whose expiration date has passed are removed; use scope "all" to remove every public link. Use it when the user asks to clean up old or expired share links. Requires their approval.';
  arguments = { scope: "string" };
  argumentDescriptions = {
    scope:
      '"expired" (default) removes links past their expiration date; "all" removes every public link.',
  };
  requiredArguments = [];
  requireApproval = true;

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const scope = parseScope(args.scope);

    const links = (await listShares()).filter((share) =>
      share.shareType === LINK_SHARE_TYPE
    );
    const targets = scope === "all"
      ? links
      : links.filter((share) => isExpired(share.expiration));

    if (targets.length === 0) {
      return scope === "all"
        ? "No public links to remove."
        : "No expired public links to remove.";
    }

    const removed: string[] = [];
    const failed: string[] = [];
    let firstError = "";
    for (const link of targets) {
      const name = link.path ?? link.target ?? link.id;
      try {
        await deleteShare(link.id);
        removed.push(name);
      } catch (error) {
        if (!firstError) {
          firstError = error instanceof Error ? error.message : String(error);
        }
        failed.push(name);
      }
    }

    // Every delete failed: report it as an error so the model doesn't claim
    // the links are gone
    if (removed.length === 0) {
      throw new Error(
        `Nothing cleaned: all ${failed.length} link(s) failed to delete. ${firstError}`,
      );
    }

    const summary = `Removed ${removed.length} public link(s): ${
      removed.join(", ")
    }.`;
    return failed.length === 0
      ? summary
      : `${summary} Failed to remove ${failed.length}: ${
        failed.join(", ")
      }. ${firstError}`;
  }
}
