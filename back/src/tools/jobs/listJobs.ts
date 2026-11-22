import type { Tool, ToolContext } from "@/tools/tool.ts";
import type { Job, JobStatus } from "@/generated/prisma/client.ts";
import { listJobs, shortId } from "@/jobs/store.ts";

const STATUSES: JobStatus[] = [
  "queued",
  "preparing",
  "ready",
  "review",
  "applied",
  "interview",
  "rejected",
  "dropped",
];

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 30;

/** Undefined means the store's default open statuses; "all" means every one. */
export function parseStatuses(value: unknown): JobStatus[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(
      `Nothing listed: status must be one of ${STATUSES.join(", ")}, or all.`,
    );
  }

  const status = value.trim().toLowerCase();
  if (status === "all") return [...STATUSES];
  if ((STATUSES as string[]).includes(status)) return [status as JobStatus];

  throw new Error(
    `Nothing listed: status must be one of ${
      STATUSES.join(", ")
    }, or all. Got "${value}".`,
  );
}

export function parseIncludeSkipped(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;

  throw new Error(
    `Nothing listed: include_skipped must be true or false, got "${
      String(value)
    }".`,
  );
}

/** Clamped to 1..30 rather than rejected, so a bad number still shows work. */
export function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_LIMIT;
  }

  const limit = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(limit)) {
    throw new Error(
      `Nothing listed: limit must be a number, got "${String(value)}".`,
    );
  }

  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function formatJob(job: Job): string {
  const lines = [
    `\`${shortId(job)}\` [${
      job.rank ?? "unranked"
    }] ${job.title} — ${job.company} (${
      job.location || "location not stated"
    }) · ${job.status}`,
  ];
  if (job.rankReason) lines.push(`  ${job.rankReason}`);
  lines.push(job.url);
  return lines.join("\n");
}

export class ListJobsTool implements Tool {
  name = "list_jobs";
  description =
    "List the job postings the owner queued by sending them from their browser. Best first: ranked apply, then maybe, then unranked, then skip. Each job shows a short id to pass to mark_job, its rank, title, company, location and status, plus the rank reason and the link. Descriptions are left out to save room; open the link to read one. By default it shows only the open statuses and hides jobs ranked skip.";
  arguments = {
    status: "string",
    include_skipped: "boolean",
    limit: "number",
  };
  argumentDescriptions = {
    status:
      '"queued", "preparing", "ready", "review", "applied", "interview", "rejected", "dropped", or "all". Default: the open statuses (queued, preparing, ready, review).',
    include_skipped: "true also lists jobs ranked skip. Default false.",
    limit: `How many jobs to show, 1-30. Default ${DEFAULT_LIMIT}.`,
  };
  requiredArguments = [];
  requireApproval = false;

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const jobs = await listJobs({
      statuses: parseStatuses(args.status),
      includeSkip: parseIncludeSkipped(args.include_skipped),
      limit: parseLimit(args.limit),
    });

    if (jobs.length === 0) {
      return "No jobs match that filter; the owner adds jobs by sending postings from their browser extension.";
    }

    const blocks = jobs.map(formatJob);
    blocks.push(
      `${jobs.length} job${jobs.length === 1 ? "" : "s"} shown.`,
    );
    return blocks.join("\n\n");
  }
}
