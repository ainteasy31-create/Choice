import importlib.util
import json
import pathlib
import sys
from unittest.mock import MagicMock, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

spec = importlib.util.spec_from_file_location("opendoor_scraper", ROOT / "opendoor_scraper.py")
module = importlib.util.module_from_spec(spec)
sys.modules["opendoor_scraper"] = module  # register so patch() can find it by name
spec.loader.exec_module(module)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _make_html(jsonld=None, nextdata=None, og_image=None):
    """Build minimal HTML containing the requested data blobs."""
    parts = ["<html><head>"]
    if jsonld:
        parts.append('<script type="application/ld+json">{}</script>'.format(json.dumps(jsonld)))
    if nextdata:
        parts.append('<script id="__NEXT_DATA__" type="application/json">{}</script>'.format(json.dumps(nextdata)))
    if og_image:
        parts.append('<meta property="og:image" content="{}"/>'.format(og_image))
    parts.append("</head><body></body></html>")
    return "".join(parts)


_SAMPLE_JSONLD = {
    "@context": "https://schema.org",
    "@type": "SingleFamilyResidence",
    "name": "Test House",
    "description": "A sale listing converted to rent.",
    "address": {
        "streetAddress": "123 Main St",
        "addressLocality": "Austin",
        "addressRegion": "TX",
        "postalCode": "78701",
    },
    "geo": {"latitude": 30.2672, "longitude": -97.7431},
    "numberOfBedrooms": 3,
    "numberOfBathroomsTotal": 2.5,
    "floorSize": {"value": 1800},
    "price": "$270,000",
    "image": [
        "https://images.opendoor.com/1.jpg",
        "https://images.opendoor.com/2.jpg",
    ],
    "yearBuilt": 2005,
}

_SAMPLE_NEXTDATA = {
    "props": {
        "pageProps": {
            "listing": {
                "id": "abc123",
                "bedrooms": 3,
                "bathrooms": 2.5,
                "yearBuilt": 2005,
                "neighborhood": "Hyde Park",
                "virtualTourUrl": "https://my.matterport.com/show/?m=xyz",
                "latitude": 30.2672,
                "longitude": -97.7431,
                "photos": [
                    {"url": "https://images.opendoor.com/photo1.jpg"},
                    {"url": "https://images.opendoor.com/photo2.jpg"},
                    {"url": "https://images.opendoor.com/photo3.jpg"},
                    {"url": "https://images.opendoor.com/photo4.jpg"},
                    {"url": "https://images.opendoor.com/photo5.jpg"},
                ],
            }
        }
    }
}


# ── URL detection ─────────────────────────────────────────────────────────────

def test_is_opendoor_url():
    assert module.is_opendoor_url("https://www.opendoor.com/listing/123")
    assert module.is_opendoor_url("http://opendoor.com/property/abc")
    assert not module.is_opendoor_url("https://www.zillow.com/homedetails/123")
    assert not module.is_opendoor_url(None)
    assert not module.is_opendoor_url("")


# ── Rent estimation ───────────────────────────────────────────────────────────

def test_estimate_rent_from_sale_price():
    # Base multiplier 0.0085 with $25 rounding
    assert module.estimate_rent_from_sale_price(200000) == 1700    # 200k*0.0085=1700 → $1700
    assert module.estimate_rent_from_sale_price("$300,000") == 2550  # 300k*0.0085=2550 → $2550
    assert module.estimate_rent_from_sale_price(50000) == 700      # enforces minimum
    assert module.estimate_rent_from_sale_price(None) is None
    assert module.estimate_rent_from_sale_price(0) is None


def test_estimate_rent_state_aware():
    """State-level multipliers should produce market-appropriate rents."""
    # Ohio (affordable market) uses a higher multiplier than default
    oh_rent = module.estimate_rent_from_sale_price(200000, state="OH")
    default_rent = module.estimate_rent_from_sale_price(200000)
    assert oh_rent > default_rent, "OH rent should be higher than default for same price"

    # California (expensive market) uses a lower multiplier
    ca_rent = module.estimate_rent_from_sale_price(400000, state="CA")
    default_ca = module.estimate_rent_from_sale_price(400000)
    assert ca_rent < default_ca, "CA rent should be lower than default for same price"

    # State codes should be case-insensitive
    assert module.estimate_rent_from_sale_price(300000, state="oh") == \
           module.estimate_rent_from_sale_price(300000, state="OH")


def test_estimate_rent_rounding():
    """Rent should be rounded to the nearest $25 (human-looking price)."""
    # 187500 * 0.0085 = 1593.75 → rounds to $1600 (nearest $25 = 1593.75/25=63.75 → 64 × 25 = 1600)
    rent = module.estimate_rent_from_sale_price(187500)
    assert rent % 25 == 0, "Rent should be a multiple of $25, got {}".format(rent)

    # 270000 * 0.0085 = 2295 → rounds to $2300 (nearest $25)
    rent = module.estimate_rent_from_sale_price(270000)
    assert rent == 2300
    assert rent % 25 == 0


# ── Basic JSON-LD extraction ───────────────────────────────────────────────────

def test_parse_opendoor_html_jsonld():
    html = _make_html(jsonld=_SAMPLE_JSONLD)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123")
    assert rec is not None
    assert rec["source"] == "opendoor"
    assert rec["city"] == "Austin"
    assert rec["state"] == "TX"
    assert rec["bedrooms"] == 3
    assert rec["bathrooms"] == 2        # integer part
    assert rec["half_bathrooms"] == 1   # fractional part → half bath
    assert rec["square_footage"] == 1800
    # 270k * 0.0085 = 2295 → rounds to nearest $25 = $2300
    assert rec["monthly_rent"] == 2300
    assert rec["monthly_rent"] % 25 == 0, "Rent must be a $25 multiple"
    # application_fee and security_deposit must NOT be hardcoded
    assert rec["application_fee"] is None
    assert rec["security_deposit"] is None
    photos = json.loads(rec["original_image_urls"])
    assert len(photos) >= 2


# ── __NEXT_DATA__ photo extraction ────────────────────────────────────────────

def test_nextdata_photos_used():
    """__NEXT_DATA__ gallery should be preferred over JSON-LD image array."""
    html = _make_html(jsonld=_SAMPLE_JSONLD, nextdata=_SAMPLE_NEXTDATA)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123")
    assert rec is not None
    photos = json.loads(rec["original_image_urls"])
    assert len(photos) == 5, "Expected all 5 __NEXT_DATA__ photos, got {}".format(len(photos))


def test_nextdata_photos_dedup():
    """Duplicate photo URLs should be deduplicated."""
    nd = {
        "props": {"pageProps": {"listing": {
            "photos": [
                {"url": "https://images.opendoor.com/photo1.jpg"},
                {"url": "https://images.opendoor.com/photo1.jpg"},  # duplicate
                {"url": "https://images.opendoor.com/photo2.jpg"},
            ]
        }}}
    }
    html = _make_html(nextdata=nd)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/456")
    assert rec is not None
    photos = json.loads(rec["original_image_urls"])
    assert len(photos) == 2


def test_og_image_fallback():
    """When no JSON-LD images or __NEXT_DATA__ photos, OG image should be used."""
    minimal_jsonld = {
        "@type": "House",
        "address": {"streetAddress": "1 Oak Ave", "addressLocality": "Dallas",
                    "addressRegion": "TX", "postalCode": "75201"},
        "price": "200000",
    }
    html = _make_html(jsonld=minimal_jsonld, og_image="https://cdn.opendoor.com/og.jpg")
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/homes/1-oak-ave")
    assert rec is not None
    photos = json.loads(rec["original_image_urls"])
    assert photos == ["https://cdn.opendoor.com/og.jpg"]


# ── New fields extracted from __NEXT_DATA__ ───────────────────────────────────

def test_neighborhood_from_nextdata():
    html = _make_html(jsonld=_SAMPLE_JSONLD, nextdata=_SAMPLE_NEXTDATA)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123")
    assert rec["neighborhood"] == "Hyde Park"


def test_virtual_tour_from_nextdata():
    html = _make_html(jsonld=_SAMPLE_JSONLD, nextdata=_SAMPLE_NEXTDATA)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123")
    assert rec["virtual_tour_url"] == "https://my.matterport.com/show/?m=xyz"


def test_year_built_from_jsonld():
    html = _make_html(jsonld=_SAMPLE_JSONLD)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123")
    assert rec["year_built"] == 2005


def test_year_built_from_nextdata_only():
    nd = {
        "props": {"pageProps": {"listing": {
            "yearBuilt": 1998,
            "photos": [{"url": "https://cdn.opendoor.com/p1.jpg"}],
        }}}
    }
    minimal_jsonld = {
        "@type": "House",
        "address": {"streetAddress": "5 Elm St", "addressLocality": "Phoenix",
                    "addressRegion": "AZ", "postalCode": "85001"},
        "price": "350000",
    }
    html = _make_html(jsonld=minimal_jsonld, nextdata=nd)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/homes/5-elm-st")
    assert rec["year_built"] == 1998


def test_lot_size_sqft_extracted():
    jsonld_with_lot = dict(_SAMPLE_JSONLD)
    jsonld_with_lot["lotSize"] = {"value": 6000, "unitCode": "sqft"}
    html = _make_html(jsonld=jsonld_with_lot)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123")
    assert rec["lot_size_sqft"] == 6000


def test_lot_size_acres_converted():
    jsonld_with_lot = dict(_SAMPLE_JSONLD)
    jsonld_with_lot["lotSize"] = {"value": 0.25, "unitCode": "acres"}
    html = _make_html(jsonld=jsonld_with_lot)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123")
    assert rec["lot_size_sqft"] == 10890  # 0.25 * 43560


def test_has_central_air_detected():
    jsonld_ac = dict(_SAMPLE_JSONLD)
    jsonld_ac["description"] = "Beautiful home with central air conditioning and garage."
    html = _make_html(jsonld=jsonld_ac)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123")
    assert rec["has_central_air"] is True


def test_has_basement_detected():
    jsonld_b = dict(_SAMPLE_JSONLD)
    jsonld_b["description"] = "Large basement perfect for storage."
    html = _make_html(jsonld=jsonld_b)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123")
    assert rec["has_basement"] is True


# ── Bedrooms int parsing ───────────────────────────────────────────────────────

def test_bedrooms_parsed_from_float_string():
    """JSON-LD sometimes delivers numeric values as '3.0' — must parse correctly."""
    jsonld = dict(_SAMPLE_JSONLD)
    jsonld["numberOfBedrooms"] = "3.0"
    html = _make_html(jsonld=jsonld)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123")
    assert rec["bedrooms"] == 3


# ── No JSON-LD fallback to __NEXT_DATA__ ─────────────────────────────────────

def test_no_jsonld_falls_back_to_nextdata():
    """Parser must not return None when JSON-LD is absent but __NEXT_DATA__ has data."""
    nd = {
        "props": {"pageProps": {"listing": {
            "id": "xyz",
            "address": {
                "streetAddress": "99 Oak Blvd",
                "addressLocality": "Houston",
                "addressRegion": "TX",
                "postalCode": "77001",
            },
            "price": 300000,
            "bedrooms": 4,
            "bathrooms": 2,
            "photos": [
                {"url": "https://cdn.opendoor.com/a.jpg"},
                {"url": "https://cdn.opendoor.com/b.jpg"},
            ],
        }}}
    }
    html = _make_html(nextdata=nd)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/homes/99-oak")
    assert rec is not None
    assert rec["city"] == "Houston"
    assert rec["bedrooms"] == 4
    photos = json.loads(rec["original_image_urls"])
    assert len(photos) == 2


# ── Image URL upgrade ─────────────────────────────────────────────────────────

def test_upgrade_image_url_strips_width_params():
    url = "https://cdn.opendoor.com/img.jpg?w=400&h=300"
    result = module._upgrade_image_url(url)
    assert "w=400" not in result
    assert "h=300" not in result


def test_upgrade_image_url_removes_size_suffix():
    url = "https://cdn.opendoor.com/photo_small.jpg"
    result = module._upgrade_image_url(url)
    assert "_small" not in result


# ── Fetch retry ───────────────────────────────────────────────────────────────

def test_scrape_opendoor_url_fetch_error():
    with patch("opendoor_scraper._req.get") as mock_get:
        mock_get.side_effect = Exception("network")
        result = module.scrape_opendoor_url("https://www.opendoor.com/listing/123", verbose=True)
        assert result is None
        assert mock_get.call_count == module._FETCH_RETRIES


def test_scrape_opendoor_url_retries_then_succeeds():
    """Should succeed on the second attempt after one network failure."""
    call_count = {"n": 0}

    def side_effect(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] < 2:
            raise Exception("transient error")
        mock_resp = MagicMock()
        mock_resp.text = _make_html(jsonld=_SAMPLE_JSONLD)
        mock_resp.raise_for_status = lambda: None
        return mock_resp

    with patch("opendoor_scraper._req.get", side_effect=side_effect):
        with patch("opendoor_scraper.time") as mock_time:
            mock_time.sleep = lambda *a: None
            result = module.scrape_opendoor_url("https://www.opendoor.com/listing/123")
    assert result is not None
    assert result["city"] == "Austin"


# ── Data quality score ────────────────────────────────────────────────────────

def test_data_quality_score_increases_with_photos():
    html_no_photos = _make_html(jsonld={
        "@type": "House",
        "address": {"streetAddress": "1 A St", "addressLocality": "NYC",
                    "addressRegion": "NY", "postalCode": "10001"},
        "price": "500000",
        "numberOfBedrooms": 2,
        "numberOfBathroomsTotal": 1,
        "floorSize": {"value": 900},
    })
    jsonld_with_photos = dict(_SAMPLE_JSONLD)
    html_with_photos = _make_html(jsonld=jsonld_with_photos, nextdata=_SAMPLE_NEXTDATA)

    rec_no = module._parse_opendoor_html(html_no_photos, "https://www.opendoor.com/homes/1a")
    rec_ph = module._parse_opendoor_html(html_with_photos, "https://www.opendoor.com/listing/123")
    assert rec_ph["data_quality_score"] > rec_no["data_quality_score"]


# ── Walk / transit / bike score extraction ────────────────────────────────────

def test_walk_scores_from_nextdata():
    """Walk/transit/bike scores in __NEXT_DATA__ listing should be stored as
    human-readable text matching the format used by scraper.py / zillow_scraper.py:
    'Walk score: 88; Transit score: 72; Bike score: 60'
    """
    nd = {
        "props": {"pageProps": {"listing": {
            "id": "w1",
            "address": {"streetAddress": "1 Walk St", "addressLocality": "Portland",
                        "addressRegion": "OR", "postalCode": "97201"},
            "price": 350000,
            "bedrooms": 3,
            "bathrooms": 2,
            "walkScore": 88,
            "transitScore": 72,
            "bikeScore": 60,
            "photos": [{"url": "https://cdn.opendoor.com/a.jpg"},
                       {"url": "https://cdn.opendoor.com/b.jpg"}],
        }}}
    }
    html = _make_html(nextdata=nd)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/homes/1-walk-st")
    assert rec is not None
    ctx = rec.get("location_context") or ""
    assert "Walk score: 88" in ctx
    assert "Transit score: 72" in ctx
    assert "Bike score: 60" in ctx
    # Must NOT be raw JSON
    assert not ctx.startswith("{"), "location_context must be human-readable, not JSON"


def test_walk_scores_nested_scores_object():
    """Walk scores nested under a 'scores' sub-object should also be extracted."""
    nd = {
        "props": {"pageProps": {"listing": {
            "id": "w2",
            "address": {"streetAddress": "2 Transit Ave", "addressLocality": "Seattle",
                        "addressRegion": "WA", "postalCode": "98101"},
            "price": 500000,
            "bedrooms": 2,
            "bathrooms": 1,
            "scores": {"walk": 95, "transit": 80},
            "photos": [{"url": "https://cdn.opendoor.com/c.jpg"},
                       {"url": "https://cdn.opendoor.com/d.jpg"}],
        }}}
    }
    html = _make_html(nextdata=nd)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/homes/2-transit")
    assert rec is not None
    ctx = rec.get("location_context") or ""
    assert "Walk score: 95" in ctx
    assert "Transit score: 80" in ctx
    assert not ctx.startswith("{"), "location_context must be human-readable, not JSON"


def test_no_walk_scores_leaves_location_context_none():
    """When no scores are present, location_context should be None."""
    html = _make_html(jsonld=_SAMPLE_JSONLD)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123")
    assert rec is not None
    assert rec.get("location_context") is None


def test_env_multiplier_overrides_state_table():
    """OPENDOOR_RENT_MULTIPLIER env var must win over the state table when set."""
    import os
    import importlib
    # Patch the explicit-override flag to simulate the env var being set
    original = module._OPENDOOR_RENT_MULTIPLIER_EXPLICIT
    original_mult = module._OPENDOOR_RENT_MULTIPLIER
    try:
        # Force override mode with a known multiplier (0.010 = 1%)
        module._OPENDOOR_RENT_MULTIPLIER_EXPLICIT = True
        module._OPENDOOR_RENT_MULTIPLIER = 0.010
        # OH normally uses 0.0095; with override it must use 0.010
        rent_with_override = module.estimate_rent_from_sale_price(200000, state="OH")
        # 200000 * 0.010 = 2000 → rounds to nearest $25 → $2000
        assert rent_with_override == 2000, (
            "Expected $2000 with 1% override, got ${}".format(rent_with_override)
        )
        # Without override flag, OH uses 0.0095 → 200000*0.0095=1900 → $1900
        module._OPENDOOR_RENT_MULTIPLIER_EXPLICIT = False
        module._OPENDOOR_RENT_MULTIPLIER = 0.0085  # restore default
        rent_state_table = module.estimate_rent_from_sale_price(200000, state="OH")
        assert rent_state_table != 2000, (
            "State-table rent should differ from override rent"
        )
    finally:
        module._OPENDOOR_RENT_MULTIPLIER_EXPLICIT = original
        module._OPENDOOR_RENT_MULTIPLIER = original_mult


# ── Smart rental defaults ─────────────────────────────────────────────────────

def test_available_date_defaults_to_today():
    """If Opendoor page has no availability info, record should default to today."""
    import datetime
    html = _make_html(jsonld=_SAMPLE_JSONLD)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123")
    assert rec is not None
    assert rec["available_date"] is not None
    # Should be parseable as a date and not in the past beyond today
    parsed = datetime.date.fromisoformat(rec["available_date"])
    assert parsed >= datetime.date.today()


def test_minimum_lease_months_defaults_to_12():
    html = _make_html(jsonld=_SAMPLE_JSONLD)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123")
    assert rec is not None
    assert rec["minimum_lease_months"] == 12


def test_smoking_allowed_defaults_to_false():
    html = _make_html(jsonld=_SAMPLE_JSONLD)
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123")
    assert rec is not None
    assert rec["smoking_allowed"] is False


# ── non-Opendoor URL guard ────────────────────────────────────────────────────

def test_scrape_non_opendoor_url_returns_none():
    assert module.scrape_opendoor_url("https://zillow.com/homedetails/123") is None
