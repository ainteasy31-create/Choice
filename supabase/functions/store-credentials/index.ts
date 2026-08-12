import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

serve(async (req) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const { supabase_url, anon_key, service_role_key, supabase_api_token, github_api_token } = await req.json()

    // Validate inputs
    if (!supabase_url || !anon_key || !service_role_key || !supabase_api_token || !github_api_token) {
      return new Response(
        JSON.stringify({ error: "Missing required credentials" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Get auth header for the calling user
    const authHeader = req.headers.get("authorization")
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Create admin client with service role (from environment)
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
    )

    // Try to store credentials - table should exist from migrations
    let { data, error } = await adminClient
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

    // If table doesn't exist, try to create it first
    if (error && error.message?.includes("does not exist")) {
      console.log("Creating credentials_config table...")
      
      // Create table using raw SQL execution
      const createResult = await fetch(
        `${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/exec_sql`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sql: `CREATE TABLE IF NOT EXISTS public.credentials_config (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              is_secret BOOLEAN DEFAULT false,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              CONSTRAINT valid_key CHECK (key IN ('SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_API_TOKEN', 'GITHUB_API_TOKEN'))
            );`
          })
        }
      ).catch(() => null)

      // Retry the upsert
      const retryResult = await adminClient
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
      
      data = retryResult.data
      error = retryResult.error
    }

    if (error) {
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
