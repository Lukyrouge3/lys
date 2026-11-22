// One job, three guarded steps: rank it, ping Discord when it is worth it, and
// put a file in the Nextcloud inbox. Each step is independent, so a broken
// ranker or a full inbox still lets the others happen, and nothing thrown here
// ever reaches the queue.
import type { Job } from "@/generated/prisma/client.ts";
import { formatJobNotice } from "@/chat/discord/notify.ts";
import {
  type InboxResult,
  jobInboxPath,
  writeJobToInbox,
} from "@/jobs/inbox.ts";
import { clip, shortJobId } from "@/jobs/log.ts";
import { rankAndStore } from "@/jobs/rank.ts";
import { markInboxWritten, markNotified } from "@/jobs/store.ts";
import { logger } from "@/utils/logger.ts";
import { withTimeout } from "@/utils/timeout.ts";

/** A Nextcloud write that takes longer than this is treated as failed. */
export const INBOX_TIMEOUT_MS = 20_000;

/** A Discord ping that takes longer than this is treated as failed. */
export const NOTIFY_TIMEOUT_MS = 15_000;

export type ProcessDeps = {
  /** Ranks and stores the job; the real one never throws on a ranking failure. */
  rank: typeof rankAndStore;
  notify: (text: string) => Promise<void>;
  writeInbox: (job: Job) => Promise<InboxResult>;
  /** Overrides INBOX_TIMEOUT_MS so a test does not wait 20 seconds. */
  inboxTimeoutMs: number;
};

/** Called when a job is processed with no notifier wired (e.g. from a tool). */
function noNotifier(): Promise<void> {
  return Promise.reject(new Error("no Discord notifier is configured"));
}

/**
 * Processes one stored job. Idempotent: the notified and inbox timestamps are
 * only stamped after the side effect happened, so a second run pings and writes
 * nothing while a failed step is retried by the next run.
 */
export async function processJob(
  jobId: string,
  deps: Partial<ProcessDeps> = {},
): Promise<Job | null> {
  const rank = deps.rank ?? rankAndStore;
  const notify = deps.notify ?? noNotifier;
  const writeInbox = deps.writeInbox ?? writeJobToInbox;
  const inboxTimeoutMs = deps.inboxTimeoutMs ?? INBOX_TIMEOUT_MS;

  const id = shortJobId(jobId);
  const started = performance.now();
  logger.info(`jobs: processing ${id}`);

  let job: Job;
  try {
    job = await rank(jobId);
  } catch (err) {
    // The row is gone or the database is down: nothing else can be done
    logger.error(`jobs: rank failed ${id}: ${err}`);
    return null;
  }

  if (job.rank === null) {
    logger.info(`jobs: ranked ${id} -> none (ranker gave no usable answer)`);
  } else {
    logger.info(
      `jobs: ranked ${id} -> ${job.rank} (${
        clip(job.rankReason ?? "", 140) || "no reason given"
      })`,
    );
  }

  // A null rank (the ranker failed) gets neither, so a retry can do both
  if (job.rank === "apply" && job.notifiedAt === null) {
    try {
      await withTimeout(
        notify(formatJobNotice(job)),
        NOTIFY_TIMEOUT_MS,
        `Pinging for job ${job.id}`,
      );
      job = await markNotified(job.id);
      logger.info(`jobs: ping sent ${id}`);
    } catch (err) {
      logger.warn(`jobs: ping failed ${id}: ${err}`);
    }
  }

  if (
    job.rank !== null && job.rank !== "skip" &&
    job.inboxWrittenAt === null
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
  }

  logger.info(
    `jobs: done ${id} in ${Math.round(performance.now() - started)} ms (rank=${
      job.rank ?? "none"
    }, pinged=${job.notifiedAt !== null}, inbox=${
      job.inboxWrittenAt !== null
    })`,
  );
  return job;
}
