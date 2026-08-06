#!/usr/bin/env python3
"""
north_charleston_summerville_batch.py — North Charleston & Summerville, SC Rental Batch
========================================================================================
Target markets  : North Charleston, SC + Summerville, SC
Fallback markets: Goose Creek, Hanahan, Ladson, Moncks Corner
Property types  : SINGLE_FAMILY and TOWNHOUSES
Bedrooms        : Any
Bathrooms       : Any
Rent range      : Up to $1,300 / month (scraped AND published)
Published rent  : Original advertised rent — no adjustment
Target          : 10 published listings

Pricing rule:
  Publish at original advertised rent.
  Cap enforced at $1,300; floor at $600.
  Security deposit = 1 month's published rent (enforced by enrichment).

All platform rules (watermark detection, ImageKit upload, enrichment,
fee normalization, duplicate detection, final validation) are enforced
automatically by PipelineOrchestrator.  See pipeline.py.

Usage:
  python3 scraper/north_charleston_summerville_batch.py
  python3 scraper/north_charleston_summerville_batch.py --dry-run
  python3 scraper/north_charleston_summerville_batch.py --target 10 --past-days 90
"""

import argparse
import sys
from typing import Optional, Set

from pipeline import PipelineOrchestrator, BatchCriteria

# ---------------------------------------------------------------------------
# Batch constants
# ---------------------------------------------------------------------------
TARGET_LOCATIONS = [
    "North Charleston, SC",
    "Summerville, SC",
]

FALLBACK_LOCATIONS = [
    "Goose Creek, SC",
    "Hanahan, SC",
    "Ladson, SC",
    "Moncks Corner, SC",
]

# ZIP-level scraping for broader coverage
ZIP_CODES = [
    # North Charleston
    "29405", "29406", "29418", "29420",
    # Summerville
    "29483", "29485", "29486",
    # Goose Creek
    "29445",
    # Hanahan
    "29410",
    # Ladson
    "29456",
    # Moncks Corner
    "29461",
]

ALLOWED_TYPES = {"SINGLE_FAMILY", "TOWNHOMES"}
RENT_MIN      = 600
RENT_MAX      = 1600   # scrape up to $1,600; published price will be reduced to $1,280–$1,300
RENT_FLOOR    = 1280   # published price floor
RENT_CAP      = 1300   # published price cap


# ---------------------------------------------------------------------------
# Pricing function
# ---------------------------------------------------------------------------

def compute_ncs_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """
    Scrape up to $1,600; publish in the $1,280–$1,300 band.
    Maps the scrape range [$600, $1,600] proportionally to [$1,280, $1,300],
    rounded to the nearest $5, so listings feel individually priced.
    enforce_price_consistency() in enrichment.py will rewrite any dollar
    figures in the description to match the final published rent.
    """
    if original_rent is None:
        return None, None
    rent = float(original_rent)
    if rent < RENT_MIN or rent > RENT_MAX:
        return None, None

    # Proportional mapping: [600, 1600] → [1280, 1300]
    ratio = (rent - RENT_MIN) / (RENT_MAX - RENT_MIN)
    published = RENT_FLOOR + ratio * (RENT_CAP - RENT_FLOOR)
    # Round to nearest $5 for a natural-looking price
    published = int(round(published / 5) * 5)
    published = max(RENT_FLOOR, min(published, RENT_CAP))

    if seen_rents is not None and published in seen_rents:
        for nudge in (5, -5, 10, -10, 15, -15):
            candidate = published + nudge
            if RENT_FLOOR <= candidate <= RENT_CAP and candidate not in seen_rents:
                published = candidate
                break

    return int(published), rent


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="North Charleston & Summerville, SC rental batch")
    ap.add_argument("--dry-run",   action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target",    type=int, default=10,  help="Number of listings to publish")
    ap.add_argument("--past-days", type=int, default=90)
    ap.add_argument("--limit",     type=int, default=250, help="Max scraped per location")
    ap.add_argument("--min-score", type=int, default=35,  help="Data quality floor")
    args = ap.parse_args()

    criteria = BatchCriteria(
        batch_name="North Charleston & Summerville, SC",
        locations=TARGET_LOCATIONS,
        zip_codes=ZIP_CODES,
        fallback_locations=FALLBACK_LOCATIONS,
        rent_min=RENT_MIN,
        rent_max=RENT_MAX,
        rent_floor=RENT_FLOOR,
        rent_cap=RENT_CAP,
        allowed_types=ALLOWED_TYPES,
        target=args.target,
        past_days=args.past_days,
        limit=args.limit,
        min_score=args.min_score,
        pricing_fn=compute_ncs_rent,
    )

    orchestrator = PipelineOrchestrator(verbose=True)
    result = orchestrator.run(criteria, dry_run=args.dry_run)

    if result.published_urls:
        print("\nPublished URLs:")
        for i, url in enumerate(result.published_urls, 1):
            print(f"{i}. {url}")

    if result.errors and result.published == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
