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
Scraped range   : $800–$1,700 / month (wider net for clean inventory)
Published cap   : $1,500 / month (tiered reduction for $1,501–$1,700 listings)
Target          : 8 publishable listings (default)

Pricing tiers:
  $800–$1,500   → publish as-is (no adjustment needed)
  $1,501–$1,575 → small reduction  → $1,450–$1,500
  $1,576–$1,640 → moderate reduction → $1,400–$1,475
  $1,641–$1,700 → larger reduction  → $1,350–$1,420

Usage:
  python3 scraper/columbus_oh_3br_batch.py
  python3 scraper/columbus_oh_3br_batch.py --dry-run
  python3 scraper/columbus_oh_3br_batch.py --target 8 --past-days 90
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

# Inner-ring suburbs (expand only if Columbus proper can't reach target)
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

# ZIP-level scraping within Columbus city limits
ZIP_CODES = [
    # Columbus core
    "43201", "43202", "43203", "43204", "43205", "43206",
    "43207", "43209", "43210", "43211", "43212", "43213",
    "43214", "43215", "43219", "43220", "43221", "43222",
    "43223", "43224", "43227", "43228", "43229", "43230",
    "43231", "43232", "43235",
]

ALLOWED_TYPES = {"SINGLE_FAMILY", "TOWNHOMES"}

BEDS_EXACT  = 3
BATHS_MIN   = 1.0
BATHS_MAX   = 2.0
RENT_MIN    = 800
RENT_MAX    = 1700   # wider scrape net
RENT_FLOOR  = 1200   # minimum published rent for adjusted listings
RENT_CAP    = 1500   # never publish above this


# ---------------------------------------------------------------------------
# Pricing function — pass-through ≤$1,500, tier-reduce $1,501–$1,700
# ---------------------------------------------------------------------------

def compute_columbus_3br_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """
    Tiered pricing for Columbus 3BR batch.

    Tier 0  $800–$1,500    → publish as-is (no adjustment)
    Tier 1  $1,501–$1,575  → small reduction    → $1,450–$1,500
    Tier 2  $1,576–$1,640  → moderate reduction → $1,400–$1,475
    Tier 3  $1,641–$1,700  → larger reduction   → $1,350–$1,420

    Returns (published_rent_int, original_rent_float) or (None, None) to skip.
    """
    if original_rent is None:
        return None, None

    rent = float(original_rent)

    if rent < RENT_MIN or rent > RENT_MAX:
        return None, None

    if rent <= 1500:
        # Tier 0: publish as-is
        published = int(round(rent))
    elif rent <= 1575:
        # Tier 1: small reduction → $1,450–$1,500
        ratio = (rent - 1501) / (1575 - 1501)
        published = int(round(1500 - ratio * (1500 - 1450)))
    elif rent <= 1640:
        # Tier 2: moderate reduction → $1,400–$1,475
        ratio = (rent - 1576) / (1640 - 1576)
        published = int(round(1475 - ratio * (1475 - 1400)))
    else:
        # Tier 3: larger reduction → $1,350–$1,420
        ratio = (rent - 1641) / (1700 - 1641)
        published = int(round(1420 - ratio * (1420 - 1350)))

    # Round to nearest $5 for natural-looking prices; enforce floor + cap
    published = round(published / 5) * 5
    published = max(RENT_FLOOR, min(int(published), RENT_CAP))

    # Uniqueness nudge
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
    ap = argparse.ArgumentParser(description="Columbus, OH 3-bedroom rental batch")
    ap.add_argument("--dry-run",   action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target",    type=int, default=8,  help="Number of listings to publish")
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
        rent_floor=RENT_FLOOR,
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
