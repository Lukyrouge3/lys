/**
 * Background service worker. The worker performs the request to the local Lys
 * endpoint so the LinkedIn page never has to make a cross-origin/mixed-content
 * request itself.
 */
"use strict";

// Shared pure helpers (toast text, company fallback, response messages).
importScripts("protocol.js");

const protocol = globalThis.LysProtocol;

const DEFAULT_ENDPOINT = "http://127.0.0.1:8787";
const REQUEST_TIMEOUT_MS = 10000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "send-job") return false;

  if (sender.id && sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, status: 0, error: "config" });
    return false;
  }

  handleSend(message.job).then(sendResponse, () => {
    sendResponse({ ok: false, status: 0, error: "network" });
  });

  return true;
});

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      { endpoint: DEFAULT_ENDPOINT, token: "" },
      (items) => {
        if (chrome.runtime.lastError) {
          resolve({ endpoint: "", token: "" });
          return;
        }

        resolve({
          endpoint: normalizeEndpoint(items.endpoint),
          token: typeof items.token === "string" ? items.token.trim() : "",
        });
      },
    );
  });
}

function normalizeEndpoint(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function validEndpoint(endpoint) {
  if (!endpoint) return false;
  try {
    const parsed = new URL(endpoint);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function cleanString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function sanitizeJob(job) {
  if (!job || typeof job !== "object") return null;

  const externalId = cleanString(job.externalId, 100);
  const url = cleanString(job.url, 2000);
  const title = cleanString(job.title, 500);
  const company = protocol.companyForJob(cleanString(job.company, 500));
  const location = job.location == null
    ? null
    : cleanString(job.location, 500) || null;
  const description = cleanString(job.description, 20000);
  const postedAt = job.postedAt == null
    ? null
    : cleanString(job.postedAt, 100) || null;

  if (!/^\d+$/.test(externalId) || !url || !title || !description) {
    return null;
  }

  return {
    source: "linkedin",
    externalId,
    url,
    title,
    company,
    location,
    description,
    postedAt,
  };
}

async function parseResponseBody(response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return null;
  }

  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function handleSend(job) {
  const config = await getConfig();
  const endpoint = normalizeEndpoint(config.endpoint);

  if (!validEndpoint(endpoint) || !config.token) {
    return { ok: false, status: 0, error: "config" };
  }

  const body = sanitizeJob(job);
  if (!body) {
    return { ok: false, status: 0, error: "bad-job" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${endpoint}/jobs`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const data = await parseResponseBody(response);

    if (response.status === 200 || response.status === 201) {
      return {
        ok: true,
        status: response.status,
        duplicate: response.status === 200 ||
          Boolean(data && data.duplicate === true),
      };
    }

    return {
      ok: false,
      status: response.status,
      error: "http",
      message: protocol.responseErrorMessage(data),
    };
  } catch (error) {
    if (error && error.name === "AbortError") {
      return { ok: false, status: 0, error: "timeout" };
    }
    return { ok: false, status: 0, error: "network" };
  } finally {
    clearTimeout(timeout);
  }
}
