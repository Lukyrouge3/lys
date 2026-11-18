import prisma from "@/db.ts";
import { MAIL_DOCUMENTS_ROOT } from "@/mail/documents.ts";
import { logger } from "@/utils/logger.ts";

/** The path itself, plus everything inside it when it is a folder. */
function subtree(path: string) {
  return { OR: [{ path }, { path: { startsWith: `${path}/` } }] };
}

/** Where a ledger path goes when `from` becomes `to`, or null when it is elsewhere. */
export function rebasePath(
  path: string,
  from: string,
  to: string,
): string | null {
  if (path === from) return to;
  const prefix = `${from}/`;
  return path.startsWith(prefix) ? `${to}/${path.slice(prefix.length)}` : null;
}

/** The category folder of a filed mail document, e.g. "medical". */
export function categoryOf(
  path: string,
  root = MAIL_DOCUMENTS_ROOT,
): string | null {
  const prefix = `${root}/`;
  if (!path.startsWith(prefix)) return null;
  const [year, category, file] = path.slice(prefix.length).split("/");
  if (!file || !/^\d{4}$/.test(year)) return null;
  return category || null;
}

/**
 * Keeps the ledger in step when a file or folder is moved in Nextcloud, so the
 * mail that brought a document in still points at where it actually lives now.
 */
export async function moveLedgerPaths(
  from: string,
  to: string,
): Promise<number> {
  const rows = await prisma.mailDocument.findMany({
    where: subtree(from),
    select: { id: true, path: true },
  });

  for (const row of rows) {
    const path = rebasePath(row.path, from, to);
    if (!path) continue;
    // A move between category folders re-files the document, so keep it in step
    const category = categoryOf(path);
    await prisma.mailDocument.update({
      where: { id: row.id },
      data: category ? { path, category } : { path },
    });
  }
  return rows.length;
}

/** Drops the ledger rows of a deleted file or folder, so the next backfill can store it again. */
export async function deleteLedgerPaths(path: string): Promise<number> {
  const { count } = await prisma.mailDocument.deleteMany({
    where: subtree(path),
  });
  return count;
}

/**
 * Ledger syncing never fails the file operation: the file already moved or is
 * already gone, so a stale ledger is reported, not thrown.
 */
export async function syncLedger(
  action: () => Promise<number>,
  what: string,
): Promise<string> {
  try {
    const rows = await action();
    return rows === 0
      ? ""
      : ` ${rows} ledger ${rows === 1 ? "entry" : "entries"} ${what}.`;
  } catch (err) {
    logger.warn(`Mail ledger was not updated: ${err}`);
    return ` The mail ledger was not updated: ${err}`;
  }
}
