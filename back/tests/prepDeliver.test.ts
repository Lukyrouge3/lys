import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Job } from "@/generated/prisma/client.ts";
import {
  deliverApplication,
  type DeliveryDav,
  folderDate,
  renderNotes,
  slugify,
} from "@/prep/deliver.ts";
import type { PrepResult } from "@/prep/types.ts";

const NOW = new Date("2026-11-09T15:30:00Z");

function fakeDav() {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();

  const under = (path: string) =>
    [...files.keys(), ...dirs].some((key) => key.startsWith(`${path}/`));

  const dav = {
    files,
    dirs,
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
    getDirectoryContents: (path: string) => {
      const prefix = `${path}/`;
      const entries: Array<{ basename: string; type: "file" | "directory" }> =
        [];
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          entries.push({ basename: key.slice(prefix.length), type: "file" });
        }
      }
      for (const key of dirs) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          entries.push({
            basename: key.slice(prefix.length),
            type: "directory",
          });
        }
      }
      return Promise.resolve(entries);
    },
  };

  return {
    ...dav,
    asDelivery: () => dav as unknown as DeliveryDav,
    text: (path: string) => {
      const data = files.get(path);
      return data ? new TextDecoder().decode(data) : undefined;
    },
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    source: "linkedin",
    externalId: "ext-1",
    url: "https://example.test/jobs/1",
    title: "Product Engineer",
    company: "The Flex",
    location: "Biel/Bienne",
    description: "Build the product.",
    postedAt: null,
    rank: "apply",
    rankReason: "Strong match.",
    status: "queued",
    notifiedAt: null,
    inboxWrittenAt: null,
    prepFolder: null,
    preparedAt: null,
    prepAttempts: 0,
    prepNote: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function result(overrides: Partial<PrepResult> = {}): PrepResult {
  return {
    language: "en",
    notes: "## Selection\n\nExperience rows 1 and 2.",
    cvTyp: "CV SOURCE",
    coverTyp: "COVER SOURCE",
    cvPdf: new TextEncoder().encode("%PDF cv"),
    coverPdf: new TextEncoder().encode("%PDF cover"),
    status: "ready",
    gaps: [],
    ...overrides,
  };
}

Deno.test("deliver: folder names, accents and every file", async () => {
  const dav = fakeDav();
  const { folder } = await deliverApplication(
    job({ company: "École 42 Lausanne", title: "Développeur" }),
    result(),
    { dav: dav.asDelivery(), now: NOW },
  );

  assertEquals(folder, "Postulations/ecole-42-lausanne/2026-11-09");
  assertEquals(
    dav.text(`${folder}/job.md`)?.includes("École 42 Lausanne"),
    true,
  );
  assertEquals(
    dav.text(`${folder}/notes.md`),
    "## Selection\n\nExperience rows 1 and 2.\n",
  );
  assertEquals(dav.text(`${folder}/cv-en.typ`), "CV SOURCE");
  assertEquals(dav.text(`${folder}/cover-en.typ`), "COVER SOURCE");
  assert(dav.files.has(`${folder}/cv-en.pdf`));
  assert(dav.files.has(`${folder}/cover-en.pdf`));
});

Deno.test("deliver: a second application the same day gets a role suffix", async () => {
  const dav = fakeDav();
  const asDelivery = dav.asDelivery();

  const first = await deliverApplication(
    job({ title: "Engineer" }),
    result(),
    { dav: asDelivery, now: NOW },
  );
  assertEquals(first.folder, "Postulations/the-flex/2026-11-09");

  const second = await deliverApplication(
    job({ title: "Designer" }),
    result(),
    { dav: asDelivery, now: NOW },
  );
  assertEquals(second.folder, "Postulations/the-flex/2026-11-09-designer");

  const third = await deliverApplication(
    job({ title: "Designer" }),
    result(),
    { dav: asDelivery, now: NOW },
  );
  assertEquals(third.folder, "Postulations/the-flex/2026-11-09-designer-2");
});

Deno.test("deliver: an occupied folder is never overwritten", async () => {
  const dav = fakeDav();
  const oldFolder = "Postulations/the-flex/2026-11-09";
  dav.dirs.add(oldFolder);
  dav.files.set(
    `${oldFolder}/notes.md`,
    new TextEncoder().encode("OLD NOTES"),
  );

  const { folder } = await deliverApplication(job(), result(), {
    dav: dav.asDelivery(),
    now: NOW,
  });

  assertEquals(folder, "Postulations/the-flex/2026-11-09-product-engineer");
  assertEquals(dav.text(`${oldFolder}/notes.md`), "OLD NOTES");
  assertEquals(dav.text(`${folder}/notes.md`), result().notes + "\n");
});

Deno.test("deliver: review notes lead with the gaps and mention missing PDFs", async () => {
  const dav = fakeDav();
  const review = result({
    status: "review",
    gaps: ["cv: the source does not compile", "cover: the name is missing"],
    cvPdf: new Uint8Array(),
  });

  const { folder } = await deliverApplication(job(), review, {
    dav: dav.asDelivery(),
    now: NOW,
  });

  const notes = dav.text(`${folder}/notes.md`) ?? "";
  assertStringIncludes(notes, "# REVIEW NEEDED");
  assertStringIncludes(notes, "- cv: the source does not compile");
  assertStringIncludes(notes, "- cover: the name is missing");
  assertStringIncludes(notes, "The cv PDF is missing");
  assert(!dav.files.has(`${folder}/cv-en.pdf`));
  assert(dav.files.has(`${folder}/cover-en.pdf`));
  assertStringIncludes(notes, "## Selection");
});

Deno.test("deliver: the review block can be rendered on its own", () => {
  const notes = renderNotes(
    result({ status: "review", gaps: ["one gap"] }),
    ["cover"],
  );
  assertStringIncludes(notes, "REVIEW NEEDED");
  assertStringIncludes(notes, "- one gap");
  assertEquals(notes.endsWith("\n"), true);
});

Deno.test("deliver: slugs and dates are stable", () => {
  assertEquals(slugify("Junior 42 Lausanne"), "junior-42-lausanne");
  assertEquals(slugify("IMÄ Méd-Tech"), "ima-med-tech");
  assertEquals(folderDate(new Date("2026-01-02T23:59:00Z")), "2026-01-02");
});
