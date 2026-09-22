import "server-only";

import type { InvestigationOutcome } from "./investigation/run";
import { getSupabase } from "./supabase";

/**
 * Phase 5 persistence.
 *
 * Appended, never updated, for the same reason as `risk_assessments`: the
 * table becomes a record of what the model said and when, which is what lets
 * Phase 7 grade a run after the fact and what lets a disagreement be
 * reconstructed. An investigation that quietly overwrote the last one would
 * make "the model used to say something different" unanswerable.
 *
 * Only successful, validated investigations are stored. A response that cited
 * evidence it was never given is not a record of anything worth keeping, and
 * storing it would put unverified claims in the same table as verified ones.
 */

export interface StoredInvestigation {
  customer_id: string;
  root_cause_hypothesis: string | null;
  investigation: unknown;
  provider: string | null;
  model: string | null;
  grounding_rate: number | null;
  created_at: string;
}

const COLUMNS =
  "customer_id, root_cause_hypothesis, investigation, provider, model, grounding_rate, created_at";

/**
 * Postgres codes for "that column does not exist" and "that table does not
 * exist".
 *
 * The investigation layer is optional: the deterministic risk score and its
 * evidence are the product, and Phase 5 sits on top. So a database that has
 * not had the Phase 5 columns added yet must render as "no investigation
 * yet", not take the customer page down with it — which is exactly what
 * happened the first time this shipped.
 *
 * Only these two codes are swallowed. A connection failure, a bad key or a
 * permissions error still surfaces, because those are real and hiding them
 * would turn a broken deployment into a silently empty panel.
 */
const SCHEMA_MISSING = new Set(["42703", "42P01"]);

const isSchemaMissing = (error: { code?: string } | null) =>
  Boolean(error?.code && SCHEMA_MISSING.has(error.code));

export async function saveInvestigation(
  customerId: string,
  outcome: Extract<InvestigationOutcome, { ok: true }>,
): Promise<void> {
  const { error } = await getSupabase().from("investigations").insert({
    customer_id: customerId,
    // Mirrored into its own column because it is the one field worth
    // querying and reading without unpacking the jsonb.
    root_cause_hypothesis: outcome.investigation.rootCause.hypothesis,
    investigation: outcome.investigation,
    provider: outcome.provider,
    model: outcome.model,
    grounding_rate: outcome.grounding.rate,
  });

  if (error) {
    if (isSchemaMissing(error)) {
      throw new Error(
        "The investigations table is missing its Phase 5 columns. Run the ALTER in supabase/schema.sql " +
          "(investigation jsonb, provider text, model text, grounding_rate numeric) before saving investigations.",
      );
    }
    throw new Error(`Failed to write investigations: ${error.message}`);
  }
}

/** Most recent investigation per customer, or an empty map before any run. */
export async function fetchLatestInvestigations(): Promise<
  Map<string, StoredInvestigation>
> {
  const { data, error } = await getSupabase()
    .from("investigations")
    .select(COLUMNS)
    .order("created_at", { ascending: false });

  if (error) {
    if (isSchemaMissing(error)) return new Map();
    throw new Error(
      `Supabase read failed on "investigations": ${error.message}`,
    );
  }

  const latest = new Map<string, StoredInvestigation>();
  for (const row of (data ?? []) as StoredInvestigation[]) {
    if (!latest.has(row.customer_id)) latest.set(row.customer_id, row);
  }
  return latest;
}

export async function fetchLatestInvestigation(
  customerId: string,
): Promise<StoredInvestigation | null> {
  const { data, error } = await getSupabase()
    .from("investigations")
    .select(COLUMNS)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isSchemaMissing(error)) return null;
    throw new Error(
      `Supabase read failed on "investigations": ${error.message}`,
    );
  }
  return (data as StoredInvestigation | null) ?? null;
}
