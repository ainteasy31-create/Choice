#!/usr/bin/env python3
"""
Choice Properties — Scraper (v5)
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
import re
import json
import uuid
import time
import random
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
    from zillow_scraper import scrape_urls   as _zillow_scrape_urls
    _ZW_AVAILABLE = True
except ImportError as _e:
    _ZW_AVAILABLE = False
    _ZW_IMPORT_ERR = str(_e)

# ── Guard: Zillow services module (Apify, ScrapeBadger, Oxylabs) ──────────────
try:
    import sys as _sys_zs
    import os as _os_zs
    _sys_zs.path.insert(0, _os_zs.path.dirname(_os_zs.path.abspath(__file__)))
    from zillow_services import scrape_zillow_with_service as _zillow_service_scrape
    from zillow_services import get_available_services as _zillow_get_services
    _ZS_AVAILABLE = True
except ImportError as _e:
    _ZS_AVAILABLE = False
    _ZS_IMPORT_ERR = str(_e)

# ── Guard: Opendoor scraper module — opt-in only for explicit URLs ───────────
try:
    import sys as _sys_op
    import os as _os_op
    _sys_op.path.insert(0, _os_op.path.dirname(_os_op.path.abspath(__file__)))
    from opendoor_scraper import is_opendoor_url as _is_opendoor_url
    from opendoor_scraper import scrape_opendoor_url as _scrape_opendoor_url
    from opendoor_scraper import scrape_opendoor_urls as _scrape_opendoor_urls
    _OPENDOOR_AVAILABLE = True
except ImportError as _e:
    _OPENDOOR_AVAILABLE = False
    _OPENDOOR_IMPORT_ERR = str(_e)

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

# ── Guard: enrichment module ──────────────────────────────────────────────────
try:
    import sys as _sys2
    import os as _os2
    _sys2.path.insert(0, _os2.path.dirname(_os2.path.abspath(__file__)))
    from enrichment import apply_enrichment_pipeline as _enrich_pipeline
    _ENRICH_AVAILABLE = True
except Exception as _enrich_err:
    _ENRICH_AVAILABLE = False
    _ENRICH_ERR = str(_enrich_err)

# ── Dynamic pipeline publisher import helper ──────────────────────────────────
def _get_pipeline_orchestrator():
    try:
        import sys as _sys3
        import os as _os3
        _sys3.path.insert(0, _os3.path.dirname(_os3.path.abspath(__file__)))
        from pipeline import PipelineOrchestrator
        return PipelineOrchestrator, None
    except Exception as _pipeline_err:
        return None, str(_pipeline_err)

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

# ── Realtor.com Phase 2 — detail page enrichment ──────────────────────────────
REALTOR_DETAIL_WORKERS   = 5
REALTOR_DETAIL_DELAY     = (0.8, 2.0)
REALTOR_DETAIL_TIMEOUT   = 20
REALTOR_ENRICH_SKIP_SCORE = 999       # always fetch detail page — every listing needs photos

_REALTOR_UA_POOL = [
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/128.0.0.0 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/127.0.6533.119 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0"
    ),
    (
        "Mozilla/5.0 (X11; Linux x86_64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/127.0.0.0 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.6478.234 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) "
        "Version/17.5 Safari/605.1.15"
    ),
]

_REALTOR_BASE_HEADERS = {
    "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language":           "en-US,en;q=0.9",
    "Accept-Encoding":           "gzip, deflate, br",
    "Connection":                "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control":             "max-age=0",
    "sec-fetch-dest":            "document",
    "sec-fetch-mode":            "navigate",
    "sec-fetch-site":            "none",
    "sec-fetch-user":            "?1",
    "DNT":                       "1",
}

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


def _sb_post_batch(table, records, upsert=False, ignore_duplicates=False, on_conflict=None):
    prefer = "return=representation"
    if upsert:
        prefer += ",resolution=merge-duplicates"
    elif ignore_duplicates:
        prefer += ",resolution=ignore-duplicates"
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    if (upsert or ignore_duplicates) and on_conflict:
        url += f"?on_conflict={on_conflict}"
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


# ── Realtor.com property mapper (v5) ─────────────────────────────────────────
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

# ── Mapper helpers ─────────────────────────────────────────────────────────────

def _list_to_str(v):
    """Normalize list or string to comma-joined string, or None."""
    if not v:
        return None
    if isinstance(v, list):
        parts = [str(x).strip() for x in v if x and str(x).strip()]
        return ", ".join(parts) if parts else None
    s = str(v).strip()
    return s or None

def _parse_fee_str(s):
    """Extract integer dollar amount from a display string like '$1,200/mo' or '500'."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return int(s) if s else None
    clean = re.sub(r"[^\d.]", "", str(s))
    try:
        return int(float(clean)) if clean else None
    except Exception:
        return None

def _get_attr(obj, key):
    """Get attribute from pydantic model or dict."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)

def _details_texts(detail_list, *keywords):
    """
    Search a HomeDetails/PropertyDetails list for entries whose category or
    parent_category contains any keyword (case-insensitive substring match).
    Returns a flat deduplicated list of all text strings found.
    Handles both pydantic model instances and raw dicts.
    """
    out, seen = [], set()
    for d in (detail_list or []):
        cat  = (_get_attr(d, "category")        or "").lower()
        pcat = (_get_attr(d, "parent_category") or "").lower()
        if any(kw.lower() in cat or kw.lower() in pcat for kw in keywords):
            texts = _get_attr(d, "text") or []
            if isinstance(texts, str):
                texts = [texts]
            for t in (texts or []):
                t = str(t).strip()
                if t and t not in seen:
                    out.append(t)
                    seen.add(t)
    return out

# ── CDN URL normalisation ──────────────────────────────────────────────────────
_REALTOR_CDN_RE = re.compile(r"rdcpix\.com|realtor\.com/api/media")

def _upgrade_photo_url(url):
    """
    Upgrade a CDN photo URL to maximum available resolution/quality.

    Realtor.com CDN (rdcpix.com): replace size params with w-2016,q-95 —
    the CDN's maximum quality tier — instead of stripping to a blank path
    that may return a default (often lower) resolution.

    Other CDNs (Zillow, Zumper, etc.): strip _[qwhr]-N size params to get
    the original-resolution upload.
    """
    if not url:
        return url
    if _REALTOR_CDN_RE.search(url):
        # Upgrade to max: 2016px wide, 95 % quality, drop height / ratio caps
        s = re.sub(r"_q-\d+", "_q-95",  url)
        s = re.sub(r"_w-\d+", "_w-2016", s)
        s = re.sub(r"_h-\d+", "",        s)
        s = re.sub(r"_r-\d+", "",        s)
        return s
    # Other CDNs — strip all size params to get original upload
    return re.sub(r"_[qwhr]-\d+", "", url)


def _collect_photos(prop):
    """
    Collect all photo URLs from a HomeHarvest Property object.
    Checks all three locations: prop.description.(primary_photo/alt_photos),
    prop.photos (list of dicts), and legacy direct attrs on prop.
    Upgrades Realtor CDN URLs to w-2016,q-95; strips params on other CDNs.
    """
    urls, seen = [], set()

    def _add(u):
        if not u:
            return
        s = str(u).strip()
        if not s or not s.startswith("http"):
            return
        # Upgrade Realtor CDN to max quality; strip params on other CDNs
        s = _upgrade_photo_url(s)
        if s not in seen:
            urls.append(s)
            seen.add(s)

    # New model: photos live on description sub-object
    desc = getattr(prop, "description", None)
    if desc:
        _add(getattr(desc, "primary_photo", None))
        for p in (getattr(desc, "alt_photos", None) or []):
            _add(p)

    # prop.photos is a list of raw dicts from GraphQL (href key)
    for p in (getattr(prop, "photos", None) or []):
        if isinstance(p, dict):
            _add(p.get("href") or p.get("url") or p.get("src"))

    # Legacy: primary_photo / alt_photos directly on prop (older HH versions)
    _add(getattr(prop, "primary_photo", None))
    for p in (getattr(prop, "alt_photos", None) or []):
        _add(p)

    return urls[:50]

# ── Quality scoring (mirrors zillow_scraper.py) ───────────────────────────────
_IMPORTANT = [
    "address", "city", "state", "zip", "lat", "lng",
    "bedrooms", "bathrooms", "square_footage", "monthly_rent",
    "property_type", "description", "available_date",
]
_BONUS = [
    "county", "neighborhood", "year_built", "parking",
    "pets_allowed", "security_deposit", "amenities", "appliances",
    "heating_type", "cooling_type", "laundry_type",
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
    n = len(json.loads(r.get("original_image_urls") or "[]"))
    sc += 10 if n >= 12 else (7 if n >= 6 else (4 if n >= 3 else (1 if n >= 1 else 0)))
    return min(sc, 100)

def _missing_fields(r):
    return [f for f in _TRACKABLE_MISSING if r.get(f) in (None, "", "[]")]

def _map_realtor_property(prop):
    """
    Map a HomeHarvest Property pydantic object to a pipeline_properties record.
    Extracts every available field from:
      - prop.description   (beds/baths/sqft/yr_built/stories/garage/style/text)
      - prop.address       (street/unit/city/state/zip)
      - prop.details       (HomeDetails list: heating/cooling/appliances/flooring/
                            laundry/utilities/interior features/amenities/parking/basement)
      - prop.terms         (PropertyDetails list: lease terms/deposits/fees/smoking)
      - prop.monthly_fees  (HomMonthlyFee: parking fee etc.)
      - prop.one_time_fees (HomeOneTimeFee list: security deposit/app fee/pet deposit)
      - prop.parking       (HomeParkingDetails: description/assigned_space_rent)
      - prop.pet_policy    (PetPolicy: cats/dogs/dogs_small/dogs_large booleans)
      - prop.units         (Unit list: availability dates for multi-family)
      - prop.advertisers   (Advertisers: agent/broker/office names)
      - prop.tags          (list of amenity tags)
      - prop.photos        (GraphQL photo dict list)
    """

    # ── Description sub-object ────────────────────────────────────────────────
    desc     = getattr(prop, "description", None)
    addr_obj = getattr(prop, "address",     None)

    beds     = _safe_int(getattr(desc, "beds",       None)) if desc else None
    bath_f   = _safe_int(getattr(desc, "baths_full", None)) if desc else None
    bath_h   = _safe_int(getattr(desc, "baths_half", None)) if desc else None
    sqft     = _safe_int(getattr(desc, "sqft",       None)) if desc else None
    lot_sqft = _safe_int(getattr(desc, "lot_sqft",   None)) if desc else None
    yr_built = _safe_int(getattr(desc, "year_built", None)) if desc else None
    floors   = _safe_int(getattr(desc, "stories",    None)) if desc else None
    garage   = _safe_float(getattr(desc, "garage",   None)) if desc else None
    desc_txt = getattr(desc, "text", None)                  if desc else None

    # style can be a PropertyType enum or a plain string
    style_raw = getattr(desc, "style", None) or getattr(desc, "type", None) if desc else None
    if style_raw is not None and hasattr(style_raw, "value"):
        style_raw = style_raw.value
    style_raw = str(style_raw or "").upper()
    prop_type = _STYLE_MAP.get(style_raw, style_raw or None)

    # ── Address ───────────────────────────────────────────────────────────────
    # full_line is the complete street address string; prefer it over reconstructed street
    street  = (getattr(addr_obj, "full_line", None) or
               getattr(addr_obj, "street",    None)) if addr_obj else None
    unit    = getattr(addr_obj, "unit",  None) if addr_obj else None
    city    = getattr(addr_obj, "city",  None) if addr_obj else None
    state   = getattr(addr_obj, "state", None) if addr_obj else None
    # IMPORTANT: field is addr.zip (NOT zip_code — that attribute does not exist)
    zipcode = getattr(addr_obj, "zip",   None) if addr_obj else None

    # ── Title ─────────────────────────────────────────────────────────────────
    bath_total = None
    if bath_f is not None:
        bath_total = round((bath_f or 0) + (bath_h or 0) * 0.5, 1)
    bed_pfx  = (str(beds) + "BR ") if beds else ""
    type_lbl = (prop_type or "Rental").replace("_", " ").title()
    title    = (bed_pfx + type_lbl + " in " + city) if city else (street or "Rental Property")

    # ── Photos ────────────────────────────────────────────────────────────────
    photos = _collect_photos(prop)

    # ── prop.details — HomeDetails list ──────────────────────────────────────
    # Each item: category (str), text (list[str]), parent_category (str)
    # This is the richest source of structured property facts from Realtor.com's
    # GraphQL API and is populated from the search results (no extra fetch needed).
    details = getattr(prop, "details", None) or []

    heating_items   = _details_texts(details, "heating",    "heat type", "heat source")
    cooling_items   = _details_texts(details, "cooling",    "air conditioning", "a/c", "ac type")
    appliance_items = _details_texts(details, "appliance")
    flooring_items  = _details_texts(details, "flooring",   "floor description", "floor type")
    laundry_items   = _details_texts(details, "laundry")
    utility_items   = _details_texts(details, "utilities",  "utility", "water/sewer",
                                     "electric", "gas include", "trash include")
    amenity_items   = _details_texts(details, "interior features", "exterior features",
                                     "community features", "amenities", "security features",
                                     "pool features", "spa", "recreation",
                                     "accessibility features", "lot features")
    parking_items   = _details_texts(details, "parking features", "parking type",
                                     "garage description", "parking description")
    basement_items  = _details_texts(details, "basement")
    fireplace_items = _details_texts(details, "fireplace")

    # Raw MLS text (may be a combined blob containing both heating and cooling labels)
    _heating_raw = _list_to_str(heating_items)
    _cooling_raw = _list_to_str(cooling_items)
    _laundry_raw = _list_to_str(laundry_items)

    # Normalize: parse raw MLS blobs into separate heating vs cooling labels.
    # Import here to avoid circular; enrichment module is always present.
    try:
        from enrichment import normalize_heating_type as _nht, normalize_cooling_type as _nct
        heating_type = _nht(_heating_raw) or _nht(_cooling_raw)
        cooling_type = _nct(_cooling_raw) or _nct(_heating_raw)
    except Exception:
        heating_type = _heating_raw
        cooling_type = _cooling_raw

    # If heating and cooling are still identical after normalization, clear cooling
    # unless the text looks like a real AC type (not just duplicated MLS noise).
    if heating_type and heating_type == cooling_type:
        cooling_type = None

    laundry_type = _laundry_raw

    # has_basement
    has_basement = False
    if basement_items:
        btext = " ".join(basement_items).lower()
        if any(w in btext for w in ("full", "finished", "unfinished", "partial",
                                    "yes", "true", "walk", "daylight")):
            has_basement = True

    # has_central_air
    has_central_air = False
    if cooling_items:
        ctext = " ".join(cooling_items).lower()
        if "central" in ctext or "refrigerated" in ctext:
            has_central_air = True

    # ── prop.tags → base amenity set ─────────────────────────────────────────
    tags = getattr(prop, "tags", None) or []
    amenity_set = set(str(t).strip() for t in tags if t and str(t).strip())
    for item in amenity_items:
        amenity_set.add(item)
    if fireplace_items:
        amenity_set.add("Fireplace")

    # ── prop.terms — PropertyDetails list ────────────────────────────────────
    # Contains rental-specific info: lease terms, deposits, fees, policies
    terms = getattr(prop, "terms", None) or []

    lease_term_items = _details_texts(terms, "lease term",  "lease type",  "lease length",
                                             "rental term",  "lease option")
    available_items  = _details_texts(terms, "available",   "date available", "move-in date",
                                             "occupancy",    "possession")
    deposit_items    = _details_texts(terms, "security deposit", "deposit amount")
    pet_dep_items    = _details_texts(terms, "pet deposit",  "pet fee",     "animal fee")
    app_fee_items    = _details_texts(terms, "application fee", "app fee")
    park_fee_items   = _details_texts(terms, "parking fee",  "parking rent", "parking cost")
    smoking_items    = _details_texts(terms, "smoking",      "tobacco",     "no smoking")
    admin_fee_items  = _details_texts(terms, "admin fee",    "administrative fee")

    # ── minimum_lease_months from lease terms ─────────────────────────────────
    minimum_lease_months = None
    for lt in lease_term_items:
        lt_lo = lt.lower()
        m_mo  = re.search(r"(\d+)\s*month", lt_lo)
        if m_mo:
            minimum_lease_months = int(m_mo.group(1))
            break
        if re.search(r"month[- ]to[- ]month|month/month|m2m|mtm", lt_lo):
            minimum_lease_months = 1
            break
        if re.search(r"\byear\b|12[\s-]*month|annual", lt_lo):
            minimum_lease_months = 12
            break

    # ── available_date — terms first, then units, NOT list_date ───────────────
    available_date = None
    for raw in available_items:
        raw = raw.strip()
        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%B %d, %Y", "%b %d, %Y",
                    "%m-%d-%Y", "%d/%m/%Y"):
            try:
                available_date = datetime.strptime(raw[:10], fmt[:len(raw[:10])]).strftime("%Y-%m-%d")
                break
            except Exception:
                pass
        if available_date:
            break
        # Store raw text if it looks like a date expression
        if any(w in raw.lower() for w in ("immediate", "now", "ready", "available")):
            available_date = raw[:40]
            break

    # Try units (multi-family individual unit availability)
    if not available_date:
        for u_obj in (getattr(prop, "units", None) or []):
            avail = getattr(u_obj, "availability", None)
            if avail:
                d = getattr(avail, "date", None)
                if d:
                    try:
                        available_date = d.strftime("%Y-%m-%d")
                    except Exception:
                        available_date = str(d)[:10]
                    break

    # ── Fee extraction helpers ─────────────────────────────────────────────────
    def _first_fee(items):
        for s in items:
            v = _parse_fee_str(s)
            if v and v > 0:
                return v
        return None

    security_deposit = _first_fee(deposit_items)
    pet_deposit      = _first_fee(pet_dep_items)
    application_fee  = _first_fee(app_fee_items)
    parking_fee      = _first_fee(park_fee_items)
    admin_fee        = _first_fee(admin_fee_items)

    # ── prop.monthly_fees (HomMonthlyFee: description + display_amount) ───────
    monthly_fees = getattr(prop, "monthly_fees", None)
    if monthly_fees:
        mf_desc = (_get_attr(monthly_fees, "description") or "").lower()
        mf_amt  = _parse_fee_str(_get_attr(monthly_fees, "display_amount"))
        if mf_amt:
            if "parking" in mf_desc and not parking_fee:
                parking_fee = mf_amt
            elif "pet" in mf_desc and not pet_deposit:
                pet_deposit = mf_amt

    # ── prop.one_time_fees (list[HomeOneTimeFee]) ─────────────────────────────
    for fee_obj in (getattr(prop, "one_time_fees", None) or []):
        fee_desc = (_get_attr(fee_obj, "description") or "").lower()
        fee_amt  = _parse_fee_str(_get_attr(fee_obj, "display_amount"))
        if not fee_amt:
            continue
        if "security" in fee_desc and not security_deposit:
            security_deposit = fee_amt
        elif "application" in fee_desc and not application_fee:
            application_fee  = fee_amt
        elif "pet" in fee_desc and not pet_deposit:
            pet_deposit      = fee_amt
        elif "admin" in fee_desc and not admin_fee:
            admin_fee        = fee_amt
        elif "parking" in fee_desc and not parking_fee:
            parking_fee      = fee_amt

    # ── prop.parking (HomeParkingDetails) ─────────────────────────────────────
    parking_obj = getattr(prop, "parking", None)
    parking_str = None
    if parking_obj:
        if isinstance(parking_obj, dict):
            parking_str = parking_obj.get("description")
            if not parking_fee:
                r_val = parking_obj.get("assigned_space_rent") or parking_obj.get("unassigned_space_rent")
                if r_val:
                    parking_fee = _safe_int(r_val)
            # Legacy format: {garage: N, carport: bool, open: bool}
            if not parking_str:
                parts = []
                if parking_obj.get("garage"):
                    parts.append("Garage (" + str(parking_obj["garage"]) + " sp.)")
                if parking_obj.get("carport"):
                    parts.append("Carport")
                if parking_obj.get("open"):
                    parts.append("Open parking")
                parking_str = ", ".join(parts) if parts else None
        else:
            parking_str = getattr(parking_obj, "description", None)
            if not parking_fee:
                r_val = (getattr(parking_obj, "assigned_space_rent", None) or
                         getattr(parking_obj, "unassigned_space_rent", None))
                if r_val:
                    parking_fee = _safe_int(r_val)

    # Merge parking_items from details into parking string
    all_parking_parts = []
    if parking_str:
        all_parking_parts.append(parking_str)
    if parking_items:
        all_parking_parts.extend(parking_items)
    parking_final = _list_to_str(all_parking_parts)

    # ── prop.pet_policy (PetPolicy pydantic model) ────────────────────────────
    # Fields: cats (bool), dogs (bool), dogs_small (bool), dogs_large (bool)
    pet_policy_obj = getattr(prop, "pet_policy", None)
    pets_allowed   = None
    pet_types      = []
    if pet_policy_obj is not None:
        cats_ok  = _get_attr(pet_policy_obj, "cats")
        dogs_ok  = _get_attr(pet_policy_obj, "dogs")
        dogs_s   = _get_attr(pet_policy_obj, "dogs_small")
        dogs_l   = _get_attr(pet_policy_obj, "dogs_large")
        if cats_ok:
            pet_types.append("cats")
            pets_allowed = True
        if dogs_ok or dogs_s or dogs_l:
            if "dogs" not in pet_types:
                pet_types.append("dogs")
            pets_allowed = True
        if pets_allowed is None:
            # All explicitly False = no pets
            if any(v is False for v in (cats_ok, dogs_ok)):
                pets_allowed = False

    # ── smoking_allowed from terms ────────────────────────────────────────────
    smoking_allowed = None
    if smoking_items:
        stext = " ".join(smoking_items).lower()
        if any(w in stext for w in ("no smoking", "not allowed", "prohibited", "non-smoking")):
            smoking_allowed = False
        elif any(w in stext for w in ("allowed", "permitted", "yes")):
            smoking_allowed = True

    # ── Neighborhood ──────────────────────────────────────────────────────────
    # prop.neighborhoods is a comma-separated string in current HomeHarvest
    hood_raw = getattr(prop, "neighborhoods", None)
    if isinstance(hood_raw, str):
        hood = hood_raw.split(",")[0].strip() or None
    elif isinstance(hood_raw, (list, tuple)):
        hood = str(hood_raw[0]).strip() if hood_raw else None
    else:
        hood = None

    # ── Financials ────────────────────────────────────────────────────────────
    rent     = _safe_int(getattr(prop, "list_price", None))
    hoa_fee  = _safe_int(getattr(prop, "hoa_fee",    None))
    tax_val  = _safe_int(
        getattr(prop, "assessed_value", None) or
        getattr(prop, "tax_assessed_value", None) or
        getattr(prop, "tax", None)
    )

    # ── Agent / broker from advertisers ───────────────────────────────────────
    advertisers = getattr(prop, "advertisers", None)
    agent_name  = None
    broker_name = None
    office_name = None
    if advertisers:
        agent_obj  = _get_attr(advertisers, "agent")
        broker_obj = _get_attr(advertisers, "broker")
        office_obj = _get_attr(advertisers, "office")
        agent_name  = _get_attr(agent_obj,  "name")
        broker_name = _get_attr(broker_obj, "name")
        office_name = _get_attr(office_obj, "name")
    # Legacy fallback (older HH versions exposed these directly)
    if not agent_name:
        agent_name  = getattr(prop, "agent_name",  None)
    if not broker_name:
        broker_name = getattr(prop, "broker_name", None) or office_name

    # ── source_status — map Realtor.com listing status to canonical value ────
    _status_raw = str(getattr(prop, "status", None) or "").upper()
    if _status_raw in ("FOR_RENT", "ACTIVE", "FOR_LEASE", "ACTIVE_UNDER_CONTRACT"):
        _source_status = "available"
    elif _status_raw == "PENDING":
        _source_status = "pending"
    elif _status_raw in ("RENTED", "LEASED", "SOLD"):
        _source_status = "rented"
    elif _status_raw in ("OFF_MARKET", "WITHDRAWN", "CANCELLED", "EXPIRED", "REMOVED"):
        _source_status = "removed"
    elif _status_raw:
        _source_status = "available"  # default for unknown active statuses
    else:
        _source_status = "available"

    # ── original_data (full audit record) ────────────────────────────────────
    ld = getattr(prop, "list_date", None)
    original_data = {
        "property_url":     str(getattr(prop, "property_url",   None) or ""),
        "property_id":      getattr(prop, "property_id",        None),
        "listing_id":       getattr(prop, "listing_id",         None),
        "mls_id":           getattr(prop, "mls_id",             None),
        "mls":              getattr(prop, "mls",                None),
        "status":           str(getattr(prop, "status",         None) or ""),
        "list_price":       rent,
        "list_price_min":   getattr(prop, "list_price_min",     None),
        "list_price_max":   getattr(prop, "list_price_max",     None),
        "list_date":        str(ld) if ld else None,
        "days_on_mls":      getattr(prop, "days_on_mls",        None),
        "neighborhoods":    hood_raw,
        "hoa_fee":          hoa_fee,
        "nearby_schools":   getattr(prop, "nearby_schools",     None),
        "fips_code":        getattr(prop, "fips_code",          None),
        "tax":              getattr(prop, "tax",                 None),
        "new_construction": getattr(prop, "new_construction",   None),
        "agent_name":       agent_name,
        "broker_name":      broker_name,
        "office_name":      office_name,
        "_source":          "realtor",
        "_version":         "v5",
    }
    now = _now()
    record = {
        "id":                    _gen_id(),
        "source":                "realtor",
        "source_url":            str(getattr(prop, "property_url", None) or ""),
        "source_listing_id":     str(
            getattr(prop, "property_id", None) or
            getattr(prop, "mls_id",      None) or ""
        ),
        "status":                "scraped",
        "source_status":         _source_status,
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
        "bathrooms":             bath_total,  # full + 0.5 * half baths (accurate for filter)
        "half_bathrooms":        bath_h,
        "total_bathrooms":       bath_total,
        "square_footage":        sqft,
        "lot_size_sqft":         lot_sqft,
        "year_built":            yr_built,
        "floors":                floors,
        "garage_spaces":         _safe_int(garage) if garage is not None else None,
        "total_units":           None,
        "has_basement":          has_basement,
        "has_central_air":       has_central_air,
        "virtual_tour_url":      None,
        "monthly_rent":          rent,
        "security_deposit":      security_deposit,
        "last_months_rent":      None,
        "application_fee":       application_fee,
        "pet_deposit":           pet_deposit,
        "admin_fee":             admin_fee,
        "move_in_special":       None,
        "parking_fee":           parking_fee,
        "hoa_fee":               hoa_fee,
        "tax_value":             tax_val,
        "description":           desc_txt,
        "showing_instructions":  None,
        "available_date":        available_date,
        "listed_at":             str(ld)[:10] if ld else None,
        "minimum_lease_months":  minimum_lease_months,
        "lease_terms":           _jdumps(lease_term_items),
        "pets_allowed":          pets_allowed,
        "pet_types_allowed":     _jdumps(pet_types),
        "pet_weight_limit":      None,
        "pet_details":           None,
        "smoking_allowed":       smoking_allowed,
        "parking":               parking_final,
        "amenities":             _jdumps(sorted(amenity_set)) if amenity_set else "[]",
        "appliances":            _jdumps(appliance_items),
        "utilities_included":    _jdumps(utility_items),
        "flooring":              _jdumps(flooring_items),
        "heating_type":          heating_type,
        "cooling_type":          cooling_type,
        "laundry_type":          laundry_type,
        "original_image_urls":   _jdumps(photos),
        "local_image_paths":     "[]",
        "agent_name":            agent_name,
        "broker_name":           broker_name,
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

    # listed_at fallback: compute from days_on_mls if list_date was unavailable
    if not record.get("listed_at"):
        _dom_mls = _safe_int(getattr(prop, "days_on_mls", None))
        if _dom_mls is not None:
            try:
                from datetime import date as _date_r, timedelta as _td_r
                record["listed_at"] = (_date_r.today() - _td_r(days=_dom_mls)).isoformat()
            except Exception:
                pass

    return record


# ── Realtor.com Phase 2 — detail page fetch & enrichment ──────────────────────

def _fetch_realtor_detail_html(url, timeout=REALTOR_DETAIL_TIMEOUT):
    """
    Fetch a Realtor.com property detail page and return the raw HTML.
    Uses a rotated User-Agent and realistic browser headers.
    Realtor.com does NOT block datacenter IPs, so this runs fine from Replit.
    Returns HTML string or None on any error.
    """
    headers = dict(_REALTOR_BASE_HEADERS)
    headers["User-Agent"] = random.choice(_REALTOR_UA_POOL)
    headers["Referer"] = "https://www.realtor.com/realestateandhomes-search/"
    for attempt in range(1, 4):
        try:
            r = _requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
            if r.status_code == 200:
                return r.text
            if r.status_code == 429:
                wait = 30 * attempt
                time.sleep(wait)
                continue
            return None
        except Exception:
            if attempt < 3:
                time.sleep(5 * attempt)
            continue
    return None


def _extract_realtor_detail_property(html):
    """
    Parse a Realtor.com listing detail page HTML and extract the property object
    from the embedded Next.js __NEXT_DATA__ JSON.

    Realtor.com uses multiple JSON structures across versions:
      v1: props.pageProps.property
      v2: props.pageProps.pdpStoreState.property (newer builds)
      v3: props.pageProps.initialState.propertyDetails
      v4: props.pageProps.data.property (API-backed builds)

    Returns the property dict if found, None otherwise.
    """
    if not html:
        return None
    m = re.search(
        r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>\s*(.*?)\s*</script>',
        html, re.DOTALL,
    )
    if not m:
        return None
    try:
        nd = json.loads(m.group(1))
    except (ValueError, TypeError):
        return None

    pp = (nd.get("props") or {}).get("pageProps") or {}

    # Try all known paths from newest to oldest Realtor.com build
    candidate_paths = [
        ["pdpStoreState", "property"],
        ["property"],
        ["initialState", "propertyDetails"],
        ["data", "property"],
        ["componentProps", "property"],
        ["listing"],
    ]
    for path in candidate_paths:
        obj = pp
        for key in path:
            if not isinstance(obj, dict):
                obj = None
                break
            obj = obj.get(key)
        if (isinstance(obj, dict) and
                (obj.get("photos") or obj.get("description") or
                 obj.get("details") or obj.get("virtual_tours"))):
            return obj

    return None


def _collect_realtor_detail_photos(prop):
    """
    Collect up to 50 high-resolution photo URLs from a Realtor.com detail-page
    property object. Realtor.com stores photos in several locations:
      - prop.photos: list of {href, tags}  (primary — full CDN URL)
      - prop.description.primary_photo / alt_photos (fallback)
    Upgrades each URL to the highest available resolution by stripping size
    parameters (e.g. _q-80_w-1024_h-768_r-1) from the CDN path.
    """
    urls, seen = [], set()

    def _add(u):
        if not u:
            return
        s = str(u).strip()
        if s and s.startswith("http") and s not in seen:
            # Upgrade Realtor CDN to max quality; strip params on other CDNs
            target = _upgrade_photo_url(s)
            if target not in seen:
                urls.append(target)
                seen.add(target)
            # Also mark original as seen to prevent duplicates
            seen.add(s)

    # Primary source: prop.photos (present on detail page, absent on search)
    for p in (prop.get("photos") or []):
        if isinstance(p, dict):
            _add(p.get("href"))
        elif isinstance(p, str):
            _add(p)

    # Fallback: description sub-object photos
    desc = prop.get("description") or {}
    primary_photo = desc.get("primary_photo") or {}
    if isinstance(primary_photo, dict):
        _add(primary_photo.get("href"))
    for ap in (desc.get("alt_photos") or []):
        if isinstance(ap, dict):
            _add(ap.get("href"))
        elif isinstance(ap, str):
            _add(ap)

    return urls[:50]


def _enrich_realtor_from_detail(record, prop):
    """
    Overlay data from a Realtor.com detail-page property object onto an existing
    search-phase record (produced by _map_realtor_property).

    Strategy:
      - Photos    : always replace (detail always has more, higher resolution)
      - Description: replace if detail is longer
      - All other : fill in only if currently None/empty
      - Always    : re-compute quality score after enrichment
    """
    if not prop or not isinstance(prop, dict):
        return record

    desc     = prop.get("description") or {}
    location = prop.get("location") or {}
    terms    = prop.get("terms") or []
    details  = prop.get("details") or []

    # ── Photos (always replace — detail page has the full gallery) ─────────────
    detail_photos = _collect_realtor_detail_photos(prop)
    if detail_photos:
        # Always use detail photos if we have any — richer than search thumbnails
        record["original_image_urls"] = _jdumps(detail_photos)

    # ── Description (prefer longer text) ──────────────────────────────────────
    detail_text = desc.get("text") or prop.get("description_text") or ""
    if len(str(detail_text)) > len(str(record.get("description") or "")):
        record["description"] = detail_text

    # ── Virtual tour ──────────────────────────────────────────────────────────
    if not record.get("virtual_tour_url"):
        tours = prop.get("virtual_tours") or []
        for t in tours:
            if isinstance(t, dict):
                href = t.get("href") or t.get("url")
                if href:
                    record["virtual_tour_url"] = href
                    break

    # ── County from location object ────────────────────────────────────────────
    if not record.get("county"):
        county_obj = location.get("county") or {}
        if isinstance(county_obj, dict):
            record["county"] = county_obj.get("name")
        elif isinstance(county_obj, str) and county_obj:
            record["county"] = county_obj

    # ── Neighborhood from location.neighborhoods ───────────────────────────────
    if not record.get("neighborhood"):
        hoods = location.get("neighborhoods") or []
        if hoods:
            h0 = hoods[0]
            if isinstance(h0, dict):
                record["neighborhood"] = h0.get("name")
            elif isinstance(h0, str):
                record["neighborhood"] = h0

    # ── Location context: neighborhood + county + schools ─────────────────────
    if not record.get("location_context"):
        ctx_parts = []
        for h in (location.get("neighborhoods") or []):
            n = h.get("name") if isinstance(h, dict) else str(h)
            if n:
                ctx_parts.append(n)
        county_obj = location.get("county") or {}
        c_name = county_obj.get("name") if isinstance(county_obj, dict) else None
        if c_name and c_name not in ctx_parts:
            ctx_parts.append(c_name + " County")
        if ctx_parts:
            record["location_context"] = ", ".join(ctx_parts)

    # ── Showing instructions ───────────────────────────────────────────────────
    if not record.get("showing_instructions"):
        showing = prop.get("showing_details") or {}
        instr = (showing.get("instructions") or showing.get("showing_instructions") or
                 prop.get("showing_instructions"))
        if instr:
            record["showing_instructions"] = str(instr).strip()[:500]

    # ── Move-in special from terms ─────────────────────────────────────────────
    if not record.get("move_in_special"):
        for term in terms:
            cat = (_get_attr(term, "category") or "").lower()
            if any(w in cat for w in ("concession", "move-in", "move_in", "special offer",
                                      "incentive", "discount")):
                texts = _get_attr(term, "text") or []
                if isinstance(texts, str):
                    texts = [texts]
                if texts:
                    record["move_in_special"] = str(texts[0]).strip()[:200]
                    break

    # ── Available date (fill gap from details/terms if not already set) ────────
    if not record.get("available_date"):
        avail_items = _details_texts(terms, "available", "date available",
                                     "move-in date", "occupancy")
        for raw in avail_items:
            raw = raw.strip()
            for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%B %d, %Y", "%b %d, %Y"):
                try:
                    record["available_date"] = datetime.strptime(
                        raw[:10], fmt[:len(raw[:10])]
                    ).strftime("%Y-%m-%d")
                    break
                except Exception:
                    pass
            if record.get("available_date"):
                break
            if any(w in raw.lower() for w in ("immediate", "now", "ready", "available")):
                record["available_date"] = raw[:40]
                break

    # ── Coordinates (fill gap) ─────────────────────────────────────────────────
    if record.get("lat") is None:
        loc_addr = location.get("address") or {}
        record["lat"] = _safe_float(loc_addr.get("lat") or prop.get("lat"))
    if record.get("lng") is None:
        loc_addr = location.get("address") or {}
        record["lng"] = _safe_float(loc_addr.get("lon") or prop.get("lon"))

    # ── Property specs from description (fill gaps) ────────────────────────────
    if not record.get("square_footage"):
        record["square_footage"] = _safe_int(desc.get("sqft"))
    if not record.get("year_built"):
        record["year_built"] = _safe_int(desc.get("year_built"))
    if not record.get("bedrooms"):
        record["bedrooms"] = _safe_int(desc.get("beds"))

    # ── Nearby schools — stored in original_data for admin reference ───────────
    schools_data = prop.get("schools") or {}
    if schools_data:
        try:
            od = json.loads(record.get("original_data") or "{}")
            od["nearby_schools"] = schools_data
            od["_phase"] = "detail_enriched"
            record["original_data"] = json.dumps(od, default=str)
        except Exception:
            pass

    # ── Walk / bike / transit scores → location_context ───────────────────────
    ws = prop.get("walkScore")
    ts = prop.get("transitScore")
    bs = prop.get("bikeScore")
    score_parts = []
    if ws is not None:
        score_parts.append("Walk score: " + str(ws))
    if ts is not None:
        score_parts.append("Transit score: " + str(ts))
    if bs is not None:
        score_parts.append("Bike score: " + str(bs))
    if score_parts:
        existing_ctx = record.get("location_context") or ""
        score_str = "; ".join(score_parts)
        record["location_context"] = (
            (existing_ctx + "; " + score_str) if existing_ctx else score_str
        )

    # ── Amenities from detail page tags (merge, deduplicate) ──────────────────
    detail_tags = list(prop.get("tags") or [])
    for d in (details or []):
        cat = (_get_attr(d, "category") or "").lower()
        if any(w in cat for w in ("amenities", "community features", "interior features",
                                  "exterior features", "pool", "recreation")):
            for t in (_get_attr(d, "text") or []):
                if t and str(t).strip():
                    detail_tags.append(str(t).strip())
    if detail_tags:
        try:
            existing = set(json.loads(record.get("amenities") or "[]"))
        except (ValueError, TypeError):
            existing = set()
        merged = list(existing) + [t for t in detail_tags if t not in existing]
        if merged:
            record["amenities"] = json.dumps(merged)

    # ── Auto-rebuild title if we now have richer data ─────────────────────────
    if record.get("bedrooms") and record.get("city") and record.get("property_type"):
        bed_pfx  = str(record["bedrooms"]) + "BR "
        type_lbl = record["property_type"].replace("_", " ").title()
        record["title"] = bed_pfx + type_lbl + " in " + record["city"]

    # ── Re-score ───────────────────────────────────────────────────────────────
    record["data_quality_score"] = _quality_score(record)
    record["missing_fields"]     = _jdumps(_missing_fields(record))

    return record


def _enrich_realtor_batch(records, verbose=False):
    """
    Phase 2 for Realtor.com: concurrently fetch each listing's detail page
    and call _enrich_realtor_from_detail() to fill in virtual tour, full
    photo gallery, showing instructions, move-in specials, schools, walk
    scores, location context, and more.

    Skips records that already have a quality score >= REALTOR_ENRICH_SKIP_SCORE
    (they are already data-complete from HomeHarvest's extra_property_data mode).

    Works fine from Replit — Realtor.com does NOT block datacenter IPs.
    """
    to_fetch = []
    for i, rec in enumerate(records):
        url   = rec.get("source_url") or ""
        score = rec.get("data_quality_score", 0)
        if url and "realtor.com" in url and score < REALTOR_ENRICH_SKIP_SCORE:
            to_fetch.append((i, url))

    if not to_fetch:
        if verbose:
            print("   [Realtor Phase 2] All records already high-quality — skipping detail fetch.")
        return records

    if verbose:
        print(
            "\n   [Realtor Phase 2] Fetching detail pages for "
            + str(len(to_fetch)) + "/" + str(len(records)) + " listing(s)..."
        )

    lock          = threading.Lock()
    enriched_count = [0]
    done_count    = [0]

    def _fetch_one(idx_url):
        idx, url = idx_url
        time.sleep(random.uniform(*REALTOR_DETAIL_DELAY))
        html = _fetch_realtor_detail_html(url)
        prop = _extract_realtor_detail_property(html) if html else None
        if prop:
            with lock:
                _enrich_realtor_from_detail(records[idx], prop)
                enriched_count[0] += 1
        with lock:
            done_count[0] += 1
            if verbose and done_count[0] % 10 == 0:
                print(
                    "   [Realtor Phase 2] "
                    + str(done_count[0]) + "/" + str(len(to_fetch))
                    + " pages fetched, "
                    + str(enriched_count[0]) + " enriched..."
                )
        return idx, bool(prop)

    workers = min(REALTOR_DETAIL_WORKERS, len(to_fetch))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(_fetch_one, item): item for item in to_fetch}
        for f in as_completed(futures):
            f.result()

    if verbose:
        skipped = len(records) - len(to_fetch)
        print(
            "   [Realtor Phase 2] Done — "
            + str(enriched_count[0]) + " enriched, "
            + str(len(to_fetch) - enriched_count[0]) + " no detail data, "
            + str(skipped) + " skipped (already high-quality)"
        )

    return records


# ── Deduplication ─────────────────────────────────────────────────────────────

def _get_existing_ids(source_ids):
    """Return the set of source_listing_ids already in the pipeline table.

    Splits into chunks of 100 to avoid GET URL length limits (414 Too Long)
    that can occur when a large batch of IDs is joined into a single query string.
    """
    if not source_ids:
        return set()
    import urllib.parse
    existing = set()
    chunk_size = 100
    chunks = [source_ids[i:i + chunk_size] for i in range(0, len(source_ids), chunk_size)]
    for chunk in chunks:
        encoded = urllib.parse.quote(",".join(chunk))
        rows, err = _sb_get(
            "pipeline_properties",
            f"source_listing_id=in.({encoded})&select=source_listing_id&limit=10000",
        )
        if err:
            print(f"  ⚠  Dedup check error (continuing without dedup): {err[:120]}")
            return set()  # fail open — DB UNIQUE constraint is the final safety net
        existing.update(r["source_listing_id"] for r in rows)
    return existing


# ── Scrape-run logger ─────────────────────────────────────────────────────────

def _log_run(location, source, count_total, count_new, avg_score,
             error_msg, started_at, count_dup=0, count_err=0, count_watermarked=0):
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
        "count_watermarked":         count_watermarked,
        "count_validation_rejected": 0,
        "count_image_failed":        count_err,
        "partial":                   False,
    }
    _sb_post_batch("pipeline_scrape_runs", [payload])


# ── Batch insert worker ───────────────────────────────────────────────────────

def _insert_batch(batch, upsert, batch_num, total_batches, source_label):
    # When not upserting, use ignore-duplicates so the DB UNIQUE constraint
    # is the final safety net (silently skips conflicting rows instead of erroring).
    inserted, err = _sb_post_batch(
        "pipeline_properties", batch, upsert=upsert,
        ignore_duplicates=(not upsert), on_conflict="source_listing_id",
    )
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
    Dedup + enrich + batch-insert a list of pipeline-ready records.
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

    # ── Enrichment pipeline ───────────────────────────────────────────────────
    count_watermarked = 0
    if records and _ENRICH_AVAILABLE and not getattr(args, "no_enrich", False):
        no_detail_fetch = getattr(args, "no_detail_enrich", False)
        try:
            records, count_watermarked = _enrich_pipeline(
                records,
                verbose=True,
                enable_detail_fetch=(not no_detail_fetch),
            )
        except Exception as _ee:
            print(f"  ⚠  Enrichment pipeline error (continuing without enrichment): {_ee}")
    elif not _ENRICH_AVAILABLE:
        print("  ⚠  Enrichment module unavailable: " + str(globals().get("_ENRICH_ERR", "?")))

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
        _log_run(location, source_label, total_scraped, 0, 0, None, started_at,
                 count_dup, 0, count_watermarked)
        return 0, count_dup, 0, 0

    # ── ImageKit image upload (permanent scraper behavior) ────────────────────
    # Upload every listing image to ImageKit CDN before staging. This runs for
    # every scraping job automatically — Zillow/Realtor CDN URLs are temporary;
    # ImageKit URLs are permanent. Never publish listings with source-CDN images
    # when ImageKit is configured.
    _ik_full = _ik_partial = _ik_no_img = 0
    try:
        import sys as _iksys
        import os as _ikos
        _iksys.path.insert(0, _ikos.path.dirname(_ikos.path.abspath(__file__)))
        from imagekit_upload import upload_images as _ik_upload, is_configured as _ik_ok
        if _ik_ok():
            print(f"\n📸  [{source_label}] Uploading images to ImageKit ({len(records)} listings)...")
            for _rec in records:
                _src_urls = []
                try:
                    _src_urls = json.loads(_rec.get("original_image_urls") or "[]")
                except (ValueError, TypeError):
                    pass
                if not _src_urls:
                    _ik_no_img += 1
                    continue
                _ik_urls, _ik_failed = _ik_upload(_src_urls, _rec["id"], verify=True, verbose=False)
                # Store ImageKit URLs as the permanent CDN copies (in original order)
                _rec["local_image_paths"] = json.dumps(_ik_urls)
                # Record upload validation result in original_data for admin review
                try:
                    _od = json.loads(_rec.get("original_data") or "{}")
                except (ValueError, TypeError):
                    _od = {}
                _od["imagekit_uploaded"] = len(_ik_urls)
                _od["imagekit_failed"]   = _ik_failed
                _od["imagekit_ready"]    = (_ik_failed == 0 and len(_ik_urls) > 0)
                _rec["original_data"] = json.dumps(_od, default=str)
                if _ik_failed > 0:
                    _ik_partial += 1
                    _addr = " ".join(filter(None, [_rec.get("address"), _rec.get("city")])) or _rec.get("id", "?")
                    print(f"  ⚠  [IK] {_addr}: {_ik_failed} image(s) failed — review before publishing")
                else:
                    _ik_full += 1
            print(f"   [IK] {_ik_full} fully uploaded, {_ik_partial} partial, {_ik_no_img} no images")
        else:
            print(
                f"   [IK] ImageKit upload skipped — "
                "set IMAGEKIT_PRIVATE_KEY + IMAGEKIT_URL_ENDPOINT in .env to enable"
            )
    except ImportError:
        print("   [IK] imagekit_upload module not found — skipping image upload")
    except Exception as _ik_err:
        print(f"   [IK] Image upload step error (staging continues): {_ik_err}")
    # ── End ImageKit upload ────────────────────────────────────────────────────

    # ── Pre-staging validation log ─────────────────────────────────────────────
    # Log records missing listed_at or with image issues so admin can review
    # before approving publication. Records are always staged — the admin
    # pipeline is the final gate before any listing goes live.
    _val_warn = 0
    for _rec in records:
        _issues = []
        if not _rec.get("listed_at"):
            _issues.append("no original listing date captured")
        try:
            _n_src = len(json.loads(_rec.get("original_image_urls") or "[]"))
            _n_ik  = len(json.loads(_rec.get("local_image_paths") or "[]"))
        except (ValueError, TypeError):
            _n_src = _n_ik = 0
        if _n_src > 0 and _n_ik == 0:
            _issues.append(f"0/{_n_src} images uploaded to ImageKit")
        elif _n_src > 0 and _n_ik < _n_src:
            _issues.append(f"{_n_ik}/{_n_src} images on ImageKit ({_n_src - _n_ik} failed)")
        if _issues:
            _val_warn += 1
            _a = " ".join(filter(None, [_rec.get("address"), _rec.get("city")])) or _rec.get("id", "?")
            print(f"  ⚠  [validation] {_a}: " + "; ".join(_issues))
    if _val_warn:
        print(f"  ⚠  [{source_label}] {_val_warn} record(s) have validation warnings — review before publishing")
    # ── End pre-staging validation ─────────────────────────────────────────────

    batches       = [records[i:i+BATCH_SIZE] for i in range(0, len(records), BATCH_SIZE)]
    total_batches = len(batches)
    workers       = min(MAX_WORKERS, total_batches)
    print(f"\n📦  [{source_label}] Staging {len(records)} listing(s) in "
          f"{total_batches} batch(es) [{workers} worker(s)]...")

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
             None, started_at, count_dup, count_err, count_watermarked)
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

    # ── Phase 2: enrich from Realtor.com detail pages ─────────────────────────
    if records and not getattr(args, "no_realtor_details", False):
        t1 = time.time()
        records = _enrich_realtor_batch(records, verbose=True)
        elapsed2 = round(time.time() - t1, 1)
        avg_after = round(
            sum(r["data_quality_score"] for r in records) / len(records), 1
        ) if records else 0
        print(f"   [Realtor Phase 2] Completed in {elapsed2}s — avg quality score: {avg_after}")
    elif getattr(args, "no_realtor_details", False):
        print("   [Realtor Phase 2] Skipped (--no-realtor-details flag set)")

    return _stage_records(records, location, "realtor", args, started_at)


# ── Generic URL scraper (non-Zillow sites: RentProgress, Apartments.com, etc.) ─

def _scrape_generic_url(url):
    """
    Best-effort property data extraction from any rental listing URL.

    Tries (in order):
    1. Schema.org JSON-LD (<script type="application/ld+json">)
    2. URL path heuristics (rentprogress.com, apartments.com, etc.)
    3. Returns a minimal stub record so the listing is at least in the pipeline.

    Returns a pipeline record dict or None on hard failure.
    """
    import re as _re
    import json as _json
    import time as _time

    # ── User-Agent rotation (same pool as zillow scraper) ─────────────────────
    UAS = [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ]

    headers = {
        "User-Agent": random.choice(UAS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    # ── Detect known sites from URL structure ─────────────────────────────────
    source_name = "web"
    source_id   = ""

    # rentprogress.com / Progress Residential
    # URL: https://rentprogress.com/property-details/{street}/{city}/{state}/{zip}/{id}
    rp_match = _re.search(
        r"rentprogress\.com/property-details/([^/?#]+)/([^/?#]+)/([^/?#]+)/([^/?#]+)/([^/?#]+)",
        url,
    )
    if rp_match:
        source_name = "rentprogress"
        raw_street, raw_city, raw_state, raw_zip, raw_id = rp_match.groups()
        source_id   = raw_id
        # Convert hyphenated slugs to human-readable
        def _slug(s):
            return s.replace("-", " ").title()
        url_address = _slug(raw_street)
        url_city    = _slug(raw_city)
        url_state   = raw_state.upper()
        url_zip     = raw_zip
    else:
        url_address = url_city = url_state = url_zip = None

    # ── Fetch page HTML ───────────────────────────────────────────────────────
    try:
        resp = _requests.get(url.split("?")[0], headers=headers, timeout=20)
        html = resp.text
    except Exception as e:
        print("  [generic url] HTTP error: " + str(e))
        return None

    # ── Try __NEXT_DATA__ (Next.js pages like rentprogress.com) ───────────────
    nd_match = _re.search(r'<script[^>]+id="__NEXT_DATA__"[^>]*>(\{.*?\})</script>', html, _re.DOTALL)
    ld_prop  = None

    if nd_match:
        try:
            nd = _json.loads(nd_match.group(1))
            # Walk pageProps for a property object
            pp = (nd.get("props") or {}).get("pageProps") or {}
            ld_prop = (
                pp.get("property")
                or pp.get("propertyDetails")
                or pp.get("listing")
                or pp.get("data")
                or {}
            )
            if not ld_prop:
                # rentprogress buries data a level deeper
                for v in pp.values():
                    if isinstance(v, dict) and (v.get("address") or v.get("price") or v.get("bedrooms")):
                        ld_prop = v
                        break
        except Exception:
            ld_prop = None

    # ── Try JSON-LD schema.org ────────────────────────────────────────────────
    jsonld_prop = None
    for ld_match in _re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', html, _re.DOTALL
    ):
        try:
            obj = _json.loads(ld_match.group(1))
            if not isinstance(obj, dict):
                continue
            types = [obj.get("@type", "")] if isinstance(obj.get("@type"), str) else (obj.get("@type") or [])
            if any(t in ("Residence", "SingleFamilyResidence", "RealEstateAgent",
                         "RentAction", "LodgingBusiness", "Apartment") for t in types):
                jsonld_prop = obj
                break
            # Fallback: any ld+json that has an address
            if isinstance(obj.get("address"), dict) and not jsonld_prop:
                jsonld_prop = obj
        except Exception:
            pass

    # ── Extract fields from best available data source ────────────────────────
    def _pick(*args):
        "Return first truthy value."
        for a in args:
            if a:
                return a
        return None

    def _price(v):
        if not v:
            return None
        m = _re.search(r"[\d,]+", str(v).replace(",", ""))
        try:
            return int(m.group(0)) if m else None
        except Exception:
            return None

    now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    # Pull values from __NEXT_DATA__ first (usually richer), then JSON-LD
    nd  = ld_prop  or {}
    jld = jsonld_prop or {}

    address_block = nd.get("address") or jld.get("address") or {}
    if isinstance(address_block, str):
        address_block = {}

    address   = _pick(nd.get("streetAddress"), nd.get("address1"),
                      address_block.get("streetAddress"), url_address)
    city      = _pick(nd.get("city"), address_block.get("addressLocality"), url_city)
    state     = _pick(nd.get("state"), nd.get("stateCode"),
                      address_block.get("addressRegion"), url_state)
    zip_code  = _pick(nd.get("zipCode"), nd.get("zip"), nd.get("postalCode"),
                      address_block.get("postalCode"), url_zip)
    bedrooms  = _pick(nd.get("bedrooms"), nd.get("beds"), nd.get("bedroom"),
                      jld.get("numberOfRooms"))
    bathrooms = _pick(nd.get("bathrooms"), nd.get("baths"), nd.get("bathroom"))
    sqft      = _pick(nd.get("squareFeet"), nd.get("livingArea"),
                      nd.get("sqft"), nd.get("size"))
    price     = _price(_pick(nd.get("price"), nd.get("rent"), nd.get("monthlyRent"),
                             jld.get("priceRange")))
    desc      = _pick(nd.get("description"), nd.get("propertyDescription"),
                      jld.get("description"))

    def _safe_int(v):
        try:
            return int(float(str(v).replace(",", "")))
        except Exception:
            return None

    def _safe_float(v):
        try:
            return float(str(v).replace(",", ""))
        except Exception:
            return None

    # Photos
    photos = []
    for key in ("photos", "images", "propertyPhotos", "photoUrls"):
        raw = nd.get(key) or []
        for p in raw:
            if isinstance(p, str) and p.startswith("http"):
                photos.append(p)
            elif isinstance(p, dict):
                u = p.get("url") or p.get("src") or p.get("href")
                if u and isinstance(u, str) and u.startswith("http"):
                    photos.append(u)
        if photos:
            break

    # Build a quality score
    filled = sum(1 for v in [address, city, state, zip_code, price, bedrooms, bathrooms, sqft]
                 if v is not None)
    score  = min(100, filled * 12 + len(photos) * 2)

    missing = [f for f, v in {
        "address": address, "city": city, "state": state, "zip": zip_code,
        "monthly_rent": price, "bedrooms": bedrooms, "bathrooms": bathrooms,
        "square_footage": sqft,
    }.items() if not v]

    title = None
    if city and bedrooms:
        title = str(bedrooms) + "BR Rental in " + city
    elif address:
        title = address

    record = {
        "id":                    _gen_id(),
        "source":                source_name,
        "source_url":            url.split("?")[0],
        "source_listing_id":     source_id,
        "status":                "scraped",
        "title":                 title,
        "address":               address,
        "unit_number":           None,
        "city":                  city,
        "state":                 state,
        "zip":                   zip_code,
        "county":                None,
        "neighborhood":          None,
        "lat":                   _safe_float(nd.get("latitude") or nd.get("lat")),
        "lng":                   _safe_float(nd.get("longitude") or nd.get("lng")),
        "location_context":      None,
        "property_type":         nd.get("propertyType") or nd.get("homeType"),
        "bedrooms":              _safe_int(bedrooms),
        "bathrooms":             _safe_float(bathrooms),
        "half_bathrooms":        None,
        "total_bathrooms":       _safe_float(bathrooms),
        "square_footage":        _safe_int(sqft),
        "lot_size_sqft":         None,
        "year_built":            _safe_int(nd.get("yearBuilt")),
        "floors":                None,
        "garage_spaces":         None,
        "total_units":           None,
        "has_basement":          None,
        "has_central_air":       None,
        "virtual_tour_url":      None,
        "monthly_rent":          price,
        "security_deposit":      _price(nd.get("depositAmount") or nd.get("securityDeposit")),
        "application_fee":       _price(nd.get("applicationFee")),
        "pet_deposit":           None,
        "admin_fee":             None,
        "move_in_special":       None,
        "parking_fee":           None,
        "hoa_fee":               None,
        "last_months_rent":      None,
        "tax_value":             None,
        "description":           desc,
        "showing_instructions":  None,
        "available_date":        nd.get("availableDate") or nd.get("availableDateNormalized"),
        "minimum_lease_months":  None,
        "lease_terms":           "[]",
        "pets_allowed":          None,
        "pet_types_allowed":     "[]",
        "pet_weight_limit":      None,
        "pet_details":           None,
        "smoking_allowed":       None,
        "parking":               None,
        "amenities":             json.dumps(list(nd.get("amenities") or []) or []),
        "appliances":            "[]",
        "utilities_included":    "[]",
        "flooring":              "[]",
        "heating_type":          None,
        "cooling_type":          None,
        "laundry_type":          None,
        "original_image_urls":   json.dumps(photos[:30]),
        "local_image_paths":     "[]",
        "agent_name":            None,
        "broker_name":           None,
        "agent_image_url":       None,
        "poster_landlord_id":    None,
        "original_data":         json.dumps({
            "_source":   source_name,
            "_phase":    "url_direct",
            "_url":      url,
            "_nd_keys":  list(nd.keys())[:30] if nd else [],
        }, default=str),
        "edited_fields":         "[]",
        "inferred_features":     "[]",
        "data_quality_score":    score,
        "missing_fields":        json.dumps(missing),
        "published_at":          None,
        "choice_property_id":    None,
        "scraped_at":            now,
        "updated_at":            now,
    }
    return record


# ── URL-list scrape runner ─────────────────────────────────────────────────────

def _upsert_one(rec, upsert=False):
    """
    Insert (or upsert) a single pipeline record.
    Returns 'new', 'dup', or 'err'.
    """
    if not upsert:
        sid = rec.get("source_listing_id", "")
        if sid:
            existing = _get_existing_ids([sid])
            if sid in existing:
                return "dup"
    count, err = _sb_post_batch("pipeline_properties", [rec], upsert=upsert)
    if err:
        print("  [error] Insert failed: " + err[:160])
        return "err"
    return "new"


def _run_urls(urls, args, started_at):
    """
    Scrape a list of individual listing URLs (Zillow or other sites) into the pipeline.
    Zillow URLs get full Phase 2 enrichment; other URLs get best-effort generic extraction.
    """
    if not urls:
        return [], 0, 0, 0

    zillow_urls  = [u for u in urls if "zillow.com" in u]
    generic_urls = [u for u in urls if "zillow.com" not in u and not _is_opendoor_url(u)]
    opendoor_urls = [u for u in urls if _is_opendoor_url(u)]

    all_records = []

    # ── Opendoor URLs ──────────────────────────────────────────────────────────
    if opendoor_urls:
        if not _OPENDOOR_AVAILABLE:
            print("❌  Opendoor module unavailable — cannot scrape Opendoor URLs.")
        elif not args.allow_opendoor:
            print("❌  Opendoor scraping requires --allow-opendoor. Skipping Opendoor URLs.")
        else:
            print("\n" + ("─" * 55))
            print("🏠  Opendoor URL scrape: " + str(len(opendoor_urls)) + " listing(s)")
            print("─" * 55)
            try:
                o_records = _scrape_opendoor_urls(opendoor_urls, verbose=True)
                all_records.extend(o_records)
                if len(o_records) < len(opendoor_urls):
                    print("  ⚠  " + str(len(opendoor_urls) - len(o_records)) + " Opendoor URL(s) failed to scrape.")
            except Exception as e:
                print("❌  Opendoor URL scrape error: " + str(e))

    # ── Zillow URLs ───────────────────────────────────────────────────────────
    if zillow_urls:
        if not _ZW_AVAILABLE:
            print("❌  Zillow module unavailable — cannot scrape Zillow URLs.")
        else:
            print("\n" + ("─" * 55))
            print("🏠  Zillow URL scrape: " + str(len(zillow_urls)) + " listing(s)")
            print("─" * 55)
            try:
                z_records, z_failed = _zillow_scrape_urls(zillow_urls, verbose=True)
                all_records.extend(z_records)
                if z_failed:
                    print("  ⚠  " + str(len(z_failed)) + " Zillow URL(s) failed to scrape.")
            except Exception as e:
                print("❌  Zillow URL scrape error: " + str(e))

    # ── Generic URLs ──────────────────────────────────────────────────────────
    if generic_urls:
        print("\n" + ("─" * 55))
        print("🌐  Generic URL scrape: " + str(len(generic_urls)) + " listing(s)")
        print("─" * 55)
        for i, url in enumerate(generic_urls):
            print("  [" + str(i + 1) + "/" + str(len(generic_urls)) + "] " + url)
            if i > 0:
                time.sleep(random.uniform(1.5, 3.0))
            try:
                rec = _scrape_generic_url(url)
                if rec:
                    all_records.append(rec)
                    addr = " ".join(filter(None, [rec.get("address"), rec.get("city"), rec.get("state")]))
                    print("  [ok] " + (addr or "?") + " score=" + str(rec.get("data_quality_score", 0)))
                else:
                    print("  [failed] Could not extract data from: " + url)
            except Exception as e:
                print("  [error] " + str(e))

    if not all_records:
        print("\n❌  No records extracted from any URL.")
        return [], 0, 0, 0

    # ── Dry run ───────────────────────────────────────────────────────────────
    if args.dry_run:
        print("\n🔍  DRY RUN — would stage " + str(len(all_records)) + " record(s):")
        for r in all_records:
            addr  = " ".join(filter(None, [r.get("address"), r.get("city"), r.get("state"), r.get("zip")]))
            rent  = ("$" + str(r["monthly_rent"]) + "/mo") if r.get("monthly_rent") else "no rent"
            score = r.get("data_quality_score", 0)
            imgs  = len(json.loads(r.get("original_image_urls") or "[]"))
            src   = r.get("source", "?")
            print("  [" + src + "] " + (addr or "?") + " — " + rent
                  + "  Q=" + str(score) + "  photos=" + str(imgs))
        return all_records, len(all_records), 0, 0

    if args.publish:
        return all_records, len(all_records), 0, 0

    # ── Insert into pipeline ──────────────────────────────────────────────────
    new_count = dup_count = err_count = 0
    for rec in all_records:
        result = _upsert_one(rec, args.upsert)
        if result == "new":
            new_count += 1
        elif result == "dup":
            dup_count += 1
        else:
            err_count += 1

    if args.publish:
        print("\n" + ("═" * 55))
        print("  URL scrape results:")
        print("  Extracted   : " + str(len(all_records)))
        print("  Errors      : " + str(err_count))
        print("═" * 55)
        _log_run("url-list", "url", len(all_records), len(all_records), 0, None, started_at)
        return all_records, len(all_records), dup_count, err_count

    print("\n" + ("═" * 55))
    print("  URL scrape results:")
    print("  Staged new  : " + str(new_count))
    print("  Skipped/dup : " + str(dup_count))
    print("  Errors      : " + str(err_count))
    print("═" * 55)

    _log_run("url-list", "url", new_count, dup_count, err_count, None, started_at)
    return all_records, new_count, dup_count, err_count


# ── Zillow scrape for one location ────────────────────────────────────────────

def _run_zillow(location, args, started_at):
    # Check if service-based scraping is requested and available
    zillow_service = getattr(args, "zillow_service", "auto")
    
    # Try service-based scraping if not explicitly set to direct
    if zillow_service != "direct" and _ZS_AVAILABLE:
        print(f"\n{'─'*55}")
        print(f"🏠  Zillow scrape ({zillow_service}): {location}")
        print(f"{'─'*55}")
        
        try:
            records, blocked, service_used = _zillow_service_scrape(
                location=location,
                service=zillow_service,
                limit=args.limit,
                beds_min=args.beds_min,
                beds_max=args.beds_max,
                price_min=args.price_min,
                price_max=args.price_max,
                verbose=True,
            )
            
            if blocked:
                msg = "Zillow blocked the request (bot detection). Try a different service or residential IP."
                print(f"  ⛔  {msg}")
                _log_run(location, "zillow", 0, 0, 0, msg, started_at)
                return 0, 0, 0, 0
            
            if not records:
                print("   No Zillow listings found.")
                _log_run(location, "zillow", 0, 0, 0, None, started_at)
                return 0, 0, 0, 0
            
            print(f"   [Service] Used {service_used} service")
            return _stage_records(records, location, "zillow", args, started_at)
            
        except Exception as e:
            print(f"❌  Zillow service scrape error: {e}")
            if zillow_service == "auto":
                print("   Falling back to direct scraper...")
            else:
                _log_run(location, "zillow", 0, 0, 0, str(e), started_at)
                return 0, 0, 0, 0
    
    # Fallback to direct scraper
    if not _ZW_AVAILABLE:
        print(f"❌  Zillow scraper unavailable: {_ZW_IMPORT_ERR}")
        return 0, 0, 0, 0

    print(f"\n{'─'*55}")
    print(f"🏠  Zillow scrape (direct): {location}")
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


# ── Redfin scrape for one location ────────────────────────────────────────────

def _run_redfin(location, args, started_at):
    if not _HH_AVAILABLE:
        print("❌  homeharvest is not installed. Run: pip install homeharvest")
        return 0, 0, 0, 0

    print(f"\n{'─'*55}")
    print(f"🏠  Redfin scrape: {location}")
    print(f"{'─'*55}")
    t0 = time.time()

    scrape_kwargs = dict(
        site_name           = ["redfin"],
        location            = location,
        listing_type        = "for_rent",
        past_days           = args.past_days,
        return_type         = "pydantic",
        limit               = args.limit,
        extra_property_data = args.extra,
    )
    if args.beds_min  is not None: scrape_kwargs["beds_min"]  = args.beds_min
    if args.beds_max  is not None: scrape_kwargs["beds_max"]  = args.beds_max
    if args.price_min is not None: scrape_kwargs["price_min"] = args.price_min
    if args.price_max is not None: scrape_kwargs["price_max"] = args.price_max

    try:
        props = scrape_property(**scrape_kwargs)
    except (InvalidListingType, AuthenticationError) as e:
        print(f"❌  Redfin scrape error: {e}")
        _log_run(location, "redfin", 0, 0, 0, str(e), started_at)
        return 0, 0, 0, 0
    except Exception as e:
        print(f"❌  Unexpected Redfin scrape error: {e}")
        _log_run(location, "redfin", 0, 0, 0, str(e), started_at)
        return 0, 0, 0, 0

    elapsed = round(time.time() - t0, 1)
    print(f"✅  HomeHarvest (Redfin) found {len(props)} listings in {elapsed}s")

    if not props:
        _log_run(location, "redfin", 0, 0, 0, None, started_at)
        return 0, 0, 0, 0

    # Use the same Realtor.com mapper — HomeHarvest returns the same Pydantic
    # Property objects regardless of site_name.
    records = []
    for prop in props:
        rec = _map_realtor_property(prop)
        if rec["data_quality_score"] < args.min_score:
            continue
        has_addr   = bool(rec.get("address") and rec.get("city"))
        has_coords = rec.get("lat") is not None and rec.get("lng") is not None
        if not has_addr and not has_coords:
            continue
        # Tag source so pipeline card shows "REDFIN" badge
        rec["source"] = "redfin"
        records.append(rec)

    dropped = len(props) - len(records)
    if dropped:
        print(f"   {dropped} listing(s) dropped (below min-score or no address/coords)")

    if not records:
        _log_run(location, "redfin", 0, 0, 0, None, started_at)
        return 0, 0, 0, 0

    return _stage_records(records, location, "redfin", args, started_at)


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

    if args.source in ("redfin", "both"):
        new, dup, err, score = _run_redfin(location, args, started_at)
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
    print("\n🏠  Choice Properties — Scraper v5")
    print(f"   Dry run      : {args.dry_run}")
    print(f"   Upsert       : {args.upsert}")
    print(f"   Publish      : {args.publish}")

    started_at = _now()

    # ── URL mode — scrape specific listing URLs directly ──────────────────────
    urls = list(getattr(args, "url", None) or [])
    urls_file = getattr(args, "urls_file", None)
    if urls_file:
        try:
            with open(urls_file) as f:
                for line in f:
                    u = line.strip()
                    if u and not u.startswith("#"):
                        urls.append(u)
        except FileNotFoundError:
            print(f"❌  URLs file not found: {urls_file}")
            return 1

    if urls:
        print(f"   Mode         : URL scrape ({len(urls)} URL(s))")
        if not _ZW_AVAILABLE:
            print(f"⚠   Zillow module unavailable: {_ZW_IMPORT_ERR}")
        records, new, dup, err = _run_urls(urls, args, started_at)
        if args.publish and records:
            orchestrator_cls, err = _get_pipeline_orchestrator()
            if not orchestrator_cls:
                print(f"❌  Pipeline module unavailable: {err}")
                return 1
            if not _requests:
                print("❌  requests is required to publish through the pipeline.")
                return 1
            print("\n" + ("─" * 55))
            print("🚀  Publishing URL-scraped listings through the pipeline")
            print(("─" * 55))
            orchestrator = orchestrator_cls(verbose=True)
            result = orchestrator.run_records(records, dry_run=args.dry_run, batch_name="URL scrape")
            return 0
        return 0

    # ── Location mode — city / ZIP / region search ────────────────────────────
    print(f"   Source       : {args.source}")
    print(f"   Past days    : {args.past_days}")
    print(f"   Price/mo     : ${args.price_min or 0} – ${args.price_max or 'no max'}")
    print(f"   Beds         : {args.beds_min or 'any'} – {args.beds_max or 'any'}")
    print(f"   Limit/loc    : {args.limit}")
    print(f"   Min score    : {args.min_score}")
    print(f"   Extra data   : {args.extra}")
    print(f"   Realtor detail: {'DISABLED (--no-realtor-details)' if getattr(args, 'no_realtor_details', False) else 'ENABLED (Phase 2)'}")
    print(f"   Zillow detail : {'DISABLED (--no-details)' if getattr(args, 'no_details', False) else 'ENABLED (Phase 2)'}")
    no_enrich = getattr(args, "no_enrich", False)
    no_detail_enrich = getattr(args, "no_detail_enrich", False)
    if no_enrich:
        print("   Enrichment   : DISABLED (--no-enrich)")
    elif no_detail_enrich:
        print("   Enrichment   : partial — watermark+rules only (--no-detail-enrich)")
    else:
        enrich_status = "ENABLED" if _ENRICH_AVAILABLE else ("UNAVAILABLE: " + str(globals().get("_ENRICH_ERR", "?")))
        print(f"   Enrichment   : {enrich_status}")
    if args.source in ("redfin", "both") and not _HH_AVAILABLE:
        print("⚠   homeharvest not installed — Redfin scraping will be skipped.")

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
        print("❌  No locations or URLs specified.")
        print("    Use --location \"Dallas, TX\" for a city search, or")
        print("    use --url https://www.zillow.com/homedetails/... for specific listings.")
        return 1

    print(f"   Locations    : {len(locations)}")

    if args.source in ("realtor", "both") and not _HH_AVAILABLE:
        print("⚠   homeharvest not installed — Realtor.com scraping will be skipped.")
        print("    Run: pip install homeharvest")
    if args.source in ("zillow", "both") and not _ZW_AVAILABLE:
        print(f"⚠   Zillow module unavailable: {_ZW_IMPORT_ERR}")

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
            "Choice Properties -- Scraper v5\n"
            "Two modes:\n"
            "  URL mode   : scrape specific listing URLs (--url / --urls-file)\n"
            "  Search mode: scrape all rentals in a city/ZIP (--location / --locations-file)"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
URL mode (Zillow -- run from iSH / residential IP):
  python3 scraper.py --url "https://www.zillow.com/homedetails/123-Main-St/49843423_zpid/"
  python3 scraper.py --url "https://www.zillow.com/..." --url "https://www.zillow.com/..."
  python3 scraper.py --urls-file my_links.txt --dry-run
  python3 scraper.py --url "https://rentprogress.com/property-details/730-parker-st/..."

Search mode (Realtor.com is safe from Replit; Zillow needs residential IP):
  python3 scraper.py --location "Austin, TX"
  python3 scraper.py --location "Dallas, TX" --source zillow
  python3 scraper.py --location "Dallas, TX" --source both
  python3 scraper.py --locations-file cities.txt --source both --min-score 40
  python3 scraper.py --location "Miami, FL" --upsert --past-days 7 --dry-run
        """,
    )

    # ── URL mode args ─────────────────────────────────────────────────────────
    p.add_argument(
        "--url", action="append", metavar="URL", dest="url",
        help=(
            "Scrape a specific listing URL directly (repeatable). "
            "Supports Zillow detail pages (full Phase 2 enrichment: all photos, "
            "appliances, heating/cooling/laundry, deposits, schools, walk scores, etc.) "
            "and other sites (RentProgress, Apartments.com) via best-effort extraction. "
            "Zillow URLs must be run from a residential IP (iSH or home WiFi)."
        ),
    )
    p.add_argument(
        "--urls-file", metavar="FILE", dest="urls_file",
        help=(
            "Text file with one listing URL per line (# comments ignored). "
            "Same as passing each line as --url. "
            "Great for pasting a batch of shared Zillow links."
        ),
    )

    # ── Search mode args ──────────────────────────────────────────────────────
    p.add_argument(
        "--location", action="append", metavar="LOCATION",
        help='City/ZIP to search (repeatable). e.g. "Dallas, TX" or "75201".',
    )
    p.add_argument(
        "--locations-file", metavar="FILE",
        help="Text file with one location per line (# comments supported).",
    )
    p.add_argument(
        "--source", choices=["realtor", "zillow", "redfin", "both"], default="realtor",
        help=(
            "Search mode source(s).\n"
            "  realtor — Realtor.com via HomeHarvest (safe from Replit, default)\n"
            "  zillow  — Zillow via __NEXT_DATA__ HTML parsing (needs residential IP)\n"
            "  redfin  — Redfin via HomeHarvest (safe from Replit)\n"
            "  both    — run realtor + zillow + redfin in sequence\n"
            "Not used in URL mode (source is auto-detected from the URL)."
        ),
    )
    p.add_argument(
        "--past-days", type=int, default=7, metavar="N",
        help="Realtor.com only: listings from the last N days (default: 7).",
    )
    p.add_argument("--beds-min",  type=int, default=None, metavar="N",
                   help="Minimum bedrooms filter.")
    p.add_argument("--beds-max",  type=int, default=None, metavar="N",
                   help="Maximum bedrooms filter.")
    p.add_argument("--price-min", type=int, default=None, metavar="$",
                   help="Minimum monthly rent filter.")
    p.add_argument("--price-max", type=int, default=None, metavar="$",
                   help="Maximum monthly rent filter.")
    p.add_argument(
        "--property-type", default=None, metavar="TYPE",
        help="Realtor.com only. Comma-separated: single_family, multi_family, condos, townhomes, apartment, mobile",
    )
    p.add_argument(
        "--limit", type=int, default=200, metavar="N",
        help="Max listings per location per source (default: 200). Not used in URL mode.",
    )
    p.add_argument(
        "--min-score", type=int, default=0, metavar="N",
        help="Skip listings with data quality score below N (default: 0).",
    )
    p.add_argument(
        "--upsert", action="store_true",
        help="Update an existing pipeline record if the source_listing_id already exists.",
    )
    p.add_argument(
        "--extra", action="store_true",
        help="Realtor.com only: fetch extra data per property (schools, tax history). Slower.",
    )
    p.add_argument(
        "--no-realtor-details", action="store_true", dest="no_realtor_details",
        help=(
            "Realtor.com search mode only: skip Phase 2 detail-page enrichment. "
            "By default, scraper visits each Realtor.com listing page to extract "
            "virtual tours, full photo galleries (up to 50), showing instructions, "
            "move-in specials, schools, walk scores, and location context. "
            "Use this flag for a faster but shallower scrape."
        ),
    )
    p.add_argument(
        "--no-details", action="store_true",
        help=(
            "Zillow search mode only: skip Phase 2 detail-page enrichment. "
            "Has no effect in URL mode (URL mode always does full detail scrape)."
        ),
    )
    p.add_argument(
        "--no-enrich", action="store_true", dest="no_enrich",
        help=(
            "Skip the enrichment pipeline entirely (watermark filter, description "
            "cleaning, rule-based enrichment, regex detail fetch). Faster but records "
            "will have less data and may include competitor-branded listings."
        ),
    )
    p.add_argument(
        "--no-detail-enrich", action="store_true", dest="no_detail_enrich",
        help=(
            "Skip the regex detail-fetch step of the enrichment pipeline only. "
            "Still applies watermark filter, description cleaner, and rule-based "
            "enrichment. Useful for faster runs when you don't need the HTTP fetches."
        ),
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Preview what would be staged without writing to the database.",
    )
    p.add_argument(
        "--publish", action="store_true", dest="publish",
        help=(
            "Automatically publish URL-scraped listings through the pipeline. "
            "Use this for Opendoor URL conversion candidates when you want end-to-end "
            "publish flow without admin approval."
        ),
    )
    p.add_argument(
        "--allow-opendoor", action="store_true", dest="allow_opendoor",
        help=(
            "Allow Opendoor URL scraping in URL mode. "
            "Opendoor listings are sale-to-rent conversion candidates and are "
            "only scraped when explicitly permitted."
        ),
    )
    p.add_argument(
        "--zillow-service", default="auto", choices=["auto", "direct", "apify", "scrapebadger", "oxylabs"],
        help=(
            "Zillow scraping service to use (search mode only).\n"
            "  auto       — automatically select best available service (default)\n"
            "  direct     — use built-in direct scraper (requires residential IP)\n"
            "  apify      — use Apify (requires APIFY_API_TOKEN in .env)\n"
            "  scrapebadger — use ScrapeBadger (requires SCRAPEBADGER_API_TOKEN in .env)\n"
            "  oxylabs    — use Oxylabs (requires OXYLABS_USERNAME + OXYLABS_PASSWORD in .env)"
        ),
    )
    return p


if __name__ == "__main__":
    parser = _build_parser()
    args   = parser.parse_args()
    sys.exit(run(args) or 0)
