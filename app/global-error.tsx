"use client";

/**
 * Root error boundary.
 *
 * Only reached when the root layout itself fails, which is why it has to ship
 * its own <html> and <body> — at this point the layout that normally provides
 * them has not rendered. Styles may not have loaded either, so this leans on
 * inline styles rather than the stylesheet.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: "48px 24px",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          color: "#1a1a1a",
          background: "#fafafa",
        }}
      >
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>
          The application failed to start
        </h1>
        <p style={{ maxWidth: 560, lineHeight: 1.5 }}>
          This is a failure in the root layout rather than in any one page.
          Check that <code>SUPABASE_URL</code> and{" "}
          <code>SUPABASE_SERVICE_ROLE_KEY</code> are set in the environment.
        </p>
        <p style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
          {error.message}
        </p>
        <button
          onClick={reset}
          type="button"
          style={{
            marginTop: 12,
            padding: "8px 14px",
            border: "1px solid #ccc",
            borderRadius: 6,
            background: "#fff",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
