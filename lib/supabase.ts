// `server-only` turns an accidental client-side import of this module into a
// build error. The service role key bypasses row-level security, so it must
// never reach the browser bundle.
import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy env.example to .env.local for local dev, and add the ` +
        `same variable in the Vercel project settings for the deployed app.`,
    );
  }
  return value;
}

let client: SupabaseClient | null = null;

/**
 * Created on first query rather than at module scope, deliberately.
 *
 * `next build` imports every page module to read its route config, so a
 * throw at module scope would fail the build outright on a machine without
 * credentials and would also escape the try/catch inside the pages. Deferring
 * it means a missing key surfaces as a readable setup message on the page.
 *
 * This is an internal CS tool, not customer-facing, so full read access from a
 * server-only client is intentional.
 */
export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return client;
}

/** PostgREST caps a single response at 1000 rows by default. */
const PAGE_SIZE = 1000;

interface OrderBy {
  column: string;
  ascending?: boolean;
}

/**
 * Filters are declarative rather than a builder callback on purpose: Supabase's
 * `PostgrestFilterBuilder` generics change shape between minor versions, and a
 * callback typed loosely enough to accept them ends up as `any` anyway.
 */
interface Filters {
  eq?: Record<string, string | number>;
  gte?: Record<string, string | number>;
  lte?: Record<string, string | number>;
}

/**
 * Reads every matching row, in pages, fetching the pages concurrently.
 *
 * `usage_daily` holds 8,323 rows (50 customers x 112-196 days), so a plain
 * `.select()` would silently return only the first 1000 and quietly drop most
 * customers off the dashboard. `order` must produce a total order, otherwise
 * rows can repeat or vanish across page boundaries.
 *
 * The first request asks for an exact count, which tells us how many further
 * pages exist so they can all go out at once. Paging sequentially instead cost
 * 9 round trips of ~300-650ms each — about 3.4s of the dashboard's load, versus
 * ~1.1s concurrently.
 *
 * One consequence of fetching by offset in parallel: if rows were inserted
 * between the count and the page reads, page boundaries would shift and a row
 * could be missed or repeated. Sequential paging has the same hazard, and these
 * are read-only views over a static dataset, so it is not worth a snapshot
 * transaction here — but it would be if this ever read a table under writes.
 */
export async function selectAll<T>(
  table: string,
  columns: string,
  order: OrderBy[],
  filters: Filters = {},
): Promise<T[]> {
  const supabase = getSupabase();

  // Rebuilt per request: a PostgREST builder cannot be reused once awaited.
  const build = (withCount: boolean) => {
    let query = withCount
      ? supabase.from(table).select(columns, { count: "exact" })
      : supabase.from(table).select(columns);

    for (const [column, value] of Object.entries(filters.eq ?? {})) {
      query = query.eq(column, value);
    }
    for (const [column, value] of Object.entries(filters.gte ?? {})) {
      query = query.gte(column, value);
    }
    for (const [column, value] of Object.entries(filters.lte ?? {})) {
      query = query.lte(column, value);
    }
    for (const { column, ascending = true } of order) {
      query = query.order(column, { ascending });
    }
    return query;
  };

  const fail = (message: string) => {
    throw new Error(`Supabase read failed on "${table}": ${message}`);
  };

  const first = await build(true).range(0, PAGE_SIZE - 1);
  if (first.error) fail(first.error.message);

  const rows = [...((first.data ?? []) as T[])];
  const total = first.count ?? rows.length;

  // Short-circuit the common case: one page is all there was.
  if (rows.length < PAGE_SIZE || rows.length >= total) return rows;

  const offsets: number[] = [];
  for (let from = PAGE_SIZE; from < total; from += PAGE_SIZE)
    offsets.push(from);

  const pages = await Promise.all(
    offsets.map((from) => build(false).range(from, from + PAGE_SIZE - 1)),
  );

  for (const page of pages) {
    if (page.error) fail(page.error.message);
    rows.push(...((page.data ?? []) as T[]));
  }

  return rows;
}
