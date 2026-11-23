import type { Job } from "@/generated/prisma/client.ts";
import prisma from "@/db.ts";
import {
  APPLICATION_PDF,
  attachmentsFolder,
  bundleApplication,
  type BundleResult,
} from "@/prep/bundle.ts";
import { resolveJobRef, shortId } from "@/jobs/store.ts";
import type { Tool, ToolContext } from "@/tools/tool.ts";

type BundleToolDeps = {
  /** Injected in tests; the real resolver otherwise. */
  resolve?: (ref: string) => Promise<Job>;
  /** Injected in tests; every ready/review job with a folder otherwise. */
  list?: () => Promise<Job[]>;
  /** Injected in tests; the real bundle otherwise. */
  bundle?: (folder: string) => Promise<BundleResult>;
};

/** Prepared jobs whose application.pdf the owner may want rebuilt. */
function preparedJobs(): Promise<Job[]> {
  return prisma.job.findMany({
    where: {
      status: { in: ["ready", "review"] },
      prepFolder: { not: null },
    },
    orderBy: { preparedAt: "desc" },
  });
}

export class BundleApplicationTool implements Tool {
  name = "bundle_application";
  description =
    `Rebuild a prepared application's ${APPLICATION_PDF}: the CV first, then the cover letter, then the owner's own PDFs (diplomas, references, certificates) from ${attachmentsFolder()}, merged in file-name order. Call it after the owner uploads attachments (env PREP_ATTACHMENTS_FOLDER changes the folder), or when they ask for the bundle again. With no job it rebuilds every ready or review job that has a folder; with a job it rebuilds that one. No approval needed.`;
  arguments = { job: "string" };
  argumentDescriptions = {
    job:
      'Optional. The short id from list_jobs (e.g. "3f9a1c2b"), a longer id prefix of at least 6 characters, or the site\'s own job id. Omit to rebuild every prepared application.',
  };
  requiredArguments = [];
  requireApproval = false;

  constructor(private readonly deps: BundleToolDeps = {}) {}

  async run(
    _context: ToolContext,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (args.job !== undefined && typeof args.job !== "string") {
      throw new Error(
        "Nothing bundled: job must be the short id from list_jobs, an id prefix of at least 6 characters, or the site's job id.",
      );
    }
    const ref = typeof args.job === "string" ? args.job.trim() : "";

    const jobs = ref
      ? [await (this.deps.resolve ?? resolveJobRef)(ref)]
      : await (this.deps.list ?? preparedJobs)();

    if (jobs.length === 0) {
      return `Nothing to bundle: no job with a prepared folder has status ready or review yet. Run prepare_job first, or wait for the queue.`;
    }

    const bundle = this.deps.bundle ??
      ((folder: string) => bundleApplication(folder));
    const lines: string[] = [];
    for (const job of jobs) {
      if (!job.prepFolder) {
        throw new Error(
          `Job "${job.title}" at ${job.company} has no prepared folder to bundle yet.`,
        );
      }
      try {
        lines.push(formatJobLine(job, await bundle(job.prepFolder)));
      } catch (error) {
        lines.push(
          `${shortId(job)} ${job.company}: could not bundle: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return lines.join("\n");
  }
}

function formatJobLine(job: Job, result: BundleResult): string {
  const attachments = result.parts.slice(2);
  const skippedNames = new Set(result.skipped.map((entry) => entry.name));
  const merged = attachments.filter((name) => !skippedNames.has(name)).length;
  const details = merged > 0
    ? `CV, cover letter, +${merged} attachment${merged === 1 ? "" : "s"}`
    : "CV, cover letter";
  const lines = [
    `${shortId(job)} ${job.company}: ${APPLICATION_PDF}, ${result.pages} page${
      result.pages === 1 ? "" : "s"
    } (${details})`,
  ];

  if (result.parts.length <= 2) {
    lines.push(
      `  no attachments found in ${attachmentsFolder()}; the bundle is CV + cover letter only`,
    );
  }
  for (const entry of result.skipped) {
    lines.push(`  skipped ${entry.name}: ${entry.reason}`);
  }
  return lines.join("\n");
}
