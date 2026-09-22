import { NextResponse } from "next/server";

import { fetchLatestInvestigation } from "@/lib/investigation-store";
import { buildEvidencePackage } from "@/lib/investigation/evidence";
import { selectProvider } from "@/lib/investigation/factory";
import { validateInvestigation } from "@/lib/investigation/schema";
import { decideOutreach, saveDraft } from "@/lib/outreach-store";
import { offlineDraft, runDraft } from "@/lib/outreach/run";
import {
  fetchCustomer,
  fetchCustomerSubscriptions,
  fetchCustomerTickets,
  fetchCustomerUsage,
} from "@/lib/queries";
import { scoreCustomer } from "@/lib/risk-engine";
import { getLatestRecordedDate } from "@/lib/time";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Phase 6. Two operations, both token-guarded:
 *
 *   POST /api/outreach?customer=C035         draft a message from the stored
 *                                            investigation
 *   POST /api/outreach?id=12&decision=approved&by=Vartika
 *                                            record a human decision
 *
 * There is no send. Not a disabled one, not one behind a flag — the codebase
 * has no outbound mail path at all, and `approved` records only that a person
 * judged the draft fit to send.
 *
 * Drafting requires an existing investigation rather than running one: a
 * message to a customer should rest on a root cause that has already passed
 * its own grounding check, not on one produced in the same breath.
 */
export async function POST(request: Request) {
  const expected = process.env.ASSESS_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: "ASSESS_TOKEN is not set, so this route is disabled." },
      { status: 503 },
    );
  }
  const provided = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  if (provided !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);

  /* --- Recording a decision ------------------------------------------ */
  const idParam = url.searchParams.get("id");
  if (idParam) {
    const decision = url.searchParams.get("decision");
    const by = url.searchParams.get("by")?.trim();
    if (decision !== "approved" && decision !== "rejected") {
      return NextResponse.json(
        { error: "decision must be approved or rejected" },
        { status: 400 },
      );
    }
    if (!by) {
      // A decision with nobody attached to it is not a human-in-the-loop
      // record, it is an audit gap.
      return NextResponse.json(
        { error: "pass &by=<name> — a decision needs a person attached" },
        { status: 400 },
      );
    }
    try {
      await decideOutreach({
        id: Number(idParam),
        status: decision,
        decidedBy: by,
        editedSubject: url.searchParams.get("subject"),
        editedBody: url.searchParams.get("body"),
      });
      return NextResponse.json({
        id: Number(idParam),
        status: decision,
        decidedBy: by,
        sent: false,
        note: "Recorded only. Nothing was sent — this system has no send path.",
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }

  /* --- Drafting ------------------------------------------------------- */
  const customerId = url.searchParams.get("customer")?.trim();
  if (!customerId) {
    return NextResponse.json(
      { error: "Pass ?customer=C035 to draft, or ?id=&decision= to decide" },
      { status: 400 },
    );
  }
  const forceOffline = url.searchParams.get("offline") === "1";
  const persist = url.searchParams.get("save") !== "0";

  try {
    const stored = await fetchLatestInvestigation(customerId);
    if (!stored) {
      return NextResponse.json(
        {
          error: `No investigation stored for ${customerId}. Run one first — a message should rest on a validated root cause.`,
        },
        { status: 409 },
      );
    }

    const customer = await fetchCustomer(customerId);
    if (!customer) {
      return NextResponse.json(
        { error: `No such customer: ${customerId}` },
        { status: 404 },
      );
    }

    const [usage, tickets, subscriptions] = await Promise.all([
      fetchCustomerUsage(customerId),
      fetchCustomerTickets(customerId),
      fetchCustomerSubscriptions(customerId),
    ]);

    const pkg = buildEvidencePackage({
      customerId,
      company: customer.company,
      plan: customer.plan,
      mrr: customer.mrr,
      industry: customer.industry,
      companySize: customer.company_size,
      signupDate: customer.signup_date,
      recordedThrough: getLatestRecordedDate(usage),
      assessment: scoreCustomer({ usage, tickets, subscriptions }),
      tickets,
      charges: subscriptions,
    });

    // Re-validated rather than trusted: the stored row may predate a schema
    // change, and drafting from a malformed investigation is how an
    // unsupported claim reaches a customer.
    const investigation = validateInvestigation(stored.investigation);
    if (!investigation.ok) {
      return NextResponse.json(
        {
          error: "The stored investigation no longer validates.",
          errors: investigation.errors,
        },
        { status: 409 },
      );
    }

    const choice = selectProvider();
    const outcome =
      forceOffline || !choice.configured
        ? offlineDraft(pkg, investigation.value)
        : await runDraft({
            provider: choice.provider,
            pkg,
            investigation: investigation.value,
          });

    if (!outcome.ok) {
      return NextResponse.json(
        {
          customerId,
          ok: false,
          stage: outcome.stage,
          errors: outcome.errors,
          raw: outcome.stage === "validation" ? outcome.raw : undefined,
        },
        { status: 502 },
      );
    }

    // Offline drafts follow the same rule as offline investigations: a
    // placeholder is not stored unless explicitly asked for.
    const shouldStore = outcome.offline
      ? url.searchParams.get("save") === "1"
      : persist;
    const id = shouldStore
      ? await saveDraft(
          customerId,
          investigation.value.recommendation.action,
          outcome,
        )
      : null;

    return NextResponse.json({
      customerId,
      ok: true,
      id,
      persisted: Boolean(id),
      offline: outcome.offline,
      provider: outcome.provider,
      model: outcome.model,
      recommendedAction: investigation.value.recommendation.action,
      draft: outcome.draft,
      sent: false,
      note: "Draft only. Nothing is sent by this system.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
