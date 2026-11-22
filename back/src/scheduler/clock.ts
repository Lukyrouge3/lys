// A daily timer that understands a timezone, plus the bookkeeping that lets a
// restart catch up on a run it missed. No cron dependency: a local wall-clock
// time is turned into an instant in the configured zone with Intl, so DST
// changes need no special cases.
import prisma from "@/db.ts";
import { logger } from "@/utils/logger.ts";

/** How late a restart may still send the run it missed. */
export const CATCH_UP_MS = 3 * 60 * 60 * 1000;
/** How long to wait before the single retry of a failed run. */
export const RETRY_MS = 5 * 60 * 1000;
/** Longest single sleep, so a clock jump or suspend cannot overshoot far. */
export const MAX_SLEEP_MS = 15 * 60 * 1000;

export type ClockParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let found = formatters.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, found);
  }
  return found;
}

/** The wall-clock fields an observer in `tz` would read off the calendar. */
export function zonedParts(date: Date, tz: string): ClockParts {
  const parts = formatter(tz).formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/**
 * The instant at which `tz` shows the given wall-clock fields. The offset is
 * resolved by repeating the conversion until it is stable, which is what makes
 * dates on either side of a DST switch land on the right instant.
 */
export function zonedTimeToUtc(
  tz: string,
  parts: Omit<ClockParts, "second"> & { second?: number },
): Date {
  const target = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0,
  );

  let guess = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = zonedParts(new Date(guess), tz);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = target - actualAsUtc;
    if (correction === 0) break;
    guess += correction;
  }
  return new Date(guess);
}

/** "HH:MM" as hour and minute; anything else is a configuration error. */
export function parseAt(at: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!match) {
    throw new Error(`Scheduled time must look like "HH:MM", got "${at}".`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`Scheduled time is not a real time of day: "${at}".`);
  }
  return { hour, minute };
}

function addDays(parts: ClockParts, days: number): ClockParts {
  const moved = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

/** The first occurrence of `at` strictly after `now`, in `tz`. */
export function nextRunAt(now: Date, at: string, tz: string): Date {
  const { hour, minute } = parseAt(at);
  const local = zonedParts(now, tz);
  const today = zonedTimeToUtc(tz, {
    year: local.year,
    month: local.month,
    day: local.day,
    hour,
    minute,
  });
  if (today.getTime() > now.getTime()) return today;

  const tomorrow = addDays(local, 1);
  return zonedTimeToUtc(tz, {
    year: tomorrow.year,
    month: tomorrow.month,
    day: tomorrow.day,
    hour,
    minute,
  });
}

/** The most recent occurrence of `at` at or before `now`, in `tz`. */
export function latestRunAt(now: Date, at: string, tz: string): Date {
  const { hour, minute } = parseAt(at);
  const local = zonedParts(now, tz);
  const today = zonedTimeToUtc(tz, {
    year: local.year,
    month: local.month,
    day: local.day,
    hour,
    minute,
  });
  if (today.getTime() <= now.getTime()) return today;

  const yesterday = addDays(local, -1);
  return zonedTimeToUtc(tz, {
    year: yesterday.year,
    month: yesterday.month,
    day: yesterday.day,
    hour,
    minute,
  });
}

/**
 * The occurrence a restart should still run: the latest scheduled time, but
 * only when it already passed, was not recorded yet, and is fresh enough to be
 * useful. A restart at 07:45 sends the morning message; at 15:00 it does not.
 */
export function missedRun(
  last: Date | null,
  now: Date,
  at: string,
  tz: string,
): Date | null {
  const latest = latestRunAt(now, at, tz);
  if (last !== null && last.getTime() >= latest.getTime()) return null;
  if (now.getTime() - latest.getTime() > CATCH_UP_MS) return null;
  return latest;
}

/** Where the last successful run of each job is kept. */
export type RunStore = {
  readLastRun: (name: string) => Promise<Date | null>;
  recordRun: (name: string, at: Date) => Promise<void>;
};

export const prismaRunStore: RunStore = {
  async readLastRun(name) {
    const row = await prisma.scheduledRun.findUnique({ where: { name } });
    return row?.lastRunAt ?? null;
  },
  async recordRun(name, at) {
    await prisma.scheduledRun.upsert({
      where: { name },
      create: { name, lastRunAt: at },
      update: { lastRunAt: at },
    });
  },
};

export type StartDailyOptions = {
  /** Also the `ScheduledRun` key. */
  name: string;
  /** Local time of day, "HH:MM". */
  at: string;
  /** IANA zone the time belongs to. */
  tz: string;
  run: () => Promise<void> | void;
  /** Injected in tests so no test waits. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  store?: RunStore;
  /** Receives the `scheduler:` lines instead of the logger. */
  log?: (message: string) => void;
};

export type Scheduler = { stop: () => void };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs `run` once a day at `at` in `tz`. Timers are slept in short stretches
 * and the target is recomputed after each, so a clock jump or a suspend does
 * not fire the run at the wrong time. Startup catch-up happens once; a failed
 * run is retried once after five minutes and then waits for tomorrow.
 */
export function startDaily(options: StartDailyOptions): Scheduler {
  const now = options.now ?? (() => new Date());
  const store = options.store ?? prismaRunStore;
  const log = options.log ?? ((message: string) => logger.info(message));
  const logFailure = options.log ??
    ((message: string) => logger.error(message));

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;

  const defaultSleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const done = () => {
        timer = undefined;
        wake = undefined;
        resolve();
      };
      wake = done;
      timer = setTimeout(done, ms);
    });
  const sleep = options.sleep ?? defaultSleep;

  function stop(): void {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const pending = wake;
    wake = undefined;
    pending?.();
  }

  async function sleepUntil(target: Date): Promise<void> {
    while (!stopped) {
      const remaining = target.getTime() - now().getTime();
      if (remaining <= 0) return;
      await sleep(Math.min(remaining, MAX_SLEEP_MS));
    }
  }

  /** True when the run succeeded. The record is written even if it cannot be. */
  async function attempt(): Promise<boolean> {
    log(`scheduler: ${options.name} run started`);
    try {
      await options.run();
    } catch (err) {
      logFailure(`scheduler: ${options.name} failed: ${errorText(err)}`);
      return false;
    }

    try {
      await store.recordRun(options.name, now());
    } catch (err) {
      // The message is out; a stale timestamp only risks one duplicate run.
      logFailure(
        `scheduler: could not record the ${options.name} run: ${
          errorText(err)
        }`,
      );
    }
    return true;
  }

  async function runWithRetry(): Promise<void> {
    if (await attempt()) return;
    if (stopped) return;

    log(`scheduler: ${options.name} retrying in 5 minutes`);
    await sleep(RETRY_MS);
    if (stopped) return;

    if (!await attempt()) {
      logFailure(
        `scheduler: ${options.name} failed twice, waiting for the next run`,
      );
    }
  }

  async function loop(): Promise<void> {
    let last: Date | null = null;
    try {
      last = await store.readLastRun(options.name);
    } catch (err) {
      logFailure(
        `scheduler: could not read the last ${options.name} run: ${
          errorText(err)
        }`,
      );
    }

    const missed = missedRun(last, now(), options.at, options.tz);
    if (missed) {
      log(
        `scheduler: ${options.name} missed its ${missed.toISOString()} run, catching up`,
      );
      await runWithRetry();
    }

    while (!stopped) {
      const target = nextRunAt(now(), options.at, options.tz);
      log(`scheduler: ${options.name} next run at ${target.toISOString()}`);
      await sleepUntil(target);
      if (stopped) return;
      await runWithRetry();
    }
  }

  void loop().catch((err) => {
    logFailure(`scheduler: ${options.name} stopped: ${errorText(err)}`);
  });

  return { stop };
}
