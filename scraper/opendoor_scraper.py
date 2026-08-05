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
    import requests as _req
except ImportError as _e:
    raise ImportError("requests is required for opendoor_scraper: {}".format(_e))

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


def estimate_rent_from_sale_price(sale_price):
    """Estimate monthly rent from a sale price using a configurable multiplier."""
    price = _parse_price(sale_price)
    if price is None or price <= 0:
        return None
    rent = int(round(price * _OPENDOOR_RENT_MULTIPLIER))
    if rent < _OPENDOOR_RENT_MIN:
        rent = _OPENDOOR_RENT_MIN
    return rent


def _normalize_image_urls(values):
    urls = []
    seen = set()
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, (list, tuple)):
        return []
    for item in values:
        if not item:
            continue
        url = str(item).strip()
        if url and url.startswith("http") and url not in seen:
            urls.append(url)
            seen.add(url)
    return urls


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
            if typ in ("SingleFamilyResidence", "House", "Apartment", "Condo"):
                return item
        return candidates[0][1]
    if isinstance(obj, dict):
        return obj
    return None


def _extract_jsonld(html):
    pattern = re.compile(r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>", re.DOTALL | re.IGNORECASE)
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
        m = re.search(r"available\s+(?:now|immediately|from\s+([A-Z][a-z]+ \d{1,2},? \d{4}))", text, re.IGNORECASE)
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


def _quality_score(record):
    score = 0
    for field in _CORE_FIELDS:
        if record.get(field) not in (None, "", []):
            score += 6
    for field in _BONUS_FIELDS:
        if record.get(field) not in (None, "", []):
            score += 2
    photos = record.get("original_image_urls") or []
    if isinstance(photos, list):
        score += 6 if len(photos) >= 5 else 3 if len(photos) >= 1 else 0
    return min(score, 100)


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


def _parse_opendoor_html(html, url, verbose=False):
    jsonld = _extract_jsonld(html)
    if not jsonld:
        return None

    address, city, state, zip_code = _build_address_fields(jsonld.get("address") or {})
    lat = None
    lng = None
    geo = jsonld.get("geo") or {}
    if isinstance(geo, dict):
        try:
            lat = float(geo.get("latitude") or geo.get("lat")) if geo.get("latitude") or geo.get("lat") else None
        except Exception:
            lat = None
        try:
            lng = float(geo.get("longitude") or geo.get("lon")) if geo.get("longitude") or geo.get("lon") else None
        except Exception:
            lng = None

    raw_price = jsonld.get("price") or jsonld.get("offers", {}).get("price") if isinstance(jsonld.get("offers"), dict) else jsonld.get("price")
    sale_price = _parse_price(raw_price)
    monthly_rent = estimate_rent_from_sale_price(sale_price)

    bedrooms = jsonld.get("numberOfRooms") or jsonld.get("numberOfBedrooms") or jsonld.get("bedrooms")
    bathrooms = jsonld.get("numberOfBathroomsTotal") or jsonld.get("bathroomCount") or jsonld.get("bathrooms")
    square_footage = None
    area = jsonld.get("floorSize") or jsonld.get("livingArea")
    if isinstance(area, dict):
        square_footage = _parse_price(area.get("value"))
    else:
        square_footage = _parse_price(area)

    bedrooms = int(bedrooms) if bedrooms is not None and str(bedrooms).isdigit() else None
    bathrooms = float(bathrooms) if bathrooms is not None and re.match(r"^[0-9]+(?:\.[0-9]+)?$", str(bathrooms)) else None

    images = _normalize_image_urls(jsonld.get("image") or [])
    if not images:
        # fallback: extract images from OpenGraph tags in the HTML
        og = re.search(r'<meta property=["\']og:image["\'] content=["\']([^"\']+)["\']', html, re.IGNORECASE)
        if og:
            images = [og.group(1).strip()]

    cleaned_description = _clean_sale_description(str(jsonld.get("description") or "").strip(), monthly_rent)
    heating, cooling = _parse_hvac(jsonld, cleaned_description)
    laundry = _parse_laundry(jsonld, cleaned_description)
    appliances = _parse_appliances(jsonld, cleaned_description)
    parking = _parse_parking(jsonld, cleaned_description)
    pets_allowed = _parse_pets(jsonld, cleaned_description)
    available_date = _parse_available_date(jsonld, html)
    move_in_special = _parse_move_in_special(html, cleaned_description)
    amenities = _normalize_amenity_tags(_parse_amenities(jsonld))

    rec = {
        "id": "PP-" + uuid.uuid4().hex[:8].upper(),
        "source": "opendoor",
        "source_url": url.split("?")[0],
        "source_listing_id": _format_source_id(url, jsonld),
        "status": "scraped",
        "title": str(jsonld.get("name") or "Opendoor Rental Candidate"),
        "address": address,
        "unit_number": None,
        "city": city,
        "state": state,
        "zip": zip_code,
        "county": None,
        "neighborhood": None,
        "lat": lat,
        "lng": lng,
        "location_context": None,
        "property_type": _normalize_property_type(jsonld.get("@type") or jsonld.get("propertyType")),
        "bedrooms": bedrooms,
        "bathrooms": bathrooms,
        "half_bathrooms": None,
        "total_bathrooms": bathrooms,
        "square_footage": square_footage,
        "lot_size_sqft": None,
        "year_built": None,
        "floors": None,
        "garage_spaces": None,
        "total_units": None,
        "has_basement": None,
        "has_central_air": None,
        "virtual_tour_url": None,
        "monthly_rent": monthly_rent,
        "security_deposit": monthly_rent,
        "application_fee": 50,
        "pet_deposit": None,
        "admin_fee": None,
        "move_in_special": move_in_special,
        "parking_fee": None,
        "hoa_fee": None,
        "tax_value": None,
        "description": cleaned_description,
        "showing_instructions": None,
        "available_date": available_date,
        "minimum_lease_months": None,
        "lease_terms": "[]",
        "pets_allowed": pets_allowed,
        "pet_types_allowed": "[]",
        "pet_weight_limit": None,
        "pet_details": None,
        "smoking_allowed": None,
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
    rec["missing_fields"] = json.dumps(_missing_fields(rec))
    rec["data_quality_score"] = _data_quality_score(rec)

    if verbose:
        print("[opendoor_scraper] extracted {} images, rent=${}".format(len(images), monthly_rent))

    return rec


def scrape_opendoor_url(url, verbose=False):
    if not is_opendoor_url(url):
        return None
    try:
        resp = _req.get(url, timeout=20, headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        })
        resp.raise_for_status()
    except Exception as e:
        if verbose:
            print("[opendoor_scraper] fetch failed: {}".format(e))
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
                print("[opendoor_scraper] scraped {} -> {}".format(url, rec.get("source_listing_id")))
        else:
            if verbose:
                print("[opendoor_scraper] failed to scrape {}".format(url))
        time.sleep(1.0)
    return records
