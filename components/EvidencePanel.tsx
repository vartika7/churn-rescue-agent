import type { EvidenceItem, EvidenceSplit } from "@/lib/analysis";

export function EvidencePanel({ evidence }: { evidence: EvidenceSplit }) {
  return (
    <div className="evidence-grid">
      <Column
        title="Supporting evidence"
        subtitle="argues the account is at risk"
        variant="supporting"
        items={evidence.supporting}
        emptyText="No supporting signals found in usage, support or billing data."
      />
      <Column
        title="Contradicting evidence"
        subtitle="argues against risk"
        variant="contradicting"
        items={evidence.contradicting}
        emptyText="No contradicting signals found in usage, support or billing data."
      />
    </div>
  );
}

function Column({
  title,
  subtitle,
  variant,
  items,
  emptyText,
}: {
  title: string;
  subtitle: string;
  variant: "supporting" | "contradicting";
  items: EvidenceItem[];
  emptyText: string;
}) {
  return (
    <section className="evidence-col">
      <header className={`evidence-head evidence-head-${variant}`}>
        <span>{title}</span>
        <span className="evidence-count">
          {items.length} · {subtitle}
        </span>
      </header>

      {items.length === 0 ? (
        <p className="evidence-empty">{emptyText}</p>
      ) : (
        <ul className="evidence-list">
          {items.map((item, index) => (
            <li className="evidence-item" key={`${item.source}-${index}`}>
              <div className="evidence-top">
                <span className="tag">{item.source}</span>
                <span className="evidence-headline">{item.headline}</span>
              </div>
              {item.detail && <p className="evidence-detail">{item.detail}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
