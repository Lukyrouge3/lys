import { logger } from "@/utils/logger.ts";

const DEFAULT_START = "22:00";
const DEFAULT_END = "07:00";
const DEFAULT_TIME_ZONE = "Europe/Zurich";
const DEFAULT_START_MINUTES = 22 * 60;
const DEFAULT_END_MINUTES = 7 * 60;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type QuietHoursConfig = {
  start?: string;
  end?: string;
  timeZone?: string;
};

// Invalid configuration is reported once, not on every incoming mail.
const warned = new Set<string>();
const formatters = new Map<string, Intl.DateTimeFormat>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  logger.warn(message);
}

/** Test hook: lets a test observe the "one warning" rule again. */
export function resetQuietHoursWarningsForTests(): void {
  warned.clear();
}

function envOr(name: string, fallback: string): string {
  const value = Deno.env.get(name);
  return value && value.trim() ? value : fallback;
}

function parseMinutes(value: string, name: string): number | null {
  const match = HH_MM.exec(value.trim());
  if (!match) {
    warnOnce(`Invalid ${name} "${value}"; using the default.`);
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached) return cached;

  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

/** Minutes since local midnight in the given time zone. */
function minutesInZone(timeZone: string, now: Date): number | null {
  const formatter = formatterFor(timeZone);
  if (!formatter) return null;

  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return hour * 60 + minute;
}

/**
 * Whether `now` falls in the nightly quiet window. The window may cross
 * midnight (the default 22:00–07:00 does); the end is exclusive, so 07:00 is
 * already awake. The clock is read in the configured time zone, not the
 * process's own, so DST changes shift the window with the wall clock.
 */
export function inQuietHours(
  now: Date = new Date(),
  cfg: QuietHoursConfig = {},
): boolean {
  const start = parseMinutes(
    cfg.start ?? envOr("QUIET_START", DEFAULT_START),
    "QUIET_START",
  ) ?? DEFAULT_START_MINUTES;
  const end = parseMinutes(
    cfg.end ?? envOr("QUIET_END", DEFAULT_END),
    "QUIET_END",
  ) ?? DEFAULT_END_MINUTES;

  const zone = cfg.timeZone ?? envOr("TZ", DEFAULT_TIME_ZONE);
  let minutes = minutesInZone(zone, now);
  if (minutes === null) {
    warnOnce(`Invalid TZ "${zone}"; using ${DEFAULT_TIME_ZONE}.`);
    minutes = minutesInZone(DEFAULT_TIME_ZONE, now);
  }
  if (minutes === null) return false;

  // A window that starts and ends at the same minute is empty, not all day.
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}
