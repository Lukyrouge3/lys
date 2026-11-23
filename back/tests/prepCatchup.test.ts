import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import prisma from "@/db.ts";
import { closeDb, truncate } from "./db.ts";
import type { Job, JobStatus } from "@/generated/prisma/client.ts";
import { saveJob, setRank } from "@/jobs/store.ts";
import { runPrepCatchup } from "@/scheduler/prepCatchup.ts";
import type { deliverApplication } from "@/prep/deliver.ts";
import type { PrepResult } from "@/prep/types.ts";
import type { upsertTrackerRow } from "@/prep/tracker.ts";
import type { writeJobToInbox } from "@/jobs/inbox.ts";

const ENV_KEYS = [
  "PREP_ENABLED",
  "PREP_RANKS",
  "PREP_DAILY_CAP",
  "PREP_TIMEOUT_MS",
] as const;

function useEnv(
  overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {},
) {
  const values: Record<string, string> = {
    PREP_ENABLED: "1",
    PREP_RANKS: "apply,maybe",
    PREP_DAILY_CAP: "0",
    PREP_TIMEOUT_MS: "600000",
    ...overrides,
  };
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value !== undefined) Deno.env.set(key, value);
  }
}

function clearEnv(): void {
  for (const key of ENV_KEYS) Deno.env.delete(key);
}

const NOW = Date.parse("2026-11-23T05:30:00Z");

let counter = 0;

async function addJob(opts: {
  rank?: "apply" | "maybe" | "skip" | null;
  status?: JobStatus;
  prepAttempts?: number;
  preparedAt?: Date | null;
  createdAt?: Date;
} = {}): Promise<Job> {
  counter += 1;
  const { job } = await saveJob({
    source: "linkedin",
    externalId: `catch-${counter}`,
    url: `https://www.linkedin.com/jobs/view/${counter}`,
    title: `Job ${counter}`,
    company: "Acme",
    location: "Geneva",
    description: "Build small things.",
  });

  if (opts.rank !== undefined) await setRank(job.id, opts.rank, "test");
  return await prisma.job.update({
    where: { id: job.id },
    data: {
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      ...(opts.prepAttempts !== undefined
        ? { prepAttempts: opts.prepAttempts }
        : {}),
      ...(opts.preparedAt !== undefined ? { preparedAt: opts.preparedAt } : {}),
      ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
    },
  });
}

function result(): PrepResult {
  return {
    language: "en",
    notes: "## Selection\n\nRows.",
    cvTyp: "CV",
    coverTyp: "COVER",
    cvPdf: new TextEncoder().encode("%PDF cv"),
    coverPdf: new TextEncoder().encode("%PDF cover"),
    status: "ready",
    gaps: [],
  };
}

type Harness = {
  prepareCalls: Job[];
  deps: Parameters<typeof runPrepCatchup>[0] & { log: (line: string) => void };
  lines: string[];
};

function harness(
  options: {
    prepare?: (job: Job) => Promise<PrepResult>;
  } = {},
): Harness {
  const prepareCalls: Job[] = [];
  const lines: string[] = [];

  const prepare = (job: Job) => {
    prepareCalls.push(job);
    return options.prepare ? options.prepare(job) : Promise.resolve(result());
  };

  const deliver = ((job: Job) => {
    return Promise.resolve({ folder: `Postulations/acme/${job.id}` });
  }) as unknown as typeof deliverApplication;

  const tracker = (() =>
    Promise.resolve({
      inserted: true,
      rows: 1,
      path: "Postulations/Applications.md",
    })) as unknown as typeof upsertTrackerRow;

  const writeInbox =
    (() =>
      Promise.resolve("written" as const)) as unknown as typeof writeJobToInbox;

  return {
    prepareCalls,
    lines,
    deps: {
      prepare,
      deliver,
      tracker,
      writeInbox,
      now: () => NOW,
      ranks: ["apply", "maybe"],
      timeoutMs: 5_000,
      log: (line: string) => lines.push(line),
    },
  };
}

Deno.test({
  name: "prep catch-up",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    try {
      await t.step("apply comes before maybe, oldest first", async () => {
        useEnv();
        await truncate("Job");

        await addJob({
          rank: "maybe",
          createdAt: new Date("2026-11-20T01:00:00Z"),
        });
        await addJob({
          rank: "apply",
          createdAt: new Date("2026-11-20T02:00:00Z"),
        });
        await addJob({
          rank: "apply",
          createdAt: new Date("2026-11-20T00:00:00Z"),
        });
        await addJob({
          rank: "maybe",
          createdAt: new Date("2026-11-20T03:00:00Z"),
        });

        const h = harness();
        await runPrepCatchup(h.deps);

        assertEquals(
          h.prepareCalls.map((job) => job.externalId),
          ["catch-3", "catch-2", "catch-1", "catch-4"],
        );
      });

      await t.step("it stops as soon as the cap is reached", async () => {
        useEnv({ PREP_DAILY_CAP: "2" });
        await truncate("Job");

        for (let index = 0; index < 4; index++) {
          await addJob({
            rank: "apply",
            createdAt: new Date(`2026-11-20T0${index}:00:00Z`),
          });
        }

        const h = harness();
        await runPrepCatchup(h.deps);

        assertEquals(h.prepareCalls.length, 2);
        const stopped = h.lines.find((line) => line.includes("daily cap"));
        assert(stopped, "the cap stop must be logged");
        assertStringIncludes(stopped!, "prepared 2");
        assertStringIncludes(stopped!, "2 still waiting");
      });

      await t.step(
        "skip, prepared and exhausted jobs are left alone",
        async () => {
          useEnv();
          await truncate("Job");

          const valid = await addJob({ rank: "apply" });
          await addJob({ rank: "skip" });
          await addJob({ rank: "apply", preparedAt: new Date(NOW - 60_000) });
          await addJob({ rank: "apply", prepAttempts: 3 });

          const h = harness();
          await runPrepCatchup(h.deps);

          assertEquals(h.prepareCalls.map((job) => job.id), [valid.id]);
        },
      );

      await t.step("jobs are prepared one at a time", async () => {
        useEnv();
        await truncate("Job");

        for (let index = 0; index < 3; index++) {
          await addJob({
            rank: "apply",
            createdAt: new Date(`2026-11-20T0${index}:00:00Z`),
          });
        }

        let active = 0;
        let most = 0;
        const h = harness({
          prepare: async () => {
            active += 1;
            most = Math.max(most, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return result();
          },
        });
        await runPrepCatchup(h.deps);

        assertEquals(h.prepareCalls.length, 3);
        assertEquals(most, 1);
      });

      await t.step("a failing prepare does not stop the rest", async () => {
        useEnv();
        await truncate("Job");

        const bad = await addJob({
          rank: "apply",
          createdAt: new Date("2026-11-20T00:00:00Z"),
        });
        const good = await addJob({
          rank: "apply",
          createdAt: new Date("2026-11-20T01:00:00Z"),
        });

        const h = harness({
          prepare: (job) =>
            job.id === bad.id
              ? Promise.reject(new Error("the model exploded"))
              : Promise.resolve(result()),
        });
        await runPrepCatchup(h.deps);

        assertEquals(h.prepareCalls.length, 2);
        const failed = await prisma.job.findUniqueOrThrow({
          where: { id: bad.id },
        });
        assertEquals(failed.status, "queued");
        assertEquals(failed.prepAttempts, 1);
        const prepared = await prisma.job.findUniqueOrThrow({
          where: { id: good.id },
        });
        assertEquals(prepared.status, "ready");
        assertStringIncludes(h.lines.at(-1) ?? "", "prepared 1");
      });

      await t.step("nothing to do is one line", async () => {
        useEnv();
        await truncate("Job");

        const h = harness();
        await runPrepCatchup(h.deps);

        assertEquals(h.lines.length, 1);
        assertStringIncludes(h.lines[0], "prep catch-up nothing to prepare");
      });

      await t.step("it is off when PREP_ENABLED is 0", async () => {
        useEnv({ PREP_ENABLED: "0" });
        await truncate("Job");
        await addJob({ rank: "apply" });

        const h = harness();
        await runPrepCatchup(h.deps);

        assertEquals(h.prepareCalls.length, 0);
        assertStringIncludes(h.lines[0], "disabled");
      });
    } finally {
      clearEnv();
      await closeDb();
    }
  },
});
