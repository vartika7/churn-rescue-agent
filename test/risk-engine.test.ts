import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { RISK_WEIGHTS } from "../lib/constants";
import { scoreCustomer } from "../lib/risk-engine";
import {
  END,
  block,
  charge,
  paidCharges,
  pointsFor,
  spans,
  ticket,
  usage,
} from "./helpers";

/** A flat run of days, so usage contributes nothing and other signals show. */
const flat = (days: number, sessions = 5) => usage(spans([days, sessions]));

/** Alternating 0/6 over 30 days: 15 silent, ends active, averages 3.0/day. */
const patchy = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0 : 6));

describe("score bands", () => {
  // The thresholds are >=, and the dataset work kept landing on these edges,
  // so the boundary values themselves are pinned rather than a value nearby.
  test("a score of exactly 50 is high", () => {
    // 30 days at 5/day, then 15 silent + 15 at 6/day: -40% recent (25) and
    // 15 silent days (25).
    const r = scoreCustomer({
      usage: usage([...spans([30, 5]), ...patchy]),
      tickets: [],
      subscriptions: [],
    });
    assert.equal(r.score, 50);
    assert.equal(r.riskLevel, "high");
  });

  test("a score of exactly 25 is medium", () => {
    // The same patchy shape in both windows: no trend at all, 15 silent days.
    const r = scoreCustomer({
      usage: usage([...patchy, ...patchy]),
      tickets: [],
      subscriptions: [],
    });
    assert.equal(r.score, 25);
    assert.equal(r.riskLevel, "medium");
  });

  test("a score of exactly 24 is low", () => {
    // Two escalated tickets hit the cap of 24 and nothing else fires.
    const r = scoreCustomer({
      usage: flat(60),
      tickets: [
        ticket({ ticket_id: "T1", resolution_status: "escalated" }),
        ticket({ ticket_id: "T2", resolution_status: "escalated" }),
      ],
      subscriptions: [],
    });
    assert.equal(r.score, 24);
    assert.equal(r.riskLevel, "low");
  });

  test("the score is capped at 100 rather than summing past it", () => {
    const r = scoreCustomer({
      usage: usage(spans([45, 20], [38, 3], [7, 0])),
      tickets: [
        ticket({ ticket_id: "T1", resolution_status: "escalated" }),
        ticket({ ticket_id: "T2", resolution_status: "escalated" }),
        ticket({ ticket_id: "T3", resolution_status: "escalated" }),
        ticket({ ticket_id: "T4", resolution_status: "unresolved" }),
        ticket({ ticket_id: "T5", resolution_status: "unresolved" }),
        ticket({ ticket_id: "T6", resolution_status: "unresolved" }),
      ],
      subscriptions: [charge({ payment_status: "past_due" })],
    });
    const raw = r.signals.reduce((n, s) => n + s.points, 0);
    assert.ok(raw > 100, `expected the raw sum to exceed 100, got ${raw}`);
    assert.equal(r.score, 100);
  });
});

describe("recent trend signal", () => {
  const withRecent = (recent: number[]) =>
    scoreCustomer({
      usage: usage([...spans([30, 10]), ...recent]),
      tickets: [],
      subscriptions: [],
    });
  const key = "usage.recent_trend_30d";

  test("-40% or worse is severe", () => {
    assert.equal(
      pointsFor(withRecent(spans([30, 6])).signals, key),
      RISK_WEIGHTS.recentTrend.severe,
    );
  });

  test("-25% is major", () => {
    assert.equal(
      pointsFor(withRecent(spans([15, 7], [15, 8])).signals, key),
      RISK_WEIGHTS.recentTrend.major,
    );
  });

  test("-10% is minor", () => {
    assert.equal(
      pointsFor(withRecent(spans([30, 9])).signals, key),
      RISK_WEIGHTS.recentTrend.minor,
    );
  });

  test("-9% scores nothing but still reports", () => {
    const r = withRecent(spans([27, 9], [3, 10]));
    assert.equal(pointsFor(r.signals, key), 0);
    // Reported as contradicting rather than omitted: "checked, found nothing"
    // is what Phase 5 needs to argue against risk.
    const signal = r.signals.find((s) => s.key === key);
    assert.equal(signal?.direction, "contradicting");
  });

  test("a rise scores nothing", () => {
    assert.equal(pointsFor(withRecent(spans([30, 15])).signals, key), 0);
  });
});

describe("whole-history trend signal", () => {
  const key = "usage.history_trend";
  const declining = (days: number) => {
    const third = Math.floor(days / 3);
    return usage(spans([days - 2 * third, 10], [third, 7], [third, 4]));
  };

  // Regression: a 12-day third on a 38-day history is noise, and the engine
  // reported it as "sustained decline of 10%". The signal is now gated on
  // having enough history to make the claim.
  test(`is skipped below ${RISK_WEIGHTS.historyTrend.minDays} days`, () => {
    const r = scoreCustomer({
      usage: declining(RISK_WEIGHTS.historyTrend.minDays - 1),
      tickets: [],
      subscriptions: [],
    });
    assert.equal(pointsFor(r.signals, key), undefined);
  });

  test(`fires at exactly ${RISK_WEIGHTS.historyTrend.minDays} days`, () => {
    const r = scoreCustomer({
      usage: declining(RISK_WEIGHTS.historyTrend.minDays),
      tickets: [],
      subscriptions: [],
    });
    assert.equal(pointsFor(r.signals, key), RISK_WEIGHTS.historyTrend.major);
  });

  test("a short history is skipped, not scored zero", () => {
    // Zero would read as "no sustained decline", which is just as unfounded a
    // claim as the decline when there is nothing to judge it on.
    const r = scoreCustomer({
      usage: declining(40),
      tickets: [],
      subscriptions: [],
    });
    assert.ok(!r.signals.some((s) => s.key === key));
  });
});

describe("silent days signal", () => {
  const key = "usage.silent_days_30d";
  // The same block twice, so the trend signal stays flat and silence is the
  // only thing varying.
  const withSilent = (n: number) =>
    scoreCustomer({
      usage: usage([...block(n), ...block(n)]),
      tickets: [],
      subscriptions: [],
    });

  test("15 silent days is severe", () => {
    assert.equal(
      pointsFor(withSilent(15).signals, key),
      RISK_WEIGHTS.silence.severe,
    );
  });

  test("10 silent days is major", () => {
    assert.equal(
      pointsFor(withSilent(10).signals, key),
      RISK_WEIGHTS.silence.major,
    );
  });

  test("6 silent days is minor", () => {
    assert.equal(
      pointsFor(withSilent(6).signals, key),
      RISK_WEIGHTS.silence.minor,
    );
  });

  test("5 silent days scores nothing", () => {
    assert.equal(pointsFor(withSilent(5).signals, key), 0);
  });
});

describe("trailing silence signal", () => {
  const key = "usage.trailing_silence";
  const trailing = (n: number) =>
    scoreCustomer({
      usage: usage(spans([30 - n, 5], [n, 0])),
      tickets: [],
      subscriptions: [],
    });

  test(`fires at ${RISK_WEIGHTS.trailingSilence.minDays} consecutive days`, () => {
    assert.equal(
      pointsFor(trailing(RISK_WEIGHTS.trailingSilence.minDays).signals, key),
      RISK_WEIGHTS.trailingSilence.points,
    );
  });

  test("does not fire one day short", () => {
    assert.equal(
      pointsFor(
        trailing(RISK_WEIGHTS.trailingSilence.minDays - 1).signals,
        key,
      ),
      undefined,
    );
  });

  test("only counts silence at the very end of the record", () => {
    // Ten silent days in the middle, active on the final day.
    const r = scoreCustomer({
      usage: usage(spans([10, 5], [10, 0], [10, 5])),
      tickets: [],
      subscriptions: [],
    });
    assert.equal(pointsFor(r.signals, key), undefined);
  });
});

describe("support signals", () => {
  const withTickets = (statuses: string[]) =>
    scoreCustomer({
      usage: flat(60),
      tickets: statuses.map((s, i) =>
        ticket({ ticket_id: `T${i}`, resolution_status: s }),
      ),
      subscriptions: [],
    });
  const escalatedKey = "support.escalated_open";
  const unresolvedKey = "support.unresolved_open";

  test("escalated tickets score per ticket up to a cap", () => {
    const one = withTickets(["escalated"]);
    const two = withTickets(["escalated", "escalated"]);
    const three = withTickets(["escalated", "escalated", "escalated"]);
    assert.equal(
      pointsFor(one.signals, escalatedKey),
      RISK_WEIGHTS.support.escalatedEach,
    );
    assert.equal(
      pointsFor(two.signals, escalatedKey),
      RISK_WEIGHTS.support.escalatedCap,
    );
    assert.equal(
      pointsFor(three.signals, escalatedKey),
      RISK_WEIGHTS.support.escalatedCap,
    );
  });

  test("unresolved tickets score separately, also capped", () => {
    assert.equal(
      pointsFor(withTickets(["unresolved"]).signals, unresolvedKey),
      RISK_WEIGHTS.support.unresolvedEach,
    );
    assert.equal(
      pointsFor(
        withTickets(["unresolved", "unresolved", "unresolved"]).signals,
        unresolvedKey,
      ),
      RISK_WEIGHTS.support.unresolvedCap,
    );
  });

  test("escalated and unresolved are counted as distinct signals", () => {
    const r = withTickets(["escalated", "unresolved"]);
    assert.equal(
      pointsFor(r.signals, escalatedKey),
      RISK_WEIGHTS.support.escalatedEach,
    );
    assert.equal(
      pointsFor(r.signals, unresolvedKey),
      RISK_WEIGHTS.support.unresolvedEach,
    );
  });

  test("resolved tickets score nothing and argue against risk", () => {
    const r = withTickets(["resolved", "resolved"]);
    const signal = r.signals.find((s) => s.key === "support.all_resolved");
    assert.equal(signal?.points, 0);
    assert.equal(signal?.direction, "contradicting");
  });

  test("status matching tolerates case and spacing", () => {
    assert.equal(
      pointsFor(withTickets(["  ESCALATED "]).signals, escalatedKey),
      RISK_WEIGHTS.support.escalatedEach,
    );
    assert.equal(
      pointsFor(withTickets(["in progress"]).signals, unresolvedKey),
      RISK_WEIGHTS.support.unresolvedEach,
    );
  });

  test("no tickets is recorded as an absence of signal, not as safety", () => {
    const r = scoreCustomer({
      usage: flat(60),
      tickets: [],
      subscriptions: [],
    });
    const signal = r.signals.find((s) => s.key === "support.no_tickets");
    assert.equal(signal?.points, 0);
    assert.equal(signal?.direction, "contradicting");
  });
});

describe("billing signal", () => {
  const key = "billing.failed_charges";
  const withCharges = (subscriptions: ReturnType<typeof charge>[]) =>
    scoreCustomer({ usage: flat(60), tickets: [], subscriptions });

  test("a past-due charge scores", () => {
    assert.equal(
      pointsFor(
        withCharges([charge({ payment_status: "past_due" })]).signals,
        key,
      ),
      RISK_WEIGHTS.billing.failedCharge,
    );
  });

  // C038's real shape: past_due with change_type 'renewal'. Checking
  // change_type alone would miss it, which is why the rule reads both.
  test("payment_status is read even when change_type looks normal", () => {
    assert.equal(
      pointsFor(
        withCharges([
          charge({ payment_status: "past_due", change_type: "renewal" }),
        ]).signals,
        key,
      ),
      RISK_WEIGHTS.billing.failedCharge,
    );
  });

  // C014's shape: the flag is in change_type.
  test("change_type is read even when payment_status looks normal", () => {
    assert.equal(
      pointsFor(
        withCharges([
          charge({ payment_status: "paid", change_type: "payment_failed" }),
        ]).signals,
        key,
      ),
      RISK_WEIGHTS.billing.failedCharge,
    );
  });

  test("several bad charges score once, not per charge", () => {
    const r = withCharges([
      charge({ date: "2026-05-01", payment_status: "past_due" }),
      charge({ date: "2026-06-01", payment_status: "past_due" }),
    ]);
    assert.equal(pointsFor(r.signals, key), RISK_WEIGHTS.billing.failedCharge);
  });

  test("a clean history scores nothing and argues against risk", () => {
    const r = withCharges(paidCharges(3));
    const signal = r.signals.find((s) => s.key === "billing.clean");
    assert.equal(signal?.points, 0);
    assert.equal(signal?.direction, "contradicting");
  });
});

describe("confidence", () => {
  test("a thin history is low confidence regardless of score", () => {
    const r = scoreCustomer({
      usage: flat(59),
      tickets: [ticket()],
      subscriptions: paidCharges(3),
    });
    assert.equal(r.confidence, "low");
  });

  test("no tickets and barely any billing is low confidence", () => {
    const r = scoreCustomer({
      usage: flat(120),
      tickets: [],
      subscriptions: paidCharges(2),
    });
    assert.equal(r.confidence, "low");
  });

  test("a long clean history is high confidence and low risk", () => {
    // The pair that matters: "we can see plenty, and it looks fine" has to be
    // distinguishable from "we cannot see much".
    const r = scoreCustomer({
      usage: flat(120),
      tickets: [ticket({ resolution_status: "resolved" })],
      subscriptions: paidCharges(3),
    });
    assert.equal(r.confidence, "high");
    assert.equal(r.riskLevel, "low");
  });

  test("evidence pointing both ways drops confidence to medium", () => {
    // One minor decline against four clean checks.
    const r = scoreCustomer({
      usage: usage(spans([30, 9], [30, 10], [30, 9])),
      tickets: [],
      subscriptions: paidCharges(3),
    });
    const supporting = r.signals.filter((s) => s.points > 0).length;
    const contradicting = r.signals.filter(
      (s) => s.direction === "contradicting" && s.points === 0,
    ).length;
    assert.ok(supporting > 0 && contradicting > supporting);
    assert.equal(r.confidence, "medium");
  });
});

describe("asOf replay", () => {
  test("ignores everything dated after the cutoff", () => {
    const cutoff = "2026-08-20";
    const r = scoreCustomer({
      usage: flat(60),
      tickets: [ticket({ date: "2026-09-10", resolution_status: "escalated" })],
      subscriptions: [
        charge({ date: "2026-09-15", payment_status: "past_due" }),
      ],
      asOf: cutoff,
    });
    assert.equal(r.window.to, cutoff);
    assert.ok(r.window.observedDays < 60);
    // Both post-cutoff rows would have scored 12 and 20 respectively.
    assert.equal(pointsFor(r.signals, "support.escalated_open"), undefined);
    assert.equal(pointsFor(r.signals, "billing.failed_charges"), undefined);
  });

  test("without a cutoff the full record is used", () => {
    const r = scoreCustomer({
      usage: flat(60),
      tickets: [],
      subscriptions: [],
    });
    assert.equal(r.window.observedDays, 60);
    assert.equal(r.window.to, END);
  });
});

describe("leakage", () => {
  test("an injected outcome changes nothing", () => {
    // The signature gives an outcome nowhere to go; this proves an extra field
    // cannot sneak in and influence the result either.
    const input = {
      usage: usage([...spans([30, 5]), ...patchy]),
      tickets: [],
      subscriptions: [],
    };
    const clean = scoreCustomer(input);
    const poisoned = scoreCustomer({
      ...input,
      outcome: "churned",
      expected_risk_level: "high",
    } as never);
    assert.deepEqual(poisoned, clean);
  });

  test("no signal is derived from outcome data", () => {
    const r = scoreCustomer({
      usage: flat(120),
      tickets: [ticket()],
      subscriptions: paidCharges(3),
    });
    for (const s of r.signals) {
      assert.ok(
        !/outcome|churn|expected_/i.test(s.key),
        `signal ${s.key} looks derived from outcome data`,
      );
      assert.ok(["Usage", "Support", "Billing"].includes(s.source));
    }
  });
});

describe("reason text", () => {
  test("stays on one line", () => {
    // It renders in a single-line table cell; a newline would wrap the row.
    const r = scoreCustomer({
      usage: usage([...spans([30, 5]), ...patchy]),
      tickets: [],
      subscriptions: [],
    });
    assert.ok(!r.reason.includes("\n"));
    assert.match(r.reason, /^Scored high: /);
  });

  test("uses the terse phrasing, not the standalone headline", () => {
    // Headlines each name their own window, so stringing them together repeats
    // "in the last 30 days on record" two or three times in one sentence.
    const r = scoreCustomer({
      usage: usage([...spans([30, 5]), ...patchy]),
      tickets: [],
      subscriptions: [],
    });
    assert.ok(r.reason.includes("sessions down"));
    assert.ok(!r.reason.includes("in the last 30 days on record"));
  });

  test("summarises the top three and counts the rest", () => {
    const r = scoreCustomer({
      usage: usage(spans([45, 20], [38, 3], [7, 0])),
      tickets: [ticket({ resolution_status: "escalated" })],
      subscriptions: [charge({ payment_status: "past_due" })],
    });
    const firing = r.signals.filter((s) => s.points > 0).length;
    assert.ok(firing > 3);
    assert.match(r.reason, new RegExp(`plus ${firing - 3} more\\.$`));
  });

  test("says so plainly when nothing fired", () => {
    const r = scoreCustomer({
      usage: flat(120),
      tickets: [ticket()],
      subscriptions: paidCharges(3),
    });
    assert.equal(
      r.reason,
      "No risk signals fired across usage, support or billing.",
    );
  });
});

describe("empty and degenerate input", () => {
  test("no usage at all does not throw", () => {
    const r = scoreCustomer({ usage: [], tickets: [], subscriptions: [] });
    assert.equal(r.score, 0);
    assert.equal(r.riskLevel, "low");
    assert.equal(r.confidence, "low");
    assert.equal(r.window.observedDays, 0);
    assert.equal(r.window.from, null);
    assert.equal(r.window.to, null);
  });

  test("a single day of usage does not throw", () => {
    const r = scoreCustomer({
      usage: flat(1),
      tickets: [],
      subscriptions: [],
    });
    assert.equal(r.window.observedDays, 1);
  });

  test("usage arriving out of order is sorted before scoring", () => {
    const ordered = usage([...spans([30, 5]), ...patchy]);
    const shuffled = [...ordered].reverse();
    assert.deepEqual(
      scoreCustomer({ usage: shuffled, tickets: [], subscriptions: [] }),
      scoreCustomer({ usage: ordered, tickets: [], subscriptions: [] }),
    );
  });

  test("an all-zero record is not reported as a percentage drop", () => {
    // A zero baseline makes percent change undefined, not infinite.
    const r = scoreCustomer({
      usage: usage(spans([60, 0])),
      tickets: [],
      subscriptions: [],
    });
    assert.equal(pointsFor(r.signals, "usage.recent_trend_30d"), 0);
  });
});

describe("determinism", () => {
  test("the same input always gives the same result", () => {
    // Phase 7 grades this engine, which requires reproducibility.
    const input = {
      usage: usage([...spans([30, 5]), ...patchy]),
      tickets: [ticket({ resolution_status: "escalated" })],
      subscriptions: [charge({ payment_status: "past_due" })],
    };
    const runs = Array.from({ length: 5 }, () => scoreCustomer(input));
    for (const r of runs) assert.deepEqual(r, runs[0]);
  });
});
