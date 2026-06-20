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
- `js/cp-api.js` — Central Supabase API client, exposes `window.CP`; includes `CP.Properties.getListingsAdmin()` for admin-mode fetches
- `js/cp-shell.js` — Shared admin/landlord/tenant shell (toasts, bottom sheets, nav)
- `js/cp-chrome.js` — Shared portal chrome (sidebar, appbar, tabbar, SVG sprite)
- `js/admin/property-detail.js` — Full admin property detail + editing (1180+ lines); accessed via "Edit Full" button in admin overlay, not in nav
- `js/admin/landlords.js` — Admin landlord list + detail slide-out (admin_list_landlords RPC)
- `js/admin/audit-log.js` — Audit log with property.* actions and smart target links
- `js/admin/listings.js` — Admin listings management page
- `js/listings.js` — Public listings page; has admin mode overlay (toolbar, status chips, CSV export, card badges)
- `js/property.js` — Public property detail page; has admin panel overlay (status toggle, metrics, admin notes, quick links)
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

## Admin Portal State (as of session ending June 2026)
Admin nav "Properties" tab now links to public `/listings.html` with admin-mode overlays.
`admin/properties.html`, `js/admin/properties.js`, `js/admin/property-shared.js` have been deleted.
`admin/property-detail.html` is kept (out of nav) — accessed via "Edit Full" button in admin overlays.

### Admin mode on /listings.html
- `CP.Auth.isAdmin()` checked at boot; if true, admin toolbar injected (sticky, dark)
- Status chip strip: All / Active / Rented / Inactive / Maintenance / Draft / Paused / Archived
- CSV export button (exports all matching rows up to 1000)
- Landlord filter banner when `?landlord=` param active
- Each card gets a status badge overlay + "Edit" button → `admin/property-detail.html?id=`
- Card click → `/property.html?id=X` (always uses ID so non-active properties load)
- `CP.Properties.getListingsAdmin()` added to cp-api.js (no status='active' filter; admin RLS fires automatically)

### Admin mode on /property.html
- Admin check at load time; non-active properties shown to admin without redirect
- Sticky admin banner (dark): property title, status dropdown + Save, Edit Full / Applications / Audit Log links
- Admin info section: metrics (views, applications, saves, inquiries) + editable admin_notes textarea
- Status change saves via `CP.Properties.update()` and logs `property.status_change` to `admin_actions`

### Cross-links updated
- `audit-log.js` targetLink for `property` type → `/property.html?id=` (was relative `property-detail.html?id=`)
- `landlords.js` property list links → `/property.html?id=` (was `/admin/property-detail.html?id=`)

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
- landlords.js: admin_list_landlords RPC, verify/unverify, property list link → /property.html
- property-detail.js: Status select, photo reorder/delete, geocode, duplicate, full edit panel
