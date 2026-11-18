import prisma from "@/db.ts";
import { putFile } from "@/files/nextcloud.ts";
import { classifyDocument } from "@/mail/classify.ts";
import type { MailAttachment, MailEvent } from "@/mail/watcher.ts";
import { logger } from "@/utils/logger.ts";

export const MAIL_DOCUMENTS_ROOT = Deno.env.get("MAIL_DOCUMENTS_FOLDER") ??
  "Mail";
const MAX_NAME_CHARS = 60;

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/zip": "zip",
  "application/json": "json",
};

export async function sha256Hex(content: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(content));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** File-system safe, and short enough to stay readable in a file list. */
export function sanitizeName(value: string, limit = MAX_NAME_CHARS): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    // deno-lint-ignore no-control-regex -- stripping control characters is the point
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  return cleaned.slice(0, limit).trim() || "unknown";
}

export function senderLabel(from: string): string {
  const name = from.split("<")[0].trim();
  if (name && !name.includes("@")) return name;
  const address = from.match(/[\w.+-]+@([\w-]+)/);
  return address?.[1] ?? address?.[0] ?? "unknown";
}

function extension(filename: string, mime: string): string {
  const fromName = filename.split(".").pop();
  if (fromName && fromName !== filename) {
    return sanitizeName(fromName, 5).replace(/\s+/g, "").toLowerCase();
  }
  return EXTENSIONS[mime] ?? "bin";
}

function baseName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/**
 * Mail/2026/invoice/2026-11-17 Ana - receipt.pdf
 * The ledger keeps the path, so this only has to be easy to browse.
 */
export function documentPath(
  mail: Pick<MailEvent, "date" | "from">,
  category: string,
  attachment: Pick<MailAttachment, "filename" | "mime">,
  suffix = "",
): string {
  const date = (mail.date ?? new Date()).toISOString().slice(0, 10);
  const sender = sanitizeName(senderLabel(mail.from), 30);
  const title = sanitizeName(baseName(attachment.filename), 70);
  const ext = extension(attachment.filename, attachment.mime);
  return `${MAIL_DOCUMENTS_ROOT}/${date.slice(0, 4)}/${
    sanitizeName(category, 20)
  }/` +
    `${date} ${sender} - ${title}${suffix}.${ext}`;
}

/**
 * Saves every attachment of one message to Nextcloud and records it in the
 * ledger. Returns how many files were stored; identical files are skipped.
 */
export async function storeAttachments(
  mail: MailEvent,
  attachments: MailAttachment[],
): Promise<number> {
  let stored = 0;

  for (const attachment of attachments) {
    try {
      const sha256 = await sha256Hex(attachment.content);
      const known = await prisma.mailDocument.findUnique({ where: { sha256 } });
      if (known) continue;

      const category = await classifyDocument({
        filename: attachment.filename,
        mime: attachment.mime,
        from: mail.from,
        subject: mail.subject,
        preview: mail.preview,
      });

      let path = documentPath(mail, category, attachment);
      const taken = await prisma.mailDocument.count({ where: { path } });
      if (taken > 0) {
        path = documentPath(
          mail,
          category,
          attachment,
          ` ${sha256.slice(0, 8)}`,
        );
      }

      // The name is chosen above to be free, and the alternative to replacing
      // is losing the attachment, so the mail pipeline opts in explicitly.
      await putFile(path, attachment.content, { overwrite: true });
      await prisma.mailDocument.create({
        data: {
          accountId: mail.accountId,
          folder: mail.folder,
          uid: mail.uid,
          from: mail.from,
          subject: mail.subject,
          receivedAt: mail.date ?? new Date(),
          filename: attachment.filename,
          mime: attachment.mime,
          bytes: attachment.content.byteLength,
          sha256,
          path,
          category,
        },
      });
      stored++;
    } catch (err) {
      // One bad attachment must not stop the others or the watcher
      logger.warn(
        `Storing attachment ${attachment.filename} of mail ${mail.uid} failed: ${err}`,
      );
    }
  }

  return stored;
}
