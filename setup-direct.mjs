#!/usr/bin/env node
/**
 * Direct credential storage bypassing the form
 * Usage: SUPABASE_API_TOKEN="your-token" node setup-direct.mjs
 */

import fetch from "node-fetch"

const supabaseUrl = "https://tlfmwetmhthpyrytrcfo.supabase.co"
const token = process.env.SUPABASE_API_TOKEN

if (!token) {
  console.error("❌ SUPABASE_API_TOKEN environment variable not set")
  console.error("Usage: SUPABASE_API_TOKEN='your-token' node setup-direct.mjs")
  process.exit(1)
}

console.log("🔐 Storing credentials directly to Supabase...")

// Sample credentials - replace with actual values
const credentials = {
  supabase_url: "https://tlfmwetmhthpyrytrcfo.supabase.co",
  anon_key: process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  service_role_key: process.env.SUPABASE_SERVICE_ROLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  supabase_api_token: token,
  github_api_token: process.env.GITHUB_API_TOKEN || "ghp_...",
}

try {
  const response = await fetch(`${supabaseUrl}/functions/v1/store-credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY || credentials.anon_key}`,
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
