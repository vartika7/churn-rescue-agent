import "server-only";

import { GeminiProvider, geminiConfigFromEnv } from "./gemini";
import type { InvestigationProvider } from "./provider";

/* ------------------------------------------------------------------ *
 * Phase 5 — provider selection
 *
 * The one place that knows which providers exist. Adding Claude means adding a
 * branch here and a file next to gemini.ts; nothing else changes.
 *
 * `server-only` because it reaches into the environment for credentials.
 * ------------------------------------------------------------------ */

export type ProviderChoice =
  | { configured: true; provider: InvestigationProvider; model: string }
  | { configured: false; reason: string };

/**
 * Returns the configured provider, or why there isn't one.
 *
 * Returning a reason rather than throwing or silently falling back: the route
 * needs to tell the difference between "no key, use the offline path" and "a
 * key is set but the model is missing", and a caller that gets a working
 * provider back when nothing is configured would ship placeholder text to the
 * UI without anything knowing it was placeholder.
 */
export function selectProvider(): ProviderChoice {
  const gemini = geminiConfigFromEnv();
  if (gemini) {
    return {
      configured: true,
      provider: new GeminiProvider(gemini),
      model: gemini.model,
    };
  }

  const hasKey = Boolean(process.env.GEMINI_API_KEY?.trim());
  const hasModel = Boolean(process.env.GEMINI_MODEL?.trim());

  if (hasKey && !hasModel) {
    return {
      configured: false,
      reason:
        "GEMINI_API_KEY is set but GEMINI_MODEL is not. Set it to the model you intend to use — it is deliberately not defaulted, because free-tier model names change and a stale default fails at request time.",
    };
  }
  if (!hasKey && hasModel) {
    return {
      configured: false,
      reason: "GEMINI_MODEL is set but GEMINI_API_KEY is not.",
    };
  }
  return {
    configured: false,
    reason:
      "No LLM provider configured. Set GEMINI_API_KEY and GEMINI_MODEL to run real investigations; until then the offline path is used and is labelled as such.",
  };
}
