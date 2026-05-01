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

  The pipeline is a **one-way feed**: it writes to the database, the website reads from it.

  ---

  ## Shared Supabase Database — Schema Ownership

  ### `public` schema — Owned by the Choice Website
  | Table | Purpose |
  |---|---|
  | `properties` | Live rental listings shown to tenants |
  | `property_photos` | Photo URLs (ImageKit CDN) per property |
  | `landlords` | Landlord account profiles |
  | `applications` | Rental applications + lease workflow |
  | `leases` | Executed lease records |
  | `inquiries` | Tenant inquiry messages |
  | `messages` | Application thread messages |
  | `saved_properties` | Tenant favorites |

  ### `pipeline` schema — Owned by the Property Pipeline
  | Table | Purpose |
  |---|---|
  | `pipeline.pipeline_properties` | Staging area for scraped listings |
  | `pipeline.pipeline_enrichment_log` | AI enrichment history per property |
  | `pipeline.pipeline_scrape_runs` | Log of every scrape job |
  | `pipeline.pipeline_chat_conversations` | AI chat history per property |

  > **Security**: The `pipeline` schema is locked to `service_role` only (migration `20260426000002_pipeline_private_schema.sql`). The `pipeline` schema must be added to Supabase's "Extra schemas to expose in your API" in dashboard settings.

  ---

  ## Cross-Project Rules

  ### Working on the Choice Website:
  - ✅ Freely add/alter tables in the `public` schema
  - ✅ Add migrations in `supabase/migrations/`
  - ❌ **Never** alter tables in the `pipeline` schema
  - ❌ **Never** revoke `service_role` access from the `pipeline` schema
  - ❌ **Never** change column names/types in `public.properties` or `public.property_photos` without checking `publisher_service.py` in the pipeline repo

  ### Working on the Property Pipeline:
  - ✅ Freely read/write `pipeline` schema tables
  - ✅ Write to `public.properties` and `public.property_photos` via the publisher only
  - ❌ **Never** write to any other `public` schema table
  - ❌ **Never** run ad-hoc SQL — add migrations to `choice121/Choice/supabase/migrations/`

  ---

  ## Migration System — Single Source of Truth

  All database changes for the entire ecosystem: `choice121/Choice/supabase/migrations/`

  Naming convention: `YYYYMMDDHHMMSS_description.sql`

  ---

  ## Publishing Flow

  1. Pipeline owner approves a listing → clicks Publish
  2. `publisher_service.py` upserts into `public.properties`
  3. Uploads photos to ImageKit CDN
  4. Inserts into `public.property_photos`
  5. Choice website reflects the listing immediately (reads Supabase live, no rebuild)

  ---

  ## Shared Environment Variables

  | Variable | Used by | Purpose |
  |---|---|---|
  | `SUPABASE_URL` | Both | `https://tlfmwetmhthpyrytrcfo.supabase.co` |
  | `SUPABASE_SERVICE_ROLE_KEY` | Pipeline | Full DB access |
  | `SUPABASE_ANON_KEY` | Choice website | Public read-only queries |
  | `IMAGEKIT_PUBLIC_KEY` | Both | ImageKit upload auth |
  | `IMAGEKIT_PRIVATE_KEY` | Pipeline | Server-side upload |
  | `IMAGEKIT_URL_ENDPOINT` | Both | ImageKit CDN base URL |
  | `DEEPSEEK_API_KEY` | Pipeline | AI features |
  | `CHOICE_LANDLORD_ID` | Pipeline | Optional — auto-resolved if unset |

  ---

  *This file is canonical and appears in both repos. Keep them in sync.*
  