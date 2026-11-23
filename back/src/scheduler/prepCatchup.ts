// The nightly catch-up: jobs the daily prep cap left queued are prepared one at
// a time, in the same serial queue a click uses, so nothing waits forever and
// nothing ever runs twice at once.
import type { Job } from "@/generated/prisma/client.ts";
import prisma from "@/db.ts";
import { shortJobId } from "@/jobs/log.ts";
import {
  MAX_PREP_ATTEMPTS,
  prepareJob,
  prepBlockReason,
  prepCapReached,
  prepEnabled,
  prepRanks,
} from "@/jobs/prep.ts";
import type { PrepDeps } from "@/jobs/prep.ts";
import { enqueuePrep } from "@/jobs/queues.ts";
import { logger } from "@/utils/logger.ts";

/** The `ScheduledRun` row that dates the nightly catch-up. */
export const PREP_CATCHUP_JOB = "prep-catchup";

export const DEFAULT_PREP_CATCHUP_TIME = "05:30";

/** Local time of the catch-up, from `PREP_CATCHUP_TIME` ("HH:MM"). */
export function prepCatchupTime(): string {
  return Deno.env.get("PREP_CATCHUP_TIME")?.trim() ||
    DEFAULT_PREP_CATCHUP_TIME;
}

/** "PREP_ENABLED=0" switches the catch-up off with the rest of prep. */
export function prepCatchupEnabled(): boolean {
  return prepEnabled();
}

export type PrepCatchupDeps = Partial<PrepDeps> & {
  /** Receives the `scheduler:` lines instead of the logger. */
  log?: (message: string) => void;
};

/** Apply before maybe; skip never reaches here. */
function rankOrder(job: Job): number {
  return job.rank === "apply" ? 0 : 1;
}

/**
 * Prepares what the daily cap held back. Stops the moment the cap is reached,
 * logs what it did and what still waits, and never throws: the scheduler must
 * survive a bad night.
 */
export async function runPrepCatchup(
  deps: PrepCatchupDeps = {},
): Promise<void> {
  const log = deps.log ?? ((message: string) => logger.info(message));
  const logError = deps.log ?? ((message: string) => logger.error(message));
  const now = deps.now ?? (() => Date.now());

  try {
    if (!prepCatchupEnabled()) {
      log("scheduler: prep catch-up disabled (PREP_ENABLED=0)");
      return;
    }

    const ranks = deps.ranks ?? prepRanks();
    const candidates = (await prisma.job.findMany({
      where: {
        status: "queued",
        preparedAt: null,
        prepAttempts: { lt: MAX_PREP_ATTEMPTS },
        rank: { in: ranks },
      },
      orderBy: { createdAt: "asc" },
    })).sort((a, b) => rankOrder(a) - rankOrder(b));

    if (candidates.length === 0) {
      log("scheduler: prep catch-up nothing to prepare");
      return;
    }

    let prepared = 0;
    let started = 0;

    for (const job of candidates) {
      const capReached = await prepCapReached(now());
      const blocked = prepBlockReason(job, ranks, { capReached });

      if (blocked === "cap") {
        log(
          `scheduler: prep catch-up stopped at the daily cap ` +
            `(prepared ${prepared}, ${
              candidates.length - started
            } still waiting)`,
        );
        return;
      }
      if (blocked) {
        log(
          `scheduler: prep catch-up skipped ${
            shortJobId(job.id)
          } (${blocked}) ${job.url}`,
        );
        continue;
      }

      started += 1;
      log(
        `scheduler: prep catch-up starting ${started}/${candidates.length} ` +
          `${shortJobId(job.id)} ${job.company} ${job.url}`,
      );

      let done = false;
      await enqueuePrep(job.id, async (id) => {
        const outcome = await prepareJob(id, deps);
        done = outcome.prepared;
      });
      if (done) prepared += 1;
    }

    log(
      `scheduler: prep catch-up done (prepared ${prepared}, ` +
        `${candidates.length - started} still waiting)`,
    );
  } catch (err) {
    logError(
      `scheduler: prep catch-up failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
