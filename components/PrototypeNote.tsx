/**
 * Required wherever placeholder risk data is shown. The status badges come from
 * `evaluation_cases` (evaluation ground truth), not from a live assessment, and
 * that has to be visible to anyone reading the screen.
 */
export function PrototypeNote({ children }: { children?: React.ReactNode }) {
  return (
    <div className="notice" role="note">
      <span className="notice-icon" aria-hidden="true">
        ⚑
      </span>
      <div>
        <strong>Placeholder data.</strong>{" "}
        {children ?? (
          <>
            Risk status and recommendations are read from the{" "}
            <code>evaluation_cases</code> table — evaluation ground truth
            standing in for output the Phase 4 risk engine and Phase 5
            investigation agent will produce. They are not live assessments.
          </>
        )}
      </div>
    </div>
  );
}
