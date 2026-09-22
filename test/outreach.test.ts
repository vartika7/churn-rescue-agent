import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { buildEvidencePackage } from "../lib/investigation/evidence";
import { FailingProvider } from "../lib/investigation/mock";
import type { InvestigationProvider } from "../lib/investigation/provider";
import type { Investigation } from "../lib/investigation/schema";
import {
  buildUserPrompt,
  offlineDraft,
  runDraft,
  SYSTEM_PROMPT,
} from "../lib/outreach/run";
import { editDistance, validateDraft } from "../lib/outreach/schema";
import { scoreCustomer } from "../lib/risk-engine";
import { block, charge, spans, ticket, usage } from "./helpers";

/**
 * Outreach is the only text in this project pointed at a customer rather than
 * a colleague, which changes what counts as a failure. An internal note that
 * overstates costs a CSM an afternoon; an email that tells a customer they
 * were scored, or promises them a refund, cannot be taken back.
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

const pkg = buildEvidencePackage({
  customerId: "C035",
  company: "Pacific Solutions",
  plan: "Enterprise",
  mrr: 1765,
  industry: "Legal Services",
  companySize: "201-500",
  signupDate: "2026-03-18",
  recordedThrough: "2026-09-20",
  assessment: scoreCustomer({
    usage: usage([...spans([90, 10]), ...block(12, 3)]),
    tickets,
    subscriptions: charges,
  }),
  tickets,
  charges,
});

const investigation: Investigation = {
  riskInterpretation: "Engagement has fallen away.",
  rootCause: {
    hypothesis: "An unresolved workflow fault drove disengagement.",
    confidence: "high",
    citations: ["T0029"],
  },
  supporting: [{ statement: "Sessions are down.", citations: ["T0029"] }],
  contradicting: [],
  recommendation: {
    action: "intervene",
    reasoning: "Resolve the ticket, then re-engage.",
    citations: ["T0029"],
  },
  limitations: "No CRM notes.",
  insufficientEvidence: false,
};

const good = {
  subject: "The workflow issue you raised in April",
  body: "I noticed the approval sequencing problem you reported is still open. I would like to get it in front of engineering properly. Would a short call this week work?",
  citations: ["T0029"],
  checkBeforeSending: "Confirm the ticket is genuinely still open.",
};

const canned = (text: string): InvestigationProvider => ({
  name: "canned",
  async complete() {
    return { text, model: "canned" };
  },
});

const citable = new Set(pkg.items.map((i) => i.id));

describe("the customer must never learn they were scored", () => {
  // The single worst failure available to this system: everything else is
  // visible only to the team.
  for (const leak of [
    "Our system flagged your account as a churn risk.",
    "Your health score has dropped recently.",
    "You are currently at-risk based on our model.",
    "Your account scored 70/100 this month.",
  ]) {
    test(`rejects: "${leak.slice(0, 40)}…"`, () => {
      const r = validateDraft({ ...good, body: leak }, citable);
      assert.equal(r.ok, false);
      assert.match(
        (r as { errors: string[] }).errors.join(" "),
        /internal scoring/,
      );
    });
  }

  test("catches it in the subject line too", () => {
    const r = validateDraft(
      { ...good, subject: "Your account is at risk" },
      citable,
    );
    assert.equal(r.ok, false);
  });

  test("the instructions say so as well as the validator", () => {
    assert.match(SYSTEM_PROMPT, /never read that they were scored/i);
  });
});

describe("a draft may propose a conversation, not a remedy", () => {
  for (const promise of [
    "We will fix this by the end of the week.",
    "I can offer you a discount while we sort it out.",
    "We guarantee this will not happen again.",
    "We'll refund the last two months.",
  ]) {
    test(`rejects: "${promise.slice(0, 36)}…"`, () => {
      const r = validateDraft({ ...good, body: promise }, citable);
      assert.equal(r.ok, false);
      assert.match(
        (r as { errors: string[] }).errors.join(" "),
        /commitment nobody authorised/,
      );
    });
  }

  test("proposing a call is fine", () => {
    assert.equal(validateDraft(good, citable).ok, true);
  });
});

describe("grounding", () => {
  test("a fabricated citation is rejected", () => {
    const r = validateDraft({ ...good, citations: ["CALL-0901"] }, citable);
    assert.equal(r.ok, false);
    assert.match(
      (r as { errors: string[] }).errors.join(" "),
      /never provided/,
    );
  });

  test("an uncited draft is rejected", () => {
    const r = validateDraft({ ...good, citations: [] }, citable);
    assert.equal(r.ok, false);
  });

  test("checkBeforeSending cannot be empty", () => {
    const r = validateDraft({ ...good, checkBeforeSending: "" }, citable);
    assert.equal(r.ok, false);
  });
});

describe("the prompt only shows evidence the investigation used", () => {
  test("includes the cited ticket", () => {
    const p = buildUserPrompt(pkg, investigation);
    assert.ok(p.includes("T0029"));
    assert.ok(p.includes("approval chain fires"));
  });

  test("omits evidence the investigation did not lean on", () => {
    // Handing over the whole package invites the draft to raise things the
    // investigation reached no conclusion about.
    const p = buildUserPrompt(pkg, investigation);
    assert.ok(!p.includes("billing.2026-09-02"));
  });

  test("tells the model the customer has seen none of it", () => {
    assert.match(
      buildUserPrompt(pkg, investigation),
      /customer has not seen any of the above/,
    );
  });

  test("flags an inconclusive investigation so the draft does not assert one", () => {
    const p = buildUserPrompt(pkg, {
      ...investigation,
      insufficientEvidence: true,
    });
    assert.match(p, /could not determine a root cause/);
  });
});

describe("running a draft", () => {
  test("accepts a clean response", async () => {
    const r = await runDraft({
      provider: canned(JSON.stringify(good)),
      pkg,
      investigation,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.draft.subject, good.subject);
    assert.equal(r.offline, false);
  });

  test("rejects rather than repairs a leaking response", async () => {
    const r = await runDraft({
      provider: canned(
        JSON.stringify({
          ...good,
          body: "Our system flagged your churn risk.",
        }),
      ),
      pkg,
      investigation,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.stage, "validation");
    assert.ok(r.raw, "the raw text is kept for diagnosis");
  });

  test("a dead provider degrades rather than throws", async () => {
    const r = await runDraft({
      provider: new FailingProvider("down"),
      pkg,
      investigation,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.stage, "provider");
  });
});

describe("offline draft", () => {
  test("is valid, grounded and says it is not usable as-is", () => {
    const r = offlineDraft(pkg, investigation);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.offline, true);
    assert.equal(validateDraft(r.draft, citable).ok, true);
    assert.match(r.draft.checkBeforeSending, /offline/i);
    assert.match(r.draft.checkBeforeSending, /rewrite/i);
  });

  test("asserts nothing about the account", () => {
    // A template cannot read the investigation's nuance and must not imply it
    // has: a generic check-in is honest, a specific one would be invented.
    const r = offlineDraft(pkg, investigation);
    if (!r.ok) return;
    assert.ok(!r.draft.body.includes("workflow"));
    assert.equal(validateDraft(r.draft, citable).ok, true);
  });
});

describe("edit distance", () => {
  // The Phase 6 quality metric: a rejection says the draft was wrong, an edit
  // says it was nearly right, and only the second tells you where drafting
  // actually fails.
  test("is zero for an untouched approval", () => {
    assert.equal(editDistance(good.body, good.body), 0);
  });

  test("is small for a light edit", () => {
    const edited = good.body.replace(
      "Would a short call",
      "Would a quick call",
    );
    assert.ok(editDistance(good.body, edited) < 0.1);
  });

  test("is large for a rewrite", () => {
    assert.ok(editDistance(good.body, "Hi, are you free Thursday?") > 0.5);
  });

  test("handles empty input without dividing by zero", () => {
    assert.equal(editDistance("", ""), 0);
    assert.equal(editDistance("abc", ""), 1);
  });
});
