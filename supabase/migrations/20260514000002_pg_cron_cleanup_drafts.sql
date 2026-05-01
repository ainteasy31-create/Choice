-- ─────────────────────────────────────────────────────────────────────────────
-- Nightly cleanup of expired draft_applications via pg_cron + pg_net
--
-- Drafts expire 7 days from created_at (enforced both by the save-draft
-- GET endpoint and by this scheduled delete).
--
-- Schedule: 03:00 UTC daily (quiet hour, well outside peak apply traffic).
--
-- Prerequisites: pg_cron and pg_net extensions must be enabled in the
-- Supabase dashboard (Database → Extensions) OR they are created below.
-- In Supabase-managed projects these extensions are available but must be
-- enabled per-project. The CREATE EXTENSION IF NOT EXISTS calls are safe
-- to run multiple times.
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_cron   WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net    WITH SCHEMA extensions;

-- Remove any previous version of this job (idempotent re-runs)
SELECT cron.unschedule('cleanup-expired-drafts')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'cleanup-expired-drafts'
);

-- Schedule: every night at 03:00 UTC
SELECT cron.schedule(
  'cleanup-expired-drafts',
  '0 3 * * *',
  $$
  SELECT extensions.net.http_post(
    url      := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL') || '/functions/v1/cleanup-expired-drafts',
    headers  := jsonb_build_object(
                  'Content-Type',  'application/json',
                  'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
                ),
    body     := '{}',
    timeout_milliseconds := 30000
  )
  $$
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Verify the job was registered
-- (SELECT * FROM cron.job WHERE jobname = 'cleanup-expired-drafts';)
-- ─────────────────────────────────────────────────────────────────────────────
