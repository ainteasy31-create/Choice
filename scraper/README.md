# Choice Properties — Scraper v5

> ⚠️ **For new city scraping jobs, use `pipeline.py` + a city batch script — not `scraper.py` directly.**
> `scraper.py` is the internal scrape/map module called by `pipeline.py`. Running it standalone stages records without enrichment, validation, ImageKit upload, or auto-publish.
>
> **Correct entry point for all production scraping:**
> ```bash
> python3 scraper/<city>_batch.py --target 10
> ```
> See `PIPELINE_USAGE.md` for the city batch template. See `PLATFORM_RULES.md` for mandatory rules.

---

Scrapes **for-rent** listings from **Realtor.com** (HomeHarvest + Phase 2 detail enrichment) and/or **Zillow** (`__NEXT_DATA__` two-phase scraper) and stages them in `pipeline.pipeline_properties` for admin review and one-click publishing.

---

## Architecture

```
Realtor.com Phase 1 (HomeHarvest)      Zillow Phase 1 (search __NEXT_DATA__)
         │                                         │
         ▼                                         ▼
Realtor.com Phase 2 (detail pages)    Zillow Phase 2 (detail gdpClientCache)
         │                                         │
         └───────────────┬─────────────────────────┘
                         │  batch inserts (50 records/POST)
                         ▼
           pipeline.pipeline_properties  ←── /admin/pipeline.html
                         │  "Publish" button
                         ▼
         public.properties + public.property_photos  ←── live site
```

All staged listings land with `status = "scraped"`. Nothing goes live until an admin reviews and publishes.

---

## Two-Phase Design (Both Sources)

### Realtor.com
| Phase | What it does | Source |
|---|---|---|
| **Phase 1** | HomeHarvest GraphQL search — fast, gets all listings with basic data | `homeharvest` library |
| **Phase 2** | Concurrent detail-page fetch — fills virtual tours, full photo gallery (up to 50), showing instructions, move-in specials, schools, walk scores, location context | Direct HTTP to realtor.com (no IP restriction — runs fine from Replit) |

### Zillow
| Phase | What it does | Source |
|---|---|---|
| **Phase 1** | `__NEXT_DATA__` search pages — gets listing IDs + basic data | Direct HTTP (needs residential IP) |
| **Phase 2** | Concurrent detail pages — extracts full `gdpClientCache` with every field Zillow's app uses | Direct HTTP (needs residential IP) |

---

## Files

| File | Purpose |
|---|---|
| `scraper.py` | Main CLI entry point — orchestrates both sources, batch inserts, dedup, logging |
| `zillow_scraper.py` | Zillow scraper module — two-phase search + detail, maps all fields |
| `requirements.txt` | Python dependencies |
| `cities.txt` *(optional)* | Your list of locations for `--locations-file` |

---

## Setup

### 1. Install dependencies

```bash
pip install homeharvest requests
# Optional (improves Zillow bot bypass):
pip install curl-cffi
# Python 3.9+ required (iSH on iPhone is Python 3.9)
```

### 2. Environment variables

Create a `.env` file (auto-loaded on every run):

```bash
# scraper/.env  or  project root .env
SUPABASE_URL=https://tlfmwetmhthpyrytrcfo.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

---

## Usage

```
python scraper/scraper.py --location <location> [--source realtor|zillow|both] [options]
```

### Source flag

| Flag | What it does |
|---|---|
| `--source realtor` | Realtor.com Phase 1 + Phase 2 **(default, safe from Replit)** |
| `--source zillow` | Zillow Phase 1 + Phase 2 (needs residential IP / iSH on iPhone) |
| `--source both` | Both sources in sequence for each location |

> **Zillow note:** Requires a **residential IP** (mobile data, home WiFi). Datacenter IPs (Replit, AWS, GCP) are blocked by Zillow's DataDome. Use **iSH Shell on iPhone** — free Alpine Linux terminal on the App Store. Your phone's mobile data is a residential IP.

> **Realtor.com note:** No IP restrictions. The Phase 2 detail fetch runs safely from Replit at any time.

### Location flags

| Flag | Description |
|---|---|
| `--location LOCATION` | Where to search — **can be passed multiple times** |
| `--locations-file FILE` | Text file with one location per line (`#` comments OK) |

### Filter flags

| Flag | Default | Description |
|---|---|---|
| `--beds-min N` | — | Minimum bedrooms |
| `--beds-max N` | — | Maximum bedrooms |
| `--price-min $` | — | Minimum monthly rent |
| `--price-max $` | — | Maximum monthly rent |
| `--limit N` | `200` | Max listings per location per source |
| `--min-score N` | `0` | Skip listings with quality score below N |

### Realtor.com flags

| Flag | Default | Description |
|---|---|---|
| `--past-days N` | `7` | Only listings from the last N days |
| `--property-type TYPE` | — | Comma-separated: `single_family`, `condos`, `townhomes`, `apartment`, `multi_family`, `mobile` |
| `--extra` | off | HomeHarvest extra data per property (schools, tax history) |
| `--no-realtor-details` | off | **Skip Phase 2** for Realtor.com — faster but shallower scrape |

### Zillow flags

| Flag | Default | Description |
|---|---|---|
| `--no-details` | off | Skip Phase 2 for Zillow — faster, search-only results |

### Behaviour flags

| Flag | Default | Description |
|---|---|---|
| `--upsert` | off | Update existing pipeline listings instead of skipping duplicates |
| `--dry-run` | off | Preview results without writing to the database |

---

## Examples

```bash
# Default — Realtor.com + Phase 2 detail enrichment, Dallas, last 7 days
python scraper/scraper.py --location "Dallas, TX"

# Fast mode — skip Phase 2 detail fetch (search data only)
python scraper/scraper.py --location "Dallas, TX" --no-realtor-details

# Zillow only (run from iSH on iPhone)
python3 scraper.py --location "Dallas, TX" --source zillow

# Both sources for one city
python scraper/scraper.py --location "Miami, FL" --source both

# Multiple cities, both sources
python scraper/scraper.py \
  --location "Dallas, TX" \
  --location "Houston, TX" \
  --location "Austin, TX" \
  --source both

# Bulk scrape from file with quality filter
python scraper/scraper.py --locations-file cities.txt --source both --min-score 40

# With rent and bedroom filters
python scraper/scraper.py \
  --location "Sacramento, CA" \
  --source both \
  --past-days 14 \
  --beds-min 2 --beds-max 4 \
  --price-max 3500

# Refresh stale listings
python scraper/scraper.py --location "Miami, FL" --source both --upsert --past-days 3

# Dry run — preview without writing
python scraper/scraper.py --location "Miami, FL" --dry-run
```

---

## What Gets Staged Per Listing

| Field | Realtor.com P1 | Realtor.com P2 | Zillow P1 | Zillow P2 |
|---|---|---|---|---|
| address, city, state, zip | ✅ | — | ✅ | — |
| lat, lng | ✅ | gap-fill | ✅ | gap-fill |
| county | ✅ | gap-fill | ❌ | ✅ |
| neighborhood | ✅ | gap-fill | ✅ | gap-fill |
| bedrooms, bathrooms, sqft | ✅ | gap-fill | ✅ | gap-fill |
| monthly_rent | ✅ | — | ✅ | preferred |
| property_type | ✅ | — | ✅ | gap-fill |
| year_built | ✅ | gap-fill | ✅ | gap-fill |
| description | ✅ | **longer wins** | basic | **full text** |
| photos | ~5–15 thumbs | **up to 50 HD** | ~5–15 thumbs | **up to 50 HD** |
| virtual_tour_url | ❌ | ✅ | ❌ | ✅ |
| heating_type, cooling_type | ✅ | merge | ❌ | ✅ |
| laundry_type | ✅ | merge | ❌ | ✅ |
| appliances | ✅ | merge | ❌ | ✅ |
| utilities_included | ✅ | merge | ❌ | ✅ |
| security_deposit | ✅ | — | ❌ | ✅ |
| application_fee | ✅ | — | ❌ | ✅ |
| pet_deposit | ✅ | — | ❌ | ✅ |
| parking_fee | ✅ | — | ❌ | ✅ |
| pets_allowed | ✅ | merge | ✅ | preferred |
| smoking_allowed | ✅ | — | ❌ | ✅ |
| available_date | ✅ | gap-fill | ❌ | ✅ |
| minimum_lease_months | ✅ | — | ❌ | ✅ |
| showing_instructions | ❌ | ✅ | ❌ | ❌ |
| move_in_special | ❌ | ✅ | ❌ | ❌ |
| location_context | ❌ | ✅ (schools, walk scores) | ❌ | ✅ (school district, walk scores) |
| has_basement | ✅ | — | ❌ | ✅ |
| has_central_air | ✅ | — | ❌ | ✅ |
| data_quality_score | ✅ | **re-scored** | ✅ | **re-scored** |

---

## Deduplication (3 Layers)

1. **Pre-insert check** — queries existing `source_listing_id` values in chunks of 100 before inserting
2. **API-level** — `on_conflict=source_listing_id` with `resolution=ignore-duplicates` (or `merge-duplicates` with `--upsert`)
3. **Database-level** — `UNIQUE` constraint on `source_listing_id` as final safety net

Cross-source duplicates (same property on Realtor.com and Zillow) get two separate records — admin archives the duplicate from the pipeline page.

---

## Performance

| Feature | Detail |
|---|---|
| Phase 2 detail workers | 5 concurrent HTTP fetches |
| Phase 2 skip threshold | Records with score ≥ 80 skip detail fetch |
| Batch inserts | 50 records per Supabase POST |
| Parallel DB workers | Up to 4 concurrent insert threads |
| Retry + back-off | 3 attempts: 1.5s → 3s → 6s per batch |

A 200-listing run:
- Phase 1: ~30–60s (HomeHarvest GraphQL)
- Phase 2: ~60–120s (5 concurrent, ~1s delay each, 200 URLs)
- DB insert: ~4 Supabase POSTs instead of 200

---

## Data Quality Scoring (0–100)

Each record gets a score based on filled fields:

| Field group | Points each |
|---|---|
| address, city, state, zip, lat, lng, beds, baths, sqft, rent, type, description, available_date | +6 |
| county, neighborhood, year_built, parking, pets_allowed, security_deposit, amenities, appliances, heating_type, cooling_type | +2 |
| ≥5 photos | +6 |
| ≥1 photo | +3 |

Phase 2 typically lifts Realtor.com scores by **+10–25 points** per listing (photos, virtual tours, description, location context).

---

## Scrape-Run Logging

Every run is recorded in `pipeline.pipeline_scrape_runs`:
- Source, location, total scraped, new staged, duplicates skipped, errors
- Average data quality score
- Start and end timestamps
