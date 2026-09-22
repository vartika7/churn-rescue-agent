import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  buildEvidencePackage,
  citableIds,
  type EvidenceInput,
} from "../lib/investigation/evidence";
import { mockInvestigation, mockProviderFor } from "../lib/investigation/mock";
import { buildUserPrompt, SYSTEM_PROMPT } from "../lib/investigation/prompt";
import {
  groundingRate,
  validateInvestigation,
} from "../lib/investigation/schema";
import { scoreCustomer } from "../lib/risk-engine";
import { block, charge, spans, ticket, usage } from "./helpers";

/**
 * The three things Phase 5 has to guarantee, in order of how badly they fail:
 * the model cannot see outcomes, it cannot cite evidence it was not given, and
 * it cannot skip the case against its own hypothesis.
 */

const declining = usage([...spans([90, 10]), ...block(12, 3)]);

function pkgFor(over: Partial<EvidenceInput> = {}) {
  const tickets = over.tickets ?? [
    ticket({
      ticket_id: "T0029",
      resolution_status: "escalated",
      sentiment: "negative",
      subject: "Workflow steps executing out of order",
      description: "Our approval chain fires before the review step completes.",
    }),
  ];
  const charges = over.charges ?? [charge({ date: "2026-09-02" })];
  const u = over.assessment ? [] : declining;

  return buildEvidencePackage({
    customerId: "C035",
    company: "Pacific Solutions",
    plan: "Enterprise",
    mrr: 1765,
    industry: "Legal Services",
    companySize: "201-500",
    signupDate: "2026-03-18",
    recordedThrough: "2026-09-20",
    assessment:
      over.assessment ??
      scoreCustomer({ usage: u, tickets, subscriptions: charges }),
    tickets,
    charges,
    ...over,
  });
}

describe("no outcome leakage", () => {
  // The guarantee is structural: EvidenceInput has no field for an outcome, so
  // this is really a test that nobody has quietly added one.
  test("the rendered prompt contains no outcome vocabulary", () => {
    const text = `${SYSTEM_PROMPT}\n${buildUserPrompt(pkgFor())}`;
    // "churn" appears legitimately in the system prompt's framing, so only the
    // user-facing evidence is checked for verdict words.
    const evidence = buildUserPrompt(pkgFor());
    for (const word of [
      "retained",
      "churned",
      "outcome",
      "expected_risk",
      "expected_recommendation",
      "case_type",
      "ground truth",
      "no_action_needed",
    ]) {
      assert.ok(
        !evidence.toLowerCase().includes(word.toLowerCase()),
        `evidence prompt leaked "${word}"`,
      );
    }
    assert.ok(text.length > 0);
  });

  test("an injected outcome field does not reach the package", () => {
    // `outcome` and `case_type` are not fields on EvidenceInput; the cast is
    // what it takes to smuggle them in at all, and they still go nowhere,
    // because the builder reads named fields rather than spreading its input.
    const smuggled = {
      outcome: "churned",
      case_type: "standard_intervene",
    } as unknown as Partial<EvidenceInput>;
    const poisoned = pkgFor(smuggled);
    const serialised = JSON.stringify(poisoned);
    assert.ok(!serialised.includes("churned"));
    assert.ok(!serialised.includes("standard_intervene"));
  });

  test("the instructions forbid guessing the outcome", () => {
    assert.match(SYSTEM_PROMPT, /must not guess/i);
  });
});

describe("grounding is enforced, not requested", () => {
  test("a citation that does not resolve is rejected", () => {
    const pkg = pkgFor();
    const good = mockInvestigation(pkg);
    const bad = {
      ...(good as Record<string, unknown>),
      supporting: [
        {
          statement: "The customer complained on a call last week.",
          citations: ["T9999"],
        },
      ],
    };
    const r = validateInvestigation(bad, citableIds(pkg));
    assert.equal(r.ok, false);
    assert.match(
      (r as { errors: string[] }).errors.join(" "),
      /never provided: T9999/,
    );
  });

  test("a claim with no citations at all is rejected", () => {
    const pkg = pkgFor();
    const bad = {
      ...(mockInvestigation(pkg) as Record<string, unknown>),
      supporting: [{ statement: "Usage is down.", citations: [] }],
    };
    const r = validateInvestigation(bad, citableIds(pkg));
    assert.equal(r.ok, false);
    assert.match(
      (r as { errors: string[] }).errors.join(" "),
      /at least one evidence id/,
    );
  });

  test("a root cause asserted with no citation is rejected", () => {
    const pkg = pkgFor();
    const bad = {
      ...(mockInvestigation(pkg) as Record<string, unknown>),
      insufficientEvidence: false,
      rootCause: {
        hypothesis: "They are switching to a competitor.",
        confidence: "high",
        citations: [],
      },
    };
    const r = validateInvestigation(bad, citableIds(pkg));
    assert.equal(r.ok, false);
    assert.match(
      (r as { errors: string[] }).errors.join(" "),
      /unless insufficientEvidence is true/,
    );
  });

  test("but an honest 'I cannot tell' needs no citation", () => {
    const pkg = pkgFor();
    const ok = {
      ...(mockInvestigation(pkg) as Record<string, unknown>),
      insufficientEvidence: true,
      rootCause: {
        hypothesis: "No root cause can be determined.",
        confidence: "low",
        citations: [],
      },
    };
    assert.equal(validateInvestigation(ok, citableIds(pkg)).ok, true);
  });

  test("grounding rate reports partial fabrication rather than hiding it", () => {
    const pkg = pkgFor();
    const r = validateInvestigation(mockInvestigation(pkg), citableIds(pkg));
    assert.equal(r.ok, true);
    const value = (r as { value: Parameters<typeof groundingRate>[0] }).value;
    const clean = groundingRate(value, citableIds(pkg));
    assert.equal(clean.rate, 1);

    const tainted = groundingRate(
      { ...value, supporting: [{ statement: "x", citations: ["NOPE"] }] },
      citableIds(pkg),
    );
    assert.ok(tainted.rate < 1);
  });
});

describe("response shape", () => {
  test("accepts the offline provider's output", () => {
    const pkg = pkgFor();
    const r = validateInvestigation(mockInvestigation(pkg), citableIds(pkg));
    assert.equal(
      r.ok,
      true,
      JSON.stringify((r as { errors?: string[] }).errors),
    );
  });

  test("parses a JSON string as well as an object", () => {
    const pkg = pkgFor();
    const text = JSON.stringify(mockInvestigation(pkg));
    assert.equal(validateInvestigation(text, citableIds(pkg)).ok, true);
  });

  test("rejects prose that is not JSON", () => {
    const r = validateInvestigation("The account looks risky to me.");
    assert.equal(r.ok, false);
    assert.match(
      (r as { errors: string[] }).errors.join(" "),
      /not valid JSON/,
    );
  });

  test("rejects an unknown recommended action", () => {
    const pkg = pkgFor();
    const bad = {
      ...(mockInvestigation(pkg) as Record<string, unknown>),
      recommendation: {
        action: "send_email",
        reasoning: "why not",
        citations: [],
      },
    };
    const r = validateInvestigation(bad, citableIds(pkg));
    assert.equal(r.ok, false);
    assert.match(
      (r as { errors: string[] }).errors.join(" "),
      /action must be one of/,
    );
  });

  test("requires the limitations field to say something", () => {
    const pkg = pkgFor();
    const bad = {
      ...(mockInvestigation(pkg) as Record<string, unknown>),
      limitations: "",
    };
    const r = validateInvestigation(bad, citableIds(pkg));
    assert.equal(r.ok, false);
    assert.match((r as { errors: string[] }).errors.join(" "), /limitations/);
  });

  test("collects every error rather than stopping at the first", () => {
    const r = validateInvestigation({ riskInterpretation: "" });
    assert.equal(r.ok, false);
    assert.ok(
      (r as { errors: string[] }).errors.length > 3,
      "a mostly-empty response should report several problems",
    );
  });
});

describe("evidence package", () => {
  test("carries zero-point signals so the model can argue against risk", () => {
    const pkg = pkgFor();
    const contradicting = pkg.items.filter(
      (i) => i.direction === "contradicting",
    );
    assert.ok(
      contradicting.length > 0,
      "a package with no contradicting evidence can only ever confirm the score",
    );
  });

  test("includes ticket prose, which is the reason this layer exists", () => {
    const rendered = buildUserPrompt(pkgFor());
    assert.ok(rendered.includes("Workflow steps executing out of order"));
    assert.ok(rendered.includes("approval chain fires before the review step"));
  });

  test("every item id is unique and citable", () => {
    const pkg = pkgFor();
    const ids = pkg.items.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate evidence ids");
    assert.equal(citableIds(pkg).size, ids.length);
  });

  test("says so explicitly when there are no tickets", () => {
    const rendered = buildUserPrompt(pkgFor({ tickets: [] }));
    assert.match(rendered, /absence of evidence, not evidence of health/);
  });

  test("tenure is derived from the record, not the wall clock", () => {
    const pkg = pkgFor();
    // 2026-03-18 to 2026-09-20.
    assert.equal(pkg.account.tenureDays, 186);
  });
});

describe("offline provider", () => {
  test("round-trips through the provider interface", async () => {
    const pkg = pkgFor();
    const provider = mockProviderFor(pkg);
    const res = await provider.complete({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(pkg),
    });
    assert.equal(provider.name, "mock");
    assert.equal(validateInvestigation(res.text, citableIds(pkg)).ok, true);
  });

  test("labels itself as not being an investigation", async () => {
    const pkg = pkgFor();
    const out = mockInvestigation(pkg) as { limitations: string };
    // Whatever renders this must be able to tell the reader it is not AI
    // output. Silence here is how a placeholder gets mistaken for analysis.
    assert.match(out.limitations, /offline/i);
    assert.match(out.limitations, /not a substitute/i);
  });

  test("declines to guess on a thin record", () => {
    const thin = buildEvidencePackage({
      customerId: "C042",
      company: "Granite Group",
      plan: "Growth",
      mrr: 75,
      industry: "Energy",
      companySize: "11-50",
      signupDate: "2026-08-14",
      recordedThrough: "2026-09-20",
      assessment: scoreCustomer({
        usage: usage(spans([38, 4])),
        tickets: [],
        subscriptions: [charge()],
      }),
      tickets: [],
      charges: [charge()],
    });
    const out = mockInvestigation(thin) as {
      insufficientEvidence: boolean;
      rootCause: { citations: string[] };
    };
    assert.equal(out.insufficientEvidence, true);
    assert.deepEqual(out.rootCause.citations, []);
    assert.equal(validateInvestigation(out, citableIds(thin)).ok, true);
  });
});
