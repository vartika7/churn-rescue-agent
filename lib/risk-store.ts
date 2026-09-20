import "server-only";

import { scoreCustomer, type RiskAssessment } from "./risk-engine";
import { getSupabase, selectAll } from "./supabase";
import type {
  Customer,
  CustomerOutcome,
  SupportTicket,
  Subscription,
  UsageDaily,
} from "./types";

/**
 * Phase 4 persistence.
 *
 * Assessments are INSERTed, never updated: `risk_assessments` has a surrogate
 * key and a `created_at`, so each run appends a new row and the table becomes a
 * history. That is what lets a later phase say "this account's risk rose
 * through October" rather than only ever showing the latest verdict. Readers
 * take the most recent row per customer.
 */

export interface StoredAssessment {
  customer_id: string;
  risk_level: string;
  risk_reason: string;
  confidence: string;
  evidence: unknown;
  created_at: string;
}

const ASSESSMENT_COLUMNS =
  "customer_id, risk_level, risk_reason, confidence, evidence, created_at";

/**
 * Scores every currently-active customer and appends the results.
 *
 * Churned customers are excluded, and not as an afterthought: a risk
 * assessment is a statement about what to do next, and there is nothing to do
 * next for an account that has already gone. Their data belongs to the Phase 7
 * evaluation harness, which replays the engine against them using `asOf`.
 *
 * The outcome is used *only* to choose whom to score. `scoreCustomer` cannot
 * see it — its signature has no parameter for it.
 */
export async function assessActiveCustomers(): Promise<{
  assessed: number;
  skippedChurned: number;
  results: { customerId: string; assessment: RiskAssessment }[];
}> {
  const [customers, outcomes, usage, tickets, subscriptions] =
    await Promise.all([
      selectAll<Customer>("customers", "customer_id", [
        { column: "customer_id" },
      ]),
      selectAll<CustomerOutcome>("customer_outcomes", "customer_id, outcome", [
        { column: "customer_id" },
      ]),
      selectAll<UsageDaily>(
        "usage_daily",
        "customer_id, date, logins, sessions, key_actions, feature_usage",
        [{ column: "customer_id" }, { column: "date" }],
      ),
      selectAll<SupportTicket>(
        "support_tickets",
        "ticket_id, customer_id, date, subject, description, category, sentiment, resolution_status",
        [{ column: "customer_id" }, { column: "date" }],
      ),
      selectAll<Subscription>(
        "subscriptions",
        "customer_id, date, plan, mrr, payment_status, change_type",
        [{ column: "customer_id" }, { column: "date" }],
      ),
    ]);

  const retained = new Set(
    outcomes
      .filter((o) => (o.outcome ?? "").toLowerCase() === "retained")
      .map((o) => o.customer_id),
  );

  const group = <T extends { customer_id: string }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) {
      const list = map.get(row.customer_id);
      if (list) list.push(row);
      else map.set(row.customer_id, [row]);
    }
    return map;
  };
  const usageBy = group(usage);
  const ticketsBy = group(tickets);
  const subsBy = group(subscriptions);

  const results: { customerId: string; assessment: RiskAssessment }[] = [];
  const rows = [];

  for (const customer of customers) {
    if (!retained.has(customer.customer_id)) continue;

    const assessment = scoreCustomer({
      usage: usageBy.get(customer.customer_id) ?? [],
      tickets: ticketsBy.get(customer.customer_id) ?? [],
      subscriptions: subsBy.get(customer.customer_id) ?? [],
    });

    results.push({ customerId: customer.customer_id, assessment });
    rows.push({
      customer_id: customer.customer_id,
      risk_level: assessment.riskLevel,
      risk_reason: assessment.reason,
      confidence: assessment.confidence,
      // The whole assessment goes in, not just the firing signals: a zero-point
      // signal is the record that something was checked and found clean, which
      // is what Phase 5 needs to argue *against* risk rather than stay silent.
      evidence: {
        score: assessment.score,
        window: assessment.window,
        signals: assessment.signals,
      },
    });
  }

  if (rows.length > 0) {
    const { error } = await getSupabase().from("risk_assessments").insert(rows);
    if (error) {
      throw new Error(`Failed to write risk_assessments: ${error.message}`);
    }
  }

  return {
    assessed: results.length,
    skippedChurned: customers.length - results.length,
    results,
  };
}

/** Most recent assessment per customer, or an empty map before the first run. */
export async function fetchLatestAssessments(): Promise<
  Map<string, StoredAssessment>
> {
  const rows = await selectAll<StoredAssessment>(
    "risk_assessments",
    ASSESSMENT_COLUMNS,
    [{ column: "created_at", ascending: false }],
  );

  const latest = new Map<string, StoredAssessment>();
  for (const row of rows) {
    // Rows arrive newest first, so the first one seen per customer wins.
    if (!latest.has(row.customer_id)) latest.set(row.customer_id, row);
  }
  return latest;
}

export async function fetchLatestAssessment(
  customerId: string,
): Promise<StoredAssessment | null> {
  const { data, error } = await getSupabase()
    .from("risk_assessments")
    .select(ASSESSMENT_COLUMNS)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Supabase read failed on "risk_assessments": ${error.message}`,
    );
  }
  return (data as StoredAssessment | null) ?? null;
}
