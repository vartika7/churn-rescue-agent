import type { RiskSignal } from "@/lib/risk-engine";

/**
 * Renders the risk engine's signals split by direction.
 *
 * This used to render a separate set of UI-layer heuristics, which meant the
 * detail page showed two lists saying nearly the same thing with different
 * numbers. The engine's signals already carry a source, a headline, a detail
 * line and a direction, so they are the evidence — there is nothing to
 * translate, and the panel can show the points each one contributed.
 */
export function EvidencePanel({ signals }: { signals: RiskSignal[] }) {
  const supporting = signals.filter((s) => s.direction === "supporting");
  const contradicting = signals.filter((s) => s.direction === "contradicting");

  return (
    <div className="evidence-grid">
      <Column
        title="Supporting evidence"
        subtitle="argues the account is at risk"
        variant="supporting"
        signals={supporting}
        emptyText="No signal in usage, support or billing argues for risk."
      />
      <Column
        title="Contradicting evidence"
        subtitle="argues against risk"
        variant="contradicting"
        signals={contradicting}
        emptyText="Nothing checked came back clean — every signal points at risk."
      />
    </div>
  );
}

function Column({
  title,
  subtitle,
  variant,
  signals,
  emptyText,
}: {
  title: string;
  subtitle: string;
  variant: "supporting" | "contradicting";
  signals: RiskSignal[];
  emptyText: string;
}) {
  const points = signals.reduce((sum, s) => sum + s.points, 0);

  return (
    <section className="evidence-col">
      <header className={`evidence-head evidence-head-${variant}`}>
        <span>{title}</span>
        <span className="evidence-count">
          {signals.length} ·{" "}
          {variant === "supporting" && points > 0 ? `+${points} points · ` : ""}
          {subtitle}
        </span>
      </header>

      {signals.length === 0 ? (
        <p className="evidence-empty">{emptyText}</p>
      ) : (
        <ul className="evidence-list">
          {[...signals]
            .sort((a, b) => b.points - a.points)
            .map((signal) => (
              <li className="evidence-item" key={signal.key}>
                <div className="evidence-top">
                  <span className="tag">{signal.source}</span>
                  <span className="evidence-headline">{signal.headline}</span>
                  {signal.points > 0 && (
                    <span className="evidence-points mono">
                      +{signal.points}
                    </span>
                  )}
                </div>
                {signal.detail && (
                  <p className="evidence-detail">{signal.detail}</p>
                )}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
