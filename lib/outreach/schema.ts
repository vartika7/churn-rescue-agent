/* Pure — no credentials, importable by the test runner. See the note in
   lib/investigation/evidence.ts. */

/* ------------------------------------------------------------------ *
 * Phase 6 — the outreach draft
 *
 * A message a CSM might send, generated from an investigation that has
 * already been validated. Held to the same grounding discipline as the
 * investigation, and to two rules that only apply once text is pointed at a
 * customer rather than at a colleague:
 *
 *   - It must not mention the risk score, the signals, or that any of this was
 *     scored. A customer reading "our system rates you 70/100 churn risk" is a
 *     worse outcome than the churn.
 *   - It must not promise anything. Fixes, timelines, credits and discounts
 *     are commitments the company has not made, and a model has no standing to
 *     make them.
 *
 * Nothing here sends. There is no send path in the codebase at all — not a
 * disabled one, not one behind a flag. The draft is text on a screen until a
 * human copies it.
 * ------------------------------------------------------------------ */

export type OutreachStatus = "draft" | "approved" | "rejected";

export interface OutreachDraft {
  subject: string;
  body: string;
  /**
   * Evidence ids the message's claims rest on.
   *
   * Same rule as the investigation, and it matters more here: an internal note
   * citing something that does not exist wastes a CSM's afternoon, whereas a
   * customer email doing it is a credibility loss the company cannot take
   * back.
   */
  citations: string[];
  /** What the CSM should confirm before this goes anywhere. */
  checkBeforeSending: string;
}

export type DraftValidation =
  { ok: true; value: OutreachDraft } | { ok: false; errors: string[] };

const isStr = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

/**
 * Phrases that mean internal machinery has leaked into customer-facing text.
 *
 * Checked mechanically because a prompt instruction is not enforcement, and
 * because this is the failure with the worst blast radius in the whole
 * project: every other mistake is visible only to the team.
 */
const INTERNAL_LEAK = [
  /\brisk score\b/i,
  /\bchurn risk\b/i,
  /\bchurn\b/i,
  /\b\d{1,3}\s*\/\s*100\b/,
  /\bflagged\b/i,
  /\bat[- ]risk\b/i,
  /\bhealth score\b/i,
  /\bour (?:system|model|algorithm|tool)\b/i,
];

/** Commitments a model has no standing to make on the company's behalf. */
const UNAUTHORISED_PROMISE = [
  /\bwe(?:'| wi)ll (?:fix|resolve|ship|deliver|refund|credit)\b/i,
  /\bguarantee\b/i,
  /\bdiscount\b/i,
  /\brefund\b/i,
  /\bby (?:next|the end of) (?:week|month|quarter)\b/i,
];

export function validateDraft(
  raw: unknown,
  citable?: ReadonlySet<string>,
): DraftValidation {
  const errors: string[] = [];

  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFence(raw));
    } catch {
      return { ok: false, errors: ["response was not valid JSON"] };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, errors: ["response JSON was not an object"] };
    }
    obj = parsed as Record<string, unknown>;
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else {
    return { ok: false, errors: ["response was not an object"] };
  }

  if (!isStr(obj.subject)) errors.push("subject must be a non-empty string");
  if (!isStr(obj.body)) errors.push("body must be a non-empty string");
  if (!isStr(obj.checkBeforeSending)) {
    errors.push("checkBeforeSending must say what to verify before sending");
  }

  const citations = Array.isArray(obj.citations)
    ? (obj.citations.filter(isStr) as string[])
    : [];
  if (!Array.isArray(obj.citations)) errors.push("citations must be an array");
  if (citations.length === 0) {
    errors.push("citations must reference the evidence the message rests on");
  }

  const text = `${obj.subject ?? ""}\n${obj.body ?? ""}`;

  for (const pattern of INTERNAL_LEAK) {
    const hit = text.match(pattern);
    if (hit) {
      errors.push(
        `mentions internal scoring to the customer: "${hit[0]}" — the customer must never read that they were scored`,
      );
    }
  }
  for (const pattern of UNAUTHORISED_PROMISE) {
    const hit = text.match(pattern);
    if (hit) {
      errors.push(
        `makes a commitment nobody authorised: "${hit[0]}" — a draft may propose a conversation, not a remedy`,
      );
    }
  }

  if (citable) {
    const unknown = citations.filter((id) => !citable.has(id));
    if (unknown.length) {
      errors.push(
        `cites evidence that was never provided: ${[...new Set(unknown)].sort().join(", ")}`,
      );
    }
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      subject: obj.subject as string,
      body: obj.body as string,
      citations,
      checkBeforeSending: obj.checkBeforeSending as string,
    },
  };
}

/** Shared with the investigation validator: any provider may fence its JSON. */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

/**
 * How far a CSM moved the draft before approving it.
 *
 * Normalised Levenshtein over the body. This is the Phase 6 quality metric
 * that actually means something: a rejection says the draft was wrong, but
 * heavy editing says it was nearly right and is a more useful signal about
 * where drafting fails.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length] / Math.max(a.length, b.length);
}
