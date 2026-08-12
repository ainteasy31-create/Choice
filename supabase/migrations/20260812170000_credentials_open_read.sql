-- ============================================================
-- CHOICE PROPERTIES — OPEN COLLABORATION CREDENTIALS
-- ============================================================
-- Makes credentials_config PUBLICLY READABLE so any fork/user/AI
-- can fetch credentials without restrictions (matches open-collab goal).
-- Writes are gated by the shared WRITE_SECRET (validated in the
-- store-credentials Edge Function), not by RLS.
--
-- NOTE: This is a deliberate security trade-off. Anyone with the repo
-- can read all stored credentials. Do NOT store truly private secrets
-- here beyond what the project already shares.

-- Ensure the table exists (idempotent)
CREATE TABLE IF NOT EXISTS public.credentials_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  is_secret BOOLEAN DEFAULT false,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT valid_key CHECK (key IN (
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_API_TOKEN',
    'GITHUB_API_TOKEN',
    'WRITE_SECRET'
  ))
);

COMMENT ON TABLE public.credentials_config IS
  'Stores shared configuration credentials for Choice project. Publicly readable for open collaboration.';

-- Enable RLS (still on, but with a public-read policy)
ALTER TABLE public.credentials_config ENABLE ROW LEVEL SECURITY;

-- Drop any old restrictive policies so we start clean
DROP POLICY IF EXISTS "Service role only access" ON public.credentials_config;
DROP POLICY IF EXISTS "Public read access" ON public.credentials_config;
DROP POLICY IF EXISTS "Service role write access" ON public.credentials_config;

-- PUBLIC READ: anyone (anon) can SELECT credentials
CREATE POLICY "Public read access" ON public.credentials_config
  FOR SELECT
  USING (true);

-- WRITE: only service_role can INSERT/UPDATE/DELETE.
-- The store-credentials Edge Function uses service_role and validates
-- the shared WRITE_SECRET before writing.
CREATE POLICY "Service role write access" ON public.credentials_config
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_credentials_config_key ON public.credentials_config(key);

-- Grant SELECT to anon/authenticated (public read), and full to service_role
GRANT SELECT ON public.credentials_config TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.credentials_config TO service_role;