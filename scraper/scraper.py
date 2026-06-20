#!/usr/bin/env python3
"""
Choice Properties — Scraper (v3)
=================================
Scrapes for-rent listings from Realtor.com (via HomeHarvest) and/or Zillow
(via __NEXT_DATA__ HTML parsing) and stages them in pipeline.pipeline_properties
for admin review and publishing.

Usage:
  python scraper.py --location "Dallas, TX"                          # Realtor only (default)
  python scraper.py --location "Dallas, TX" --source zillow          # Zillow only
  python scraper.py --location "Dallas, TX" --source both            # Realtor + Zillow
  python scraper.py --location "Austin, TX" --location "Houston, TX" # multi-city
  python scraper.py --locations-file cities.txt --source both        # bulk from file
  python scraper.py --location "Miami, FL" --upsert --past-days 3
  python scraper.py --location "Miami, FL" --dry-run

Requirements:
  pip install homeharvest requests

Environment variables (.env file auto-loaded if present):
  SUPABASE_URL              (default: https://tlfmwetmhthpyrytrcfo.supabase.co)
  SUPABASE_SERVICE_ROLE_KEY (required)

Zillow note:
  The Zillow scraper works by parsing __NEXT_DATA__ JSON from Zillow's
  Next.js pages. It works best from residential IPs. Datacenter/cloud IPs
  may be blocked by Zillow's DataDome bot-detection layer. Run locally,
  or set HTTP_PROXY / HTTPS_PROXY to a residential proxy.
"""

import os
import sys
import json
import uuid
import time
import argparse
import threading
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── .env auto-loader ──────────────────────────────────────────────────────────
def _load_dotenv():
    for candidate in [".env", "../.env"]:
        if os.path.isfile(candidate):
            with open(candidate) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key and key not in os.environ:
                        os.environ[key] = val
            break

_load_dotenv()

# ── Guard: Realtor.com scraper (HomeHarvest) ──────────────────────────────────
try:
    from homeharvest import scrape_property
    from homeharvest.exceptions import InvalidListingType, AuthenticationError
    _HH_AVAILABLE = True
except ImportError:
    _HH_AVAILABLE = False

# ── Guard: Zillow scraper module ──────────────────────────────────────────────
try:
    import sys as _sys
    import os as _os
    _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
    from zillow_scraper import scrape_and_map as _zillow_scrape
    _ZW_AVAILABLE = True
except ImportError as _e:
    _ZW_AVAILABLE = False
    _ZW_IMPORT_ERR = str(_e)

# ── Guard: requests ───────────────────────────────────────────────────────────
try:
    import requests as _requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
except ImportError:
    sys.exit(
        "❌  requests is not installed.\n"
        "    Run:  pip install requests\n"
    )

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL     = os.environ.get("SUPABASE_URL", "https://tlfmwetmhthpyrytrcfo.supabase.co").rstrip("/")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not SERVICE_ROLE_KEY:
    sys.exit(
        "❌  SUPABASE_SERVICE_ROLE_KEY is not set.\n"
        "    Add it to a .env file or export it before running."
    )

BATCH_SIZE  = 50
MAX_WORKERS = 4
MAX_RETRIES = 3
RETRY_DELAY = 1.5

# ── HTTP session (Supabase) ───────────────────────────────────────────────────
_session_local = threading.local()

def _get_sb_session():
    if not hasattr(_session_local, "session"):
        s = _requests.Session()
        retry = Retry(
            total=3,
            backoff_factor=0.5,
            status_forcelist=[500, 502, 503, 504],
            allowed_methods=["GET", "POST", "PATCH"],
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=20)
        s.mount("https://", adapter)
        s.mount("http://",  adapter)
        s.headers.update({
            "apikey":          SERVICE_ROLE_KEY,
            "Authorization":   f"Bearer {SERVICE_ROLE_KEY}",
            "Content-Type":    "application/json",
            "Accept":          "application/json",
            "Accept-Profile":  "pipeline",
            "Content-Profile": "pipeline",
            "Prefer":          "return=representation",
        })
        _session_local.session = s
    return _session_local.session


def _sb_get(table, qs=""):
    url = f"{SUPABASE_URL}/rest/v1/{table}?{qs}"
    try:
        r = _get_sb_session().get(url, timeout=20)
        r.raise_for_status()
        return r.json(), None
    except _requests.HTTPError as e:
        return [], e.response.text[:300] if e.response else str(e)
    except Exception as e:
        return [], str(e)


def _sb_post_batch(table, records, upsert=False):
    prefer = "return=representation"
    if upsert:
        prefer += ",resolution=merge-duplicates"
    url  = f"{SUPABASE_URL}/rest/v1/{table}"
    body = json.dumps(records, default=str).encode()
    delay = RETRY_DELAY
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = _get_sb_session().post(
                url, data=body,
                headers={"Prefer": prefer},
                timeout=30,
            )
            r.raise_for_status()
            data = r.json()
            return len(data) if isinstance(data, list) else len(records), None
        except _requests.HTTPError as e:
            err_text = e.response.text[:300] if e.response else str(e)
            if e.response is not None and 400 <= e.response.status_code < 500:
                return 0, err_text
            last_err = err_text
        except Exception as e:
            last_err = str(e)
        if attempt < MAX_RETRIES:
            time.sleep(delay)
            delay *= 2
    return 0, last_err


# ── Helpers ───────────────────────────────────────────────────────────────────

def _gen_id():
    return "PP-" + uuid.uuid4().hex[:8].upper()

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

def _now():
    return datetime.now(timezone.utc).isoformat()


# ── Realtor.com property mapper ───────────────────────────────────────────────
_STYLE_MAP = {
    "SINGLE_FAMILY":               "SINGLE_FAMILY",
    "MULTI_FAMILY":                "MULTI_FAMILY",
    "CONDO":                       "CONDOS",
    "CONDOS":                      "CONDOS",
    "CONDO_TOWNHOME_ROWHOME_COOP": "CONDOS",
    "CONDO_TOWNHOME":              "CONDOS",
    "TOWNHOMES":                   "TOWNHOMES",
    "TOWNHOUSE":                   "TOWNHOMES",
    "DUPLEX_TRIPLEX":              "MULTI_FAMILY",
    "APARTMENT":                   "APARTMENT",
    "LAND":                        "LAND",
    "MOBILE":                      "MOBILE",
    "FARM":                        "FARM",
}

def _parse_pet_policy(pp):
    if pp is None:
        return None, []
    if isinstance(pp, bool):
        return pp, []
    if isinstance(pp, dict):
        types, allowed = [], False
        if pp.get("cats"):  types.append("cats");  allowed = True
        if pp.get("dogs"):  types.append("dogs");  allowed = True
        if pp.get("pets_allowed") and not allowed:
            allowed = True
        return allowed if (types or pp.get("pets_allowed") is not None) else None, types
    return None, []

def _collect_photos(prop):
    urls, seen = [], set()
    for src in [getattr(prop, "primary_photo", None)]:
        if src:
            s = str(src).strip()
            if s and s not in seen:
                urls.append(s); seen.add(s)
    for p in (getattr(prop, "alt_photos", None) or []):
        s = str(p).strip()
        if s and s not in seen:
            urls.append(s); seen.add(s)
    return urls[:40]

def _parking_str(parking):
    if parking is None:
        return None
    if isinstance(parking, dict):
        parts = []
        if parking.get("garage"):  parts.append(f"Garage ({parking['garage']} sp.)")
        if parking.get("carport"): parts.append("Carport")
        if parking.get("open"):    parts.append("Open parking")
        return ", ".join(parts) if parts else json.dumps(parking)
    return str(parking)

# ── Quality scoring (shared logic; mirrors zillow_scraper.py) ─────────────────
_IMPORTANT = [
    "address", "city", "state", "zip", "lat", "lng",
    "bedrooms", "bathrooms", "square_footage", "monthly_rent",
    "property_type", "description", "available_date",
]
_BONUS = [
    "county", "neighborhood", "year_built", "parking",
    "pets_allowed", "security_deposit", "amenities", "appliances",
]
_TRACKABLE_MISSING = [
    "lat", "lng", "county", "neighborhood", "year_built", "square_footage",
    "parking", "pets_allowed", "security_deposit", "amenities", "appliances",
    "available_date", "heating_type", "cooling_type", "laundry_type",
]

def _quality_score(r):
    sc = 0
    for f in _IMPORTANT:
        if r.get(f) not in (None, "", "[]"):
            sc += 6
    for f in _BONUS:
        if r.get(f) not in (None, "", "[]"):
            sc += 2
    n   = len(json.loads(r.get("original_image_urls") or "[]"))
    sc += 6 if n >= 5 else (3 if n >= 1 else 0)
    return min(sc, 100)

def _missing_fields(r):
    return [f for f in _TRACKABLE_MISSING if r.get(f) in (None, "", "[]")]

def _map_realtor_property(prop):
    desc = getattr(prop, "description", None)
    addr = getattr(prop, "address",     None)
    street   = getattr(addr, "street",   None) if addr else None
    unit     = getattr(addr, "unit",     None) if addr else None
    city     = getattr(addr, "city",     None) if addr else None
    state    = getattr(addr, "state",    None) if addr else None
    zipcode  = getattr(addr, "zip_code", None) if addr else None
    beds     = _safe_int(getattr(desc, "beds",       None)) if desc else None
    bath_f   = _safe_int(getattr(desc, "baths_full", None)) if desc else None
    bath_h   = _safe_int(getattr(desc, "baths_half", None)) if desc else None
    sqft     = _safe_int(getattr(desc, "sqft",       None)) if desc else None
    lot_sqft = _safe_int(getattr(desc, "lot_sqft",   None)) if desc else None
    yr_built = _safe_int(getattr(desc, "year_built", None)) if desc else None
    floors   = _safe_int(getattr(desc, "stories",    None)) if desc else None
    garage   = _safe_int(getattr(desc, "garage",     None)) if desc else None
    desc_txt  = getattr(desc, "text",  None) if desc else None
    style_raw = str(getattr(desc, "style", None) or getattr(desc, "type", None) or "").upper()
    prop_type = _STYLE_MAP.get(style_raw, style_raw or None)
    bed_pfx  = f"{beds}BR " if beds else ""
    type_lbl = (prop_type or "Rental").replace("_", " ").title()
    title    = f"{bed_pfx}{type_lbl} in {city}" if city else (street or "Rental Property")
    ld       = getattr(prop, "list_date", None)
    available_date = None
    if ld:
        try:    available_date = ld.strftime("%Y-%m-%d")
        except: available_date = str(ld)[:10]
    photos = _collect_photos(prop)
    pets_allowed, pet_types = _parse_pet_policy(getattr(prop, "pet_policy", None))
    tags      = getattr(prop, "tags", None) or []
    amenities = _jdumps(tags)
    hoods = getattr(prop, "neighborhoods", None) or []
    hood  = str(hoods[0]) if hoods else None
    rent  = _safe_int(getattr(prop, "list_price", None))
    bath_total = None
    if bath_f is not None:
        bath_total = round((bath_f or 0) + (bath_h or 0) * 0.5, 1)
    original_data = {
        "property_url":   getattr(prop, "property_url",   None),
        "property_id":    getattr(prop, "property_id",    None),
        "listing_id":     getattr(prop, "listing_id",     None),
        "mls_id":         getattr(prop, "mls_id",         None),
        "status":         str(getattr(prop, "status",     None)),
        "list_price":     getattr(prop, "list_price",     None),
        "list_price_min": getattr(prop, "list_price_min", None),
        "list_price_max": getattr(prop, "list_price_max", None),
        "list_date":      str(ld),
        "neighborhoods":  [str(n) for n in hoods],
        "hoa_fee":        getattr(prop, "hoa_fee",        None),
        "agent_name":     getattr(prop, "agent_name",     None),
        "broker_name":    getattr(prop, "broker_name",    None),
        "office_name":    getattr(prop, "office_name",    None),
        "_source":        "realtor",
    }
    now = _now()
    record = {
        "id":                    _gen_id(),
        "source":                "realtor",
        "source_url":            getattr(prop, "property_url",  None),
        "source_listing_id":     str(
            getattr(prop, "property_id", None) or
            getattr(prop, "mls_id",      None) or ""
        ),
        "status":                "scraped",
        "title":                 title,
        "address":               street,
        "unit_number":           unit,
        "city":                  city,
        "state":                 state,
        "zip":                   zipcode,
        "county":                getattr(prop, "county", None),
        "neighborhood":          hood,
        "lat":                   _safe_float(getattr(prop, "latitude",  None)),
        "lng":                   _safe_float(getattr(prop, "longitude", None)),
        "location_context":      None,
        "property_type":         prop_type,
        "bedrooms":              beds,
        "bathrooms":             bath_f,
        "half_bathrooms":        bath_h,
        "total_bathrooms":       bath_total,
        "square_footage":        sqft,
        "lot_size_sqft":         lot_sqft,
        "year_built":            yr_built,
        "floors":                floors,
        "garage_spaces":         garage,
        "total_units":           None,
        "has_basement":          False,
        "has_central_air":       False,
        "virtual_tour_url":      None,
        "monthly_rent":          rent,
        "security_deposit":      rent,
        "last_months_rent":      None,
        "application_fee":       None,
        "pet_deposit":           None,
        "admin_fee":             None,
        "move_in_special":       None,
        "parking_fee":           None,
        "hoa_fee":               _safe_int(getattr(prop, "hoa_fee",            None)),
        "tax_value":             _safe_int(getattr(prop, "tax_assessed_value", None)),
        "description":           desc_txt,
        "showing_instructions":  None,
        "available_date":        available_date,
        "minimum_lease_months":  None,
        "lease_terms":           "[]",
        "pets_allowed":          pets_allowed,
        "pet_types_allowed":     _jdumps(pet_types),
        "pet_weight_limit":      None,
        "pet_details":           None,
        "smoking_allowed":       None,
        "parking":               _parking_str(getattr(prop, "parking", None)),
        "amenities":             amenities,
        "appliances":            "[]",
        "utilities_included":    "[]",
        "flooring":              "[]",
        "heating_type":          None,
        "cooling_type":          None,
        "laundry_type":          None,
        "original_image_urls":   _jdumps(photos),
        "local_image_paths":     "[]",
        "agent_name":            getattr(prop, "agent_name",  None),
        "broker_name":           getattr(prop, "broker_name", None),
        "agent_image_url":       None,
        "poster_landlord_id":    None,
        "original_data":         json.dumps(original_data, default=str),
        "edited_fields":         "[]",
        "inferred_features":     "[]",
        "published_at":          None,
        "choice_property_id":    None,
        "scraped_at":            now,
        "updated_at":            now,
    }
    record["data_quality_score"] = _quality_score(record)
    record["missing_fields"]     = _jdumps(_missing_fields(record))
    return record


# ── Deduplication ─────────────────────────────────────────────────────────────

def _get_existing_ids(source_ids):
    if not source_ids:
        return set()
    import urllib.parse
    encoded = urllib.parse.quote(",".join(source_ids))
    rows, err = _sb_get(
        "pipeline_properties",
        f"source_listing_id=in.({encoded})&select=source_listing_id&limit=10000",
    )
    if err:
        print(f"  ⚠  Dedup check error (continuing without dedup): {err[:120]}")
        return set()
    return {r["source_listing_id"] for r in rows}


# ── Scrape-run logger ─────────────────────────────────────────────────────────

def _log_run(location, source, count_total, count_new, avg_score,
             error_msg, started_at, count_dup=0, count_err=0):
    payload = {
        "source":                    source,
        "location":                  location,
        "count_total":               count_total,
        "count_new":                 count_new,
        "avg_score":                 avg_score,
        "error_message":             error_msg,
        "started_at":                started_at,
        "completed_at":              _now(),
        "count_duplicate":           count_dup,
        "count_watermarked":         0,
        "count_validation_rejected": 0,
        "count_image_failed":        count_err,
        "partial":                   False,
    }
    _sb_post_batch("pipeline_scrape_runs", [payload])


# ── Batch insert worker ───────────────────────────────────────────────────────

def _insert_batch(batch, upsert, batch_num, total_batches, source_label):
    inserted, err = _sb_post_batch("pipeline_properties", batch, upsert=upsert)
    if err:
        print(f"  ❌  [{source_label}] Batch {batch_num}/{total_batches} failed: {err[:160]}")
        return 0, len(batch)
    print(
        f"  ✅  [{source_label}] Batch {batch_num}/{total_batches} — "
        f"{inserted} record(s) {'upserted' if upsert else 'inserted'}"
    )
    return inserted, 0


# ── Shared staging logic ──────────────────────────────────────────────────────

def _stage_records(records, location, source_label, args, started_at):
    """
    Dedup + batch-insert a list of pipeline-ready records.
    Returns (count_new, count_dup, count_err, avg_score).
    """
    if not records:
        _log_run(location, source_label, 0, 0, 0, None, started_at)
        return 0, 0, 0, 0

    total_scraped = len(records)

    # Dedup
    if not args.dry_run and not args.upsert:
        source_ids = [r.get("source_listing_id", "") for r in records]
        existing   = _get_existing_ids([s for s in source_ids if s])
        pre_dedup  = len(records)
        records    = [r for r in records if r.get("source_listing_id", "") not in existing]
        count_dup  = pre_dedup - len(records)
        print(f"   [{source_label}] {count_dup} duplicates skipped, {len(records)} to stage")
    else:
        count_dup = 0

    scores = [r["data_quality_score"] for r in records]

    if args.dry_run:
        print(f"\n   [DRY RUN — {source_label}] Would stage {len(records)} listings, "
              f"avg score = {round(sum(scores)/len(scores),1) if scores else 0}")
        for r in records[:8]:
            addr = f"{r.get('address','')} {r.get('city','')}".strip()
            print(f"  [DRY] {r['id']}  ${r['monthly_rent'] or '?'}/mo  "
                  f"score={r['data_quality_score']}  {addr}")
        if len(records) > 8:
            print(f"  ... and {len(records)-8} more")
        avg_score = round(sum(scores)/len(scores), 1) if scores else 0
        return len(records), count_dup, 0, avg_score

    if not records:
        _log_run(location, source_label, total_scraped, 0, 0, None, started_at, count_dup)
        return 0, count_dup, 0, 0

    batches       = [records[i:i+BATCH_SIZE] for i in range(0, len(records), BATCH_SIZE)]
    total_batches = len(batches)
    workers       = min(MAX_WORKERS, total_batches)
    print(f"\n📦  [{source_label}] Staging {len(records)} listing(s) in "
          f"{total_batches} batch(es) [{workers} worker(s)]…")

    count_new = count_err = 0
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(_insert_batch, b, args.upsert, i+1, total_batches, source_label): i
            for i, b in enumerate(batches)
        }
        for f in as_completed(futures):
            ok, err_cnt = f.result()
            count_new += ok
            count_err += err_cnt

    avg_score = round(sum(scores)/len(scores), 1) if scores else 0
    _log_run(location, source_label, total_scraped, count_new, avg_score,
             None, started_at, count_dup, count_err)
    return count_new, count_dup, count_err, avg_score


# ── Realtor.com scrape for one location ───────────────────────────────────────

def _run_realtor(location, args, started_at):
    if not _HH_AVAILABLE:
        print("❌  homeharvest is not installed. Run: pip install homeharvest")
        return 0, 0, 0, 0

    print(f"\n{'─'*55}")
    print(f"🏠  Realtor.com scrape: {location}")
    print(f"{'─'*55}")
    t0 = time.time()

    scrape_kwargs = dict(
        location            = location,
        listing_type        = "for_rent",
        past_days           = args.past_days,
        return_type         = "pydantic",
        limit               = args.limit,
        extra_property_data = args.extra,
    )
    if args.beds_min       is not None: scrape_kwargs["beds_min"]      = args.beds_min
    if args.beds_max       is not None: scrape_kwargs["beds_max"]      = args.beds_max
    if args.price_min      is not None: scrape_kwargs["price_min"]     = args.price_min
    if args.price_max      is not None: scrape_kwargs["price_max"]     = args.price_max
    if args.property_type:              scrape_kwargs["property_type"] = args.property_type.split(",")

    try:
        props = scrape_property(**scrape_kwargs)
    except (InvalidListingType, AuthenticationError) as e:
        print(f"❌  Scrape error: {e}")
        _log_run(location, "realtor", 0, 0, 0, str(e), started_at)
        return 0, 0, 0, 0
    except Exception as e:
        print(f"❌  Unexpected scrape error: {e}")
        _log_run(location, "realtor", 0, 0, 0, str(e), started_at)
        return 0, 0, 0, 0

    elapsed = round(time.time() - t0, 1)
    print(f"✅  HomeHarvest found {len(props)} listings in {elapsed}s")

    if not props:
        _log_run(location, "realtor", 0, 0, 0, None, started_at)
        return 0, 0, 0, 0

    # Map + quality filter + address validation
    records = []
    for prop in props:
        rec = _map_realtor_property(prop)
        if rec["data_quality_score"] < args.min_score:
            continue
        has_addr   = bool(rec.get("address") and rec.get("city"))
        has_coords = rec.get("lat") is not None and rec.get("lng") is not None
        if not has_addr and not has_coords:
            continue
        records.append(rec)

    dropped = len(props) - len(records)
    if dropped:
        print(f"   {dropped} listing(s) dropped (below min-score or no address/coords)")

    return _stage_records(records, location, "realtor", args, started_at)


# ── Zillow scrape for one location ────────────────────────────────────────────

def _run_zillow(location, args, started_at):
    if not _ZW_AVAILABLE:
        print(f"❌  Zillow scraper unavailable: {_ZW_IMPORT_ERR}")
        return 0, 0, 0, 0

    print(f"\n{'─'*55}")
    print(f"🏠  Zillow scrape: {location}")
    print(f"{'─'*55}")

    try:
        records, blocked = _zillow_scrape(
            location      = location,
            limit         = args.limit,
            beds_min      = args.beds_min,
            beds_max      = args.beds_max,
            price_min     = args.price_min,
            price_max     = args.price_max,
            min_score     = args.min_score,
            fetch_details = not getattr(args, "no_details", False),
            verbose       = True,
        )
    except Exception as e:
        print(f"❌  Zillow scrape error: {e}")
        _log_run(location, "zillow", 0, 0, 0, str(e), started_at)
        return 0, 0, 0, 0

    if blocked:
        msg = "Zillow blocked the request (bot detection). Run from a residential IP."
        print(f"  ⛔  {msg}")
        _log_run(location, "zillow", 0, 0, 0, msg, started_at)
        return 0, 0, 0, 0

    if not records:
        print("   No Zillow listings found.")
        _log_run(location, "zillow", 0, 0, 0, None, started_at)
        return 0, 0, 0, 0

    return _stage_records(records, location, "zillow", args, started_at)


# ── Per-location dispatcher ───────────────────────────────────────────────────

def _run_location(location, args, started_at):
    print(f"\n{'═'*55}")
    print(f"📍  Location : {location}")
    print(f"    Source   : {args.source}")
    print(f"{'═'*55}")

    total_new = total_dup = total_err = 0
    scores = []

    if args.source in ("realtor", "both"):
        new, dup, err, score = _run_realtor(location, args, started_at)
        total_new += new; total_dup += dup; total_err += err
        if score:
            scores.append(score)

    if args.source in ("zillow", "both"):
        new, dup, err, score = _run_zillow(location, args, started_at)
        total_new += new; total_dup += dup; total_err += err
        if score:
            scores.append(score)

    avg = round(sum(scores)/len(scores), 1) if scores else 0

    print(f"\n{'─'*55}")
    print(f"  Location    : {location}  [{args.source}]")
    print(f"  Staged new  : {total_new}")
    print(f"  Skipped/dup : {total_dup}")
    print(f"  Errors      : {total_err}")
    print(f"  Avg score   : {avg}")
    print(f"{'─'*55}")

    return total_new, total_dup, total_err, avg


# ── Main runner ───────────────────────────────────────────────────────────────

def run(args):
    print("\n🏠  Choice Properties — Scraper v4")
    print(f"   Source       : {args.source}")
    print(f"   Past days    : {args.past_days}")
    print(f"   Price/mo     : ${args.price_min or 0} – ${args.price_max or 'no max'}")
    print(f"   Beds         : {args.beds_min or 'any'} – {args.beds_max or 'any'}")
    print(f"   Limit/loc    : {args.limit}")
    print(f"   Min score    : {args.min_score}")
    print(f"   Upsert       : {args.upsert}")
    print(f"   Extra data   : {args.extra}")
    print(f"   Zillow details: {'DISABLED (--no-details)' if getattr(args, 'no_details', False) else 'ENABLED (Phase 2 full enrichment)'}")
    print(f"   Dry run      : {args.dry_run}")

    # ── Collect locations ─────────────────────────────────────────────────────
    locations = list(args.location) if args.location else []
    if args.locations_file:
        try:
            with open(args.locations_file) as f:
                for line in f:
                    loc = line.strip()
                    if loc and not loc.startswith("#"):
                        locations.append(loc)
        except FileNotFoundError:
            print(f"❌  Locations file not found: {args.locations_file}")
            return 1

    if not locations:
        print("❌  No locations specified. Use --location or --locations-file.")
        return 1

    print(f"   Locations  : {len(locations)}")

    # ── Source availability check ─────────────────────────────────────────────
    if args.source in ("realtor", "both") and not _HH_AVAILABLE:
        print("⚠   homeharvest not installed — Realtor.com scraping will be skipped.")
        print("    Run: pip install homeharvest")
    if args.source in ("zillow", "both") and not _ZW_AVAILABLE:
        print(f"⚠   Zillow module unavailable: {_ZW_IMPORT_ERR}")

    started_at = _now()
    grand_new = grand_dup = grand_err = 0

    for loc in locations:
        new, dup, err, _ = _run_location(loc, args, started_at)
        grand_new += new
        grand_dup += dup
        grand_err += err

    if len(locations) > 1 or args.source == "both":
        print(f"\n{'═'*55}")
        print(f"  GRAND TOTAL — {len(locations)} location(s) [{args.source}]")
        print(f"  Staged new  : {grand_new}")
        print(f"  Skipped/dup : {grand_dup}")
        print(f"  Errors      : {grand_err}")
        print(f"{'═'*55}\n")

    return 0


# ── CLI entry-point ───────────────────────────────────────────────────────────

def _build_parser():
    p = argparse.ArgumentParser(
        prog="scraper",
        description=(
            "Choice Properties -- Scraper v4\n"
            "Stages Realtor.com and/or Zillow for-rent listings into pipeline.pipeline_properties.\n"
            "Zillow now runs in two phases: search (fast) + detail pages (full data)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python scraper.py --location "Austin, TX"
  python scraper.py --location "Dallas, TX" --source zillow
  python scraper.py --location "Dallas, TX" --source zillow --no-details
  python scraper.py --location "Dallas, TX" --source both
  python scraper.py --location "Dallas, TX" --location "Houston, TX" --source both
  python scraper.py --locations-file cities.txt --source both --min-score 40
  python scraper.py --location "30301" --past-days 3 --price-max 2500
  python scraper.py --location "Los Angeles, CA" --beds-min 2 --beds-max 4 --limit 500
  python scraper.py --location "Miami, FL" --upsert --past-days 7
  python scraper.py --location "Miami, FL" --dry-run
        """,
    )
    p.add_argument(
        "--location", action="append", metavar="LOCATION",
        help='Location to search (repeatable). Accepts: city, "City, ST", ZIP, county.',
    )
    p.add_argument(
        "--locations-file", metavar="FILE",
        help="Text file with one location per line (# comments supported).",
    )
    p.add_argument(
        "--source", choices=["realtor", "zillow", "both"], default="realtor",
        help=(
            "Which source(s) to scrape.\n"
            "  realtor — Realtor.com via HomeHarvest (default)\n"
            "  zillow  — Zillow via __NEXT_DATA__ HTML parsing\n"
            "  both    — run both in sequence\n"
            "Zillow works best from a residential IP."
        ),
    )
    p.add_argument(
        "--past-days", type=int, default=7, metavar="N",
        help="Realtor.com only: listings from the last N days (default: 7).",
    )
    p.add_argument("--beds-min",  type=int, default=None, metavar="N")
    p.add_argument("--beds-max",  type=int, default=None, metavar="N")
    p.add_argument("--price-min", type=int, default=None, metavar="$")
    p.add_argument("--price-max", type=int, default=None, metavar="$")
    p.add_argument(
        "--property-type", default=None, metavar="TYPE",
        help="Realtor.com only. Comma-separated: single_family, multi_family, condos, townhomes, apartment, mobile",
    )
    p.add_argument(
        "--limit", type=int, default=200, metavar="N",
        help="Max listings per location per source (default: 200).",
    )
    p.add_argument(
        "--min-score", type=int, default=0, metavar="N",
        help="Skip listings with data quality score below N (default: 0).",
    )
    p.add_argument(
        "--upsert", action="store_true",
        help="Update existing pipeline listings rather than skipping duplicates.",
    )
    p.add_argument(
        "--extra", action="store_true",
        help="Realtor.com only: fetch extra data per property (schools, tax history). Slower.",
    )
    p.add_argument(
        "--no-details", action="store_true",
        help=(
            "Zillow only: skip Phase 2 detail-page enrichment. "
            "Faster but leaves many fields empty (no heating/cooling/laundry/appliances/etc). "
            "Use when you only need basic listing data quickly."
        ),
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Print what would be staged without writing to the database.",
    )
    return p


if __name__ == "__main__":
    parser = _build_parser()
    args   = parser.parse_args()
    sys.exit(run(args) or 0)
