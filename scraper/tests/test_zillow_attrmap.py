import json
import sys
import os

# Add parent directory to path so we can import zillow_scraper
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zillow_scraper import _enrich_from_detail


def test_attrmap_facts_parsing():
    """Test that attrMap facts are parsed and fill missing fields."""
    record = {
        "address": "123 Main St",
        "city": "Austin",
        "state": "TX",
        "zip": "78701",
        "monthly_rent": 1500,
        "bedrooms": 2,
        "bathrooms": 2,
        "square_footage": 1000,
        "year_built": None,
        "lot_size_sqft": None,
        "parking": None,
        "heating_type": None,
        "cooling_type": None,
        "laundry_type": None,
        "appliances": "[]",
        "pets_allowed": None,
        "smoking_allowed": None,
        "county": None,
        "neighborhood": None,
        "amenities": "[]",
        "original_image_urls": "[]",
    }

    prop = {
        "resoFacts": {},
        "attrMap": {
            "Year Built": "2010",
            "Lot Size": "5000",
            "Parking": "2-car garage",
            "Heating": "Forced air",
            "Cooling": "Central AC",
            "Laundry": "In-unit",
            "Appliances": "Dishwasher, Microwave",
            "Pet Friendly": "Yes",
            "Smoking": "No",
            "County": "Travis",
            "Neighborhood": "Downtown",
            "Amenities": "Pool, Gym, Parking",
        },
    }

    result = _enrich_from_detail(record, prop)

    # Verify attrMap fields were parsed
    assert result["year_built"] == 2010, f"Expected 2010, got {result['year_built']}"
    assert result["lot_size_sqft"] == 5000, f"Expected 5000, got {result['lot_size_sqft']}"
    assert result["parking"] == "2-car garage", f"Expected '2-car garage', got {result['parking']}"
    assert result["heating_type"] == "Forced air", f"Expected 'Forced air', got {result['heating_type']}"
    assert result["cooling_type"] == "Central AC", f"Expected 'Central AC', got {result['cooling_type']}"
    assert result["laundry_type"] == "In-unit", f"Expected 'In-unit', got {result['laundry_type']}"
    assert "Dishwasher" in result["appliances"], f"Expected appliances, got {result['appliances']}"
    assert result["pets_allowed"] is True, f"Expected True, got {result['pets_allowed']}"
    assert result["smoking_allowed"] is False, f"Expected False, got {result['smoking_allowed']}"
    assert result["county"] == "Travis", f"Expected 'Travis', got {result['county']}"
    assert result["neighborhood"] == "Downtown", f"Expected 'Downtown', got {result['neighborhood']}"
    assert "Pool" in result["amenities"], f"Expected Pool in amenities, got {result['amenities']}"
    print("✅ All attrMap facts parsed correctly")


def test_attrmap_array_format():
    """Test that attrMap array format is parsed correctly."""
    record = {
        "year_built": None,
        "amenities": "[]",
        "original_image_urls": "[]",
    }

    prop = {
        "resoFacts": {},
        "attrMap": [
            {"label": "Year Built", "value": "2015"},
            {"label": "Amenities", "value": "Pool, Gym"},
        ],
    }

    result = _enrich_from_detail(record, prop)
    assert result["year_built"] == 2015, f"Expected 2015, got {result['year_built']}"
    assert "Pool" in result["amenities"], f"Expected Pool in amenities, got {result['amenities']}"
    print("✅ attrMap array format parsed correctly")


def test_amenity_categories():
    """Test that amenityCategories are parsed correctly."""
    record = {
        "amenities": "[]",
        "original_image_urls": "[]",
    }

    prop = {
        "resoFacts": {},
        "amenityCategories": [
            {
                "name": "Community",
                "amenities": ["Pool", "Gym", "Clubhouse"]
            },
            {
                "name": "Interior",
                "amenities": ["Hardwood floors", "Granite counters"]
            }
        ],
    }

    result = _enrich_from_detail(record, prop)
    assert "Pool" in result["amenities"], f"Expected Pool, got {result['amenities']}"
    assert "Gym" in result["amenities"], f"Expected Gym, got {result['amenities']}"
    assert "Hardwood floors" in result["amenities"], f"Expected Hardwood floors, got {result['amenities']}"
    assert "Community" in result["amenities"], f"Expected Community, got {result['amenities']}"
    print("✅ amenityCategories parsed correctly")


if __name__ == "__main__":
    test_attrmap_facts_parsing()
    test_attrmap_array_format()
    test_amenity_categories()
    print("\n✅ All tests passed!")
