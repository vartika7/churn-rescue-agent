import {
  activeDaysComparison,
  recentVsPriorTrend,
  sessionsTrend,
} from "./analysis";
import { RISK_WEIGHTS, RISK_LEVEL_THRESHOLDS } from "./constants";
import { formatDate } from "./format";
import type { SupportTicket, Subscription, UsageDaily } from "./types";

/* ------------------------------------------------------------------ *
 * Phase 4 — deterministic risk engine
 *
 * Scores a customer from observable behaviour only. Everything here is
 * rule-based and reproducible: the same inputs always give the same score,
 * which is what makes it gradeable in Phase 7 and what Phase 5's LLM
 * investigation sits on top of rather than replaces.
 *
 * LEAKAGE: `scoreCustomer` deliberately accepts no outcome, no
 * `customer_outcomes` row and no `evaluation_cases` row. Knowing who churned
 * is not a feature — it is the answer. Selecting *which* customers to score
 * (retained only) is the caller's job; the scoring itself cannot see it,
 * because the signature gives it nowhere to go.
 * ------------------------------------------------------------------ */

export type RiskLevel = "high" | "medium" | "low";
export type Confidence = "high" | "medium" | "low";
export type SignalSource = "Usage" | "Support" | "Billing";

export interface RiskSignal {
  /** Stable identifier, safe to persist and group on. */
  key: string;
  source: SignalSource;
  /** One line, already phrased for display. */
  headline: string;
  detail?: string;
  /** Points contributed to the total. Zero means "checked, found nothing". */
  points: number;
  /** Whether this argues for risk or against it. */
  direction: "supporting" | "contradicting";
}

export interface RiskAssessment {
  riskLevel: RiskLevel;
  /** 0-100. Capped, so a pile-up of minor signals cannot exceed a severe one. */
  score: number;
  confidence: Confidence;
  /** Plain-language summary, derived from the signals that actually fired. */
  reason: string;
  signals: RiskSignal[];
  /** What the score was computed from, for auditability. */
  window: {
    observedDays: number;
    from: string | null;
    to: string | null;
  };
}

export interface ScoreInput {
  usage: readonly UsageDaily[];
  tickets: readonly SupportTicket[];
  subscriptions: readonly Subscription[];
  /**
   * Ignore anything dated after this. Lets the engine be replayed as it would
   * have run on a past date — which is the only way to measure whether it
   * would have caught an account that has since churned, since no currently
   * active account is labelled high risk in the ground truth.
   */
  asOf?: string;
}

const OPEN_TICKET_STATUSES = new Set([
  "unresolved",
  "escalated",
  "open",
  "in_progress",
  "pending",
]);

const BAD_PAYMENT_STATUSES = new Set(["past_due", "payment_failed", "failed"]);

function normalise(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/** Consecutive zero-session days at the end of the record. */
function trailingSilence(sessions: readonly number[]): number {
  let n = 0;
  for (let i = sessions.length - 1; i >= 0 && sessions[i] === 0; i--) n++;
  return n;
}

export function scoreCustomer(input: ScoreInput): RiskAssessment {
  const cutoff = input.asOf;
  const keep = <T extends { date: string }>(rows: readonly T[]) =>
    cutoff ? rows.filter((r) => r.date <= cutoff) : [...rows];

  const usage = keep(input.usage).sort((a, b) => a.date.localeCompare(b.date));
  const tickets = keep(input.tickets);
  const subscriptions = keep(input.subscriptions);
  const sessions = usage.map((u) => u.sessions);

  const signals: RiskSignal[] = [];
  const add = (s: RiskSignal) => signals.push(s);

  /* --- Usage: recent trend ----------------------------------------- */
  const recent = recentVsPriorTrend(sessions, 30);
  if (recent.pctChange !== null) {
    const pct = Math.round(recent.pctChange);
    const w = RISK_WEIGHTS.recentTrend;
    const points =
      pct <= -40 ? w.severe : pct <= -25 ? w.major : pct <= -10 ? w.minor : 0;
    add({
      key: "usage.recent_trend_30d",
      source: "Usage",
      headline:
        points > 0
          ? `Sessions down ${Math.abs(pct)}% in the last 30 days on record`
          : `Sessions ${pct >= 0 ? "up" : "down"} ${Math.abs(pct)}% over the last 30 days on record`,
      detail: `${recent.priorAvg.toFixed(1)} → ${recent.recentAvg.toFixed(1)} sessions/day against the prior 30.`,
      points,
      direction: points > 0 ? "supporting" : "contradicting",
    });
  }

  /* --- Usage: whole-history drift ---------------------------------- */
  const longRun = sessionsTrend(sessions);
  if (longRun.pctChange !== null) {
    const pct = Math.round(longRun.pctChange);
    const w = RISK_WEIGHTS.historyTrend;
    const points = pct <= -25 ? w.major : pct <= -8 ? w.minor : 0;
    add({
      key: "usage.history_trend",
      source: "Usage",
      headline:
        points > 0
          ? `Sustained decline of ${Math.abs(pct)}% across observed history`
          : `No sustained decline across observed history (${pct >= 0 ? "+" : ""}${pct}%)`,
      detail: `First third averaged ${longRun.earlyAvg.toFixed(1)}/day, last third ${longRun.lateAvg.toFixed(1)}/day over ${longRun.observedDays} days.`,
      points,
      direction: points > 0 ? "supporting" : "contradicting",
    });
  }

  /* --- Usage: silence ---------------------------------------------- */
  const activity = activeDaysComparison(usage, 30);
  if (activity.days > 0) {
    const silent = activity.days - activity.active;
    const w = RISK_WEIGHTS.silence;
    const points =
      silent >= 15
        ? w.severe
        : silent >= 10
          ? w.major
          : silent >= 6
            ? w.minor
            : 0;
    add({
      key: "usage.silent_days_30d",
      source: "Usage",
      headline:
        points > 0
          ? `${silent} of the last ${activity.days} days on record had no sessions`
          : `Active on ${activity.active} of the last ${activity.days} days on record`,
      detail:
        activity.delta === null
          ? undefined
          : `${activity.priorActive}/${activity.days} active in the prior window (${activity.delta >= 0 ? "+" : ""}${activity.delta}).`,
      points,
      direction: points > 0 ? "supporting" : "contradicting",
    });
  }

  /* --- Usage: gone quiet at the end -------------------------------- */
  const trailing = trailingSilence(sessions);
  if (trailing >= RISK_WEIGHTS.trailingSilence.minDays) {
    add({
      key: "usage.trailing_silence",
      source: "Usage",
      headline: `No sessions at all for the last ${trailing} days on record`,
      detail: "Ends the observation window silent rather than merely quieter.",
      points: RISK_WEIGHTS.trailingSilence.points,
      direction: "supporting",
    });
  }

  /* --- Support ------------------------------------------------------ */
  const open = tickets.filter((t) =>
    OPEN_TICKET_STATUSES.has(normalise(t.resolution_status)),
  );
  const escalated = open.filter(
    (t) => normalise(t.resolution_status) === "escalated",
  );
  const otherOpen = open.filter(
    (t) => normalise(t.resolution_status) !== "escalated",
  );

  if (escalated.length > 0) {
    add({
      key: "support.escalated_open",
      source: "Support",
      headline: `${escalated.length} escalated ticket${escalated.length === 1 ? "" : "s"} still open`,
      detail: escalated
        .map((t) => `"${t.subject}" (${formatDate(t.date)})`)
        .join("; "),
      points: Math.min(
        escalated.length * RISK_WEIGHTS.support.escalatedEach,
        RISK_WEIGHTS.support.escalatedCap,
      ),
      direction: "supporting",
    });
  }
  if (otherOpen.length > 0) {
    add({
      key: "support.unresolved_open",
      source: "Support",
      headline: `${otherOpen.length} unresolved ticket${otherOpen.length === 1 ? "" : "s"}`,
      detail: otherOpen
        .map((t) => `"${t.subject}" (${formatDate(t.date)})`)
        .join("; "),
      points: Math.min(
        otherOpen.length * RISK_WEIGHTS.support.unresolvedEach,
        RISK_WEIGHTS.support.unresolvedCap,
      ),
      direction: "supporting",
    });
  }
  if (tickets.length === 0) {
    add({
      key: "support.no_tickets",
      source: "Support",
      headline: "No support tickets raised",
      detail:
        "No friction visible through the support channel — and no signal either way.",
      points: 0,
      direction: "contradicting",
    });
  } else if (open.length === 0) {
    add({
      key: "support.all_resolved",
      source: "Support",
      headline: `All ${tickets.length} ticket${tickets.length === 1 ? "" : "s"} resolved`,
      detail: "Issues were raised and closed out.",
      points: 0,
      direction: "contradicting",
    });
  }

  // A positive-sentiment ticket often carries a benign explanation for a dip —
  // a reorg, a seasonal lull — so it argues against risk without cancelling it.
  const positive = tickets.filter((t) => normalise(t.sentiment) === "positive");
  for (const t of positive) {
    add({
      key: "support.positive_sentiment",
      source: "Support",
      headline: `Customer-reported context: "${t.subject}"`,
      detail: `${formatDate(t.date)} — positive sentiment, may explain a usage change benignly.`,
      points: 0,
      direction: "contradicting",
    });
  }

  /* --- Billing ------------------------------------------------------ */
  const badCharges = subscriptions.filter(
    (s) =>
      BAD_PAYMENT_STATUSES.has(normalise(s.payment_status)) ||
      BAD_PAYMENT_STATUSES.has(normalise(s.change_type)),
  );
  if (badCharges.length > 0) {
    const recentFirst = [...badCharges].sort((a, b) =>
      b.date.localeCompare(a.date),
    );
    add({
      key: "billing.failed_charges",
      source: "Billing",
      headline: `${badCharges.length} failed or past-due charge${badCharges.length === 1 ? "" : "s"}`,
      detail: `Most recent ${formatDate(recentFirst[0].date)}.`,
      points: RISK_WEIGHTS.billing.failedCharge,
      direction: "supporting",
    });
  } else if (subscriptions.length > 0) {
    add({
      key: "billing.clean",
      source: "Billing",
      headline: `Clean payment history across ${subscriptions.length} charge${subscriptions.length === 1 ? "" : "s"}`,
      points: 0,
      direction: "contradicting",
    });
  }

  /* --- Score, level, confidence ------------------------------------ */
  const score = Math.min(
    100,
    signals.reduce((sum, s) => sum + s.points, 0),
  );
  const riskLevel: RiskLevel =
    score >= RISK_LEVEL_THRESHOLDS.high
      ? "high"
      : score >= RISK_LEVEL_THRESHOLDS.medium
        ? "medium"
        : "low";

  return {
    riskLevel,
    score,
    confidence: assessConfidence(usage.length, tickets, subscriptions, signals),
    reason: buildReason(riskLevel, signals),
    signals,
    window: {
      observedDays: usage.length,
      from: usage.length > 0 ? usage[0].date : null,
      to: usage.length > 0 ? usage[usage.length - 1].date : null,
    },
  };
}

/**
 * Confidence describes how much there was to look at, not how high the score
 * is. A quiet account with three weeks of history and no tickets scores low
 * with low confidence: that is "we cannot see much", not "this is fine". The
 * distinction matters for the unobservable cases, where no amount of product
 * data would have predicted the loss.
 */
function assessConfidence(
  observedDays: number,
  tickets: readonly SupportTicket[],
  subscriptions: readonly Subscription[],
  signals: readonly RiskSignal[],
): Confidence {
  const thin =
    observedDays < 60 || (tickets.length === 0 && subscriptions.length < 3);
  if (thin) return "low";

  const supporting = signals.filter((s) => s.points > 0);
  const contradicting = signals.filter(
    (s) => s.direction === "contradicting" && s.points === 0,
  );

  // Signals all pointing the same way is a clearer read than a split verdict.
  const mixed =
    supporting.length > 0 && contradicting.length > supporting.length;
  if (observedDays >= 90 && !mixed) return "high";
  return "medium";
}

function buildReason(level: RiskLevel, signals: readonly RiskSignal[]): string {
  const firing = signals
    .filter((s) => s.points > 0)
    .sort((a, b) => b.points - a.points);

  if (firing.length === 0) {
    return "No risk signals fired across usage, support or billing.";
  }

  const lead = firing
    .slice(0, 3)
    .map((s) => s.headline.charAt(0).toLowerCase() + s.headline.slice(1));
  const rest = firing.length > 3 ? `, and ${firing.length - 3} more` : "";
  return `Scored ${level} on ${lead.join("; ")}${rest}.`;
}
