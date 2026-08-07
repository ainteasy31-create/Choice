#!/usr/bin/env python3
"""
Choice Properties — CJ Properties (cjproperties.org) Scraper
=============================================================
Scrapes rental listings from https://cjproperties.org/ which is a
WordPress + Rent Manager powered property management site.

The site serves its listing data via Rent Manager's JavaScript API:
    https://cjre.ua.rentmanager.com/search_result?command=search_result&corpid=cjre&...
The API returns a `document.write(...)` JavaScript blob containing HTML
property cards. This module fetches that blob, parses the HTML, and maps
each property into the standard `pipeline_properties` record format so it
can be fed directly to `PipelineOrchestrator.run_records()`.

Integration:
    from cjproperties_scraper import scrape_cjproperties
    records = scrape_cjproperties(states=None, verbose=True)
    orchestrator.run_records(records, batch_name="CJ Properties MO/KS")

Key data points extracted per property:
  - source_listing_id: Rent Manager unitID
  - address / city / state / zip
  - property_type: House, Townhome, Duplex, Apartment, etc.
  - bedrooms, bathrooms, monthly_rent
  - description (rich HTML stripped to plain text)
  - original_image_urls: Rent Manager FileReader photo URLs
  - title / header

Photo notes:
  The search results API provides one main photo per unit. Some units
  may have additional photos accessible via the per-unit detail endpoint,
  but that endpoint is not reliably reachable. Listing records carry
  whatever photos the search API exposes — the pipeline's photo gate
  (minimum 6) will filter out records with insufficient imagery, so the
  operator should run `--min-score` / `--target` with awareness that only
  fully-photographed units will publish.
"""

from __future__ import annotations

import html
import json
import re
import time
import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

try:
    from bs4 import BeautifulSoup
    _BS4_OK = True
except ImportError:
    BeautifulSoup = None
    _BS4_OK = False

try:
    import requests as _req
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
    _REQUESTS_OK = True
except ImportError:
    _REQUESTS_OK = False

# ---------------------------------------------------------------------------
# Rent Manager API configuration
# ---------------------------------------------------------------------------
RM_BASE_URL = "https://cjre.ua.rentmanager.com"
RM_SEARCH_URL = RM_BASE_URL + "/search_result"
RM_CORP_ID = "cjre"
RM_LOCATIONS_DEFAULT = "Results,CJ Real Estate"
RM_LOCATIONS_ALL = "CJ Real Estate,Results"

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://cjproperties.org/properties/",
    "Connection": "keep-alive",
}

FETCH_TIMEOUT = 30
FETCH_RETRIES = 3
FETCH_RETRY_DELAY = 2.0
REQUEST_DELAY = 1.0

MAX_PHOTOS = 50

# Property type mapping: Rent Manager type string -> pipeline canonical type
_PROPERTY_TYPE_MAP = {
    "House": "SINGLE_FAMILY",
    "Single Family": "SINGLE_FAMILY",
    "Single-Family": "SINGLE_FAMILY",
    "Townhome": "TOWNHOMES",
    "Townhouse": "TOWNHOMES",
    "Condo": "CONDOS",
    "Condominium": "CONDOS",
    "Apartment": "APARTMENT",
    "Aparmtment": "APARTMENT",     # typo from source
    "Duplex": "DUPLEX",
    "Multi-Family": "MULTI_FAMILY",
    "MultiFamily": "MULTI_FAMILY",
    "Commercial": "COMMERCIAL",
    "Commercial Space": "COMMERCIAL",
    "Mobile Home": "MOBILE",
    "Manufactured": "MOBILE",
}

# Canonical property types the pipeline can accept for normal listings
_ALLOWED_RENTAL_TYPES = {
    "SINGLE_FAMILY", "TOWNHOMES", "CONDOS", "APARTMENT", "DUPLEX",
}

_CORE_FIELDS = [
    "address", "city", "state", "zip", "lat", "lng",
    "bedrooms", "bathrooms", "square_footage", "monthly_rent",
    "property_type", "description", "available_date",
]
_BONUS_FIELDS = [
    "county", "neighborhood", "year_built", "parking",
    "pets_allowed", "security_deposit", "amenities", "appliances",
    "heating_type", "cooling_type", "laundry_type",
]
_TRACKABLE_MISSING = [
    "lat", "lng", "county", "neighborhood", "year_built", "square_footage",
    "parking", "pets_allowed", "security_deposit", "amenities", "appliances",
    "available_date", "heating_type", "cooling_type", "laundry_type",
]


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _make_session():
    if not _REQUESTS_OK:
        return None
    s = _req.Session()
    retry = Retry(
        total=FETCH_RETRIES,
        backoff_factor=0.5,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.headers.update(_HEADERS)
    return s


def _fetch_with_retry(session, url: str, params: Optional[Dict] = None, verbose: bool = False):
    """Fetch a URL with retries and backoff."""
    last_exc = None
    for attempt in range(1, FETCH_RETRIES + 1):
        try:
            resp = session.get(url, params=params, timeout=FETCH_TIMEOUT)
            resp.raise_for_status()
            return resp.text
        except Exception as e:
            last_exc = e
            if verbose:
                print("[cjproperties_scraper] fetch attempt {}/{} failed: {}".format(
                    attempt, FETCH_RETRIES, e
                ))
            if attempt < FETCH_RETRIES:
                time.sleep(FETCH_RETRY_DELAY * attempt)
    if verbose:
        print("[cjproperties_scraper] all fetch attempts failed for {}".format(url))
    return None


# ---------------------------------------------------------------------------
# HTML parsing helpers
# ---------------------------------------------------------------------------

def _unescape_js_string(js_text: str) -> str:
    """Rent Manager returns a document.write() JS blob.
    We need to pull the HTML content out of the escaped string.
    """
    # Decode common JS escapes
    text = js_text
    text = text.replace('\\"', '"').replace("\\'", "'")
    text = text.replace('\\n', "\n").replace('\\r', "\r").replace('\\t', "\t")
    return text


def _extract_html_from_js(js_text: str) -> str:
    """Extract the HTML written by document.write from the JS blob.
    Rent Manager emits: document.write("<table>...<table>");
    The HTML is inside a JS string with escaped quotes (\\").
    We need to unescape the JS string first, then extract the HTML.
    """
    # First, unescape the JS string content
    text = _unescape_js_string(js_text)

    # Try to find the HTML content directly
    m = re.search(r'<html[^>]*>.*?</html>', text, re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(0)
    m = re.search(r'<table.*?</table>', text, re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(0)
    m = re.search(r'<div.*?</div>\s*$', text, re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(0)

    # Fallback: extract the content between document.write(" and ");
    m = re.search(r'document\.write\(\s*["\'](.*?)["\']\s*\)', text, re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(1)

    return text


def _strip_tags(text: str) -> str:
    """Strip HTML tags but preserve newlines from <br> tags."""
    if not text:
        return ""
    text = re.sub(r"<br\s*/?>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    # Collapse spaces but keep newlines
    text = re.sub(r"[ \t]+", " ", text)
    # Remove spaces at line boundaries
    text = re.sub(r" *\n *", "\n", text)
    # Collapse multiple blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _safe_int(value) -> Optional[int]:
    if value is None:
        return None
    try:
        f = float(str(value).strip())
        return int(f) if f > 0 else None
    except (ValueError, TypeError):
        return None


def _safe_float(value) -> Optional[float]:
    if value is None:
        return None
    try:
        f = float(str(value).strip())
        return f if f > 0 else None
    except (ValueError, TypeError):
        return None


def _parse_price(value) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value)
    m = re.search(r"[\d,]+(?:\.\d+)?", text)
    if not m:
        return None
    try:
        return int(float(m.group(0).replace(",", "")))
    except Exception:
        return None


def _extract_property_blocks(html_content: str) -> List[Dict[str, Any]]:
    """Parse property cards from the Rent Manager HTML output.

    Each property is a `<div class="property" data-unitid="NNNN">` block
    containing sub-divs for header, address, price, and description.
    """
    pattern = re.compile(
        r'<div[^>]*class=["\']property["\'][^>]*data-unitid=["\'](\d+)["\'](.*?)'
        r'<div[^>]*class=["\']clear["\'][^>]*>.*?<hr',
        re.DOTALL | re.IGNORECASE,
    )
    blocks = []
    for m in pattern.finditer(html_content):
        unit_id = m.group(1)
        block = m.group(2)
        blocks.append({"unitid": unit_id, "html": block})

    # Fallback: if regex above didn't match, try a simpler split
    if not blocks:
        prop_pattern = re.compile(
            r'<div[^>]*class=["\']property["\'][^>]*data-unitid=["\'](\d+)["\'](.*?)(?=<div[^>]*class=["\']property["\']|$)',
            re.DOTALL | re.IGNORECASE,
        )
        for m in prop_pattern.finditer(html_content):
            blocks.append({"unitid": m.group(1), "html": m.group(2)})

    return blocks


# ---------------------------------------------------------------------------
# Per-property field extraction
# ---------------------------------------------------------------------------

def _extract_header(block_html: str) -> Optional[str]:
    m = re.search(r'<div class=["\']propertyHeader["\']>(.*?)</div>', block_html, re.DOTALL)
    if m:
        return _strip_tags(m.group(1))[:200] or None
    return None


def _extract_address(block_html: str) -> Dict[str, Optional[str]]:
    m = re.search(r'<div class=["\']propertyAddress["\']>(.*?)</div>', block_html, re.DOTALL)
    if not m:
        return {"street": None, "city": None, "state": None, "zip": None}
    raw = _strip_tags(m.group(1))
    # Format: "Street\nCity, State ZIP"
    lines = [l.strip() for l in raw.split("\n") if l.strip()]
    street = lines[0] if lines else None

    city_state_zip = lines[1] if len(lines) > 1 else lines[0] if lines else None
    city = None
    state = None
    zip_code = None

    if city_state_zip:
        # Try: "Kansas City, MO 64123"
        m2 = re.search(r"(.*?),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?", city_state_zip)
        if m2:
            city = m2.group(1).strip()
            state = m2.group(2).strip()
            zip_code = m2.group(3) or None
        else:
            # No comma — maybe "Sarasota FL 34231"
            m3 = re.search(r"(.+?)\s+([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?", city_state_zip)
            if m3:
                city = m3.group(1).strip()
                state = m3.group(2).strip()
                zip_code = m3.group(3) or None

    return {"street": street, "city": city, "state": state, "zip": zip_code}


def _extract_details(block_html: str) -> Dict[str, Optional[Any]]:
    """Extract type, bedrooms, bathrooms, price from the detailRight block."""
    m = re.search(r'<div class=["\']detailRight["\']>(.*?)</div>', block_html, re.DOTALL)
    if not m:
        return {"type": None, "beds": None, "baths": None, "rent": None}

    raw = _strip_tags(m.group(1))
    result = {"type": None, "beds": None, "baths": None, "rent": None}

    # Type
    tm = re.search(r"Type:\s*([^:\n]+)", raw)
    if tm:
        result["type"] = tm.group(1).strip()

    # Bedrooms
    bm = re.search(r"Bedrooms?:\s*(\d+)", raw)
    if bm:
        result["beds"] = _safe_int(bm.group(1))

    # Bathrooms
    bm2 = re.search(r"Bathrooms?:\s*([\d.]+)", raw)
    if bm2:
        result["baths"] = _safe_float(bm2.group(1))

    # Price
    pm = re.search(r"Price:\s*\$?([\d,]+(?:\.\d+)?)", raw)
    if pm:
        result["rent"] = _parse_price(pm.group(1))

    return result


def _extract_description(block_html: str) -> Optional[str]:
    m = re.search(r'<div class=["\']propertyDescription["\']>(.*?)</div>', block_html, re.DOTALL)
    if m:
        return _strip_tags(m.group(1))[:2000] or None
    return None


def _collect_image_urls_from_text(text: str, limit: int = MAX_PHOTOS) -> List[str]:
    """Collect unique Rent Manager FileReader image URLs from arbitrary HTML/text."""
    urls = []
    seen = set()
    pattern = re.compile(
        r'https://rm12filereader\.rentmanager\.com/files/get/\?EID=cjre&FKey=[^"\'\s\\]+',
        re.IGNORECASE,
    )
    for m in pattern.finditer(text or ""):
        url = html.unescape(m.group(0))
        if url and url not in seen:
            seen.add(url)
            urls.append(url)
            if len(urls) >= limit:
                break
    return urls


def _extract_image_urls(block_html: str) -> List[str]:
    """Extract Rent Manager FileReader image URLs from a property block."""
    return _collect_image_urls_from_text(block_html)


def _extract_image_urls_from_detail_html(detail_html: str) -> List[str]:
    """Extract gallery URLs from an individual detail page HTML payload."""
    if not detail_html:
        return []

    urls = _collect_image_urls_from_text(detail_html)
    if urls:
        return urls

    # Some detail pages may embed the gallery in JSON/JS objects or attributes.
    for pattern in [
        r'"(?:photos|images|gallery)"\s*:\s*\[(.*?)\]',
        r'\b(?:photos|images|gallery)\b\s*=\s*\[(.*?)\]',
    ]:
        m = re.search(pattern, detail_html, re.DOTALL | re.IGNORECASE)
        if m:
            urls = _collect_image_urls_from_text(m.group(1))
            if urls:
                return urls
    return urls


def _extract_unit_url(block_html: str) -> Optional[str]:
    m = re.search(r'href=["\']([^"\']*?unit[-_]detail[^"\']*)["\']', block_html, re.IGNORECASE)
    if m:
        return m.group(1)
    return None


def _fetch_detail_html(session, unit_id: str, unit_url: Optional[str], verbose: bool = False) -> Optional[str]:
    """Fetch the per-unit detail page when available and extract gallery URLs from it.

    Tries multiple sources in order:
    1. Rent Manager detail endpoint (rmwebsvc) which often includes the full photo gallery
    2. WordPress unit-detail page
    """
    if not session:
        return None

    # Save original headers to restore later
    original_headers = dict(session.headers)

    try:
        # Rent Manager detail endpoint that often includes the full photo gallery
        # This endpoint requires the unit-detail page as referer
        today = date.today()
        today_str = "{}/{:d}/{:d}".format(today.month, today.day, today.year)
        rm_detail = (
            "https://cjre.ua.rentmanager.com/search_result"
            "?command=Detail_View.aspx&corpid=cjre"
            "&rmwebsvc_unitid=" + unit_id +
            "&rmwebsvc_id=" + unit_id +
            "&rmwebsvc_command=Detail_View.aspx"
            "&rmwebsvc_corpid=cjre"
            "&rmwebsvc_location=1"
            "&rmwebsvc_mode=javaScript"
            "&rmwebsvc_template=searchresults"
            "&rmwebsvc_AvailabilityDate=" + today_str
        )

        if verbose:
            print("[cjproperties_scraper] fetching rmwebsvc detail: {}".format(rm_detail))
        # Set the correct referer for the rmwebsvc endpoint
        session.headers["Referer"] = "https://cjproperties.org/unit-detail?unitID={}".format(unit_id)
        resp = session.get(rm_detail, timeout=FETCH_TIMEOUT)
        if resp.status_code == 200:
            text = resp.text or ""
            if text:
                if verbose:
                    print("[cjproperties_scraper] rmwebsvc returned {} bytes".format(len(text)))
                return text
    except Exception as exc:
        if verbose:
            print("[cjproperties_scraper] rmwebsvc fetch failed: {}".format(exc))
    finally:
        # Restore original headers
        session.headers.clear()
        session.headers.update(original_headers)

    # Fallback to WordPress pages
    candidates = []
    if unit_url:
        if unit_url.startswith("/"):
            unit_url = "https://cjproperties.org" + unit_url
        candidates.append(unit_url)

    candidates.append("https://cjproperties.org/unit-detail?unitID={}".format(unit_id))

    seen = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            if verbose:
                print("[cjproperties_scraper] fetching detail page: {}".format(candidate))
            resp = session.get(candidate, timeout=FETCH_TIMEOUT)
            if resp.status_code != 200:
                continue
            text = resp.text or ""
            if not text:
                continue
            return text
        except Exception as exc:
            if verbose:
                print("[cjproperties_scraper] detail page fetch failed for {}: {}".format(candidate, exc))
    return None


# ---------------------------------------------------------------------------
# Amenity / policy extraction from description text
# ---------------------------------------------------------------------------

def _parse_pets(description: str, header: str = "") -> Optional[bool]:
    text = " ".join(filter(None, [description or "", header or ""])).lower()
    if re.search(r"\b(no pets|pets not allowed|no pet|not pet friendly|no dogs|no cats)\b", text):
        return False
    if re.search(r"\b(pets (?:are )?welcome|pets allowed|dogs allowed|cats allowed|small pets allowed|pets welcome|pet[- ]friendly)\b", text):
        return True
    return None


def _parse_parking(description: str) -> Optional[str]:
    text = (description or "").lower()
    m = re.search(r"(\d+)[- ]?car garage", text)
    if m:
        return "{} car garage".format(m.group(1))
    if "attached garage" in text:
        return "Attached garage"
    if "detached garage" in text:
        return "Detached garage"
    if "carport" in text:
        return "Carport"
    if "driveway" in text:
        return "Driveway"
    if "off-street parking" in text or "off street parking" in text:
        return "Off-street parking"
    return None


def _parse_laundry(description: str) -> Optional[str]:
    text = (description or "").lower()
    if "washer/dryer hookups" in text or "washer / dryer hookups" in text:
        return "Washer/dryer hookups"
    if "in-unit washer and dryer" in text or "in unit washer and dryer" in text:
        return "In-unit"
    if "washer and dryer included" in text or "washer & dryer included" in text:
        return "In-unit"
    if "stackable washer and dryer" in text:
        return "In-unit"
    if "laundry hookups" in text:
        return "Laundry hookups"
    if "coin operated laundry" in text or "on-site laundry" in text:
        return "Shared laundry"
    return None


def _parse_available_date(description: str, header: str = "") -> Optional[str]:
    """Extract availability date from description or header if present."""
    text = " ".join(filter(None, [description or "", header or ""]))
    # Patterns like "available August 15th, 2026", "available on September 15, 2026"
    m = re.search(
        r"available\s+(?:on\s+)?([A-Z][a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})",
        text,
        re.IGNORECASE,
    )
    if m:
        month = m.group(1)
        day = m.group(2)
        year = m.group(3)
        try:
            d = datetime.strptime("{} {} {}".format(month, day, year), "%B %d %Y")
            return d.strftime("%Y-%m-%d")
        except Exception:
            pass
    # "Available on 11/14/2026"
    m2 = re.search(r"available\s+(?:on\s+)?(\d{1,2})/(\d{1,2})/(\d{4})", text, re.IGNORECASE)
    if m2:
        try:
            d = datetime.strptime("{}-{}-{}".format(m2.group(3), m2.group(1), m2.group(2)), "%Y-%m-%d")
            return d.strftime("%Y-%m-%d")
        except Exception:
            pass
    return None


def _parse_move_in_special(description: str, header: str = "") -> Optional[str]:
    """Detect move-in specials (e.g. 'HALF OFF first full month')."""
    text = " ".join(filter(None, [description or "", header or ""]))
    patterns = [
        r"(half off[^.\n]{0,120})",
        r"(1/2 off[^.\n]{0,120})",
        r"(first month free[^.\n]{0,80})",
        r"(one month free[^.\n]{0,80})",
        r"(move[- ]in special[^.\n]{0,120})",
        r"(free first month[^.\n]{0,80})",
        r"(look and lease[^.\n]{0,120})",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            snippet = re.sub(r"\s+", " ", m.group(0)).strip()
            return snippet[:200]
    return None


def _parse_appliances(description: str) -> List[str]:
    text = (description or "").lower()
    appliances = set()
    for keyword, label in [
        ("dishwasher", "dishwasher"),
        ("refrigerator", "refrigerator"),
        ("microwave", "microwave"),
        ("stove", "stove"),
        ("range", "range"),
        ("oven", "oven"),
        ("washer", "washer"),
        ("dryer", "dryer"),
        ("garbage disposal", "garbage_disposal"),
    ]:
        if keyword in text:
            appliances.add(label)
    return sorted(appliances)


# ---------------------------------------------------------------------------
# Data quality scoring (mirrors pipeline conventions)
# ---------------------------------------------------------------------------

def _missing_fields(record: Dict[str, Any]) -> List[str]:
    return [f for f in _TRACKABLE_MISSING if record.get(f) in (None, "", "[]")]


def _data_quality_score(record: Dict[str, Any]) -> int:
    score = 0
    for field in _CORE_FIELDS:
        if record.get(field) not in (None, "", "[]"):
            score += 6
    for field in _BONUS_FIELDS:
        if record.get(field) not in (None, "", "[]"):
            score += 2
    photos = record.get("original_image_urls") or "[]"
    try:
        photo_list = json.loads(photos) if isinstance(photos, str) else list(photos)
    except Exception:
        photo_list = []
    score += 6 if len(photo_list) >= 5 else 3 if len(photo_list) >= 1 else 0
    return min(score, 100)


# ---------------------------------------------------------------------------
# Record builder
# ---------------------------------------------------------------------------

def _normalize_property_type(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    raw = str(raw).strip()
    return _PROPERTY_TYPE_MAP.get(raw) or raw.upper().replace("-", "_").replace(" ", "_")


def _build_record(
    unit_id: str,
    header: str,
    address: Dict[str, Optional[str]],
    details: Dict[str, Optional[Any]],
    description: str,
    image_urls: List[str],
    unit_url: str,
) -> Dict[str, Any]:
    """Build a standard pipeline_properties record from extracted fields."""
    typ = _normalize_property_type(details.get("type"))
    beds = details.get("beds")
    baths = details.get("baths")
    rent = details.get("rent")
    street = address.get("street")
    city = address.get("city")
    state = address.get("state")
    zip_code = address.get("zip")

    # Property type: skip commercial
    if typ and typ not in _ALLOWED_RENTAL_TYPES:
        typ = None

    # Availability
    available_date = _parse_available_date(description, header)
    if not available_date:
        # If "Tenant Occupied" or "currently occupied", not immediately available
        if re.search(r"tenant occupied", " ".join(filter(None, [description or "", header or ""])), re.IGNORECASE):
            pass  # keep as None — pipeline will treat as available
        else:
            available_date = date.today().isoformat()

    pets_allowed = _parse_pets(description, header)
    parking = _parse_parking(description)
    laundry = _parse_laundry(description)
    appliances = _parse_appliances(description)
    move_in_special = _parse_move_in_special(description, header)

    # Source URL
    source_url = "https://cjproperties.org/unit-detail?unitID={}".format(unit_id)
    if unit_url:
        source_url = "https://cjproperties.org" + unit_url if unit_url.startswith("/") else unit_url

    now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    rec = {
        "id": "PP-" + uuid.uuid4().hex[:8].upper(),
        "source": "cjproperties",
        "source_url": source_url,
        "source_listing_id": "cjproperties:" + str(unit_id),
        "status": "scraped",
        "title": header,
        "address": street,
        "unit_number": None,
        "city": city,
        "state": state,
        "zip": zip_code,
        "county": None,
        "neighborhood": None,
        "lat": None,
        "lng": None,
        "location_context": None,
        "property_type": typ,
        "bedrooms": beds,
        "bathrooms": baths if baths is not None else None,
        "half_bathrooms": 1 if baths is not None and baths != int(baths) else None,
        "total_bathrooms": baths,
        "square_footage": None,
        "lot_size_sqft": None,
        "year_built": None,
        "floors": None,
        "garage_spaces": None,
        "total_units": None,
        "has_basement": None,
        "has_central_air": None,
        "virtual_tour_url": None,
        "monthly_rent": rent,
        "security_deposit": None,
        "application_fee": None,
        "pet_deposit": None,
        "admin_fee": None,
        "move_in_special": move_in_special,
        "parking_fee": None,
        "hoa_fee": None,
        "tax_value": None,
        "description": description,
        "showing_instructions": None,
        "available_date": available_date,
        # Default standard lease — some listings mention 13 or 24 month leases
        "minimum_lease_months": 12,
        "lease_terms": "[]",
        "pets_allowed": pets_allowed,
        "pet_types_allowed": "[]",
        "pet_weight_limit": None,
        "pet_details": None,
        "smoking_allowed": None,
        "parking": parking,
        "amenities": "[]",
        "appliances": json.dumps(appliances),
        "utilities_included": "[]",
        "flooring": "[]",
        "heating_type": None,
        "cooling_type": None,
        "laundry_type": laundry,
        "original_image_urls": json.dumps(image_urls[:MAX_PHOTOS]),
        "local_image_paths": "[]",
        "agent_name": None,
        "broker_name": "CJ Real Estate, Inc.",
        "agent_image_url": None,
        "poster_landlord_id": None,
        "original_data": json.dumps({
            "_source": "cjproperties",
            "_imported_at": now,
            "unit_id": unit_id,
            "rent_manager_corpid": RM_CORP_ID,
            "photocount": len(image_urls),
            "source_detail_url": source_url,
            "_version": "v1",
        }, default=str),
        "edited_fields": "[]",
        "inferred_features": "[]",
        "data_quality_score": 0,
        "missing_fields": "[]",
        "published_at": None,
        "choice_property_id": None,
        "scraped_at": now,
        "updated_at": now,
    }

    rec["missing_fields"] = json.dumps(_missing_fields(rec))
    rec["data_quality_score"] = _data_quality_score(rec)
    return rec


# ---------------------------------------------------------------------------
# Main scrape function
# ---------------------------------------------------------------------------

def scrape_cjproperties(
    states: Optional[List[str]] = None,
    locations: Optional[str] = None,
    verbose: bool = False,
) -> List[Dict[str, Any]]:
    """Scrape all rental listings from cjproperties.org.

    Args:
        states: Optional list of state codes to filter ('MO','KS','FL').
        locations: Override the Rent Manager locations parameter.
        verbose: Print progress information.

    Returns:
        List of pipeline_properties records.
    """
    if not _REQUESTS_OK:
        raise RuntimeError("requests is not installed")

    session = _make_session()
    records: List[Dict[str, Any]] = []
    seen_unit_ids: set = set()
    loc_value = locations or RM_LOCATIONS_DEFAULT

    # Build the search URL with state filters if requested
    params = {
        "command": "search_result",
        "corpid": RM_CORP_ID,
        "locations": loc_value,
        "fromsearch": "fromsearch",
        "mode": "javaScript",
        "template": "searchresults",
        "unituserdef_Allow_on_websitene": "no",
        "maxperpage": "9999",
        "headerfooter": "false",
    }

    # The Rent Manager API does not support state filtering via statelk.
    # Fetch all listings and filter by state after parsing.
    if verbose:
        print("[cjproperties_scraper] Fetching all listings from Rent Manager API...")
        print("  URL: {}?command=search_result&corpid={}".format(RM_SEARCH_URL, RM_CORP_ID))
        print("  Locations: {}".format(loc_value))

    js_text = _fetch_with_retry(session, RM_SEARCH_URL, params=params, verbose=verbose)
    if js_text is None:
        if verbose:
            print("[cjproperties_scraper] ERROR: Failed to fetch search results")
        return records

    # Extract HTML content from the JS document.write
    html_content = _extract_html_from_js(js_text)

    if verbose:
        print("[cjproperties_scraper] Retrieved {} bytes of HTML".format(len(html_content)))

    # Parse property blocks
    blocks = _extract_property_blocks(html_content)

    if verbose:
        print("[cjproperties_scraper] Found {} property blocks".format(len(blocks)))

    for block in blocks:
        unit_id = block["unitid"]
        if unit_id in seen_unit_ids:
            continue
        seen_unit_ids.add(unit_id)

        block_html = block["html"]

        header = _extract_header(block_html)
        address = _extract_address(block_html)
        details = _extract_details(block_html)
        description = _extract_description(block_html)
        image_urls = _extract_image_urls(block_html)
        unit_url = _extract_unit_url(block_html)

        # Always try to fetch the detail page to get additional photos
        # (the rmwebsvc endpoint often contains the full gallery)
        detail_html = _fetch_detail_html(session, unit_id, unit_url, verbose=verbose)
        if detail_html:
            detail_images = _extract_image_urls_from_detail_html(detail_html)
            if detail_images:
                # Merge detail images with search images, avoiding duplicates
                seen = set(image_urls)
                for url in detail_images:
                    if url not in seen:
                        image_urls.append(url)
                        seen.add(url)
                if verbose and len(detail_images) > 1:
                    print("  [{}] detail gallery added {} photo(s)".format(unit_id, len(detail_images)))

        # State filter (post-parse)
        if states and address.get("state") and address.get("state") not in states:
            if verbose:
                print("  [{}] SKIP (state {})".format(unit_id, address.get("state")))
            continue

        if verbose:
            addr_str = "{} {}".format(address.get("street") or "?", address.get("city") or "?").strip()
            # Sanitize for console output (emoji can crash cp1252 terminals)
            safe_addr = addr_str.encode("ascii", "replace").decode("ascii")
            print("  [{}] {} | ${}/mo | {} bed | {} photos".format(
                unit_id,
                safe_addr,
                details.get("rent"),
                details.get("beds"),
                len(image_urls),
            ))

        rec = _build_record(
            unit_id=unit_id,
            header=header,
            address=address,
            details=details,
            description=description,
            image_urls=image_urls,
            unit_url=unit_url,
        )
        if rec:
            records.append(rec)

        # Respect rate limiting
        time.sleep(REQUEST_DELAY)

    if verbose:
        valid = [r for r in records if r.get("data_quality_score", 0) >= 20]
        print("[cjproperties_scraper] Done. {} total records, {} with quality >= 20".format(
            len(records), len(valid)))

    return records


# ---------------------------------------------------------------------------
# Feature detection helpers for batch scripts
# ---------------------------------------------------------------------------

def estimate_rent_range(records: List[Dict[str, Any]]) -> Tuple[Optional[int], Optional[int]]:
    """Compute min/max rent across scraped records."""
    rents = [r.get("monthly_rent") for r in records if r.get("monthly_rent")]
    if not rents:
        return None, None
    return min(rents), max(rents)


def list_states(records: List[Dict[str, Any]]) -> List[str]:
    """Return sorted unique states from scraped records."""
    states = {r.get("state") for r in records if r.get("state")}
    return sorted(states)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="CJ Properties (cjproperties.org) scraper probe")
    ap.add_argument("--states", help="Comma-separated state codes e.g. MO,KS,FL")
    ap.add_argument("--limit", type=int, default=200, help="Max records to print")
    ap.add_argument("--json", action="store_true", help="Output JSON")
    args = ap.parse_args()

    states = [s.strip().upper() for s in args.states.split(",")] if args.states else None

    results = scrape_cjproperties(states=states, verbose=True)

    print("\n" + "=" * 70)
    print("CJ PROPERTIES SCRAPER PROBE")
    print("=" * 70)
    print("Total records scraped: {}".format(len(results)))

    if results:
        states_found = list_states(results)
        rent_min, rent_max = estimate_rent_range(results)
        print("States: {}".format(", ".join(states_found) if states_found else "N/A"))
        print("Rent range: ${} – ${}".format(rent_min, rent_max))
        print()
        for i, rec in enumerate(results[: args.limit], 1):
            print("  {:3}. {} | ${}/mo | {} bed | score={} | {} photos".format(
                i,
                "{}, {}".format(rec.get("address"), rec.get("city")).strip(),
                rec.get("monthly_rent"),
                rec.get("bedrooms"),
                rec.get("data_quality_score"),
                len(json.loads(rec.get("original_image_urls") or "[]")),
            ))

    if args.json:
        print("\n" + json.dumps(results, indent=2, default=str))