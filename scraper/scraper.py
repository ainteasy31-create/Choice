#!/usr/bin/env python3
"""
Choice Properties — HomeHarvest Scraper
========================================
Scrapes for-rent listings from Realtor.com via HomeHarvest and stages them
in pipeline.pipeline_properties for admin review and publishing.

Usage:
  python scraper.py --location "Dallas, TX"
  python scraper.py --location "Sacramento, CA" --past-days 14 --price-min 900 --price-max 4000
  python scraper.py --location "92104" --beds-min 2 --limit 100 --dry-run

Requirements:
  pip install homeharvest

Environment variables (set in .env or export):
  SUPABASE_URL              (default: https://tlfmwetmhthpyrytrcfo.supabase.co)
  SUPABASE_SERVICE_ROLE_KEY (required)
"""

import os
import sys
import json
import uuid
import time
import argparse
from datetime import datetime, timezone

# ── Guard imports ─────────────────────────────────────────────────────────────
try:
    from homeharvest import scrape_property
    from homeharvest.exceptions import InvalidListingType, AuthenticationError
except ImportError:
    sys.exit(
        "❌  homeharvest is not installed.\n"
        "    Run:  pip install homeharvest\n"
    )

import urllib.request
import urllib.error
import urllib.parse

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL     = os.environ.get("SUPABASE_URL", "https://tlfmwetmhthpyrytrcfo.supabase.co").rstrip("/")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not SERVICE_ROLE_KEY:
    sys.exit("❌  SUPABASE_SERVICE_ROLE_KEY environment variable is not set.\n"
             "    Export it or add it to a .env file and source it first.")

# ── Supabase REST client (pipeline schema) ────────────────────────────────────
_HEADERS = {
    "apikey":          SERVICE_ROLE_KEY,
    "Authorization":   f"Bearer {SERVICE_ROLE_KEY}",
    "Content-Type":    "application/json",
    "Accept":          "application/json",
    "Accept-Profile":  "pipeline",
    "Content-Profile": "pipeline",
    "Prefer":          "return=representation",
}


def _sb_get(table, qs=""):
    url = f"{SUPABASE_URL}/rest/v1/{table}?{qs}"
    req = urllib.request.Request(url, headers=_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read()), None
    except urllib.error.HTTPError as e:
        return [], e.read().decode()
    except Exception as e:
        return [], str(e)


def _sb_post(table, data):
    body = json.dumps(data).encode()
    req  = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{table}",
        data=body, headers=_HEADERS, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read()), None
    except urllib.error.HTTPError as e:
        return None, e.read().decode()
    except Exception as e:
        return None, str(e)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _gen_id():
    """Generate a pipeline property ID in the PP-XXXXXXXX format."""
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
    """Serialize a list to a JSON string (pipeline stores arrays as text)."""
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
    """Return (pets_allowed: bool|None, pet_types: list[str])."""
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
    """Return up to 40 photo URLs from a HomeHarvest pydantic Property."""
    urls  = []
    primary = getattr(prop, "primary_photo", None)
    if primary:
        s = str(primary)
        if s and s not in urls:
            urls.append(s)
    for p in (getattr(prop, "alt_photos", None) or []):
        s = str(p)
        if s and s not in urls:
            urls.append(s)
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
    """Score 0–100 based on filled fields."""
    sc = 0
    for f in _IMPORTANT:
        if r.get(f) not in (None, "", "[]"):
            sc += 6                             # 13 × 6 = 78 pts max
    for f in _BONUS:
        if r.get(f) not in (None, "", "[]"):
            sc += 2                             # 8 × 2 = 16 pts max
    n = len(json.loads(r.get("original_image_urls") or "[]"))
    sc += 6 if n >= 5 else (3 if n >= 1 else 0)
    return min(sc, 100)


def _missing_fields(r):
    return [f for f in _TRACKABLE_MISSING if r.get(f) in (None, "", "[]")]


# ── Field mapper ──────────────────────────────────────────────────────────────

def _map_property(prop):
    """
    Map a HomeHarvest pydantic Property object to a pipeline_properties dict.
    All column names and types match the live pipeline schema.
    """
    desc = getattr(prop, "description", None)
    addr = getattr(prop, "address",     None)

    # Address
    street   = getattr(addr, "street",   None) if addr else None
    unit     = getattr(addr, "unit",     None) if addr else None
    city     = getattr(addr, "city",     None) if addr else None
    state    = getattr(addr, "state",    None) if addr else None
    zipcode  = getattr(addr, "zip_code", None) if addr else None

    # Description sub-fields
    beds     = _safe_int(getattr(desc, "beds",       None)) if desc else None
    bath_f   = _safe_int(getattr(desc, "baths_full", None)) if desc else None
    bath_h   = _safe_int(getattr(desc, "baths_half", None)) if desc else None
    sqft     = _safe_int(getattr(desc, "sqft",       None)) if desc else None
    lot_sqft = _safe_int(getattr(desc, "lot_sqft",   None)) if desc else None
    yr_built = _safe_int(getattr(desc, "year_built", None)) if desc else None
    floors   = _safe_int(getattr(desc, "stories",    None)) if desc else None
    garage   = _safe_int(getattr(desc, "garage",     None)) if desc else None
    desc_txt = getattr(desc, "text",  None) if desc else None
    style_raw = str(getattr(desc, "style", None) or getattr(desc, "type", None) or "").upper()
    prop_type = _STYLE_MAP.get(style_raw, style_raw or None)

    # Auto-generate a human title
    bed_pfx  = f"{beds}BR " if beds else ""
    type_lbl = (prop_type or "Rental").replace("_", " ").title()
    title    = f"{bed_pfx}{type_lbl} in {city}" if city else (street or "Rental Property")

    # Available date — use list_date as the best proxy for for_rent listings
    ld             = getattr(prop, "list_date", None)
    available_date = None
    if ld:
        try:    available_date = ld.strftime("%Y-%m-%d")
        except: available_date = str(ld)[:10]

    # Photos
    photos = _collect_photos(prop)

    # Pets
    pets_allowed, pet_types = _parse_pet_policy(getattr(prop, "pet_policy", None))

    # Tags → amenities
    tags      = getattr(prop, "tags", None) or []
    amenities = _jdumps(tags)

    # Neighborhood
    hoods = getattr(prop, "neighborhoods", None) or []
    hood  = str(hoods[0]) if hoods else None

    # Rent
    rent = _safe_int(getattr(prop, "list_price", None))

    # Total bathrooms
    bath_total = None
    if bath_f is not None:
        bath_total = round((bath_f or 0) + (bath_h or 0) * 0.5, 1)

    # Original raw data — kept for audit trail
    original_data = {
        "property_url":  getattr(prop, "property_url",  None),
        "property_id":   getattr(prop, "property_id",   None),
        "listing_id":    getattr(prop, "listing_id",    None),
        "mls_id":        getattr(prop, "mls_id",        None),
        "status":        str(getattr(prop, "status",    None)),
        "list_price":    getattr(prop, "list_price",    None),
        "list_price_min":getattr(prop, "list_price_min",None),
        "list_price_max":getattr(prop, "list_price_max",None),
        "list_date":     str(ld),
        "neighborhoods": [str(n) for n in hoods],
        "hoa_fee":       getattr(prop, "hoa_fee",       None),
        "agent_name":    getattr(prop, "agent_name",    None),
        "broker_name":   getattr(prop, "broker_name",   None),
        "office_name":   getattr(prop, "office_name",   None),
        "_source":       "realtor",
    }

    now = _now()

    record = {
        # ── Identity ──────────────────────────────────────────────────────────
        "id":                    _gen_id(),
        "source":                "realtor",
        "source_url":            getattr(prop, "property_url",  None),
        "source_listing_id":     str(
            getattr(prop, "property_id", None) or
            getattr(prop, "mls_id",      None) or ""
        ),
        "status":                "scraped",

        # ── Address ───────────────────────────────────────────────────────────
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

        # ── Property details ──────────────────────────────────────────────────
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

        # ── Financials ────────────────────────────────────────────────────────
        "monthly_rent":          rent,
        "security_deposit":      rent,           # default: 1× monthly rent
        "last_months_rent":      None,
        "application_fee":       None,
        "pet_deposit":           None,
        "admin_fee":             None,
        "move_in_special":       None,
        "parking_fee":           None,
        "hoa_fee":               _safe_int(getattr(prop, "hoa_fee",            None)),
        "tax_value":             _safe_int(getattr(prop, "tax_assessed_value", None)),

        # ── Listing details ───────────────────────────────────────────────────
        "description":           desc_txt,
        "showing_instructions":  None,
        "available_date":        available_date,
        "minimum_lease_months":  None,
        "lease_terms":           "[]",

        # ── Pets & policies ───────────────────────────────────────────────────
        "pets_allowed":          pets_allowed,
        "pet_types_allowed":     _jdumps(pet_types),
        "pet_weight_limit":      None,
        "pet_details":           None,
        "smoking_allowed":       None,

        # ── Amenities & features ──────────────────────────────────────────────
        "parking":               _parking_str(getattr(prop, "parking", None)),
        "amenities":             amenities,
        "appliances":            "[]",
        "utilities_included":    "[]",
        "flooring":              "[]",
        "heating_type":          None,
        "cooling_type":          None,
        "laundry_type":          None,

        # ── Photos ────────────────────────────────────────────────────────────
        "original_image_urls":   _jdumps(photos),
        "local_image_paths":     "[]",

        # ── Agent / broker ────────────────────────────────────────────────────
        "agent_name":            getattr(prop, "agent_name",  None),
        "broker_name":           getattr(prop, "broker_name", None),
        "agent_image_url":       None,
        "poster_landlord_id":    None,

        # ── Pipeline metadata ─────────────────────────────────────────────────
        "original_data":         json.dumps(original_data, default=str),
        "edited_fields":         "[]",
        "inferred_features":     "[]",
        "published_at":          None,
        "choice_property_id":    None,
        "scraped_at":            now,
        "updated_at":            now,
    }

    # Compute derived quality fields
    record["data_quality_score"] = _quality_score(record)
    record["missing_fields"]     = _jdumps(_missing_fields(record))

    return record


# ── Deduplication ─────────────────────────────────────────────────────────────

def _get_existing_ids(source_ids):
    """Return the set of source_listing_ids already staged in pipeline."""
    if not source_ids:
        return set()
    # PostgREST `in` filter: source_listing_id=in.(id1,id2,...)
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
    result, err = _sb_post("pipeline_scrape_runs", payload)
    if err:
        print(f"  ⚠  Could not log scrape run: {err[:120]}")
    else:
        run_id = result[0]["id"] if (result and isinstance(result, list)) else "?"
        print(f"   📋  Scrape run logged  (id = {run_id})")


# ── Main runner ───────────────────────────────────────────────────────────────

def run(args):
    print("\n🏠  Choice Properties — HomeHarvest Scraper")
    print(f"   Location   : {args.location}")
    print(f"   Past days  : {args.past_days}")
    price_range = f"${args.price_min or 0} – ${args.price_max or '∞'}"
    beds_range  = f"{args.beds_min or 'any'} – {args.beds_max or 'any'}"
    print(f"   Price/mo   : {price_range}")
    print(f"   Beds       : {beds_range}")
    print(f"   Limit      : {args.limit}")
    print(f"   Extra data : {args.extra}")
    print(f"   Dry run    : {args.dry_run}")
    print()

    started_at = _now()

    # ── Step 1 · Scrape from Realtor.com ─────────────────────────────────────
    print("⏳  Scraping Realtor.com via HomeHarvest…")
    t0 = time.time()

    scrape_kwargs = dict(
        location             = args.location,
        listing_type         = "for_rent",
        past_days            = args.past_days,
        return_type          = "pydantic",
        limit                = args.limit,
        extra_property_data  = args.extra,
    )
    if args.beds_min  is not None: scrape_kwargs["beds_min"]  = args.beds_min
    if args.beds_max  is not None: scrape_kwargs["beds_max"]  = args.beds_max
    if args.price_min is not None: scrape_kwargs["price_min"] = args.price_min
    if args.price_max is not None: scrape_kwargs["price_max"] = args.price_max
    if args.property_type:         scrape_kwargs["property_type"] = args.property_type.split(",")

    try:
        props = scrape_property(**scrape_kwargs)
    except (InvalidListingType, AuthenticationError) as e:
        print(f"❌  Scrape error: {e}")
        _log_run(args.location, 0, 0, 0, str(e), started_at)
        return 1
    except Exception as e:
        print(f"❌  Unexpected scrape error: {e}")
        _log_run(args.location, 0, 0, 0, str(e), started_at)
        return 1

    elapsed       = round(time.time() - t0, 1)
    total_scraped = len(props)
    print(f"✅  Found {total_scraped} listings in {elapsed}s\n")

    if not props:
        print("   Nothing to stage.")
        _log_run(args.location, 0, 0, 0, None, started_at)
        return 0

    # ── Step 2 · Deduplication ────────────────────────────────────────────────
    source_ids = [
        str(getattr(p, "property_id", None) or getattr(p, "mls_id", None) or "")
        for p in props
    ]
    if not args.dry_run:
        existing = _get_existing_ids([sid for sid in source_ids if sid])
        print(f"   {len(existing)} already in pipeline — will be skipped")
    else:
        existing = set()

    # ── Step 3 · Map + insert ─────────────────────────────────────────────────
    count_new = count_dup = count_err = 0
    scores    = []

    for prop, sid in zip(props, source_ids):
        if sid and sid in existing:
            count_dup += 1
            continue

        record = _map_property(prop)
        scores.append(record["data_quality_score"])

        addr_label = (
            f"{record.get('address', '')} {record.get('city', '')}".strip()
            or record.get("source_url", "?")[:60]
        )

        if args.dry_run:
            print(
                f"  [DRY] {record['id']}  ${record['monthly_rent'] or '?'}/mo  "
                f"score={record['data_quality_score']}  {addr_label}"
            )
            count_new += 1
            continue

        result, err = _sb_post("pipeline_properties", record)
        if err:
            snippet = err[:160]
            print(f"  ❌  Insert failed — {addr_label}\n      {snippet}")
            count_err += 1
        else:
            print(
                f"  ✅  {record['id']}  ${record['monthly_rent'] or '?'}/mo  "
                f"score={record['data_quality_score']}  {addr_label}"
            )
            count_new += 1
            if sid:
                existing.add(sid)      # prevent double-insert within same run

    avg_score = round(sum(scores) / len(scores), 1) if scores else 0

    print(f"\n{'─'*55}")
    print(f"  New staged    : {count_new}")
    print(f"  Duplicates    : {count_dup}")
    print(f"  Errors        : {count_err}")
    print(f"  Avg score     : {avg_score}")
    print(f"{'─'*55}\n")

    if not args.dry_run:
        _log_run(
            args.location, total_scraped, count_new, avg_score,
            None, started_at, count_dup, count_err,
        )

    return 0


# ── CLI entry-point ───────────────────────────────────────────────────────────

def _build_parser():
    p = argparse.ArgumentParser(
        prog="scraper",
        description=(
            "Choice Properties — HomeHarvest Scraper\n"
            "Stages Realtor.com for-rent listings into pipeline.pipeline_properties."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python scraper.py --location "Austin, TX"
  python scraper.py --location "30301" --past-days 3 --price-max 2500
  python scraper.py --location "Los Angeles, CA" --beds-min 2 --beds-max 4 --limit 500
  python scraper.py --location "Miami, FL" --dry-run
        """,
    )
    p.add_argument(
        "--location", required=True,
        help='Location to search. Accepts: city, "City, ST", ZIP, address, county.',
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
        help="Maximum number of listings to fetch (default: 200, max: 10000).",
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
