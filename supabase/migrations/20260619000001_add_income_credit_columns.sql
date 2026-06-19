-- Migration: add minimum_income_multiplier and minimum_credit_score to properties
-- Applied manually via Supabase Management API on 2026-06-19.
-- This file is for source-control record-keeping only.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS minimum_income_multiplier numeric,
  ADD COLUMN IF NOT EXISTS minimum_credit_score integer;

COMMENT ON COLUMN properties.minimum_income_multiplier IS 'Required gross monthly income as a multiple of monthly rent (e.g. 3 = 3× rent). Null means no requirement.';
COMMENT ON COLUMN properties.minimum_credit_score IS 'Minimum acceptable credit score for applicants. Null means no minimum.';
