import { EVIDENCE_THRESHOLDS } from "./constants";
import { formatCurrency, formatDate, formatPercent } from "./format";
import type { SupportTicket, Subscription, UsageDaily } from "./types";

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

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

export type EvidenceSource = "Usage" | "Support" | "Billing";

export interface EvidenceItem {
  source: EvidenceSource;
  headline: string;
  detail?: string;
}

export interface EvidenceSplit {
  supporting: EvidenceItem[];
  contradicting: EvidenceItem[];
}

/**
 * Normalises a status/sentiment string so that "Past Due", "past-due" and
 * "past_due" all compare equal. The exact casing used in the seeded data has
 * not been verified against the live table, so matching is deliberately loose.
 */
function normalise(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

const OPEN_TICKET_STATUSES = new Set([
  "unresolved",
  "escalated",
  "open",
  "in_progress",
  "pending",
]);

const RESOLVED_TICKET_STATUSES = new Set(["resolved", "closed"]);

const BAD_PAYMENT_STATUSES = new Set(["past_due", "payment_failed", "failed"]);

/**
 * Builds the supporting / contradicting evidence split from real data signals.
 *
 * IMPORTANT: this is a UI-layer stand-in for the real Phase 5 AI investigation
 * agent, not the risk engine itself. The thresholds it leans on were rough
 * placeholders in the validated prototype and Phase 4/5 are expected to
 * replace or substantially extend them. It deliberately reads only
 * `usage_daily`, `support_tickets` and `subscriptions` — never
 * `customer_outcomes` or `evaluation_cases`, which would leak ground truth
 * into the assessment path.
 */
export function buildEvidence(
  usage: UsageDaily[],
  tickets: SupportTicket[],
  subscriptions: Subscription[],
): EvidenceSplit {
  const supporting: EvidenceItem[] = [];
  const contradicting: EvidenceItem[] = [];

  // Sorted once; both usage windows below are slices off the end of this, i.e.
  // anchored to the latest date on record for this customer.
  const sorted = [...usage].sort((a, b) => a.date.localeCompare(b.date));
  const sessions = sorted.map((day) => day.sessions);

  /* --- Usage: trend ------------------------------------------------ */
  const trend = sessionsTrend(sessions);
  if (trend.pctChange !== null) {
    const delta = formatPercent(trend.pctChange);
    const detail =
      `Avg sessions/day went from ${trend.earlyAvg.toFixed(1)} in the first third ` +
      `of ${trend.observedDays} observed days to ${trend.lateAvg.toFixed(1)} in the last third.`;

    if (trend.pctChange <= EVIDENCE_THRESHOLDS.usageStrongDeclinePct) {
      supporting.push({
        source: "Usage",
        // Magnitude only — "down -93%" reads as a double negative.
        headline: `Sessions down ${Math.abs(Math.round(trend.pctChange))}% across observed history`,
        detail,
      });
    } else if (trend.pctChange >= EVIDENCE_THRESHOLDS.usageHealthyPct) {
      contradicting.push({
        source: "Usage",
        headline: `Sessions broadly stable (${delta})`,
        detail,
      });
    } else {
      // Between the two thresholds: a real but not decisive decline.
      supporting.push({
        source: "Usage",
        headline: `Mild session decline (${delta})`,
        detail,
      });
    }
  }

  /* --- Usage: zero-activity days ----------------------------------- */
  const zero = zeroActivityDays(sorted);
  if (zero.windowDays > 0) {
    // Spelling out the window's end date matters: "in the last 30 days" would
    // otherwise read as 30 days from now, and for a churned account the window
    // ends at its outcome_date, months before real today.
    const window = `the ${zero.windowDays} days on record to ${formatDate(zero.to!)}`;

    if (zero.count >= EVIDENCE_THRESHOLDS.zeroActivitySupportingDays) {
      supporting.push({
        source: "Usage",
        headline: `${zero.count} zero-session days in ${window}`,
        detail: "Extended inactivity rather than reduced activity.",
      });
    } else if (
      zero.count <= EVIDENCE_THRESHOLDS.zeroActivityContradictingDays
    ) {
      contradicting.push({
        source: "Usage",
        headline:
          zero.count === 0
            ? `No zero-session days in ${window}`
            : `Only ${zero.count} zero-session day${zero.count === 1 ? "" : "s"} in ${window}`,
        detail: "Engagement is still near-daily.",
      });
    }
    // 4-9 zero days intentionally produces no item: the prototype's heuristic
    // treats that band as inconclusive.
  }

  /* --- Support ----------------------------------------------------- */
  const openTickets = tickets.filter((t) =>
    OPEN_TICKET_STATUSES.has(normalise(t.resolution_status)),
  );
  const positiveTickets = tickets.filter(
    (t) => normalise(t.sentiment) === "positive",
  );

  for (const ticket of openTickets) {
    supporting.push({
      source: "Support",
      headline: `${titleCase(ticket.resolution_status)} ticket: "${ticket.subject}"`,
      detail: `Opened ${formatDate(ticket.date)} · ${ticket.category} · ${ticket.sentiment} sentiment`,
    });
  }

  if (tickets.length === 0) {
    contradicting.push({
      source: "Support",
      headline: "No support tickets on record",
      detail: "No signal of friction through the support channel.",
    });
  } else if (
    openTickets.length === 0 &&
    tickets.every((t) =>
      RESOLVED_TICKET_STATUSES.has(normalise(t.resolution_status)),
    )
  ) {
    contradicting.push({
      source: "Support",
      headline: `All ${tickets.length} ticket${tickets.length === 1 ? "" : "s"} resolved, none open`,
      detail: "Issues raised were closed out.",
    });
  }

  for (const ticket of positiveTickets) {
    contradicting.push({
      source: "Support",
      headline: `Positive-sentiment ticket: "${ticket.subject}"`,
      // Positive sentiment often carries a benign explanation for a usage dip
      // (a reorg, a seasonal slowdown) rather than dissatisfaction.
      detail: `${formatDate(ticket.date)} — may point to a benign explanation for a usage change.`,
    });
  }

  /* --- Billing ----------------------------------------------------- */
  // These rows are billing-cycle charge events, not contract renewals.
  //
  // Both columns are checked because the failure signal is not confined to
  // `payment_status`: in the live data the one bad charge (C014, 2026-05-09)
  // carries payment_status "past_due" AND change_type "payment_failed", and
  // `change_type` otherwise holds "renewal"/"new". The brief's rule is "any
  // past_due or payment_failed row", so a row flagged in either column counts.
  const badCharges = subscriptions.filter(
    (s) =>
      BAD_PAYMENT_STATUSES.has(normalise(s.payment_status)) ||
      BAD_PAYMENT_STATUSES.has(normalise(s.change_type)),
  );

  if (badCharges.length > 0) {
    const recent = [...badCharges].sort((a, b) => b.date.localeCompare(a.date));
    const dates = recent
      .slice(0, 3)
      .map((s) => formatDate(s.date))
      .join(", ");
    supporting.push({
      source: "Billing",
      headline: `${badCharges.length} failed or past-due billing charge${badCharges.length === 1 ? "" : "s"}`,
      detail: `Most recent: ${dates}${recent.length > 3 ? " (+ earlier)" : ""} · ${formatCurrency(recent[0].mrr)}`,
    });
  } else if (subscriptions.length > 0) {
    contradicting.push({
      source: "Billing",
      headline: `Clean payment history across ${subscriptions.length} billing charge${subscriptions.length === 1 ? "" : "s"}`,
      detail: "No past-due or failed charges on record.",
    });
  }

  return { supporting, contradicting };
}

function titleCase(value: string): string {
  const cleaned = (value ?? "").replace(/_/g, " ").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
