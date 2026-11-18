import { Tool, ToolContext } from "@/tools/tool.ts";
import { nextcloud } from "@/files/nextcloud.ts";
import { createShare, expiryDate, type ShareMode } from "@/files/share.ts";
import { normalizePath } from "@/files/paths.ts";

// Re-exported for the tool's tests and callers
export { normalizePath };

export function parseMode(value: unknown): ShareMode {
  if (value === undefined || value === null || value === "") return "user";
  if (value === "user" || value === "link") return value;
  throw new Error(
    'Nothing shared: mode must be "user" (direct share) or "link" (public link).',
  );
}

const DEFAULT_LINK_DAYS = 7;

export function parseExpiresInDays(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_LINK_DAYS;
  }
  const days = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error(
      `Nothing shared: expires_in_days must be a whole number from 1 to 365, got ${
        String(value)
      }.`,
    );
  }
  return days;
}

export class ShareFolderTool implements Tool {
  name = "share_folder";
  description =
    'Share a folder or file from your Nextcloud so the user can open it. mode "user" (default) puts it in their Nextcloud under Shared with you; mode "link" returns a public link that anyone can open, so it needs their approval and expires after expires_in_days (default 7). Use it when they ask for a file, or when pointing them at something you saved, like mail attachments.';
  arguments = { path: "string", mode: "string", expires_in_days: "number" };
  argumentDescriptions = {
    path:
      'Path in your Nextcloud, e.g. "Mail/2026/invoice" or "Mail/2026/invoice/x.pdf".',
    mode:
      '"user" (default, direct share) or "link" (public link, needs approval).',
    expires_in_days:
      'Only for mode "link": whole number of days the link stays valid, 1-365. Default 7.',
  };
  requiredArguments = ["path"];
  // A public link leaves their Nextcloud, so the owner decides first
  requireApproval = (args: Record<string, unknown>) => args.mode === "link";

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const path = normalizePath(args.path);
    const mode = parseMode(args.mode);
    const expiresInDays = mode === "link"
      ? parseExpiresInDays(args.expires_in_days)
      : undefined;

    if (!(await nextcloud().exists(path))) {
      throw new Error(
        `Nothing shared: "${path}" does not exist in your Nextcloud.`,
      );
    }

    const share = await createShare(path, mode, expiresInDays);
    if (mode === "link") {
      const until = share.expiration?.slice(0, 10) ??
        expiryDate(expiresInDays!);
      return `Public link for "${path}": ${share.url}. Valid until ${until}.`;
    }
    return `Shared "${path}" with the user. It is in their Nextcloud under "Shared with you".`;
  }
}
