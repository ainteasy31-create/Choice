-- 20260616000002 — Add 'archived' to application_status enum + exclude archived from dashboard_pulse
--
-- Problem
-- -------
-- 1. The 'archived' application status was introduced in the JS/CSS layer
--    (filter chips, Archive button, badge) but was never added to the
--    `application_status` PostgreSQL enum — meaning Archive button clicks
--    would throw a DB error at runtime.
--
-- 2. dashboard_pulse counted archived applications in `total`, `lease_pending`,
--    `movein_pending`, and `recent`, making the admin dashboard show stale
--    hidden records in KPI tiles and the action queue.
--
-- Fix
-- ---
-- 1. ALTER TYPE application_status ADD VALUE 'archived'
--    (applied separately before this function — ALTER TYPE ADD VALUE cannot
--    appear in the same transaction as statements that reference the new value)
--
-- 2. CREATE OR REPLACE FUNCTION dashboard_pulse — filter status <> 'archived'
--    in both apps_in_range and apps_all CTEs, and in the recent subquery.

-- NOTE: The ALTER TYPE below is idempotent but may be a no-op if already
-- applied in a previous run. It MUST run in its own statement/transaction.
-- If re-running this file, apply this line first in a separate exec:
--   ALTER TYPE application_status ADD VALUE IF NOT EXISTS 'archived';

create or replace function public.dashboard_pulse(
  range_start  timestamptz default null,
  recent_limit int         default 8
)
returns json
language sql
stable
security definer
set search_path = public
as $$
  with
    apps_in_range as (
      select status, lease_status, move_in_status, payment_status, created_at
      from applications
      where status <> 'archived'
        and (range_start is null or created_at >= range_start)
    ),
    apps_all as (
      select status, lease_status, move_in_status, payment_status, created_at
      from applications
      where status <> 'archived'
    ),
    app_counts as (
      select
        count(*)                                                              as total,
        count(*) filter (where status = 'pending')                            as pending,
        count(*) filter (where status = 'approved')                           as approved,
        count(*) filter (where status = 'denied')                             as denied,
        count(*) filter (where status = 'waitlisted')                         as waitlisted,
        count(*) filter (where status = 'approved'
                          and (payment_status is null
                               or payment_status = 'unpaid'))                 as unpaid_approved
      from apps_in_range
    ),
    month_count as (
      select count(*) as this_month
      from apps_all
      where created_at >= date_trunc('month', now())
    ),
    lease_counts as (
      select
        count(*) filter (where lease_status is null
                          or lease_status = 'none')                            as lease_pending,
        count(*) filter (where lease_status = 'sent')                          as lease_sent,
        count(*) filter (where lease_status = 'signed'
                          or lease_status = 'awaiting_co_sign')                as lease_signed,
        count(*) filter (where lease_status = 'co_signed')                     as lease_executed
      from apps_all
    ),
    movein_counts as (
      select
        count(*) filter (where move_in_status = 'pending')                     as movein_pending,
        count(*) filter (where move_in_status = 'confirmed')                   as movein_confirmed
      from apps_all
    ),
    listing_counts as (
      select count(*) filter (where status = 'active') as active_listings
      from properties
    ),
    failed_emails as (
      select count(*) as failed_emails_48h
      from email_logs
      where status = 'failed'
        and created_at >= now() - interval '48 hours'
    ),
    recent as (
      select
        id, app_id, first_name, last_name, email,
        status, payment_status, lease_status, move_in_status,
        property_address, created_at
      from applications
      where status <> 'archived'
      order by created_at desc
      limit greatest(1, least(coalesce(recent_limit, 8), 50))
    )
  select json_build_object(
    'counts', (
      (select row_to_json(app_counts)       from app_counts)::jsonb
      || (select row_to_json(month_count)   from month_count)::jsonb
      || (select row_to_json(lease_counts)  from lease_counts)::jsonb
      || (select row_to_json(movein_counts) from movein_counts)::jsonb
      || (select row_to_json(listing_counts)from listing_counts)::jsonb
      || (select row_to_json(failed_emails) from failed_emails)::jsonb
    ),
    'recent', (select coalesce(json_agg(r order by r.created_at desc), '[]'::json) from recent r),
    'range_start', range_start,
    'generated_at', now()
  );
$$;

comment on function public.dashboard_pulse(timestamptz, int)
  is 'Aggregated dashboard data for admin/dashboard.html. Excludes archived applications from all counts and recent feed.';

revoke execute on function public.dashboard_pulse(timestamptz, int) from public;
grant  execute on function public.dashboard_pulse(timestamptz, int) to authenticated;
