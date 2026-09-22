import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  compareToBand,
  evaluateAi,
  gradeCase,
  phantomEntities,
  type GradeInput,
} from "../lib/ai-evaluation";
import {
  buildEvidencePackage,
  type EvidencePackage,
} from "../lib/investigation/evidence";
import { mockInvestigation } from "../lib/investigation/mock";
import type { Investigation } from "../lib/investigation/schema";
import { scoreCustomer } from "../lib/risk-engine";
import { block, charge, spans, ticket, usage } from "./helpers";

/**
 * Adversarial suite for the AI layer.
 *
 * The live metrics say the model behaved. These say the pipeline would have
 * caught it if it hadn't — which is the part that actually generalises,
 * because it holds for a model nobody has run yet. Each case is a response a
 * plausible-sounding model might really produce.
 */

const tickets = [
  ticket({
    ticket_id: "T0029",
    resolution_status: "escalated",
    sentiment: "negative",
    subject: "Workflow steps executing out of order",
    description: "Our approval chain fires before the review step completes.",
  }),
];
const charges = [charge({ date: "2026-09-02" })];

function pkg(days = 120): EvidencePackage {
  const u =
    days >= 120
      ? usage([...spans([days - 30, 10]), ...block(12, 3)])
      : usage(spans([days, 4]));
  return buildEvidencePackage({
    customerId: "C035",
    company: "Pacific Solutions",
    plan: "Enterprise",
    mrr: 1765,
    industry: "Legal Services",
    companySize: "201-500",
    signupDate: "2026-03-18",
    recordedThrough: "2026-09-20",
    assessment: scoreCustomer({ usage: u, tickets, subscriptions: charges }),
    tickets,
    charges,
  });
}

const good = (p: EvidencePackage) => mockInvestigation(p) as Investigation;

const input = (stored: unknown, p = pkg(), expected?: string): GradeInput => ({
  customerId: "C035",
  provider: "gemini",
  model: "test-model",
  stored,
  pkg: p,
  expectedRecommendation: expected,
});

describe("adversarial: fabrication", () => {
  test("a fabricated citation fails grading, not just logging", () => {
    const p = pkg();
    const bad = {
      ...good(p),
      supporting: [
        { statement: "They said so on a call.", citations: ["CALL-0901"] },
      ],
    };
    const c = gradeCase(input(bad, p));
    assert.equal(c.valid, false);
    assert.match(c.validationErrors.join(" "), /never provided/);
  });

  // The nastiest failure mode: citations all resolve, and the prose alongside
  // them names a ticket that does not exist. Citation checking alone misses
  // this entirely.
  test("a phantom ticket in the prose is caught even with clean citations", () => {
    const p = pkg();
    const base = good(p);
    const sneaky: Investigation = {
      ...base,
      rootCause: {
        ...base.rootCause,
        hypothesis:
          "Ticket T0099 shows the same fault recurring, so the problem is systemic.",
      },
    };
    const c = gradeCase(input(sneaky, p));
    assert.equal(c.valid, true, "it validates — that is the point");
    assert.equal(c.grounding.rate, 1, "and every citation resolves");
    assert.deepEqual(c.phantomEntities, ["T0099"]);
  });

  test("an invented date in the prose is caught", () => {
    const p = pkg();
    const base = good(p);
    const c = gradeCase(
      input(
        {
          ...base,
          limitations: "The outage on 2019-01-01 is not covered by this data.",
        },
        p,
      ),
    );
    assert.deepEqual(c.phantomEntities, ["2019-01-01"]);
  });

  test("real ids and dates from the package are not flagged", () => {
    const p = pkg();
    const base = good(p);
    const c = gradeCase(
      input(
        {
          ...base,
          rootCause: {
            ...base.rootCause,
            hypothesis:
              "T0029 remains open and the charge on 2026-09-02 cleared.",
          },
        },
        p,
      ),
    );
    assert.deepEqual(c.phantomEntities, []);
  });

  test("the detector reports every distinct phantom, sorted", () => {
    const p = pkg();
    const base = good(p);
    const inv: Investigation = {
      ...base,
      riskInterpretation: "See T0500 and T0100.",
      limitations: "Also 1999-12-31 and T0500 again.",
    };
    assert.deepEqual(phantomEntities(inv, p), ["1999-12-31", "T0100", "T0500"]);
  });
});

describe("adversarial: unsupported and one-sided claims", () => {
  test("an uncited claim fails grading", () => {
    const p = pkg();
    const c = gradeCase(
      input(
        {
          ...good(p),
          supporting: [{ statement: "Churn imminent.", citations: [] }],
        },
        p,
      ),
    );
    assert.equal(c.valid, false);
  });

  test("an unfalsifiable root cause fails grading", () => {
    const p = pkg();
    const c = gradeCase(
      input(
        {
          ...good(p),
          insufficientEvidence: false,
          rootCause: {
            hypothesis: "They are switching to a competitor.",
            confidence: "high",
            citations: [],
          },
        },
        p,
      ),
    );
    assert.equal(c.valid, false);
  });

  test("ignoring the available counter-case is recorded", () => {
    const p = pkg();
    // A one-sided investigation is still valid output — it is not malformed.
    // It is a quality failure, so it surfaces as a metric rather than a
    // rejection, which is the distinction the report has to preserve.
    const c = gradeCase(input({ ...good(p), contradicting: [] }, p));
    assert.equal(c.valid, true);
    assert.equal(c.contradictingAvailable, true);
    assert.equal(c.contradictingUsed, false);
  });

  test("an unknown action fails grading", () => {
    const p = pkg();
    const c = gradeCase(
      input(
        {
          ...good(p),
          recommendation: {
            action: "email_the_ceo",
            reasoning: "Escalate hard.",
            citations: [],
          },
        },
        p,
      ),
    );
    assert.equal(c.valid, false);
  });

  test("prose instead of JSON fails grading", () => {
    const c = gradeCase(input("The account looks risky."));
    assert.equal(c.valid, false);
    assert.equal(c.recommendedAction, "n/a");
  });
});

describe("adversarial: uncertainty", () => {
  test("inventing a root cause on a thin record is flagged", () => {
    const thin = pkg(38);
    const base = good(thin);
    const c = gradeCase(
      input(
        {
          ...base,
          insufficientEvidence: false,
          rootCause: {
            hypothesis: "Onboarding failed and the champion left.",
            confidence: "high",
            citations: [thin.items[0].id],
          },
        },
        thin,
      ),
    );
    assert.equal(c.valid, true);
    assert.equal(c.observedDays, 38);
    assert.equal(c.insufficientAppropriate, false);
  });

  test("declining to judge a thin record is correct", () => {
    const thin = pkg(38);
    const c = gradeCase(input(good(thin), thin));
    assert.equal(c.insufficientEvidence, true);
    assert.equal(c.insufficientAppropriate, true);
  });

  // Regression: an earlier version of this metric expected an insufficient
  // verdict whenever no signal fired, which marked a healthy account with six
  // months of clean records as a failure. Abundant evidence of good news is
  // not absent evidence.
  test("a long clean record is not expected to claim insufficiency", () => {
    const clean = buildEvidencePackage({
      customerId: "C009",
      company: "Westbrook Ventures",
      plan: "Pro",
      mrr: 500,
      industry: "SaaS",
      companySize: "51-200",
      signupDate: "2026-03-18",
      recordedThrough: "2026-09-20",
      assessment: scoreCustomer({
        usage: usage(spans([186, 8])),
        tickets: [],
        subscriptions: [
          charge(),
          charge({ date: "2026-07-01" }),
          charge({ date: "2026-08-01" }),
        ],
      }),
      tickets: [],
      charges: [
        charge(),
        charge({ date: "2026-07-01" }),
        charge({ date: "2026-08-01" }),
      ],
    });
    // Claiming sufficiency obliges the root cause to cite something — the
    // mock returns no citations alongside its insufficient verdict, so
    // flipping only the flag would be internally inconsistent and the
    // validator rightly rejects it.
    const base = good(clean);
    const c = gradeCase(
      input(
        {
          ...base,
          insufficientEvidence: false,
          rootCause: {
            hypothesis: "The account is healthy; usage is growing.",
            confidence: "high",
            citations: [clean.items[0].id],
          },
        },
        clean,
      ),
    );
    assert.equal(c.valid, true, c.validationErrors.join("; "));
    assert.equal(c.observedDays, 186);
    assert.equal(c.insufficientAppropriate, true);
  });
});

describe("band comparison", () => {
  test("classifies urgency against the deterministic level", () => {
    assert.equal(compareToBand("intervene", "high"), "aligned");
    assert.equal(compareToBand("monitor", "medium"), "aligned");
    assert.equal(compareToBand("no_action_needed", "low"), "aligned");
    assert.equal(compareToBand("intervene", "low"), "escalated");
    assert.equal(compareToBand("monitor", "low"), "escalated");
    assert.equal(compareToBand("no_action_needed", "high"), "de-escalated");
    assert.equal(compareToBand("monitor", "high"), "de-escalated");
  });

  test("de-escalation is the direction that loses a churn", () => {
    // Recorded separately from escalation on purpose: an escalation adds an
    // account to a worklist, a de-escalation removes one.
    const p = pkg();
    const c = gradeCase(
      input(
        {
          ...good(p),
          recommendation: {
            action: "no_action_needed",
            reasoning: "Looks fine to me.",
            citations: [p.items[0].id],
          },
        },
        p,
      ),
    );
    assert.equal(c.deterministicLevel, "high");
    assert.equal(c.vsBand, "de-escalated");
  });
});

describe("aggregate report", () => {
  test("separates malformed cases from quality failures", () => {
    const p = pkg();
    const report = evaluateAi([
      input(good(p), p, "intervene"),
      input({ ...good(p), contradicting: [] }, p, "intervene"),
      input("not json", p, "monitor"),
    ]);
    assert.equal(report.totals.graded, 3);
    assert.equal(report.totals.valid, 2);
    assert.equal(report.totals.contradictingUsed, 1);
    assert.equal(report.totals.contradictingAvailable, 3);
  });

  test("compares against the human grading without scoring it", () => {
    const p = pkg();
    const report = evaluateAi([
      input(good(p), p, "intervene"),
      input(good(p), p, "monitor"),
    ]);
    assert.equal(report.vsGroundTruth.compared, 2);
    assert.equal(report.vsGroundTruth.agree, 1);
  });

  test("skips the comparison when no label exists", () => {
    const p = pkg();
    const report = evaluateAi([input(good(p), p)]);
    assert.equal(report.vsGroundTruth.compared, 0);
  });

  test("breaks results down per model", () => {
    const p = pkg();
    const report = evaluateAi([
      { ...input(good(p), p), model: "model-a" },
      { ...input(good(p), p), model: "model-b" },
    ]);
    assert.equal(report.byModel.length, 2);
  });

  test("no cases does not divide by zero", () => {
    const report = evaluateAi([]);
    assert.equal(report.totals.graded, 0);
    assert.ok(Number.isFinite(report.totals.meanGrounding));
  });
});
