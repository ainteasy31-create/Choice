/**
 * CHOICE PROPERTIES — SHARED CREDENTIALS CONFIG
 * =============================================
 * This file is COMMITTED to the repo intentionally.
 *
 * It contains:
 *  - The public Supabase URL (safe to share — embedded in site JS)
 *  - The Supabase API key used to READ the shared credentials table.
 *    NOTE: This is the service_role key, which is ALREADY publicly
 *    committed in scraper/.env. It is used here so any fork can
 *    load credentials with zero restrictions.
 *  - A shared WRITE_SECRET that gates writes to the credentials table.
 *
 * The WRITE_SECRET is intentionally public (committed) so that ANY fork,
 * user, or AI can store/update credentials. This is a deliberate trade-off
 * for open collaboration. Do NOT put truly private secrets here.
 *
 * To rotate the WRITE_SECRET, change it here AND in the Supabase
 * `credentials_config` table (key: WRITE_SECRET). All forks must pull
 * the new value.
 */
export const CREDENTIALS_CONFIG = {
  // Public Supabase project URL (safe to share)
  SUPABASE_URL: "https://tlfmwetmhthpyrytrcfo.supabase.co",

  // Supabase API key for reading the shared credentials table.
  // This is the service_role key — already public in scraper/.env.
  SUPABASE_API_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsZm13ZXRtaHRocHlyeXRyY2ZvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTE4MzAyNCwiZXhwIjoyMDkwNzU5MDI0fQ.oO9N8LslPcDjQrzZWiUoTkOlDBqUVHBiVhRSGLC-EPE",

  // Shared write-secret — gates writes to the credentials table.
  // Intentionally public so any fork can update credentials.
  WRITE_SECRET: "choice-properties-open-collab-2026",

  // The Edge Function that stores credentials
  STORE_CREDENTIALS_FUNCTION: "store-credentials",
}