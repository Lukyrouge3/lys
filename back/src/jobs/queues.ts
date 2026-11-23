// The one serial prep queue, shared by the HTTP server (a click, a rank that
// finishes) and the nightly catch-up. Prep is slow and expensive, so it never
// runs two jobs at once, whichever caller asked for them.
import { prepareJob } from "@/jobs/prep.ts";
import { shortJobId } from "@/jobs/log.ts";
import { logger } from "@/utils/logger.ts";

export type PrepRunner = (jobId: string) => Promise<void>;

let tail: Promise<void> = Promise.resolve();
let pending = 0;

async function defaultRun(jobId: string): Promise<void> {
  await prepareJob(jobId);
}

/**
 * Queues one job's preparation behind whatever is already running, and resolves
 * when that job's prep is done. A failure is logged, never thrown, so one bad
 * row cannot poison the queue or its caller.
 */
export function enqueuePrep(
  jobId: string,
  run: PrepRunner = defaultRun,
): Promise<void> {
  pending += 1;
  const done = tail.then(() => run(jobId)).catch((err) => {
    logger.error(`jobs: queue ${shortJobId(jobId)} failed: ${err}`);
  }).finally(() => {
    pending -= 1;
  });
  tail = done;
  return done;
}

/** How many prep runs are queued or running, the one just enqueued included. */
export function prepPending(): number {
  return pending;
}
