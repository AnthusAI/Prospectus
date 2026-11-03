/**
 * The quota week. Every Account's week starts at the same instant: Saturday at 12:00 noon in `QUOTA_WEEK_ZONE`,
 * following daylight saving, so a week is usually 168 hours but 167 across the spring change and 169 across the
 * autumn change. This file is the only place the zone, day and hour are named.
 */
export const QUOTA_WEEK_ZONE = "America/New_York";
/** Saturday, as `Date#getUTCDay` numbers it. */
export const QUOTA_WEEK_DAY = 6;
export const QUOTA_WEEK_HOUR = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
/** The shortest a week can be (the spring change). A hold shorter than this can reach at most one week ahead. */
export const SHORTEST_WEEK_MS = 167 * HOUR_MS;

const parts = new Intl.DateTimeFormat("en-US", {
  timeZone: QUOTA_WEEK_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

/** The zone's wall-clock fields at an instant. */
function wallClock(ms: number) {
  const fields: Record<string, number> = {};
  for (const part of parts.formatToParts(new Date(ms)))
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  return fields as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Offset of the zone from UTC at an instant, in milliseconds (negative west of Greenwich). */
function offsetAt(ms: number): number {
  const wall = wallClock(ms);
  return (
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) -
    Math.floor(ms / 1000) * 1000
  );
}

/** The instant of noon on a calendar date in the zone. Noon is never skipped or repeated by a clock change. */
function noonUtc(year: number, month: number, day: number): number {
  const guess = Date.UTC(year, month - 1, day, QUOTA_WEEK_HOUR);
  return guess - offsetAt(guess);
}

export interface QuotaWeekWindow {
  /** The week's start as a date number, YYYYMMDD of the Saturday in the zone. This keys the week's record. */
  key: number;
  startMs: number;
  endMs: number;
  startsAt: string;
  endsAt: string;
}

/** The start instant and date key of the week containing `ms`. A boundary instant belongs to the week it starts. */
function startOfWeek(ms: number): { key: number; startMs: number } {
  const wall = wallClock(ms);
  // Walk back to this week's Saturday on the calendar, then step back a week if its noon is still ahead of `ms`.
  const day = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() - QUOTA_WEEK_DAY + 7) % 7));
  let startMs = noonUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
  if (startMs > ms) {
    day.setUTCDate(day.getUTCDate() - 7);
    startMs = noonUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
  }
  return { key: day.getUTCFullYear() * 10000 + (day.getUTCMonth() + 1) * 100 + day.getUTCDate(), startMs };
}

/** The week containing an instant. */
export function weekAt(ms: number): QuotaWeekWindow {
  const { key, startMs } = startOfWeek(ms);
  // The next Saturday noon is a week on the calendar, an hour either side in real time; six hours in lands inside it.
  const endMs = startOfWeek(startMs + 7 * DAY_MS + 6 * HOUR_MS).startMs;
  return {
    key,
    startMs,
    endMs,
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
  };
}

/** The week before the one containing an instant. */
export const previousWeekKey = (ms: number): number => startOfWeek(weekAt(ms).startMs - 1).key;
