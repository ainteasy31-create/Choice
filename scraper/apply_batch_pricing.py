#!/usr/bin/env python3
"""
Choice Properties -- TEMPORARY batch pricing adjustment
=========================================================
One-off pricing/deposit rules for a single scrape batch. This script is NOT
part of the permanent enrichment pipeline (see enrichment.py) -- it is a
standalone pass you run manually against a set of staged pipeline records
when a specific batch calls for a temporary rent cap.

Rules applied (per the batch instructions):
  * Only touches listings with an ORIGINAL rent between --rent-min and
    --rent-max (default $1,600-$2,000).
  * If original rent <= --cap ($1,800): publish at the original rent
    (no change).
  * If original rent is between --cap ($1,800) and $1,900: reduce the
    published rent by --reduction ($150).
  * Special case: if original rent is exactly $2,000, reduce by --reduction
    ($150) and publish as $1,850.
  * Never publish above --cap after reduction. Any listing that would still
    be above --cap after the reduction is skipped (flagged for manual review)
    rather than silently published over the cap.
  * If the rent was adjusted, the security deposit is set to match the new
    published rent.

This does not scrape or touch the description -- run the normal enrichment
pipeline first (it already keeps descriptions in sync with monthly_rent via
enforce_price_consistency), then run this script to adjust price/deposit,
then re-run enrichment's price-consistency step or let the pipeline UI
re-render before publishing.

Usage:
  # Preview against already-staged pipeline records for one batch/location:
  python3 scraper/apply_batch_pricing.py --location "Dallas, TX" --dry-run

  # Apply for real:
  python3 scraper/apply_batch_pricing.py --location "Dallas, TX"

  # Custom thresholds:
  python3 scraper/apply_batch_pricing.py --location "Dallas, TX" \\
      --rent-min 1600 --rent-max 2000 --cap 1800 --reduction 150

Environment variables (.env auto-loaded, same as scraper.py):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
"""

import argparse
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scraper import _load_dotenv  # noqa: E402  (reuse existing .env loader)

_load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://tlfmwetmhthpyrytrcfo.supabase.co").rstrip("/")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

HEADERS = {
    "apikey": SERVICE_ROLE_KEY,
    "Authorization": "Bearer " + SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
    "Accept-Profile": "pipeline",
    "Content-Profile": "pipeline",
}


def compute_adjusted_rent(original_rent, rent_min, rent_max, cap, reduction,
                          reduce_max=1900):
    """
    Returns (published_rent, adjusted) or (None, None) if the listing is out
    of scope / must be skipped.

    Parameters
    ----------
    original_rent : float
    rent_min      : float  lower bound of scrape range (default 1600)
    rent_max      : float  upper bound of scrape range (default 2000)
    cap           : float  publish-at-most ceiling for generic reductions (default 1800)
    reduction     : float  amount to subtract when original_rent > cap (default 150)
    reduce_max    : float  highest rent eligible for generic auto-reduction (default 1900)
                           Rents between reduce_max+1 and rent_max-1 are SKIPPED unless
                           they match the explicit rent_max exception below.

    Rules (evaluated in this order):
      1. rent < rent_min or rent > rent_max -> out of scope (None, None)
      2. rent <= cap                        -> publish as-is
      3. rent == rent_max (exactly $2,000)  -> named exception: reduce by
                                               reduction and publish ($1,850)
                                               even though result exceeds cap.
      4. cap < rent <= reduce_max           -> reduce by reduction; skip if
                                               result still > cap
      5. reduce_max < rent < rent_max       -> skip (not covered by any rule)

    Why rule 3 before rule 4:
      The batch instructions explicitly name $2,000 as a special case: "if
      the original rent is exactly $2,000, reduce it by $150 and publish it
      as $1,850."  $1,850 > cap ($1,800), so without this explicit carve-out
      the generic skip path would incorrectly reject it.
    """
    if original_rent is None:
        return None, None
    if original_rent < rent_min or original_rent > rent_max:
        return None, None  # out of scope for this batch

    # Rule 2: at or below cap — publish unchanged.
    if original_rent <= cap:
        return original_rent, False

    # Rule 3: explicit named exception for exactly rent_max ($2,000).
    if original_rent == rent_max:
        return original_rent - reduction, True

    # Rule 4: auto-reduce band (cap < rent <= reduce_max, e.g. $1,801–$1,900).
    if original_rent <= reduce_max:
        adjusted = original_rent - reduction
        if adjusted > cap:
            # Reduction insufficient — skip rather than publish above cap.
            return None, None
        return adjusted, True

    # Rule 5: gap between reduce_max and rent_max ($1,901–$1,999) — skip.
    return None, None


def fetch_pipeline_records(location, status="scraped"):
    params = {
        "select": "id,address,city,state,monthly_rent,security_deposit,source_listing_id",
        "status": "eq." + status,
    }
    if location:
        city = location.split(",")[0].strip()
        params["city"] = "eq." + city
    resp = requests.get(
        SUPABASE_URL + "/rest/v1/pipeline_properties",
        headers=HEADERS,
        params=params,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def update_record(record_id, published_rent, deposit):
    resp = requests.patch(
        SUPABASE_URL + "/rest/v1/pipeline_properties",
        headers=HEADERS,
        params={"id": "eq." + str(record_id)},
        json={"monthly_rent": published_rent, "security_deposit": deposit},
        timeout=30,
    )
    resp.raise_for_status()


def main():
    ap = argparse.ArgumentParser(description="TEMPORARY batch pricing adjustment (not a permanent rule).")
    ap.add_argument("--location", help="City/state to filter staged pipeline records (e.g. 'Dallas, TX')")
    ap.add_argument("--status", default="scraped", help="Pipeline status to filter on (default: scraped)")
    ap.add_argument("--rent-min",   type=float, default=1600)
    ap.add_argument("--rent-max",   type=float, default=2000)
    ap.add_argument("--cap",        type=float, default=1800)
    ap.add_argument("--reduction",  type=float, default=150)
    ap.add_argument("--reduce-max", type=float, default=1900,
                    help="Upper bound for generic auto-reduction (default 1900). "
                         "Rents above this and below rent-max are skipped unless "
                         "they equal rent-max (the explicit named exception).")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not SERVICE_ROLE_KEY:
        print("SUPABASE_SERVICE_ROLE_KEY is not set.")
        sys.exit(1)

    records = fetch_pipeline_records(args.location, args.status)
    print("Fetched " + str(len(records)) + " staged record(s)" + (" for " + args.location if args.location else ""))

    applied, skipped, out_of_scope = 0, 0, 0

    for rec in records:
        original_rent = rec.get("monthly_rent")
        published_rent, adjusted = compute_adjusted_rent(
            original_rent, args.rent_min, args.rent_max, args.cap, args.reduction,
            reduce_max=args.reduce_max,
        )
        addr = (rec.get("address") or "") + ", " + (rec.get("city") or "")

        if published_rent is None:
            if original_rent is not None and args.rent_min <= original_rent <= args.rent_max:
                skipped += 1
                print("  [SKIP] " + addr + " orig=$" + str(original_rent) + " -- reduction insufficient to stay <= cap")
            else:
                out_of_scope += 1
            continue

        deposit = published_rent if adjusted else rec.get("security_deposit")
        tag = "[ADJUST]" if adjusted else "[OK]"
        print(
            "  " + tag + " " + addr +
            " orig=$" + str(original_rent) +
            " -> published=$" + str(published_rent) +
            " deposit=$" + str(deposit)
        )

        if not args.dry_run:
            update_record(rec["id"], published_rent, deposit)
        applied += 1

    print("")
    print("Applied: " + str(applied) + "  Skipped (over cap even after reduction): " + str(skipped) +
          "  Out of batch scope: " + str(out_of_scope))
    if args.dry_run:
        print("(dry run -- no records were updated)")


if __name__ == "__main__":
    main()
