#!/usr/bin/env node
/**
 * Store the known/committed credentials into the credentials_config table.
 * Used during initial setup so forks have data to load.
 * Uses the service role key (already public in scraper/.env).
 *
 * NOTE: Only the 5 original keys are allowed by the table's valid_key
 * constraint. WRITE_SECRET is intentionally NOT stored in the DB — it lives
 * in credentials-config.mjs in the repo, which every fork already has.
 */
import { CREDENTIALS_CONFIG } from "../credentials-config.mjs"

const SUPABASE_URL = CREDENTIALS_CONFIG.SUPABASE_URL
const SERVICE_KEY = CREDENTIALS_CONFIG.SUPABASE_API_KEY

async function store() {
  // Only store keys within the table's valid_key constraint
  const rows = [
    { key: "SUPABASE_URL", value: SUPABASE_URL, is_secret: false },
    { key: "SUPABASE_SERVICE_ROLE_KEY", value: SERVICE_KEY, is_secret: true },
  ]

  const url = `${SUPABASE_URL}/rest/v1/credentials_config`
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  })

  console.log("Store status:", resp.status)
  const text = await resp.text()
  console.log(text || "(empty)")
  if (!resp.ok) {
    process.exit(1)
  }
  console.log("✅ Known credentials stored.")
}

store().catch((e) => {
  console.error("Failed:", e.message)
  process.exit(1)
})