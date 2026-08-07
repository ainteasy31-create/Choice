#!/usr/bin/env python3
"""
cjproperties_batch.py — CJ Properties (cjproperties.org) Rental Batch
=====================================================================
Scrapes rental listings from cjproperties.org (a WordPress + Rent Manager
powered property management site) and runs them through the full Choice
Properties pipeline.

The site serves listings via Rent Manager's JavaScript API. This batch
script:
  1. Scrapes all available listings from cjproperties.org
  2. Filters by state / rent / beds / type criteria
  3. Feeds the records into PipelineOrchestrator.run_records()
  4. All platform rules (watermark, ImageKit, enrichment, validation,
     dedup, publish, activate, photos) are enforced automatically.

Usage:
  python3 scraper/cjproperties_batch.py
  python3 scraper/cjproperties_batch.py --dry-run
  python3 scraper/cjproperties_batch.py --target 10 --states MO,KS
  python3 scraper/cjproperties_batch.py --min-score 40 --rent-min 1000 --rent-max 2000
"""

import argparse
import json
import os
import sys
from typing import List, Optional, Set

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

# Load .env from scraper/ or repo root
for candidate in [os.path.join(_SCRIPT_DIR, ".env"), os.path.join(_SCRIPT_DIR, "../.env"), ".env"]:
    if os.path.isfile(candidate):
        with open(candidate) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                if k and k not in os.environ:
                    os.environ[k] = v.strip().strip('"').strip("'")
        break

from cjproperties_scraper import scrape_cjproperties, list_states, estimate_rent_range
from pipeline import PipelineOrchestrator

# ---------------------------------------------------------------------------
# Batch constants
# ---------------------------------------------------------------------------
DEFAULT_STATES = ["MO", "KS"]   # Missouri + Kansas primary markets
DEFAULT_TARGET = 10
DEFAULT_MIN_SCORE = 40
DEFAULT_RENT_MIN = 800
DEFAULT_RENT_MAX = 3500

# Property types to include (exclude commercial)
ALLOWED_TYPES = {"SINGLE_FAMILY", "TOWNHOMES", "CONDOS", "APARTMENT", "DUPLEX"}


# ---------------------------------------------------------------------------
# Filtering helpers
# ---------------------------------------------------------------------------

def _filter_records(
    records: List[dict],
    states: Optional[List[str]] = None,
    rent_min: int = DEFAULT_RENT_MIN,
    rent_max: int = DEFAULT_RENT_MAX,
    beds_min: Optional[int] = None,
    beds_max: Optional[int] = None,
    allowed_types: Optional[Set[str]] = None,
    min_score: int = DEFAULT_MIN_SCORE,
) -> List[dict]:
    """Filter scraped records by criteria before feeding to the pipeline."""
    filtered = []
    for rec in records:
        # State filter
        if states and rec.get("state") not in states:
            continue

        # Rent filter
        rent = rec.get("monthly_rent")
        if rent is None or rent < rent_min or rent > rent_max:
            continue

        # Beds filter
        beds = rec.get("bedrooms")
        if beds_min is not None and (beds is None or beds < beds_min):
            continue
        if beds_max is not None and beds is not None and beds > beds_max:
            continue

        # Property type filter
        ptype = rec.get("property_type")
        if allowed_types and ptype and ptype not in allowed_types:
            continue

        # Quality floor
        if rec.get("data_quality_score", 0) < min_score:
            continue

        filtered.append(rec)

    return filtered


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="CJ Properties (cjproperties.org) batch")
    ap.add_argument("--dry-run", action="store_true", help="Stop before any DB writes")
    ap.add_argument("--target", type=int, default=DEFAULT_TARGET, help="Number of listings to publish")
    ap.add_argument("--states", help="Comma-separated state codes e.g. MO,KS,FL (default: MO,KS)")
    ap.add_argument("--rent-min", type=int, default=DEFAULT_RENT_MIN, help="Minimum monthly rent")
    ap.add_argument("--rent-max", type=int, default=DEFAULT_RENT_MAX, help="Maximum monthly rent")
    ap.add_argument("--beds-min", type=int, default=None, help="Minimum bedrooms")
    ap.add_argument("--beds-max", type=int, default=None, help="Maximum bedrooms")
    ap.add_argument("--min-score", type=int, default=DEFAULT_MIN_SCORE, help="Data quality floor")
    ap.add_argument("--verbose", action="store_true", help="Verbose scraper output")
    args = ap.parse_args()

    states = [s.strip().upper() for s in args.states.split(",")] if args.states else DEFAULT_STATES

    print("=" * 65)
    print("Choice Properties — CJ Properties (cjproperties.org) Batch")
    print("=" * 65)
    print("States: {}".format(", ".join(states)))
    print("Target: {} | Rent: ${}-${} | Min score: {}".format(
        args.target, args.rent_min, args.rent_max, args.min_score))
    print("Dry run: {}".format(args.dry_run))
    print()

    # ── Step 1: Scrape ───────────────────────────────────────────────────
    print("── Step 1: Scraping cjproperties.org ──")
    records = scrape_cjproperties(states=states, verbose=args.verbose)
    print("   Scraped {} total records".format(len(records)))

    if not records:
        print("ERROR: No listings scraped from cjproperties.org")
        sys.exit(1)

    # Show market overview
    states_found = list_states(records)
    rent_min, rent_max = estimate_rent_range(records)
    print("   States found: {}".format(", ".join(states_found) if states_found else "N/A"))
    print("   Rent range: ${} – ${}".format(rent_min, rent_max))

    # ── Step 2: Filter ───────────────────────────────────────────────────
    print("\n── Step 2: Filtering by criteria ──")
    filtered = _filter_records(
        records,
        states=states,
        rent_min=args.rent_min,
        rent_max=args.rent_max,
        beds_min=args.beds_min,
        beds_max=args.beds_max,
        allowed_types=ALLOWED_TYPES,
        min_score=args.min_score,
    )
    print("   Kept {} / {} records after filtering".format(len(filtered), len(records)))

    if not filtered:
        print("ERROR: No records passed filtering criteria. Try broader criteria.")
        sys.exit(1)

    # Show top candidates
    filtered.sort(key=lambda r: -r.get("data_quality_score", 0))
    print("\n   Top candidates:")
    for i, rec in enumerate(filtered[: min(10, len(filtered))], 1):
        addr = "{}, {}".format(rec.get("address", "?"), rec.get("city", "?")).strip()
        print("   {:2}. {} | ${}/mo | {} bed | score={} | {} photos".format(
            i,
            addr,
            rec.get("monthly_rent"),
            rec.get("bedrooms"),
            rec.get("data_quality_score"),
            len(json.loads(rec.get("original_image_urls") or "[]")),
        ))

    # ── Step 3: Run pipeline ─────────────────────────────────────────────
    print("\n── Step 3: Running pipeline ──")
    orchestrator = PipelineOrchestrator(verbose=True)
    result = orchestrator.run_records(
        records=filtered,
        batch_name="CJ Properties {} batch".format(",".join(states)),
        dry_run=args.dry_run,
    )

    print("\n" + result.summary())

    if result.errors and not args.dry_run:
        sys.exit(1)


if __name__ == "__main__":
    main()