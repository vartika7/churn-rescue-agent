import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { MIN_OBSERVED_DAYS_FOR_CONFIDENCE } from "../lib/constants";
import { evaluate, type AccountData, type EvalInput } from "../lib/evaluation";
import type { CustomerOutcome, EvaluationCase } from "../lib/types";
import { block, spans, ticket, usage } from "./helpers";

/**
 * The harness grades the engine, so it needs its own grading. A metric that
 * silently counts an unobservable account as a miss, or scores a churned
 * account against data from after it left, reports a number that looks
 * authoritative and means nothing.
 */

const CHURN_DATE = "2026-06-30";

const churned = (id: string, date = CHURN_DATE): CustomerOutcome =>
  ({
    customer_id: id,
    outcome: "churned",
    outcome_date: date,
  }) as CustomerOutcome;

const retained = (id: string): CustomerOutcome =>
  ({
    customer_id: id,
    outcome: "retained",
    outcome_date: "",
  }) as CustomerOutcome;

const evalCase = (
  id: string,
  over: Partial<EvaluationCase> = {},
): EvaluationCase =>
  ({
    customer_id: id,
    actual_outcome: "churned",
    expected_risk_level: "high",
    expected_recommendation: "intervene",
    expected_root_cause: "",
    case_type: "standard_intervene",
    ...over,
  }) as EvaluationCase;

/** Declining hard enough to flag: 60 flat days then 30 mostly silent. */
const declining = (end = CHURN_DATE, days = 120) =>
  usage([...spans([days - 30, 10]), ...block(15, 3)], end);

const steady = (end = CHURN_DATE, days = 120) => usage(spans([days, 10]), end);

function input(
  entries: [string, AccountData][],
  outcomes: CustomerOutcome[],
  cases: EvaluationCase[],
  constructed: string[] = [],
): EvalInput {
  return { outcomes, cases, data: new Map(entries), constructed };
}

const acct = (u: ReturnType<typeof usage>): AccountData => ({
  usage: u,
  tickets: [],
  subscriptions: [],
});

describe("churn detection", () => {
  test("counts a declining churned account as caught", () => {
    const r = evaluate(
      input([["X1", acct(declining())]], [churned("X1")], [evalCase("X1")]),
    );
    assert.equal(r.churn.total, 1);
    assert.equal(r.churn.flaggedAtChurn, 1);
    assert.equal(r.churn.recall, 1);
  });

  test("counts a steady churned account as missed", () => {
    const r = evaluate(
      input([["X2", acct(steady())]], [churned("X2")], [evalCase("X2")]),
    );
    assert.equal(r.churn.flaggedAtChurn, 0);
    assert.equal(r.churn.recall, 0);
  });

  test("ignores retained accounts entirely", () => {
    const r = evaluate(
      input(
        [
          ["X1", acct(declining())],
          ["R1", acct(declining("2026-09-20"))],
        ],
        [churned("X1"), retained("R1")],
        [evalCase("X1"), evalCase("R1", { actual_outcome: "retained" })],
      ),
    );
    assert.equal(r.churn.total, 1);
    assert.equal(r.churn.accounts[0].customerId, "X1");
  });

  // If the harness scored churned accounts against the full record, it would
  // be reading data from after the customer left — and reporting a detection
  // the engine could never have made in time.
  test("scores a churned account as of its churn date, not the full record", () => {
    // Steady until the churn date, collapsing only afterwards.
    const u = usage([...spans([120, 10]), ...spans([30, 0])], "2026-07-30");
    const churnedOn = u[119].date;
    const r = evaluate(
      input([["X3", acct(u)]], [churned("X3", churnedOn)], [evalCase("X3")]),
    );
    assert.equal(
      r.churn.flaggedAtChurn,
      0,
      "the post-churn collapse must be invisible",
    );
    assert.equal(r.churn.accounts[0].observedDays, 120);
  });
});

describe("lead time observability", () => {
  const horizonRow = (r: ReturnType<typeof evaluate>, days: number) =>
    r.leadTime.find((x) => x.daysBefore === days)!;

  test(`a horizon with under ${MIN_OBSERVED_DAYS_FOR_CONFIDENCE} days of records is not evaluated`, () => {
    // 70 days of history: at 30 days before churn only 40 records exist.
    const r = evaluate(
      input(
        [["X4", acct(steady(CHURN_DATE, 70))]],
        [churned("X4")],
        [evalCase("X4")],
      ),
    );
    const at30 = horizonRow(r, 30);
    assert.equal(at30.evaluated, 0);
    assert.equal(at30.notObservable, 1);

    const at0 = horizonRow(r, 0);
    assert.equal(at0.evaluated, 1, "70 records is enough to judge at churn");
    assert.equal(at0.notObservable, 0);
  });

  test("evaluated and notObservable together account for every churned row", () => {
    const r = evaluate(
      input(
        [
          ["X1", acct(declining())],
          ["X4", acct(steady(CHURN_DATE, 70))],
        ],
        [churned("X1"), churned("X4")],
        [evalCase("X1"), evalCase("X4")],
      ),
    );
    for (const row of r.leadTime) {
      assert.equal(
        row.evaluated + row.notObservable,
        2,
        `horizon ${row.daysBefore} lost an account`,
      );
    }
  });

  test("flagged never exceeds evaluated", () => {
    const r = evaluate(
      input(
        [
          ["X1", acct(declining())],
          ["X2", acct(steady())],
        ],
        [churned("X1"), churned("X2")],
        [evalCase("X1"), evalCase("X2")],
      ),
    );
    for (const row of r.leadTime) {
      assert.ok(row.flagged <= row.evaluated, `horizon ${row.daysBefore}`);
    }
  });
});

describe("peak score", () => {
  test("records a peak earlier than the churn-date score", () => {
    // Collapses mid-record, then recovers before churning.
    const u = usage(
      [...spans([60, 10]), ...block(20, 1), ...spans([40, 10])],
      CHURN_DATE,
    );
    const r = evaluate(
      input([["X5", acct(u)]], [churned("X5")], [evalCase("X5")]),
    );
    const a = r.churn.accounts[0];
    assert.ok(
      a.peakScore >= a.score,
      "peak must be at least the final score by construction",
    );
    assert.ok(a.peakDaysBefore >= 0);
  });

  test("peak equals the final score for a monotonic decline", () => {
    const r = evaluate(
      input([["X1", acct(declining())]], [churned("X1")], [evalCase("X1")]),
    );
    const a = r.churn.accounts[0];
    assert.equal(a.peakScore, a.score);
    assert.equal(a.peakDaysBefore, 0);
  });
});

describe("label agreement", () => {
  test("matches on the expected level and counts the confusion cell", () => {
    const r = evaluate(
      input(
        [["X1", acct(declining())]],
        [churned("X1")],
        [evalCase("X1", { expected_risk_level: "high" })],
      ),
    );
    assert.equal(r.labelAgreement.total, 1);
    assert.equal(r.labelAgreement.exact, 1);
    assert.equal(r.labelAgreement.confusion[0].count, 1);
  });

  test("counts a near miss as within one band but not exact", () => {
    const r = evaluate(
      input(
        [["X2", acct(steady())]],
        [churned("X2")],
        [evalCase("X2", { expected_risk_level: "medium" })],
      ),
    );
    assert.equal(r.labelAgreement.exact, 0);
    assert.equal(r.labelAgreement.withinOneBand, 1);
  });

  test("skips accounts with no label rather than scoring them as wrong", () => {
    const r = evaluate(input([["X1", acct(declining())]], [churned("X1")], []));
    assert.equal(r.labelAgreement.total, 0);
  });
});

describe("false positive cases", () => {
  test("counts only retained accounts labelled false_positive_risk", () => {
    const r = evaluate(
      input(
        [
          ["R1", acct(declining("2026-09-20"))],
          ["X1", acct(declining())],
        ],
        [retained("R1"), churned("X1")],
        [
          evalCase("R1", {
            case_type: "false_positive_risk",
            expected_risk_level: "low",
            actual_outcome: "retained",
          }),
          // A churned account with the same type must not be counted here.
          evalCase("X1", { case_type: "false_positive_risk" }),
        ],
      ),
    );
    assert.equal(r.falsePositiveCases.total, 1);
    assert.equal(r.falsePositiveCases.accounts[0].customerId, "R1");
  });

  test("a quiet retained account is not counted as a false positive", () => {
    const r = evaluate(
      input(
        [["R2", acct(steady("2026-09-20"))]],
        [retained("R2")],
        [
          evalCase("R2", {
            case_type: "false_positive_risk",
            actual_outcome: "retained",
          }),
        ],
      ),
    );
    assert.equal(r.falsePositiveCases.total, 1);
    assert.equal(r.falsePositiveCases.flagged, 0);
    assert.equal(r.falsePositiveCases.flaggedHigh, 0);
  });
});

describe("case type breakdown", () => {
  test("carries the stated expectation for known types", () => {
    const r = evaluate(
      input(
        [["X2", acct(steady())]],
        [churned("X2")],
        [evalCase("X2", { case_type: "unobservable_limitation" })],
      ),
    );
    const row = r.byCaseType.find(
      (x) => x.caseType === "unobservable_limitation",
    );
    // A miss here is the correct answer, and the report has to say so rather
    // than counting it against the engine.
    assert.match(row!.expectation!, /Miss expected/);
    assert.equal(row!.flagged, 0);
  });

  test("leaves the expectation null for an unrecognised type", () => {
    const r = evaluate(
      input(
        [["X1", acct(declining())]],
        [churned("X1")],
        [evalCase("X1", { case_type: "something_new" })],
      ),
    );
    assert.equal(
      r.byCaseType.find((x) => x.caseType === "something_new")!.expectation,
      null,
    );
  });

  test("every churned and retained account lands in exactly one type", () => {
    const r = evaluate(
      input(
        [
          ["X1", acct(declining())],
          ["X2", acct(steady())],
          ["R1", acct(steady("2026-09-20"))],
        ],
        [churned("X1"), churned("X2"), retained("R1")],
        [evalCase("X1"), evalCase("X2"), evalCase("R1")],
      ),
    );
    assert.equal(
      r.byCaseType.reduce((n, t) => n + t.total, 0),
      3,
    );
  });
});

describe("constructed accounts are named, not hidden", () => {
  test("passes the list through to the report", () => {
    const r = evaluate(
      input(
        [["X1", acct(declining())]],
        [churned("X1")],
        [evalCase("X1")],
        ["C035", "C038"],
      ),
    );
    // Metrics including hand-authored accounts are partly self-fulfilling, so
    // the report has to be able to say which they are.
    assert.deepEqual(r.constructed, ["C035", "C038"]);
  });
});

describe("degenerate input", () => {
  test("no churned accounts gives zero recall without dividing by zero", () => {
    const r = evaluate(
      input([["R1", acct(steady("2026-09-20"))]], [retained("R1")], []),
    );
    assert.equal(r.churn.total, 0);
    assert.equal(r.churn.recall, 0);
    assert.ok(Number.isFinite(r.churn.recall));
  });

  test("an account with no data at all does not throw", () => {
    const r = evaluate(input([], [churned("GONE")], [evalCase("GONE")]));
    assert.equal(r.churn.total, 1);
    assert.equal(r.churn.accounts[0].observedDays, 0);
    assert.equal(r.churn.flaggedAtChurn, 0);
  });

  test("tickets and charges still count when usage is thin", () => {
    const r = evaluate(
      input(
        [
          [
            "X6",
            {
              usage: steady(CHURN_DATE, 70),
              tickets: [
                ticket({ resolution_status: "escalated" }),
                ticket({ ticket_id: "T2", resolution_status: "escalated" }),
              ],
              subscriptions: [],
            },
          ],
        ],
        [churned("X6")],
        [evalCase("X6")],
      ),
    );
    assert.ok(r.churn.accounts[0].score > 0);
  });
});
