-- ─────────────────────────────────────────────────────────────────────────────
-- Add nudge_sent_at to draft_applications
--
-- Prevents the nudge-expiring-drafts edge function from sending more than
-- one re-engagement email per draft. Set to NOW() once the email is sent.
-- NULL = not yet nudged (eligible for the 5-day nudge window).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.draft_applications
  ADD COLUMN IF NOT EXISTS nudge_sent_at TIMESTAMPTZ DEFAULT NULL;

-- Index for the nightly cron query:
-- WHERE created_at BETWEEN <5d ago> AND <6d ago> AND nudge_sent_at IS NULL
CREATE INDEX IF NOT EXISTS idx_draft_applications_nudge
  ON public.draft_applications (created_at, nudge_sent_at)
  WHERE nudge_sent_at IS NULL;

COMMENT ON COLUMN public.draft_applications.nudge_sent_at IS
  'Timestamp when the expiry-warning nudge email was sent. NULL = not yet sent.';
