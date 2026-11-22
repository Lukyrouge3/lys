// `/Postulations/Applications.md` is the one file the owner reads to know where
// every application stands. This module parses that table, updates exactly one
// row, and preserves every other line, including backlog rows and the Closed
// section. Because the owner's list is irreplaceable, a write is refused when
// the parse is uncertain or when it would lose a row, and the previous content
// is copied to Applications.md.bak first.
import type { JobStatus } from "@/generated/prisma/client.ts";
import { type DavWriter, nextcloud, putFile } from "@/files/nextcloud.ts";
import { logger } from "@/utils/logger.ts";

export const TRACKER_PATH = "Postulations/Applications.md";
export const TRACKER_BACKUP_PATH = `${TRACKER_PATH}.bak`;

export const TRACKER_COLUMNS = [
  "Applied",
  "Company",
  "Role",
  "Status",
  "Folder",
  "Next",
] as const;

export const TRACKER_STATUSES = [
  "To apply",
  "Drafted",
  "Sent",
  "Interview",
  "Offer",
  "Rejected",
  "Withdrawn",
  "Archived",
] as const;

export type TrackerStatus = (typeof TRACKER_STATUSES)[number];

export type TrackerEntry = {
  /** "2026-11-09", "?" or "—" for a backlog row. */
  applied: string;
  company: string;
  role: string;
  status: TrackerStatus;
  /** A folder path like "the-flex/2026-11-09" or "—". */
  folder: string;
  next: string;
};

export type TrackerRow = {
  /** The original line, so an untouched row is written back byte-for-byte. */
  raw: string;
  /** Six logical cells, with `\|` unescaped. */
  cells: string[];
};

export type ParsedTracker = {
  eol: "\n" | "\r\n";
  before: string[];
  header: string;
  separator: string;
  rows: TrackerRow[];
  after: string[];
};

export type TrackerDav = DavWriter & {
  getFileContents(
    path: string,
    options?: { format?: string },
  ): Promise<unknown>;
};

export type TrackerDeps = {
  /** Injected in tests; the real client otherwise. */
  dav?: TrackerDav;
};

export type UpsertResult = {
  inserted: boolean;
  rows: number;
  path: string;
};

const DEFAULT_DOCUMENT = [
  "# Applications",
  "",
  `| ${TRACKER_COLUMNS.join(" | ")} |`,
  `| ${TRACKER_COLUMNS.map(() => "---").join(" | ")} |`,
  "",
].join("\n");

/**
 * Reads the first main table and keeps the surrounding lines untouched. Returns
 * null when there is no recognisable table, so a caller can refuse to write
 * rather than replace a file it does not understand.
 */
export function parseTracker(text: string): ParsedTracker | null {
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);

  let headerAt = -1;
  for (let index = 0; index < lines.length; index++) {
    if (isMainHeader(lines[index])) {
      headerAt = index;
      break;
    }
  }
  if (headerAt === -1) return null;

  const separator = lines[headerAt + 1];
  if (separator === undefined || !isSeparator(separator)) return null;

  const rows: TrackerRow[] = [];
  let index = headerAt + 2;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim().startsWith("|")) break;
    const cells = splitRow(line);
    // A malformed row is left in `after` rather than silently dropped.
    if (cells.length !== TRACKER_COLUMNS.length) break;
    rows.push({ raw: line, cells });
  }

  return {
    eol,
    before: lines.slice(0, headerAt),
    header: lines[headerAt],
    separator,
    rows,
    after: lines.slice(index),
  };
}

/** Round-trips an untouched document exactly. */
export function renderTracker(
  parsed: ParsedTracker,
  rows: TrackerRow[] = parsed.rows,
): string {
  return [
    ...parsed.before,
    parsed.header,
    parsed.separator,
    ...rows.map((row) => row.raw),
    ...parsed.after,
  ].join(parsed.eol);
}

/** The tracker status and next action for a job status. */
export function statusToTracker(
  status: JobStatus,
  gapCount = 0,
): { status: TrackerStatus; next: string } {
  switch (status) {
    case "ready":
      return { status: "Drafted", next: "Review, then send" };
    case "review":
      return {
        status: "Drafted",
        next: `Needs review: ${gapCount} gap${
          gapCount === 1 ? "" : "s"
        }, see notes.md`,
      };
    case "applied":
      return { status: "Sent", next: "" };
    case "interview":
      return { status: "Interview", next: "" };
    case "rejected":
      return { status: "Rejected", next: "" };
    case "dropped":
      return { status: "Withdrawn", next: "" };
    case "queued":
    case "preparing":
      return { status: "To apply", next: "" };
  }
}

/** "2026-11-09" in UTC, the tracker's date format. */
export function trackerDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Updates the row whose Folder cell links `entry.folder`, or inserts a new row
 * at the top of the main table. Serialised in-process so two status changes
 * cannot both read the same old text and lose one of them.
 */
export function upsertTrackerRow(
  entry: TrackerEntry,
  deps: TrackerDeps = {},
): Promise<UpsertResult> {
  return withTrackerLock(async () => {
    const dav = deps.dav ?? nextcloud();
    const exists = await dav.exists(TRACKER_PATH);
    const previous = exists
      ? String(await dav.getFileContents(TRACKER_PATH, { format: "text" }))
      : "";

    const parsed = exists && previous.trim() !== ""
      ? parseTracker(previous)
      : parseTracker(DEFAULT_DOCUMENT);
    if (!parsed) {
      throw new Error(
        `${TRACKER_PATH} could not be parsed as the applications table; refusing to rewrite it.`,
      );
    }

    const { rows, inserted } = applyEntry(parsed.rows, entry);
    if (rows.length < parsed.rows.length) {
      throw new Error(
        `${TRACKER_PATH}: refusing to write a table with fewer rows (${rows.length} < ${parsed.rows.length}).`,
      );
    }

    const next = renderTracker(parsed, rows);

    if (exists) {
      await putFile(
        TRACKER_BACKUP_PATH,
        new TextEncoder().encode(previous),
        { dav, overwrite: true },
      );
    }
    await putFile(TRACKER_PATH, new TextEncoder().encode(next), {
      dav,
      overwrite: true,
    });

    logger.info(
      `jobs: tracker ${
        inserted ? "inserted" : "updated"
      } "${entry.company}" — ${entry.role} (${entry.status}), ${rows.length} rows`,
    );
    return { inserted, rows: rows.length, path: TRACKER_PATH };
  });
}

/** The pure part of the upsert: matching, updating, or inserting at the top. */
export function applyEntry(
  rows: TrackerRow[],
  entry: TrackerEntry,
): { rows: TrackerRow[]; inserted: boolean } {
  const wanted = normalizeFolder(entry.folder);
  if (wanted) {
    const at = rows.findIndex((row) =>
      normalizeFolder(folderOfCell(row.cells[4] ?? "")) === wanted
    );
    if (at !== -1) {
      const cells = [...rows[at].cells];
      cells[3] = entry.status;
      cells[5] = entry.next;
      const updated = { raw: rowLine(cells), cells };
      return {
        rows: rows.map((row, index) => index === at ? updated : row),
        inserted: false,
      };
    }
  }

  const cells = [
    entry.applied || "—",
    entry.company,
    entry.role,
    entry.status,
    folderCell(entry.folder),
    entry.next,
  ];
  return {
    rows: [{ raw: rowLine(cells), cells }, ...rows],
    inserted: true,
  };
}

/** Refuses a candidate document that lost a row; exported for the guard test. */
export function assertNotShrinking(
  previous: ParsedTracker,
  next: ParsedTracker,
): void {
  if (next.rows.length < previous.rows.length) {
    throw new Error(
      `${TRACKER_PATH}: refusing to write a table with fewer rows (${next.rows.length} < ${previous.rows.length}).`,
    );
  }
}

/** The path a Folder cell points at, or null for "—" and empty cells. */
export function folderOfCell(cell: string): string | null {
  const link = /\[[^\]]*\]\(([^)]+)\)/.exec(cell);
  let target = link ? link[1].trim() : cell.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1);
  }
  if (target === "" || target === "—" || target === "-") return null;

  target = target.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep the raw target: a bad escape is still a usable key.
  }
  target = target.replace(/^Postulations\//, "");
  return target || null;
}

/** Makes "Postulations/the-flex/2026-11-09" and "./the-flex/2026-11-09/" equal. */
export function normalizeFolder(folder: string | null): string {
  if (!folder) return "";
  return folder
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/^Postulations\//, "");
}

function folderCell(folder: string): string {
  const normal = normalizeFolder(folder);
  if (!normal || normal === "—" || normal === "-") return "—";
  return `[${normal}](./${normal}/)`;
}

function rowLine(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";

  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === "\\" && body[index + 1] === "|") {
      current += "|";
      index++;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isMainHeader(line: string): boolean {
  const cells = splitRow(line);
  if (cells.length !== TRACKER_COLUMNS.length) return false;
  return cells.every((cell, index) =>
    cell.toLowerCase() === TRACKER_COLUMNS[index].toLowerCase()
  );
}

function isSeparator(line: string): boolean {
  if (!line.trim().startsWith("|")) return false;
  const cells = splitRow(line);
  return cells.length === TRACKER_COLUMNS.length &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

// One chain for the whole process: every read-modify-write waits for the one
// before it, so two concurrent status changes cannot drop each other's row.
let trackerTail: Promise<unknown> = Promise.resolve();

function withTrackerLock<T>(task: () => Promise<T>): Promise<T> {
  const run = trackerTail.then(task, task);
  trackerTail = run.then(() => undefined, () => undefined);
  return run;
}
