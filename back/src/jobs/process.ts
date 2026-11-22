// One job, two guarded steps: rank it and put a file in the Nextcloud inbox.
// Each step is independent, so a broken ranker or a full inbox still lets the
// other happen, and nothing thrown here ever reaches the queue. The owner hears
// about the good ones in the morning message, not in a Discord DM per click.
import type { Job } from "@/generated/prisma/client.ts";
import {
  type InboxResult,
  jobInboxPath,
  writeJobToInbox,
} from "@/jobs/inbox.ts";
import { clip, shortJobId } from "@/jobs/log.ts";
import { prepCapReached, shouldPrepare } from "@/jobs/prep.ts";
import { rankAndStore } from "@/jobs/rank.ts";
import { markInboxWritten } from "@/jobs/store.ts";
import { logger } from "@/utils/logger.ts";
import { withTimeout } from "@/utils/timeout.ts";

/** A Nextcloud write that takes longer than this is treated as failed. */
export const INBOX_TIMEOUT_MS = 20_000;

export type ProcessDeps = {
  /** Ranks and stores the job; the real one never throws on a ranking failure. */
  rank: typeof rankAndStore;
  writeInbox: (job: Job) => Promise<InboxResult>;
  /** Overrides INBOX_TIMEOUT_MS so a test does not wait 20 seconds. */
  inboxTimeoutMs: number;
  /**
   * Whether document preparation will run for this job. True means the Input
   * bridge file is redundant: prep delivers job.md into the application folder.
   * False keeps the old bridge behaviour.
   */
  willPrepare: (job: Job) => Promise<boolean>;
};

/**
 * Processes one stored job. Idempotent: the inbox timestamp is only stamped
 * after the write happened, so a second run writes nothing while a failed write
 * is retried by the next run.
 */
export async function processJob(
  jobId: string,
  deps: Partial<ProcessDeps> = {},
): Promise<Job | null> {
  const rank = deps.rank ?? rankAndStore;
  const writeInbox = deps.writeInbox ?? writeJobToInbox;
  const inboxTimeoutMs = deps.inboxTimeoutMs ?? INBOX_TIMEOUT_MS;
  const willPrepare = deps.willPrepare ??
    (async (candidate: Job) =>
      shouldPrepare(candidate) && !(await prepCapReached()));

  const id = shortJobId(jobId);
  const started = performance.now();

  let job: Job;
  try {
    job = await rank(jobId);
  } catch (err) {
    // The row is gone or the database is down: nothing else can be done
    logger.error(`jobs: rank failed ${id}: ${err}`);
    return null;
  }

  logger.info(`jobs: processing ${id} ${job.url}`);

  if (job.rank === null) {
    logger.info(
      `jobs: ranked ${id} -> none (ranker gave no usable answer) ${job.url}`,
    );
  } else {
    logger.info(
      `jobs: ranked ${id} -> ${job.rank} (${
        clip(job.rankReason ?? "", 140) || "no reason given"
      }) ${job.url}`,
    );
  }

  const prep = job.rank !== null && job.rank !== "skip" &&
    await willPrepare(job);

  if (
    job.rank !== null && job.rank !== "skip" &&
    !prep && job.inboxWrittenAt === null
  ) {
    const path = jobInboxPath(job);
    try {
      // Deadline first: a hung WebDAV write would block every later job
      const result = await withTimeout(
        writeInbox(job),
        inboxTimeoutMs,
        `Writing job ${job.id} to the inbox`,
      );
      job = await markInboxWritten(job.id);
      logger.info(
        result === "written"
          ? `jobs: inbox ${id} -> written ${path}`
          : `jobs: inbox ${id} -> already there ${path}`,
      );
    } catch (err) {
      logger.warn(`jobs: inbox ${id} -> failed: ${err}`);
    }
  } else if (prep) {
    logger.info(
      `jobs: inbox ${id} -> skipped, prep will deliver job.md ${job.url}`,
    );
  }

  logger.info(
    `jobs: done ${id} in ${Math.round(performance.now() - started)} ms (rank=${
      job.rank ?? "none"
    }, inbox=${job.inboxWrittenAt !== null}) ${job.url}`,
  );
  return job;
}
