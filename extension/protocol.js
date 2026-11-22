/**
 * Pure helpers shared by content.js and background.js: turning a failed send
 * into the exact toast text, spotting a stale extension context, and coercing
 * a missing company name.
 *
 * Loaded as a classic content script (before content.js) and via
 * importScripts() in the background service worker. It is also imported by
 * extract.test.mjs, so it must not touch chrome/document/window at import time.
 */
(function (root) {
  "use strict";

  const UNKNOWN_COMPANY = "Unknown company";
  const MAX_ERROR_MESSAGE_LENGTH = 200;

  const TOAST_STALE_CONTEXT =
    "The extension was reloaded: refresh this LinkedIn tab.";
  const TOAST_UNREACHABLE = "Lys not reachable (is the SSH tunnel up?)";
  const TOAST_CONFIG = "Set the endpoint and token in the extension options.";
  const TOAST_TOKEN =
    "Lys rejected the token. Paste the current one in options (and restart the bot if you rotated it).";
  const TOAST_UNEXPECTED = "Lys gave an unexpected response.";

  // Toasts are small, so server-supplied text is trimmed and capped.
  function clampErrorMessage(value) {
    if (typeof value !== "string") return "";
    return value.trim().slice(0, MAX_ERROR_MESSAGE_LENGTH);
  }

  // The jobs API answers errors as `{"error":"<message>"}`.
  function responseErrorMessage(data) {
    if (!data || typeof data !== "object") return "";
    return clampErrorMessage(data.error);
  }

  // The server rejects an empty company, so name it rather than drop the job.
  function companyForJob(company) {
    const trimmed = typeof company === "string" ? company.trim() : "";
    return trimmed || UNKNOWN_COMPANY;
  }

  // Chrome throws/assigns this message when a content script from before an
  // extension reload talks to the new, disconnected runtime.
  function isStaleContextError(error) {
    const message = typeof error === "string"
      ? error
      : error && typeof error.message === "string"
      ? error.message
      : "";
    return message.toLowerCase().includes("context invalidated");
  }

  function sendErrorToast(error) {
    return isStaleContextError(error) ? TOAST_STALE_CONTEXT : TOAST_UNREACHABLE;
  }

  // Toast text for a failed `send-job` response. Only network/timeout failures
  // and missing configuration are reported as "not reachable"/"set options";
  // HTTP answers carry the server's own explanation.
  function sendFailureToast(response) {
    if (!response) return TOAST_UNEXPECTED;
    if (response.error === "config") return TOAST_CONFIG;
    if (response.error === "network" || response.error === "timeout") {
      return TOAST_UNREACHABLE;
    }

    const detail = clampErrorMessage(response.message);
    const status = response.status;

    if (status === 401) return TOAST_TOKEN;
    if (status === 400) {
      return detail
        ? `Lys rejected the job: ${detail}`
        : "Lys rejected the job.";
    }
    if (status) {
      return detail
        ? `Lys returned HTTP ${status}: ${detail}`
        : `Lys returned HTTP ${status}.`;
    }
    return TOAST_UNEXPECTED;
  }

  const api = Object.freeze({
    UNKNOWN_COMPANY,
    MAX_ERROR_MESSAGE_LENGTH,
    TOAST_CONFIG,
    TOAST_STALE_CONTEXT,
    TOAST_TOKEN,
    TOAST_UNEXPECTED,
    TOAST_UNREACHABLE,
    clampErrorMessage,
    responseErrorMessage,
    companyForJob,
    isStaleContextError,
    sendErrorToast,
    sendFailureToast,
  });

  root.LysProtocol = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
