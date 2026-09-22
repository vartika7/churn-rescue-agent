/* No `import "server-only"` here, deliberately. This module is pure — it reads
   no environment variable and holds no credential — and it has to be importable
   by the test runner, which does not resolve Next's `server-only` shim. The
   guard belongs on the provider implementation that reads the API key, not on
   functions that transform data. */

import type { EvidencePackage } from "./evidence";
import type {
  CompletionRequest,
  CompletionResult,
  InvestigationProvider,
} from "./provider";

/* ------------------------------------------------------------------ *
 * Phase 5 — offline provider
 *
 * Lets the whole pipeline run with no API key: prompt, validation,
 * persistence, UI and the Phase 7 AI metrics all exercise the real code path.
 *
 * It is NOT an investigation. It composes sentences from the evidence it was
 * handed, which is exactly what the real thing is not for — the point of the
 * model is reading the ticket prose, and this cannot. It exists so that
 * development and tests do not depend on a live provider, and so the UI has
 * something to render before a key exists.
 *
 * Anything it produces must be labelled as offline output wherever it is
 * shown. An unlabelled placeholder presented as AI analysis is a lie to
 * whoever reads the screen.
 * ------------------------------------------------------------------ */

export const MOCK_PROVIDER_NAME = "mock";

/**
 * Builds a valid, fully-grounded response from the package.
 *
 * Every citation is taken from the evidence, so this always passes validation
 * — which is the point: it isolates provider failures from validator failures
 * when something breaks.
 */
export function mockInvestigation(pkg: EvidencePackage): unknown {
  const firing = pkg.items.filter((i) => i.direction === "supporting");
  const against = pkg.items.filter((i) => i.direction === "contradicting");
  const tickets = pkg.items.filter((i) => i.kind === "ticket");

  const thin = pkg.usage.observedDays < 60;
  const insufficient = thin || firing.length === 0;

  return {
    riskInterpretation: insufficient
      ? `${pkg.account.company} scores ${pkg.risk.score}/100 (${pkg.risk.level}), but there is not enough here to explain it: ${pkg.usage.observedDays} days on record and ${firing.length} signals firing.`
      : `${pkg.account.company} scores ${pkg.risk.score}/100 (${pkg.risk.level}) on ${firing.length} signal${firing.length === 1 ? "" : "s"}, against ${pkg.account.mrr} dollars of monthly revenue.`,
    rootCause: {
      hypothesis: insufficient
        ? "No root cause can be determined from the evidence provided."
        : `Most likely driver: ${firing[0].summary.toLowerCase()}.`,
      confidence: thin ? "low" : firing.length > 2 ? "medium" : "low",
      citations: insufficient ? [] : [firing[0].id],
    },
    supporting: firing.slice(0, 4).map((i) => ({
      statement: i.summary,
      citations: [i.id],
    })),
    contradicting: against.slice(0, 4).map((i) => ({
      statement: i.summary,
      citations: [i.id],
    })),
    recommendation: {
      action:
        pkg.risk.level === "high"
          ? "intervene"
          : pkg.risk.level === "medium"
            ? "monitor"
            : "no_action_needed",
      reasoning: `Mirrors the deterministic risk level (${pkg.risk.level}). This offline provider does not reason about the evidence.`,
      citations: firing.length > 0 ? [firing[0].id] : [],
    },
    limitations: `Generated offline without a language model. Ticket prose was not interpreted${tickets.length ? ` — ${tickets.length} ticket${tickets.length === 1 ? "" : "s"} on record went unread` : ""}. Not a substitute for an investigation.`,
    insufficientEvidence: insufficient,
  };
}

/**
 * Provider that returns `mockInvestigation` for whatever package it is given.
 *
 * It re-parses the rendered prompt rather than receiving the package, so that
 * it exercises the same request/response boundary the real providers do.
 */
export class MockProvider implements InvestigationProvider {
  readonly name = MOCK_PROVIDER_NAME;

  constructor(private readonly resolve: (req: CompletionRequest) => unknown) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    return {
      text: JSON.stringify(this.resolve(request)),
      model: "offline-fixture",
    };
  }
}

/** Convenience for the common case: a provider bound to one package. */
export function mockProviderFor(pkg: EvidencePackage): InvestigationProvider {
  return new MockProvider(() => mockInvestigation(pkg));
}

/** A provider that always fails, for exercising the error path in tests. */
export class FailingProvider implements InvestigationProvider {
  readonly name = "failing";
  constructor(private readonly message = "provider unavailable") {}
  async complete(): Promise<CompletionResult> {
    throw new Error(this.message);
  }
}
