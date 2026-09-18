/**
 * Two reference points, deliberately kept separate.
 *
 * There is no single "today" in this app, and there must not be one. Renewal
 * countdowns are a live question about the real world; usage windows are a
 * question about a bounded table. A shared constant conflated the two, which is
 * the bug this module exists to prevent:
 *
 *   getRealToday()          -> renewal countdowns, "is this overdue"
 *   getLatestRecordedDate() -> usage windows, "last N days on record"
 *
 * Using the wrong one is silently wrong rather than loudly broken, so each is
 * documented with what it must never be used for.
 */

const MS_PER_DAY = 86_400_000;

/* ------------------------------------------------------------------ *
 * Date maths (timezone-safe)
 * ------------------------------------------------------------------ */

/**
 * Parses a `YYYY-MM-DD` date as UTC midnight. Passing the bare string to
 * `new Date()` would be parsed as UTC anyway, but building it explicitly keeps
 * the arithmetic below free of any local-timezone off-by-one.
 */
export function parseISODate(iso: string): Date {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Whole days from `from` to `to`; negative when `to` is in the past. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/* ------------------------------------------------------------------ *
 * Reference point 1: real wall-clock time
 * ------------------------------------------------------------------ */

/**
 * The real current date, normalised to UTC midnight.
 *
 * For renewal countdowns and overdue checks only. These are genuinely live: if
 * someone opens this dashboard in November, "in 12d" has to mean twelve days
 * from that November day, not from whenever the data was generated.
 *
 * MUST NOT be used for usage windows. `usage_daily` is a bounded table that
 * stops at a fixed date per customer, so any "last N days" measured from real
 * time quietly returns nothing once the calendar moves past it — an empty
 * evidence panel rather than an error. Use `getLatestRecordedDate` there.
 *
 * Normalised to UTC rather than the host's local calendar so the result does
 * not depend on where it runs. Vercel's runtime is UTC, so this matches
 * production exactly; a local dev machine east of UTC may briefly disagree with
 * its own wall clock before ~05:30 local, which is harmless for a day-grained
 * countdown.
 *
 * Because both pages are `force-dynamic`, this is re-evaluated on every
 * request. Countdowns are computed on the server and passed to the client as
 * strings, so the client never re-derives them from its own clock — that would
 * risk a hydration mismatch across a midnight boundary.
 */
export function getRealToday(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/* ------------------------------------------------------------------ *
 * Reference point 2: the data's own most recent day
 * ------------------------------------------------------------------ */

export interface DatedRow {
  date: string;
}

/**
 * The most recent date actually present in a set of `usage_daily` rows.
 *
 * This is the anchor for every usage window — zero-activity counts, trend
 * thirds, the sparkline slice. "Last 30 days on record", not "last 30 calendar
 * days". Records end in different places by design: retained accounts run to
 * 2026-10-31, churned accounts stop at their `outcome_date`, so an account that
 * left in May has no rows anywhere near real today.
 *
 * MUST NOT be replaced with `getRealToday()`. Returns null for an empty set,
 * which callers treat as "no usage on record" rather than substituting a date.
 */
export function getLatestRecordedDate(
  rows: readonly DatedRow[],
): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    if (latest === null || row.date > latest) latest = row.date;
  }
  return latest;
}

/* ------------------------------------------------------------------ *
 * Countdowns (reference point 1 only)
 * ------------------------------------------------------------------ */

/**
 * "in 12d" / "today" / "12d ago", relative to real time.
 *
 * `now` is injectable purely so tests can be deterministic; production callers
 * omit it and get the real clock.
 */
export function relativeDayLabel(
  iso: string,
  now: Date = getRealToday(),
): { days: number; label: string } {
  const days = daysBetween(now, parseISODate(iso));
  if (days === 0) return { days, label: "today" };
  return { days, label: days > 0 ? `in ${days}d` : `${Math.abs(days)}d ago` };
}

export type RenewalStatus = "overdue" | "soon" | "later";

export interface RenewalCountdown {
  days: number;
  label: string;
  status: RenewalStatus;
}

/** Renewals at or inside this many days get the amber treatment. */
export const RENEWAL_SOON_DAYS = 14;

export function renewalCountdown(
  renewalISO: string,
  now: Date = getRealToday(),
): RenewalCountdown {
  const { days, label } = relativeDayLabel(renewalISO, now);

  // A renewal already in the past is not "due soon" — folding negatives into
  // the amber window would style overdue rows as upcoming.
  const status: RenewalStatus =
    days < 0 ? "overdue" : days <= RENEWAL_SOON_DAYS ? "soon" : "later";

  return { days, label, status };
}
