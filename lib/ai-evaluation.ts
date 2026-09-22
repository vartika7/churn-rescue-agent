/* No `import "server-only"` — pure metric computation, driven by injected
   data in tests. See the note in lib/investigation/evidence.ts. */

import { MIN_OBSERVED_DAYS_FOR_CONFIDENCE } from "./constants";
import type { EvidencePackage } from "./investigation/evidence";
import { citableIds } from "./investigation/evidence";
import {
  groundingRate,
  validateInvestigation,
  type Investigation,
} from "./investigation/schema";

/* ------------------------------------------------------------------ *
 * Phase 7 — grading the AI layer
 *
 * Grading generated prose is the hard half of this project, because the
 * obvious metrics need either a human or a second model to judge "is this root
 * cause any good", and both are unreproducible. So this measures only what can
 * be checked mechanically against the evidence the model was given:
 *
 *   - did it answer in the required shape at all
 *   - does every citation resolve
 *   - did it mention entities that were never in the package
 *   - did it engage with the case against its own hypothesis
 *   - does its recommendation line up with the deterministic verdict
 *   - did it admit uncertainty exactly where the evidence was thin
 *
 * What it deliberately does NOT claim to measure is whether the root cause is
 * *correct*. Nothing here can know that, and a number that pretended to would
 * be worse than no number. `expected_root_cause` exists in the dataset and is
 * used only for a side-by-side read, never scored.
 *
 * Ground truth is never an input to the model. It is compared against output
 * after the fact, which is the whole distinction between grading and leaking.
 * ------------------------------------------------------------------ */

export interface GradedCase {
  customerId: string;
  provider: string;
  model: string;
  /** Re-validates the stored output against its package. */
  valid: boolean;
  validationErrors: string[];
  grounding: { cited: number; resolved: number; rate: number };
  /** Claims carrying no citation at all. */
  uncitedClaims: number;
  /**
   * Ticket ids and ISO dates that appear in the prose but nowhere in the
   * evidence package. Citations can be clean while the sentences around them
   * invent a ticket, so this checks the text itself.
   */
  phantomEntities: string[];
  /** Did the package offer a counter-case, and did the model take it up? */
  contradictingAvailable: boolean;
  contradictingUsed: boolean;
  /** Distinct evidence items cited, against the number available. */
  citedDistinct: number;
  itemsAvailable: number;
  recommendedAction: string;
  deterministicLevel: string;
  deterministicScore: number;
  /**
   * How the recommendation sits against the deterministic band.
   *
   * Not scored as right or wrong. An escalation is the AI layer doing the one
   * thing the engine cannot — reading ticket prose — so treating divergence as
   * error would mark its entire contribution as a defect. A de-escalation is
   * the riskier direction: talking a CSM out of looking at a flagged account.
   */
  vsBand: "aligned" | "escalated" | "de-escalated";
  insufficientEvidence: boolean;
  observedDays: number;
  /** Was claiming insufficient evidence the right call on this record? */
  insufficientAppropriate: boolean;
}

export interface AiEvaluationReport {
  cases: GradedCase[];
  totals: {
    graded: number;
    valid: number;
    fullyGrounded: number;
    meanGrounding: number;
    withPhantoms: number;
    uncitedClaims: number;
    contradictingAvailable: number;
    contradictingUsed: number;
    aligned: number;
    escalated: number;
    deEscalated: number;
    /** Escalations where signals fired but summed below the flag threshold. */
    escalatedUnderThreshold: number;
    insufficientAppropriate: number;
    meanCitedDistinct: number;
  };
  byModel: {
    model: string;
    cases: number;
    meanGrounding: number;
    withPhantoms: number;
  }[];
  /** Recommendation against the human grading, compared but never scored. */
  vsGroundTruth: {
    compared: number;
    agree: number;
    matrix: { expected: string; got: string; count: number }[];
  };
}

const URGENCY: Record<string, number> = {
  no_action_needed: 0,
  monitor: 1,
  intervene: 2,
};
const LEVEL_URGENCY: Record<string, number> = { low: 0, medium: 1, high: 2 };

/** Whether the recommendation is more, less or equally urgent than the band. */
export function compareToBand(
  action: string,
  level: string,
): "aligned" | "escalated" | "de-escalated" {
  const a = URGENCY[action] ?? 0;
  const l = LEVEL_URGENCY[level] ?? 0;
  if (a === l) return "aligned";
  return a > l ? "escalated" : "de-escalated";
}

/** intervene <-> high, monitor <-> medium, no_action_needed <-> low. */
export function actionForLevel(level: string): string {
  switch (level) {
    case "high":
      return "intervene";
    case "medium":
      return "monitor";
    default:
      return "no_action_needed";
  }
}

const TICKET_RE = /\bT\d{3,}\b/g;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;

/** Every piece of prose the model wrote, concatenated. */
function proseOf(inv: Investigation): string {
  return [
    inv.riskInterpretation,
    inv.rootCause.hypothesis,
    inv.recommendation.reasoning,
    inv.limitations,
    ...inv.supporting.map((c) => c.statement),
    ...inv.contradicting.map((c) => c.statement),
  ].join("\n");
}

/**
 * Entities named in the prose that appear nowhere in the package.
 *
 * Citation checking catches a fabricated *reference*; this catches a
 * fabricated *mention* — "ticket T0099 is still open" with a clean citation
 * list beside it. Limited to ticket ids and ISO dates on purpose: those are
 * unambiguous and verifiable. A hallucinated company name or feature is not
 * mechanically detectable and is not claimed to be.
 */
export function phantomEntities(
  inv: Investigation,
  pkg: EvidencePackage,
): string[] {
  const haystack = [
    ...pkg.items.map((i) => `${i.id} ${i.summary} ${i.detail ?? ""}`),
    pkg.risk.reason,
    pkg.usage.from ?? "",
    pkg.usage.to ?? "",
  ]
    .join("\n")
    .toLowerCase();

  const prose = proseOf(inv);
  const found = new Set<string>();

  for (const re of [TICKET_RE, ISO_DATE_RE]) {
    for (const match of prose.match(re) ?? []) {
      if (!haystack.includes(match.toLowerCase())) found.add(match);
    }
  }
  return [...found].sort();
}

export interface GradeInput {
  customerId: string;
  provider: string;
  model: string;
  /** The stored output, as read back from the database. */
  stored: unknown;
  pkg: EvidencePackage;
  /** `expected_recommendation`, for after-the-fact comparison only. */
  expectedRecommendation?: string;
}

export function gradeCase(input: GradeInput): GradedCase {
  const citable = citableIds(input.pkg);
  const validated = validateInvestigation(input.stored, citable);

  const contradictingAvailable = input.pkg.items.some(
    (i) => i.direction === "contradicting",
  );

  if (!validated.ok) {
    return {
      customerId: input.customerId,
      provider: input.provider,
      model: input.model,
      valid: false,
      validationErrors: validated.errors,
      grounding: { cited: 0, resolved: 0, rate: 0 },
      uncitedClaims: 0,
      phantomEntities: [],
      contradictingAvailable,
      contradictingUsed: false,
      citedDistinct: 0,
      itemsAvailable: input.pkg.items.length,
      recommendedAction: "n/a",
      deterministicLevel: input.pkg.risk.level,
      deterministicScore: input.pkg.risk.score,
      vsBand: "aligned",
      insufficientEvidence: false,
      observedDays: input.pkg.usage.observedDays,
      insufficientAppropriate: false,
    };
  }

  const inv = validated.value;
  const allCitations = [
    ...inv.rootCause.citations,
    ...inv.recommendation.citations,
    ...inv.supporting.flatMap((c) => c.citations),
    ...inv.contradicting.flatMap((c) => c.citations),
  ];

  // Thin records are where a model is most tempted to invent a story, so
  // "did it decline to" is checked against the same gate the engine uses.
  //
  // Only thinness counts. An earlier version also expected an insufficient
  // verdict when no signal fired, which conflated "nothing is wrong" with
  // "I cannot tell" — C009 has 186 days of records and growing usage, which is
  // abundant evidence that happens to be good news.
  const shouldBeInsufficient =
    input.pkg.usage.observedDays < MIN_OBSERVED_DAYS_FOR_CONFIDENCE;

  return {
    customerId: input.customerId,
    provider: input.provider,
    model: input.model,
    valid: true,
    validationErrors: [],
    grounding: groundingRate(inv, citable),
    uncitedClaims: [...inv.supporting, ...inv.contradicting].filter(
      (c) => c.citations.length === 0,
    ).length,
    phantomEntities: phantomEntities(inv, input.pkg),
    contradictingAvailable,
    contradictingUsed: inv.contradicting.length > 0,
    citedDistinct: new Set(allCitations).size,
    itemsAvailable: input.pkg.items.length,
    recommendedAction: inv.recommendation.action,
    deterministicLevel: input.pkg.risk.level,
    deterministicScore: input.pkg.risk.score,
    vsBand: compareToBand(inv.recommendation.action, input.pkg.risk.level),
    insufficientEvidence: inv.insufficientEvidence,
    observedDays: input.pkg.usage.observedDays,
    insufficientAppropriate: inv.insufficientEvidence === shouldBeInsufficient,
  };
}

export function evaluateAi(inputs: GradeInput[]): AiEvaluationReport {
  const cases = inputs.map(gradeCase);
  const n = cases.length || 1;
  const valid = cases.filter((c) => c.valid);

  const byModelMap = new Map<string, GradedCase[]>();
  for (const c of cases) {
    const l = byModelMap.get(c.model);
    if (l) l.push(c);
    else byModelMap.set(c.model, [c]);
  }

  const matrixMap = new Map<
    string,
    { expected: string; got: string; count: number }
  >();
  let compared = 0;
  let agree = 0;
  for (const [i, input] of inputs.entries()) {
    const expected = input.expectedRecommendation;
    const got = cases[i].recommendedAction;
    if (!expected || got === "n/a") continue;
    compared++;
    if (expected === got) agree++;
    const key = `${expected}|${got}`;
    const cell = matrixMap.get(key);
    if (cell) cell.count++;
    else matrixMap.set(key, { expected, got, count: 1 });
  }

  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

  return {
    cases,
    totals: {
      graded: cases.length,
      valid: valid.length,
      fullyGrounded: valid.filter((c) => c.grounding.rate === 1).length,
      meanGrounding: mean(valid.map((c) => c.grounding.rate)),
      withPhantoms: valid.filter((c) => c.phantomEntities.length > 0).length,
      uncitedClaims: valid.reduce((s, c) => s + c.uncitedClaims, 0),
      contradictingAvailable: cases.filter((c) => c.contradictingAvailable)
        .length,
      contradictingUsed: cases.filter(
        (c) => c.contradictingAvailable && c.contradictingUsed,
      ).length,
      aligned: valid.filter((c) => c.vsBand === "aligned").length,
      escalated: valid.filter((c) => c.vsBand === "escalated").length,
      deEscalated: valid.filter((c) => c.vsBand === "de-escalated").length,
      escalatedUnderThreshold: valid.filter(
        (c) => c.vsBand === "escalated" && c.deterministicScore > 0,
      ).length,
      insufficientAppropriate: valid.filter((c) => c.insufficientAppropriate)
        .length,
      meanCitedDistinct: mean(valid.map((c) => c.citedDistinct)),
    },
    byModel: [...byModelMap.entries()].map(([model, cs]) => ({
      model,
      cases: cs.length,
      meanGrounding: mean(
        cs.filter((c) => c.valid).map((c) => c.grounding.rate),
      ),
      withPhantoms: cs.filter((c) => c.phantomEntities.length > 0).length,
    })),
    vsGroundTruth: {
      compared,
      agree,
      matrix: [...matrixMap.values()].sort((a, b) => b.count - a.count),
    },
  };
}
