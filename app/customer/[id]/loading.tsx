/**
 * Customer detail loading state.
 *
 * Mirrors the real page: back link, header, metadata row, then the chart and
 * evidence blocks. The detail page fetches usage, tickets, charges, the
 * evaluation case, the outcome and any stored investigation in parallel, so
 * this is on screen for about as long as the dashboard's.
 */
export default function Loading() {
  return (
    <main className="page" aria-busy="true" aria-live="polite">
      <span className="back-link">← Back</span>
      <span className="sr-only">Loading this account…</span>

      <div className="detail-head" aria-hidden="true">
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-badge" />
      </div>

      <div className="meta-row" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <div className="meta-item" key={i}>
            <div className="skeleton skeleton-label" />
            <div className="skeleton skeleton-value" />
          </div>
        ))}
      </div>

      <div className="card card-pad" aria-hidden="true">
        <div className="skeleton skeleton-chart" />
      </div>

      <div className="card card-pad" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <div className="skeleton skeleton-row" key={i} />
        ))}
      </div>
    </main>
  );
}
