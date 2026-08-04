import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

spec = importlib.util.spec_from_file_location("enrichment", ROOT / "enrichment.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_title_generation_and_pet_inference():
    record = {
        "bedrooms": 2,
        "property_type": "APARTMENT",
        "city": "Austin",
        "description": "Pets are welcome. Washer and dryer in unit. Garage available.",
        "amenities": ["garage_2", "pet_friendly", "washer_dryer"],
    }

    enriched = module.rule_based_enrich(record)

    assert enriched["title"].startswith("2BR")
    assert "Garage" in enriched["title"]
    assert enriched["pets_allowed"] is True
    assert enriched["laundry_type"] == "In-unit"
    assert enriched["parking"] == "2-car garage"


def test_application_fee_floor_and_description_cleanup():
    text = "Application fee: $35.00. Free to apply today."
    cleaned = module.normalize_application_fee_in_description(text)
    assert "Application Fee: $50." in cleaned
    assert "$35.00" not in cleaned


def test_fallback_description_is_generated_from_features():
    record = {
        "bedrooms": 2,
        "bathrooms": 2,
        "property_type": "APARTMENT",
        "city": "Austin",
        "monthly_rent": 1800,
        "amenities": ["Pool", "Pet Friendly", "Garage"],
        "description": "",
    }

    enriched = module.rule_based_enrich(record)

    assert enriched["description"]
    assert "Austin" in enriched["description"]
    assert "Pool" in enriched["description"] or "garage" in enriched["description"].lower()


def test_pet_inference_from_spaced_amenity_tag():
    record = {"pets_allowed": None, "amenities": ["Pet Friendly"], "description": ""}
    enriched = module.rule_based_enrich(record)
    assert enriched["pets_allowed"] is True


def test_parking_inference_from_driveway_amenity_tag():
    record = {"parking": None, "amenities": ["Driveway"], "description": ""}
    enriched = module.rule_based_enrich(record)
    assert enriched["parking"] == "Driveway"


def test_price_consistency_rewrites_monthly_rent_mentions():
    text = "The rent is $1,200/month and the app fee is $50."
    updated = module.enforce_price_consistency(text, 1500)
    assert "$1,200/month" not in updated
    assert "$1,500/month" in updated
