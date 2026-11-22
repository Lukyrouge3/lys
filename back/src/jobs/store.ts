import prisma from "@/db.ts";
import type {
  Job,
  JobRank,
  JobStatus,
  Prisma,
} from "@/generated/prisma/client.ts";

export type JobInput = {
  source: string;
  externalId: string;
  url: string;
  title: string;
  company: string;
  location?: string | null;
  description: string;
  postedAt?: Date | null;
};

const DEFAULT_STATUSES: JobStatus[] = ["queued", "preparing", "ready"];

/** Lower sorts first. Unranked sits between "maybe" and "skip". */
const RANK_ORDER: Record<JobRank, number> = {
  apply: 0,
  maybe: 1,
  skip: 3,
};

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err &&
    (err as { code?: unknown }).code === "P2002";
}

/**
 * Stores one posting, deduped on (source, externalId). A duplicate keeps the
 * status, rank and ping timestamps the existing row earned; only the posting
 * text is refreshed, because the site can edit it after we first saw it.
 */
export async function saveJob(
  input: JobInput,
): Promise<{ job: Job; duplicate: boolean }> {
  const data = {
    source: input.source,
    externalId: input.externalId,
    url: input.url,
    title: input.title,
    company: input.company,
    location: input.location ?? null,
    description: input.description,
    postedAt: input.postedAt ?? null,
  };

  try {
    const job = await prisma.job.create({ data });
    return { job, duplicate: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    // Another writer won the race (or this is a re-scrape): return its row.
    const existing = await prisma.job.findUnique({
      where: {
        source_externalId: {
          source: input.source,
          externalId: input.externalId,
        },
      },
    });
    if (!existing) throw err;

    if (
      existing.url !== data.url || existing.title !== data.title ||
      existing.description !== data.description
    ) {
      const job = await prisma.job.update({
        where: { id: existing.id },
        data: {
          url: data.url,
          title: data.title,
          description: data.description,
        },
      });
      return { job, duplicate: true };
    }

    return { job: existing, duplicate: true };
  }
}

export type ListJobsOptions = {
  statuses?: JobStatus[];
  includeSkip?: boolean;
  limit?: number;
};

/**
 * Jobs to act on, best first. Prisma cannot express "apply, maybe, null, skip"
 * and "newest first inside each rank" in one orderBy, so the list is sorted
 * here; the default limit is applied after sorting to keep the best work.
 */
export async function listJobs(opts: ListJobsOptions = {}): Promise<Job[]> {
  const where: Prisma.JobWhereInput = {
    status: { in: opts.statuses ?? DEFAULT_STATUSES },
  };
  if (!opts.includeSkip) {
    // A bare `rank: { not: "skip" }` also drops NULL ranks, hiding unranked jobs.
    where.OR = [{ rank: null }, { rank: { not: "skip" } }];
  }

  const jobs = await prisma.job.findMany({ where });
  jobs.sort((a, b) => {
    const rankA = a.rank ? RANK_ORDER[a.rank] : 2;
    const rankB = b.rank ? RANK_ORDER[b.rank] : 2;
    if (rankA !== rankB) return rankA - rankB;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  return jobs.slice(0, opts.limit ?? 20);
}

function ambiguous(ref: string, jobs: Job[]): Error {
  const candidates = jobs
    .map((job) => `${shortId(job)} "${job.title}"`)
    .join(", ");
  return new Error(
    `Ambiguous job reference "${ref}": matches ${jobs.length} jobs: ${candidates}. Use a longer id.`,
  );
}

async function resolveJob(ref: string): Promise<Job> {
  const byId = await prisma.job.findUnique({ where: { id: ref } });
  if (byId) return byId;

  const byExternal = await prisma.job.findMany({ where: { externalId: ref } });
  if (byExternal.length === 1) return byExternal[0];
  if (byExternal.length > 1) throw ambiguous(ref, byExternal);

  if (ref.length >= 6) {
    const byPrefix = await prisma.job.findMany({
      where: { id: { startsWith: ref } },
    });
    if (byPrefix.length === 1) return byPrefix[0];
    if (byPrefix.length > 1) throw ambiguous(ref, byPrefix);
  }

  throw new Error(
    `No job found for "${ref}". Pass a full id, an id prefix of at least 6 characters, or an external id.`,
  );
}

export async function markJob(ref: string, status: JobStatus): Promise<Job> {
  const job = await resolveJob(ref);
  return await prisma.job.update({
    where: { id: job.id },
    data: { status },
  });
}

export function shortId(job: Pick<Job, "id">): string {
  return job.id.slice(0, 8);
}

export function setRank(
  id: string,
  rank: JobRank | null,
  reason: string | null = null,
): Promise<Job> {
  return prisma.job.update({
    where: { id },
    data: { rank, rankReason: reason },
  });
}

export function markNotified(id: string): Promise<Job> {
  return prisma.job.update({
    where: { id },
    data: { notifiedAt: new Date() },
  });
}

export function markInboxWritten(id: string): Promise<Job> {
  return prisma.job.update({
    where: { id },
    data: { inboxWrittenAt: new Date() },
  });
}
