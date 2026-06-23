#!/usr/bin/env bash
# ============================================================
# Choice Properties — Scraper one-time setup
# Run this once after cloning or importing to a new environment.
#
# Usage:
#   bash scraper/setup.sh
#
# What it does:
#   1. Creates scraper/.env from existing env vars (if set)
#   2. Prompts for any missing required values
#   3. Verifies the Supabase connection works
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

echo ""
echo "═══════════════════════════════════════════"
echo "  Choice Properties — Scraper Setup"
echo "═══════════════════════════════════════════"
echo ""

# ── Already exists? ───────────────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  echo "✅  $ENV_FILE already exists — nothing to do."
  echo ""
  echo "To re-run setup, delete scraper/.env first:"
  echo "  rm scraper/.env && bash scraper/setup.sh"
  echo ""
  exit 0
fi

# ── Build .env from environment variables (if present) or prompt ───────────────

echo "Building scraper/.env ..."
echo ""

# SUPABASE_URL — has a known default
SUPABASE_URL_VAL="${SUPABASE_URL:-https://tlfmwetmhthpyrytrcfo.supabase.co}"

# SUPABASE_SERVICE_ROLE_KEY — required
if [ -n "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  SERVICE_KEY_VAL="$SUPABASE_SERVICE_ROLE_KEY"
  echo "✅  SUPABASE_SERVICE_ROLE_KEY — found in environment"
else
  echo "⚠️   SUPABASE_SERVICE_ROLE_KEY not found in environment."
  echo "    Find it: Supabase dashboard → Project Settings → API → service_role"
  echo ""
  read -r -p "    Paste your service role key: " SERVICE_KEY_VAL
  if [ -z "$SERVICE_KEY_VAL" ]; then
    echo "❌  Service role key is required. Aborting."
    exit 1
  fi
fi

# RESEND_API_KEY — optional
RESEND_VAL="${RESEND_API_KEY:-}"
NOTIFY_VAL="${NOTIFY_EMAIL:-}"
FROM_VAL="${FROM_EMAIL:-scraper@choiceproperties.com}"
ADMIN_VAL="${ADMIN_URL:-https://choice-properties-site.pages.dev/admin/pipeline.html}"

# ── Write the file ─────────────────────────────────────────────────────────────
cat > "$ENV_FILE" <<EOF
SUPABASE_URL=$SUPABASE_URL_VAL
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_KEY_VAL

# Optional — email summaries after scrape runs
RESEND_API_KEY=$RESEND_VAL
NOTIFY_EMAIL=$NOTIFY_VAL
FROM_EMAIL=$FROM_VAL
ADMIN_URL=$ADMIN_VAL
EOF

echo ""
echo "✅  scraper/.env created"
echo ""

# ── Verify the Supabase connection ─────────────────────────────────────────────
echo "Verifying Supabase connection..."

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "apikey: $SERVICE_KEY_VAL" \
  -H "Authorization: Bearer $SERVICE_KEY_VAL" \
  "https://tlfmwetmhthpyrytrcfo.supabase.co/rest/v1/")

if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "404" ]; then
  echo "✅  Supabase connection verified (HTTP $HTTP_STATUS)"
else
  echo "⚠️   Supabase returned HTTP $HTTP_STATUS — check your service role key"
fi

echo ""
echo "═══════════════════════════════════════════"
echo "  Setup complete. You can now run:"
echo ""
echo "  python3 scraper/scraper.py --location \"Dallas, TX\" --dry-run"
echo "  python3 scraper/scraper.py --location \"Dallas, TX\""
echo "═══════════════════════════════════════════"
echo ""
