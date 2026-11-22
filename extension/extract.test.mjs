import "./extract.js";

const {
  extractJobId,
  htmlToText,
  parseJsonLdJobPosting,
  extractJobFromJsonLdText,
} = globalThis.LysExtract;

const test = typeof Deno !== "undefined"
  ? Deno.test
  : (await import("node:test")).default;

function fail(message) {
  throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    fail(
      `${message}\nExpected: ${JSON.stringify(expected)}\nActual:   ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function assertTrue(value, message) {
  if (!value) fail(message);
}

function assertIncludes(haystack, needle, message) {
  if (typeof haystack !== "string" || !haystack.includes(needle)) {
    fail(
      `${message}\nMissing: ${JSON.stringify(needle)}\nIn: ${
        JSON.stringify(haystack)
      }`,
    );
  }
}

test("extractJobId reads /jobs/view/ ids", () => {
  assertEqual(
    extractJobId("https://www.linkedin.com/jobs/view/1234567890/"),
    "1234567890",
    "plain numeric id",
  );
  assertEqual(
    extractJobId(
      "https://www.linkedin.com/jobs/view/software-engineer-at-acme-1234567890/?trk=public_jobs",
    ),
    "1234567890",
    "slug plus id",
  );
  assertEqual(
    extractJobId("https://linkedin.com/jobs/view/0987654321"),
    "0987654321",
    "linkedin.com without www",
  );
});

test("extractJobId reads currentJobId and prefers the path", () => {
  assertEqual(
    extractJobId(
      "https://www.linkedin.com/jobs/search/?currentJobId=987654321&keywords=engineer",
    ),
    "987654321",
    "currentJobId query parameter",
  );
  assertEqual(
    extractJobId(
      "https://www.linkedin.com/jobs/view/111222333/?currentJobId=999999999",
    ),
    "111222333",
    "path id takes precedence",
  );
});

test("extractJobId rejects absent or malformed ids", () => {
  assertEqual(
    extractJobId("https://www.linkedin.com/jobs/"),
    null,
    "jobs landing page",
  );
  assertEqual(
    extractJobId(
      "https://www.linkedin.com/jobs/view/software-engineer-12ab/",
    ),
    null,
    "non-numeric suffix",
  );
  assertEqual(
    extractJobId("https://example.com/jobs/view/1234567890/"),
    null,
    "non-LinkedIn host",
  );
  assertEqual(extractJobId(""), null, "empty URL");
});

test("htmlToText preserves paragraphs, line breaks and list items", () => {
  const html =
    "<p>Hello <strong>world</strong></p><p>Second<br>line</p><ul><li>One</li><li>Two</li></ul>";
  assertEqual(
    htmlToText(html),
    "Hello world\n\nSecond\nline\n\nOne\nTwo",
    "block boundaries",
  );
});

test("htmlToText decodes entities without decoding tags into HTML", () => {
  assertEqual(
    htmlToText(
      "<p>Fish &amp; Chips &#8212; &quot;yes&quot; &nbsp; now</p><p>&lt;tag&gt;</p>",
    ),
    'Fish & Chips \u2014 "yes" now\n\n<tag>',
    "entities",
  );
  assertEqual(
    htmlToText("<script>alert(1)</script><style>.x{}</style><p>ok</p>"),
    "ok",
    "script and style removed",
  );
});

test("parseJsonLdJobPosting handles @graph and @type arrays", () => {
  const graph = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", name: "Acme" },
      {
        "@type": ["JobPosting"],
        title: "Graph Job",
        description: "<p>Graph description</p>",
      },
    ],
  });

  const posting = parseJsonLdJobPosting(graph);
  assertTrue(posting, "should find JobPosting inside @graph");
  assertEqual(posting.title, "Graph Job", "title from @graph");

  assertEqual(
    parseJsonLdJobPosting("{not json"),
    null,
    "malformed JSON returns null",
  );
  assertEqual(
    parseJsonLdJobPosting(JSON.stringify({ "@type": "WebPage" })),
    null,
    "non-JobPosting returns null",
  );
});

test("extractJobFromJsonLdText normalizes a complete posting", () => {
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "  Senior Engineer  ",
    hiringOrganization: { "@type": "Organization", name: "Acme" },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: "Berlin",
        addressCountry: "DE",
      },
    },
    description:
      "<p>Build <strong>things</strong>.</p><ul><li>One</li><li>Two &amp; more</li></ul>",
    datePosted: "2025-01-15",
  });

  const result = extractJobFromJsonLdText(
    jsonLd,
    "https://www.linkedin.com/jobs/view/1234567890/",
  );

  assertTrue(result && result.ok, "expected a successful extraction");
  assertEqual(result.job.source, "linkedin", "source");
  assertEqual(result.job.externalId, "1234567890", "externalId");
  assertEqual(
    result.job.url,
    "https://www.linkedin.com/jobs/view/1234567890/",
    "canonical url",
  );
  assertEqual(result.job.title, "Senior Engineer", "trimmed title");
  assertEqual(result.job.company, "Acme", "company");
  assertEqual(result.job.location, "Berlin, DE", "location");
  assertEqual(
    result.job.description,
    "Build things.\n\nOne\nTwo & more",
    "description",
  );
  assertEqual(result.job.postedAt, "2025-01-15T00:00:00.000Z", "postedAt");
});

test("extractJobFromJsonLdText refuses missing required fields", () => {
  const url = "https://www.linkedin.com/jobs/view/1234567890/";

  const noTitle = extractJobFromJsonLdText(
    JSON.stringify({ "@type": "JobPosting", description: "<p>Body</p>" }),
    url,
  );
  assertTrue(noTitle && !noTitle.ok, "missing title should fail");
  assertTrue(noTitle.missing.includes("title"), "missing title is reported");
  assertIncludes(noTitle.error, "title", "error names title");

  const noDescription = extractJobFromJsonLdText(
    JSON.stringify({ "@type": "JobPosting", title: "Engineer" }),
    url,
  );
  assertTrue(noDescription && !noDescription.ok, "missing description fails");
  assertTrue(
    noDescription.missing.includes("description"),
    "missing description is reported",
  );
  assertIncludes(noDescription.error, "description", "error names description");

  const neither = extractJobFromJsonLdText(
    JSON.stringify({ "@type": "JobPosting" }),
    url,
  );
  assertTrue(neither && !neither.ok, "both missing should fail");
  assertEqual(neither.missing.length, 2, "both fields missing");
});

test("description is capped at 20000 characters", () => {
  const description = "x".repeat(20050);
  const result = extractJobFromJsonLdText(
    JSON.stringify({
      "@type": "JobPosting",
      title: "Long Job",
      description,
    }),
    "https://www.linkedin.com/jobs/view/1234567890/",
  );

  assertTrue(result && result.ok, "long description extraction");
  assertEqual(
    result.job.description.length,
    20000,
    "description length cap",
  );
});

test("invalid datePosted becomes null", () => {
  const result = extractJobFromJsonLdText(
    JSON.stringify({
      "@type": "JobPosting",
      title: "Job",
      description: "Description",
      datePosted: "not a date",
    }),
    "https://www.linkedin.com/jobs/view/1234567890/",
  );

  assertTrue(result && result.ok, "job should still extract");
  assertEqual(result.job.postedAt, null, "invalid date is null");
});
