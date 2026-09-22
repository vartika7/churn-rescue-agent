/* No `import "server-only"` here, deliberately. This module is pure — it reads
   no environment variable and holds no credential — and it has to be importable
   by the test runner, which does not resolve Next's `server-only` shim. The
   guard belongs on the provider implementation that reads the API key, not on
   functions that transform data. */

import type { RiskAssessment } from "../risk-engine";
import type { SupportTicket, Subscription } from "../types";

/* ------------------------------------------------------------------ *
 * Phase 5 — the evidence package
 *
 * The only thing the model is ever shown. Two jobs:
 *
 * 1. LEAKAGE. `buildEvidencePackage` accepts no outcome, no
 *    `customer_outcomes` row, no `evaluation_cases` row — the same trick
 *    `scoreCustomer` uses. The signature gives ground truth nowhere to go, so
 *    "did the LLM see the answer?" is settled by reading the types rather than
 *    by auditing a prompt string.
 *
 * 2. GROUNDING. Every item carries a stable `id`. The model must cite those
 *    ids, which turns grounding from a hope into a check: a citation that does
 *    not resolve is a fabrication, and validation rejects it. That is the
 *    difference between asking a model to behave and being able to prove it
 *    did.
 * ------------------------------------------------------------------ */

export interface EvidenceItem {
  /** Stable citation id. The model refers to evidence by this and only this. */
  id: string;
  kind: "signal" | "ticket" | "charge" | "usage" | "account";
  /** One line, safe to show a CSM verbatim. */
  summary: string;
  /** Free text the model is expected to actually read, where there is any. */
  detail?: string;
  /**
   * Whether the deterministic layer read this as arguing for or against risk.
   * Passed through so the model can disagree with a reason, not so it can
   * launder the engine's verdict as its own reasoning.
   */
  direction?: "supporting" | "contradicting" | "neutral";
}

export interface EvidencePackage {
  customerId: string;
  /** Commercial context. Deliberately excludes anything outcome-derived. */
  account: {
    company: string;
    plan: string;
    mrr: number;
    industry: string;
    companySize: string;
    tenureDays: number;
  };
  risk: {
    level: string;
    score: number;
    confidence: string;
    /** The engine's own one-line summary, for the model to expand on. */
    reason: string;
  };
  usage: {
    observedDays: number;
    from: string | null;
    to: string | null;
  };
  items: EvidenceItem[];
}

/**
 * Inputs allowed into an investigation.
 *
 * Note what is absent and cannot be added without editing this type: outcome,
 * outcome_date, expected_risk_level, expected_recommendation, case_type.
 */
export interface EvidenceInput {
  customerId: string;
  company: string;
  plan: string;
  mrr: number;
  industry: string;
  companySize: string;
  signupDate: string;
  assessment: RiskAssessment;
  tickets: readonly SupportTicket[];
  charges: readonly Subscription[];
  /** Latest date on record for this customer, for tenure and recency. */
  recordedThrough: string | null;
}

const dayDiff = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86400000,
  );

/** `billing.2026-09-02` — dates are unique per customer in this dataset. */
const chargeId = (date: string) => `billing.${date}`;

export function buildEvidencePackage(input: EvidenceInput): EvidencePackage {
  const items: EvidenceItem[] = [];

  /* Deterministic signals, including the ones that scored zero. A signal at
     zero points is the record that something was checked and found clean —
     without it the model can only argue for risk, never against it. */
  for (const s of input.assessment.signals) {
    items.push({
      id: s.key,
      kind: "signal",
      summary: s.headline,
      detail: s.detail,
      direction: s.direction,
    });
  }

  /* Tickets are the reason this layer exists: subject and description are
     natural language that the rules only ever counted, never read. */
  for (const t of input.tickets) {
    items.push({
      id: t.ticket_id,
      kind: "ticket",
      summary: `${t.date} · ${t.category} · ${t.resolution_status} · ${t.sentiment} — ${t.subject}`,
      detail: t.description,
      direction:
        t.sentiment?.toLowerCase() === "positive" ? "contradicting" : "neutral",
    });
  }

  for (const c of input.charges) {
    items.push({
      id: chargeId(c.date),
      kind: "charge",
      summary: `${c.date} · $${c.mrr} · ${c.payment_status} · ${c.change_type}`,
      direction: "neutral",
    });
  }

  const tenureDays = input.recordedThrough
    ? dayDiff(input.signupDate, input.recordedThrough)
    : 0;

  return {
    customerId: input.customerId,
    account: {
      company: input.company,
      plan: input.plan,
      mrr: input.mrr,
      industry: input.industry,
      companySize: input.companySize,
      tenureDays,
    },
    risk: {
      level: input.assessment.riskLevel,
      score: input.assessment.score,
      confidence: input.assessment.confidence,
      reason: input.assessment.reason,
    },
    usage: {
      observedDays: input.assessment.window.observedDays,
      from: input.assessment.window.from,
      to: input.assessment.window.to,
    },
    items,
  };
}

/** Every citable id in a package. Validation checks claims against this. */
export function citableIds(pkg: EvidencePackage): Set<string> {
  return new Set(pkg.items.map((i) => i.id));
}
