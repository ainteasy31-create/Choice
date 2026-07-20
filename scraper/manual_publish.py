#!/usr/bin/env python3
"""
manual_publish.py — Publish a manually-entered listing from local photo files.

Usage:
    python3 scraper/manual_publish.py

Reads property data from the hardcoded listing dict below,
uploads local photos to ImageKit, stages a pipeline_properties record,
calls pipeline_publish RPC, activates the property, and inserts property_photos.
"""

import base64
import json
import os
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("ERROR: requests not installed. Run: pip install requests")

# ---------------------------------------------------------------------------
# Config from env
# ---------------------------------------------------------------------------
SUPABASE_URL       = os.environ.get("SUPABASE_URL", "https://tlfmwetmhthpyrytrcfo.supabase.co").rstrip("/")
SERVICE_ROLE_KEY   = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
IK_PRIVATE_KEY     = os.environ.get("IMAGEKIT_PRIVATE_KEY", "").strip()
IK_URL_ENDPOINT    = "https://ik.imagekit.io/21rg7lvzo"
IK_UPLOAD_URL      = "https://upload.imagekit.io/api/v1/files/upload"

if not SERVICE_ROLE_KEY:
    sys.exit("ERROR: SUPABASE_SERVICE_ROLE_KEY not set")
if not IK_PRIVATE_KEY:
    sys.exit("ERROR: IMAGEKIT_PRIVATE_KEY not set")

IK_AUTH = "Basic " + base64.b64encode((IK_PRIVATE_KEY + ":").encode()).decode()

# Supabase headers
SB_HEADERS = {
    "apikey": SERVICE_ROLE_KEY,
    "Authorization": "Bearer " + SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Prefer": "return=representation",
}
SB_PIPELINE_HEADERS = dict(SB_HEADERS)
SB_PIPELINE_HEADERS["Accept-Profile"] = "pipeline"
SB_PIPELINE_HEADERS["Content-Profile"] = "pipeline"

# ---------------------------------------------------------------------------
# Listing data — 3053 SW 92nd St, Oklahoma City, OK 73159
# ---------------------------------------------------------------------------
LISTING = {
    "source": "manual",
    "source_url": "manual",
    "source_listing_id": "manual-3053-sw-92nd-st-okc-ok-73159",
    "status": "scraped",
    "title": "3BR/2BA in Oklahoma City",
    "address": "3053 SW 92nd St",
    "city": "Oklahoma City",
    "state": "OK",
    "zip": "73159",
    "county": "Oklahoma",
    "bedrooms": 3,
    "bathrooms": 2,
    "half_bathrooms": 0,
    "square_footage": 1391,
    "property_type": "SINGLE_FAMILY",
    "monthly_rent": 1325,
    "security_deposit": 1325,
    "application_fee": 50,
    "pets_allowed": False,
    "smoking_allowed": False,
    "minimum_lease_months": 12,
    "garage_spaces": 2,
    "parking": "Attached 2-Car Garage",
    "amenities": json.dumps([
        "attached_garage",
        "central_air",
        "forced_air_heating",
        "dishwasher",
        "oven",
        "washer_dryer_hookups",
        "carpet",
        "tile_flooring",
    ]),
    "utilities_included": json.dumps([]),
    "lease_terms": json.dumps(["12_months"]),
    "flooring": json.dumps(["carpet", "tile"]),
    "description": (
        "Welcome to this beautiful 3-bedroom, 2-bathroom home located in a highly convenient "
        "Southwest Oklahoma City neighborhood. With 1,391 square feet of well-designed living "
        "space, this residence offers comfort, functionality, and an ideal location for modern living.\n\n"
        "The open and inviting floor plan features tile and carpet flooring throughout, creating a warm "
        "and practical living environment. The kitchen comes equipped with a dishwasher and oven, while "
        "washer and dryer hookups add everyday convenience. Central air and forced air heating ensure "
        "year-round comfort.\n\n"
        "The attached 2-car garage provides secure parking and additional storage space. Outside, "
        "you'll find a well-maintained yard — perfect for outdoor activities and relaxation.\n\n"
        "Situated in the highly regarded Westmoore School District, this home is served by Earlywine "
        "Elementary (8/10), West Junior High (4/10), and Westmoore High School (9/10). Commuters will "
        "appreciate the easy access to I-44 and I-240, with Tinker AFB, the Amazon Warehouse on "
        "Portland Avenue, the FAA, and Will Rogers World Airport all just a short drive away.\n\n"
        "Don't miss this opportunity to lease a well-located home in a desirable Oklahoma City "
        "neighborhood! Submit your application today at Choice Properties."
    ),
    "data_quality_score": 85,
    "missing_fields": json.dumps([]),
    "edited_fields": json.dumps([]),
    "inferred_features": json.dumps([]),
    "original_image_urls": json.dumps([]),
    "local_image_paths": json.dumps([]),
    "original_data": json.dumps({"_source": "manual"}),
    "source_status": "available",
    "lat": 35.3822,
    "lng": -97.5786,
}

# ---------------------------------------------------------------------------
# Local photo files — all webp in attached_assets/
# We use the sorted list to keep order consistent across runs.
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).parent.parent
PHOTO_FILES = sorted(REPO_ROOT.glob("attached_assets/*.webp"))
MAX_PHOTOS = 20

print("Found {} local photo files. Will upload up to {}.".format(len(PHOTO_FILES), MAX_PHOTOS))

# ---------------------------------------------------------------------------
# Step 1: Upload photos to ImageKit
# ---------------------------------------------------------------------------

def upload_photo(idx, path, folder):
    """Upload one local file to ImageKit. Returns (idx, url) or (idx, None)."""
    fname = "photo_{:02d}.webp".format(idx + 1)
    for attempt in range(1, 4):
        try:
            with open(path, "rb") as f:
                data = f.read()
            r = requests.post(
                IK_UPLOAD_URL,
                headers={"Authorization": IK_AUTH},
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
ik_folder = "/properties/{}".format(pipeline_id)

print("\n── Step 1: Uploading photos to ImageKit ──")
photos_to_upload = list(PHOTO_FILES[:MAX_PHOTOS])
ik_results = [None] * len(photos_to_upload)

with ThreadPoolExecutor(max_workers=4) as ex:
    futures = {ex.submit(upload_photo, i, p, ik_folder): i for i, p in enumerate(photos_to_upload)}
    for fut in as_completed(futures):
        idx, url = fut.result()
        ik_results[idx] = url

ik_urls = [u for u in ik_results if u]
failed = ik_results.count(None)
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
# Step 4: Activate (status = active)
# ---------------------------------------------------------------------------
print("\n── Step 4: Activating ──")
import urllib.parse
r = requests.patch(
    "{}/rest/v1/properties?id=eq.{}".format(SUPABASE_URL, urllib.parse.quote(str(prop_id))),
    headers=SB_HEADERS,
    json={"status": "active"},
    timeout=15,
)
print("Activate: HTTP {}".format(r.status_code))
if not r.ok:
    print("WARNING: activate failed: {}".format(r.text[:200]))

# ---------------------------------------------------------------------------
# Step 5: Insert property_photos
# ---------------------------------------------------------------------------
print("\n── Step 5: Inserting property_photos ──")

photo_rows = []
for i, url in enumerate(ik_urls):
    photo_rows.append({
        "property_id": str(prop_id),
        "url": url,
        "display_order": i,
        "is_hero": i == 0,
        "watermark_status": "pending",
        "alt_text": "3053 SW 92nd St, Oklahoma City OK - photo {}".format(i + 1),
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
print("PUBLISHED: 3053 SW 92nd St, Oklahoma City, OK 73159")
print("Property ID: {}".format(prop_id))
print("URL: https://choice-properties-site.pages.dev/property?id={}".format(prop_id))
print("Photos: {}".format(len(ik_urls)))
print("=" * 60)
