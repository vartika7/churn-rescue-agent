import type { Confidence, RiskLevel } from "./risk-engine";

/**
 * Presentation for engine output. Kept apart from `placeholder-risk.ts`
 * deliberately — that module maps `evaluation_cases` ground truth, this one
 * maps live assessments, and conflating the two is how a placeholder ends up
 * being mistaken for a real signal.
 */

export function riskLabel(level: RiskLevel): string {
  switch (level) {
    case "high":
      return "High risk";
    case "medium":
      return "Medium risk";
    case "low":
      return "Low risk";
  }
}

export function riskBadgeClass(level: RiskLevel): string {
  switch (level) {
    case "high":
      return "badge badge-intervene";
    case "medium":
      return "badge badge-monitor";
    case "low":
      return "badge badge-healthy";
  }
}

/**
 * Past-tense label for a churned account's replayed score.
 *
 * A churned account must never carry present-tense risk language: "High risk"
 * on a company that left in April reads as a live verdict and an instruction to
 * act. The score is still worth showing — it is how the engine would have
 * graded them before they left — but the wording has to place it in the past.
 */
export function riskLabelAtChurn(level: RiskLevel): string {
  switch (level) {
    case "high":
      return "Scored high risk before churn";
    case "medium":
      return "Scored medium risk before churn";
    case "low":
      return "Scored low risk before churn";
  }
}

/** Most urgent first. */
export function riskRank(level: RiskLevel): number {
  return level === "high" ? 0 : level === "medium" ? 1 : 2;
}

export const RISK_LEVELS: RiskLevel[] = ["high", "medium", "low"];

/**
 * Confidence is about how much there was to look at, not how bad the news is —
 * so it gets a neutral treatment rather than the risk palette, which would
 * read as a second severity score sitting next to the first.
 */
export function confidenceLabel(confidence: Confidence): string {
  switch (confidence) {
    case "high":
      return "high confidence";
    case "medium":
      return "moderate confidence";
    case "low":
      return "low confidence — little to go on";
  }
}
