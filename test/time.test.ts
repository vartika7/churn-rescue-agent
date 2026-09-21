import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  RENEWAL_SOON_DAYS,
  getLatestRecordedDate,
  getRealToday,
  relativeDayLabel,
  renewalCountdown,
} from "../lib/time";

/**
 * The two reference points must not be conflated — one bug here styled every
 * overdue renewal as upcoming, and another scored usage windows against the
 * wall clock instead of the last recorded day. `now` is injected throughout so
 * these stay deterministic as the real date moves.
 */

const NOW = new Date("2026-09-21T00:00:00Z");

describe("renewal countdown", () => {
  // Regression: the amber window was `days <= 14`, which is true for every
  // negative number, so all ten churned accounts rendered as "due soon".
  test("a renewal in the past is overdue, not due soon", () => {
    const r = renewalCountdown("2026-08-01", NOW);
    assert.equal(r.status, "overdue");
    assert.ok(r.days < 0);
  });

  test("yesterday is overdue", () => {
    assert.equal(renewalCountdown("2026-09-20", NOW).status, "overdue");
  });

  test("today is due soon, not overdue", () => {
    const r = renewalCountdown("2026-09-21", NOW);
    assert.equal(r.days, 0);
    assert.equal(r.status, "soon");
    assert.equal(r.label, "today");
  });

  test(`the amber window ends at exactly ${RENEWAL_SOON_DAYS} days`, () => {
    assert.equal(
      renewalCountdown("2026-10-05", NOW).status,
      "soon",
      "14 days out should still be amber",
    );
    assert.equal(
      renewalCountdown("2026-10-06", NOW).status,
      "later",
      "15 days out should not be amber",
    );
  });

  test("the three statuses are mutually exclusive across a long span", () => {
    for (let offset = -40; offset <= 40; offset++) {
      const d = new Date(NOW);
      d.setUTCDate(d.getUTCDate() + offset);
      const { status, days } = renewalCountdown(
        d.toISOString().slice(0, 10),
        NOW,
      );
      const expected =
        days < 0 ? "overdue" : days <= RENEWAL_SOON_DAYS ? "soon" : "later";
      assert.equal(status, expected, `offset ${offset} (days ${days})`);
    }
  });
});

describe("relative day label", () => {
  test("reads forwards, backwards and today", () => {
    assert.deepEqual(relativeDayLabel("2026-09-28", NOW), {
      days: 7,
      label: "in 7d",
    });
    assert.deepEqual(relativeDayLabel("2026-09-14", NOW), {
      days: -7,
      label: "7d ago",
    });
    assert.deepEqual(relativeDayLabel("2026-09-21", NOW), {
      days: 0,
      label: "today",
    });
  });

  test("never prints a negative day count in the label", () => {
    assert.ok(!relativeDayLabel("2026-01-01", NOW).label.includes("-"));
  });
});

describe("latest recorded date", () => {
  // This is the other reference point: usage windows are measured against the
  // last day a customer has data for, not against today.
  test("returns the maximum date regardless of row order", () => {
    const rows = [
      { date: "2026-03-04" },
      { date: "2026-09-20" },
      { date: "2026-07-11" },
    ];
    assert.equal(getLatestRecordedDate(rows), "2026-09-20");
    assert.equal(getLatestRecordedDate([...rows].reverse()), "2026-09-20");
  });

  test("returns null for no rows rather than substituting today", () => {
    // A caller that got today's date here would measure a 30-day window
    // against days the customer has no records for at all.
    assert.equal(getLatestRecordedDate([]), null);
  });

  test("is unaffected by the real clock", () => {
    const rows = [{ date: "2025-01-01" }];
    assert.equal(getLatestRecordedDate(rows), "2025-01-01");
  });
});

describe("real today", () => {
  test("is normalised to midnight UTC", () => {
    const t = getRealToday();
    assert.equal(t.getUTCHours(), 0);
    assert.equal(t.getUTCMinutes(), 0);
    assert.equal(t.getUTCSeconds(), 0);
    assert.equal(t.getUTCMilliseconds(), 0);
  });
});
