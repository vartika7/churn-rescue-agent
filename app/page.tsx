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
  parseRecommendation,
  retrospectiveBadge,
} from "@/lib/placeholder-risk";
import {
  fetchAllSessions,
  fetchAllSubscriptions,
  fetchAllTickets,
  fetchCustomerOutcomes,
  fetchCustomers,
  fetchPlaceholderRiskCases,
} from "@/lib/queries";
import { scoreCustomer, type RiskLevel } from "@/lib/risk-engine";
import {
  getLatestRecordedDate,
  getRealToday,
  relativeDayLabel,
  renewalCountdown,
  toISODate,
} from "@/lib/time";

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

  let customers, sessions, tickets, subscriptions, riskCases, outcomes;

  try {
    [customers, sessions, tickets, subscriptions, riskCases, outcomes] =
      await Promise.all([
        fetchCustomers(),
        fetchAllSessions(),
        fetchAllTickets(),
        fetchAllSubscriptions(),
        fetchPlaceholderRiskCases(),
        fetchCustomerOutcomes(),
      ]);
  } catch (error) {
    return <SetupError error={error} />;
  }

  const groupBy = <T extends { customer_id: string }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) {
      const list = map.get(row.customer_id);
      if (list) list.push(row);
      else map.set(row.customer_id, [row]);
    }
    return map;
  };

  // Ordered by (customer_id, date) in the queries, so each array is already
  // chronological — which is what the analysis primitives require.
  const usageBy = groupBy(sessions);
  const ticketsBy = groupBy(tickets);
  const subsBy = groupBy(subscriptions);

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
    const history = usageBy.get(customer.customer_id) ?? [];

    // Usage window: last 90 days ON RECORD for this customer, anchored to its
    // own latest recorded date rather than real today.
    const windowRows = history.slice(-SPARKLINE_DAYS);
    const sparkline = windowRows.map((r) => r.sessions);
    const recordedThrough = getLatestRecordedDate(history);
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
      renewalDateLabel: formatDate(customer.renewal_date),
      renewalDays: countdown.days,
      renewalCountdown: countdown.label,
      renewalStatus: countdown.status,
    };

    const isRetained = (outcome?.outcome ?? "").toLowerCase() === "retained";

    if (isRetained) {
      // Scored live rather than read from `risk_assessments`: that table is
      // only populated when POST /api/assess runs, and a dashboard that shows
      // nothing until a job has been triggered is a worse dashboard. The
      // stored rows exist to give Phases 6 and 7 a history to work against.
      const assessment = scoreCustomer({
        usage: history,
        tickets: ticketsBy.get(customer.customer_id) ?? [],
        subscriptions: subsBy.get(customer.customer_id) ?? [],
      });

      activeRows.push({
        ...base,
        risk: {
          level: assessment.riskLevel,
          score: assessment.score,
          confidence: assessment.confidence,
          reason: assessment.reason,
          firingSignals: assessment.signals.filter((s) => s.points > 0).length,
        },
        lost: null,
      });
    } else {
      // Churned accounts are never scored — see lib/risk-store.ts. They keep
      // the retrospective grading from `evaluation_cases`.
      const recommendation = parseRecommendation(
        riskCase?.expected_recommendation,
      );
      const badge = retrospectiveBadge(recommendation, riskCase?.case_type);
      const churn = outcome
        ? relativeDayLabel(outcome.outcome_date, realToday)
        : null;

      lostRows.push({
        ...base,
        risk: null,
        lost: {
          badgeLabel: badge.label,
          badgeClass: badge.className,
          badgeRank: badge.rank,
          churnDateLabel: outcome
            ? formatDate(outcome.outcome_date)
            : "unknown",
          churnDays: churn?.days ?? 0,
          reason: outcome?.reason ?? "",
        },
      });
    }
  }

  const counts: Record<RiskLevel, number> = { high: 0, medium: 0, low: 0 };
  let mrrAtRisk = 0;
  let activeMrr = 0;

  for (const row of activeRows) {
    activeMrr += row.mrr;
    if (!row.risk) continue;
    counts[row.risk.level] += 1;
    // High and medium both count: medium is "worth a call", which is still
    // revenue you would act to keep.
    if (row.risk.level !== "low") mrrAtRisk += row.mrr;
  }

  const lostMrr = lostRows.reduce((sum, row) => sum + row.mrr, 0);
  const rows = variant === "active" ? activeRows : lostRows;

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <h1 className="page-title">Portfolio risk overview</h1>
          <p className="page-desc">
            {activeRows.length} active accounts, {lostRows.length} lost · live
            from Supabase · today is{" "}
            <span className="mono">{formatDate(toISODate(realToday))}</span>
          </p>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat stat-intervene">
          <div className="stat-label">High risk</div>
          <div className="stat-value mono">{counts.high}</div>
          <div className="stat-foot">active accounts, score 50+</div>
        </div>
        <div className="stat stat-monitor">
          <div className="stat-label">Medium risk</div>
          <div className="stat-value mono">{counts.medium}</div>
          <div className="stat-foot">active accounts, score 25-49</div>
        </div>
        <div className="stat stat-healthy">
          <div className="stat-label">Low risk</div>
          <div className="stat-value mono">{counts.low}</div>
          <div className="stat-foot">active accounts, no or minor signals</div>
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
          <>
            <PrototypeNote>
              Lost accounts are <strong>not</strong> scored by the risk engine —
              there is no next action for an account that has gone. These
              gradings come from <code>evaluation_cases</code> ground truth and
              answer &ldquo;would intervening have been right, on the data
              available before they left?&rdquo;
            </PrototypeNote>
            <div className="notice notice-info" role="note">
              <span className="notice-icon" aria-hidden="true">
                ⓘ
              </span>
              <div>
                <strong>Retrospective view — not a worklist.</strong> Renewal
                dates are omitted because a churned account&apos;s{" "}
                <code>renewal_date</code> is its churn date; the churn column
                below already carries it.
              </div>
            </div>
          </>
        ) : (
          <div className="section-head">
            <h2 className="section-title">Active accounts</h2>
            <span className="section-note">
              Risk scored live by the Phase 4 engine from usage, support and
              billing. Click any row for the signals behind a score.
            </span>
          </div>
        )}

        <CustomerTable rows={rows} variant={variant} />
      </section>
    </main>
  );
}
