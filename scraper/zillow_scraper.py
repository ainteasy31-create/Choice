#!/usr/bin/env python3
"""
Choice Properties -- Zillow Scraper Module (v4 -- Two-Phase)
=============================================================
Phase 1 (Search): Fetch Zillow for-rent search pages, extract listing IDs +
         basic data from the __NEXT_DATA__ JSON on each search result page.

Phase 2 (Detail): Visit each individual listing page concurrently and extract
         the full gdpClientCache property object, which contains every field
         that Zillow's own app uses -- amenities, appliances, utilities,
         heating/cooling/laundry, actual security deposit, pet fee,
         application fee, parking details, available date, virtual tour,
         high-resolution full photo gallery, and much more.

Bot-detection notes:
  * curl_cffi (preferred): impersonates Chrome 124 TLS fingerprint (JA3/JA4),
    bypassing DataDome bot-detection. Install with: pip install curl-cffi
    Falls back to plain requests if curl_cffi is not available (e.g. iSH/Alpine).
  * Still requires a residential IP (home/office WiFi or mobile data).
    Datacenter IPs (Replit, AWS, GCP) will receive 403 from DataDome regardless.
  * Run from iSH on iPhone using mobile data or home WiFi (or any residential IP).
  * User-agents are rotated across requests to reduce fingerprint.
  * Inter-page and inter-detail delays are randomised to mimic human browsing.
  * Use --no-details flag to skip Phase 2 if speed matters more than completeness.

This module is imported by scraper.py. Do NOT run it directly.

iSH / Python 3.9 compatibility:
  * ASCII quotes only in all string literals.
  * No walrus operator (:=).
  * No match/case statements.
  * No dict-union operator (|).
  * f-strings use ASCII quotes only.
"""

import re
import json
import time
import uuid
import random
import threading
import os
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

# Prefer curl_cffi for browser-accurate TLS fingerprinting (bypasses DataDome JA3
# detection that blocks plain Python requests even on residential IPs).
# On iSH/Alpine: install with `pip install curl-cffi --no-binary curl-cffi` to
# compile from source, since pre-built musl wheels may not be available.
# WARNING: without curl_cffi, the plain-requests fallback uses Python's SSL stack,
# which has a different JA3 fingerprint that DataDome will block even on residential
# IPs. Do NOT run Zillow scraping without curl_cffi installed.
try:
    from curl_cffi import requests as _req
    _CURL_CFFI = True
except ImportError:
    _CURL_CFFI = False
    import sys as _sys
    _sys.stderr.write(
        "\n[zillow_scraper] WARNING: curl_cffi is not installed.\n"
        "  Zillow scraping requires curl_cffi for Chrome TLS fingerprinting.\n"
        "  Without it, DataDome will block ALL requests (even from residential IPs).\n"
        "  Install with: pip install curl-cffi\n"
        "  On iSH/Alpine: pip install curl-cffi --no-binary curl-cffi\n\n"
    )
    try:
        import requests as _req
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry
    except ImportError:
        raise ImportError(
            "Neither curl_cffi nor requests is installed. "
            "Run: pip install curl-cffi"
        )


# -- Constants -----------------------------------------------------------------

ZILLOW_BASE     = "https://www.zillow.com"
MAX_PAGES       = 20              # Zillow caps search results at 20 pages
PAGE_DELAY      = (2.5, 5.0)     # random delay (s) between search page fetches
DETAIL_DELAY    = (1.2, 3.0)     # random delay (s) between detail page fetches
DETAIL_WORKERS  = 5              # concurrent detail-page fetchers
DETAIL_TIMEOUT  = 22             # seconds per detail request
MAX_DETAIL_RETRY = 1             # retries per detail page (0 = no retry)
ENRICH_SKIP_SCORE = 80           # skip detail fetch for records already >= this score

# Rotate through realistic Chrome user-agent strings to reduce fingerprinting.
# These cover Chrome 131 on Windows + macOS + Linux, matching the impersonate=
# "chrome131" TLS fingerprint used by curl_cffi below.
_USER_AGENTS = [
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.6778.205 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
    ),
    (
        "Mozilla/5.0 (X11; Linux x86_64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.6778.205 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.6778.139 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.6778.108 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.6778.85 Safari/537.36"
    ),
]

_BASE_HEADERS = {
    "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language":           "en-US,en;q=0.9",
    "Accept-Encoding":           "gzip, deflate, br",
    "Referer":                   "https://www.zillow.com/",
    "sec-ch-ua":                 '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile":          "?0",
    "sec-ch-ua-platform":        '"Windows"',
    "sec-fetch-dest":            "document",
    "sec-fetch-mode":            "navigate",
    "sec-fetch-site":            "same-origin",
    "sec-fetch-user":            "?1",
    "upgrade-insecure-requests": "1",
    "DNT":                       "1",
    "Cache-Control":             "max-age=0",
}

# Zillow homeType -> pipeline property_type
_TYPE_MAP = {
    "SINGLE_FAMILY":   "SINGLE_FAMILY",
    "MULTI_FAMILY":    "MULTI_FAMILY",
    "CONDO":           "CONDOS",
    "CONDO_TOWNHOME":  "CONDOS",
    "TOWNHOUSE":       "TOWNHOMES",
    "APARTMENT":       "APARTMENT",
    "MANUFACTURED":    "MOBILE",
    "MOBILE":          "MOBILE",
    "LOT":             "LAND",
    "LAND":            "LAND",
    "FARM":            "FARM",
}

# Quality scoring fields (mirrors scraper.py)
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


# -- HTTP session --------------------------------------------------------------

def _make_session():
    """
    Create an HTTP session.

    When curl_cffi is available, the session impersonates Chrome 124 at the
    TLS layer (JA3/JA4 fingerprint), which bypasses DataDome bot-detection
    that blocks plain Python requests even from residential IPs.

    Falls back to a requests.Session with a retry adapter when curl_cffi is
    not installed (e.g. on iSH/Alpine where musl wheels may be unavailable).
    """
    ua = random.choice(_USER_AGENTS)
    headers = dict(_BASE_HEADERS)
    headers["User-Agent"] = ua

    if _CURL_CFFI:
        # impersonate="chrome131" sets the correct TLS ClientHello fingerprint.
        # Must match the Chrome version in _USER_AGENTS and sec-ch-ua header above.
        # curl_cffi does not support HTTPAdapter/mount -- retries handled manually.
        s = _req.Session(impersonate="chrome131")
        s.headers.update(headers)
        return s

    # --- requests fallback ---
    s = _req.Session()
    adapter = HTTPAdapter(
        max_retries=Retry(
            total=2,
            backoff_factor=1.2,
            status_forcelist=[500, 502, 503, 504],
        ),
        pool_connections=10,
        pool_maxsize=20,
    )
    s.mount("https://", adapter)
    s.mount("http://",  adapter)
    s.headers.update(headers)
    return s


def _warm_session(session, verbose=False):
    """
    Establish Zillow session cookies by visiting the homepage then the
    for-rent search page before hitting any detail pages.

    Without this warm-up, DataDome (Zillow's bot-protection) returns 403
    on detail pages because no session cookie chain exists.

    Steps:
      1. GET https://www.zillow.com/           (sec-fetch-site: none)
      2. Wait 3-5 s
      3. GET https://www.zillow.com/homes/for_rent/   (sec-fetch-site: same-origin)
      4. Wait 2-4 s
    """
    pages = [
        ("https://www.zillow.com/", "none"),
        ("https://www.zillow.com/homes/for_rent/", "same-origin"),
    ]
    for i, (url, fetch_site) in enumerate(pages):
        try:
            hdrs = {
                "User-Agent":      random.choice(_USER_AGENTS),
                "Referer":         "https://www.google.com/" if fetch_site == "none" else "https://www.zillow.com/",
                "sec-fetch-site":  fetch_site,
                "sec-fetch-dest":  "document",
                "sec-fetch-mode":  "navigate",
                "sec-fetch-user":  "?1",
                "Cache-Control":   "max-age=0",
            }
            resp = session.get(url, headers=hdrs, timeout=20, allow_redirects=True)
            if verbose:
                print("  [warmup] " + url + " -> " + str(resp.status_code)
                      + "  cookies=" + str(len(session.cookies)))
        except Exception as e:
            if verbose:
                print("  [warmup] " + url + " failed: " + str(e)[:60])
        # Only sleep between pages, not after the last one
        if i < len(pages) - 1:
            delay = random.uniform(3.0, 5.0)
            if verbose:
                print("  [warmup] Waiting " + str(round(delay, 1)) + "s ...")
            time.sleep(delay)


def _rotate_ua(session):
    """Swap the session's User-Agent to a new random value."""
    session.headers["User-Agent"] = random.choice(_USER_AGENTS)


# -- URL helpers ---------------------------------------------------------------

def _location_to_slug(location):
    """
    Convert a human location string to Zillow URL slug format.
      'Dallas, TX'       -> 'Dallas,-TX'
      'Los Angeles, CA'  -> 'Los-Angeles,-CA'
      '90210'            -> '90210'
    """
    s = location.strip()
    s = s.replace(", ", ",-")
    s = s.replace(",", ",-")
    s = s.replace(" ", "-")
    s = re.sub(r"-{2,}", "-", s)
    return s


def _build_search_url(slug, page):
    if page <= 1:
        return ZILLOW_BASE + "/homes/for_rent/" + slug + "/"
    return ZILLOW_BASE + "/homes/for_rent/" + slug + "/" + str(page) + "_p/"


def _build_detail_url(detail_path):
    """Turn a Zillow detailUrl (relative or absolute) into a full URL."""
    if not detail_path:
        return None
    if detail_path.startswith("http"):
        return detail_path
    return ZILLOW_BASE + detail_path


# -- __NEXT_DATA__ extraction --------------------------------------------------

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
    except (ValueError, TypeError):
        return None


def _is_bot_page(html, status):
    """Return True if the response looks like a bot-detection page."""
    if status in (403, 429):
        return True
    if not html:
        return True
    lower = html[:3000].lower()
    bot_signals = [
        "datadome",
        "please enable js",
        "robot or human",
        "are you a robot",
        "captcha",
        "access denied",
        "blocked",
    ]
    for sig in bot_signals:
        if sig in lower:
            return True
    return False


def _get_listings_array(nd):
    """
    Try multiple known paths inside search __NEXT_DATA__ to locate the listing array.
    Zillow periodically restructures this JSON; these paths cover all known variants.
    Returns (list_of_listings, total_count).
    """
    total = 0

    for total_path in [
        ("props", "pageProps", "searchPageState", "cat1", "searchList", "totalCount"),
        ("props", "pageProps", "searchPageState", "cat2", "searchList", "totalCount"),
    ]:
        try:
            v = nd
            for k in total_path:
                v = v[k]
            total = int(v)
            break
        except (KeyError, TypeError, ValueError):
            pass

    list_paths = [
        ("props", "pageProps", "searchPageState", "cat1", "searchResults", "listResults"),
        ("props", "pageProps", "searchPageState", "cat1", "searchResults", "relaxedResults"),
        ("props", "pageProps", "searchPageState", "cat2", "searchResults", "mapResults"),
        ("props", "pageProps", "componentProps", "listResults"),
        ("props", "pageProps", "searchResults", "listResults"),
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


def _extract_detail_property(nd):
    """
    Parse the full property object from a detail page __NEXT_DATA__.
    The data lives inside a JSON-encoded string called gdpClientCache.
    Returns the property dict or None.
    """
    if not nd:
        return None

    # gdpClientCache can be at several paths depending on Zillow version
    cache_str = None
    cache_paths = [
        ("props", "pageProps", "componentProps", "gdpClientCache"),
        ("props", "pageProps", "initialData", "gdpClientCache"),
        ("props", "pageProps", "gdpClientCache"),
    ]
    for path in cache_paths:
        try:
            node = nd
            for k in path:
                node = node[k]
            if isinstance(node, str) and node:
                cache_str = node
                break
            # Sometimes it is already a dict (newer Zillow builds)
            if isinstance(node, dict) and node:
                cache_str = json.dumps(node)
                break
        except (KeyError, TypeError):
            continue

    if not cache_str:
        # Fallback: try direct componentProps
        try:
            cp = nd["props"]["pageProps"]["componentProps"]
            if "homeDetails" in cp:
                return cp["homeDetails"]
        except (KeyError, TypeError):
            pass
        return None

    try:
        cache = json.loads(cache_str)
    except (ValueError, TypeError):
        return None

    # Iterate over all keys in the cache -- the key name varies by Zillow build
    for _, val in cache.items():
        if not isinstance(val, dict):
            continue
        # Try: {property: {...}}
        if "property" in val and isinstance(val["property"], dict):
            return val["property"]
        # Try: {data: {property: {...}}}
        try:
            p = val["data"]["property"]
            if isinstance(p, dict):
                return p
        except (KeyError, TypeError):
            pass
        # Try: val itself looks like a property object
        if "zpid" in val and "bedrooms" in val:
            return val

    return None


# -- Field helpers -------------------------------------------------------------

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
    Handles both numeric and string price formats.
      '$2,200/mo'  -> 2200
      '$1,500+/mo' -> 1500
      2200.0       -> 2200
    """
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v) if v > 0 else None
    digits = re.sub(r"[^\d]", "", str(v).split("+")[0].split("-")[0])
    return int(digits) if digits else None


def _jdumps(v):
    if v is None:
        return "[]"
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return json.dumps([str(x) for x in v if x is not None])
    return "[]"


def _now():
    return datetime.now(timezone.utc).isoformat()


def _gen_id():
    return "PP-" + uuid.uuid4().hex[:8].upper()


def _list_to_str(lst):
    """Join a list of strings into a single readable string."""
    if not lst or not isinstance(lst, list):
        return None
    parts = [str(x).strip() for x in lst if x]
    return ", ".join(parts) if parts else None


def _parse_date(v):
    """Try to extract a YYYY-MM-DD string from various Zillow date formats."""
    if not v:
        return None
    s = str(v).strip()
    # Already ISO: '2024-08-01'
    m = re.match(r"(\d{4}-\d{2}-\d{2})", s)
    if m:
        return m.group(1)
    # Epoch milliseconds
    if re.match(r"^\d{13}$", s):
        try:
            return datetime.utcfromtimestamp(int(s) / 1000).strftime("%Y-%m-%d")
        except (ValueError, OSError):
            pass
    # Epoch seconds
    if re.match(r"^\d{10}$", s):
        try:
            return datetime.utcfromtimestamp(int(s)).strftime("%Y-%m-%d")
        except (ValueError, OSError):
            pass
    # 'August 1, 2024' style
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%m/%d/%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return None


def _coerce_bool(v):
    """Return True/False/None from various Zillow yes/no/bool values."""
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("true", "yes", "1", "allowed", "ok"):
        return True
    if s in ("false", "no", "0", "not allowed", "none"):
        return False
    return None


# -- Photo collection ----------------------------------------------------------

def _collect_photos_search(listing):
    """
    Collect photo URLs from a search result listing dict.
    Checks imgSrc, carouselPhotos, hdpData.homeInfo.photos.
    Returns up to 40 deduplicated URLs.
    """
    urls = []
    seen = set()

    def _add(url):
        if url and isinstance(url, str) and url.startswith("http") and url not in seen:
            urls.append(url)
            seen.add(url)

    _add(listing.get("imgSrc") or listing.get("img"))

    for p in (listing.get("carouselPhotos") or []):
        if isinstance(p, str):
            _add(p)
        elif isinstance(p, dict):
            _add(p.get("url") or p.get("src") or p.get("href"))

    hi = (listing.get("hdpData") or {}).get("homeInfo") or {}
    for p in (hi.get("photos") or hi.get("images") or []):
        if isinstance(p, str):
            _add(p)
        elif isinstance(p, dict):
            _add(p.get("url") or p.get("src"))

    return urls[:40]


def _collect_photos_detail(prop):
    """
    Collect ALL high-resolution photo URLs from a detail page property dict.
    Prefers responsivePhotosOriginalRatio (best quality, original aspect ratio),
    then responsivePhotos, then flat photos array, then hdpData fallback.
    Returns all deduplicated URLs (no artificial cap — for targeted URL scraping
    we want every single photo Zillow has).
    """
    urls = []
    seen = set()

    def _add(u):
        if u and isinstance(u, str) and u.startswith("http") and u not in seen:
            urls.append(u)
            seen.add(u)

    def _best_from_mixed(mixed):
        """Pick the highest-resolution URL from a mixedSources object."""
        if not isinstance(mixed, dict):
            return None
        # Try JPEG first (best quality), then WebP, then anything
        for key in ("jpeg", "jpg", "webp", "png"):
            lst = mixed.get(key)
            if lst and isinstance(lst, list):
                best_url = None
                best_w   = 0
                for item in lst:
                    if isinstance(item, dict):
                        w = item.get("width") or 0
                        if w > best_w:
                            best_w = w
                            best_url = item.get("url")
                if best_url:
                    return best_url
        return None

    # ── Source 1: responsivePhotosOriginalRatio (full-res, original aspect ratio)
    for photo in (prop.get("responsivePhotosOriginalRatio") or []):
        if isinstance(photo, dict):
            u = _best_from_mixed(photo.get("mixedSources")) or photo.get("url")
            _add(u)

    # ── Source 2: responsivePhotos (standard Zillow photo set)
    for photo in (prop.get("responsivePhotos") or []):
        if isinstance(photo, dict):
            u = _best_from_mixed(photo.get("mixedSources")) or photo.get("url")
            _add(u)

    # ── Source 3: hugePhotos / mediumPhotos (older Zillow format)
    for key in ("hugePhotos", "largePhotos", "mediumPhotos", "photos"):
        for photo in (prop.get(key) or []):
            if isinstance(photo, str):
                _add(photo)
            elif isinstance(photo, dict):
                _add(photo.get("url") or photo.get("src") or photo.get("href"))

    # ── Source 4: desktopWebHdpImageLink / heroImage
    _add(prop.get("desktopWebHdpImageLink"))
    _add(prop.get("heroImage"))

    # ── Source 5: hdpData.homeInfo.photos (last resort)
    hi = (prop.get("hdpData") or {}).get("homeInfo") or {}
    for p in (hi.get("photos") or []):
        if isinstance(p, dict):
            _add(p.get("url") or p.get("src"))
        elif isinstance(p, str):
            _add(p)

    # ── Source 6: thumbnail from search phase (absolute fallback)
    _add(prop.get("imgSrc"))

    return urls[:50]  # Cap at 50 photos to keep row sizes sane


# -- Quality scoring -----------------------------------------------------------

def _quality_score(r):
    sc = 0
    for f in _IMPORTANT:
        if r.get(f) not in (None, "", "[]"):
            sc += 6
    for f in _BONUS:
        if r.get(f) not in (None, "", "[]"):
            sc += 2
    try:
        n = len(json.loads(r.get("original_image_urls") or "[]"))
    except (ValueError, TypeError):
        n = 0
    sc += 6 if n >= 5 else (3 if n >= 1 else 0)
    return min(sc, 100)


def _missing_fields(r):
    return [f for f in _TRACKABLE_MISSING if r.get(f) in (None, "", "[]")]


# -- Listing mapper (Phase 1 -- search result) ---------------------------------

def _map_listing(raw):
    """Map one raw Zillow search-result listing dict -> pipeline_properties record."""
    hi = {}
    try:
        hi = (raw.get("hdpData") or {}).get("homeInfo") or {}
    except Exception:
        pass

    zpid = str(raw.get("zpid") or hi.get("zpid") or "")

    street  = raw.get("addressStreet")  or hi.get("streetAddress") or raw.get("address")
    city    = raw.get("addressCity")    or hi.get("city")
    state   = raw.get("addressState")   or hi.get("state")
    zipcode = raw.get("addressZipcode") or hi.get("zipcode")

    ll  = raw.get("latLong") or {}
    lat = _safe_float(ll.get("latitude")  or hi.get("latitude"))
    lng = _safe_float(ll.get("longitude") or hi.get("longitude"))

    rent = _parse_price(
        raw.get("unformattedPrice") or
        hi.get("price") or
        hi.get("rentZestimate") or
        raw.get("price")
    )

    beds      = _safe_int(raw.get("beds")  or hi.get("bedrooms"))
    baths_raw = _safe_float(raw.get("baths") or hi.get("bathrooms"))
    bath_f    = _safe_int(baths_raw) if baths_raw is not None else None
    bath_h    = 1 if (baths_raw is not None and baths_raw != bath_f) else None
    bath_total = baths_raw

    raw_type  = (raw.get("homeType") or hi.get("homeType") or "").upper()
    prop_type = _TYPE_MAP.get(raw_type) or (raw_type or None)

    bed_pfx  = (str(beds) + "BR ") if beds else ""
    type_lbl = (prop_type or "Rental").replace("_", " ").title()
    title    = (bed_pfx + type_lbl + " in " + city) if city else (street or "Zillow Rental")

    detail = raw.get("detailUrl") or ""
    source_url = _build_detail_url(detail) if detail else None

    photos = _collect_photos_search(raw)

    pets_allowed = hi.get("isPetFriendly")
    if pets_allowed is None:
        tags = raw.get("tags") or []
        if any("pet" in str(t).lower() for t in tags):
            pets_allowed = True

    parking_raw = hi.get("parkingType") or raw.get("parkingType")
    parking     = str(parking_raw).replace("_", " ").title() if parking_raw else None

    tags      = raw.get("tags") or []
    amenities = _jdumps(tags)

    desc = hi.get("description") or raw.get("description")
    hood = raw.get("neighborhood") or hi.get("neighborhoodName") or hi.get("neighborhood")
    yr_built = _safe_int(hi.get("yearBuilt"))
    hoa      = _safe_int(hi.get("hoaFee"))

    agent  = hi.get("agentName") or raw.get("agentName") or raw.get("brokerName")
    broker = hi.get("brokerName") or raw.get("brokerName")

    # -- listed_at: capture original listing date from source ------------------
    # Never use the scrape date as the listing date. Prefer direct date fields;
    # fall back to computing from daysOnMarket if no direct date is available.
    _listed_at = None
    _date_raw = (
        hi.get("listingDateTimeOnZillow") or
        hi.get("datePosted") or
        raw.get("listingDateTimeOnZillow") or
        raw.get("datePosted")
    )
    if _date_raw:
        _listed_at = _parse_date(str(_date_raw))
    if _listed_at is None:
        _dom_search = _safe_int(
            raw.get("daysOnMarket") or hi.get("daysOnMarket") or
            hi.get("daysOnZillow") or raw.get("daysOnZillow")
        )
        if _dom_search is not None:
            try:
                from datetime import date as _date_cls, timedelta as _td_cls
                _listed_at = (_date_cls.today() - _td_cls(days=_dom_search)).isoformat()
            except Exception:
                pass

    original_data = {
        "zpid":       zpid,
        "detailUrl":  source_url,
        "homeType":   raw_type,
        "statusType": raw.get("statusType"),
        "pgapt":      raw.get("pgapt"),
        "_source":    "zillow",
        "_phase":     "search",
    }

    # ── source_status — map Zillow statusType to canonical value ──────────
    _status_raw = str(raw.get("statusType") or "").upper()
    if "FOR_RENT" in _status_raw or _status_raw in ("ACTIVE", "ACTIVE_FOR_RENT"):
        _source_status = "available"
    elif "PENDING" in _status_raw:
        _source_status = "pending"
    elif "RENTED" in _status_raw or "LEASED" in _status_raw:
        _source_status = "rented"
    elif "SOLD" in _status_raw or "OFF_MARKET" in _status_raw or "REMOVED" in _status_raw:
        _source_status = "removed"
    elif _status_raw:
        _source_status = "available"
    else:
        _source_status = "available"

    now = _now()

    record = {
        # -- Identity ----------------------------------------------------------
        "id":                    _gen_id(),
        "source":                "zillow",
        "source_url":            source_url,
        "source_listing_id":     zpid,
        "status":                "scraped",
        "source_status":         _source_status,

        # -- Address -----------------------------------------------------------
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

        # -- Property details --------------------------------------------------
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

        # -- Financials --------------------------------------------------------
        "monthly_rent":          rent,
        "security_deposit":      None,      # filled by detail phase
        "last_months_rent":      None,
        "application_fee":       None,
        "pet_deposit":           None,
        "admin_fee":             None,
        "move_in_special":       None,
        "parking_fee":           None,
        "hoa_fee":               hoa,
        "tax_value":             None,

        # -- Listing details ---------------------------------------------------
        "description":           desc,
        "showing_instructions":  None,
        "available_date":        None,
        "listed_at":             _listed_at,
        "minimum_lease_months":  None,
        "lease_terms":           "[]",

        # -- Pets & policies ---------------------------------------------------
        "pets_allowed":          pets_allowed,
        "pet_types_allowed":     "[]",
        "pet_weight_limit":      None,
        "pet_details":           None,
        "smoking_allowed":       None,

        # -- Amenities & features ----------------------------------------------
        "parking":               parking,
        "amenities":             amenities,
        "appliances":            "[]",
        "utilities_included":    "[]",
        "flooring":              "[]",
        "heating_type":          None,
        "cooling_type":          None,
        "laundry_type":          None,

        # -- Photos ------------------------------------------------------------
        "original_image_urls":   _jdumps(photos),
        "local_image_paths":     "[]",

        # -- Agent / broker ----------------------------------------------------
        "agent_name":            agent,
        "broker_name":           broker,
        "agent_image_url":       None,
        "poster_landlord_id":    None,

        # -- Pipeline metadata -------------------------------------------------
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


# -- Detail enrichment (Phase 2) -----------------------------------------------

def _enrich_from_detail(record, prop):
    """
    Overlay a full detail-page property dict onto an existing search-phase record.
    Only overwrites fields that are currently None/empty with non-None detail values.
    Always overwrites photos and description (detail is always richer).
    Returns the enriched record (mutates in place).
    """
    if not prop or not isinstance(prop, dict):
        return record

    rf = prop.get("resoFacts") or {}

    # -- Address (fill gaps) ---------------------------------------------------
    addr = prop.get("address") or {}
    if not record.get("address"):
        record["address"] = addr.get("streetAddress") or addr.get("street")
    if not record.get("city"):
        record["city"] = addr.get("city")
    if not record.get("state"):
        record["state"] = addr.get("state")
    if not record.get("zip"):
        record["zip"] = addr.get("zipcode")
    if not record.get("county"):
        record["county"] = prop.get("county") or addr.get("county")

    # -- Coordinates -----------------------------------------------------------
    if record.get("lat") is None:
        record["lat"] = _safe_float(prop.get("latitude"))
    if record.get("lng") is None:
        record["lng"] = _safe_float(prop.get("longitude"))

    # -- Property specs --------------------------------------------------------
    if not record.get("square_footage"):
        record["square_footage"] = _safe_int(prop.get("livingArea") or rf.get("livingArea"))
    if not record.get("lot_size_sqft"):
        record["lot_size_sqft"] = _safe_int(prop.get("lotSizeSquareFeet") or rf.get("lotSizeSquareFeet"))
    if not record.get("year_built"):
        record["year_built"] = _safe_int(prop.get("yearBuilt") or rf.get("yearBuilt"))
    if not record.get("bedrooms"):
        record["bedrooms"] = _safe_int(prop.get("bedrooms") or rf.get("bedrooms"))
    if not record.get("bathrooms"):
        # Prefer bathroomsFull (integer count of full baths) over the combined
        # Zillow "bathrooms" figure (e.g. 2.5), which would be truncated by
        # _safe_int and silently drop half-bath data already in total_bathrooms.
        baths_full = _safe_int(rf.get("bathroomsFull") or prop.get("bathroomsOnMainLevel"))
        if baths_full is None and prop.get("bathrooms") is not None:
            baths_full = _safe_int(prop.get("bathrooms"))  # truncate combined count as last resort
        record["bathrooms"] = baths_full
    if not record.get("half_bathrooms"):
        record["half_bathrooms"] = _safe_int(prop.get("bathroomsHalf") or rf.get("bathroomsHalf"))
    if not record.get("total_bathrooms"):
        record["total_bathrooms"] = _safe_float(prop.get("bathrooms"))

    # Floors / stories
    if not record.get("floors"):
        stories = rf.get("stories") or rf.get("levels")
        if stories:
            # levels can be "Two", "Three" etc
            num = _safe_int(stories)
            if num is None:
                levels_map = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
                num = levels_map.get(str(stories).strip().lower())
            record["floors"] = num

    # Garage
    if not record.get("garage_spaces"):
        record["garage_spaces"] = _safe_int(rf.get("garageSpaces"))

    # Basement
    basement_val = rf.get("basement") or rf.get("basementYN")
    if basement_val not in (None, "", "None", "No basement", "none"):
        record["has_basement"] = True

    # Central air
    has_cooling = _coerce_bool(rf.get("hasCooling"))
    cooling_list = rf.get("cooling") or []
    if has_cooling or any("central" in str(c).lower() for c in cooling_list):
        record["has_central_air"] = True

    # Virtual tour
    if not record.get("virtual_tour_url"):
        record["virtual_tour_url"] = prop.get("virtualTourUrl") or prop.get("threeDimensionalTourUrl")

    # -- Financials ------------------------------------------------------------
    # Monthly rent (prefer detail over search -- search sometimes shows estimate)
    detail_rent = _parse_price(prop.get("price") or prop.get("rentZestimate"))
    if detail_rent and not record.get("monthly_rent"):
        record["monthly_rent"] = detail_rent

    # Actual security deposit — never fabricate from rent; leave None if unknown.
    # The pipeline review UI lets admin fill it in before publishing.
    deposit = _safe_int(rf.get("securityDeposit") or prop.get("securityDeposit"))
    if deposit and deposit > 0:
        record["security_deposit"] = deposit

    # Fees
    if not record.get("application_fee"):
        record["application_fee"] = _safe_int(rf.get("applicationFee") or prop.get("applicationFee"))
    if not record.get("pet_deposit"):
        record["pet_deposit"] = _safe_int(rf.get("petFee") or prop.get("petFee"))
    if not record.get("parking_fee"):
        record["parking_fee"] = _safe_int(rf.get("parkingFee") or prop.get("parkingFee"))
    if not record.get("hoa_fee"):
        record["hoa_fee"] = _safe_int(rf.get("monthlyHoaFee") or prop.get("monthlyHoaFee") or rf.get("hoaFee"))
    if not record.get("tax_value"):
        record["tax_value"] = _safe_int(prop.get("taxAnnualAmount") or rf.get("taxAnnualAmount"))
    if not record.get("admin_fee"):
        record["admin_fee"] = _safe_int(rf.get("adminFee") or prop.get("adminFee"))
    if not record.get("last_months_rent"):
        record["last_months_rent"] = _safe_int(rf.get("lastMonthRent") or rf.get("lastMonthsRent"))
    if not record.get("move_in_special"):
        concessions = rf.get("concessions") or prop.get("specialOffers") or prop.get("concessions")
        if concessions:
            record["move_in_special"] = str(concessions).strip()[:200]
    if not record.get("total_units"):
        record["total_units"] = _safe_int(
            prop.get("unitCount") or prop.get("numberOfUnitsTotal") or rf.get("unitCount")
        )

    # -- Listing details -------------------------------------------------------
    # Description -- always prefer detail page (much longer and complete)
    detail_desc = prop.get("description")
    if detail_desc and len(str(detail_desc)) > len(str(record.get("description") or "")):
        record["description"] = detail_desc

    # Available date
    if not record.get("available_date"):
        date_raw = (
            rf.get("dateAvailable") or rf.get("availableFrom") or
            prop.get("dateAvailable") or prop.get("availableFrom") or
            prop.get("datePostedString")
        )
        record["available_date"] = _parse_date(date_raw)

    # Lease term
    lease_raw = rf.get("leaseTerm") or rf.get("leaseTerms") or prop.get("leaseTerm")
    if lease_raw and record.get("lease_terms") in (None, "[]"):
        if isinstance(lease_raw, list):
            record["lease_terms"] = _jdumps(lease_raw)
        else:
            record["lease_terms"] = _jdumps([str(lease_raw)])
        # Try to parse months from lease term
        if not record.get("minimum_lease_months"):
            m = re.search(r"(\d+)\s*month", str(lease_raw).lower())
            if m:
                record["minimum_lease_months"] = int(m.group(1))

    # -- Pets & policies -------------------------------------------------------
    pets = _coerce_bool(rf.get("petsAllowed") or prop.get("petsAllowed") or rf.get("isPetFriendly"))
    if pets is not None:
        record["pets_allowed"] = pets

    smoking = _coerce_bool(rf.get("smokingAllowed") or prop.get("smokingAllowed"))
    if smoking is not None:
        record["smoking_allowed"] = smoking

    # Pet types
    if record.get("pet_types_allowed") in (None, "[]"):
        pet_types = []
        if _coerce_bool(rf.get("catsAllowed")):
            pet_types.append("cats")
        if _coerce_bool(rf.get("dogsAllowed")):
            pet_types.append("dogs")
        if pet_types:
            record["pet_types_allowed"] = _jdumps(pet_types)

    # -- Amenities & features --------------------------------------------------

    # Heating
    heating_list = rf.get("heating") or []
    if heating_list:
        record["heating_type"] = _list_to_str(heating_list)

    # Cooling
    cooling_list = rf.get("cooling") or []
    if cooling_list:
        record["cooling_type"] = _list_to_str(cooling_list)

    # Laundry
    laundry_list = (
        rf.get("laundryFeatures") or rf.get("laundry") or
        rf.get("washerDryer") or []
    )
    if laundry_list:
        record["laundry_type"] = _list_to_str(laundry_list)

    # Appliances
    appliances_list = rf.get("appliances") or []
    if appliances_list and record.get("appliances") in (None, "[]"):
        record["appliances"] = _jdumps(appliances_list)

    # Utilities included
    utils_list = (
        rf.get("utilities") or rf.get("utilitiesIncluded") or
        rf.get("utilitiesPaidBy") or []
    )
    if utils_list and record.get("utilities_included") in (None, "[]"):
        record["utilities_included"] = _jdumps(utils_list)

    # Flooring
    floor_list = rf.get("flooring") or []
    if floor_list and record.get("flooring") in (None, "[]"):
        record["flooring"] = _jdumps(floor_list)

    # Parking -- richer detail from resoFacts
    parking_list = rf.get("parkingFeatures") or []
    if parking_list:
        record["parking"] = _list_to_str(parking_list)

    # Pet weight limit
    if not record.get("pet_weight_limit"):
        pet_wt = (
            rf.get("petsMaxWeight") or rf.get("maxPetWeight") or
            rf.get("petSizeLimit") or rf.get("petWeightLimit")
        )
        if pet_wt:
            record["pet_weight_limit"] = _safe_int(pet_wt)

    # ── Comprehensive amenity collection from every resoFacts section ──────────
    # We merge everything into a rich amenities list so admins see all details.

    existing_tags = []
    try:
        existing_tags = json.loads(record.get("amenities") or "[]")
    except (ValueError, TypeError):
        pass

    all_amenities = list(existing_tags)

    def _extend_amenities(label, lst):
        """Add labeled feature items to the amenities list."""
        if not lst:
            return
        if isinstance(lst, str):
            lst = [lst]
        for item in lst:
            if item and str(item).strip() not in ("None", "none", "0", "false", ""):
                entry = (label + ": " + str(item)) if label else str(item)
                if entry not in all_amenities:
                    all_amenities.append(entry)

    def _extend_plain(lst):
        """Add plain feature items (no label prefix) to the amenities list."""
        if not lst:
            return
        if isinstance(lst, str):
            lst = [lst]
        for item in lst:
            s = str(item).strip()
            if s and s not in ("None", "none", "0", "false", "") and s not in all_amenities:
                all_amenities.append(s)

    # Community / building features
    _extend_plain(prop.get("communityFeatures") or rf.get("communityFeatures") or [])
    _extend_plain(rf.get("buildingFeatures") or [])
    _extend_plain(rf.get("associationAmenities") or rf.get("amenities") or [])

    # Interior features
    _extend_plain(rf.get("interiorFeatures") or [])

    # Exterior features
    _extend_plain(rf.get("exteriorFeatures") or [])

    # Pool
    pool_f = rf.get("poolFeatures") or []
    if pool_f or _coerce_bool(rf.get("pool") or rf.get("poolPrivateYN")):
        _extend_plain(pool_f if pool_f else ["Pool"])

    # Spa / hot tub
    spa_f = rf.get("spaFeatures") or []
    if spa_f or _coerce_bool(rf.get("spaYN")):
        _extend_plain(spa_f if spa_f else ["Spa/Hot Tub"])

    # Patio / deck
    _extend_plain(rf.get("patioAndPorchFeatures") or [])

    # View
    _extend_plain(rf.get("view") or [])

    # Security features
    _extend_plain(rf.get("securityFeatures") or rf.get("security") or [])

    # Accessibility / ADA
    _extend_plain(rf.get("accessibilityFeatures") or [])

    # Lot features
    _extend_plain(rf.get("lotFeatures") or rf.get("lotDescription") or [])

    # Green / energy efficiency
    _extend_plain(rf.get("greenEnergyEfficient") or [])
    _extend_plain(rf.get("greenEnergyGeneration") or [])
    _extend_plain(rf.get("greenBuildingVerificationType") or [])

    # Construction materials & structure
    _extend_amenities("Construction", rf.get("constructionMaterials") or [])
    _extend_amenities("Roof", rf.get("roof") or [])
    _extend_amenities("Foundation", rf.get("foundationDetails") or rf.get("foundation") or [])

    # Water / sewer (add to utilities too)
    water = rf.get("waterSource") or rf.get("water") or []
    sewer = rf.get("sewer") or rf.get("sewerType") or []
    if water:
        _extend_amenities("Water", water if isinstance(water, list) else [water])
    if sewer:
        _extend_amenities("Sewer", sewer if isinstance(sewer, list) else [sewer])
    # Also merge water/sewer into utilities_included if not already there
    combined_utils = []
    try:
        combined_utils = json.loads(record.get("utilities_included") or "[]")
    except (ValueError, TypeError):
        pass
    if water and not any("water" in str(u).lower() for u in combined_utils):
        combined_utils.extend(water if isinstance(water, list) else [water])
    if sewer and not any("sewer" in str(u).lower() for u in combined_utils):
        combined_utils.extend(sewer if isinstance(sewer, list) else [sewer])
    if combined_utils:
        record["utilities_included"] = _jdumps(combined_utils)

    # Electric
    elec = rf.get("electricExpenses") or rf.get("electric")
    if elec:
        _extend_amenities("Electric", [elec] if isinstance(elec, str) else elec)

    # Other structures (shed, garage, barn, etc.)
    _extend_plain(rf.get("otherStructures") or [])

    # Fencing
    _extend_plain(rf.get("fencing") or [])

    # Horse / farm amenities
    _extend_plain(rf.get("horseAmenities") or [])

    # Fire place
    fp = rf.get("fireplaceFeatures") or []
    fp_count = rf.get("fireplaces") or rf.get("fireplaceCount") or 0
    if fp_count and int(str(fp_count).split(".")[0]) > 0:
        _extend_plain(fp if fp else ["Fireplace"])

    # Window features
    _extend_plain(rf.get("windowFeatures") or [])

    # Door features
    _extend_plain(rf.get("doorFeatures") or [])

    # atAGlanceFacts (Zillow's own summary cards)
    for fact in (rf.get("atAGlanceFacts") or []):
        if isinstance(fact, dict):
            val = fact.get("factValue") or fact.get("value")
            lbl = fact.get("factLabel") or fact.get("label")
            if val and val not in ("None", "0", "false", ""):
                entry = ((lbl + ": " + str(val)) if lbl else str(val)).strip()
                if entry not in all_amenities:
                    all_amenities.append(entry)

    if all_amenities:
        record["amenities"] = _jdumps(list(dict.fromkeys(all_amenities)))

    # -- Location context: school district, zoning, walk scores ---------------
    ctx_parts = []

    # School district
    district = rf.get("schoolDistrict") or prop.get("schoolDistrict")
    elem     = rf.get("elementarySchool") or rf.get("elementarySchoolDistrict")
    middle   = rf.get("middleOrJuniorSchool") or rf.get("middleOrJuniorSchoolDistrict")
    high     = rf.get("highSchool") or rf.get("highSchoolDistrict")
    if district:
        ctx_parts.append("School district: " + str(district))
    if elem:
        ctx_parts.append("Elementary: " + str(elem))
    if middle:
        ctx_parts.append("Middle school: " + str(middle))
    if high:
        ctx_parts.append("High school: " + str(high))

    # Walk / transit / bike scores
    ws = prop.get("walkScore") or (prop.get("walkScoreData") or {}).get("walkScore")
    ts = prop.get("transitScore") or (prop.get("walkScoreData") or {}).get("transitScore")
    bs = prop.get("bikeScore") or (prop.get("walkScoreData") or {}).get("bikeScore")
    if ws is not None:
        ctx_parts.append("Walk score: " + str(ws))
    if ts is not None:
        ctx_parts.append("Transit score: " + str(ts))
    if bs is not None:
        ctx_parts.append("Bike score: " + str(bs))

    # Zoning
    zoning = rf.get("zoning") or rf.get("zoningDescription")
    if zoning:
        ctx_parts.append("Zoning: " + str(zoning))

    if ctx_parts:
        existing_ctx = record.get("location_context") or ""
        new_ctx = "; ".join(ctx_parts)
        record["location_context"] = (existing_ctx + "; " + new_ctx) if existing_ctx else new_ctx

    # -- Neighborhood ----------------------------------------------------------
    if not record.get("neighborhood"):
        hood = (
            prop.get("neighborhoodRegion", {}).get("name") or
            prop.get("neighborhoodName") or
            prop.get("neighborhood") or
            rf.get("subdivision") or
            rf.get("neighborhoodCommunityName")
        )
        record["neighborhood"] = hood

    # -- Property type ---------------------------------------------------------
    if not record.get("property_type"):
        raw_type = (prop.get("homeType") or rf.get("homeType") or "").upper()
        record["property_type"] = _TYPE_MAP.get(raw_type) or raw_type or None

    # -- Auto-title (rebuild if we now have better data) -----------------------
    if record.get("bedrooms") and record.get("city") and record.get("property_type"):
        bed_pfx  = str(record["bedrooms"]) + "BR "
        type_lbl = record["property_type"].replace("_", " ").title()
        record["title"] = bed_pfx + type_lbl + " in " + record["city"]

    # -- Photos (always replace -- detail is far richer, no cap) ---------------
    detail_photos = _collect_photos_detail(prop)
    if detail_photos:
        record["original_image_urls"] = _jdumps(detail_photos)

    # -- Agent / broker --------------------------------------------------------
    attr = prop.get("attributionInfo") or {}
    if not record.get("agent_name"):
        record["agent_name"] = attr.get("agentName") or attr.get("providerName")
    if not record.get("broker_name"):
        record["broker_name"] = attr.get("brokerName") or attr.get("officeName")
    if not record.get("agent_image_url"):
        record["agent_image_url"] = attr.get("agentPhoto") or attr.get("agentPhotoUrl")

    # Virtual tour / 3D tour / video tour
    if not record.get("virtual_tour_url"):
        record["virtual_tour_url"] = (
            prop.get("virtualTourUrl") or
            prop.get("threeDimensionalTourUrl") or
            prop.get("videoTourUrl") or
            prop.get("tourViewCount") and None  # don't use count as URL
        )

    # -- Update original_data: mark phase 2 complete + store rich metadata -----
    try:
        od = json.loads(record.get("original_data") or "{}")
    except (ValueError, TypeError):
        od = {}
    od["_phase"]       = "detail"
    od["zpid"]         = record.get("source_listing_id") or od.get("zpid")
    od["daysOnMarket"] = prop.get("daysOnZillow") or prop.get("daysOnMarket")

    # -- listed_at: prefer direct date fields; fall back to computed daysOnMarket
    # Direct fields are more accurate than subtracting days from today's date.
    # Never overwrite a listed_at already set in Phase 1 search.
    if record.get("listed_at") is None:
        _direct_date = (
            _parse_date(prop.get("listingDateTimeOnZillow")) or
            _parse_date(prop.get("datePostedString")) or
            _parse_date(rf.get("onMarketDate")) or
            _parse_date(rf.get("listingContractDate"))
        )
        if _direct_date:
            record["listed_at"] = _direct_date
    # Compute listed_at from daysOnMarket (today - N days = original listing date)
    _dom = od["daysOnMarket"]
    if _dom is not None and record.get("listed_at") is None:
        try:
            from datetime import date as _date, timedelta as _td
            record["listed_at"] = (_date.today() - _td(days=int(_dom))).isoformat()
        except Exception:
            pass
    od["priceHistory"] = (prop.get("priceHistory") or [])[:5]     # last 5 events
    od["openHouses"]   = prop.get("openHouseSchedule") or prop.get("openHouses") or []
    od["mlsId"]        = rf.get("mlsId") or rf.get("listingId") or rf.get("listingContractDate")
    od["taxHistory"]   = (prop.get("taxHistory") or [])[:3]        # last 3 years
    od["zillowUrl"]    = record.get("source_url")
    od["schools"]      = prop.get("schools") or []
    od["photoCount"]   = len(json.loads(record.get("original_image_urls") or "[]"))
    # Store full resoFacts for reference (truncated to avoid huge JSON)
    rf_keys_stored = [
        "heating","cooling","laundryFeatures","appliances","flooring","parkingFeatures",
        "garageSpaces","basement","securityDeposit","applicationFee","petFee",
        "petsAllowed","catsAllowed","dogsAllowed","petsMaxWeight","smokingAllowed",
        "stories","interiorFeatures","exteriorFeatures","communityFeatures",
        "poolFeatures","spaFeatures","patioAndPorchFeatures","view","securityFeatures",
        "accessibilityFeatures","lotFeatures","greenEnergyEfficient",
        "constructionMaterials","roof","foundationDetails","waterSource","sewer",
        "fireplaces","fireplaceFeatures","windowFeatures","utilities",
        "schoolDistrict","elementarySchool","middleOrJuniorSchool","highSchool",
        "zoning","leaseTerm","leaseTerms","dateAvailable","associationAmenities",
    ]
    od["resoFacts"] = {k: rf.get(k) for k in rf_keys_stored if rf.get(k) is not None}
    record["original_data"] = json.dumps(od, default=str)

    # -- Recompute quality score & missing fields ------------------------------
    record["data_quality_score"] = _quality_score(record)
    record["missing_fields"]     = _jdumps(_missing_fields(record))
    record["updated_at"]         = _now()

    return record


# -- Filters -------------------------------------------------------------------

def _passes_filters(raw, beds_min, beds_max, price_min, price_max):
    """Return True if a raw search listing passes the user's CLI filters."""
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

    if beds_min is not None and (beds is None or float(beds) < beds_min):
        return False
    if beds_max is not None and (beds is not None and float(beds) > beds_max):
        return False
    if price_min is not None and (price is None or price < price_min):
        return False
    if price_max is not None and (price is not None and price > price_max):
        return False

    # Skip non-rental items that sometimes bleed into results
    pgapt  = raw.get("pgapt") or ""
    status = raw.get("statusType") or ""
    if pgapt and pgapt not in ("ForRent", ""):
        return False
    if status and "RENT" not in status.upper() and status not in ("", "FOR_RENT"):
        return False

    return True


# -- Phase 2: detail page fetcher (thread-safe) --------------------------------

_detail_lock = threading.Lock()
_detail_ua_idx = [0]


def _next_ua():
    """Thread-safe round-robin UA picker."""
    with _detail_lock:
        idx = _detail_ua_idx[0] % len(_USER_AGENTS)
        _detail_ua_idx[0] += 1
        return _USER_AGENTS[idx]


def _fetch_detail_property(session, url, zpid, verbose=False):
    """
    Fetch a single Zillow detail page and return the property dict, or None.
    Uses the shared session (cookies carry over from search phase).
    Applies a random delay before the request.
    """
    if not url:
        return None

    time.sleep(random.uniform(*DETAIL_DELAY))

    # Rotate UA per request to reduce fingerprint
    hdrs = {"User-Agent": _next_ua(), "Referer": "https://www.zillow.com/homes/for_rent/"}

    for attempt in range(MAX_DETAIL_RETRY + 1):
        try:
            resp = session.get(url, headers=hdrs, timeout=DETAIL_TIMEOUT, allow_redirects=True)
        except Exception as e:
            if verbose:
                print("     [detail] error fetching zpid=" + zpid + " : " + str(e)[:80])
            return None

        if _is_bot_page(resp.text if resp.status_code == 200 else "", resp.status_code):
            if verbose:
                print("     [detail] bot-detected (status=" + str(resp.status_code) + ") zpid=" + zpid)
            if attempt < MAX_DETAIL_RETRY:
                time.sleep(random.uniform(3.0, 6.0))
                continue
            return None

        if resp.status_code != 200:
            if verbose:
                print("     [detail] HTTP " + str(resp.status_code) + " for zpid=" + zpid)
            return None

        nd = _extract_next_data(resp.text)
        prop = _extract_detail_property(nd)
        if prop:
            return prop

        if attempt < MAX_DETAIL_RETRY:
            time.sleep(random.uniform(2.0, 4.0))

    return None


def _enrich_records_with_details(session, records, verbose=True):
    """
    Phase 2: fetch detail pages for all records that have a source_url and
    would benefit from enrichment (score < ENRICH_SKIP_SCORE).
    Returns the enriched records list.
    """
    to_enrich = []
    already_good = []

    for rec in records:
        url = rec.get("source_url")
        score = rec.get("data_quality_score") or 0
        if url and score < ENRICH_SKIP_SCORE:
            to_enrich.append(rec)
        else:
            already_good.append(rec)

    if not to_enrich:
        if verbose:
            print("  ✅  All records already at quality score >= " + str(ENRICH_SKIP_SCORE) + ", skipping detail fetch.")
        return records

    if verbose:
        print(
            "\n  🔍  Phase 2 — Fetching detail pages for "
            + str(len(to_enrich)) + " listing(s) ["
            + str(DETAIL_WORKERS) + " workers]..."
        )
        if already_good:
            print("     Skipping " + str(len(already_good)) + " already high-quality records.")

    enriched      = []
    fetch_failed  = 0   # prop=None (bot block / timeout / 404)
    worker_errors = 0   # unexpected exception in worker

    def _worker(rec):
        url  = rec.get("source_url")
        zpid = rec.get("source_listing_id") or "?"
        prop = _fetch_detail_property(session, url, zpid, verbose=False)
        if prop:
            result = _enrich_from_detail(rec, prop)
            result["_detail_ok"] = True
            return result
        # Detail fetch returned None — bot block, timeout, or 404.
        stub = dict(rec)
        stub["_detail_ok"] = False
        return stub

    workers = min(DETAIL_WORKERS, len(to_enrich))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(_worker, rec): rec for rec in to_enrich}
        done = 0
        for fut in as_completed(futures):
            done += 1
            try:
                result = fut.result()
                if not result.pop("_detail_ok", True):
                    fetch_failed += 1
                enriched.append(result)
            except Exception as _exc:
                enriched.append(futures[fut])
                worker_errors += 1
            if verbose and done % 5 == 0:
                print("     [detail] " + str(done) + "/" + str(len(to_enrich)) + " done...")

    if verbose:
        scores = [r.get("data_quality_score", 0) for r in enriched]
        avg_after = round(sum(scores) / len(scores), 1) if scores else 0
        total_failed = fetch_failed + worker_errors
        ok_count = len(enriched) - total_failed
        print(
            "  ✅  Detail phase complete. "
            + str(ok_count) + " enriched, "
            + str(total_failed) + " failed"
            + (" (" + str(fetch_failed) + " bot/timeout, " + str(worker_errors) + " errors)" if total_failed else "")
            + ". Avg score after: " + str(avg_after)
        )
        if fetch_failed:
            print(
                "     ⚠  " + str(fetch_failed) + " listing(s) staged as search-phase stubs "
                "(detail page blocked — lower quality score, fewer fields)."
            )

    return already_good + enriched


# -- Public scrape function ----------------------------------------------------

def scrape_and_map(
    location,
    limit         = 200,
    beds_min      = None,
    beds_max      = None,
    price_min     = None,
    price_max     = None,
    min_score     = 0,
    fetch_details = True,
    verbose       = True,
):
    """
    Scrape Zillow for-rent listings for one location and return a list of
    pipeline_properties-compatible dicts (quality scored, filters applied).

    Phase 1: Crawl search result pages to collect listings (always runs).
    Phase 2: Fetch each listing's detail page to extract full property data
             including amenities, appliances, utilities, heating/cooling/laundry,
             actual security deposit, available date, and high-res photos.
             Controlled by fetch_details parameter.

    Args:
        location      : human-readable location string ('Dallas, TX', etc.)
        limit         : max number of records to return
        beds_min/max  : bedroom filter (client-side)
        price_min/max : rent filter (client-side)
        min_score     : drop records below this quality score (after enrichment)
        fetch_details : if True, run Phase 2 detail enrichment (recommended)
        verbose       : print progress to stdout

    Returns:
        (records: list[dict], blocked: bool)
        blocked=True means Zillow returned bot-detection on the first search page.
    """
    # -- Cloud/datacenter IP guard ------------------------------------------------
    # DataDome blocks ALL datacenter IPs regardless of TLS fingerprint or UA.
    # Detect common cloud environments and warn immediately so the user does not
    # waste time watching requests silently fail with 403s.
    _cloud_signals = ["REPLIT_CLUSTER", "REPLIT_ID", "REPL_ID", "AWS_EXECUTION_ENV",
                      "ECS_CONTAINER_METADATA_URI", "GOOGLE_CLOUD_PROJECT", "DYNO"]
    _on_cloud = any(os.environ.get(k) for k in _cloud_signals)
    if _on_cloud:
        import sys as _warn_sys
        _warn_sys.stderr.write(
            "\n[zillow_scraper] WARNING: Cloud/datacenter environment detected.\n"
            "  Zillow's DataDome bot-detection blocks all datacenter IPs regardless of\n"
            "  TLS fingerprint or user-agent. Requests will return 403.\n"
            "  Run this scraper from a residential IP (home WiFi, office, or iPhone\n"
            "  mobile data via iSH) to get results.\n\n"
        )

    session  = _make_session()
    slug     = _location_to_slug(location)
    raw_kept = []
    blocked  = False

    if verbose:
        print("  [Zillow] Phase 1 -- search pages for: " + location)
        print("  [Zillow] Warming up session (homepage + for-rent page) ...")

    # Establish session cookies before hitting search pages. Without this warm-up,
    # DataDome flags the first search request (no prior cookie chain).
    _warm_session(session, verbose=verbose)

    # -- Phase 1: Search pages -------------------------------------------------
    for page in range(1, MAX_PAGES + 1):
        if len(raw_kept) >= limit:
            break

        url = _build_search_url(slug, page)
        if verbose:
            print("     -> page " + str(page) + ": " + url)

        try:
            resp = session.get(url, timeout=25, allow_redirects=True)
        except Exception as e:
            if verbose:
                print("  [warning] Request error (page " + str(page) + "): " + str(e))
            break

        if _is_bot_page(resp.text if resp.status_code == 200 else "", resp.status_code):
            # Handle 429 rate-limit with a wait-and-retry regardless of verbose mode.
            if resp.status_code == 429:
                if verbose:
                    print("  [rate-limited] 429 -- waiting 45s and retrying...")
                time.sleep(45)
                try:
                    resp = session.get(url, timeout=25, allow_redirects=True)
                    if resp.status_code == 200 and not _is_bot_page(resp.text, resp.status_code):
                        pass  # retry succeeded -- fall through to normal processing
                    else:
                        if page == 1:
                            blocked = True
                        break
                except Exception:
                    if page == 1:
                        blocked = True
                    break
            else:
                if verbose:
                    if resp.status_code == 403:
                        print("  [blocked] Zillow returned 403 -- DataDome bot detection triggered.")
                        print("  [blocked] Must run from a residential IP (home/office WiFi or mobile data).")
                        print("  [blocked] Datacenter/cloud IPs (Replit, AWS, GCP) are always blocked.")
                    else:
                        print("  [blocked] Bot-detection page detected (status=" + str(resp.status_code) + ").")
                if resp.status_code != 200:
                    if page == 1:
                        blocked = True
                    break

        if resp.status_code != 200:
            if verbose:
                print("  [warning] HTTP " + str(resp.status_code) + " on page " + str(page))
            break

        nd = _extract_next_data(resp.text)
        if not nd:
            if verbose:
                print(
                    "  [warning] __NEXT_DATA__ not found on page " + str(page) + ".\n"
                    "     Zillow may have served a CAPTCHA or changed page structure."
                )
            if page == 1:
                blocked = True
            break

        listings, total_count = _get_listings_array(nd)

        if not listings:
            if verbose and page == 1:
                print(
                    "  [warning] No listings in __NEXT_DATA__ on page 1.\n"
                    "     Location may be invalid, or results page structure changed."
                )
            break

        if verbose and page == 1:
            desc = ("~" + str(total_count) + " total") if total_count else "unknown total"
            print("     Zillow reports " + desc + " for-rent listings")

        page_kept = 0
        for raw in listings:
            if len(raw_kept) >= limit:
                break
            if _passes_filters(raw, beds_min, beds_max, price_min, price_max):
                raw_kept.append(raw)
                page_kept += 1

        if verbose:
            print(
                "     Kept " + str(page_kept) + " from page " + str(page)
                + " (running total: " + str(len(raw_kept)) + ")"
            )

        if total_count and len(raw_kept) >= min(total_count, limit):
            break
        if len(listings) < 10:
            break

        if page < MAX_PAGES:
            # Rotate UA between search pages
            _rotate_ua(session)
            time.sleep(random.uniform(*PAGE_DELAY))

    # -- Map Phase 1 raw -> pipeline records -----------------------------------
    records = []
    for raw in raw_kept:
        try:
            rec = _map_listing(raw)
            has_addr   = bool(rec.get("address") and rec.get("city"))
            has_coords = rec.get("lat") is not None and rec.get("lng") is not None
            if not has_addr and not has_coords:
                continue
            records.append(rec)
        except Exception:
            continue

    if verbose:
        scores = [r.get("data_quality_score", 0) for r in records]
        avg    = round(sum(scores) / len(scores), 1) if scores else 0
        print(
            "  [Phase 1 done] " + str(len(records)) + " records mapped. "
            "Avg quality score: " + str(avg)
        )

    # -- Phase 2: Detail enrichment --------------------------------------------
    if fetch_details and records:
        records = _enrich_records_with_details(session, records, verbose=verbose)

    # -- Final quality filter --------------------------------------------------
    if min_score > 0:
        before = len(records)
        records = [r for r in records if (r.get("data_quality_score") or 0) >= min_score]
        dropped = before - len(records)
        if verbose and dropped:
            print("     Dropped " + str(dropped) + " record(s) below min-score " + str(min_score))

    if verbose:
        scores = [r.get("data_quality_score", 0) for r in records]
        avg    = round(sum(scores) / len(scores), 1) if scores else 0
        print(
            "  [Zillow done] " + str(len(records)) + " pipeline-ready records for: "
            + location + "  (avg score: " + str(avg) + ")"
        )

    return records, blocked


# -- Direct URL scraping (skip search phase entirely) -------------------------

def _extract_zpid_from_url(url):
    """Extract Zillow property ID (zpid) from a detail page URL.
    e.g. https://www.zillow.com/homedetails/.../49843423_zpid/ -> '49843423'
    """
    m = re.search(r"/(\d+)_zpid", url)
    return m.group(1) if m else None


def _map_from_detail_only(prop, source_url=None, zpid=None):
    """
    Create a full pipeline_properties record from a detail-page property dict alone.
    This is used when scraping specific URLs directly (no search phase).
    Starts with a blank record and applies the full detail enrichment.
    """
    if not prop or not isinstance(prop, dict):
        return None

    zpid_str = zpid or str(prop.get("zpid") or "")
    addr = prop.get("address") or {}
    now  = _now()

    # Map homeStatus/statusType to canonical source_status so the availability
    # filter in pipeline._step2_availability_dedup() can gate off-market listings.
    _raw_status = str(prop.get("homeStatus") or prop.get("statusType") or "").upper()
    if "FOR_RENT" in _raw_status or _raw_status in ("ACTIVE", "ACTIVE_FOR_RENT"):
        _src_status = "available"
    elif "PENDING" in _raw_status:
        _src_status = "pending"
    elif "RENTED" in _raw_status or "LEASED" in _raw_status:
        _src_status = "rented"
    elif not _raw_status:
        # No status field on the detail page at all -- default to available.
        # This path is hit when scraping known for-rent URLs directly.
        _src_status = "available"
    else:
        # Any other non-empty status (FOR_SALE, SOLD, OFF_MARKET, REMOVED, etc.)
        # is treated as removed. Safer to reject unknowns than to publish them.
        _src_status = "removed"

    # Blank record -- all fields defaulted, then _enrich_from_detail fills them in
    record = {
        "id":                    _gen_id(),
        "source":                "zillow",
        "source_url":            source_url,
        "source_listing_id":     zpid_str,
        "status":                "scraped",
        "source_status":         _src_status,
        "title":                 None,
        "address":               addr.get("streetAddress") or addr.get("street"),
        "unit_number":           None,
        "city":                  addr.get("city"),
        "state":                 addr.get("state"),
        "zip":                   addr.get("zipcode"),
        "county":                None,
        "neighborhood":          None,
        "lat":                   _safe_float(prop.get("latitude")),
        "lng":                   _safe_float(prop.get("longitude")),
        "location_context":      None,
        "property_type":         None,
        "bedrooms":              _safe_int(prop.get("bedrooms")),
        "bathrooms":             _safe_int(prop.get("bathrooms")),
        "half_bathrooms":        None,
        "total_bathrooms":       _safe_float(prop.get("bathrooms")),
        "square_footage":        _safe_int(prop.get("livingArea")),
        "lot_size_sqft":         None,
        "year_built":            _safe_int(prop.get("yearBuilt")),
        "floors":                None,
        "garage_spaces":         None,
        "total_units":           None,
        "has_basement":          False,
        "has_central_air":       False,
        "virtual_tour_url":      None,
        "monthly_rent":          _parse_price(prop.get("price") or prop.get("rentZestimate")),
        "security_deposit":      None,
        "last_months_rent":      None,
        "application_fee":       None,
        "pet_deposit":           None,
        "admin_fee":             None,
        "move_in_special":       None,
        "parking_fee":           None,
        "hoa_fee":               None,
        "tax_value":             None,
        "description":           prop.get("description"),
        "showing_instructions":  None,
        "available_date":        None,
        "minimum_lease_months":  None,
        "lease_terms":           "[]",
        "pets_allowed":          None,
        "pet_types_allowed":     "[]",
        "pet_weight_limit":      None,
        "pet_details":           None,
        "smoking_allowed":       None,
        "parking":               None,
        "amenities":             "[]",
        "appliances":            "[]",
        "utilities_included":    "[]",
        "flooring":              "[]",
        "heating_type":          None,
        "cooling_type":          None,
        "laundry_type":          None,
        "original_image_urls":   "[]",
        "local_image_paths":     "[]",
        "agent_name":            None,
        "broker_name":           None,
        "agent_image_url":       None,
        "poster_landlord_id":    None,
        "original_data":         json.dumps(
            {"zpid": zpid_str, "detailUrl": source_url, "_source": "zillow", "_phase": "detail"},
            default=str,
        ),
        "edited_fields":         "[]",
        "inferred_features":     "[]",
        "published_at":          None,
        "choice_property_id":    None,
        "scraped_at":            now,
        "updated_at":            now,
    }

    # Apply full detail enrichment (this populates every resoFacts field, photos, etc.)
    record = _enrich_from_detail(record, prop)

    # Build auto-title from best available data
    if not record.get("title"):
        beds     = record.get("bedrooms")
        ptype    = record.get("property_type") or "Rental"
        city     = record.get("city")
        street   = record.get("address")
        bed_pfx  = (str(beds) + "BR ") if beds else ""
        type_lbl = ptype.replace("_", " ").title()
        if city:
            record["title"] = bed_pfx + type_lbl + " in " + city
        elif street:
            record["title"] = street
        else:
            record["title"] = "Zillow Rental"

    return record


def scrape_urls(urls, verbose=True):
    """
    Scrape a list of individual Zillow detail page URLs directly.

    Skips Phase 1 (search) entirely and fetches the full detail page for each
    URL, extracting all property data including photos, resoFacts, amenities, etc.

    Args:
        urls    : list of Zillow homedetails URLs (absolute, with or without query params)
        verbose : print progress to stdout

    Returns:
        (records: list[dict], failed_urls: list[str])
    """
    session  = _make_session()
    records  = []
    failed   = []
    total    = len(urls)

    if verbose:
        print("  [Zillow] Direct URL scrape: " + str(total) + " listing(s)")
        print("  [Zillow] Warming up session (homepage + search page) to establish cookies ...")

    # CRITICAL: warm up session before hitting any detail pages.
    # Without cookies from a prior Zillow page visit, DataDome returns 403
    # on every detail page regardless of IP or User-Agent.
    _warm_session(session, verbose=verbose)

    for i, raw_url in enumerate(urls):
        # Strip UTM params / query string -- they don't affect the page content
        clean_url = raw_url.split("?")[0].rstrip("/") + "/"
        # Make sure it's a full URL
        if not clean_url.startswith("http"):
            clean_url = ZILLOW_BASE + clean_url
        zpid = _extract_zpid_from_url(clean_url) or ""

        if verbose:
            print(
                "\n  [" + str(i + 1) + "/" + str(total) + "] "
                + clean_url
                + ("  (zpid=" + zpid + ")" if zpid else "")
            )

        # Polite delay between requests (skip on first)
        if i > 0:
            delay = random.uniform(*DETAIL_DELAY)
            if verbose:
                print("     Waiting " + str(round(delay, 1)) + "s...")
            time.sleep(delay)

        prop = _fetch_detail_property(session, clean_url, zpid, verbose=verbose)

        if not prop:
            if verbose:
                print("  [failed] Could not extract property data. "
                      "Check if the listing is still active and your IP is residential.")
            failed.append(raw_url)
            continue

        try:
            rec = _map_from_detail_only(prop, clean_url, zpid)
            if not rec:
                failed.append(raw_url)
                continue
            records.append(rec)
            if verbose:
                addr  = " ".join(filter(None, [rec.get("address"), rec.get("city"), rec.get("state")]))
                rent  = ("$" + str(rec["monthly_rent"]) + "/mo") if rec.get("monthly_rent") else "no rent"
                score = rec.get("data_quality_score", 0)
                imgs  = len(json.loads(rec.get("original_image_urls") or "[]"))
                print(
                    "  [ok] " + (addr or "?") + " — " + rent
                    + "  score=" + str(score)
                    + "  photos=" + str(imgs)
                )
        except Exception as e:
            if verbose:
                print("  [error] Failed to map property: " + str(e))
            failed.append(raw_url)
            continue

    if verbose:
        if records:
            scores = [r.get("data_quality_score", 0) for r in records]
            avg    = round(sum(scores) / len(scores), 1) if scores else 0
            print(
                "\n  [Zillow URL done] " + str(len(records)) + "/" + str(total)
                + " scraped successfully. Avg score: " + str(avg)
            )
        if failed:
            print("  [failed URLs] " + str(len(failed)) + " could not be scraped:")
            for u in failed:
                print("     " + u)

    return records, failed
