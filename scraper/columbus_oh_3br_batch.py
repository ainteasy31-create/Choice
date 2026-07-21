#!/usr/bin/env python3
"""
columbus_oh_3br_batch.py — Columbus, OH 3-Bedroom Rental Batch
===============================================================
Target markets  : Columbus, OH (all neighborhoods/zip codes)
                  Fallback: inner-ring suburbs only
Property types  : Single-family homes (SINGLE_FAMILY), Townhomes (TOWNHOMES)
                  Strictly NO apartments, condos, duplexes, or multi-family
Bedrooms        : Exactly 3
Bathrooms       : 1 or 2 (baths_min 1.0, baths_max 2.0)
Rent range      : $800–$1,500 / month (base rent)
Published cap   : $1,500 / month (never publish above this)
Target          : 10 publishable listings

Pricing policy  : Publish as-is (all scraped listings are already ≤ $1,500).
                  Round to nearest dollar; ensure no listing exceeds $1,500.

Usage:
  python3 scraper/columbus_oh_3br_batch.py
  python3 scraper/columbus_oh_3br_batch.py --dry-run
  python3 scraper/columbus_oh_3br_batch.py --target 10 --past-days 90
"""

import argparse
import sys
from typing import Optional, Set

from pipeline import PipelineOrchestrator, BatchCriteria

# ---------------------------------------------------------------------------
# Batch constants
# ---------------------------------------------------------------------------

# Columbus city proper — all neighborhoods, all zip codes
TARGET_LOCATIONS = [
    "Columbus, OH",
]

# Inner-ring suburbs only (expand if Columbus proper can't reach target)
FALLBACK_LOCATIONS = [
    "Bexley, OH",
    "Whitehall, OH",
    "Upper Arlington, OH",
    "Grandview Heights, OH",
    "Worthington, OH",
    "Gahanna, OH",
    "Reynoldsburg, OH",
    "Hilliard, OH",
    "Grove City, OH",
    "Westerville, OH",
    "Dublin, OH",
]

# ZIP-level scraping within Columbus city limits gives broader coverage
ZIP_CODES = [
    # Columbus core
    "43201", "43202", "43203", "43204", "43205", "43206",
    "43207", "43209", "43210", "43211", "43212", "43213",
    "43214", "43215", "43219", "43220", "43221", "43222",
    "43223", "43224", "43227", "43228", "43229", "43230",
    "43231", "43232", "43235",
]

ALLOWED_TYPES = {"SINGLE_FAMILY", "TOWNHOMES"}   # strictly no apartments/condos/duplexes

BEDS_EXACT  = 3
BATHS_MIN   = 1.0
BATHS_MAX   = 2.0
RENT_MIN    = 800    # capture all affordable Columbus 3BR inventory
RENT_MAX    = 1500   # directive maximum
RENT_CAP    = 1500   # never publish above this


# ---------------------------------------------------------------------------
# Pricing function — publish as-is (all listings ≤ $1,500)
# ---------------------------------------------------------------------------

def compute_columbus_3br_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """
    Pass-through pricing for Columbus 3BR batch.

    All scraped listings are already at or below $1,500, so we publish
    the original rent as-is (rounded to the nearest dollar).  A small
    uniqueness nudge (±$5 increments) is applied only when two listings
    land on the exact same dollar amount.

    Returns (published_rent_int, original_rent_float) or (None, None) to skip.
    """
    if original_rent is None:
        return None, None

    rent = float(original_rent)

    if rent < RENT_MIN or rent > RENT_MAX:
        return None, None

    published = int(round(rent))

    # Uniqueness nudge — keep within range and cap
    if seen_rents is not None and published in seen_rents:
        for nudge in (5, -5, 10, -10, 15, -15, 20, -20, 25, -25):
            candidate = published + nudge
            if RENT_MIN <= candidate <= RENT_CAP and candidate not in seen_rents:
                published = candidate
                break

    return int(published), rent


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Columbus, OH 3-bedroom rental batch")
    ap.add_argument("--dry-run",   action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target",    type=int, default=10, help="Number of listings to publish")
    ap.add_argument("--past-days", type=int, default=90)
    ap.add_argument("--limit",     type=int, default=200, help="Max scraped per location")
    ap.add_argument("--min-score", type=int, default=35,  help="Data quality floor")
    args = ap.parse_args()

    criteria = BatchCriteria(
        batch_name="Columbus, OH — 3BR",
        locations=TARGET_LOCATIONS,
        zip_codes=ZIP_CODES,
        fallback_locations=FALLBACK_LOCATIONS,
        beds_exact=BEDS_EXACT,
        baths_min=BATHS_MIN,
        baths_max=BATHS_MAX,
        rent_min=RENT_MIN,
        rent_max=RENT_MAX,
        rent_floor=RENT_MIN,
        rent_cap=RENT_CAP,
        allowed_types=ALLOWED_TYPES,
        target=args.target,
        past_days=args.past_days,
        limit=args.limit,
        min_score=args.min_score,
        pricing_fn=compute_columbus_3br_rent,
    )

    orchestrator = PipelineOrchestrator(verbose=True)
    result = orchestrator.run(criteria, dry_run=args.dry_run)

    if result.errors and result.published == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
