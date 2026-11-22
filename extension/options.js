"use strict";

(function () {
  const DEFAULT_ENDPOINT = "http://127.0.0.1:8787";
  const HEALTH_TIMEOUT_MS = 8000;

  const form = document.getElementById("settings");
  const endpointInput = document.getElementById("endpoint");
  const tokenInput = document.getElementById("token");
  const testButton = document.getElementById("test");
  const status = document.getElementById("status");

  function setStatus(message, kind) {
    status.textContent = message;
    status.dataset.kind = kind || "";
  }

  function normalizeEndpoint(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function validEndpoint(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  function loadSettings() {
    chrome.storage.local.get(
      { endpoint: DEFAULT_ENDPOINT, token: "" },
      (items) => {
        if (chrome.runtime.lastError) {
          setStatus("Could not read saved settings.", "error");
          return;
        }

        endpointInput.value = normalizeEndpoint(items.endpoint) ||
          DEFAULT_ENDPOINT;
        tokenInput.value = typeof items.token === "string" ? items.token : "";
      },
    );
  }

  function saveSettings(event) {
    event.preventDefault();

    const endpoint = normalizeEndpoint(endpointInput.value);
    const token = tokenInput.value.trim();

    if (!validEndpoint(endpoint)) {
      setStatus("Enter an http:// or https:// endpoint.", "error");
      endpointInput.focus();
      return;
    }

    chrome.storage.local.set({ endpoint, token }, () => {
      if (chrome.runtime.lastError) {
        setStatus("Could not save settings.", "error");
        return;
      }

      endpointInput.value = endpoint;
      tokenInput.value = token;
      setStatus(
        token
          ? "Saved."
          : "Saved without a token. Sending will fail until you add one.",
        token ? "ok" : "warn",
      );
    });
  }

  async function testConnection() {
    const endpoint = normalizeEndpoint(endpointInput.value);

    if (!validEndpoint(endpoint)) {
      setStatus("Enter an http:// or https:// endpoint first.", "error");
      endpointInput.focus();
      return;
    }

    testButton.disabled = true;
    setStatus("Checking…", "");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    try {
      const response = await fetch(`${endpoint}/health`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });

      if (response.status === 200) {
        setStatus("Connected (HTTP 200).", "ok");
      } else {
        setStatus(`Health check returned HTTP ${response.status}.`, "error");
      }
    } catch (error) {
      if (error && error.name === "AbortError") {
        setStatus("Timed out waiting for Lys.", "error");
      } else {
        setStatus(
          "Could not reach Lys. Is the SSH tunnel up?",
          "error",
        );
      }
    } finally {
      clearTimeout(timeout);
      testButton.disabled = false;
    }
  }

  form.addEventListener("submit", saveSettings);
  testButton.addEventListener("click", testConnection);
  loadSettings();
})();
