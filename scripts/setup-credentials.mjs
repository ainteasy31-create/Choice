#!/usr/bin/env node
/**
 * Load credentials from Supabase and create .env.local
 * This is run automatically when setting up a new fork
 */

import * as fs from "fs"
import * as path from "path"
import { createClient } from "@supabase/supabase-js"

// For the initial setup, we need at least the SUPABASE_URL and ANON_KEY
// These should be passed as environment variables or command line args
const INITIAL_SUPABASE_URL = process.env.SUPABASE_URL || process.argv[2]
const INITIAL_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.argv[3]

async function loadCredentials() {
  if (!INITIAL_SUPABASE_URL || !INITIAL_ANON_KEY) {
    console.error("❌ Missing required environment variables:")
    console.error("   SUPABASE_URL: Supabase project URL")
    console.error("   SUPABASE_ANON_KEY: Supabase anon key")
    console.error("")
    console.error("Usage:")
    console.error("   npm run load-credentials")
    console.error("")
    console.error("Or set environment variables:")
    console.error("   export SUPABASE_URL=https://...")
    console.error("   export SUPABASE_ANON_KEY=eyJ...")
    console.error("   npm run load-credentials")
    console.error("")
    console.error("Note: All other credentials (service role, API tokens, etc.)")
    console.error("are fetched from the Supabase credentials_config table.")
    process.exit(1)
  }

  try {
    console.log("📡 Connecting to Supabase...")
    const supabase = createClient(INITIAL_SUPABASE_URL, INITIAL_ANON_KEY)

    console.log("🔍 Fetching credentials from config table...")
    const { data, error } = await supabase
      .from("credentials_config")
      .select("*")

    if (error) {
      throw new Error(`Failed to fetch credentials: ${error.message}`)
    }

    if (!data || data.length === 0) {
      console.warn("⚠️  No credentials found in config table.")
      console.warn("Please run the setup form first:")
      console.warn("")
      console.warn("1. Run: npm run open-setup")
      console.warn("2. Fill in your Supabase credentials")
      console.warn("3. Submit the form")
      console.warn("4. Then run this script again")
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
    console.log("📝 Next steps:")
    console.log("   1. Commit and push your changes")
    console.log("   2. Any fork will automatically have access to these credentials")
    console.log("")
  } catch (error) {
    console.error("❌ Error:", error.message)
    process.exit(1)
  }
}

loadCredentials()
