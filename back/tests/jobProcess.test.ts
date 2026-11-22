import { assert, assertEquals } from "@std/assert";
import prisma from "@/db.ts";
import { closeDb, truncate } from "./db.ts";
import type { Job, JobRank } from "@/generated/prisma/client.ts";
import { processJob } from "@/jobs/process.ts";
import { saveJob, setRank } from "@/jobs/store.ts";
import type { rankAndStore } from "@/jobs/rank.ts";

function recorder() {
  const notified: string[] = [];
  const written: Job[] = [];
  return {
    notified,
    written,
    notify: (text: string) => {
      notified.push(text);
      return Promise.resolve();
    },
    writeInbox: (job: Job) => {
      written.push(job);
      return Promise.resolve();
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
        "an apply job is pinged once and written to the inbox",
        async () => {
          await truncate("Job");
          const job = await addJob("apply-1");
          const calls = recorder();

          const result = await processJob(job.id, {
            rank: rankAs("apply", "Strong match."),
            notify: calls.notify,
            writeInbox: calls.writeInbox,
          });

          assertEquals(calls.notified.length, 1);
          assert(calls.notified[0].includes("Worth a look"));
          assertEquals(calls.written.length, 1);
          assertEquals(calls.written[0].rank, "apply");
          assertEquals(result?.rank, "apply");

          const stored = await fresh(job.id);
          assert(stored.notifiedAt !== null);
          assert(stored.inboxWrittenAt !== null);
        },
      );

      await t.step("a maybe job is written but not pinged", async () => {
        await truncate("Job");
        const job = await addJob("maybe-1");
        const calls = recorder();

        await processJob(job.id, {
          rank: rankAs("maybe", "Worth a look."),
          notify: calls.notify,
          writeInbox: calls.writeInbox,
        });

        assertEquals(calls.notified.length, 0);
        assertEquals(calls.written.length, 1);

        const stored = await fresh(job.id);
        assertEquals(stored.notifiedAt, null);
        assert(stored.inboxWrittenAt !== null);
      });

      await t.step("a skip job gets nothing", async () => {
        await truncate("Job");
        const job = await addJob("skip-1");
        const calls = recorder();

        await processJob(job.id, {
          rank: rankAs("skip", "Not this one."),
          notify: calls.notify,
          writeInbox: calls.writeInbox,
        });

        assertEquals(calls.notified.length, 0);
        assertEquals(calls.written.length, 0);

        const stored = await fresh(job.id);
        assertEquals(stored.notifiedAt, null);
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
            notify: calls.notify,
            writeInbox: calls.writeInbox,
          });

          assertEquals(result?.rank, null);
          assertEquals(calls.notified.length, 0);
          assertEquals(calls.written.length, 0);

          const stored = await fresh(job.id);
          assertEquals(stored.rank, null);
          assertEquals(stored.notifiedAt, null);
          assertEquals(stored.inboxWrittenAt, null);
        },
      );

      await t.step("running twice still pings and writes once", async () => {
        await truncate("Job");
        const job = await addJob("twice-1");
        const calls = recorder();
        const deps = {
          rank: rankAs("apply", "Strong match."),
          notify: calls.notify,
          writeInbox: calls.writeInbox,
        };

        await processJob(job.id, deps);
        await processJob(job.id, deps);

        assertEquals(calls.notified.length, 1);
        assertEquals(calls.written.length, 1);
      });

      await t.step(
        "a failing ping does not stop the inbox write",
        async () => {
          await truncate("Job");
          const job = await addJob("ping-fails");
          const calls = recorder();

          await processJob(job.id, {
            rank: rankAs("apply"),
            notify: () => Promise.reject(new Error("Discord is down")),
            writeInbox: calls.writeInbox,
          });

          assertEquals(calls.written.length, 1);

          const stored = await fresh(job.id);
          // Null, so the next run retries the ping
          assertEquals(stored.notifiedAt, null);
          assert(stored.inboxWrittenAt !== null);
        },
      );

      await t.step(
        "a failing inbox write leaves the timestamp unset and does not throw",
        async () => {
          await truncate("Job");
          const job = await addJob("inbox-fails");
          const calls = recorder();

          await processJob(job.id, {
            rank: rankAs("apply"),
            notify: calls.notify,
            writeInbox: () => Promise.reject(new Error("Nextcloud is down")),
          });

          const stored = await fresh(job.id);
          assertEquals(stored.inboxWrittenAt, null);
          assert(stored.notifiedAt !== null);
        },
      );
      await t.step(
        "a hung inbox write times out and does not block the job",
        async () => {
          await truncate("Job");
          const job = await addJob("inbox-hangs");
          const calls = recorder();

          const result = await processJob(job.id, {
            rank: rankAs("apply"),
            notify: calls.notify,
            // Never settles, like WebDAV against an unreachable Nextcloud
            writeInbox: () => new Promise<void>(() => {}),
            inboxTimeoutMs: 20,
          });

          assertEquals(result?.id, job.id);
          // The ping happened before the inbox step and still counted
          assertEquals(calls.notified.length, 1);

          const stored = await fresh(job.id);
          assert(stored.notifiedAt !== null);
          assertEquals(stored.inboxWrittenAt, null);
        },
      );
    } finally {
      await closeDb();
    }
  },
});
