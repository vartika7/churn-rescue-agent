import type { SupportTicket, Subscription } from "../lib/types";

/**
 * Fixture builders for the engine tests.
 *
 * Every fixture is synthetic and local — no database, no network, no seed
 * file. The engine's signal bands are step functions, so a test that leans on
 * real data only asserts whatever that data happens to sit on today; the
 * dataset has been reshaped twice already. These build the exact series needed
 * to land on each boundary.
 */

/** Anchor for generated series. Arbitrary — nothing here reads the clock. */
export const END = "2026-09-20";

/** `[count, sessionsPerDay]` spans, expanded oldest-first. */
export function spans(...pairs: [number, number][]): number[] {
  return pairs.flatMap(([n, v]) => Array<number>(n).fill(v));
}

/**
 * Turns a sessions series into dated usage rows ending on `end`.
 * Index 0 is the oldest day, matching the order the engine expects.
 */
export function usage(
  sessions: readonly number[],
  end: string = END,
): { date: string; sessions: number }[] {
  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (sessions.length - 1));

  return sessions.map((s, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return { date: d.toISOString().slice(0, 10), sessions: s };
  });
}

/**
 * A 30-day block of `silent` zero days followed by active days.
 *
 * Zeros lead so the block never *ends* silent, which would trip the separate
 * trailing-silence signal and contaminate a test aimed at the silent-day
 * count.
 */
export function block(silent: number, sessionsPerDay = 5, days = 30): number[] {
  return spans([silent, 0], [days - silent, sessionsPerDay]);
}

export function ticket(over: Partial<SupportTicket> = {}): SupportTicket {
  return {
    ticket_id: "T0001",
    customer_id: "C001",
    date: "2026-06-01",
    subject: "Something is broken",
    description: "A description.",
    category: "workflow",
    sentiment: "neutral",
    resolution_status: "resolved",
    ...over,
  };
}

export function charge(over: Partial<Subscription> = {}): Subscription {
  return {
    customer_id: "C001",
    date: "2026-06-01",
    plan: "Pro",
    mrr: 500,
    payment_status: "paid",
    change_type: "renewal",
    ...over,
  };
}

/** Three clean paid charges — enough to clear the thin-data confidence gate. */
export function paidCharges(n = 3): Subscription[] {
  return Array.from({ length: n }, (_, i) =>
    charge({ date: `2026-0${(i % 9) + 1}-01` }),
  );
}

/** Points for one signal key, or undefined when the signal did not fire. */
export function pointsFor(
  signals: readonly { key: string; points: number }[],
  key: string,
): number | undefined {
  return signals.find((s) => s.key === key)?.points;
}
