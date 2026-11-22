import prisma from "@/db.ts";
import type { Job, JobRank } from "@/generated/prisma/client.ts";
import { askAgent } from "@/mail/classify.ts";
import { logger } from "@/utils/logger.ts";
import { JOB_PROFILE } from "@/jobs/profile.ts";
import { setRank } from "@/jobs/store.ts";

type ChatRequest = {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  max_tokens: number;
  temperature: number;
};

const SYSTEM_PROMPT = `You rank one job posting for one candidate.

Answer with exactly two lines and nothing else:

rank: apply|maybe|skip
reason: <one short sentence, max 140 characters>

- apply: the posting fits the candidate well, or asks for experience they can plausibly show; they should apply.
- maybe: it could work, but something is off: a stretch requirement, an unclear stack, an uncertain fit.
- skip: it is not the kind of job they want, or it clearly asks for far more experience than they have.

Judge by what the posting asks for, not by its title alone. A stated "3+ years" is usually soft and only lowers the rank; "5+ years", or a senior/lead/staff title with no sign that juniors are welcome, is skip.`;

const MAX_DESCRIPTION_CHARS = 4000;
const MAX_REASON_CHARS = 140;
const MAX_LOGGED_ANSWER_CHARS = 80;

export function rankRequest(
  model: string,
  job: Pick<Job, "title" | "company" | "location" | "description">,
  profile = JOB_PROFILE,
): ChatRequest {
  const description = job.description.length > MAX_DESCRIPTION_CHARS
    ? job.description.slice(0, MAX_DESCRIPTION_CHARS) + "…"
    : job.description;

  return {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          "Candidate profile:",
          profile,
          "",
          "Job posting:",
          `Title: ${job.title}`,
          `Company: ${job.company}`,
          `Location: ${job.location ?? "unknown"}`,
          "",
          description || "(no description)",
        ].join("\n"),
      },
    ],
    // A reasoning model spends tokens thinking before it answers, and ranking
    // needs more of that than the mail classifier: 512 was still all spent on
    // thinking for a real posting, which came back with an empty answer. The
    // answer itself is two short lines, so the extra budget costs nothing on
    // the calls where the model answers quickly.
    max_tokens: 2048,
    temperature: 0,
  };
}

const RANK_LINE = /^rank:/i;
const REASON_LINE = /^reason:/i;

/**
 * Reads the two-line answer strictly: only the `rank:` line's value counts, so
 * a reason like "not skip" or an explanation mentioning another rank cannot win.
 */
export function parseRank(
  answer: string,
): { rank: JobRank; reason: string } | null {
  const lines = answer.split("\n").map((line) => line.trim());

  const rankLine = lines.find((line) => RANK_LINE.test(line));
  if (!rankLine) return null;

  const value = rankLine.replace(RANK_LINE, "").trim().toLowerCase();
  if (value !== "apply" && value !== "maybe" && value !== "skip") return null;

  const reasonLine = lines.find((line) => REASON_LINE.test(line));
  const reason = reasonLine
    ? reasonLine.replace(REASON_LINE, "").trim().slice(0, MAX_REASON_CHARS)
    : "";

  return { rank: value, reason };
}

/** Fail-soft: a broken ranker leaves the job unranked instead of dropping it. */
export async function rankJob(
  job: Pick<Job, "title" | "company" | "location" | "description">,
): Promise<{ rank: JobRank; reason: string } | null> {
  const started = performance.now();
  try {
    const result = await askAgent(
      "job:rank",
      (model) => rankRequest(model, job),
      (answer) => {
        const parsed = parseRank(answer);
        if (!parsed) {
          logger.warn(
            `job:rank gave an unusable answer for "${job.title}": ${
              JSON.stringify(answer.slice(0, MAX_LOGGED_ANSWER_CHARS))
            }`,
          );
        }
        return parsed;
      },
      Deno.env.get("JOB_RANKER_AGENT") ?? "lys",
    );
    // askAgent hands back only the parsed answer, so the token counts stay in
    // the llmCall row; the round trip is what tells a slow ranker from a fast one
    logger.info(
      `jobs: rank call ${Math.round(performance.now() - started)} ms`,
    );
    return result;
  } catch (err) {
    logger.warn(`job:rank failed: ${err}`);
    return null;
  }
}

export async function rankAndStore(jobId: string): Promise<Job> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job ${jobId} not found`);

  const result = await rankJob(job);
  if (!result) return job;

  return await setRank(job.id, result.rank, result.reason);
}
