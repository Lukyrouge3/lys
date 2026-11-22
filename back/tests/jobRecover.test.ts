import { assertEquals } from "@std/assert";
import prisma from "@/db.ts";
import { closeDb, truncate } from "./db.ts";
import type { Job, JobStatus } from "@/generated/prisma/client.ts";
import {
  INTERRUPTED_PREP_NOTE,
  interruptedPrepJobs,
  recoverInterruptedPrep,
  shouldPrepare,
} from "@/jobs/prep.ts";
import { saveJob, setRank } from "@/jobs/store.ts";

const ENV_KEYS = ["PREP_ENABLED", "PREP_RANKS", "PREP_DAILY_CAP"] as const;

function useEnv(): void {
  Deno.env.set("PREP_ENABLED", "1");
  Deno.env.set("PREP_RANKS", "apply,maybe");
  Deno.env.set("PREP_DAILY_CAP", "6");
}

function clearEnv(): void {
  for (const key of ENV_KEYS) Deno.env.delete(key);
}

let counter = 0;

async function addJob(
  opts: {
    rank?: "apply" | "maybe" | "skip" | null;
    status?: JobStatus;
    prepAttempts?: number;
    prepNote?: string | null;
  } = {},
): Promise<Job> {
  counter += 1;
  const { job } = await saveJob({
    source: "linkedin",
    externalId: `recover-${counter}`,
    url: `https://example.test/jobs/${counter}`,
    title: `Job ${counter}`,
    company: "Acme",
    location: "Geneva",
    description: "Build small things.",
  });

  if (opts.rank !== undefined) await setRank(job.id, opts.rank, "test");
  if (
    opts.status !== undefined || opts.prepAttempts !== undefined ||
    opts.prepNote !== undefined
  ) {
    return await prisma.job.update({
      where: { id: job.id },
      data: {
        ...(opts.status !== undefined ? { status: opts.status } : {}),
        ...(opts.prepAttempts !== undefined
          ? { prepAttempts: opts.prepAttempts }
          : {}),
        ...(opts.prepNote !== undefined ? { prepNote: opts.prepNote } : {}),
      },
    });
  }
  return job;
}

async function fresh(id: string): Promise<Job> {
  return await prisma.job.findUniqueOrThrow({ where: { id } });
}

Deno.test({
  name: "job recovery",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    try {
      await t.step("a preparing job goes back to the queue", async () => {
        useEnv();
        await truncate("Job");
        const job = await addJob({
          rank: "apply",
          status: "preparing",
          prepAttempts: 1,
        });

        assertEquals(await recoverInterruptedPrep(), 1);

        const stored = await fresh(job.id);
        assertEquals(stored.status, "queued");
        assertEquals(stored.prepNote, INTERRUPTED_PREP_NOTE);
        assertEquals(stored.prepAttempts, 1);
      });

      await t.step("count is only what it changed", async () => {
        useEnv();
        await truncate("Job");
        await addJob({ rank: "apply", status: "queued", prepNote: "waiting" });
        await addJob({ rank: "apply", status: "ready" });
        await addJob({ rank: "apply", status: "review" });
        const stuck = await addJob({
          rank: "maybe",
          status: "preparing",
          prepAttempts: 2,
        });
        await addJob({ rank: "maybe", status: "preparing", prepAttempts: 0 });

        assertEquals(await recoverInterruptedPrep(), 2);
        assertEquals((await fresh(stuck.id)).prepAttempts, 2);
      });

      await t.step("jobs that were not preparing are untouched", async () => {
        useEnv();
        await truncate("Job");
        const queued = await addJob({
          rank: "apply",
          status: "queued",
          prepNote: "waiting",
        });
        const ready = await addJob({
          rank: "apply",
          status: "ready",
          prepNote: "gaps",
        });
        const review = await addJob({
          rank: "apply",
          status: "review",
          prepNote: "needs a look",
        });

        assertEquals(await recoverInterruptedPrep(), 0);

        assertEquals((await fresh(queued.id)).prepNote, "waiting");
        assertEquals((await fresh(ready.id)).status, "ready");
        assertEquals((await fresh(ready.id)).prepNote, "gaps");
        assertEquals((await fresh(review.id)).status, "review");
        assertEquals((await fresh(review.id)).prepNote, "needs a look");
      });

      await t.step("a recovered job is offered to the prep queue", async () => {
        useEnv();
        await truncate("Job");
        const job = await addJob({
          rank: "apply",
          status: "preparing",
          prepAttempts: 1,
        });

        assertEquals(await recoverInterruptedPrep(), 1);

        const offered = await interruptedPrepJobs();
        assertEquals(offered.length, 1);
        assertEquals(offered[0].id, job.id);
      });

      await t.step(
        "a job at the attempts limit is recovered but not offered",
        async () => {
          useEnv();
          await truncate("Job");
          const tired = await addJob({
            rank: "apply",
            status: "preparing",
            prepAttempts: 3,
          });

          assertEquals(await recoverInterruptedPrep(), 1);

          const stored = await fresh(tired.id);
          assertEquals(stored.status, "queued");
          assertEquals(stored.prepAttempts, 3);
          assertEquals(shouldPrepare(stored), false);
          assertEquals((await interruptedPrepJobs()).length, 0);
        },
      );
    } finally {
      clearEnv();
      await closeDb();
    }
  },
});
