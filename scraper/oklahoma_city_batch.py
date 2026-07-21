#!/usr/bin/env python3
"""
oklahoma_city_batch.py — Oklahoma City, OK Single-Family Rental Batch
======================================================================
Target market   : Oklahoma City, OK (+ surrounding suburbs as fallback)
Property types  : Single-family homes ONLY (NO apartments, condos, duplexes,
                  triplexes, multifamily, rooms for rent, shared housing)
Bedrooms        : 3 exactly
Bathrooms       : 2 (min 2.0)
Rent range      : $1,300–$1,600 / month (scraped)
Price rule      : tiered reduction; published rent never exceeds $1,400/month
                  Security deposit = published rent when adjusted

Pricing tiers (this batch only):
  $1,300–$1,400  -> publish at original price
  $1,401–$1,500  -> reduce to $1,400 or below
  $1,501–$1,600  -> apply reasonable adjustment to land at or below $1,400

Platform rules enforced automatically by PipelineOrchestrator:
  - Watermark detection & rejection (text/metadata)
  - All-photo-watermarked listings rejected at enrichment step
  - ImageKit upload + verification
  - Enrichment, fee normalization ($50 app fee), duplicate detection
  - Final validation gate before any DB write

See scraper/pipeline.py and scraper/PLATFORM_RULES.md for full rule set.

Usage:
  python3 scraper/oklahoma_city_batch.py
  python3 scraper/oklahoma_city_batch.py --dry-run
  python3 scraper/oklahoma_city_batch.py --target 5 --past-days 90
"""

import argparse
import sys
from typing import Optional, Set

from pipeline import PipelineOrchestrator, BatchCriteria

# ---------------------------------------------------------------------------
# Locations
# ---------------------------------------------------------------------------
TARGET_LOCATIONS = [
    "Oklahoma City, OK",
]

FALLBACK_LOCATIONS = [
    "Edmond, OK",
    "Midwest City, OK",
    "Moore, OK",
    "Norman, OK",
    "Yukon, OK",
    "Mustang, OK",
    "Del City, OK",
    "Bethany, OK",
]

ALLOWED_TYPES = {"SINGLE_FAMILY"}

BEDS_EXACT  = 3
BATHS_MIN   = 2.0
BATHS_MAX   = 3.0
RENT_MIN    = 1300
RENT_MAX    = 1600
RENT_CAP    = 1400
RENT_FLOOR  = 1300


# ---------------------------------------------------------------------------
# Pricing function
# ---------------------------------------------------------------------------

def compute_okc_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """
    Tiered pricing for the Oklahoma City market.

    Tiers:
      $1,300–$1,400  -> publish as-is
      $1,401–$1,500  -> smooth reduction → $1,300–$1,400
      $1,501–$1,600  -> smooth reduction → $1,300–$1,400

    Applies a uniqueness nudge (±$5–$20 in $5 steps) to avoid duplicate
    published rents within the same batch. Never publishes above $1,400.
    """
    if original_rent is None:
        return None, None
    rent = float(original_rent)
    if rent < RENT_MIN or rent > RENT_MAX:
        return None, None

    if rent <= 1400:
        published = rent
    elif rent <= 1500:
        ratio     = (rent - 1400) / (1500 - 1400)
        published = 1400 - ratio * (1400 - 1300)
    else:
        ratio     = (rent - 1500) / (1600 - 1500)
        published = RENT_FLOOR + ratio * (RENT_CAP - RENT_FLOOR)

    published = round(published / 5) * 5
    published = max(RENT_FLOOR, min(int(published), RENT_CAP))

    if seen_rents is not None:
        for nudge in (0, 5, -5, 10, -10, 15, -15, 20, -20):
            candidate = published + nudge
            if RENT_FLOOR <= candidate <= RENT_CAP and candidate not in seen_rents:
                published = candidate
                break

    return int(published), rent


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Oklahoma City, OK single-family batch")
    ap.add_argument("--dry-run",   action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target",    type=int, default=5,  help="Number of listings to publish")
    ap.add_argument("--past-days", type=int, default=90, help="Max listing age in days")
    ap.add_argument("--limit",     type=int, default=200, help="Max scraped per location")
    ap.add_argument("--min-score", type=int, default=40,  help="Data quality floor")
    args = ap.parse_args()

    criteria = BatchCriteria(
        batch_name="Oklahoma City, OK",
        locations=TARGET_LOCATIONS,
        fallback_locations=FALLBACK_LOCATIONS,
        beds_exact=BEDS_EXACT,
        baths_min=BATHS_MIN,
        baths_max=BATHS_MAX,
        rent_min=RENT_MIN,
        rent_max=RENT_MAX,
        rent_floor=RENT_FLOOR,
        rent_cap=RENT_CAP,
        allowed_types=ALLOWED_TYPES,
        target=args.target,
        past_days=args.past_days,
        limit=args.limit,
        min_score=args.min_score,
        pricing_fn=compute_okc_rent,
    )

    orchestrator = PipelineOrchestrator(verbose=True)
    result = orchestrator.run(criteria, dry_run=args.dry_run)

    print("\n" + result.summary())

    if result.published_urls:
        print("\nLive listings:")
        for i, url in enumerate(result.published_urls, 1):
            print("  {}. {}".format(i, url))

    if result.errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
