export type Plan = "Growth" | "Pro" | "Enterprise";

/** `evaluation_cases.expected_recommendation` — placeholder risk signal only. */
export type Recommendation = "intervene" | "monitor" | "no_action";

export interface Customer {
  customer_id: string;
  company: string;
  plan: string;
  mrr: number;
  signup_date: string;
  renewal_date: string;
  industry: string;
  company_size: string;
}

export interface UsageDaily {
  customer_id: string;
  date: string;
  logins: number;
  sessions: number;
  key_actions: number;
  feature_usage: number;
}

export interface SupportTicket {
  ticket_id: string;
  customer_id: string;
  date: string;
  subject: string;
  description: string;
  category: string;
  sentiment: string;
  resolution_status: string;
}

/**
 * Billing-cycle charge events (roughly monthly, 5-50 day gaps) — NOT contract
 * renewals. The next actual renewal is `customers.renewal_date`. Never label
 * these "renewal" in the UI.
 */
export interface Subscription {
  customer_id: string;
  date: string;
  plan: string;
  mrr: number;
  payment_status: string;
  change_type: string;
}

/**
 * Evaluation ground truth. Read ONLY for the dashboard's placeholder risk
 * badges, which are visibly labeled as such. Never read from anything that
 * simulates the real risk/AI workflow — that is data leakage.
 *
 * `actual_outcome` duplicates `customer_outcomes.outcome` (verified identical
 * on all 50 rows) and is deliberately never selected.
 */
export interface EvaluationCase {
  customer_id: string;
  actual_outcome: string;
  expected_risk_level: string;
  expected_recommendation: string;
  expected_root_cause: string;
  case_type: string;
}

export type Outcome = "retained" | "churned";

/**
 * Ground truth on who actually left.
 *
 * Read for exactly one purpose: splitting the dashboard into the active
 * worklist and the retrospective "Lost accounts" view. A churned customer is
 * not a live action queue — `expected_recommendation` is a backward-looking
 * grading label, so presenting a churned account with a present-tense
 * "Intervene" badge would tell a CSM to act on someone who left months ago.
 *
 * Still barred from anything that simulates the real risk/AI workflow: Phase
 * 4/5 must generate `risk_assessments` for active customers only, and churned
 * customers' data belongs to the Phase 7 evaluation harness.
 */
export interface CustomerOutcome {
  customer_id: string;
  outcome: string;
  outcome_date: string;
  reason: string;
}
