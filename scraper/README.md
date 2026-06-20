# Choice Properties — Scraper v3

Scrapes **for-rent** listings from **Realtor.com** (via HomeHarvest) and/or **Zillow** (via `__NEXT_DATA__` HTML parsing) and stages them in `pipeline.pipeline_properties` for admin review and one-click publishing.

---

## Architecture

```
Realtor.com (HomeHarvest)          Zillow (__NEXT_DATA__ parse)
         │                                      │
         ▼                                      ▼
  scraper/scraper.py  ←──── zillow_scraper.py ──┘
         │
         │  batch inserts (50 records/POST, parallel workers)
         ▼
pipeline.pipeline_properties   ←── /admin/pipeline.html
         │  "Publish" button
         ▼
public.properties + public.property_photos  ←── live site
```

All staged listings land with `status = "scraped"`. Nothing goes live until an admin reviews and publishes.

---

## Files

| File | Purpose |
|---|---|
| `scraper.py` | Main CLI entry point — orchestrates both sources, batch inserts, dedup, logging |
| `zillow_scraper.py` | Standalone Zillow scraper module — fetches + parses + maps Zillow listings |
| `requirements.txt` | Python dependencies (`homeharvest`, `requests`) |
| `cities.txt` *(optional)* | Your list of locations for `--locations-file` |

---

## Setup

### 1. Install dependencies

```bash
pip install homeharvest requests
# Python 3.9+ required
```

### 2. Environment variables

Create a `.env` file (auto-loaded on every run — no `source .env` needed):

```bash
# scraper/.env  or  project root .env
SUPABASE_URL=https://tlfmwetmhthpyrytrcfo.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

Or export manually:

```bash
export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
```

---

## Usage

```
python scraper/scraper.py --location <location> [--source realtor|zillow|both] [options]
```

### Source flag (new in v3)

| Flag | What it does |
|---|---|
| `--source realtor` | Realtor.com only via HomeHarvest **(default)** |
| `--source zillow` | Zillow only via `__NEXT_DATA__` HTML parsing |
| `--source both` | Both sources in sequence for each location |

> **Zillow note:** The Zillow scraper works best from a **residential IP** (home or office network). Cloud/datacenter IPs (like Replit) may be blocked by Zillow's DataDome bot detection. Run locally, or set `HTTP_PROXY` / `HTTPS_PROXY` to a residential proxy.

### Location flags

| Flag | Description |
|---|---|
| `--location LOCATION` | Where to search — **can be passed multiple times** |
| `--locations-file FILE` | Text file with one location per line (`#` comments OK) |

### Filter flags (apply to both sources)

| Flag | Default | Description |
|---|---|---|
| `--beds-min N` | — | Minimum bedrooms |
| `--beds-max N` | — | Maximum bedrooms |
| `--price-min $` | — | Minimum monthly rent |
| `--price-max $` | — | Maximum monthly rent |
| `--limit N` | `200` | Max listings per location per source |
| `--min-score N` | `0` | Skip listings with quality score below N |

### Realtor.com-only flags

| Flag | Default | Description |
|---|---|---|
| `--past-days N` | `7` | Only listings from the last N days |
| `--property-type TYPE` | — | Comma-separated: `single_family`, `condos`, `townhomes`, `apartment`, `multi_family`, `mobile` |
| `--extra` | off | Fetch per-property extras (schools, tax history) — adds 1 request/listing |

### Behaviour flags

| Flag | Default | Description |
|---|---|---|
| `--upsert` | off | Update existing pipeline listings instead of skipping duplicates |
| `--dry-run` | off | Preview results without writing to the database |

---

## Examples

```bash
# Default — Realtor.com, Dallas, last 7 days
python scraper/scraper.py --location "Dallas, TX"

# Zillow only
python scraper/scraper.py --location "Dallas, TX" --source zillow

# Both sources for one city
python scraper/scraper.py --location "Miami, FL" --source both

# Both sources, multiple cities
python scraper/scraper.py \
  --location "Dallas, TX" \
  --location "Houston, TX" \
  --location "Austin, TX" \
  --source both

# Bulk scrape from a file — both sources, quality filter
python scraper/scraper.py --locations-file cities.txt --source both --min-score 40

# With filters
python scraper/scraper.py \
  --location "Sacramento, CA" \
  --source both \
  --past-days 14 \
  --beds-min 2 --beds-max 4 \
  --price-max 3500

# Refresh stale listings (upsert)
python scraper/scraper.py --location "Miami, FL" --source both --upsert --past-days 3

# Dry run — see what would be staged
python scraper/scraper.py --location "Miami, FL" --source both --dry-run
```

### cities.txt format

```
# Texas
Dallas, TX
Houston, TX
Austin, TX

# Florida
Miami, FL
Tampa, FL
Orlando, FL

# California
Los Angeles, CA
San Diego, CA
```

---

## How the Zillow Scraper Works

1. Builds a search URL: `https://www.zillow.com/homes/for_rent/{city-slug}/`
2. Fetches the page with realistic Chrome browser headers
3. Extracts the `<script id="__NEXT_DATA__">` JSON block embedded in the HTML
4. Navigates multiple known JSON paths to locate the listing array
5. Maps Zillow's fields (`zpid`, `addressStreet`, `beds`, `latLong`, etc.) to the pipeline schema
6. Paginates up to 20 pages with 2–4 second polite delays between requests

**Bot detection handling:**
- Returns a clear `blocked=True` signal if Zillow returns 403
- Handles 429 (rate limit) with a 30-second wait and one retry
- Detects CAPTCHA pages by checking for missing `__NEXT_DATA__`

---

## What Gets Staged

Every listing (from either source) maps to a full `pipeline_properties` record:

| Field | Realtor.com | Zillow |
|---|---|---|
| address, city, state, zip | ✅ | ✅ |
| lat, lng | ✅ | ✅ |
| county | ✅ | ❌ (not in Zillow API) |
| neighborhood | ✅ | ✅ (when available) |
| bedrooms, bathrooms, sqft | ✅ | ✅ |
| monthly_rent | ✅ | ✅ |
| property_type | ✅ | ✅ |
| year_built | ✅ | ✅ (when in hdpData) |
| description | ✅ | ✅ (when in hdpData) |
| parking | ✅ | ✅ (when in hdpData) |
| pets_allowed | ✅ | ✅ (isPetFriendly flag) |
| amenities | ✅ (tags) | ✅ (tags) |
| photos (up to 40) | ✅ | ✅ (carousel + primary) |
| agent_name, broker_name | ✅ | ✅ (when available) |
| data_quality_score | ✅ 0–100 | ✅ 0–100 |
| source | `"realtor"` | `"zillow"` |

---

## Deduplication

- **Within source:** Checks `source_listing_id` against existing pipeline rows before inserting. Realtor uses `property_id`; Zillow uses `zpid`. Same listing from the same source will be skipped.
- **Cross-source:** A property listed on both Realtor.com and Zillow gets staged twice (different `source_listing_id` values). The admin sees both cards and can archive the duplicate.
- **Upsert mode (`--upsert`):** Refreshes all matching listings instead of skipping.

---

## Performance

| Feature | Detail |
|---|---|
| Batch inserts | 50 records per Supabase POST |
| Parallel workers | Up to 4 concurrent batch-insert threads |
| Retry + back-off | 3 attempts: 1.5s → 3s → 6s per batch |
| Connection pooling | `requests.Session` with Keep-Alive for both Zillow and Supabase |

A 200-listing run makes ~4 Supabase POSTs instead of 200.

---

## Scrape-Run Logging

Every run is recorded in `pipeline.pipeline_scrape_runs`:
- Source (`realtor` or `zillow`)
- Location searched
- Total scraped, new staged, duplicates skipped, errors
- Average data quality score
- Start and end timestamps

---

## Proxy Support

If Zillow blocks your IP:

```bash
export HTTP_PROXY="http://user:pass@residential-proxy:port"
export HTTPS_PROXY="http://user:pass@residential-proxy:port"
python scraper/scraper.py --location "Dallas, TX" --source zillow
```

Both `requests` and HomeHarvest automatically respect these environment variables.
