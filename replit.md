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
- `js/admin/property-detail.js` — Full admin property detail + editing; accessed via "Edit Full" button in admin overlays, not in nav
- `js/admin/landlords.js` — Admin landlord list + detail slide-out (admin_list_landlords RPC)
- `js/admin/audit-log.js` — Audit log with property.* actions and smart target links
- `js/admin/leases.js` — Lease generation, send, countersign, void, utility matrix
- `js/listings.js` — Public listings page; has full admin mode overlay
- `js/property.js` — Public property detail page; has admin panel overlay
- `supabase/migrations/` — Database schema history (source of truth)

## User Preferences
- This project is for Cloudflare Pages only. Never configure Replit workflows or servers.
- Push changes to GitHub via the Git Data API (blob → tree → commit → PATCH refs/heads/main).
- Admin portal is at `/admin/` — requires entry in `admin_roles` Supabase table.
- `config.js` does not exist in repo — it is generated at Cloudflare build time from environment variables.

## Important Database Notes
- Migration `000013` restricts the `authenticated` role to only these landlord columns: `id, user_id, contact_name, business_name, avatar_url, verified, tagline`. Never query `phone` or `email` directly on landlords from the frontend — use `admin_list_landlords()` RPC for full admin access.
- Admin actions must be logged to `admin_actions` with `action`, `target_type`, `target_id`, `metadata`, `user_id`. Use `CP.Auth.getSession()` to get `user_id`.
- Property status values: `active`, `rented`, `inactive`, `maintenance`, `draft`, `paused`, `archived`.
- `admin_actions` action keys: `property.edit`, `property.status_change`, `property.hard_delete`, `property.photo_delete`, `property.photo_reorder`, `property.featured_change`.
- `CP.Applications.getAll()` SELECT must include every column the lease generation form pre-populates from — including `rent_due_day_of_month` and `rent_proration_method`.

## Admin Portal — Current State (June 2026)

### Deleted pages
`admin/properties.html`, `js/admin/properties.js`, `js/admin/property-shared.js` — removed. Admin nav "Properties" tab links directly to `/listings.html` with admin-mode overlays. `admin/property-detail.html` is kept out of nav, accessed via "Edit Full" button.

### Admin mode on /listings.html
- `CP.Auth.isAdmin()` checked at boot; if true, admin toolbar injected (sticky dark header)
- Status filter chips: All / Active / Rented / Inactive / Maintenance / Draft / Paused / Archived
- CSV export (up to 1,000 rows, current filter applied)
- Landlord filter banner when `?landlord=` param is active; param persisted through `pushURL`/`readURL`
- Each card: per-card selection checkbox (top-left) + status badge + "Edit" → `admin/property-detail.html?id=` + "Featured" badge when applicable
- Card click → `/property.html?id=X` (always uses ID so non-active properties load)
- **Bulk action bar** (appears when ≥1 card selected, sticky below toolbar):
  - Status dropdown → Apply (confirm dialog → parallel updates → `property.status_change` audit log per property)
  - ⭐ Feature / Unfeature buttons (confirm dialog → parallel updates → `property.featured_change` audit log per property)
  - Select all on page / Clear selection
- `CP.Properties.getListingsAdmin()` in cp-api.js fetches all statuses for admin; standard `getListings()` used for public view

### Admin mode on /property.html
- Admin check at load; non-active properties shown without redirect
- Sticky admin banner: property title, status dropdown + Save, Edit Full / Applications / Audit Log links
- Admin info section: metrics (views, applications, saves, inquiries) + editable `admin_notes` textarea
- Status change logs `property.status_change` to `admin_actions`
- 404 / missing property → redirect to `/listings.html`

### Admin property-detail.html (full edit panel)
- Edit panel fields include: all core listing fields + county, neighborhood, location_context, has_basement, has_central_air, virtual_tour_url (validated https://), featured toggle
- **Autosave:** `sessionStorage` (per-tab, not localStorage) — key `pd_draft_{propId}`. Restores checkboxes AND custom "other" amenity/tag values from saved snapshot.
- **Landlord assignment:** search input filters 200-landlord select in real time; cached across panel opens.
- Photo gallery refreshes in place after delete (no full page reload)
- HEIC/HEIF uploads blocked with user-facing error at both upload paths
- Watermark apply button calls `imagekit-watermark` edge function with Bearer token

### Cross-links
- `audit-log.js` property target links → `/property.html?id=`
- `landlords.js` property list links → `/property.html?id=`

### Page-by-page status
| Page | Status |
|------|--------|
| dashboard.js | `dashboard_pulse` RPC; `SETOF` array unwrapped correctly; range label shows `⚠ range n/a` for legacy source |
| leases.js | Generate/send/countersign/void/download; utility matrix values captured via FormData; `application_fee` passed to edge fn; `rent_due_day_of_month` + `rent_proration_method` pre-populated from DB |
| move-ins.js | Confirm, schedule, prep guide, date/notes edit |
| messages.js | Thread view + admin reply |
| email-logs.js | 500-row load, type/status/app filters |
| inspections.js | Warning banners for required-state move-in checklists |
| deposit-accounting.js | Full deduction editor, dry-run recompute, letter PDF; 401 → session redirect |
| watermark-review.js | Per-photo scan; scan results saved by photo ID (not just URL); bulk delete |
| state-law.js | State law reference table, sortable + searchable |
| landlords.js | admin_list_landlords RPC, verify/unverify, property links → /property.html |

## Recent Migrations (applied via Supabase dashboard)
- `20260621000001_property_location_features.sql` — adds `county`, `neighborhood`, `location_context`, `has_basement`, `has_central_air` to `properties`; adds `rent_due_day_of_month`, `rent_proration_method` to `applications`
- `20260620000002_property_admin_fields.sql` — adds `admin_notes`, `featured` to `properties`
- `20260620000001_property_status_add_inactive_maintenance.sql` — adds `inactive`, `maintenance` to status enum
