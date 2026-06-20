#!/usr/bin/env python3
"""
Choice Properties — Zillow Scraper Module
==========================================
Scrapes for-rent listings from Zillow by parsing the __NEXT_DATA__ JSON
embedded in Zillow's Next.js search result pages.

How it works:
  1. Fetch Zillow's rental search HTML page (e.g. /homes/for_rent/Dallas,-TX/)
  2. Extract the <script id="__NEXT_DATA__"> JSON blob from the HTML
  3. Navigate the nested JSON to pull the listing array
  4. Map Zillow field names to the pipeline_properties schema
  5. Batch-insert into Supabase (handled by scraper.py)

Bot-detection notes:
  • Works best from residential IPs (home/office network).
  • Datacenter IPs (cloud servers, Replit) may receive a 403 or CAPTCHA
    page from Zillow's DataDome protection layer.
  • If blocked, run the scraper locally from your machine.
  • Setting HTTP_PROXY / HTTPS_PROXY to a residential proxy will also work.

This module is imported by scraper.py and is not meant to be run directly.
"""

import re
import json
import time
import uuid
import random
from datetime import datetime, timezone

try:
    import requests as _req
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
except ImportError:
    raise ImportError("requests not installed. Run: pip install requests")


# ── Constants ─────────────────────────────────────────────────────────────────
ZILLOW_BASE = "https://www.zillow.com"
MAX_PAGES   = 20              # Zillow caps search results at 20 pages
PAGE_DELAY  = (2.0, 4.5)     # random delay (seconds) between page requests

# Realistic Chrome 124 browser headers — minimises bot-detection fingerprint
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept":                   "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language":          "en-US,en;q=0.9",
    "Accept-Encoding":          "gzip, deflate, br",
    "Referer":                  "https://www.zillow.com/",
    "sec-ch-ua":                '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile":         "?0",
    "sec-ch-ua-platform":       '"Windows"',
    "sec-fetch-dest":           "document",
    "sec-fetch-mode":           "navigate",
    "sec-fetch-site":           "same-origin",
    "sec-fetch-user":           "?1",
    "upgrade-insecure-requests":"1",
    "DNT":                      "1",
    "Cache-Control":            "max-age=0",
}

# Zillow homeType → pipeline property_type
_TYPE_MAP = {
    "SINGLE_FAMILY":  "SINGLE_FAMILY",
    "MULTI_FAMILY":   "MULTI_FAMILY",
    "CONDO":          "CONDOS",
    "CONDO_TOWNHOME": "CONDOS",
    "TOWNHOUSE":      "TOWNHOMES",
    "APARTMENT":      "APARTMENT",
    "MANUFACTURED":   "MOBILE",
    "MOBILE":         "MOBILE",
    "LOT":            "LAND",
    "LAND":           "LAND",
    "FARM":           "FARM",
}

# Fields used for quality scoring (must match scraper.py scoring logic)
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


# ── HTTP session ──────────────────────────────────────────────────────────────

def _make_session():
    s = _req.Session()
    adapter = HTTPAdapter(
        max_retries=Retry(total=2, backoff_factor=1.0, status_forcelist=[500, 502, 503, 504]),
        pool_connections=5,
        pool_maxsize=10,
    )
    s.mount("https://", adapter)
    s.mount("http://",  adapter)
    s.headers.update(_HEADERS)
    return s


# ── URL helpers ───────────────────────────────────────────────────────────────

def _location_to_slug(location):
    """
    Convert a human location string to the Zillow URL slug format.
      'Dallas, TX'       → 'Dallas,-TX'
      'Los Angeles, CA'  → 'Los-Angeles,-CA'
      '90210'            → '90210'
      'Austin TX'        → 'Austin-TX'
    """
    s = location.strip()
    s = s.replace(", ", ",-")    # "Dallas, TX" → "Dallas,-TX"
    s = s.replace(",", ",-")     # handle no-space commas
    s = s.replace(" ", "-")      # spaces → hyphens
    s = re.sub(r"-{2,}", "-", s) # collapse double hyphens
    return s


def _build_search_url(slug, page):
    if page <= 1:
        return f"{ZILLOW_BASE}/homes/for_rent/{slug}/"
    return f"{ZILLOW_BASE}/homes/for_rent/{slug}/{page}_p/"


# ── __NEXT_DATA__ extraction ──────────────────────────────────────────────────

def _extract_next_data(html):
    """Pull the __NEXT_DATA__ JSON from a Zillow HTML page."""
    m = re.search(
        r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>\s*(.*?)\s*</script>',
        html, re.DOTALL,
    )
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


def _get_listings_array(nd):
    """
    Try multiple known paths inside __NEXT_DATA__ to locate the listing array.
    Zillow periodically restructures the JSON but these paths cover all known variants.
    Returns (list_of_listings, total_count).
    """
    total = 0

    # Try to find total count first
    for total_path in [
        ("props","pageProps","searchPageState","cat1","searchList","totalCount"),
        ("props","pageProps","searchPageState","cat2","searchList","totalCount"),
    ]:
        try:
            v = nd
            for k in total_path:
                v = v[k]
            total = int(v)
            break
        except (KeyError, TypeError, ValueError):
            pass

    # Try listing arrays in order of likelihood
    list_paths = [
        ("props","pageProps","searchPageState","cat1","searchResults","listResults"),
        ("props","pageProps","searchPageState","cat1","searchResults","relaxedResults"),
        ("props","pageProps","searchPageState","cat2","searchResults","mapResults"),
        ("props","pageProps","componentProps","listResults"),
        ("props","pageProps","searchResults","listResults"),
    ]
    for path in list_paths:
        try:
            node = nd
            for k in path:
                node = node[k]
            if isinstance(node, list) and node:
                return node, total
        except (KeyError, TypeError):
            continue

    return [], total


# ── Field helpers ─────────────────────────────────────────────────────────────

def _safe_int(v):
    try:
        return int(float(v)) if v is not None else None
    except (ValueError, TypeError):
        return None


def _safe_float(v):
    try:
        return float(v) if v is not None else None
    except (ValueError, TypeError):
        return None


def _parse_price(v):
    """
    Handles both numeric and string price formats from Zillow.
      '$2,200/mo'  → 2200
      '$1,500+/mo' → 1500
      2200.0       → 2200
    """
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    digits = re.sub(r"[^\d]", "", str(v).split("+")[0].split("-")[0])
    return int(digits) if digits else None


def _jdumps(v):
    if v is None:
        return "[]"
    if isinstance(v, str):
        return v
    return json.dumps([str(x) for x in v if x])


def _now():
    return datetime.now(timezone.utc).isoformat()


def _gen_id():
    return "PP-" + uuid.uuid4().hex[:8].upper()


# ── Photo collector ───────────────────────────────────────────────────────────

def _collect_photos(listing):
    urls = []
    seen = set()

    def _add(url):
        if url and isinstance(url, str) and url.startswith("http") and url not in seen:
            urls.append(url)
            seen.add(url)

    # Primary image
    _add(listing.get("imgSrc") or listing.get("img"))

    # Carousel / gallery
    for p in (listing.get("carouselPhotos") or []):
        if isinstance(p, str):
            _add(p)
        elif isinstance(p, dict):
            _add(p.get("url") or p.get("src") or p.get("href"))

    # hdpData photos (sometimes included)
    hi = (listing.get("hdpData") or {}).get("homeInfo") or {}
    for p in (hi.get("photos") or hi.get("images") or []):
        if isinstance(p, str):
            _add(p)
        elif isinstance(p, dict):
            _add(p.get("url") or p.get("src"))

    return urls[:40]


# ── Quality scoring (mirrors scraper.py logic) ────────────────────────────────

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


# ── Listing mapper ────────────────────────────────────────────────────────────

def _map_listing(raw):
    """Map one raw Zillow listing dict → pipeline_properties record."""
    hi = {}
    try:
        hi = (raw.get("hdpData") or {}).get("homeInfo") or {}
    except Exception:
        pass

    zpid = str(raw.get("zpid") or hi.get("zpid") or "")

    # ── Address ───────────────────────────────────────────────────────────────
    street  = (raw.get("addressStreet")  or hi.get("streetAddress") or
               raw.get("address"))
    city    = (raw.get("addressCity")    or hi.get("city"))
    state   = (raw.get("addressState")   or hi.get("state"))
    zipcode = (raw.get("addressZipcode") or hi.get("zipcode"))

    # ── Coordinates ───────────────────────────────────────────────────────────
    ll  = raw.get("latLong") or {}
    lat = _safe_float(ll.get("latitude")  or hi.get("latitude"))
    lng = _safe_float(ll.get("longitude") or hi.get("longitude"))

    # ── Rent ──────────────────────────────────────────────────────────────────
    rent = _parse_price(
        raw.get("unformattedPrice") or
        hi.get("price")             or
        hi.get("rentZestimate")     or
        raw.get("price")
    )

    # ── Beds / baths ──────────────────────────────────────────────────────────
    beds       = _safe_int(raw.get("beds")  or hi.get("bedrooms"))
    baths_raw  = _safe_float(raw.get("baths") or hi.get("bathrooms"))
    bath_f     = _safe_int(baths_raw) if baths_raw is not None else None
    bath_h     = 1 if (baths_raw is not None and baths_raw != bath_f) else None
    bath_total = baths_raw  # keep the 0.5 precision Zillow provides

    # ── Property type ─────────────────────────────────────────────────────────
    raw_type  = (raw.get("homeType") or hi.get("homeType") or "").upper()
    prop_type = _TYPE_MAP.get(raw_type) or (raw_type or None)

    # ── Auto-title ────────────────────────────────────────────────────────────
    bed_pfx  = f"{beds}BR " if beds else ""
    type_lbl = (prop_type or "Rental").replace("_", " ").title()
    title    = f"{bed_pfx}{type_lbl} in {city}" if city else (street or "Zillow Rental")

    # ── Source URL ────────────────────────────────────────────────────────────
    detail = raw.get("detailUrl") or ""
    source_url = (f"{ZILLOW_BASE}{detail}" if detail.startswith("/") else detail) or None

    # ── Photos ────────────────────────────────────────────────────────────────
    photos = _collect_photos(raw)

    # ── Pets ──────────────────────────────────────────────────────────────────
    pets_allowed = hi.get("isPetFriendly")
    if pets_allowed is None:
        tags = raw.get("tags") or []
        if any("pet" in str(t).lower() for t in tags):
            pets_allowed = True

    # ── Parking ───────────────────────────────────────────────────────────────
    parking_raw = hi.get("parkingType") or raw.get("parkingType")
    parking     = str(parking_raw).replace("_", " ").title() if parking_raw else None

    # ── Amenities from tags ───────────────────────────────────────────────────
    tags      = raw.get("tags") or []
    amenities = _jdumps(tags)

    # ── Description ───────────────────────────────────────────────────────────
    desc = hi.get("description") or raw.get("description")

    # ── Neighborhood ─────────────────────────────────────────────────────────
    hood = raw.get("neighborhood") or hi.get("neighborhoodName") or hi.get("neighborhood")

    # ── Year built / HOA ──────────────────────────────────────────────────────
    yr_built = _safe_int(hi.get("yearBuilt"))
    hoa      = _safe_int(hi.get("hoaFee"))

    # ── Agent / broker ────────────────────────────────────────────────────────
    agent  = raw.get("brokerName") or hi.get("agentName")
    broker = raw.get("brokerName") or hi.get("brokerName")

    original_data = {
        "zpid":       zpid,
        "detailUrl":  source_url,
        "homeType":   raw_type,
        "statusType": raw.get("statusType"),
        "pgapt":      raw.get("pgapt"),
        "_source":    "zillow",
    }

    now = _now()

    record = {
        # ── Identity ──────────────────────────────────────────────────────────
        "id":                    _gen_id(),
        "source":                "zillow",
        "source_url":            source_url,
        "source_listing_id":     zpid,
        "status":                "scraped",

        # ── Address ───────────────────────────────────────────────────────────
        "title":                 title,
        "address":               street,
        "unit_number":           None,
        "city":                  city,
        "state":                 state,
        "zip":                   zipcode,
        "county":                None,
        "neighborhood":          hood,
        "lat":                   lat,
        "lng":                   lng,
        "location_context":      None,

        # ── Property details ──────────────────────────────────────────────────
        "property_type":         prop_type,
        "bedrooms":              beds,
        "bathrooms":             bath_f,
        "half_bathrooms":        bath_h,
        "total_bathrooms":       bath_total,
        "square_footage":        _safe_int(raw.get("area") or hi.get("livingArea")),
        "lot_size_sqft":         None,
        "year_built":            yr_built,
        "floors":                None,
        "garage_spaces":         None,
        "total_units":           None,
        "has_basement":          False,
        "has_central_air":       False,
        "virtual_tour_url":      None,

        # ── Financials ────────────────────────────────────────────────────────
        "monthly_rent":          rent,
        "security_deposit":      rent,
        "last_months_rent":      None,
        "application_fee":       None,
        "pet_deposit":           None,
        "admin_fee":             None,
        "move_in_special":       None,
        "parking_fee":           None,
        "hoa_fee":               hoa,
        "tax_value":             None,

        # ── Listing details ───────────────────────────────────────────────────
        "description":           desc,
        "showing_instructions":  None,
        "available_date":        None,
        "minimum_lease_months":  None,
        "lease_terms":           "[]",

        # ── Pets & policies ───────────────────────────────────────────────────
        "pets_allowed":          pets_allowed,
        "pet_types_allowed":     "[]",
        "pet_weight_limit":      None,
        "pet_details":           None,
        "smoking_allowed":       None,

        # ── Amenities & features ──────────────────────────────────────────────
        "parking":               parking,
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
        "agent_name":            agent,
        "broker_name":           broker,
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

    record["data_quality_score"] = _quality_score(record)
    record["missing_fields"]     = _jdumps(_missing_fields(record))

    return record


# ── Filters ───────────────────────────────────────────────────────────────────

def _passes_filters(raw, beds_min, beds_max, price_min, price_max):
    """Return True if a raw listing passes the user's CLI filters."""
    hi = {}
    try:
        hi = (raw.get("hdpData") or {}).get("homeInfo") or {}
    except Exception:
        pass

    beds  = raw.get("beds")  or hi.get("bedrooms")
    price = _parse_price(
        raw.get("unformattedPrice") or hi.get("price") or
        hi.get("rentZestimate")     or raw.get("price")
    )

    if beds_min  is not None and (beds  is None or float(beds)  < beds_min):  return False
    if beds_max  is not None and (beds  is not None and float(beds) > beds_max):  return False
    if price_min is not None and (price is None or price < price_min):         return False
    if price_max is not None and (price is not None and price > price_max):    return False

    # Skip non-rental items that sometimes bleed into results
    pgapt = raw.get("pgapt") or ""
    status = raw.get("statusType") or ""
    if pgapt and pgapt not in ("ForRent", ""):
        return False
    if status and "RENT" not in status.upper() and status not in ("", "FOR_RENT"):
        return False

    return True


# ── Public scrape function ────────────────────────────────────────────────────

def scrape_and_map(
    location,
    limit     = 200,
    beds_min  = None,
    beds_max  = None,
    price_min = None,
    price_max = None,
    min_score = 0,
    verbose   = True,
):
    """
    Scrape Zillow for-rent listings for one location and return a list of
    pipeline_properties-compatible dicts (quality scored, filters applied).

    Args:
        location  : human-readable location string ('Dallas, TX', '90210', etc.)
        limit     : max number of records to return
        beds_min/max, price_min/max : filter applied client-side
        min_score : skip records with data_quality_score below this value
        verbose   : print progress lines

    Returns:
        (records: list[dict], blocked: bool)
        blocked=True means Zillow returned bot-detection on page 1.
    """
    session  = _make_session()
    slug     = _location_to_slug(location)
    raw_kept = []
    blocked  = False

    if verbose:
        print(f"  🔍  Zillow: fetching rentals for: {location}")

    for page in range(1, MAX_PAGES + 1):
        if len(raw_kept) >= limit:
            break

        url = _build_search_url(slug, page)
        if verbose:
            print(f"     → page {page}: {url}")

        try:
            resp = session.get(url, timeout=25, allow_redirects=True)
        except Exception as e:
            if verbose:
                print(f"  ⚠  Request error (page {page}): {e}")
            break

        # ── Bot-detection signals ─────────────────────────────────────────────
        if resp.status_code == 403:
            if verbose:
                print("  ⛔  Zillow returned 403 — bot detection triggered.")
                print("     Run from a residential IP or set HTTP_PROXY to a residential proxy.")
            if page == 1:
                blocked = True
            break

        if resp.status_code == 429:
            if verbose:
                print("  ⛔  Zillow rate-limited (429). Waiting 30s before retry…")
            time.sleep(30)
            try:
                resp = session.get(url, timeout=25, allow_redirects=True)
            except Exception:
                break
            if resp.status_code != 200:
                if page == 1:
                    blocked = True
                break

        if resp.status_code != 200:
            if verbose:
                print(f"  ⚠  HTTP {resp.status_code} on page {page}")
            break

        # ── Parse __NEXT_DATA__ ───────────────────────────────────────────────
        nd = _extract_next_data(resp.text)
        if not nd:
            if verbose:
                print(
                    f"  ⚠  __NEXT_DATA__ not found on page {page}.\n"
                    f"     Zillow may have served a CAPTCHA or changed their page structure."
                )
            if page == 1:
                blocked = True
            break

        listings, total_count = _get_listings_array(nd)

        if not listings:
            if verbose and page == 1:
                print(
                    "  ⚠  No listings in __NEXT_DATA__ on page 1.\n"
                    "     Location may be invalid, or Zillow returned a non-search page."
                )
            break

        if verbose and page == 1:
            desc = f"~{total_count} total" if total_count else "unknown total"
            print(f"     Zillow reports {desc} for-rent listings")

        # ── Apply filters & collect ───────────────────────────────────────────
        page_kept = 0
        for raw in listings:
            if len(raw_kept) >= limit:
                break
            if _passes_filters(raw, beds_min, beds_max, price_min, price_max):
                raw_kept.append(raw)
                page_kept += 1

        if verbose:
            print(f"     Kept {page_kept} from page {page} (running total: {len(raw_kept)})")

        # Stop early if we've collected everything Zillow has
        if total_count and len(raw_kept) >= min(total_count, limit):
            break
        # Sparse page → likely the last one
        if len(listings) < 10:
            break

        # Polite inter-page delay
        if page < MAX_PAGES:
            time.sleep(random.uniform(*PAGE_DELAY))

    # ── Map raw → pipeline records ────────────────────────────────────────────
    records = []
    for raw in raw_kept:
        try:
            rec = _map_listing(raw)
            if rec["data_quality_score"] < min_score:
                continue
            # Drop listings with neither address nor coordinates
            has_addr   = bool(rec.get("address") and rec.get("city"))
            has_coords = rec.get("lat") is not None and rec.get("lng") is not None
            if not has_addr and not has_coords:
                continue
            records.append(rec)
        except Exception:
            continue

    if verbose:
        print(f"  ✅  Zillow: {len(records)} pipeline-ready records for: {location}")

    return records, blocked
