#!/usr/bin/env python3
"""
dallas_ga_batch.py — Dallas, GA Rental Batch
============================================
Target markets  : Dallas, GA · Hiram, GA · Powder Springs, GA · Acworth, GA
                  + West Cobb / GA-61 corridor / I-75 nearby communities
Property types  : Houses (SINGLE_FAMILY), Townhouses (TOWNHOMES)
                  NO Apartments, Condos, Duplexes
Bedrooms        : 3 exactly
Bathrooms       : 2+
Rent range      : $1,500–$2,000 / month (scraped)
Price rule      : tiered proportional reduction; published rent <= $1,500
                  security deposit = published rent

Pricing tiers (this batch only):
  $1,500–$1,599  -> proportional -> $1,350–$1,400
  $1,600–$1,699  -> proportional -> $1,375–$1,425
  $1,700–$1,799  -> proportional -> $1,400–$1,450
  $1,800–$1,899  -> proportional -> $1,425–$1,475
  $1,900–$2,000  -> proportional -> $1,450–$1,500 (cap $1,500)

All platform rules enforced automatically by PipelineOrchestrator.
See scraper/pipeline.py and scraper/PLATFORM_RULES.md.

Usage:
  python3 scraper/dallas_ga_batch.py
  python3 scraper/dallas_ga_batch.py --dry-run
  python3 scraper/dallas_ga_batch.py --target 15 --past-days 90
"""

import argparse
import sys
from typing import Optional, Set

from pipeline import PipelineOrchestrator, BatchCriteria

# ---------------------------------------------------------------------------
# Batch constants
# ---------------------------------------------------------------------------
TARGET_LOCATIONS = [
    "Dallas, GA",
    "Hiram, GA",
    "Powder Springs, GA",
    "Acworth, GA",
]
FALLBACK_LOCATIONS = [
    "Kennesaw, GA",
    "Marietta, GA",
    "Austell, GA",
    "Smyrna, GA",
    "Villa Rica, GA",
]

# ZIP-level scraping gives 200 results per ZIP vs 200 for the entire city
ZIP_CODES = [
    "30132",  # Dallas, GA
    "30141",  # Hiram, GA
    "30127",  # Powder Springs, GA
    "30101",  # Acworth, GA (west)
    "30102",  # Acworth, GA (east)
    "30157",  # Dallas area extension
    "30064",  # Marietta (Cobb County western corridor)
    "30106",  # Austell, GA
]

ALLOWED_TYPES = {"SINGLE_FAMILY", "TOWNHOMES"}
BEDS_EXACT    = 3
BATHS_MIN     = 2.0
RENT_MIN      = 1500
RENT_MAX      = 2000
RENT_CAP      = 1500
RENT_FLOOR    = 1350


# ---------------------------------------------------------------------------
# Pricing function (batch-specific)
# ---------------------------------------------------------------------------

def compute_dallas_ga_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """
    Tiered proportional reduction for the Dallas GA market.

    Five tiers each map a $100 scraped band to a $50 published band,
    all within $1,350–$1,500.
    Returns (published_rent_int, original_rent_float) or (None, None).
    """
    if original_rent is None:
        return None, None
    rent = float(original_rent)
    if rent < RENT_MIN or rent > RENT_MAX:
        return None, None

    # Map each $100 band proportionally to its $50 output band
    tiers = [
        (1500, 1599, 1350, 1400),
        (1600, 1699, 1375, 1425),
        (1700, 1799, 1400, 1450),
        (1800, 1899, 1425, 1475),
        (1900, 2000, 1450, 1500),
    ]

    published = None
    for src_lo, src_hi, dst_lo, dst_hi in tiers:
        if src_lo <= rent <= src_hi:
            ratio = (rent - src_lo) / (src_hi - src_lo) if src_hi != src_lo else 0
            published = dst_lo + ratio * (dst_hi - dst_lo)
            break

    if published is None:
        return None, None

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
    ap = argparse.ArgumentParser(description="Dallas GA rental batch")
    ap.add_argument("--dry-run",   action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target",    type=int, default=15, help="Number of listings to publish")
    ap.add_argument("--past-days", type=int, default=90)
    ap.add_argument("--limit",     type=int, default=200)
    ap.add_argument("--min-score", type=int, default=40)
    args = ap.parse_args()

    criteria = BatchCriteria(
        batch_name="Dallas / Hiram / Powder Springs / Acworth, GA",
        locations=TARGET_LOCATIONS,
        zip_codes=ZIP_CODES,
        fallback_locations=FALLBACK_LOCATIONS,
        beds_exact=BEDS_EXACT,
        baths_min=BATHS_MIN,
        rent_min=RENT_MIN,
        rent_max=RENT_MAX,
        rent_floor=RENT_FLOOR,
        rent_cap=RENT_CAP,
        allowed_types=ALLOWED_TYPES,
        target=args.target,
        past_days=args.past_days,
        limit=args.limit,
        min_score=args.min_score,
        pricing_fn=compute_dallas_ga_rent,
    )

    orchestrator = PipelineOrchestrator(verbose=True)
    result = orchestrator.run(criteria, dry_run=args.dry_run)

    if result.errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
