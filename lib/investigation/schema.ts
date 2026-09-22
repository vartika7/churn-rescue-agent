/* ------------------------------------------------------------------ *
 * Phase 5 — structured investigation output, and its validator
 *
 * Hand-rolled rather than pulled from a schema library, for two reasons: the
 * shape is small and stable, and the interesting checks are not type checks.
 * "Is `rootCause.citations` an array of strings" is trivial; "does every
 * citation resolve to a real piece of evidence" is the one that catches a
 * model inventing a support ticket, and no off-the-shelf validator knows about
 * the evidence package.
 *
 * Validation is a gate, not a warning. An investigation that cites evidence
 * that does not exist is discarded, because a plausible paragraph citing a
 * fabricated ticket is worse than no investigation at all — a CSM cannot tell
 * the difference by reading it.
 * ------------------------------------------------------------------ */

export type ActionRecommendation = "intervene" | "monitor" | "no_action_needed";
export type InvestigationConfidence = "high" | "medium" | "low";

export interface Claim {
  statement: string;
  /** Evidence ids from the package. Must be non-empty and must resolve. */
  citations: string[];
}

export interface Investigation {
  /** What the deterministic score means for this account, in plain terms. */
  riskInterpretation: string;
  rootCause: {
    hypothesis: string;
    confidence: InvestigationConfidence;
    citations: string[];
  };
  /** Claims arguing the account is at risk. */
  supporting: Claim[];
  /**
   * Claims arguing against it. Required to be considered — an investigation
   * that only ever agrees with the score is not an investigation.
   */
  contradicting: Claim[];
  recommendation: {
    action: ActionRecommendation;
    reasoning: string;
    citations: string[];
  };
  /** What the evidence cannot settle. Empty string is not acceptable. */
  limitations: string;
  /**
   * Set when the evidence will not support a root cause. The prompt asks for
   * this explicitly so "I cannot tell" is an available answer rather than
   * something the model has to invent its way around.
   */
  insufficientEvidence: boolean;
}

export const ACTIONS: ActionRecommendation[] = [
  "intervene",
  "monitor",
  "no_action_needed",
];
const CONFIDENCES: InvestigationConfidence[] = ["high", "medium", "low"];

export type ValidationResult =
  { ok: true; value: Investigation } | { ok: false; errors: string[] };

const isStr = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

function readClaims(raw: unknown, field: string, errors: string[]): Claim[] {
  if (!Array.isArray(raw)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  const out: Claim[] = [];
  raw.forEach((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (!e || typeof e !== "object") {
      errors.push(`${field}[${i}] must be an object`);
      return;
    }
    if (!isStr(e.statement)) {
      errors.push(`${field}[${i}].statement must be a non-empty string`);
      return;
    }
    const cites = e.citations;
    if (!Array.isArray(cites) || cites.length === 0) {
      // A claim with no citation is exactly the shape of an invented one.
      errors.push(
        `${field}[${i}].citations must list at least one evidence id`,
      );
      return;
    }
    if (!cites.every(isStr)) {
      errors.push(`${field}[${i}].citations must all be strings`);
      return;
    }
    out.push({ statement: e.statement, citations: cites as string[] });
  });
  return out;
}

/**
 * Parses and checks a model response.
 *
 * `citable` is the set of evidence ids from the package the model was given.
 * Pass it and grounding is enforced; omit it and only the shape is checked,
 * which is why callers in the live path always pass it.
 */
export function validateInvestigation(
  raw: unknown,
  citable?: ReadonlySet<string>,
): ValidationResult {
  const errors: string[] = [];

  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ok: false, errors: ["response was not valid JSON"] };
    }
  } else if (raw && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  } else {
    return { ok: false, errors: ["response was not an object"] };
  }

  if (!isStr(obj.riskInterpretation)) {
    errors.push("riskInterpretation must be a non-empty string");
  }
  if (!isStr(obj.limitations)) {
    // The model is required to say what it cannot see. Allowing "" here would
    // let it skip the one field that admits doubt.
    errors.push("limitations must be a non-empty string");
  }
  if (typeof obj.insufficientEvidence !== "boolean") {
    errors.push("insufficientEvidence must be a boolean");
  }

  const rc = (obj.rootCause ?? {}) as Record<string, unknown>;
  if (!isStr(rc.hypothesis)) errors.push("rootCause.hypothesis is required");
  if (!CONFIDENCES.includes(rc.confidence as InvestigationConfidence)) {
    errors.push(
      `rootCause.confidence must be one of ${CONFIDENCES.join(", ")}`,
    );
  }
  const rcCites = Array.isArray(rc.citations)
    ? (rc.citations.filter(isStr) as string[])
    : [];
  if (!Array.isArray(rc.citations))
    errors.push("rootCause.citations must be an array");

  const rec = (obj.recommendation ?? {}) as Record<string, unknown>;
  if (!ACTIONS.includes(rec.action as ActionRecommendation)) {
    errors.push(`recommendation.action must be one of ${ACTIONS.join(", ")}`);
  }
  if (!isStr(rec.reasoning))
    errors.push("recommendation.reasoning is required");
  const recCites = Array.isArray(rec.citations)
    ? (rec.citations.filter(isStr) as string[])
    : [];
  if (!Array.isArray(rec.citations)) {
    errors.push("recommendation.citations must be an array");
  }

  const supporting = readClaims(obj.supporting, "supporting", errors);
  const contradicting = readClaims(obj.contradicting, "contradicting", errors);

  // A root cause asserted with no citation at all is unfalsifiable. The
  // exception is an explicit "insufficient evidence", where having nothing to
  // cite is the honest answer.
  if (obj.insufficientEvidence !== true && rcCites.length === 0) {
    errors.push(
      "rootCause.citations must cite evidence unless insufficientEvidence is true",
    );
  }

  /* --- Grounding ---------------------------------------------------- */
  if (citable) {
    const unknown = new Set<string>();
    const check = (ids: string[]) => {
      for (const id of ids) if (!citable.has(id)) unknown.add(id);
    };
    check(rcCites);
    check(recCites);
    for (const c of supporting) check(c.citations);
    for (const c of contradicting) check(c.citations);

    if (unknown.size > 0) {
      errors.push(
        `cites evidence that was never provided: ${[...unknown].sort().join(", ")}`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      riskInterpretation: obj.riskInterpretation as string,
      rootCause: {
        hypothesis: rc.hypothesis as string,
        confidence: rc.confidence as InvestigationConfidence,
        citations: rcCites,
      },
      supporting,
      contradicting,
      recommendation: {
        action: rec.action as ActionRecommendation,
        reasoning: rec.reasoning as string,
        citations: recCites,
      },
      limitations: obj.limitations as string,
      insufficientEvidence: obj.insufficientEvidence as boolean,
    },
  };
}

/**
 * Share of cited ids that resolve. 1 is fully grounded, and the Phase 7 AI
 * metrics report the rate across a run rather than only pass/fail per case.
 */
export function groundingRate(
  investigation: Investigation,
  citable: ReadonlySet<string>,
): { cited: number; resolved: number; rate: number } {
  const all = [
    ...investigation.rootCause.citations,
    ...investigation.recommendation.citations,
    ...investigation.supporting.flatMap((c) => c.citations),
    ...investigation.contradicting.flatMap((c) => c.citations),
  ];
  const resolved = all.filter((id) => citable.has(id)).length;
  return {
    cited: all.length,
    resolved,
    rate: all.length === 0 ? 1 : resolved / all.length,
  };
}
