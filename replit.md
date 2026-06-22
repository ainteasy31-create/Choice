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
- **Scraper (Realtor.com):** `scraper/scraper.py` — run from Replit shell → stages into `pipeline.pipeline_properties`
- **Scraper (Zillow):** `scraper/zillow_scraper.py` — run from **iSH Shell on iPhone** (requires residential IP; Zillow blocks Replit/datacenter IPs) → same pipeline table
- **iOS Single-listing Importer:** `shortcuts/import-to-choice.js` — Scriptable script; lets the owner import any Zillow listing from Safari on iPhone directly into the pipeline with one tap, no computer required

## iSH Shell (iPhone — Zillow Scraper)
The Zillow scraper must run from a residential IP. The owner uses **iSH** (free Alpine Linux terminal app for iOS, available on the App Store).

**One-time setup in iSH:**
```bash
apk add python3 py3-pip git
pip3 install homeharvest requests python-dotenv
git clone https://ghp_<TOKEN>@github.com/choice121/Choice.git
cd Choice/scraper
# Create .env:
echo 'SUPABASE_URL=https://tlfmwetmhthpyrytrcfo.supabase.co' > .env
echo 'SUPABASE_SERVICE_ROLE_KEY=eyJ...' >> .env
```

**Pulling latest code in iSH (run before every scrape session):**
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

**Key iSH constraints (important for future edits to scraper files):**
- Python 3.9 (Alpine Linux) — f-strings with Unicode curly quotes (`"`, `"`) cause SyntaxError. Use plain ASCII quotes only.
- No Docker, no Supabase CLI, no `git push` (use `git pull` with token URL)
- Realtor.com scraper works fine from Replit shell (datacenter IP is OK)
- Zillow scraper needs iSH or any residential IP (mobile data or home WiFi)

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

## How to Deploy Edge Functions
Use the Supabase CLI via npx — no Docker, no local Supabase install needed:
```bash
SUPABASE_ACCESS_TOKEN=sbp_... \
  npx supabase@latest functions deploy <function-name> \
  --project-ref tlfmwetmhthpyrytrcfo \
  --use-api
```
The `--use-api` flag bundles server-side (skips Docker). `SUPABASE_ACCESS_TOKEN` is the personal access token (starts with `sbp_`). The `SUPABASE_MANAGEMENT_TOKEN` env var does **not** work for function deployment — use `SUPABASE_ACCESS_TOKEN` only.

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
| File | Purpose |
|------|---------|
| `scraper.py` | Main CLI — orchestrates Realtor.com + Zillow, batch inserts, dedup, logging |
| `zillow_scraper.py` | Zillow `__NEXT_DATA__` HTML parser module (called by `scraper.py`) |
| `requirements.txt` | `pip install homeharvest requests python-dotenv` |
| `README.md` | Full scraper usage guide |
| `cities.txt` *(optional)* | One location per line for `--locations-file` bulk runs |

### Database
- `supabase/migrations/` — Full schema history (source of truth)
- `supabase/functions/` — Edge Functions (Deno/TypeScript)

## User Preferences
- This project is for Cloudflare Pages only. Never configure Replit workflows or production servers.
- Push all changes to GitHub via the Git Data API (blob → tree → commit → PATCH refs/heads/main).
- Apply SQL to Supabase via the Management API (write JSON to `/tmp/`, use `curl --data-binary`).
- Deploy edge functions via `npx supabase@latest functions deploy --use-api --project-ref tlfmwetmhthpyrytrcfo` with `SUPABASE_ACCESS_TOKEN` env var.
- Admin portal is at `/admin/` — requires entry in `admin_roles` Supabase table.
- `config.js` does not exist in the repo — generated at Cloudflare build time.

## Important Database Notes

### Supabase Connection
- Project ref: `tlfmwetmhthpyrytrcfo`
- URL: `https://tlfmwetmhthpyrytrcfo.supabase.co`
- Management API token stored as `SUPABASE_MANAGEMENT_TOKEN` env var in Replit (for DB queries only — NOT for edge function deployment)

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
| `pipeline_publish(id, landlord_id)` | Create `public.properties` draft + mark published; sets `choice_property_id` on the pipeline record |

## Edge Functions (`supabase/functions/`)

### Deployed functions relevant to the scraper/pipeline workflow
| Function | Purpose |
|----------|---------|
| `import-pipeline-photos` | Fetches source photos (Zillow/Realtor CDN) server-side, uploads to ImageKit, stores in `property_photos` via `add_property_photo` RPC. Accepts `{ property_id }` — looks up the pipeline source automatically via `choice_property_id`. Returns `{ transferred, skipped, no_source }`. |
| `imagekit-upload` | Uploads a base64-encoded file to ImageKit; optionally persists to `property_photos` when `propertyId` is provided. Rate-limited to 60 uploads per 10 min per user. |
| `imagekit-watermark` | Applies watermark to an existing ImageKit photo by URL + file_id. Called from property-detail watermark button. |

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

### Pipeline (`/admin/pipeline.html`)
Scraper stages listings into `pipeline.pipeline_properties`. Admin reviews and publishes from this page.

**Filter chips (two rows):**
- Row 1 — Status: New / Edited / All / Published / Archived (live counts from `pipeline_count()` RPC)
- Row 2 — Source: All / Zillow / Realtor (client-side filter, no server round-trip)

**Card features:**
- Thumbnail from first source photo
- Source badge: blue `ZILLOW` or red `REALTOR`
- Quality score badge (0–100), missing fields count
- Checkbox in top-left corner of thumbnail for bulk selection

**Bulk action bar (slides up from bottom when cards are checked):**
- Select all / clear
- "Publish all →" — publishes all selected non-published/non-archived listings as drafts

**Single publish flow (via panel):**
1. Click a card → right-side panel opens
2. Edit fields → Save changes
3. "Publish as draft →" → calls `pipeline_publish()` RPC → creates `public.properties` draft
4. Auto-opens `property-detail.html` in new tab
5. Auto-triggers `import-pipeline-photos` edge function in background (transfers up to 20 photos to ImageKit)
6. Toast: "Transferring X photos…" then "X photos added to ImageKit ✓"

> **Note:** Bulk publish does NOT auto-transfer photos (rate limit). Use "Import source photos" button on each property-detail page instead.

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
- **"Import source photos" button** → calls `import-pipeline-photos` edge function with `{ property_id }`. Finds the pipeline source automatically, downloads up to 20 photos from the Zillow/Realtor CDN server-side (no CORS issues), uploads to ImageKit, saves to `property_photos`. Gallery refreshes in place. Shows `no_source` message if property wasn't from the scraper.

### Cross-links
- `audit-log.js` property target links → `/property.html?id=`
- `landlords.js` property list links → `/property.html?id=`
- `pipeline.js` publish → opens `admin/property-detail.html?id=` in new tab

### Page-by-page status
| Page | Status |
|------|--------|
| dashboard.js | `dashboard_pulse` RPC + pipeline staging widget (`pipeline_stats` RPC); action queue, KPI strip, recent activity |
| pipeline.js | Source filter chips + bulk select/publish; edit panel; single publish with auto photo transfer; archive |
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
| property-detail.js | Full edit + upload + "Import source photos" button → import-pipeline-photos edge fn |

## Scraper Usage (v3)

Two sources, one command. Run Realtor.com from Replit shell; run Zillow from iSH on iPhone.

```bash
# Realtor.com only (default) — safe to run from Replit
python scraper/scraper.py --location "Dallas, TX"

# Zillow only — run from iSH on iPhone (residential IP required)
python3 scraper.py --location "Dallas, TX" --source zillow

# Both sources — run from iSH; Replit will be blocked by Zillow
python3 scraper.py --location "Dallas, TX" --source both

# Multiple cities, both sources
python3 scraper.py --location "Dallas, TX" --location "Houston, TX" --source both

# From a cities file
python3 scraper.py --locations-file cities.txt --source both

# Filtered
python scraper/scraper.py --location "Miami, FL" --past-days 14 --beds-min 2 --price-max 3000

# Dry run — preview without writing to DB
python3 scraper.py --location "Austin, TX" --source zillow --dry-run
```

Scraped listings land in `pipeline.pipeline_properties` with `status = 'scraped'`. All runs logged to `pipeline.pipeline_scrape_runs`. Deduplication is by `source_listing_id`.

## Recent Migrations (applied via Management API)
- `20260620000001_property_status_add_inactive_maintenance.sql` — adds `inactive`, `maintenance` to status enum
- `20260620000002_property_admin_fields.sql` — adds `admin_notes`, `featured` to `properties`
- `20260620000003_pipeline_stats_rpc.sql` — `pipeline_stats()` RPC for dashboard widget
- `20260620000004_pipeline_rpcs.sql` — `pipeline_count`, `pipeline_list`, `pipeline_save`, `pipeline_archive`, `pipeline_publish` RPCs
- `20260621000001_property_location_features.sql` — adds `county`, `neighborhood`, `location_context`, `has_basement`, `has_central_air` to `properties`; adds `rent_due_day_of_month`, `rent_proration_method` to `applications`

## Recent Edge Function Deployments
- `import-pipeline-photos` — deployed via `npx supabase@latest functions deploy --use-api`. Fetches pipeline source photos server-side and uploads to ImageKit. Accepts `{ property_id }` only — looks up pipeline record by `choice_property_id` internally.
- `imagekit-watermark` — deployed via `npx supabase@latest functions deploy --use-api`. Applies a "Choice Properties" text overlay to an ImageKit photo via URL transformation. Accepts `{ url, file_id, property_id }`, updates `property_photos.url` and sets `watermark_status='applied'`. Admin-only.
