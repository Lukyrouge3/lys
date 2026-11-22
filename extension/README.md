# Send to Lys

A tiny Manifest V3 extension that adds a **Send to Lys** button to LinkedIn job
pages. Clicking it sends the job you are currently viewing to a local Lys bot.

## Load it

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this `extension/` directory.
4. Open the extension's **Options** page, set the endpoint (default
   `http://127.0.0.1:8787`) and the bearer token, then click **Save**.
5. Use **Test connection** to check `GET /health`.

The endpoint is reached through an SSH tunnel, for example:

```sh
ssh -N -L 8787:127.0.0.1:8787 <server>
```

## What is captured

Only after an explicit click, and only from the page already rendered in the
current tab:

- `source`: always `"linkedin"`
- `externalId`: from `/jobs/view/<id>`, `/jobs/view/<slug>-<id>` or
  `?currentJobId=<id>`
- `url`: `https://www.linkedin.com/jobs/view/<id>/`
- `title`, `company`, `location`, `description`, `postedAt`

The extension prefers the page's JSON-LD `JobPosting` block and falls back to
CSS selectors in the rendered job detail pane. Descriptions are converted to
plain text, trimmed, and capped at 20,000 characters. If the title or
description cannot be found, the extension refuses to send and reports which
field is missing.

The background service worker performs the `POST {endpoint}/jobs` request, so
the LinkedIn page never has to make a cross-origin or mixed-content request. The
token is read from `chrome.storage.local` and is never logged.

## What it does NOT do

- No automatic recording or auto-sending.
- No background scraping, polling of job data, or reading hidden/private APIs.
- No clicking, scrolling, or navigating LinkedIn on your behalf.
- No remote code, analytics, or third-party services.
- It does not bypass LinkedIn's terms or access controls.

## When extraction breaks

LinkedIn changes its markup often. The fallback selectors are in **one place**:
`JOB_DETAIL_SELECTORS` at the top of `extract.js`. Inspect the job detail pane
in DevTools, update the alternatives there, and reload the extension. The
JSON-LD path usually keeps working even when class names change.

## Tests

```sh
cd extension
deno test *.test.mjs
deno fmt --check .
deno lint
```

(Deno 2.9 no longer accepts `--allow-none`; the test command above needs no
permissions.)

The tests cover the pure functions only: job-id parsing, JSON-LD parsing,
HTML-to-text conversion, field validation, and description capping. Live
LinkedIn DOM extraction has **not** been verified here because no LinkedIn login
is available in this environment.

## Firefox note

The manifest uses a Chrome MV3 background service worker. The rest of the
extension uses standard `chrome.*` APIs and should be straightforward to adapt
for Firefox if its MV3 background support differs in your version.
