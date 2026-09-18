import Link from "next/link";

export default function NotFound() {
  return (
    <main className="shell">
      <div className="card card-pad">
        <h1 className="page-title">Not found</h1>
        <p className="page-desc">
          No account exists at that address. It may have been removed from the{" "}
          <span className="mono">customers</span> table.
        </p>
        <p style={{ marginTop: 14 }}>
          <Link href="/">← Back to all accounts</Link>
        </p>
      </div>
    </main>
  );
}
