# Choice Properties — GitHub Copilot Instructions

  ## Project Type

  Static website deployed by Cloudflare Pages from GitHub. Supabase is the only backend.

  - Frontend: vanilla HTML, CSS, JavaScript
  - Build: `npm run build`
  - Build internals: `node generate-config.js`
  - Deploy: Cloudflare Pages on push to `main`
  - Backend: Supabase cloud PostgreSQL, Auth, Storage, and Edge Functions
  - Replit role: editing only, never runtime hosting

  ## Do Not Suggest

  - Replit hosting, Replit Database, Replit PostgreSQL, Neon, local Postgres, SQLite, or `DATABASE_URL`
  - `npm install <package>` for runtime/server/database packages
  - Express, Fastify, Node API routes, `server.js`, ORM setup, or migration tooling
  - Drizzle, Prisma, Knex, Sequelize, TypeORM, `pg`, or `postgres`
  - Moving Supabase Edge Functions into this repository as Node routes
  - Creating or committing `config.js`

  ## Do Suggest

  - Static HTML/CSS/browser JavaScript edits
  - Existing Supabase client patterns in `js/cp-api.js`
  - Deno TypeScript edits inside `supabase/functions/`
  - Cloudflare Pages environment variable configuration

  ## Deployment Rule

  The only valid production path is GitHub push to Cloudflare Pages. Any database or auth work must remain in Supabase.

  ---

  ## ECOSYSTEM CONTEXT — The Property Pipeline (MANDATORY READING)

  This website is part of a two-project ecosystem. The second project is the **Property Pipeline**, a private internal tool that feeds listings into this website.

  **Pipeline repo**: [choice121/property-pipeline](https://github.com/choice121/property-pipeline)
  **Full cross-project architecture**: `ECOSYSTEM.md` in this repo

  ### What the pipeline does
  1. Scrapes listings from Zillow, Realtor.com, Redfin
  2. Stages them in the `pipeline` private Postgres schema (this database)
  3. AI-enriches them (titles, descriptions, quality scores)
  4. Publishes approved listings into `public.properties` and `public.property_photos`

  ### The shared Supabase database

  Both projects use the **same** Supabase project (`tlfmwetmhthpyrytrcfo`). Table ownership is split by schema:

  **`public` schema — owned by this project (Choice website)**
  - `properties`, `property_photos`, `landlords`, `applications`, `leases`, `inquiries`, `messages`, `saved_properties`, `sign_events`, `lease_pdf_versions`, etc.

  **`pipeline` schema — owned by the Property Pipeline project**
  - `pipeline.pipeline_properties` (~35,000+ rows of staged listings)
  - `pipeline.pipeline_enrichment_log`
  - `pipeline.pipeline_scrape_runs`
  - `pipeline.pipeline_chat_conversations`

  ### Cross-project rules for AI working on this (Choice) repo

  - ✅ You may freely add/alter tables in the `public` schema
  - ✅ You may add migrations in `supabase/migrations/`
  - ❌ **Do NOT** alter, drop, or move any table in the `pipeline` schema
  - ❌ **Do NOT** revoke `service_role` access from the `pipeline` schema
  - ❌ **Do NOT** change column names or types in `public.properties` or `public.property_photos` without checking with the pipeline team — the pipeline's publisher writes ~60 fields into these tables
  - ⚠️ If you add a new migration, check that it does not affect the pipeline's write patterns to `public.properties`

  ### Why the pipeline schema is private

  Migration `20260426000002_pipeline_private_schema.sql` moved the pipeline tables from `public` to the `pipeline` schema for security (internal staging data should never be exposed to `anon` or `authenticated` roles). The pipeline backend connects with `service_role` and accesses the schema via `client.schema("pipeline")`. Do not change this security model.

  ### How properties get published

  When the pipeline owner approves a listing:
  1. `publisher_service.py` (in the pipeline repo) upserts into `public.properties`
  2. Uploads photos to ImageKit CDN
  3. Inserts into `public.property_photos`

  This website then reads from `public.properties` live — no rebuild needed.
  