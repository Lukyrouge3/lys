// The interim bridge between the job tools and the application trackers: every
// job worth acting on becomes one markdown file in Nextcloud. The file is the
// record, so an existing file is left alone and never rewritten.
import type { Job } from "@/generated/prisma/client.ts";
import { type DavWriter, nextcloud, putFile } from "@/files/nextcloud.ts";

export const JOB_INBOX_FOLDER = "Postulations/Input";

/** Characters of "<company>-<title>" kept before the external id is appended. */
const SLUG_CHARS = 80;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type Sluggable = Pick<Job, "company" | "title" | "externalId">;

/** Accents stripped, lowercased, everything but [a-z0-9] collapsed to one dash. */
function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `<company>-<title>-<externalId>`, readable enough to recognise in a folder
 * listing and unique enough to key the file on. The id keeps its punctuation
 * (only dots, dashes and underscores survive validation) so a name is not
 * shared by two postings from different ids.
 */
export function jobSlug(job: Sluggable): string {
  const base = slugify(`${job.company} ${job.title}`)
    .slice(0, SLUG_CHARS)
    .replace(/-+$/, "");
  const id = job.externalId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "job"}-${id || "unknown"}`;
}

export function jobInboxPath(job: Sluggable): string {
  return `${JOB_INBOX_FOLDER}/${jobSlug(job)}.md`;
}

/** "22 November 2026": no leading zero, English month, UTC so it is stable. */
export function formatCaptured(now: Date): string {
  return `${now.getUTCDate()} ${
    MONTHS[now.getUTCMonth()]
  } ${now.getUTCFullYear()}`;
}

type MarkdownJob = Pick<
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

/** The file a person opens to decide whether to apply. */
export function formatJobMarkdown(job: MarkdownJob, now = new Date()): string {
  const lines = [
    `# ${job.title} — ${job.company}`,
    "",
    `- **Company:** ${job.company}`,
    `- **Role:** ${job.title}`,
    `- **Location:** ${job.location ?? "not stated"}`,
    `- **Source:** ${job.source} job posting (${job.url})`,
    `- **Captured:** ${formatCaptured(now)}`,
  ];

  if (job.rank) {
    const reason = job.rankReason?.trim() ?? "";
    lines.push(
      `- **Ranked by Lys:** ${job.rank}${reason ? ` — ${reason}` : ""}`,
    );
  }

  lines.push("", "---", "", job.description);
  return `${lines.join("\n")}\n`;
}

export type InboxOptions = {
  /** Injected in tests; the real client otherwise. */
  dav?: DavWriter;
  now?: Date;
};

/**
 * Writes one job to `/Postulations/Input`. A file that is already there is the
 * job's record, so this returns without touching it; a failed write throws and
 * the caller retries later.
 */
export async function writeJobToInbox(
  job: Job,
  { dav = nextcloud(), now }: InboxOptions = {},
): Promise<void> {
  const path = jobInboxPath(job);
  if (await dav.exists(path)) return;

  const content = new TextEncoder().encode(formatJobMarkdown(job, now));
  // putFile creates the parent folder and refuses to overwrite, so a racing
  // writer still cannot lose an existing file.
  await putFile(path, content, { dav });
}
