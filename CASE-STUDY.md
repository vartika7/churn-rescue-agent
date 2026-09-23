# Churn Rescue Agent

An AI-powered churn investigation tool for B2B SaaS Customer Success teams.

It answers three questions in order, and deliberately uses different machinery
for each:

| Question                              | Answered by                       |
| ------------------------------------- | --------------------------------- |
| Which customers should I worry about? | a deterministic risk engine       |
| Why are they at risk?                 | an LLM reading the evidence       |
| What should I do?                     | a recommendation a human approves |

The interesting decisions here are about where the model is _not_ used, how its
output is constrained, and how both layers were measured. Those are covered
below in that order.

---

## The problem

A Customer Success Manager holds 40-80 accounts. Churn is rarely a surprise in
hindsight and almost always a surprise in practice: the signals exist — usage
tailing off, a support ticket that never closed, a payment that failed — but
they sit in three different systems and nobody correlates them until the
cancellation email arrives.

Existing health scores mostly fail in one of two ways. Either they are a single
opaque number nobody trusts, so the CSM ignores it; or they flag so many
accounts that the list becomes noise, which has the same result. A score that
cannot explain itself does not change behaviour.

So the product question is not "can we predict churn". It is: **can we produce
a short list a CSM will actually open, with enough evidence attached that they
know what to do before they open the account.**

## Who uses it

A CSM triaging their book at the start of the week. They want a ranked list,
a reason they can check, and a suggested action they can accept or reject. They
are not a data scientist and will not tune a model. They will stop using
anything that wastes their time twice.

That user shapes two decisions that recur below: the score has to be
explainable line by line, and a false positive is more expensive than a false
negative. A missed churn costs one account. A worklist full of healthy
customers costs the team's trust in the tool, and then they stop opening it.

---

## Architecture: why the score is not an LLM

```
customer data
   ↓
deterministic signals        usage trend, silent days, open tickets, failed charges
   ↓
risk score + evidence        additive points, 0-100, every signal named
   ↓
AI investigation             reads the evidence, including ticket prose
   ↓
root cause + recommendation  every claim cites the evidence it rests on
   ↓
human approval               the CSM decides
   ↓
outreach
```

**The risk score is computed by rules, not by a model.** Same inputs, same
score, every time. That buys four things a language model cannot:

- It can be **graded**. Phase 7 replays it against accounts that have already
  churned and produces a recall number. You cannot do that with a component
  whose output moves between runs.
- It can be **explained**. Every point is attributable: "sessions down 67%" is
  25 points, "13 silent days in the last 30" is 18. A CSM can check the
  arithmetic.
- It can be **debugged**. When the engine is wrong, the wrong rule is visible.
- It **cannot hallucinate a customer**.

The LLM sits on top and never touches the score. Its prompt says so explicitly:
_"You are not scoring the account. The score is given and is not yours to
revise."_

**Why use a model at all, then.** Because one input resists rules entirely.
`support_tickets.subject` and `description` are free English:

> "Workflow steps executing out of order — our approval chain fires before the
> review step completes."

> "Two of our admins reset their passwords and are now stuck in a loop."

The deterministic engine can only _count_ those — one open ticket, 8 points. It
cannot tell that an approval chain firing out of order is an operational
blocker while a password loop is an annoyance. Reading them is the model's job,
and it is the only job it has.

This split is also what keeps the project from being a thin wrapper. The value
is not "we sent data to an LLM". It is that the model operates on a structured
evidence package the deterministic layer assembled, and everything it says is
checked back against that package.

---

## Constraining the model

Three properties are enforced in code, not requested in the prompt. Each has a
test that fails if the enforcement is removed.

### No outcome leakage

The evidence package builder accepts no outcome, no `case_type`, no
`expected_*` field. The type signature gives ground truth nowhere to go, so
_"did the model see the answer?"_ is settled by reading the type rather than by
auditing a prompt string. The same trick is used one layer down: `scoreCustomer`
has no parameter for an outcome either.

The subtlest version of this was almost missed. `renewal_date` looks like
ordinary commercial context — "renews in 27 days" is genuinely useful, and the
model asked for it in its limitations. But churned accounts in this dataset
carry `renewal_date = outcome_date`, so supplying it would have handed over the
exact date every churned account left. It is outcome data wearing a commercial
label.

### Grounding is checked, not hoped for

Every piece of evidence carries a stable id — `usage.recent_trend_30d`,
`T0029`, `billing.2026-09-02` — and the model must cite ids. A citation that
does not resolve is a fabrication, and the whole investigation is rejected
rather than repaired: silently dropping a bad citation would leave a plausible
sentence with nothing behind it, which is worse than no answer.

Citation checking alone is not enough, because the prose beside a clean
citation list can still invent things. A second check scans the text for ticket
ids and dates that appear nowhere in the package — the "phantom entity" case,
where every citation resolves and the sentence next to it refers to a ticket
that does not exist.

### Uncertainty is an available answer

`insufficientEvidence` is a first-class field and the only way to submit a root
cause with no citations. "I cannot tell" is therefore something the model can
say, rather than something it has to invent its way around. The `limitations`
field cannot be empty.

### Contradicting evidence is structural

The evidence package includes the engine's **zero-point** signals — the record
that something was checked and found clean. Without them the model could only
ever argue for risk. An investigation that never makes the case against its own
hypothesis is a justification, not an investigation.

---

## Evaluation

Two harnesses, built for different purposes, both reproducible from a clean
clone with no credentials.

### The deterministic layer

`npm run evaluate` replays the engine against the 10 churned accounts using
`asOf` set to each churn date — asking whether it would have raised a hand
while there was still something to do, not whether it notices an account
stopped existing.

|                                              |                                       |
| -------------------------------------------- | ------------------------------------- |
| Flagged at churn                             | **8 / 10** (7 scored high)            |
| Agreement with human labels                  | **40 / 50** exact, 49 within one band |
| Flagged among `false_positive_risk` accounts | **2 / 6**, none high                  |

Lead time matters more than the headline, because a flag raised the week an
account leaves is not a rescue:

| Days before churn | Observable | Flagged |
| ----------------- | ---------- | ------- |
| at churn          | 10         | 8       |
| 14                | 10         | 9       |
| 30                | 10         | 8       |
| 60                | 5          | 3       |
| 90                | 1          | 0       |

"Observable" excludes accounts whose records do not reach that far back.
Counting those as misses would measure the dataset rather than the engine — and
the column shrinking is the honest limit of this data, not something to hide.

**Two weaknesses the harness found, both left unfixed and documented:**

_The middle band is under-sensitive._ 5 of 6 accounts a human graded `medium`
score `low`. The cause is arithmetic: two minor signals at 8 points each total
16, under the 25 needed to surface.

_The score is not monotonic in time._ Recall at 14 days (9/10) is **higher**
than at the churn date (8/10). Two accounts recovered some usage shortly before
leaving, and the recency-weighted windows read that as health returning. C005
peaks at 65 sixty days out and scores 14 on the day it goes. Fixing it needs
state across runs — which is what the `risk_assessments` history table exists
for and is not yet used for.

### The AI layer

`npm run evaluate:ai` grades investigations already stored, so it costs no
quota and every number describes a response that really happened.

|                               |       |
| ----------------------------- | ----- |
| Valid structured output       | 6 / 6 |
| Fully grounded                | 6 / 6 |
| Phantom entities              | **0** |
| Uncited claims                | **0** |
| Engaged the counter-case      | 6 / 6 |
| Uncertainty claimed correctly | 6 / 6 |

**There is deliberately no root-cause accuracy score.** The dataset contains
`expected_root_cause`, and scoring prose against prose by string similarity
would produce a number that tracks phrasing rather than correctness. A metric
that looks rigorous while measuring nothing is worse than an admitted gap, so
the gap is admitted.

**The most useful result came from a sample that is no longer in the table.**
Before the policy narrowed to flagged accounts only, a run investigated
low-risk accounts too:

| Account | Engine score | Model said |
| ------- | ------------ | ---------- |
| C003    | 16           | monitor    |
| C006    | 22           | intervene  |
| C011    | 23           | monitor    |
| C007    | 0            | monitor    |

Every escalation sat in the 16–23 band, immediately under the flag threshold of 25. C006 is the clearest: an unresolved negative ticket — _"Dashboard taking
20-30 seconds to load"_, open two months — that the engine counted for 8 points
and could not read. The model read it, connected it to a mild usage decline,
and said intervene.

That is the same defect the deterministic harness reached independently from
human labels. **Two evaluations built for different purposes converged on one
weakness**, which is better evidence than either alone — and it is the clearest
argument for the AI layer existing at all: the engine counts tickets, it cannot
read them.

C007 is the counterweight and the reason not to over-read this. It scored
**zero**, has no tickets, and the model still suggested monitoring an 8%
decline that sits below the engine's own minor threshold. One escalation in
four was over-caution. If every escalation were insight you would simply lower
the threshold; the fact that one is noise is the argument for a human deciding.

### Adversarial testing

The live numbers say this model behaved. The adversarial suite says the
pipeline would have caught it if it had not, which is the part that generalises
to a model nobody has run yet. Fabricated citations, a phantom ticket named in
prose _with clean citations beside it_, uncited claims, invented actions, and a
root cause asserted on 38 days of data are each proven to be rejected.

153 tests overall, verified by mutation rather than by passing — inverting the
risk threshold, removing the 90-day history gate, disabling the phantom
detector or collapsing de-escalation into escalation each produce failures. A
suite that cannot fail is not evidence of anything.

---

## Failure modes

| Failure                                | What happens                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model fabricates a citation            | Investigation rejected, nothing stored. The deterministic score and evidence still render.                                                                                                  |
| Model invents a ticket in prose        | Caught by the phantom-entity check and reported as a metric.                                                                                                                                |
| Evidence is too thin to judge          | `insufficientEvidence: true`, no root cause invented. C042 (38 days of history) is the case that exercises it.                                                                              |
| Provider is down, slow or rate-limited | The page degrades, it does not break. Risk score and evidence are unaffected — they never depended on the model.                                                                            |
| No provider configured                 | Offline placeholder, labelled as such in the UI, and **not persisted**.                                                                                                                     |
| Model disagrees with the engine        | Recorded as escalation or de-escalation, not scored as error. De-escalations are tracked separately: an escalation costs a CSM ten minutes, a de-escalation costs a churn nobody looked at. |
| Dataset dates drift past real time     | Documented shelf life; a shift script realigns everything and lists the four things it invalidates.                                                                                         |

The pattern across all of them: **the deterministic layer is the product, and
the AI layer is an enhancement that must never be able to take it down.**

## Human in the loop

Nothing reaches a customer without a person. The investigation produces a
recommendation — intervene, monitor, no action — and the CSM approves, edits or
rejects it.

That is not a hedge, it follows from the measurement. One escalation in four
was over-caution, and the agreement with human labels is 3 of 5. Those are
useful numbers for a decision-support tool and unacceptable ones for an
autonomous system. The tool is built to the accuracy it actually has.

It is also why the UI shows every claim's citations inline: the CSM is expected
to check, and the interface is designed to make checking take seconds rather
than requiring them to trust it.

**The attribution is not proof, and should not be read as it.** `decided_by`
records who a decision was submitted under, and nothing verifies it — there is
no user authentication, only a shared token on the endpoint. So the column is a
label. Anything running for real would need per-user auth before that field
could carry an audit claim, and the distinction matters precisely because the
human-in-the-loop story is the part a reviewer will lean on hardest.

---

## Rollout

How this would ship to a real CS team:

**Shadow mode first.** Run the engine nightly, store assessments, show nobody.
After a quarter, compare flagged accounts against actual churn. The replay
harness already does this; in production it would run on real outcomes rather
than a synthetic label.

**One team, then wider.** A single CSM pod for a quarter, with the explicit
question: did the worklist change what you did? Not "was the score accurate" —
a score nobody acts on is worthless regardless of accuracy.

**Investigations on flagged accounts only**, as now. The cost per investigation
is trivial; the cost of a CSM reading a paragraph about a healthy customer is
not.

**Audit sampling.** A flagged-only policy cannot detect under-flagging — you
learn nothing about what the engine misses by looking only at what it caught.
That weakness was found here by accident, and in production would need
deliberate sampling of low-risk accounts.

**Kill switch on the AI layer.** It can be turned off without affecting
triage, because the risk score never depended on it. That property was
designed, and it is what makes shipping the model layer low-risk.

## Metrics

**AI quality** — grounding rate, unsupported-claim rate, structured-output
validity, counter-case coverage, escalation and de-escalation rates against the
deterministic band. All computed from stored output, all reproducible.

**Product** — worklist open rate, proportion of recommendations accepted versus
edited versus rejected, and time from flag to first contact. A CSM editing
recommendations heavily is a more useful signal than one rejecting them
outright: rejection means wrong, editing means nearly right.

**Business** — churn rate among flagged-and-contacted accounts against
flagged-and-not-contacted, and revenue retained. The honest version of this
needs a holdout group, and any serious rollout should reserve one.

---

## Limitations

**The data is synthetic.** Fifty invented companies. Every number here says the
system behaves as designed on data shaped to contain the cases it targets. None
of it predicts performance on a real customer book.

**Ten churned accounts is a small denominator.** One account moving changes
recall by 10 percentage points. The lead-time table is a shape, not a
measurement.

**Four accounts were hand-authored** to make specific branches reachable — a
recent signup with too little history to judge, two active accounts in genuine
decline, and one given tickets so its grading had evidence to stand on. Any
metric including them is partly self-fulfilling and the reports say so.

**The AI grading measures support, not insight.** Every check asks whether a
claim is backed by evidence, not whether it is worth reading. A model that only
restated the evidence list would score perfectly. The offline provider exists
partly to make that visible: it scores well and is deliberately not an
investigation.

**The provider abstraction is half proven.** A second model,
`gemini-3.5-flash-lite`, now produces complete validated outreach drafts — and
could not before. The attempt surfaced a real portability bug: a config field
sent unconditionally that this model rejects outright, which is what made the
abstraction actually swappable rather than nominally so. It has still never
produced an *investigation*, so the claim holds for one of the two call types.

---

## What I would do differently

**Design the tables after the output, not before.** `investigations` was
written in an early phase assuming the model would summarise each data source
in turn. The useful decomposition turned out to be by argument — root cause,
evidence for, evidence against — because the finding that matters crosses
sources. Three columns were never written to and were eventually dropped.

**Expect measurement bugs, and read the outliers.** Two AI metrics were wrong
in ways that would have quietly misled: one scored model-versus-engine
disagreement as error, which would have marked the layer's entire contribution
as a defect; the other expected an "insufficient evidence" verdict whenever no
signal fired, which failed a healthy account with six months of clean records.
Abundant evidence of good news is not absent evidence. Both were found by
reading individual cases rather than the totals.

**Watch what a validation run writes.** An offline dry-run persisted
placeholder rows, three of which superseded real results, and the grader then
counted them as model output. That provider builds its citations from the
evidence package, so it cannot fail a grounding check — the headline was padded
with cases incapable of failing until it was caught.

**Cost constraints change the right answer.** Adding retries to a flaky API is
reflexively correct and was wrong here: failed attempts count against a
20-request daily quota, so retrying a persistent outage spent a third of the
day's budget to achieve nothing. The same code on a paid tier should retry.
