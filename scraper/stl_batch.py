#!/usr/bin/env python3
"""
stl_batch.py — St. Louis Rental Batch
======================================
Target markets : Maryland Heights, MO + Creve Coeur, MO
                 (falls back to North St. Louis County suburbs)
Property types : Houses (SINGLE_FAMILY), Townhouses (TOWNHOMES), Apartments (APARTMENT)
Bedrooms       : 3 exactly
Rent range     : $1,200–$1,600 / month (scraped)
Price rule     : published rent capped at $1,200; security deposit = published rent

All platform rules enforced automatically by PipelineOrchestrator.
See scraper/pipeline.py and scraper/PLATFORM_RULES.md.

Usage:
  python3 scraper/stl_batch.py
  python3 scraper/stl_batch.py --dry-run
  python3 scraper/stl_batch.py --target 15 --past-days 90
"""

import argparse
import sys
from typing import Optional, Set

from pipeline import PipelineOrchestrator, BatchCriteria

# ---------------------------------------------------------------------------
# Batch constants
# ---------------------------------------------------------------------------
TARGET_LOCATIONS = [
    "Maryland Heights, MO",
    "Creve Coeur, MO",
]
FALLBACK_LOCATIONS = [
    "Florissant, MO",
    "Hazelwood, MO",
    "Ferguson, MO",
    "Bellefontaine Neighbors, MO",
    "Jennings, MO",
    "Overland, MO",
    "Normandy, MO",
    "University City, MO",
    "Mehlville, MO",
]

# ZIP-level scraping gives 200 results per ZIP vs 200 for the entire city
ZIP_CODES = [
    # Maryland Heights / Creve Coeur
    "63043", "63141",
    # North St. Louis County suburbs
    "63031", "63033", "63034", "63044", "63074", "63114",
    "63121", "63122", "63123", "63125", "63126", "63129",
    "63130", "63131", "63132", "63133", "63135", "63136",
    "63137", "63138", "63140", "63143", "63144", "63146",
]

ALLOWED_TYPES = {"SINGLE_FAMILY", "TOWNHOMES", "APARTMENT"}
BEDS_EXACT    = 3
RENT_MIN      = 1200
RENT_MAX      = 1600
RENT_CAP      = 1200
RENT_FLOOR    = 1050


# ---------------------------------------------------------------------------
# Pricing function (batch-specific)
# ---------------------------------------------------------------------------

def compute_stl_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """
    Cap-based pricing for St. Louis market.
    Anything above $1,200 is proportionally reduced to $1,050–$1,200.
    Returns (published_rent_int, original_rent_float) or (None, None).
    """
    if original_rent is None:
        return None, None
    rent = float(original_rent)
    if rent < RENT_MIN or rent > RENT_MAX:
        return None, None

    if rent <= RENT_CAP:
        published = int(rent)
    else:
        # Proportional: $1,201–$1,600 -> $1,050–$1,200
        ratio = (rent - RENT_CAP) / (RENT_MAX - RENT_CAP) if RENT_MAX != RENT_CAP else 0
        published = RENT_FLOOR + ratio * (RENT_CAP - RENT_FLOOR)
        published = round(published / 5) * 5
        published = max(RENT_FLOOR, min(int(published), RENT_CAP))

    if seen_rents is not None:
        for nudge in (0, 5, -5, 10, -10, 15, -15, 25, -25):
            candidate = published + nudge
            if RENT_FLOOR <= candidate <= RENT_CAP and candidate not in seen_rents:
                published = candidate
                break

    return int(published), rent


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="St. Louis rental batch")
    ap.add_argument("--dry-run",   action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target",    type=int, default=15, help="Number of listings to publish")
    ap.add_argument("--past-days", type=int, default=90)
    ap.add_argument("--limit",     type=int, default=200)
    ap.add_argument("--min-score", type=int, default=35)
    args = ap.parse_args()

    criteria = BatchCriteria(
        batch_name="Maryland Heights / Creve Coeur, MO (St. Louis)",
        locations=TARGET_LOCATIONS,
        zip_codes=ZIP_CODES,
        fallback_locations=FALLBACK_LOCATIONS,
        beds_exact=BEDS_EXACT,
        rent_min=RENT_MIN,
        rent_max=RENT_MAX,
        rent_floor=RENT_FLOOR,
        rent_cap=RENT_CAP,
        allowed_types=ALLOWED_TYPES,
        target=args.target,
        past_days=args.past_days,
        limit=args.limit,
        min_score=args.min_score,
        pricing_fn=compute_stl_rent,
    )

    orchestrator = PipelineOrchestrator(verbose=True)
    result = orchestrator.run(criteria, dry_run=args.dry_run)

    if result.errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
