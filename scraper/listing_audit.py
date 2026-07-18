#!/usr/bin/env python3
"""
Choice Properties -- Existing Listing Audit
============================================
Implements Rule 5 of the permanent pipeline spec:

  "Before every publishing batch, scan all existing published properties.
   If any published property contains watermarked images, broken ImageKit
   links, missing images, or placeholder images — remove or unpublish the
   listing until it complies."

This script is run automatically by the GitHub Actions daily audit workflow
(.github/workflows/existing-listing-audit.yml) and can also be run manually:

  python3 scraper/listing_audit.py
  python3 scraper/listing_audit.py --dry-run
  python3 scraper/listing_audit.py --fix           # unpublish failing listings
  python3 scraper/listing_audit.py --report-only   # print report, no writes

Checks performed per published listing:
  1. Has at least MIN_PHOTOS photos in property_photos table
  2. Every photo URL is accessible (HTTP HEAD check)
  3. All photo URLs are on ImageKit CDN (not raw source URLs)
  4. watermark_status is not 'flagged' (pending is OK, none is invalid)

Exit codes:
  0 — all listings compliant
  1 — non-compliant listings found (details printed to stdout)
  2 — script error / misconfiguration
"""

import os
import sys
import json
import time
import logging
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger("listing_audit")

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _SCRIPT_DIR)


def _load_dotenv():
    for candidate in [".env", "../.env",
                      os.path.join(_SCRIPT_DIR, ".env"),
                      os.path.join(_SCRIPT_DIR, "../.env")]:
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


_load_dotenv()

try:
    import requests as _req
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
    _REQUESTS_OK = True
except ImportError:
    sys.exit("ERROR: requests not installed -- pip install requests")

# ---------------------------------------------------------------------------
# Config — FIX H1: no hardcoded Supabase URL default; fail fast if unset
# ---------------------------------------------------------------------------
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
IMAGEKIT_DOMAIN = "ik.imagekit.io"

MIN_PHOTOS = 6
URL_CHECK_WORKERS = 8
URL_CHECK_TIMEOUT = 8     # seconds per HEAD request
PAGE_SIZE = 200           # listings per Supabase page

if not SUPABASE_URL:
    sys.exit("ERROR: SUPABASE_URL not set.")
if not SERVICE_ROLE_KEY:
    sys.exit("ERROR: SUPABASE_SERVICE_ROLE_KEY not set.")

# ---------------------------------------------------------------------------
# HTTP session
# ---------------------------------------------------------------------------

def _make_session():
    s = _req.Session()
    retry = Retry(total=3, backoff_factor=0.5, status_forcelist=[500, 502, 503, 504],
                  allowed_methods=["GET", "POST", "PATCH"])
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.headers.update({
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": "Bearer " + SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Prefer": "return=representation",
    })
    return s


_session = _make_session()

# ---------------------------------------------------------------------------
# Data fetching
# ---------------------------------------------------------------------------

def fetch_active_properties() -> List[Dict]:
    """Fetch all active published properties (paginated)."""
    properties = []
    offset = 0
    while True:
        r = _session.get(
            "{}/rest/v1/properties"
            "?status=eq.active"
            "&select=id,title,address,city,state,status"
            "&limit={}&offset={}".format(SUPABASE_URL, PAGE_SIZE, offset),
            timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        properties.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
        time.sleep(0.2)
    return properties


def fetch_property_photos(property_id: str) -> List[Dict]:
    """Fetch all photos for a property from property_photos."""
    r = _session.get(
        "{}/rest/v1/property_photos"
        "?property_id=eq.{}"
        "&select=id,url,display_order,is_hero,watermark_status"
        "&order=display_order.asc&limit=50".format(SUPABASE_URL, property_id),
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------------------
# Photo checks
# ---------------------------------------------------------------------------

def _check_url(url: str) -> Tuple[str, bool, int]:
    """
    HEAD-check a URL. Returns (url, is_accessible, status_code).
    Falls back to a streaming GET if HEAD returns 405 (some CDNs block HEAD).
    """
    try:
        r = _req.head(url, timeout=URL_CHECK_TIMEOUT, allow_redirects=True,
                      headers={"User-Agent": "ChoiceProperties-Audit/1.0"})
        if r.status_code == 405:
            # FIX L16: Fallback to GET with stream=True for CDNs that block HEAD
            r = _req.get(url, timeout=URL_CHECK_TIMEOUT, allow_redirects=True, stream=True,
                         headers={"User-Agent": "ChoiceProperties-Audit/1.0"})
        return url, r.status_code < 400, r.status_code
    except Exception:
        return url, False, 0


def check_photos(photos: List[Dict]) -> List[str]:
    """
    Run all photo checks. Returns list of failure reasons (empty = pass).
    Checks: count, ImageKit CDN, URL accessibility, watermark_status.
    """
    failures = []

    if len(photos) < MIN_PHOTOS:
        failures.append("Only {}/{} photos in DB".format(len(photos), MIN_PHOTOS))

    if not photos:
        return failures

    # Check each URL
    urls = [p.get("url", "") for p in photos if p.get("url")]

    # ImageKit CDN check — no raw source URLs allowed
    non_ik = [u for u in urls if IMAGEKIT_DOMAIN not in u]
    if non_ik:
        failures.append("{} non-ImageKit URL(s): {}".format(
            len(non_ik), non_ik[0][:60]))

    # Watermark status check
    flagged = [p for p in photos if p.get("watermark_status") == "flagged"]
    if flagged:
        failures.append("{} photo(s) flagged as watermarked".format(len(flagged)))

    # Accessibility check (parallel HEAD requests)
    results = {}
    with ThreadPoolExecutor(max_workers=URL_CHECK_WORKERS) as ex:
        futs = {ex.submit(_check_url, u): u for u in urls}
        for fut in as_completed(futs):
            url, accessible, code = fut.result()
            results[url] = (accessible, code)

    broken = [u for u, (ok, _) in results.items() if not ok]
    if broken:
        failures.append("{} broken/inaccessible photo URL(s)".format(len(broken)))

    return failures


# ---------------------------------------------------------------------------
# Remediation
# ---------------------------------------------------------------------------

def unpublish_property(property_id: str) -> bool:
    """Set status=needs_review so the listing is hidden until fixed."""
    r = _session.patch(
        "{}/rest/v1/properties?id=eq.{}".format(SUPABASE_URL, property_id),
        json={"status": "needs_review"},
        timeout=15,
    )
    if not r.ok:
        logger.warning("unpublish_property: HTTP %d for %s — %s",
                       r.status_code, property_id, r.text[:200])
        return False

    # FIX M7: Validate response confirms status change, not just HTTP 200
    try:
        rows = r.json()
        if isinstance(rows, list) and rows:
            updated_status = rows[0].get("status")
            if updated_status != "needs_review":
                logger.warning(
                    "unpublish_property: property %s status is '%s', expected 'needs_review' — "
                    "possible RLS or trigger block",
                    property_id, updated_status,
                )
                return False
    except Exception as parse_err:
        logger.warning("unpublish_property: could not parse response for %s: %s",
                       property_id, parse_err)
        # r.ok was True, so HTTP succeeded — treat as best-effort success
    return True


def log_audit_action(property_id: str, failures: List[str], dry_run: bool):
    """Insert an audit log entry. Logs a warning if the insert fails."""
    try:
        r = _session.post(
            "{}/rest/v1/admin_actions".format(SUPABASE_URL),
            json={
                "action": "listing_audit",
                "entity_type": "property",
                "entity_id": property_id,
                "metadata": json.dumps({
                    "failures": failures,
                    "dry_run": dry_run,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "source": "listing_audit.py",
                }),
            },
            timeout=10,
        )
        if not r.ok:
            # FIX M6: No longer swallows silently — warns if logging fails
            logger.warning("log_audit_action: failed to insert admin_action for %s — HTTP %d: %s",
                           property_id, r.status_code, r.text[:200])
    except Exception as e:
        # FIX M6: Log the failure rather than silently passing
        logger.warning("log_audit_action: exception for %s: %s", property_id, str(e)[:200])


# ---------------------------------------------------------------------------
# Main audit
# ---------------------------------------------------------------------------

def run_audit(dry_run: bool = False, fix: bool = False, report_only: bool = False) -> int:
    """
    Run the full existing listing audit.
    Returns number of non-compliant listings found.
    """
    print("=" * 65)
    print("Choice Properties — Existing Listing Audit")
    print("Mode: {} | Time: {}".format(
        "DRY RUN" if dry_run else ("FIX" if fix else "REPORT ONLY"),
        datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")))
    print("=" * 65)

    print("\nFetching active properties...")
    try:
        properties = fetch_active_properties()
    except Exception as e:
        print("ERROR: Could not fetch properties: {}".format(e))
        return -1

    print("Found {} active listings to audit.\n".format(len(properties)))

    non_compliant = []
    compliant_count = 0

    for i, prop in enumerate(properties, 1):
        prop_id = prop.get("id")
        addr = "{} {}".format(prop.get("address", ""), prop.get("city", "")).strip()
        title = prop.get("title", addr)

        if i % 25 == 0:
            print("  Progress: {}/{} checked ({} issues so far)...".format(
                i, len(properties), len(non_compliant)))

        try:
            photos = fetch_property_photos(prop_id)
        except Exception as e:
            print("  WARNING: Could not fetch photos for {}: {}".format(prop_id, e))
            continue

        failures = check_photos(photos)

        if failures:
            non_compliant.append((prop_id, title, addr, failures))
            print("  [FAIL] {}".format(addr))
            for f in failures:
                print("         - {}".format(f))

            if not report_only:
                log_audit_action(prop_id, failures, dry_run)

            if fix and not dry_run:
                ok = unpublish_property(prop_id)
                if ok:
                    print("         -> unpublished (status=needs_review)")
                else:
                    print("         -> WARNING: failed to unpublish — check logs")
        else:
            compliant_count += 1

    # Summary
    print("\n" + "=" * 65)
    print("AUDIT SUMMARY")
    print("=" * 65)
    print("Total checked      : {}".format(len(properties)))
    print("Compliant          : {}".format(compliant_count))
    print("Non-compliant      : {}".format(len(non_compliant)))

    if non_compliant:
        print("\nNon-compliant listings:")
        for prop_id, title, addr, failures in non_compliant:
            print("  {} ({})".format(addr, prop_id))
            for f in failures:
                print("    - {}".format(f))
        if not fix and not report_only and not dry_run:
            print("\nRun with --fix to unpublish non-compliant listings.")
    else:
        print("\nAll published listings are compliant.")

    print("=" * 65)
    return len(non_compliant)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Choice Properties existing listing audit")
    ap.add_argument("--dry-run", action="store_true",
                    help="Check and log but do not write to DB")
    ap.add_argument("--fix", action="store_true",
                    help="Unpublish (status=needs_review) non-compliant listings")
    ap.add_argument("--report-only", action="store_true",
                    help="Print report only, no DB writes at all")
    args = ap.parse_args()

    count = run_audit(dry_run=args.dry_run, fix=args.fix, report_only=args.report_only)
    if count < 0:
        sys.exit(2)
    sys.exit(1 if count > 0 else 0)


if __name__ == "__main__":
    main()
