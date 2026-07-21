#!/usr/bin/env python3
"""
arlington_tx_batch.py — Arlington / Euless / Grapevine, TX Rental Batch
========================================================================
Target markets  : Arlington, TX · Euless, TX · Grapevine, TX
Property types  : Houses (SINGLE_FAMILY), Townhouses (TOWNHOMES)
                  NO Apartments, Condos, Duplexes
Bedrooms        : 2 exactly
Bathrooms       : 1 or 2 (min 1.0)
Rent range      : $1,300–$1,600 / month (scraped)
Price rule      : tiered proportional reduction; published rent $1,300–$1,400
                  security deposit = published rent when adjusted

Pricing tiers (this batch only):
  $1,300–$1,400  -> publish as-is (original rent)
  $1,401–$1,500  -> proportional reduction -> $1,300–$1,400
  $1,501–$1,600  -> proportional reduction -> $1,300–$1,400

All platform rules (watermark detection, ImageKit upload, enrichment,
fee normalization, duplicate detection, final validation) are enforced
automatically by PipelineOrchestrator — they do not need to be repeated
here. See scraper/pipeline.py and scraper/PLATFORM_RULES.md.

Usage:
  python3 scraper/arlington_tx_batch.py
  python3 scraper/arlington_tx_batch.py --dry-run
  python3 scraper/arlington_tx_batch.py --target 10 --past-days 90
"""

import argparse
import sys
from typing import Optional, Set

from pipeline import PipelineOrchestrator, BatchCriteria

# ---------------------------------------------------------------------------
# Batch constants
# ---------------------------------------------------------------------------
TARGET_LOCATIONS = [
    "Arlington, TX",
    "Euless, TX",
    "Grapevine, TX",
]

FALLBACK_LOCATIONS = [
    "Bedford, TX",
    "Hurst, TX",
    "North Richland Hills, TX",
    "Grand Prairie, TX",
    "Irving, TX",
    "Mansfield, TX",
    "Keller, TX",
    "Fort Worth, TX",
]

# ZIP-level scraping gives 200 results per ZIP vs 200 for the entire city
ZIP_CODES = [
    # Arlington
    "76001", "76002", "76006", "76010", "76011", "76012",
    "76013", "76014", "76015", "76016", "76017", "76018",
    # Euless
    "76039", "76040",
    # Grapevine
    "76051", "76092",
]

ALLOWED_TYPES  = {"SINGLE_FAMILY", "TOWNHOMES"}
BEDS_EXACT     = 2
BATHS_MIN      = 1.0
BATHS_MAX      = 2.0
RENT_MIN       = 1300
RENT_MAX       = 1600
RENT_CAP       = 1400
RENT_FLOOR     = 1300


# ---------------------------------------------------------------------------
# Pricing function (batch-specific)
# ---------------------------------------------------------------------------

def compute_arlington_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """
    Tiered proportional reduction for the Arlington TX market.

    Tiers:
      $1,300–$1,400  -> publish as-is
      $1,401–$1,500  -> proportional -> $1,300–$1,400
      $1,501–$1,600  -> proportional -> $1,300–$1,400

    FIX M5: Tier 2 boundary corrected from 1401 to 1400 to eliminate the
    $100 cliff where a $1 increase in scraped rent caused a $100 drop in
    published rent. Now the transition is smooth and continuous.

    Uses a uniqueness nudge to avoid duplicate published rents.
    Returns (published_rent_int, original_rent_float) or (None, None).
    """
    if original_rent is None:
        return None, None
    rent = float(original_rent)
    if rent < RENT_MIN or rent > RENT_MAX:
        return None, None

    if rent <= 1400:
        published = rent
    elif rent <= 1500:
        # FIX M5: Tier 2 maps $1,400 scraped → $1,400 published (matching tier 1 top),
        # then smoothly descends to $1,300 at $1,500 scraped — zero cliff at the boundary.
        # Old formula mapped $1,401 → $1,300 (a $99 cliff from $1,400 → $1,400).
        ratio     = (rent - 1400) / (1500 - 1400)
        published = 1400 - ratio * (1400 - 1300)   # descends 1400→1300 as rent goes 1400→1500
    else:
        ratio     = (rent - 1500) / (1600 - 1500)
        published = RENT_FLOOR + ratio * (RENT_CAP - RENT_FLOOR)

    published = round(published / 5) * 5
    published = max(RENT_FLOOR, min(int(published), RENT_CAP))

    if seen_rents is not None:
        for nudge in (0, 5, -5, 10, -10, 15, -15, 20, -20):
            candidate = published + nudge
            if RENT_FLOOR <= candidate <= RENT_CAP and candidate not in seen_rents:
                published = candidate
                break

    return int(published), rent


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Arlington / Euless / Grapevine TX batch")
    ap.add_argument("--dry-run",   action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target",    type=int, default=10, help="Number of listings to publish")
    ap.add_argument("--past-days", type=int, default=90)
    ap.add_argument("--limit",     type=int, default=200, help="Max scraped per location")
    ap.add_argument("--min-score", type=int, default=40,  help="Data quality floor")
    args = ap.parse_args()

    criteria = BatchCriteria(
        batch_name="Arlington / Euless / Grapevine, TX",
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
        pricing_fn=compute_arlington_rent,
    )

    orchestrator = PipelineOrchestrator(verbose=True)
    result = orchestrator.run(criteria, dry_run=args.dry_run)

    if result.errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
