# Choice Properties

## Project Overview
Nationwide rental property marketplace and management platform. Static HTML/CSS/JS site deployed exclusively to **Cloudflare Pages**. Replit is used for code editing and database management only — do not run production servers here.

## Architecture
- **Frontend:** Vanilla HTML/CSS/JS (no framework)
- **Backend:** Supabase (PostgreSQL + SECURITY DEFINER RPCs + Edge Functions via Deno/TypeScript)
- **Hosting:** Cloudflare Pages (auto-deploys on every push to `main`)
- **Images:** ImageKit.io CDN
- **Maps:** Leaflet + Geoapify
- **Auth:** Supabase Auth (PKCE flow)
- **Scraper (Realtor.com):** Python + HomeHarvest CLI (`scraper/scraper.py`) — run from Replit shell → stages into `pipeline.pipeline_properties`
- **Scraper (Zillow):** `scraper/zillow_scraper.py` — run from **iSH Shell on iPhone** (requires residential IP; Zillow blocks datacenter IPs) → same pipeline table

## iSH Shell (iPhone Scraper)
The Zillow scraper must run from a residential IP. The owner runs it from **iSH** (Alpine Linux terminal app for iOS):

**Setup (one-time):**
```bash
# In iSH on iPhone
apk add python3 py3-pip git
pip3 install homeharvest requests python-dotenv
git clone https://ghp_<TOKEN>@github.com/choice121/Choice.git
cd Choice/scraper
# Create .env with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
```

**Pulling latest code in iSH:**
```bash
cd ~/Choice
git pull https://ghp_<TOKEN>@github.com/choice121/Choice.git
```

**Running the Zillow scraper from iSH:**
```bash
cd ~/Choice/scraper
python3 scraper.py --location "Dallas, TX" --source zillow --dry-run   # preview
python3 scraper.py --location "Dallas, TX" --source zillow              # real run
python3 scraper.py --location "Dallas, TX" --source both               # Zillow + Realtor
```

**Key iSH constraints:**
- Python 3.9 (Alpine) — no f-strings with Unicode curly quotes (`"`, `"`)
- No Docker, no Supabase CLI
- Realtor.com scraper works fine from Replit shell (datacenter IP is OK)
- Zillow scraper needs iSH / any residential IP (mobile data or home WiFi)

## Repository
- GitHub: https://github.com/choice121/Choice
- Cloudflare Pages auto-builds on every push to `main`
- **Live site:** https://choice-properties-site.pages.dev
- **Admin portal:** https://choice-properties-site.pages.dev/admin/

## How to Push Changes
Always use the GitHub Git Data API — never `git push` from Replit:
1. Create blobs for each changed file (`POST /repos/{repo}/git/blobs`)
2. Create a tree (`POST /repos/{repo}/git/trees`, base_tree = current HEAD tree SHA)
3. Create a commit (`POST /repos/{repo}/git/commits`)
4. Update the ref (`PATCH /repos/{repo}/git/refs/heads/main`)

## How to Run Database Queries
Use the Supabase Management API directly — no Supabase dashboard needed:
```
POST https://api.supabase.com/v1/projects/tlfmwetmhthpyrytrcfo/database/query
Authorization: Bearer <SUPABASE_MANAGEMENT_TOKEN>
Content-Type: application/json
Body: { "query": "SQL here" }
```
Write the SQL to `/tmp/payload.json` via Python `json.dumps`, then send with `curl --data-binary @/tmp/payload.json` to avoid shell-escaping issues with complex SQL.

## Key Files

### Shared / Core
- `generate-config.js` — Build script: generates `config.js` from env vars at Cloudflare build time. `config.js` is **not** in the repo.
- `js/cp-api.js` — Central Supabase client; exposes `window.CP` namespace
- `js/cp-chrome.js` — Shared portal chrome: SVG sprite, sidebar nav, appbar, tabbar. **Edit here to add nav links.**
- `js/cp-shell.js` — Shared shell helpers: toasts, confirm dialogs, bottom sheets, auth guards
- `serve.js` — Local dev server (port 5000) for Replit preview only

### Admin Pages (`/admin/`)
| File | Description |
|------|-------------|
| `dashboard.html` + `js/admin/dashboard.js` | KPI pulse, action queue, pipeline staging widget |
| `pipeline.html` + `js/admin/pipeline.js` | Pipeline review: browse/edit/publish scraped listings |
| `applications.html` + `js/admin/applications.js` | Application list, filters, status changes |
| `leases.html` + `js/admin/leases.js` | Generate, send, countersign, void, download leases |
| `move-ins.html` + `js/admin/move-ins.js` | Confirm, schedule, prep guide |
| `inspections.html` + `js/admin/inspections.js` | Move-in checklists, warning banners |
| `landlords.html` + `js/admin/landlords.js` | Landlord list, verify/unverify, property links |
| `messages.html` + `js/admin/messages.js` | Thread view + admin reply |
| `email-logs.html` + `js/admin/email-logs.js` | 500-row load, type/status/app filters |
| `audit-log.html` + `js/admin/audit-log.js` | Audit log with smart property target links |
| `deposit-accounting.html` + `js/admin/deposit-accounting.js` | Deduction editor, dry-run, letter PDF |
| `watermark-review.html` + `js/admin/watermark-review.js` | Per-photo watermark scan, bulk delete |
| `state-law.html` + `js/admin/state-law.js` | State law reference table, sortable + searchable |
| `property-detail.html` + `js/admin/property-detail.js` | Full property edit — accessed via "Edit Full" button only, not in nav |
| `lease-detail.html` + `js/admin/lease-detail.js` | Lease detail view |
| `lease-template.html` + `js/admin/lease-template.js` | Lease template editor |

### Public Pages
- `listings.html` + `js/listings.js` — Public listing grid; admin mode overlay when `CP.Auth.isAdmin()` is true
- `property.html` + `js/property.js` — Public property detail; admin banner overlay when admin

### Scraper (`scraper/`)
- `scraper.py` — HomeHarvest CLI scraper: pulls Realtor.com for-rent listings → `pipeline.pipeline_properties`
- `requirements.txt` — `pip install homeharvest`
- `README.md` — Usage guide

### Database
- `supabase/migrations/` — Full schema history (source of truth, ~80 migration files)

## User Preferences
- This project is for Cloudflare Pages only. Never configure Replit workflows or production servers.
- Push all changes to GitHub via the Git Data API (blob → tree → commit → PATCH refs/heads/main).
- Apply SQL to Supabase via the Management API (write JSON to `/tmp/`, use `curl --data-binary`).
- Admin portal is at `/admin/` — requires entry in `admin_roles` Supabase table.
- `config.js` does not exist in the repo — generated at Cloudflare build time.

## Important Database Notes

### Supabase Connection
- Project ref: `tlfmwetmhthpyrytrcfo`
- URL: `https://tlfmwetmhthpyrytrcfo.supabase.co`
- Management API token stored as `SUPABASE_MANAGEMENT_TOKEN` env var in Replit

### Landlord RLS
Migration `20260425000013` restricts the `authenticated` role to only these landlord columns: `id, user_id, contact_name, business_name, avatar_url, verified, tagline`. Never query `phone` or `email` directly on landlords from the frontend — use `admin_list_landlords()` RPC for full admin access.

### Admin Action Logging
Admin actions must be logged to `admin_actions` with `action`, `target_type`, `target_id`, `metadata`, `user_id`. Use `CP.Auth.getSession()` (not `auth.getUser()`) to get `user_id`. Insert non-blocking inside `try/catch`. Include `source:'bulk'` in metadata for batch operations.

### Property Status Values
`active` | `rented` | `inactive` | `maintenance` | `draft` | `paused` | `archived`

### Admin Action Keys
`property.edit` | `property.status_change` | `property.hard_delete` | `property.photo_delete` | `property.photo_reorder` | `property.featured_change`

### Lease / Application Fields
`CP.Applications.getAll()` SELECT must include `rent_due_day_of_month` and `rent_proration_method` — the lease generation form pre-populates from these.

### Pipeline Schema
The `pipeline` schema is private (service_role only via direct REST). Frontend accesses it exclusively through `SECURITY DEFINER` RPCs in the `public` schema:
| RPC | Purpose |
|-----|---------|
| `pipeline_stats()` | Count by status — used by dashboard widget |
| `pipeline_count()` | Count by status — used by pipeline page filter chips |
| `pipeline_list(status, limit, offset)` | Paginated listing fetch |
| `pipeline_save(id, patch)` | Edit a pipeline listing (auto-promotes scraped → edited) |
| `pipeline_archive(id)` | Mark archived |
| `pipeline_publish(id, landlord_id)` | Create `public.properties` draft + mark published |

## Admin Portal — Current State (June 2026)

### Navigation
`cp-chrome.js` defines the sidebar nav and mobile tab/more lists. To add a new page, register it in **both** `nav` and `more` arrays inside the `admin` portal config.

**Current admin nav sections:**
- Overview: Dashboard
- Applications: Applications, Leases, Move-ins
- Properties: Properties (→ /listings.html), **Pipeline**, Landlords
- Communications: Messages, Email Logs
- Operations: Inspections
- Admin: Audit Log, Watermark Review, Deposit Accounting, State Law Reference

### Pipeline (scraped listings review)
- Scraper (`scraper/scraper.py`) stages raw Realtor.com listings into `pipeline.pipeline_properties`
- `/admin/pipeline.html` — filter chips (New/Edited/Published/Archived/All) with live counts
- Click a card → right-side panel: photo strip, editable fields, Save / Publish / Archive
- **Publish** → calls `pipeline_publish()` RPC → creates `public.properties` record (status=`draft`) → admin then opens property-detail to add ImageKit photos and activate
- Dashboard widget shows pipeline counts and surfaces an action card when listings await review

### Admin mode on /listings.html
- `CP.Auth.isAdmin()` checked at boot; if true, admin toolbar injected (sticky dark header)
- Status filter chips: All / Active / Rented / Inactive / Maintenance / Draft / Paused / Archived
- CSV export (up to 1,000 rows, current filter applied)
- Landlord filter banner when `?landlord=` param is active
- Each card: selection checkbox + status badge + "Edit" → `admin/property-detail.html?id=` + "Featured" badge
- Card click → `/property.html?id=X`
- **Bulk action bar:** status change + feature/unfeature with confirm dialogs and per-property audit logs

### Admin mode on /property.html
- Non-active properties shown without redirect
- Sticky admin banner: status dropdown + Save, Edit Full / Applications / Audit Log links
- Admin info section: metrics (views, apps, saves) + editable `admin_notes` textarea
- Status change logs `property.status_change` to `admin_actions`

### Admin property-detail.html
- All core listing fields + county, neighborhood, location_context, has_basement, has_central_air, virtual_tour_url, featured toggle
- **Autosave:** `sessionStorage` (per-tab) — key `pd_draft_{propId}`
- Landlord picker: search input filters 200-landlord select, cached across opens
- Photo gallery refreshes in place after delete
- HEIC/HEIF uploads blocked with user-facing error
- Watermark apply → `imagekit-watermark` edge function with Bearer token

### Cross-links
- `audit-log.js` property target links → `/property.html?id=`
- `landlords.js` property list links → `/property.html?id=`
- `pipeline.js` publish → opens `admin/property-detail.html?id=` in new tab

### Page-by-page status
| Page | Status |
|------|--------|
| dashboard.js | `dashboard_pulse` RPC + pipeline staging widget (`pipeline_stats` RPC); action queue, KPI strip, recent activity |
| pipeline.js | Browse/filter scraped listings; edit panel; publish to draft; archive |
| leases.js | Generate/send/countersign/void/download; `rent_due_day_of_month` + `rent_proration_method` pre-populated |
| move-ins.js | Confirm, schedule, prep guide, date/notes edit |
| messages.js | Thread view + admin reply |
| email-logs.js | 500-row load, type/status/app filters |
| inspections.js | Warning banners for required-state move-in checklists |
| deposit-accounting.js | Full deduction editor, dry-run recompute, letter PDF; 401 → session redirect |
| watermark-review.js | Per-photo scan; scan results saved by photo ID; bulk delete |
| state-law.js | State law reference table, sortable + searchable |
| landlords.js | admin_list_landlords RPC, verify/unverify, property links → /property.html |
| audit-log.js | property.* actions, smart target links |

## Scraper Usage

Run locally (Python 3.9+ required):
```bash
pip install homeharvest
export SUPABASE_URL="https://tlfmwetmhthpyrytrcfo.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="..."

# Basic scrape
python scraper/scraper.py --location "Dallas, TX"

# Filtered
python scraper/scraper.py --location "Miami, FL" --past-days 14 --beds-min 2 --price-max 3000

# Preview only
python scraper/scraper.py --location "Austin, TX" --dry-run
```

Scraped listings land in `pipeline.pipeline_properties` with `status = 'scraped'`. All runs logged to `pipeline.pipeline_scrape_runs`. Deduplication is by `source_listing_id`.

## Recent Migrations (applied via Management API)
- `20260620000001_property_status_add_inactive_maintenance.sql` — adds `inactive`, `maintenance` to status enum
- `20260620000002_property_admin_fields.sql` — adds `admin_notes`, `featured` to `properties`
- `20260620000003_pipeline_stats_rpc.sql` — `pipeline_stats()` RPC for dashboard widget
- `20260620000004_pipeline_rpcs.sql` — `pipeline_count`, `pipeline_list`, `pipeline_save`, `pipeline_archive`, `pipeline_publish` RPCs
- `20260621000001_property_location_features.sql` — adds `county`, `neighborhood`, `location_context`, `has_basement`, `has_central_air` to `properties`; adds `rent_due_day_of_month`, `rent_proration_method` to `applications`
