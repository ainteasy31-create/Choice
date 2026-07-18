#!/usr/bin/env python3
"""
stl_batch.py — St. Louis Rental Batch: Scrape → Process → Publish
==================================================================
Target markets : Maryland Heights, MO + Creve Coeur, MO
                 (falls back to nearby north St. Louis County suburbs)
Property types : Houses (SINGLE_FAMILY), Townhouses (TOWNHOMES), Apartments (APARTMENT)
Bedrooms       : 3 exactly
Rent range     : $1,200 – $1,600 / month (scraped)
Price rule     : published rent capped at $1,200; security deposit = published rent
Image rule     : photos imported via Supabase import-pipeline-photos edge function
Description    : remove tours/showings, external apps, third-party branding, old prices
Goal           : publish 15 listings that pass all validation checks

Usage (from workspace root):
  python3 scraper/stl_batch.py
  python3 scraper/stl_batch.py --dry-run
  python3 scraper/stl_batch.py --target 15 --past-days 90
"""

import argparse
import json
import os
import sys
import time
import re
import uuid
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

# ── Path setup ────────────────────────────────────────────────────────────────
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _SCRIPT_DIR)

# ── .env loader ───────────────────────────────────────────────────────────────
def _load_dotenv():
    for candidate in [".env", "../.env",
                      os.path.join(_SCRIPT_DIR, ".env"),
                      os.path.join(_SCRIPT_DIR, "../.env")]:
        if os.path.isfile(candidate):
            with open(candidate) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    if key.strip() and key.strip() not in os.environ:
                        os.environ[key.strip()] = val.strip().strip('"').strip("'")
            break
_load_dotenv()

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL     = os.environ.get("SUPABASE_URL", "https://tlfmwetmhthpyrytrcfo.supabase.co").rstrip("/")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not SERVICE_ROLE_KEY:
    sys.exit("❌  SUPABASE_SERVICE_ROLE_KEY not set.")

# ── Batch constants ───────────────────────────────────────────────────────────
TARGET_LOCATIONS   = ["Maryland Heights, MO", "Creve Coeur, MO"]
FALLBACK_LOCATIONS = [
    # North St. Louis County — confirmed 3BR $1,200–$1,600 inventory
    "Florissant, MO", "Hazelwood, MO", "Ferguson, MO",
    "Bellefontaine Neighbors, MO", "Jennings, MO", "Overland, MO",
    "Normandy, MO", "University City, MO", "Cool Valley, MO", "Mehlville, MO",
]

ALLOWED_CITIES = {"maryland heights", "creve coeur"}
FALLBACK_CITIES = {
    "florissant", "hazelwood", "ferguson", "bellefontaine neighbors",
    "jennings", "overland", "normandy", "university city", "cool valley",
    "mehlville", "saint louis", "st. louis", "st louis",
}

ALLOWED_TYPES = {"SINGLE_FAMILY", "TOWNHOMES", "APARTMENT"}
BEDS_EXACT    = 3
RENT_MIN      = 1200
RENT_MAX      = 1600
RENT_CAP      = 1200

# ── Guards ────────────────────────────────────────────────────────────────────
try:
    from homeharvest import scrape_property
    from homeharvest.exceptions import InvalidListingType, AuthenticationError
    _HH_OK = True
except ImportError:
    _HH_OK = False

try:
    import requests as _req
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
except ImportError:
    sys.exit("❌  requests not installed — pip install requests")

try:
    from enrichment import (
        clean_description, strip_external_application_instructions,
        replace_owner_manager_references, strip_third_party_branding,
        enforce_price_consistency, append_apply_cta,
        is_watermarked, filter_record_photos,
    )
    _ENRICH_OK = True
except Exception as _ee:
    _ENRICH_OK = False
    print(f"⚠  enrichment module unavailable: {_ee}")

try:
    from scraper import (
        _map_realtor_property, _enrich_realtor_batch,
        _quality_score, _missing_fields, _get_existing_ids, _sb_post_batch,
    )
    _SCRAPER_OK = True
except Exception as _se:
    _SCRAPER_OK = False
    print(f"⚠  scraper.py imports failed: {_se}")

# ── HTTP helpers ──────────────────────────────────────────────────────────────
_session_local = threading.local()

def _pipeline_session():
    if not hasattr(_session_local, "pipe"):
        s = _req.Session()
        retry = Retry(total=3, backoff_factor=0.5, status_forcelist=[500,502,503,504],
                      allowed_methods=["GET","POST","PATCH"])
        s.mount("https://", HTTPAdapter(max_retries=retry))
        s.headers.update({
            "apikey": SERVICE_ROLE_KEY, "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
            "Content-Type": "application/json", "Accept": "application/json",
            "Accept-Profile": "pipeline", "Content-Profile": "pipeline",
            "Prefer": "return=representation",
        })
        _session_local.pipe = s
    return _session_local.pipe

def _public_session():
    if not hasattr(_session_local, "pub"):
        s = _req.Session()
        s.headers.update({
            "apikey": SERVICE_ROLE_KEY, "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
            "Content-Type": "application/json", "Accept": "application/json",
            "Prefer": "return=representation",
        })
        _session_local.pub = s
    return _session_local.pub

def _now():
    return datetime.now(timezone.utc).isoformat()

def _safe_int(v):
    try: return int(v) if v is not None else None
    except (ValueError, TypeError): return None

def _jdumps(v):
    if v is None: return "[]"
    if isinstance(v, str): return v
    return json.dumps([str(x) for x in v if x])

# ── Location validation ───────────────────────────────────────────────────────
def _city_tier(city_str):
    """Return 'primary', 'fallback', or None."""
    if not city_str: return None
    c = city_str.lower().strip()
    if c in ALLOWED_CITIES: return "primary"
    if c in FALLBACK_CITIES: return "fallback"
    return None

# ── Scrape one location ───────────────────────────────────────────────────────
def scrape_location(location, past_days, limit):
    print(f"\n{'─'*55}")
    print(f"🏠  Scraping: {location}")
    print(f"{'─'*55}")
    if not _HH_OK or not _SCRAPER_OK:
        print("   Skipping — dependencies unavailable")
        return []
    try:
        props = scrape_property(
            location=location, listing_type="for_rent", past_days=past_days,
            return_type="pydantic", limit=limit,
            beds_min=BEDS_EXACT, beds_max=BEDS_EXACT,
            price_min=RENT_MIN, price_max=RENT_MAX,
            extra_property_data=True,
        )
    except (InvalidListingType, AuthenticationError) as e:
        print(f"   ❌  {e}"); return []
    except Exception as e:
        print(f"   ❌  {e}"); return []

    print(f"   HomeHarvest returned {len(props)} listing(s)")
    recs = []
    for p in props:
        try: recs.append(_map_realtor_property(p))
        except Exception: pass
    print(f"   Mapped {len(recs)} records")
    return recs

# ── Filter ────────────────────────────────────────────────────────────────────
def filter_records(records, strict=True):
    kept, dropped = [], []
    for rec in records:
        issues = []
        # Competitor brand
        if _ENRICH_OK and is_watermarked(rec):
            issues.append("competitor-branded")
        # City
        tier = _city_tier(rec.get("city"))
        if tier is None:
            issues.append(f"city not in target area: {rec.get('city')}")
        elif tier == "fallback" and strict:
            issues.append(f"fallback city (strict mode): {rec.get('city')}")
        # Type
        ptype = (rec.get("property_type") or "").upper()
        if ptype not in ALLOWED_TYPES:
            issues.append(f"type={ptype}")
        # Beds
        beds = _safe_int(rec.get("bedrooms"))
        if beds != BEDS_EXACT:
            issues.append(f"beds={beds}")
        # Rent
        rent = rec.get("monthly_rent")
        if rent is None or rent < RENT_MIN or rent > RENT_MAX:
            issues.append(f"rent=${rent}")
        # Must have at least 6 source images (sparse galleries look poor on the site)
        src_imgs = []
        try: src_imgs = json.loads(rec.get("original_image_urls") or "[]")
        except (ValueError, TypeError): pass
        if len(src_imgs) < 6:
            issues.append("too few photos ({}/6 minimum)".format(len(src_imgs)))

        if issues:
            addr = f"{rec.get('address','')} {rec.get('city','')}".strip()
            dropped.append((addr, issues))
        else:
            if _ENRICH_OK:
                rec = filter_record_photos(rec)
                # Re-check images after branded-photo filter
                try:
                    remaining = json.loads(rec.get("original_image_urls") or "[]")
                except (ValueError, TypeError):
                    remaining = []
                if not remaining:
                    dropped.append((f"{rec.get('address','')} {rec.get('city','')}".strip(),
                                    ["all photos removed by brand filter"]))
                    continue
            kept.append(rec)
    return kept, dropped

# ── Price adjustment ──────────────────────────────────────────────────────────
def apply_pricing(rec):
    rent = rec.get("monthly_rent")
    if rent is None: return rec
    published = rent if rent <= RENT_CAP else RENT_CAP
    rec["monthly_rent"]     = published
    rec["security_deposit"] = published
    return rec

# ── Description cleanup ───────────────────────────────────────────────────────
def clean_desc(rec):
    text = rec.get("description") or ""
    if not text or not _ENRICH_OK:
        return rec
    text = clean_description(text)
    text = strip_external_application_instructions(text)
    text = replace_owner_manager_references(text)
    text = strip_third_party_branding(text)
    text = enforce_price_consistency(text, rec.get("monthly_rent"))
    text = append_apply_cta(text)
    rec["description"] = text
    return rec

# ── Validation ────────────────────────────────────────────────────────────────
def validate(rec, strict=True):
    fails = []
    tier = _city_tier(rec.get("city"))
    if tier is None:
        fails.append(f"city not in target area: {rec.get('city')}")
    if strict and tier == "fallback":
        pass  # fallback cities are allowed when strict=False at filter time; skip here
    state = (rec.get("state") or "").upper()
    if state and state != "MO":
        fails.append(f"state={state}")
    if _safe_int(rec.get("bedrooms")) != BEDS_EXACT:
        fails.append(f"beds={rec.get('bedrooms')}")
    ptype = (rec.get("property_type") or "").upper()
    if ptype not in ALLOWED_TYPES:
        fails.append(f"type={ptype}")
    rent = rec.get("monthly_rent")
    if rent is None or rent > RENT_CAP:
        fails.append(f"rent=${rent} > cap ${RENT_CAP}")
    for f in ("title", "address", "city", "state", "zip", "monthly_rent"):
        if not rec.get(f):
            fails.append(f"missing {f}")
    src_imgs = []
    try: src_imgs = json.loads(rec.get("original_image_urls") or "[]")
    except (ValueError, TypeError): pass
    if len(src_imgs) < 6:
        fails.append("too few photos ({}/6 minimum)".format(len(src_imgs)))
    return len(fails) == 0, fails

# ── Fetch existing pipeline IDs by source_listing_id ─────────────────────────
def fetch_pipeline_id_map(source_ids):
    """Return {source_listing_id: pipeline_id} for records already in pipeline."""
    if not source_ids:
        return {}
    import urllib.parse
    result = {}
    chunk_size = 100
    for i in range(0, len(source_ids), chunk_size):
        chunk = source_ids[i:i+chunk_size]
        encoded = urllib.parse.quote(",".join(chunk))
        r = _pipeline_session().get(
            f"{SUPABASE_URL}/rest/v1/pipeline_properties"
            f"?source_listing_id=in.({encoded})"
            f"&select=id,source_listing_id&limit=1000",
            timeout=20,
        )
        try:
            r.raise_for_status()
            for row in r.json():
                result[row["source_listing_id"]] = row["id"]
        except Exception as e:
            print(f"   ⚠  fetch_pipeline_id_map error: {e}")
    return result


# ── Stage into pipeline and resolve actual IDs ────────────────────────────────
def stage_and_resolve(records):
    """
    Insert new records; skip duplicates.
    Returns the same list with rec["id"] updated to the actual pipeline ID
    (the existing ID for pre-existing records, the generated ID for new ones).
    """
    if not records: return records

    source_ids = [r.get("source_listing_id","") for r in records if r.get("source_listing_id")]

    # Fetch existing IDs first (covers records from previous runs)
    existing_map = fetch_pipeline_id_map(source_ids)  # sid → pipeline_id

    # Identify truly new records
    new_records = [r for r in records if r.get("source_listing_id","") not in existing_map]
    print(f"   Dedup: {len(records)-len(new_records)} already in pipeline, {len(new_records)} new")

    # Insert new ones
    inserted = 0
    for i in range(0, len(new_records), 50):
        batch = new_records[i:i+50]
        url = f"{SUPABASE_URL}/rest/v1/pipeline_properties?on_conflict=source_listing_id"
        r = _pipeline_session().post(
            url, data=json.dumps(batch, default=str).encode(),
            headers={"Prefer": "return=representation,resolution=ignore-duplicates"},
            timeout=30,
        )
        try:
            r.raise_for_status()
            data = r.json()
            cnt = len(data) if isinstance(data, list) else len(batch)
            inserted += cnt
            print(f"   ✅  Batch {i//50+1}: {cnt} staged")
        except Exception as e:
            print(f"   ❌  Batch {i//50+1} failed: {e} — {r.text[:200]}")

    # Re-fetch IDs for newly inserted records (in case DB assigned different IDs)
    if new_records:
        new_sids = [r.get("source_listing_id","") for r in new_records]
        fresh = fetch_pipeline_id_map(new_sids)
        existing_map.update(fresh)

    # Update rec["id"] to actual pipeline ID for all records
    resolved = []
    for rec in records:
        sid = rec.get("source_listing_id","")
        if sid in existing_map:
            rec["id"] = existing_map[sid]   # overwrite generated ID with real one
        resolved.append(rec)

    return resolved

# ── Publish via pipeline_publish RPC ─────────────────────────────────────────
def publish_listing(pipeline_id):
    """
    Call pipeline_publish(p_id). Returns (choice_property_id, error).
    The RPC returns: {"ok": true, "choice_property_id": "<uuid>"}
    """
    r = _public_session().post(
        f"{SUPABASE_URL}/rest/v1/rpc/pipeline_publish",
        json={"p_id": pipeline_id, "p_landlord_id": None},
        timeout=30,
    )
    try:
        r.raise_for_status()
        data = r.json()
        if isinstance(data, list): data = data[0] if data else {}
        if data.get("ok") is False:
            return None, data.get("error", "RPC returned ok=false")
        # RPC returns choice_property_id (the new public.properties UUID)
        prop_id = (data.get("choice_property_id") or
                   data.get("property_id") or
                   data.get("id"))
        return prop_id, None
    except Exception as e:
        return None, f"{e} — {r.text[:200]}"

# ── Import photos via edge function ───────────────────────────────────────────
def import_photos(property_id):
    """
    Call import-pipeline-photos edge function.
    Downloads source photos from pipeline record, uploads to ImageKit,
    inserts into property_photos. Returns (transferred, skipped, error).
    """
    try:
        r = _req.post(
            f"{SUPABASE_URL}/functions/v1/import-pipeline-photos",
            headers={
                "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
                "Content-Type": "application/json",
            },
            json={"property_id": property_id},
            timeout=120,  # edge function does IK upload — allow up to 2 min
        )
        r.raise_for_status()
        data = r.json()
        return data.get("transferred", 0), data.get("skipped", 0), None
    except Exception as e:
        return 0, 0, str(e)[:200]

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run",   action="store_true")
    ap.add_argument("--target",    type=int, default=15)
    ap.add_argument("--past-days", type=int, default=90)
    ap.add_argument("--limit",     type=int, default=200)
    ap.add_argument("--min-score", type=int, default=40)
    args = ap.parse_args()

    print("=" * 60)
    print("St. Louis Rental Batch — Scrape & Publish")
    print(f"Target: {args.target} | Past {args.past_days} days | Dry run: {args.dry_run}")
    print(f"Criteria: 3BR | ${RENT_MIN}–${RENT_MAX}/mo → cap ${RENT_CAP} | {ALLOWED_TYPES}")
    print("=" * 60)

    # ── Phase 1: Scrape all locations ─────────────────────────────────────────
    print("\n── Phase 1: Scraping ──")
    all_recs = []
    for loc in TARGET_LOCATIONS + FALLBACK_LOCATIONS:
        recs = scrape_location(loc, past_days=args.past_days, limit=args.limit)
        all_recs.extend(recs)

    # Deduplicate within batch
    seen, unique = set(), []
    for r in all_recs:
        sid = r.get("source_listing_id", "")
        if sid and sid in seen: continue
        seen.add(sid); unique.append(r)
    print(f"\n🔢  Raw: {len(all_recs)} | After within-batch dedup: {len(unique)}")
    all_recs = unique

    if not all_recs:
        print("❌  No listings found. Try --past-days 120.")
        sys.exit(1)

    # ── Phase 2: Realtor.com detail-page enrichment ───────────────────────────
    if _SCRAPER_OK:
        print(f"\n── Phase 2: Detail-page enrichment ──")
        all_recs = _enrich_realtor_batch(all_recs, verbose=True)

    # ── Phase 3: Filter ───────────────────────────────────────────────────────
    print(f"\n── Phase 3: Filtering ──")
    # Allow fallback cities (primary cities have no inventory in this price range)
    kept, dropped = filter_records(all_recs, strict=False)
    print(f"   Kept: {len(kept)} | Dropped: {len(dropped)}")
    for addr, reasons in dropped[:15]:
        print(f"   [DROP] {addr} — {', '.join(reasons)}")
    if len(dropped) > 15:
        print(f"   ... and {len(dropped)-15} more dropped")

    # Quality floor
    pre = len(kept)
    kept = [r for r in kept if r.get("data_quality_score", 0) >= args.min_score]
    print(f"   After quality floor ({args.min_score}): {len(kept)}/{pre}")

    if not kept:
        print("❌  No listings passed filters.")
        sys.exit(1)

    # ── Phase 4: Price adjustment ─────────────────────────────────────────────
    print(f"\n── Phase 4: Price adjustment ──")
    price_changes = 0
    for rec in kept:
        orig = rec.get("monthly_rent")
        apply_pricing(rec)
        if orig != rec.get("monthly_rent"):
            price_changes += 1
    print(f"   {price_changes} listings capped at ${RENT_CAP}/mo | all deposits set to match rent")

    # ── Phase 5: Description cleanup ──────────────────────────────────────────
    print(f"\n── Phase 5: Description cleanup ──")
    for rec in kept:
        clean_desc(rec)
    print(f"   Cleaned {len(kept)} descriptions")

    # ── Phase 6: Validation ───────────────────────────────────────────────────
    print(f"\n── Phase 6: Validation ──")
    valid, invalid = [], []
    for rec in kept:
        ok, fails = validate(rec, strict=False)
        if ok:
            valid.append(rec)
        else:
            addr = f"{rec.get('address','')} {rec.get('city','')}".strip()
            invalid.append((addr, fails))
            print(f"   [FAIL] {addr}: {', '.join(fails)}")
    print(f"   Valid: {len(valid)} | Invalid: {len(invalid)}")

    if not valid:
        print("❌  No listings passed validation.")
        sys.exit(1)

    # Sort: primary cities first, then by quality score descending
    valid.sort(key=lambda r: (
        0 if _city_tier(r.get("city")) == "primary" else 1,
        -r.get("data_quality_score", 0)
    ))

    to_publish = valid[:args.target]
    print(f"\n   Selecting top {len(to_publish)}/{len(valid)} for publishing")
    for i, rec in enumerate(to_publish, 1):
        addr = f"{rec.get('address','')} {rec.get('city','')}".strip()
        rent = rec.get("monthly_rent")
        score = rec.get("data_quality_score", 0)
        src_ct = len(json.loads(rec.get("original_image_urls") or "[]"))
        print(f"   {i:2}. {addr} | ${rent}/mo | score={score} | {src_ct} source photos")

    if args.dry_run:
        print("\n⚠  DRY RUN — stopping before any database writes.")
        print(f"   Would publish {len(to_publish)} listings.")
        return

    # ── Phase 7: Stage in pipeline + resolve actual IDs ──────────────────────
    print(f"\n── Phase 7: Staging {len(to_publish)} records in pipeline ──")
    to_publish = stage_and_resolve(to_publish)
    print(f"   All records have resolved pipeline IDs")

    # Update pricing + description on pipeline records before publishing
    # (handles both new and pre-existing records)
    print(f"\n   Updating pricing + descriptions on pipeline records...")
    for rec in to_publish:
        pid = rec["id"]
        r = _pipeline_session().patch(
            f"{SUPABASE_URL}/rest/v1/pipeline_properties?id=eq.{pid}",
            json={
                "monthly_rent":    rec.get("monthly_rent"),
                "security_deposit": rec.get("security_deposit"),
                "description":     rec.get("description"),
            },
            timeout=20,
        )
        if not r.ok:
            print(f"   ⚠  PATCH failed for {pid}: {r.text[:100]}")

    # Fetch current status for all records (skip already-published ones)
    def _fetch_statuses(ids):
        if not ids: return {}
        import urllib.parse
        encoded = urllib.parse.quote(",".join(ids))
        r = _pipeline_session().get(
            f"{SUPABASE_URL}/rest/v1/pipeline_properties"
            f"?id=in.({encoded})"
            f"&select=id,status,choice_property_id&limit=1000",
            timeout=20,
        )
        result = {}
        if r.ok:
            for row in r.json():
                result[row["id"]] = row
        return result

    statuses = _fetch_statuses([r["id"] for r in to_publish])

    # ── Phase 8: Publish + import photos ─────────────────────────────────────
    print(f"\n── Phase 8: Publishing + importing photos ──")
    published, photo_ok, photo_fail = [], [], []

    for rec in to_publish:
        addr = f"{rec.get('address','')} {rec.get('city','')} {rec.get('state','')}".strip()
        pid  = rec["id"]

        # Check if already published
        current = statuses.get(pid, {})
        existing_prop_id = current.get("choice_property_id")
        if current.get("status") == "published" and existing_prop_id:
            print(f"   ♻️   Already published: {addr} → {existing_prop_id}")
            published.append((pid, existing_prop_id, addr))
            # Still try to import photos in case they weren't imported before
            print(f"      Importing photos...", end=" ", flush=True)
            transferred, skipped, photo_err = import_photos(existing_prop_id)
            if photo_err:
                print(f"⚠  {photo_err}")
                photo_fail.append((addr, photo_err))
            elif transferred == 0 and skipped > 0:
                print(f"✅  Photos already present ({skipped} skipped)")
                photo_ok.append((addr, skipped))
            elif transferred > 0:
                print(f"✅  {transferred} photo(s) added")
                photo_ok.append((addr, transferred))
            else:
                print(f"⚠  0 transferred, 0 skipped")
                photo_fail.append((addr, "0 photos transferred or skipped"))
            continue

        # pipeline_publish → creates public.properties draft
        prop_id, err = publish_listing(pid)
        if err:
            print(f"   ❌  PUBLISH FAILED: {addr} — {err}")
            continue

        print(f"   ✅  Published: {addr}")
        print(f"      → property_id={prop_id}")
        published.append((pid, prop_id, addr))

        # import-pipeline-photos → uploads to ImageKit + inserts property_photos
        print(f"      Importing photos...", end=" ", flush=True)
        transferred, skipped, photo_err = import_photos(prop_id)
        if photo_err:
            print(f"⚠  {photo_err}")
            photo_fail.append((addr, photo_err))
        elif transferred == 0:
            print(f"⚠  0 photos transferred (skipped={skipped}) — check pipeline record")
            photo_fail.append((addr, "0 photos transferred"))
        else:
            print(f"✅  {transferred} photo(s) on ImageKit")
            photo_ok.append((addr, transferred))

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Scraped (raw)           : {len(all_recs)}")
    print(f"Passed filters          : {len(kept)}")
    print(f"Passed validation       : {len(valid)}")
    print(f"Selected to publish     : {len(to_publish)}")
    print(f"Successfully published  : {len(published)}")
    print(f"Photos OK (IK)          : {len(photo_ok)}")
    print(f"Photo import issues     : {len(photo_fail)}")

    if photo_fail:
        print("\nListings with photo issues:")
        for addr, err in photo_fail:
            print(f"  ⚠  {addr}: {err}")
        print("  → Use 'Import source photos' button on each property-detail page to retry")

    if len(published) < args.target:
        shortfall = args.target - len(published)
        print(f"\n⚠  {shortfall} short of target {args.target}.")
        print("   Tips:")
        print(f"   • Re-run with --past-days {args.past_days * 2}")
        print("   • Wait for new listings to appear on Realtor.com")
        print(f"   • {len(invalid)} listings failed validation — review above")

    print(f"\nAdmin pipeline : https://choice-properties-site.pages.dev/admin/pipeline.html")
    print(f"Listings page  : https://choice-properties-site.pages.dev/listings.html")

    print("\nPublished properties:")
    for pipe_id, prop_id, addr in published:
        print(f"  ✅  {addr}")
        print(f"      pipeline={pipe_id}  property={prop_id}")

    return len(published)


if __name__ == "__main__":
    main()
