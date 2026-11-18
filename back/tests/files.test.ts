import { assertEquals } from "@std/assert";
import { normalizeFolder, normalizePath } from "@/files/paths.ts";
import { readLimit } from "@/tools/files/readFile.ts";
import {
  entryPath,
  formatDate,
  formatEntry,
  formatPathEntry,
  formatSize,
} from "@/files/format.ts";

Deno.test("paths lose their leading and trailing slashes", () => {
  assertEquals(normalizePath(" /Mail/2026/ "), "Mail/2026");
});

Deno.test("an empty path is rejected", () => {
  let failed = false;
  try {
    normalizePath("");
  } catch {
    failed = true;
  }
  assertEquals(failed, true);
});

Deno.test("a path cannot walk up", () => {
  let failed = false;
  try {
    normalizePath("Mail/../../etc");
  } catch {
    failed = true;
  }
  assertEquals(failed, true);
});

Deno.test("an empty folder means the root", () => {
  assertEquals(normalizeFolder(undefined), "");
  assertEquals(normalizeFolder(""), "");
  assertEquals(normalizeFolder("/"), "");
  assertEquals(normalizeFolder(" Mail/2026/ "), "Mail/2026");
});

Deno.test("a non-text folder is rejected", () => {
  let failed = false;
  try {
    normalizeFolder(42);
  } catch {
    failed = true;
  }
  assertEquals(failed, true);
});

Deno.test("sizes are human readable", () => {
  assertEquals(formatSize(500), "500 B");
  assertEquals(formatSize(1024), "1.0 KB");
  assertEquals(formatSize(1536), "1.5 KB");
  assertEquals(formatSize(1024 * 1024), "1.0 MB");
});

Deno.test("dates become YYYY-MM-DD", () => {
  assertEquals(formatDate("Tue, 10 Nov 2026 12:00:00 GMT"), "2026-11-10");
  assertEquals(formatDate("not a date"), "unknown date");
  assertEquals(formatDate(undefined), "unknown date");
});

const file = {
  filename: "/Mail/2026/x.pdf",
  basename: "x.pdf",
  lastmod: "Tue, 10 Nov 2026 12:00:00 GMT",
  size: 2048,
  type: "file" as const,
  mime: "application/pdf",
};

Deno.test("a file entry shows its size and date", () => {
  assertEquals(formatEntry(file), "[file] 2.0 KB  2026-11-10  x.pdf");
});

Deno.test("a directory entry is marked as one", () => {
  assertEquals(
    formatEntry({ ...file, basename: "2026", type: "directory" }),
    "[dir]  2026",
  );
});

Deno.test("find results show the full path", () => {
  assertEquals(
    formatPathEntry(file),
    "[file] 2.0 KB  2026-11-10  Mail/2026/x.pdf",
  );
});

Deno.test("entry paths drop the leading slash", () => {
  assertEquals(entryPath(file), "Mail/2026/x.pdf");
});

Deno.test("read size scales with the context window", () => {
  assertEquals(readLimit(undefined), 8000);
  assertEquals(readLimit(8192), 8000);
  assertEquals(readLimit(65536), 39321);
  assertEquals(readLimit(200000), 120000);
});
