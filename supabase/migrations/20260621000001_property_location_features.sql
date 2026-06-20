-- Migration: add county, neighborhood, location_context, has_basement, has_central_air to properties
-- Required by the admin property-detail edit form (Phase 3 UI additions).

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS county            TEXT,
  ADD COLUMN IF NOT EXISTS neighborhood      TEXT,
  ADD COLUMN IF NOT EXISTS location_context  TEXT,
  ADD COLUMN IF NOT EXISTS has_basement      BOOLEAN,
  ADD COLUMN IF NOT EXISTS has_central_air   BOOLEAN;

COMMENT ON COLUMN public.properties.county           IS 'County the property is located in (e.g. Los Angeles County).';
COMMENT ON COLUMN public.properties.neighborhood     IS 'Neighborhood name (e.g. Silver Lake, Midtown).';
COMMENT ON COLUMN public.properties.location_context IS 'Free-form location notes shown to prospective tenants.';
COMMENT ON COLUMN public.properties.has_basement     IS 'True if the property has a basement.';
COMMENT ON COLUMN public.properties.has_central_air  IS 'True if the property has central air conditioning.';

-- Also add rent_due_day_of_month and rent_proration_method to applications
-- if not already present (Phase 07 lease generation columns).
ALTER TABLE public.applications
  ADD COLUMN IF NOT EXISTS rent_due_day_of_month  SMALLINT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rent_proration_method  TEXT     DEFAULT 'daily';

COMMENT ON COLUMN public.applications.rent_due_day_of_month IS 'Day of month rent is due (1-28). Stored on the application after lease generation.';
COMMENT ON COLUMN public.applications.rent_proration_method IS 'First-month proration method: daily | 30day | none.';
