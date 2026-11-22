import { assert, assertEquals } from "@std/assert";
import prisma from "@/db.ts";
import { closeDb, truncate } from "./db.ts";
import type { JobInput } from "@/jobs/store.ts";
import { saveJob, setRank, shortId } from "@/jobs/store.ts";
import type { JobStatus } from "@/generated/prisma/client.ts";
import { ListJobsTool } from "@/tools/jobs/listJobs.ts";
import { MarkJobTool } from "@/tools/jobs/markJob.ts";
import {
  generateToolRequest,
  runTool,
  type ToolContext,
} from "@/tools/tool.ts";

const context: ToolContext = {
  conversationId: "test-conversation",
  approval: "pending",
  emit: () => {},
};

const listTool = new ListJobsTool();
const markTool = new MarkJobTool();

let counter = 0;

function input(overrides: Partial<JobInput> = {}): JobInput {
  counter += 1;
  return {
    source: "linkedin",
    externalId: `ext-${counter}`,
    url: `https://example.com/${counter}`,
    title: `Job ${counter}`,
    company: "Acme",
    location: "Geneva",
    // A marker no other output field carries, so a leak is easy to spot.
    description: "DESCRIPTION-TEXT-SHOULD-NEVER-APPEAR",
    ...overrides,
  };
}

async function addJob(
  overrides: Partial<JobInput> = {},
  opts: {
    rank?: "apply" | "maybe" | "skip" | null;
    reason?: string;
    status?: JobStatus;
    createdAt?: Date;
  } = {},
) {
  const { job } = await saveJob(input(overrides));
  if (opts.rank !== undefined) {
    await setRank(job.id, opts.rank, opts.reason ?? "test reason");
  }
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

/** One block per job; the trailing count line is dropped. */
function blocks(output: string): string[] {
  return output.split("\n\n").filter((block) => block.startsWith("`"));
}

async function list(args: Record<string, unknown> = {}): Promise<string> {
  return await listTool.run(context, args);
}

async function mark(args: Record<string, unknown>): Promise<string> {
  return await markTool.run(context, args);
}

Deno.test({
  name: "job tools",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    try {
      await t.step(
        "the default list hides skip and finished jobs",
        async () => {
          await truncate("Job");
          await addJob({ title: "keep me" }, { rank: "apply" });
          await addJob({ title: "skipped" }, { rank: "skip" });
          await addJob({ title: "applied" }, {
            rank: "apply",
            status: "applied",
          });
          await addJob({ title: "dropped" }, {
            rank: "apply",
            status: "dropped",
          });

          const output = await list();
          assert(output.includes("keep me"));
          assert(!output.includes("skipped"));
          assert(!output.includes("applied"));
          assert(!output.includes("dropped"));
          assertEquals(blocks(output).length, 1);
          assert(output.endsWith("1 job shown."));
        },
      );

      await t.step("include_skipped lists the skip rank", async () => {
        await truncate("Job");
        await addJob({ title: "kept" }, { rank: "apply" });
        await addJob({ title: "skipped" }, { rank: "skip" });

        const output = await list({ include_skipped: true });
        assert(output.includes("kept"));
        assert(output.includes("skipped"));
        assertEquals(blocks(output).length, 2);
      });

      await t.step("a status filter shows only that status", async () => {
        await truncate("Job");
        await addJob({ title: "one applied" }, { status: "applied" });
        await addJob({ title: "one rejected" }, { status: "rejected" });

        const output = await list({ status: "rejected" });
        assert(output.includes("one rejected"));
        assert(!output.includes("one applied"));
        assert(output.includes("· rejected"));
      });

      await t.step("the review status can be filtered", async () => {
        await truncate("Job");
        await addJob({ title: "needs a look" }, { status: "review" });
        await addJob({ title: "still queued" });

        const output = await list({ status: "review" });
        assert(output.includes("needs a look"));
        assert(output.includes("· review"));
        assert(!output.includes("still queued"));
        assertEquals(blocks(output).length, 1);
      });

      await t.step('status "all" covers every status', async () => {
        await truncate("Job");
        await addJob({ title: "open job" });
        await addJob({ title: "applied job" }, { status: "applied" });
        await addJob({ title: "rejected job" }, { status: "rejected" });
        await addJob({ title: "dropped job" }, { status: "dropped" });
        await addJob({ title: "interview job" }, { status: "interview" });

        const output = await list({ status: "all" });
        for (
          const title of [
            "open job",
            "applied job",
            "rejected job",
            "dropped job",
            "interview job",
          ]
        ) {
          assert(output.includes(title), `${title} is missing`);
        }
        assertEquals(blocks(output).length, 5);
        assert(output.endsWith("5 jobs shown."));
      });

      await t.step("the limit is clamped, not trusted", async () => {
        await truncate("Job");
        await addJob({ title: "job a" }, { rank: "apply" });
        await addJob({ title: "job b" }, { rank: "apply" });

        assertEquals(blocks(await list({ limit: 1 })).length, 1);
        assertEquals(blocks(await list({ limit: 0 })).length, 1);
        assertEquals(blocks(await list({ limit: -5 })).length, 1);

        for (let i = 0; i < 31; i++) {
          await addJob({ title: `many ${i}` }, { rank: "maybe" });
        }
        const capped = await list({ limit: 99 });
        assertEquals(blocks(capped).length, 30);
        assert(capped.endsWith("30 jobs shown."));
      });

      await t.step("an empty queue says how jobs arrive", async () => {
        await truncate("Job");
        const output = await list();

        assert(output.includes("No jobs match that filter"));
        assert(output.includes("browser extension"));
        assertEquals(blocks(output).length, 0);
      });

      await t.step(
        "a job block carries id, rank, place, status and url",
        async () => {
          await truncate("Job");
          const job = await addJob({ title: "Junior Dev" }, {
            rank: "apply",
            reason: "strong TypeScript match",
          });

          const [block] = blocks(await list());
          assert(block.startsWith(`\`${shortId(job)}\` [apply] Junior Dev`));
          assert(block.includes("Acme"));
          assert(block.includes("(Geneva)"));
          assert(block.includes("· queued"));
          assert(block.includes("strong TypeScript match"));
          assert(block.includes("https://example.com/"));
          assert(!block.includes("DESCRIPTION-TEXT-SHOULD-NEVER-APPEAR"));
        },
      );

      await t.step("a missing rank and location are labelled", async () => {
        await truncate("Job");
        await addJob({ title: "No place", location: null });

        const [block] = blocks(await list());
        assert(block.includes("[unranked]"));
        assert(block.includes("(location not stated)"));
      });

      await t.step("the description never reaches the output", async () => {
        await truncate("Job");
        await addJob({ title: "Long posting" });

        const output = await list({ status: "all", include_skipped: true });
        assert(!output.includes("DESCRIPTION-TEXT-SHOULD-NEVER-APPEAR"));
      });

      await t.step(
        "mark_job resolves a short id, a prefix and an external id",
        async () => {
          await truncate("Job");
          const byShort = await addJob({ externalId: "short-one" });
          const byPrefix = await addJob({ externalId: "prefix-two" });
          const byExternal = await addJob({ externalId: "external-three" });

          assertEquals(
            await mark({ job: shortId(byShort), status: "applied" }),
            `Marked "${byShort.title}" at Acme as applied.`,
          );
          await mark({ job: byPrefix.id.slice(0, 6), status: "interview" });
          await mark({ job: "external-three", status: "rejected" });

          const statuses = await prisma.job.findMany({
            where: {
              id: {
                in: [byShort.id, byPrefix.id, byExternal.id],
              },
            },
            select: { id: true, status: true },
          });
          const byId = new Map(statuses.map((row) => [row.id, row.status]));
          assertEquals(byId.get(byShort.id), "applied");
          assertEquals(byId.get(byPrefix.id), "interview");
          assertEquals(byId.get(byExternal.id), "rejected");
        },
      );

      await t.step("a job goes back to the queue", async () => {
        await truncate("Job");
        const job = await addJob({}, { status: "dropped" });
        await mark({ job: shortId(job), status: "queued" });

        assert((await list({ status: "queued" })).includes(job.title));
      });

      await t.step("system-only and unknown statuses are refused", async () => {
        await truncate("Job");
        const job = await addJob();

        for (const status of ["preparing", "ready", "review", "bogus", ""]) {
          const result = await runTool(
            "mark_job",
            context,
            JSON.stringify({ job: shortId(job), status }),
          );
          assertEquals(result.status, "error");
          assert(
            result.status === "error" &&
              result.content.includes("Nothing changed"),
          );
          assert(
            result.status === "error" && result.content.includes("applied"),
          );
        }

        const preparing = await runTool(
          "mark_job",
          context,
          JSON.stringify({ job: shortId(job), status: "preparing" }),
        );
        assert(
          preparing.status === "error" &&
            preparing.content.includes("set by the system"),
        );

        const unchanged = await prisma.job.findUniqueOrThrow({
          where: { id: job.id },
        });
        assertEquals(unchanged.status, "queued");
      });

      await t.step("missing arguments are refused", async () => {
        await truncate("Job");
        const job = await addJob();

        const noStatus = await runTool(
          "mark_job",
          context,
          JSON.stringify({ job: shortId(job) }),
        );
        assertEquals(noStatus.status, "error");

        const noJob = await runTool(
          "mark_job",
          context,
          JSON.stringify({ status: "applied" }),
        );
        assertEquals(noJob.status, "error");
        assert(
          noJob.status === "error" && noJob.content.includes("Nothing changed"),
        );
      });

      await t.step(
        "an ambiguous or missing reference says so",
        async () => {
          await truncate("Job");
          const one = await addJob({ title: "first job" });
          const two = await addJob({ title: "second job" });
          await prisma.job.update({
            where: { id: one.id },
            data: { id: "abcdef11-1111-1111-1111-111111111111" },
          });
          await prisma.job.update({
            where: { id: two.id },
            data: { id: "abcdef22-2222-2222-2222-222222222222" },
          });

          const ambiguous = await runTool(
            "mark_job",
            context,
            JSON.stringify({ job: "abcdef", status: "applied" }),
          );
          assert(ambiguous.status === "error");
          assert(ambiguous.content.includes("Ambiguous job reference"));
          assert(ambiguous.content.includes("abcdef11"));
          assert(ambiguous.content.includes("abcdef22"));

          const missing = await runTool(
            "mark_job",
            context,
            JSON.stringify({ job: "zzzzzz", status: "applied" }),
          );
          assert(missing.status === "error");
          assert(missing.content.includes("No job found"));
        },
      );

      await t.step(
        "both tools run through runTool without approval",
        async () => {
          await truncate("Job");
          const job = await addJob({ title: "Runnable" });

          assertEquals(listTool.requireApproval, false);
          assertEquals(markTool.requireApproval, false);

          const listed = await runTool("list_jobs", context, '{"limit":1}');
          assertEquals(listed.status, "ok");
          assert(listed.status === "ok" && listed.content.includes("Runnable"));

          const marked = await runTool(
            "mark_job",
            context,
            JSON.stringify({ job: shortId(job), status: "applied" }),
          );
          assertEquals(marked.status, "ok");
          assertEquals(marked, {
            status: "ok",
            content: 'Marked "Runnable" at Acme as applied.',
          });
        },
      );

      await t.step("bad list arguments are refused", async () => {
        const result = await runTool(
          "list_jobs",
          context,
          '{"status":"finished"}',
        );
        assertEquals(result.status, "error");
        assert(
          result.status === "error" &&
            result.content.includes("Nothing listed"),
        );

        const badLimit = await runTool(
          "list_jobs",
          context,
          '{"limit":"many"}',
        );
        assertEquals(badLimit.status, "error");
      });

      await t.step("both tools are advertised to the model", () => {
        const requests = generateToolRequest();
        const names = requests.map((request) =>
          request.type === "function" ? request.function.name : ""
        );
        assert(names.includes("list_jobs"));
        assert(names.includes("mark_job"));

        const markRequest = requests.find((request) =>
          request.type === "function" && request.function.name === "mark_job"
        ) as
          | {
            function: {
              name: string;
              parameters: { required?: string[]; properties: unknown };
            };
          }
          | undefined;

        assertEquals(markRequest?.function.name, "mark_job");
        assertEquals(markRequest?.function.parameters.required, [
          "job",
          "status",
        ]);
      });
    } finally {
      await closeDb();
    }
  },
});
