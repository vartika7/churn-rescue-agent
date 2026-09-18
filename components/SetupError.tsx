/**
 * Turns a missing-credentials or failed-query error into something actionable
 * rather than a blank error screen. The message is safe to render: it comes
 * from our own `Error` construction in lib/supabase.ts or from a PostgREST
 * message, neither of which contains the key itself.
 */
export function SetupError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    <main className="shell">
      <div className="error-box">
        <h2>Could not read from Supabase</h2>
        <p className="mono">{message}</p>
        <p>
          For local development, copy <code>env.example</code> to{" "}
          <code>.env.local</code> and fill in <code>SUPABASE_URL</code> and{" "}
          <code>SUPABASE_SERVICE_ROLE_KEY</code> from the Supabase dashboard,
          then restart <code>npm run dev</code>.
        </p>
        <p>
          For the deployed app, add the same two variables under Vercel →
          project → Settings → Environment Variables, then redeploy. A Supabase
          project on the free tier also auto-pauses after about a week of
          inactivity — if it has gone quiet, un-pause it in the Supabase
          dashboard.
        </p>
      </div>
    </main>
  );
}
