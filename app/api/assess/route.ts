import { NextResponse } from "next/server";

import { assessActiveCustomers } from "@/lib/risk-store";

export const dynamic = "force-dynamic";

/**
 * Scores all 40 active customers in one request, reading five tables first.
 * Roughly a second and a half warm, but a cold function plus a cold database
 * is a different number, so the limit is raised rather than left at whatever
 * the platform defaults to.
 */
export const maxDuration = 60;

/**
 * Re-runs the Phase 4 risk engine over every active customer and appends the
 * results to `risk_assessments`.
 *
 * POST rather than GET because it writes, and token-guarded because the
 * deployment is public: without the guard anyone who found the URL could
 * append rows. Set ASSESS_TOKEN in the environment and send it as
 * `Authorization: Bearer <token>`.
 *
 * If ASSESS_TOKEN is unset the route refuses outright rather than defaulting
 * to open — an unset secret should fail closed, not silently disable the lock.
 */
export async function POST(request: Request) {
  const expected = process.env.ASSESS_TOKEN;
  if (!expected) {
    return NextResponse.json(
      {
        error:
          "ASSESS_TOKEN is not set, so this route is disabled. Set it in the environment to enable re-scoring.",
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

  try {
    const { assessed, skippedChurned, results } = await assessActiveCustomers();

    const byLevel = { high: 0, medium: 0, low: 0 } as Record<string, number>;
    for (const r of results) byLevel[r.assessment.riskLevel]++;

    return NextResponse.json({
      assessed,
      skippedChurned,
      byLevel,
      ranAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
