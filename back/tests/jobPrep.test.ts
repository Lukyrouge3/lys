import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import prisma from "@/db.ts";
import { closeDb, truncate } from "./db.ts";
import type { Job, JobStatus } from "@/generated/prisma/client.ts";
import {
  prepareJob,
  prepBlockReason,
  prepCapReached,
  prepRanks,
  shouldPrepare,
} from "@/jobs/prep.ts";
import { saveJob, setRank } from "@/jobs/store.ts";
import type { deliverApplication } from "@/prep/deliver.ts";
import type { bundleApplication } from "@/prep/bundle.ts";
import type { BundleResult } from "@/prep/bundle.ts";
import type { PrepResult } from "@/prep/types.ts";
import type { TrackerEntry, upsertTrackerRow } from "@/prep/tracker.ts";
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
    PREP_DAILY_CAP: "6",
    PREP_TIMEOUT_MS: "600000",
    ...overrides,
  };
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

function clearEnv(): void {
  for (const key of ENV_KEYS) Deno.env.delete(key);
}

let counter = 0;

async function addJob(opts: {
  rank?: "apply" | "maybe" | "skip" | null;
  status?: JobStatus;
  prepAttempts?: number;
  preparedAt?: Date | null;
} = {}): Promise<Job> {
  counter += 1;
  const { job } = await saveJob({
    source: "linkedin",
    externalId: `prep-${counter}`,
    url: `https://example.test/jobs/${counter}`,
    title: `Job ${counter}`,
    company: "Acme",
    location: "Geneva",
    description: "Build small things.",
  });

  if (opts.rank !== undefined) await setRank(job.id, opts.rank, "test");
  if (
    opts.status !== undefined || opts.prepAttempts !== undefined ||
    opts.preparedAt !== undefined
  ) {
    return await prisma.job.update({
      where: { id: job.id },
      data: {
        ...(opts.status !== undefined ? { status: opts.status } : {}),
        ...(opts.prepAttempts !== undefined
          ? { prepAttempts: opts.prepAttempts }
          : {}),
        ...(opts.preparedAt !== undefined
          ? { preparedAt: opts.preparedAt }
          : {}),
      },
    });
  }
  return job;
}

function result(overrides: Partial<PrepResult> = {}): PrepResult {
  return {
    language: "en",
    notes: "## Selection\n\nRows.",
    cvTyp: "CV",
    coverTyp: "COVER",
    cvPdf: new TextEncoder().encode("%PDF cv"),
    coverPdf: new TextEncoder().encode("%PDF cover"),
    status: "ready",
    gaps: [],
    ...overrides,
  };
}

type Harness = {
  prepareCalls: Job[];
  deliveries: string[];
  bundles: string[];
  trackerEntries: TrackerEntry[];
  bridge: Job[];
  deps: Parameters<typeof prepareJob>[1];
};

function harness(
  options: {
    prepared?: PrepResult;
    prepareError?: Error;
    hang?: boolean;
    trackerError?: Error;
    bundleError?: Error;
    timeoutMs?: number;
    force?: boolean;
    now?: () => number;
  } = {},
): Harness {
  const prepareCalls: Job[] = [];
  const deliveries: string[] = [];
  const bundles: string[] = [];
  const trackerEntries: TrackerEntry[] = [];
  const bridge: Job[] = [];

  const prepare = (job: Job) => {
    prepareCalls.push(job);
    if (options.hang) return new Promise<PrepResult>(() => {});
    if (options.prepareError) return Promise.reject(options.prepareError);
    return Promise.resolve(options.prepared ?? result());
  };

  const deliver = ((job: Job) => {
    deliveries.push(job.id);
    return Promise.resolve({ folder: "Postulations/acme/2026-11-10" });
  }) as unknown as typeof deliverApplication;

  const bundle = ((folder: string) => {
    bundles.push(folder);
    if (options.bundleError) return Promise.reject(options.bundleError);
    return Promise.resolve(
      {
        path: `${folder}/application.pdf`,
        parts: ["cv-en.pdf", "cover-en.pdf"],
        skipped: [],
        pages: 2,
      } satisfies BundleResult,
    );
  }) as unknown as typeof bundleApplication;

  const tracker = ((entry: TrackerEntry) => {
    trackerEntries.push(entry);
    if (options.trackerError) return Promise.reject(options.trackerError);
    return Promise.resolve({
      inserted: true,
      rows: 1,
      path: "Postulations/Applications.md",
    });
  }) as unknown as typeof upsertTrackerRow;

  const writeInbox = ((job: Job) => {
    bridge.push(job);
    return Promise.resolve("written" as const);
  }) as unknown as typeof writeJobToInbox;

  return {
    prepareCalls,
    deliveries,
    bundles,
    trackerEntries,
    bridge,
    deps: {
      prepare,
      deliver,
      bundle,
      tracker,
      writeInbox,
      timeoutMs: options.timeoutMs ?? 5_000,
      force: options.force,
      now: options.now,
      ranks: ["apply", "maybe"],
    },
  };
}

async function fresh(id: string): Promise<Job> {
  return await prisma.job.findUniqueOrThrow({ where: { id } });
}

Deno.test({
  name: "job prep",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    try {
      await t.step("shouldPrepare is the static gate", () => {
        useEnv();
        assertEquals(prepRanks(), ["apply", "maybe"]);
        assertEquals(
          shouldPrepare({
            status: "queued",
            rank: "apply",
            prepAttempts: 0,
            preparedAt: null,
          }),
          true,
        );
        assertEquals(
          shouldPrepare({
            status: "queued",
            rank: "maybe",
            prepAttempts: 0,
            preparedAt: null,
          }),
          true,
        );
        assertEquals(
          shouldPrepare({
            status: "queued",
            rank: "skip",
            prepAttempts: 0,
            preparedAt: null,
          }),
          false,
        );
        assertEquals(
          shouldPrepare({
            status: "ready",
            rank: "apply",
            prepAttempts: 0,
            preparedAt: null,
          }),
          false,
        );
        assertEquals(
          shouldPrepare({
            status: "queued",
            rank: "apply",
            prepAttempts: 3,
            preparedAt: null,
          }),
          false,
        );
        assertEquals(
          shouldPrepare({
            status: "queued",
            rank: "apply",
            prepAttempts: 0,
            preparedAt: new Date(),
          }),
          false,
        );

        Deno.env.set("PREP_ENABLED", "0");
        assertEquals(
          prepBlockReason({
            status: "queued",
            rank: "apply",
            prepAttempts: 0,
            preparedAt: null,
          }),
          "disabled",
        );
      });

      await t.step("guards return a reason without preparing", async () => {
        useEnv({ PREP_ENABLED: "0" });
        await truncate("Job");
        const disabled = await addJob({ rank: "apply" });
        let h = harness();
        let outcome = await prepareJob(disabled.id, h.deps);
        assertEquals(outcome.prepared, false);
        assertEquals(outcome.reason, "disabled");
        assertEquals(h.prepareCalls.length, 0);

        useEnv();
        await truncate("Job");
        const skip = await addJob({ rank: "skip" });
        h = harness();
        outcome = await prepareJob(skip.id, h.deps);
        assertEquals(outcome.reason, "rank");

        await truncate("Job");
        const tired = await addJob({ rank: "apply", prepAttempts: 3 });
        outcome = await prepareJob(tired.id, harness().deps);
        assertEquals(outcome.reason, "attempts");

        await truncate("Job");
        const done = await addJob({ rank: "apply", preparedAt: new Date() });
        outcome = await prepareJob(done.id, harness().deps);
        assertEquals(outcome.reason, "prepared");

        await truncate("Job");
        const ready = await addJob({ rank: "apply", status: "ready" });
        outcome = await prepareJob(ready.id, harness().deps);
        assertEquals(outcome.reason, "status");
      });

      await t.step("the daily cap blocks prep unless forced", async () => {
        useEnv({ PREP_DAILY_CAP: "1" });
        await truncate("Job");

        const prepared = await addJob({
          rank: "apply",
          status: "ready",
          preparedAt: new Date(),
        });
        assert(prepared.preparedAt);

        const target = await addJob({ rank: "apply" });
        let h = harness();
        let outcome = await prepareJob(target.id, h.deps);
        assertEquals(outcome.prepared, false);
        assertEquals(outcome.reason, "cap");
        assertEquals(h.prepareCalls.length, 0);
        assertEquals(await prepCapReached(), true);

        h = harness({ force: true });
        outcome = await prepareJob(target.id, h.deps);
        assertEquals(outcome.prepared, true);
        assertEquals(h.prepareCalls.length, 1);
      });

      await t.step("force still respects PREP_ENABLED", async () => {
        useEnv({ PREP_ENABLED: "0" });
        await truncate("Job");
        const job = await addJob({ rank: "apply", prepAttempts: 3 });

        const h = harness({ force: true });
        const outcome = await prepareJob(job.id, h.deps);

        assertEquals(outcome.prepared, false);
        assertEquals(outcome.reason, "disabled");
        assertEquals(h.prepareCalls.length, 0);
      });

      await t.step(
        "success lands in ready with the folder and tracker row",
        async () => {
          useEnv();
          await truncate("Job");
          const job = await addJob({ rank: "apply" });

          const h = harness({ now: () => Date.parse("2026-11-10T08:00:00Z") });
          const outcome = await prepareJob(job.id, h.deps);

          assertEquals(outcome.prepared, true);
          assertEquals(outcome.folder, "Postulations/acme/2026-11-10");
          assertEquals(h.prepareCalls.length, 1);
          assertEquals(h.prepareCalls[0].status, "preparing");
          assertEquals(h.prepareCalls[0].prepAttempts, 1);
          assertEquals(h.deliveries, [job.id]);

          const stored = await fresh(job.id);
          assertEquals(stored.status, "ready");
          assertEquals(stored.prepFolder, "Postulations/acme/2026-11-10");
          assertEquals(
            stored.preparedAt?.toISOString(),
            "2026-11-10T08:00:00.000Z",
          );
          assertEquals(stored.prepNote, "");
          assertEquals(stored.prepAttempts, 1);

          assertEquals(h.trackerEntries.length, 1);
          assertEquals(h.trackerEntries[0].status, "Drafted");
          assertEquals(h.trackerEntries[0].next, "Review, then send");
          assertEquals(h.trackerEntries[0].applied, "2026-11-10");
        },
      );

      await t.step(
        "review keeps the gaps in the note and the tracker",
        async () => {
          useEnv();
          await truncate("Job");
          const job = await addJob({ rank: "maybe" });

          const h = harness({
            prepared: result({
              status: "review",
              gaps: ["cv: page count 2", "cover: name missing"],
            }),
          });
          const outcome = await prepareJob(job.id, h.deps);

          assertEquals(outcome.prepared, true);
          const stored = await fresh(job.id);
          assertEquals(stored.status, "review");
          assertEquals(
            stored.prepNote,
            "cv: page count 2; cover: name missing",
          );
          assertEquals(
            h.trackerEntries[0].next,
            "Needs review: 2 gaps, see notes.md",
          );
        },
      );

      await t.step("a tracker failure never undoes the delivery", async () => {
        useEnv();
        await truncate("Job");
        const job = await addJob({ rank: "apply" });

        const h = harness({ trackerError: new Error("tracker is locked") });
        const outcome = await prepareJob(job.id, h.deps);

        assertEquals(outcome.prepared, true);
        assertEquals((await fresh(job.id)).status, "ready");
      });

      await t.step(
        "a bundle failure never undoes the delivery",
        async () => {
          useEnv();
          await truncate("Job");
          const job = await addJob({ rank: "apply" });

          const h = harness({ bundleError: new Error("pdfunite is missing") });
          const outcome = await prepareJob(job.id, h.deps);

          assertEquals(outcome.prepared, true);
          assertEquals(h.bundles, ["Postulations/acme/2026-11-10"]);
          assertStringIncludes(outcome.bundleWarning ?? "", "pdfunite");
          assertEquals((await fresh(job.id)).status, "ready");
          assertEquals(h.trackerEntries.length, 1);
        },
      );

      await t.step("review jobs are bundled too", async () => {
        useEnv();
        await truncate("Job");
        const job = await addJob({ rank: "maybe" });

        const h = harness({
          prepared: result({ status: "review", gaps: ["one gap"] }),
        });
        const outcome = await prepareJob(job.id, h.deps);

        assertEquals(outcome.prepared, true);
        assertEquals(h.bundles, ["Postulations/acme/2026-11-10"]);
        assertEquals(outcome.bundle?.pages, 2);
        assertEquals((await fresh(job.id)).status, "review");
      });

      await t.step(
        "an exception puts the job back in the queue with a note",
        async () => {
          useEnv();
          await truncate("Job");
          const job = await addJob({ rank: "apply" });

          const h = harness({ prepareError: new Error("the model exploded") });
          const outcome = await prepareJob(job.id, h.deps);

          assertEquals(outcome.prepared, false);
          assertStringIncludes(outcome.reason ?? "", "the model exploded");
          const stored = await fresh(job.id);
          assertEquals(stored.status, "queued");
          assertEquals(stored.prepAttempts, 1);
          assertEquals(stored.prepNote, "the model exploded");
          assertEquals(h.bridge.length, 0);
        },
      );

      await t.step("a hung workflow times out and requeues", async () => {
        useEnv();
        await truncate("Job");
        const job = await addJob({ rank: "apply" });

        const h = harness({ hang: true, timeoutMs: 20 });
        const outcome = await prepareJob(job.id, h.deps);

        assertEquals(outcome.prepared, false);
        assertStringIncludes(outcome.reason ?? "", "timed out");
        const stored = await fresh(job.id);
        assertEquals(stored.status, "queued");
        assertEquals(stored.prepAttempts, 1);
      });

      await t.step(
        "the third failure writes the old Input bridge file",
        async () => {
          useEnv();
          await truncate("Job");
          const job = await addJob({ rank: "apply", prepAttempts: 2 });

          const h = harness({ prepareError: new Error("still broken") });
          const outcome = await prepareJob(job.id, h.deps);

          assertEquals(outcome.prepared, false);
          assertEquals(h.bridge.length, 1);
          assertEquals(h.bridge[0].id, job.id);
          assertEquals(h.bridge[0].prepAttempts, 3);

          const stored = await fresh(job.id);
          assertEquals(stored.status, "queued");
          assertEquals(stored.prepAttempts, 3);
          assertEquals(stored.prepNote, "still broken");
        },
      );

      await t.step("force re-runs a job that used its attempts", async () => {
        useEnv();
        await truncate("Job");
        const job = await addJob({ rank: "apply", prepAttempts: 3 });

        const h = harness({ force: true });
        const outcome = await prepareJob(job.id, h.deps);

        assertEquals(outcome.prepared, true);
        assertEquals((await fresh(job.id)).status, "ready");
        assertEquals((await fresh(job.id)).prepAttempts, 4);
      });
    } finally {
      clearEnv();
      await closeDb();
    }
  },
});
