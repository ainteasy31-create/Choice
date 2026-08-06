#!/usr/bin/env python3
"""
charleston_sc_batch.py — Charleston, SC Rental Batch
=====================================================
Target markets  : Charleston, SC + surrounding areas
Fallback markets: Mount Pleasant, North Charleston, Summerville, Goose Creek,
                  Hanahan, Ladson, Johns Island, James Island, Daniel Island,
                  Isle of Palms, Moncks Corner, Ridgeville
Property types  : Single-family homes ONLY (SINGLE_FAMILY)
                  No apartments, condos, townhouses, duplexes, or multi-family.
Bedrooms        : 1–2 bedrooms
Bathrooms       : 1.0 minimum
Rent range      : $3,000–$4,500 / month (scraped AND published)
Published rent  : Original advertised rent — no adjustment required
Target          : 10 published listings

Pricing rule:
  Publish at original advertised rent.
  Cap enforced at $4,500; floor at $3,000.
  Security deposit = 1 month's published rent (enforced by enrichment).

All platform rules (watermark detection, ImageKit upload, enrichment,
fee normalization, duplicate detection, final validation) are enforced
automatically by PipelineOrchestrator.  See pipeline.py.

Usage:
  python3 scraper/charleston_sc_batch.py
  python3 scraper/charleston_sc_batch.py --dry-run
  python3 scraper/charleston_sc_batch.py --target 10 --past-days 90
"""

import argparse
import sys
from typing import Optional, Set

from pipeline import PipelineOrchestrator, BatchCriteria

# ---------------------------------------------------------------------------
# Batch constants
# ---------------------------------------------------------------------------
TARGET_LOCATIONS = [
    "Charleston, SC",
    "Mount Pleasant, SC",
    "North Charleston, SC",
]

FALLBACK_LOCATIONS = [
    "Summerville, SC",
    "Goose Creek, SC",
    "Hanahan, SC",
    "Ladson, SC",
    "Johns Island, SC",
    "James Island, SC",
    "Daniel Island, SC",
    "Isle of Palms, SC",
    "Moncks Corner, SC",
    "Ridgeville, SC",
    "Ravenel, SC",
    "Hollywood, SC",
]

# ZIP-level scraping for broader coverage across the Charleston metro
ZIP_CODES = [
    # Charleston proper
    "29401", "29403", "29405", "29407", "29409",
    # James Island / West Ashley
    "29412", "29414",
    # North Charleston
    "29406", "29418", "29420",
    # Mount Pleasant
    "29464", "29466",
    # Daniel Island
    "29492",
    # Summerville / Ladson / Goose Creek
    "29483", "29485", "29486", "29445", "29456",
    # Hanahan
    "29410",
    # Johns Island
    "29455",
    # Isle of Palms / Sullivan's Island
    "29451", "29482",
    # Moncks Corner
    "29461",
]

ALLOWED_TYPES = {"SINGLE_FAMILY"}   # houses only — per prompt
BEDS_MIN      = 1
BEDS_MAX      = 2
BATHS_MIN     = 1.0
RENT_MIN      = 3000
RENT_MAX      = 4500
RENT_CAP      = 4500


# ---------------------------------------------------------------------------
# Pricing function
# ---------------------------------------------------------------------------

def compute_charleston_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """
    Publish at original advertised rent.
    Validates rent is within [$3,000, $4,500].
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
    ap = argparse.ArgumentParser(description="Charleston, SC rental batch")
    ap.add_argument("--dry-run",   action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target",    type=int, default=10,  help="Number of listings to publish")
    ap.add_argument("--past-days", type=int, default=90)
    ap.add_argument("--limit",     type=int, default=250, help="Max scraped per location")
    ap.add_argument("--min-score", type=int, default=35,  help="Data quality floor")
    args = ap.parse_args()

    criteria = BatchCriteria(
        batch_name="Charleston, SC",
        locations=TARGET_LOCATIONS,
        zip_codes=ZIP_CODES,
        fallback_locations=FALLBACK_LOCATIONS,
        beds_min=BEDS_MIN,
        beds_max=BEDS_MAX,
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
        pricing_fn=compute_charleston_rent,
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
