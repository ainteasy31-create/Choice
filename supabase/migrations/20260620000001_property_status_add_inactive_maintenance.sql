-- Add missing property_status enum values that the admin UI references.
-- The enum previously only had: draft, active, paused, rented, archived.
-- The admin portal shows inactive and maintenance as status options,
-- so any attempt to save those values was silently failing with a DB error.

ALTER TYPE property_status ADD VALUE IF NOT EXISTS 'inactive';
ALTER TYPE property_status ADD VALUE IF NOT EXISTS 'maintenance';
