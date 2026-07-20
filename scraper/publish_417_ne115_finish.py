#!/usr/bin/env python3
"""
Complete the publish for 417 NE 115th St — photos already on IK (PP-2DECB7B3).
Runs Steps 2-5: stage → publish → activate → insert property_photos.
"""
import json, os, sys, urllib.parse
import requests

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY,
    "Content-Type": "application/json",
}
SB_PIPELINE_HEADERS = {
    **SB_HEADERS,
    "Accept-Profile":  "pipeline",
    "Content-Profile": "pipeline",
}

# Already uploaded to IK in order (photo_01 … photo_17)
IK_URLS = [
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_01_6-dIbVn1p.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_02_w8tp7mtI0.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_03_kjxBOP-xC.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_04_BM_hp3lME.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_05_SMeksdLLY.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_06_KVvhp1xve.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_07_6NkTsg6rr.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_08_G8Bqyp4NF.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_09_khU1gjGC1.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_10_cmYcbVo5a.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_11_SWYFWGrRL.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_12_F6osdca6E.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_13_3ZLl2GFyYB.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_14_DUJbl68a6.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_15_xWKrvJrf8.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_16_3RsDS2JpP.webp",
    "https://ik.imagekit.io/21rg7lvzo/properties/PP-2DECB7B3/photo_17_gTJkXbTgi.webp",
]

PIPELINE_ID = "PP-2DECB7B3"

LISTING = {
    "id":                 PIPELINE_ID,
    "source":             "manual",
    "source_url":         "manual",
    "source_listing_id":  "manual-417-ne-115th-okc-73114",
    "status":             "scraped",
    "title":              "3BR/2.5BA in Oklahoma City",
    "address":            "417 NE 115th St",
    "city":               "Oklahoma City",
    "state":              "OK",
    "zip":                "73114",
    "county":             "Oklahoma",
    "bedrooms":           3,
    "bathrooms":          2,
    "half_bathrooms":     1,
    "total_bathrooms":    2.5,
    "square_footage":     1415,
    "property_type":      "SINGLE_FAMILY",
    "monthly_rent":       1400,
    "security_deposit":   1400,
    "application_fee":    50,
    "pets_allowed":       True,
    "smoking_allowed":    False,
    "minimum_lease_months": 12,
    "garage_spaces":      2,
    "parking":            "Attached 2-Car Garage",
    "amenities": json.dumps([
        "brick_fireplace",
        "open_layout",
        "private_backyard",
        "2_car_garage",
        "stainless_steel_appliances",
        "marble_countertops",
        "recessed_lighting",
        "dishwasher",
    ]),
    "utilities_included": json.dumps([]),
    "lease_terms":        json.dumps(["12_months"]),
    "description": (
        "Welcome to this well-maintained home located in a convenient Oklahoma City neighborhood. "
        "With 3 bedrooms, 2.5 bathrooms, and 1,415 square feet of comfortable living space, this "
        "residence offers both functionality and charm.\n\n"
        "The open layout creates a warm and inviting atmosphere, anchored by a beautiful brick "
        "fireplace in the living area—perfect for relaxing or gathering with family and friends. "
        "The well-designed floor plan provides ample space for everyday living and entertaining.\n\n"
        "The private and spacious backyard offers endless possibilities—whether you're looking to "
        "garden, host outdoor gatherings, or simply enjoy some quiet time in the fresh air. "
        "The attached 2-car garage adds convenience and additional storage.\n\n"
        "Situated in a great area with easy access to highways, this home puts you close to all "
        "the best that Oklahoma City has to offer—shopping, dining, entertainment, and more. "
        "Don't miss the opportunity to make this charming home your own!"
    ),
    "data_quality_score":  88,
    "missing_fields":      json.dumps([]),
    "edited_fields":       json.dumps([]),
    "inferred_features":   json.dumps([]),
    "original_image_urls": json.dumps(IK_URLS),
    "local_image_paths":   json.dumps([]),
    "original_data":       json.dumps({"_source": "manual"}),
    "source_status":       "available",
    "lat":  35.5768,
    "lng": -97.4878,
}

# ---------------------------------------------------------------------------
# Step 2: Stage
# ---------------------------------------------------------------------------
print("── Step 2: Staging pipeline record ──")
r = requests.post(
    "{}/rest/v1/pipeline_properties?on_conflict=source_listing_id".format(SUPABASE_URL),
    headers={**SB_PIPELINE_HEADERS, "Prefer": "return=representation,resolution=merge-duplicates"},
    data=json.dumps(LISTING).encode(),
    timeout=30,
)
if not r.ok:
    sys.exit("ERROR stage: {} {}".format(r.status_code, r.text[:400]))

staged = r.json()
if isinstance(staged, list):
    staged = staged[0]
staged_id = staged.get("id") or PIPELINE_ID
print("Staged: {}".format(staged_id))

# ---------------------------------------------------------------------------
# Step 3: Publish RPC
# ---------------------------------------------------------------------------
print("\n── Step 3: Publishing via RPC ──")
r = requests.post(
    "{}/rest/v1/rpc/pipeline_publish".format(SUPABASE_URL),
    headers=SB_HEADERS,
    json={"p_id": staged_id, "p_landlord_id": None},
    timeout=30,
)
if not r.ok:
    sys.exit("ERROR publish: {} {}".format(r.status_code, r.text[:400]))

rpc = r.json()
if isinstance(rpc, list):
    rpc = rpc[0] if rpc else {}
print("RPC: {}".format(json.dumps(rpc)[:200]))

if rpc.get("ok") is False:
    sys.exit("ERROR: RPC ok=false: {}".format(rpc.get("error")))

prop_id = rpc.get("choice_property_id") or rpc.get("property_id") or rpc.get("id")
if not prop_id:
    sys.exit("ERROR: no property_id in RPC response: {}".format(rpc))
print("Property ID: {}".format(prop_id))

# ---------------------------------------------------------------------------
# Step 4: Activate
# ---------------------------------------------------------------------------
print("\n── Step 4: Activating ──")
r = requests.patch(
    "{}/rest/v1/properties?id=eq.{}".format(SUPABASE_URL, urllib.parse.quote(str(prop_id))),
    headers=SB_HEADERS,
    json={"status": "active"},
    timeout=15,
)
print("Activate: HTTP {}".format(r.status_code))
if not r.ok:
    sys.exit("ERROR activate: {}".format(r.text[:200]))

# ---------------------------------------------------------------------------
# Step 5: Insert property_photos
# ---------------------------------------------------------------------------
print("\n── Step 5: Inserting property_photos ──")
photo_rows = [
    {
        "property_id":      str(prop_id),
        "url":              url,
        "display_order":    i,
        "is_hero":          i == 0,
        "watermark_status": "pending",
        "alt_text":         "417 NE 115th St, Oklahoma City OK - photo {}".format(i + 1),
    }
    for i, url in enumerate(IK_URLS)
]

r = requests.post(
    "{}/rest/v1/property_photos".format(SUPABASE_URL),
    headers={**SB_HEADERS, "Prefer": "return=minimal"},
    data=json.dumps(photo_rows).encode(),
    timeout=30,
)
print("Insert photos: HTTP {}".format(r.status_code))
if not r.ok:
    sys.exit("ERROR photos: {}".format(r.text[:300]))
print("Inserted {} photo rows.".format(len(photo_rows)))

# ---------------------------------------------------------------------------
print("\n" + "=" * 60)
print("PUBLISHED: 417 NE 115th St, Oklahoma City, OK 73114")
print("Property ID: {}".format(prop_id))
print("URL: https://choice-properties-site.pages.dev/property?id={}".format(prop_id))
print("Photos: {}".format(len(IK_URLS)))
print("=" * 60)
