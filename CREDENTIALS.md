# Choice Properties — New Developer Guide

This file covers everything a new developer or AI assistant needs to get fully operational on this project. No manual credential hunting required — everything is already committed.

---

## What You're Working With

| Component | Location | What it does |
|---|---|---|
| **Python Scraper** | `scraper/` | **The main tool.** Scrapes Realtor.com, enriches listings, publishes to the live site. Run from Replit. |
| **Chrome Extension** | `chrome-extension/` | Secondary tool. Adds a "Save to Pipeline" button on open listing pages in your browser. |
| **Live site** | Cloudflare Pages | https://choice-properties-site.pages.dev — NOT hosted on Replit. Replit only runs the scraper. |

> **AI assistants:** Read `replit.md` first. It has the full project overview, architecture diagram, and scraping instructions. Do not treat this as a Chrome extension project.

---

## Setup — Choose Your Path

### Path A: Run a scraping job (most common)

Everything is already set up. Just install deps and run:

```bash
pip install homeharvest requests pillow

# Dry run (no DB writes)
python3 scraper/charleston_sc_batch.py --dry-run

# Live run — publish 10 listings
python3 scraper/charleston_sc_batch.py --target 10
```

All credentials are in `scraper/.env` — already committed, nothing to configure.

Need to scrape a new city? Copy any existing batch script and update the locations/criteria. See `scraper/PIPELINE_USAGE.md` for the full template.

**For AI-assisted scraping jobs:** use `SCRAPING_PROMPT.md` as the copy-paste prompt template.

---

### Path B: Set up the Chrome Extension

1. Open Chrome → `chrome://extensions` → enable **Developer mode**
2. Click **Load unpacked** → select the `chrome-extension/` folder
3. Done — all credentials are already in `chrome-extension/config.js`

To use: navigate to any Zillow/Realtor.com/Apartments.com/Redfin listing page and click the **"Save to Pipeline"** button that appears.

---

### Path C: Server-side / Replit scripts (needs one secret)

Scripts that run on Replit use the Supabase service role key, which is NOT committed (it bypasses all row-level security). To get it:

1. Ask the project owner for `SUPABASE_SERVICE_ROLE_KEY`, OR
2. Find it in Supabase Dashboard → Project Settings → API → `service_role` key
3. Add it to Replit Secrets as `SUPABASE_SERVICE_ROLE_KEY`

> **Note:** `scraper/.env` already has the service role key committed — so Path A works without any extra setup. Path C is only relevant if you're writing NEW server-side scripts that use Replit Secrets directly.

---

## Credential Inventory

### What's already committed (no setup needed)

| Credential | File | Notes |
|---|---|---|
| Supabase URL | `scraper/.env` | Project endpoint |
| Supabase service role key | `scraper/.env` | Full DB access. Used by scraper only. |
| ImageKit private key | `scraper/.env` | Used by scraper for photo uploads |
| ImageKit URL endpoint | `scraper/.env` | `https://ik.imagekit.io/21rg7lvzo` |
| Supabase anon key | `chrome-extension/config.js` | Public/safe. Protected by RLS. |
| Import secret | `chrome-extension/config.js` | Sent as `x-import-secret` header to the Edge Function |
| ImageKit public key | `chrome-extension/config.js` | Client-side upload auth |

### What lives in Replit Secrets only (server-side)

| Secret | Replit key | Why not committed |
|---|---|---|
| Supabase service role key | `SUPABASE_SERVICE_ROLE_KEY` | Bypasses all RLS — high privilege. (Also in `scraper/.env` for the scraper.) |

---

## How to Rotate a Credential

1. Generate the new key in the relevant dashboard (Supabase, ImageKit)
2. Update `scraper/.env` and/or `chrome-extension/config.js` as appropriate (see table above)
3. **If rotating `IMPORT_SECRET`:** also update it in Supabase → Edge Functions → `receive-pipeline-import` → Secrets → `IMPORT_SECRET`
4. **If rotating the service role key:** also update Replit Secrets → `SUPABASE_SERVICE_ROLE_KEY`
5. Reload the Chrome extension: `chrome://extensions` → click ↺ on the extension card
6. Reload any open listing tabs

---

## Key Documentation

| File | What it covers |
|---|---|
| `replit.md` | Full project overview, architecture, how to run scraping jobs, file map |
| `SCRAPING_PROMPT.md` | Copy-paste prompt for AI-assisted scraping jobs |
| `scraper/PIPELINE_USAGE.md` | `PipelineOrchestrator` API, `BatchCriteria` reference, new-city template |
| `scraper/PLATFORM_RULES.md` | Mandatory rules enforced automatically by `enrichment.py` |
| `scraper/SEARCH_PREFERENCES.md` | Active markets and their criteria |
| `scraper/RULES.md` | Scannable table of enrichment rules |

---

## Things That Will Trip You Up

- **Zillow requires a residential IP.** HomeHarvest/Realtor.com works fine from Replit; Zillow does not.
- **`main.py` at the root is unused.** Ignore it.
- **Root `manifest.json` is the Chrome extension manifest**, not a site config. Ignore it for scraping.
- **`scraper/scraper.py` is internal.** Don't call it directly — it's invoked by `pipeline.py` automatically.
- **The pipeline enforces all platform rules automatically.** You cannot skip watermark detection, ImageKit upload, fee normalization, etc. — they are not optional.
- **Published listing URLs use the slug format:**
  `https://choice-properties-site.pages.dev/rent/<state>/<city>/<beds>br-<type>-<id>/`
  The old `property.html?id=` format still works (301 redirect) but the slug URL is canonical.
