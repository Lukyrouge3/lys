/**
 * Content script: a single explicit "Send to Lys" button on LinkedIn jobs
 * pages. It never records automatically and never navigates or clicks on
 * LinkedIn's behalf.
 */
(function () {
  "use strict";

  const api = globalThis.LysExtract;
  if (!api) return;

  const HOST_ID = "lys-send-to-lys-host";
  const TOAST_DURATION_MS = 5000;

  let host = null;
  let button = null;
  let toast = null;
  let toastTimer = 0;
  let sending = false;
  let lastUrl = "";
  let refreshScheduled = false;

  function buildUi() {
    if (host) return;

    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.right = "20px";
    host.style.bottom = "20px";
    host.style.zIndex = "2147483647";
    host.style.display = "block";

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          color-scheme: light;
        }
        button {
          all: initial;
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 118px;
          border: 0;
          border-radius: 999px;
          padding: 12px 18px;
          background: #0a66c2;
          color: #fff;
          font: 600 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
          cursor: pointer;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
          transition: background 0.15s ease, transform 0.15s ease, opacity 0.15s ease;
        }
        button:hover:not(:disabled) {
          background: #004182;
          transform: translateY(-1px);
        }
        button:active:not(:disabled) {
          transform: translateY(0);
        }
        button:focus-visible {
          outline: 3px solid #f5c26b;
          outline-offset: 2px;
        }
        button:disabled {
          background: #5f6b7a;
          color: #fff;
          opacity: 0.75;
          cursor: not-allowed;
          box-shadow: none;
        }
        button[data-sending="true"] {
          opacity: 0.85;
          cursor: wait;
        }
        .lys-toast {
          all: initial;
          position: absolute;
          right: 0;
          bottom: calc(100% + 10px);
          box-sizing: border-box;
          max-width: 320px;
          border: 1px solid #d0d7de;
          border-radius: 10px;
          padding: 10px 12px;
          background: #fff;
          color: #1f2328;
          font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
          box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
          opacity: 0;
          transform: translateY(6px);
          pointer-events: none;
          transition: opacity 0.15s ease, transform 0.15s ease;
          white-space: normal;
          overflow-wrap: anywhere;
        }
        .lys-toast.show {
          opacity: 1;
          transform: translateY(0);
        }
        .lys-toast.success {
          border-color: #1a7f37;
          background: #edfcf1;
          color: #0f5323;
        }
        .lys-toast.error {
          border-color: #cf222e;
          background: #fff0f1;
          color: #7d0a14;
        }
        .lys-toast.info {
          border-color: #0969da;
          background: #f0f7ff;
          color: #0a3069;
        }
      </style>
      <button type="button" aria-label="Send this job to Lys">Send to Lys</button>
      <div class="lys-toast" role="status" aria-live="polite" aria-hidden="true"></div>
    `;

    button = shadow.querySelector("button");
    toast = shadow.querySelector(".lys-toast");
    button.addEventListener("click", onSendClick);
  }

  function ensureUi() {
    buildUi();
    if (!host.isConnected) {
      const parent = document.body || document.documentElement;
      if (parent) parent.appendChild(host);
    }
  }

  function isJobsPage() {
    return /^\/jobs(?:\/|$)/.test(location.pathname);
  }

  function setButtonState(text, disabled, title) {
    if (!button) return;
    button.textContent = text;
    button.disabled = disabled;
    button.title = title;
    button.setAttribute("aria-label", title);
  }

  function updateButton() {
    if (!host || !button) return;

    if (!isJobsPage()) {
      host.style.display = "none";
      return;
    }
    host.style.display = "block";

    if (sending) {
      button.dataset.sending = "true";
      setButtonState(
        "Sending\u2026",
        true,
        "Sending this job to Lys\u2026",
      );
      return;
    }

    button.dataset.sending = "false";
    const hasJob = Boolean(api.extractJobId(location.href));
    if (hasJob) {
      setButtonState(
        "Send to Lys",
        false,
        "Send this LinkedIn job to Lys",
      );
    } else {
      setButtonState(
        "No job detected",
        true,
        "Open a LinkedIn job to send it to Lys",
      );
    }
  }

  function showToast(message, kind) {
    if (!toast) return;

    toast.textContent = message;
    toast.className = `lys-toast show ${kind || "info"}`.trim();
    toast.setAttribute("aria-hidden", "false");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.className = "lys-toast";
      toast.setAttribute("aria-hidden", "true");
    }, TOAST_DURATION_MS);
  }

  function sendJob(job) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "send-job", job }, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function handleResponse(response) {
    if (!response) {
      showToast("Lys gave an unexpected response.", "error");
      return;
    }

    if (response.ok) {
      showToast(
        response.duplicate ? "Already in Lys" : "Sent to Lys",
        "success",
      );
      return;
    }

    if (response.error === "config") {
      showToast("Check token/endpoint in options", "error");
      return;
    }

    if (response.error === "network" || response.error === "timeout") {
      showToast(
        "Lys not reachable (is the SSH tunnel up?)",
        "error",
      );
      return;
    }

    if (response.status === 400 || response.status === 401) {
      showToast("Check token/endpoint in options", "error");
      return;
    }

    if (response.status) {
      showToast(`Lys returned HTTP ${response.status}.`, "error");
      return;
    }

    showToast("Lys gave an unexpected response.", "error");
  }

  function onSendClick(event) {
    event.preventDefault();
    if (sending) return;

    ensureUi();
    updateButton();

    if (!api.extractJobId(location.href)) {
      showToast("No job detected on this page.", "error");
      return;
    }

    let result;
    try {
      result = api.extractJobFromDocument(document, location.href);
    } catch {
      showToast("Could not read this job page.", "error");
      return;
    }

    if (!result.ok) {
      showToast(result.error || "Could not read this job page.", "error");
      return;
    }

    sending = true;
    updateButton();

    sendJob(result.job)
      .then(handleResponse)
      .catch(() => {
        showToast(
          "Lys not reachable (is the SSH tunnel up?)",
          "error",
        );
      })
      .finally(() => {
        sending = false;
        updateButton();
      });
  }

  function refresh() {
    ensureUi();
    updateButton();
  }

  function onUrlMaybeChanged() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    refresh();
  }

  function scheduleRefresh() {
    if (refreshScheduled) return;
    refreshScheduled = true;

    queueMicrotask(() => {
      refreshScheduled = false;
      if (!host || !host.isConnected) ensureUi();
      onUrlMaybeChanged();
    });
  }

  function init() {
    ensureUi();
    lastUrl = location.href;
    updateButton();

    const root = document.documentElement;
    if (root) {
      const observer = new MutationObserver(scheduleRefresh);
      observer.observe(root, { childList: true, subtree: true });
    }

    addEventListener("popstate", onUrlMaybeChanged);
    addEventListener("hashchange", onUrlMaybeChanged);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
