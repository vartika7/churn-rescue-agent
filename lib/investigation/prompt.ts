/* No `import "server-only"` here, deliberately. This module is pure — it reads
   no environment variable and holds no credential — and it has to be importable
   by the test runner, which does not resolve Next's `server-only` shim. The
   guard belongs on the provider implementation that reads the API key, not on
   functions that transform data. */

import type { EvidencePackage } from "./evidence";
import { ACTIONS } from "./schema";

/* ------------------------------------------------------------------ *
 * Phase 5 — the prompt
 *
 * Kept in its own module because it is the part most likely to change on
 * evidence, and because a prompt buried in a route handler cannot be
 * diffed, reviewed or tested.
 *
 * Note what the prompt does NOT do: it never states the outcome, because it
 * cannot — `EvidencePackage` has no field for it. The instructions below are
 * about behaviour, not secrecy.
 * ------------------------------------------------------------------ */

export const SYSTEM_PROMPT = `You are an analyst supporting a B2B SaaS Customer Success team. A deterministic risk engine has already scored this account and assembled an evidence package. Your job is to explain WHY the account is where it is, and what to do about it.

You are not scoring the account. The score is given and is not yours to revise.

RULES

1. Ground every claim. Each claim must cite the id of the evidence it rests on. Never cite an id that does not appear in the evidence package.
2. Invent nothing. Do not refer to conversations, features, meetings, competitors, contract terms or events that are not in the package. If you find yourself needing a fact you were not given, that is a limitation to report, not a gap to fill.
3. Argue both ways. Populate "contradicting" with the genuine case against the risk hypothesis. If usage is down but support is clean and billing has never failed, say so. An investigation that only agrees with the score is not useful.
4. Read the ticket text. Support ticket subjects and descriptions are the richest thing in the package and the part the rules could only count, not interpret. A ticket about admins locked out of their accounts means something different from one about an export format.
5. Admit uncertainty. If the evidence will not support a root cause, set "insufficientEvidence" to true, say what is missing in "limitations", and do not manufacture a hypothesis. "Too little history to judge" is a valid and useful answer.
6. Do not infer the outcome. You are not told whether this customer stayed or left, and you must not guess. Write as though the account is live and the decision is still open, because that is the situation this is used in.

OUTPUT

Reply with a single JSON object and nothing else. No markdown fences, no commentary.

{
  "riskInterpretation": "what the score means for this account, in plain language a CSM can act on",
  "rootCause": {
    "hypothesis": "the most likely explanation, or why none can be determined",
    "confidence": "high | medium | low",
    "citations": ["evidence-id", "..."]
  },
  "supporting": [
    { "statement": "a claim that the account is at risk", "citations": ["evidence-id"] }
  ],
  "contradicting": [
    { "statement": "a claim that argues against the risk", "citations": ["evidence-id"] }
  ],
  "recommendation": {
    "action": ${ACTIONS.map((a) => `"${a}"`).join(" | ")},
    "reasoning": "why this action, tied to the evidence",
    "citations": ["evidence-id"]
  },
  "limitations": "what this evidence cannot tell you",
  "insufficientEvidence": false
}

Every citation must be an exact id from the EVIDENCE list. Claims without citations are rejected.`;

/** Renders the package. Ids are printed prominently because they get cited. */
export function renderEvidence(pkg: EvidencePackage): string {
  const lines: string[] = [];

  lines.push(`ACCOUNT`);
  lines.push(`  company: ${pkg.account.company}`);
  lines.push(`  plan: ${pkg.account.plan} at $${pkg.account.mrr}/mo`);
  lines.push(`  industry: ${pkg.account.industry}`);
  lines.push(`  size: ${pkg.account.companySize}`);
  lines.push(`  customer for: ${pkg.account.tenureDays} days`);
  lines.push("");

  lines.push(`DETERMINISTIC RISK ASSESSMENT (given; do not revise)`);
  lines.push(`  level: ${pkg.risk.level}`);
  lines.push(`  score: ${pkg.risk.score}/100`);
  lines.push(`  engine confidence: ${pkg.risk.confidence}`);
  lines.push(`  engine summary: ${pkg.risk.reason}`);
  lines.push(
    `  observation window: ${pkg.usage.observedDays} days on record` +
      (pkg.usage.from ? `, ${pkg.usage.from} to ${pkg.usage.to}` : ""),
  );
  lines.push("");

  lines.push(`EVIDENCE — cite by id`);
  const byKind = (kind: EvidencePackage["items"][number]["kind"]) =>
    pkg.items.filter((i) => i.kind === kind);

  const section = (title: string, items: EvidencePackage["items"]) => {
    if (items.length === 0) return;
    lines.push(`  ${title}`);
    for (const i of items) {
      const dir =
        i.direction && i.direction !== "neutral" ? ` [${i.direction}]` : "";
      lines.push(`    [${i.id}]${dir} ${i.summary}`);
      if (i.detail) lines.push(`        ${i.detail}`);
    }
    lines.push("");
  };

  section("Signals measured by the risk engine:", byKind("signal"));
  section("Support tickets (read the text):", byKind("ticket"));
  section("Billing history:", byKind("charge"));

  if (byKind("ticket").length === 0) {
    lines.push(
      `  No support tickets on record. That is an absence of evidence, not evidence of health.`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

export function buildUserPrompt(pkg: EvidencePackage): string {
  return `Investigate ${pkg.customerId}.\n\n${renderEvidence(pkg)}`;
}
