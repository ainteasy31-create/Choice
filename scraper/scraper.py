#!/usr/bin/env python3
"""
Choice Properties — HomeHarvest Scraper (v2)
=============================================
Scrapes for-rent listings from Realtor.com via HomeHarvest and stages them
in pipeline.pipeline_properties for admin review and publishing.

Performance improvements over v1:
  • Batch inserts  — 50 records per POST instead of one-at-a-time
  • Parallel workers — concurrent batch writes via ThreadPoolExecutor
  • Retry/backoff   — 3 retries with exponential back-off on failures
  • Connection pool — requests.Session with Keep-Alive
  • .env auto-load  — no manual "source .env" required
  • Multi-location  — --location can be passed multiple times
  • Locations file  — --locations-file runs a whole list of cities
  • Upsert mode     — --upsert refreshes existing scraped listings
  • Quality filter  — --min-score skips low-quality junk

Usage:
  python scraper.py --location "Dallas, TX"
  python scraper.py --location "Austin, TX" --location "Houston, TX"
  python scraper.py --locations-file cities.txt --min-score 40
  python scraper.py --location "92104" --upsert --past-days 3

Requirements:
  pip install homeharvest requests

Environment variables (.env file auto-loaded if present):
  SUPABASE_URL              (default: https://tlfmwetmhthpyrytrcfo.supabase.co)
  SUPABASE_SERVICE_ROLE_KEY (required)
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
    """Load key=value pairs from .env in cwd or parent dir (no dependency needed)."""
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

# ── Guard imports ─────────────────────────────────────────────────────────────
try:
    from homeharvest import scrape_property
    from homeharvest.exceptions import InvalidListingType, AuthenticationError
except ImportError:
    sys.exit(
        "❌  homeharvest is not installed.\n"
        "    Run:  pip install homeharvest requests\n"
    )

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

BATCH_SIZE   = 50    # records per POST
MAX_WORKERS  = 4     # parallel batch-insert threads
MAX_RETRIES  = 3     # DB write retries per batch
RETRY_DELAY  = 1.5   # seconds (doubles each retry)

# ── HTTP session (connection pool + retry for transient network errors) ────────
_session_local = threading.local()

def _get_session():
    """Return a thread-local requests.Session with connection pooling."""
    if not hasattr(_session_local, "session"):
        s = _requests.Session()
        # Retry on connection errors / 5xx, but NOT on 4xx (those are logic errors)
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
        r = _get_session().get(url, timeout=20)
        r.raise_for_status()
        return r.json(), None
    except _requests.HTTPError as e:
        return [], e.response.text[:300] if e.response else str(e)
    except Exception as e:
        return [], str(e)


def _sb_post_batch(table, records, upsert=False):
    """
    Insert or upsert a list of records in one POST.
    Returns (inserted_count, error_string_or_None).
    Retries up to MAX_RETRIES times with exponential back-off.
    """
    prefer = "return=representation"
    if upsert:
        prefer += ",resolution=merge-duplicates"

    url  = f"{SUPABASE_URL}/rest/v1/{table}"
    body = json.dumps(records, default=str).encode()

    headers_override = {"Prefer": prefer}

    delay = RETRY_DELAY
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = _get_session().post(url, data=body, headers=headers_override, timeout=30)
            r.raise_for_status()
            data = r.json()
            return len(data) if isinstance(data, list) else len(records), None
        except _requests.HTTPError as e:
            err_text = e.response.text[:300] if e.response else str(e)
            # 4xx → logic error, no point retrying
            if e.response is not None and 400 <= e.response.status_code < 500:
                return 0, err_text
            last_err = err_text
        except Exception as e:
            last_err = str(e)

        if attempt < MAX_RETRIES:
            time.sleep(delay)
            delay *= 2

    return 0, last_err


def _sb_upsert_conflict_col():
    """Column used as unique key for upsert conflict resolution."""
    return "source_listing_id"


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


# ── Property-type normalisation ───────────────────────────────────────────────
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


# ── Pet policy parser ─────────────────────────────────────────────────────────

def _parse_pet_policy(pp):
    if pp is None:
        return None, []
    if isinstance(pp, bool):
        return pp, []
    if isinstance(pp, dict):
        types   = []
        allowed = False
        if pp.get("cats"):  types.append("cats");  allowed = True
        if pp.get("dogs"):  types.append("dogs");  allowed = True
        if pp.get("pets_allowed") and not allowed:
            allowed = True
        return allowed if (types or pp.get("pets_allowed") is not None) else None, types
    return None, []


# ── Photo collector ───────────────────────────────────────────────────────────

def _collect_photos(prop):
    urls    = []
    seen    = set()
    primary = getattr(prop, "primary_photo", None)
    if primary:
        s = str(primary).strip()
        if s and s not in seen:
            urls.append(s); seen.add(s)
    for p in (getattr(prop, "alt_photos", None) or []):
        s = str(p).strip()
        if s and s not in seen:
            urls.append(s); seen.add(s)
    return urls[:40]


# ── Parking stringifier ───────────────────────────────────────────────────────

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


# ── Data-quality scoring ──────────────────────────────────────────────────────
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


# ── Field mapper ──────────────────────────────────────────────────────────────

def _map_property(prop):
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

    ld             = getattr(prop, "list_date", None)
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

    rent = _safe_int(getattr(prop, "list_price", None))

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
    """Return set of source_listing_ids already in pipeline."""
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

def _log_run(location, count_total, count_new, avg_score,
             error_msg, started_at, count_dup=0, count_img_fail=0):
    payload = {
        "source":                    "realtor",
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
        "count_image_failed":        count_img_fail,
        "partial":                   False,
    }
    inserted, err = _sb_post_batch("pipeline_scrape_runs", [payload])
    if err:
        print(f"  ⚠  Could not log scrape run: {err[:120]}")
    else:
        print(f"   📋  Scrape run logged")


# ── Batch insert worker ───────────────────────────────────────────────────────

def _insert_batch(batch, upsert, batch_num, total_batches):
    """Insert one batch; called from thread pool. Returns (ok_count, err_count)."""
    inserted, err = _sb_post_batch("pipeline_properties", batch, upsert=upsert)
    if err:
        print(f"  ❌  Batch {batch_num}/{total_batches} failed ({len(batch)} records): {err[:160]}")
        return 0, len(batch)
    print(
        f"  ✅  Batch {batch_num}/{total_batches} — "
        f"{inserted} record(s) {'upserted' if upsert else 'inserted'}"
    )
    return inserted, 0


# ── Single-location runner ────────────────────────────────────────────────────

def _run_location(location, args, global_started_at):
    """Scrape + stage one location. Returns (count_new, count_dup, count_err, avg_score)."""
    print(f"\n{'═'*55}")
    print(f"📍  Location: {location}")
    print(f"{'═'*55}")

    # ── Scrape ───────────────────────────────────────────────────────────────
    print("⏳  Scraping Realtor.com via HomeHarvest…")
    t0 = time.time()

    scrape_kwargs = dict(
        location            = location,
        listing_type        = "for_rent",
        past_days           = args.past_days,
        return_type         = "pydantic",
        limit               = args.limit,
        extra_property_data = args.extra,
    )
    if args.beds_min       is not None: scrape_kwargs["beds_min"]       = args.beds_min
    if args.beds_max       is not None: scrape_kwargs["beds_max"]       = args.beds_max
    if args.price_min      is not None: scrape_kwargs["price_min"]      = args.price_min
    if args.price_max      is not None: scrape_kwargs["price_max"]      = args.price_max
    if args.property_type:              scrape_kwargs["property_type"]  = args.property_type.split(",")

    try:
        props = scrape_property(**scrape_kwargs)
    except (InvalidListingType, AuthenticationError) as e:
        print(f"❌  Scrape error: {e}")
        _log_run(location, 0, 0, 0, str(e), global_started_at)
        return 0, 0, 0, 0
    except Exception as e:
        print(f"❌  Unexpected scrape error: {e}")
        _log_run(location, 0, 0, 0, str(e), global_started_at)
        return 0, 0, 0, 0

    elapsed       = round(time.time() - t0, 1)
    total_scraped = len(props)
    print(f"✅  Found {total_scraped} listings in {elapsed}s")

    if not props:
        print("   Nothing to stage.")
        _log_run(location, 0, 0, 0, None, global_started_at)
        return 0, 0, 0, 0

    # ── Map all records ───────────────────────────────────────────────────────
    source_ids = [
        str(getattr(p, "property_id", None) or getattr(p, "mls_id", None) or "")
        for p in props
    ]

    # ── Deduplication (skip for upsert mode — upsert handles conflicts) ───────
    if not args.dry_run and not args.upsert:
        existing = _get_existing_ids([sid for sid in source_ids if sid])
        print(f"   {len(existing)} already in pipeline — will be skipped")
    else:
        existing = set()

    # ── Build records to stage ────────────────────────────────────────────────
    to_insert = []
    count_dup  = 0
    scores     = []

    for prop, sid in zip(props, source_ids):
        if not args.upsert and sid and sid in existing:
            count_dup += 1
            continue

        record = _map_property(prop)

        # Quality filter
        if record["data_quality_score"] < args.min_score:
            count_dup += 1  # count as skipped
            continue

        # Basic validation: must have at least address or coordinates
        has_address = bool(record.get("address") and record.get("city"))
        has_coords  = record.get("lat") is not None and record.get("lng") is not None
        if not has_address and not has_coords:
            count_dup += 1
            continue

        scores.append(record["data_quality_score"])
        to_insert.append(record)

    if args.dry_run:
        print(f"\n   [DRY RUN] Would stage {len(to_insert)} listings "
              f"(skip {count_dup}), avg score = "
              f"{round(sum(scores)/len(scores),1) if scores else 0}")
        for r in to_insert[:10]:
            addr_label = f"{r.get('address','')} {r.get('city','')}".strip()
            print(
                f"  [DRY] {r['id']}  ${r['monthly_rent'] or '?'}/mo  "
                f"score={r['data_quality_score']}  {addr_label}"
            )
        if len(to_insert) > 10:
            print(f"  ... and {len(to_insert)-10} more")
        return len(to_insert), count_dup, 0, round(sum(scores)/len(scores),1) if scores else 0

    if not to_insert:
        avg_score = 0
        _log_run(location, total_scraped, 0, avg_score, None, global_started_at, count_dup)
        return 0, count_dup, 0, avg_score

    # ── Batch insert (parallel) ───────────────────────────────────────────────
    batches = [to_insert[i:i+BATCH_SIZE] for i in range(0, len(to_insert), BATCH_SIZE)]
    total_batches = len(batches)
    print(f"\n📦  Staging {len(to_insert)} listings in {total_batches} batch(es) "
          f"[{min(MAX_WORKERS, total_batches)} workers]…")

    count_new = count_err = 0
    futures = {}

    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, total_batches)) as executor:
        for i, batch in enumerate(batches, 1):
            f = executor.submit(_insert_batch, batch, args.upsert, i, total_batches)
            futures[f] = i

        for f in as_completed(futures):
            ok, err_cnt = f.result()
            count_new += ok
            count_err += err_cnt

    avg_score = round(sum(scores) / len(scores), 1) if scores else 0

    print(f"\n{'─'*55}")
    print(f"  Location      : {location}")
    print(f"  Scraped total : {total_scraped}")
    print(f"  Staged (new)  : {count_new}")
    print(f"  Skipped/dup   : {count_dup}")
    print(f"  Errors        : {count_err}")
    print(f"  Avg score     : {avg_score}")
    print(f"{'─'*55}")

    _log_run(location, total_scraped, count_new, avg_score,
             None, global_started_at, count_dup, count_err)

    return count_new, count_dup, count_err, avg_score


# ── Main runner ───────────────────────────────────────────────────────────────

def run(args):
    print("\n🏠  Choice Properties — HomeHarvest Scraper v2")
    print(f"   Past days  : {args.past_days}")
    price_range = f"${args.price_min or 0} – ${args.price_max or '∞'}"
    beds_range  = f"{args.beds_min or 'any'} – {args.beds_max or 'any'}"
    print(f"   Price/mo   : {price_range}")
    print(f"   Beds       : {beds_range}")
    print(f"   Limit/loc  : {args.limit}")
    print(f"   Min score  : {args.min_score}")
    print(f"   Upsert     : {args.upsert}")
    print(f"   Extra data : {args.extra}")
    print(f"   Dry run    : {args.dry_run}")

    # ── Collect all locations ─────────────────────────────────────────────────
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

    started_at = _now()
    grand_new = grand_dup = grand_err = 0

    for loc in locations:
        new, dup, err, _ = _run_location(loc, args, started_at)
        grand_new += new
        grand_dup += dup
        grand_err += err

    if len(locations) > 1:
        print(f"\n{'═'*55}")
        print(f"  GRAND TOTAL — {len(locations)} locations")
        print(f"  Staged (new)  : {grand_new}")
        print(f"  Skipped/dup   : {grand_dup}")
        print(f"  Errors        : {grand_err}")
        print(f"{'═'*55}\n")

    return 0


# ── CLI entry-point ───────────────────────────────────────────────────────────

def _build_parser():
    p = argparse.ArgumentParser(
        prog="scraper",
        description=(
            "Choice Properties — HomeHarvest Scraper v2\n"
            "Stages Realtor.com for-rent listings into pipeline.pipeline_properties."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python scraper.py --location "Austin, TX"
  python scraper.py --location "Dallas, TX" --location "Houston, TX"
  python scraper.py --locations-file cities.txt --min-score 40
  python scraper.py --location "30301" --past-days 3 --price-max 2500
  python scraper.py --location "Los Angeles, CA" --beds-min 2 --beds-max 4 --limit 500
  python scraper.py --location "Miami, FL" --upsert --past-days 7
  python scraper.py --location "Miami, FL" --dry-run
        """,
    )

    p.add_argument(
        "--location", action="append", metavar="LOCATION",
        help='Location to search (can be specified multiple times). '
             'Accepts: city, "City, ST", ZIP, address, county.',
    )
    p.add_argument(
        "--locations-file", metavar="FILE",
        help="Path to a text file with one location per line (# comments supported).",
    )
    p.add_argument(
        "--past-days", type=int, default=7, metavar="N",
        help="Return listings listed/updated in the last N days (default: 7).",
    )
    p.add_argument("--beds-min",  type=int, default=None, metavar="N", help="Minimum bedrooms filter.")
    p.add_argument("--beds-max",  type=int, default=None, metavar="N", help="Maximum bedrooms filter.")
    p.add_argument("--price-min", type=int, default=None, metavar="$", help="Minimum monthly rent filter.")
    p.add_argument("--price-max", type=int, default=None, metavar="$", help="Maximum monthly rent filter.")
    p.add_argument(
        "--property-type", default=None, metavar="TYPE",
        help=(
            "Comma-separated HomeHarvest property types to filter.\n"
            "Options: single_family, multi_family, condos, townhomes, duplex_triplex, apartment, mobile"
        ),
    )
    p.add_argument(
        "--limit", type=int, default=200, metavar="N",
        help="Maximum number of listings to fetch per location (default: 200).",
    )
    p.add_argument(
        "--min-score", type=int, default=0, metavar="N",
        help="Skip listings with a data quality score below N (default: 0 = accept all).",
    )
    p.add_argument(
        "--upsert", action="store_true",
        help="Update existing pipeline listings instead of skipping duplicates.",
    )
    p.add_argument(
        "--extra", action="store_true",
        help="Fetch extra data per property (schools, tax history). Slower — adds 1 request/listing.",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Print results without writing to the database.",
    )
    return p


if __name__ == "__main__":
    parser = _build_parser()
    args   = parser.parse_args()
    sys.exit(run(args) or 0)
