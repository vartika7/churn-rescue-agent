import Link from "next/link";
import { notFound } from "next/navigation";

import { EvidencePanel } from "@/components/EvidencePanel";
import { PrototypeNote } from "@/components/PrototypeNote";
import { SetupError } from "@/components/SetupError";
import { UsageChart } from "@/components/UsageChart";
import { buildEvidence } from "@/lib/analysis";
import { formatCurrency, formatDate } from "@/lib/format";
import { getLatestRecordedDate, renewalCountdown } from "@/lib/time";
import {
  recommendationBadgeClass,
  recommendationLabel,
  parseRecommendation,
  retrospectiveBadge,
} from "@/lib/placeholder-risk";
import {
  fetchCustomer,
  fetchCustomerOutcome,
  fetchCustomerSubscriptions,
  fetchCustomerTickets,
  fetchCustomerUsage,
  fetchPlaceholderRiskCase,
} from "@/lib/queries";

/** See the note in app/page.tsx — edits in Supabase must show on a refresh. */
export const dynamic = "force-dynamic";

export default async function CustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let customer, usage, tickets, subscriptions, riskCase, outcome;

  try {
    customer = await fetchCustomer(id);
    if (!customer) notFound();

    [usage, tickets, subscriptions, riskCase, outcome] = await Promise.all([
      fetchCustomerUsage(id),
      fetchCustomerTickets(id),
      fetchCustomerSubscriptions(id),
      fetchPlaceholderRiskCase(id),
      fetchCustomerOutcome(id),
    ]);
  } catch (error) {
    // `notFound()` signals via a thrown control-flow error; let it through
    // instead of reporting a missing customer as a Supabase failure.
    if (isNextControlFlowError(error)) throw error;
    return <SetupError error={error} />;
  }

  const recommendation = parseRecommendation(riskCase?.expected_recommendation);
  // Renewal countdown: real wall-clock time. The usage anchor below is a
  // different reference point entirely — see lib/time.ts.
  const countdown = renewalCountdown(customer.renewal_date);
  const recordedThrough = getLatestRecordedDate(usage);
  const evidence = buildEvidence(usage, tickets, subscriptions);

  // A churned account gets past-tense framing throughout: no present-tense
  // "Intervene" badge, and no renewal countdown — since migration 17 its
  // renewal_date equals its outcome_date, so a countdown would just restate
  // the churn date as though a contract were still running.
  const isChurned = (outcome?.outcome ?? "").toLowerCase() !== "retained";
  const retrospective = isChurned
    ? retrospectiveBadge(recommendation, riskCase?.case_type)
    : null;

  return (
    <main className="shell">
      <Link className="back-link" href={isChurned ? "/?view=lost" : "/"}>
        ← {isChurned ? "Lost accounts" : "Active worklist"}
      </Link>

      <div className="detail-head">
        <div>
          <h1 className="page-title">{customer.company}</h1>
          <p className="page-desc">
            <span className="mono">{customer.customer_id}</span> ·{" "}
            {customer.industry} · {customer.company_size}
          </p>
        </div>
        {retrospective ? (
          <span className={retrospective.className}>{retrospective.label}</span>
        ) : (
          <span className={recommendationBadgeClass(recommendation)}>
            {recommendationLabel(recommendation)}
          </span>
        )}
      </div>

      {isChurned && (
        <div className="notice notice-lost" role="note">
          <span className="notice-icon" aria-hidden="true">
            ⌧
          </span>
          <div>
            <strong>
              This account churned
              {outcome ? ` on ${formatDate(outcome.outcome_date)}` : ""}.
            </strong>{" "}
            Everything below is retrospective analysis, not a live worklist item
            — the account is gone, and a win-back is a different motion with
            different messaging. {retrospective?.explanation}
            {outcome?.reason ? ` Recorded reason: ${outcome.reason}.` : ""}
          </div>
        </div>
      )}

      <div className="meta-row">
        <div className="meta-item">
          <div className="meta-label">Plan</div>
          <div className="meta-value">{customer.plan}</div>
        </div>
        <div className="meta-item">
          <div className="meta-label">MRR</div>
          <div className="meta-value mono">{formatCurrency(customer.mrr)}</div>
        </div>
        <div className="meta-item">
          <div className="meta-label">Company size</div>
          <div className="meta-value">{customer.company_size}</div>
        </div>
        <div className="meta-item">
          <div className="meta-label">Signed up</div>
          <div className="meta-value mono">
            {formatDate(customer.signup_date)}
          </div>
        </div>
        {isChurned ? (
          <div className="meta-item">
            <div className="meta-label">Churned</div>
            <div className="meta-value mono">
              {outcome ? formatDate(outcome.outcome_date) : "unknown"}
            </div>
          </div>
        ) : (
          <div className="meta-item">
            <div className="meta-label">Next renewal</div>
            <div className={`meta-value mono renewal-${countdown.status}`}>
              {formatDate(customer.renewal_date)}
              <span className="cell-sub"> · {countdown.label}</span>
            </div>
          </div>
        )}
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Usage trend</h2>
          <span className="section-note">
            Daily sessions across all observed history
            {recordedThrough ? `, through ${formatDate(recordedThrough)}` : ""}
          </span>
        </div>
        <div className="card card-pad">
          <UsageChart data={usage} />
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Evidence</h2>
          <span className="section-note">
            Computed from this account&apos;s usage, support and billing records
          </span>
        </div>
        <PrototypeNote>
          These items come from a fixed set of threshold rules in the UI layer,
          not from an AI investigation. They stand in for the Phase 5
          investigation agent and the thresholds are provisional. They read only
          usage, support and billing data — never the outcome — so on a churned
          account they show what was visible <em>before</em> it left. The badge
          above is separately read from <code>evaluation_cases</code>.
        </PrototypeNote>
        <EvidencePanel evidence={evidence} />
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Support tickets</h2>
          <span className="section-note">
            {tickets.length === 0
              ? "None on record"
              : `${tickets.length} on record, most recent first`}
          </span>
        </div>
        <div className="card">
          {tickets.length === 0 ? (
            <p className="evidence-empty">
              No support tickets for this account.
            </p>
          ) : (
            tickets.map((ticket) => (
              <article className="ticket" key={ticket.ticket_id}>
                <div className="ticket-head">
                  <h3 className="ticket-subject">{ticket.subject}</h3>
                  <span className="ticket-date mono">
                    {formatDate(ticket.date)}
                  </span>
                </div>
                {ticket.description && (
                  <p className="ticket-desc">{ticket.description}</p>
                )}
                <div className="tag-row">
                  <span className="tag">{ticket.category}</span>
                  <span className={`tag ${sentimentClass(ticket.sentiment)}`}>
                    {ticket.sentiment}
                  </span>
                  <span
                    className={`tag ${statusClass(ticket.resolution_status)}`}
                  >
                    {ticket.resolution_status}
                  </span>
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Billing history</h2>
          <span className="section-note">
            {subscriptions.length} charge events, most recent first
          </span>
        </div>
        <div className="card">
          {/* These rows are billing-cycle charges, not contract renewals — the
              next renewal is customers.renewal_date, shown above. */}
          <p className="billing-note">
            Each row is a billing charge on the subscription, not a contract
            renewal.{" "}
            {isChurned
              ? "Charges stop at the churn date; this account has no next renewal."
              : `The next contract renewal is ${formatDate(customer.renewal_date)}.`}
          </p>
          {subscriptions.length === 0 ? (
            <p className="evidence-empty">No billing charges on record.</p>
          ) : (
            <div
              className="table-wrap"
              style={{ border: "none", borderRadius: 0 }}
            >
              <table className="grid" style={{ minWidth: "560px" }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Event</th>
                    <th>Plan</th>
                    <th className="num-cell">Amount</th>
                    <th>Payment status</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((row) => (
                    <tr
                      key={`${row.date}-${row.change_type}-${row.mrr}`}
                      style={{ cursor: "default" }}
                    >
                      <td className="mono">{formatDate(row.date)}</td>
                      <td>
                        Billing charge
                        {chargeNote(row.change_type) && (
                          <div className="cell-sub">
                            {chargeNote(row.change_type)}
                          </div>
                        )}
                      </td>
                      <td>{row.plan}</td>
                      <td className="num-cell mono">
                        {formatCurrency(row.mrr)}
                      </td>
                      <td>
                        <span
                          className={`tag ${paymentClass(row.payment_status)}`}
                        >
                          {row.payment_status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function normalise(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * `subscriptions.change_type` reads "renewal" on 140 of the 143 rows, but these
 * are billing-cycle charges, and surfacing that word is exactly the labelling
 * that caused real confusion before. An ordinary recurring charge therefore
 * gets no extra note — only genuinely different events do.
 */
function chargeNote(changeType: string): string | null {
  switch (normalise(changeType)) {
    case "renewal":
    case "none":
    case "":
      return null;
    case "new":
      return "First charge";
    case "upgrade":
      return "Plan upgrade";
    case "downgrade":
      return "Plan downgrade";
    default: {
      const cleaned = changeType.replace(/_/g, " ").trim();
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }
  }
}

function sentimentClass(sentiment: string): string {
  const value = normalise(sentiment);
  if (value === "positive") return "tag-positive";
  if (value === "negative" || value === "frustrated" || value === "angry") {
    return "tag-negative";
  }
  return "";
}

function statusClass(status: string): string {
  const value = normalise(status);
  if (value === "resolved" || value === "closed") return "tag-positive";
  if (value === "escalated") return "tag-negative";
  if (value === "unresolved" || value === "open" || value === "pending")
    return "tag-warn";
  return "";
}

function paymentClass(status: string): string {
  const value = normalise(status);
  if (value === "paid" || value === "current" || value === "active")
    return "tag-positive";
  if (
    value === "past_due" ||
    value === "payment_failed" ||
    value === "failed"
  ) {
    return "tag-negative";
  }
  return "";
}

/**
 * Next signals `notFound()` by throwing, so a blanket catch would otherwise
 * swallow it and render a Supabase error for a customer that simply is not there.
 */
function isNextControlFlowError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_")
  );
}
