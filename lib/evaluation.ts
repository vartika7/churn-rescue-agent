import { scoreCustomer, type RiskLevel } from "./risk-engine";
import {
  RISK_LEVEL_THRESHOLDS,
  MIN_OBSERVED_DAYS_FOR_CONFIDENCE,
} from "./constants";
import type {
  CustomerOutcome,
  EvaluationCase,
  SupportTicket,
  Subscription,
  UsageDaily,
} from "./types";

/* ------------------------------------------------------------------ *
 * Phase 7 — evaluation harness
 *
 * This is the ONE module allowed to read `customer_outcomes` and
 * `evaluation_cases`. Grading requires the answers; that is what grading is.
 * The separation that matters is that nothing here feeds back into scoring —
 * `scoreCustomer` is called with exactly the inputs the live path uses, and
 * the outcome is only ever compared against what it returned.
 *
 * Read `asOf` carefully when interpreting any number below. A churned account
 * is replayed as of its churn date, because scoring it against today's data
 * would ask "can the engine tell this account stopped existing eight months
 * ago", which is not the question. The question is whether the engine would
 * have flagged it while there was still something to do.
 * ------------------------------------------------------------------ */

export interface AccountData {
  usage: readonly Pick<UsageDaily, "date" | "sessions">[];
  tickets: readonly SupportTicket[];
  subscriptions: readonly Subscription[];
}

export interface EvalInput {
  outcomes: readonly CustomerOutcome[];
  cases: readonly EvaluationCase[];
  data: ReadonlyMap<string, AccountData>;
  /** Accounts whose usage or labels were authored by hand, not generated. */
  constructed?: readonly string[];
}

const isRetained = (o: CustomerOutcome) =>
  (o.outcome ?? "").trim().toLowerCase() === "retained";

/** A flag is any verdict above `low` — the point at which a CSM is told to look. */
const flagged = (level: RiskLevel) => level !== "low";

/**
 * Whether an account can be graded at all as of `cutoff`.
 *
 * Requires enough records for the engine's own windows to mean something. The
 * first version of this asked only whether *any* usage predated the cutoff,
 * which let C048 be scored on 2 rows at the 90-day horizon and counted as a
 * miss — an artefact of the dataset's history depth, reported as an engine
 * failure.
 */
function isObservable(
  usage: readonly Pick<UsageDaily, "date" | "sessions">[],
  cutoff: string,
): boolean {
  let n = 0;
  for (const u of usage) if (u.date <= cutoff) n++;
  return n >= MIN_OBSERVED_DAYS_FOR_CONFIDENCE;
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface ChurnDetection {
  customerId: string;
  churnedOn: string;
  score: number;
  level: RiskLevel;
  confidence: string;
  observedDays: number;
  flagged: boolean;
  caseType: string;
  /** Days before churn at which the engine first flagged, or null if never. */
  firstFlaggedDaysBefore: number | null;
  /** Highest score at any observable horizon, and where it peaked. */
  peakScore: number;
  peakDaysBefore: number;
}

/** Horizons to replay each churned account at, in days before the churn date. */
export const LEAD_TIME_HORIZONS = [0, 14, 30, 60, 90] as const;

export interface LeadTimeRow {
  daysBefore: number;
  /** Accounts with enough history to be scored at this horizon at all. */
  evaluated: number;
  flagged: number;
  /** Accounts skipped because their records do not reach back this far. */
  notObservable: number;
}

export interface ConfusionCell {
  expected: string;
  actual: RiskLevel;
  count: number;
}

export interface CaseTypeRow {
  caseType: string;
  total: number;
  flagged: number;
  /** What the engine is supposed to do here, for types with a known answer. */
  expectation: string | null;
}

export interface EvaluationReport {
  churn: {
    total: number;
    flaggedAtChurn: number;
    highAtChurn: number;
    recall: number;
    accounts: ChurnDetection[];
  };
  leadTime: LeadTimeRow[];
  labelAgreement: {
    total: number;
    exact: number;
    withinOneBand: number;
    accuracy: number;
    confusion: ConfusionCell[];
  };
  /**
   * Retained accounts that look risky on the surface. Flagging these is the
   * expensive mistake: it sends a CSM to a customer who was never leaving.
   */
  falsePositiveCases: {
    total: number;
    flagged: number;
    flaggedHigh: number;
    accounts: { customerId: string; score: number; level: RiskLevel }[];
  };
  byCaseType: CaseTypeRow[];
  constructed: string[];
}

const LEVEL_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Known expectations per `case_type`. Without these, a harness scores itself
 * badly for behaving correctly: `unobservable_limitation` is an account whose
 * loss nothing in the product data could have predicted, so a miss there is
 * the right answer, and `false_positive_risk` is a retained account that looks
 * alarming, where a flag is the error.
 */
const CASE_TYPE_EXPECTATION: Record<string, string> = {
  unobservable_limitation: "Miss expected — no signal was available",
  false_positive_risk: "Should NOT flag — retained despite looking risky",
  standard_intervene: "Should flag",
  difficult_intervene: "Should flag, but the signal is weak",
  high_usage_intervene: "Should flag despite healthy usage",
  active_at_risk: "Should flag — constructed for this purpose",
  conflicting_signal_monitor: "Either verdict defensible; evidence conflicts",
  standard_monitor: "Mild flag expected",
  standard_no_action: "Should stay quiet",
};

export function evaluate(input: EvalInput): EvaluationReport {
  const constructed = new Set(input.constructed ?? []);
  const caseBy = new Map(input.cases.map((c) => [c.customer_id, c]));
  const empty: AccountData = { usage: [], tickets: [], subscriptions: [] };

  /* --- Churn detection, replayed as of each churn date --------------- */
  const churnAccounts: ChurnDetection[] = [];
  for (const outcome of input.outcomes) {
    if (isRetained(outcome)) continue;
    const id = outcome.customer_id;
    const d = input.data.get(id) ?? empty;
    const churnedOn = outcome.outcome_date;

    const at = scoreCustomer({ ...d, asOf: churnedOn });

    // Walk from the earliest horizon forward, recording both the first flag
    // and the peak. The peak matters: the score is not monotonic in time, so
    // an account can be flagged at 60 days and look healthy again by the end.
    let firstFlagged: number | null = null;
    let peakScore = at.score;
    let peakDaysBefore = 0;

    for (const days of [...LEAD_TIME_HORIZONS].sort((a, b) => b - a)) {
      const cutoff = shiftDays(churnedOn, -days);
      if (!isObservable(d.usage, cutoff)) continue;
      const replay = scoreCustomer({ ...d, asOf: cutoff });
      if (firstFlagged === null && flagged(replay.riskLevel)) firstFlagged = days;
      if (replay.score > peakScore) {
        peakScore = replay.score;
        peakDaysBefore = days;
      }
    }

    churnAccounts.push({
      customerId: id,
      churnedOn,
      score: at.score,
      level: at.riskLevel,
      confidence: at.confidence,
      observedDays: at.window.observedDays,
      flagged: flagged(at.riskLevel),
      caseType: caseBy.get(id)?.case_type ?? "unknown",
      firstFlaggedDaysBefore: firstFlagged,
      peakScore,
      peakDaysBefore,
    });
  }
  churnAccounts.sort((a, b) => b.score - a.score);

  const flaggedAtChurn = churnAccounts.filter((a) => a.flagged).length;

  /* --- Lead time ----------------------------------------------------- */
  const leadTime: LeadTimeRow[] = LEAD_TIME_HORIZONS.map((daysBefore) => {
    let evaluated = 0;
    let flags = 0;
    let notObservable = 0;

    for (const outcome of input.outcomes) {
      if (isRetained(outcome)) continue;
      const d = input.data.get(outcome.customer_id) ?? empty;
      const cutoff = shiftDays(outcome.outcome_date, -daysBefore);

      if (!isObservable(d.usage, cutoff)) {
        notObservable++;
        continue;
      }
      evaluated++;
      if (flagged(scoreCustomer({ ...d, asOf: cutoff }).riskLevel)) flags++;
    }
    return { daysBefore, evaluated, flagged: flags, notObservable };
  });

  /* --- Agreement with the labelled gradings -------------------------- */
  const confusionMap = new Map<string, ConfusionCell>();
  let exact = 0;
  let withinOne = 0;
  let labelled = 0;

  for (const outcome of input.outcomes) {
    const id = outcome.customer_id;
    const expected = (caseBy.get(id)?.expected_risk_level ?? "").toLowerCase();
    if (!expected) continue;
    const d = input.data.get(id) ?? empty;

    // Churned accounts are replayed; active ones scored on current data, which
    // is exactly how each is treated in the product.
    const result = isRetained(outcome)
      ? scoreCustomer(d)
      : scoreCustomer({ ...d, asOf: outcome.outcome_date });

    labelled++;
    if (result.riskLevel === expected) exact++;
    if (
      Math.abs(
        (LEVEL_ORDER[result.riskLevel] ?? 9) - (LEVEL_ORDER[expected] ?? 9),
      ) <= 1
    ) {
      withinOne++;
    }

    const key = `${expected}|${result.riskLevel}`;
    const cell = confusionMap.get(key);
    if (cell) cell.count++;
    else
      confusionMap.set(key, {
        expected,
        actual: result.riskLevel,
        count: 1,
      });
  }

  /* --- The expensive mistake: flagging a retained account ------------ */
  const fpAccounts: { customerId: string; score: number; level: RiskLevel }[] =
    [];
  for (const c of input.cases) {
    if (c.case_type !== "false_positive_risk") continue;
    const outcome = input.outcomes.find((o) => o.customer_id === c.customer_id);
    if (!outcome || !isRetained(outcome)) continue;
    const r = scoreCustomer(input.data.get(c.customer_id) ?? empty);
    fpAccounts.push({
      customerId: c.customer_id,
      score: r.score,
      level: r.riskLevel,
    });
  }
  fpAccounts.sort((a, b) => b.score - a.score);

  /* --- Per case type ------------------------------------------------- */
  const typeMap = new Map<string, { total: number; flagged: number }>();
  for (const outcome of input.outcomes) {
    const id = outcome.customer_id;
    const caseType = caseBy.get(id)?.case_type ?? "unknown";
    const d = input.data.get(id) ?? empty;
    const r = isRetained(outcome)
      ? scoreCustomer(d)
      : scoreCustomer({ ...d, asOf: outcome.outcome_date });

    const row = typeMap.get(caseType) ?? { total: 0, flagged: 0 };
    row.total++;
    if (flagged(r.riskLevel)) row.flagged++;
    typeMap.set(caseType, row);
  }

  const byCaseType: CaseTypeRow[] = [...typeMap.entries()]
    .map(([caseType, v]) => ({
      caseType,
      total: v.total,
      flagged: v.flagged,
      expectation: CASE_TYPE_EXPECTATION[caseType] ?? null,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    churn: {
      total: churnAccounts.length,
      flaggedAtChurn,
      highAtChurn: churnAccounts.filter((a) => a.level === "high").length,
      recall: churnAccounts.length ? flaggedAtChurn / churnAccounts.length : 0,
      accounts: churnAccounts,
    },
    leadTime,
    labelAgreement: {
      total: labelled,
      exact,
      withinOneBand: withinOne,
      accuracy: labelled ? exact / labelled : 0,
      confusion: [...confusionMap.values()].sort(
        (a, b) =>
          (LEVEL_ORDER[a.expected] ?? 9) - (LEVEL_ORDER[b.expected] ?? 9) ||
          (LEVEL_ORDER[a.actual] ?? 9) - (LEVEL_ORDER[b.actual] ?? 9),
      ),
    },
    falsePositiveCases: {
      total: fpAccounts.length,
      flagged: fpAccounts.filter((a) => a.level !== "low").length,
      flaggedHigh: fpAccounts.filter((a) => a.level === "high").length,
      accounts: fpAccounts,
    },
    byCaseType,
    constructed: [...constructed].sort(),
  };
}

/** The score at which a flag is raised, surfaced so the report can state it. */
export const FLAG_THRESHOLD = RISK_LEVEL_THRESHOLDS.medium;
