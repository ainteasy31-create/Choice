import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

/**
 * run-migration — DEPRECATED / SAFETY HARDENED
 *
 * Previously this function tried to auto-create the credentials_config table
 * by calling the `exec_sql` RPC. That RPC (if it exists) allows arbitrary SQL
 * execution — a catastrophic security risk, so it has been removed.
 *
 * Migrations are now applied ONLY via the declarative migration files in
 * supabase/migrations/ (applied by the supabase-deploy.yml workflow).
 *
 * This function now simply VERIFIES that the credentials_config table exists
 * and is publicly readable — it does NOT execute any DDL.
 */
Deno.serve(async (req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: "Missing environment variables" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    const client = createClient(supabaseUrl, serviceRoleKey)

    // Verify the credentials_config table exists by attempting a read.
    // This is read-only — no DDL, no exec_sql.
    const { data, error } = await client
      .from("credentials_config")
      .select("key")
      .limit(1)

    if (error) {
      return new Response(
        JSON.stringify({
          success: false,
          error: error.message,
          hint: "Run the migration: supabase/migrations/20260812170000_credentials_open_read.sql (applied automatically by supabase-deploy.yml)",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "credentials_config table exists and is readable.",
        tableFound: true,
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