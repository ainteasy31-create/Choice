#!/usr/bin/env node
/**
 * Verify the open-collaboration Supabase setup:
 *  1. Check if credentials_config table exists & is readable (public read policy)
 *  2. Report current stored credentials (masked)
 *  3. Test public-read availability with anon key if available
 *
 * Reads the service role key from scraper/.env (already committed publicly).
 */

import { CREDENTIALS_CONFIG } from "../credentials-config.mjs"

const SUPABASE_URL = CREDENTIALS_CONFIG.SUPABASE_URL
const SERVICE_KEY = CREDENTIALS_CONFIG.SUPABASE_API_KEY

async function check() {
  console.log("🔍 Verifying open-collaboration setup...")
  console.log(`   Project: ${SUPABASE_URL}`)
  console.log("")

  // 1. Check if the table exists and is readable (SELECT via REST)
  const url = `${SUPABASE_URL}/rest/v1/credentials_config?select=key,is_secret&order=key`
  try {
    const resp = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
    })

    if (resp.ok) {
      const rows = await resp.json()
      console.log("✅ credentials_config table EXISTS and is readable via service role.")
      console.log("   Stored keys:")
      if (rows.length === 0) {
        console.log("   (empty — no credentials stored yet)")
      } else {
        rows.forEach((r) =>
          console.log(`   - ${r.key}${r.is_secret ? " (secret)" : ""}`)
        )
      }
    } else {
      const body = await resp.text()
      console.log(`❌ Table not readable (HTTP ${resp.status}): ${body}`)
    }
  } catch (e) {
    console.log(`❌ Network error: ${e.message}`)
  }
  console.log("")

  // 2. Test the public-read policy using the ANON key if we can find one.
  //    (The anon key is NOT stored in the repo — only service role.)
  //    If the migration applied, public read should work for ANY caller,
  //    but we need a valid anon key to test it. We'll note this.
  console.log("ℹ️ Note: Public-read (anon) verification requires the Supabase anon key,")
  console.log("   which is not stored in this repo (only service role).")
  console.log("   The migration grants anon SELECT — this will work once you store")
  console.log("   credentials and any fork can read them with the anon key.")
  console.log("")

  // 3. Recommend next steps
  console.log("Next steps:")
  console.log("  1. Ensure the migration has applied (auto via supabase-deploy.yml on push)")
  console.log("  2. Store credentials once: npm run setup-credentials (or npm run setup-direct)")
  console.log("  3. Any fork: npm run load-credentials")
}

check()