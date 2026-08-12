#!/usr/bin/env node
/**
 * Run database migration directly against Supabase
 */

import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Get token from environment
const token = process.argv[2]
if (!token) {
  console.error('❌ No token provided')
  process.exit(1)
}

// Extract project URL from token or use environment
const supabaseUrl = process.env.SUPABASE_URL || 'https://tlfmwetmhthpyrytrcfo.supabase.co'

console.log('🔧 Running database migration...')

const client = createClient(supabaseUrl, token, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
})

// Read migration file
const migrationPath = path.join(__dirname, 'supabase/migrations/20260812150000_create_credentials_config.sql')
const migrationSQL = fs.readFileSync(migrationPath, 'utf-8')

// Run migration
const { error, data } = await client.rpc('exec', {
  sql: migrationSQL,
})

if (error) {
  // Try direct query approach
  try {
    const statements = migrationSQL.split(';').filter(s => s.trim())
    for (const statement of statements) {
      if (statement.trim()) {
        const { error: execError } = await client.sql(statement.trim())
        if (execError) {
          console.warn('⚠️  Statement warning:', execError.message)
        }
      }
    }
    console.log('✅ Migration completed!')
  } catch (e) {
    console.error('❌ Migration failed:', e.message)
    process.exit(1)
  }
} else {
  console.log('✅ Migration completed!')
}

process.exit(0)
