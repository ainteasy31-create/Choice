#!/usr/bin/env python3
"""Verify the CJ Properties published property exists in the database."""
import json
import os
import sys

import requests

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
for candidate in [os.path.join(_SCRIPT_DIR, ".env"), os.path.join(_SCRIPT_DIR, "../.env"), ".env"]:
    if os.path.isfile(candidate):
        with open(candidate) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                if k and k not in os.environ:
                    os.environ[k] = v.strip().strip('"').strip("'")
        break

PROP_ID = "9d87c6c1-fe17-4602-a6d9-1cdaa5fa7e0c"
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not SUPABASE_URL or not SERVICE_ROLE_KEY:
    sys.exit("ERROR: Missing Supabase credentials")

HEADERS = {
    "apikey": SERVICE_ROLE_KEY,
    "Authorization": "Bearer " + SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
}
PIPELINE_HEADERS = dict(HEADERS)
PIPELINE_HEADERS["Accept-Profile"] = "pipeline"
PIPELINE_HEADERS["Content-Profile"] = "pipeline"

# 1. Check properties table
r = requests.get(
    SUPABASE_URL + "/rest/v1/properties?id=eq." + PROP_ID,
    headers=HEADERS,
    timeout=15,
)
print("=== properties table ===")
print("HTTP", r.status_code)
if r.ok:
    rows = r.json()
    if rows:
        p = rows[0]
        print("Found property:")
        print("  ID:     {}".format(p.get("id")))
        print("  Title:  {}".format(p.get("title")))
        print("  Address: {} {}, {} {}".format(
            p.get("address", ""), p.get("unit_number") or "",
            p.get("city", ""), p.get("state", "")))
        print("  Rent:   ${}/mo".format(p.get("monthly_rent")))
        print("  Beds:   {}".format(p.get("bedrooms")))
        print("  Status: {}".format(p.get("status")))
    else:
        print("NOT FOUND in properties table!")
else:
    print(r.text[:200])

# 2. Check photos
print("\n=== property_photos ===")
r2 = requests.get(
    SUPABASE_URL + "/rest/v1/property_photos?property_id=eq." + PROP_ID + "&select=id,url,is_hero,display_order",
    headers=HEADERS,
    timeout=15,
)
print("HTTP", r2.status_code)
if r2.ok:
    photos = r2.json()
    print("Photo count: {}".format(len(photos)))
    if photos:
        for ph in photos[:3]:
            print("  - {}".format(ph.get("url", "")[:80]))
else:
    print(r2.text[:200])

# 3. Check pipeline record
print("\n=== pipeline_properties ===")
r3 = requests.get(
    SUPABASE_URL + "/rest/v1/pipeline_properties?source_listing_id=eq.cjproperties%3A650",
    headers=PIPELINE_HEADERS,
    timeout=15,
)
print("HTTP", r3.status_code)
if r3.ok:
    rows = r3.json()
    if rows:
        p = rows[0]
        print("Found pipeline record:")
        print("  ID:             {}".format(p.get("id")))
        print("  Source:         {}".format(p.get("source")))
        print("  Source Listing: {}".format(p.get("source_listing_id")))
        print("  Status:         {}".format(p.get("status")))
        print("  Property ID:    {}".format(p.get("choice_property_id")))
        print("  Score:          {}".format(p.get("data_quality_score")))
    else:
        print("NOT FOUND in pipeline table!")
else:
    print(r3.text[:200])