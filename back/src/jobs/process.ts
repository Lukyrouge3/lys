// One job, three guarded steps: rank it, ping Discord when it is worth it, and
// put a file in the Nextcloud inbox. Each step is independent, so a broken
// ranker or a full inbox still lets the others happen, and nothing thrown here
// ever reaches the queue.
import type { Job } from "@/generated/prisma/client.ts";
import { formatJobNotice } from "@/chat/discord/notify.ts";
import { writeJobToInbox } from "@/jobs/inbox.ts";
import { rankAndStore } from "@/jobs/rank.ts";
import { markInboxWritten, markNotified } from "@/jobs/store.ts";
import { logger } from "@/utils/logger.ts";

export type ProcessDeps = {
  /** Ranks and stores the job; the real one never throws on a ranking failure. */
  rank: typeof rankAndStore;
  notify: (text: string) => Promise<void>;
  writeInbox: (job: Job) => Promise<void>;
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

  let job: Job;
  try {
    job = await rank(jobId);
  } catch (err) {
    // The row is gone or the database is down: nothing else can be done
    logger.error(`Ranking job ${jobId} failed: ${err}`);
    return null;
  }

  // A null rank (the ranker failed) gets neither, so a retry can do both
  if (job.rank === "apply" && job.notifiedAt === null) {
    try {
      await notify(formatJobNotice(job));
      job = await markNotified(job.id);
    } catch (err) {
      logger.warn(`Pinging for job ${jobId} failed: ${err}`);
    }
  }

  if (
    job.rank !== null && job.rank !== "skip" &&
    job.inboxWrittenAt === null
  ) {
    try {
      await writeInbox(job);
      job = await markInboxWritten(job.id);
    } catch (err) {
      logger.warn(`Writing job ${jobId} to the inbox failed: ${err}`);
    }
  }

  return job;
}
