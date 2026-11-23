// The one message of the day: everything the owner clicked since the previous
// morning, the applications that still wait for him, and the important mail.
// Pure formatting lives here so it can be read and tested without a database;
// `buildMorningMessage` only adds the reads.
import prisma from "@/db.ts";
import type { Job, JobRank, MailNote } from "@/generated/prisma/client.ts";
import { prepCapReached, prepRanks } from "@/jobs/prep.ts";
import { shortId } from "@/jobs/store.ts";
import { senderName } from "@/chat/discord/notify.ts";

/** The `ScheduledRun` row that dates the window. */
export const MORNING_JOB = "morning";

/** Discord's limit is 2000; the margin leaves room for its own wrapping. */
export const MORNING_LIMIT = 1900;

/** A run older than this is not a morning run any more; use the last 24 h. */
const MAX_WINDOW_MS = 36 * 60 * 60 * 1000;

export type ClickedJob = Pick<
  Job,
  "id" | "rank" | "title" | "company" | "status" | "url"
>;

export type WaitingJob = Pick<
  Job,
  "id" | "rank" | "title" | "company" | "status" | "prepFolder" | "prepNote"
>;

export type MailBrief = Pick<MailNote, "from" | "subject" | "topic">;

/** The sorting proposal still waiting for a tap, when there is one. */
export type PendingProposal = { summary: string };

export type MorningData = {
  since: Date;
  clicked: ClickedJob[];
  waiting: WaitingJob[];
  importantMail: MailBrief[];
  otherMail: { normal: number; noise: number };
  /** Optional: the line only appears when a proposal is pending. */
  sortProposal?: PendingProposal | null;
  /** Optional: true when today's prep cap is used up. */
  prepCapReached?: boolean;
};

export type Item = { full: string; short: string };

export type Section = {
  heading: string;
  items: Item[];
  /** Shown instead of items when the section is empty. */
  empty: string;
  /** Always appended, also after truncation. */
  footer?: string;
};

const RANK_EMOJI: Record<JobRank | "unranked", string> = {
  apply: "🎯",
  maybe: "🤔",
  skip: "🚫",
  unranked: "·",
};

/** Groups the recap the way the owner thinks about it: apply first. */
const RANK_ORDER: (JobRank | "unranked")[] = [
  "apply",
  "maybe",
  "unranked",
  "skip",
];

function cut(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The window of the recap. The previous morning run when it is still a
 * morning run away, otherwise the last 24 hours (a long outage, a fresh row,
 * or a clock that moved backwards).
 */
export function summaryWindow(now: Date, lastRunAt: Date | null): Date {
  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  if (!lastRunAt) return new Date(dayAgo);

  const last = lastRunAt.getTime();
  if (last >= now.getTime() || last < now.getTime() - MAX_WINDOW_MS) {
    return new Date(dayAgo);
  }
  return lastRunAt;
}

function emojiFor(rank: JobRank | null): string {
  return RANK_EMOJI[rank ?? "unranked"];
}

function jobTitle(job: Pick<Job, "title" | "company">, max: number): string {
  return `${cut(job.title, max)} — ${cut(job.company, Math.floor(max / 2))}`;
}

/** One block per clicked job, best rank first, with the link on its own line. */
export function formatClickedJobs(jobs: ClickedJob[]): Item[] {
  const ordered = [...jobs].sort((a, b) => {
    const rankA = RANK_ORDER.indexOf(a.rank ?? "unranked");
    const rankB = RANK_ORDER.indexOf(b.rank ?? "unranked");
    return rankA - rankB;
  });

  return ordered.map((job) => {
    const emoji = emojiFor(job.rank);
    return {
      full: `${emoji} ${jobTitle(job, 90)} (${job.status})\n<${job.url}>`,
      short: `${emoji} ${jobTitle(job, 45)} (${job.status})`,
    };
  });
}

function waitingLabel(job: WaitingJob): string {
  if (job.status === "queued") return "waiting to be prepared";
  return job.status;
}

const WAITING_ORDER: Record<string, number> = {
  ready: 0,
  review: 1,
  queued: 2,
};

function sortWaiting(jobs: WaitingJob[]): WaitingJob[] {
  return [...jobs].sort((a, b) =>
    (WAITING_ORDER[a.status] ?? 3) - (WAITING_ORDER[b.status] ?? 3)
  );
}

/** Ready, review and un-prepared apply jobs, each with the id he can quote. */
export function formatWaitingJobs(jobs: WaitingJob[]): Item[] {
  return sortWaiting(jobs).map((job) => {
    const emoji = job.status === "ready"
      ? "✅"
      : job.status === "review"
      ? "⚠️"
      : "⏳";
    const head = `${emoji} ${jobTitle(job, 90)} · ${waitingLabel(job)} · ${
      shortId(job)
    }`;
    const shortHead = `${emoji} ${jobTitle(job, 45)} · ${waitingLabel(job)} · ${
      shortId(job)
    }`;

    let detail = "";
    if (job.status === "ready") {
      const where = job.prepFolder ? ` in ${cut(job.prepFolder, 80)}` : "";
      detail = `Prepared${where}: review and send.`;
    } else if (job.status === "review") {
      detail = job.prepNote
        ? `Needs your look: ${cut(job.prepNote, 160)}`
        : "Needs your look before it can go out.";
    }

    return { full: detail ? `${head}\n${detail}` : head, short: shortHead };
  });
}

/** The important mail, one line each, with the topic when the classifier had one. */
export function formatImportantMail(notes: MailBrief[]): Item[] {
  return notes.map((note) => {
    const from = senderName(note.from);
    const topic = note.topic.trim();
    const subject = cut(note.subject, 90);
    return {
      full: `• ${from} — ${subject}${topic ? ` (${cut(topic, 60)})` : ""}`,
      short: `• ${cut(from, 24)} — ${subject}`,
    };
  });
}

/** The one line that says how much ordinary mail came along. */
export function mailTail(normal: number, noise: number): string | undefined {
  if (normal === 0 && noise === 0) return undefined;
  return `Other mail: ${normal} normal, ${noise} noise.`;
}

/** The pending sorting proposal, as the one line that waits with the jobs. */
export function formatPendingProposal(proposal: PendingProposal): Item {
  return {
    full: `📬 Mail sorting proposal waiting: ${cut(proposal.summary, 200)}`,
    short: `📬 Mail sorting proposal waiting: ${cut(proposal.summary, 80)}`,
  };
}

/** All three sections, before any trimming. */
export function morningSections(data: MorningData): Section[] {
  const clicked = formatClickedJobs(data.clicked);
  const waiting = formatWaitingJobs(data.waiting);
  const pending = data.sortProposal
    ? formatPendingProposal(data.sortProposal)
    : null;
  const waitingItems = pending ? [...waiting, pending] : waiting;
  const mail = formatImportantMail(data.importantMail);
  const waitingHint = waiting.length === 0
    ? undefined
    : `When something moves, say \`mark_job\` — e.g. "I applied to ${
      shortId(sortWaiting(data.waiting)[0])
    }".`;
  // Short clause only: the cap is a normal night, not a problem to explain.
  const capHint = waiting.length > 0 && data.prepCapReached
    ? "Prep is at its daily cap; the nightly catch-up picks up the rest."
    : undefined;
  const waitingFooter = waitingHint
    ? [waitingHint, capHint].filter(Boolean).join(" ")
    : capHint;

  return [
    {
      heading: clicked.length === 0
        ? "📥 Clicked since yesterday"
        : `📥 Clicked since yesterday (${clicked.length}${
          clicked.length === 1 ? " job" : " jobs"
        })`,
      items: clicked,
      empty: "nothing clicked",
    },
    {
      heading: waitingItems.length === 0
        ? "🕒 Waiting for you"
        : `🕒 Waiting for you (${waitingItems.length})`,
      items: waitingItems,
      empty: "Nothing waiting; the queue is clear.",
      footer: waitingFooter,
    },
    {
      heading: mail.length === 0
        ? "📬 Important mail since yesterday"
        : `📬 Important mail since yesterday (${
          mail.length === 1 ? "1 mail" : `${mail.length} mails`
        })`,
      items: mail,
      empty: "No important mail.",
      footer: mailTail(data.otherMail.normal, data.otherMail.noise),
    },
  ];
}

function render(
  sections: Section[],
  counts: number[],
  short: boolean,
): string {
  return sections.map((section, index) => {
    const kept = Math.min(counts[index] ?? 0, section.items.length);
    const lines = [section.heading];

    if (section.items.length === 0) {
      lines.push(section.empty);
    } else {
      for (const item of section.items.slice(0, kept)) {
        lines.push(short ? item.short : item.full);
      }
      const hidden = section.items.length - kept;
      if (hidden > 0) lines.push(`… and ${hidden} more`);
    }

    if (section.footer) lines.push(section.footer);
    return lines.join("\n");
  }).join("\n\n");
}

/**
 * The message, shortened until it fits: first every item's one-line form,
 * then whole items from the tail of a section, replaced by "… and N more".
 * Lines are never cut through the middle besides the per-item ellipsis.
 */
export function renderMorning(
  sections: Section[],
  limit = MORNING_LIMIT,
): string {
  const counts = sections.map((section) => section.items.length);

  const full = render(sections, counts, false);
  if (full.length <= limit) return full;

  const compact = render(sections, counts, true);
  if (compact.length <= limit) return compact;

  while (counts.some((count) => count > 0)) {
    for (let index = counts.length - 1; index >= 0; index--) {
      if (counts[index] > 0) {
        counts[index] -= 1;
        break;
      }
    }
    const trimmed = render(sections, counts, true);
    if (trimmed.length <= limit) return trimmed;
  }

  return render(sections, counts, true);
}

/** Everything the morning message needs, read from the database. */
export async function loadMorningData(
  now: Date = new Date(),
): Promise<MorningData> {
  const run = await prisma.scheduledRun.findUnique({
    where: { name: MORNING_JOB },
  });
  const since = summaryWindow(now, run?.lastRunAt ?? null);
  const window = { gte: since, lte: now };

  const [clicked, waiting, importantMail, other, sortProposal, capReached] =
    await Promise.all([
      prisma.job.findMany({
        where: { createdAt: window },
        orderBy: { createdAt: "desc" },
      }),
      prisma.job.findMany({
        where: {
          OR: [
            { status: { in: ["ready", "review"] } },
            {
              status: "queued",
              rank: { in: prepRanks() },
              preparedAt: null,
              prepFolder: null,
            },
          ],
        },
      }),
      prisma.mailNote.findMany({
        where: { importance: "important", receivedAt: window },
        orderBy: { receivedAt: "desc" },
      }),
      prisma.mailNote.groupBy({
        by: ["importance"],
        where: { receivedAt: window, importance: { in: ["normal", "noise"] } },
        _count: { _all: true },
      }),
      prisma.mailProposal.findFirst({
        where: { status: "pending" },
        orderBy: { createdAt: "desc" },
        select: { summary: true },
      }),
      prepCapReached(now.getTime()),
    ]);

  const countOf = (importance: string) =>
    other.find((row) => row.importance === importance)?._count._all ?? 0;

  return {
    since,
    clicked,
    waiting,
    importantMail,
    otherMail: { normal: countOf("normal"), noise: countOf("noise") },
    sortProposal,
    prepCapReached: capReached,
  };
}

/** The text of the morning message, built from the database only. */
export async function buildMorningMessage(
  now: Date = new Date(),
): Promise<string> {
  const data = await loadMorningData(now);
  return renderMorning(morningSections(data));
}
