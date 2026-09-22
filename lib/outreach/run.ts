/* Pure orchestration — providers are injected, no credentials read here. */

import { citableIds, type EvidencePackage } from "../investigation/evidence";
import { ProviderError, type InvestigationProvider } from "../investigation/provider";
import type { Investigation } from "../investigation/schema";
import { validateDraft, type OutreachDraft } from "./schema";

/* ------------------------------------------------------------------ *
 * Phase 6 — drafting outreach
 *
 * Drafting is a separate step from investigating, not another field on the
 * investigation, for two reasons. It matches the order a CSM actually works
 * in — decide there is a problem, then decide to write — and it means a draft
 * can be regenerated without re-running the investigation it rests on, which
 * matters at 20 model requests a day.
 *
 * The draft is built from an investigation that has already been validated, so
 * a message can never rest on a root cause that failed its own grounding
 * check.
 * ------------------------------------------------------------------ */

export const SYSTEM_PROMPT = `You draft short emails for a Customer Success Manager to send to a B2B SaaS customer. A colleague has already investigated the account; you are turning their findings into something a person can send.

You are writing to the CUSTOMER. They have not seen the investigation and must not learn it exists.

RULES

1. Never mention risk scoring. Not the score, not the signals, not that anything was flagged, measured or monitored. Do not use the words "churn", "at risk", "health score", or refer to "our system". The customer must never read that they were scored.
2. Promise nothing. You cannot commit the company to a fix, a timeline, a credit, a refund or a discount. Propose a conversation, not a remedy.
3. Ground every claim. Reference only things the investigation established, and cite the evidence ids they came from. Do not invent a meeting, a previous email, a named person, or a feature.
4. Lead with their problem, not your observation. "I saw your usage drop" is surveillance. "I noticed the workflow issue you raised in April is still open" is help.
5. Short. Four sentences or fewer in the body. A CSM will edit this, and a long draft is harder to edit than to rewrite.
6. Say what you are unsure of. The "checkBeforeSending" field is for the CSM: what should they confirm is true before this goes out.

OUTPUT

Reply with a single JSON object and nothing else.

{
  "subject": "a specific subject line, not 'Checking in'",
  "body": "the message, plain text, no greeting placeholder like [Name]",
  "citations": ["evidence-id", "..."],
  "checkBeforeSending": "what the CSM should verify first"
}`;

export function buildUserPrompt(
  pkg: EvidencePackage,
  investigation: Investigation,
): string {
  const lines: string[] = [];
  lines.push(`Customer: ${pkg.account.company} (${pkg.account.plan} plan)`);
  lines.push("");
  lines.push("WHAT THE INVESTIGATION FOUND");
  lines.push(`  Root cause: ${investigation.rootCause.hypothesis}`);
  lines.push(`  Confidence: ${investigation.rootCause.confidence}`);
  lines.push(`  Recommended action: ${investigation.recommendation.action}`);
  lines.push(`  Reasoning: ${investigation.recommendation.reasoning}`);
  if (investigation.insufficientEvidence) {
    lines.push(
      "  NOTE: the investigation could not determine a root cause. Write something that opens a conversation rather than asserting a diagnosis.",
    );
  }
  lines.push("");

  // Only the evidence the investigation actually leaned on. Handing over the
  // whole package invites the draft to mention things the investigation did
  // not conclude anything about.
  const cited = new Set([
    ...investigation.rootCause.citations,
    ...investigation.recommendation.citations,
    ...investigation.supporting.flatMap((c) => c.citations),
  ]);
  lines.push("EVIDENCE THE INVESTIGATION RELIED ON — cite by id");
  for (const item of pkg.items.filter((i) => cited.has(i.id))) {
    lines.push(`  [${item.id}] ${item.summary}`);
    if (item.detail) lines.push(`      ${item.detail}`);
  }
  lines.push("");
  lines.push(
    "Write the email. Remember the customer has not seen any of the above.",
  );
  return lines.join("\n");
}

export type DraftOutcome =
  | {
      ok: true;
      draft: OutreachDraft;
      provider: string;
      model: string;
      offline: boolean;
    }
  | {
      ok: false;
      stage: "provider" | "validation";
      errors: string[];
      retryable: boolean;
      raw?: string;
    };

export async function runDraft(options: {
  provider: InvestigationProvider;
  pkg: EvidencePackage;
  investigation: Investigation;
}): Promise<DraftOutcome> {
  const citable = citableIds(options.pkg);

  let text: string;
  let model: string;
  try {
    const res = await options.provider.complete({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(options.pkg, options.investigation),
      temperature: 0,
      maxOutputTokens: 1024,
    });
    text = res.text;
    model = res.model;
  } catch (err) {
    return {
      ok: false,
      stage: "provider",
      errors: [err instanceof Error ? err.message : String(err)],
      retryable: err instanceof ProviderError ? err.retryable : false,
    };
  }

  const validated = validateDraft(text, citable);
  if (!validated.ok) {
    // Not repaired. A draft that leaked the risk score or promised a refund is
    // not something to patch up and store — the failure is the point, and
    // Phase 7 should be able to count how often it happens.
    return {
      ok: false,
      stage: "validation",
      errors: validated.errors,
      retryable: false,
      raw: text,
    };
  }

  return {
    ok: true,
    draft: validated.value,
    provider: options.provider.name,
    model,
    offline: options.provider.name === "mock",
  };
}

/**
 * A draft built without a model, for when no provider is configured.
 *
 * Deliberately plain. It opens a conversation and asserts nothing, because a
 * template cannot read the investigation's nuance and should not pretend to.
 * Labelled offline wherever it is shown, like every other placeholder here.
 */
export function offlineDraft(
  pkg: EvidencePackage,
  investigation: Investigation,
): DraftOutcome {
  const cited = [
    ...investigation.rootCause.citations,
    ...investigation.recommendation.citations,
  ];
  const citations = cited.length ? [...new Set(cited)] : pkg.items.slice(0, 1).map((i) => i.id);

  return {
    ok: true,
    draft: {
      subject: `Following up on ${pkg.account.company}'s account`,
      body:
        `Hi — I wanted to check in and see how things are going with the platform. ` +
        `If there is anything getting in the way at the moment, I would like to hear about it ` +
        `and see what we can do. Would a short call this week or next suit you?`,
      citations,
      checkBeforeSending:
        "Generated offline without a language model: it is a generic check-in and does not reflect this account's situation. Rewrite before sending.",
    },
    provider: "mock",
    model: "offline-fixture",
    offline: true,
  };
}
