-- Create credentials_config table for storing encrypted credentials
-- This table is NOT in the public schema to keep it private
CREATE TABLE IF NOT EXISTS public.credentials_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  is_secret BOOLEAN DEFAULT false,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT valid_key CHECK (key IN ('SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_API_TOKEN', 'GITHUB_API_TOKEN'))
);

-- Add comment to table
COMMENT ON TABLE public.credentials_config IS 'Stores sensitive configuration credentials for Choice project';

-- Set RLS to prevent public access to secrets
ALTER TABLE public.credentials_config ENABLE ROW LEVEL SECURITY;

-- Only service_role can access this table
DO $$ BEGIN
  CREATE POLICY "Service role only access" ON public.credentials_config
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create an index on key for faster lookups
CREATE INDEX IF NOT EXISTS idx_credentials_config_key ON public.credentials_config(key);

-- Grant permissions to service_role
GRANT SELECT, INSERT, UPDATE, DELETE ON public.credentials_config TO service_role;
