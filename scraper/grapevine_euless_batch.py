#!/usr/bin/env python3
"""
grapevine_euless_batch.py — Grapevine / Euless, TX Rental Batch
================================================================
Target markets  : Grapevine, TX · Euless, TX
Property types  : Apartments (APARTMENT), Townhouses (TOWNHOMES)
                  NO single-family homes, duplexes, condos, rooms for rent
Bedrooms        : 1 or 2
Bathrooms       : 1+ (min 1.0)
Rent range      : $1,400–$1,800 / month (scraped and published as-is)
Pricing rule    : Publish at original advertised rent — no reduction applied.
                  Maximum published rent: $1,800/month.

Location priority: Near Highway 360, Highway 121, Highway 114
Amenity priority : In-unit W/D, garage/covered parking, community amenities,
                   modern interiors, updated kitchens, hardwood-style floors

Platform rules (applied automatically by the pipeline):
  - Watermark detection + rejection (text and visual)
  - ImageKit-only image hosting (min 6 photos per listing)
  - Description cleaned — no competitor branding or agent language
  - Application fee normalized to $50
  - No tour/showing/contact/agent language
  - No third-party branding
  - No restrictive applicant screening language
  - Pets allowed (platform default)
  - Duplicate detection (address + source_id)
  - Pre-publish validation gate

See scraper/pipeline.py and scraper/PLATFORM_RULES.md for full rule set.

Usage:
  python3 scraper/grapevine_euless_batch.py
  python3 scraper/grapevine_euless_batch.py --dry-run
  python3 scraper/grapevine_euless_batch.py --target 10 --past-days 90
  python3 scraper/grapevine_euless_batch.py --target 5 --beds 1
  python3 scraper/grapevine_euless_batch.py --target 5 --beds 2
"""

import argparse
import sys
from typing import Optional, Set

from pipeline import PipelineOrchestrator, BatchCriteria

# ---------------------------------------------------------------------------
# Batch constants
# ---------------------------------------------------------------------------
TARGET_LOCATIONS = [
    "Grapevine, TX",
    "Euless, TX",
]

# Mid-Cities fallbacks if primary cities don't reach target count
FALLBACK_LOCATIONS = [
    "Hurst, TX",
    "Bedford, TX",
    "Colleyville, TX",
    "Southlake, TX",
    "Irving, TX",
    "Coppell, TX",
    "Grand Prairie, TX",
    "Carrollton, TX",
    "Lewisville, TX",
    "Flower Mound, TX",
    "North Richland Hills, TX",
    "Mansfield, TX",
    "Keller, TX",
]

# ZIP-level scraping gives 200 results per ZIP vs 200 for the entire city
ZIP_CODES = [
    "76051", "76092", "76099",  # Grapevine
    "76039", "76040",            # Euless
]

# Apartments and townhomes only — per the brief
ALLOWED_TYPES = {"APARTMENT", "TOWNHOMES"}

BATHS_MIN  = 1.0
RENT_MIN   = 1400
RENT_MAX   = 1800   # hard ceiling per brief


# ---------------------------------------------------------------------------
# Pricing function — publish as-is, hard cap at $1,800
# ---------------------------------------------------------------------------

def compute_grapevine_euless_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """
    Publish at the original advertised rent with no adjustment.

    Rules (per brief):
      - Accept $1,400–$1,800 only.
      - Never publish above $1,800.
      - No downward price manipulation for this market.

    Returns (published_rent_int, original_rent_float) or (None, None) to reject.
    """
    if original_rent is None:
        return None, None
    rent = float(original_rent)
    if rent < RENT_MIN or rent > RENT_MAX:
        return None, None
    published = int(round(rent))
    return published, rent


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Grapevine / Euless TX apartment & townhome batch"
    )
    ap.add_argument("--dry-run",   action="store_true",
                    help="Preview — stop before any database writes")
    ap.add_argument("--target",    type=int, default=10,
                    help="Number of listings to publish (default: 10)")
    ap.add_argument("--past-days", type=int, default=90,
                    help="How far back to scrape (default: 90)")
    ap.add_argument("--limit",     type=int, default=200,
                    help="Max scraped per location (default: 200)")
    ap.add_argument("--min-score", type=int, default=40,
                    help="Data quality floor (default: 40)")
    ap.add_argument("--beds",      type=int, default=None, choices=[1, 2],
                    help="Restrict to exactly 1 or 2 bedrooms (default: both)")
    args = ap.parse_args()

    # Bed filter: default is 1–2; --beds locks to exactly that count
    if args.beds is not None:
        beds_exact = args.beds
        beds_min = beds_max = None
    else:
        beds_exact = None
        beds_min   = 1
        beds_max   = 2

    criteria = BatchCriteria(
        batch_name="Grapevine / Euless, TX",
        locations=TARGET_LOCATIONS,
        zip_codes=ZIP_CODES,
        fallback_locations=FALLBACK_LOCATIONS,
        beds_exact=beds_exact,
        beds_min=beds_min,
        beds_max=beds_max,
        baths_min=BATHS_MIN,
        rent_min=RENT_MIN,
        rent_max=RENT_MAX,
        # rent_floor / rent_cap left as None — no price reduction applied;
        # pricing_fn enforces the $1,800 cap and rejects out-of-range listings.
        allowed_types=ALLOWED_TYPES,
        target=args.target,
        past_days=args.past_days,
        limit=args.limit,
        min_score=args.min_score,
        pricing_fn=compute_grapevine_euless_rent,
    )

    orchestrator = PipelineOrchestrator(verbose=True)
    result = orchestrator.run(criteria, dry_run=args.dry_run)

    if result.errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
