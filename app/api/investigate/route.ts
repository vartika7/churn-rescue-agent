import { NextResponse } from "next/server";

import { saveInvestigation } from "@/lib/investigation-store";
import { selectProvider } from "@/lib/investigation/factory";
import {
  offlineInvestigation,
  runInvestigation,
  shouldPersist,
} from "@/lib/investigation/run";
import {
  fetchCustomer,
  fetchCustomerSubscriptions,
  fetchCustomerTickets,
  fetchCustomerUsage,
} from "@/lib/queries";
import { scoreCustomer } from "@/lib/risk-engine";
import { getLatestRecordedDate } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * Runs the Phase 5 investigation for one customer and appends the result.
 *
 * POST because it writes and costs money, token-guarded with the same
 * ASSESS_TOKEN as /api/assess because the deployment is public, and 503 when
 * the token is unset so an unset secret fails closed rather than silently
 * opening the route.
 *
 * `?offline=1` forces the offline path even when a provider is configured, so
 * the pipeline can be exercised without spending quota.
 *
 * Deliberately one customer per request. Investigating all 40 in one call
 * would sit far past any sane serverless timeout, and a partial failure
 * halfway through a batch is worse than 40 independent outcomes.
 *
 * NO DEDUPLICATION, also deliberately. Every accepted call appends a row, even
 * if the account was investigated a minute ago. This route is the mechanism;
 * which accounts to investigate and how often is policy, and it lives in
 * scripts/investigate.ts — the same split that keeps `scoreCustomer` free of
 * any opinion about which customers to score.
 *
 * Re-running is a real use: after a prompt change, after the dataset shifts,
 * or to compare two models on one account. A route that refused would need a
 * bypass flag and end up back here with more code. The consequence to know is
 * that calling this in a loop will spend the day's quota, so batch through the
 * script, which skips accounts that already have a live investigation.
 */
export async function POST(request: Request) {
  const expected = process.env.ASSESS_TOKEN;
  if (!expected) {
    return NextResponse.json(
      {
        error:
          "ASSESS_TOKEN is not set, so this route is disabled. Set it in the environment to enable investigations.",
      },
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
  const customerId = url.searchParams.get("customer")?.trim();
  const forceOffline = url.searchParams.get("offline") === "1";
  const saveParam = url.searchParams.get("save");

  if (!customerId) {
    return NextResponse.json({ error: "Pass ?customer=C001" }, { status: 400 });
  }

  try {
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

    // The investigation sees exactly what the live scoring path sees. No
    // outcome is fetched here, and `buildEvidencePackage` has no parameter
    // for one even if it were.
    const assessment = scoreCustomer({ usage, tickets, subscriptions });

    const input = {
      customerId,
      company: customer.company,
      plan: customer.plan,
      mrr: customer.mrr,
      industry: customer.industry,
      companySize: customer.company_size,
      signupDate: customer.signup_date,
      recordedThrough: getLatestRecordedDate(usage),
      assessment,
      tickets,
      charges: subscriptions,
    };

    const choice = selectProvider();
    const outcome =
      forceOffline || !choice.configured
        ? offlineInvestigation(input)
        : await runInvestigation({ provider: choice.provider, input });

    // An offline result is a placeholder, not an investigation, and is stored
    // only when explicitly asked for — see shouldPersist.
    const persist = shouldPersist(outcome, saveParam);
    if (persist) {
      await saveInvestigation(customerId, outcome);
    }

    if (!outcome.ok) {
      return NextResponse.json(
        {
          customerId,
          ok: false,
          stage: outcome.stage,
          errors: outcome.errors,
          retryable: outcome.retryable,
          // Returned so a validation failure can be diagnosed without
          // re-running the call; never persisted.
          raw: outcome.stage === "validation" ? outcome.raw : undefined,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      customerId,
      ok: true,
      offline: outcome.offline,
      provider: outcome.provider,
      model: outcome.model,
      grounding: outcome.grounding,
      usage: outcome.usage,
      persisted: persist,
      providerNote: choice.configured ? undefined : choice.reason,
      investigation: outcome.investigation,
      ranAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
