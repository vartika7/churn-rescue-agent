-- Churn Rescue Agent — base schema
--
-- Snapshot of the table structure the app reads. Verified against the live
-- Supabase project on 2026-09-18 via the PostgREST OpenAPI spec: all 9 tables,
-- and every column name, type, nullability, primary key, foreign key and
-- default below matches what is deployed.
--
-- This is a declarative snapshot of the table shapes. Data changes are applied
-- separately and are not tracked here.
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

-- Phase 5 output, appended rather than updated: the table is a record of what
-- the model said and when, which is what lets an investigation be graded after
-- the fact and a changed verdict be reconstructed.
--
-- This table originally carried usage_summary, support_summary and
-- subscription_summary — written in Phase 2 on the assumption that an
-- investigation would summarise each data source in turn. By the time Phase 5
-- was built the useful decomposition turned out to be by argument instead
-- (root cause, evidence for, evidence against, recommendation), because the
-- finding that matters usually crosses sources: C035's is "unresolved support
-- ticket -> lost trust -> usage collapse", which cannot be split three ways
-- without destroying it. The columns were never written and have been dropped.
CREATE TABLE public.investigations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id text NOT NULL
        REFERENCES public.customers(customer_id),
    -- Mirrored out of the jsonb because it is the one field worth querying.
    root_cause_hypothesis text,
    -- The validated Investigation object: interpretation, root cause,
    -- supporting and contradicting claims with their citations,
    -- recommendation, limitations, insufficientEvidence.
    investigation jsonb,
    -- Which provider and model produced it. 'mock' means the offline path,
    -- which is not model output and must be labelled as such wherever shown.
    provider text,
    model text,
    -- Share of the response's citations that resolved to real evidence. 1 is
    -- fully grounded; anything lower is a fabrication rate.
    grounding_rate numeric,
    created_at timestamptz DEFAULT now()
);

-- Phase 6. Appended like the other two, so a customer's outreach history is a
-- record rather than a current value.
--
-- The original draft and the CSM's edit live in separate columns and never
-- overwrite each other. A rejection says the draft was wrong; an edit says it
-- was nearly right, and the difference between body and edited_body is the
-- only honest measure of drafting quality. Overwriting would discard it.
--
-- `status = 'approved'` means a human judged the message fit to send. It does
-- NOT mean it was sent: nothing in this codebase sends anything, and there is
-- no disabled or feature-flagged path that does.
CREATE TABLE public.outreach (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id text NOT NULL
        REFERENCES public.customers(customer_id),
    -- Carried over from the investigation this draft was built from.
    recommended_action text,
    subject text,
    body text,
    -- Evidence ids the message's claims rest on, same discipline as
    -- investigations: a customer email citing something that does not exist is
    -- a credibility loss the company cannot take back.
    citations jsonb,
    check_before_sending text,
    -- draft | approved | rejected
    status text,
    -- Null unless the CSM actually changed something.
    edited_subject text,
    edited_body text,
    decided_by text,
    decided_at timestamptz,
    provider text,
    model text,
    -- What happened afterwards, for a later phase.
    outcome text,
    created_at timestamptz DEFAULT now()
);
