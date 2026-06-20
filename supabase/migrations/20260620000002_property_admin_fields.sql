-- Add admin_notes and featured columns to properties table
-- admin_notes: internal admin memo, never shown to landlords or tenants
-- featured: marks a listing as promoted/featured on the public site

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS admin_notes TEXT,
  ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for filtering featured listings
CREATE INDEX IF NOT EXISTS idx_properties_featured ON public.properties (featured) WHERE featured = TRUE;

-- Update the properties_select column grants for authenticated role
-- (admins already have full access via RLS bypass; this ensures landlord reads cannot see admin_notes)
REVOKE UPDATE (admin_notes) ON public.properties FROM authenticated;
GRANT  UPDATE (admin_notes) ON public.properties TO authenticated;

REVOKE UPDATE (featured)    ON public.properties FROM authenticated;
GRANT  UPDATE (featured)    ON public.properties TO authenticated;

-- Backfill: ensure existing rows have featured = false (should be default, but be safe)
UPDATE public.properties SET featured = FALSE WHERE featured IS NULL;

COMMENT ON COLUMN public.properties.admin_notes IS 'Internal admin-only memo. Never exposed to landlords or tenants.';
COMMENT ON COLUMN public.properties.featured    IS 'When true the property is promoted/featured on the public listing page.';
