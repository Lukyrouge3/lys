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

  // LinkedIn changes these class names regularly. When extraction breaks, fix
  // the selectors here. JSON-LD is tried first; these are only the fallbacks.
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
      return {
        ok: false,
        error: `Could not find ${missing.join(" and ")} on this page.`,
        missing,
      };
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

  function readElementText(element) {
    if (!element) return "";

    try {
      const innerText = typeof element.innerText === "string"
        ? element.innerText
        : "";
      if (innerText.trim()) return innerText;
    } catch {
      // Fall through to textContent.
    }

    try {
      return typeof element.textContent === "string" ? element.textContent : "";
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

  function titleFromDocumentTitle(title) {
    const cleaned = cleanInline(title)
      .replace(/\s*[|\-\u2013]\s*LinkedIn\s*$/i, "")
      .trim();
    if (/^(linkedin|jobs|linkedin jobs)$/i.test(cleaned)) return "";
    return cleaned;
  }

  /**
   * Extract from the rendered page. JSON-LD is preferred, then the selector
   * fallbacks above, then document.title for the title only.
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

    if (!title) {
      title = cleanInline(pickText(doc, JOB_DETAIL_SELECTORS.title));
    }
    if (!title) {
      title = titleFromDocumentTitle(documentTitle(doc));
    }
    if (!company) {
      company = cleanInline(pickText(doc, JOB_DETAIL_SELECTORS.company));
    }
    if (!location) {
      location = cleanInline(pickText(doc, JOB_DETAIL_SELECTORS.location)) ||
        null;
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
    JOB_DETAIL_SELECTORS,
    MAX_DESCRIPTION_LENGTH,
    extractJobId,
    canonicalJobUrl,
    htmlToText,
    parseJsonLdJobPosting,
    extractJobFromJsonLdText,
    extractJobFromDocument,
  });

  root.LysExtract = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
