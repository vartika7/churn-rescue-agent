import assert from "node:assert/strict";
import { test, describe } from "node:test";

import type { RiskLevel } from "../lib/risk-engine";
import {
  RISK_LEVELS,
  confidenceLabel,
  riskBadgeClass,
  riskLabel,
  riskLabelAtChurn,
  riskRank,
} from "../lib/risk-display";

describe("churned accounts never get present-tense risk language", () => {
  // Regression: a churned account rendered a live "High risk" badge, which
  // reads as an instruction to go and save a company that left in April.
  test("every level is phrased in the past", () => {
    for (const level of RISK_LEVELS) {
      const label = riskLabelAtChurn(level);
      assert.match(
        label,
        /before churn$/,
        `${level} should place the score in the past`,
      );
      assert.match(label, /^Scored /);
    }
  });

  test("the past-tense label is never identical to the live one", () => {
    for (const level of RISK_LEVELS) {
      assert.notEqual(riskLabelAtChurn(level), riskLabel(level));
    }
  });

  test("the live label stays present-tense for active accounts", () => {
    assert.equal(riskLabel("high"), "High risk");
    assert.equal(riskLabel("medium"), "Medium risk");
    assert.equal(riskLabel("low"), "Low risk");
  });
});

describe("ordering", () => {
  test("ranks most urgent first", () => {
    assert.ok(riskRank("high") < riskRank("medium"));
    assert.ok(riskRank("medium") < riskRank("low"));
  });

  test("RISK_LEVELS is already in rank order", () => {
    const sorted = [...RISK_LEVELS].sort((a, b) => riskRank(a) - riskRank(b));
    assert.deepEqual(sorted, RISK_LEVELS);
  });
});

describe("exhaustiveness", () => {
  // These are switch statements over a union; a new level added to RiskLevel
  // without updating them would return undefined and render an empty badge.
  test("every level yields a label and a class", () => {
    for (const level of RISK_LEVELS) {
      assert.equal(typeof riskLabel(level), "string");
      assert.ok(riskLabel(level).length > 0);
      assert.match(riskBadgeClass(level), /^badge badge-/);
    }
  });

  test("badge classes are distinct per level", () => {
    const classes = RISK_LEVELS.map(riskBadgeClass);
    assert.equal(new Set(classes).size, RISK_LEVELS.length);
  });

  test("every confidence yields a label", () => {
    for (const c of ["high", "medium", "low"] as const) {
      assert.ok(confidenceLabel(c).length > 0);
    }
  });

  test("low confidence says what it means, not just how low", () => {
    // "low confidence" alone reads as a weak verdict; the point is that there
    // was little to go on.
    assert.match(confidenceLabel("low"), /little to go on/);
  });
});

describe("risk and confidence are not the same axis", () => {
  test("confidence labels never reuse the risk wording", () => {
    // A confidence chip reading "High risk" next to a risk badge would look
    // like a second severity score.
    for (const c of ["high", "medium", "low"] as const) {
      const label = confidenceLabel(c);
      for (const level of RISK_LEVELS as RiskLevel[]) {
        assert.notEqual(label, riskLabel(level));
      }
      assert.ok(!/\brisk\b/i.test(label), `"${label}" should not say "risk"`);
    }
  });
});
