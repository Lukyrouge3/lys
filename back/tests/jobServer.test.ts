import { assert, assertEquals } from "@std/assert";
import type { Job } from "@/generated/prisma/client.ts";
import {
  handleJobRequest,
  type JobServerDeps,
  MAX_BODY_BYTES,
  needsProcessing,
  type SaveJob,
} from "@/jobs/server.ts";
import type { JobInput } from "@/jobs/store.ts";

const TOKEN = "test-token-0123456789abcdef";

function fakeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    source: "linkedin",
    externalId: "ext-1",
    url: "https://example.com/1",
    title: "Junior Developer",
    company: "Acme",
    location: "Geneva",
    description: "Build small things.",
    postedAt: null,
    rank: null,
    rankReason: null,
    status: "queued",
    notifiedAt: null,
    inboxWrittenAt: null,
    prepFolder: null,
    preparedAt: null,
    prepAttempts: 0,
    prepNote: null,
    createdAt: new Date("2026-11-01T10:00:00Z"),
    updatedAt: new Date("2026-11-01T10:00:00Z"),
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    source: "linkedin",
    externalId: "ext-1",
    url: "https://example.com/jobs/1",
    title: "Junior Developer",
    company: "Acme",
    location: "Geneva",
    description: "TypeScript and SvelteKit.",
    ...overrides,
  };
}

type Setup = {
  deps: JobServerDeps;
  enqueued: string[];
  saved: JobInput[];
};

function setup(
  save: SaveJob = () => Promise.resolve({ job: fakeJob(), duplicate: false }),
): Setup {
  const enqueued: string[] = [];
  const saved: JobInput[] = [];
  const recording: SaveJob = async (input) => {
    saved.push(input);
    return await save(input);
  };
  return {
    deps: { token: TOKEN, save: recording, enqueue: (id) => enqueued.push(id) },
    enqueued,
    saved,
  };
}

function post(
  body: unknown,
  init: { token?: string | null; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token !== null) {
    headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  }
  return new Request("http://localhost/jobs", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function error(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

Deno.test("health answers without a token", async () => {
  const { deps } = setup();
  const response = await handleJobRequest(
    new Request("http://localhost/health"),
    deps,
  );

  assertEquals(response.status, 200);
  assertEquals(await response.text(), "ok");
});

Deno.test("health refuses other methods", async () => {
  const { deps } = setup();
  const response = await handleJobRequest(
    new Request("http://localhost/health", { method: "POST" }),
    deps,
  );

  assertEquals(response.status, 405);
});

Deno.test("a missing token is unauthorized", async () => {
  const { deps, saved } = setup();
  const response = await handleJobRequest(
    post(payload(), { token: null }),
    deps,
  );

  assertEquals(response.status, 401);
  assertEquals(await error(response), "unauthorized");
  assertEquals(saved.length, 0);
});

Deno.test("a wrong token is unauthorized", async () => {
  const { deps, saved } = setup();
  const response = await handleJobRequest(
    post(payload(), { token: "the-wrong-token" }),
    deps,
  );

  assertEquals(response.status, 401);
  assertEquals(saved.length, 0);
});

Deno.test("a different scheme or an empty token is unauthorized", async () => {
  const { deps } = setup();

  const basic = await handleJobRequest(
    post(payload(), { token: null, headers: { authorization: "Basic abc" } }),
    deps,
  );
  assertEquals(basic.status, 401);

  const empty = await handleJobRequest(
    post(payload(), { token: null, headers: { authorization: "Bearer" } }),
    deps,
  );
  assertEquals(empty.status, 401);
});

Deno.test("a body that is not JSON is a bad request", async () => {
  const { deps, saved } = setup();
  const response = await handleJobRequest(post("{not json"), deps);

  assertEquals(response.status, 400);
  assertEquals(await error(response), "body: must be JSON");
  assertEquals(saved.length, 0);
});

Deno.test("a missing field is named in the error", async () => {
  const { deps, saved } = setup();
  const body = payload();
  delete (body as Record<string, unknown>).title;

  const response = await handleJobRequest(post(body), deps);
  assertEquals(response.status, 400);
  assert((await error(response)).startsWith("title:"));
  assertEquals(saved.length, 0);
});

Deno.test("a non-https url is refused", async () => {
  const { deps } = setup();
  const response = await handleJobRequest(
    post(payload({ url: "http://example.com/jobs/1" })),
    deps,
  );

  assertEquals(response.status, 400);
  assertEquals(await error(response), "url: must be an https URL");
});

Deno.test("an external id outside the allowed characters is refused", async () => {
  const { deps } = setup();
  const response = await handleJobRequest(
    post(payload({ externalId: "job 1/../etc" })),
    deps,
  );

  assertEquals(response.status, 400);
  assert((await error(response)).startsWith("externalId:"));
});

Deno.test("a postedAt that is not an ISO date is refused", async () => {
  const { deps } = setup();
  const response = await handleJobRequest(
    post(payload({ postedAt: "next tuesday" })),
    deps,
  );

  assertEquals(response.status, 400);
  assert((await error(response)).startsWith("postedAt:"));
});

Deno.test("a declared oversized body is refused before it is read", async () => {
  const { deps, saved } = setup();
  const response = await handleJobRequest(
    post(payload(), {
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    }),
    deps,
  );

  assertEquals(response.status, 413);
  assertEquals(saved.length, 0);
});

Deno.test("an oversized body is refused even without a length header", async () => {
  const { deps, saved } = setup();
  const response = await handleJobRequest(
    post(payload({ description: "x".repeat(MAX_BODY_BYTES + 1) })),
    deps,
  );

  assertEquals(response.status, 413);
  assertEquals(saved.length, 0);
});

Deno.test("a new job answers 201 at once and is queued once", async () => {
  const { deps, enqueued } = setup(() =>
    Promise.resolve({ job: fakeJob({ id: "new-1" }), duplicate: false })
  );

  const response = await handleJobRequest(post(payload()), deps);

  assertEquals(response.status, 201);
  assertEquals(await response.json(), { id: "new-1", duplicate: false });
  assertEquals(enqueued, ["new-1"]);
});

const done = {
  notifiedAt: new Date("2026-11-01T10:00:00Z"),
  inboxWrittenAt: new Date("2026-11-01T10:00:00Z"),
};

Deno.test("a fully processed duplicate is not processed again", async () => {
  const cases = [
    fakeJob({ id: "old-apply", rank: "apply", ...done }),
    fakeJob({
      id: "old-maybe",
      rank: "maybe",
      inboxWrittenAt: done.inboxWrittenAt,
    }),
    fakeJob({ id: "old-skip", rank: "skip" }),
  ];

  for (const job of cases) {
    const { deps, enqueued } = setup(() =>
      Promise.resolve({ job, duplicate: true })
    );
    const response = await handleJobRequest(post(payload()), deps);

    assertEquals(response.status, 200);
    assertEquals(await response.json(), { id: job.id, duplicate: true });
    assertEquals(enqueued, []);
  }
});

Deno.test("a duplicate whose ranking failed is retried", async () => {
  const { deps, enqueued } = setup(() =>
    Promise.resolve({
      job: fakeJob({ id: "old-2", rank: null }),
      duplicate: true,
    })
  );

  const response = await handleJobRequest(post(payload()), deps);

  assertEquals(response.status, 200);
  assertEquals(enqueued, ["old-2"]);
});

Deno.test("a duplicate that was never pinged is retried", async () => {
  const { deps, enqueued } = setup(() =>
    Promise.resolve({
      job: fakeJob({ id: "old-3", rank: "apply", ...done, notifiedAt: null }),
      duplicate: true,
    })
  );

  await handleJobRequest(post(payload()), deps);

  assertEquals(enqueued, ["old-3"]);
});

Deno.test("a duplicate with no inbox file is retried", async () => {
  const { deps, enqueued } = setup(() =>
    Promise.resolve({
      job: fakeJob({ id: "old-4", rank: "maybe", inboxWrittenAt: null }),
      duplicate: true,
    })
  );

  await handleJobRequest(post(payload()), deps);

  assertEquals(enqueued, ["old-4"]);
});

Deno.test("needsProcessing reads the three fields", () => {
  assertEquals(needsProcessing(fakeJob({ rank: null })), true);
  assertEquals(
    needsProcessing(fakeJob({ rank: "apply", ...done, notifiedAt: null })),
    true,
  );
  assertEquals(
    needsProcessing(fakeJob({ rank: "maybe", ...done, inboxWrittenAt: null })),
    true,
  );
  // A skip is never written, so it is done once it is ranked
  assertEquals(needsProcessing(fakeJob({ rank: "skip" })), false);
  assertEquals(needsProcessing(fakeJob({ rank: "apply", ...done })), false);
  assertEquals(
    needsProcessing(
      fakeJob({ rank: "maybe", inboxWrittenAt: done.inboxWrittenAt }),
    ),
    false,
  );
});

Deno.test("the stored job keeps the optional fields optional", async () => {
  const { deps, saved } = setup();
  const body = payload({ location: null, postedAt: "2026-11-01T10:00:00Z" });

  const response = await handleJobRequest(post(body), deps);

  assertEquals(response.status, 201);
  assertEquals(saved[0].location, null);
  assertEquals(saved[0].postedAt?.toISOString(), "2026-11-01T10:00:00.000Z");
});

Deno.test("omitted optional fields are stored as null", async () => {
  const { deps, saved } = setup();
  const body = payload();
  delete (body as Record<string, unknown>).location;

  const response = await handleJobRequest(post(body), deps);

  assertEquals(response.status, 201);
  assertEquals(saved[0].location, null);
  assertEquals(saved[0].postedAt, null);
});

Deno.test("control characters are stripped from every string", async () => {
  const { deps, saved } = setup();
  const body = payload({
    title: "Junior\u0000 Developer\u0007",
    company: "Ac\u0001me",
    location: "Gene\u0008va",
    description: "Line one\u0000\r\n\tLine two",
  });

  const response = await handleJobRequest(post(body), deps);

  assertEquals(response.status, 201);
  assertEquals(saved[0].title, "Junior Developer");
  assertEquals(saved[0].company, "Acme");
  assertEquals(saved[0].location, "Geneva");
  // Line breaks and tabs in the description are formatting, not noise
  assertEquals(saved[0].description, "Line one\r\n\tLine two");
});

Deno.test("an unknown path is not found", async () => {
  const { deps } = setup();
  const response = await handleJobRequest(
    new Request("http://localhost/nope"),
    deps,
  );

  assertEquals(response.status, 404);
  assertEquals(await error(response), "not found");
});

Deno.test("the right path with the wrong method says so", async () => {
  const { deps } = setup();
  const response = await handleJobRequest(
    new Request("http://localhost/jobs"),
    deps,
  );

  assertEquals(response.status, 405);
  assertEquals(await error(response), "use POST");
});

Deno.test("a store failure is a generic 500, never a stack trace", async () => {
  const { deps } = setup(() =>
    Promise.reject(new Error("database is on fire"))
  );

  const response = await handleJobRequest(post(payload()), deps);

  assertEquals(response.status, 500);
  assertEquals(await error(response), "internal error");
});
