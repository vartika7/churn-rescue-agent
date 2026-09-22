import type { StoredInvestigation } from "@/lib/investigation-store";
import type { Investigation } from "@/lib/investigation/schema";
import { formatDate } from "@/lib/format";

/**
 * Renders a stored investigation.
 *
 * Three rules this panel exists to enforce visually:
 *
 * 1. An offline placeholder is never shown as AI analysis. If it did not come
 *    from a model, the panel says so in the header, not in small print.
 * 2. Every claim shows what it cites. The citation ids are the audit trail —
 *    a CSM should be able to check any sentence against the evidence panel
 *    below it, and a claim whose citation they cannot find is a bug worth
 *    seeing.
 * 3. Contradicting evidence gets the same weight as supporting. Collapsing it
 *    or dropping it below a fold would turn an investigation back into a
 *    justification.
 */

export function InvestigationPanel({
  stored,
}: {
  stored: StoredInvestigation | null;
}) {
  if (!stored) {
    return (
      <section className="section">
        <h2 className="section-title">AI investigation</h2>
        <p className="evidence-empty">
          No investigation has run for this account yet. The risk score and
          evidence below are produced by the deterministic engine and do not
          depend on it.
        </p>
      </section>
    );
  }

  const investigation = stored.investigation as Investigation | null;
  if (!investigation) {
    return (
      <section className="section">
        <h2 className="section-title">AI investigation</h2>
        <p className="evidence-empty">
          The stored investigation could not be read.
        </p>
      </section>
    );
  }

  const offline = stored.provider === "mock";
  const grounding = stored.grounding_rate;

  return (
    <section className="section">
      <div className="investigation-head">
        <h2 className="section-title">AI investigation</h2>
        <div className="investigation-meta">
          {offline ? (
            <span className="badge badge-unknown">
              Offline placeholder — not model output
            </span>
          ) : (
            <span className="badge badge-healthy">
              {stored.provider} · {stored.model}
            </span>
          )}
          {grounding !== null && grounding < 1 ? (
            <span className="badge badge-intervene">
              {Math.round(grounding * 100)}% of citations resolved
            </span>
          ) : null}
          <span className="investigation-date">
            {formatDate(stored.created_at.slice(0, 10))}
          </span>
        </div>
      </div>

      {offline ? (
        <p className="evidence-empty">
          Generated without a language model, by restating the deterministic
          evidence. It does not interpret the support ticket text, which is the
          entire point of this layer. Set a provider to run a real
          investigation.
        </p>
      ) : null}

      <p className="investigation-lede">{investigation.riskInterpretation}</p>

      <div className="investigation-block">
        <h3 className="investigation-label">
          Root cause
          <span className="investigation-confidence">
            {investigation.rootCause.confidence} confidence
          </span>
        </h3>
        <p>{investigation.rootCause.hypothesis}</p>
        <Citations ids={investigation.rootCause.citations} />
      </div>

      {investigation.insufficientEvidence ? (
        <p className="investigation-warning">
          The model reported that the evidence is insufficient to determine a
          root cause. That is a valid answer, not a failure — treat the
          hypothesis above as unsupported.
        </p>
      ) : null}

      <div className="evidence-grid">
        <ClaimList
          title="Argues the account is at risk"
          claims={investigation.supporting}
          emptyNote="The model found nothing supporting the risk."
        />
        <ClaimList
          title="Argues against the risk"
          claims={investigation.contradicting}
          emptyNote="The model found nothing arguing against the risk. Worth reading sceptically — an investigation with no counter-case usually means it did not look."
        />
      </div>

      <div className="investigation-block">
        <h3 className="investigation-label">
          Recommended action
          <span
            className={`badge ${actionClass(investigation.recommendation.action)}`}
          >
            {actionLabel(investigation.recommendation.action)}
          </span>
        </h3>
        <p>{investigation.recommendation.reasoning}</p>
        <Citations ids={investigation.recommendation.citations} />
        <p className="investigation-approval">
          Recommendations are not acted on automatically. A CSM approves, edits
          or rejects before anything reaches the customer.
        </p>
      </div>

      <div className="investigation-block">
        <h3 className="investigation-label">What this cannot tell you</h3>
        <p>{investigation.limitations}</p>
      </div>
    </section>
  );
}

function ClaimList({
  title,
  claims,
  emptyNote,
}: {
  title: string;
  claims: Investigation["supporting"];
  emptyNote: string;
}) {
  return (
    <div className="investigation-block">
      <h3 className="investigation-label">
        {title}
        <span className="evidence-count">{claims.length}</span>
      </h3>
      {claims.length === 0 ? (
        <p className="evidence-empty">{emptyNote}</p>
      ) : (
        <ul className="claim-list">
          {claims.map((c, i) => (
            <li key={i}>
              <span>{c.statement}</span>
              <Citations ids={c.citations} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The audit trail. Shown inline so a claim and its basis stay together. */
function Citations({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <span className="citations">
      {ids.map((id) => (
        <code key={id} className="citation">
          {id}
        </code>
      ))}
    </span>
  );
}

function actionLabel(action: Investigation["recommendation"]["action"]) {
  switch (action) {
    case "intervene":
      return "Intervene";
    case "monitor":
      return "Monitor";
    case "no_action_needed":
      return "No action needed";
  }
}

function actionClass(action: Investigation["recommendation"]["action"]) {
  switch (action) {
    case "intervene":
      return "badge-intervene";
    case "monitor":
      return "badge-monitor";
    case "no_action_needed":
      return "badge-healthy";
  }
}
