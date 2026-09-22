-- Churn Rescue Agent — realign the dataset to the calendar
--
-- The dataset is a fixed snapshot but the calendar keeps moving, so it drifts:
-- usage stops at a hard end date while "today" walks past it, and every renewal
-- countdown slides from upcoming to overdue. This slides the whole thing so the
-- newest usage row lands on `target_end` again.
--
-- It is a UNIFORM TRANSLATION: every date in every table moves by the same
-- number of days. That is the entire reason to do it this way rather than
-- regenerate — gaps, orderings and every invariant survive by construction:
--
--   * no usage or billing after a churn date
--   * churned renewal_date = outcome_date
--   * signup_date < renewal_date
--   * no active account billing past its own renewal
--   * the ~monthly billing rhythm and the 5-50 day gaps between charges
--
-- Re-runnable and self-computing: it works out the offset from the data, so
-- running it again later shifts by whatever the new drift is, and running it
-- twice in a row does nothing the second time.
--
-- WHEN TO RUN IT: shortly before a demo, not routinely. Everything derived
-- from the data goes stale the moment the dates move, and restoring that
-- alignment costs Gemini quota (20 requests per day, per model).
--
-- AFTER RUNNING THIS:
--   1. Re-run the seed export so the committed snapshot matches (the repo's
--      supabase/seed.sql and supabase/seed/*.csv are now stale).
--   2. Re-run POST /api/assess. Stored risk_assessments were computed against
--      the old dates; their created_at is a real audit timestamp and is
--      deliberately NOT shifted, so old rows would misrepresent when they ran.
--   3. Re-run `npm run investigate`. Stored investigations cite evidence from
--      the old window — "13 silent days in the last 30" describes a window
--      that has moved, and the dates quoted in their prose no longer match the
--      account. Grounding is still checked against ids rather than dates, so
--      `npm run evaluate:ai` will not catch this; the rows read as fine and
--      quietly describe the wrong period. Use --force, since the script skips
--      accounts that already have a live investigation.
--   4. Re-run `npm run evaluate` and `npm run evaluate:ai` so both reports
--      describe the shifted dataset.
--
-- WHAT IT DOES NOT DO: it never changes `customer_outcomes.outcome`, so no
-- account moves between the active worklist and Lost. A renewal date passing
-- is not churn — it means the renewal came due, and a retained account simply
-- renewed. Deriving churn from "renewal_date < today" would tell a CSM that a
-- customer who just renewed had left.

DO $$
DECLARE
    -- Where the newest usage_daily row should land.
    -- CURRENT_DATE keeps the dataset aligned with today. Set an explicit date
    -- to aim elsewhere, e.g. '2026-11-14' to prepare for a demo on that day.
    target_end date := CURRENT_DATE;

    shift_days integer;
    current_end date;
BEGIN
    SELECT MAX(date) INTO current_end FROM public.usage_daily;

    IF current_end IS NULL THEN
        RAISE EXCEPTION 'usage_daily is empty — load the seed before shifting.';
    END IF;

    shift_days := target_end - current_end;

    IF shift_days = 0 THEN
        RAISE NOTICE 'Already aligned: usage_daily ends on % — nothing to do.', current_end;
        RETURN;
    END IF;

    RAISE NOTICE 'Shifting every date by % days (% -> %).',
        shift_days, current_end, target_end;

    UPDATE public.customers
       SET signup_date  = signup_date  + shift_days,
           renewal_date = renewal_date + shift_days;

    UPDATE public.usage_daily       SET date         = date         + shift_days;
    UPDATE public.support_tickets   SET date         = date         + shift_days;
    UPDATE public.subscriptions     SET date         = date         + shift_days;
    UPDATE public.customer_outcomes SET outcome_date = outcome_date + shift_days;

    RAISE NOTICE 'Done. Re-export the seed and re-run the risk assessments.';
END $$;

-- ---------------------------------------------------------------------------
-- Verification. Returns 0 rows when the shift preserved everything it should.
-- ---------------------------------------------------------------------------
WITH checks(assertion, actual, expected) AS (
  VALUES
    ('usage ends today',
      (SELECT MAX(date) FROM public.usage_daily)::text, CURRENT_DATE::text),
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
    ('every churn date is in the past',
      (SELECT count(*) FROM public.customer_outcomes
        WHERE outcome <> 'retained' AND outcome_date > CURRENT_DATE)::text, '0'),
    ('row counts unchanged by the shift',
      (SELECT count(*) FROM public.usage_daily)::text, '7980')
)
SELECT assertion, expected, actual FROM checks WHERE actual IS DISTINCT FROM expected;

-- What the renewal picture looks like now.
SELECT
    c.renewal_date - CURRENT_DATE AS days_out,
    count(*)                      AS accounts
FROM public.customers c
JOIN public.customer_outcomes o ON o.customer_id = c.customer_id
WHERE o.outcome = 'retained'
GROUP BY 1
ORDER BY 1;
