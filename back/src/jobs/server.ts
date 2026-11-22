// The local HTTP API the browser extension posts job postings to. Kept free of
// sockets so the request handling can be tested without one; `startJobServer`
// is the thin layer that binds it and wires the processing queue.
import * as z from "zod";
import type { Job } from "@/generated/prisma/client.ts";
import { processJob } from "@/jobs/process.ts";
import { loadJobsToken } from "@/jobs/token.ts";
import type { JobInput } from "@/jobs/store.ts";
import { saveJob } from "@/jobs/store.ts";
import { JOB_INBOX_FOLDER } from "@/jobs/inbox.ts";
import { clip, shortJobId } from "@/jobs/log.ts";
import { logger } from "@/utils/logger.ts";

/** 200 KB: a full posting with its description, with room to spare. */
export const MAX_BODY_BYTES = 200_000;

const ID_PATTERN = /^[\w.-]{1,64}$/;

// Control characters are noise in every field; in a description the line breaks
// and tabs still carry the formatting.
// deno-lint-ignore no-control-regex -- stripping control characters is the point
const CONTROL_ALL = /[\x00-\x1f\x7f]/g;
// deno-lint-ignore no-control-regex -- same, but keeping \n and \t
const CONTROL_LAYOUT = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export type SaveJob = (input: JobInput) => Promise<{
  job: Job;
  duplicate: boolean;
}>;

export type JobServerDeps = {
  /** The bearer token `deno task jobs:token` created. */
  token: string;
  save: SaveJob;
  /** Queues a job and returns how many are now waiting, this one included. */
  enqueue: (jobId: string) => number;
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function badRequest(error: string): Response {
  logger.warn(`jobs: rejected 400 ${error}`);
  return json({ error }, 400);
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

/**
 * Compares the header against the token in constant time. Both sides are
 * hashed first so the comparison never depends on the token's length either.
 */
async function authorized(
  header: string | null,
  token: string,
): Promise<boolean> {
  if (!header) return false;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme.toLowerCase() !== "bearer") return false;
  const given = rest.join(" ");
  if (!given) return false;

  const [a, b] = await Promise.all([digest(given), digest(token)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function stripControls(value: string, keepLayout: boolean): string {
  return value.replace(keepLayout ? CONTROL_LAYOUT : CONTROL_ALL, "");
}

/**
 * Removes control characters (and stray padding, except in the description)
 * before validation, so a zero-width click from the extension cannot sneak a
 * NUL into a title.
 */
function clean(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const input = { ...(raw as Record<string, unknown>) };

  for (
    const key of [
      "source",
      "externalId",
      "url",
      "title",
      "company",
      "location",
      "description",
    ] as const
  ) {
    const value = input[key];
    if (typeof value !== "string") continue;
    input[key] = key === "description"
      ? stripControls(value, true)
      : stripControls(value, false).trim();
  }

  return input;
}

const schema = z.object({
  source: z.string({ error: "is required" }).min(1, "is required").max(
    40,
    "must be 40 characters or fewer",
  ),
  externalId: z.string({ error: "is required" }).regex(
    ID_PATTERN,
    "must be 1-64 characters: letters, digits, dots, dashes or underscores",
  ),
  url: z.string({ error: "is required" }).max(
    2000,
    "must be 2000 characters or fewer",
  ).refine(
    (value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    },
    "must be an https URL",
  ),
  title: z.string({ error: "is required" }).min(1, "is required").max(
    300,
    "must be 300 characters or fewer",
  ),
  company: z.string({ error: "is required" }).min(1, "is required").max(
    300,
    "must be 300 characters or fewer",
  ),
  location: z.string().max(300, "must be 300 characters or fewer").nullish(),
  description: z.string({ error: "is required" }).min(1, "is required").max(
    50_000,
    "must be 50 000 characters or fewer",
  ),
  postedAt: z.union([z.iso.datetime({ offset: true }), z.iso.date()], {
    error: "must be an ISO date",
  }).nullish(),
});

type ParsedJob = z.infer<typeof schema>;

/** Zod's first complaint, named by the field it is about. */
function validationError(error: z.ZodError): Response {
  const issue = error.issues[0];
  const field = issue?.path.join(".") || "body";
  return badRequest(`${field}: ${issue?.message ?? "is invalid"}`);
}

function toInput(data: ParsedJob): JobInput {
  return {
    source: data.source,
    externalId: data.externalId,
    url: data.url,
    title: data.title,
    company: data.company,
    location: data.location ?? null,
    description: data.description,
    postedAt: data.postedAt ? new Date(data.postedAt) : null,
  };
}

/**
 * Whether a second pass could still do something: an unranked job, an apply
 * job that was never pinged, or any job but a skip without an inbox file.
 */
export function needsProcessing(
  job: Pick<Job, "rank" | "notifiedAt" | "inboxWrittenAt">,
): boolean {
  if (job.rank === null) return true;
  if (job.rank === "apply" && job.notifiedAt === null) return true;
  return job.rank !== "skip" && job.inboxWrittenAt === null;
}

/**
 * Handles one request. The response is sent as soon as the row is stored; the
 * ranking and the Discord ping happen in the queue behind it.
 */
export async function handleJobRequest(
  req: Request,
  deps: JobServerDeps,
): Promise<Response> {
  try {
    const { pathname } = new URL(req.url);

    if (pathname === "/health" || pathname === "/health/") {
      if (req.method !== "GET") return text("method not allowed", 405);
      return text("ok", 200);
    }

    if (pathname !== "/jobs" && pathname !== "/jobs/") {
      return json({ error: "not found" }, 404);
    }
    if (req.method !== "POST") return json({ error: "use POST" }, 405);

    if (!(await authorized(req.headers.get("authorization"), deps.token))) {
      logger.warn("jobs: rejected 401 (bad or missing token)");
      return json({ error: "unauthorized" }, 401);
    }

    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      logger.warn("jobs: rejected 413");
      return json({ error: "body too large" }, 413);
    }

    const body = await req.text();
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      logger.warn("jobs: rejected 413");
      return json({ error: "body too large" }, 413);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return badRequest("body: must be JSON");
    }

    const parsed = schema.safeParse(clean(raw));
    if (!parsed.success) return validationError(parsed.error);

    const { job, duplicate } = await deps.save(toInput(parsed.data));
    const id = shortJobId(job.id);

    if (duplicate) {
      logger.info(
        `jobs: duplicate ${id} (rank=${job.rank ?? "none"}, pinged=${
          job.notifiedAt !== null
        }, inbox=${job.inboxWrittenAt !== null})`,
      );
      // A re-click retries whatever the earlier run could not finish
      if (needsProcessing(job)) {
        const depth = deps.enqueue(job.id);
        logger.debug(`jobs: queued ${id} (queue depth ${depth})`);
      }
      return json({ id: job.id, duplicate: true }, 200);
    }

    logger.info(`jobs: received ${id} "${clip(job.title)}" at ${job.company}`);
    const depth = deps.enqueue(job.id);
    logger.debug(`jobs: queued ${id} (queue depth ${depth})`);
    return json({ id: job.id, duplicate: false }, 201);
  } catch (err) {
    // A stack trace in the response would only amuse the wrong people
    logger.error(`jobs: request failed: ${err}`);
    return json({ error: "internal error" }, 500);
  }
}

/** One job at a time, in arrival order; a failure is logged, never thrown. */
function serialQueue(
  run: (jobId: string) => Promise<void>,
): (jobId: string) => number {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return (jobId) => {
    pending += 1;
    tail = tail.then(() => run(jobId)).catch((err) => {
      logger.error(`jobs: queue ${shortJobId(jobId)} failed: ${err}`);
    }).finally(() => {
      pending -= 1;
    });
    return pending;
  };
}

export type JobServerOptions = {
  notify: (text: string) => Promise<void>;
};

/**
 * Binds the API and returns the server, or null when it cannot run (no token
 * yet, port taken). The Discord bot must survive either way.
 */
export async function startJobServer(
  opts: JobServerOptions,
): Promise<Deno.HttpServer | null> {
  const token = await loadJobsToken();
  if (!token) {
    logger.warn(
      "jobs: no token found, the extension cannot post jobs. " +
        "Run: deno task jobs:token",
    );
    return null;
  }
  logger.info("jobs: token found, the extension can post jobs");

  const hostname = Deno.env.get("JOBS_HOST") ?? "127.0.0.1";
  const port = Deno.env.get("JOBS_PORT")
    ? Number(Deno.env.get("JOBS_PORT"))
    : 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    logger.error(`jobs: JOBS_PORT is not a port number; the jobs API is off`);
    return null;
  }

  const enqueue = serialQueue(async (jobId) => {
    await processJob(jobId, { notify: opts.notify });
  });

  try {
    const server = Deno.serve({
      hostname,
      port,
      onListen: ({ hostname, port }) => {
        logger.info(`jobs: listening on http://${hostname}:${port}`);
        logger.info(`jobs: inbox folder ${JOB_INBOX_FOLDER}`);
      },
    }, (req) => handleJobRequest(req, { token, save: saveJob, enqueue }));

    // A listen failure (port taken) resolves through the server, not a throw
    server.finished.catch((err) => {
      logger.error(`jobs: api stopped: ${err}`);
    });
    return server;
  } catch (err) {
    logger.error(`jobs: could not listen on ${hostname}:${port}: ${err}`);
    return null;
  }
}
