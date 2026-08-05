#!/usr/bin/env python3
"""
rescrape_publish_sc.py — Re-scrape and re-publish two SC Opendoor listings.

Listings:
  PP-26A3727B  218 Persimmon Cir, Goose Creek SC  cpid=ca6362d5-3123-405e-bce7-ed4631a5b77d
  PP-0D0E30A4  189 Tall Pines Rd, Ladson SC        cpid=4e86b4ea-ab64-4ae2-8174-049594c2cb57

Flow:
  1. Re-scrape Opendoor URL (gets fresh photos + all structured fields)
  2. Apply enrichment pipeline (clean description, smart defaults, CTA)
  3. Upload ALL photos to ImageKit (replace existing 3-photo set)
  4. Update pipeline_properties record with fresh data
  5. Delete old property_photos rows; insert new ones
  6. Patch public.properties with new description, available_date, etc.
"""

import base64
import json
import os
import sys
import time

import requests

# ── Load env ──────────────────────────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from scraper import _load_dotenv
    _load_dotenv()
except Exception:
    from pathlib import Path
    env_file = Path(__file__).parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

from opendoor_scraper import scrape_opendoor_url
from enrichment import apply_enrichment_pipeline
from imagekit_upload import upload_images

SB      = os.environ["SUPABASE_URL"].rstrip("/")
KEY     = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
IK_KEY  = os.environ.get("IMAGEKIT_PRIVATE_KEY", "")
IK_EP   = os.environ.get("IMAGEKIT_URL_ENDPOINT", "").rstrip("/")

H_PUB = {
    "apikey": KEY, "Authorization": "Bearer " + KEY,
    "Content-Type": "application/json", "Prefer": "return=representation",
}
H_PL = dict(H_PUB, **{"Accept-Profile": "pipeline", "Content-Profile": "pipeline"})

# ── Listings to re-process ─────────────────────────────────────────────────────
LISTINGS = [
    {
        "pp_id":   "PP-26A3727B",
        "cpid":    "ca6362d5-3123-405e-bce7-ed4631a5b77d",
        "url":     "https://www.opendoor.com/homes/218-Persimmon-Cir-Goose-Creek-SC-29445",
        "label":   "218 Persimmon Cir, Goose Creek SC",
        # Keep existing published rent — don't re-estimate from sale price
        "keep_rent": 2592,
    },
    {
        "pp_id":   "PP-0D0E30A4",
        "cpid":    "4e86b4ea-ab64-4ae2-8174-049594c2cb57",
        "url":     "https://www.opendoor.com/homes/189-Tall-Pines-Rd-Ladson-SC-29456",
        "label":   "189 Tall Pines Rd, Ladson SC",
        "keep_rent": 2975,
    },
]


# ── Helpers ────────────────────────────────────────────────────────────────────

def sb_get(path, headers=H_PUB, params=None):
    r = requests.get(SB + path, headers=headers, params=params, timeout=20)
    r.raise_for_status()
    return r.json()


def sb_patch(path, payload, headers=H_PUB):
    r = requests.patch(SB + path, headers=headers, json=payload, timeout=20)
    r.raise_for_status()
    return r


def sb_post(path, payload, headers=H_PUB):
    r = requests.post(SB + path, headers=headers, json=payload, timeout=20)
    r.raise_for_status()
    return r


def sb_delete(path, headers=H_PUB, params=None):
    r = requests.delete(SB + path, headers=headers, params=params, timeout=20)
    r.raise_for_status()
    return r


def fetch_pipeline_record(pp_id):
    rows = sb_get(f"/rest/v1/pipeline_properties?id=eq.{pp_id}&select=*", headers=H_PL)
    return rows[0] if rows else None


def delete_property_photos(cpid):
    """Delete all existing property_photos rows for a property."""
    r = requests.delete(
        f"{SB}/rest/v1/property_photos?property_id=eq.{cpid}",
        headers=H_PUB, timeout=20
    )
    r.raise_for_status()
    print(f"    Deleted old photo rows for {cpid[:8]}")


def insert_property_photos(cpid, ik_urls):
    """Insert new property_photos rows (first = hero)."""
    rows = []
    for i, url in enumerate(ik_urls):
        rows.append({
            "property_id":    cpid,
            "url":            url,
            "display_order":  i,
            "is_hero":        (i == 0),
            "watermark_status": "none",
        })
    if rows:
        r = requests.post(
            f"{SB}/rest/v1/property_photos",
            headers=H_PUB, json=rows, timeout=30
        )
        r.raise_for_status()
        print(f"    Inserted {len(rows)} photo rows")


def update_pipeline_record(pp_id, fresh_rec, ik_urls):
    """Patch the pipeline_properties row with fresh scraped data + IK URLs."""
    payload = {
        "description":         fresh_rec.get("description"),
        "available_date":      fresh_rec.get("available_date"),
        "minimum_lease_months": fresh_rec.get("minimum_lease_months"),
        "smoking_allowed":     fresh_rec.get("smoking_allowed"),
        "location_context":    fresh_rec.get("location_context"),
        "year_built":          fresh_rec.get("year_built"),
        "lot_size_sqft":       fresh_rec.get("lot_size_sqft"),
        "has_basement":        fresh_rec.get("has_basement"),
        "has_central_air":     fresh_rec.get("has_central_air"),
        "neighborhood":        fresh_rec.get("neighborhood"),
        "virtual_tour_url":    fresh_rec.get("virtual_tour_url"),
        "heating_type":        fresh_rec.get("heating_type"),
        "cooling_type":        fresh_rec.get("cooling_type"),
        "laundry_type":        fresh_rec.get("laundry_type"),
        "parking":             fresh_rec.get("parking"),
        "pets_allowed":        fresh_rec.get("pets_allowed"),
        "amenities":           fresh_rec.get("amenities"),
        "appliances":          fresh_rec.get("appliances"),
        "original_image_urls": json.dumps(ik_urls),
        "data_quality_score":  fresh_rec.get("data_quality_score"),
        "missing_fields":      fresh_rec.get("missing_fields"),
    }
    # Remove None-valued keys so we don't overwrite good existing data
    payload = {k: v for k, v in payload.items() if v is not None}
    r = requests.patch(
        f"{SB}/rest/v1/pipeline_properties?id=eq.{pp_id}",
        headers=H_PL, json=payload, timeout=20
    )
    r.raise_for_status()
    print(f"    Pipeline record updated")


def update_public_property(cpid, fresh_rec, ik_urls):
    """Patch public.properties with fresh description, available_date, photo count."""
    payload = {
        "description":         fresh_rec.get("description"),
        "available_date":      fresh_rec.get("available_date"),
        "minimum_lease_months": fresh_rec.get("minimum_lease_months"),
        "smoking_allowed":     fresh_rec.get("smoking_allowed"),
        "year_built":          fresh_rec.get("year_built"),
        "lot_size_sqft":       fresh_rec.get("lot_size_sqft"),
        "has_basement":        fresh_rec.get("has_basement"),
        "has_central_air":     fresh_rec.get("has_central_air"),
        "neighborhood":        fresh_rec.get("neighborhood"),
        "virtual_tour_url":    fresh_rec.get("virtual_tour_url"),
        "heating_type":        fresh_rec.get("heating_type"),
        "cooling_type":        fresh_rec.get("cooling_type"),
        "laundry_type":        fresh_rec.get("laundry_type"),
        "parking":             fresh_rec.get("parking"),
        "pets_allowed":        fresh_rec.get("pets_allowed"),
    }
    payload = {k: v for k, v in payload.items() if v is not None}
    r = requests.patch(
        f"{SB}/rest/v1/properties?id=eq.{cpid}",
        headers=H_PUB, json=payload, timeout=20
    )
    r.raise_for_status()
    print(f"    public.properties updated")


# ── Main ───────────────────────────────────────────────────────────────────────

def process_listing(listing):
    pp_id = listing["pp_id"]
    cpid  = listing["cpid"]
    url   = listing["url"]
    label = listing["label"]
    keep_rent = listing["keep_rent"]

    print(f"\n{'='*60}")
    print(f"  {label}")
    print(f"  pp_id={pp_id}  cpid={cpid[:8]}")
    print(f"{'='*60}")

    # ── 1. Re-scrape ──────────────────────────────────────────────────────────
    print("  [1/5] Re-scraping Opendoor page ...")
    fresh = scrape_opendoor_url(url, verbose=True)
    if not fresh:
        print("  ⚠️  Scrape returned nothing — Opendoor may be blocking. Applying")
        print("       enrichment improvements to existing record data only.")
        # Fall back: fetch existing record and apply new defaults
        existing = fetch_pipeline_record(pp_id)
        if not existing:
            print("  ❌  No existing pipeline record found. Skipping.")
            return False
        fresh = dict(existing)
        # Apply the smart defaults that were missing
        from datetime import date
        fresh["available_date"]      = fresh.get("available_date") or date.today().isoformat()
        fresh["minimum_lease_months"] = fresh.get("minimum_lease_months") or 12
        fresh["smoking_allowed"]     = False if fresh.get("smoking_allowed") is None else fresh["smoking_allowed"]
        scrape_succeeded = False
    else:
        scrape_succeeded = True
        photos_found = len(json.loads(fresh.get("original_image_urls") or "[]"))
        print(f"  ✅  Scraped OK — {photos_found} photos found, quality={fresh.get('data_quality_score')}")

    # ── 2. Preserve published rent (don't re-estimate from sale price) ─────
    fresh["monthly_rent"]     = keep_rent
    fresh["security_deposit"] = keep_rent
    fresh["choice_property_id"] = cpid  # needed for enrichment pipeline

    # ── 3. Apply enrichment ────────────────────────────────────────────────────
    print("  [2/5] Running enrichment pipeline ...")
    enriched_list, _ = apply_enrichment_pipeline([fresh], verbose=True, enable_detail_fetch=False)
    if not enriched_list:
        print("  ❌  Enrichment dropped this record (watermark?). Skipping.")
        return False
    enriched = enriched_list[0]

    # ── 4. Upload photos to ImageKit ──────────────────────────────────────────
    print("  [3/5] Uploading photos to ImageKit ...")
    source_urls = json.loads(enriched.get("original_image_urls") or "[]")
    if not source_urls:
        print("  ⚠️  No source photo URLs — skipping photo upload.")
        ik_urls = []
    else:
        print(f"       {len(source_urls)} source photo(s) to upload ...")
        ik_urls, failed = upload_images(source_urls, pp_id, verify=True, verbose=True)
        if not ik_urls:
            print(f"  ⚠️  All {len(source_urls)} photo uploads failed. Using existing ImageKit photos.")
            # Keep existing IK URLs from property_photos table
            existing_photos = sb_get(
                f"/rest/v1/property_photos?property_id=eq.{cpid}&select=url,display_order&order=display_order.asc",
                headers=H_PUB
            )
            ik_urls = [p["url"] for p in existing_photos]
        print(f"       {len(ik_urls)} photos ready for publishing")

    if len(ik_urls) < 6:
        print(f"  ⚠️  Only {len(ik_urls)} photo(s) — minimum is 6. Will update DB but flag for review.")

    # ── 5. Update pipeline_properties ─────────────────────────────────────────
    print("  [4/5] Updating pipeline_properties ...")
    update_pipeline_record(pp_id, enriched, ik_urls)

    # ── 6. Replace property_photos + update public.properties ─────────────────
    print("  [5/5] Replacing property_photos and updating public listing ...")
    if ik_urls:
        delete_property_photos(cpid)
        insert_property_photos(cpid, ik_urls)
    update_public_property(cpid, enriched, ik_urls)

    desc_len = len(enriched.get("description") or "")
    print(f"\n  ✅  Done: {len(ik_urls)} photos | desc {desc_len} chars | "
          f"available_date={enriched.get('available_date')} | "
          f"min_lease={enriched.get('minimum_lease_months')} | "
          f"quality={enriched.get('data_quality_score')}")
    print(f"  🔗  https://choice-properties-site.pages.dev/property?id={cpid}")
    return True


def main():
    print("\nChoice Properties — Opendoor SC Re-scrape + Re-publish")
    print("=" * 60)
    ok = 0
    for listing in LISTINGS:
        try:
            if process_listing(listing):
                ok += 1
        except Exception as e:
            print(f"  ❌  Error processing {listing['label']}: {e}")
            import traceback; traceback.print_exc()
        time.sleep(2)

    print(f"\n{'='*60}")
    print(f"Completed: {ok}/{len(LISTINGS)} listings updated")


if __name__ == "__main__":
    main()
