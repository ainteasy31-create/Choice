#!/usr/bin/env python3
"""
columbus_3_4br_1800_2000_batch.py — Columbus, OH 3-4BR Single-Family Batch ($1,800-$2,000)
==========================================================================================
Target markets  : Columbus, OH (all neighborhoods/zip codes)
Fallback markets: Reynoldsburg, Blacklick, New Albany, Gahanna, Westerville,
                  Pickerington, Grove City, Hilliard, Dublin
Property types  : SINGLE_FAMILY ONLY — houses only. No apartments, condos,
                  townhouses, duplexes, or multi-family units.
Bedrooms        : 3 to 4 (beds_min=3, beds_max=4)
Bathrooms       : 2.0 minimum
Rent range      : $1,800 – $2,000 / month (scrape and publish range)
Published rent  : Original advertised rent — no adjustment needed
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
  python3 scraper/columbus_3_4br_1800_2000_batch.py
  python3 scraper/columbus_3_4br_1800_2000_batch.py --dry-run
  python3 scraper/columbus_3_4br_1800_2000_batch.py --target 10 --past-days 90
  python3 scraper/columbus_3_4br_1800_2000_batch.py --target 10 --past-days 120
"""

import argparse
import sys
from typing import Optional, Set

from pipeline import PipelineOrchestrator, BatchCriteria

# ---------------------------------------------------------------------------
# Batch constants
# ---------------------------------------------------------------------------

TARGET_LOCATIONS = [
    "Columbus, OH",
]

FALLBACK_LOCATIONS = [
    "Reynoldsburg, OH",
    "Blacklick, OH",
    "New Albany, OH",
    "Gahanna, OH",
    "Westerville, OH",
    "Pickerington, OH",
    "Grove City, OH",
    "Hilliard, OH",
    "Dublin, OH",
]

# ZIP-level scraping within Columbus city limits
ZIP_CODES = [
    # Columbus core
    "43201", "43202", "43203", "43204", "43205", "43206",
    "43207", "43209", "43210", "43211", "43212", "43213",
    "43214", "43215", "43219", "43220", "43221", "43222",
    "43223", "43224", "43227", "43228", "43229", "43230",
    "43231", "43232", "43235",
]

ALLOWED_TYPES = {"SINGLE_FAMILY"}

BEDS_MIN      = 3
BEDS_MAX      = 4
BATHS_MIN     = 2.0
RENT_MIN      = 1800
RENT_MAX      = 2000
RENT_FLOOR    = 1800
RENT_CAP      = 2000


# ---------------------------------------------------------------------------
# Pricing function — publish at original advertised rent, cap at $2,000
# ---------------------------------------------------------------------------

def compute_columbus_3_4br_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """
    Publish at the original advertised rent — no reduction needed.
    Only filter out listings outside the $1,800–$2,000 range.
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
        description="Columbus, OH 3-4BR single-family rental batch ($1,800-$2,000)"
    )
    ap.add_argument("--dry-run",   action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target",    type=int, default=10, help="Number of listings to publish")
    ap.add_argument("--past-days", type=int, default=90, help="How far back to scrape")
    ap.add_argument("--limit",     type=int, default=200, help="Max scraped per location")
    ap.add_argument("--min-score", type=int, default=35,  help="Data quality floor")
    args = ap.parse_args()

    criteria = BatchCriteria(
        batch_name="Columbus, OH — 3-4BR Single-Family ($1,800-$2,000)",
        locations=TARGET_LOCATIONS,
        zip_codes=ZIP_CODES,
        fallback_locations=FALLBACK_LOCATIONS,
        beds_min=BEDS_MIN,
        beds_max=BEDS_MAX,
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
        pricing_fn=compute_columbus_3_4br_rent,
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