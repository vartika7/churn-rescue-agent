/**
 * Runs Phase 5 investigations across the active book.
 *
 * Only accounts the deterministic engine flagged — medium or high. This is a
 * product decision before it is a quota one: the engine already answers a
 * low-risk account with "no signals fired", and spending a model call to
 * explain why a healthy customer is healthy produces a paragraph nobody opens.
 * The worklist is the flagged accounts, so the investigations are too.
 *
 * It also happens to be the only workable approach on the free tier, which is
 * 20 requests per DAY per model — not per minute. Investigating all 40 active
 * accounts exhausts the day's quota twice over and fills the table with
 * explanations of non-problems.
 *
 * Requires the app running (it posts to /api/investigate), because the Gemini
 * client is server-only and cannot be imported here.
 *
 *   npm start                       # in one shell
 *   npm run investigate             # flagged accounts missing a live result
 *   npm run investigate -- --force      # redo ones already done
 *   npm run investigate -- --offline    # no quota spent, and nothing stored
 *   npm run investigate -- --all        # every active account; will hit the cap
 *   npm run investigate -- --limit 5    # stop after five
 *   npm run investigate -- --dry        # list what it would do
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RISK_LEVEL_THRESHOLDS } from "../lib/constants";
import { scoreCustomer } from "../lib/risk-engine";
import type { SupportTicket, Subscription, UsageDaily } from "../lib/types";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT ?? "3000";
const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const value = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const OFFLINE = has("--offline");
const ALL = has("--all");
const DRY = has("--dry");
/** Re-investigate accounts that already have a live result. Off by default. */
const FORCE = has("--force");

const LIMIT = Number(value("--limit") ?? Number.POSITIVE_INFINITY);
/** Free tier is 20/day/model; pacing only helps with the per-minute window. */
const DELAY_MS = 1500;

const env: Record<string, string> = {};
for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}

const SB = `${env.SUPABASE_URL}/rest/v1`;
const H = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
};

async function selectAll<T>(table: string, select: string): Promise<T[]> {
  let out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(
      `${SB}/${table}?select=${select}&order=customer_id&limit=1000&offset=${from}`,
      { headers: H },
    );
    const page = (await res.json()) as T[];
    out = out.concat(page);
    if (page.length < 1000) break;
  }
  return out;
}

function group<T extends { customer_id: string }>(rows: T[]) {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const l = m.get(r.customer_id);
    if (l) l.push(r);
    else m.set(r.customer_id, [r]);
  }
  return m;
}

(async () => {
  const [outcomes, usage, tickets, subs] = await Promise.all([
    selectAll<{ customer_id: string; outcome: string }>(
      "customer_outcomes",
      "customer_id,outcome",
    ),
    selectAll<UsageDaily>("usage_daily", "customer_id,date,sessions"),
    selectAll<SupportTicket>("support_tickets", "*"),
    selectAll<Subscription>("subscriptions", "*"),
  ]);

  const usageBy = group(usage);
  const ticketsBy = group(tickets);
  const subsBy = group(subs);

  // Churned accounts are never investigated: a recommendation is an
  // instruction about what to do next, and there is nothing to do next for an
  // account that already left. Their evaluation belongs to Phase 7.
  const active = outcomes
    .filter((o) => (o.outcome ?? "").toLowerCase() === "retained")
    .map((o) => o.customer_id);

  const scored = active.map((id) => {
    const assessment = scoreCustomer({
      usage: (usageBy.get(id) ?? [])
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date)),
      tickets: ticketsBy.get(id) ?? [],
      subscriptions: subsBy.get(id) ?? [],
    });
    return { id, score: assessment.score, level: assessment.riskLevel };
  });

  // Accounts whose most recent investigation already came from a real model.
  // Skipped by default: at 20 requests per day, re-investigating an account
  // that already has a good result is the most expensive thing this script can
  // do, and a partly-failed batch is the normal case rather than the exception.
  const existing = await selectAll<{
    customer_id: string;
    provider: string;
    created_at: string;
  }>("investigations", "customer_id,provider,created_at");

  const latestProvider = new Map<string, string>();
  for (const row of [...existing].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  )) {
    if (!latestProvider.has(row.customer_id)) {
      latestProvider.set(row.customer_id, row.provider);
    }
  }
  const alreadyLive = (id: string) => {
    const p = latestProvider.get(id);
    return Boolean(p && p !== "mock");
  };

  const flagged = scored.filter((s) => s.score >= RISK_LEVEL_THRESHOLDS.medium);
  const eligible = ALL ? scored : flagged;
  const skipped =
    OFFLINE || FORCE ? [] : eligible.filter((s) => alreadyLive(s.id));
  const selected = eligible
    .filter((s) => OFFLINE || FORCE || !alreadyLive(s.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT);

  console.log(
    `${active.length} active accounts, ${flagged.length} flagged ` +
      `(score >= ${RISK_LEVEL_THRESHOLDS.medium})`,
  );
  console.log(
    `investigating ${selected.length}${OFFLINE ? " via the offline provider" : ""}` +
      (ALL ? " — every active account, including low risk" : ""),
  );
  if (skipped.length) {
    console.log(
      `skipping ${skipped.length} that already have a live investigation ` +
        `(${skipped.map((s) => s.id).join(", ")}); --force to redo them`,
    );
  }
  if (!OFFLINE && selected.length > 20) {
    console.log(
      `WARNING: the Gemini free tier allows 20 requests per day per model. ` +
        `${selected.length} requests will exhaust it and the rest will 429.`,
    );
  }
  console.log();

  if (DRY) {
    for (const s of selected)
      console.log(`  ${s.id}  ${s.score}/100 ${s.level}`);
    console.log("\n(dry run — nothing requested)");
    return;
  }

  let ok = 0;
  const failures: string[] = [];
  const grounding: number[] = [];
  const actions: Record<string, number> = {};

  for (const [i, s] of selected.entries()) {
    const url =
      `http://localhost:${PORT}/api/investigate?customer=${s.id}` +
      (OFFLINE ? "&offline=1" : "");
    let body: Record<string, unknown>;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.ASSESS_TOKEN}` },
      });
      body = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      body = {
        ok: false,
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }

    const label = `[${String(i + 1).padStart(2)}/${selected.length}] ${s.id} (${s.score})`;
    if (body.ok) {
      ok++;
      const g = (body.grounding as { rate: number }).rate;
      grounding.push(g);
      const inv = body.investigation as {
        recommendation: { action: string };
        insufficientEvidence: boolean;
      };
      actions[inv.recommendation.action] =
        (actions[inv.recommendation.action] ?? 0) + 1;
      console.log(
        `  ${label} ok  ${inv.recommendation.action}` +
          (inv.insufficientEvidence ? "  insufficient-evidence" : "") +
          (g < 1 ? `  GROUNDING ${g.toFixed(2)}` : ""),
      );
    } else {
      const errs = Array.isArray(body.errors)
        ? body.errors.join("; ")
        : String(body.error ?? "");
      failures.push(`${s.id}: ${errs.slice(0, 120)}`);
      console.log(`  ${label} FAILED  ${errs.slice(0, 100)}`);
      // A daily quota will not recover inside this run; stop rather than
      // printing thirty more identical failures.
      if (/RESOURCE_EXHAUSTED|per day|429/i.test(errs)) {
        console.log("\n  daily quota reached — stopping.");
        break;
      }
    }
    if (i < selected.length - 1)
      await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\nsucceeded ${ok}/${selected.length}`);
  if (grounding.length) {
    const perfect = grounding.filter((g) => g === 1).length;
    console.log(
      `grounding: ${perfect}/${grounding.length} fully grounded, ` +
        `mean ${(grounding.reduce((a, b) => a + b, 0) / grounding.length).toFixed(3)}`,
    );
  }
  console.log(`recommendations: ${JSON.stringify(actions)}`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  ${f}`);
  }
})();
