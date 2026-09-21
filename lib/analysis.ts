import { EVIDENCE_THRESHOLDS } from "./constants";
import type { UsageDaily } from "./types";

/* ------------------------------------------------------------------ *
 * Usage trend
 * ------------------------------------------------------------------ */

export interface SessionsTrend {
  /** Percent change from the earliest third to the most recent third. */
  pctChange: number | null;
  earlyAvg: number;
  lateAvg: number;
  observedDays: number;
}

export interface ActiveDaysComparison {
  /** Days with at least one session in the most recent window. */
  active: number;
  days: number;
  /** Same, for the window immediately before it. */
  priorActive: number;
  priorDays: number;
  /** active - priorActive; null when there is no comparable prior window. */
  delta: number | null;
}

/**
 * Counts days with any session in the last `windowDays` on record, against the
 * `windowDays` before them.
 *
 * Complements the sessions trend rather than repeating it: an average cannot
 * distinguish thirty light days from three heavy ones and twenty-seven silent,
 * and it is the silence that matters for churn. `rows` must already be in
 * chronological order.
 *
 * `delta` is null unless the prior window is the same length, since "18/30 vs
 * 9/12" is not a comparison anyone should read at a glance.
 */
export function activeDaysComparison(
  rows: readonly Pick<UsageDaily, "date" | "sessions">[],
  windowDays = 30,
): ActiveDaysComparison {
  const recent = rows.slice(-windowDays);
  const prior = rows.slice(-windowDays * 2, -windowDays);

  const active = recent.filter((r) => r.sessions > 0).length;
  const priorActive = prior.filter((r) => r.sessions > 0).length;

  return {
    active,
    days: recent.length,
    priorActive,
    priorDays: prior.length,
    delta: prior.length === recent.length ? active - priorActive : null,
  };
}

export interface RecentTrend {
  /** Percent change from the prior window to the most recent one. */
  pctChange: number | null;
  recentAvg: number;
  priorAvg: number;
  /** Actual sizes, which are smaller than `windowDays` on a short history. */
  recentDays: number;
  priorDays: number;
}

/**
 * Compares the most recent `windowDays` on record against the `windowDays`
 * immediately before them — two adjacent windows, nothing discarded.
 *
 * This is what the dashboard column shows. It is deliberately NOT
 * `sessionsTrend`: that one splits a customer's entire observed history into
 * thirds and throws the middle third away, which is defensible for a
 * whole-history assessment but reads as nonsense in a table column headed with
 * a day count. Adjacent windows are what someone triaging a list expects from
 * "30d vs prior 30d", and they can be checked by eye against the sparkline.
 *
 * `sessions` must already be in chronological order. Returns null for
 * `pctChange` when there is no prior window to compare against, or when the
 * prior window is all zeros (percent change from zero is undefined, not
 * infinite).
 */
export function recentVsPriorTrend(
  sessions: number[],
  windowDays = 30,
): RecentTrend {
  const recent = sessions.slice(-windowDays);
  const prior = sessions.slice(-windowDays * 2, -windowDays);

  const recentAvg = mean(recent);
  const priorAvg = mean(prior);

  let pctChange: number | null;
  if (prior.length === 0) pctChange = null;
  else if (priorAvg === 0) pctChange = recentAvg === 0 ? 0 : null;
  else pctChange = ((recentAvg - priorAvg) / priorAvg) * 100;

  return {
    pctChange,
    recentAvg,
    priorAvg,
    recentDays: recent.length,
    priorDays: prior.length,
  };
}

/**
 * Compares average sessions in the earliest third of a run of days against the
 * most recent third. `sessions` must already be in chronological order.
 *
 * Thirds rather than fixed windows because the observation window runs 112-196
 * days and is truncated at `outcome_date` for churned accounts, so a fixed
 * "first 30 vs last 30" would weight short and long histories differently.
 */
export function sessionsTrend(sessions: number[]): SessionsTrend {
  const n = sessions.length;

  if (n < 3) {
    return { pctChange: null, earlyAvg: 0, lateAvg: 0, observedDays: n };
  }

  const third = Math.floor(n / 3);
  const earlyAvg = mean(sessions.slice(0, third));
  const lateAvg = mean(sessions.slice(n - third));

  // A zero baseline makes percent change undefined rather than infinite. Both
  // ends at zero is a genuine 0% change; a zero start with activity later is
  // reported as n/a instead of a meaningless huge number.
  let pctChange: number | null;
  if (earlyAvg === 0) {
    pctChange = lateAvg === 0 ? 0 : null;
  } else {
    pctChange = ((lateAvg - earlyAvg) / earlyAvg) * 100;
  }

  return { pctChange, earlyAvg, lateAvg, observedDays: n };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export interface ZeroActivityWindow {
  count: number;
  windowDays: number;
  /** First and last dates the window actually covers; null when empty. */
  from: string | null;
  to: string | null;
}

/**
 * Zero-session days within the last `windowDays` days **on record**.
 *
 * Takes rows rather than bare numbers so it can report the window it used.
 * The window ends at this customer's latest recorded date — never at real
 * today; see lib/time.ts. `rows` must already be in chronological order.
 */
export function zeroActivityDays(
  rows: readonly Pick<UsageDaily, "date" | "sessions">[],
  windowDays: number = EVIDENCE_THRESHOLDS.zeroActivityWindowDays,
): ZeroActivityWindow {
  const window = rows.slice(-windowDays);
  return {
    count: window.filter((r) => r.sessions === 0).length,
    windowDays: window.length,
    from: window.length > 0 ? window[0].date : null,
    to: window.length > 0 ? window[window.length - 1].date : null,
  };
}
