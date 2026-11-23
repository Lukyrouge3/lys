import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  bundleApplication,
  type BundleDav,
  DEFAULT_ATTACHMENTS_FOLDER,
  naturalCompare,
} from "@/prep/bundle.ts";
import type { MergeResult } from "@/prep/merge.ts";

const encoder = new TextEncoder();
const FOLDER = "Postulations/acme/2026-11-09";

function fakeDav(seed: Record<string, Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(seed));
  const dirs = new Set<string>();
  const created: string[] = [];
  const puts: { path: string; overwrite?: boolean }[] = [];

  const under = (path: string) =>
    [...files.keys(), ...dirs].some((key) => key.startsWith(`${path}/`));

  const dav = {
    files,
    dirs,
    created,
    puts,
    exists: (path: string) =>
      Promise.resolve(files.has(path) || dirs.has(path) || under(path)),
    createDirectory: (path: string) => {
      created.push(path);
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
      puts.push({ path, overwrite: options?.overwrite });
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
    getFileContents: (path: string) => {
      const data = files.get(path);
      return data
        ? Promise.resolve(data)
        : Promise.reject(new Error("missing"));
    },
  };

  return { ...dav, asBundle: () => dav as unknown as BundleDav };
}

function fakeMerge(seen: string[], result?: Partial<MergeResult>) {
  return (parts: { name: string }[]): Promise<MergeResult> => {
    seen.push(...parts.map((part) => part.name));
    return Promise.resolve({
      pdf: encoder.encode("%PDF-MERGED"),
      skipped: [],
      ...result,
    });
  };
}

function seedApplication(dav: ReturnType<typeof fakeDav>): void {
  dav.files.set(`${FOLDER}/cv-en.pdf`, encoder.encode("%PDF-CV"));
  dav.files.set(`${FOLDER}/cover-en.pdf`, encoder.encode("%PDF-COVER"));
}

Deno.test("bundle: CV, cover letter, then attachments in natural order", async () => {
  const dav = fakeDav();
  seedApplication(dav);
  dav.dirs.add(DEFAULT_ATTACHMENTS_FOLDER);
  dav.files.set(
    `${DEFAULT_ATTACHMENTS_FOLDER}/10-z.pdf`,
    encoder.encode("%PDF-10"),
  );
  dav.files.set(
    `${DEFAULT_ATTACHMENTS_FOLDER}/2-y.pdf`,
    encoder.encode("%PDF-2"),
  );
  dav.files.set(
    `${DEFAULT_ATTACHMENTS_FOLDER}/01-x.pdf`,
    encoder.encode("%PDF-01"),
  );
  dav.files.set(
    `${DEFAULT_ATTACHMENTS_FOLDER}/notes.txt`,
    encoder.encode("not a pdf"),
  );

  const seen: string[] = [];
  const result = await bundleApplication(FOLDER, {
    dav: dav.asBundle(),
    merge: fakeMerge(seen),
    pageCount: () => Promise.resolve(4),
  });

  assertEquals(result.parts, [
    "cv-en.pdf",
    "cover-en.pdf",
    "01-x.pdf",
    "2-y.pdf",
    "10-z.pdf",
  ]);
  assertEquals(seen, result.parts);
  assertEquals(result.skipped, []);
  assertEquals(result.pages, 4);
  assertEquals(result.path, `${FOLDER}/application.pdf`);
  assertEquals(
    new TextDecoder().decode(dav.files.get(`${FOLDER}/application.pdf`)),
    "%PDF-MERGED",
  );
  assertEquals(dav.puts, [{
    path: `${FOLDER}/application.pdf`,
    overwrite: true,
  }]);
  assert(!result.parts.includes("notes.txt"));
});

Deno.test("bundle: missing cover and missing CV are readable errors", async () => {
  const dav = fakeDav();
  dav.files.set(`${FOLDER}/cv-en.pdf`, encoder.encode("%PDF-CV"));

  const noCover = await assertRejects(
    () =>
      bundleApplication(FOLDER, {
        dav: dav.asBundle(),
        merge: fakeMerge([]),
        pageCount: () => Promise.resolve(1),
      }),
    Error,
  );
  assertStringIncludes(noCover.message, "cover letter PDF");
  assertStringIncludes(noCover.message, "cover-<lang>.pdf");

  dav.files.delete(`${FOLDER}/cv-en.pdf`);
  dav.files.set(`${FOLDER}/cover-en.pdf`, encoder.encode("%PDF-COVER"));
  const noCv = await assertRejects(
    () =>
      bundleApplication(FOLDER, {
        dav: dav.asBundle(),
        merge: fakeMerge([]),
        pageCount: () => Promise.resolve(1),
      }),
    Error,
  );
  assertStringIncludes(noCv.message, "CV PDF");
});

Deno.test("bundle: an empty CV is a readable error", async () => {
  const dav = fakeDav();
  dav.files.set(`${FOLDER}/cv-en.pdf`, new Uint8Array());
  dav.files.set(`${FOLDER}/cover-en.pdf`, encoder.encode("%PDF-COVER"));

  const error = await assertRejects(
    () =>
      bundleApplication(FOLDER, {
        dav: dav.asBundle(),
        merge: fakeMerge([]),
        pageCount: () => Promise.resolve(1),
      }),
    Error,
  );
  assertStringIncludes(error.message, "CV PDF is empty");
});

Deno.test("bundle: a missing attachments folder is created and stays empty", async () => {
  const dav = fakeDav();
  seedApplication(dav);

  const result = await bundleApplication(FOLDER, {
    dav: dav.asBundle(),
    merge: fakeMerge([]),
    pageCount: () => Promise.resolve(2),
  });

  assertEquals(dav.created, [DEFAULT_ATTACHMENTS_FOLDER]);
  assertEquals(result.parts, ["cv-en.pdf", "cover-en.pdf"]);
  assertEquals(result.skipped, []);
  assertEquals(result.pages, 2);
});

Deno.test("bundle: re-bundling overwrites application.pdf", async () => {
  const dav = fakeDav();
  seedApplication(dav);
  dav.files.set(`${FOLDER}/application.pdf`, encoder.encode("OLD"));

  const result = await bundleApplication(FOLDER, {
    dav: dav.asBundle(),
    merge: () =>
      Promise.resolve({
        pdf: encoder.encode("%PDF-NEW"),
        skipped: [],
      }),
    pageCount: () => Promise.resolve(2),
  });

  assertEquals(
    new TextDecoder().decode(dav.files.get(result.path)),
    "%PDF-NEW",
  );
  assertEquals(dav.puts.at(-1)?.overwrite, true);
});

Deno.test("bundle: merge skips are reported with their reason", async () => {
  const dav = fakeDav();
  seedApplication(dav);
  dav.dirs.add(DEFAULT_ATTACHMENTS_FOLDER);
  dav.files.set(
    `${DEFAULT_ATTACHMENTS_FOLDER}/broken.pdf`,
    encoder.encode("not a pdf"),
  );

  const result = await bundleApplication(FOLDER, {
    dav: dav.asBundle(),
    merge: fakeMerge([], {
      skipped: [{ name: "broken.pdf", reason: "not a PDF" }],
    }),
    pageCount: () => Promise.resolve(2),
  });

  assertEquals(result.parts, ["cv-en.pdf", "cover-en.pdf", "broken.pdf"]);
  assertEquals(result.skipped, [{ name: "broken.pdf", reason: "not a PDF" }]);
});

Deno.test("bundle: natural ordering puts 01 before 2 before 10", () => {
  const names = ["10-z.pdf", "2-y.pdf", "01-x.pdf"];
  assertEquals(names.sort(naturalCompare), [
    "01-x.pdf",
    "2-y.pdf",
    "10-z.pdf",
  ]);
  assert(naturalCompare("a2.pdf", "a10.pdf") < 0);
  assertEquals(naturalCompare("Same.PDF", "same.pdf"), 0);
});
