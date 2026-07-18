# Choice Properties — Replit Workspace

## Project Overview

Choice Properties is a **pure static frontend** (HTML/CSS/JS) for a rental property marketplace. There is no Node.js/Python application server in this repo — all server-side logic runs on external hosted platforms.

**Stack:**
- **Frontend:** Static HTML + CSS + vanilla JS (no build step for the site itself)
- **Database/API:** Supabase (PostgreSQL + Edge Functions) — project ref `tlfmwetmhthpyrytrcfo`
- **CDN (photos):** ImageKit.io — endpoint `https://ik.imagekit.io/21rg7lvzo`
- **Deployment target:** Cloudflare Pages (auto-deploys on `git push origin main`)
- **Email relay:** Google Apps Script (`GAS-EMAIL-RELAY.gs`)
- **Address autocomplete:** Geoapify (optional — disabled if key not set)

## How to Run Locally (Replit Preview)

The workflow `Start application` runs `node _dev_preview.js` on port 5000.

Before the server starts, `config.js` must be generated:

```bash
SUPABASE_URL="$SUPABASE_URL" \
SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
IMAGEKIT_URL="$IMAGEKIT_URL" \
IMAGEKIT_PUBLIC_KEY="$IMAGEKIT_PUBLIC_KEY" \
SITE_URL="$SITE_URL" \
node generate-config.js
```

`config.js` and `_dev_preview.js` are gitignored — they exist only in Replit, never pushed to GitHub.

## Deployment

Push to `main` → GitHub CI validates → Cloudflare Pages builds (runs `node generate-config.js`) and deploys automatically. Production URL: `https://choice-properties-site.pages.dev`

## Environment Variables (all set in Replit shared env)

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project REST URL |
| `SUPABASE_ANON_KEY` | Supabase key used by browser client |
| `SUPABASE_SERVICE_ROLE_KEY` | Full-access key for admin/scraping tasks |
| `IMAGEKIT_URL` | ImageKit CDN endpoint |
| `IMAGEKIT_PUBLIC_KEY` | ImageKit public key |
| `IMAGEKIT_PRIVATE_KEY` | ImageKit private key (for uploads) |
| `IMAGEKIT_ID` | ImageKit account ID |
| `SITE_URL` | Canonical production URL (for sitemap/robots) |

## Key Files

| File | Purpose |
|---|---|
| `generate-config.js` | Build script — generates `config.js` from env vars |
| `_dev_preview.js` | Local static file server (Replit only, gitignored) |
| `config.js` | Generated config injected into every page (gitignored) |
| `js/cp-api.js` | Shared Supabase + API client used by all pages |
| `js/components.js` | Shared nav/footer injected at build time |
| `ARCHITECTURE.md` | Full system architecture reference |
| `SETUP.md` | Guide for standing up a fresh Supabase/Cloudflare project |
| `MIGRATION.md` | Database schema migrations |

## User Preferences

- Automate everything — do not ask to provide values that are already available in the environment or conversation.
- Use the provided credentials directly; do not prompt for re-entry.
