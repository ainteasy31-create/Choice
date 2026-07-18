-- ============================================================
-- MIGRATION: Drop old 7-param add_property_photo overload
-- Date: 2026-07-18
-- Root cause: Two overloaded signatures of add_property_photo
-- coexist in the DB:
--   (TEXT,TEXT,TEXT,TEXT,TEXT,INT,INT)          ← old, 7 params
--   (TEXT,TEXT,TEXT,TEXT,TEXT,INT,INT,INT,BOOLEAN) ← current, 9 params
-- When called with only 3 named args (all others defaulting),
-- PostgreSQL cannot resolve the ambiguity and raises:
--   "Could not choose the best candidate function"
-- Fix: drop the old overload. The 9-param version handles all
-- call sites and is the authoritative implementation.
-- ============================================================

DROP FUNCTION IF EXISTS public.add_property_photo(TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT);
