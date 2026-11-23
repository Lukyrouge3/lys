// Runs document preparation for one queued job and delivers the result. The
// queue calls this automatically for jobs worth applying to; the prepare_job
// tool calls it when the owner asks for one. Every failure leaves the row back
// in the queue with a short note, so a retry is always safe.
import type { Job, JobRank } from "@/generated/prisma/client.ts";
import prisma from "@/db.ts";
import { writeJobToInbox } from "@/jobs/inbox.ts";
import { shortJobId } from "@/jobs/log.ts";
import { resolveJobRef } from "@/jobs/store.ts";
import { bundleApplication } from "@/prep/bundle.ts";
import type { BundleResult } from "@/prep/bundle.ts";
import { deliverApplication } from "@/prep/deliver.ts";
import type { DeliveryDav } from "@/prep/deliver.ts";
import { prepareApplication } from "@/prep/prepare.ts";
import {
  statusToTracker,
  trackerDate,
  upsertTrackerRow,
} from "@/prep/tracker.ts";
import type { TrackerDav, TrackerEntry } from "@/prep/tracker.ts";
import type { PrepResult } from "@/prep/types.ts";
import { logger } from "@/utils/logger.ts";
import { withTimeout } from "@/utils/timeout.ts";

export const MAX_PREP_ATTEMPTS = 3;
export const DEFAULT_PREP_RANKS: JobRank[] = ["apply", "maybe"];
export const DEFAULT_PREP_DAILY_CAP = 6;
export const DEFAULT_PREP_TIMEOUT_MS = 600_000;

/** Extra room on top of the workflow's own budget, so its timeout wins. */
const TIMEOUT_MARGIN_MS = 30_000;
const BRIDGE_TIMEOUT_MS = 20_000;
const MAX_NOTE_CHARS = 500;

export type PrepBlock =
  | "disabled"
  | "rank"
  | "status"
  | "attempts"
  | "prepared"
  | "cap";

export type PrepOutcome = {
  prepared: boolean;
  job: Job;
  folder?: string;
  reason?: string;
  /** The merged application.pdf, when bundling succeeded. */
  bundle?: BundleResult;
  /** Why bundling failed; the delivery itself still stands. */
  bundleWarning?: string;
};

export type PreparableJob = Pick<
  Job,
  "status" | "rank" | "prepAttempts" | "preparedAt"
>;

export type PrepDeps = {
  /** The long-running workflow; the real one talks to the model and Typst. */
  prepare: (job: Job) => Promise<PrepResult>;
  deliver: typeof deliverApplication;
  bundle: typeof bundleApplication;
  tracker: typeof upsertTrackerRow;
  writeInbox: typeof writeJobToInbox;
  /** Injectable clock, in milliseconds since the epoch. */
  now: () => number;
  /** Overrides the PREP_TIMEOUT_MS + margin budget in tests. */
  timeoutMs: number;
  /** Skip the daily cap and the attempts limit (prepare_job). */
  force: boolean;
  /** Inject the prep ranks, mostly for tests. */
  ranks: JobRank[];
  /** One fake DAV client shared by delivery and the tracker in tests. */
  dav?: DeliveryDav & TrackerDav;
};

/** PREP_ENABLED is on unless it is explicitly "0". */
export function prepEnabled(): boolean {
  return Deno.env.get("PREP_ENABLED")?.trim() !== "0";
}

/** PREP_RANKS, defaulting to apply,maybe; unknown values are ignored. */
export function prepRanks(): JobRank[] {
  const raw = Deno.env.get("PREP_RANKS")?.trim();
  if (!raw) return [...DEFAULT_PREP_RANKS];

  const valid = new Set<JobRank>(["apply", "maybe", "skip"]);
  const ranks = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is JobRank => valid.has(value as JobRank));

  return ranks.length > 0 ? [...new Set(ranks)] : [...DEFAULT_PREP_RANKS];
}

/** PREP_DAILY_CAP, default 6; a non-positive value means no cap. */
export function prepDailyCap(): number {
  const raw = Deno.env.get("PREP_DAILY_CAP")?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : DEFAULT_PREP_DAILY_CAP;
}

/** PREP_TIMEOUT_MS, default ten minutes. */
export function prepTimeoutMs(): number {
  const raw = Deno.env.get("PREP_TIMEOUT_MS")?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PREP_TIMEOUT_MS;
}

/**
 * The static guards, with no database and no clock: prep is enabled, the job is
 * queued, its rank is one we prepare for, it has not been prepared, and it has
 * attempts left. The daily cap is checked separately because it needs a count.
 */
export function shouldPrepare(
  job: PreparableJob,
  ranks: JobRank[] = prepRanks(),
): boolean {
  return prepBlockReason(job, ranks) === null;
}

/** Why a job would not be prepared right now, or null when it would. */
export function prepBlockReason(
  job: PreparableJob,
  ranks: JobRank[] = prepRanks(),
  { capReached = false, force = false }: {
    capReached?: boolean;
    force?: boolean;
  } = {},
): PrepBlock | null {
  if (!prepEnabled()) return "disabled";
  if (job.rank === null || !ranks.includes(job.rank)) return "rank";
  if (!force && job.status !== "queued") return "status";
  if (!force && job.preparedAt !== null) return "prepared";
  if (!force && job.prepAttempts >= MAX_PREP_ATTEMPTS) return "attempts";
  if (capReached) return "cap";
  return null;
}

/** Whether the daily cap is used up at `at` (milliseconds since the epoch). */
export async function prepCapReached(at = Date.now()): Promise<boolean> {
  const cap = prepDailyCap();
  if (cap <= 0) return false;

  const since = new Date(at - 24 * 60 * 60 * 1000);
  const prepared = await prisma.job.count({
    where: { preparedAt: { gte: since } },
  });
  return prepared >= cap;
}

export const INTERRUPTED_PREP_NOTE = "interrupted by a restart";

/**
 * Requeues jobs a crash left mid-preparation. Only correct at startup: while
 * the process is up, a preparing row belongs to a live run. The attempt count
 * is kept, so a job that keeps getting interrupted still runs out of tries.
 */
export async function recoverInterruptedPrep(): Promise<number> {
  const { count } = await prisma.job.updateMany({
    where: { status: "preparing" },
    data: { status: "queued", prepNote: INTERRUPTED_PREP_NOTE },
  });
  if (count > 0) {
    logger.warn(`jobs: recovered ${count} job(s) interrupted while preparing`);
  }
  return count;
}

/**
 * The jobs a restart just requeued that are still worth preparing. Rank and
 * attempts are unchanged, so a job that used them all stays out of the queue.
 */
export async function interruptedPrepJobs(): Promise<Job[]> {
  const jobs = await prisma.job.findMany({
    where: { status: "queued", prepNote: INTERRUPTED_PREP_NOTE },
  });
  return jobs.filter((job) => shouldPrepare(job));
}

/**
 * Prepares and delivers one job. Throws only when the job itself cannot be
 * loaded; every later failure is recorded on the row and returned. A tracker
 * failure is logged, never allowed to undo a delivery.
 */
export async function prepareJob(
  jobId: string,
  deps: Partial<PrepDeps> = {},
): Promise<PrepOutcome> {
  const prepare = deps.prepare ?? ((job: Job) => prepareApplication(job));
  const deliver = deps.deliver ?? deliverApplication;
  const bundle = deps.bundle ?? bundleApplication;
  const tracker = deps.tracker ?? upsertTrackerRow;
  const writeInbox = deps.writeInbox ?? writeJobToInbox;
  const now = deps.now ?? (() => Date.now());
  const ranks = deps.ranks ?? prepRanks();
  const force = deps.force ?? false;
  const timeoutMs = deps.timeoutMs ?? prepTimeoutMs() + TIMEOUT_MARGIN_MS;

  const job = await resolveJobRef(jobId);
  const id = shortJobId(job.id);
  const started = now();

  const capReached = !force && await prepCapReached(started);
  const blocked = prepBlockReason(job, ranks, { capReached, force });
  if (blocked) {
    logger.info(
      `jobs: prep ${id} ${job.company} skipped (${blocked}) ${job.url}`,
    );
    return { prepared: false, job, reason: blocked };
  }

  const attempts = job.prepAttempts + 1;
  logger.info(
    `jobs: prep ${id} ${job.company} starting (attempt ${attempts}) ${job.url}`,
  );

  try {
    const preparing = await prisma.job.update({
      where: { id: job.id },
      data: { status: "preparing", prepAttempts: { increment: 1 } },
    });

    const result = await withTimeout(
      prepare(preparing),
      timeoutMs,
      `Preparing job ${id}`,
    );

    const { folder } = await deliver(
      preparing,
      result,
      { dav: deps.dav, now: new Date(now()) },
    );

    // application.pdf is a convenience copy; a bundling failure is reported,
    // never allowed to undo or fail the delivery that already happened.
    let bundleResult: BundleResult | undefined;
    let bundleWarning: string | undefined;
    try {
      bundleResult = await bundle(folder, { dav: deps.dav });
    } catch (err) {
      bundleWarning = errorText(err);
      logger.warn(
        `jobs: bundle failed for ${folder}: ${bundleWarning} ${preparing.url}`,
      );
    }

    const entry = trackerEntry(preparing, result, folder, now());
    try {
      await tracker(entry, { dav: deps.dav });
    } catch (err) {
      logger.warn(
        `jobs: prep ${id} ${preparing.company} delivered to ${folder}, tracker not updated: ${
          errorText(err)
        } ${preparing.url}`,
      );
    }

    const status = result.status === "ready" ? "ready" : "review";
    const updated = await prisma.job.update({
      where: { id: job.id },
      data: {
        status,
        prepFolder: folder,
        preparedAt: new Date(now()),
        prepNote: result.gaps.join("; "),
      },
    });

    logger.info(
      `jobs: prep ${id} ${preparing.company} -> ${status} in ${
        Math.round(now() - started)
      } ms, folder ${folder} ${preparing.url}`,
    );
    return {
      prepared: true,
      job: updated,
      folder,
      bundle: bundleResult,
      bundleWarning,
    };
  } catch (err) {
    const note = errorText(err);
    let failed: Job;
    try {
      failed = await prisma.job.update({
        where: { id: job.id },
        data: { status: "queued", prepNote: note },
      });
    } catch (updateError) {
      logger.error(
        `jobs: prep ${id} ${job.company} failed and could not be requeued: ${
          errorText(updateError)
        } ${job.url}`,
      );
      throw updateError;
    }

    logger.error(
      `jobs: prep ${id} ${job.company} failed after ${
        Math.round(now() - started)
      } ms (attempt ${failed.prepAttempts}): ${note} ${job.url}`,
    );

    if (failed.prepAttempts >= MAX_PREP_ATTEMPTS) {
      try {
        const bridge = await withTimeout(
          writeInbox(failed),
          BRIDGE_TIMEOUT_MS,
          `Writing job ${failed.id} to the inbox`,
        );
        logger.info(
          `jobs: prep ${id} ${job.company} fell back to the Input bridge (${bridge})`,
        );
      } catch (bridgeError) {
        logger.warn(
          `jobs: prep ${id} ${job.company} Input bridge failed: ${
            errorText(bridgeError)
          } ${job.url}`,
        );
      }
    }

    return { prepared: false, job: failed, reason: note };
  }
}

/** The tracker row for a prepared job, in the owner's status vocabulary. */
export function trackerEntry(
  job: Pick<Job, "company" | "title">,
  result: Pick<PrepResult, "status" | "gaps">,
  folder: string,
  at: number,
): TrackerEntry {
  const jobStatus = result.status === "ready" ? "ready" : "review";
  const mapped = statusToTracker(jobStatus, result.gaps.length);
  return {
    applied: trackerDate(new Date(at)),
    company: job.company,
    role: job.title,
    status: mapped.status,
    folder,
    next: mapped.next,
  };
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_NOTE_CHARS
    ? `${text.slice(0, MAX_NOTE_CHARS)}…`
    : text;
}
