import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { Job } from "@/generated/prisma/client.ts";
import { BundleApplicationTool } from "@/tools/jobs/bundleApplication.ts";
import type { BundleResult } from "@/prep/bundle.ts";
import { DEFAULT_ATTACHMENTS_FOLDER } from "@/prep/bundle.ts";
import { generateToolRequest, type ToolContext } from "@/tools/tool.ts";

const NOW = new Date("2026-11-09T15:30:00Z");

const context: ToolContext = {
  conversationId: "test",
  approval: "pending",
  emit: () => {},
};

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "abcdef12-1111-1111-1111-111111111111",
    source: "linkedin",
    externalId: "ext-1",
    url: "https://example.test/1",
    title: "Product Engineer",
    company: "Acme",
    location: "Geneva",
    description: "Build.",
    postedAt: null,
    rank: "apply",
    rankReason: null,
    status: "ready",
    notifiedAt: null,
    inboxWrittenAt: null,
    prepFolder: "Postulations/acme/2026-11-09",
    preparedAt: NOW,
    prepAttempts: 1,
    prepNote: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function bundleResult(overrides: Partial<BundleResult> = {}): BundleResult {
  return {
    path: "Postulations/acme/2026-11-09/application.pdf",
    parts: ["cv-en.pdf", "cover-en.pdf"],
    skipped: [],
    pages: 2,
    ...overrides,
  };
}

Deno.test("bundle tool: one job names the file, pages and attachments", async () => {
  const target = job();
  const seen: string[] = [];
  const tool = new BundleApplicationTool({
    resolve: () => Promise.resolve(target),
    bundle: (folder) => {
      seen.push(folder);
      return Promise.resolve(bundleResult({
        parts: ["cv-en.pdf", "cover-en.pdf", "diploma.pdf", "ref.pdf"],
        pages: 5,
      }));
    },
  });

  const output = await tool.run(context, { job: "abcdef" });

  assertEquals(seen, ["Postulations/acme/2026-11-09"]);
  assertEquals(
    output,
    "abcdef12 Acme: application.pdf, 5 pages (CV, cover letter, +2 attachments)",
  );
});

Deno.test("bundle tool: every ready/review job with a folder", async () => {
  const one = job({
    id: "aaaaaaaa-1111-1111-1111-111111111111",
    company: "One",
  });
  const two = job({
    id: "bbbbbbbb-2222-2222-2222-222222222222",
    company: "Two",
    prepFolder: "Postulations/two/2026-11-10",
  });
  const folders: string[] = [];
  const tool = new BundleApplicationTool({
    list: () => Promise.resolve([one, two]),
    bundle: (folder) => {
      folders.push(folder);
      return Promise.resolve(
        folder.includes("two")
          ? bundleResult({ parts: ["cv-en.pdf", "cover-en.pdf"], pages: 2 })
          : bundleResult({
            parts: ["cv-en.pdf", "cover-en.pdf", "cert.pdf"],
            pages: 3,
          }),
      );
    },
  });

  const output = await tool.run(context, {});

  assertEquals(folders, [
    "Postulations/acme/2026-11-09",
    "Postulations/two/2026-11-10",
  ]);
  const lines = output.split("\n");
  assertEquals(
    lines[0],
    "aaaaaaaa One: application.pdf, 3 pages (CV, cover letter, +1 attachment)",
  );
  assertStringIncludes(
    output,
    "bbbbbbbb Two: application.pdf, 2 pages (CV, cover letter)",
  );
  assertStringIncludes(
    output,
    `no attachments found in ${DEFAULT_ATTACHMENTS_FOLDER}; the bundle is CV + cover letter only`,
  );
});

Deno.test("bundle tool: skipped parts are named with their reason", async () => {
  const tool = new BundleApplicationTool({
    resolve: () => Promise.resolve(job()),
    bundle: () =>
      Promise.resolve(bundleResult({
        parts: ["cv-en.pdf", "cover-en.pdf", "broken.pdf"],
        skipped: [{ name: "broken.pdf", reason: "not a PDF" }],
        pages: 2,
      })),
  });

  const output = await tool.run(context, { job: "abcdef" });
  assertStringIncludes(
    output,
    "abcdef12 Acme: application.pdf, 2 pages (CV, cover letter)",
  );
  assertStringIncludes(output, "skipped broken.pdf: not a PDF");
});

Deno.test("bundle tool: nothing to bundle says so", async () => {
  const tool = new BundleApplicationTool({
    list: () => Promise.resolve([]),
  });
  const output = await tool.run(context, {});
  assertStringIncludes(output, "Nothing to bundle");
});

Deno.test("bundle tool: an unknown job surfaces the resolver error", async () => {
  const tool = new BundleApplicationTool({
    resolve: () => Promise.reject(new Error('No job found for "zzzzzz"')),
  });
  await assertRejects(
    () => tool.run(context, { job: "zzzzzz" }),
    Error,
    "No job found",
  );
});

Deno.test("bundle tool: a job without a folder is refused", async () => {
  const tool = new BundleApplicationTool({
    resolve: () => Promise.resolve(job({ prepFolder: null })),
  });
  const error = await assertRejects(
    () => tool.run(context, { job: "abcdef" }),
    Error,
  );
  assertStringIncludes(error.message, "no prepared folder");
});

Deno.test("bundle tool: advertised without approval, with the attachments folder", () => {
  const tool = new BundleApplicationTool();
  assertEquals(tool.requireApproval, false);
  assertStringIncludes(tool.description, "CV first, then the cover letter");
  assertStringIncludes(tool.description, DEFAULT_ATTACHMENTS_FOLDER);

  const requests = generateToolRequest();
  const request = requests.find((entry) =>
    entry.type === "function" && entry.function.name === "bundle_application"
  ) as
    | {
      function: {
        name: string;
        parameters?: { required?: string[] };
      };
    }
    | undefined;
  assert(request);
  assertEquals(request.function.parameters?.required, []);
});
