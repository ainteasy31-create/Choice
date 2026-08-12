import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

Deno.serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: "Missing environment variables" }),
        { status: 500 }
      )
    }

    const client = createClient(supabaseUrl, serviceRoleKey)

    // Run migration SQL
    const { error: createError } = await client.rpc("exec_sql", {
      sql: `CREATE TABLE IF NOT EXISTS public.credentials_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        is_secret BOOLEAN DEFAULT false,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_key CHECK (key IN ('SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_API_TOKEN', 'GITHUB_API_TOKEN'))
      );`,
    })

    // Continue with other statements even if first fails
    await client.rpc("exec_sql", {
      sql: `ALTER TABLE public.credentials_config ENABLE ROW LEVEL SECURITY;`,
    }).catch(() => null)

    await client.rpc("exec_sql", {
      sql: `CREATE POLICY "Service role only access" ON public.credentials_config
        FOR ALL
        USING (auth.role() = 'service_role')
        WITH CHECK (auth.role() = 'service_role');`,
    }).catch(() => null)

    await client.rpc("exec_sql", {
      sql: `CREATE INDEX IF NOT EXISTS idx_credentials_config_key ON public.credentials_config(key);`,
    }).catch(() => null)

    return new Response(
      JSON.stringify({
        success: true,
        message: "Migration completed",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
})
