import type { StoredOutreach } from "@/lib/outreach-store";
import { formatDate } from "@/lib/format";

/**
 * Renders a drafted message and the decision recorded against it.
 *
 * Read-only by design. The approve / edit / reject actions post to
 * `/api/outreach`, which is token-guarded, and the page has no authentication
 * — so wiring buttons here would either mean shipping the token to the browser
 * or leaving the endpoint open. Neither is acceptable for something that
 * writes, so the decision is recorded through the API and this panel shows the
 * state.
 *
 * What the panel must make impossible to misread: that nothing was sent. The
 * word "approved" on its own invites the opposite assumption.
 */
export function OutreachPanel({ stored }: { stored: StoredOutreach | null }) {
  if (!stored) return null;

  const offline = stored.provider === "mock";
  const edited = Boolean(stored.edited_body || stored.edited_subject);
  const subject = stored.edited_subject ?? stored.subject ?? "";
  const body = stored.edited_body ?? stored.body ?? "";

  return (
    <section className="section">
      <div className="investigation-head">
        <h2 className="section-title">Suggested outreach</h2>
        <div className="investigation-meta">
          <StatusBadge status={stored.status} />
          {offline ? (
            <span className="badge badge-unknown">
              Offline placeholder — not model output
            </span>
          ) : null}
          {edited ? <span className="badge badge-monitor">Edited</span> : null}
          <span className="investigation-date">
            {formatDate(stored.created_at.slice(0, 10))}
          </span>
        </div>
      </div>

      {/* The single most important line in this component. */}
      <p className="outreach-notsent">
        Nothing is sent from here. This system has no outbound mail path;
        approving records a judgement, and a person still copies the text.
      </p>

      <div className="outreach-draft">
        <div className="outreach-subject">{subject}</div>
        <div className="outreach-body">{body}</div>
      </div>

      {edited ? (
        <details className="outreach-original">
          <summary>See the original draft before editing</summary>
          <div className="outreach-subject">{stored.subject}</div>
          <div className="outreach-body">{stored.body}</div>
        </details>
      ) : null}

      {stored.check_before_sending ? (
        <div className="investigation-block">
          <h3 className="investigation-label">Check before sending</h3>
          <p>{stored.check_before_sending}</p>
        </div>
      ) : null}

      {stored.decided_by ? (
        <p className="investigation-approval">
          {stored.status === "approved" ? "Approved" : "Rejected"} by{" "}
          <strong>{stored.decided_by}</strong>
          {stored.decided_at
            ? ` on ${formatDate(stored.decided_at.slice(0, 10))}`
            : null}
          . Not sent.
        </p>
      ) : (
        <p className="investigation-approval">
          Awaiting a decision. A CSM approves, edits or rejects this before it
          goes anywhere.
        </p>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  switch (status) {
    case "approved":
      // Deliberately not the green "healthy" treatment: approved is a step in
      // a workflow, not an outcome, and it has not been sent.
      return <span className="badge badge-monitor">Approved, not sent</span>;
    case "rejected":
      return <span className="badge badge-unknown">Rejected</span>;
    default:
      return <span className="badge badge-unknown">Draft</span>;
  }
}
