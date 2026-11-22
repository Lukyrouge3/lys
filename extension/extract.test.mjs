import "./extract.js";
import "./protocol.js";

const {
  JOB_DESCRIPTION_HEADINGS,
  isDescriptionHeading,
  extractJobId,
  htmlToText,
  parseJsonLdJobPosting,
  extractJobFromJsonLdText,
  parseDocumentTitle,
  extractJobFromDocument,
} = globalThis.LysExtract;

const {
  UNKNOWN_COMPANY,
  MAX_ERROR_MESSAGE_LENGTH,
  TOAST_CONFIG,
  TOAST_STALE_CONTEXT,
  TOAST_TOKEN,
  TOAST_UNEXPECTED,
  TOAST_UNREACHABLE,
  responseErrorMessage,
  companyForJob,
  isStaleContextError,
  sendErrorToast,
  sendFailureToast,
} = globalThis.LysProtocol;

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

// --- Tiny fake DOM -------------------------------------------------------
// extract.js only relies on children/parentElement/tagName/textContent/innerText
// (plus document.querySelector*/title for the JSON-LD and fallback paths), so a
// plain object tree is enough to reproduce LinkedIn's markup.

const BLOCK_TAGS = new Set([
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "SECTION",
  "UL",
]);

function joinInnerText(children) {
  let text = "";
  for (const child of children) {
    if (child.tagName === "BR") {
      text += "\n";
      continue;
    }
    if (!child.innerText) continue;
    text += BLOCK_TAGS.has(child.tagName)
      ? `${text ? "\n\n" : ""}${child.innerText}`
      : child.innerText;
  }
  return text;
}

function createElement(tag, options = {}) {
  const attrs = options.attributes || {};
  const children = options.children || [];
  const element = {
    tagName: tag.toUpperCase(),
    children: [],
    parentElement: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name)
        ? attrs[name]
        : null;
    },
    textContent: options.text || "",
    innerText: options.innerText !== undefined ? options.innerText : "",
  };

  for (const child of children) {
    element.children.push(child);
    child.parentElement = element;
  }

  if (children.length > 0) {
    element.textContent = children.map((child) => child.textContent).join("");
    element.innerText = joinInnerText(children);
  } else if (options.innerText === undefined) {
    element.innerText = element.textContent;
  }

  return element;
}

function createDocument({ title = "", body = null, jsonLd = [] } = {}) {
  const scripts = jsonLd.map((text) =>
    createElement("script", {
      text,
      attributes: { type: "application/ld+json" },
    })
  );

  return {
    title,
    body,
    documentElement: body,
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return String(selector).includes("ld+json") ? scripts : [];
    },
  };
}

const JOB_URL = "https://www.linkedin.com/jobs/view/1234567890/";
const PARAGRAPHS = [
  "We are hiring a backend engineer for our payments team.",
  "You will work with TypeScript, Postgres and Kubernetes every day.",
  "This role is based in Berlin and offers a hybrid schedule.",
];

/**
 * The structure reported on the live page: a leaf H2 inside two wrappers,
 * where the grandparent also holds the description paragraphs, under a page
 * wrapper that starts with unrelated toolbar/company markup.
 */
function linkedInJobTree(heading, paragraphs) {
  const headingNode = createElement("h2", { text: heading });
  const headingWrapper = createElement("div", { children: [headingNode] });
  const descriptionContainer = createElement("div", {
    children: [
      headingWrapper,
      ...paragraphs.map((text) => createElement("p", { text })),
    ],
  });
  const toolbar = createElement("div", {
    children: [createElement("button", { text: "Save" })],
  });
  const companyLink = createElement("a", {
    text: "Acme",
    attributes: { href: "/company/acme/" },
  });
  const topCard = createElement("div", { children: [companyLink] });
  const page = createElement("div", {
    children: [topCard, toolbar, descriptionContainer],
  });

  return { page, headingNode, headingWrapper, descriptionContainer };
}

function descriptionFromTree(tree, title) {
  const doc = createDocument({ title, body: tree.page });
  return extractJobFromDocument(doc, JOB_URL);
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

test("finds the description next to an About the job heading", () => {
  const tree = linkedInJobTree("About the job", PARAGRAPHS);
  const result = descriptionFromTree(
    tree,
    "Backend Engineer | Acme Corp | LinkedIn",
  );

  assertTrue(result && result.ok, "expected extraction to succeed");
  assertEqual(
    result.job.title,
    "Backend Engineer",
    "title from document.title",
  );
  assertEqual(
    result.job.company,
    "Acme Corp",
    "company from document.title",
  );
  assertEqual(result.job.location, null, "location is null without JSON-LD");
  assertEqual(
    result.job.description,
    PARAGRAPHS.join("\n\n"),
    "description keeps paragraph breaks and drops the heading",
  );
  assertTrue(
    !result.job.description.includes("About the job"),
    "heading is not part of the description",
  );
});

test("finds the description under localized headings", () => {
  const french = "À propos de l'offre d'emploi";
  const frenchResult = descriptionFromTree(
    linkedInJobTree(french, PARAGRAPHS),
    "Ingénieur backend | Acme | LinkedIn",
  );
  assertTrue(frenchResult.ok, "French heading is recognized");
  assertEqual(
    frenchResult.job.description,
    PARAGRAPHS.join("\n\n"),
    "French description",
  );

  const curly = "À propos de l’offre";
  const curlyResult = descriptionFromTree(
    linkedInJobTree(curly, PARAGRAPHS),
    "Ingénieur backend | Acme | LinkedIn",
  );
  assertTrue(curlyResult.ok, "heading with a typographic apostrophe works");
  assertEqual(
    curlyResult.job.description,
    PARAGRAPHS.join("\n\n"),
    "curly apostrophe description",
  );
});

test("the heading list matches every supported locale", () => {
  const headings = [
    ...JOB_DESCRIPTION_HEADINGS,
    "About the job:",
    "about the role",
    "À propos de l’offre d’emploi",
  ];
  for (const heading of headings) {
    assertTrue(
      isDescriptionHeading(heading),
      `should match heading ${JSON.stringify(heading)}`,
    );
  }

  for (const other of ["About us", "Senior Engineer", "Job", ""]) {
    assertTrue(
      !isDescriptionHeading(other),
      `should not match ${JSON.stringify(other)}`,
    );
  }
});

test("the first heading chain with a description wins", () => {
  function jobCard(heading, paragraphs) {
    const container = createElement("div", {
      children: [
        createElement("div", {
          children: [createElement("h2", { text: heading })],
        }),
        ...paragraphs.map((text) => createElement("p", { text })),
      ],
    });
    return createElement("div", { children: [container] });
  }

  const firstCard = jobCard("About the job", [
    "First card description with enough words in it to comfortably pass the hundred character length check used by the extractor.",
  ]);
  const secondCard = jobCard("About the job", [
    "Second card description with enough words in it to comfortably pass the hundred character length check used by the extractor.",
  ]);
  const page = createElement("div", { children: [firstCard, secondCard] });

  const result = extractJobFromDocument(
    createDocument({ title: "Engineer | Acme | LinkedIn", body: page }),
    JOB_URL,
  );

  assertTrue(result.ok, "two matching chains still extract");
  assertEqual(
    result.job.description,
    "First card description with enough words in it to comfortably pass the hundred character length check used by the extractor.",
    "document order decides",
  );
});

test("stops walking after eight ancestors", () => {
  const longText =
    "This paragraph is deliberately long enough to look exactly like a real job description body, with several requirements, responsibilities and benefits listed in full sentences.";

  function deepDocument(wrapperCount) {
    const heading = createElement("h2", { text: "About the job" });
    let node = createElement("div", { children: [heading] });
    for (let index = 1; index < wrapperCount; index += 1) {
      node = createElement("div", { children: [node] });
    }
    const big = createElement("div", {
      children: [node, createElement("p", { text: longText })],
    });
    return createDocument({
      title: "Engineer | Acme | LinkedIn",
      body: createElement("div", { children: [big] }),
    });
  }

  const found = extractJobFromDocument(deepDocument(7), JOB_URL);
  assertTrue(found.ok, "container at the eighth ancestor is found");
  assertEqual(found.job.description, longText, "description text");

  const missed = extractJobFromDocument(deepDocument(8), JOB_URL);
  assertTrue(!missed.ok, "container beyond eight ancestors is ignored");
  assertIncludes(
    missed.error,
    "Open the job on its own page",
    "helpful error for the deep case",
  );
});

test("a heading with almost no text under it fails helpfully", () => {
  const result = descriptionFromTree(
    linkedInJobTree("About the job", ["Tiny."]),
    "Engineer | Acme | LinkedIn",
  );

  assertTrue(!result.ok, "a tiny description is rejected");
  assertEqual(result.missing.join(","), "description", "description missing");
  assertIncludes(
    result.error,
    "Could not find the job description.",
    "error tells the user what failed",
  );
  assertIncludes(
    result.error,
    "linkedin.com/jobs/view/",
    "error points at the standalone job page",
  );
});

test("a page without a description heading reports the helpful error", () => {
  const page = createElement("div", {
    children: [
      createElement("h1", { text: "Backend Engineer" }),
      createElement("p", { text: "Some unrelated page text." }),
    ],
  });

  const result = extractJobFromDocument(
    createDocument({ title: "Backend Engineer | Acme | LinkedIn", body: page }),
    JOB_URL,
  );

  assertTrue(!result.ok, "no heading means no description");
  assertEqual(
    result.error,
    "Could not find the job description. Open the job on its own page (linkedin.com/jobs/view/…) and try again.",
    "exact help message",
  );
});

test("parseDocumentTitle handles counters, missing company and no pipes", () => {
  assertEqual(
    JSON.stringify(
      parseDocumentTitle("(3) Backend Engineer | Acme Corp | LinkedIn"),
    ),
    JSON.stringify({ title: "Backend Engineer", company: "Acme Corp" }),
    "notification counter prefix",
  );
  assertEqual(
    JSON.stringify(parseDocumentTitle("Backend Engineer | LinkedIn")),
    JSON.stringify({ title: "Backend Engineer", company: "" }),
    "missing company",
  );
  assertEqual(
    JSON.stringify(parseDocumentTitle("Backend Engineer")),
    JSON.stringify({ title: "Backend Engineer", company: "" }),
    "no pipes",
  );
  assertEqual(
    JSON.stringify(parseDocumentTitle("Backend Engineer - LinkedIn")),
    JSON.stringify({ title: "Backend Engineer", company: "" }),
    "dash before LinkedIn",
  );
  assertEqual(
    JSON.stringify(parseDocumentTitle("LinkedIn")),
    JSON.stringify({ title: "", company: "" }),
    "bare LinkedIn",
  );
  assertEqual(
    JSON.stringify(parseDocumentTitle("")),
    JSON.stringify({ title: "", company: "" }),
    "empty title",
  );
});

test("an h1 beats document.title and a company link fills the gap", () => {
  const tree = linkedInJobTree("About the job", PARAGRAPHS);
  const h1 = createElement("h1", { text: "Staff Backend Engineer" });
  tree.page.children.unshift(h1);
  h1.parentElement = tree.page;

  const result = extractJobFromDocument(
    createDocument({ title: "Other Title | LinkedIn", body: tree.page }),
    JOB_URL,
  );

  assertTrue(result.ok, "extraction succeeds");
  assertEqual(result.job.title, "Staff Backend Engineer", "h1 wins");
  assertEqual(result.job.company, "Acme", "company link fallback");
  assertEqual(
    result.job.description,
    PARAGRAPHS.join("\n\n"),
    "description still found",
  );
});

test("JSON-LD still wins over the heading walk", () => {
  const tree = linkedInJobTree("About the job", PARAGRAPHS);
  const jsonLd = JSON.stringify({
    "@type": "JobPosting",
    title: "JSON-LD Title",
    hiringOrganization: { "@type": "Organization", name: "Json Co" },
    jobLocation: {
      "@type": "Place",
      address: { addressLocality: "Paris", addressCountry: "FR" },
    },
    description: "<p>JSON-LD description</p>",
  });

  const result = extractJobFromDocument(
    createDocument({
      title: "Ignored | LinkedIn",
      body: tree.page,
      jsonLd: [jsonLd],
    }),
    JOB_URL,
  );

  assertTrue(result.ok, "JSON-LD extraction succeeds");
  assertEqual(result.job.title, "JSON-LD Title", "JSON-LD title");
  assertEqual(result.job.company, "Json Co", "JSON-LD company");
  assertEqual(result.job.location, "Paris, FR", "JSON-LD location");
  assertEqual(
    result.job.description,
    "JSON-LD description",
    "JSON-LD description",
  );
});

test("a page-sized description container is cut to the 20000 character cap", () => {
  const tree = linkedInJobTree("About the job", ["x".repeat(60000)]);

  const result = descriptionFromTree(tree, "Engineer | Acme | LinkedIn");

  assertTrue(result.ok, "oversized container still extracts");
  assertTrue(
    result.job.description.length <= 20000,
    "description respects the cap",
  );
  assertTrue(
    result.job.description.length > 19000,
    "description is not silently empty",
  );
});

// --- Toast text for failed sends (protocol.js) ---------------------------
// The jobs API answers errors as `{"error":"<message>"}`; these tests pin the
// exact wording so a wrong token is never confused with a rejected job body.

test("401 says the token was rejected, not that the job was bad", () => {
  assertEqual(
    sendFailureToast({
      ok: false,
      status: 401,
      error: "http",
      message: "unauthorized",
    }),
    TOAST_TOKEN,
    "401 explains the token",
  );
  assertIncludes(TOAST_TOKEN, "rejected the token", "401 names the token");
});

test("400 reports the server's own complaint about the job body", () => {
  assertEqual(
    sendFailureToast({
      ok: false,
      status: 400,
      error: "http",
      message: "company: is required",
    }),
    "Lys rejected the job: company: is required",
    "400 passes the server message through",
  );
});

test("400 without a message still says the job was rejected", () => {
  for (
    const response of [
      { ok: false, status: 400, error: "http", message: "" },
      { ok: false, status: 400, error: "http" },
      { ok: false, status: 400, error: "http", message: "   " },
    ]
  ) {
    assertEqual(
      sendFailureToast(response),
      "Lys rejected the job.",
      "empty server message falls back to a short toast",
    );
  }
});

test("config errors point at the extension options", () => {
  assertEqual(
    sendFailureToast({ ok: false, status: 0, error: "config" }),
    TOAST_CONFIG,
    "config toast",
  );
});

test("network and timeout are the only not-reachable toasts", () => {
  assertEqual(
    sendFailureToast({ ok: false, status: 0, error: "network" }),
    TOAST_UNREACHABLE,
    "network toast",
  );
  assertEqual(
    sendFailureToast({ ok: false, status: 0, error: "timeout" }),
    TOAST_UNREACHABLE,
    "timeout toast",
  );
  assertEqual(
    sendFailureToast({
      ok: false,
      status: 500,
      error: "http",
      message: "internal error",
    }),
    "Lys returned HTTP 500: internal error",
    "500 is not reported as unreachable",
  );
});

test("a 401 or 400 never uses the tunnel wording", () => {
  for (const status of [400, 401]) {
    const toast = sendFailureToast({
      ok: false,
      status,
      error: "http",
      message: "x",
    });
    assertTrue(
      !toast.includes("SSH tunnel"),
      `HTTP ${status} must not claim the endpoint is down`,
    );
  }
});

test("server messages are trimmed and capped for a toast", () => {
  assertEqual(
    responseErrorMessage({ error: "  company: is required  " }),
    "company: is required",
    "trimmed",
  );
  assertEqual(responseErrorMessage(null), "", "null body");
  assertEqual(responseErrorMessage({ error: 42 }), "", "non-string error");
  assertEqual(
    responseErrorMessage({ error: "x".repeat(500) }).length,
    MAX_ERROR_MESSAGE_LENGTH,
    "capped",
  );
});

test("a stale extension context asks for a tab refresh", () => {
  const stale = new Error("Extension context invalidated.");
  const staleLower = new Error("extension context invalidated");
  const disconnected = new Error(
    "Could not establish connection. Receiving end does not exist.",
  );

  assertTrue(isStaleContextError(stale), "thrown Error is detected");
  assertTrue(
    isStaleContextError("Extension context invalidated."),
    "plain message is detected",
  );
  assertTrue(isStaleContextError(staleLower), "matching ignores case");
  assertTrue(!isStaleContextError(disconnected), "other errors are not stale");
  assertTrue(!isStaleContextError(undefined), "undefined is not stale");

  assertEqual(sendErrorToast(stale), TOAST_STALE_CONTEXT, "stale toast");
  assertEqual(
    sendErrorToast(disconnected),
    TOAST_UNREACHABLE,
    "a real send failure stays not-reachable",
  );
});

test("an empty company becomes Unknown company instead of dropping the job", () => {
  assertEqual(companyForJob(""), UNKNOWN_COMPANY, "empty");
  assertEqual(companyForJob("   "), UNKNOWN_COMPANY, "whitespace only");
  assertEqual(companyForJob(null), UNKNOWN_COMPANY, "null");
  assertEqual(companyForJob("Acme"), "Acme", "real name kept");
});

test("an unknown response is not mistaken for a specific failure", () => {
  assertEqual(sendFailureToast(null), TOAST_UNEXPECTED, "no response");
  assertEqual(
    sendFailureToast({ ok: false, status: 0, error: "bad-job" }),
    TOAST_UNEXPECTED,
    "bad-job has no dedicated toast yet",
  );
});
