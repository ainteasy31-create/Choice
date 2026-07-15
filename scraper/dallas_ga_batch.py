#!/usr/bin/env python3
"""
dallas_ga_batch.py — Dallas, GA Rental Batch: Scrape → Process → Publish
=========================================================================
Target markets  : Dallas, GA · Hiram, GA · Powder Springs, GA · Acworth, GA
                  + West Cobb / GA-61 corridor / I-75 nearby communities
Property types  : Houses (SINGLE_FAMILY), Townhouses (TOWNHOMES)
                  DO NOT include: Apartments, Condos, Duplexes
Bedrooms        : 3 exactly
Bathrooms       : 2+
Rent range      : $1,250–$1,500 / month (scraped)
Price rule      : tiered proportional reduction; published rent ≤ $1,250
                  security deposit = published rent
Image rule      : photos imported via Supabase import-pipeline-photos edge function
Description     : remove tours/showings, external apps, third-party branding, old prices
Goal            : publish 15 listings that pass all validation checks
Site URL        : https://choice-properties-site.pages.dev

Pricing tiers (this batch only):
  $1,250              → publish as-is ($1,250)
  $1,251–$1,299       → proportional reduction → $1,200–$1,250
  $1,300–$1,349       → proportional reduction → $1,175–$1,225
  $1,350–$1,399       → proportional reduction → $1,150–$1,200
  $1,400–$1,449       → proportional reduction → $1,150–$1,200
  $1,450–$1,500       → proportional reduction → $1,200–$1,250 (cap $1,250)

Usage (from workspace root):
  python3 scraper/dallas_ga_batch.py
  python3 scraper/dallas_ga_batch.py --dry-run
  python3 scraper/dallas_ga_batch.py --target 15 --past-days 90
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
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
SITE_BASE_URL    = "https://choice-properties-site.pages.dev"

if not SERVICE_ROLE_KEY:
    sys.exit("❌  SUPABASE_SERVICE_ROLE_KEY not set.")

# ── Batch constants ───────────────────────────────────────────────────────────
TARGET_LOCATIONS = [
    "Dallas, GA",
    "Hiram, GA",
    "Powder Springs, GA",
    "Acworth, GA",
]
FALLBACK_LOCATIONS = [
    # West Cobb / GA-61 corridor / near I-75
    "Kennesaw, GA",
    "Marietta, GA",
    "Austell, GA",
    "Smyrna, GA",
    "Villa Rica, GA",
]

# Primary and fallback city sets (lower-cased for matching)
PRIMARY_CITIES  = {"dallas", "hiram", "powder springs", "acworth"}
FALLBACK_CITIES = {
    "kennesaw", "marietta", "austell", "smyrna",
    "villa rica", "west cobb",
}

ALLOWED_TYPES = {"SINGLE_FAMILY", "TOWNHOMES"}   # NO APARTMENT, CONDO, MULTI_FAMILY
BEDS_EXACT    = 3
BATHS_MIN     = 2.0
RENT_MIN      = 1250
RENT_MAX      = 1500
RENT_CAP      = 1250   # maximum published monthly rent

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
        clean_description,
        strip_external_application_instructions,
        replace_owner_manager_references,
        strip_third_party_branding,
        enforce_price_consistency,
        normalize_application_fee_in_description,
        append_apply_cta,
        is_watermarked,
        filter_record_photos,
    )
    _ENRICH_OK = True
except Exception as _ee:
    _ENRICH_OK = False
    print("⚠  enrichment module unavailable: {}".format(_ee))

try:
    from scraper import (
        _map_realtor_property,
        _enrich_realtor_batch,
        _quality_score,
        _missing_fields,
        _get_existing_ids,
        _sb_post_batch,
    )
    _SCRAPER_OK = True
except Exception as _se:
    _SCRAPER_OK = False
    print("⚠  scraper.py imports failed: {}".format(_se))

# ── HTTP helpers ──────────────────────────────────────────────────────────────
_session_local = threading.local()

def _pipeline_session():
    if not hasattr(_session_local, "pipe"):
        s = _req.Session()
        retry = Retry(total=3, backoff_factor=0.5, status_forcelist=[500, 502, 503, 504],
                      allowed_methods=["GET", "POST", "PATCH"])
        s.mount("https://", HTTPAdapter(max_retries=retry))
        s.headers.update({
            "apikey":           SERVICE_ROLE_KEY,
            "Authorization":    "Bearer " + SERVICE_ROLE_KEY,
            "Content-Type":     "application/json",
            "Accept":           "application/json",
            "Accept-Profile":   "pipeline",
            "Content-Profile":  "pipeline",
            "Prefer":           "return=representation",
        })
        _session_local.pipe = s
    return _session_local.pipe

def _public_session():
    if not hasattr(_session_local, "pub"):
        s = _req.Session()
        s.headers.update({
            "apikey":        SERVICE_ROLE_KEY,
            "Authorization": "Bearer " + SERVICE_ROLE_KEY,
            "Content-Type":  "application/json",
            "Accept":        "application/json",
            "Prefer":        "return=representation",
        })
        _session_local.pub = s
    return _session_local.pub

def _now():
    return datetime.now(timezone.utc).isoformat()

def _safe_int(v):
    try:
        return int(v) if v is not None else None
    except (ValueError, TypeError):
        return None

def _safe_float(v):
    try:
        return float(v) if v is not None else None
    except (ValueError, TypeError):
        return None

def _jdumps(v):
    if v is None:
        return "[]"
    if isinstance(v, str):
        return v
    return json.dumps([str(x) for x in v if x])

# ── Tiered pricing model (this batch only) ────────────────────────────────────
def compute_dallas_rent(original_rent, seen_rents=None):
    """
    Apply Dallas GA batch tiered pricing rules.

    Tiers:
      $1,250              → $1,250 (publish as-is)
      $1,251–$1,299       → proportional → $1,200–$1,250
      $1,300–$1,349       → proportional → $1,175–$1,225
      $1,350–$1,399       → proportional → $1,150–$1,200
      $1,400–$1,449       → proportional → $1,150–$1,200
      $1,450–$1,500       → proportional → $1,200–$1,250 (cap $1,250)

    Uniqueness: if `seen_rents` is provided (a set), shift the result by ±$5
    to avoid duplicate published rents where a natural variation is possible.

    Returns (published_rent_int, original_rent) or (None, None) if out of scope.
    """
    if original_rent is None:
        return None, None
    rent = float(original_rent)
    if rent < RENT_MIN or rent > RENT_MAX:
        return None, None

    if rent <= 1250:
        published = 1250.0
    elif rent <= 1299:
        # $1,251–$1,299 → $1,200–$1,250
        ratio = (rent - 1251) / (1299 - 1251)
        published = 1200.0 + ratio * (1250 - 1200)
    elif rent <= 1349:
        # $1,300–$1,349 → $1,175–$1,225
        ratio = (rent - 1300) / (1349 - 1300)
        published = 1175.0 + ratio * (1225 - 1175)
    elif rent <= 1399:
        # $1,350–$1,399 → $1,150–$1,200
        ratio = (rent - 1350) / (1399 - 1350)
        published = 1150.0 + ratio * (1200 - 1150)
    elif rent <= 1449:
        # $1,400–$1,449 → $1,150–$1,200
        ratio = (rent - 1400) / (1449 - 1400)
        published = 1150.0 + ratio * (1200 - 1150)
    else:
        # $1,450–$1,500 → $1,200–$1,250 (cap $1,250)
        ratio = (rent - 1450) / (1500 - 1450)
        published = 1200.0 + ratio * (1250 - 1200)

    # Round to nearest $5 for natural-looking prices
    published = round(published / 5) * 5
    # Hard cap
    published = min(int(published), RENT_CAP)

    # Uniqueness nudge: avoid duplicate published rents when possible
    if seen_rents is not None:
        for nudge in (0, -5, 5, -10, 10, -15, 15):
            candidate = published + nudge
            if candidate > RENT_CAP:
                continue
            if candidate < 1150:
                continue
            if candidate not in seen_rents:
                published = candidate
                break

    return int(published), original_rent

# ── Location validation ───────────────────────────────────────────────────────
def _city_tier(city_str):
    """Return 'primary', 'fallback', or None."""
    if not city_str:
        return None
    c = city_str.lower().strip()
    if c in PRIMARY_CITIES:
        return "primary"
    if c in FALLBACK_CITIES:
        return "fallback"
    return None

# ── URL builder (mirrors /rent/[state]/[city]/[slug].js logic) ────────────────
def _slug(s):
    """Slugify a string: lowercase, NFKD, strip accents, replace non-alnum with '-'."""
    if not s:
        return ""
    s = str(s).lower().strip()
    # Simple ASCII transliteration (no unicodedata needed for GA city names)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s[:60]

def build_property_url(prop_row):
    """
    Build the canonical public URL for a published property row.
    Pattern (from functions/rent/[state]/[city]/[slug].js):
      /rent/{state}/{city}/{beds}br-{type}-{prop_id_lower}/
    """
    state   = (prop_row.get("state") or "").lower()[:2]
    city    = _slug(prop_row.get("city") or "")
    beds    = prop_row.get("bedrooms")
    ptype   = _slug(prop_row.get("property_type") or "home")
    prop_id = (prop_row.get("id") or "").lower()

    beds_str = "{}br".format(beds) if beds else "home"
    slug = "{}-{}-{}".format(beds_str, ptype, prop_id)

    return "{}/rent/{}/{}/{}/".format(SITE_BASE_URL, state, city, slug)

# ── Scrape one location ───────────────────────────────────────────────────────
def scrape_location(location, past_days, limit):
    print("\n{}".format("─" * 55))
    print("🏠  Scraping: {}".format(location))
    print("{}".format("─" * 55))
    if not _HH_OK or not _SCRAPER_OK:
        print("   Skipping — dependencies unavailable")
        return []
    try:
        props = scrape_property(
            location=location,
            listing_type="for_rent",
            past_days=past_days,
            return_type="pydantic",
            limit=limit,
            beds_min=BEDS_EXACT,
            beds_max=BEDS_EXACT,
            price_min=RENT_MIN,
            price_max=RENT_MAX,
            extra_property_data=True,
        )
    except (InvalidListingType, AuthenticationError) as e:
        print("   ❌  {}".format(e))
        return []
    except Exception as e:
        print("   ❌  {}".format(e))
        return []

    print("   HomeHarvest returned {} listing(s)".format(len(props)))
    recs = []
    for p in props:
        try:
            recs.append(_map_realtor_property(p))
        except Exception:
            pass
    print("   Mapped {} records".format(len(recs)))
    return recs

# ── Filter ────────────────────────────────────────────────────────────────────
def filter_records(records):
    """
    Filter records against all Dallas batch criteria.
    Allows fallback cities (primary GA cities often have thin inventory).
    """
    kept, dropped = [], []
    for rec in records:
        issues = []

        # Competitor-branded listing
        if _ENRICH_OK and is_watermarked(rec):
            issues.append("competitor-branded")

        # State must be GA
        state = (rec.get("state") or "").upper()
        if state and state != "GA":
            issues.append("state={}".format(state))

        # City must be in target or fallback areas
        tier = _city_tier(rec.get("city"))
        if tier is None:
            issues.append("city not in target area: {}".format(rec.get("city")))

        # Property type — houses and townhouses only
        ptype = (rec.get("property_type") or "").upper()
        if ptype not in ALLOWED_TYPES:
            issues.append("type={}".format(ptype))

        # Bedrooms — exactly 3
        beds = _safe_int(rec.get("bedrooms"))
        if beds != BEDS_EXACT:
            issues.append("beds={}".format(beds))

        # Bathrooms — must be present and at least 2
        baths = _safe_float(rec.get("bathrooms"))
        if baths is None:
            issues.append("baths=missing")
        elif baths < BATHS_MIN:
            issues.append("baths={}".format(baths))

        # Rent range
        rent = rec.get("monthly_rent")
        if rent is None or rent < RENT_MIN or rent > RENT_MAX:
            issues.append("rent=${}".format(rent))

        # Must have at least one source image URL
        src_imgs = []
        try:
            src_imgs = json.loads(rec.get("original_image_urls") or "[]")
        except (ValueError, TypeError):
            pass
        if not src_imgs:
            issues.append("no source images")

        if issues:
            addr = "{} {}".format(rec.get("address", ""), rec.get("city", "")).strip()
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
                    addr = "{} {}".format(rec.get("address", ""), rec.get("city", "")).strip()
                    dropped.append((addr, ["all photos removed by brand filter"]))
                    continue
            kept.append(rec)
    return kept, dropped

# ── Price adjustment ──────────────────────────────────────────────────────────
def apply_pricing_batch(records):
    """
    Apply the tiered pricing model to all records.
    Tracks seen rents to maximise published-price variety.
    Returns list of records with updated monthly_rent and security_deposit.
    """
    seen_rents = set()
    price_changes = 0
    for rec in records:
        orig = rec.get("monthly_rent")
        published, _ = compute_dallas_rent(orig, seen_rents)
        if published is None:
            # Out of scope — shouldn't happen post-filter, but guard anyway
            continue
        seen_rents.add(published)
        if orig != published:
            price_changes += 1
        rec["monthly_rent"]     = published
        rec["security_deposit"] = published
    return records, price_changes

# ── Description cleanup ───────────────────────────────────────────────────────
def clean_desc(rec):
    """
    Run the full description enrichment pipeline on one record.
    Enforces all platform rules:
      • remove tour/showing/contact CTAs
      • remove external application instructions
      • remove property manager/owner references → replace with Choice Properties
      • remove third-party branding
      • normalize application fee to $50
      • enforce price consistency (rent + deposit match published values)
      • append apply CTA
    """
    text = rec.get("description") or ""
    if not text or not _ENRICH_OK:
        return rec
    text = clean_description(text)
    text = strip_external_application_instructions(text)
    text = replace_owner_manager_references(text)
    text = strip_third_party_branding(text)
    try:
        text = normalize_application_fee_in_description(text)
    except Exception:
        pass
    text = enforce_price_consistency(text, rec.get("monthly_rent"))
    text = append_apply_cta(text)
    rec["description"] = text
    return rec

# ── Validation ────────────────────────────────────────────────────────────────
def validate(rec):
    """
    Pre-publish validation gate. All checks must pass.
    Returns (True, []) on success, (False, [failures]) on fail.
    """
    fails = []

    # Location
    tier = _city_tier(rec.get("city"))
    if tier is None:
        fails.append("city not in target area: {}".format(rec.get("city")))
    state = (rec.get("state") or "").upper()
    if state and state != "GA":
        fails.append("state={}".format(state))

    # Property type
    ptype = (rec.get("property_type") or "").upper()
    if ptype not in ALLOWED_TYPES:
        fails.append("type={}".format(ptype))

    # Bedrooms
    if _safe_int(rec.get("bedrooms")) != BEDS_EXACT:
        fails.append("beds={}".format(rec.get("bedrooms")))

    # Bathrooms — must be present and at least 2
    baths = _safe_float(rec.get("bathrooms"))
    if baths is None:
        fails.append("baths=missing")
    elif baths < BATHS_MIN:
        fails.append("baths={}".format(baths))

    # Rent cap
    rent = rec.get("monthly_rent")
    if rent is None or rent > RENT_CAP:
        fails.append("published rent=${} exceeds cap ${}".format(rent, RENT_CAP))

    # Security deposit must equal published rent
    dep = rec.get("security_deposit")
    if dep is not None and rent is not None and dep != rent:
        fails.append("deposit=${} != rent=${}".format(dep, rent))

    # Required fields
    for f in ("title", "address", "city", "state", "zip", "monthly_rent"):
        if not rec.get(f):
            fails.append("missing {}".format(f))

    # Source images required for photo import
    src_imgs = []
    try:
        src_imgs = json.loads(rec.get("original_image_urls") or "[]")
    except (ValueError, TypeError):
        pass
    if not src_imgs:
        fails.append("no source images for photo import")

    return len(fails) == 0, fails

# ── Fetch existing pipeline IDs ───────────────────────────────────────────────
def fetch_pipeline_id_map(source_ids):
    """Return {source_listing_id: pipeline_id} for records already in pipeline."""
    if not source_ids:
        return {}
    result = {}
    chunk_size = 100
    for i in range(0, len(source_ids), chunk_size):
        chunk = source_ids[i:i + chunk_size]
        encoded = urllib.parse.quote(",".join(chunk))
        r = _pipeline_session().get(
            "{}/rest/v1/pipeline_properties"
            "?source_listing_id=in.({})&select=id,source_listing_id&limit=1000".format(
                SUPABASE_URL, encoded),
            timeout=20,
        )
        try:
            r.raise_for_status()
            for row in r.json():
                result[row["source_listing_id"]] = row["id"]
        except Exception as e:
            print("   ⚠  fetch_pipeline_id_map error: {}".format(e))
    return result

# ── Stage in pipeline and resolve actual IDs ──────────────────────────────────
def stage_and_resolve(records):
    """Insert new records; skip duplicates. Resolves each rec['id'] to actual pipeline ID."""
    if not records:
        return records

    source_ids = [r.get("source_listing_id", "") for r in records
                  if r.get("source_listing_id")]
    existing_map = fetch_pipeline_id_map(source_ids)

    new_records = [r for r in records
                   if r.get("source_listing_id", "") not in existing_map]
    print("   Dedup: {} already in pipeline, {} new".format(
        len(records) - len(new_records), len(new_records)))

    inserted = 0
    for i in range(0, len(new_records), 50):
        batch = new_records[i:i + 50]
        url = "{}/rest/v1/pipeline_properties?on_conflict=source_listing_id".format(SUPABASE_URL)
        r = _pipeline_session().post(
            url,
            data=json.dumps(batch, default=str).encode(),
            headers={"Prefer": "return=representation,resolution=ignore-duplicates"},
            timeout=30,
        )
        try:
            r.raise_for_status()
            data = r.json()
            cnt = len(data) if isinstance(data, list) else len(batch)
            inserted += cnt
            print("   ✅  Batch {}: {} staged".format(i // 50 + 1, cnt))
        except Exception as e:
            print("   ❌  Batch {} failed: {} — {}".format(i // 50 + 1, e, r.text[:200]))

    # Re-fetch IDs for newly inserted records
    if new_records:
        new_sids = [r.get("source_listing_id", "") for r in new_records]
        fresh = fetch_pipeline_id_map(new_sids)
        existing_map.update(fresh)

    # Update rec["id"] to actual pipeline ID for all records
    resolved = []
    for rec in records:
        sid = rec.get("source_listing_id", "")
        if sid in existing_map:
            rec["id"] = existing_map[sid]
        resolved.append(rec)

    return resolved

# ── Publish via pipeline_publish RPC ─────────────────────────────────────────
def publish_listing(pipeline_id):
    """
    Call pipeline_publish RPC. Returns (choice_property_id, error_str_or_None).
    """
    r = _public_session().post(
        "{}/rest/v1/rpc/pipeline_publish".format(SUPABASE_URL),
        json={"p_id": pipeline_id, "p_landlord_id": None},
        timeout=30,
    )
    try:
        r.raise_for_status()
        data = r.json()
        if isinstance(data, list):
            data = data[0] if data else {}
        if data.get("ok") is False:
            return None, data.get("error", "RPC returned ok=false")
        prop_id = (data.get("choice_property_id") or
                   data.get("property_id") or
                   data.get("id"))
        return prop_id, None
    except Exception as e:
        return None, "{} — {}".format(e, r.text[:200])

# ── Import photos via edge function ──────────────────────────────────────────
def import_photos(property_id):
    """
    Call import-pipeline-photos edge function.
    Returns (transferred_count, skipped_count, error_str_or_None).
    """
    try:
        r = _req.post(
            "{}/functions/v1/import-pipeline-photos".format(SUPABASE_URL),
            headers={
                "Authorization": "Bearer " + SERVICE_ROLE_KEY,
                "Content-Type":  "application/json",
            },
            json={"property_id": property_id},
            timeout=120,
        )
        r.raise_for_status()
        data = r.json()
        return data.get("transferred", 0), data.get("skipped", 0), None
    except Exception as e:
        return 0, 0, str(e)[:200]

# ── Fetch published property row for URL construction ─────────────────────────
def fetch_property_row(choice_property_id):
    """Fetch id, city, state, property_type, bedrooms from public.properties."""
    try:
        r = _public_session().get(
            "{}/rest/v1/properties"
            "?id=eq.{}&select=id,city,state,property_type,bedrooms&limit=1".format(
                SUPABASE_URL, urllib.parse.quote(choice_property_id)),
            timeout=15,
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None
    except Exception:
        return None

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Dallas, GA rental batch — scrape & publish")
    ap.add_argument("--dry-run",   action="store_true", help="Preview without writing to DB")
    ap.add_argument("--target",    type=int, default=15,  help="Number of listings to publish")
    ap.add_argument("--past-days", type=int, default=90,  help="Realtor.com lookback window")
    ap.add_argument("--limit",     type=int, default=200, help="Max listings per location")
    ap.add_argument("--min-score", type=int, default=30,  help="Minimum data quality score")
    args = ap.parse_args()

    print("=" * 65)
    print("Dallas, GA Rental Batch — Scrape & Publish")
    print("Target: {} listings | Past {} days | Dry run: {}".format(
        args.target, args.past_days, args.dry_run))
    print("Criteria: 3BR | 2+ BA | ${:,}–${:,}/mo scraped → cap ${:,}".format(
        RENT_MIN, RENT_MAX, RENT_CAP))
    print("Types: {} (NO apartments/condos/duplexes)".format(", ".join(sorted(ALLOWED_TYPES))))
    print("=" * 65)

    # ── Phase 1: Scrape all locations ─────────────────────────────────────────
    print("\n── Phase 1: Scraping ──")
    all_recs = []
    for loc in TARGET_LOCATIONS + FALLBACK_LOCATIONS:
        recs = scrape_location(loc, past_days=args.past_days, limit=args.limit)
        all_recs.extend(recs)

    # Within-batch dedup by source_listing_id
    seen_sids, unique = set(), []
    for r in all_recs:
        sid = r.get("source_listing_id", "")
        if sid and sid in seen_sids:
            continue
        seen_sids.add(sid)
        unique.append(r)
    print("\n🔢  Raw: {} | After within-batch dedup: {}".format(len(all_recs), len(unique)))
    all_recs = unique

    if not all_recs:
        print("❌  No listings found. Try --past-days 120 or check GA market inventory.")
        sys.exit(1)

    # ── Phase 2: Realtor.com detail-page enrichment ───────────────────────────
    if _SCRAPER_OK:
        print("\n── Phase 2: Detail-page enrichment ──")
        all_recs = _enrich_realtor_batch(all_recs, verbose=True)

    # ── Phase 3: Filter ───────────────────────────────────────────────────────
    print("\n── Phase 3: Filtering ──")
    kept, dropped = filter_records(all_recs)
    print("   Kept: {} | Dropped: {}".format(len(kept), len(dropped)))
    for addr, reasons in dropped[:20]:
        print("   [DROP] {} — {}".format(addr, ", ".join(reasons)))
    if len(dropped) > 20:
        print("   ... and {} more dropped".format(len(dropped) - 20))

    # Quality floor
    pre = len(kept)
    kept = [r for r in kept if r.get("data_quality_score", 0) >= args.min_score]
    print("   After quality floor ({}): {}/{}".format(args.min_score, len(kept), pre))

    if not kept:
        print("❌  No listings passed filters. Tips:")
        print("   • Try --past-days 120 or --past-days 180")
        print("   • Lower --min-score to 20")
        sys.exit(1)

    # ── Phase 4: Price adjustment ─────────────────────────────────────────────
    print("\n── Phase 4: Tiered pricing adjustment ──")
    kept, price_changes = apply_pricing_batch(kept)
    print("   {} listings adjusted | all deposits set to match published rent".format(price_changes))
    print("   Price cap: ${:,}/mo".format(RENT_CAP))

    # ── Phase 5: Description cleanup ──────────────────────────────────────────
    print("\n── Phase 5: Description cleanup ──")
    for rec in kept:
        clean_desc(rec)
    print("   Cleaned {} descriptions".format(len(kept)))

    # ── Phase 6: Validation ───────────────────────────────────────────────────
    print("\n── Phase 6: Validation ──")
    valid, invalid = [], []
    for rec in kept:
        ok, fails = validate(rec)
        if ok:
            valid.append(rec)
        else:
            addr = "{} {}".format(rec.get("address", ""), rec.get("city", "")).strip()
            invalid.append((addr, fails))
            print("   [FAIL] {}: {}".format(addr, ", ".join(fails)))
    print("   Valid: {} | Invalid: {}".format(len(valid), len(invalid)))

    if not valid:
        print("❌  No listings passed validation.")
        sys.exit(1)

    # Sort: primary cities first (Dallas/Hiram/Powder Springs/Acworth), then quality
    valid.sort(key=lambda r: (
        0 if _city_tier(r.get("city")) == "primary" else 1,
        -r.get("data_quality_score", 0),
    ))

    to_publish = valid[:args.target]
    print("\n   Selecting top {}/{} for publishing".format(len(to_publish), len(valid)))
    for i, rec in enumerate(to_publish, 1):
        addr   = "{} {}".format(rec.get("address", ""), rec.get("city", "")).strip()
        rent   = rec.get("monthly_rent")
        score  = rec.get("data_quality_score", 0)
        baths  = rec.get("bathrooms")
        src_ct = 0
        try:
            src_ct = len(json.loads(rec.get("original_image_urls") or "[]"))
        except Exception:
            pass
        print("   {:2}. {} | ${}/mo | {}BA | score={} | {} source photos".format(
            i, addr, rent, baths, score, src_ct))

    if args.dry_run:
        print("\n⚠  DRY RUN — stopping before any database writes.")
        print("   Would publish {} listing(s).".format(len(to_publish)))
        return

    # ── Phase 7: Stage in pipeline + resolve actual IDs ──────────────────────
    print("\n── Phase 7: Staging {} records in pipeline ──".format(len(to_publish)))
    to_publish = stage_and_resolve(to_publish)
    print("   All records have resolved pipeline IDs")

    # Patch pricing + description on pipeline records (covers pre-existing records too)
    print("\n   Patching pricing + descriptions on pipeline records...")
    for rec in to_publish:
        pid = rec["id"]
        r = _pipeline_session().patch(
            "{}/rest/v1/pipeline_properties?id=eq.{}".format(SUPABASE_URL, pid),
            json={
                "monthly_rent":     rec.get("monthly_rent"),
                "security_deposit": rec.get("security_deposit"),
                "description":      rec.get("description"),
            },
            timeout=20,
        )
        if not r.ok:
            print("   ⚠  PATCH failed for {}: {}".format(pid, r.text[:100]))

    # Fetch current pipeline statuses (skip already-published)
    def _fetch_statuses(ids):
        if not ids:
            return {}
        encoded = urllib.parse.quote(",".join(ids))
        r = _pipeline_session().get(
            "{}/rest/v1/pipeline_properties"
            "?id=in.({})&select=id,status,choice_property_id&limit=1000".format(
                SUPABASE_URL, encoded),
            timeout=20,
        )
        result = {}
        if r.ok:
            for row in r.json():
                result[row["id"]] = row
        return result

    statuses = _fetch_statuses([r["id"] for r in to_publish])

    # ── Phase 8: Publish + import photos ─────────────────────────────────────
    print("\n── Phase 8: Publishing + importing photos ──")
    published    = []   # [(pipeline_id, choice_property_id, full_addr, rec)]
    photo_ok     = []
    photo_fail   = []

    for rec in to_publish:
        addr = "{} {} {}".format(
            rec.get("address", ""), rec.get("city", ""), rec.get("state", "")).strip()
        pid  = rec["id"]

        current          = statuses.get(pid, {})
        existing_prop_id = current.get("choice_property_id")

        if current.get("status") == "published" and existing_prop_id:
            print("   ♻️   Already published: {} → {}".format(addr, existing_prop_id))
            published.append((pid, existing_prop_id, addr, rec))
            # Still retry photo import in case it wasn't completed
            print("      Importing photos...", end=" ", flush=True)
            transferred, skipped, photo_err = import_photos(existing_prop_id)
            if photo_err:
                print("⚠  {}".format(photo_err))
                photo_fail.append((addr, photo_err))
            elif transferred == 0 and skipped > 0:
                print("✅  Photos already present ({} skipped)".format(skipped))
                photo_ok.append((addr, skipped))
            elif transferred > 0:
                print("✅  {} photo(s) added".format(transferred))
                photo_ok.append((addr, transferred))
            else:
                print("⚠  0 transferred, 0 skipped — check pipeline record")
                photo_fail.append((addr, "0 photos transferred or skipped"))
            continue

        # Publish via pipeline_publish RPC
        prop_id, err = publish_listing(pid)
        if err:
            print("   ❌  PUBLISH FAILED: {} — {}".format(addr, err))
            continue

        print("   ✅  Published: {}".format(addr))
        print("      → property_id={}".format(prop_id))
        published.append((pid, prop_id, addr, rec))

        # Import photos: download → ImageKit → property_photos table
        print("      Importing photos...", end=" ", flush=True)
        transferred, skipped, photo_err = import_photos(prop_id)
        if photo_err:
            print("⚠  {}".format(photo_err))
            photo_fail.append((addr, photo_err))
        elif transferred == 0:
            print("⚠  0 photos transferred (skipped={}) — check source images".format(skipped))
            photo_fail.append((addr, "0 photos transferred"))
        else:
            print("✅  {} photo(s) on ImageKit".format(transferred))
            photo_ok.append((addr, transferred))

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n" + "=" * 65)
    print("SUMMARY")
    print("=" * 65)
    print("Scraped (raw)           : {}".format(len(all_recs)))
    print("Passed filters          : {}".format(len(kept)))
    print("Passed validation       : {}".format(len(valid)))
    print("Selected to publish     : {}".format(len(to_publish)))
    print("Successfully published  : {}".format(len(published)))
    print("Photos OK (ImageKit)    : {}".format(len(photo_ok)))
    print("Photo import issues     : {}".format(len(photo_fail)))

    if photo_fail:
        print("\nListings with photo issues:")
        for addr, err in photo_fail:
            print("  ⚠  {}: {}".format(addr, err))
        print("  → Use 'Import source photos' button on each property-detail page to retry")

    if len(published) < args.target:
        shortfall = args.target - len(published)
        print("\n⚠  {} short of target {}.".format(shortfall, args.target))
        print("   Tips:")
        print("   • Re-run with --past-days {}".format(args.past_days * 2))
        print("   • Add more fallback cities (edit FALLBACK_LOCATIONS)")
        print("   • {} listings failed validation — review failures above".format(len(invalid)))

    # ── Post-Scraping Report ──────────────────────────────────────────────────
    if published:
        print("\n" + "=" * 65)
        print("POST-SCRAPING REPORT")
        print("Published Properties — Dallas, GA Batch")
        print("=" * 65)

        n = 0
        for _pid, prop_id, addr, rec in published:
            if not prop_id:
                continue
            n += 1

            # Try to fetch the live property row for canonical URL construction.
            # The row gives us the exact id, city, state, property_type, bedrooms
            # which the /rent/[state]/[city]/[slug].js route uses to build the URL.
            prop_row = fetch_property_row(prop_id)
            if prop_row:
                url = build_property_url(prop_row)
            else:
                # Fallback: construct from the pipeline record we already have
                fallback_row = {
                    "id":            prop_id,
                    "city":          rec.get("city", "dallas"),
                    "state":         rec.get("state", "GA"),
                    "property_type": rec.get("property_type", "SINGLE_FAMILY"),
                    "bedrooms":      rec.get("bedrooms", BEDS_EXACT),
                }
                url = build_property_url(fallback_row)

            # Full address: street + city + state + zip for the report
            full_addr = "{}, {} {} {}".format(
                rec.get("address", ""),
                rec.get("city", ""),
                rec.get("state", ""),
                rec.get("zip", ""),
            ).strip(", ")

            print("{}. {}\n   {}".format(n, full_addr, url))

        print("\n" + "=" * 65)
        print("✅  {} properties published and listed above.".format(n))
        print("Admin pipeline: {}/admin/pipeline.html".format(SITE_BASE_URL))

    print("\nDone.")


if __name__ == "__main__":
    main()
