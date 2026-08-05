-- Migration: Set all live (active) properties to pets_allowed = true
-- WARNING: Run this only after taking a backup and verifying with the team.
-- This migration updates `public.properties` rows with status = 'active'.

BEGIN;

-- Safety: preview affected rows
-- SELECT id, title, pets_allowed FROM public.properties WHERE status = 'active' AND (pets_allowed IS DISTINCT FROM true);

UPDATE public.properties
SET pets_allowed = true
WHERE status = 'active' AND (pets_allowed IS DISTINCT FROM true);

-- Optionally standardize pet_details for rows with no details
-- UPDATE public.properties
-- SET pet_details = 'Pets allowed. Contact the landlord for any pet deposits or breed/size restrictions.'
-- WHERE status = 'active' AND (pet_details IS NULL OR length(trim(pet_details)) = 0);

COMMIT;
