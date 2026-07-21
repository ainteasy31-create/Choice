#!/usr/bin/env python3
"""
okc_batch.py — Oklahoma City Area Rental Batch
===============================================
Target markets  : Oklahoma City, OK  |  Moore, OK  |  Midwest City, OK
Fallback markets: Edmond, Yukon, Mustang, Norman, Del City, Choctaw,
                  Bethany, Warr Acres, Nicholls Hills, Harrah
Property types  : Single-family homes ONLY (SINGLE_FAMILY)
                  No apartments, townhomes, condos, duplexes, or multi-family.
Bedrooms        : 3 exactly
Bathrooms       : 2.0 minimum
Rent range      : $1,300–$1,650 / month (scraped AND published)
Published rent  : Original advertised rent — no adjustment required
Target          : 10 published listings

Pricing rule:
  Publish at original advertised rent; no tiers needed.
  Cap enforced at $1,650; floor at $1,300.

Watermark policy (zero-tolerance):
  The pipeline enforces this automatically via text/metadata check
  (_step3_filter via is_watermarked()). Any competitor-branded listing is
  dropped before staging; if clean photos fall below MIN_PHOTOS the listing
  is skipped entirely.

All platform rules (watermark detection, ImageKit upload, enrichment,
fee normalization, duplicate detection, final validation)
are enforced automatically by PipelineOrchestrator.  See pipeline.py.

Usage:
  python3 scraper/okc_batch.py
  python3 scraper/okc_batch.py --dry-run
  python3 scraper/okc_batch.py --target 10 --past-days 90
"""

import argparse
import sys
from typing import Optional, Set

from pipeline import PipelineOrchestrator, BatchCriteria

# ---------------------------------------------------------------------------
# Batch constants
# ---------------------------------------------------------------------------
TARGET_LOCATIONS = [
    "Oklahoma City, OK",
    "Moore, OK",
    "Midwest City, OK",
]

FALLBACK_LOCATIONS = [
    "Edmond, OK",
    "Yukon, OK",
    "Mustang, OK",
    "Norman, OK",
    "Del City, OK",
    "Choctaw, OK",
    "Bethany, OK",
    "Warr Acres, OK",
    "Nichols Hills, OK",
    "Harrah, OK",
    "Tuttle, OK",
    "Blanchard, OK",
]

# ZIP-level scraping gives 200 results per ZIP vs 200 for the entire city
ZIP_CODES = [
    # Oklahoma City core
    "73103", "73104", "73105", "73106", "73107", "73108",
    "73109", "73111", "73112", "73114", "73115", "73116",
    "73117", "73118", "73119", "73120", "73127", "73128",
    "73129", "73131", "73132", "73134", "73135", "73139",
    "73141", "73142", "73145", "73149", "73151", "73159",
    "73162", "73165", "73169", "73170", "73173", "73179",
    # Moore
    "73160",
    # Midwest City
    "73110", "73130",
]

ALLOWED_TYPES  = {"SINGLE_FAMILY"}   # single-family homes only
BEDS_EXACT     = 3
BATHS_MIN      = 2.0
RENT_MIN       = 1300
RENT_MAX       = 1650                # scrape cap == publish cap
RENT_CAP       = 1650                # never publish above this


# ---------------------------------------------------------------------------
# Pricing function
# ---------------------------------------------------------------------------

def compute_okc_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """
    No pricing tiers for this batch — publish at original advertised rent.

    Validates rent is within [$1,300, $1,650].
    Applies a small uniqueness nudge if two listings land on the same dollar
    amount, keeping every published price within the allowed band.

    Returns (published_rent_int, original_rent_float) or (None, None) to skip.
    """
    if original_rent is None:
        return None, None
    rent = float(original_rent)
    if rent < RENT_MIN or rent > RENT_MAX:
        return None, None

    published = int(round(rent))
    published = max(RENT_MIN, min(published, RENT_CAP))

    # Uniqueness nudge — prefer $5 increments to keep prices natural-looking
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
    ap = argparse.ArgumentParser(description="Oklahoma City area rental batch")
    ap.add_argument("--dry-run",   action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target",    type=int, default=10,  help="Number of listings to publish")
    ap.add_argument("--past-days", type=int, default=90)
    ap.add_argument("--limit",     type=int, default=250, help="Max scraped per location")
    ap.add_argument("--min-score", type=int, default=35,  help="Data quality floor")
    args = ap.parse_args()

    criteria = BatchCriteria(
        batch_name="Oklahoma City, OK",
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
        pricing_fn=compute_okc_rent,
    )

    orchestrator = PipelineOrchestrator(verbose=True)
    result = orchestrator.run(criteria, dry_run=args.dry_run)

    if result.errors and result.published == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
