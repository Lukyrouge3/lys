import { assertEquals } from "@std/assert";
import {
  expiryDate,
  isExpired,
  parseShareResponse,
  shareRequest,
} from "@/files/share.ts";

Deno.test("expiry dates are YYYY-MM-DD in UTC", () => {
  assertEquals(
    expiryDate(7, new Date("2026-11-17T12:00:00Z")),
    "2026-11-24",
  );
});

Deno.test("expiry dates roll over month and year boundaries", () => {
  assertEquals(
    expiryDate(1, new Date("2026-12-31T23:00:00Z")),
    "2027-01-01",
  );
});

Deno.test("link shares get an expiration date", () => {
  const request = shareRequest("Mail/invoice", "link", "lys", 7);
  assertEquals(request.shareType, 3);
  assertEquals(request.shareWith, undefined);
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(request.expireDate!), true);
});

Deno.test("link shares without days have no expiration date", () => {
  const request = shareRequest("Mail/invoice", "link", "lys");
  assertEquals("expireDate" in request, false);
});

Deno.test("user shares never get an expiration date", () => {
  const request = shareRequest("Mail/invoice", "user", "lys", 7);
  assertEquals(request.shareType, 0);
  assertEquals(request.shareWith, "lys");
  assertEquals("expireDate" in request, false);
});

Deno.test("a share without an expiration never expires", () => {
  assertEquals(isExpired(undefined), false);
});

Deno.test("a share expires at its date", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  assertEquals(isExpired("2026-11-16 00:00:00", now), true);
  assertEquals(isExpired("2026-11-18 00:00:00", now), false);
});

Deno.test("an unparseable expiration doesn't count as expired", () => {
  assertEquals(isExpired("not a date"), false);
});

Deno.test("the share response carries the expiration", () => {
  const result = parseShareResponse({
    ocs: {
      meta: { status: "ok" },
      data: {
        id: 42,
        url: "https://cloud.example/s/abc",
        expiration: "2026-11-24 00:00:00",
      },
    },
  });
  assertEquals(result.id, "42");
  assertEquals(result.expiration, "2026-11-24 00:00:00");
});
