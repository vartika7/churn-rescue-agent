import Link from "next/link";

import {
  CustomerTable,
  type DashboardRow,
  type TableVariant,
} from "@/components/CustomerTable";
import { PrototypeNote } from "@/components/PrototypeNote";
import { SetupError } from "@/components/SetupError";
import { activeDaysComparison, recentVsPriorTrend } from "@/lib/analysis";
import {
  ACTIVITY_WINDOW_DAYS,
  SPARKLINE_DAYS,
  TREND_WINDOW_DAYS,
} from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  getLatestRecordedDate,
  getRealToday,
  relativeDayLabel,
  renewalCountdown,
  toISODate,
} from "@/lib/time";
import {
  parseRecommendation,
  retrospectiveBadge,
} from "@/lib/placeholder-risk";
import {
  fetchAllSessions,
  fetchCustomerOutcomes,
  fetchCustomers,
  fetchPlaceholderRiskCases,
} from "@/lib/queries";
import type { Recommendation } from "@/lib/types";

/**
 * Without this, the Server Component's data fetch is cached at build time and a
 * row edited directly in the Supabase table editor would not appear until the
 * next deploy. This tool has to reflect live data on a plain browser refresh.
 */
export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const variant: TableVariant = view === "lost" ? "lost" : "active";

  let customers, sessions, riskCases, outcomes;

  try {
    [customers, sessions, riskCases, outcomes] = await Promise.all([
      fetchCustomers(),
      fetchAllSessions(),
      fetchPlaceholderRiskCases(),
      fetchCustomerOutcomes(),
    ]);
  } catch (error) {
    return <SetupError error={error} />;
  }

  // Ordered by (customer_id, date) in the query, so each array is chronological.
  // Dates are kept alongside sessions so each customer's usage window can be
  // anchored to its own latest recorded date.
  const usageByCustomer = new Map<
    string,
    { date: string; sessions: number }[]
  >();
  for (const row of sessions) {
    const entry = { date: row.date, sessions: row.sessions };
    const list = usageByCustomer.get(row.customer_id);
    if (list) list.push(entry);
    else usageByCustomer.set(row.customer_id, [entry]);
  }

  const caseByCustomer = new Map(riskCases.map((c) => [c.customer_id, c]));
  const outcomeByCustomer = new Map(outcomes.map((o) => [o.customer_id, o]));

  // Renewal countdowns are all measured against one real-clock read, so every
  // row on a given request agrees even if it straddles UTC midnight.
  const realToday = getRealToday();

  const activeRows: DashboardRow[] = [];
  const lostRows: DashboardRow[] = [];

  for (const customer of customers) {
    const outcome = outcomeByCustomer.get(customer.customer_id);
    const riskCase = caseByCustomer.get(customer.customer_id);
    const recommendation = parseRecommendation(
      riskCase?.expected_recommendation,
    );

    // Usage window: last 90 days ON RECORD for this customer, anchored to its
    // own latest recorded date rather than real today. Churned accounts' rows
    // stop at their outcome_date, so this gives each cohort a comparable final
    // stretch instead of an empty window.
    const history = usageByCustomer.get(customer.customer_id) ?? [];
    const windowRows = history.slice(-SPARKLINE_DAYS);
    const sparkline = windowRows.map((r) => r.sessions);
    const recordedThrough = getLatestRecordedDate(history);

    // Two different questions, deliberately kept apart. The trend answers "is
    // this falling off?" over adjacent 30-day windows; active days answers "is
    // anyone actually showing up?", which an average hides — 30 sessions spread
    // over 30 days and crammed into 3 average the same.
    const trend = recentVsPriorTrend(sparkline, TREND_WINDOW_DAYS);
    const activity = activeDaysComparison(windowRows, ACTIVITY_WINDOW_DAYS);

    // Renewal countdown: real wall-clock time, a different question entirely.
    const countdown = renewalCountdown(customer.renewal_date, realToday);

    const base = {
      customerId: customer.customer_id,
      company: customer.company,
      industry: customer.industry,
      plan: customer.plan,
      mrr: customer.mrr,
      sparkline,
      sparklineDays: sparkline.length,
      recordedThroughLabel: recordedThrough
        ? formatDate(recordedThrough)
        : null,
      trendPct: trend.pctChange,
      trendWindowDays: trend.recentDays,
      activeDays: activity.active,
      activityWindowDays: activity.days,
      activeDaysPrior: activity.priorActive,
      activeDaysDelta: activity.delta,
      recommendation,
      renewalDateLabel: formatDate(customer.renewal_date),
      renewalDays: countdown.days,
      renewalCountdown: countdown.label,
      renewalStatus: countdown.status,
    };

    const isRetained = (outcome?.outcome ?? "").toLowerCase() === "retained";

    if (isRetained) {
      activeRows.push({ ...base, lost: null });
    } else {
      const badge = retrospectiveBadge(recommendation, riskCase?.case_type);
      const churn = outcome
        ? relativeDayLabel(outcome.outcome_date, realToday)
        : null;
      lostRows.push({
        ...base,
        lost: {
          badgeLabel: badge.label,
          badgeClass: badge.className,
          badgeRank: badge.rank,
          churnDateLabel: outcome
            ? formatDate(outcome.outcome_date)
            : "unknown",
          churnDays: churn?.days ?? 0,
          churnCountdown: churn?.label ?? "",
          reason: outcome?.reason ?? "",
        },
      });
    }
  }

  // Summary is scoped to the active book. Including churned accounts would
  // inflate "MRR at risk" with revenue that is already gone.
  const counts: Record<Recommendation | "none", number> = {
    intervene: 0,
    monitor: 0,
    no_action: 0,
    none: 0,
  };
  let mrrAtRisk = 0;
  let activeMrr = 0;

  for (const row of activeRows) {
    activeMrr += row.mrr;
    counts[row.recommendation ?? "none"] += 1;
    if (row.recommendation === "intervene") mrrAtRisk += row.mrr;
  }

  const lostMrr = lostRows.reduce((sum, row) => sum + row.mrr, 0);
  const lostInterveneCount = lostRows.filter(
    (row) => row.recommendation === "intervene",
  ).length;
  const rows = variant === "active" ? activeRows : lostRows;

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <h1 className="page-title">Portfolio risk overview</h1>
          {/* One line on purpose. The date-anchor explanation this used to
              carry now lives in the per-column tooltips, where it is read at
              the moment it matters rather than skimmed past up here. */}
          <p className="page-desc">
            {activeRows.length} active accounts, {lostRows.length} lost · live
            from Supabase · today is{" "}
            <span className="mono">{formatDate(toISODate(realToday))}</span>
          </p>
        </div>
      </div>

      <PrototypeNote />

      <div className="stat-grid">
        <div className="stat stat-intervene">
          <div className="stat-label">Intervene</div>
          <div className="stat-value mono">{counts.intervene}</div>
          <div className="stat-foot">active accounts flagged for outreach</div>
        </div>
        <div className="stat stat-monitor">
          <div className="stat-label">Monitor</div>
          <div className="stat-value mono">{counts.monitor}</div>
          <div className="stat-foot">watch, no action yet</div>
        </div>
        <div className="stat stat-healthy">
          <div className="stat-label">No action</div>
          <div className="stat-value mono">{counts.no_action}</div>
          <div className="stat-foot">
            {counts.none > 0
              ? `${counts.none} without case data`
              : "healthy active accounts"}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">MRR at risk</div>
          <div className="stat-value mono">{formatCurrency(mrrAtRisk)}</div>
          <div className="stat-foot">
            {activeMrr > 0
              ? `${Math.round((mrrAtRisk / activeMrr) * 100)}% of active book`
              : "—"}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Active MRR</div>
          <div className="stat-value mono">{formatCurrency(activeMrr)}</div>
          <div className="stat-foot">{formatCurrency(activeMrr * 12)} ARR</div>
        </div>
        <div className="stat">
          <div className="stat-label">MRR already lost</div>
          <div className="stat-value mono">{formatCurrency(lostMrr)}</div>
          <div className="stat-foot">
            across {lostRows.length} churned accounts
          </div>
        </div>
      </div>

      {counts.intervene === 0 && (
        <div className="notice notice-info" role="note">
          <span className="notice-icon" aria-hidden="true">
            ⓘ
          </span>
          <div>
            <strong>
              No active account is flagged &ldquo;Intervene&rdquo;.
            </strong>{" "}
            That is a property of the placeholder data, not a bug: all{" "}
            {lostInterveneCount} <code>intervene</code> labels in{" "}
            <code>evaluation_cases</code> belong to accounts that have already
            churned, because the label grades whether intervening{" "}
            <em>would have been</em> right before they left. Producing a
            forward-looking risk signal for active accounts is precisely what
            the Phase 4 risk engine is for.
          </div>
        </div>
      )}

      <section className="section">
        <div className="tabs" role="tablist">
          <Link
            href="/"
            role="tab"
            aria-selected={variant === "active"}
            className={`tab${variant === "active" ? " tab-on" : ""}`}
          >
            Active worklist{" "}
            <span className="tab-count">{activeRows.length}</span>
          </Link>
          <Link
            href="/?view=lost"
            role="tab"
            aria-selected={variant === "lost"}
            className={`tab${variant === "lost" ? " tab-on" : ""}`}
          >
            Lost accounts <span className="tab-count">{lostRows.length}</span>
          </Link>
        </div>

        {variant === "lost" ? (
          <div className="notice notice-info" role="note">
            <span className="notice-icon" aria-hidden="true">
              ⓘ
            </span>
            <div>
              <strong>Retrospective view — not a worklist.</strong> These
              accounts have already left, so nothing here is actionable today; a
              win-back motion is a separate workflow. Gradings answer
              &ldquo;would intervening have been right, on the data available
              before they left?&rdquo; Renewal dates are omitted because a
              churned account&apos;s <code>renewal_date</code> is its churn
              date; the churn column below already carries it.
            </div>
          </div>
        ) : (
          <div className="section-head">
            <h2 className="section-title">Active accounts</h2>
            <span className="section-note">
              Sparkline shows daily sessions over each account&apos;s final{" "}
              {SPARKLINE_DAYS} days on record; the figure beside it is the
              change from the first third of that window to the last. Click any
              row for detail.
            </span>
          </div>
        )}

        <CustomerTable rows={rows} variant={variant} />
      </section>
    </main>
  );
}
