import { assertEquals } from "@std/assert";
import {
  inQuietHours,
  resetQuietHoursWarningsForTests,
} from "@/utils/quietHours.ts";

const zurich = { timeZone: "Europe/Zurich" } as const;

function withEnv(
  values: Record<string, string>,
  run: () => void,
): void {
  const saved = Object.fromEntries(
    Object.keys(values).map((key) => [key, Deno.env.get(key)]),
  );
  try {
    for (const [key, value] of Object.entries(values)) Deno.env.set(key, value);
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

function countWarnings(run: () => void): number {
  const original = console.warn;
  let count = 0;
  console.warn = () => {
    count++;
  };
  try {
    run();
  } finally {
    console.warn = original;
  }
  return count;
}

Deno.test("the default window crosses midnight", () => {
  assertEquals(inQuietHours(new Date("2026-11-22T21:00:00Z"), zurich), true);
  assertEquals(inQuietHours(new Date("2026-11-22T23:30:00Z"), zurich), true);
  assertEquals(inQuietHours(new Date("2026-11-22T05:30:00Z"), zurich), true);
  assertEquals(inQuietHours(new Date("2026-11-22T06:00:00Z"), zurich), false);
  assertEquals(inQuietHours(new Date("2026-11-22T12:00:00Z"), zurich), false);
});

Deno.test("a same-day window does not wrap around", () => {
  const daytime = { start: "09:00", end: "17:00", ...zurich };
  assertEquals(inQuietHours(new Date("2026-11-22T08:00:00Z"), daytime), true);
  assertEquals(inQuietHours(new Date("2026-11-22T18:00:00Z"), daytime), false);
  assertEquals(inQuietHours(new Date("2026-11-22T06:59:00Z"), daytime), false);
});

Deno.test("the spring DST change moves the window with the wall clock", () => {
  // 2026-03-29: 02:00 CET becomes 03:00 CEST.
  assertEquals(inQuietHours(new Date("2026-03-29T00:30:00Z"), zurich), true);
  assertEquals(inQuietHours(new Date("2026-03-29T04:59:00Z"), zurich), true);
  assertEquals(inQuietHours(new Date("2026-03-29T05:00:00Z"), zurich), false);
  assertEquals(inQuietHours(new Date("2026-03-29T12:00:00Z"), zurich), false);
});

Deno.test("the autumn DST change moves the window too", () => {
  // 2026-10-25: 03:00 CEST becomes 02:00 CET.
  assertEquals(inQuietHours(new Date("2026-10-25T00:30:00Z"), zurich), true);
  assertEquals(inQuietHours(new Date("2026-10-25T05:30:00Z"), zurich), true);
  assertEquals(inQuietHours(new Date("2026-10-25T06:00:00Z"), zurich), false);
  assertEquals(inQuietHours(new Date("2026-10-25T12:00:00Z"), zurich), false);
});

Deno.test("env values are the defaults and cfg wins over them", () => {
  withEnv(
    { QUIET_START: "09:00", QUIET_END: "17:00", TZ: "Europe/Zurich" },
    () => {
      assertEquals(inQuietHours(new Date("2026-11-22T10:00:00Z")), true);
      assertEquals(inQuietHours(new Date("2026-11-22T18:00:00Z")), false);
      assertEquals(
        inQuietHours(new Date("2026-11-22T23:30:00Z"), {
          start: "22:00",
          end: "07:00",
          timeZone: "Europe/Zurich",
        }),
        true,
      );
    },
  );
});

Deno.test("an invalid start falls back to the default and warns once", () => {
  resetQuietHoursWarningsForTests();
  const cfg = { start: "25:00", timeZone: "Europe/Zurich" };
  const warnings = countWarnings(() => {
    assertEquals(inQuietHours(new Date("2026-11-22T23:30:00Z"), cfg), true);
    assertEquals(inQuietHours(new Date("2026-11-22T12:00:00Z"), cfg), false);
  });
  assertEquals(warnings, 1);
});

Deno.test("an invalid time zone falls back to Europe/Zurich and warns once", () => {
  resetQuietHoursWarningsForTests();
  const cfg = { timeZone: "Mars/Olympus" };
  const warnings = countWarnings(() => {
    assertEquals(inQuietHours(new Date("2026-11-22T23:30:00Z"), cfg), true);
    assertEquals(inQuietHours(new Date("2026-11-22T12:00:00Z"), cfg), false);
  });
  assertEquals(warnings, 1);
});

Deno.test("a window with no length is not quiet all day", () => {
  assertEquals(
    inQuietHours(new Date("2026-11-22T12:00:00Z"), {
      start: "08:00",
      end: "08:00",
      ...zurich,
    }),
    false,
  );
});
