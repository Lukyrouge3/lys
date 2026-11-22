/**
 * Pure extraction helpers for the LinkedIn job page.
 *
 * This file is loaded as a classic content script (before content.js) and it is
 * also imported by extract.test.mjs. It deliberately does not touch
 * document/window at import time; pass a DOM-like object to
 * extractJobFromDocument() when running in the page.
 */
(function (root) {
  "use strict";

  // Heading wording that LinkedIn puts directly above a job description, in
  // the languages we have seen. Matching is case-insensitive, anchored at the
  // start of a leaf element's trimmed text, and tolerates a trailing colon.
  // THIS IS THE ONE PLACE TO EXTEND when description extraction stops working:
  // add the new wording here, then reload the extension.
  const JOB_DESCRIPTION_HEADINGS = Object.freeze([
    "About the job",
    "About the role",
    "Job description",
    "À propos de l'offre d'emploi",
    "À propos de l’offre",
    "Description du poste",
    "Über die Stelle",
    "Acerca del empleo",
    "Informazioni sull'offerta di lavoro",
    "Sobre a vaga",
  ]);

  // LinkedIn rotates its CSS class names, so the selectors below are only the
  // LAST resort: JSON-LD first, then the heading-anchored DOM walk, then these.
  const JOB_DETAIL_SELECTORS = Object.freeze({
    title: Object.freeze([
      ".job-details-jobs-unified-top-card__job-title",
      ".jobs-unified-top-card__job-title",
      ".job-details-jobs-unified-top-card__job-title h1",
      "h1",
    ]),
    company: Object.freeze([
      ".job-details-jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__company-name a",
      ".jobs-unified-top-card__company-name",
      ".job-details-jobs-unified-top-card__company-name a",
    ]),
    // Kept for reference only: location is reported when JSON-LD provides it
    // and is null otherwise, because guessing it from the header text was not
    // reliable.
    location: Object.freeze([
      ".job-details-jobs-unified-top-card__primary-description-container .tvm__text--low-emphasis",
      ".job-details-jobs-unified-top-card__primary-description-container",
      ".jobs-unified-top-card__bullet",
      ".jobs-unified-top-card__workplace-type",
      ".job-details-jobs-unified-top-card__workplace-type",
    ]),
    description: Object.freeze([
      ".jobs-description__content",
      "#job-details",
      ".jobs-box__html-content",
      ".jobs-description-content__text",
    ]),
  });

  const MAX_DESCRIPTION_LENGTH = 20000;

  // A container much bigger than this is the whole pane or the page, not the
  // description; keep only its head.
  const MAX_CONTAINER_SCAN_LENGTH = 50000;

  // A heading is a short label, never a paragraph.
  const MAX_HEADING_LENGTH = 120;

  // How far up from the heading we are willing to walk before giving up.
  const MAX_HEADING_ANCESTOR_STEPS = 8;

  // The description container must be this much longer than the heading itself
  // (the heading usually sits inside one or two same-size wrappers first).
  const MIN_DESCRIPTION_GROWTH = 100;

  const DESCRIPTION_HELP =
    "Could not find the job description. Open the job on its own page (linkedin.com/jobs/view/…) and try again.";

  const NAMED_ENTITIES = Object.freeze({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "\u2013",
    mdash: "\u2014",
    hellip: "\u2026",
    lsquo: "\u2018",
    rsquo: "\u2019",
    ldquo: "\u201c",
    rdquo: "\u201d",
    copy: "\u00a9",
    reg: "\u00ae",
    trade: "\u2122",
    euro: "\u20ac",
    pound: "\u00a3",
    yen: "\u00a5",
    cent: "\u00a2",
    middot: "\u00b7",
    bull: "\u2022",
    deg: "\u00b0",
  });

  function asString(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    return "";
  }

  function cleanInline(value) {
    return asString(value).replace(/\s+/g, " ").trim();
  }

  function cleanBlock(value) {
    return asString(value)
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function truncateDescription(value) {
    const text = cleanBlock(value);
    if (text.length <= MAX_DESCRIPTION_LENGTH) return text;
    return text.slice(0, MAX_DESCRIPTION_LENGTH).trim();
  }

  function decodeHtmlEntities(text) {
    return text.replace(
      /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi,
      (match, entity) => {
        if (entity.charAt(0) === "#") {
          const isHex = entity.charAt(1).toLowerCase() === "x";
          const digits = entity.slice(isHex ? 2 : 1);
          const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
          if (
            Number.isFinite(codePoint) && codePoint >= 0 &&
            codePoint <= 0x10ffff
          ) {
            try {
              return String.fromCodePoint(codePoint);
            } catch {
              return match;
            }
          }
          return match;
        }

        const key = entity.toLowerCase();
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)
          ? NAMED_ENTITIES[key]
          : match;
      },
    );
  }

  /**
   * Convert the small HTML subset used by JobPosting.description into plain
   * text, preserving paragraph, line-break and list-item boundaries.
   */
  function htmlToText(html) {
    if (typeof html !== "string" || html.length === 0) return "";

    let text = html;
    text = text.replace(/<!--[\s\S]*?-->/g, "");
    text = text.replace(
      /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      "",
    );
    text = text.replace(/<\s*br\s*\/?>/gi, "\n");
    text = text.replace(
      /<\s*\/\s*(p|div|section|article|header|footer|h[1-6]|table|tr)\s*>/gi,
      "\n\n",
    );
    text = text.replace(
      /<\s*(p|div|section|article|header|footer|h[1-6]|table|tr)\b[^>]*>/gi,
      "\n",
    );
    text = text.replace(/<\s*li\b[^>]*>/gi, "\n");
    text = text.replace(/<\s*\/\s*li\s*>/gi, "");
    text = text.replace(/<\s*\/\s*(ul|ol)\s*>/gi, "\n");
    text = text.replace(/<[^>]*>/g, "");
    text = decodeHtmlEntities(text);

    return cleanBlock(text);
  }

  function extractJobId(url) {
    if (typeof url !== "string" || url.length === 0) return null;

    let parsed;
    try {
      parsed = new URL(url, "https://www.linkedin.com");
    } catch {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com")) {
      return null;
    }

    const pathMatch = parsed.pathname.match(
      /\/jobs\/view\/(?:[^/?#]+-)?(\d+)\/?$/,
    );
    if (pathMatch) return pathMatch[1];

    const currentJobId = parsed.searchParams.get("currentJobId");
    if (currentJobId && /^\d+$/.test(currentJobId)) return currentJobId;

    return null;
  }

  function canonicalJobUrl(externalId) {
    return `https://www.linkedin.com/jobs/view/${externalId}/`;
  }

  function findJobPosting(node, depth) {
    if (!node || typeof node !== "object" || depth > 20) return null;

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findJobPosting(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    const rawTypes = Array.isArray(node["@type"])
      ? node["@type"]
      : [node["@type"]];
    const types = rawTypes.map((type) =>
      asString(type).split(/[/#]/).pop().toLowerCase()
    );
    if (types.includes("jobposting")) return node;

    if (node["@graph"]) {
      const found = findJobPosting(node["@graph"], depth + 1);
      if (found) return found;
    }

    for (const key of Object.keys(node)) {
      if (key === "@graph") continue;
      const value = node[key];
      if (value && typeof value === "object") {
        const found = findJobPosting(value, depth + 1);
        if (found) return found;
      }
    }

    return null;
  }

  function parseJsonLdJobPosting(text) {
    if (typeof text !== "string" || text.trim().length === 0) return null;

    let data;
    try {
      data = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      return null;
    }

    return findJobPosting(data, 0);
  }

  function valueLabel(value) {
    if (typeof value === "string") return cleanInline(value);
    if (typeof value === "number") return String(value);
    if (value && typeof value === "object") {
      return cleanInline(value.name || value["@value"] || "");
    }
    return "";
  }

  function addressToString(address) {
    if (typeof address === "string") return cleanInline(address);
    if (!address || typeof address !== "object") return "";

    if (Array.isArray(address)) {
      return address.map(addressToString).filter(Boolean).join(", ");
    }

    return [
      address.addressLocality,
      address.addressRegion,
      address.addressCountry,
      address.postalCode,
    ].map(valueLabel).filter(Boolean).join(", ");
  }

  function locationToString(jobLocation) {
    if (!jobLocation) return null;

    if (Array.isArray(jobLocation)) {
      const values = jobLocation.map(locationToString).filter(Boolean);
      return values.length > 0 ? [...new Set(values)].join("; ") : null;
    }

    if (typeof jobLocation === "string") {
      return cleanInline(jobLocation) || null;
    }

    if (typeof jobLocation === "object") {
      if (jobLocation.address) {
        const address = addressToString(jobLocation.address);
        if (address) return address;
      }
      const name = cleanInline(jobLocation.name);
      if (name) return name;
    }

    return null;
  }

  function organizationName(organization) {
    if (typeof organization === "string") return cleanInline(organization);
    if (organization && typeof organization === "object") {
      return cleanInline(organization.name);
    }
    return "";
  }

  function toIsoOrNull(value) {
    const text = asString(value).trim();
    if (!text) return null;

    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  function buildJobResult(url, fields) {
    const externalId = extractJobId(url);
    if (!externalId) {
      return {
        ok: false,
        error: "No LinkedIn job id found in the URL.",
        missing: ["jobId"],
      };
    }

    const title = cleanInline(fields.title);
    const description = truncateDescription(fields.description);
    const missing = [];
    if (!title) missing.push("title");
    if (!description) missing.push("description");

    if (missing.length > 0) {
      let error;
      if (missing.includes("description")) {
        error = missing.length > 1
          ? `Could not find ${
            missing.join(" and ")
          } on this page. ${DESCRIPTION_HELP}`
          : DESCRIPTION_HELP;
      } else {
        error = `Could not find ${missing.join(" and ")} on this page.`;
      }
      return { ok: false, error, missing };
    }

    return {
      ok: true,
      job: {
        source: "linkedin",
        externalId,
        url: canonicalJobUrl(externalId),
        title,
        company: cleanInline(fields.company),
        location: fields.location == null
          ? null
          : cleanInline(fields.location) || null,
        description,
        postedAt: toIsoOrNull(fields.postedAt),
      },
    };
  }

  function jobFromPosting(url, posting) {
    return buildJobResult(url, {
      title: posting.title,
      company: organizationName(posting.hiringOrganization),
      location: locationToString(posting.jobLocation),
      description: htmlToText(posting.description),
      postedAt: posting.datePosted,
    });
  }

  /**
   * Convenience function for tests and for callers that already have the
   * JSON-LD text. Returns null when there is no JobPosting block.
   */
  function extractJobFromJsonLdText(text, url) {
    const posting = parseJsonLdJobPosting(text);
    if (!posting) return null;
    return jobFromPosting(url, posting);
  }

  function getJobPostingFromDocument(doc) {
    if (!doc || typeof doc.querySelectorAll !== "function") return null;

    let scripts;
    try {
      scripts = doc.querySelectorAll('script[type^="application/ld+json"]');
    } catch {
      return null;
    }

    for (const script of Array.from(scripts || [])) {
      const text = script && typeof script.textContent === "string"
        ? script.textContent
        : "";
      const posting = parseJsonLdJobPosting(text);
      if (posting) return posting;
    }

    return null;
  }

  function elementChildren(element) {
    if (!element) return [];

    let children;
    try {
      children = element.children;
    } catch {
      return [];
    }
    if (!children) return [];

    try {
      return Array.from(children);
    } catch {
      return [];
    }
  }

  function tagNameOf(element) {
    if (!element) return "";
    return asString(element.tagName || element.nodeName || "").toUpperCase();
  }

  const BLOCK_TAG_NAMES = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "DD",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HR",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "UL",
  ]);

  const SKIPPED_TAG_NAMES = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
  ]);

  /**
   * Text of a subtree with block boundaries preserved, used when the node has
   * no usable innerText (fake DOMs, detached or hidden nodes).
   */
  function blockAwareText(element) {
    if (!element) return "";

    const tag = tagNameOf(element);
    if (tag === "BR") return "\n";
    if (SKIPPED_TAG_NAMES.has(tag)) return "";

    const children = elementChildren(element);
    if (children.length === 0) {
      try {
        return typeof element.textContent === "string"
          ? element.textContent
          : "";
      } catch {
        return "";
      }
    }

    let text = "";
    for (const child of children) {
      const childTag = tagNameOf(child);
      if (childTag === "BR") {
        text += "\n";
        continue;
      }
      const childText = blockAwareText(child);
      if (!childText) continue;
      if (BLOCK_TAG_NAMES.has(childTag)) {
        text += `\n\n${childText}\n\n`;
      } else {
        text += childText;
      }
    }
    return text;
  }

  function readElementText(element) {
    if (!element) return "";

    try {
      const innerText = typeof element.innerText === "string"
        ? element.innerText
        : "";
      if (innerText.trim()) return innerText;
    } catch {
      // Fall through to the subtree walk.
    }

    try {
      const text = blockAwareText(element);
      if (text.trim()) return text;
    } catch {
      // Fall through to textContent.
    }

    try {
      return typeof element.textContent === "string" ? element.textContent : "";
    } catch {
      return "";
    }
  }

  function documentRoot(doc) {
    if (!doc) return null;
    try {
      return doc.body || doc.documentElement || doc;
    } catch {
      return null;
    }
  }

  /** Depth-first, document-order walk. Return true from visit to stop. */
  function eachElement(root, visit) {
    const stack = [root];
    while (stack.length > 0) {
      const element = stack.pop();
      if (!element) continue;
      if (visit(element) === true) return true;

      const children = elementChildren(element);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]);
      }
    }
    return false;
  }

  function readAttribute(element, name) {
    if (!element) return "";

    try {
      if (typeof element.getAttribute === "function") {
        return asString(element.getAttribute(name));
      }
    } catch {
      return "";
    }

    try {
      return asString(element[name]);
    } catch {
      return "";
    }
  }

  function pickText(doc, selectors) {
    if (!doc || typeof doc.querySelector !== "function") return "";

    for (const selector of selectors) {
      let element;
      try {
        element = doc.querySelector(selector);
      } catch {
        continue;
      }
      if (!element) continue;

      const text = readElementText(element);
      if (text.trim()) return text;
    }

    return "";
  }

  function documentTitle(doc) {
    try {
      return doc && typeof doc.title === "string" ? doc.title : "";
    } catch {
      return "";
    }
  }

  function normalizeHeadingText(value) {
    return asString(value)
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isDescriptionHeading(value) {
    const text = normalizeHeadingText(value).replace(/[:\s]+$/, "");
    if (!text || text.length > MAX_HEADING_LENGTH) return false;

    return JOB_DESCRIPTION_HEADINGS.some((heading) => {
      const label = normalizeHeadingText(heading).replace(/[:\s]+$/, "");
      return text === label || text.startsWith(`${label} `);
    });
  }

  /**
   * Split document.title into title and company. LinkedIn job pages look like
   * "<Job title> | <Company> | LinkedIn", sometimes prefixed with a
   * notification counter such as "(3) ".
   */
  function parseDocumentTitle(value) {
    const empty = { title: "", company: "" };

    let text = cleanInline(value);
    if (!text) return empty;

    text = text.replace(/^\(\d+\)\s*/, "").trim();
    text = text.replace(/\s*[|\-\u2013\u2014]\s*LinkedIn\s*$/i, "").trim();
    if (!text || /^(linkedin|jobs|linkedin jobs)$/i.test(text)) return empty;

    const segments = text.split(/\s*\|\s*/).map(cleanInline).filter(Boolean);
    if (segments.length === 0) return empty;

    const title = /^linkedin$/i.test(segments[0]) ? "" : segments[0];
    const company = segments.length > 1 && !/^linkedin$/i.test(segments[1])
      ? segments[1]
      : "";

    return { title, company };
  }

  function titleFromH1(doc) {
    const root = documentRoot(doc);
    if (!root) return "";

    let title = "";
    eachElement(root, (element) => {
      if (tagNameOf(element) !== "H1") return false;

      const text = cleanInline(readElementText(element));
      if (!text || /^linkedin$/i.test(text)) return false;

      title = text;
      return true;
    });
    return title;
  }

  /** First link to /company/ with text, in document order. */
  function companyFromPage(doc) {
    const root = documentRoot(doc);
    if (!root) return "";

    let company = "";
    eachElement(root, (element) => {
      if (tagNameOf(element) !== "A") return false;

      const href = readAttribute(element, "href");
      if (!href || !href.includes("/company/")) return false;

      const text = cleanInline(readElementText(element));
      if (!text) return false;

      company = text;
      return true;
    });
    return company;
  }

  function stripHeadingText(text, heading) {
    const cleaned = cleanBlock(text);
    const headingText = cleanBlock(heading);
    if (!headingText) return cleaned;

    if (cleaned.startsWith(headingText)) {
      return cleaned.slice(headingText.length).trim();
    }

    const index = cleaned.indexOf(headingText);
    if (index >= 0) {
      return `${cleaned.slice(0, index)}${
        cleaned.slice(index + headingText.length)
      }`.trim();
    }

    return cleaned;
  }

  function startsWithHeading(text, headingText) {
    const heading = cleanBlock(headingText);
    if (!heading) return false;
    return cleanBlock(text).startsWith(heading);
  }

  function descriptionFromHeading(heading) {
    const headingText = readElementText(heading);
    const referenceLength = headingText.trim().length;

    let node = heading.parentElement || null;
    for (
      let step = 1;
      node && step <= MAX_HEADING_ANCESTOR_STEPS;
      step += 1
    ) {
      let text = readElementText(node);
      // The container must begin with the heading; otherwise we have walked
      // past the description into a toolbar or a page-sized wrapper.
      if (
        text.length > referenceLength + MIN_DESCRIPTION_GROWTH &&
        startsWithHeading(text, headingText)
      ) {
        if (text.length > MAX_CONTAINER_SCAN_LENGTH) {
          text = text.slice(0, MAX_DESCRIPTION_LENGTH);
        }
        const description = stripHeadingText(text, headingText);
        if (description) return truncateDescription(description);
      }
      node = node.parentElement || null;
    }

    return "";
  }

  /**
   * Description by heading anchor: find a leaf element whose text is a known
   * "About the job"-style heading, then walk up to the nearest ancestor that is
   * clearly longer than the heading itself. That ancestor is the description.
   */
  function descriptionByHeading(doc) {
    const root = documentRoot(doc);
    if (!root) return "";

    const headings = [];
    eachElement(root, (element) => {
      if (elementChildren(element).length > 0) return false;
      if (!isDescriptionHeading(readElementText(element))) return false;

      headings.push(element);
      return false;
    });

    for (const heading of headings) {
      const description = descriptionFromHeading(heading);
      if (description) return description;
    }

    return "";
  }

  /**
   * Extract from the rendered page. JSON-LD is preferred; otherwise the job
   * detail pane is found by anchoring on the "About the job"-style heading.
   * Class-based selectors are only the last resort.
   */
  function extractJobFromDocument(doc, url) {
    const externalId = extractJobId(url);
    if (!externalId) {
      return {
        ok: false,
        error: "No job detected on this page.",
        missing: ["jobId"],
      };
    }

    const posting = getJobPostingFromDocument(doc);
    let title = "";
    let company = "";
    let location = null;
    let description = "";
    let postedAt = null;

    if (posting) {
      title = cleanInline(posting.title);
      company = organizationName(posting.hiringOrganization);
      location = locationToString(posting.jobLocation);
      description = htmlToText(posting.description);
      postedAt = posting.datePosted;
    }

    const parsedTitle = parseDocumentTitle(documentTitle(doc));

    if (!title) title = titleFromH1(doc);
    if (!title) title = parsedTitle.title;
    if (!company) company = parsedTitle.company;
    if (!company) company = companyFromPage(doc);

    if (!title) {
      title = cleanInline(pickText(doc, JOB_DETAIL_SELECTORS.title));
    }
    if (!company) {
      company = cleanInline(pickText(doc, JOB_DETAIL_SELECTORS.company));
    }
    if (!description) {
      description = descriptionByHeading(doc);
    }
    if (!description) {
      description = truncateDescription(
        pickText(doc, JOB_DETAIL_SELECTORS.description),
      );
    }

    return buildJobResult(url, {
      title,
      company,
      location,
      description,
      postedAt,
    });
  }

  const api = Object.freeze({
    JOB_DESCRIPTION_HEADINGS,
    JOB_DETAIL_SELECTORS,
    MAX_DESCRIPTION_LENGTH,
    isDescriptionHeading,
    extractJobId,
    canonicalJobUrl,
    htmlToText,
    parseJsonLdJobPosting,
    extractJobFromJsonLdText,
    parseDocumentTitle,
    extractJobFromDocument,
  });

  root.LysExtract = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
