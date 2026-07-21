#!/usr/bin/env python3
"""
charlotte_nc_batch.py — Charlotte, NC Rental Batch
====================================================
Target markets  : Charlotte, NC (preferred ZIP codes 28269 / 28262 first)
Fallback markets: Huntersville, Concord, Cornelius, Mint Hill, Matthews,
                  Pineville, Mooresville, Indian Trail, Stallings, Waxhaw
Property types  : Single-family homes (SINGLE_FAMILY) and Townhomes (TOWNHOMES)
                  No apartments, condos, duplexes, or multi-family.
Bedrooms        : 2 exactly
Bathrooms       : 2.0 minimum
Rent range      : $1,400–$1,700 / month (scraped AND published)
Published rent  : Original advertised rent — no adjustment required
Target          : 10 published listings

Pricing rule:
  Publish at original advertised rent; no tiers needed.
  Cap enforced at $1,700; floor at $1,400.

All platform rules (watermark detection, ImageKit upload, enrichment,
fee normalization, duplicate detection, final validation) are enforced
automatically by PipelineOrchestrator.  See pipeline.py.

Usage:
  python3 scraper/charlotte_nc_batch.py
  python3 scraper/charlotte_nc_batch.py --dry-run
  python3 scraper/charlotte_nc_batch.py --target 10 --past-days 90
"""

import argparse
import sys
from typing import Optional, Set

from pipeline import PipelineOrchestrator, BatchCriteria

# ---------------------------------------------------------------------------
# Batch constants
# ---------------------------------------------------------------------------
TARGET_LOCATIONS = [
    "Charlotte, NC",
    "Huntersville, NC",
]

FALLBACK_LOCATIONS = [
    "Concord, NC",
    "Cornelius, NC",
    "Mint Hill, NC",
    "Matthews, NC",
    "Pineville, NC",
    "Mooresville, NC",
    "Indian Trail, NC",
    "Stallings, NC",
    "Waxhaw, NC",
    "Kannapolis, NC",
    "Davidson, NC",
    "Harrisburg, NC",
]

# ZIP-level scraping gives 200 results per ZIP vs 200 for the entire city
ZIP_CODES = [
    # Charlotte core
    "28202", "28203", "28204", "28205", "28206", "28207",
    "28208", "28209", "28210", "28211", "28212", "28213",
    "28214", "28215", "28216", "28217",
    # High-demand suburbs
    "28226", "28227", "28262", "28269", "28270", "28273", "28277", "28278",
    # Huntersville
    "28078",
]

ALLOWED_TYPES  = {"SINGLE_FAMILY", "TOWNHOMES"}
BEDS_EXACT     = 2
BATHS_MIN      = 2.0
RENT_MIN       = 1400
RENT_MAX       = 1700
RENT_CAP       = 1700


# ---------------------------------------------------------------------------
# Pricing function
# ---------------------------------------------------------------------------

def compute_charlotte_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """
    No pricing tiers — publish at original advertised rent.
    Validates rent is within [$1,400, $1,700].
    Applies a small uniqueness nudge if two listings land on the same amount.
    """
    if original_rent is None:
        return None, None
    rent = float(original_rent)
    if rent < RENT_MIN or rent > RENT_MAX:
        return None, None

    published = int(round(rent))
    published = max(RENT_MIN, min(published, RENT_CAP))

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
    ap = argparse.ArgumentParser(description="Charlotte, NC rental batch")
    ap.add_argument("--dry-run",   action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target",    type=int, default=10,  help="Number of listings to publish")
    ap.add_argument("--past-days", type=int, default=90)
    ap.add_argument("--limit",     type=int, default=250, help="Max scraped per location")
    ap.add_argument("--min-score", type=int, default=35,  help="Data quality floor")
    args = ap.parse_args()

    criteria = BatchCriteria(
        batch_name="Charlotte, NC",
        locations=TARGET_LOCATIONS,
        zip_codes=ZIP_CODES,
        fallback_locations=FALLBACK_LOCATIONS,
        beds_exact=BEDS_EXACT,
        baths_min=BATHS_MIN,
        rent_min=RENT_MIN,
        rent_max=RENT_MAX,
        rent_floor=RENT_MIN,
        rent_cap=RENT_CAP,
        allowed_types=ALLOWED_TYPES,
        target=args.target,
        past_days=args.past_days,
        limit=args.limit,
        min_score=args.min_score,
        pricing_fn=compute_charlotte_rent,
    )

    orchestrator = PipelineOrchestrator(verbose=True)
    result = orchestrator.run(criteria, dry_run=args.dry_run)

    if result.errors and result.published == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
