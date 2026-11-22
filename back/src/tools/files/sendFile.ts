import type { Tool, ToolContext } from "@/tools/tool.ts";
import { normalizePath } from "@/files/paths.ts";
import { nextcloud } from "@/files/nextcloud.ts";
import { createShare, expiryDate, type ShareResult } from "@/files/share.ts";
import { cleanForContext, formatSize } from "@/files/format.ts";

// Discord's default upload limit is 10 MB; stay under it so a big file is
// refused before a slow upload instead of failing halfway through.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const LINK_DAYS = 7;

/** The DAV calls send_file needs, so tests can supply a fake client. */
export type SendFileDav = {
  exists: (path: string) => Promise<boolean>;
  stat: (path: string) => Promise<unknown>;
  getFileContents: (
    path: string,
    options: { format: "binary" },
  ) => Promise<unknown>;
};

export type SendFileDeps = {
  dav?: SendFileDav;
  share?: (path: string, mode: "link", days: number) => Promise<ShareResult>;
};

export class SendFileTool implements Tool {
  name = "send_file";
  description =
    "Send a file from your Nextcloud to the user. In chats that support attachments it is uploaded directly; otherwise the user gets a temporary download link — when the result contains a link, include it in your reply. If the upload fails, report the error instead; no public link is made as a fallback.";
  arguments = { path: "string" };
  argumentDescriptions = {
    path: 'Path in your Nextcloud, e.g. "Mail/2026/invoice.pdf".',
  };
  requiredArguments = ["path"];
  requireApproval = true;

  constructor(private deps: SendFileDeps = {}) {}

  async run(
    context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const path = normalizePath(args.path);
    const dav: SendFileDav = this.deps.dav ?? nextcloud();

    if (!(await dav.exists(path))) {
      throw new Error(
        `Nothing sent: "${
          cleanForContext(path)
        }" does not exist in your Nextcloud.`,
      );
    }

    // `details: false` (the default) returns a bare FileStat
    const stat = await dav.stat(path) as { type: string; size: number };
    if (stat.type === "directory") {
      throw new Error(
        `Nothing sent: "${
          cleanForContext(path)
        }" is a folder. Use share_folder for folders.`,
      );
    }

    const name = cleanForContext(
      path.split("/").filter(Boolean).pop() ?? "file",
    );
    const sendFile = context.sendFile;

    if (!sendFile) {
      return await this.sendLink(path, name);
    }

    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Nothing sent: "${name}" is ${formatSize(stat.size)}, over the ${
          formatSize(MAX_ATTACHMENT_BYTES)
        } attachment limit. No public link was created.`,
      );
    }

    let data: Uint8Array;
    try {
      const contents = await dav.getFileContents(path, { format: "binary" });
      data = contents instanceof Uint8Array
        ? contents
        : new Uint8Array(contents as ArrayBuffer);
    } catch (err) {
      throw new Error(
        `Nothing sent: could not read "${name}" (${
          cleanForContext(String(err))
        }). No public link was created.`,
        { cause: err },
      );
    }

    try {
      await sendFile({ name, data });
    } catch (err) {
      // Fail closed: a transient upload error must not turn a private file
      // into a world-readable URL.
      throw new Error(
        `Nothing sent: the attachment upload for "${name}" failed (${
          cleanForContext(String(err))
        }). No public link was created.`,
        { cause: err },
      );
    }
    return `Sent "${name}" as an attachment.`;
  }

  /** Only chats without a native upload get a link. */
  private async sendLink(path: string, name: string): Promise<string> {
    const share = await (this.deps.share ?? createShare)(
      path,
      "link",
      LINK_DAYS,
    );
    if (!share.url) {
      throw new Error(
        `Nothing sent: Nextcloud created a link for "${
          cleanForContext(path)
        }" but returned no URL.`,
      );
    }
    const until = share.expiration?.slice(0, 10) ?? expiryDate(LINK_DAYS);
    return `Sent "${name}" as a temporary link: ${share.url} (valid until ${until}).`;
  }
}
