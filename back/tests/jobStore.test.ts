import { assert, assertEquals, assertRejects } from "@std/assert";
import prisma from "@/db.ts";
import { closeDb, truncate } from "./db.ts";
import type { JobRank, JobStatus } from "@/generated/prisma/client.ts";
import {
  type JobInput,
  listJobs,
  markInboxWritten,
  markJob,
  markNotified,
  saveJob,
  setRank,
  shortId,
} from "@/jobs/store.ts";

const t0 = new Date("2026-11-01T10:00:00Z");

function input(overrides: Partial<JobInput> = {}): JobInput {
  return {
    source: "linkedin",
    externalId: "ext-1",
    url: "https://example.com/1",
    title: "Junior Developer",
    company: "Acme",
    location: "Geneva",
    description: "Build small things.",
    ...overrides,
  };
}

async function addJob(
  overrides: Partial<JobInput> = {},
  opts: {
    rank?: JobRank | null;
    status?: JobStatus;
    createdAt?: Date;
  } = {},
) {
  const { job } = await saveJob(input(overrides));
  if (opts.rank !== undefined) await setRank(job.id, opts.rank, "test");
  if (opts.status !== undefined || opts.createdAt !== undefined) {
    return await prisma.job.update({
      where: { id: job.id },
      data: {
        ...(opts.status !== undefined ? { status: opts.status } : {}),
        ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
      },
    });
  }
  return job;
}

Deno.test({
  name: "job store",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    try {
      await t.step("a new posting is saved and marked new", async () => {
        await truncate("Job");
        const { job, duplicate } = await saveJob(input());

        assertEquals(duplicate, false);
        assertEquals(job.source, "linkedin");
        assertEquals(job.externalId, "ext-1");
        assertEquals(job.status, "queued");
        assertEquals(job.rank, null);
        assertEquals(job.notifiedAt, null);
        assertEquals(shortId(job), job.id.slice(0, 8));
      });

      await t.step(
        "a duplicate keeps its status, rank and ping but refreshes the text",
        async () => {
          await truncate("Job");
          const { job: first } = await saveJob(input());
          await setRank(first.id, "apply", "good fit");
          await markJob(first.id, "ready");
          await markNotified(first.id);

          const { job, duplicate } = await saveJob(input({
            url: "https://example.com/1-edited",
            title: "Junior Developer (edited)",
            description: "A refreshed description.",
          }));

          assertEquals(duplicate, true);
          assertEquals(job.id, first.id);
          assertEquals(job.status, "ready");
          assertEquals(job.rank, "apply");
          assert(job.notifiedAt !== null);
          assertEquals(job.title, "Junior Developer (edited)");
          assertEquals(job.description, "A refreshed description.");
          assertEquals(await prisma.job.count(), 1);
        },
      );

      await t.step("concurrent saves insert exactly one row", async () => {
        await truncate("Job");
        const [a, b] = await Promise.all([
          saveJob(input({ externalId: "race-1" })),
          saveJob(input({ externalId: "race-1" })),
        ]);

        assertEquals(a.job.id, b.job.id);
        assertEquals([a.duplicate, b.duplicate].sort(), [false, true]);
        assertEquals(await prisma.job.count(), 1);
      });

      await t.step(
        "the list orders apply, maybe, unranked, skip and newest first",
        async () => {
          await truncate("Job");
          await addJob({ externalId: "apply-old", title: "apply old" }, {
            rank: "apply",
            createdAt: t0,
          });
          await addJob({ externalId: "apply-new", title: "apply new" }, {
            rank: "apply",
            createdAt: new Date(t0.getTime() + 60_000),
          });
          await addJob({ externalId: "maybe-old", title: "maybe old" }, {
            rank: "maybe",
            createdAt: t0,
          });
          await addJob({ externalId: "maybe-new", title: "maybe new" }, {
            rank: "maybe",
            createdAt: new Date(t0.getTime() + 60_000),
          });
          await addJob({ externalId: "unranked", title: "unranked" }, {
            rank: null,
          });
          await addJob({ externalId: "skip-old", title: "skip old" }, {
            rank: "skip",
            createdAt: t0,
          });
          await addJob({ externalId: "skip-new", title: "skip new" }, {
            rank: "skip",
            createdAt: new Date(t0.getTime() + 60_000),
          });

          const jobs = await listJobs({ includeSkip: true });
          assertEquals(jobs.map((job) => job.title), [
            "apply new",
            "apply old",
            "maybe new",
            "maybe old",
            "unranked",
            "skip new",
            "skip old",
          ]);
        },
      );

      await t.step(
        "the default list hides skip and finished statuses",
        async () => {
          await truncate("Job");
          await addJob({ externalId: "keep", title: "keep" }, {
            rank: "apply",
          });
          await addJob({ externalId: "skip", title: "skip" }, { rank: "skip" });
          await addJob({ externalId: "dropped", title: "dropped" }, {
            rank: "apply",
            status: "dropped",
          });
          await addJob({ externalId: "queued", title: "unranked queued" });

          const jobs = await listJobs();
          assertEquals(jobs.map((job) => job.title), [
            "keep",
            "unranked queued",
          ]);
        },
      );

      await t.step("the limit applies after the ranking order", async () => {
        await truncate("Job");
        await addJob({ externalId: "a1", title: "apply 1" }, {
          rank: "apply",
          createdAt: t0,
        });
        await addJob({ externalId: "a2", title: "apply 2" }, {
          rank: "apply",
          createdAt: new Date(t0.getTime() + 60_000),
        });
        await addJob({ externalId: "m1", title: "maybe 1" }, { rank: "maybe" });

        const jobs = await listJobs({ limit: 2 });
        assertEquals(jobs.map((job) => job.title), ["apply 2", "apply 1"]);
      });

      await t.step(
        "markJob resolves a full id, a prefix and an external id",
        async () => {
          await truncate("Job");
          const byId = await addJob({ externalId: "by-id", title: "by id" });
          const byPrefix = await addJob({
            externalId: "by-prefix",
            title: "by prefix",
          });
          const byExternal = await addJob({
            externalId: "by-external",
            title: "by external",
          });

          assertEquals((await markJob(byId.id, "ready")).status, "ready");
          assertEquals(
            (await markJob(byPrefix.id.slice(0, 6), "preparing")).id,
            byPrefix.id,
          );
          assertEquals(
            (await markJob("by-external", "applied")).id,
            byExternal.id,
          );
        },
      );

      await t.step(
        "markJob explains a missing or ambiguous reference",
        async () => {
          await truncate("Job");
          const one = await addJob({ externalId: "one", title: "first job" });
          const two = await addJob({ externalId: "two", title: "second job" });
          await prisma.job.update({
            where: { id: one.id },
            data: { id: "abcdef11-1111-1111-1111-111111111111" },
          });
          await prisma.job.update({
            where: { id: two.id },
            data: { id: "abcdef22-2222-2222-2222-222222222222" },
          });

          const ambiguous = await assertRejects(
            () => markJob("abcdef", "ready"),
            Error,
          );
          assert(ambiguous.message.includes("abcdef11"));
          assert(ambiguous.message.includes("abcdef22"));
          assert(ambiguous.message.includes("first job"));
          assert(ambiguous.message.includes("second job"));

          const missing = await assertRejects(
            () => markJob("zzzzzz", "ready"),
            Error,
          );
          assert(missing.message.includes("No job found"));
        },
      );

      await t.step("the small updaters set their fields", async () => {
        await truncate("Job");
        const { job } = await saveJob(input({ externalId: "small" }));

        const ranked = await setRank(job.id, "maybe", "worth a look");
        assertEquals(ranked.rank, "maybe");
        assertEquals(ranked.rankReason, "worth a look");

        const unranked = await setRank(job.id, null);
        assertEquals(unranked.rank, null);
        assertEquals(unranked.rankReason, null);

        assert((await markNotified(job.id)).notifiedAt !== null);
        assert((await markInboxWritten(job.id)).inboxWrittenAt !== null);
      });
    } finally {
      await closeDb();
    }
  },
});
