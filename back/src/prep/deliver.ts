// Delivers one prepared application into the owner's Nextcloud tree:
// Postulations/<company>/<YYYY-MM-DD>/ holds the posting, the notes, and both
// documents as Typst sources and compiled PDFs. Existing folders are never
// reused, so a failed or repeated run cannot overwrite an application.
import type { Job } from "@/generated/prisma/client.ts";
import { type DavWriter, nextcloud, putFile } from "@/files/nextcloud.ts";
import { formatJobMarkdown } from "@/jobs/inbox.ts";
import type { PrepResult } from "@/prep/types.ts";

export const POSTULATIONS_FOLDER = "Postulations";

/** The slice of the DAV client delivery needs. */
export type DeliveryDav = DavWriter & {
  getDirectoryContents(path: string): Promise<unknown>;
};

export type DeliveryDeps = {
  /** Injected in tests; the real client otherwise. */
  dav?: DeliveryDav;
  /** The day the application is produced (UTC); defaults to now. */
  now?: Date;
};

export type DeliveryResult = { folder: string };

type DeliverableJob = Pick<
  Job,
  | "title"
  | "company"
  | "location"
  | "source"
  | "url"
  | "description"
  | "rank"
  | "rankReason"
>;

/** Accents stripped, lowercased, everything but [a-z0-9] collapsed to one dash. */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "2026-11-09", in UTC so the folder name does not depend on the host zone. */
export function folderDate(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Writes everything the owner needs to review, send or archive one application.
 * The folder is chosen before anything is written; a folder that already holds
 * files gets a role suffix, then a numeric one, and `putFile` still refuses to
 * overwrite should a racing writer get there first.
 */
export async function deliverApplication(
  job: DeliverableJob,
  result: PrepResult,
  { dav = nextcloud(), now = new Date() }: DeliveryDeps = {},
): Promise<DeliveryResult> {
  const company = slugify(job.company) || "company";
  const role = slugify(job.title).slice(0, 40).replace(/-+$/, "") || "role";
  const date = folderDate(now);
  const root = `${POSTULATIONS_FOLDER}/${company}`;
  const folder = await freeFolder(dav, root, date, role);

  const missingPdfs: string[] = [];
  if (result.cvPdf.length === 0) missingPdfs.push("cv");
  if (result.coverPdf.length === 0) missingPdfs.push("cover");

  await putFile(
    `${folder}/job.md`,
    new TextEncoder().encode(formatJobMarkdown(job, now)),
    { dav },
  );
  await putFile(
    `${folder}/notes.md`,
    new TextEncoder().encode(renderNotes(result, missingPdfs)),
    { dav },
  );

  await writeText(dav, `${folder}/cv-${result.language}.typ`, result.cvTyp);
  await writeText(
    dav,
    `${folder}/cover-${result.language}.typ`,
    result.coverTyp,
  );
  if (!missingPdfs.includes("cv")) {
    await putFile(`${folder}/cv-${result.language}.pdf`, result.cvPdf, { dav });
  }
  if (!missingPdfs.includes("cover")) {
    await putFile(`${folder}/cover-${result.language}.pdf`, result.coverPdf, {
      dav,
    });
  }

  return { folder };
}

/**
 * The notes file: the model's requirement map, a review block when the quality
 * gate failed, and a line for every PDF that could not be compiled.
 */
export function renderNotes(
  result: PrepResult,
  missingPdfs: string[] = [],
): string {
  const sections: string[] = [];

  if (result.status === "review") {
    const gaps = result.gaps.length > 0
      ? result.gaps.map((gap) => `- ${gap}`)
      : ["- No specific gap was listed; read the documents before sending."];
    sections.push(
      [
        "# REVIEW NEEDED",
        "",
        "This draft did not pass every check. Read the gaps before sending it.",
        "",
        ...gaps,
      ].join("\n"),
    );
  }

  const notes = result.notes.trimEnd();
  if (notes) sections.push(notes);

  if (missingPdfs.length > 0) {
    sections.push(
      [
        "## Missing PDFs",
        "",
        ...missingPdfs.map((name) =>
          `The ${name} PDF is missing: compilation failed, so only the Typst source is here.`
        ),
      ].join("\n"),
    );
  }

  return `${sections.join("\n\n---\n\n").trimEnd()}\n`;
}

/** `<date>`, then `<date>-<role>`, then `<date>-<role>-2`, … */
async function freeFolder(
  dav: DeliveryDav,
  root: string,
  date: string,
  role: string,
): Promise<string> {
  const dated = `${root}/${date}`;
  if (!(await holdsEntries(dav, dated))) return dated;

  const withRole = `${dated}-${role}`;
  if (!(await holdsEntries(dav, withRole))) return withRole;

  for (let suffix = 2;; suffix++) {
    const candidate = `${withRole}-${suffix}`;
    if (!(await holdsEntries(dav, candidate))) return candidate;
  }
}

async function holdsEntries(
  dav: DeliveryDav,
  path: string,
): Promise<boolean> {
  if (!(await dav.exists(path))) return false;
  const entries = entriesOf(await dav.getDirectoryContents(path));
  return entries.length > 0;
}

type DavEntry = { type?: string };

function entriesOf(value: unknown): DavEntry[] {
  const list = Array.isArray(value)
    ? value
    : (value as { data?: unknown })?.data;
  return Array.isArray(list) ? list as DavEntry[] : [];
}

async function writeText(
  dav: DeliveryDav,
  path: string,
  content: string,
): Promise<void> {
  await putFile(path, new TextEncoder().encode(content), { dav });
}
