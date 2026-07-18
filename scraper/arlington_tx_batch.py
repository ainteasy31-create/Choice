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
Image rule      : direct download → ImageKit upload → property_photos insert
                  (bypasses import-pipeline-photos edge function which returns 401)
Description     : remove tours/showings, external apps, third-party branding, old prices
Goal            : publish 10 listings that pass all validation checks

Pricing tiers (this batch only):
  $1,300–$1,400  → publish as-is (original rent)
  $1,401–$1,500  → proportional reduction → $1,300–$1,400
  $1,501–$1,600  → proportional reduction → $1,300–$1,400

Usage (from workspace root):
  python3 scraper/arlington_tx_batch.py
  python3 scraper/arlington_tx_batch.py --dry-run
  python3 scraper/arlington_tx_batch.py --target 10 --past-days 90
"""

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.parse
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
IK_PRIVATE_KEY   = os.environ.get("IMAGEKIT_PRIVATE_KEY", "").strip()
SITE_BASE_URL    = "https://choice-properties-site.pages.dev"

if not SERVICE_ROLE_KEY:
    sys.exit("❌  SUPABASE_SERVICE_ROLE_KEY not set.")
if not IK_PRIVATE_KEY:
    sys.exit("❌  IMAGEKIT_PRIVATE_KEY not set.")

IK_UPLOAD_URL  = "https://upload.imagekit.io/api/v1/files/upload"
IK_AUTH_HEADER = "Basic " + base64.b64encode((IK_PRIVATE_KEY + ":").encode()).decode()

# ── Batch constants ───────────────────────────────────────────────────────────
TARGET_LOCATIONS = [
    "Arlington, TX",
    "Euless, TX",
    "Grapevine, TX",
]
# Thin DFW mid-cities fallbacks — only used if primary cities can't fill target
FALLBACK_LOCATIONS = [
    "Bedford, TX",
    "Hurst, TX",
    "North Richland Hills, TX",
    "Richland Hills, TX",
    "Grand Prairie, TX",
    "Irving, TX",
    "Mansfield, TX",
    "Keller, TX",
    "Fort Worth, TX",
    "Colleyville, TX",
]

PRIMARY_CITIES  = {"arlington", "euless", "grapevine"}
FALLBACK_CITIES = {
    "bedford", "hurst", "north richland hills", "richland hills",
    "grand prairie", "irving", "mansfield", "keller", "fort worth",
    "colleyville", "southlake", "haltom city", "watauga",
}

ALLOWED_TYPES = {"SINGLE_FAMILY", "TOWNHOMES"}
BEDS_EXACT    = 2
BATHS_MIN     = 1.0
BATHS_MAX     = 2.0
RENT_MIN      = 1300
RENT_MAX      = 1600
RENT_CAP      = 1400    # maximum published monthly rent
RENT_FLOOR    = 1300    # minimum published monthly rent

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

# ── HTTP session helpers ───────────────────────────────────────────────────────
_session_local = threading.local()

def _pipeline_session():
    if not hasattr(_session_local, "pipe"):
        s = _req.Session()
        retry = Retry(total=3, backoff_factor=0.5, status_forcelist=[500, 502, 503, 504],
                      allowed_methods=["GET", "POST", "PATCH"])
        s.mount("https://", HTTPAdapter(max_retries=retry))
        s.headers.update({
            "apikey":          SERVICE_ROLE_KEY,
            "Authorization":   "Bearer " + SERVICE_ROLE_KEY,
            "Content-Type":    "application/json",
            "Accept":          "application/json",
            "Accept-Profile":  "pipeline",
            "Content-Profile": "pipeline",
            "Prefer":          "return=representation",
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

# ── Tiered pricing model ───────────────────────────────────────────────────────
def compute_arlington_rent(original_rent, seen_rents=None):
    """
    Apply Arlington TX batch pricing rules.

    Tiers:
      $1,300–$1,400  → publish as-is
      $1,401–$1,500  → proportional → $1,300–$1,400
      $1,501–$1,600  → proportional → $1,300–$1,400

    Uses uniqueness nudge to avoid duplicate published rents.
    Returns (published_rent_int, original_rent_float) or (None, None).
    """
    if original_rent is None:
        return None, None
    rent = float(original_rent)
    if rent < RENT_MIN or rent > RENT_MAX:
        return None, None

    if rent <= 1400:
        # Publish as-is — already within target
        published = rent
    elif rent <= 1500:
        # $1,401–$1,500 → proportional → $1,300–$1,400
        ratio     = (rent - 1401) / (1500 - 1401)
        published = RENT_FLOOR + ratio * (RENT_CAP - RENT_FLOOR)
    else:
        # $1,501–$1,600 → proportional → $1,300–$1,400
        ratio     = (rent - 1501) / (1600 - 1501)
        published = RENT_FLOOR + ratio * (RENT_CAP - RENT_FLOOR)

    # Round to nearest $5 for natural pricing
    published = round(published / 5) * 5
    published = max(RENT_FLOOR, min(int(published), RENT_CAP))

    # Uniqueness nudge
    if seen_rents is not None:
        for nudge in (0, 5, -5, 10, -10, 15, -15, 20, -20):
            candidate = published + nudge
            if candidate < RENT_FLOOR or candidate > RENT_CAP:
                continue
            if candidate not in seen_rents:
                published = candidate
                break

    return int(published), rent

# ── Location helpers ──────────────────────────────────────────────────────────
def _city_tier(city_str):
    if not city_str:
        return None
    c = city_str.lower().strip()
    if c in PRIMARY_CITIES:
        return "primary"
    if c in FALLBACK_CITIES:
        return "fallback"
    return None

# ── URL builder ───────────────────────────────────────────────────────────────
def _slug(s):
    if not s:
        return ""
    s = str(s).lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:60]

def build_property_url(prop_row):
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
def filter_records(records, allow_fallback=False):
    kept, dropped = [], []
    for rec in records:
        issues = []

        # Watermarked/competitor-branded
        if _ENRICH_OK and is_watermarked(rec):
            issues.append("competitor-branded")

        # State must be TX
        state = (rec.get("state") or "").upper()
        if state and state != "TX":
            issues.append("state={}".format(state))

        # City
        tier = _city_tier(rec.get("city"))
        if tier is None:
            issues.append("city not in target: {}".format(rec.get("city")))
        elif tier == "fallback" and not allow_fallback:
            issues.append("fallback city (primary-only pass): {}".format(rec.get("city")))

        # Property type
        ptype = (rec.get("property_type") or "").upper()
        if ptype not in ALLOWED_TYPES:
            issues.append("type={}".format(ptype))

        # Bedrooms — exactly 2
        beds = _safe_int(rec.get("bedrooms"))
        if beds != BEDS_EXACT:
            issues.append("beds={}".format(beds))

        # Bathrooms — 1 or 2 (must be present)
        baths = _safe_float(rec.get("bathrooms"))
        if baths is None:
            issues.append("baths=missing")
        elif baths < BATHS_MIN:
            issues.append("baths={} (< {})".format(baths, BATHS_MIN))
        elif baths > BATHS_MAX:
            issues.append("baths={} (> {})".format(baths, BATHS_MAX))

        # Rent range
        rent = rec.get("monthly_rent")
        if rent is None or rent < RENT_MIN or rent > RENT_MAX:
            issues.append("rent=${}".format(rent))

        # Must have at least 6 source images (sparse galleries look poor on the site)
        src_imgs = []
        try:
            src_imgs = json.loads(rec.get("original_image_urls") or "[]")
        except (ValueError, TypeError):
            pass
        if len(src_imgs) < 6:
            issues.append("too few photos ({}/6 minimum)".format(len(src_imgs)))

        if issues:
            addr = "{} {}".format(rec.get("address", ""), rec.get("city", "")).strip()
            dropped.append((addr, issues))
        else:
            if _ENRICH_OK:
                rec = filter_record_photos(rec)
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

# ── Pricing ───────────────────────────────────────────────────────────────────
def apply_pricing_batch(records):
    seen_rents   = set()
    price_changes = 0
    for rec in records:
        orig = rec.get("monthly_rent")
        published, _ = compute_arlington_rent(orig, seen_rents)
        if published is None:
            continue
        seen_rents.add(published)
        if orig != published:
            price_changes += 1
        rec["monthly_rent"]     = published
        rec["security_deposit"] = published
    return records, price_changes

# ── Description cleanup ───────────────────────────────────────────────────────
def clean_desc(rec):
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
    fails = []

    # Location (primary or fallback)
    tier = _city_tier(rec.get("city"))
    if tier is None:
        fails.append("city not in target: {}".format(rec.get("city")))
    state = (rec.get("state") or "").upper()
    if state and state != "TX":
        fails.append("state={}".format(state))

    # Property type
    ptype = (rec.get("property_type") or "").upper()
    if ptype not in ALLOWED_TYPES:
        fails.append("type={}".format(ptype))

    # Bedrooms
    if _safe_int(rec.get("bedrooms")) != BEDS_EXACT:
        fails.append("beds={}".format(rec.get("bedrooms")))

    # Bathrooms
    baths = _safe_float(rec.get("bathrooms"))
    if baths is None:
        fails.append("baths=missing")
    elif baths < BATHS_MIN:
        fails.append("baths={} (< {})".format(baths, BATHS_MIN))

    # Published rent must be $1,300–$1,400
    rent = rec.get("monthly_rent")
    if rent is None or rent < RENT_FLOOR or rent > RENT_CAP:
        fails.append("published rent=${} (must be ${:,}–${:,})".format(rent, RENT_FLOOR, RENT_CAP))

    # Security deposit matches published rent
    dep = rec.get("security_deposit")
    if dep is not None and rent is not None and int(dep) != int(rent):
        fails.append("deposit=${} != rent=${}".format(dep, rent))

    # Required fields
    for f in ("title", "address", "city", "state", "zip", "monthly_rent"):
        if not rec.get(f):
            fails.append("missing {}".format(f))

    # Minimum 6 source images required
    src_imgs = []
    try:
        src_imgs = json.loads(rec.get("original_image_urls") or "[]")
    except (ValueError, TypeError):
        pass
    if len(src_imgs) < 6:
        fails.append("too few photos ({}/6 minimum)".format(len(src_imgs)))

    return len(fails) == 0, fails

# ── Pipeline helpers ──────────────────────────────────────────────────────────
def fetch_pipeline_id_map(source_ids):
    if not source_ids:
        return {}
    result = {}
    for i in range(0, len(source_ids), 100):
        chunk = source_ids[i:i + 100]
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

def stage_and_resolve(records):
    if not records:
        return records
    source_ids   = [r.get("source_listing_id", "") for r in records if r.get("source_listing_id")]
    existing_map = fetch_pipeline_id_map(source_ids)
    new_records  = [r for r in records if r.get("source_listing_id", "") not in existing_map]
    print("   Dedup: {} already in pipeline, {} new".format(
        len(records) - len(new_records), len(new_records)))

    for i in range(0, len(new_records), 50):
        batch = new_records[i:i + 50]
        r = _pipeline_session().post(
            "{}/rest/v1/pipeline_properties?on_conflict=source_listing_id".format(SUPABASE_URL),
            data=json.dumps(batch, default=str).encode(),
            headers={"Prefer": "return=representation,resolution=ignore-duplicates"},
            timeout=30,
        )
        try:
            r.raise_for_status()
            data = r.json()
            print("   ✅  Batch {}: {} staged".format(i // 50 + 1,
                  len(data) if isinstance(data, list) else len(batch)))
        except Exception as e:
            print("   ❌  Batch {} failed: {} — {}".format(i // 50 + 1, e, r.text[:200]))

    if new_records:
        new_sids = [r.get("source_listing_id", "") for r in new_records]
        existing_map.update(fetch_pipeline_id_map(new_sids))

    resolved = []
    for rec in records:
        sid = rec.get("source_listing_id", "")
        if sid in existing_map:
            rec["id"] = existing_map[sid]
        resolved.append(rec)
    return resolved

def publish_listing(pipeline_id):
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

def activate_property(prop_id):
    """PATCH status to active (pipeline_publish creates draft)."""
    r = _public_session().patch(
        "{}/rest/v1/properties?id=eq.{}".format(SUPABASE_URL, urllib.parse.quote(prop_id)),
        json={"status": "active"},
        timeout=15,
    )
    return r.ok

# ── Direct ImageKit photo import ───────────────────────────────────────────────
# Bypass import-pipeline-photos edge function (returns 401 from Replit).
# Pattern: download bytes from CDN (non-streaming) → upload to IK → insert property_photos.
_DL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
    "Accept":     "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Referer":    "https://www.realtor.com/",
}
_IK_MAX_WORKERS = 4
_IK_MAX_PHOTOS  = 20

def _upload_one_photo(prop_id, idx, src_url):
    """Download src_url and upload to ImageKit. Returns (idx, ik_url, file_id, err)."""
    folder = "/properties/{}".format(prop_id)
    # Download (non-streaming — reliable in threads; stream=True silently fails)
    try:
        rd = _req.get(src_url, headers=_DL_HEADERS, timeout=25)
        if rd.status_code != 200 or not rd.content:
            return idx, None, None, "dl {}".format(rd.status_code)
        data = rd.content
        if len(data) > 20 * 1024 * 1024:
            return idx, None, None, "too large"
        ct  = rd.headers.get("Content-Type", "")
        ext = "webp" if ("webp" in ct or ".webp" in src_url) else "jpg"
    except Exception as e:
        return idx, None, None, "dl: {}".format(str(e)[:60])

    # Upload bytes to ImageKit
    fname = "photo_{:02d}.{}".format(idx + 1, ext)
    mime  = "image/{}".format(ext)
    try:
        ru = _req.post(
            IK_UPLOAD_URL,
            headers={"Authorization": IK_AUTH_HEADER},
            files={"file": (fname, data, mime)},
            data={"fileName": fname, "folder": folder},
            timeout=60,
        )
        if ru.status_code != 200:
            return idx, None, None, "ik {}: {}".format(ru.status_code, ru.text[:60])
        d = ru.json()
        return idx, d.get("url"), d.get("fileId"), None
    except Exception as e:
        return idx, None, None, "ik: {}".format(str(e)[:60])

def import_photos_direct(prop_id, src_urls, verbose=True):
    """
    Upload up to _IK_MAX_PHOTOS images to ImageKit, then insert into property_photos.
    Returns (uploaded_count, failed_count).
    """
    if not src_urls:
        return 0, 0

    # Deduplicate — keep full-size, skip thumbnail s.jpg
    seen, photo_urls = set(), []
    for u in src_urls:
        base = re.sub(r'(od-w\d+_h\d+_x\d+\.webp.*|s\.jpg)$', '', u.split("?")[0])
        if base in seen or u.endswith("s.jpg"):
            continue
        seen.add(base)
        photo_urls.append(u)
        if len(photo_urls) >= _IK_MAX_PHOTOS:
            break

    sb_headers = {
        "apikey":        SERVICE_ROLE_KEY,
        "Authorization": "Bearer " + SERVICE_ROLE_KEY,
        "Content-Type":  "application/json",
        "Prefer":        "return=minimal",
    }

    tasks    = [(prop_id, i, u) for i, u in enumerate(photo_urls)]
    results  = {}
    uploaded = 0
    failed   = 0

    with ThreadPoolExecutor(max_workers=_IK_MAX_WORKERS) as ex:
        futs = {ex.submit(_upload_one_photo, *t): t[1] for t in tasks}
        for fut in as_completed(futs):
            idx, ik_url, file_id, err = fut.result()
            if ik_url:
                results[idx] = (ik_url, file_id)
            else:
                failed += 1
                if verbose and err:
                    print("      ⚠  photo[{}]: {}".format(idx, err))

    # Insert in order (hero = index 0)
    for idx in sorted(results.keys()):
        ik_url, file_id = results[idx]
        ri = _req.post(
            "{}/rest/v1/property_photos".format(SUPABASE_URL),
            headers=sb_headers,
            json={
                "property_id":    prop_id,
                "url":            ik_url,
                "file_id":        file_id or "",
                "display_order":  idx,
                "is_hero":        idx == 0,
                "watermark_status": "pending",
            },
            timeout=15,
        )
        if ri.status_code in (200, 201):
            uploaded += 1
            if verbose and idx == 0:
                print("      ✅ hero → {}".format(ik_url))
        else:
            failed += 1
            if verbose:
                print("      ⚠  db insert[{}]: {} {}".format(idx, ri.status_code, ri.text[:60]))

    return uploaded, failed

# ── Fetch published property row ──────────────────────────────────────────────
def fetch_property_row(prop_id):
    try:
        r = _public_session().get(
            "{}/rest/v1/properties?id=eq.{}&select=id,city,state,property_type,bedrooms&limit=1".format(
                SUPABASE_URL, urllib.parse.quote(prop_id)),
            timeout=15,
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None
    except Exception:
        return None

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Arlington/Euless/Grapevine TX batch")
    ap.add_argument("--dry-run",   action="store_true")
    ap.add_argument("--target",    type=int, default=10)
    ap.add_argument("--past-days", type=int, default=90)
    ap.add_argument("--limit",     type=int, default=200)
    ap.add_argument("--min-score", type=int, default=40)
    ap.add_argument("--fallback",  action="store_true",
                    help="Also search fallback DFW cities if primary cities are thin")
    args = ap.parse_args()

    print("=" * 65)
    print("Arlington / Euless / Grapevine, TX — Scrape & Publish")
    print("Target: {} listings | Past {} days | Dry run: {}".format(
        args.target, args.past_days, args.dry_run))
    print("Criteria: 2BR | 1–2 BA | ${:,}–${:,}/mo scraped → ${:,}–${:,} published".format(
        RENT_MIN, RENT_MAX, RENT_FLOOR, RENT_CAP))
    print("Types: {} (NO apartments/condos/duplexes)".format(", ".join(sorted(ALLOWED_TYPES))))
    print("=" * 65)

    # ── Phase 1: Scrape ───────────────────────────────────────────────────────
    print("\n── Phase 1: Scraping primary locations ──")
    all_recs = []
    locations = TARGET_LOCATIONS + (FALLBACK_LOCATIONS if args.fallback else [])
    for loc in locations:
        recs = scrape_location(loc, past_days=args.past_days, limit=args.limit)
        all_recs.extend(recs)

    # Within-batch dedup
    seen_sids, unique = set(), []
    for r in all_recs:
        sid = r.get("source_listing_id", "")
        if sid and sid in seen_sids:
            continue
        seen_sids.add(sid)
        unique.append(r)
    print("\n🔢  Raw: {} | After dedup: {}".format(len(all_recs), len(unique)))
    all_recs = unique

    if not all_recs:
        print("❌  No listings found. Try --past-days 120 or --fallback.")
        sys.exit(1)

    # ── Phase 2: Enrichment ───────────────────────────────────────────────────
    if _SCRAPER_OK:
        print("\n── Phase 2: Detail-page enrichment ──")
        all_recs = _enrich_realtor_batch(all_recs, verbose=True)

    # ── Phase 3: Filter (primary-only first pass) ─────────────────────────────
    print("\n── Phase 3: Filtering ──")
    kept, dropped = filter_records(all_recs, allow_fallback=args.fallback)
    print("   Kept: {} | Dropped: {}".format(len(kept), len(dropped)))
    for addr, reasons in dropped[:20]:
        print("   [DROP] {} — {}".format(addr, ", ".join(reasons)))
    if len(dropped) > 20:
        print("   ... and {} more".format(len(dropped) - 20))

    # If short on primary-only and fallbacks not yet scraped, try fallbacks
    if len(kept) < args.target and not args.fallback:
        print("\n   ⚠  Only {} in primary cities — retrying with fallback cities...".format(len(kept)))
        fb_recs = []
        for loc in FALLBACK_LOCATIONS:
            fb_recs.extend(scrape_location(loc, past_days=args.past_days, limit=args.limit))
        if fb_recs:
            if _SCRAPER_OK:
                fb_recs = _enrich_realtor_batch(fb_recs, verbose=False)
            fb_kept, fb_dropped = filter_records(fb_recs, allow_fallback=True)
            # Exclude duplicates already in kept
            existing_sids = {r.get("source_listing_id") for r in kept}
            fb_kept = [r for r in fb_kept if r.get("source_listing_id") not in existing_sids]
            print("   Fallback added: {}".format(len(fb_kept)))
            kept.extend(fb_kept)

    # Quality floor
    pre  = len(kept)
    kept = [r for r in kept if r.get("data_quality_score", 0) >= args.min_score]
    print("   After quality floor ({}): {}/{}".format(args.min_score, len(kept), pre))

    if not kept:
        print("❌  No listings passed filters. Try --past-days 120 or --min-score 20.")
        sys.exit(1)

    # ── Phase 4: Pricing ──────────────────────────────────────────────────────
    print("\n── Phase 4: Tiered pricing adjustment ──")
    kept, price_changes = apply_pricing_batch(kept)
    print("   {} rents adjusted | cap=${:,} | floor=${:,}".format(
        price_changes, RENT_CAP, RENT_FLOOR))

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

    # Sort: primary cities first, then by quality score desc
    valid.sort(key=lambda r: (
        0 if _city_tier(r.get("city")) == "primary" else 1,
        -r.get("data_quality_score", 0),
    ))

    to_publish = valid[:args.target]
    print("\n   Selecting top {}/{} for publishing:".format(len(to_publish), len(valid)))
    for i, rec in enumerate(to_publish, 1):
        addr   = "{} {}".format(rec.get("address", ""), rec.get("city", "")).strip()
        rent   = rec.get("monthly_rent")
        score  = rec.get("data_quality_score", 0)
        baths  = rec.get("bathrooms")
        try:
            src_ct = len(json.loads(rec.get("original_image_urls") or "[]"))
        except Exception:
            src_ct = 0
        print("   {:2}. {} | ${}/mo | {}BA | score={} | {} photos".format(
            i, addr, rent, baths, score, src_ct))

    if args.dry_run:
        print("\n⚠  DRY RUN — stopping before any database writes.")
        sys.exit(0)

    # ── Phase 7: Stage + resolve pipeline IDs ────────────────────────────────
    print("\n── Phase 7: Staging {} records in pipeline ──".format(len(to_publish)))
    to_publish = stage_and_resolve(to_publish)

    print("\n   Patching pricing + descriptions on pipeline records...")
    for rec in to_publish:
        pid = rec.get("id")
        if not pid:
            continue
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
            print("   ⚠  PATCH failed {}: {}".format(pid, r.text[:80]))

    # ── Phase 8: Publish + activate + import photos ───────────────────────────
    print("\n── Phase 8: Publishing + photos ──")
    published  = []   # [(pipeline_id, choice_property_id, full_addr, rec)]
    photo_ok   = []
    photo_fail = []

    for rec in to_publish:
        addr = "{}, {} {}".format(
            rec.get("address", ""), rec.get("city", ""), rec.get("state", "")).strip()
        pid  = rec.get("id")
        if not pid:
            print("   ❌  No pipeline ID for: {}".format(addr))
            continue

        # Publish via RPC
        prop_id, err = publish_listing(pid)
        if err:
            print("   ❌  PUBLISH FAILED: {} — {}".format(addr, err))
            continue
        print("   ✅  Published: {} → {}".format(addr, prop_id))

        # Activate (pipeline_publish creates draft)
        ok = activate_property(prop_id)
        if ok:
            print("      → activated (status=active)")
        else:
            print("      ⚠  activation PATCH failed")

        published.append((pid, prop_id, addr, rec))

        # Import photos directly (edge fn bypass)
        print("      Importing photos...", flush=True)
        src_urls = []
        try:
            src_urls = json.loads(rec.get("original_image_urls") or "[]")
        except Exception:
            pass

        uploaded, failed = import_photos_direct(prop_id, src_urls, verbose=True)
        if uploaded > 0:
            print("      ✅  {}/{} photos on ImageKit".format(
                uploaded, uploaded + failed))
            photo_ok.append((addr, uploaded))
        else:
            print("      ⚠  0 photos uploaded ({} failed)".format(failed))
            photo_fail.append((addr, "0 photos uploaded"))

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n" + "=" * 65)
    print("SUMMARY")
    print("=" * 65)
    print("Passed filters          : {}".format(len(kept)))
    print("Passed validation       : {}".format(len(valid)))
    print("Selected to publish     : {}".format(len(to_publish)))
    print("Successfully published  : {}".format(len(published)))
    print("Photos OK               : {}".format(len(photo_ok)))
    print("Photo import issues     : {}".format(len(photo_fail)))

    if photo_fail:
        print("\nListings with photo issues:")
        for addr, err in photo_fail:
            print("  ⚠  {}: {}".format(addr, err))

    # ── Post-Scraping Report ──────────────────────────────────────────────────
    if published:
        print("\n" + "=" * 65)
        print("POST-SCRAPING REPORT")
        print("Published Properties — Arlington / Euless / Grapevine, TX")
        print("=" * 65)

        n = 0
        for _pid, prop_id, addr, rec in published:
            if not prop_id:
                continue
            n += 1
            prop_row = fetch_property_row(prop_id)
            if prop_row:
                url = build_property_url(prop_row)
            else:
                url = build_property_url({
                    "id":            prop_id,
                    "city":          rec.get("city", "arlington"),
                    "state":         rec.get("state", "TX"),
                    "property_type": rec.get("property_type", "SINGLE_FAMILY"),
                    "bedrooms":      rec.get("bedrooms", BEDS_EXACT),
                })
            full_addr = "{}, {} {} {}".format(
                rec.get("address", ""), rec.get("city", ""),
                rec.get("state", ""), rec.get("zip", ""),
            ).strip(", ")
            print("{}. {}\n   {}".format(n, full_addr, url))

        print("\n" + "=" * 65)
        print("✅  {} properties published.".format(n))
        print("Admin pipeline: {}/admin/pipeline.html".format(SITE_BASE_URL))

    print("\nDone.")


if __name__ == "__main__":
    main()
