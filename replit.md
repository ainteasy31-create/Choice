# Choice Properties — Project Overview

## What This Project Is

**Choice Properties** is a rental property marketing platform with three components:

1. **Python Scraper** (`scraper/`) — the primary tool. Scrapes rental listings from Realtor.com using the HomeHarvest library, enriches them, and publishes them to the live site. **This is the main purpose of this Replit project.**
2. **Chrome Extension** (`chrome-extension/`) — a secondary tool. A browser extension that lets you manually import a single listing from Zillow/Realtor.com/Apartments.com/Redfin by clicking a button on an already-open listing page.
3. **Static Site** (Cloudflare Pages) — the live rental marketplace at https://choice-properties-site.pages.dev — NOT hosted on Replit. Replit is used only for the scraper.

> ⚠️ **AI ASSISTANTS: Read this first.** This is NOT primarily a Chrome extension project. The Chrome extension is a small secondary tool. The core work done in this Replit is running Python scraping jobs. Do not confuse the project structure with the extension. The root `manifest.json` and root `README.md` are Chrome extension artifacts — ignore them when asked to run scraping jobs.

---

## Scraping — How It Works (Source of Truth)

All scraping jobs use **`scraper/pipeline.py`** via a city batch script. This is the only correct method. Do not use `scraper/scraper.py` as a standalone entry point for new production jobs.

### The pipeline in one sentence
`PipelineOrchestrator` from `pipeline.py` scrapes Realtor.com via HomeHarvest, filters, enriches, validates, uploads photos to ImageKit, and publishes listings to Supabase — all automatically.

### Required files
| File | Role |
|---|---|
| `scraper/pipeline.py` | The orchestrator — 13-step automated pipeline. **Entry point for all new jobs.** |
| `scraper/enrichment.py` | Mandatory post-processing: cleans descriptions, removes branding, normalizes fees, validates before publish |
| `scraper/imagekit_upload.py` | Downloads source photos and uploads them to ImageKit |
| `scraper/scraper.py` | HomeHarvest + detail-page scrape logic — called internally by `pipeline.py`. Do not call directly for new city batches. |
| `scraper/.env` | All credentials (Supabase URL/key, ImageKit key). Already populated — no setup needed. |
| `scraper/requirements.txt` | Python deps: `homeharvest`, `requests`, `curl-cffi` |

### City batch scripts (the pattern to follow)
Each city has its own `scraper/<city>_batch.py` file. They all follow the same pattern:
- Define `TARGET_LOCATIONS`, `FALLBACK_LOCATIONS`, `ALLOWED_TYPES`, bed/bath/rent constants
- Define a `compute_<city>_rent()` pricing function
- Call `PipelineOrchestrator(verbose=True).run(criteria)` — that's it

**Examples:** `arlington_tx_batch.py`, `charlotte_nc_batch.py`, `charleston_sc_batch.py`, `dallas_ga_batch.py`, `okc_batch.py`, `stl_batch.py`

### How to run a scraping job
```bash
# Install deps (only needed once per environment)
pip install homeharvest requests pillow

# Dry run — no DB writes, see what would be published
python3 scraper/charleston_sc_batch.py --dry-run

# Live run — scrape and publish 10 listings
python3 scraper/charleston_sc_batch.py --target 10

# Options available on every batch script:
#   --dry-run          stop before any DB writes
#   --target N         number of listings to publish (default 10)
#   --past-days N      how far back to scrape (default 90)
#   --min-score N      data quality floor (default 35)
#   --limit N          max scraped per location (default 250)
```

### Creating a new city batch
See `scraper/PIPELINE_USAGE.md` for the full template (~60 lines). The short version:
1. Copy any existing batch script (e.g. `charlotte_nc_batch.py`)
2. Update `TARGET_LOCATIONS`, `FALLBACK_LOCATIONS`, bed/bath/rent constants, and `batch_name`
3. Run with `--dry-run` first, then live

---

## Environment & Credentials

All credentials are in `scraper/.env` — already populated, committed to this repo.

| Variable | Value location |
|---|---|
| `SUPABASE_URL` | `scraper/.env` |
| `SUPABASE_SERVICE_ROLE_KEY` | `scraper/.env` |
| `IMAGEKIT_PRIVATE_KEY` | `scraper/.env` |
| `IMAGEKIT_URL_ENDPOINT` | `scraper/.env` |
| Public/anon keys | `chrome-extension/config.js` (safe to commit) |

---

## Platform Rules (Non-Negotiable)

Enforced automatically by `apply_enrichment_pipeline()` — never bypass:

- **≥ 6 photos required** per listing (fewer = rejected)
- **All photos hosted on ImageKit** — never publish external/hotlinked URLs
- **Watermarked or competitor-branded listings are dropped entirely**
- **Application fee = $50** always (free/other amounts are normalized)
- **Descriptions must not contain** tour/showing/contact language, external portal links, agent/owner names, competitor branding
- **Security deposit = published monthly rent** (standardized)
- **Pets allowed = Yes** (always published as pet-friendly)
- **Descriptions must end** with the Choice Properties Apply CTA

Full rules: `scraper/PLATFORM_RULES.md`

---

## Chrome Extension (Secondary Tool)

Located in `chrome-extension/`. A Manifest V3 browser extension that adds a "Save to Pipeline" button on Zillow/Realtor.com/Apartments.com/Redfin listing pages. Clicking it sends the listing directly to the pipeline via a Supabase Edge Function.

**To use:** Load `chrome-extension/` as an unpacked extension in Chrome (Developer mode). No server required — it runs entirely in the browser.

This is NOT the primary scraping method and NOT what this Replit is for.

---

## Active Markets

See `scraper/SEARCH_PREFERENCES.md` for full details on active markets and their criteria.

---

## File Map (Quick Reference)

```
scraper/
  pipeline.py              ← MAIN ORCHESTRATOR — use this for all new jobs
  scraper.py               ← Internal scrape logic (called by pipeline.py)
  enrichment.py            ← Description cleaning, validation, fee normalization
  imagekit_upload.py       ← Photo download + ImageKit upload
  .env                     ← All credentials (already set)
  requirements.txt         ← pip deps
  PLATFORM_RULES.md        ← Mandatory rules enforced by enrichment.py
  PIPELINE_USAGE.md        ← How to use PipelineOrchestrator + BatchCriteria reference
  SEARCH_PREFERENCES.md    ← Active markets and content rules
  charleston_sc_batch.py   ← Example: 1-2 bed, $3,000-$4,500, SC
  charlotte_nc_batch.py    ← Example: 2 bed, $1,400-$1,700, NC
  arlington_tx_batch.py    ← Example: 2 bed, TX
  dallas_ga_batch.py       ← Example: 3 bed, tiered pricing, GA

chrome-extension/          ← Secondary tool — browser extension only
  config.js                ← Public credentials (safe to commit)
  manifest.json            ← Extension config
  content.js               ← Injected button logic
  background.js            ← Service worker / queue
  popup.html/js            ← Toolbar popup

main.py                    ← Unused stub — ignore
manifest.json              ← Root copy of Chrome extension manifest — ignore for scraping
README.md                  ← Extension-focused README — not the full project description
```

---

## User Preferences

- Use `pipeline.py` + `PipelineOrchestrator` for all new city scraping jobs — never `scraper.py` standalone
- All credentials stay in `scraper/.env` (already committed)
- Never invent or estimate missing property data
- Never publish a property that fails any platform rule
- Zillow scraping requires a residential IP and cannot run from Replit — use Realtor.com (HomeHarvest) only on Replit
- The scraper prompt format lives in `SCRAPING_PROMPT.md` — use it as the template for all new scrape requests
