import "server-only";

import type { DraftOutcome } from "./outreach/run";
import type { OutreachStatus } from "./outreach/schema";
import { getSupabase } from "./supabase";

/**
 * Phase 6 persistence.
 *
 * Appended like the other two tables, so a customer's outreach history is a
 * record rather than a current value.
 *
 * The original draft and the CSM's edit are stored in separate columns and
 * never overwrite each other. That is the whole point: a rejection tells you a
 * draft was wrong, but an edit tells you it was nearly right, and the
 * difference between `body` and `edited_body` is the only honest measure of
 * how good the drafting actually is. Overwriting would throw away the metric.
 *
 * Nothing in this module, or anywhere else in the codebase, sends anything.
 * `approved` means a human said it was fit to send, not that it went.
 */

export interface StoredOutreach {
  id: number;
  customer_id: string;
  recommended_action: string | null;
  subject: string | null;
  body: string | null;
  citations: unknown;
  check_before_sending: string | null;
  status: OutreachStatus | null;
  edited_subject: string | null;
  edited_body: string | null;
  decided_by: string | null;
  decided_at: string | null;
  provider: string | null;
  model: string | null;
  outcome: string | null;
  created_at: string;
}

const COLUMNS =
  "id, customer_id, recommended_action, subject, body, citations, " +
  "check_before_sending, status, edited_subject, edited_body, decided_by, " +
  "decided_at, provider, model, outcome, created_at";

const SCHEMA_MISSING = new Set(["42703", "42P01"]);
const isSchemaMissing = (error: { code?: string } | null) =>
  Boolean(error?.code && SCHEMA_MISSING.has(error.code));

export async function saveDraft(
  customerId: string,
  recommendedAction: string,
  outcome: Extract<DraftOutcome, { ok: true }>,
): Promise<number> {
  const { data, error } = await getSupabase()
    .from("outreach")
    .insert({
      customer_id: customerId,
      recommended_action: recommendedAction,
      subject: outcome.draft.subject,
      body: outcome.draft.body,
      citations: outcome.draft.citations,
      check_before_sending: outcome.draft.checkBeforeSending,
      status: "draft" satisfies OutreachStatus,
      provider: outcome.provider,
      model: outcome.model,
    })
    .select("id")
    .single();

  if (error) {
    if (isSchemaMissing(error)) {
      throw new Error(
        "The outreach table is missing its Phase 6 columns. See supabase/schema.sql for the ALTER.",
      );
    }
    throw new Error(`Failed to write outreach: ${error.message}`);
  }
  return (data as { id: number }).id;
}

/**
 * Records a human decision on a draft.
 *
 * `approved` records that a person judged it fit to send. It does not send,
 * and there is no code path that does.
 */
export async function decideOutreach(input: {
  id: number;
  status: Exclude<OutreachStatus, "draft">;
  decidedBy: string;
  editedSubject?: string | null;
  editedBody?: string | null;
}): Promise<void> {
  const { error } = await getSupabase()
    .from("outreach")
    .update({
      status: input.status,
      decided_by: input.decidedBy,
      decided_at: new Date().toISOString(),
      // Written only when the CSM actually changed something, so an untouched
      // approval is distinguishable from one edited back to the original.
      edited_subject: input.editedSubject ?? null,
      edited_body: input.editedBody ?? null,
    })
    .eq("id", input.id);

  if (error) throw new Error(`Failed to record decision: ${error.message}`);
}

/** Most recent outreach row per customer, or null before any draft exists. */
export async function fetchLatestOutreach(
  customerId: string,
): Promise<StoredOutreach | null> {
  const { data, error } = await getSupabase()
    .from("outreach")
    .select(COLUMNS)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    // Same reasoning as investigations: Phase 6 is an enhancement and must not
    // take the customer page down on a database that has not been migrated.
    if (isSchemaMissing(error)) return null;
    throw new Error(`Supabase read failed on "outreach": ${error.message}`);
  }
  return (data as StoredOutreach | null) ?? null;
}
