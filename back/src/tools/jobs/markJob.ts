import type { Tool, ToolContext } from "@/tools/tool.ts";
import type { JobStatus } from "@/generated/prisma/client.ts";
import { markJob } from "@/jobs/store.ts";

const MARKABLE: JobStatus[] = [
  "applied",
  "interview",
  "rejected",
  "dropped",
  "queued",
];

const ALLOWED = MARKABLE.join(", ");

export function parseMarkStatus(value: unknown): JobStatus {
  if (typeof value === "string") {
    const status = value.trim().toLowerCase();
    if ((MARKABLE as string[]).includes(status)) return status as JobStatus;
    if (status === "preparing" || status === "ready" || status === "review") {
      throw new Error(
        `Nothing changed: "${status}" is set by the system, not by hand. Use one of ${ALLOWED}.`,
      );
    }
  }

  throw new Error(
    `Nothing changed: status must be one of ${ALLOWED}. Got "${
      String(value)
    }".`,
  );
}

export function parseJobRef(value: unknown): string {
  const ref = typeof value === "string" ? value.trim() : "";
  if (!ref) {
    throw new Error(
      "Nothing changed: job must be the short id from list_jobs, an id prefix of at least 6 characters, or the site's job id. Call list_jobs first.",
    );
  }
  return ref;
}

export class MarkJobTool implements Tool {
  name = "mark_job";
  description =
    'Record what happened to a job the owner queued. Only call it when the owner EXPLICITLY says what happened: they applied, they got an interview, they were rejected, they are not interested and want it dropped, or they want it put back in the queue. Never infer a status from mail, a notification or a guess; ask when unsure. "preparing", "ready" and "review" belong to the system and cannot be set here.';
  arguments = { job: "string", status: "string" };
  argumentDescriptions = {
    job:
      'The short id from list_jobs (e.g. "3f9a1c2b"), a longer id prefix of at least 6 characters, or the site\'s own job id.',
    status:
      '"applied", "interview", "rejected", "dropped" (not interested), or "queued" (back in the queue).',
  };
  requiredArguments = ["job", "status"];
  requireApproval = false;

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const status = parseMarkStatus(args.status);
    const ref = parseJobRef(args.job);

    const job = await markJob(ref, status);
    return `Marked "${job.title}" at ${job.company} as ${job.status}.`;
  }
}
