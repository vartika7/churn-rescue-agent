/* There is deliberately no pinned "today" constant here.
 *
 * Renewal countdowns use real wall-clock time and usage windows are anchored to
 * the latest date on record per customer — two different questions that a
 * single shared constant used to conflate. Both live in lib/time.ts as
 * `getRealToday()` and `getLatestRecordedDate()`; `RENEWAL_SOON_DAYS` sits
 * beside the countdown logic there too. */

/**
 * Length of the dashboard sparkline window, in days on record.
 *
 * Measured back from each customer's own latest recorded date, not from real
 * today. Retained accounts have usage running to 2026-10-31 while churned
 * accounts stop at their `outcome_date`, so a window anchored to wall-clock
 * time would be empty for anyone who left months ago and would drift empty for
 * everyone else as real time passes the end of the table.
 */
export const SPARKLINE_DAYS = 90;

/**
 * Thresholds for the evidence heuristics in lib/analysis.ts.
 *
 * These are a UI-layer stand-in for the real Phase 5 AI investigation agent.
 * They were rough placeholders in the validated prototype and are expected to
 * be replaced or substantially extended in Phase 4/5 — treat the numbers as
 * provisional, not as a tuned model.
 */
export const EVIDENCE_THRESHOLDS = {
  /** Sessions decline (%) at or past which the usage trend is strong support. */
  usageStrongDeclinePct: -25,
  /** Sessions change (%) at or above which the usage trend argues against risk. */
  usageHealthyPct: -8,
  /** Window for counting zero-session days, in days on record. */
  zeroActivityWindowDays: 30,
  /** Zero-session days at or above this count are supporting evidence. */
  zeroActivitySupportingDays: 10,
  /** Zero-session days at or below this count are contradicting evidence. */
  zeroActivityContradictingDays: 3,
} as const;
