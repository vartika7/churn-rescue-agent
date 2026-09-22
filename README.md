# Churn Rescue Agent

Internal customer-success console for retention risk triage. Next.js App Router
reading live from Supabase, with a deterministic risk engine that is unit-tested
and graded against held-out churn outcomes (`EVALUATION.md`).

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
| `ASSESS_TOKEN`              | Any random string; guards the two POST routes           |
| `GEMINI_API_KEY`            | Optional. Without it, investigations use the offline path |
| `GEMINI_MODEL`              | Required alongside the key. Deliberately not defaulted   |

Neither is prefixed `NEXT_PUBLIC_`, deliberately. The service role key bypasses
row-level security, so `lib/supabase.ts` imports `server-only` — an accidental
client-side import becomes a build error rather than a leaked key.

If either is missing the pages render a setup message instead of crashing.

## Scripts

| Command             | Purpose                                |
| ------------------- | -------------------------------------- |
| `npm run dev`       | Local dev server                       |
| `npm run build`     | Production build                       |
| `npm run typecheck` | `tsc --noEmit`                         |
| `npm test`          | Unit tests — engine, harness, dates, display (no database) |
| `npm run evaluate`  | Grade the engine against the seed, write `EVALUATION.md` |
| `npm run investigate` | Investigate flagged accounts (needs the app running) |
| `npm run evaluate:ai` | Grade stored investigations, write `EVALUATION-AI.md` |

## Structure

```
app/
  page.tsx                 Dashboard (Server Component); ?view=lost for churned
  customer/[id]/page.tsx   Customer detail (Server Component)
  api/assess/route.ts      POST re-scores active customers; token-guarded
  api/investigate/route.ts POST investigates one customer; token-guarded
  globals.css              Design tokens, light palette
components/
  CustomerTable.tsx        'use client' — sort / filter / search
  UsageChart.tsx           'use client' — inline SVG + hover tooltip
  Sparkline.tsx            Sessions over the final 90 days on record
  EvidencePanel.tsx        Engine signals split by direction
  InvestigationPanel.tsx   AI investigation with inline citations
  PrototypeNote.tsx        Placeholder-data labelling
  SetupError.tsx           Readable credentials / connection failure
lib/
  risk-engine.ts           Phase 4 scoring: signals, points, level, confidence
  evaluation.ts            Phase 7 grading; the only module reading outcomes
  ai-evaluation.ts         Phase 7 grading of the AI layer
  investigation/
    evidence.ts            The only thing the model sees; no outcome field
    schema.ts              Structured output + grounding validation
    prompt.ts              System prompt and evidence rendering
    provider.ts            Provider interface; vendor-agnostic
    gemini.ts              Gemini client (server-only; reads the key)
    factory.ts             Provider selection from the environment
    mock.ts                Offline provider — not an investigation
    run.ts                 Orchestration: package -> provider -> validate
  investigation-store.ts   Appends investigations; degrades if unmigrated
  risk-store.ts            Persists assessments; active customers only
  risk-display.ts          Engine output → badges and labels
  supabase.ts              Server-only client + paginated `selectAll`
  queries.ts               All table reads
  analysis.ts              Trend and activity primitives the engine builds on
  placeholder-risk.ts      `evaluation_cases` → retrospective lost-account badges
  time.ts                  getRealToday vs getLatestRecordedDate + countdowns
  format.ts                Presentation only: dates, currency, percents
  constants.ts             Risk weights, thresholds, window sizes
supabase/
  schema.sql               Table DDL for all 9 tables (verified against live)
  seed.sql                 The dataset as SQL, self-verifying
  seed/*.csv               The same rows as CSV, numbered in FK order
  shift_dates.sql          Realign the dataset to the calendar
scripts/
  export-seed.mjs          Re-export seed.sql + CSVs from the live database
  evaluate.ts              Grade the engine, write EVALUATION.md
  evaluate-ai.ts           Grade stored investigations, write EVALUATION-AI.md
  investigate.ts           Investigate flagged accounts; quota-aware
test/
  helpers.ts               Synthetic fixture builders — no database
  risk-engine.test.ts      Signal bands, score cap, confidence, leakage
  evaluation.test.ts       The harness's own metric maths
  time.test.ts             The two date reference points
  risk-display.test.ts     Past-tense rule for churned accounts
EVALUATION.md              Generated: how good is the engine?
EVALUATION-AI.md           Generated: how good is the investigation layer?
```

### Tests

`npm test` runs `node:test` through `tsx`, 89 cases over the risk engine, the
Phase 7 harness, the two date reference points and the display helpers. No database, no network, no
seed file: every fixture is built in `test/helpers.ts`.

That is deliberate. The signal bands are step functions, so a test asserting
against real rows only pins whatever the dataset happens to sit on today — and
this dataset has been reshaped twice. The fixtures construct the exact series
needed to land on each boundary, so `-40%` versus `-39%` and 6 silent days
versus 5 are checked directly.

What the suite is really guarding is the four bugs that already happened once:
a whole-history trend claimed from 38 days of data, an amber renewal badge on
every overdue account, a present-tense "High risk" on a company that left in
April, and a reason string that wrapped to two lines. Each has a named
regression test.

The suite was checked by mutation rather than by passing: inverting the high
threshold, removing the 90-day history gate, shifting the silence band,
removing the escalated cap, folding `overdue` back into `soon`, removing the
score cap and making the churned label present-tense each produce failures.
A suite that cannot fail is not evidence of anything.

### Evaluation

`npm run evaluate` grades the engine and regenerates `EVALUATION.md`. Like the
tests it reads the committed seed rather than Supabase, so the grade is
reproducible from a clean clone and pinned to a known dataset instead of to
whatever the database holds today.

`lib/evaluation.ts` is the one module allowed to read `customer_outcomes` and
`evaluation_cases` — grading needs the answers, that is what grading is. What
matters is that nothing flows back: it calls `scoreCustomer` with exactly the
inputs the live path uses and only ever compares the result.

Two findings are worth knowing before reading anything else in this repo:

- **The engine's middle band is under-sensitive.** 5 of 6 accounts a human
  graded `medium` score `low`. Two minor signals at 8 points each total 16,
  under the 25 needed to surface.
- **The score is not monotonic in time.** Recall at 14 days before churn (9/10)
  is higher than at the churn date (8/10), because two accounts recovered some
  usage shortly before leaving and the recency-weighted windows read that as
  health returning.

Neither is fixed. They are the output of the harness doing its job, and
`EVALUATION.md` states what it would take to address them.

### AI investigation (Phase 5)

The layer that answers *why*, sitting on top of the deterministic score rather
than replacing it. `POST /api/investigate?customer=C035`, token-guarded with
`ASSESS_TOKEN`; `&offline=1` forces the offline path, `&save=0` skips
persistence.

Three guarantees, each enforced in code and each with a test that fails when
the enforcement is removed:

- **No outcome leakage.** `buildEvidencePackage` has no parameter for an
  outcome, `case_type` or `expected_*` — the same signature trick
  `scoreCustomer` uses. "Did the model see the answer?" is settled by reading
  the type, not by auditing a prompt.
- **Grounding is checked, not requested.** Every evidence item has a stable id
  and the model must cite ids. A citation that does not resolve is a
  fabrication and the whole investigation is rejected rather than repaired —
  silently dropping it would leave a plausible claim with nothing behind it.
  `grounding_rate` is stored per run.
- **Uncertainty is available.** `insufficientEvidence` is the only way to
  submit an uncited root cause, so "I cannot tell" is a first-class answer
  instead of something the model has to invent its way around.

Contradicting evidence is structural: the package carries the engine's
zero-point signals — the record that something was checked and found clean.
Without them the model could only ever confirm the score.

Two things learned from the first live run, both now enforced:

- **The model wrote "the most recent renewal on September 19".** `change_type`
  is literally `renewal` on most `subscriptions` rows, and passing it through
  raw reproduced the framing the UI already refuses — these are monthly
  charges; the contract renewal is a different date. The package now applies
  the same `chargeNote` rule the customer page does.
- **`renewal_date` is deliberately withheld**, and it is the subtlest leak in
  the schema. It reads as ordinary commercial context, and the model asked for
  it — but churned accounts carry `renewal_date = outcome_date`, so supplying
  it would hand over the exact date every churned account left.

**Provider is swappable.** The app talks to `InvestigationProvider` (system
prompt, user prompt, text back) and never to a vendor SDK, so adding Claude
means adding a file. `GEMINI_MODEL` is deliberately not defaulted: free-tier
model names move, and a stale default fails at request time with a confusing
404.

**Model choice is verified, not assumed.** `gemini-2.5-flash` — the model a
2026-vintage guess would land on — now returns 404 for new keys, and
`3.7`/`3.8-flash` returned 503 under load on two separate probes. The list
endpoint is the source of truth. A pinned version is used rather than the
`gemini-flash-latest` alias so evaluation numbers stay attributable to a
specific model.

**`GEMINI_THINKING_BUDGET=off` omits the field entirely**, which some models
require: `gemini-3.5-flash-lite` rejects `thinkingConfig` with a bare "Request
contains an invalid argument". A provider that always sends it is not actually
swappable between models, which is the sort of thing only a second model finds.

**Retries are off by default**, which looks wrong and is not. The free quota is
20 requests per day and failed attempts count against it, so three accounts
retrying a persistent 503 three times each spent nine requests, produced
nothing, and exhausted the day. These 503s last minutes, not milliseconds.
Raise `attempts` on a paid tier where a retry costs a fraction of a cent rather
than 5% of the daily budget.

**Thinking is disabled** (`thinkingBudget: 0`). Not a tuning preference: those
tokens are charged against `maxOutputTokens`, and left to the model's
discretion a 2048 ceiling went 1532 to reasoning and 500 to output, truncating
the JSON mid-object. With it off the same request finishes in 835 tokens and
parses. A full investigation runs about 1,400 in and 650 out.

**The free tier is 20 requests per DAY per model** — not per minute. Verified
from the 429 body: `GenerateRequestsPerDayPerProjectPerModel-FreeTier`,
`quotaValue: 20`. The quota is per model, so a second model adds another 20 at
the cost of comparability between accounts.

**Only flagged accounts are investigated** (`npm run investigate`, score >= 25).
That is a product decision the quota merely confirms: the engine already
answers a low-risk account with "no signals fired", and spending a model call
to explain why a healthy customer is healthy produces a paragraph nobody
opens. Currently 6 of 40 active accounts qualify, which fits the daily cap with
room to re-run. `--all` exists and warns before exhausting the quota;
`--offline` costs nothing.

**The table holds medium and high risk active accounts only.** Low-risk accounts
are not investigated: the engine already answers them with "no signals fired",
and a paragraph explaining why a healthy customer is healthy is one nobody
opens.

#### A finding from a sample that is no longer in the table

Before that rule existed, a run investigated every active account, including 34
low-risk ones, and reached 8 before the daily quota stopped it. Those five
low-risk investigations produced the single most useful result in the project,
recorded here because the rows behind it have since been removed:

| Account | Engine score | Model said |
| --- | --- | --- |
| C003 | 16 | monitor |
| C006 | 22 | intervene |
| C011 | 23 | monitor |
| C007 | 0 | monitor |

Every escalation sat in the 16-23 band, immediately under the flag threshold of
25. C006 is the clearest: an unresolved negative ticket — *"Dashboard taking
20-30 seconds to load"*, open two months — that the engine counted for 8 points
and could not read. The model read it, tied it to a mild usage decline, and
said intervene.

That is the same defect `EVALUATION.md` reached independently by grading the
engine against human labels: the middle band is under-sensitive, because two
minor signals at 8 points each total 16 and never surface.

C007 is the counterweight and the reason not to over-read this. It scored **0**,
has no tickets at all, and the model suggested monitoring an 8% decline that
sits below the engine's own minor threshold. One escalation in four was
over-caution, which is why a CSM approves rather than the system acting.

**The methodological point survives the data.** A flagged-only policy cannot
detect under-flagging: you learn nothing about what the engine misses by
looking only at what it caught. Periodically sampling a few high-scoring
low-risk accounts would surface it — worth doing deliberately if this ever ran
for real, and noted here rather than left as an accident.

Churned accounts are never investigated, for the same reason they are not
scored: a recommendation is an instruction about what to do next, and there is
nothing to do next for an account that left in April. The customer page
suppresses the panel for them rather than rendering a present-tense
recommendation on a dead account.

**With no key configured** the offline provider runs instead. It restates the
evidence and does not read the ticket prose, which is the entire point of the
layer — so it is labelled as a placeholder in the UI and says so in its own
`limitations` field. An unlabelled placeholder shown as AI output is a lie to
whoever reads the screen.

The `investigations` table needs four columns added before results can be
saved (`investigation jsonb`, `provider text`, `model text`, `grounding_rate
numeric`) — see `supabase/schema.sql`. Until then reads return "no
investigation yet" rather than breaking the page: the deterministic score is
the product and must not depend on this layer.

### Evaluating the AI layer

`npm run evaluate:ai` grades investigations already stored in `investigations`,
so it spends no quota and every number refers to a response that actually
happened. Results in `EVALUATION-AI.md`.

Only mechanically checkable things are measured: structured-output validity,
whether every citation resolves, whether the prose names ticket ids or dates
absent from the package, whether the counter-case was engaged, and whether
uncertainty was claimed where the record was thin.

**There is deliberately no root-cause accuracy score.** `expected_root_cause`
exists, but scoring prose against prose by string similarity produces a number
that tracks phrasing rather than correctness, and a metric that looks rigorous
while measuring nothing is worse than an admitted gap.

Current results across 8 real investigations: 8/8 valid shape, 8/8 fully
grounded, **0 phantom entities, 0 uncited claims**, 8/8 engaged the
counter-case, 8/8 claimed uncertainty correctly.

**Offline placeholders are excluded from these numbers**, and the reason is a
bug worth recording. An `--offline` validation run persisted six rows, three of
which superseded real Gemini results, and the grader then counted them as AI
output. That provider builds its citations from the evidence package, so it
scores a perfect grounding rate by construction and can never produce a phantom
entity — it was padding the denominator with cases incapable of failing.
Offline runs no longer persist without an explicit opt-in, and the grader skips
them.

**The most useful finding is a disagreement.** The model recommended more
urgency than the deterministic band on **4 of 8** accounts and less on **0**.
Excluding the offline rows sharpened this rather than softening it: that
provider mirrors the band by construction, so every placeholder counted as
agreement. Every
escalation is an account where signals fired but summed below the flag
threshold — C006 clearest of all: an unresolved negative ticket, *"Dashboard
taking 20-30 seconds to load"*, open two months, plus a mild decline. The
engine scored those 8 and 6, total 14, under the 25 needed to surface, and
called it low risk. The model read the ticket text and said intervene.

That is the same defect `EVALUATION.md` found independently by grading the
engine against human labels — the middle band is under-sensitive. Two
harnesses built for different purposes landing on the same weakness is better
evidence than either alone, and it is the clearest argument for the layer
existing: the engine counts tickets, it cannot read them.

Zero de-escalations is the safety result. An escalation adds an account to a
worklist and costs ten minutes; a de-escalation removes one, and the cost of
being wrong is a churn nobody looked at.

The adversarial suite in `test/ai-evaluation.test.ts` is the part that
generalises to a model nobody has run yet: fabricated citations, a phantom
ticket named in prose *with clean citations beside it*, uncited claims,
invented actions, and a root cause asserted on 38 days of data are each proven
to be caught. Verified by mutation — disabling the phantom detector, collapsing
de-escalation into escalation, or always reporting the counter-case as used
each produce failures.

### Keeping the dataset aligned

The data is a fixed snapshot but the calendar keeps moving, so it drifts: usage
stops at a hard end date while today walks past it, and renewal countdowns slide
from upcoming to overdue. Two commands fix it:

```bash
# 1. in the Supabase SQL editor
#    slides every date so the newest usage row lands on CURRENT_DATE
supabase/shift_dates.sql

# 2. locally, so the committed snapshot stops being a lie
node scripts/export-seed.mjs
```

The shift is a **uniform translation** — every date in every table moves by the
same number of days — so gaps, orderings and every invariant survive by
construction. It computes its own offset and is a no-op when already aligned.

Run it a few days before any demo rather than months ahead: renewals sit within
30 days of the data end, so the picture is good for roughly a fortnight after a
shift and degrades after that.

`git status` cannot tell you the seed has gone stale, because the drift lives in
Supabase rather than the working tree. `export-seed.mjs` parses everything it
writes back and diffs it against the source, so an escaping bug fails there
rather than silently at load time.

### Restoring the database

Two copies of the same 8,458 rows, both pulled from the live project and both
validated by round-tripping back to source. Use whichever fits the job.

**`seed.sql` — to actually load it.** Run `schema.sql` then `seed.sql` (the
Supabase CLI does both in order on `supabase db reset`; otherwise paste them
into the SQL editor). It runs in a transaction, truncates first so it is safe to
re-run, and ends with a verification query that returns **0 rows** on success
and one named row per failed assertion otherwise — row counts, the $22,920 MRR
total, the 40/10 cohort split, and the invariants the app depends on (no
post-churn activity, `renewal_date = outcome_date` for churned accounts).

**`seed/*.csv` — to look at it or load it elsewhere.** Smaller (236 KB vs
360 KB), diffable per row, and opens in a spreadsheet or a notebook. Files are
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
holds 7,980, so a plain `.select()` silently returns the first 1000 and drops
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

| Column                                     | Values                                             |
| ------------------------------------------ | -------------------------------------------------- |
| `customer_outcomes.outcome`                | `retained` 40, `churned` 10                        |
| `evaluation_cases.expected_recommendation` | `no_action_needed` 33, `intervene` 11, `monitor` 6 |
| `evaluation_cases.expected_risk_level`     | `low` 33, `high` 11, `medium` 6                    |
| `support_tickets.resolution_status`        | `resolved` 18, `unresolved` 14, `escalated` 11     |
| `support_tickets.sentiment`                | `negative` 27, `neutral` 10, `positive` 6          |
| `subscriptions.payment_status`             | `paid` 283, `past_due` 2                           |
| `subscriptions.change_type`                | `renewal` 234, `new` 50, `payment_failed` 1        |

- The stored recommendation is `no_action_needed`, not the `no_action` the brief
  documented. `parseRecommendation` accepts both; drop the alias and 35
  accounts silently become "No case data".
- `change_type` is literally `renewal` on 234 rows. It is **not** rendered,
  because these are billing charges — see `chargeNote` in the customer page.
- `change_type` also carries the value `payment_failed`, so the billing evidence
  rule checks **both** `payment_status` and `change_type`, and it has to: of the
  two bad charges, C014's flags in both columns while C038's is `past_due` with
  `change_type = 'renewal'`. Checking `change_type` alone would miss it.
- C042 (Granite Group) was converted into a recently-signed account — 38 days
  of usage, two charges, no tickets — because the engine's `low` confidence
  branch was unreachable otherwise: every other account has 92+ days of
  history, so the sparse-data check never fired. It is the one case where the
  engine declines to judge, which is the answer you want for an account nobody
  has watched long enough. Converting an existing customer rather than adding a
  51st kept the counts, the 40/10 split and the $22,920 total intact.
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
- C035 (Pacific Solutions, Enterprise $1,765) and C038 (Orbit Partners, Pro
  $605) were converted into **active accounts in genuine decline**, because the
  generated data had no such cohort: every account was either healthy and
  retained or declining and already churned, so no active account could score
  `high` and the worklist the tool exists to produce was structurally empty.
  C035 lost engagement outright — 45 days sliding to a quarter of its baseline,
  13 silent days in the last 30, plus ticket T0029 escalated. C038 slid more
  gently over 30 days and stopped paying, so the two are not the same case
  twice. As with C042, existing rows were edited rather than customers added:
  the 50 customers, the 40/10 split and the $22,920 total all still hold, and
  no usage row was added or removed (the later signup realignment is what moved
  that count).
  They score **70** and **61**, deliberately short of the churned cohort's
  81-97 — the story is an account caught while it can still be saved, and if
  the two populations overlapped the score would not carry that meaning.
- 22 of 50 customers have no tickets at all, which is the branch this data
  exercises least.

### Consequence: the "Intervene" card was structurally empty

Originally all 9 `intervene` labels belonged to churned accounts, so once the
active/lost split was applied the active summary read **Intervene 0 / MRR at
risk $0**, with 6 Monitor and 34 No action.

That was not a bug in the split: `expected_recommendation` encodes the outcome,
and `intervene` is the right grading precisely for accounts that went on to
leave. But it did mean the placeholder gradings carried **no forward-looking
signal for active accounts** — a churn tool whose worklist can only ever be
empty. The C035/C038 conversion above is what closed the gap; the active
summary now reads **Intervene 2 / MRR at risk $2,370**, with 6 Monitor and 32
No action, and the risk engine independently scores both `high`.

Two things are worth keeping straight here. The gradings in `evaluation_cases`
are ground truth for the Phase 7 harness, not engine output — they are labels
someone wrote down, and the dashboard marks them as placeholder. And the engine
reaching the same verdict is not confirmation that it is right: the data was
shaped to contain a case of this kind, so the agreement shows the signal is
detectable, not that the thresholds generalise.

### Signup dates were fiction, and are now tied to the data

The generator chose `signup_date` independently of the usage window, so 48 of
50 accounts claimed tenure they had no records for — C017 by 971 days, C038 by
934, and 34 accounts by over a year. The customer page renders "Signed up"
directly above the usage chart, so C038 read _signed up Oct 6, 2023_ over a
chart starting Apr 2026. Tenure is also a standard churn feature, which makes a
fictional tenure column worse than a missing one.

Every `signup_date` was pulled to 0-3 days before that account's first usage
row, with the lead varying per account so the join does not look mechanical.
Every signup now falls in 2026. The seed carries the corrected dates and
asserts the property on load, so there is no migration to run.

Five churned accounts (C008, C014, C016, C020, C048) had usage genuinely
starting in late 2025; their pre-2026 usage was trimmed to bring their signups
into 2026, at staggered cutoffs rather than a shared Jan 1, since five accounts
sharing one signup date would read as generated. `usage_daily` went 8,200 →
7,980 and `subscriptions` 289 → 285; each trimmed account's opening `new` charge
was re-dated rather than deleted, so every customer still has exactly one.

**The cost is worth knowing before Phase 7.** Those five are churned accounts,
which are the evaluation set, and trimming shortened exactly the histories that
evidence rests on — C016 from 170 days to 93, C048 from 112 to 92. Recall is
unchanged (8/10 flagged at churn, no account changing level), but "how early was
this detectable?" is answered by replaying the engine at 120/90/60/30 days
before churn, and two accounts no longer have the depth for the longest horizon.
The alternative was to let those five keep late-2025 signups, which the data
would have supported. Forcing 2026 was a deliberate choice, not a constraint the
incoherence required.

A related consequence: with every signup in 2026 and all usage ending
2026-09-20, tenure is now close to collinear with "when this account's records
start", so it carries little independent signal. Worth remembering before
treating tenure as a feature.

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

| as of      | overdue | amber ≤14d | 15-45d | 46d+ | range    |
| ---------- | ------- | ---------- | ------ | ---- | -------- |
| 2026-09-18 | 0       | 0          | 4      | 36   | 44-73d   |
| +30d       | 0       | 4          | 36     | 0    | 14-43d   |
| +60d       | 20      | 20         | 0      | 0    | -16-13d  |
| +90d       | 40      | 0          | 0      | 0    | -46--17d |

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

- Phase 6 recommendations and outreach. `outreach` is still empty and
  unqueried. The investigation already produces a recommended action; what is
  missing is the approve / edit / reject flow and the drafted message. Nothing
  is ever sent automatically.
- Three of the six flagged accounts (C038, C027, C049) have no live
  investigation yet — the free tier is 20 requests per day per model and it was
  spent. Their stored investigations are from the offline provider and are
  labelled as such.
- Phase 8 deployment. Nothing is on Vercel yet — it needs `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY` and `ASSESS_TOKEN` set in project settings.
- Phase 7 acts on its own findings. The harness reports that the middle band is
  under-sensitive (5 of 6 `medium` labels score `low`) and that the score is not
  monotonic in time, but neither has been fixed — see `EVALUATION.md`.
- No component or end-to-end tests. `npm test` covers the engine, the two date
  reference points and the display helpers — the logic where a silent
  regression would be invisible. The pages are verified by eye.

Resolved earlier: the deterministic scoring lives in the app layer as
TypeScript, not as a SQL view. It has to run identically over live rows and
over synthetic fixtures with no database at all, which is what makes both the
unit tests and the Phase 7 replay possible.
