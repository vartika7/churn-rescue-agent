/* No `import "server-only"` here — see the note in evidence.ts. This module is
   provider-agnostic orchestration and is driven by injected providers in
   tests. The key lives in gemini.ts, which is server-only. */

import {
  buildEvidencePackage,
  citableIds,
  type EvidenceInput,
  type EvidencePackage,
} from "./evidence";
import { mockInvestigation, MOCK_PROVIDER_NAME } from "./mock";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt";
import { ProviderError, type InvestigationProvider } from "./provider";
import {
  groundingRate,
  validateInvestigation,
  type Investigation,
} from "./schema";

/* ------------------------------------------------------------------ *
 * Phase 5 — running an investigation
 *
 * One function, so the route, the tests and the Phase 7 AI evaluation all
 * exercise the same path. Anything that only the route did would be untested
 * by construction.
 *
 * Failure is a first-class outcome rather than an exception. The risk score is
 * already on screen and is what a CSM triages on; an investigation that could
 * not be produced should degrade the page, not break it. So the result is a
 * discriminated union and the caller decides what to render.
 * ------------------------------------------------------------------ */

export type InvestigationOutcome =
  | {
      ok: true;
      investigation: Investigation;
      provider: string;
      model: string;
      /** 1 when every citation resolved. Recorded for the AI metrics. */
      grounding: { cited: number; resolved: number; rate: number };
      /** True when this came from the offline provider, not a model. */
      offline: boolean;
      evidence: EvidencePackage;
      usage?: { input?: number; output?: number };
    }
  | {
      ok: false;
      /** Which stage failed, so the UI can say something specific. */
      stage: "provider" | "validation";
      errors: string[];
      retryable: boolean;
      evidence: EvidencePackage;
      /** The raw response, kept for debugging a validation failure. */
      raw?: string;
    };

export interface RunOptions {
  provider: InvestigationProvider;
  input: EvidenceInput;
  maxOutputTokens?: number;
}

export async function runInvestigation(
  options: RunOptions,
): Promise<InvestigationOutcome> {
  const evidence = buildEvidencePackage(options.input);
  const citable = citableIds(evidence);

  let text: string;
  let model: string;
  let usage: { input?: number; output?: number } | undefined;

  try {
    const result = await options.provider.complete({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(evidence),
      temperature: 0,
      maxOutputTokens: options.maxOutputTokens,
    });
    text = result.text;
    model = result.model;
    usage = result.usage;
  } catch (err) {
    return {
      ok: false,
      stage: "provider",
      errors: [err instanceof Error ? err.message : String(err)],
      retryable: err instanceof ProviderError ? err.retryable : false,
      evidence,
    };
  }

  const validated = validateInvestigation(text, citable);
  if (!validated.ok) {
    // Deliberately not retried or repaired here. A response that cites
    // evidence it was never given is not a transient fault, and silently
    // patching it up would hide exactly the behaviour Phase 7 needs to
    // measure.
    return {
      ok: false,
      stage: "validation",
      errors: validated.errors,
      retryable: false,
      evidence,
      raw: text,
    };
  }

  return {
    ok: true,
    investigation: validated.value,
    provider: options.provider.name,
    model,
    grounding: groundingRate(validated.value, citable),
    offline: options.provider.name === MOCK_PROVIDER_NAME,
    evidence,
    usage,
  };
}

/**
 * Whether a result should be written to `investigations`.
 *
 * Keyed on what the outcome actually is, not on why it happened. An earlier
 * version checked the `--offline` flag, which missed the other route to an
 * offline result entirely: when no provider is configured the app falls back
 * to the placeholder silently, so a missing or expired key on a deployment
 * would have quietly refilled the table with rows that are not
 * investigations.
 *
 * A placeholder is stored only when asked for explicitly, and a failed
 * outcome never is — an unvalidated response must not sit in the same table
 * as verified ones.
 */
export function shouldPersist(
  outcome: InvestigationOutcome,
  saveParam: string | null,
): outcome is Extract<InvestigationOutcome, { ok: true }> {
  if (!outcome.ok) return false;
  return outcome.offline ? saveParam === "1" : saveParam !== "0";
}

/**
 * Offline result for the same input, without going near a provider.
 *
 * Used when nothing is configured, so the UI has something real to render and
 * the pipeline stays exercised. It is labelled `offline: true` and its own
 * `limitations` field says it is not an investigation — both of which the UI
 * must surface.
 */
export function offlineInvestigation(
  input: EvidenceInput,
): InvestigationOutcome {
  const evidence = buildEvidencePackage(input);
  const citable = citableIds(evidence);
  const validated = validateInvestigation(mockInvestigation(evidence), citable);

  if (!validated.ok) {
    // The offline provider builds its citations from the package, so this is
    // unreachable unless the validator and the package have drifted apart.
    return {
      ok: false,
      stage: "validation",
      errors: validated.errors,
      retryable: false,
      evidence,
    };
  }

  return {
    ok: true,
    investigation: validated.value,
    provider: MOCK_PROVIDER_NAME,
    model: "offline-fixture",
    grounding: groundingRate(validated.value, citable),
    offline: true,
    evidence,
  };
}
