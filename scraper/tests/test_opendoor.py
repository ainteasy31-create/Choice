import importlib.util
import pathlib
import sys
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

spec = importlib.util.spec_from_file_location("opendoor_scraper", ROOT / "opendoor_scraper.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_is_opendoor_url():
    assert module.is_opendoor_url("https://www.opendoor.com/listing/123")
    assert module.is_opendoor_url("http://opendoor.com/property/abc")
    assert not module.is_opendoor_url("https://www.zillow.com/homedetails/123")


def test_estimate_rent_from_sale_price():
    assert module.estimate_rent_from_sale_price(200000) == 1700
    assert module.estimate_rent_from_sale_price("$300,000") == 2550
    assert module.estimate_rent_from_sale_price(50000) == 700


def test_parse_opendoor_html_jsonld():
    html = '''
    <html><head>
    <script type="application/ld+json">
    {
      "@context":"https://schema.org",
      "@type":"SingleFamilyResidence",
      "name":"Test House",
      "description":"A sale listing converted to rent.",
      "address":{
        "streetAddress":"123 Main St",
        "addressLocality":"Austin",
        "addressRegion":"TX",
        "postalCode":"78701"
      },
      "geo":{"latitude":30.2672,"longitude":-97.7431},
      "numberOfBedrooms":3,
      "numberOfBathroomsTotal":2,
      "floorSize":{"value":1800},
      "price":"$270,000",
      "image":["https://images.opendoor.com/1.jpg","https://images.opendoor.com/2.jpg"]
    }
    </script>
    </head><body></body></html>
    '''
    rec = module._parse_opendoor_html(html, "https://www.opendoor.com/listing/123", verbose=False)
    assert rec["source"] == "opendoor"
    assert rec["city"] == "Austin"
    assert rec["state"] == "TX"
    assert rec["bedrooms"] == 3
    assert rec["bathrooms"] == 2.0
    assert rec["square_footage"] == 1800
    assert rec["monthly_rent"] == 2295
    assert rec["security_deposit"] == 2295
    assert len(rec["original_image_urls"]) > 0 or rec["original_image_urls"]


def test_scrape_opendoor_url_fetch_error():
    with patch("opendoor_scraper._req.get") as mock_get:
        mock_get.side_effect = Exception("network")
        assert module.scrape_opendoor_url("https://www.opendoor.com/listing/123", verbose=True) is None
