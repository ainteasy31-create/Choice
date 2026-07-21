#!/usr/bin/env python3
"""
columbus_oh_batch.py — Columbus, OH Rental Batch
=================================================
Target markets  : Columbus, OH metro area (Dublin, Westerville, Hilliard,
                  Grove City, Gahanna, New Albany, Reynoldsburg, Worthington,
                  Pickerington, Upper Arlington, Bexley, Whitehall)
Property types  : Houses (SINGLE_FAMILY), Townhouses (TOWNHOMES),
                  Apartments (APARTMENT)
Bedrooms        : 2 exactly
Bathrooms       : Any (min 1.0)
Rent range      : $1,400–$1,800 / month (scraped); max published $1,600
Preferred       : Hardwood floors, in-home washer/dryer (ranked higher)

Pricing tiers (this batch only):
  $1,400–$1,600  -> publish the original advertised rent
  $1,601–$1,675  -> small reduction so final rent is naturally below $1,600
  $1,676–$1,750  -> moderate reduction -> $1,500–$1,600
  $1,751–$1,800  -> larger reduction -> $1,500–$1,600

Final rent rules:
  - Never publish above $1,600/month
  - Security deposit = published rent when adjusted
  - Maintain natural price variation; avoid every listing at exactly $1,600

All platform rules (watermark detection, ImageKit upload, enrichment,
fee normalization, duplicate detection, final validation) are enforced
automatically by PipelineOrchestrator — they do not need to be repeated
here. See scraper/pipeline.py and scraper/PLATFORM_RULES.md.

Usage:
  python3 scraper/columbus_oh_batch.py
  python3 scraper/columbus_oh_batch.py --dry-run
  python3 scraper/columbus_oh_batch.py --target 5 --past-days 90
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
    "Dublin, OH",
    "Westerville, OH",
    "Hilliard, OH",
    "Grove City, OH",
]

FALLBACK_LOCATIONS = [
    "Gahanna, OH",
    "New Albany, OH",
    "Reynoldsburg, OH",
    "Worthington, OH",
    "Pickerington, OH",
    "Upper Arlington, OH",
    "Bexley, OH",
    "Whitehall, OH",
    "Canal Winchester, OH",
    "Delaware, OH",
    "Heath, OH",
    "Lancaster, OH",
]

# ZIP-level scraping gives 200 results per ZIP vs 200 for the entire city
ZIP_CODES = [
    # Columbus core
    "43201", "43202", "43203", "43204", "43205", "43206",
    "43207", "43209", "43210", "43211", "43212", "43213",
    "43214", "43215", "43219", "43220", "43221", "43222",
    "43223", "43224", "43227", "43228", "43229", "43230",
    "43231", "43232", "43235",
    # Dublin / Hilliard / Grove City / Westerville
    "43016", "43017", "43026", "43054", "43082", "43123",
]

ALLOWED_TYPES    = {"SINGLE_FAMILY", "TOWNHOMES", "APARTMENT"}
BEDS_EXACT       = 2
BATHS_MIN        = 1.0
RENT_MIN         = 1400
RENT_MAX         = 1800
ADJUSTED_FLOOR   = 1500   # minimum for tiers 2–4 (adjusted-down properties only)
RENT_CAP         = 1600   # never publish above this


# ---------------------------------------------------------------------------
# Pricing function (batch-specific)
# ---------------------------------------------------------------------------

def compute_columbus_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """
    Tiered pricing for Columbus, OH batch (per job spec).

    Tier 1  $1,400–$1,600  -> publish as-is (no floor clamp; preserve original)
    Tier 2  $1,601–$1,675  -> small reduction;   published naturally below $1,600
    Tier 3  $1,676–$1,750  -> moderate reduction; published $1,500–$1,600
    Tier 4  $1,751–$1,800  -> larger reduction;   published $1,500–$1,600

    The ADJUSTED_FLOOR ($1,500) only applies to tiers 2–4.
    Tier 1 listings publish at their exact original rent (rounded to dollars).

    Returns (published_rent_int, original_rent_float) or (None, None) to skip.
    """
    if original_rent is None:
        return None, None
    rent = float(original_rent)
    if rent < RENT_MIN or rent > RENT_MAX:
        return None, None

    if rent <= 1600:
        # Tier 1: publish as-is — round to nearest dollar, no floor clamp.
        # A $1,450 listing stays $1,450; a $1,600 listing stays $1,600.
        published = int(round(rent))
        # Only uniqueness nudge within the as-is range (keep below cap)
        if seen_rents is not None and published in seen_rents:
            for nudge in (5, -5, 10, -10, 15, -15, 20, -20):
                candidate = published + nudge
                if RENT_MIN <= candidate <= RENT_CAP and candidate not in seen_rents:
                    published = candidate
                    break
        return int(published), rent

    # Tiers 2–4: rent is above $1,600 and needs to be adjusted down.
    if rent <= 1675:
        # Tier 2: small reduction -> just below $1,600 down to ~$1,570
        ratio = (rent - 1601) / (1675 - 1601)
        published = 1599 - ratio * (1599 - 1570)

    elif rent <= 1750:
        # Tier 3: moderate reduction -> $1,540–$1,595
        ratio = (rent - 1676) / (1750 - 1676)
        published = 1595 - ratio * (1595 - 1540)

    else:
        # Tier 4: larger reduction -> $1,500–$1,540
        ratio = (rent - 1751) / (1800 - 1751)
        published = 1540 - ratio * (1540 - 1500)

    # Round to nearest $5 for natural-looking prices; enforce adjusted floor + cap
    published = round(published / 5) * 5
    published = max(ADJUSTED_FLOOR, min(int(published), RENT_CAP))

    # Uniqueness nudge for adjusted tiers
    if seen_rents is not None:
        for nudge in (0, 5, -5, 10, -10, 15, -15, 20, -20, 25, -25):
            candidate = published + nudge
            if ADJUSTED_FLOOR <= candidate <= RENT_CAP and candidate not in seen_rents:
                published = candidate
                break

    return int(published), rent


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Columbus, OH rental batch")
    ap.add_argument("--dry-run",   action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target",    type=int, default=5,  help="Number of listings to publish")
    ap.add_argument("--past-days", type=int, default=90)
    ap.add_argument("--limit",     type=int, default=200, help="Max scraped per location")
    ap.add_argument("--min-score", type=int, default=35,  help="Data quality floor")
    args = ap.parse_args()

    criteria = BatchCriteria(
        batch_name="Columbus, OH",
        locations=TARGET_LOCATIONS,
        zip_codes=ZIP_CODES,
        fallback_locations=FALLBACK_LOCATIONS,
        beds_exact=BEDS_EXACT,
        baths_min=BATHS_MIN,
        rent_min=RENT_MIN,
        rent_max=RENT_MAX,
        rent_floor=ADJUSTED_FLOOR,
        rent_cap=RENT_CAP,
        allowed_types=ALLOWED_TYPES,
        target=args.target,
        past_days=args.past_days,
        limit=args.limit,
        min_score=args.min_score,
        pricing_fn=compute_columbus_rent,
    )

    orchestrator = PipelineOrchestrator(verbose=True)
    result = orchestrator.run(criteria, dry_run=args.dry_run)

    if result.errors and result.published == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
