import type { Tool, ToolContext } from "@/tools/tool.ts";
import { prepareJob } from "@/jobs/prep.ts";
import { parseJobRef } from "@/tools/jobs/markJob.ts";

/**
 * Re-runs document preparation for one job when the owner explicitly asks. It
 * skips the daily cap and the attempts limit (force), but not PREP_ENABLED.
 */
export class PrepareJobTool implements Tool {
  name = "prepare_job";
  description =
    "Re-run document preparation (CV, cover letter, notes) for one job now, even when the daily cap is reached. Only call it when the owner explicitly asks to prepare or re-prepare a specific job; the queue does this automatically for jobs worth applying to.";
  arguments = { job: "string" };
  argumentDescriptions = {
    job:
      'The short id from list_jobs (e.g. "3f9a1c2b"), a longer id prefix of at least 6 characters, or the site\'s own job id.',
  };
  requiredArguments = ["job"];
  requireApproval = false;

  constructor(private readonly deps: { prepare?: typeof prepareJob } = {}) {}

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    const ref = parseJobRef(args.job);
    const prepare = this.deps.prepare ?? prepareJob;
    const outcome = await prepare(ref, { force: true });

    if (!outcome.prepared) {
      throw new Error(
        `Preparation failed for "${outcome.job.title}" at ${outcome.job.company}: ${
          outcome.reason ?? "unknown reason"
        }. The job is back in the queue.`,
      );
    }

    return `Prepared "${outcome.job.title}" at ${outcome.job.company} (${outcome.job.status}). Documents are in ${outcome.folder}.`;
  }
}
