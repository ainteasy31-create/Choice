#!/usr/bin/env node
/**
 * Direct credential storage bypassing the form
 * Usage: node setup-direct.mjs
 *
 * Reads the shared config from credentials-config.js and stores
 * credentials via the store-credentials Edge Function.
 */

import { CREDENTIALS_CONFIG } from "./credentials-config.mjs"

const supabaseUrl = CREDENTIALS_CONFIG.SUPABASE_URL
const apiKey = CREDENTIALS_CONFIG.SUPABASE_API_KEY
const writeSecret = CREDENTIALS_CONFIG.WRITE_SECRET

// Credentials come from env vars (set by the caller) — no placeholders.
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabaseApiToken = process.env.SUPABASE_API_TOKEN
const githubApiToken = process.env.GITHUB_API_TOKEN

if (!serviceRoleKey || !supabaseApiToken || !githubApiToken) {
  console.error("❌ Missing required environment variables:")
  console.error("   SUPABASE_SERVICE_ROLE_KEY: Supabase service role key")
  console.error("   SUPABASE_API_TOKEN: Supabase API token")
  console.error("   GITHUB_API_TOKEN: GitHub personal access token")
  console.error("")
  console.error("Usage:")
  console.error("   SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_API_TOKEN=... GITHUB_API_TOKEN=... node setup-direct.mjs")
  process.exit(1)
}

console.log("🔐 Storing credentials directly to Supabase...")

const credentials = {
  supabase_url: supabaseUrl,
  anon_key: apiKey,
  service_role_key: serviceRoleKey,
  supabase_api_token: supabaseApiToken,
  github_api_token: githubApiToken,
  write_secret: writeSecret,
}

try {
  const response = await fetch(`${supabaseUrl}/functions/v1/store-credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(credentials),
  })

  const data = await response.json()

  if (response.ok) {
    console.log("✅ Credentials stored successfully!")
    console.log("You can now run: npm run load-credentials")
    process.exit(0)
  } else {
    console.error("❌ Error:", data.error)
    process.exit(1)
  }
} catch (error) {
  console.error("❌ Failed:", error.message)
  process.exit(1)
}