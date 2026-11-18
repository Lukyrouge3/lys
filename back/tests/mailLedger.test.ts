import { assertEquals } from "@std/assert";
import { categoryOf, rebasePath } from "@/mail/ledger.ts";

Deno.test("a moved file keeps its name under the new folder", () => {
  assertEquals(
    rebasePath(
      "Mail/2026/invoice/2026-11-17 Ana - bill.pdf",
      "Mail/2026/invoice/2026-11-17 Ana - bill.pdf",
      "Mail/2026/medical/2026-11-17 Ana - bill.pdf",
    ),
    "Mail/2026/medical/2026-11-17 Ana - bill.pdf",
  );
});

Deno.test("everything inside a moved folder follows it", () => {
  assertEquals(
    rebasePath(
      "Mail/2026/invoice/2026-11-17 Ana - bill.pdf",
      "Mail/2026/invoice",
      "Archive/invoice",
    ),
    "Archive/invoice/2026-11-17 Ana - bill.pdf",
  );
});

Deno.test("a path outside the move is left alone", () => {
  assertEquals(
    rebasePath("Mail/2026/travel/ticket.pdf", "Mail/2026/invoice", "X"),
    null,
  );
});

Deno.test("a sibling with the same prefix is not part of the move", () => {
  assertEquals(
    rebasePath("Mail/2026/invoice-old/bill.pdf", "Mail/2026/invoice", "X"),
    null,
  );
});

Deno.test("the category follows a move between mail folders", () => {
  assertEquals(
    categoryOf("Mail/2026/medical/2026-11-17 Ana - bill.pdf"),
    "medical",
  );
});

Deno.test("a path outside the mail root has no category", () => {
  assertEquals(categoryOf("Downloads/2026/medical/bill.pdf"), null);
  assertEquals(categoryOf("Mail/2026/bill.pdf"), null);
  assertEquals(categoryOf("Mail/bill.pdf"), null);
});
