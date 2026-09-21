-- Churn Rescue Agent — pull signup_date to where the data actually begins
--
-- The generator chose signup_date independently of the usage window, so 48 of
-- 50 accounts claimed tenure they have no records for — C017 by 971 days, C038
-- by 934. A customer page reading "signed up Oct 2023" above a usage chart that
-- starts in Apr 2026 is a flat contradiction, and tenure is one of the first
-- fields a reader checks against the chart.
--
-- This sets every signup_date to 0-3 days before that account's first usage
-- row, so stated tenure and observed history finally agree.
--
-- Five churned accounts (C008, C014, C016, C020, C048) have usage genuinely
-- beginning in late 2025. Their pre-2026 usage is trimmed so every signup lands
-- in 2026, at staggered cutoffs rather than a shared Jan 1 — five accounts
-- sharing one signup date would read as generated. Each cutoff leaves >= 90
-- days of history, the engine's gate for the whole-history trend signal, and
-- churn recall is unchanged at 8/10 flagged at churn.
--
-- Effects on the row counts: usage_daily 8200 -> 7980, subscriptions 289 -> 285.
-- Every customer keeps exactly one 'new' charge.
--
-- AFTER RUNNING THIS: re-run scripts/export-seed.mjs so the committed snapshot
-- matches. Re-running /api/assess is not needed — signup_date is not an input
-- to the risk engine and no active account's usage changed.

BEGIN;

-- 1. Trim usage that predates 2026 for the five accounts whose records
--    start in late 2025. Staggered so their signup dates do not collide.
DELETE FROM public.usage_daily WHERE customer_id = 'C008' AND date < DATE '2026-01-06';
DELETE FROM public.usage_daily WHERE customer_id = 'C014' AND date < DATE '2026-01-09';
DELETE FROM public.usage_daily WHERE customer_id = 'C016' AND date < DATE '2026-01-04';
DELETE FROM public.usage_daily WHERE customer_id = 'C020' AND date < DATE '2026-01-12';
DELETE FROM public.usage_daily WHERE customer_id = 'C048' AND date < DATE '2026-01-02';

-- 2. Move each trimmed account's opening charge to just after its records
--    now begin, and drop renewals left stranded before that point.
UPDATE public.subscriptions SET date = DATE '2026-01-08'
 WHERE customer_id = 'C008' AND date = DATE '2025-11-17';
DELETE FROM public.subscriptions WHERE customer_id = 'C008' AND date = DATE '2025-12-17';
UPDATE public.subscriptions SET date = DATE '2026-01-11'
 WHERE customer_id = 'C014' AND date = DATE '2025-11-29';
DELETE FROM public.subscriptions WHERE customer_id = 'C014' AND date = DATE '2025-12-29';
UPDATE public.subscriptions SET date = DATE '2026-01-06'
 WHERE customer_id = 'C016' AND date = DATE '2025-10-21';
DELETE FROM public.subscriptions WHERE customer_id = 'C016' AND date = DATE '2025-11-20';
DELETE FROM public.subscriptions WHERE customer_id = 'C016' AND date = DATE '2025-12-20';
UPDATE public.subscriptions SET date = DATE '2026-01-14'
 WHERE customer_id = 'C020' AND date = DATE '2025-12-18';
UPDATE public.subscriptions SET date = DATE '2026-01-04'
 WHERE customer_id = 'C048' AND date = DATE '2025-12-17';

-- 3. Pull every signup_date to just before the first usage row.
UPDATE public.customers c
   SET signup_date = v.signup
  FROM (VALUES
  ('C001', DATE '2026-04-27'),
  ('C002', DATE '2026-04-21'),
  ('C003', DATE '2026-03-16'),
  ('C004', DATE '2026-04-02'),
  ('C005', DATE '2026-01-10'),
  ('C006', DATE '2026-04-19'),
  ('C007', DATE '2026-03-30'),
  ('C008', DATE '2026-01-04'),
  ('C009', DATE '2026-03-18'),
  ('C010', DATE '2026-03-23'),
  ('C011', DATE '2026-03-20'),
  ('C012', DATE '2026-03-08'),
  ('C013', DATE '2026-01-29'),
  ('C014', DATE '2026-01-06'),
  ('C015', DATE '2026-03-23'),
  ('C016', DATE '2026-01-03'),
  ('C017', DATE '2026-04-11'),
  ('C018', DATE '2026-03-16'),
  ('C019', DATE '2026-03-13'),
  ('C020', DATE '2026-01-12'),
  ('C021', DATE '2026-01-20'),
  ('C022', DATE '2026-03-30'),
  ('C023', DATE '2026-04-11'),
  ('C024', DATE '2026-04-03'),
  ('C025', DATE '2026-04-10'),
  ('C026', DATE '2026-04-01'),
  ('C027', DATE '2026-03-17'),
  ('C028', DATE '2026-04-02'),
  ('C029', DATE '2026-03-18'),
  ('C030', DATE '2026-05-02'),
  ('C031', DATE '2026-03-11'),
  ('C032', DATE '2026-04-15'),
  ('C033', DATE '2026-04-01'),
  ('C034', DATE '2026-04-07'),
  ('C035', DATE '2026-03-18'),
  ('C036', DATE '2026-04-07'),
  ('C037', DATE '2026-04-09'),
  ('C038', DATE '2026-04-26'),
  ('C039', DATE '2026-03-23'),
  ('C040', DATE '2026-04-18'),
  ('C041', DATE '2026-04-22'),
  ('C042', DATE '2026-08-14'),
  ('C043', DATE '2026-04-17'),
  ('C044', DATE '2026-03-07'),
  ('C045', DATE '2026-04-17'),
  ('C046', DATE '2026-03-21'),
  ('C047', DATE '2026-03-15'),
  ('C048', DATE '2026-01-01'),
  ('C049', DATE '2026-04-17'),
  ('C050', DATE '2026-04-07')
  ) AS v(customer_id, signup)
 WHERE c.customer_id = v.customer_id;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification. Returns 0 rows when the realignment held.
-- ---------------------------------------------------------------------------
WITH first_usage AS (
  SELECT customer_id, MIN(date) AS first_date, MAX(date) AS last_date,
         COUNT(*) AS days
    FROM public.usage_daily GROUP BY customer_id
),
checks(assertion, actual, expected) AS (
  VALUES
    ('every signup is in 2026',
      (SELECT count(*) FROM public.customers
        WHERE signup_date < DATE '2026-01-01')::text, '0'),
    ('no signup after its first usage row',
      (SELECT count(*) FROM public.customers c JOIN first_usage f USING (customer_id)
        WHERE c.signup_date > f.first_date)::text, '0'),
    ('no signup more than 3 days before first usage',
      (SELECT count(*) FROM public.customers c JOIN first_usage f USING (customer_id)
        WHERE f.first_date - c.signup_date > 3)::text, '0'),
    ('signup_date before renewal_date',
      (SELECT count(*) FROM public.customers WHERE signup_date >= renewal_date)::text, '0'),
    ('no charge predates its account''s first usage',
      (SELECT count(*) FROM public.subscriptions s JOIN first_usage f USING (customer_id)
        WHERE s.date < f.first_date)::text, '0'),
    ('exactly one new charge per customer',
      (SELECT count(*) FROM (
         SELECT customer_id FROM public.subscriptions WHERE change_type = 'new'
          GROUP BY customer_id HAVING count(*) <> 1) x)::text, '0'),
    ('every customer still has usage',
      (SELECT count(*) FROM public.customers c
        WHERE NOT EXISTS (SELECT 1 FROM public.usage_daily u
                           WHERE u.customer_id = c.customer_id))::text, '0'),
    ('every account keeps 90+ days of history (C042 excepted)',
      (SELECT count(*) FROM first_usage
        WHERE days < 90 AND customer_id <> 'C042')::text, '0'),
    ('usage_daily row count',
      (SELECT count(*) FROM public.usage_daily)::text, '7980'),
    ('subscriptions row count',
      (SELECT count(*) FROM public.subscriptions)::text, '285')
)
SELECT assertion, expected, actual FROM checks WHERE actual IS DISTINCT FROM expected;

-- Tenure now visible per account.
SELECT c.customer_id, c.company, c.signup_date,
       MIN(u.date) AS first_usage, MAX(u.date) AS last_usage, count(*) AS days
  FROM public.customers c JOIN public.usage_daily u USING (customer_id)
 GROUP BY c.customer_id, c.company, c.signup_date
 ORDER BY c.signup_date;
