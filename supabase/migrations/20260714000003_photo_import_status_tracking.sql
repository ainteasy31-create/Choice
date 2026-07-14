-- Photo-import status tracking + auto-activation gate
-- ============================================================
-- Context: pipeline_publish() creates public.properties rows with
-- status='draft' (hidden from the public site, which only shows
-- status='active'). Photos are then transferred to ImageKit by the
-- import-pipeline-photos edge function, asynchronously, after publish.
-- Nothing previously flipped status to 'active' automatically, and a
-- failed transfer left no record of why — a listing could sit
-- invisible forever with no signal to the admin.
--
-- This migration adds tracking columns so import-pipeline-photos can:
--   - mark photo_import_status='ok' and auto-activate the property
--     (draft -> active) once at least one photo is confirmed on
--     ImageKit, closing the loop without manual admin action.
--   - mark photo_import_status='failed' with a logged reason when the
--     transfer produced zero photos, so the property stays hidden
--     ('draft') and the failure is visible/retryable in the admin UI
--     instead of silently disappearing.
-- No CHECK constraint is added (mirrors the existing free-text
-- `status` column in this table) so retry logic can't get blocked by
-- an unexpected value.
-- ============================================================

ALTER TABLE pipeline.pipeline_properties
  ADD COLUMN IF NOT EXISTS photo_import_status     text,
  ADD COLUMN IF NOT EXISTS last_photo_import_error  text,
  ADD COLUMN IF NOT EXISTS last_photo_import_at     timestamptz;

COMMENT ON COLUMN pipeline.pipeline_properties.photo_import_status IS
  'null = not attempted yet; ok = >=1 photo confirmed on ImageKit; failed = transfer attempted but produced zero photos.';
COMMENT ON COLUMN pipeline.pipeline_properties.last_photo_import_error IS
  'Human-readable reason for the most recent failed photo transfer attempt (for admin visibility + retry).';
