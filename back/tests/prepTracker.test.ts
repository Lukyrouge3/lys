import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  applyEntry,
  assertNotShrinking,
  folderOfCell,
  parseTracker,
  renderTracker,
  statusToTracker,
  TRACKER_BACKUP_PATH,
  TRACKER_PATH,
  type TrackerDav,
  type TrackerEntry,
  upsertTrackerRow,
} from "@/prep/tracker.ts";

// The owner's real format, taken from AGENTS.md, plus a Closed section so the
// preservation test covers non-table content too.
const REAL = `# Applications

| Applied | Company | Role | Status | Folder | Next |
| --- | --- | --- | --- | --- | --- |
| 2026-11-09 | The Flex | Product Engineer (Base360.ai) | Drafted | [the-flex/2026-11-09](./the-flex/2026-11-09/) | Review, then send |

## Closed

| Applied | Company | Role | Status | Folder | Next |
| --- | --- | --- | --- | --- | --- |
| ? | Old Co | Developer | Archived | — | — |
`;

function fakeDav(initial: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(initial)) {
    files.set(path, new TextEncoder().encode(content));
  }
  const dirs = new Set<string>(["Postulations"]);

  const under = (path: string) =>
    [...files.keys(), ...dirs].some((key) => key.startsWith(`${path}/`));

  const dav = {
    files,
    exists: (path: string) =>
      Promise.resolve(files.has(path) || dirs.has(path) || under(path)),
    createDirectory: (path: string) => {
      dirs.add(path);
      return Promise.resolve();
    },
    putFileContents: (
      path: string,
      data: ArrayBuffer,
      options?: { overwrite?: boolean },
    ) => {
      if (files.has(path) && !options?.overwrite) {
        return Promise.reject(new Error(`refusing to overwrite ${path}`));
      }
      files.set(path, new Uint8Array(data));
      return Promise.resolve(true);
    },
    getFileContents: (path: string) => {
      const data = files.get(path);
      if (!data) return Promise.reject(new Error(`no file ${path}`));
      return Promise.resolve(new TextDecoder().decode(data));
    },
  };

  return {
    files,
    dav: dav as unknown as TrackerDav,
    text: (path: string) => {
      const data = files.get(path);
      return data ? new TextDecoder().decode(data) : undefined;
    },
  };
}

function entry(overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    applied: "2026-11-10",
    company: "New Co",
    role: "Developer",
    status: "Drafted",
    folder: "new-co/2026-11-10",
    next: "Review, then send",
    ...overrides,
  };
}

Deno.test("tracker: the real example round-trips byte for byte", () => {
  const parsed = parseTracker(REAL);
  assert(parsed);
  assertEquals(renderTracker(parsed), REAL);
  assertEquals(parsed.rows.length, 1);
  assertEquals(parsed.rows[0].cells[1], "The Flex");
});

Deno.test("tracker: a new row is inserted at the top and sections are kept", async () => {
  const db = fakeDav({ [TRACKER_PATH]: REAL });

  const result = await upsertTrackerRow(entry(), { dav: db.dav });

  assertEquals(result.inserted, true);
  assertEquals(result.rows, 2);

  const text = db.text(TRACKER_PATH) ?? "";
  assertStringIncludes(text, "| 2026-11-10 | New Co | Developer |");
  assertStringIncludes(text, "[new-co/2026-11-10](./new-co/2026-11-10/)");
  assertStringIncludes(text, "| 2026-11-09 | The Flex |");
  // The Closed section is untouched, including its backlog row.
  assertStringIncludes(
    text,
    "## Closed\n\n| Applied | Company | Role | Status | Folder | Next |",
  );
  assertStringIncludes(text, "| ? | Old Co | Developer | Archived | — | — |");

  const parsed = parseTracker(text);
  assert(parsed);
  assertEquals(parsed.rows[0].cells[1], "New Co");
});

Deno.test("tracker: the row whose folder matches is updated", async () => {
  const db = fakeDav({ [TRACKER_PATH]: REAL });

  const result = await upsertTrackerRow(
    entry({
      applied: "2026-11-09",
      company: "The Flex",
      role: "Product Engineer (Base360.ai)",
      status: "Sent",
      folder: "Postulations/the-flex/2026-11-09",
      next: "",
    }),
    { dav: db.dav },
  );

  assertEquals(result.inserted, false);
  assertEquals(result.rows, 1);

  const parsed = parseTracker(db.text(TRACKER_PATH) ?? "");
  assert(parsed);
  assertEquals(parsed.rows[0].cells[3], "Sent");
  assertEquals(parsed.rows[0].cells[5], "");
  assertEquals(parsed.rows[0].cells[1], "The Flex");
});

Deno.test("tracker: pipes in text are escaped and read back", async () => {
  const db = fakeDav({ [TRACKER_PATH]: REAL });

  await upsertTrackerRow(
    entry({ company: "A|B", role: "Dev | Ops", next: "Ask | wait" }),
    { dav: db.dav },
  );

  const text = db.text(TRACKER_PATH) ?? "";
  assertStringIncludes(text, "| A\\|B | Dev \\| Ops |");
  const parsed = parseTracker(text);
  assert(parsed);
  assertEquals(parsed.rows[0].cells[1], "A|B");
  assertEquals(parsed.rows[0].cells[2], "Dev | Ops");
  assertEquals(renderTracker(parsed), text);
});

Deno.test("tracker: a shrinking table is refused", () => {
  const parsed = parseTracker(REAL);
  assert(parsed);

  const shrunk = parseTracker(
    "| Applied | Company | Role | Status | Folder | Next |\n| --- | --- | --- | --- | --- | --- |\n",
  );
  assert(shrunk);
  assertThrows(
    () => assertNotShrinking(parsed, shrunk),
    Error,
    "refusing to write a table with fewer rows",
  );
});

Deno.test("tracker: the previous file is copied to .bak", async () => {
  const db = fakeDav({ [TRACKER_PATH]: REAL });

  await upsertTrackerRow(entry(), { dav: db.dav });

  assertEquals(db.text(TRACKER_BACKUP_PATH), REAL);
});

Deno.test("tracker: concurrent updates are serialised, not lost", async () => {
  const db = fakeDav({ [TRACKER_PATH]: REAL });
  const original = db.dav.getFileContents.bind(db.dav);
  let reads = 0;

  // Widen the read-modify-write window so an unguarded pair would collide.
  const slow = new Proxy(db.dav, {
    get(target, key, receiver) {
      if (key === "getFileContents") {
        return async (...args: [string, { format?: string }?]) => {
          reads += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await original(...args);
        };
      }
      return Reflect.get(target, key, receiver);
    },
  }) as TrackerDav;

  const [first, second] = await Promise.all([
    upsertTrackerRow(
      entry({ company: "First Co", folder: "first/2026-11-10" }),
      {
        dav: slow,
      },
    ),
    upsertTrackerRow(
      entry({ company: "Second Co", folder: "second/2026-11-10" }),
      {
        dav: slow,
      },
    ),
  ]);

  assertEquals(first.rows, 2);
  assertEquals(second.rows, 3);
  assertEquals(reads, 2);

  const text = db.text(TRACKER_PATH) ?? "";
  assertStringIncludes(text, "First Co");
  assertStringIncludes(text, "Second Co");
  assertStringIncludes(text, "The Flex");
});

Deno.test("tracker: a missing file is created with the header", async () => {
  const db = fakeDav();

  await upsertTrackerRow(entry(), { dav: db.dav });

  const text = db.text(TRACKER_PATH) ?? "";
  assertEquals(
    text,
    `# Applications

| Applied | Company | Role | Status | Folder | Next |
| --- | --- | --- | --- | --- | --- |
| 2026-11-10 | New Co | Developer | Drafted | [new-co/2026-11-10](./new-co/2026-11-10/) | Review, then send |
`,
  );
  assertEquals(db.text(TRACKER_BACKUP_PATH), undefined);
});

Deno.test("tracker: an unparseable existing file is not overwritten", async () => {
  const db = fakeDav({ [TRACKER_PATH]: "just a note\n" });

  let failed = false;
  try {
    await upsertTrackerRow(entry(), { dav: db.dav });
  } catch (err) {
    failed = true;
    assertStringIncludes(String(err), "refusing to rewrite");
  }

  assertEquals(failed, true);
  assertEquals(db.text(TRACKER_PATH), "just a note\n");
});

Deno.test("tracker: status vocabulary", () => {
  assertEquals(statusToTracker("ready"), {
    status: "Drafted",
    next: "Review, then send",
  });
  assertEquals(statusToTracker("review", 2), {
    status: "Drafted",
    next: "Needs review: 2 gaps, see notes.md",
  });
  assertEquals(
    statusToTracker("review", 1).next,
    "Needs review: 1 gap, see notes.md",
  );
  assertEquals(statusToTracker("applied").status, "Sent");
  assertEquals(statusToTracker("interview").status, "Interview");
  assertEquals(statusToTracker("rejected").status, "Rejected");
  assertEquals(statusToTracker("dropped").status, "Withdrawn");
});

Deno.test("tracker: folder cells are read and inserted in the owner's shape", () => {
  assertEquals(
    folderOfCell("[the-flex/2026-11-09](./the-flex/2026-11-09/)"),
    "the-flex/2026-11-09",
  );
  assertEquals(
    folderOfCell("[x](/Postulations/x/2026-11-09/)"),
    "x/2026-11-09",
  );
  assertEquals(folderOfCell("—"), null);
  assertEquals(folderOfCell(""), null);

  const rows = applyEntry([], entry());
  assertEquals(rows.inserted, true);
  assertEquals(
    rows.rows[0].raw,
    "| 2026-11-10 | New Co | Developer | Drafted | [new-co/2026-11-10](./new-co/2026-11-10/) | Review, then send |",
  );
});
