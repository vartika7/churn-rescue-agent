/* No `import "server-only"` here, deliberately. This module is pure — it reads
   no environment variable and holds no credential — and it has to be importable
   by the test runner, which does not resolve Next's `server-only` shim. The
   guard belongs on the provider implementation that reads the API key, not on
   functions that transform data. */

/* ------------------------------------------------------------------ *
 * Phase 5 — provider abstraction
 *
 * The application talks to this interface, never to a vendor SDK. Swapping
 * Gemini for Claude means adding a file next to `gemini.ts`, not touching the
 * route, the prompt, the validator or the UI.
 *
 * Deliberately narrow: one method, text in and text out. Everything that
 * actually matters — the prompt, the schema, grounding checks, persistence —
 * lives on our side of this line, so it is provider-independent by
 * construction and testable with no network. A wider interface that exposed
 * tool-calling or streaming would drag vendor concepts into the core and is
 * not needed to answer "why is this account at risk".
 * ------------------------------------------------------------------ */

export interface CompletionRequest {
  /** Instructions and constraints. Stable across customers. */
  system: string;
  /** The evidence package, rendered. Varies per customer. */
  user: string;
  /** Upper bound on response length, in provider-native units. */
  maxOutputTokens?: number;
  /** 0 for the most reproducible output we can ask for. */
  temperature?: number;
}

export interface CompletionResult {
  text: string;
  /** Provider and model actually used, recorded alongside the investigation. */
  model: string;
  /** Token counts when the provider reports them; for cost sanity only. */
  usage?: { input?: number; output?: number };
}

export interface InvestigationProvider {
  /** Short stable identifier, e.g. "gemini" or "mock". Persisted. */
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    /** True when retrying the same request might succeed. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Wraps a call with a hard timeout.
 *
 * A dashboard that hangs because a model is slow is worse than one that says
 * the investigation is unavailable — the deterministic risk score is already
 * on screen and is the part a CSM needs to triage.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ProviderError(
                `${label} timed out after ${ms}ms`,
                undefined,
                true,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const DEFAULT_TIMEOUT_MS = 30_000;
