import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// The shared write-secret. This is intentionally committed in the repo
// (credentials-config.js) so any fork/user/AI can update credentials.
// It gates writes to the credentials table. Rotate by changing it here
// AND in the credentials_config table (key: WRITE_SECRET).
const WRITE_SECRET = Deno.env.get("CREDENTIALS_WRITE_SECRET") || "choice-properties-open-collab-2026"

serve(async (req) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const {
      supabase_url,
      anon_key,
      service_role_key,
      supabase_api_token,
      github_api_token,
      write_secret,
    } = body

    // Validate the write-secret FIRST — this is the gate that prevents
    // random internet users from overwriting credentials.
    if (!write_secret || write_secret !== WRITE_SECRET) {
      return new Response(
        JSON.stringify({ error: "Invalid write_secret. Check credentials-config.js in the repo." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Validate inputs
    if (!supabase_url || !anon_key || !service_role_key || !supabase_api_token || !github_api_token) {
      return new Response(
        JSON.stringify({ error: "Missing required credentials" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Create admin client with service role (from environment)
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
    )

    // Store credentials. The table must already exist (created by migration).
    // We do NOT auto-create the table here — that required the dangerous
    // exec_sql RPC which has been removed. Run the migration instead.
    const { error } = await adminClient
      .from("credentials_config")
      .upsert(
        [
          { key: "SUPABASE_URL", value: supabase_url, is_secret: false },
          { key: "SUPABASE_ANON_KEY", value: anon_key, is_secret: false },
          { key: "SUPABASE_SERVICE_ROLE_KEY", value: service_role_key, is_secret: true },
          { key: "SUPABASE_API_TOKEN", value: supabase_api_token, is_secret: true },
          { key: "GITHUB_API_TOKEN", value: github_api_token, is_secret: true },
        ],
        { onConflict: "key" }
      )

    if (error) {
      // If the table doesn't exist, tell the user to run the migration.
      if (error.message?.includes("does not exist")) {
        return new Response(
          JSON.stringify({
            error: "credentials_config table does not exist. Run the migration first: supabase/migrations/20260812170000_credentials_open_read.sql",
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        )
      }
      throw error
    }

    return new Response(
      JSON.stringify({ success: true, message: "Credentials stored securely" }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    )
  }
})