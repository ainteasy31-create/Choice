-- Add updated_at column to draft_applications so save-draft edge function
-- can track last-save time separately from creation time.
-- This prevents auto-saves from resetting the 7-day expiry window.

ALTER TABLE public.draft_applications
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Backfill existing rows
UPDATE public.draft_applications
SET updated_at = created_at
WHERE updated_at IS NULL;
