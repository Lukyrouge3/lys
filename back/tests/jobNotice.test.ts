import { assert, assertEquals } from "@std/assert";
import type { Job } from "@/generated/prisma/client.ts";
import { formatJobNotice } from "@/chat/discord/notify.ts";
import { formatJobMarkdown, jobSlug } from "@/jobs/inbox.ts";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    source: "linkedin",
    externalId: "ext-1",
    url: "https://example.com/jobs/1",
    title: "Junior Developer",
    company: "Acme",
    location: "Geneva",
    description: "Build small things.",
    postedAt: null,
    rank: "apply",
    rankReason: "Strong match.",
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

Deno.test("a job notice says what, where and why", () => {
  assertEquals(
    formatJobNotice(job()),
    "💼 Worth a look: **Junior Developer** at Acme (Geneva)\n" +
      "Strong match.\n<https://example.com/jobs/1>",
  );
});

Deno.test("a job without a location has no empty parentheses", () => {
  const notice = formatJobNotice(job({ location: null }));
  assert(notice.includes("at Acme\nStrong match."));
  assertEquals(notice.includes("()"), false);
});

Deno.test("an empty reason takes no line of its own", () => {
  const notice = formatJobNotice(job({ rankReason: null }));
  assertEquals(
    notice,
    "💼 Worth a look: **Junior Developer** at Acme (Geneva)\n" +
      "<https://example.com/jobs/1>",
  );
  assertEquals(notice.split("\n").length, 2);
});

Deno.test("the url is wrapped so Discord does not unfurl it", () => {
  const notice = formatJobNotice(job());
  assert(notice.endsWith("<https://example.com/jobs/1>"));
});

Deno.test("a very long title is cut on a word", () => {
  const notice = formatJobNotice(job({ title: "mot ".repeat(200) }));
  const title = notice.split("**")[1];

  assertEquals(title.length, 200);
  assert(title.endsWith("mot…"));
});

const marker = "2026-11-22T10:00:00Z";

Deno.test("the inbox file is the posting in a readable shape", () => {
  assertEquals(
    formatJobMarkdown(job(), new Date(marker)),
    `# Junior Developer — Acme

- **Company:** Acme
- **Role:** Junior Developer
- **Location:** Geneva
- **Source:** linkedin job posting (https://example.com/jobs/1)
- **Captured:** 22 November 2026
- **Ranked by Lys:** apply — Strong match.

---

Build small things.
`,
  );
});

Deno.test("a missing location is stated, not left blank", () => {
  const markdown = formatJobMarkdown(job({ location: null }), new Date(marker));
  assert(markdown.includes("- **Location:** not stated"));
});

Deno.test("an unranked job has no ranked line", () => {
  const markdown = formatJobMarkdown(
    job({ rank: null, rankReason: null }),
    new Date(marker),
  );
  assertEquals(markdown.includes("Ranked by Lys"), false);
});

Deno.test("a rank without a reason keeps the dash out", () => {
  const markdown = formatJobMarkdown(
    job({ rank: "maybe", rankReason: "" }),
    new Date(marker),
  );
  assert(markdown.includes("- **Ranked by Lys:** maybe\n"));
});

Deno.test("the captured date is English, with no leading zero", () => {
  const markdown = formatJobMarkdown(
    job(),
    new Date("2026-03-05T23:30:00Z"),
  );
  assert(markdown.includes("- **Captured:** 5 March 2026"));
});

Deno.test("the description is the last thing in the file", () => {
  const markdown = formatJobMarkdown(
    job({ description: "Line one\n\nLine two" }),
    new Date(marker),
  );
  assert(markdown.endsWith("---\n\nLine one\n\nLine two\n"));
});

Deno.test("a slug is readable, lowercased and self-describing", () => {
  assertEquals(jobSlug(job()), "acme-junior-developer-ext-1");
});

Deno.test("a slug strips accents", () => {
  assertEquals(
    jobSlug(job({ company: "Société Générale", title: "Ingénieur" })),
    "societe-generale-ingenieur-ext-1",
  );
});

Deno.test("a slug keeps the id even when the name is very long", () => {
  const slug = jobSlug(
    job({ company: "a".repeat(200), title: "b".repeat(200) }),
  );

  assert(slug.endsWith("-ext-1"));
  // Only the company-title part is capped, and it is cut on a dash boundary
  assertEquals(slug.split("-ext-1")[0].length, 80);
  assertEquals(slug.includes("--"), false);
});

Deno.test("a slug keeps the id's own punctuation", () => {
  assert(jobSlug(job({ externalId: "abc.123_4" })).endsWith("-abc.123_4"));
});
