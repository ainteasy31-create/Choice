# Choice Properties

## Project Overview
Nationwide rental property marketplace and management platform. Static HTML/CSS/JS site deployed exclusively to **Cloudflare Pages**. Replit is used for code editing only — do not run, configure workflows, or install packages here.

## Architecture
- **Frontend:** Vanilla HTML/CSS/JS (no framework)
- **Backend:** Supabase (PostgreSQL + Edge Functions via Deno/TypeScript)
- **Hosting:** Cloudflare Pages (auto-deploys on GitHub push)
- **Images:** ImageKit.io CDN
- **Maps:** Leaflet + Geoapify
- **Auth:** Supabase Auth (PKCE flow)

## Repository
- GitHub: https://github.com/choice121/Choice
- Cloudflare Pages auto-builds on every push to `main`

## Key Files
- `generate-config.js` — Build script that generates `config.js` from env vars (runs at Cloudflare build time)
- `js/cp-api.js` — Central Supabase API client, exposes `window.CP`
- `js/cp-shell.js` — Shared admin/landlord/tenant shell (toasts, bottom sheets, nav)
- `js/admin/property-detail.js` — Full admin property detail + editing
- `js/admin/properties.js` — Admin property list/cards
- `supabase/migrations/` — Database schema history (source of truth)

## User Preferences
- This project is for Cloudflare Pages only. Never configure Replit workflows or servers.
- Push changes to GitHub via git; Cloudflare deploys automatically.
- Admin portal is at `/admin/` — requires entry in `admin_roles` Supabase table.
- `config.js` does not exist in repo — it is generated at Cloudflare build time from environment variables.

## Important Database Notes
- Migration `000013` (`20260425000013_landlords_auth_column_grants.sql`) restricts the `authenticated` role to only these landlord columns: `id, user_id, contact_name, business_name, avatar_url, verified, tagline`. Never query `phone` or `email` directly on landlords from the frontend — use the `admin_list_landlords()` RPC for full admin access.
- Admin actions should be logged to the `admin_actions` table.
- Property status values: `active`, `rented`, `inactive`, `maintenance`, `draft`, `paused`, `archived`.
