#!/usr/bin/env node
/**
 * Direct SQL execution against Supabase database
 */

import { createClient } from "@supabase/supabase-js"

const supabaseUrl = "https://tlfmwetmhthpyrytrcfo.supabase.co"
const serviceRoleKey = process.argv[2]

if (!serviceRoleKey) {
  console.error("❌ No service role key provided")
  process.exit(1)
}

console.log("🔧 Creating credentials table...")

const client = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

try {
  // Try to create the table by querying it first
  // If it doesn't exist, we'll get an error and can create it
  const { data, error: checkError } = await client
    .from("credentials_config")
    .select("count", { count: "exact", head: true })
    .limit(1)

  if (checkError && checkError.code === "PGRST116") {
    // Table doesn't exist, we need to create it
    console.log("⚠️  Table doesn't exist yet, attempting direct SQL execution...")

    // Use the REST API to execute SQL if available
    const response = await fetch(
      `${supabaseUrl}/rest/v1/rpc/sql_exec`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sql: `CREATE TABLE IF NOT EXISTS public.credentials_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            is_secret BOOLEAN DEFAULT false,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT valid_key CHECK (key IN ('SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_API_TOKEN', 'GITHUB_API_TOKEN'))
          );
          ALTER TABLE public.credentials_config ENABLE ROW LEVEL SECURITY;
          CREATE INDEX IF NOT EXISTS idx_credentials_config_key ON public.credentials_config(key);
          GRANT SELECT, INSERT, UPDATE, DELETE ON public.credentials_config TO service_role;`,
        }),
      }
    )

    const result = await response.json()
    if (!response.ok) {
      throw new Error(result.message || "SQL execution failed")
    }

    console.log("✅ Table created successfully!")
  } else if (!checkError) {
    console.log("✅ Table already exists!")
  } else {
    throw checkError
  }

  console.log("✅ Database setup complete!")
  process.exit(0)
} catch (error) {
  console.error("❌ Error:", error.message)
  process.exit(1)
}
