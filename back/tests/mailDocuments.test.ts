import { assertEquals } from "@std/assert";
import {
  documentPath,
  sanitizeName,
  senderLabel,
  sha256Hex,
} from "@/mail/documents.ts";

const mail = {
  from: "Torrenté Florian <florian@deneria.net>",
  date: new Date("2026-11-17T13:28:21Z"),
};

Deno.test("names lose characters a file system rejects", () => {
  assertEquals(sanitizeName('a/b:c*d?"e<f>g|h'), "a b c d e f g h");
  assertEquals(sanitizeName("  ..hidden..  "), "hidden");
  assertEquals(sanitizeName(""), "unknown");
});

Deno.test("names are cut to the limit", () => {
  assertEquals(sanitizeName("x".repeat(100), 10).length, 10);
});

Deno.test("accents and dots are folded for a filename", () => {
  assertEquals(sanitizeName("Torrenté"), "Torrente");
});

Deno.test("a display name is the sender label", () => {
  assertEquals(
    senderLabel("Torrenté Florian <florian@deneria.net>"),
    "Torrenté Florian",
  );
});

Deno.test("a bare address falls back to its domain", () => {
  assertEquals(senderLabel("florian@deneria.net"), "deneria");
});

Deno.test("an empty sender is unknown", () => {
  assertEquals(senderLabel(""), "unknown");
});

Deno.test("a document lands in year and category, named by date and sender", () => {
  assertEquals(
    documentPath(mail, "invoice", {
      filename: "invoice-0042.pdf",
      mime: "application/pdf",
    }),
    "Mail/2026/invoice/2026-11-17 Torrente Florian - invoice-0042.pdf",
  );
});

Deno.test("the extension comes from the MIME type when the name has none", () => {
  assertEquals(
    documentPath(mail, "travel", { filename: "ticket", mime: "image/jpeg" }),
    "Mail/2026/travel/2026-11-17 Torrente Florian - ticket.jpg",
  );
});

Deno.test("a suffix keeps colliding paths apart", () => {
  assertEquals(
    documentPath(
      mail,
      "other",
      { filename: "scan", mime: "application/pdf" },
      " 1234abcd",
    ),
    "Mail/2026/other/2026-11-17 Torrente Florian - scan 1234abcd.pdf",
  );
});

Deno.test("the hash is stable and hex", async () => {
  const hash = await sha256Hex(new TextEncoder().encode("hello"));
  assertEquals(
    hash,
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});
