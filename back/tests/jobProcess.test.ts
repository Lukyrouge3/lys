import { assert, assertEquals } from "@std/assert";
import prisma from "@/db.ts";
import { closeDb, truncate } from "./db.ts";
import type { Job, JobRank } from "@/generated/prisma/client.ts";
import { processJob } from "@/jobs/process.ts";
import { saveJob, setRank } from "@/jobs/store.ts";
import type { rankAndStore } from "@/jobs/rank.ts";

function recorder() {
  const written: Job[] = [];
  return {
    written,
    writeInbox: (job: Job) => {
      written.push(job);
      return Promise.resolve("written" as const);
    },
  };
}

const rankAs = (rank: JobRank, reason: string | null = "Because.") =>
  ((id: string) => setRank(id, rank, reason)) as typeof rankAndStore;

/** What the real ranker does when the agent call fails: the row, unchanged. */
const failRank = (async (id: string) => {
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) throw new Error(`Job ${id} not found`);
  return job;
}) as typeof rankAndStore;

async function addJob(externalId: string): Promise<Job> {
  const { job } = await saveJob({
    source: "linkedin",
    externalId,
    url: `https://example.com/${externalId}`,
    title: "Junior Developer",
    company: "Acme",
    location: "Geneva",
    description: "Build small things.",
  });
  return job;
}

function fresh(id: string): Promise<Job> {
  return prisma.job.findUniqueOrThrow({ where: { id } });
}

Deno.test({
  name: "job processing",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    try {
      await t.step(
        "an apply job is written to the inbox without pinging anyone",
        async () => {
          await truncate("Job");
          const job = await addJob("apply-1");
          const calls = recorder();

          const result = await processJob(job.id, {
            rank: rankAs("apply", "Strong match."),
            writeInbox: calls.writeInbox,
            willPrepare: () => Promise.resolve(false),
          });

          assertEquals(calls.written.length, 1);
          assertEquals(calls.written[0].rank, "apply");
          assertEquals(result?.rank, "apply");

          const stored = await fresh(job.id);
          assertEquals(stored.notifiedAt, null);
          assert(stored.inboxWrittenAt !== null);
        },
      );

      await t.step("a maybe job is written", async () => {
        await truncate("Job");
        const job = await addJob("maybe-1");
        const calls = recorder();

        await processJob(job.id, {
          rank: rankAs("maybe", "Worth a look."),
          writeInbox: calls.writeInbox,
          willPrepare: () => Promise.resolve(false),
        });

        assertEquals(calls.written.length, 1);

        const stored = await fresh(job.id);
        assert(stored.inboxWrittenAt !== null);
      });

      await t.step("a skip job gets nothing", async () => {
        await truncate("Job");
        const job = await addJob("skip-1");
        const calls = recorder();

        await processJob(job.id, {
          rank: rankAs("skip", "Not this one."),
          writeInbox: calls.writeInbox,
          willPrepare: () => Promise.resolve(false),
        });

        assertEquals(calls.written.length, 0);

        const stored = await fresh(job.id);
        assertEquals(stored.inboxWrittenAt, null);
      });

      await t.step(
        "a ranker failure leaves the job alone and does not throw",
        async () => {
          await truncate("Job");
          const job = await addJob("unranked-1");
          const calls = recorder();

          const result = await processJob(job.id, {
            rank: failRank,
            writeInbox: calls.writeInbox,
            willPrepare: () => Promise.resolve(false),
          });

          assertEquals(result?.rank, null);
          assertEquals(calls.written.length, 0);

          const stored = await fresh(job.id);
          assertEquals(stored.rank, null);
          assertEquals(stored.inboxWrittenAt, null);
        },
      );

      await t.step("running twice still writes once", async () => {
        await truncate("Job");
        const job = await addJob("twice-1");
        const calls = recorder();
        const deps = {
          rank: rankAs("apply", "Strong match."),
          writeInbox: calls.writeInbox,
          willPrepare: () => Promise.resolve(false),
        };

        await processJob(job.id, deps);
        await processJob(job.id, deps);

        assertEquals(calls.written.length, 1);
      });

      await t.step(
        "prep replaces the bridge file, so the inbox is left alone",
        async () => {
          await truncate("Job");
          const job = await addJob("prep-will-run");
          const calls = recorder();

          const result = await processJob(job.id, {
            rank: rankAs("apply", "Strong match."),
            writeInbox: calls.writeInbox,
            willPrepare: () => Promise.resolve(true),
          });

          assertEquals(calls.written.length, 0);
          assertEquals(result?.rank, "apply");

          const stored = await fresh(job.id);
          assertEquals(stored.inboxWrittenAt, null);
        },
      );

      await t.step(
        "when prep will not run, the bridge file is still written",
        async () => {
          await truncate("Job");
          const job = await addJob("prep-will-not-run");
          const calls = recorder();

          await processJob(job.id, {
            rank: rankAs("maybe", "Worth a look."),
            writeInbox: calls.writeInbox,
            willPrepare: () => Promise.resolve(false),
          });

          assertEquals(calls.written.length, 1);
          assert((await fresh(job.id)).inboxWrittenAt !== null);
        },
      );

      await t.step(
        "a failing inbox write leaves the timestamp unset and does not throw",
        async () => {
          await truncate("Job");
          const job = await addJob("inbox-fails");

          await processJob(job.id, {
            rank: rankAs("apply"),
            writeInbox: () => Promise.reject(new Error("Nextcloud is down")),
            willPrepare: () => Promise.resolve(false),
          });

          const stored = await fresh(job.id);
          assertEquals(stored.inboxWrittenAt, null);
        },
      );
      await t.step(
        "a hung inbox write times out and does not block the job",
        async () => {
          await truncate("Job");
          const job = await addJob("inbox-hangs");

          const result = await processJob(job.id, {
            rank: rankAs("apply"),
            // Never settles, like WebDAV against an unreachable Nextcloud
            writeInbox: () => new Promise<never>(() => {}),
            inboxTimeoutMs: 20,
            willPrepare: () => Promise.resolve(false),
          });

          assertEquals(result?.id, job.id);

          const stored = await fresh(job.id);
          assertEquals(stored.inboxWrittenAt, null);
        },
      );
    } finally {
      await closeDb();
    }
  },
});
