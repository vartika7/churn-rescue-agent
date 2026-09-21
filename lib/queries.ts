import "server-only";

import { getSupabase, selectAll } from "./supabase";
import type {
  Customer,
  CustomerOutcome,
  EvaluationCase,
  SupportTicket,
  Subscription,
  UsageDaily,
} from "./types";

const CUSTOMER_COLUMNS =
  "customer_id, company, plan, mrr, signup_date, renewal_date, industry, company_size";
const USAGE_COLUMNS =
  "customer_id, date, logins, sessions, key_actions, feature_usage";
const TICKET_COLUMNS =
  "ticket_id, customer_id, date, subject, description, category, sentiment, resolution_status";
const SUBSCRIPTION_COLUMNS =
  "customer_id, date, plan, mrr, payment_status, change_type";
const OUTCOME_COLUMNS = "customer_id, outcome, outcome_date, reason";

/** Placeholder risk signal, plus the case_type needed to label lost accounts. */
export type PlaceholderRiskCase = Pick<
  EvaluationCase,
  | "customer_id"
  | "expected_risk_level"
  | "expected_recommendation"
  | "case_type"
>;

const RISK_CASE_COLUMNS =
  "customer_id, expected_risk_level, expected_recommendation, case_type";

/**
 * Placeholder risk signal for the dashboard badges only.
 *
 * `evaluation_cases` is evaluation ground truth. It is read here purely so the
 * UI has something to render until the Phase 4 risk engine and Phase 5
 * investigation agent populate `risk_assessments` / `investigations`, and every
 * surface that shows it is labeled as placeholder data. Nothing that simulates
 * the real assessment path may call this, and `actual_outcome` is intentionally
 * left unselected so the outcome cannot leak in through this table.
 */
export async function fetchPlaceholderRiskCases(): Promise<
  PlaceholderRiskCase[]
> {
  return selectAll("evaluation_cases", RISK_CASE_COLUMNS, [
    { column: "customer_id" },
  ]);
}

export async function fetchPlaceholderRiskCase(
  customerId: string,
): Promise<PlaceholderRiskCase | null> {
  const { data, error } = await getSupabase()
    .from("evaluation_cases")
    .select(RISK_CASE_COLUMNS)
    .eq("customer_id", customerId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Supabase read failed on "evaluation_cases": ${error.message}`,
    );
  }
  return data ?? null;
}

/**
 * Who actually left. `customers` carries no outcome column, so this join is
 * required to keep churned accounts out of the active worklist — see the note
 * on `CustomerOutcome` for why that separation matters.
 */
export async function fetchCustomerOutcomes(): Promise<CustomerOutcome[]> {
  return selectAll("customer_outcomes", OUTCOME_COLUMNS, [
    { column: "customer_id" },
  ]);
}

export async function fetchCustomerOutcome(
  customerId: string,
): Promise<CustomerOutcome | null> {
  const { data, error } = await getSupabase()
    .from("customer_outcomes")
    .select(OUTCOME_COLUMNS)
    .eq("customer_id", customerId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Supabase read failed on "customer_outcomes": ${error.message}`,
    );
  }
  return data ?? null;
}

export async function fetchCustomers(): Promise<Customer[]> {
  return selectAll("customers", CUSTOMER_COLUMNS, [{ column: "company" }]);
}

/**
 * Sessions for every customer's whole history, for the dashboard sparklines.
 *
 * Deliberately unfiltered by date. The sparkline shows each customer's last 90
 * days *on record*, and those records end at different places: 2026-10-31 for
 * retained accounts, `outcome_date` for churned ones. A calendar window pinned
 * to the dataset's today would return nothing at all for an account that left
 * in May. ~8,300 narrow rows is cheap, and `selectAll` pages past the 1000-row
 * cap; ordering by (customer_id, date) keeps each customer's slice
 * chronological without a second sort.
 */
export async function fetchAllSessions(): Promise<
  Pick<UsageDaily, "customer_id" | "date" | "sessions">[]
> {
  return selectAll("usage_daily", "customer_id, date, sessions", [
    { column: "customer_id" },
    { column: "date" },
  ]);
}

export async function fetchCustomer(
  customerId: string,
): Promise<Customer | null> {
  const { data, error } = await getSupabase()
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .eq("customer_id", customerId)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase read failed on "customers": ${error.message}`);
  }
  return (data as Customer | null) ?? null;
}

/** Full observed history for one customer, oldest first. */
export async function fetchCustomerUsage(
  customerId: string,
): Promise<UsageDaily[]> {
  return selectAll("usage_daily", USAGE_COLUMNS, [{ column: "date" }], {
    eq: { customer_id: customerId },
  });
}

/** Newest first, for display. */
export async function fetchCustomerTickets(
  customerId: string,
): Promise<SupportTicket[]> {
  return selectAll(
    "support_tickets",
    TICKET_COLUMNS,
    [
      { column: "date", ascending: false },
      { column: "ticket_id", ascending: false },
    ],
    { eq: { customer_id: customerId } },
  );
}

/** Billing-cycle charge events, newest first. Never labeled "renewal". */
export async function fetchCustomerSubscriptions(
  customerId: string,
): Promise<Subscription[]> {
  return selectAll(
    "subscriptions",
    SUBSCRIPTION_COLUMNS,
    [{ column: "date", ascending: false }],
    { eq: { customer_id: customerId } },
  );
}

/** Every ticket, for scoring the whole book in one page render. 43 rows. */
export async function fetchAllTickets(): Promise<SupportTicket[]> {
  return selectAll("support_tickets", TICKET_COLUMNS, [
    { column: "customer_id" },
    { column: "date" },
  ]);
}

/** Every charge, for scoring the whole book in one page render. ~293 rows. */
export async function fetchAllSubscriptions(): Promise<Subscription[]> {
  return selectAll("subscriptions", SUBSCRIPTION_COLUMNS, [
    { column: "customer_id" },
    { column: "date" },
  ]);
}
