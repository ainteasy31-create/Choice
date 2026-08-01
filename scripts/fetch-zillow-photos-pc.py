#!/usr/bin/env python3
"""
Choice Properties — Fetch Zillow Photos & Replace in DB
========================================================
Run this from your PC (home WiFi or any residential internet connection).
Zillow blocks server/cloud IPs, but your home PC works fine.

SETUP (one-time):
  pip install requests curl-cffi

RUN:
  python fetch-zillow-photos-pc.py

What it does:
  1. Fetches each Zillow listing page to extract real photo URLs
  2. Downloads all photos from Zillow's CDN
  3. Uploads them to ImageKit CDN
  4. Deletes the old screenshot photos from the database
  5. Inserts the new real photos

No manual steps needed — it's fully automatic.
"""

import re
import json
import time
import base64
import random
import sys

try:
    import requests
except ImportError:
    print("ERROR: 'requests' not installed. Run:  pip install requests curl-cffi")
    sys.exit(1)

# ─── CONFIGURATION (pre-filled) ──────────────────────────────────────────────

SUPABASE_URL      = "https://tlfmwetmhthpyrytrcfo.supabase.co"
SUPABASE_KEY      = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsZm13ZXRtaHRocHlyeXRyY2ZvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTE4MzAyNCwiZXhwIjoyMDkwNzU5MDI0fQ.oO9N8LslPcDjQrzZWiUoTkOlDBqUVHBiVhRSGLC-EPE"
IK_PRIVATE_KEY    = "private_0EEkHXTzdRqJ++giVS30rF+qDAs="
IK_UPLOAD_URL     = "https://upload.imagekit.io/api/v1/files/upload"

PROPERTIES = [
    {"prop_id": "PROP-AC002CE4", "address": "2299 Hamilton Ave",  "zpid": 33870750},
    {"prop_id": "PROP-DBEF5150", "address": "3091 E 13th Ave",    "zpid": 33885238},
    {"prop_id": "PROP-52A9B99F", "address": "2691 Homecroft Dr",  "zpid": 33870114},
    {"prop_id": "PROP-1640C4C8", "address": "2766 Hiawatha St",   "zpid": 33887188},
    {"prop_id": "PROP-339D09AD", "address": "411 S Yale Ave",     "zpid": 33830154},
    {"prop_id": "PROP-AB86D1B4", "address": "117 Sunnyside Ln",   "zpid": 2078980363},
    {"prop_id": "PROP-B9F986D5", "address": "1347 Gault St",      "zpid": 33837593},
]

# ─── HELPERS ─────────────────────────────────────────────────────────────────

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
]

def make_session():
    """Create a requests session that looks like a real browser."""
    try:
        from curl_cffi import requests as cffi_req
        session = cffi_req.Session(impersonate="chrome131")
        print("  ✓ Using curl_cffi (Chrome TLS fingerprint) — best Zillow compatibility")
        return session, True
    except ImportError:
        session = requests.Session()
        session.headers.update({
            "User-Agent": random.choice(USER_AGENTS),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
        })
        print("  ℹ Using plain requests (install curl-cffi for better results)")
        return session, False

def warm_zillow(session):
    """Visit Zillow homepage to get cookies before hitting detail pages."""
    print("  Warming up Zillow session (visiting homepage to get cookies)...")
    try:
        session.get("https://www.zillow.com/", timeout=15)
        time.sleep(random.uniform(2, 4))
        session.get("https://www.zillow.com/columbus-oh/rentals/", timeout=15)
        time.sleep(random.uniform(1.5, 3))
        print("  ✓ Session warmed up")
    except Exception as e:
        print(f"  ⚠ Warmup failed (continuing anyway): {e}")

def get_zillow_photos(session, zpid, address):
    """Fetch Zillow listing page and extract photo URLs."""
    url = f"https://www.zillow.com/homes/{zpid}_zpid/"
    print(f"  Fetching: {url}")
    try:
        resp = session.get(url, timeout=20)
        if resp.status_code == 403:
            print(f"  ✗ Got 403 — Zillow is blocking this IP.")
            print("    Make sure you're on home WiFi or mobile data (not a VPN or corporate network).")
            return []
        if resp.status_code != 200:
            print(f"  ✗ HTTP {resp.status_code}")
            return []

        html = resp.text

        # Try to extract from __NEXT_DATA__ JSON blob (most reliable)
        match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group(1))
                # Walk the JSON tree looking for photo URLs
                photos = extract_photos_from_next_data(data)
                if photos:
                    print(f"  ✓ Found {len(photos)} photos via __NEXT_DATA__")
                    return photos
            except Exception as e:
                print(f"  ⚠ JSON parse error: {e}")

        # Fallback: regex search for photo URLs in the raw HTML
        patterns = [
            r'https://photos\.zillowstatic\.com/fp/[a-zA-Z0-9_-]+-p_[a-z]\.jpg',
            r'https://photos\.zillowstatic\.com/fp/[a-zA-Z0-9_-]+\.jpg',
        ]
        found = []
        for pattern in patterns:
            found.extend(re.findall(pattern, html))
        # Deduplicate and prefer high-res variants
        seen = set()
        unique = []
        for url in found:
            base = re.sub(r'-p_[a-z]\.jpg$', '', url)
            if base not in seen:
                seen.add(base)
                # Convert to highest-res variant
                high_res = base + "-p_e.jpg"
                unique.append(high_res)
        if unique:
            print(f"  ✓ Found {len(unique)} photos via regex fallback")
        return unique

    except Exception as e:
        print(f"  ✗ Error fetching listing: {e}")
        return []

def extract_photos_from_next_data(data, depth=0):
    """Recursively search JSON for Zillow photo URLs."""
    if depth > 20:
        return []
    photos = []
    if isinstance(data, dict):
        for key, val in data.items():
            if key in ("photos", "originalPhotos", "responsivePhotos", "mixedPhotos"):
                if isinstance(val, list):
                    for item in val:
                        if isinstance(item, dict):
                            # Try common URL field names
                            for field in ("url", "src", "href", "mixedSources"):
                                if field in item:
                                    if isinstance(item[field], str) and "zillow" in item[field]:
                                        photos.append(item[field])
                                    elif isinstance(item[field], dict):
                                        for size_key in ("jpeg", "webp"):
                                            if size_key in item[field]:
                                                for entry in item[field][size_key]:
                                                    if isinstance(entry, dict) and "url" in entry:
                                                        photos.append(entry["url"])
            photos.extend(extract_photos_from_next_data(val, depth + 1))
    elif isinstance(data, list):
        for item in data:
            photos.extend(extract_photos_from_next_data(item, depth + 1))
    # Deduplicate
    seen = set()
    unique = []
    for p in photos:
        if p not in seen and "zillowstatic" in p:
            seen.add(p)
            unique.append(p)
    return unique

def download_image(url):
    """Download an image, returning (bytes, extension) or (None, None)."""
    headers = {
        "User-Agent": random.choice(USER_AGENTS),
        "Referer": "https://www.zillow.com/",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }
    try:
        resp = requests.get(url, headers=headers, timeout=25, stream=True)
        if resp.status_code != 200:
            return None, None
        chunks = []
        total = 0
        for chunk in resp.iter_content(65536):
            total += len(chunk)
            if total > 20 * 1024 * 1024:  # 20MB cap
                return None, None
            chunks.append(chunk)
        ct = resp.headers.get("Content-Type", "")
        ext = "jpg"
        if "png" in ct:
            ext = "png"
        elif "webp" in ct:
            ext = "webp"
        return b"".join(chunks), ext
    except Exception as e:
        print(f"    ⚠ Download failed: {e}")
        return None, None

def upload_to_imagekit(image_bytes, filename, folder):
    """Upload image bytes to ImageKit, return (ik_url, file_id) or (None, None)."""
    auth = base64.b64encode((IK_PRIVATE_KEY + ":").encode()).decode()
    try:
        resp = requests.post(
            IK_UPLOAD_URL,
            headers={"Authorization": f"Basic {auth}"},
            files={"file": (filename, image_bytes, "image/jpeg")},
            data={"fileName": filename, "folder": folder, "useUniqueFileName": "false"},
            timeout=60,
        )
        if resp.status_code == 200:
            d = resp.json()
            return d.get("url"), d.get("fileId")
        print(f"    ⚠ ImageKit upload failed: HTTP {resp.status_code} — {resp.text[:200]}")
        return None, None
    except Exception as e:
        print(f"    ⚠ ImageKit upload error: {e}")
        return None, None

def sb_get(path, params=""):
    """GET from Supabase REST API."""
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    if params:
        url += "?" + params
    resp = requests.get(url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
    }, timeout=20)
    return resp.json()

def sb_delete(path, params):
    """DELETE from Supabase REST API."""
    url = f"{SUPABASE_URL}/rest/v1/{path}?{params}"
    resp = requests.delete(url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
    }, timeout=20)
    return resp.status_code

def sb_insert(table, records):
    """INSERT rows into Supabase."""
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
        json=records,
        timeout=30,
    )
    return resp.status_code, resp.json()

def delete_ik_file(file_id):
    """Delete a file from ImageKit by file ID."""
    auth = base64.b64encode((IK_PRIVATE_KEY + ":").encode()).decode()
    try:
        resp = requests.delete(
            f"https://api.imagekit.io/v1/files/{file_id}",
            headers={"Authorization": f"Basic {auth}"},
            timeout=20,
        )
        return resp.status_code in (200, 204)
    except Exception:
        return False

# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("Choice Properties — Zillow Photo Import")
    print("=" * 60)
    print()

    session, using_cffi = make_session()

    print("\nStep 1: Warming up Zillow session...")
    warm_zillow(session)

    results = {}

    for i, prop in enumerate(PROPERTIES):
        prop_id  = prop["prop_id"]
        address  = prop["address"]
        zpid     = prop["zpid"]
        folder   = f"properties/{prop_id.lower()}"

        print(f"\n{'='*60}")
        print(f"[{i+1}/{len(PROPERTIES)}] {address}  (zpid={zpid})")
        print(f"{'='*60}")

        # Step 1: Get photo URLs from Zillow
        print("  Step 1: Fetching photo URLs from Zillow...")
        photo_urls = get_zillow_photos(session, zpid, address)
        if not photo_urls:
            print(f"  ✗ No photos found — skipping {address}")
            results[prop_id] = {"status": "failed", "reason": "no_photos"}
            continue

        # Limit to first 15 photos (Zillow listings can have 50+)
        photo_urls = photo_urls[:15]
        print(f"  → Will download and upload {len(photo_urls)} photos")

        # Step 2: Download + upload each photo
        print("  Step 2: Downloading from Zillow and uploading to ImageKit...")
        uploaded = []
        for j, src_url in enumerate(photo_urls):
            print(f"    Photo {j+1}/{len(photo_urls)}: ", end="", flush=True)
            img_data, ext = download_image(src_url)
            if img_data is None:
                print("download failed, skipping")
                continue
            filename = f"photo_{j+1:02d}.{ext}"
            ik_url, file_id = upload_to_imagekit(img_data, filename, folder)
            if ik_url:
                uploaded.append({"url": ik_url, "file_id": file_id})
                print(f"✓ uploaded ({len(img_data)//1024}KB)")
            else:
                print("upload failed")
            time.sleep(0.5)  # Polite delay

        if not uploaded:
            print(f"  ✗ All uploads failed — skipping DB update for {address}")
            results[prop_id] = {"status": "failed", "reason": "upload_failed"}
            continue

        print(f"  → Successfully uploaded {len(uploaded)}/{len(photo_urls)} photos")

        # Step 3: Get existing photos from DB to delete
        print("  Step 3: Removing old screenshots from DB + ImageKit...")
        existing = sb_get("property_photos", f"property_id=eq.{prop_id}&select=id,file_id")
        if isinstance(existing, list):
            for old in existing:
                old_file_id = old.get("file_id")
                if old_file_id:
                    delete_ik_file(old_file_id)  # Best-effort IK delete
            # Delete all DB rows for this property
            status = sb_delete("property_photos", f"property_id=eq.{prop_id}")
            print(f"    → Deleted {len(existing)} old photo record(s) (HTTP {status})")
        else:
            print(f"    ⚠ Could not fetch existing photos: {existing}")

        # Step 4: Insert new photos
        print("  Step 4: Inserting new photos into database...")
        new_rows = []
        for order, photo in enumerate(uploaded):
            new_rows.append({
                "property_id":    prop_id,
                "url":            photo["url"],
                "file_id":        photo["file_id"],
                "display_order":  order,
                "alt_text":       f"{address} — photo {order + 1}",
                "watermark_status": "pending",
                "is_hero":        order == 0,
            })
        insert_status, insert_result = sb_insert("property_photos", new_rows)
        if insert_status in (200, 201):
            print(f"  ✓ Inserted {len(new_rows)} new photos")
            results[prop_id] = {"status": "ok", "photos": len(new_rows)}
        else:
            print(f"  ✗ DB insert failed (HTTP {insert_status}): {str(insert_result)[:200]}")
            results[prop_id] = {"status": "db_error", "detail": str(insert_result)[:200]}

        # Polite delay between properties
        if i < len(PROPERTIES) - 1:
            delay = random.uniform(3, 6)
            print(f"\n  Waiting {delay:.1f}s before next property...")
            time.sleep(delay)

    # ─── Summary ─────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    ok  = [p for p, r in results.items() if r.get("status") == "ok"]
    bad = [p for p, r in results.items() if r.get("status") != "ok"]
    print(f"  ✓ Succeeded: {len(ok)}/{len(PROPERTIES)}")
    for p in ok:
        addr = next(x["address"] for x in PROPERTIES if x["prop_id"] == p)
        print(f"     {addr} — {results[p]['photos']} photos")
    if bad:
        print(f"  ✗ Failed: {len(bad)}")
        for p in bad:
            addr = next(x["address"] for x in PROPERTIES if x["prop_id"] == p)
            print(f"     {addr} — {results[p].get('reason', results[p].get('detail', '?'))}")
    print()
    print("Done! Check the live site to see the updated listings.")

if __name__ == "__main__":
    main()
