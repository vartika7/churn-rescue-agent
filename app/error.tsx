"use client";

/**
 * Route error boundary.
 *
 * `SetupError` already handles the expected failure — Supabase unreachable or
 * misconfigured — with an explanation of which variables to set. This catches
 * everything else, so an unexpected throw shows something readable instead of
 * Next's default stack page.
 *
 * It offers a retry because the most likely causes here are transient: a
 * dropped connection, a cold database, a request that timed out.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="page">
      <div className="error-box">
        <h1 className="page-title">Something went wrong</h1>
        <p>
          This page could not be rendered. The risk data itself is unaffected —
          nothing here writes to the database.
        </p>
        <p className="mono error-detail">{error.message}</p>
        {error.digest ? (
          <p className="cell-sub">
            Reference: <code>{error.digest}</code>
          </p>
        ) : null}
        <button className="button" onClick={reset} type="button">
          Try again
        </button>
      </div>
    </main>
  );
}
