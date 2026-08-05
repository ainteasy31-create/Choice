#!/usr/bin/env python3
"""
opendoor_run_2.py — Scrape exactly 2 Opendoor listings and run the full pipeline.

Fetches live listing URLs from the Opendoor sitemap via curl_cffi (same
TLS-impersonation used for listing pages), scrapes TARGET_COUNT properties,
enriches, publishes, and verifies that EVERY expected photo is on ImageKit
before exiting successfully.

Exit codes:
  0 — TARGET_COUNT properties published with all expected photos on ImageKit
  1 — any failure (insufficient scraped records, publish error, photo shortfall)
"""

import sys
import os
import re
import time
import json

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

# Load .env from scraper/ or repo root
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

# Use curl_cffi for all HTTP — Opendoor blocks plain requests via TLS fingerprinting
try:
    from curl_cffi import requests as _http
    _IMPERSONATE = "chrome110"
    print("[setup] Using curl_cffi (chrome110 impersonation)")
except ImportError:
    import requests as _http
    _IMPERSONATE = None
    print("[setup] WARNING: curl_cffi not available — falling back to requests (may be blocked)")

try:
    import requests as _rq  # for Supabase queries (no impersonation needed)
except ImportError:
    _rq = _http

SITEMAP_URL = "https://www.opendoor.com/sitemaps/listings.xml"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.google.com/",
}

TARGET_COUNT  = 2
IK_MAX_PHOTOS = 50   # must match pipeline.py IK_MAX_PHOTOS


def _get(url, timeout=30):
    """Fetch url using curl_cffi Chrome impersonation when available."""
    if _IMPERSONATE:
        return _http.get(url, headers=HEADERS, timeout=timeout, impersonate=_IMPERSONATE)
    return _http.get(url, headers=HEADERS, timeout=timeout)


def get_sitemap_urls(n=60):
    """Fetch the Opendoor listings sitemap and return up to n property URLs.
    Uses the same impersonated client so TLS fingerprint is consistent."""
    print("[setup] Fetching Opendoor listings sitemap...")
    resp = _get(SITEMAP_URL, timeout=30)
    resp.raise_for_status()
    urls = re.findall(r"<loc>(https://www\.opendoor\.com/properties/[^<]+)</loc>", resp.text)
    print("[setup] Found {} total listing URLs in sitemap".format(len(urls)))
    if not urls:
        raise RuntimeError(
            "Sitemap returned 0 property URLs — check connectivity or sitemap format."
        )
    return urls[:n]


def _count_expected_photos(rec):
    """
    Mirror the pipeline's dedup + cap logic to compute how many photos
    should land on ImageKit for this record.
    """
    raw = rec.get("original_image_urls", "[]")
    try:
        src = json.loads(raw) if isinstance(raw, str) else list(raw)
    except Exception:
        return 0
    seen = set()
    count = 0
    for u in src:
        base = re.sub(r"(od-w\d+_h\d+_x\d+\.webp.*|s\.jpg)$", "", u.split("?")[0])
        if base in seen or u.endswith("s.jpg"):
            continue
        seen.add(base)
        count += 1
        if count >= IK_MAX_PHOTOS:
            break
    return count


def _verify_photos_on_imagekit(prop_id, expected):
    """Query property_photos and assert actual count == expected.
    Returns (actual_count, ok_bool, message)."""
    SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
    KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not SUPABASE_URL or not KEY:
        return 0, False, "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set"
    H = {"apikey": KEY, "Authorization": "Bearer " + KEY}
    try:
        r = _rq.get(
            "{}/rest/v1/property_photos".format(SUPABASE_URL),
            headers=H,
            params={"select": "id", "property_id": "eq.{}".format(prop_id)},
            timeout=15,
        )
        actual = len(r.json()) if isinstance(r.json(), list) else 0
    except Exception as e:
        return 0, False, "DB query failed: {}".format(e)
    ok = actual >= expected
    msg = "{}/{} photos in DB".format(actual, expected)
    return actual, ok, msg


def _extract_prop_id(published_url):
    """Extract UUID from a published property URL."""
    m = re.search(r"[?&]id=([a-f0-9\-]{36})", published_url)
    return m.group(1) if m else None


def main():
    print("=" * 65)
    print("Choice Properties — Opendoor 2-Property Run")
    print("=" * 65)

    # ── Step 1: Get candidate URLs from sitemap ───────────────────────
    candidate_urls = get_sitemap_urls(n=60)

    # ── Step 2: Scrape until TARGET_COUNT valid records collected ─────
    from opendoor_scraper import scrape_opendoor_url

    records = []
    print("\n[scrape] Trying URLs until {} valid records scraped...".format(TARGET_COUNT))

    for url in candidate_urls:
        if len(records) >= TARGET_COUNT:
            break

        print("\n[scrape] -> {}".format(url))
        rec = scrape_opendoor_url(url, verbose=True)

        if rec is None:
            print("[scrape]    FAILED — scraper returned None")
            time.sleep(1.5)
            continue

        addr = "{}, {} {}".format(
            rec.get("address", "?"), rec.get("city", "?"), rec.get("state", "?"))
        score = rec.get("data_quality_score", 0)
        expected = _count_expected_photos(rec)
        rent = rec.get("monthly_rent")

        print("[scrape]    OK: {}".format(addr))
        print("[scrape]       score={} | expected_photos={} | est_rent=${}/mo".format(
            score, expected, rent))

        if expected < 6:
            print("[scrape]    SKIP — only {} deduped photos after cap (min 6)".format(expected))
            time.sleep(1.5)
            continue

        records.append(rec)
        print("[scrape]    Accepted ({}/{})".format(len(records), TARGET_COUNT))
        time.sleep(1.5)

    # Hard gate: abort without publishing if we couldn't collect enough records
    if len(records) < TARGET_COUNT:
        print("\nERROR: Only {}/{} valid Opendoor records scraped — aborting without publishing.".format(
            len(records), TARGET_COUNT))
        sys.exit(1)

    # Compute expected photo totals per record before the pipeline mutates them
    expected_per_record = [_count_expected_photos(r) for r in records]
    expected_total = sum(expected_per_record)

    print("\n[pre-pipeline] Expected photos per listing:")
    for rec, exp in zip(records, expected_per_record):
        addr = "{}, {}".format(rec.get("address", "?"), rec.get("city", "?"))
        print("  {} — {} photos".format(addr, exp))
    print("  Total expected on ImageKit: {}".format(expected_total))

    # ── Step 3: Full pipeline ─────────────────────────────────────────
    from pipeline import PipelineOrchestrator

    orchestrator = PipelineOrchestrator(verbose=True)
    result = orchestrator.run_records(
        records=records,
        batch_name="Opendoor 2-Property Run",
        dry_run=False,
    )

    print("\n" + "=" * 65)
    print("PIPELINE SUMMARY")
    print("=" * 65)
    print(result.summary() if hasattr(result, "summary") else str(result))

    # ── Step 4: Verify publish count ─────────────────────────────────
    if result.published < TARGET_COUNT:
        print("\nERROR: Only {}/{} properties published.".format(result.published, TARGET_COUNT))
        sys.exit(1)

    # ── Step 5: Verify photo counts per published property ────────────
    print("\n[verify] Checking photos on ImageKit per property...")
    all_ok = True
    for published_url, expected in zip(result.published_urls, expected_per_record):
        prop_id = _extract_prop_id(published_url)
        if not prop_id:
            print("  ERROR: could not parse prop_id from {}".format(published_url))
            all_ok = False
            continue
        actual, ok, msg = _verify_photos_on_imagekit(prop_id, expected)
        status = "OK" if ok else "FAIL"
        print("  [{}] {} — {}".format(status, prop_id[:8], msg))
        if not ok:
            all_ok = False

    # Also check aggregate pipeline counters
    if result.photos_failed > 0:
        print("\n  WARNING: pipeline reported {} upload failure(s)".format(result.photos_failed))
        all_ok = False

    if not all_ok:
        print("\nERROR: Photo verification failed — not all photos landed on ImageKit.")
        sys.exit(1)

    print("\nDone. {}/{} properties published, {}/{} photos verified on ImageKit.".format(
        result.published, TARGET_COUNT, result.photos_ok, expected_total))


if __name__ == "__main__":
    main()
