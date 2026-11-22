import { assert, assertEquals } from "@std/assert";
import {
  CATCH_UP_MS,
  latestRunAt,
  missedRun,
  nextRunAt,
  parseAt,
  RETRY_MS,
  type RunStore,
  startDaily,
  zonedParts,
} from "@/scheduler/clock.ts";

const TZ = "Europe/Zurich";

function memoryStore(last: Date | null = null) {
  const state = { last, records: [] as Date[] };
  const store: RunStore = {
    readLastRun: () => Promise.resolve(state.last),
    recordRun: (_name, at) => {
      state.last = at;
      state.records.push(at);
      return Promise.resolve();
    },
  };
  return { state, store };
}

function fakeTime(start: string) {
  const state = { ms: new Date(start).getTime() };
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => new Date(state.ms),
    /** A macrotask, so `settle` can interleave with the loop. */
    sleep: (ms: number) => {
      sleeps.push(ms);
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

async function settle(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

Deno.test("nextRunAt stays on 07:30 local across the spring DST change", () => {
  // 2026-03-29: 02:00 CET becomes 03:00 CEST. The day is 23 hours long.
  const saturday = new Date("2026-03-28T06:30:00Z"); // 07:30 CET
  const sunday = nextRunAt(saturday, "07:30", TZ);
  assertEquals(sunday.toISOString(), "2026-03-29T05:30:00.000Z");
  assertEquals(sunday.getTime() - saturday.getTime(), 23 * 60 * 60 * 1000);

  // A few minutes before the run, still 07:30 local, now on CEST.
  assertEquals(
    nextRunAt(new Date("2026-03-29T00:00:00Z"), "07:30", TZ).toISOString(),
    "2026-03-29T05:30:00.000Z",
  );
});

Deno.test("nextRunAt stays on 07:30 local across the autumn DST change", () => {
  // 2026-10-25: 03:00 CEST becomes 02:00 CET. The day is 25 hours long.
  const saturday = new Date("2026-10-24T05:30:00Z"); // 07:30 CEST
  const sunday = nextRunAt(saturday, "07:30", TZ);
  assertEquals(sunday.toISOString(), "2026-10-25T06:30:00.000Z");
  assertEquals(sunday.getTime() - saturday.getTime(), 25 * 60 * 60 * 1000);

  assertEquals(
    latestRunAt(new Date("2026-10-25T12:00:00Z"), "07:30", TZ).toISOString(),
    "2026-10-25T06:30:00.000Z",
  );
});

Deno.test("nextRunAt is the next occurrence, never the current one", () => {
  assertEquals(
    nextRunAt(new Date("2026-11-22T04:00:00Z"), "07:30", TZ).toISOString(),
    "2026-11-22T06:30:00.000Z",
  );
  assertEquals(
    nextRunAt(new Date("2026-11-22T06:30:00Z"), "07:30", TZ).toISOString(),
    "2026-11-23T06:30:00.000Z",
  );
  assertEquals(
    nextRunAt(new Date("2026-11-22T23:30:00Z"), "07:30", TZ).toISOString(),
    "2026-11-23T06:30:00.000Z",
  );
});

Deno.test("zonedParts reads the zone, not the host clock", () => {
  const parts = zonedParts(new Date("2026-11-22T06:30:00Z"), TZ);
  assertEquals([parts.hour, parts.minute], [7, 30]);
  assertEquals([parts.year, parts.month, parts.day], [2026, 11, 22]);
});

Deno.test("a time of day is validated", () => {
  assertEquals(parseAt("07:30"), { hour: 7, minute: 30 });
  assertEquals(parseAt("7:05"), { hour: 7, minute: 5 });
  for (const bad of ["", "7", "25:00", "07:60", "morning"]) {
    let threw = false;
    try {
      parseAt(bad);
    } catch {
      threw = true;
    }
    assert(threw, `"${bad}" should be rejected`);
  }
});

Deno.test("a missed run catches up within three hours only", () => {
  const lastMorning = new Date("2026-11-21T06:30:00Z"); // yesterday 07:30 CET

  // Restart at 07:45: the latest 07:30 was missed.
  assertEquals(
    missedRun(lastMorning, new Date("2026-11-22T06:45:00Z"), "07:30", TZ)
      ?.toISOString(),
    "2026-11-22T06:30:00.000Z",
  );

  // Restart at 15:00: too late, the next run is tomorrow.
  assertEquals(
    missedRun(lastMorning, new Date("2026-11-22T14:00:00Z"), "07:30", TZ),
    null,
  );

  // Already ran today.
  assertEquals(
    missedRun(
      new Date("2026-11-22T06:31:00Z"),
      new Date("2026-11-22T06:45:00Z"),
      "07:30",
      TZ,
    ),
    null,
  );

  // Three hours after the scheduled time is still inside the window.
  assertEquals(
    missedRun(lastMorning, new Date("2026-11-22T09:30:00Z"), "07:30", TZ)
      ?.toISOString(),
    "2026-11-22T06:30:00.000Z",
  );
  assertEquals(
    missedRun(lastMorning, new Date("2026-11-22T09:31:00Z"), "07:30", TZ),
    null,
  );
  assertEquals(CATCH_UP_MS, 3 * 60 * 60 * 1000);
});

Deno.test({
  name: "startDaily catches up once after a restart",
  async fn() {
    const time = fakeTime("2026-11-22T06:45:00Z"); // 07:45 CET
    const { state, store } = memoryStore(
      new Date("2026-11-21T06:30:00Z"),
    );
    const lines: string[] = [];
    let runs = 0;

    const scheduler = startDaily({
      name: "morning",
      at: "07:30",
      tz: TZ,
      run: () => {
        runs += 1;
      },
      now: time.now,
      sleep: time.sleep,
      store,
      log: (line) => lines.push(line),
    });
    await settle();
    scheduler.stop();
    await settle(2);

    assertEquals(runs, 1);
    assertEquals(state.records.length, 1);
    assertEquals(state.records[0].toISOString(), "2026-11-22T06:45:00.000Z");
    assert(lines.some((line) => line.includes("catching up")));
    assert(lines.some((line) => line.includes("next run at")));
  },
});

Deno.test({
  name: "startDaily does not catch up in the afternoon",
  async fn() {
    const time = fakeTime("2026-11-22T14:00:00Z"); // 15:00 CET
    const { state, store } = memoryStore(
      new Date("2026-11-21T06:30:00Z"),
    );
    let runs = 0;

    const scheduler = startDaily({
      name: "morning",
      at: "07:30",
      tz: TZ,
      run: () => {
        runs += 1;
      },
      now: time.now,
      sleep: time.sleep,
      store,
      log: () => {},
    });
    await settle();
    scheduler.stop();
    await settle(2);

    assertEquals(runs, 0);
    assertEquals(state.records.length, 0);
  },
});

Deno.test({
  name: "startDaily does not catch up when today's run is recorded",
  async fn() {
    const time = fakeTime("2026-11-22T06:45:00Z");
    const { store } = memoryStore(new Date("2026-11-22T06:31:00Z"));
    let runs = 0;

    const scheduler = startDaily({
      name: "morning",
      at: "07:30",
      tz: TZ,
      run: () => {
        runs += 1;
      },
      now: time.now,
      sleep: time.sleep,
      store,
      log: () => {},
    });
    await settle();
    scheduler.stop();
    await settle(2);

    assertEquals(runs, 0);
  },
});

Deno.test({
  name: "a failed run is retried once after five minutes",
  async fn() {
    const time = fakeTime("2026-11-22T06:45:00Z");
    const { state, store } = memoryStore(
      new Date("2026-11-21T06:30:00Z"),
    );
    const lines: string[] = [];
    let attempts = 0;

    const scheduler = startDaily({
      name: "morning",
      at: "07:30",
      tz: TZ,
      run: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Discord is down");
      },
      now: time.now,
      sleep: time.sleep,
      store,
      log: (line) => lines.push(line),
    });
    await settle();
    scheduler.stop();
    await settle(2);

    assertEquals(attempts, 2);
    assertEquals(time.sleeps.includes(RETRY_MS), true);
    assertEquals(state.records.length, 1);
    assert(lines.some((line) => line.includes("Discord is down")));
  },
});

Deno.test({
  name: "a run that fails twice is logged, not thrown",
  async fn() {
    const time = fakeTime("2026-11-22T06:45:00Z");
    const { state, store } = memoryStore(
      new Date("2026-11-21T06:30:00Z"),
    );
    const lines: string[] = [];
    let attempts = 0;

    const scheduler = startDaily({
      name: "morning",
      at: "07:30",
      tz: TZ,
      run: () => {
        attempts += 1;
        throw new Error("still down");
      },
      now: time.now,
      sleep: time.sleep,
      store,
      log: (line) => lines.push(line),
    });
    await settle();
    scheduler.stop();
    await settle(2);

    assertEquals(attempts, 2);
    assertEquals(state.records.length, 0);
    assert(lines.some((line) => line.includes("failed twice")));
  },
});

Deno.test("stop clears the sleeping timer", async () => {
  const time = fakeTime("2026-11-22T04:00:00Z"); // 05:00 CET, before 07:30
  const { store } = memoryStore(new Date("2026-11-21T06:30:00Z"));
  let runs = 0;

  const scheduler = startDaily({
    name: "morning",
    at: "07:30",
    tz: TZ,
    run: () => {
      runs += 1;
    },
    now: time.now,
    store,
    log: () => {},
  });
  await settle(3);
  scheduler.stop();
  await settle(2);

  // A leaked setTimeout would trip the test's op sanitizer here.
  assertEquals(runs, 0);
});
