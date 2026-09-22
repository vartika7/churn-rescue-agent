/**
 * Dashboard loading state.
 *
 * Every page is `force-dynamic` and reads six tables on each request, which
 * takes roughly a second and a half. Without this the browser shows the
 * previous page — or nothing — for that whole time, and a demo looks broken
 * before it looks slow.
 *
 * The skeleton mirrors the real layout rather than being a spinner, so the
 * content does not jump when it arrives.
 */
export default function Loading() {
  return (
    <main className="page" aria-busy="true" aria-live="polite">
      <div className="page-head">
        <h1 className="page-title">Churn Rescue</h1>
        <p className="page-desc">Customer success · retention risk triage</p>
      </div>

      <span className="sr-only">Loading the account list…</span>

      <div className="stat-grid" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div className="stat" key={i}>
            <div className="skeleton skeleton-label" />
            <div className="skeleton skeleton-value" />
          </div>
        ))}
      </div>

      <div className="card card-pad" aria-hidden="true">
        <div className="skeleton skeleton-controls" />
        {Array.from({ length: 8 }, (_, i) => (
          <div className="skeleton skeleton-row" key={i} />
        ))}
      </div>
    </main>
  );
}
