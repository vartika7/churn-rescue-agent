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
 * The dashboard's trend column compares the last N days on record against the
 * N immediately before. Both windows fit inside SPARKLINE_DAYS, so the figure
 * can be checked by eye against the sparkline beside it.
 */
export const TREND_WINDOW_DAYS = 30;

/**
 * Window for the "Active 30d" column — days with at least one session.
 *
 * Kept equal to EVIDENCE_THRESHOLDS.zeroActivityWindowDays on purpose: the
 * column and the evidence panel's zero-activity rule then describe the same
 * window, so a reader comparing the two never sees them disagree.
 */
export const ACTIVITY_WINDOW_DAYS = 30;

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

/* ------------------------------------------------------------------ *
 * Phase 4 — risk engine
 * ------------------------------------------------------------------ */

/**
 * Points each signal contributes. Additive and capped at 100.
 *
 * Deliberately readable numbers rather than tuned coefficients: this is a
 * deterministic engine whose job is to be explainable and gradeable, and
 * Phase 7 is where the numbers get moved on evidence rather than instinct.
 * Nothing here is fitted to the ground truth — that would be training on the
 * test set.
 */
export const RISK_WEIGHTS = {
  /** Last 30 days on record vs the prior 30. */
  recentTrend: { severe: 25, major: 18, minor: 8 },
  /**
   * Whole observed history, first third vs last.
   *
   * `minDays` because the claim is about a *sustained* trend, and thirds of a
   * short history are too noisy to support it: at 38 days the comparison is
   * 12-day thirds, which fired a spurious "sustained decline of 10%" on an
   * account five weeks old. 90 days gives each third a month.
   */
  historyTrend: { major: 15, minor: 6, minDays: 90 },
  /** Days with no sessions inside the last 30 on record. */
  silence: { severe: 25, major: 18, minor: 8 },
  /** Consecutive silent days at the very end of the record. */
  trailingSilence: { minDays: 7, points: 15 },
  support: {
    escalatedEach: 12,
    escalatedCap: 24,
    unresolvedEach: 8,
    unresolvedCap: 16,
  },
  billing: { failedCharge: 20 },
} as const;

/**
 * Score bands. The vocabulary matches `evaluation_cases.expected_risk_level`
 * (high / medium / low) so Phase 7 can grade the engine without translating.
 */
export const RISK_LEVEL_THRESHOLDS = { high: 50, medium: 25 } as const;

/**
 * Below this many days of records the engine calls its own read low-confidence:
 * two of the three usage signals compare a 30-day window against the 30 before
 * it, so under 60 days there is no complete prior window to compare against.
 *
 * Phase 7 reads the same number. Grading the engine on an account with a
 * fortnight of history and scoring the "miss" against it measures the dataset,
 * not the engine.
 */
export const MIN_OBSERVED_DAYS_FOR_CONFIDENCE = 60;
