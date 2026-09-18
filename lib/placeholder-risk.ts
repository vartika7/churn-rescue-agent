import type { Recommendation } from "./types";

/**
 * Named "placeholder" deliberately: every value here originates in
 * `evaluation_cases`, which is evaluation ground truth rather than a live
 * assessment. It exists only so the dashboard has a status column before the
 * Phase 4 risk engine and Phase 5 investigation agent populate
 * `risk_assessments` / `investigations`.
 *
 * Every surface that renders it must carry a visible placeholder label.
 */
export const RECOMMENDATIONS: Recommendation[] = [
  "intervene",
  "monitor",
  "no_action",
];

/**
 * Maps the stored strings onto the three buckets.
 *
 * Verified against the v2 dataset on 2026-09-18: `expected_recommendation`
 * holds "no_action_needed" (35), "intervene" (9) and "monitor" (6). The brief
 * documented that first value as "no_action", so both spellings are accepted —
 * without the alias 35 accounts render as "No case data" and the "No action"
 * summary count reads zero.
 */
const RECOMMENDATION_ALIASES: Record<string, Recommendation> = {
  intervene: "intervene",
  monitor: "monitor",
  no_action: "no_action",
  no_action_needed: "no_action",
};

export function parseRecommendation(
  value: string | null | undefined,
): Recommendation | null {
  const normalised = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return RECOMMENDATION_ALIASES[normalised] ?? null;
}

export function recommendationLabel(rec: Recommendation | null): string {
  switch (rec) {
    case "intervene":
      return "Intervene";
    case "monitor":
      return "Monitor";
    case "no_action":
      return "No action";
    default:
      return "No case data";
  }
}

export function recommendationBadgeClass(rec: Recommendation | null): string {
  switch (rec) {
    case "intervene":
      return "badge badge-intervene";
    case "monitor":
      return "badge badge-monitor";
    case "no_action":
      return "badge badge-healthy";
    default:
      return "badge badge-unknown";
  }
}

/** Sort order for the status column: most urgent first. */
export function recommendationRank(rec: Recommendation | null): number {
  switch (rec) {
    case "intervene":
      return 0;
    case "monitor":
      return 1;
    case "no_action":
      return 2;
    default:
      return 3;
  }
}

/* ------------------------------------------------------------------ *
 * Retrospective labelling for lost accounts
 * ------------------------------------------------------------------ */

export interface RetrospectiveBadge {
  label: string;
  className: string;
  /** Longer form for the detail page. */
  explanation: string;
  /** Sort order: catchable misses first. */
  rank: number;
}

/**
 * Churned accounts get past-tense labels, never the present-tense
 * "Intervene" / "Monitor" / "No action" used for the active worklist.
 *
 * `expected_recommendation` answers "would intervening have been the right
 * call, given this customer's data, before they left?" — it is a grading label,
 * not an instruction. Nine of the ten churned accounts carry `intervene`; the
 * tenth (C008, `unobservable_limitation`) was acquired by a competitor with no
 * product signal to catch, so "should have intervened" would be untrue of it.
 *
 * Verified against the live table on 2026-09-18: churned x intervene = 9,
 * churned x no_action_needed = 1 (the unobservable case).
 */
export function retrospectiveBadge(
  rec: Recommendation | null,
  caseType: string | null | undefined,
): RetrospectiveBadge {
  const normalisedCase = (caseType ?? "").trim().toLowerCase();

  if (normalisedCase === "unobservable_limitation") {
    return {
      label: "No signal available",
      className: "badge badge-unknown",
      explanation:
        "Nothing in the usage, support or billing data could have predicted this loss.",
      rank: 2,
    };
  }

  if (rec === "intervene") {
    return {
      label: "Missed — should have intervened",
      className: "badge badge-missed",
      explanation:
        "The data available before this account left supported intervening. Retrospective grading, not a live action.",
      rank: 0,
    };
  }

  return {
    label: "Churned — not flagged",
    className: "badge badge-unknown",
    explanation:
      "This account left without the placeholder data flagging it for intervention.",
    rank: 1,
  };
}
