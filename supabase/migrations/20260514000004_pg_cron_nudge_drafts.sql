-- ─────────────────────────────────────────────────────────────────────────────
-- Schedule daily re-engagement nudge for expiring drafts via pg_cron + pg_net
--
-- Runs at 09:00 UTC (morning — better email open rates than the 03:00
-- cleanup cron) and calls nudge-expiring-drafts for any draft that is
-- 5–6 days old with no nudge_sent_at yet.
--
-- Prerequisites: pg_cron and pg_net enabled (see migration 20260514000002).
-- ─────────────────────────────────────────────────────────────────────────────

-- Remove any previous version of this job (idempotent re-runs)
SELECT cron.unschedule('nudge-expiring-drafts')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'nudge-expiring-drafts'
);

-- Schedule: every morning at 09:00 UTC
SELECT cron.schedule(
  'nudge-expiring-drafts',
  '0 9 * * *',
  $$
  SELECT extensions.net.http_post(
    url      := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL') || '/functions/v1/nudge-expiring-drafts',
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
-- Verify:
-- SELECT * FROM cron.job WHERE jobname IN ('cleanup-expired-drafts','nudge-expiring-drafts');
-- ─────────────────────────────────────────────────────────────────────────────
