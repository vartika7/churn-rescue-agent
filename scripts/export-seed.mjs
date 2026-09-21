#!/usr/bin/env node
/**
 * Re-exports supabase/seed.sql and supabase/seed/*.csv from the live database.
 *
 * Run this after any change to the data — a migration, a date shift, an edit in
 * the table editor — so the committed snapshot stops being a lie. A plain
 * `git status` cannot tell you the seed has gone stale, because the drift is in
 * Supabase, not in the working tree.
 *
 *   node scripts/export-seed.mjs
 *
 * Deliberately dependency-free: node builtins and fetch only, talking to
 * PostgREST directly. It reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from
 * .env.local, and every row it writes is parsed back and diffed against the
 * source before the files are kept, so an escaping bug fails loudly here rather
 * than silently at load time.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const env = {};
try {
  for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split(
    "\n",
  )) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
} catch {
  console.error("Could not read .env.local — copy env.example and fill it in.");
  process.exit(1);
}
for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!env[key]) {
    console.error(`Missing ${key} in .env.local`);
    process.exit(1);
  }
}

const BASE = `${env.SUPABASE_URL}/rest/v1`;
const H = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
};

/** PostgREST caps a response at 1000 rows, so page past it. */
async function fetchAll(table, cols, order) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const url = `${BASE}/${table}?select=${cols}&order=${order}`;
    const res = await fetch(url, {
      headers: { ...H, Range: `${from}-${from + 999}`, "Range-Unit": "items" },
    });
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

async function count(table) {
  const res = await fetch(`${BASE}/${table}?select=*`, {
    method: "HEAD",
    headers: { ...H, Prefer: "count=exact" },
  });
  return Number(res.headers.get("content-range")?.split("/")[1] ?? 0);
}

/* Ordered so foreign keys resolve: customers first, everything else after. */
const TABLES = [
  [
    "01",
    "customers",
    [
      "customer_id",
      "company",
      "plan",
      "mrr",
      "signup_date",
      "renewal_date",
      "industry",
      "company_size",
    ],
    "customer_id",
  ],
  [
    "02",
    "usage_daily",
    [
      "customer_id",
      "date",
      "logins",
      "sessions",
      "key_actions",
      "feature_usage",
    ],
    "customer_id,date",
  ],
  [
    "03",
    "support_tickets",
    [
      "ticket_id",
      "customer_id",
      "date",
      "subject",
      "description",
      "category",
      "sentiment",
      "resolution_status",
    ],
    "ticket_id",
  ],
  [
    "04",
    "subscriptions",
    ["customer_id", "date", "plan", "mrr", "payment_status", "change_type"],
    "customer_id,date",
  ],
  [
    "05",
    "customer_outcomes",
    ["customer_id", "outcome", "outcome_date", "reason"],
    "customer_id",
  ],
  [
    "06",
    "evaluation_cases",
    [
      "customer_id",
      "actual_outcome",
      "expected_risk_level",
      "expected_recommendation",
      "expected_root_cause",
      "case_type",
    ],
    "customer_id",
  ],
];

/* standard_conforming_strings is on by default, so only the quote needs doubling. */
const sqlLit = (v) =>
  v === null || v === undefined
    ? "NULL"
    : typeof v === "number"
      ? String(v)
      : `'${String(v).replace(/'/g, "''")}'`;

/**
 * RFC 4180 field. NULL becomes a genuinely empty, unquoted field, which is what
 * COPY ... FORMAT csv reads back as NULL; a quoted "" would come back as an
 * empty string instead.
 */
const csvField = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) || s !== s.trim()
    ? `"${s.replace(/"/g, '""')}"`
    : s;
};

const data = {};
const counts = {};
let inserts = "";

for (const [, table, cols, order] of TABLES) {
  const rows = await fetchAll(table, cols.join(","), order);
  data[table] = { rows, cols };
  counts[table] = rows.length;

  inserts += `\n-- ${table} (${rows.length} rows)\n`;
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    inserts += `INSERT INTO public.${table} (${cols.join(", ")}) VALUES\n`;
    inserts +=
      slice
        .map((r) => `  (${cols.map((c) => sqlLit(r[c])).join(", ")})`)
        .join(",\n") + ";\n";
  }
}

const mrrTotal = data.customers.rows.reduce((s, c) => s + Number(c.mrr), 0);
const retained = data.customer_outcomes.rows.filter(
  (o) => o.outcome === "retained",
).length;
const churned = counts.customer_outcomes - retained;
const usageDates = data.usage_daily.rows.map((r) => r.date).sort();
const today = new Date().toISOString().slice(0, 10);

for (const t of ["risk_assessments", "investigations", "outreach"]) {
  counts[t] = await count(t);
}

const header = `-- Churn Rescue Agent — seed data
--
-- Exported from the live Supabase project on ${today} by scripts/export-seed.mjs.
-- Usage data spans ${usageDates[0]} to ${usageDates[usageDates.length - 1]}.
-- Load after schema.sql; the Supabase CLI runs both in order on
-- \`supabase db reset\`, or paste this into the SQL editor.
--
-- ${counts.customers} customers (${retained} retained, ${churned} churned), ${counts.usage_daily} usage_daily rows,
-- ${counts.support_tickets} support tickets, ${counts.subscriptions} billing charges, portfolio total
-- $${mrrTotal.toLocaleString("en-US")} MRR.
--
-- risk_assessments, investigations and outreach are deliberately left empty:
-- Phase 4/5 populate them, for currently-active customers only. They are
-- truncated below so a reseed returns the project to the documented baseline.
--
-- TRUNCATE rather than DELETE, and RESTART IDENTITY, because usage_daily and
-- subscriptions have GENERATED ALWAYS AS IDENTITY primary keys and no unique
-- constraint on their business columns. A plain re-run of the INSERTs would
-- silently duplicate all ${counts.usage_daily} usage rows — no error, but every trend,
-- sparkline and zero-activity count would then be computed on doubled data.
-- Every table referencing customers is listed explicitly, so CASCADE is not
-- needed; if a future table references customers and is not listed here, the
-- TRUNCATE fails loudly rather than leaving orphans.
--
-- Wrapped in a transaction, so a failure part-way through rolls back instead
-- of leaving the project half-loaded.

BEGIN;

TRUNCATE TABLE
    public.usage_daily,
    public.support_tickets,
    public.subscriptions,
    public.customer_outcomes,
    public.evaluation_cases,
    public.risk_assessments,
    public.investigations,
    public.outreach,
    public.customers
  RESTART IDENTITY;
`;

const verify = `
COMMIT;

-- ---------------------------------------------------------------------------
-- Verification. Returns 0 rows when the seed loaded correctly; any row is a
-- failed assertion naming what did not match.
--
-- Date-relative assertions are deliberately absent: supabase/shift_dates.sql
-- slides the whole dataset through the calendar, so anything pinned to a
-- literal date would fail purely from time passing. Everything below is
-- relational and survives a shift.
-- ---------------------------------------------------------------------------
WITH checks(assertion, actual, expected) AS (
  VALUES
    ('customers row count',       (SELECT count(*) FROM public.customers)::text,         '${counts.customers}'),
    ('usage_daily row count',     (SELECT count(*) FROM public.usage_daily)::text,       '${counts.usage_daily}'),
    ('support_tickets row count', (SELECT count(*) FROM public.support_tickets)::text,   '${counts.support_tickets}'),
    ('subscriptions row count',   (SELECT count(*) FROM public.subscriptions)::text,     '${counts.subscriptions}'),
    ('customer_outcomes count',   (SELECT count(*) FROM public.customer_outcomes)::text, '${counts.customer_outcomes}'),
    ('evaluation_cases count',    (SELECT count(*) FROM public.evaluation_cases)::text,  '${counts.evaluation_cases}'),
    ('risk_assessments empty',    (SELECT count(*) FROM public.risk_assessments)::text,  '0'),
    ('investigations empty',      (SELECT count(*) FROM public.investigations)::text,    '0'),
    ('outreach empty',            (SELECT count(*) FROM public.outreach)::text,          '0'),
    ('portfolio MRR total',       (SELECT sum(mrr)::bigint FROM public.customers)::text, '${mrrTotal}'),
    ('retained customers',        (SELECT count(*) FROM public.customer_outcomes WHERE outcome = 'retained')::text,  '${retained}'),
    ('churned customers',         (SELECT count(*) FROM public.customer_outcomes WHERE outcome <> 'retained')::text, '${churned}'),
    -- Invariants the application relies on.
    ('no usage after churn',
      (SELECT count(*) FROM public.usage_daily u
         JOIN public.customer_outcomes o USING (customer_id)
        WHERE o.outcome <> 'retained' AND u.date > o.outcome_date)::text, '0'),
    ('no billing after churn',
      (SELECT count(*) FROM public.subscriptions s
         JOIN public.customer_outcomes o USING (customer_id)
        WHERE o.outcome <> 'retained' AND s.date > o.outcome_date)::text, '0'),
    ('churned renewal_date = outcome_date',
      (SELECT count(*) FROM public.customers c
         JOIN public.customer_outcomes o USING (customer_id)
        WHERE o.outcome <> 'retained' AND c.renewal_date <> o.outcome_date)::text, '0'),
    ('signup_date before renewal_date',
      (SELECT count(*) FROM public.customers WHERE signup_date >= renewal_date)::text, '0'),
    -- Tenure has to be backed by records: signup_date was once chosen
    -- independently of the usage window and claimed up to 971 days nobody has
    -- data for. See supabase/18_realign_signup_dates.sql.
    ('signup_date sits 0-3 days before the first usage row',
      (SELECT count(*) FROM public.customers c
         JOIN (SELECT customer_id, MIN(date) AS first_date
                 FROM public.usage_daily GROUP BY customer_id) f USING (customer_id)
        WHERE c.signup_date > f.first_date
           OR f.first_date - c.signup_date > 3)::text, '0'),
    ('no charge predates its account''s first usage',
      (SELECT count(*) FROM public.subscriptions s
         JOIN (SELECT customer_id, MIN(date) AS first_date
                 FROM public.usage_daily GROUP BY customer_id) f USING (customer_id)
        WHERE s.date < f.first_date)::text, '0'),
    ('exactly one new charge per customer',
      (SELECT count(*) FROM (
         SELECT customer_id FROM public.subscriptions WHERE change_type = 'new'
          GROUP BY customer_id HAVING count(*) <> 1) x)::text, '0'),
    ('no active account bills past its renewal',
      (SELECT count(*) FROM (
         SELECT c.customer_id
           FROM public.customers c
           JOIN public.subscriptions s ON s.customer_id = c.customer_id
                                      AND s.payment_status = 'paid'
           JOIN public.customer_outcomes o ON o.customer_id = c.customer_id
          WHERE o.outcome = 'retained'
          GROUP BY c.customer_id, c.renewal_date
         HAVING c.renewal_date <= MAX(s.date)
       ) stale)::text, '0'),
    ('no open access ticket on a retained account',
      (SELECT count(*) FROM public.support_tickets st
         JOIN public.customer_outcomes co ON co.customer_id = st.customer_id
        WHERE st.category = 'access'
          AND st.resolution_status IN ('in_progress', 'unresolved', 'escalated')
          AND co.outcome = 'retained')::text, '0'),
    ('every customer has an outcome row',
      (SELECT count(*) FROM public.customers c
        WHERE NOT EXISTS (SELECT 1 FROM public.customer_outcomes o
                           WHERE o.customer_id = c.customer_id))::text, '0'),
    ('every customer has usage',
      (SELECT count(*) FROM public.customers c
        WHERE NOT EXISTS (SELECT 1 FROM public.usage_daily u
                           WHERE u.customer_id = c.customer_id))::text, '0')
)
SELECT assertion, expected, actual FROM checks WHERE actual IS DISTINCT FROM expected;
`;

/* ------------------------------------------------------------------ *
 * Validate before writing: parse the generated SQL and CSV back and
 * diff field-by-field against what came out of the database.
 * ------------------------------------------------------------------ */
let failures = 0;
const fail = (m) => {
  failures++;
  console.error(`  FAIL  ${m}`);
};

/** Char-level parser: handles quoted strings containing commas, parens and ''. */
function parseInserts(text) {
  const out = {};
  const re = /INSERT INTO public\.(\w+) \(([^)]+)\) VALUES\n/g;
  let m;
  while ((m = re.exec(text))) {
    const table = m[1];
    const cols = m[2].split(",").map((c) => c.trim());
    out[table] ??= { cols, rows: [] };
    let i = re.lastIndex;
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] !== "(") break;
      i++;
      const vals = [];
      for (;;) {
        while (i < text.length && /\s/.test(text[i])) i++;
        if (text[i] === "'") {
          i++;
          let s = "";
          for (;;) {
            if (text[i] === "'") {
              if (text[i + 1] === "'") {
                s += "'";
                i += 2;
                continue;
              }
              i++;
              break;
            }
            s += text[i];
            i++;
          }
          vals.push(s);
        } else {
          let s = "";
          while (i < text.length && text[i] !== "," && text[i] !== ")") {
            s += text[i];
            i++;
          }
          s = s.trim();
          vals.push(s === "NULL" ? null : Number(s));
        }
        while (i < text.length && /\s/.test(text[i])) i++;
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === ")") {
          i++;
          break;
        }
        fail(`${table}: unexpected character at offset ${i}`);
        break;
      }
      out[table].rows.push(vals);
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === ";") {
        i++;
        break;
      }
      break;
    }
    re.lastIndex = i;
  }
  return out;
}

function parseCSV(text) {
  const rows = [];
  let row = [],
    cur = "",
    quoted = false,
    wasQuoted = false,
    i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      wasQuoted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(wasQuoted ? cur : cur === "" ? null : cur);
      cur = "";
      wasQuoted = false;
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(wasQuoted ? cur : cur === "" ? null : cur);
      rows.push(row);
      row = [];
      cur = "";
      wasQuoted = false;
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur !== "" || wasQuoted || row.length) {
    row.push(wasQuoted ? cur : cur === "" ? null : cur);
    rows.push(row);
  }
  return rows;
}

const same = (want, have) =>
  want === null || want === undefined
    ? have === null
    : typeof want === "number"
      ? Number(have) === want
      : String(have) === String(want);

const seedSql = header + inserts + verify;
const parsedSql = parseInserts(seedSql);

for (const [, table, cols] of TABLES) {
  const src = data[table].rows;
  const got = parsedSql[table];
  if (!got) {
    fail(`${table}: no INSERTs parsed back`);
    continue;
  }
  if (got.rows.length !== src.length) {
    fail(`${table}: ${got.rows.length} rows parsed, ${src.length} in source`);
    continue;
  }
  let bad = 0;
  for (let r = 0; r < src.length; r++)
    for (let c = 0; c < cols.length; c++)
      if (!same(src[r][cols[c]], got.rows[r][c])) bad++;
  if (bad) fail(`${table}: ${bad} field mismatches in seed.sql`);
}

mkdirSync(join(ROOT, "supabase", "seed"), { recursive: true });
const csvFiles = [];
for (const [n, table, cols] of TABLES) {
  const src = data[table].rows;
  const csv =
    cols.join(",") +
    "\n" +
    src.map((r) => cols.map((c) => csvField(r[c])).join(",")).join("\n") +
    "\n";

  const parsed = parseCSV(csv);
  const head = parsed.shift();
  if (head.join() !== cols.join()) fail(`${table}.csv: header mismatch`);
  if (parsed.length !== src.length)
    fail(`${table}.csv: ${parsed.length} rows vs ${src.length}`);
  else {
    let bad = 0;
    for (let r = 0; r < src.length; r++)
      for (let c = 0; c < cols.length; c++)
        if (!same(src[r][cols[c]], parsed[r][c])) bad++;
    if (bad) fail(`${table}.csv: ${bad} field mismatches`);
  }
  csvFiles.push([
    join(ROOT, "supabase", "seed", `${n}_${table}.csv`),
    csv,
    table,
    src.length,
  ]);
}

if (failures > 0) {
  console.error(`\n${failures} validation failure(s) — nothing written.`);
  process.exit(1);
}

writeFileSync(join(ROOT, "supabase", "seed.sql"), seedSql);
for (const [path, csv] of csvFiles) writeFileSync(path, csv);

console.log(
  `exported ${today}, usage spans ${usageDates[0]} to ${usageDates[usageDates.length - 1]}`,
);
for (const [, table] of TABLES)
  console.log(`  ${table.padEnd(18)} ${counts[table]} rows`);
console.log(
  `  ${"seed.sql".padEnd(18)} ${Math.round(Buffer.byteLength(seedSql) / 1024)}KB`,
);
console.log("\nvalidated: every row round-trips exactly, in both formats.");
