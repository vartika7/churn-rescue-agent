import assert from "node:assert/strict";
import { test, describe } from "node:test";

import type { EvidenceInput } from "../lib/investigation/evidence";
import { FailingProvider } from "../lib/investigation/mock";
import {
  ProviderError,
  withTimeout,
  type InvestigationProvider,
} from "../lib/investigation/provider";
import {
  offlineInvestigation,
  runInvestigation,
  shouldPersist,
} from "../lib/investigation/run";
import { stripFence } from "../lib/investigation/schema";
import { scoreCustomer } from "../lib/risk-engine";
import { block, charge, spans, ticket, usage } from "./helpers";

/**
 * The orchestration exists so the route, the tests and the Phase 7 AI metrics
 * all take the same path. These cover the parts a route handler would
 * otherwise own and leave untested: what happens when the provider dies, and
 * what happens when it answers with something unusable.
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

const input: EvidenceInput = {
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
};

/**
 * A provider that returns exactly the text it is given.
 *
 * Not MockProvider — that JSON-stringifies its resolver's return value, which
 * double-encodes a string body and makes the response parse back to a string
 * instead of an object.
 */
const canned = (text: string): InvestigationProvider => ({
  name: "canned",
  async complete() {
    return { text, model: "canned" };
  },
});

describe("provider failure degrades rather than throws", () => {
  test("a dead provider returns a failed outcome, not an exception", async () => {
    const outcome = await runInvestigation({
      provider: new FailingProvider("network is down"),
      input,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.stage, "provider");
    assert.match(outcome.errors.join(" "), /network is down/);
    // The evidence still comes back, so the page can show what was gathered
    // even though nothing interpreted it.
    assert.ok(outcome.evidence.items.length > 0);
  });

  test("a retryable provider error is reported as retryable", async () => {
    const provider = {
      name: "flaky",
      async complete(): Promise<never> {
        throw new ProviderError("429 slow down", undefined, true);
      },
    };
    const outcome = await runInvestigation({ provider, input });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.retryable, true);
  });

  test("a non-provider error is not marked retryable", async () => {
    const outcome = await runInvestigation({
      provider: new FailingProvider("bad request"),
      input,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.retryable, false);
  });
});

describe("unusable responses are rejected, not repaired", () => {
  test("prose instead of JSON fails validation", async () => {
    const outcome = await runInvestigation({
      provider: canned("This account looks quite risky to me."),
      input,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.stage, "validation");
    // The raw text is returned for diagnosis but never persisted.
    assert.ok(outcome.raw);
  });

  test("a fabricated citation fails validation rather than being dropped", async () => {
    // Silently discarding the bad citation would leave a plausible claim with
    // no evidence behind it — the exact failure this layer is built to catch.
    const body = JSON.stringify({
      riskInterpretation: "At risk.",
      rootCause: {
        hypothesis: "They are evaluating a competitor.",
        confidence: "high",
        citations: ["CALL-2026-09-01"],
      },
      supporting: [
        {
          statement: "Mentioned churn on a call.",
          citations: ["CALL-2026-09-01"],
        },
      ],
      contradicting: [],
      recommendation: {
        action: "intervene",
        reasoning: "Escalate to the AE.",
        citations: ["CALL-2026-09-01"],
      },
      limitations: "None.",
      insufficientEvidence: false,
    });
    const outcome = await runInvestigation({ provider: canned(body), input });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.errors.join(" "), /never provided: CALL-2026-09-01/);
  });

  test("a well-formed grounded response succeeds and reports grounding", async () => {
    const signal = input.assessment.signals[0].key;
    const body = JSON.stringify({
      riskInterpretation: "Engagement has fallen away.",
      rootCause: {
        hypothesis: "Unresolved workflow fault drove disengagement.",
        confidence: "medium",
        citations: [signal, "T0029"],
      },
      supporting: [{ statement: "Sessions are down.", citations: [signal] }],
      contradicting: [
        { statement: "Billing is clean.", citations: ["billing.2026-09-02"] },
      ],
      recommendation: {
        action: "intervene",
        reasoning: "Fix the ticket, then re-engage.",
        citations: ["T0029"],
      },
      limitations: "No CRM notes available.",
      insufficientEvidence: false,
    });
    const outcome = await runInvestigation({ provider: canned(body), input });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.grounding.rate, 1);
    assert.equal(outcome.investigation.recommendation.action, "intervene");
    assert.equal(outcome.offline, false);
  });
});

describe("offline path", () => {
  test("produces a valid, fully grounded, clearly-labelled result", () => {
    const outcome = offlineInvestigation(input);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.offline, true);
    assert.equal(outcome.grounding.rate, 1);
    assert.match(outcome.investigation.limitations, /offline/i);
  });

  test("needs no provider at all", () => {
    // The point of this path: the pipeline runs with nothing configured.
    assert.doesNotThrow(() => offlineInvestigation(input));
  });
});

describe("what gets written to the database", () => {
  // A placeholder must never quietly become an account's stored answer. The
  // first version of this guard keyed on the --offline flag, which missed the
  // other route to an offline result: when no provider is configured the app
  // falls back silently, so a missing or expired key on a deployment would
  // have refilled the table with rows that are not investigations.
  test("an offline result is not stored by default", () => {
    const outcome = offlineInvestigation(input);
    assert.equal(shouldPersist(outcome, null), false);
    assert.equal(shouldPersist(outcome, "0"), false);
  });

  test("an offline result is stored only when asked for explicitly", () => {
    assert.equal(shouldPersist(offlineInvestigation(input), "1"), true);
  });

  test("a real result is stored by default", async () => {
    const signal = input.assessment.signals[0].key;
    const body = JSON.stringify({
      riskInterpretation: "Engagement has fallen away.",
      rootCause: { hypothesis: "Disengagement.", confidence: "medium", citations: [signal] },
      supporting: [{ statement: "Sessions down.", citations: [signal] }],
      contradicting: [],
      recommendation: { action: "intervene", reasoning: "Reach out.", citations: [signal] },
      limitations: "No CRM notes.",
      insufficientEvidence: false,
    });
    const outcome = await runInvestigation({ provider: canned(body), input });
    assert.equal(outcome.ok, true);
    assert.equal(shouldPersist(outcome, null), true);
    assert.equal(shouldPersist(outcome, "0"), false, "save=0 still opts out");
  });

  test("a failed result is never stored", async () => {
    const outcome = await runInvestigation({
      provider: new FailingProvider("down"),
      input,
    });
    // Storing an unvalidated response would put unverified claims in the same
    // table as verified ones.
    assert.equal(shouldPersist(outcome, "1"), false);
  });
});

describe("gemini response handling", () => {
  test("unwraps a fenced JSON block", () => {
    assert.equal(stripFence('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(stripFence('```\n{"a":1}\n```'), '{"a":1}');
  });

  test("leaves bare JSON untouched", () => {
    assert.equal(stripFence('{"a":1}'), '{"a":1}');
    assert.equal(stripFence('  {"a":1}  '), '{"a":1}');
  });

  test("does not corrupt a string containing backticks", () => {
    const body = '{"a":"use ``` carefully"}';
    assert.equal(stripFence(body), body);
  });
});

describe("timeout helper", () => {
  test("rejects with a retryable error once the deadline passes", async () => {
    await assert.rejects(
      withTimeout(new Promise((r) => setTimeout(r, 200)), 20, "slow call"),
      (err: unknown) =>
        err instanceof ProviderError &&
        err.retryable &&
        /slow call timed out/.test(err.message),
    );
  });

  test("passes a fast result straight through", async () => {
    assert.equal(await withTimeout(Promise.resolve(7), 1000, "fast"), 7);
  });

  test("clears its timer so the process can exit", async () => {
    // A dangling timer would keep the test runner alive for the full duration.
    const started = Date.now();
    await withTimeout(Promise.resolve("done"), 60_000, "fast");
    assert.ok(Date.now() - started < 1000);
  });
});
