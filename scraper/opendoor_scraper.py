#!/usr/bin/env python3
"""
Choice Properties — Opendoor URL import and sale-to-rent conversion.
===============================================================

This module converts an Opendoor sale listing into a rental candidate
pipeline record. It is intentionally opt-in: Opendoor URLs are only scraped
when the caller enables `--allow-opendoor` or another explicit authorization
mechanism.

Opendoor listings are treated as conversion candidates, not automatic rentals.
The conversion flow preserves the original sale price and images, estimates a
rental price, and reuses the existing pipeline publishing rules.
"""

import json
import os
import re
import uuid
import time
from datetime import date, datetime, timezone
from urllib.parse import urlparse

try:
    from curl_cffi import requests as _req
    _CURL_CFFI_OK = True
except ImportError:
    try:
        import requests as _req
        _CURL_CFFI_OK = False
    except ImportError as _e:
        raise ImportError("requests or curl_cffi is required for opendoor_scraper: {}".format(_e))

_OPENDOOR_URL_RE = re.compile(r"^https?://(?:www\.)?opendoor\.com/.*", re.IGNORECASE)

_PROPERTY_TYPE_MAP = {
    "House": "SINGLE_FAMILY",
    "SingleFamilyResidence": "SINGLE_FAMILY",
    "SingleFamily": "SINGLE_FAMILY",
    "Townhouse": "TOWNHOMES",
    "Townhome": "TOWNHOMES",
    "Condo": "CONDOS",
    "Condominium": "CONDOS",
    "Apartment": "APARTMENT",
    "ApartmentBuilding": "APARTMENT",
    "MultiFamily": "MULTI_FAMILY",
    "ManufacturedHome": "MOBILE",
    "MobileHome": "MOBILE",
}

_OPENDOOR_RENT_MULTIPLIER = float(os.environ.get("OPENDOOR_RENT_MULTIPLIER", "0.0085"))
_OPENDOOR_RENT_MIN = int(os.environ.get("OPENDOOR_RENT_MIN", "700"))
_OPENDOOR_RENT_METHOD = os.environ.get("OPENDOOR_RENT_METHOD", "opendoor_rent_estimate")
_OPENDOOR_RENT_ROUND = int(os.environ.get("OPENDOOR_RENT_ROUND", "25"))

# True when the operator explicitly set OPENDOOR_RENT_MULTIPLIER in the
# environment.  When True the explicit value takes precedence over the
# per-state table so a bulk-run override (e.g. for a new market) always wins.
_OPENDOOR_RENT_MULTIPLIER_EXPLICIT = "OPENDOOR_RENT_MULTIPLIER" in os.environ

# ── State-level rent multiplier overrides ─────────────────────────────────────
# The gross rent multiplier (monthly rent / sale price) varies by market.
# High cost-of-living states have inflated home values relative to rent
# → lower multiplier.  Affordable Midwest/South markets have lower sale prices
# but rents are not proportionally lower → higher multiplier.
# These are median estimates; override per-run with OPENDOOR_RENT_MULTIPLIER.
_STATE_RENT_MULTIPLIERS = {
    # High cost-of-living (price/rent ratio ~150-200x)
    "HI": 0.0058,
    "CA": 0.0063,
    "MA": 0.0066,
    "NY": 0.0066,
    "NJ": 0.0067,
    "CT": 0.0067,
    "WA": 0.0069,
    "OR": 0.0070,
    "CO": 0.0072,
    "MD": 0.0072,
    "VA": 0.0074,
    "IL": 0.0076,
    # Mid-cost markets (price/rent ratio ~120-150x) → default 0.0085 applies
    # Affordable/Midwest/South (price/rent ratio ~100-120x)
    "MO": 0.0090,
    "TN": 0.0090,
    "LA": 0.0090,
    "NC": 0.0090,
    "SC": 0.0090,
    "GA": 0.0090,
    "AL": 0.0092,
    "AR": 0.0092,
    "KY": 0.0092,
    "NE": 0.0092,
    "IA": 0.0094,
    "IN": 0.0094,
    "MI": 0.0094,
    "OH": 0.0095,
    "KS": 0.0095,
    "OK": 0.0095,
    "MS": 0.0095,
    "WV": 0.0096,
}

_TRACKABLE_MISSING = [
    "lat", "lng", "county", "neighborhood", "year_built", "square_footage",
    "parking", "pets_allowed", "security_deposit", "amenities", "appliances",
    "available_date", "heating_type", "cooling_type", "laundry_type",
]

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

# ── HTTP fetch headers ────────────────────────────────────────────────────────
_FETCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.google.com/",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
    "Upgrade-Insecure-Requests": "1",
    "Connection": "keep-alive",
}

_FETCH_TIMEOUT = int(os.environ.get("OPENDOOR_FETCH_TIMEOUT", "25"))
_FETCH_RETRIES = int(os.environ.get("OPENDOOR_FETCH_RETRIES", "3"))
_FETCH_RETRY_DELAY = float(os.environ.get("OPENDOOR_FETCH_RETRY_DELAY", "2.0"))


def is_opendoor_url(url: str) -> bool:
    return bool(_OPENDOOR_URL_RE.match(str(url or "")))


def _parse_price(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value)
    match = re.search(r"[\d,]+(?:\.\d+)?", text)
    if not match:
        return None
    try:
        return int(float(match.group(0).replace(",", "")))
    except Exception:
        return None


def estimate_rent_from_sale_price(sale_price, state=None):
    """
    Estimate monthly rent from a sale price using a state-aware multiplier.

    The gross rent multiplier varies significantly by market:
      - High cost-of-living states (CA, NY, HI, MA) have inflated prices
        relative to rents, so the multiplier is lower.
      - Affordable Midwest/South markets (OH, OK, MI) have relatively
        higher rent-to-price ratios, so the multiplier is higher.

    The result is rounded to the nearest _OPENDOOR_RENT_ROUND dollars
    (default $25) so the published rent looks human-set rather than
    machine-generated (e.g. $2,300 instead of $2,295).

    Override the default multiplier entirely via OPENDOOR_RENT_MULTIPLIER
    env var; override the rounding increment via OPENDOOR_RENT_ROUND.
    """
    price = _parse_price(sale_price)
    if price is None or price <= 0:
        return None
    # Explicit OPENDOOR_RENT_MULTIPLIER env var always wins — lets operators
    # override the state table for a specific bulk run without editing code.
    # When the env var is absent, fall back to the per-state table, then to
    # the compiled-in default (0.0085).
    if _OPENDOOR_RENT_MULTIPLIER_EXPLICIT:
        multiplier = _OPENDOOR_RENT_MULTIPLIER
    else:
        multiplier = _STATE_RENT_MULTIPLIERS.get(
            (state or "").strip().upper(), _OPENDOOR_RENT_MULTIPLIER
        )
    raw_rent = price * multiplier
    # Round to nearest increment (default $25) for human-looking prices
    step = max(1, _OPENDOOR_RENT_ROUND)
    rent = int(round(raw_rent / step) * step)
    if rent < _OPENDOOR_RENT_MIN:
        rent = _OPENDOOR_RENT_MIN
    return rent


def _normalize_image_urls(values, max_count=50):
    """Deduplicate and validate a list of image URL strings."""
    urls = []
    seen = set()
    if isinstance(values, str):
        try:
            values = json.loads(values)
        except Exception:
            values = [values]
    if not isinstance(values, (list, tuple)):
        return []
    for item in values:
        if not item:
            continue
        url = str(item).strip()
        # Normalise: strip query params for dedup key only, keep original URL
        dedup_key = url.split("?")[0].lower()
        if url and url.startswith("http") and dedup_key not in seen:
            urls.append(url)
            seen.add(dedup_key)
        if len(urls) >= max_count:
            break
    return urls


def _upgrade_image_url(url):
    """
    Try to swap known thumbnail/small size tokens in an OpenDoor CDN URL
    for a full-resolution variant.
    OpenDoor CDN URLs often contain /w_NNN/ or ?width=NNN or _small/_medium suffixes.
    """
    if not url:
        return url
    # Remove width-limiting query params that Cloudinary-style CDNs support
    url = re.sub(r"[?&]w=\d+", "", url)
    url = re.sub(r"[?&]width=\d+", "", url)
    url = re.sub(r"[?&]h=\d+", "", url)
    url = re.sub(r"[?&]height=\d+", "", url)
    # Cloudinary /upload/w_NNN,h_NNN/ → /upload/
    url = re.sub(r"/upload/[^/]*?(?:w_\d+|h_\d+|c_\w+)[^/]*/", "/upload/", url)
    # _small / _medium / _thumbnail suffixes before extension
    url = re.sub(r"_(small|medium|thumb|thumbnail|sm|md)\.", ".", url, flags=re.IGNORECASE)
    return url.rstrip("?&")


def _choose_jsonld_object(obj):
    if isinstance(obj, list):
        candidates = []
        for item in obj:
            if isinstance(item, dict):
                typ = item.get("@type") or item.get("type")
                if isinstance(typ, list):
                    typ = typ[0]
                candidates.append((str(typ or ""), item))
        if not candidates:
            return None
        for typ, item in candidates:
            if typ in ("SingleFamilyResidence", "House", "Apartment", "Condo",
                       "Townhouse", "Residence", "RealEstateListing"):
                return item
        return candidates[0][1]
    if isinstance(obj, dict):
        return obj
    return None


def _extract_jsonld(html):
    pattern = re.compile(
        r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
        re.DOTALL | re.IGNORECASE,
    )
    for match in pattern.finditer(html):
        text = match.group(1).strip()
        if not text:
            continue
        try:
            data = json.loads(text)
        except Exception:
            continue
        record = _choose_jsonld_object(data)
        if record:
            return record
    return None


def _extract_nextdata(html):
    """
    Extract the full __NEXT_DATA__ JSON blob from the page.
    OpenDoor is a Next.js app — this is the richest data source for photos,
    year_built, neighborhood, virtual tour, coordinates, and more.
    """
    m = re.search(
        r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>',
        html,
        re.DOTALL | re.IGNORECASE,
    )
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:
        return None


def _walk(obj, *keys):
    """Safely traverse a nested dict/list by key path; return None on any miss."""
    node = obj
    for key in keys:
        if node is None:
            return None
        if isinstance(node, dict):
            node = node.get(key)
        elif isinstance(node, list) and isinstance(key, int):
            try:
                node = node[key]
            except IndexError:
                return None
        else:
            return None
    return node


def _find_listing_in_nextdata(nd):
    """
    Try a ranked list of known __NEXT_DATA__ paths that OpenDoor has used
    across different versions of their Next.js app.
    Returns the first dict that looks like a listing.
    """
    if not nd:
        return None

    candidates = [
        # Standard pageProps paths
        _walk(nd, "props", "pageProps", "listing"),
        _walk(nd, "props", "pageProps", "property"),
        _walk(nd, "props", "pageProps", "home"),
        _walk(nd, "props", "pageProps", "initialData", "listing"),
        _walk(nd, "props", "pageProps", "initialData", "property"),
        _walk(nd, "props", "pageProps", "pageData", "listing"),
        _walk(nd, "props", "pageProps", "pageData", "property"),
    ]

    # React Query / TanStack dehydrated state
    dehydrated = _walk(nd, "props", "pageProps", "dehydratedState", "queries")
    if isinstance(dehydrated, list):
        for q in dehydrated:
            data = _walk(q, "state", "data")
            if isinstance(data, dict) and (
                data.get("address") or data.get("listingId") or data.get("id")
            ):
                candidates.append(data)
            # Sometimes wrapped one level deeper
            inner = _walk(data, "listing") or _walk(data, "property")
            if isinstance(inner, dict) and (inner.get("address") or inner.get("id")):
                candidates.append(inner)

    _LISTING_SIGNALS = (
        "address", "id", "listingId", "price", "photos", "images",
        "bedrooms", "beds", "yearBuilt", "year_built", "squareFeet",
        "squareFootage", "sqft", "latitude", "lat",
    )
    for c in candidates:
        if isinstance(c, dict) and any(c.get(k) for k in _LISTING_SIGNALS):
            return c
    return None


def _collect_nextdata_photos(nd_listing):
    """
    Extract all photo URLs from an OpenDoor __NEXT_DATA__ listing object.
    Tries multiple known field shapes and picks the highest-res variant.
    """
    if not isinstance(nd_listing, dict):
        return []
    photos = []
    seen = set()

    def add(url):
        if not url:
            return
        url = str(url).strip()
        if not url.startswith("http"):
            return
        key = url.split("?")[0].lower()
        if key not in seen:
            photos.append(_upgrade_image_url(url))
            seen.add(key)

    def best_from_sizes(sizes_dict):
        """Pick the largest variant from a sizes/srcset dict."""
        if not isinstance(sizes_dict, dict):
            return None
        for key in ("original", "full", "large", "xlarge", "x_large", "medium"):
            v = sizes_dict.get(key)
            if v and isinstance(v, str) and v.startswith("http"):
                return v
        # Fall back to any string value
        for v in sizes_dict.values():
            if v and isinstance(v, str) and v.startswith("http"):
                return v
        return None

    for field in ("photos", "images", "media", "gallery", "propertyPhotos", "listingPhotos"):
        items = nd_listing.get(field)
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, str):
                add(item)
            elif isinstance(item, dict):
                # Try common URL field names
                url = (
                    item.get("url") or item.get("src") or item.get("href")
                    or item.get("imageUrl") or item.get("photoUrl")
                )
                # Try sizes dict for higher-res variant
                sizes = item.get("sizes") or item.get("variants") or item.get("srcset")
                best = best_from_sizes(sizes)
                add(best or url)

    return photos[:50]


def _normalize_property_type(raw):
    if not raw:
        return None
    if isinstance(raw, list):
        raw = raw[0]
    raw = str(raw).strip()
    if not raw:
        return None
    return _PROPERTY_TYPE_MAP.get(raw) or raw.upper().replace("-", "_").replace(" ", "_")


def _parse_boolean(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in ("yes", "true", "allowed", "allowed."):
        return True
    if text in ("no", "false", "not allowed", "not allowed."):
        return False
    return None


def _normalize_tag(item):
    if not item:
        return None
    return str(item).strip()


def _normalize_amenity_tags(tags):
    items = []
    seen = set()
    for item in tags or []:
        norm = _normalize_tag(item)
        if not norm:
            continue
        lowered = norm.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        items.append(norm)
    return items


_APPLIANCE_KEYWORDS = [
    "dishwasher", "microwave", "refrigerator", "range", "oven", "stove",
    "washer", "dryer", "garbage disposal", "disposal", "cooktop",
    "freezer", "cooktop", "vent hood",
]


def _parse_appliances(jsonld, description):
    appliances = set()
    for raw in (jsonld.get("amenityFeature") or []):
        if isinstance(raw, dict) and raw.get("name"):
            name = str(raw.get("name") or "").lower()
            for keyword in _APPLIANCE_KEYWORDS:
                if keyword in name:
                    appliances.add(keyword.replace(" ", "_"))
    for keyword in _APPLIANCE_KEYWORDS:
        if keyword in (description or "").lower():
            appliances.add(keyword.replace(" ", "_"))
    return sorted(appliances)


def _parse_pets(jsonld, description):
    pets = None
    if isinstance(jsonld.get("petsAllowed"), bool):
        pets = jsonld.get("petsAllowed")
    for raw in (jsonld.get("amenityFeature") or []):
        if isinstance(raw, dict) and raw.get("name"):
            name = str(raw.get("name") or "").lower()
            if "pet" in name or "dog" in name or "cat" in name:
                if any(w in name for w in ("allowed", "welcome", "friendly", "permitted")):
                    return True
                if any(w in name for w in ("no pets", "not allowed", "pets not")):
                    return False
    text = (description or "").lower()
    if re.search(r"\b(no pets|pets not allowed|not pet friendly)\b", text):
        return False
    if re.search(r"\b(pet[- ]friendly|pets allowed|dogs allowed|cats allowed|small pets allowed)\b", text):
        return True
    return pets


def _parse_parking(jsonld, description):
    garage = None
    if isinstance(jsonld.get("numberOfGarageSpaces"), (int, float)):
        garage = int(jsonld.get("numberOfGarageSpaces"))
    if garage is None:
        for raw in (jsonld.get("amenityFeature") or []):
            if isinstance(raw, dict) and raw.get("name"):
                name = str(raw.get("name") or "").lower()
                m = re.search(r"(\d+)[- ]?car garage", name)
                if m:
                    garage = int(m.group(1))
                    break
                if "garage" in name and "attached" in name:
                    garage = 1
                    break
    if garage:
        return str(garage) + "-car garage"
    text = (description or "").lower()
    if "attached garage" in text:
        return "Attached garage"
    if "detached garage" in text:
        return "Detached garage"
    if "garage" in text:
        return "Garage"
    if "carport" in text:
        return "Carport"
    if "driveway" in text or "off-street parking" in text:
        return "Driveway"
    return None


def _parse_hvac(jsonld, description):
    heating = None
    cooling = None
    if isinstance(jsonld.get("heating"), str):
        heating = str(jsonld.get("heating")).strip()
    if isinstance(jsonld.get("cooling"), str):
        cooling = str(jsonld.get("cooling")).strip()
    combined = []
    for raw in (jsonld.get("amenityFeature") or []):
        if isinstance(raw, dict) and raw.get("name"):
            combined.append(str(raw.get("name")).lower())
    text = (description or "").lower()
    if not heating and re.search(r"\b(heat pump|forced air|electric heat|natural gas|baseboard|radiant)\b", text):
        heating = re.search(r"\b(heat pump|forced air|electric heat|natural gas|baseboard|radiant)\b", text).group(1).title()
    if not cooling and re.search(r"\b(central air|window a/c|window ac|mini[- ]split|ductless|swamp cool|evaporative)\b", text):
        cooling = re.search(r"\b(central air|window a/c|window ac|mini[- ]split|ductless|swamp cool|evaporative)\b", text).group(1).title()
    for item in combined:
        if not heating and any(k in item for k in ("heat pump", "forced air", "electric heat", "natural gas", "baseboard", "radiant")):
            heating = item.title()
        if not cooling and any(k in item for k in ("central air", "window a/c", "window ac", "mini-split", "ductless", "evaporative")):
            cooling = item.title()
    if heating and heating == cooling:
        cooling = None
    return heating, cooling


def _parse_laundry(jsonld, description):
    text = (description or "").lower()
    for keyword, label in [
        (r"in[- ]unit laundry", "In-unit"),
        (r"washer[/ ]?dryer in unit", "In-unit"),
        (r"washer[/ ]?dryer included", "In-unit"),
        (r"laundry hookups", "Washer/dryer hookups"),
        (r"washer[/ ]?dryer hookups", "Washer/dryer hookups"),
        (r"shared laundry", "Shared laundry"),
        (r"laundry on[- ]site", "Shared laundry"),
        (r"coin[- ]operated laundry", "Shared laundry"),
    ]:
        if re.search(keyword, text):
            return label
    for raw in (jsonld.get("amenityFeature") or []):
        if isinstance(raw, dict) and raw.get("name"):
            name = str(raw.get("name") or "").lower()
            if "in-unit laundry" in name or "in unit laundry" in name or "washer/dryer" in name:
                return "In-unit"
            if "laundry hookup" in name:
                return "Washer/dryer hookups"
            if "shared laundry" in name or "community laundry" in name:
                return "Shared laundry"
    return None


def _parse_available_date(jsonld, html):
    raw = None
    if isinstance(jsonld.get("offers"), dict):
        raw = jsonld["offers"].get("validFrom") or jsonld["offers"].get("availabilityStarts")
    if isinstance(raw, str) and raw:
        for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ"):
            try:
                return datetime.strptime(raw[:len(fmt)], fmt).strftime("%Y-%m-%d")
            except Exception:
                continue
    if html:
        text = re.sub(r"<[^>]+>", " ", html)
        text = re.sub(r"\s+", " ", text)
        m = re.search(
            r"available\s+(?:now|immediately|from\s+([A-Z][a-z]+ \d{1,2},? \d{4}))",
            text,
            re.IGNORECASE,
        )
        if m:
            if m.group(1):
                try:
                    return datetime.strptime(m.group(1), "%B %d, %Y").strftime("%Y-%m-%d")
                except Exception:
                    return m.group(1).strip()
            return date.today().isoformat()
    return None


_MOVE_IN_SPECIAL_PATTERNS = [
    r"first month free",
    r"one month free",
    r"free first month",
    r"move[- ]in special[:]?",
    r"special pricing.*rent",
]


def _parse_move_in_special(html, description):
    text = " ".join(filter(None, [description, html or ""]))
    text = text.lower()
    for pat in _MOVE_IN_SPECIAL_PATTERNS:
        m = re.search(pat, text)
        if m:
            snippet = text[m.start():m.end() + 120]
            snippet = re.sub(r"\s+", " ", snippet).strip()
            return snippet[:200]
    return None


_SALE_LANGUAGE_RE = re.compile(
    r"\b(for sale|sale listing|sale price|asking price|new construction|original list price|open house|selling for|list price|MLS[#:\s]+\w+)\b",
    re.IGNORECASE,
)


def _clean_sale_description(text, monthly_rent):
    if not text:
        return text
    result = _SALE_LANGUAGE_RE.sub("", text)
    if monthly_rent:
        result = re.sub(r"\$[\d,]+(?:\.\d{2})?", "${:,.0f}".format(monthly_rent), result)
    result = re.sub(r"\s+", " ", result).strip()
    result = result.replace(". .", ".")
    return result


def _missing_fields(record):
    missing = []
    for field in _TRACKABLE_MISSING:
        value = record.get(field)
        if value in (None, "", "[]"):
            missing.append(field)
    return missing


def _data_quality_score(record):
    score = 0
    for field in _CORE_FIELDS:
        if record.get(field) not in (None, "", "[]"):
            score += 6
    for field in _BONUS_FIELDS:
        if record.get(field) not in (None, "", "[]"):
            score += 2
    photos = record.get("original_image_urls") or []
    if isinstance(photos, str):
        try:
            photos = json.loads(photos)
        except Exception:
            photos = []
    if isinstance(photos, list):
        score += 6 if len(photos) >= 5 else 3 if len(photos) >= 1 else 0
    return min(score, 100)


def _format_source_id(url, jsonld):
    if isinstance(jsonld, dict):
        source_id = jsonld.get("@id") or jsonld.get("identifier") or jsonld.get("url")
        if source_id:
            source_id = str(source_id).strip()
            if source_id:
                return source_id
    parsed = urlparse(url)
    path = parsed.path.strip("/")
    if not path:
        return url
    return "opendoor:" + path.replace("/", "-")


def _build_address_fields(address_block):
    if not isinstance(address_block, dict):
        return None, None, None, None
    return (
        address_block.get("streetAddress") or address_block.get("address") or address_block.get("name"),
        address_block.get("addressLocality") or address_block.get("city"),
        address_block.get("addressRegion") or address_block.get("state"),
        address_block.get("postalCode") or address_block.get("zip"),
    )


def _parse_amenities(jsonld):
    amenities = []
    if not isinstance(jsonld, dict):
        return amenities
    if isinstance(jsonld.get("amenityFeature"), list):
        for item in jsonld["amenityFeature"]:
            if isinstance(item, dict) and item.get("name"):
                amenities.append(str(item.get("name")).strip())
    if isinstance(jsonld.get("keywords"), str):
        amenities.extend([kw.strip() for kw in jsonld["keywords"].split(",") if kw.strip()])
    return amenities


def _safe_int(value):
    """Parse a numeric-like value to int, handling ints, floats, and strings like '3.0'."""
    if value is None:
        return None
    try:
        f = float(str(value).strip())
        if f > 0:
            return int(f)
    except (ValueError, TypeError):
        pass
    return None


def _safe_float(value):
    """Parse a numeric-like value to float."""
    if value is None:
        return None
    try:
        f = float(str(value).strip())
        return f if f > 0 else None
    except (ValueError, TypeError):
        return None


def _parse_lot_size(jsonld):
    """Extract lot size in sqft from JSON-LD lotSize field."""
    raw = jsonld.get("lotSize") or jsonld.get("lotSizeArea")
    if not raw:
        return None
    if isinstance(raw, dict):
        val = raw.get("value")
        unit = str(raw.get("unitCode") or raw.get("unitText") or "").lower()
        n = _safe_float(val)
        if n is None:
            return None
        # Convert acres to sqft if needed
        if "acre" in unit:
            return int(round(n * 43560))
        return int(n)
    return _safe_int(raw)


def _parse_year_built(jsonld, nd_listing):
    """Try JSON-LD then __NEXT_DATA__ listing object for yearBuilt."""
    # JSON-LD sometimes has yearBuilt
    raw = jsonld.get("yearBuilt") or jsonld.get("dateCreated")
    if raw:
        yr = _safe_int(str(raw)[:4])
        if yr and 1800 < yr <= datetime.utcnow().year + 1:
            return yr

    # __NEXT_DATA__ listing object
    if isinstance(nd_listing, dict):
        for key in ("yearBuilt", "year_built", "builtYear", "constructionYear"):
            raw = nd_listing.get(key)
            if raw:
                yr = _safe_int(str(raw)[:4])
                if yr and 1800 < yr <= datetime.utcnow().year + 1:
                    return yr
    return None


def _parse_neighborhood(jsonld, nd_listing):
    """Extract neighborhood / subdivision name."""
    if isinstance(nd_listing, dict):
        for key in ("neighborhood", "neighborhoodName", "subdivision", "community"):
            v = nd_listing.get(key)
            if v and isinstance(v, str):
                return v.strip()
        # Nested location object
        loc = nd_listing.get("location") or nd_listing.get("address") or {}
        if isinstance(loc, dict):
            for key in ("neighborhood", "neighborhoodName", "subdivision"):
                v = loc.get(key)
                if v and isinstance(v, str):
                    return v.strip()
    if isinstance(jsonld, dict):
        for key in ("containedInPlace", "neighborhood"):
            v = jsonld.get(key)
            if isinstance(v, dict):
                return v.get("name") or v.get("alternateName")
            if isinstance(v, str):
                return v.strip()
    return None


def _parse_walk_scores(nd_listing):
    """
    Extract walk / transit / bike scores from an Opendoor __NEXT_DATA__
    listing object.  Returns (walk_score, transit_score, bike_score) with
    each element being an int 0-100 or None.

    Opendoor sometimes embeds Walk Score data directly in the listing
    object or in a nested ``scores`` / ``walkScores`` sub-object.
    """
    if not isinstance(nd_listing, dict):
        return None, None, None

    def _extract_score(obj, *keys):
        for key in keys:
            v = obj.get(key)
            if isinstance(v, (int, float)) and 0 <= v <= 100:
                return int(v)
            if isinstance(v, dict):
                inner = v.get("score") or v.get("value") or v.get("walkScore")
                if isinstance(inner, (int, float)) and 0 <= inner <= 100:
                    return int(inner)
        return None

    walk    = _extract_score(nd_listing, "walkScore",    "walk_score",    "walkability")
    transit = _extract_score(nd_listing, "transitScore", "transit_score")
    bike    = _extract_score(nd_listing, "bikeScore",    "bike_score")

    # Nested scores object (e.g. {"scores": {"walk": 72, "transit": 45}})
    for scores_key in ("scores", "walkScores", "transportationScores"):
        sub = nd_listing.get(scores_key)
        if isinstance(sub, dict):
            if walk    is None:
                walk    = _extract_score(sub, "walkScore", "walk")
            if transit is None:
                transit = _extract_score(sub, "transitScore", "transit")
            if bike    is None:
                bike    = _extract_score(sub, "bikeScore", "bike")

    return walk, transit, bike


def _parse_virtual_tour(jsonld, nd_listing):
    """Extract virtual tour URL from JSON-LD or __NEXT_DATA__."""
    if isinstance(jsonld, dict):
        vt = jsonld.get("virtualTourUrl") or jsonld.get("virtualTour")
        if vt and isinstance(vt, str):
            return vt.strip()
    if isinstance(nd_listing, dict):
        for key in ("virtualTourUrl", "virtualTour", "tourUrl", "threeDTourUrl", "matterportUrl"):
            v = nd_listing.get(key)
            if v and isinstance(v, str):
                return v.strip()
    return None


def _parse_has_basement(jsonld, description):
    """Detect basement presence from amenityFeature or description."""
    for raw in (jsonld.get("amenityFeature") or []):
        if isinstance(raw, dict):
            name = str(raw.get("name") or "").lower()
            if "basement" in name:
                return True
    text = (description or "").lower()
    if re.search(r"\bbasement\b", text):
        return True
    return None


def _parse_has_central_air(jsonld, description, cooling):
    """Detect central AC from JSON-LD, description, or extracted cooling type."""
    if cooling and "central" in cooling.lower():
        return True
    for raw in (jsonld.get("amenityFeature") or []):
        if isinstance(raw, dict):
            name = str(raw.get("name") or "").lower()
            if "central air" in name or "central a/c" in name or "central ac" in name:
                return True
    text = (description or "").lower()
    if re.search(r"\bcentral air\b|\bcentral a/?c\b", text):
        return True
    return None


def _build_rental_description(rec, scraped_text=None):
    """
    Build a rich, natural-prose rental description from the structured fields
    on an Opendoor-converted record.

    If ``scraped_text`` is provided and is long enough (>= 200 chars) it is
    used as the opening paragraph; the generated content is appended as an
    additional "Features at a glance" paragraph so nothing is lost.

    If ``scraped_text`` is absent or short (<200 chars), the generated text
    is the entire description (with the scraped text prepended if it exists).
    """

    # ── helpers ──────────────────────────────────────────────────────────────
    def _fmt_type(t):
        return (t or "home").replace("_", " ").replace("SINGLE FAMILY", "single-family home").title()

    def _beds_label(n):
        if n is None:
            return None
        if n == 0:
            return "studio"
        return "{}-bedroom".format(int(n))

    def _baths_label(full, half):
        if full is None:
            return None
        label = "{} bath{}".format(int(full), "s" if full != 1 else "")
        if half:
            label += " + half bath"
        return label

    def _money(n):
        return "${:,.0f}".format(n) if n else None

    beds   = rec.get("bedrooms")
    baths  = rec.get("bathrooms")
    half   = rec.get("half_bathrooms")
    sqft   = rec.get("square_footage")
    yr     = rec.get("year_built")
    city   = rec.get("city") or ""
    state  = rec.get("state") or ""
    hood   = rec.get("neighborhood")
    ptype  = rec.get("property_type")
    rent   = rec.get("monthly_rent")
    lot    = rec.get("lot_size_sqft")
    heat   = rec.get("heating_type")
    cool   = rec.get("cooling_type")
    laundry = rec.get("laundry_type")
    parking = rec.get("parking")
    pets    = rec.get("pets_allowed")
    avail   = rec.get("available_date")
    basement = rec.get("has_basement")
    central_air = rec.get("has_central_air")
    vtour   = rec.get("virtual_tour_url")

    try:
        appliances = json.loads(rec.get("appliances") or "[]")
    except Exception:
        appliances = []
    try:
        amenities = json.loads(rec.get("amenities") or "[]")
    except Exception:
        amenities = []

    paragraphs = []

    # ── Paragraph 1: opening / overview ──────────────────────────────────────
    if scraped_text and len(scraped_text.strip()) >= 200:
        # Keep the original; we'll append features below
        paragraphs.append(scraped_text.strip())
    else:
        # Compose an opening sentence
        location_parts = []
        if hood:
            location_parts.append("the {} neighborhood".format(hood))
        if city and state:
            location_parts.append("{}, {}".format(city, state))
        elif city:
            location_parts.append(city)
        location_str = " in " + " of ".join(location_parts) if location_parts else ""

        type_label = _fmt_type(ptype)
        beds_str   = _beds_label(beds)
        baths_str  = _baths_label(baths, half)

        opening_parts = []
        if beds_str and baths_str:
            opening_parts.append("This {}, {} {}{}".format(
                beds_str, baths_str, type_label, location_str
            ))
        elif beds_str:
            opening_parts.append("This {} {}{}".format(beds_str, type_label, location_str))
        else:
            opening_parts.append("This {}{}".format(type_label, location_str))

        detail_parts = []
        if yr:
            detail_parts.append("built in {}".format(yr))
        if sqft:
            detail_parts.append("offering {:,} sq ft of living space".format(sqft))
        if lot:
            if lot >= 43560:
                detail_parts.append("on a {:.2f}-acre lot".format(lot / 43560))
            else:
                detail_parts.append("on a {:,} sq ft lot".format(lot))

        sentence = opening_parts[0]
        if detail_parts:
            sentence += ", " + ", ".join(detail_parts)
        sentence += " is now available for rent"
        if rent:
            sentence += " at {}/month".format(_money(rent))
        sentence += "."

        # Include short scraped text as a second sentence if present
        if scraped_text and scraped_text.strip():
            paragraphs.append(sentence + " " + scraped_text.strip())
        else:
            paragraphs.append(sentence)

    # ── Paragraph 2: interior features ────────────────────────────────────────
    interior = []

    # HVAC
    if heat and cool:
        if heat.lower() == cool.lower():
            interior.append("{} heating and cooling".format(heat))
        else:
            interior.append("{} heating".format(heat))
            interior.append("{} cooling".format(cool))
    elif heat:
        interior.append("{} heating".format(heat))
    elif cool:
        interior.append("{} cooling".format(cool))
    elif central_air:
        interior.append("central air conditioning")

    # Laundry
    if laundry:
        laundry_map = {
            "In-unit": "in-unit washer/dryer",
            "Washer/dryer hookups": "washer/dryer hookups",
            "Shared laundry": "shared laundry facilities",
        }
        interior.append(laundry_map.get(laundry, laundry.lower()))

    # Basement
    if basement:
        interior.append("a full basement")

    # Appliances
    clean_appliances = [a.replace("_", " ") for a in appliances if a]
    if clean_appliances:
        if len(clean_appliances) == 1:
            interior.append(clean_appliances[0])
        elif len(clean_appliances) <= 4:
            interior.append(", ".join(clean_appliances[:-1]) + " and " + clean_appliances[-1])
        else:
            interior.append(", ".join(clean_appliances[:4]) + ", and more")

    if interior:
        para = "Interior highlights include " + ", ".join(interior) + "."
        paragraphs.append(para)

    # ── Paragraph 3: parking & outdoor ────────────────────────────────────────
    outdoor = []
    if parking:
        outdoor.append(parking.lower())
    # Check amenities for pool, yard, deck, patio
    amenity_lower = " ".join(str(a).lower() for a in amenities)
    if re.search(r"\bpool\b|\bswimming\b", amenity_lower):
        outdoor.append("a swimming pool")
    if re.search(r"\bfenced.{0,5}yard\b|\bbackyard\b|\bback yard\b", amenity_lower):
        outdoor.append("a fenced backyard")
    elif re.search(r"\byard\b", amenity_lower):
        outdoor.append("a yard")
    if re.search(r"\bpatio\b|\bdeck\b|\bporch\b", amenity_lower):
        outdoor.append("outdoor patio/deck space")

    if outdoor:
        if len(outdoor) == 1:
            para = "The property includes {}.".format(outdoor[0])
        else:
            para = "The property includes " + ", ".join(outdoor[:-1]) + " and " + outdoor[-1] + "."
        paragraphs.append(para)

    # ── Paragraph 4: policies & availability ─────────────────────────────────
    policy_parts = []
    if pets is True:
        policy_parts.append("Pets are welcome")
    elif pets is False:
        policy_parts.append("No pets allowed")

    if avail:
        if avail == "now" or re.match(r"^\d{4}-\d{2}-\d{2}$", str(avail)):
            from datetime import date as _date
            try:
                avail_date = _date.fromisoformat(str(avail))
                today = _date.today()
                if avail_date <= today:
                    policy_parts.append("available for immediate move-in")
                else:
                    policy_parts.append("available from {}".format(
                        avail_date.strftime("%B %-d, %Y")
                    ))
            except Exception:
                policy_parts.append("availability: {}".format(avail))

    if vtour:
        policy_parts.append("a virtual tour is available")

    if policy_parts:
        para = ". ".join(p[0].upper() + p[1:] for p in policy_parts) + "."
        paragraphs.append(para)

    # ── Final assembly ────────────────────────────────────────────────────────
    description = "\n\n".join(p for p in paragraphs if p.strip())
    return description if description.strip() else None


def _parse_opendoor_html(html, url, verbose=False):
    """
    Parse an Opendoor listing HTML page into a normalised pipeline record.

    Extraction priority:
      1. __NEXT_DATA__ (Next.js embedded JSON) — richest source, especially for photos
      2. JSON-LD (schema.org) — good for address, price, basic fields
      3. OpenGraph meta tags — last-resort image fallback
    """
    jsonld = _extract_jsonld(html) or {}
    nd = _extract_nextdata(html)
    nd_listing = _find_listing_in_nextdata(nd)

    # Require at least one data source with something useful
    if not jsonld and not nd_listing:
        if verbose:
            print("[opendoor_scraper] no JSON-LD or __NEXT_DATA__ listing found")
        return None

    # ── Address ──────────────────────────────────────────────────────────────
    address, city, state, zip_code = _build_address_fields(jsonld.get("address") or {})

    # Fallback address fields from __NEXT_DATA__
    if nd_listing:
        nd_addr = nd_listing.get("address") or nd_listing.get("location") or {}
        if isinstance(nd_addr, dict):
            address = address or nd_addr.get("streetAddress") or nd_addr.get("street") or nd_addr.get("line")
            city     = city     or nd_addr.get("addressLocality") or nd_addr.get("city")
            state    = state    or nd_addr.get("addressRegion")   or nd_addr.get("state")
            zip_code = zip_code or nd_addr.get("postalCode")      or nd_addr.get("zip")
        # Sometimes address is a flat string at top level
        if not address:
            address = nd_listing.get("streetAddress") or nd_listing.get("address1")
        if not city:
            city = nd_listing.get("city")
        if not state:
            state = nd_listing.get("state") or nd_listing.get("stateCode")
        if not zip_code:
            zip_code = nd_listing.get("zip") or nd_listing.get("postalCode")

    # ── Coordinates ──────────────────────────────────────────────────────────
    lat, lng = None, None
    geo = jsonld.get("geo") or {}
    if isinstance(geo, dict):
        try:
            lat = float(geo.get("latitude") or geo.get("lat")) if (geo.get("latitude") or geo.get("lat")) else None
        except Exception:
            lat = None
        try:
            lng = float(geo.get("longitude") or geo.get("lon") or geo.get("lng")) if (geo.get("longitude") or geo.get("lon") or geo.get("lng")) else None
        except Exception:
            lng = None

    # __NEXT_DATA__ coordinate fallback
    if nd_listing and (lat is None or lng is None):
        for lat_key in ("latitude", "lat"):
            v = nd_listing.get(lat_key)
            if v is not None:
                try:
                    lat = float(v)
                    break
                except Exception:
                    pass
        for lng_key in ("longitude", "lon", "lng"):
            v = nd_listing.get(lng_key)
            if v is not None:
                try:
                    lng = float(v)
                    break
                except Exception:
                    pass
        # Nested location/geo object
        for loc_key in ("location", "geo", "coordinates"):
            loc = nd_listing.get(loc_key)
            if isinstance(loc, dict):
                if lat is None:
                    for k in ("latitude", "lat"):
                        v = loc.get(k)
                        if v is not None:
                            try:
                                lat = float(v)
                            except Exception:
                                pass
                if lng is None:
                    for k in ("longitude", "lon", "lng"):
                        v = loc.get(k)
                        if v is not None:
                            try:
                                lng = float(v)
                            except Exception:
                                pass

    # ── Price ─────────────────────────────────────────────────────────────────
    raw_price = jsonld.get("price")
    if raw_price is None and isinstance(jsonld.get("offers"), dict):
        raw_price = jsonld["offers"].get("price")
    if raw_price is None and nd_listing:
        raw_price = nd_listing.get("price") or nd_listing.get("listPrice") or nd_listing.get("salePrice")
    sale_price = _parse_price(raw_price)
    monthly_rent = estimate_rent_from_sale_price(sale_price, state=state)

    # ── Beds / Baths ──────────────────────────────────────────────────────────
    # Fix: use _safe_int/_safe_float to handle values like 3.0 or "3"
    beds_raw = (
        jsonld.get("numberOfBedrooms") or jsonld.get("numberOfRooms") or jsonld.get("bedrooms")
        or (nd_listing.get("bedrooms") if nd_listing else None)
        or (nd_listing.get("beds") if nd_listing else None)
    )
    bedrooms = _safe_int(beds_raw)

    baths_raw = (
        jsonld.get("numberOfBathroomsTotal") or jsonld.get("bathroomCount") or jsonld.get("bathrooms")
        or (nd_listing.get("bathrooms") if nd_listing else None)
        or (nd_listing.get("baths") if nd_listing else None)
    )
    baths_f = _safe_float(baths_raw)
    bathrooms = int(baths_f) if baths_f is not None else None
    # Extract half bathrooms from fractional part
    half_bathrooms = 1 if (baths_f is not None and baths_f != int(baths_f)) else None

    # ── Square footage ────────────────────────────────────────────────────────
    square_footage = None
    area = jsonld.get("floorSize") or jsonld.get("livingArea")
    if isinstance(area, dict):
        square_footage = _parse_price(area.get("value"))
    else:
        square_footage = _parse_price(area)
    if square_footage is None and nd_listing:
        for key in ("squareFeet", "squareFootage", "sqft", "livingArea", "livingAreaSqFt"):
            v = nd_listing.get(key)
            if v:
                square_footage = _safe_int(v)
                break

    # ── Lot size ─────────────────────────────────────────────────────────────
    lot_size_sqft = _parse_lot_size(jsonld)
    if lot_size_sqft is None and nd_listing:
        for key in ("lotSize", "lotSizeSqFt", "lotSizeSquareFeet", "lot_size_sqft"):
            v = nd_listing.get(key)
            if v:
                lot_size_sqft = _safe_int(v)
                break

    # ── Year built ────────────────────────────────────────────────────────────
    year_built = _parse_year_built(jsonld, nd_listing)

    # ── Photos ────────────────────────────────────────────────────────────────
    # Priority: __NEXT_DATA__ gallery (full-res) > JSON-LD image array > OG meta
    images = _collect_nextdata_photos(nd_listing)

    if not images:
        raw_images = jsonld.get("image") or []
        if isinstance(raw_images, str):
            raw_images = [raw_images]
        images = _normalize_image_urls([_upgrade_image_url(u) for u in raw_images])

    if not images:
        og = re.search(r'<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
        if not og:
            og = re.search(r'<meta\s+content=["\']([^"\']+)["\']\s+property=["\']og:image["\']', html, re.IGNORECASE)
        if og:
            images = _normalize_image_urls([og.group(1).strip()])

    if verbose:
        print("[opendoor_scraper] collected {} images (nextdata={}, jsonld={})".format(
            len(images),
            len(_collect_nextdata_photos(nd_listing)),
            len(jsonld.get("image") or []) if isinstance(jsonld.get("image"), list) else (1 if jsonld.get("image") else 0),
        ))

    # ── Description ──────────────────────────────────────────────────────────
    raw_desc = str(jsonld.get("description") or "").strip()
    if not raw_desc and nd_listing:
        raw_desc = str(nd_listing.get("description") or nd_listing.get("remarks") or "").strip()
    cleaned_description = _clean_sale_description(raw_desc, monthly_rent)

    # ── Property type ─────────────────────────────────────────────────────────
    prop_type_raw = (
        jsonld.get("@type") or jsonld.get("propertyType")
        or (nd_listing.get("propertyType") if nd_listing else None)
        or (nd_listing.get("homeType") if nd_listing else None)
    )
    property_type = _normalize_property_type(prop_type_raw)

    # ── HVAC / Laundry / Parking / Pets ──────────────────────────────────────
    heating, cooling = _parse_hvac(jsonld, cleaned_description)
    laundry    = _parse_laundry(jsonld, cleaned_description)
    appliances = _parse_appliances(jsonld, cleaned_description)
    parking    = _parse_parking(jsonld, cleaned_description)
    pets_allowed  = _parse_pets(jsonld, cleaned_description)
    available_date = _parse_available_date(jsonld, html)
    move_in_special = _parse_move_in_special(html, cleaned_description)
    amenities   = _normalize_amenity_tags(_parse_amenities(jsonld))

    # ── Extra fields from __NEXT_DATA__ ──────────────────────────────────────
    neighborhood  = _parse_neighborhood(jsonld, nd_listing)
    virtual_tour  = _parse_virtual_tour(jsonld, nd_listing)
    has_basement  = _parse_has_basement(jsonld, cleaned_description)
    has_central_air = _parse_has_central_air(jsonld, cleaned_description, cooling)
    walk_score, transit_score, bike_score = _parse_walk_scores(nd_listing)

    # Build location_context as human-readable text matching the format used
    # by scraper.py and zillow_scraper.py:
    #   "Walk score: 88; Transit score: 72; Bike score: 60"
    _score_parts = []
    if walk_score is not None:
        _score_parts.append("Walk score: " + str(walk_score))
    if transit_score is not None:
        _score_parts.append("Transit score: " + str(transit_score))
    if bike_score is not None:
        _score_parts.append("Bike score: " + str(bike_score))
    location_context = "; ".join(_score_parts) if _score_parts else None

    # ── Title ─────────────────────────────────────────────────────────────────
    title = str(jsonld.get("name") or "").strip()
    if not title and nd_listing:
        title = str(nd_listing.get("title") or nd_listing.get("name") or "").strip()
    if not title:
        parts = []
        if bedrooms:
            parts.append("{}BR".format(bedrooms))
        if city and state:
            parts.append("{}, {}".format(city, state))
        elif address:
            parts.append(address)
        title = " ".join(parts) if parts else "Opendoor Rental Candidate"

    rec = {
        "id": "PP-" + uuid.uuid4().hex[:8].upper(),
        "source": "opendoor",
        "source_url": url.split("?")[0],
        "source_listing_id": _format_source_id(url, jsonld),
        "status": "scraped",
        "title": title,
        "address": address,
        "unit_number": None,
        "city": city,
        "state": state,
        "zip": zip_code,
        "county": None,
        "neighborhood": neighborhood,
        "lat": lat,
        "lng": lng,
        "location_context": location_context,
        "property_type": property_type,
        "bedrooms": bedrooms,
        "bathrooms": bathrooms,
        "half_bathrooms": half_bathrooms,
        "total_bathrooms": baths_f,
        "square_footage": square_footage,
        "lot_size_sqft": lot_size_sqft,
        "year_built": year_built,
        "floors": None,
        "garage_spaces": None,
        "total_units": None,
        "has_basement": has_basement,
        "has_central_air": has_central_air,
        "virtual_tour_url": virtual_tour,
        "monthly_rent": monthly_rent,
        "security_deposit": None,       # Left blank — admin sets this after review
        "application_fee": None,        # Not applicable for Opendoor sale→rental conversions
        "pet_deposit": None,
        "admin_fee": None,
        "move_in_special": move_in_special,
        "parking_fee": None,
        "hoa_fee": None,
        "tax_value": None,
        "description": cleaned_description,
        "showing_instructions": None,
        # Default available_date to today — Opendoor homes are vacant/unoccupied
        # (they buy homes directly), so immediate availability is the safe default.
        "available_date": available_date or date.today().isoformat(),
        # Standard 12-month lease for single-family conversions
        "minimum_lease_months": 12,
        "lease_terms": "[]",
        "pets_allowed": pets_allowed,
        "pet_types_allowed": "[]",
        "pet_weight_limit": None,
        "pet_details": None,
        "smoking_allowed": False,   # standard for residential rentals
        "parking": parking,
        "amenities": json.dumps(amenities),
        "appliances": json.dumps(appliances),
        "utilities_included": "[]",
        "flooring": "[]",
        "heating_type": heating,
        "cooling_type": cooling,
        "laundry_type": laundry,
        "original_image_urls": json.dumps(images[:50]),
        "local_image_paths": "[]",
        "agent_name": None,
        "broker_name": None,
        "agent_image_url": None,
        "poster_landlord_id": None,
        "original_data": json.dumps({
            "_source": "opendoor",
            "_imported_at": datetime.utcnow().isoformat() + "Z",
            "sale_price": sale_price,
            "estimated_rent": monthly_rent,
            "jsonld_type": jsonld.get("@type"),
            "converted_from_sale": True,
            "conversion_method": _OPENDOOR_RENT_METHOD,
            "opendoor_sale_price": sale_price,
            "opendoor_listing_id": _format_source_id(url, jsonld),
            "nextdata_found": nd_listing is not None,
            "photo_count": len(images),
        }, default=str),
        "edited_fields": "[]",
        "inferred_features": "[]",
        "data_quality_score": 0,
        "missing_fields": "[]",
        "published_at": None,
        "choice_property_id": None,
        "scraped_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "updated_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    # ── Description: build a rich rental description from structured data ────
    # If the cleaned scraped text is absent or thin (< 200 chars), generate
    # a full multi-paragraph description from every structured field we have.
    # If the scraped text is rich enough, _build_rental_description appends a
    # features paragraph after it so nothing is lost.
    generated = _build_rental_description(rec, scraped_text=cleaned_description)
    if generated:
        rec["description"] = generated

    rec["missing_fields"] = json.dumps(_missing_fields(rec))
    rec["data_quality_score"] = _data_quality_score(rec)

    if verbose:
        print("[opendoor_scraper] extracted {} images, rent=${}, quality={}, desc_len={}".format(
            len(images), monthly_rent, rec["data_quality_score"],
            len(rec.get("description") or ""),
        ))

    return rec


def _fetch_with_retry(url, verbose=False):
    """Fetch a URL with up to _FETCH_RETRIES attempts and exponential backoff.

    Uses curl_cffi with Chrome TLS impersonation when available so that
    Opendoor's bot-detection does not block the request.
    """
    last_exc = None
    for attempt in range(1, _FETCH_RETRIES + 1):
        try:
            if _CURL_CFFI_OK:
                resp = _req.get(
                    url,
                    timeout=_FETCH_TIMEOUT,
                    headers=_FETCH_HEADERS,
                    impersonate="chrome110",
                )
            else:
                resp = _req.get(url, timeout=_FETCH_TIMEOUT, headers=_FETCH_HEADERS)
            resp.raise_for_status()
            return resp
        except Exception as e:
            last_exc = e
            if verbose:
                print("[opendoor_scraper] fetch attempt {}/{} failed: {}".format(
                    attempt, _FETCH_RETRIES, e
                ))
            if attempt < _FETCH_RETRIES:
                time.sleep(_FETCH_RETRY_DELAY * attempt)
    if verbose:
        print("[opendoor_scraper] all fetch attempts failed for {}".format(url))
    return None


def scrape_opendoor_url(url, verbose=False):
    if not is_opendoor_url(url):
        return None
    resp = _fetch_with_retry(url, verbose=verbose)
    if resp is None:
        return None
    return _parse_opendoor_html(resp.text, url, verbose=verbose)


def scrape_opendoor_urls(urls, verbose=False):
    records = []
    for url in urls:
        if not is_opendoor_url(url):
            continue
        rec = scrape_opendoor_url(url, verbose=verbose)
        if rec:
            records.append(rec)
            if verbose:
                print("[opendoor_scraper] scraped {} -> {} (quality={})".format(
                    url, rec.get("source_listing_id"), rec.get("data_quality_score")
                ))
        else:
            if verbose:
                print("[opendoor_scraper] failed to scrape {}".format(url))
        time.sleep(1.0)
    return records
