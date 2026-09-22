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
}

/** Reads config from the environment, or null when it is not configured. */
export function geminiConfigFromEnv(): GeminiConfig | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim();
  if (!apiKey || !model) return null;
  return { apiKey, model };
}

export class GeminiProvider implements InvestigationProvider {
  readonly name = "gemini";

  constructor(private readonly config: GeminiConfig) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const { apiKey, model, timeoutMs = DEFAULT_TIMEOUT_MS } = this.config;
    // Key travels as a header, not a query string: query strings end up in
    // logs, proxies and error messages.
    const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`;

    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.user }] }],
      generationConfig: {
        temperature: request.temperature ?? 0,
        maxOutputTokens: request.maxOutputTokens ?? 2048,
        responseMimeType: "application/json",
      },
    };

    let res: Response;
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
      if (err instanceof ProviderError) throw err;
      throw new ProviderError("Gemini request failed", err, true);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // 429 and 5xx are worth retrying; 400/401/403 mean the request or the
      // key is wrong and retrying just burns quota.
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(
        `Gemini returned ${res.status}${detail ? `: ${truncate(detail)}` : ""}`,
        undefined,
        retryable,
      );
    }

    const payload = (await res
      .json()
      .catch(() => null)) as GeminiResponse | null;
    if (!payload) throw new ProviderError("Gemini response was not JSON");

    const candidate = payload.candidates?.[0];
    const finish = candidate?.finishReason;
    if (finish && finish !== "STOP") {
      // MAX_TOKENS in particular yields truncated JSON, which would otherwise
      // surface as a confusing parse error several layers away.
      throw new ProviderError(`Gemini stopped early (${finish})`);
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
