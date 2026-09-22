import "server-only";

import {
  DEFAULT_TIMEOUT_MS,
  ProviderError,
  withTimeout,
  type CompletionRequest,
  type CompletionResult,
  type InvestigationProvider,
} from "./provider";
import { stripFence } from "./schema";

/* ------------------------------------------------------------------ *
 * Phase 5 — Gemini provider
 *
 * `server-only`, and the only module here that is: it reads the API key. An
 * accidental client import becomes a build error rather than a key in a
 * JavaScript bundle.
 *
 * Plain `fetch` against the REST endpoint rather than the SDK. One HTTP call
 * with a JSON body does not need a dependency, and the narrower the surface
 * the easier the swap to another provider.
 *
 * The model id is NOT hardcoded. `GEMINI_MODEL` must be set, and an unset
 * value fails loudly instead of silently pinning whatever was current when
 * this was written — free-tier model names and limits move, and a stale
 * default would fail at request time with a confusing 404.
 * ------------------------------------------------------------------ */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiConfig {
  apiKey: string;
  /** e.g. the current free-tier flash model. Comes from the environment. */
  model: string;
  timeoutMs?: number;
  /**
   * Internal reasoning budget, in tokens. Defaults to 0 — off.
   *
   * This is not a tuning knob, it is a correctness one. Thinking tokens are
   * charged against `maxOutputTokens`, so with the budget left to the model's
   * discretion a 2048 ceiling was consumed 1532 by reasoning and 500 by
   * output, truncating the JSON mid-object and failing validation. With
   * thinking off the same request finishes in 835 tokens total and parses.
   *
   * The task is interpretation and citation discipline over an evidence list
   * that is already structured, not multi-step deduction, so the reasoning
   * bought little and cost roughly four times the tokens — which matters on a
   * per-day free-tier quota. Raise it if root-cause quality turns out to need
   * it, and raise maxOutputTokens with it.
   */
  thinkingBudget?: number | null;
  /**
   * Attempts for retryable failures. Defaults to 1 — no retry.
   *
   * Retrying looks obviously right and is wrong on this tier. The free quota
   * is 20 requests per DAY and failed attempts count against it, so a batch of
   * three accounts retrying a persistent 503 three times each spent nine
   * requests, produced nothing, and exhausted the day. The 503s on this model
   * last minutes rather than milliseconds, so no backoff short enough to sit
   * inside a request outlives them.
   *
   * Raise it on a paid tier, where a retry costs a fraction of a cent instead
   * of 5% of the day's budget.
   */
  attempts?: number;
}

/**
 * Reads config from the environment, or null when it is not configured.
 *
 * GEMINI_THINKING_BUDGET accepts a token count, or "off" to omit the field
 * entirely. Omitting matters: gemini-3.5-flash-lite rejects thinkingConfig
 * outright with a bare "Request contains an invalid argument", so a provider
 * that always sends it is not actually swappable between models.
 */
export function geminiConfigFromEnv(): GeminiConfig | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim();
  if (!apiKey || !model) return null;

  const raw = process.env.GEMINI_THINKING_BUDGET?.trim().toLowerCase();
  const thinkingBudget =
    raw === undefined || raw === ""
      ? 0
      : raw === "off" || raw === "none"
        ? null
        : Number.isFinite(Number(raw))
          ? Number(raw)
          : 0;

  return { apiKey, model, thinkingBudget };
}

export class GeminiProvider implements InvestigationProvider {
  readonly name = "gemini";

  constructor(private readonly config: GeminiConfig) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const {
      apiKey,
      model,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      thinkingBudget = 0,
      attempts = 1,
    } = this.config;
    // Key travels as a header, not a query string: query strings end up in
    // logs, proxies and error messages.
    const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`;

    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.user }] }],
      generationConfig: {
        temperature: request.temperature ?? 0,
        // Headroom well past the ~630 tokens a full investigation needs, so a
        // verbose account does not truncate.
        maxOutputTokens: request.maxOutputTokens ?? 4096,
        responseMimeType: "application/json",
        // null omits the field. Some models reject it outright.
        ...(thinkingBudget === null
          ? {}
          : { thinkingConfig: { thinkingBudget } }),
      },
    };

    // The newest flash models returned 503 "high demand" on two separate
    // probes, so one retry is worth having. Bounded deliberately: a longer
    // backoff chain on a free tier just queues behind the same congestion.
    let res: Response | undefined;
    let lastError: ProviderError | undefined;

    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
      try {
        res = await withTimeout(
          fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify(body),
          }),
          timeoutMs,
          "Gemini request",
        );
      } catch (err) {
        lastError =
          err instanceof ProviderError
            ? err
            : new ProviderError("Gemini request failed", err, true);
        res = undefined;
      }

      if (res?.ok) break;

      if (res && !res.ok) {
        const detail = await res.text().catch(() => "");
        // 429 and 5xx are worth retrying; 400/401/403 mean the request or the
        // key is wrong and retrying just burns quota.
        const retryable = res.status === 429 || res.status >= 500;
        lastError = new ProviderError(
          `Gemini returned ${res.status}${detail ? `: ${truncate(detail)}` : ""}`,
          undefined,
          retryable,
        );
        res = undefined;
      }

      if (!lastError?.retryable || attempt === attempts) throw lastError;
      const backoff = 750 * 2 ** (attempt - 1) + Math.random() * 400;
      await new Promise((r) => setTimeout(r, backoff));
    }

    if (!res) throw lastError ?? new ProviderError("Gemini request failed");

    const payload = (await res
      .json()
      .catch(() => null)) as GeminiResponse | null;
    if (!payload) throw new ProviderError("Gemini response was not JSON");

    const candidate = payload.candidates?.[0];
    const finish = candidate?.finishReason;
    if (finish && finish !== "STOP") {
      // MAX_TOKENS in particular yields truncated JSON, which would otherwise
      // surface as a confusing parse error several layers away.
      const hint =
        finish === "MAX_TOKENS"
          ? " — raise maxOutputTokens, or lower thinkingBudget: reasoning tokens are charged against the same ceiling"
          : "";
      throw new ProviderError(`Gemini stopped early (${finish})${hint}`);
    }

    const text = candidate?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) throw new ProviderError("Gemini returned no text");

    return {
      text: stripFence(text),
      model,
      usage: {
        input: payload.usageMetadata?.promptTokenCount,
        output: payload.usageMetadata?.candidatesTokenCount,
      },
    };
  }
}

const truncate = (s: string, n = 300) =>
  s.length > n ? `${s.slice(0, n)}…` : s;

interface GeminiResponse {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string }[] };
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}
