#!/bin/bash

# Simple credential storage script
# Just set these 5 environment variables and run the script

SUPABASE_URL="${SUPABASE_URL:?Error: Set SUPABASE_URL}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:?Error: Set SUPABASE_ANON_KEY}"
SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:?Error: Set SUPABASE_SERVICE_ROLE_KEY}"
SUPABASE_API_TOKEN="${SUPABASE_API_TOKEN:?Error: Set SUPABASE_API_TOKEN}"
GITHUB_API_TOKEN="${GITHUB_API_TOKEN:?Error: Set GITHUB_API_TOKEN}"

echo "🔐 Storing credentials to Supabase..."

# Call the Edge Function to store credentials
RESPONSE=$(curl -s -X POST "https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/store-credentials" \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"supabase_url\": \"${SUPABASE_URL}\",
    \"anon_key\": \"${SUPABASE_ANON_KEY}\",
    \"service_role_key\": \"${SUPABASE_SERVICE_ROLE_KEY}\",
    \"supabase_api_token\": \"${SUPABASE_API_TOKEN}\",
    \"github_api_token\": \"${GITHUB_API_TOKEN}\"
  }")

if echo "$RESPONSE" | grep -q "success"; then
  echo "✅ Credentials stored successfully!"
  echo ""
  echo "Next steps:"
  echo "  1. Go to Supabase and DELETE the old token"
  echo "  2. Run: npm run load-credentials"
else
  echo "Response: $RESPONSE"
fi
