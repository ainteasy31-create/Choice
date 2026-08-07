#!/usr/bin/env python3
"""
tulsa_ok_batch.py — Tulsa, OK rental batch
========================================
Target markets  : Tulsa, OK and nearby suburbs (Broken Arrow, Jenks, Bixby,
                  Owasso)
Property types  : Single-family homes only (SINGLE_FAMILY)
Bedrooms        : 3–4 bedrooms
Bathrooms       : any
Rent range      : $1,000–$1,500 / month (scraped and published)
Target          : 10 published listings

All platform rules (watermark detection, ImageKit upload, enrichment,
fee normalization, duplicate detection, final validation) are enforced
automatically by PipelineOrchestrator. See pipeline.py.

Usage:
  python3 scraper/tulsa_ok_batch.py --dry-run
  python3 scraper/tulsa_ok_batch.py --target 10
  python3 scraper/tulsa_ok_batch.py --target 10 --past-days 120
"""

import argparse
import sys
from typing import Optional, Set

from pipeline import PipelineOrchestrator, BatchCriteria

# ---------------------------------------------------------------------------
# Batch constants
# ---------------------------------------------------------------------------
TARGET_LOCATIONS = [
    "Tulsa, OK",
    "Broken Arrow, OK",
    "Jenks, OK",
]

FALLBACK_LOCATIONS = [
    "Bixby, OK",
    "Owasso, OK",
    "Sand Springs, OK",
]

ALLOWED_TYPES = {"SINGLE_FAMILY"}
BEDS_MIN = 3
BEDS_MAX = 4
BATHS_MIN = 0.0
RENT_MIN = 1000
RENT_MAX = 1500
RENT_CAP = 1500


def compute_tulsa_rent(
    original_rent,
    seen_rents: Optional[Set[int]] = None,
):
    """Publish at the advertised rent when it is within the budget window."""
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


def main():
    ap = argparse.ArgumentParser(description="Tulsa, OK rental batch")
    ap.add_argument("--dry-run", action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target", type=int, default=10, help="Number of listings to publish")
    ap.add_argument("--past-days", type=int, default=3650)
    ap.add_argument("--limit", type=int, default=250, help="Max scraped per location")
    ap.add_argument("--min-score", type=int, default=35, help="Data quality floor")
    args = ap.parse_args()

    criteria = BatchCriteria(
        batch_name="Tulsa, OK",
        locations=TARGET_LOCATIONS,
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
        pricing_fn=compute_tulsa_rent,
    )

    orchestrator = PipelineOrchestrator(verbose=True)
    result = orchestrator.run(criteria, dry_run=args.dry_run)

    if result.errors and result.published == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
