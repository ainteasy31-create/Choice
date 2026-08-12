#!/usr/bin/env node
/**
 * Load credentials from Supabase and create .env.local
 * This is run automatically when setting up a new fork.
 *
 * The credentials_config table is PUBLICLY READABLE (per the
 * "open collaboration" model), so this works with just the anon key.
 *
 * Uses only Node.js built-in fetch (Node 18+) — no external deps.
 */

import * as fs from "fs"
import * as path from "path"
import { CREDENTIALS_CONFIG } from "../credentials-config.mjs"

const SUPABASE_URL = process.env.SUPABASE_URL || CREDENTIALS_CONFIG.SUPABASE_URL
const API_KEY = process.env.SUPABASE_API_KEY || CREDENTIALS_CONFIG.SUPABASE_API_KEY

async function loadCredentials() {
  if (!SUPABASE_URL || !API_KEY) {
    console.error("❌ Missing required configuration:")
    console.error("   SUPABASE_URL: Supabase project URL")
    console.error("   SUPABASE_API_KEY: Supabase API key (service role)")
    console.error("")
    console.error("These default to credentials-config.mjs values. Check that file.")
    process.exit(1)
  }

  try {
    console.log("📡 Connecting to Supabase...")

    // Fetch credentials from the publicly-readable table via REST API
    const url = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/credentials_config?select=*`
    const response = await fetch(url, {
      headers: {
        apikey: API_KEY,
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to fetch credentials (HTTP ${response.status}): ${body}`)
    }

    const data = await response.json()

    if (!data || data.length === 0) {
      console.warn("⚠️  No credentials found in config table.")
      console.warn("Please store credentials first (one-time):")
      console.warn("")
      console.warn("  npm run setup-credentials")
      console.warn("")
      console.warn("Then run this script again.")
      process.exit(1)
    }

    // Build .env.local from fetched credentials
    const envContent = data
      .map((config) => `${config.key}=${config.value}`)
      .join("\n")

    const envPath = path.join(process.cwd(), ".env.local")
    fs.writeFileSync(envPath, envContent, { mode: 0o600 })

    console.log("✅ Success! Created .env.local with the following credentials:")
    console.log("")
    data.forEach((config) => {
      const value = config.is_secret ? "***" : config.value
      console.log(`   ${config.key}=${value}`)
    })
    console.log("")
    console.log("You're ready to work end-to-end.")
    console.log("")
  } catch (error) {
    console.error("❌ Error:", error.message)
    process.exit(1)
  }
}

loadCredentials()