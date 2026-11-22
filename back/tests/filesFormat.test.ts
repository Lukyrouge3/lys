import { assertEquals } from "@std/assert";
import {
  cleanForContext,
  formatEntry,
  formatPathEntry,
} from "@/files/format.ts";

const entry = {
  filename: "/Mail/a\nb.pdf",
  basename: "a\r\nb.pdf",
  lastmod: "Tue, 10 Nov 2026 12:00:00 GMT",
  size: 10,
  type: "file" as const,
};

Deno.test("control characters are stripped from names", () => {
  assertEquals(cleanForContext("a\nb\tc\x00d"), "a b c d");
});

Deno.test("a newline in a file name cannot forge an entry", () => {
  const line = formatEntry(entry);
  assertEquals(line.includes("\n"), false);
  assertEquals(line.includes("\r"), false);
});

Deno.test("a newline in a full path cannot forge an entry", () => {
  const line = formatPathEntry(entry);
  assertEquals(line.includes("\n"), false);
  assertEquals(line.includes("\r"), false);
});

Deno.test("a clean name is left alone", () => {
  assertEquals(
    formatEntry({
      ...entry,
      basename: "invoice.pdf",
      filename: "/Mail/invoice.pdf",
    }),
    "[file] 10 B  2026-11-10  invoice.pdf",
  );
});
