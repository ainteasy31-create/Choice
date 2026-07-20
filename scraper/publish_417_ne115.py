#!/usr/bin/env python3
"""
One-shot publisher for 417 NE 115th St, Oklahoma City, OK 73114.
"""
import json, os, sys, time, uuid, urllib.parse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SUPABASE_URL   = os.environ["SUPABASE_URL"]
SUPABASE_KEY   = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
IK_PRIVATE_KEY = os.environ["IMAGEKIT_PRIVATE_KEY"]

IK_UPLOAD_URL = "https://upload.imagekit.io/api/v1/files/upload"
IK_AUTH = requests.auth.HTTPBasicAuth(IK_PRIVATE_KEY, "")

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

# ---------------------------------------------------------------------------
# Listing data
# ---------------------------------------------------------------------------
LISTING = {
    "source_listing_id": "manual-417-ne-115th-okc-73114",
    "source":            "manual",
    "source_url":        "",
    "status":            "ready",
    "address":           "417 NE 115th St",
    "city":              "Oklahoma City",
    "state":             "OK",
    "zip":               "73114",
    "full_address":      "417 NE 115th St, Oklahoma City, OK 73114",
    "bedrooms":          3,
    "bathrooms":         2.5,
    "half_baths":        1,
    "square_feet":       1415,
    "price":             1400,
    "deposit":           1400,
    "property_type":     "house",
    "parking":           "2-car garage",
    "pets_allowed":      True,
    "application_fee":   50,
    "lease_term":        12,
    "available_now":     True,
    "features": json.dumps([
        "brick fireplace",
        "open layout",
        "private backyard",
        "2-car garage",
        "stainless steel appliances",
        "marble countertops",
        "recessed lighting",
    ]),
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
    "data_quality_score": 88,
    "missing_fields":     json.dumps([]),
    "edited_fields":      json.dumps([]),
    "inferred_features":  json.dumps([]),
    "original_image_urls": json.dumps([]),
    "local_image_paths":  json.dumps([]),
    "original_data":      json.dumps({"_source": "manual"}),
    "source_status":      "available",
    "lat":  35.5768,
    "lng": -97.4878,
}

# ---------------------------------------------------------------------------
# Photo files — only the batch uploaded for this listing (timestamp prefix)
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).parent.parent
PHOTO_FILES = sorted(
    REPO_ROOT.glob("attached_assets/*_178456406030[67].webp")
)
# Fallback: if glob missed some, grab all matching the two timestamps
if len(PHOTO_FILES) < 5:
    PHOTO_FILES = sorted(
        p for p in REPO_ROOT.glob("attached_assets/*.webp")
        if "1784564060306" in p.name or "1784564060307" in p.name
    )

print("Found {} photo files for this listing.".format(len(PHOTO_FILES)))

# ---------------------------------------------------------------------------
# Step 1: Upload photos to ImageKit
# ---------------------------------------------------------------------------
def upload_photo(idx, path, folder):
    fname = "photo_{:02d}.webp".format(idx + 1)
    for attempt in range(1, 4):
        try:
            data = open(path, "rb").read()
            r = requests.post(
                IK_UPLOAD_URL,
                auth=IK_AUTH,
                files={"file": (fname, data, "image/webp")},
                data={"fileName": fname, "folder": folder},
                timeout=60,
            )
            if r.status_code == 200:
                url = r.json().get("url")
                if url:
                    print("  [{}] OK: {}".format(idx + 1, url))
                    return idx, url
            print("  [{}] HTTP {} attempt {}: {}".format(idx+1, r.status_code, attempt, r.text[:80]))
        except Exception as e:
            print("  [{}] Error attempt {}: {}".format(idx+1, attempt, str(e)[:80]))
        if attempt < 3:
            time.sleep(2 * attempt)
    return idx, None

pipeline_id = "PP-" + uuid.uuid4().hex[:8].upper()
ik_folder   = "/properties/{}".format(pipeline_id)

print("\n── Step 1: Uploading {} photos to ImageKit ──".format(len(PHOTO_FILES)))
ik_results = [None] * len(PHOTO_FILES)

with ThreadPoolExecutor(max_workers=4) as ex:
    futures = {ex.submit(upload_photo, i, p, ik_folder): i
               for i, p in enumerate(PHOTO_FILES)}
    for fut in as_completed(futures):
        idx, url = fut.result()
        ik_results[idx] = url

ik_urls = [u for u in ik_results if u]
failed  = ik_results.count(None)
print("\nUploaded: {} OK, {} failed".format(len(ik_urls), failed))

if len(ik_urls) < 6:
    sys.exit("ERROR: Only {} photos uploaded (min 6 required). Aborting.".format(len(ik_urls)))

LISTING["original_image_urls"] = json.dumps(ik_urls)

# ---------------------------------------------------------------------------
# Step 2: Stage record in pipeline_properties
# ---------------------------------------------------------------------------
print("\n── Step 2: Staging pipeline record ──")

LISTING["id"] = pipeline_id

r = requests.post(
    "{}/rest/v1/pipeline_properties?on_conflict=source_listing_id".format(SUPABASE_URL),
    headers={**SB_PIPELINE_HEADERS, "Prefer": "return=representation,resolution=merge-duplicates"},
    data=json.dumps(LISTING).encode(),
    timeout=30,
)
if not r.ok:
    sys.exit("ERROR: Stage failed: {} {}".format(r.status_code, r.text[:300]))

staged = r.json()
if isinstance(staged, list):
    staged = staged[0]
staged_id = staged.get("id") or pipeline_id
print("Staged with pipeline ID: {}".format(staged_id))

# ---------------------------------------------------------------------------
# Step 3: Publish via pipeline_publish RPC
# ---------------------------------------------------------------------------
print("\n── Step 3: Publishing via RPC ──")

r = requests.post(
    "{}/rest/v1/rpc/pipeline_publish".format(SUPABASE_URL),
    headers=SB_HEADERS,
    json={"p_id": staged_id, "p_landlord_id": None},
    timeout=30,
)
if not r.ok:
    sys.exit("ERROR: Publish RPC failed: {} {}".format(r.status_code, r.text[:300]))

rpc_data = r.json()
if isinstance(rpc_data, list):
    rpc_data = rpc_data[0] if rpc_data else {}
print("RPC response: {}".format(json.dumps(rpc_data)[:200]))

if rpc_data.get("ok") is False:
    sys.exit("ERROR: RPC returned ok=false: {}".format(rpc_data.get("error", "unknown")))

prop_id = (
    rpc_data.get("choice_property_id")
    or rpc_data.get("property_id")
    or rpc_data.get("id")
)
if not prop_id:
    sys.exit("ERROR: Could not extract property_id from RPC response: {}".format(rpc_data))
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
    sys.exit("ERROR: activate failed: {}".format(r.text[:200]))

# ---------------------------------------------------------------------------
# Step 5: Insert property_photos
# ---------------------------------------------------------------------------
print("\n── Step 5: Inserting property_photos ──")

photo_rows = []
for i, url in enumerate(ik_urls):
    photo_rows.append({
        "property_id":     str(prop_id),
        "url":             url,
        "display_order":   i,
        "is_hero":         i == 0,
        "watermark_status": "pending",
        "alt_text":        "417 NE 115th St, Oklahoma City OK - photo {}".format(i + 1),
    })

r = requests.post(
    "{}/rest/v1/property_photos".format(SUPABASE_URL),
    headers={**SB_HEADERS, "Prefer": "return=minimal"},
    data=json.dumps(photo_rows).encode(),
    timeout=30,
)
print("Insert photos: HTTP {}".format(r.status_code))
if not r.ok:
    sys.exit("ERROR: photo insert failed: {}".format(r.text[:300]))
print("Inserted {} photo rows.".format(len(photo_rows)))

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
print("\n" + "=" * 60)
print("PUBLISHED: 417 NE 115th St, Oklahoma City, OK 73114")
print("Property ID: {}".format(prop_id))
print("URL: https://choice-properties-site.pages.dev/property?id={}".format(prop_id))
print("Photos: {}".format(len(ik_urls)))
print("=" * 60)
