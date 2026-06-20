# Choice Properties — HomeHarvest Scraper

Scrapes **for-rent** listings directly from **Realtor.com** using the [HomeHarvest](https://github.com/ZacharyHampton/HomeHarvest) library and stages them in `pipeline.pipeline_properties` for admin review and one-click publishing to the live site.

---

## How It Fits the Architecture

```
HomeHarvest (Realtor.com)
        │
        ▼
  scraper/scraper.py
        │  writes to
        ▼
pipeline.pipeline_properties  ←── admin reviews in Property Pipeline UI
        │  "Publish" button
        ▼
public.properties + public.property_photos  ←── live Choice Properties site
```

Scraped listings always land with `status = "scraped"`. Nothing goes live until an admin reviews and publishes.

---

## Setup

### 1. Install Python dependency

```bash
pip install homeharvest
# Python >= 3.9 required
```

### 2. Set environment variables

```bash
export SUPABASE_URL="https://tlfmwetmhthpyrytrcfo.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<your service role key>"
```

Or create a `.env` file and `source` it:

```bash
# .env
SUPABASE_URL=https://tlfmwetmhthpyrytrcfo.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

```bash
source .env  # or: set -a && source .env && set +a
```

---

## Usage

```
python scraper/scraper.py --location <location> [options]
```

### Required

| Flag | Description |
|---|---|
| `--location` | Where to search. Accepts: city, `"City, ST"`, ZIP code, full address, neighborhood, county |

### Optional filters

| Flag | Default | Description |
|---|---|---|
| `--past-days N` | `7` | Only listings from the last N days |
| `--beds-min N` | — | Minimum bedrooms |
| `--beds-max N` | — | Maximum bedrooms |
| `--price-min $` | — | Minimum monthly rent |
| `--price-max $` | — | Maximum monthly rent |
| `--property-type TYPE` | — | Comma-separated types: `single_family`, `condos`, `townhomes`, `apartment`, `multi_family`, `duplex_triplex`, `mobile` |
| `--limit N` | `200` | Max results to fetch (up to 10,000) |
| `--extra` | off | Fetch per-property extras (schools, tax history) — adds 1 HTTP request per listing |
| `--dry-run` | off | Preview results without writing to the database |

---

## Examples

```bash
# Basic — scrape Dallas rentals from the last 7 days
python scraper/scraper.py --location "Dallas, TX"

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

# Preview without saving
python scraper/scraper.py --location "Miami, FL" --dry-run

# ZIP code search
python scraper/scraper.py --location "30301" --price-max 2500
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

1. Open the **Property Pipeline** admin UI (`choice121/property-pipeline`)
2. Review staged listings — edit titles, descriptions, photos as needed
3. Click **Publish** to move approved listings to the live site

The scraper **never auto-publishes**. All listings start as `status = "scraped"`.

---

## Deduplication

The scraper checks `source_listing_id` against existing pipeline rows before inserting. A listing that's already been scraped (same Realtor.com property_id) will be skipped automatically.

---

## Logging

Every scrape run is recorded in `pipeline.pipeline_scrape_runs` with:
- Total scraped, new staged, duplicates skipped, errors
- Average data quality score
- Start/end timestamps
- Location searched

---

## Notes

- **Source**: Realtor.com only (HomeHarvest uses Realtor.com's GraphQL API; Zillow was removed in 2024)
- **Rate limits**: For runs > 500 listings, consider spacing requests or using the `--limit` flag with multiple runs
- **Photo URLs**: Realtor.com CDN URLs are stored as-is. The publisher uploads them to ImageKit CDN when publishing to the live site
- **Proxy support**: If you get rate-limited, set `HTTP_PROXY` / `HTTPS_PROXY` env vars — HomeHarvest respects them automatically
- **Python version**: 3.9+ required by HomeHarvest
