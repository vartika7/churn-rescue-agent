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
  seed.sql                 The v2 dataset as SQL, 8,807 rows, self-verifying
  seed/*.csv               The same rows as CSV, numbered in FK order
```

### Restoring the database

Two copies of the same 8,807 rows, both pulled from the live project and both
validated by round-tripping back to source. Use whichever fits the job.

**`seed.sql` — to actually load it.** Run `schema.sql` then `seed.sql` (the
Supabase CLI does both in order on `supabase db reset`; otherwise paste them
into the SQL editor). It runs in a transaction, truncates first so it is safe to
re-run, and ends with a verification query that returns **0 rows** on success
and one named row per failed assertion otherwise — row counts, the $22,920 MRR
total, the 40/10 cohort split, and the invariants the app depends on (no
post-churn activity, `renewal_date = outcome_date` for churned accounts).

**`seed/*.csv` — to look at it or load it elsewhere.** Smaller (229 KB vs
359 KB), diffable per row, and opens in a spreadsheet or a notebook. Files are
numbered `01_`–`06_` in foreign-key order, so load them in that order.

One caveat if you import the CSVs through Supabase's table-editor UI rather than
`COPY`: `customer_outcomes.reason` is NULL on all 40 retained accounts and is
written as a bare empty field, which `COPY ... FORMAT csv` reads as NULL. Some
CSV importers insert an empty string instead. The data contains no legitimate
empty strings, so `SELECT count(*) FROM customer_outcomes WHERE reason = ''`
should return 0 after loading — if it returns 40, the importer converted them
and `seed.sql` is the safer route.

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

## The dataset

The exact rows live in `supabase/seed/` and `supabase/seed.sql`, so counts and
invariants no longer need restating here — `seed.sql` ends with a verification
query that asserts them (row counts, the $22,920 MRR total, the 40 retained /
10 churned split, no post-churn activity, `renewal_date = outcome_date` for
churned accounts). Run it and read the result rather than trusting prose.

What is worth writing down is the part the data does not explain on its own:
the column vocabularies the heuristics in `lib/analysis.ts` match against, and
the four places where the data shaped the code.

| Column                                     | Values                                                          |
| ------------------------------------------ | --------------------------------------------------------------- |
| `customer_outcomes.outcome`                | `retained` 40, `churned` 10                                     |
| `evaluation_cases.expected_recommendation` | `no_action_needed` 35, `intervene` 9, `monitor` 6               |
| `evaluation_cases.expected_risk_level`     | `low` 35, `high` 9, `medium` 6                                  |
| `support_tickets.resolution_status`        | `resolved` 19, `unresolved` 14, `escalated` 10                  |
| `support_tickets.sentiment`                | `negative` 26, `neutral` 11, `positive` 6                       |
| `subscriptions.payment_status`             | `paid` 292, `past_due` 1                                        |
| `subscriptions.change_type`                | `renewal` 242, `new` 50, `payment_failed` 1                     |

- The stored recommendation is `no_action_needed`, not the `no_action` the brief
  documented. `parseRecommendation` accepts both; drop the alias and 35
  accounts silently become "No case data".
- `change_type` is literally `renewal` on 242 rows. It is **not** rendered,
  because these are billing charges — see `chargeNote` in the customer page.
- `change_type` also carries the value `payment_failed`, so the billing evidence
  rule checks **both** `payment_status` and `change_type`. The one bad charge in
  the dataset (C014, 2026-05-09) happens to flag in both columns.
- C028 (Juniper Group) carries two authored tickets, T0042 and T0043 — a
  performance complaint dated inside its Jun-Aug engagement dip and a recent
  export gap. They were written to give its `monitor` grading something to
  stand on: before them the rule-based panel found nothing supporting, so the
  badge and the evidence contradicted each other. Both are `unresolved`, which
  is plausible for backlog items on an $85/mo account in a way an open account
  lockout is not.
- No retained account has an open `access`-category ticket. A still-paying
  customer with an account lockout left open for months is not how a real
  support desk behaves, so those two were resolved in the data; churned
  accounts keep theirs, where the unresolved lockout is part of the churn
  story. `seed.sql` asserts it. `resolution_status` no longer contains
  `in_progress` at all — `OPEN_TICKET_STATUSES` still matches it defensively.
- With one `past_due` charge in 293, the billing-supporting branch almost never
  fires, and 22 of 50 customers have no tickets at all. Both are exercised by
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

### Renewal dates, and this dataset's shelf life

Churned accounts carry `renewal_date = outcome_date`, which `seed.sql` asserts.
That is why the Lost accounts view omits the renewal column and the detail page
swaps it for the churn date — the column would otherwise restate the churn date
under a heading implying a live contract.

Active accounts were reset to **30 days after their last paid charge**. That
fixed 11 accounts which were still billing past their own stated next renewal —
the renewal had never rolled forward, so the dashboard counted down to a date
the billing record had already passed. `seed.sql` now asserts that case cannot
recur.

The side effect is that every active renewal landed in one November band,
because billing is roughly monthly and usage data ends 2026-10-31. Countdowns
read the real clock, so the buckets move:

| as of      | overdue | amber ≤14d | 15-45d | 46d+ | range     |
| ---------- | ------- | ---------- | ------ | ---- | --------- |
| 2026-09-18 | 0       | 0          | 4      | 36   | 44-73d    |
| +30d       | 0       | 4          | 36     | 0    | 14-43d    |
| +60d       | 20      | 20         | 0      | 0    | -16-13d   |
| +90d       | 40      | 0          | 0      | 0    | -46--17d  |

**So the data has a shelf life.** Nothing is amber today, and by about 90 days
out every active account reads overdue. Before demoing on a given date, check
where that date falls in the table. The durable fix is to spread `renewal_date`
over a wider horizon rather than deriving it from the last charge, which by
construction bunches them into a single month.

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
