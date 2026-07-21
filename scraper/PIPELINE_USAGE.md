# Choice Properties — Pipeline Orchestrator Usage Guide

All scraping and publishing jobs must use `PipelineOrchestrator` from
`scraper/pipeline.py`. This guarantees every permanent platform rule
(see `PLATFORM_RULES.md`) is enforced identically for every batch.

---

## Creating a New City Batch

A new batch script is ~60 lines. You only define:
1. **Search criteria** (locations, bed/bath/rent/type filters)
2. **A pricing function** (optional — omit if publishing as-is)

Everything else — watermark detection, ImageKit upload, enrichment,
fee normalization, duplicate detection, validation, publish, activate
— runs automatically.

### Template

```python
#!/usr/bin/env python3
"""
my_city_batch.py — My City, ST Rental Batch
"""
import argparse, sys
from typing import Optional, Set
from pipeline import PipelineOrchestrator, BatchCriteria


TARGET_LOCATIONS   = ["My City, ST"]
FALLBACK_LOCATIONS = ["Nearby City, ST"]
ALLOWED_TYPES      = {"SINGLE_FAMILY", "TOWNHOMES"}


def compute_my_city_rent(original_rent, seen_rents: Optional[Set[int]] = None):
    """
    Define your pricing logic here.
    Returns (published_rent_int, original_rent_float) or (None, None) to skip.
    """
    if original_rent is None:
        return None, None
    rent = float(original_rent)
    if rent < 1200 or rent > 1800:
        return None, None
    # Example: proportional reduction to $1,100–$1,300
    ratio = (rent - 1200) / (1800 - 1200)
    published = int(1100 + ratio * (1300 - 1100))
    published = round(published / 5) * 5
    if seen_rents:
        for nudge in (0, 5, -5, 10, -10):
            c = published + nudge
            if 1100 <= c <= 1300 and c not in seen_rents:
                published = c
                break
    return published, rent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run",   action="store_true")
    ap.add_argument("--target",    type=int, default=10)
    ap.add_argument("--past-days", type=int, default=90)
    ap.add_argument("--limit",     type=int, default=200)
    ap.add_argument("--min-score", type=int, default=40)
    args = ap.parse_args()

    criteria = BatchCriteria(
        batch_name="My City, ST",
        locations=TARGET_LOCATIONS,
        fallback_locations=FALLBACK_LOCATIONS,
        beds_exact=3,          # or beds_min/beds_max for a range
        baths_min=2.0,
        rent_min=1200,
        rent_max=1800,
        rent_floor=1100,
        rent_cap=1300,
        allowed_types=ALLOWED_TYPES,
        target=args.target,
        past_days=args.past_days,
        limit=args.limit,
        min_score=args.min_score,
        pricing_fn=compute_my_city_rent,
    )

    result = PipelineOrchestrator(verbose=True).run(criteria, dry_run=args.dry_run)
    if result.errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
```

---

## BatchCriteria Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `batch_name` | str | yes | Label shown in logs |
| `locations` | list[str] | yes | Primary scrape targets e.g. `["Austin, TX"]` |
| `fallback_locations` | list[str] | no | Used if primary cities don't hit target count |
| `beds_exact` | int | no | Exact bedroom count (overrides min/max) |
| `beds_min` / `beds_max` | int | no | Bedroom range |
| `baths_min` / `baths_max` | float | no | Bathroom range |
| `rent_min` / `rent_max` | int | yes | Scraped rent filter |
| `rent_floor` / `rent_cap` | int | no | Published rent range (used by default proportional pricer if no `pricing_fn`) |
| `allowed_types` | set[str] | no | e.g. `{"SINGLE_FAMILY", "TOWNHOMES"}` |
| `target` | int | yes | How many listings to publish |
| `past_days` | int | yes | How far back to scrape |
| `limit` | int | no | Max scraped per location (default 200) |
| `min_score` | int | no | Data quality floor (default 40) |
| `pricing_fn` | callable | no | `fn(original_rent, seen_rents) -> (published_int, orig_float)` |

---

## The 13-Step Pipeline (What Runs Automatically)

Every call to `PipelineOrchestrator.run()` executes all 13 steps in order.
None can be skipped.

| Step | What happens |
|---|---|
| 1 | Scrape via HomeHarvest + detail-page enrichment |
| 2 | Active/available filter + within-batch dedup |
| 3 | Criteria filter + text-based watermark check (drops competitor-branded listings) |
| 4 | Pricing — applies `pricing_fn` or default proportional reduction |
| 5 | Image pre-check — must have ≥ 6 source URLs |
| 6 | Enrichment pipeline — cleanup, branding, fee normalization, price sync, CTA |
| 7 | Pre-publish validation gate (`validate_for_publish`) |
| 8 | Stage records in `pipeline_properties` |
| 9 | Patch pricing + description on staged records |
| 10 | Publish via `pipeline_publish` RPC |
| 11 | Activate property (status = active) |
| 12 | Download → ImageKit upload → verify → insert `property_photos` |

---

## Required Environment Variables

| Variable | Required | Used for |
|---|---|---|
| `SUPABASE_URL` | yes | All DB operations |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | All DB + RPC calls |
| `IMAGEKIT_PRIVATE_KEY` | yes | Photo uploads |
| `IMAGEKIT_URL_ENDPOINT` | yes | Photo URL base |

Set in `.env` (local) or Replit Secrets / GitHub Actions secrets (CI).

---

## Running a Batch

```bash
# Preview (no DB writes)
python3 scraper/arlington_tx_batch.py --dry-run

# Publish 10 listings
python3 scraper/arlington_tx_batch.py --target 10

# Publish 15, scrape further back
python3 scraper/dallas_ga_batch.py --target 15 --past-days 120
```

---

## Running the Existing Listing Audit

The audit checks every published listing for broken images, non-ImageKit
URLs, watermarked photos, and insufficient photo count.

```bash
# Report only (no writes)
python3 scraper/listing_audit.py --report-only

# Identify and unpublish non-compliant listings
python3 scraper/listing_audit.py --fix

# Preview what --fix would do
python3 scraper/listing_audit.py --fix --dry-run
```

The audit also runs automatically every day at 06:00 UTC via
`.github/workflows/existing-listing-audit.yml`.

---

## Adding a New Module to the Pipeline

If you want to add a new processing step (e.g. duplicate photo detection,
geo-coding validation), add it to `PipelineOrchestrator` in `pipeline.py`
as a numbered method and call it from `run()`. Do not add it in individual
batch scripts — it will be silently skipped everywhere else.
