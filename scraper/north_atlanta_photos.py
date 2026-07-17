#!/usr/bin/env python3
"""
North Metro Atlanta — Photo Import Script
=========================================
Downloads source photos from Realtor.com CDN and uploads them to ImageKit,
then inserts rows into public.property_photos for each property.

Runs after north_atlanta_publish.py.
"""

import os
import sys
import json
import time
import logging

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scraper import _load_dotenv
_load_dotenv()

logging.basicConfig(level=logging.WARNING)

SUPABASE_URL     = "https://tlfmwetmhthpyrytrcfo.supabase.co"
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
IK_PRIVATE_KEY   = os.environ.get("IMAGEKIT_PRIVATE_KEY", "")
IK_ENDPOINT      = os.environ.get("IMAGEKIT_URL_ENDPOINT", "").rstrip("/")

if not SERVICE_ROLE_KEY:
    sys.exit("❌  SUPABASE_SERVICE_ROLE_KEY not set")
if not IK_PRIVATE_KEY:
    sys.exit("❌  IMAGEKIT_PRIVATE_KEY not set")
if not IK_ENDPOINT:
    sys.exit("❌  IMAGEKIT_URL_ENDPOINT not set")

H_SUP = {
    "apikey":        SERVICE_ROLE_KEY,
    "Authorization": "Bearer " + SERVICE_ROLE_KEY,
    "Content-Type":  "application/json",
    "Prefer":        "return=representation",
}

# Mapping: pipeline_id → choice_property_id (from publish run)
PROPERTY_MAP = {
    "PP-A15CF80C": "a576c8c4-6f06-4aa1-8251-b6d7c19c1a49",   # 50 King Alfred Ct, Dallas
    "PP-ED2FF130": "3fc51740-fa53-47c4-8f7a-07a5bc27fb1f",   # 232 Hampton Dr, Dallas
    "PP-5534B3D0": "965a8993-6d57-41fa-8e44-8edaf090cf00",   # 3210 Baker Rd NW, Acworth
    "PP-C4A66B47": "796d0089-e174-4007-821e-c5d39bf683e9",   # 5020 Sand Wedge Cir NW, Kennesaw
    "PP-CA39EF0F": "67b77d25-3d5c-4a87-adb8-5cd5c94ba105",   # 121 Creekwood Trl, Acworth
    "PP-75589BB7": "c9a57997-21d2-4334-bc7e-28864b250788",   # 5065 Sand Wedge Cir NW, Kennesaw
    "PP-C0077582": "5113592d-01e1-4642-b3b9-4b228453927c",   # 538 Oakside Pl, Acworth
}

MAX_PHOTOS      = 20     # cap per property (quality > quantity)
DOWNLOAD_TIMEOUT = 25   # seconds
UPLOAD_TIMEOUT   = 45   # seconds
MAX_RETRIES      = 3
RETRY_BACKOFF    = 2.0


def get_pipeline_images(pipeline_id):
    """Fetch original_image_urls from pipeline record."""
    r = requests.get(
        SUPABASE_URL + "/rest/v1/pipeline_properties",
        headers=dict(H_SUP, **{"Accept-Profile": "pipeline", "Content-Profile": "pipeline"}),
        params={"select": "original_image_urls,address", "id": "eq." + pipeline_id},
    )
    data = r.json()
    if not data:
        return [], "unknown"
    row = data[0]
    urls = json.loads(row.get("original_image_urls") or "[]")
    return urls, row.get("address", pipeline_id)


def download_image(url):
    """Download image bytes from source URL. Returns (bytes, content_type) or (None, None)."""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/128.0.0.0 Safari/537.36"
        ),
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Referer": "https://www.realtor.com/",
    }
    try:
        resp = requests.get(url, headers=headers, timeout=DOWNLOAD_TIMEOUT, stream=False)
        if resp.status_code == 200:
            ct = resp.headers.get("Content-Type", "image/jpeg")
            return resp.content, ct
        return None, None
    except Exception:
        return None, None


def upload_to_imagekit(img_bytes, filename, folder, content_type):
    """Upload image bytes to ImageKit. Returns IK file URL on success, None on failure."""
    import base64
    b64 = base64.b64encode(img_bytes).decode("utf-8")
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(
                "https://upload.imagekit.io/api/v1/files/upload",
                auth=(IK_PRIVATE_KEY, ""),
                data={
                    "file":     b64,
                    "fileName": filename,
                    "folder":   folder,
                },
                timeout=UPLOAD_TIMEOUT,
            )
            if resp.status_code in (200, 201):
                data = resp.json()
                return data.get("url"), data.get("fileId")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BACKOFF * (attempt + 1))
        except Exception:
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BACKOFF * (attempt + 1))
    return None, None


def insert_photo(property_id, ik_url, file_id, display_order, is_hero):
    """Insert a row into public.property_photos."""
    r = requests.post(
        SUPABASE_URL + "/rest/v1/property_photos",
        headers=H_SUP,
        json={
            "property_id":      property_id,
            "url":              ik_url,
            "file_id":          file_id,
            "display_order":    display_order,
            "is_hero":          is_hero,
            "watermark_status": "pending",
            "alt_text":         "",
        },
    )
    return r.status_code in (200, 201)


def process_property(pipeline_id, property_id):
    source_urls, address = get_pipeline_images(pipeline_id)
    if not source_urls:
        return 0, 0, "no source images"

    # Cap at MAX_PHOTOS, preserve order
    urls_to_process = source_urls[:MAX_PHOTOS]
    folder = "properties/" + property_id.replace("-", "")

    transferred = 0
    skipped     = 0

    for idx, src_url in enumerate(urls_to_process):
        is_hero = (idx == 0)

        # Derive filename
        ext = "jpg"
        src_lower = src_url.lower().split("?")[0]
        if ".png" in src_lower:
            ext = "png"
        elif ".webp" in src_lower:
            ext = "webp"
        filename = f"photo_{idx+1:03d}.{ext}"

        # Download
        img_bytes, content_type = download_image(src_url)
        if not img_bytes:
            skipped += 1
            print(f"     ⚠   [{idx+1}/{len(urls_to_process)}] download failed — skipped")
            continue

        # Upload to ImageKit
        ik_url, file_id = upload_to_imagekit(img_bytes, filename, folder, content_type)
        if not ik_url:
            skipped += 1
            print(f"     ⚠   [{idx+1}/{len(urls_to_process)}] IK upload failed — skipped")
            continue

        # Insert into DB
        ok = insert_photo(property_id, ik_url, file_id or "", idx, is_hero)
        if ok:
            transferred += 1
            hero_tag = " [HERO]" if is_hero else ""
            print(f"     ✅  [{idx+1}/{len(urls_to_process)}]{hero_tag} {ik_url}")
        else:
            skipped += 1
            print(f"     ⚠   [{idx+1}/{len(urls_to_process)}] DB insert failed")

        # Brief pause to avoid CDN rate-limiting
        time.sleep(0.15)

    return transferred, skipped, None


def main():
    print("\n" + "=" * 60)
    print("  North Metro Atlanta — Photo Import")
    print("  ImageKit endpoint: " + IK_ENDPOINT)
    print("=" * 60)

    grand_transferred = 0
    grand_skipped     = 0

    for pipeline_id, property_id in PROPERTY_MAP.items():
        print(f"\n{'─'*55}")
        print(f"  {pipeline_id} → {property_id}")

        transferred, skipped, err = process_property(pipeline_id, property_id)
        if err:
            print(f"  ❌  {err}")
        else:
            print(f"  ✅  transferred={transferred}  skipped={skipped}")
        grand_transferred += transferred
        grand_skipped     += skipped

    print("\n" + "=" * 60)
    print(f"  DONE — total transferred: {grand_transferred}  skipped: {grand_skipped}")
    print("=" * 60)


if __name__ == "__main__":
    main()
