"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { formatCurrency, formatPercent } from "@/lib/format";
import type { RenewalStatus } from "@/lib/time";
import {
  RECOMMENDATIONS,
  recommendationBadgeClass,
  recommendationLabel,
  recommendationRank,
} from "@/lib/placeholder-risk";
import type { Recommendation } from "@/lib/types";
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
  trendPct: number | null;

  /** Present-tense placeholder status. Active cohort only. */
  recommendation: Recommendation | null;
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
    churnCountdown: string;
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
  { key: "trend", label: "90d sessions" },
  { key: "status", label: "Status" },
  { key: "renewal", label: "Renewal" },
];

/* No renewal column for lost accounts. Since migration 17 a churned account's
   renewal_date equals its outcome_date, so the column would just restate the
   churn date under a heading that implies a live contract. Churn date and
   reason instead. */
const LOST_COLUMNS: Column[] = [
  { key: "company", label: "Company" },
  { key: "industry", label: "Industry" },
  { key: "plan", label: "Plan" },
  { key: "mrr", label: "MRR lost", numeric: true },
  { key: "trend", label: "Final 90d sessions" },
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
        (row.recommendation ?? "none") !== statusFilter
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
          return variant === "active"
            ? (recommendationRank(a.recommendation) -
                recommendationRank(b.recommendation)) *
                direction || a.company.localeCompare(b.company)
            : ((a.lost?.badgeRank ?? 9) - (b.lost?.badgeRank ?? 9)) *
                direction || a.company.localeCompare(b.company);
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
            aria-label="Filter by placeholder status"
          >
            <option value="all">All statuses</option>
            {RECOMMENDATIONS.map((rec) => (
              <option key={rec} value={rec}>
                {recommendationLabel(rec)}
              </option>
            ))}
            <option value="none">No case data</option>
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
                    <span className="trend-delta mono">
                      {formatPercent(row.trendPct)}
                    </span>
                  </div>
                </td>
                <td>
                  {variant === "active" ? (
                    <span
                      className={recommendationBadgeClass(row.recommendation)}
                    >
                      {recommendationLabel(row.recommendation)}
                    </span>
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
