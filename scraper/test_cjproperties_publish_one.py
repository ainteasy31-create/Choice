#!/usr/bin/env python3
"""
Test script: Scrape ONE property from cjproperties.org and publish it.
Uses the scraper's internal functions to fetch just the first MO/KS listing,
then publishes it via the same flow as cjproperties_publish.py.
"""
import base64
import json
import os
import sys
import time
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    sys.exit("ERROR: requests not installed. Run: pip install requests")

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

# Load .env
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

from cjproperties_scraper import (
    _make_session, _fetch_with_retry, _extract_html_from_js,
    _extract_property_blocks, _extract_header, _extract_address,
    _extract_details, _extract_description, _extract_image_urls,
    _extract_unit_url, _fetch_detail_html, _extract_image_urls_from_detail_html,
    _build_record, RM_SEARCH_URL, RM_CORP_ID, RM_LOCATIONS_DEFAULT,
    REQUEST_DELAY,
)

# Config
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://tlfmwetmhthpyrytrcfo.supabase.co").rstrip("/")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
IK_PRIVATE_KEY = os.environ.get("IMAGEKIT_PRIVATE_KEY", "").strip()
IK_URL_ENDPOINT = os.environ.get("IMAGEKIT_URL_ENDPOINT", "https://ik.imagekit.io/21rg7lvzo").rstrip("/")
IK_UPLOAD_URL = "https://upload.imagekit.io/api/v1/files/upload"
SITE_BASE_URL = os.environ.get("SITE_BASE_URL", "https://choice-properties-site.pages.dev").rstrip("/")

if not SERVICE_ROLE_KEY:
    sys.exit("ERROR: SUPABASE_SERVICE_ROLE_KEY not set")
if not IK_PRIVATE_KEY:
    sys.exit("ERROR: IMAGEKIT_PRIVATE_KEY not set")

IK_AUTH = "Basic " + base64.b64encode((IK_PRIVATE_KEY + ":").encode()).decode()

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

TARGET_STATES = ["MO", "KS"]


def scrape_one_property():
    """Fetch just the first MO/KS property from cjproperties.org."""
    session = _make_session()
    params = {
        "command": "search_result",
        "corpid": RM_CORP_ID,
        "locations": RM_LOCATIONS_DEFAULT,
        "fromsearch": "fromsearch",
        "mode": "javaScript",
        "template": "searchresults",
        "unituserdef_Allow_on_websitene": "no",
        "maxperpage": "9999",
        "headerfooter": "false",
    }

    print("Fetching listings from Rent Manager API...")
    js_text = _fetch_with_retry(session, RM_SEARCH_URL, params=params, verbose=True)
    if js_text is None:
        sys.exit("ERROR: Failed to fetch search results")

    html_content = _extract_html_from_js(js_text)
    print("Retrieved {} bytes of HTML".format(len(html_content)))

    blocks = _extract_property_blocks(html_content)
    print("Found {} property blocks".format(len(blocks)))

    for block in blocks:
        unit_id = block["unitid"]
        block_html = block["html"]

        header = _extract_header(block_html)
        address = _extract_address(block_html)
        details = _extract_details(block_html)
        description = _extract_description(block_html)
        image_urls = _extract_image_urls(block_html)
        unit_url = _extract_unit_url(block_html)

        # Skip if not in target states
        if address.get("state") and address.get("state") not in TARGET_STATES:
            print("  [{}] SKIP (state {})".format(unit_id, address.get("state")))
            continue

        # Fetch detail page for more photos
        detail_html = _fetch_detail_html(session, unit_id, unit_url, verbose=True)
        if detail_html:
            detail_images = _extract_image_urls_from_detail_html(detail_html)
            if detail_images:
                seen = set(image_urls)
                for url in detail_images:
                    if url not in seen:
                        image_urls.append(url)
                        seen.add(url)
                print("  [{}] detail gallery added {} photo(s)".format(unit_id, len(detail_images)))

        print("  [{}] {} | ${}/mo | {} bed | {} photos".format(
            unit_id,
            "{} {}".format(address.get("street") or "?", address.get("city") or "?").strip(),
            details.get("rent"),
            details.get("beds"),
            len(image_urls),
        ))

        rec = _build_record(
            unit_id=unit_id,
            header=header,
            address=address,
            details=details,
            description=description,
            image_urls=image_urls,
            unit_url=unit_url,
        )
        if rec:
            print("\nSelected property:")
            print("  Address: {} {}, {} {}".format(
                rec.get("address"), rec.get("unit_number") or "",
                rec.get("city"), rec.get("state")))
            print("  Rent: ${}/mo | Beds: {} | Baths: {}".format(
                rec.get("monthly_rent"), rec.get("bedrooms"), rec.get("bathrooms")))
            print("  Photos: {}".format(len(json.loads(rec.get("original_image_urls") or "[]"))))
            print("  Score: {}".format(rec.get("data_quality_score")))
            return rec

        time.sleep(REQUEST_DELAY)

    sys.exit("ERROR: No MO/KS property found")


def upload_photo(url, folder, idx):
    """Download a photo from source URL and upload to ImageKit."""
    for attempt in range(1, 4):
        try:
            rd = requests.get(url, timeout=25, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
                "Referer": "https://cjproperties.org/",
            })
            if rd.status_code != 200 or not rd.content:
                print("    [{}] Download failed HTTP {}".format(idx + 1, rd.status_code))
                if attempt < 3:
                    time.sleep(2 * attempt)
                continue

            fname = "photo_{:02d}.jpg".format(idx + 1)
            r = requests.post(
                IK_UPLOAD_URL,
                headers={"Authorization": IK_AUTH},
                files={"file": (fname, rd.content, "image/jpeg")},
                data={"fileName": fname, "folder": folder},
                timeout=60,
            )
            if r.status_code == 200:
                url = r.json().get("url")
                if url:
                    return idx, url
            print("    [{}] ImageKit HTTP {} attempt {}: {}".format(
                idx + 1, r.status_code, attempt, r.text[:80]))
        except Exception as e:
            print("    [{}] Error attempt {}: {}".format(idx + 1, attempt, str(e)[:80]))
        if attempt < 3:
            time.sleep(2 * attempt)
    return idx, None


def main():
    print("=" * 65)
    print("CJ Properties - Test Publish ONE Property")
    print("=" * 65)

    # Step 1: Scrape one property
    print("\n-- Step 1: Scraping one property from cjproperties.org --")
    rec = scrape_one_property()

    # Step 2: Check if already published
    print("\n-- Step 2: Checking for existing record --")
    sid = rec.get("source_listing_id", "")
    try:
        r = requests.get(
            "{}/rest/v1/pipeline_properties?source_listing_id=eq.{}&select=id,source_listing_id,choice_property_id".format(
                SUPABASE_URL, urllib.parse.quote(sid)),
            headers=SB_PIPELINE_HEADERS,
            timeout=20,
        )
        if r.ok:
            existing = r.json()
            if existing and existing[0].get("choice_property_id"):
                print("  ALREADY PUBLISHED: {}".format(sid))
                print("  Property ID: {}".format(existing[0]["choice_property_id"]))
                print("  URL: {}/property?id={}".format(SITE_BASE_URL, existing[0]["choice_property_id"]))
                sys.exit(0)
            if existing:
                rec["id"] = existing[0]["id"]
                print("  Found existing staged record: {}".format(existing[0]["id"]))
            else:
                print("  No existing record - will create new")
    except Exception as e:
        print("  WARNING: check failed: {}".format(str(e)[:100]))

    # Step 3: Stage in pipeline_properties
    print("\n-- Step 3: Staging in pipeline_properties --")
    pipeline_id = rec.get("id") or "PP-" + uuid.uuid4().hex[:8].upper()
    rec["id"] = pipeline_id

    rec.setdefault("application_fee", None)
    rec.setdefault("security_deposit", None)
    rec.setdefault("minimum_lease_months", None)
    rec.setdefault("lease_terms", "[]")
    rec.setdefault("amenities", "[]")
    rec.setdefault("appliances", "[]")
    rec.setdefault("utilities_included", "[]")
    rec.setdefault("flooring", "[]")
    rec.setdefault("local_image_paths", "[]")
    rec.setdefault("edited_fields", "[]")
    rec.setdefault("inferred_features", "[]")
    rec.setdefault("original_data", json.dumps({"_source": "cjproperties"}))

    try:
        r = requests.post(
            "{}/rest/v1/pipeline_properties?on_conflict=source_listing_id".format(SUPABASE_URL),
            headers={**SB_PIPELINE_HEADERS, "Prefer": "return=representation,resolution=merge-duplicates"},
            data=json.dumps(rec, default=str).encode(),
            timeout=30,
        )
        if not r.ok:
            print("  ERROR: Stage failed: {} {}".format(r.status_code, r.text[:200]))
            sys.exit(1)
        staged = r.json()
        if isinstance(staged, list):
            staged = staged[0] if staged else {}
        staged_id = staged.get("id") or pipeline_id
        print("  Staged: {}".format(staged_id))
    except Exception as e:
        print("  ERROR: Stage exception: {}".format(str(e)[:100]))
        sys.exit(1)

    # Step 4: Publish via RPC
    print("\n-- Step 4: Publishing via RPC --")
    try:
        r = requests.post(
            "{}/rest/v1/rpc/pipeline_publish".format(SUPABASE_URL),
            headers=SB_HEADERS,
            json={"p_id": staged_id, "p_landlord_id": None},
            timeout=30,
        )
        if not r.ok:
            print("  ERROR: Publish RPC failed: {} {}".format(r.status_code, r.text[:200]))
            sys.exit(1)
        rpc_data = r.json()
        if isinstance(rpc_data, list):
            rpc_data = rpc_data[0] if rpc_data else {}
        if rpc_data.get("ok") is False:
            print("  ERROR: RPC returned ok=false: {}".format(rpc_data.get("error", "unknown")))
            sys.exit(1)
        prop_id = (
            rpc_data.get("choice_property_id")
            or rpc_data.get("property_id")
            or rpc_data.get("id")
        )
        if not prop_id:
            print("  ERROR: Could not extract property_id from RPC response")
            sys.exit(1)
        print("  Published: property_id={}".format(prop_id))
    except Exception as e:
        print("  ERROR: Publish exception: {}".format(str(e)[:100]))
        sys.exit(1)

    # Step 5: Activate
    print("\n-- Step 5: Activating --")
    try:
        r = requests.patch(
            "{}/rest/v1/properties?id=eq.{}".format(SUPABASE_URL, urllib.parse.quote(str(prop_id))),
            headers=SB_HEADERS,
            json={"status": "active"},
            timeout=15,
        )
        if r.ok:
            print("  Activated")
        else:
            print("  WARNING: activation failed: {}".format(r.text[:100]))
    except Exception as e:
        print("  WARNING: activation exception: {}".format(str(e)[:80]))

    # Step 6: Upload photos to ImageKit
    print("\n-- Step 6: Uploading photos to ImageKit --")
    src_urls = []
    try:
        src_urls = json.loads(rec.get("original_image_urls") or "[]")
    except Exception:
        pass

    if not src_urls:
        print("  WARNING: No source photos available")
    else:
        ik_folder = "/properties/{}".format(prop_id)
        upload_candidates = src_urls[:50]
        print("  Uploading {} photo(s)...".format(len(upload_candidates)))
        uploaded_urls = []
        with ThreadPoolExecutor(max_workers=min(4, max(1, len(upload_candidates)))) as ex:
            futures = {ex.submit(upload_photo, u, ik_folder, i): i for i, u in enumerate(upload_candidates)}
            for fut in as_completed(futures):
                i, url = fut.result()
                if url:
                    uploaded_urls.append((i, url))

        uploaded_urls.sort(key=lambda x: x[0])
        ik_urls = [u for _, u in uploaded_urls]

        if ik_urls:
            photo_rows = []
            addr = "{} {}".format(rec.get("address", ""), rec.get("city", "")).strip()
            for i, url in enumerate(ik_urls):
                photo_rows.append({
                    "property_id": str(prop_id),
                    "url": url,
                    "display_order": i,
                    "is_hero": i == 0,
                    "watermark_status": "pending",
                    "alt_text": "{} - photo {}".format(addr, i + 1),
                })
            try:
                r = requests.post(
                    "{}/rest/v1/property_photos".format(SUPABASE_URL),
                    headers={**SB_HEADERS, "Prefer": "return=minimal"},
                    data=json.dumps(photo_rows).encode(),
                    timeout=30,
                )
                if r.ok:
                    print("  Inserted {} photo row(s)".format(len(photo_rows)))
                else:
                    print("  WARNING: photo insert failed: {}".format(r.text[:100]))
            except Exception as e:
                print("  WARNING: photo insert exception: {}".format(str(e)[:80]))
        else:
            print("  WARNING: no photos uploaded to ImageKit")

    # Summary
    url = "{}/property?id={}".format(SITE_BASE_URL, prop_id)
    print("\n" + "=" * 65)
    print("SUCCESS!")
    print("=" * 65)
    print("Property: {} {}, {} {}".format(
        rec.get("address"), rec.get("unit_number") or "",
        rec.get("city"), rec.get("state")))
    print("Rent: ${}/mo | Beds: {} | Baths: {}".format(
        rec.get("monthly_rent"), rec.get("bedrooms"), rec.get("bathrooms")))
    print("Property ID: {}".format(prop_id))
    print("URL: {}".format(url))
    print("=" * 65)


if __name__ == "__main__":
    main()