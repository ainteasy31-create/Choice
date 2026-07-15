#!/usr/bin/env python3
"""
Houston Batch Pricing — one-time script for the Houston 1BR scrape.

Pricing formula (from batch spec):
  published = round(0.5 * original + 450)

Anchor verification:
  $1,100 -> $1,000  ($1,100 * 0.5 + 450 = $1,000) ✓
  $1,200 -> $1,050  ($1,200 * 0.5 + 450 = $1,050) ✓
  $1,300 -> $1,100  ($1,300 * 0.5 + 450 = $1,100) ✓

Rules:
  - Only adjusts records with original rent $1,100–$1,300.
  - Records below $1,100 are published as-is (already within budget).
  - Published rent is capped at $1,100; never publishes above.
  - Security deposit is set equal to published rent.
  - Only touches records staged in the last N hours (default 12h).
  - Only touches records with city in the Houston-area target list.
"""

import os
import sys
import json
import argparse
from datetime import datetime, timezone, timedelta

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scraper import _load_dotenv

_load_dotenv()

SUPABASE_URL     = os.environ.get("SUPABASE_URL", "https://tlfmwetmhthpyrytrcfo.supabase.co").rstrip("/")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

HEADERS = {
    "apikey":          SERVICE_ROLE_KEY,
    "Authorization":   "Bearer " + SERVICE_ROLE_KEY,
    "Content-Type":    "application/json",
    "Prefer":          "return=representation",
    "Accept-Profile":  "pipeline",
    "Content-Profile": "pipeline",
}

# Houston-area cities in scope for this batch
HOUSTON_CITIES = {
    "houston", "conroe", "cypress", "katy",
    "missouri city", "pearland",
    # surrounding communities per spec
    "sugar land", "spring", "humble", "league city",
    "friendswood", "the woodlands", "tomball", "richmond",
}

RENT_MIN = 1100.0
RENT_MAX = 1300.0
CAP      = 1100.0


def compute_published_rent(original_rent):
    """
    Returns (published_rent, adjusted: bool).
    - original < RENT_MIN  -> publish as-is, no rounding (already within budget)
    - RENT_MIN <= original <= RENT_MAX -> apply formula, cap at CAP
    - original > RENT_MAX  -> out of scope (None, None)
    """
    if original_rent is None:
        return None, None
    if original_rent > RENT_MAX:
        return None, None  # out of scope for this batch
    if original_rent < RENT_MIN:
        return original_rent, False  # already within budget — keep exact value, no rounding

    # Proportional reduction: published = 0.5 * original + 450
    # Anchor points: $1,100→$1,000  $1,200→$1,050  $1,300→$1,100
    published = round(0.5 * original_rent + 450)
    published = min(published, int(CAP))  # hard cap at $1,100
    return published, True


def fetch_records(hours_back=12):
    """Fetch pipeline_properties staged in the last N hours in Houston-area cities.

    Scope guards applied server-side:
      - status = scraped
      - scraped_at >= now - hours_back  (batch time window)
      - bedrooms = 1                    (hard 1BR constraint per batch spec)

    City filter applied client-side against HOUSTON_CITIES.
    """
    since = (datetime.now(timezone.utc) - timedelta(hours=hours_back)).isoformat()

    resp = requests.get(
        SUPABASE_URL + "/rest/v1/pipeline_properties",
        headers=HEADERS,
        params={
            "select":     "id,address,city,state,monthly_rent,security_deposit,bedrooms,scraped_at",
            "status":     "eq.scraped",
            "bedrooms":   "eq.1",
            "scraped_at": "gte." + since.replace("+00:00", "Z"),
        },
        timeout=30,
    )
    resp.raise_for_status()
    records = resp.json()

    # Secondary filter: restrict to Houston-area cities from the batch spec
    return [
        r for r in records
        if (r.get("city") or "").strip().lower() in HOUSTON_CITIES
    ]


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
    ap = argparse.ArgumentParser(description="Houston batch pricing — one-time script.")
    ap.add_argument("--hours-back", type=int, default=12,
                    help="Only touch records staged in the last N hours (default: 12).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Preview without writing.")
    args = ap.parse_args()

    if not SERVICE_ROLE_KEY:
        print("SUPABASE_SERVICE_ROLE_KEY is not set.")
        sys.exit(1)

    records = fetch_records(args.hours_back)
    print(f"Fetched {len(records)} recently staged Houston-area record(s)\n")

    applied = skipped = out_of_scope = already_ok = 0

    for rec in records:
        orig = rec.get("monthly_rent")
        addr = f"{rec.get('address', '?')}, {rec.get('city', '?')}"
        published, adjusted = compute_published_rent(orig)

        if published is None:
            out_of_scope += 1
            print(f"  [OUT-OF-SCOPE] {addr}  orig=${orig}  (above $1,300 — skipped)")
            continue

        deposit = published

        if adjusted:
            print(f"  [ADJUST] {addr}  orig=${orig} -> published=${published}  deposit=${deposit}")
            applied += 1
        else:
            print(f"  [OK]     {addr}  orig=${orig} -> published=${published}  deposit=${deposit}")
            already_ok += 1

        if not args.dry_run:
            update_record(rec["id"], published, deposit)

    print(f"\nAdjusted: {applied}  As-is (already ≤$1,100): {already_ok}  Out of scope: {out_of_scope}")
    if args.dry_run:
        print("(dry run — no records were updated)")
    else:
        print("✅  Pricing applied.")


if __name__ == "__main__":
    main()
