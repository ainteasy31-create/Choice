# Choice Properties — HomeHarvest Scraper v2

Scrapes **for-rent** listings directly from **Realtor.com** using the [HomeHarvest](https://github.com/ZacharyHampton/HomeHarvest) library and stages them in `pipeline.pipeline_properties` for admin review and one-click publishing to the live site.

---

## How It Fits the Architecture

```
HomeHarvest (Realtor.com)
        │
        ▼
  scraper/scraper.py
        │  batch-inserts to
        ▼
pipeline.pipeline_properties  ←── admin reviews in Property Pipeline UI
        │  "Publish" button
        ▼
public.properties + public.property_photos  ←── live Choice Properties site
```

Scraped listings always land with `status = "scraped"`. Nothing goes live until an admin reviews and publishes.

---

## What's New in v2

| Feature | Detail |
|---|---|
| **Batch inserts** | 50 records per POST instead of 1 — 10–50× fewer DB round-trips |
| **Parallel workers** | Up to 4 concurrent batch-insert threads via `ThreadPoolExecutor` |
| **Retry + back-off** | 3 retries with exponential back-off on transient network errors |
| **Connection pool** | `requests.Session` with Keep-Alive; no per-request TCP overhead |
| **`.env` auto-load** | Automatically loads `.env` in current or parent dir — no more `source .env` |
| **Multi-location** | `--location` can be passed multiple times in one run |
| **Locations file** | `--locations-file cities.txt` — bulk scrape a whole list of cities |
| **Upsert mode** | `--upsert` refreshes existing scraped listings instead of always skipping |
| **Quality filter** | `--min-score N` skips listings below a data quality threshold |
| **Address validation** | Listings with neither address nor coordinates are silently dropped |

---

## Setup

### 1. Install Python dependencies

```bash
pip install homeharvest requests
# Python >= 3.9 required
```

### 2. Set environment variables

Create a `.env` file in the project root (auto-loaded on every run):

```bash
# .env
SUPABASE_URL=https://tlfmwetmhthpyrytrcfo.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

Or export them manually:

```bash
export SUPABASE_URL="https://tlfmwetmhthpyrytrcfo.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<your service role key>"
```

---

## Usage

```
python scraper/scraper.py --location <location> [options]
```

### Required (at least one)

| Flag | Description |
|---|---|
| `--location LOCATION` | Where to search — can be passed **multiple times** |
| `--locations-file FILE` | Text file with one location per line (`#` comments supported) |

### Optional filters

| Flag | Default | Description |
|---|---|---|
| `--past-days N` | `7` | Only listings from the last N days |
| `--beds-min N` | — | Minimum bedrooms |
| `--beds-max N` | — | Maximum bedrooms |
| `--price-min $` | — | Minimum monthly rent |
| `--price-max $` | — | Maximum monthly rent |
| `--property-type TYPE` | — | Comma-separated types: `single_family`, `condos`, `townhomes`, `apartment`, `multi_family`, `duplex_triplex`, `mobile` |
| `--limit N` | `200` | Max results per location (up to 10,000) |
| `--min-score N` | `0` | Skip listings with data quality score below N |

### Behaviour flags

| Flag | Default | Description |
|---|---|---|
| `--upsert` | off | Update existing pipeline listings rather than skipping duplicates |
| `--extra` | off | Fetch per-property extras (schools, tax history) — adds 1 HTTP request per listing |
| `--dry-run` | off | Preview results without writing to the database |

---

## Examples

```bash
# Basic — scrape Dallas rentals from the last 7 days
python scraper/scraper.py --location "Dallas, TX"

# Multiple cities in one run
python scraper/scraper.py \
  --location "Dallas, TX" \
  --location "Houston, TX" \
  --location "Austin, TX"

# Bulk scrape from a file
python scraper/scraper.py --locations-file cities.txt --min-score 40

# With filters — Sacramento 2–4 BR under $3,500/mo
python scraper/scraper.py \
  --location "Sacramento, CA" \
  --past-days 14 \
  --beds-min 2 --beds-max 4 \
  --price-max 3500

# Large batch — all LA rentals, last 30 days
python scraper/scraper.py \
  --location "Los Angeles, CA" \
  --past-days 30 \
  --limit 1000

# Refresh existing scraped listings (upsert mode)
python scraper/scraper.py --location "Miami, FL" --upsert --past-days 3

# Preview without saving, quality filter
python scraper/scraper.py --location "Miami, FL" --dry-run --min-score 50

# ZIP code search
python scraper/scraper.py --location "30301" --price-max 2500
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
```

---

## What Gets Scraped

Every listing is mapped to a full `pipeline_properties` record including:

| Field | Source |
|---|---|
| address, city, state, zip | Realtor.com |
| lat, lng | Realtor.com |
| county, neighborhood | Realtor.com |
| bedrooms, bathrooms, sqft | Realtor.com |
| monthly_rent | Realtor.com list_price |
| security_deposit | Defaults to 1× monthly rent |
| property_type | Realtor.com style (SINGLE_FAMILY, CONDOS, etc.) |
| description | Full listing text |
| available_date | Realtor.com list_date |
| parking | Realtor.com parking object |
| pets_allowed, pet_types | Realtor.com pet_policy |
| amenities | Realtor.com tags |
| agent_name, broker_name | Realtor.com agent info |
| original_image_urls | Up to 40 Realtor.com photo URLs |
| data_quality_score | Auto-computed 0–100 |
| missing_fields | List of unfilled key fields |
| original_data | Full raw JSON snapshot for audit |

---

## After Scraping

1. Open the **Property Pipeline** admin UI (`/admin/pipeline.html`)
2. Review staged listings — edit titles, descriptions, photos as needed
3. Click **Publish** to move approved listings to the live site

The scraper **never auto-publishes**. All listings start as `status = "scraped"`.

---

## Deduplication

By default the scraper checks `source_listing_id` against existing pipeline rows and skips duplicates. Pass `--upsert` to refresh existing listings with the latest data from Realtor.com instead.

---

## Logging

Every scrape run is recorded in `pipeline.pipeline_scrape_runs` with:
- Total scraped, new staged, duplicates skipped, errors
- Average data quality score
- Start/end timestamps
- Location searched

---

## Performance Notes

- **Batch size**: 50 records per Supabase POST (configurable via `BATCH_SIZE` constant)
- **Workers**: 4 parallel batch-insert threads (configurable via `MAX_WORKERS`)
- **Retries**: 3 attempts per batch with 1.5s→3s→6s back-off
- **Rate limits**: For runs > 500 listings, consider spacing requests or splitting across multiple `--location` flags
- **Proxy support**: If rate-limited by Realtor.com, set `HTTP_PROXY` / `HTTPS_PROXY` env vars — HomeHarvest respects them automatically
- **Photo URLs**: Realtor.com CDN URLs stored as-is; publisher uploads them to ImageKit CDN when publishing

---

## Notes

- **Source**: Realtor.com only (HomeHarvest uses Realtor.com's GraphQL API; Zillow was removed in 2024)
- **Python version**: 3.9+ required by HomeHarvest
