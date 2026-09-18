-- Churn Rescue Agent — base schema
--
-- Snapshot of the table structure the app reads. Verified against the live
-- Supabase project on 2026-09-18 via the PostgREST OpenAPI spec: all 9 tables,
-- and every column name, type, nullability, primary key, foreign key and
-- default below matches what is deployed.
--
-- This is a declarative snapshot, not a numbered step in the migration chain
-- (e.g. 17_fix_churned_renewal_dates.sql, which set renewal_date = outcome_date
-- for churned accounts). Data changes belong in those; this file is the shape.
--
-- Notes for anyone reading this alongside the app:
--
--   * subscriptions rows are billing-cycle charge events (~monthly, 5-50 day
--     gaps), NOT contract renewals. The next contract renewal is
--     customers.renewal_date. change_type holds the literal value 'renewal' on
--     most rows, which is why the UI never renders that column.
--   * usage_daily is one row per customer per day, contiguous, no gaps. The
--     observation window is bounded and ends at different dates per customer:
--     2026-10-31 for retained accounts, outcome_date for churned ones.
--   * customer_outcomes and evaluation_cases are ground truth. They must never
--     be read by anything simulating the risk/AI workflow; the dashboard reads
--     them only to split active from lost accounts and to render clearly
--     labelled placeholder badges.
--   * risk_assessments, investigations and outreach are intentionally empty.
--     Phase 4/5 populate them, for currently-active customers only.

CREATE TABLE public.customers (
    customer_id text PRIMARY KEY,
    company text NOT NULL,
    plan text NOT NULL,
    mrr numeric NOT NULL,
    signup_date date NOT NULL,
    renewal_date date NOT NULL,
    industry text NOT NULL,
    company_size text NOT NULL
);

CREATE TABLE public.usage_daily (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id text NOT NULL
        REFERENCES public.customers(customer_id),
    date date NOT NULL,
    logins integer NOT NULL,
    sessions integer NOT NULL,
    key_actions integer NOT NULL,
    feature_usage integer NOT NULL
);

CREATE TABLE public.support_tickets (
    ticket_id text PRIMARY KEY,
    customer_id text NOT NULL
        REFERENCES public.customers(customer_id),
    date date NOT NULL,
    subject text NOT NULL,
    description text NOT NULL,
    category text NOT NULL,
    sentiment text NOT NULL,
    resolution_status text NOT NULL
);

CREATE TABLE public.subscriptions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id text NOT NULL
        REFERENCES public.customers(customer_id),
    date date NOT NULL,
    plan text NOT NULL,
    mrr numeric NOT NULL,
    payment_status text NOT NULL,
    change_type text NOT NULL
);

CREATE TABLE public.customer_outcomes (
    customer_id text PRIMARY KEY
        REFERENCES public.customers(customer_id),
    outcome text NOT NULL,
    outcome_date date NOT NULL,
    reason text
);

CREATE TABLE public.evaluation_cases (
    customer_id text PRIMARY KEY
        REFERENCES public.customers(customer_id),
    actual_outcome text NOT NULL,
    expected_risk_level text NOT NULL,
    expected_recommendation text NOT NULL,
    expected_root_cause text NOT NULL,
    case_type text
);

CREATE TABLE public.risk_assessments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id text NOT NULL
        REFERENCES public.customers(customer_id),
    risk_level text,
    risk_reason text,
    confidence text,
    evidence jsonb,
    created_at timestamptz DEFAULT now()
);

CREATE TABLE public.investigations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id text NOT NULL
        REFERENCES public.customers(customer_id),
    usage_summary text,
    support_summary text,
    subscription_summary text,
    root_cause_hypothesis text,
    created_at timestamptz DEFAULT now()
);

CREATE TABLE public.outreach (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id text NOT NULL
        REFERENCES public.customers(customer_id),
    recommended_action text,
    status text,
    outcome text,
    created_at timestamptz DEFAULT now()
);
