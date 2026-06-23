-- ============================================================
-- MIGRATION: Fix watermark_status system
-- Date: 2026-06-23
--
-- Two problems fixed:
--
-- 1. CHECK constraint only allowed 'pending','applied','skipped',
--    'failed' — but watermark-review.js saves 'watermark',
--    'branding', 'unscanned', 'clean'. Every save from the
--    watermark review page silently failed with code 23514.
--    Fix: expand constraint to include all values the UI uses.
--
-- 2. Old add_property_photo RPC hard-coded watermark_status=
--    'applied' for every insert, including fresh scraper imports
--    that were never watermarked. 9,459 photos incorrectly show
--    as "watermarked". Fix: reset any photo whose URL does NOT
--    contain the watermark transform back to 'pending'.
-- ============================================================

BEGIN;

-- 1. Fix the CHECK constraint
ALTER TABLE property_photos
  DROP CONSTRAINT IF EXISTS property_photos_watermark_status_check;

ALTER TABLE property_photos
  ADD CONSTRAINT property_photos_watermark_status_check
  CHECK (watermark_status = ANY (ARRAY[
    'pending'::text,    -- not yet watermarked
    'applied'::text,    -- our "Choice Properties" watermark applied
    'skipped'::text,    -- intentionally skipped
    'failed'::text,     -- watermark application failed
    'watermark'::text,  -- scan found a third-party watermark
    'branding'::text,   -- scan found competing branding
    'unscanned'::text,  -- scan not yet run (alias for pending)
    'clean'::text       -- scan ran, no watermark found
  ]));

-- 2. Reset stale 'applied' records to 'pending'
-- A truly-watermarked photo URL contains 'ot-Choice' (the IK
-- text overlay transform from imagekit-watermark edge fn).
-- Any 'applied' record without that string was mislabeled by
-- the old RPC and should go back to 'pending'.
UPDATE property_photos
SET    watermark_status = 'pending'
WHERE  watermark_status = 'applied'
  AND  url NOT LIKE '%ot-Choice%';

COMMIT;
