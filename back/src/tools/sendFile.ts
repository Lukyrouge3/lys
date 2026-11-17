import type { Tool, ToolContext } from "@/tools/tool.ts";
import { normalizePath } from "@/files/paths.ts";
import { nextcloud } from "@/files/nextcloud.ts";
import { createShare, expiryDate } from "@/files/share.ts";
import { logger } from "@/utils/logger.ts";

// Discord's default upload limit is 10 MB; stay under it so a big file goes
// straight to a link instead of failing after a slow upload.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const LINK_DAYS = 7;

export class SendFileTool implements Tool {
  name = "send_file";
  description =
    "Send a file from your Nextcloud to the user. In chats that support attachments it is uploaded directly; otherwise, or if the upload fails, the user gets a temporary download link — when the result contains a link, include it in your reply. Use it when they ask for a file or when you saved something for them.";
  arguments = { path: "string" };
  argumentDescriptions = {
    path: 'Path in your Nextcloud, e.g. "Mail/2026/invoice.pdf".',
  };
  requiredArguments = ["path"];
  requireApproval = true;

  async run(
    context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const path = normalizePath(args.path);
    const dav = nextcloud();

    if (!(await dav.exists(path))) {
      throw new Error(
        `Nothing sent: "${path}" does not exist in your Nextcloud.`,
      );
    }

    // `details: false` (the default) returns a bare FileStat
    const stat = await dav.stat(path) as { type: string; size: number };
    if (stat.type === "directory") {
      throw new Error(
        `Nothing sent: "${path}" is a folder. Use share_folder for folders.`,
      );
    }

    const name = path.split("/").filter(Boolean).pop() ?? "file";
    const sendFile = context.sendFile;

    if (sendFile && stat.size <= MAX_ATTACHMENT_BYTES) {
      try {
        const contents = await dav.getFileContents(path, {
          format: "binary",
        }) as Uint8Array | ArrayBuffer;
        const data = contents instanceof Uint8Array
          ? contents
          : new Uint8Array(contents);
        await sendFile({ name, data });
        return `Sent "${name}" as an attachment.`;
      } catch (err) {
        // The chat refused the upload (size, permissions, network): a link
        // still gets the file to them
        logger.warn(`Attachment failed, sending a link instead: ${err}`);
      }
    }

    const share = await createShare(path, "link", LINK_DAYS);
    if (!share.url) {
      throw new Error(
        `Nothing sent: Nextcloud created a link for "${path}" but returned no URL.`,
      );
    }
    const until = share.expiration?.slice(0, 10) ?? expiryDate(LINK_DAYS);
    return `Sent "${name}" as a temporary link: ${share.url} (valid until ${until}).`;
  }
}
