import { assertEquals, assertRejects } from "@std/assert";
import {
  createShare,
  deleteShare,
  expiryDate,
  isExpired,
  parseExpiration,
  parseShareResponse,
  shareRequest,
} from "@/files/share.ts";

const ENV_KEYS = [
  "NEXTCLOUD_URL",
  "NEXTCLOUD_USERNAME",
  "NEXTCLOUD_PASSWORD",
  "NEXTCLOUD_OWNER",
] as const;

function setShareEnv(): () => void {
  const previous = ENV_KEYS.map((key) => [key, Deno.env.get(key)] as const);
  Deno.env.set("NEXTCLOUD_URL", "https://cloud.example");
  Deno.env.set("NEXTCLOUD_USERNAME", "tester");
  Deno.env.set("NEXTCLOUD_PASSWORD", "secret");
  Deno.env.set("NEXTCLOUD_OWNER", "tester");
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  };
}

function fakeFetch(response: () => Response) {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(response());
  }) as typeof fetch;
  return {
    urls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function ocs(status: string, message?: string): Response {
  return new Response(
    JSON.stringify({ ocs: { meta: { status, statuscode: 200, message } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

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

Deno.test("Nextcloud expirations are parsed as UTC, not local time", () => {
  assertEquals(
    parseExpiration("2026-11-16 12:00:00")?.toISOString(),
    "2026-11-16T12:00:00.000Z",
  );
});

Deno.test("a share expires at its date", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  assertEquals(isExpired("2026-11-16 00:00:00", now), true);
  assertEquals(isExpired("2026-11-18 00:00:00", now), false);
  // A same-day expiration at 13:00 UTC is still in the future at noon
  assertEquals(isExpired("2026-11-17 13:00:00", now), false);
});

Deno.test("an unparseable expiration is treated as expired", () => {
  assertEquals(isExpired("not a date"), true);
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

Deno.test("createShare fails on OCS 200 with a failure meta", async () => {
  const restoreEnv = setShareEnv();
  const fake = fakeFetch(() => ocs("failure", "Path not found"));
  try {
    await assertRejects(
      () => createShare("Mail/invoice", "link", 7),
      Error,
      "Path not found",
    );
  } finally {
    fake.restore();
    restoreEnv();
  }
});

Deno.test("deleteShare fails on OCS 200 with a failure meta", async () => {
  const restoreEnv = setShareEnv();
  const fake = fakeFetch(() => ocs("failure", "Share not found"));
  try {
    await assertRejects(
      () => deleteShare("42"),
      Error,
      "Nextcloud refused to delete the share: Share not found",
    );
  } finally {
    fake.restore();
    restoreEnv();
  }
});

Deno.test("deleteShare succeeds on an ok meta", async () => {
  const restoreEnv = setShareEnv();
  const fake = fakeFetch(() => ocs("ok"));
  try {
    await deleteShare("42");
    assertEquals(fake.urls.length, 1);
    assertEquals(fake.urls[0].endsWith("/42?format=json"), true);
  } finally {
    fake.restore();
    restoreEnv();
  }
});

Deno.test("a remote error message cannot inject a new line", async () => {
  const restoreEnv = setShareEnv();
  const fake = fakeFetch(() => ocs("failure", "first line\nsecond line"));
  try {
    const err = await assertRejects(
      () => deleteShare("42"),
      Error,
      "first line second line",
    );
    assertEquals(err.message.includes("\n"), false);
  } finally {
    fake.restore();
    restoreEnv();
  }
});
