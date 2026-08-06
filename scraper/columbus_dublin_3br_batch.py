#!/usr/bin/env python3
"""
columbus_dublin_3br_batch.py — Columbus, OH / Dublin-Area 3BR Single-Family Batch
===================================================================================
Target markets  : Dublin, OH (priority — ZIP codes 43235, 43016, 43017), then
                  Upper Arlington, Hilliard, Worthington, Powell, Northwest Columbus
Fallback markets: Columbus, OH (full city)
Property types  : SINGLE_FAMILY ONLY — houses only. No apartments, condos,
                  townhouses, duplexes, or multi-family units.
Bedrooms        : Exactly 3
Bathrooms       : 1.5 minimum (at least 1 full + 1 half bath)
Rent range      : $1,700 – $2,200 / month (scrape and publish range)
Published rent  : Original advertised rent — no adjustment. Cap enforced at $2,200.
Target          : 10 published listings

Platform rules enforced automatically by PipelineOrchestrator:
  - Watermark detection + rejection
  - ImageKit photo upload (minimum 6 photos)
  - Description enrichment + CTA
  - Application fee = $50
  - Security deposit = 1× monthly rent
  - Pets allowed = Yes
  - Duplicate detection
  - Pre-publish validation gate

Usage:
  python3 scraper/columbus_dublin_3br_batch.py
  python3 scraper/columbus_dublin_3br_batch.py --dry-run
  python3 scraper/columbus_dublin_3br_batch.py --target 10 --past-days 90
  python3 scraper/columbus_dublin_3br_batch.py --target 10 --past-days 120
"""

import argparse
import sys
from typing import Optional, Set

from pipeline import PipelineOrchestrator, BatchCriteria

# ---------------------------------------------------------------------------
# Batch constants
# ---------------------------------------------------------------------------

# Dublin ZIP codes are highest priority — scrape these first
TARGET_LOCATIONS = [
    "Dublin, OH",         # 43235, 43016, 43017
    "Upper Arlington, OH",
    "Hilliard, OH",
    "Worthington, OH",
    "Powell, OH",
]

FALLBACK_LOCATIONS = [
    "Columbus, OH",
    "Westerville, OH",
    "Gahanna, OH",
    "New Albany, OH",
    "Grove City, OH",
    "Pickerington, OH",
    "Reynoldsburg, OH",
]

# Dublin ZIP codes — scrape at ZIP level for denser results in priority area
ZIP_CODES = [
    "43235",  # Dublin core / NW Columbus
    "43016",  # Dublin west
    "43017",  # Dublin east
    "43220",  # Upper Arlington north
    "43221",  # Upper Arlington south
    "43026",  # Hilliard
    "43085",  # Worthington
    "43065",  # Powell
]

ALLOWED_TYPES = {"SINGLE_FAMILY"}

BEDS_EXACT  = 3
BATHS_MIN   = 1.5
RENT_MIN    = 1700
RENT_MAX    = 2200
RENT_FLOOR  = 1700
RENT_CAP    = 2200


# ---------------------------------------------------------------------------
# Pricing function — publish at original advertised rent, cap at $2,200
# ---------------------------------------------------------------------------

def compute_dublin_3br_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """
    Publish at the original advertised rent — no reduction needed.
    Only filter out listings outside the $1,700–$2,200 range.
    Uniqueness nudge applied if rent already seen in this batch.

    Returns (published_rent_int, original_rent_float) or (None, None) to skip.
    """
    if original_rent is None:
        return None, None

    rent = float(original_rent)

    if rent < RENT_MIN or rent > RENT_MAX:
        return None, None

    published = round(int(rent) / 5) * 5  # round to nearest $5
    published = max(RENT_FLOOR, min(published, RENT_CAP))

    # Uniqueness nudge — avoid two listings at the exact same price
    if seen_rents is not None and published in seen_rents:
        for nudge in (5, -5, 10, -10, 15, -15, 20, -20, 25, -25):
            candidate = published + nudge
            if RENT_FLOOR <= candidate <= RENT_CAP and candidate not in seen_rents:
                published = candidate
                break

    return int(published), rent


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Columbus, OH / Dublin-area 3BR single-family rental batch"
    )
    ap.add_argument("--dry-run",   action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target",    type=int, default=10, help="Number of listings to publish")
    ap.add_argument("--past-days", type=int, default=90, help="How far back to scrape")
    ap.add_argument("--limit",     type=int, default=200, help="Max scraped per location")
    ap.add_argument("--min-score", type=int, default=35,  help="Data quality floor")
    args = ap.parse_args()

    criteria = BatchCriteria(
        batch_name="Columbus/Dublin, OH — 3BR Single-Family",
        locations=TARGET_LOCATIONS,
        zip_codes=ZIP_CODES,
        fallback_locations=FALLBACK_LOCATIONS,
        beds_exact=BEDS_EXACT,
        baths_min=BATHS_MIN,
        rent_min=RENT_MIN,
        rent_max=RENT_MAX,
        rent_floor=RENT_FLOOR,
        rent_cap=RENT_CAP,
        allowed_types=ALLOWED_TYPES,
        target=args.target,
        past_days=args.past_days,
        limit=args.limit,
        min_score=args.min_score,
        pricing_fn=compute_dublin_3br_rent,
    )

    orchestrator = PipelineOrchestrator(verbose=True)
    result = orchestrator.run(criteria, dry_run=args.dry_run)

    if result.published > 0:
        print("\n" + "=" * 60)
        print("PUBLISHED LISTINGS")
        print("=" * 60)
        for url in result.published_urls:
            print(url)

    if result.errors and result.published == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
