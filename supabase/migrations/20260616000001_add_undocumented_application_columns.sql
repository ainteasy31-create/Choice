-- Migration: Document and ensure existence of application columns
-- These columns are inserted by receive-application edge function but were
-- never formally added in a migration. Using ADD COLUMN IF NOT EXISTS so
-- this is safe to run against both fresh and existing databases.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS previous_residency_duration      TEXT,
  ADD COLUMN IF NOT EXISTS employment_start_date            TEXT,
  ADD COLUMN IF NOT EXISTS supervisor_name                  TEXT,
  ADD COLUMN IF NOT EXISTS supervisor_phone                 TEXT,
  ADD COLUMN IF NOT EXISTS primary_payment_method_other     TEXT,
  ADD COLUMN IF NOT EXISTS alternative_payment_method_other TEXT,
  ADD COLUMN IF NOT EXISTS third_choice_payment_method      TEXT,
  ADD COLUMN IF NOT EXISTS third_choice_payment_method_other TEXT;
