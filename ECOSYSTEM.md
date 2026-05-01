# Choice Properties — Full Ecosystem Overview

> **Mandatory reading** for any developer or AI working on either the Choice website or the Property Pipeline. Both projects share one Supabase database. Changes in one affect the other.

---

## The Two Projects

| | Choice Website | Property Pipeline |
|---|---|---|
| **Repo** | [choice121/Choice](https://github.com/choice121/Choice) | [choice121/property-pipeline](https://github.com/choice121/property-pipeline) |
| **What it is** | The public rental listing website tenants use | Private internal tool for sourcing and managing listings |
| **Deployment** | Cloudflare Pages (auto-deploy on push to `main`) | Replit (run manually) |
| **Frontend** | Vanilla HTML/CSS/JS — no framework, no build step | React 18 + Vite |
| **Backend** | Supabase Edge Functions (Deno/TypeScript) | Python FastAPI |
| **Database** | Supabase PostgreSQL — `public` schema | Same Supabase project — `pipeline` private schema |
| **CDN** | ImageKit.io | ImageKit.io (same account) |
| **Supabase project** | `tlfmwetmhthpyrytrcfo` | Same — `tlfmwetmhthpyrytrcfo` |

---

## How They Work Together

```
┌──────────────────────────────────────────────────────────────────┐
│                     PROPERTY PIPELINE (Replit)                   │
│                                                                  │
│  Scraper → pipeline.pipeline_properties (staging) → Publisher   │
│                                                                  │
│  Publisher writes to:                                            │
│    • public.properties      (live listing record)                │
│    • public.property_photos (ImageKit CDN URLs)                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │  publishes approved listings
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                  CHOICE WEBSITE (Cloudflare Pages)               │
│                                                                  │
│  Reads public.properties + public.property_photos via Supabase   │
│  Tenants browse listings, submit applications, sign leases       │
└──────────────────────────────────────────────────────────────────┘
```

The pipeline is a **one-way feed**: it writes to the database, the website reads from it. They never communicate directly.

---

## Shared Supabase Database — Schema Ownership

This is the most critical thing to understand. Both projects use the **same Supabase database** (`tlfmwetmhthpyrytrcfo`). Table ownership is split by schema:

### `public` schema — Owned by the Choice Website
**Never alter these from the pipeline project without coordinating with the Choice team.**

| Table | Purpose |
|---|---|
| `properties` | Live rental listings shown to tenants |
| `property_photos` | Photo URLs (ImageKit CDN) per property |
| `landlords` | Landlord account profiles |
| `applications` | Full rental application + lease workflow |
| `leases` | Executed lease records |
| `inquiries` | Tenant inquiry messages |
| `messages` | Application thread messages |
| `saved_properties` | Tenant favorites |
| `rate_limit_log` | API rate limiting |
| `lease_pdf_versions` | Lease PDF audit trail |
| `sign_events` | E-signature events |
| `email_logs` | Email delivery log |
| `agent_issues` | Internal issue tracker |
| `lease_amendments` | Lease amendment records |
| `lease_inspection_photos` | Move-in/out inspection photos |

### `pipeline` schema — Owned by the Property Pipeline
**Never alter, drop, or move these tables from the Choice project without coordinating with the pipeline team.**

| Table | Purpose |
|---|---|
| `pipeline.pipeline_properties` | Staging area for scraped listings (35,000+ rows) |
| `pipeline.pipeline_enrichment_log` | AI enrichment history per property |
| `pipeline.pipeline_scrape_runs` | Log of every scrape job run |
| `pipeline.pipeline_chat_conversations` | AI chat history per property |

> **Why a separate schema?** Choice website migration `20260426000002_pipeline_private_schema.sql` moved pipeline tables from `public` to a private `pipeline` schema for security. The `pipeline` schema is only accessible to `service_role` — it is never exposed to `anon` or `authenticated` roles. The pipeline backend connects with the service role key, so it can access both schemas.

---

## The Publishing Flow (Pipeline → Website)

When the pipeline owner approves a listing and clicks Publish:

1. `backend/services/publisher_service.py` runs
2. It **upserts** a row into `public.properties` (creating or updating the live listing)
3. It uploads up to **40 photos** to ImageKit CDN
4. It inserts rows into `public.property_photos` with the ImageKit URLs
5. It resolves the landlord UUID from `public.landlords` (or uses `CHOICE_LANDLORD_ID` env var)
6. The Choice website immediately reflects the new listing (no rebuild needed — it queries Supabase live)

The pipeline writes **only** to `public.properties` and `public.property_photos`. It never touches applications, leases, landlords, or any other public table.

### IMPORTANT: property_photos column schema

```
property_id      text  -- e.g. "PROP-BF860F35" (matches properties.id)
url              text  -- ImageKit CDN URL
file_id          text  -- ImageKit file ID
display_order    int   -- 0-indexed gallery order
alt_text         text
caption          text
watermark_status text
width / height   int
```

**`public.properties` does NOT have `photo_urls` or `photo_file_ids` columns.** Those were removed in Choice migration `20260426000002`. All photo data lives in `property_photos`. Any code referencing those old columns will fail with a PostgREST 204 error.

---

## Environment Variables (Shared)

Both projects use the same Supabase project and ImageKit account. The credentials are:

| Variable | Used by | Purpose |
|---|---|---|
| `SUPABASE_URL` | Both | `https://tlfmwetmhthpyrytrcfo.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Pipeline only | Full DB access (pipeline + public schema) |
| `SUPABASE_ANON_KEY` | Choice website | Public read-only queries from the browser |
| `IMAGEKIT_PUBLIC_KEY` | Both | ImageKit upload authentication |
| `IMAGEKIT_PRIVATE_KEY` | Pipeline | ImageKit server-side upload |
| `IMAGEKIT_URL_ENDPOINT` | Both | ImageKit CDN base URL |
| `CHOICE_LANDLORD_ID` | Pipeline | UUID of the landlord — auto-resolved from `public.landlords` if unset |
| `DEEPSEEK_API_KEY` | Pipeline | AI features (autofill, rewrite, pricing, SEO) |

---

## Cross-Project Rules

### If you are working on the Choice Website (choice121/Choice):
- ✅ You may freely add/alter tables in the `public` schema
- ✅ You may add Supabase migrations in `supabase/migrations/`
- ❌ **Do NOT** alter, rename, or drop tables in the `pipeline` schema
- ❌ **Do NOT** revoke `service_role` access from the `pipeline` schema
- ❌ **Do NOT** change the column names or types in `public.properties` or `public.property_photos` without checking that the pipeline publisher handles them — `backend/services/publisher_service.py` writes to these tables
- ⚠️ **If you need to restructure `public.properties`**, run the change by the pipeline team first. The pipeline maps ~60 fields into this table.

### If you are working on the Property Pipeline (choice121/property-pipeline):
- ✅ You may freely read/write the `pipeline` schema tables
- ✅ You may write to `public.properties` and `public.property_photos` via the publisher
- ❌ **Do NOT** write to any other `public` schema table
- ❌ **Do NOT** run ad-hoc SQL in Supabase without adding it as a proper migration in the Choice repo
- ❌ **Do NOT** drop or truncate `public.properties` or `public.property_photos`
- ⚠️ **Any new database tables or column changes** should be committed as a migration in `choice121/Choice/supabase/migrations/` using the Supabase CLI format

---

## Migration System — Single Source of Truth

All database changes for the entire ecosystem live in:
```
choice121/Choice/supabase/migrations/
```

The Choice repo uses the Supabase CLI. Every migration file is named:
```
YYYYMMDDHHMMSS_description.sql
```

**Pipeline developers**: when you need a new column or table in the pipeline schema, write a migration SQL file and add it to the Choice repo's migrations folder. Do not create ad-hoc SQL files. The current pipeline-specific migrations that exist in the pipeline repo root (`supabase_migration.sql`, `supabase_migration_phase3_4.sql`) are legacy and should not be re-run — the tables already exist in the `pipeline` schema.

---

## How the Choice Website Deploys

```
1. Developer edits code in Replit (editing only — Replit is not the host)
2. git push origin main
3. GitHub CI validates the push (rejects forbidden files)
4. Cloudflare Pages auto-builds and deploys in ~1–2 minutes
5. Site is live at https://choice-properties-site.pages.dev
```

Supabase Edge Functions deploy separately via the Supabase CLI (`supabase functions deploy`).

---

## How the Pipeline Deploys

The pipeline runs exclusively on Replit. It is not deployed publicly.

```
1. Open the Replit project (choice121/property-pipeline)
2. Click Run (or bash start.sh)
3. Frontend available at Replit preview URL (port 5000)
4. Backend API at port 8000 (internal, proxied by Vite)
```

---

## Key Contact Points Between Projects

If you are an AI working on one project and need to understand the other:

- **Choice website architecture**: `choice121/Choice/README.md` and `choice121/Choice/.github/copilot-instructions.md`
- **Pipeline architecture**: `choice121/property-pipeline/replit.md` and `choice121/property-pipeline/AI_HANDOFF.md`
- **This document**: Canonical in both repos as `ECOSYSTEM.md`

---

## Security Model

- The `pipeline` schema is private: no `anon` or `authenticated` role can access it
- The pipeline backend always uses `SUPABASE_SERVICE_ROLE_KEY` — never the anon key
- RLS (Row Level Security) is enabled on all public schema tables
- The pipeline bypasses RLS because service_role is exempt from RLS by default in Supabase
- ImageKit uploads from the pipeline use the private key (server-side) — the public key alone cannot upload
