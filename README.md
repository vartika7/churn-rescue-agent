# Churn Rescue Agent — Phase 3 (live dashboard)

Internal customer-success console. Next.js App Router reading live from
Supabase, replacing the static HTML prototype's embedded JSON.

## Setup

```bash
npm install
cp env.example .env.local   # then fill in the two values
npm run dev
```

`.env.local` needs:

| Variable                    | Where to find it                                        |
| --------------------------- | ------------------------------------------------------- |
| `SUPABASE_URL`              | Supabase → Project Settings → Data API → Project URL    |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → `service_role` |

Neither is prefixed `NEXT_PUBLIC_`, deliberately. The service role key bypasses
row-level security, so `lib/supabase.ts` imports `server-only` — an accidental
client-side import becomes a build error rather than a leaked key.

If either is missing the pages render a setup message instead of crashing.

## Scripts

| Command             | Purpose          |
| ------------------- | ---------------- |
| `npm run dev`       | Local dev server |
| `npm run build`     | Production build |
| `npm run typecheck` | `tsc --noEmit`   |

## Structure

```
app/
  page.tsx                 Dashboard (Server Component); ?view=lost for churned
  customer/[id]/page.tsx   Customer detail (Server Component)
  globals.css              Design tokens from the validated prototype
components/
  CustomerTable.tsx        'use client' — sort / filter / search
  UsageChart.tsx           'use client' — inline SVG + hover tooltip
  Sparkline.tsx            Sessions over the final 90 days on record
  EvidencePanel.tsx        Supporting vs contradicting evidence
  PrototypeNote.tsx        Placeholder-data labelling
  SetupError.tsx           Readable credentials / connection failure
lib/
  supabase.ts              Server-only client + paginated `selectAll`
  queries.ts               All table reads
  analysis.ts              Trend maths + evidence heuristics
  placeholder-risk.ts      `evaluation_cases` → active + retrospective badges
  time.ts                  getRealToday vs getLatestRecordedDate + countdowns
  format.ts                Presentation only: dates, currency, percents
  constants.ts             Evidence thresholds + sparkline width
supabase/
  schema.sql               Table DDL for all 9 tables (verified against live)
```

## Things that will bite you if you forget them

**Both pages are `force-dynamic`.** Without it, Next caches the Supabase read at
build time and a row edited in the Supabase table editor would not appear until
the next deploy. Verify after deploying by editing a row in Supabase and
refreshing the Vercel URL — not redeploying. `next build` should list both
routes as `ƒ (Dynamic)`. Do not enable Cache Components in `next.config.mjs`:
it retires `export const dynamic`.

**Churned accounts are not a worklist — this is the load-bearing rule.** The
default view shows retained accounts only, filtered on
`customer_outcomes.outcome` (`customers` carries no outcome column, so the join
is required). Churned accounts live behind the "Lost accounts" tab with
past-tense gradings from `retrospectiveBadge` — "Missed — should have
intervened", "No signal available" — and never a present-tense
Intervene/Monitor/No action badge. `expected_recommendation` grades whether
intervening _would have been_ right before an account left; it is not an
instruction to act today, and an account that left in May cannot be rescued.
Summary cards are scoped to the active book so "MRR at risk" never counts
revenue that is already gone. The same rule is structural for Phase 4/5:
generate `risk_assessments` for active customers only; churned data belongs to
the Phase 7 evaluation harness.

**Reads are paginated.** PostgREST caps a response at 1000 rows. `usage_daily`
holds 8,323, so a plain `.select()` silently returns the first 1000 and drops
most customers off the dashboard. Use `selectAll` from `lib/supabase.ts`, and
give it an ordering that is a _total_ order or rows can repeat across page
boundaries.

**There are two date reference points, and they must not be merged.** This was
a real bug: one shared "today" constant fed both, and they answer different
questions. `lib/time.ts` names them separately and documents what each must
never be used for.

- `getRealToday()` — real wall-clock UTC. Renewal countdowns and overdue
  checks only. Open the dashboard in November and "in 12d" means twelve days
  from that November day. `renewalCountdown(iso, now?)` takes an optional
  `now` purely so tests can inject a fixed clock.
- `getLatestRecordedDate(rows)` — the newest date present in a customer's
  `usage_daily` rows. Every usage window only.

Using the wrong one fails silently rather than loudly, which is why they are
separate functions with loud comments rather than one flag.

**Usage windows are "on record", never wall-clock.** Usage data does not end at
one date: retained accounts run to 2026-10-31 and churned accounts stop at their
`outcome_date`. So the sparkline and the zero-activity check take each
customer's last N days _on record_. Anchoring them to real time would return an
empty window for an account that left in May — an empty evidence panel rather
than an error — and would drift empty for everyone else once the calendar passes
the end of the table.

The UI names the window it used ("30 days on record to May 14, 2026") so no one
reads it as "the last 30 days from now". You can see the two anchors diverge on
any active account's page: the usage window ends 2026-10-31 while the renewal
countdown is measured from real today.

**`subscriptions` rows are billing charges, not renewals.** They are monthly-ish
charge events with 5–50 day gaps. The next contract renewal is
`customers.renewal_date`. Calling these "renewals" has already caused real
confusion once — the UI labels every row "billing charge".

**Ground truth is walled off from the risk path.** `customer_outcomes` is read
for exactly one purpose — the active/lost split above — and `evaluation_cases`
only for the placeholder badges; `actual_outcome` is never selected (it
duplicates `customer_outcomes.outcome`, verified identical on all 50 rows).
`lib/analysis.ts` reads neither table: the evidence heuristics see only usage,
support and billing, so on a churned account they show what was visible _before_
it left. Nothing that simulates the real risk/AI workflow may read either table.

**The evidence panel is not AI.** `lib/analysis.ts` is a threshold-rule stand-in
for the Phase 5 investigation agent, computed from real usage/support/billing
signals. Thresholds live in `EVIDENCE_THRESHOLDS` and are provisional.

## Live data, as verified on 2026-09-18 (v2 dataset)

Row counts: `customers` 50, `usage_daily` 8,323, `support_tickets` 41,
`subscriptions` 293, `customer_outcomes` 50, `evaluation_cases` 50.
`risk_assessments`, `investigations` and `outreach` are empty, as intended.
Portfolio reconciles to the expected **$22,920 MRR** — $16,675 across the 40
retained accounts, $6,245 already lost across the 10 churned ones.
`feature_usage` is an integer column.

Renewal dates split by cohort since migration 17: the **40 retained** accounts
renew 3-150 days after 2026-09-18, none in the past, while the **10 churned**
accounts now carry `renewal_date = outcome_date` (so mostly in the past, and not
shown in the UI). Countdowns read the real clock, so which active accounts fall
in the amber (<=14-day) bucket changes as time passes — measured from the live
data, 8 of the 40 are amber today, 5 thirty days on, 3 at sixty days, with
overdue rising 0 -> 12 -> 22.

Post-churn leakage was re-checked and is clean: **zero** `usage_daily` rows and
**zero** `subscriptions` rows exist for any churned customer dated after that
customer's `outcome_date`.

Column vocabularies, which the heuristics in `lib/analysis.ts` match against:

| Column                                     | Values                                                          |
| ------------------------------------------ | --------------------------------------------------------------- |
| `customer_outcomes.outcome`                | `retained` 40, `churned` 10                                     |
| `evaluation_cases.expected_recommendation` | `no_action_needed` 35, `intervene` 9, `monitor` 6               |
| `evaluation_cases.expected_risk_level`     | `low` 35, `high` 9, `medium` 6                                  |
| `support_tickets.resolution_status`        | `resolved` 17, `unresolved` 13, `escalated` 10, `in_progress` 1 |
| `support_tickets.sentiment`                | `negative` 24, `neutral` 11, `positive` 6                       |
| `subscriptions.payment_status`             | `paid` 292, `past_due` 1                                        |
| `subscriptions.change_type`                | `renewal` 242, `new` 50, `payment_failed` 1                     |

Four consequences worth knowing:

- The stored recommendation is `no_action_needed`, not the `no_action` the brief
  documented. `parseRecommendation` accepts both; drop the alias and 35
  accounts silently become "No case data".
- `change_type` is literally `renewal` on 242 rows. It is **not** rendered,
  because these are billing charges — see `chargeNote` in the customer page.
- `change_type` also carries the value `payment_failed`, so the billing evidence
  rule checks **both** `payment_status` and `change_type`. The one bad charge in
  the dataset (C014, 2026-05-09) happens to flag in both columns.
- With one `past_due` charge in 293, the billing-supporting branch almost never
  fires; 22 of 50 customers have no tickets at all. Both are exercised by
  fixtures rather than by this data.

### Consequence: no active account is flagged "Intervene"

All 9 `intervene` labels belong to churned accounts, so once the active/lost
split is applied the active summary reads **Intervene 0 / MRR at risk $0**, with
6 Monitor and 34 No action.

This is correct, not a bug: `expected_recommendation` encodes the outcome, since
`intervene` is the right grading precisely for accounts that went on to leave.
The dashboard shows an explanatory note rather than letting the empty card look
broken. It also means the placeholder data carries **no forward-looking signal
for active accounts** — which is exactly the gap the Phase 4 risk engine exists
to fill, and worth remembering before reading anything into that zero.

### Resolved: churned accounts' renewal dates

Churned accounts used to carry a `renewal_date` _after_ their `outcome_date`
(C048 left 2026-05-14 but renewed 2027-02-06). Migration
`17_fix_churned_renewal_dates.sql` set `renewal_date = outcome_date` for all 10;
re-verified here on 2026-09-18 with 0 mismatches, `signup_date < renewal_date`
still holding for all 50, and the 40 retained accounts untouched (3-150 days
out, none in the past).

The Lost accounts view still omits the renewal column and the detail page still
swaps it for the churn date. The reason is now different: the column would
simply restate the churn date under a heading implying a live contract.

C041's `outcome_date` of 2026-09-26 is intentionally left as-is. With countdowns
on the real clock it needs no separate fix.

## Deployment (Vercel)

1. Push to GitHub.
2. Vercel → Import Project → select the repo. Next.js is auto-detected.
3. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` under Settings →
   Environment Variables. The deployed app needs these separately from
   `.env.local`.
4. Pushes to `main` auto-redeploy. Supabase data changes need no redeploy — just
   a refresh.

Supabase free tier auto-pauses after roughly a week of inactivity. Open the
dashboard once before any presentation, or expect to un-pause it manually.

`@supabase/supabase-js` warns on Node 20 and wants Node 22+. The app itself runs
fine on Node 20 because Next provides a global `WebSocket` that the client's
realtime layer needs — but a **plain Node 20 script** calling `createClient`
throws `native WebSocket not found`. If you write a standalone script against
this database, either run it on Node 22+ or talk to PostgREST over `fetch`.
Set Node 22 in Vercel's project settings regardless.

## Not yet built

- Phase 4 risk engine and Phase 5 investigation agent. `risk_assessments`,
  `investigations` and `outreach` are intentionally empty and unqueried.
- **Open decision before Phase 4:** whether the deterministic risk scoring lives
  in SQL (a Supabase view/function) or in the app layer as TypeScript.
