"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { formatCurrency, formatPercent } from "@/lib/format";
import type { RenewalStatus } from "@/lib/time";
import type { Confidence, RiskLevel } from "@/lib/risk-engine";
import {
  RISK_LEVELS,
  riskBadgeClass,
  riskLabel,
  riskRank,
} from "@/lib/risk-display";
import { Sparkline } from "./Sparkline";

/**
 * Countdowns and trend deltas are computed on the server and passed in as
 * finished strings so the client never re-derives them from its own clock,
 * which could disagree with the server across a midnight boundary and produce
 * a hydration mismatch.
 *
 * The two date fields answer different questions and come from different
 * reference points (see lib/time.ts): renewal* from real wall-clock time,
 * recordedThroughLabel from the account's latest recorded usage day.
 */
export interface DashboardRow {
  customerId: string;
  company: string;
  industry: string;
  plan: string;
  mrr: number;
  sparkline: number[];
  sparklineDays: number;
  /** End of the sparkline's on-record window; null when there is no usage. */
  recordedThroughLabel: string | null;
  /** Last 30 days on record vs the 30 before; null when there is no prior window. */
  trendPct: number | null;
  trendWindowDays: number;
  /** Days with at least one session, out of activityWindowDays on record. */
  activeDays: number;
  activityWindowDays: number;
  activeDaysPrior: number;
  /** activeDays - activeDaysPrior; null when the prior window is a different length. */
  activeDaysDelta: number | null;

  /** Live engine assessment. Active cohort only — churned accounts are not scored. */
  risk: {
    level: RiskLevel;
    score: number;
    confidence: Confidence;
    reason: string;
    firingSignals: number;
  } | null;
  renewalDateLabel: string;
  renewalDays: number;
  renewalCountdown: string;
  renewalStatus: RenewalStatus;

  /** Retrospective labelling. Lost cohort only. */
  lost: {
    badgeLabel: string;
    badgeClass: string;
    badgeRank: number;
    churnDateLabel: string;
    churnDays: number;
    reason: string;
  } | null;
}

export type TableVariant = "active" | "lost";

type SortKey =
  | "company"
  | "industry"
  | "plan"
  | "mrr"
  | "trend"
  | "active"
  | "status"
  | "renewal"
  | "churned";

interface Column {
  key: SortKey;
  label: string;
  numeric?: boolean;
}

const ACTIVE_COLUMNS: Column[] = [
  { key: "company", label: "Company" },
  { key: "industry", label: "Industry" },
  { key: "plan", label: "Plan" },
  { key: "mrr", label: "MRR", numeric: true },
  { key: "trend", label: "Sessions 30d vs prior" },
  { key: "active", label: "Active 30d", numeric: true },
  { key: "status", label: "Risk", numeric: false },
  { key: "renewal", label: "Renewal" },
];

/* No renewal column for lost accounts: a churned account's renewal_date equals
   its outcome_date, so the column would just restate the churn date under a
   heading that implies a live contract. Churn date and reason instead. */
const LOST_COLUMNS: Column[] = [
  { key: "company", label: "Company" },
  { key: "industry", label: "Industry" },
  { key: "plan", label: "Plan" },
  { key: "mrr", label: "MRR lost", numeric: true },
  { key: "trend", label: "Sessions 30d pre-churn vs prior" },
  { key: "active", label: "Active 30d pre-churn", numeric: true },
  { key: "status", label: "Retrospective grading" },
  { key: "churned", label: "Churned" },
];

/** Ascending for text, descending for the columns where "biggest" is the story. */
const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  company: "asc",
  industry: "asc",
  plan: "asc",
  mrr: "desc",
  trend: "asc",
  active: "asc",
  status: "asc",
  renewal: "asc",
  churned: "desc",
};

export function CustomerTable({
  rows,
  variant,
}: {
  rows: DashboardRow[];
  variant: TableVariant;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [planFilter, setPlanFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const columns = variant === "active" ? ACTIVE_COLUMNS : LOST_COLUMNS;

  const plans = useMemo(
    () =>
      [...new Set(rows.map((r) => r.plan))].sort((a, b) => a.localeCompare(b)),
    [rows],
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();

    const filtered = rows.filter((row) => {
      if (planFilter !== "all" && row.plan !== planFilter) return false;
      if (
        variant === "active" &&
        statusFilter !== "all" &&
        row.risk?.level !== statusFilter
      ) {
        return false;
      }
      if (!needle) return true;
      return (
        row.company.toLowerCase().includes(needle) ||
        row.industry.toLowerCase().includes(needle) ||
        row.customerId.toLowerCase().includes(needle)
      );
    });

    const direction = sortDir === "asc" ? 1 : -1;

    return filtered.sort((a, b) => {
      switch (sortKey) {
        case "mrr":
          return (a.mrr - b.mrr) * direction;
        case "trend":
          // Nulls (no computable trend) always sort to the bottom.
          if (a.trendPct === null && b.trendPct === null) return 0;
          if (a.trendPct === null) return 1;
          if (b.trendPct === null) return -1;
          return (a.trendPct - b.trendPct) * direction;
        case "status":
          if (variant === "active") {
            // Rank first so bands stay together, then score within a band.
            const byRank =
              (riskRank(a.risk?.level ?? "low") - riskRank(b.risk?.level ?? "low")) *
              direction;
            if (byRank !== 0) return byRank;
            const byScore = ((b.risk?.score ?? 0) - (a.risk?.score ?? 0)) * direction;
            return byScore || a.company.localeCompare(b.company);
          }
          return (
            ((a.lost?.badgeRank ?? 9) - (b.lost?.badgeRank ?? 9)) * direction ||
            a.company.localeCompare(b.company)
          );
        case "active":
          return (a.activeDays - b.activeDays) * direction;
        case "renewal":
          return (a.renewalDays - b.renewalDays) * direction;
        case "churned":
          return (
            ((a.lost?.churnDays ?? 0) - (b.lost?.churnDays ?? 0)) * direction
          );
        case "industry":
          return a.industry.localeCompare(b.industry) * direction;
        case "plan":
          return a.plan.localeCompare(b.plan) * direction;
        default:
          return a.company.localeCompare(b.company) * direction;
      }
    });
  }, [rows, search, planFilter, statusFilter, sortKey, sortDir, variant]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  }

  return (
    <>
      <div className="controls">
        <input
          className="input"
          type="search"
          placeholder="Search company, industry or ID…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search customers"
        />
        <select
          className="select"
          value={planFilter}
          onChange={(event) => setPlanFilter(event.target.value)}
          aria-label="Filter by plan"
        >
          <option value="all">All plans</option>
          {plans.map((plan) => (
            <option key={plan} value={plan}>
              {plan}
            </option>
          ))}
        </select>
        {variant === "active" && (
          <select
            className="select"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            aria-label="Filter by risk level"
          >
            <option value="all">All risk levels</option>
            {RISK_LEVELS.map((level) => (
              <option key={level} value={level}>
                {riskLabel(level)}
              </option>
            ))}
          </select>
        )}
        <span className="result-count">
          {visible.length} of {rows.length}
        </span>
      </div>

      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={column.numeric ? "num-cell" : undefined}
                  aria-sort={
                    sortKey === column.key
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    type="button"
                    className="sort-btn"
                    onClick={() => toggleSort(column.key)}
                  >
                    {column.label}
                    {sortKey === column.key && (
                      <span className="sort-arrow" aria-hidden="true">
                        {sortDir === "asc" ? "▲" : "▼"}
                      </span>
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr className="empty-row">
                <td colSpan={columns.length}>
                  No customers match those filters.
                </td>
              </tr>
            )}

            {visible.map((row) => (
              <tr
                key={row.customerId}
                onClick={(event) => {
                  // The company cell holds a real link for keyboard users; let it
                  // handle its own clicks rather than navigating twice.
                  if ((event.target as HTMLElement).closest("a")) return;
                  router.push(`/customer/${row.customerId}`);
                }}
              >
                <td>
                  <Link
                    className="company-cell"
                    href={`/customer/${row.customerId}`}
                  >
                    {row.company}
                  </Link>
                  <div className="cell-sub mono">{row.customerId}</div>
                </td>
                <td>{row.industry}</td>
                <td>{row.plan}</td>
                <td className="num-cell mono">{formatCurrency(row.mrr)}</td>
                <td>
                  <div className="trend-cell">
                    <Sparkline
                      values={row.sparkline}
                      label={`Sessions over the final ${row.sparklineDays} days on record${
                        row.recordedThroughLabel
                          ? `, to ${row.recordedThroughLabel}`
                          : ""
                      }`}
                    />
                    <span
                      className={`trend-delta mono ${trendToneClass(row.trendPct)}`}
                      title={`Average daily sessions over the last ${row.trendWindowDays} days on record, compared with the ${row.trendWindowDays} days before them. The sparkline covers ${row.sparklineDays} days. ${windowEndNote(row, variant)}`}
                    >
                      {formatPercent(row.trendPct)}
                    </span>
                  </div>
                </td>
                <td
                  className="num-cell"
                  title={`Days with at least one session in the last ${row.activityWindowDays} days on record, against the ${row.activityWindowDays} before them (${row.activeDaysPrior}/${row.activityWindowDays}). Counts silence, which an average cannot show. ${windowEndNote(row, variant)}`}
                >
                  <span
                    className={`mono ${activityToneClass(row.activeDays, row.activityWindowDays)}`}
                  >
                    {row.activeDays}/{row.activityWindowDays}
                  </span>
                  <div className="cell-sub mono">
                    {row.activeDaysDelta === null
                      ? "no prior"
                      : `${row.activeDaysDelta > 0 ? "+" : ""}${row.activeDaysDelta} vs prior`}
                  </div>
                </td>
                <td>
                  {variant === "active" && row.risk ? (
                    <div className="risk-cell" title={row.risk.reason}>
                      <span className={riskBadgeClass(row.risk.level)}>
                        {riskLabel(row.risk.level)}
                      </span>
                      <span className="risk-score mono">
                        {row.risk.score}
                        <span className="risk-score-sub">
                          /100 · {row.risk.firingSignals} signal
                          {row.risk.firingSignals === 1 ? "" : "s"}
                        </span>
                      </span>
                    </div>
                  ) : (
                    <span className={row.lost?.badgeClass}>
                      {row.lost?.badgeLabel}
                    </span>
                  )}
                </td>
                {variant === "active" ? (
                  <td>
                    <div className="mono">{row.renewalDateLabel}</div>
                    <div
                      className={`cell-sub mono renewal-${row.renewalStatus}`}
                    >
                      {row.renewalCountdown}
                    </div>
                  </td>
                ) : (
                  <td>
                    <div className="mono">{row.lost?.churnDateLabel}</div>
                    <div className="cell-sub">{row.lost?.reason}</div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Colour is a reading aid, not a risk verdict — the only risk signal in this
 * build is the clearly-labelled placeholder badge. These thresholds mirror
 * EVIDENCE_THRESHOLDS so the table and the evidence panel never contradict
 * each other on the same account.
 */
function trendToneClass(pct: number | null): string {
  if (pct === null) return "tone-none";
  if (pct <= -25) return "tone-bad";
  if (pct <= -8) return "tone-warn";
  return "tone-ok";
}

function activityToneClass(activeDays: number, windowDays: number): string {
  if (windowDays === 0) return "tone-none";
  const silent = windowDays - activeDays;
  if (silent >= 10) return "tone-bad";
  if (silent > 3) return "tone-warn";
  return "tone-ok";
}

/**
 * Says which day a usage window actually ends on.
 *
 * Without this the figures read as "the last 30 days", which they are not: they
 * end at each account's last day on record. For a churned account that is its
 * outcome_date, so an account that left in May shows its final 30 days alive,
 * not an empty recent window — the single most confusable thing in this table.
 */
function windowEndNote(row: DashboardRow, variant: TableVariant): string {
  if (!row.recordedThroughLabel) return "";
  return variant === "lost"
    ? `Window ends ${row.recordedThroughLabel}, the day this account churned — not the last 30 calendar days.`
    : `Window ends ${row.recordedThroughLabel}, the last day with usage on record.`;
}
