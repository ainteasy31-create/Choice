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
- `js/cp-chrome.js` — Shared portal chrome (sidebar, appbar, tabbar, SVG sprite)
- `js/admin/property-detail.js` — Full admin property detail + editing (1180+ lines)
- `js/admin/properties.js` — Admin property list/cards (landlord filter banner, all 8 status chips)
- `js/admin/landlords.js` — Admin landlord list + detail slide-out (admin_list_landlords RPC)
- `js/admin/audit-log.js` — Audit log with property.* actions and smart target links
- `js/admin/listings.js` — Listings index with View link and all 7 statuses
- `supabase/migrations/` — Database schema history (source of truth)

## User Preferences
- This project is for Cloudflare Pages only. Never configure Replit workflows or servers.
- Push changes to GitHub via git; Cloudflare deploys automatically.
- Admin portal is at `/admin/` — requires entry in `admin_roles` Supabase table.
- `config.js` does not exist in repo — it is generated at Cloudflare build time from environment variables.

## Important Database Notes
- Migration `000013` (`20260425000013_landlords_auth_column_grants.sql`) restricts the `authenticated` role to only these landlord columns: `id, user_id, contact_name, business_name, avatar_url, verified, tagline`. Never query `phone` or `email` directly on landlords from the frontend — use the `admin_list_landlords()` RPC for full admin access.
- Admin actions should be logged to the `admin_actions` table with `action`, `target_type`, `target_id`, `metadata`, `user_id`.
- Property status values: `active`, `rented`, `inactive`, `maintenance`, `draft`, `paused`, `archived`.
- `admin_actions` action keys for properties: `property.edit`, `property.status_change`, `property.hard_delete`, `property.photo_delete`, `property.photo_reorder`.

## Admin Portal State (as of session ending May 2026)
All admin pages reviewed and functional. Key improvements made:

### property-detail.js
- Status select added to edit panel form (all 7 statuses; overrides inline toggle on save)
- Saving via edit panel refreshes inline status toggle bar immediately without page reload
- `pillCls()` extended with draft/paused/archived
- Inline status toggle now logs `property.status_change` to `admin_actions` (with `from`/`to` metadata)

### properties.js / properties.html
- Landlord filter banner shown when `?landlord=` param is active; name resolved via `admin_list_landlords` RPC
- All 8 status chips: all / active / rented / inactive / maintenance / draft / paused / archived

### audit-log.js / audit-log.html
- Property-related action labels and pill colours added
- `targetLink()` routes property targets → `property-detail.html`, app targets → `applications.html`
- Filter dropdown uses `<optgroup>` for Applications vs Properties, accepts 36-char UUIDs

### listings.js
- Each listing row has a "View ↗" link to `property-detail.html?id=`
- Status quick-change form includes all 7 statuses (inactive + maintenance added)

### applications.js
- Already comprehensive: bulk actions, deep-link `?id=`, full detail panels, payment/lease/holding-fee flows

### Other pages (all reviewed, already solid)
- dashboard.js: `dashboard_pulse` RPC + legacy fallback, KPI strip, action queue
- leases.js: Generate/send, countersign, void, download, utility matrix
- move-ins.js: Confirm, schedule, prep guide, date/notes edit
- messages.js: Thread view + admin reply
- email-logs.js: 500-row load, type/status/app filters
- inspections.js: Warning banners for required-state move-in checklists
- deposit-accounting.js: Full deduction editor, dry-run recompute, letter PDF generation
- watermark-review.js: Per-photo watermark scan + bulk apply
- state-law.js: State law reference table (sortable, searchable)
- landlords.js: admin_list_landlords RPC, verify/unverify, property list link
