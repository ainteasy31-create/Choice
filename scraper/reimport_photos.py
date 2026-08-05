#!/usr/bin/env python3
"""
reimport_photos.py — Non-destructive full photo re-import for published properties.

Algorithm (safe / atomic):
  1. Re-scrape the original Opendoor URL to recover source photo URLs.
     → Aborts immediately (non-zero exit) if scrape returns 0 photos.
  2. Upload ALL source photos to ImageKit concurrently.
     → Collects results WITHOUT touching the existing property_photos rows.
  3. Only when every upload has succeeded, delete old DB rows and insert
     the new ImageKit URLs in display_order.
     → Any upload failure leaves the existing gallery untouched.

Exit codes:
  0 — all properties re-imported with complete photo sets
  1 — any source-scrape failure, upload failure, or DB error
"""
import sys, os, json, time, re, base64
from concurrent.futures import ThreadPoolExecutor, as_completed

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

# Load .env from scraper/ dir or repo root
def _load_dotenv():
    for candidate in [
        os.path.join(_SCRIPT_DIR, ".env"),
        os.path.join(_SCRIPT_DIR, "../.env"),
        ".env",
    ]:
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
except ImportError:
    sys.exit("requests not available")

SUPABASE_URL  = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY           = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
IK_KEY        = os.environ.get("IMAGEKIT_PRIVATE_KEY", "")
IK_AUTH       = "Basic " + base64.b64encode((IK_KEY + ":").encode()).decode() if IK_KEY else ""
IK_UPLOAD_URL = "https://upload.imagekit.io/api/v1/files/upload"

SB_HEADERS = {
    "apikey": KEY,
    "Authorization": "Bearer " + KEY,
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}

IK_MAX_PHOTOS = 50   # must match pipeline.py
IK_MAX_WORKERS = 8
IK_MAX_RETRIES = 3
RETRY_BACKOFF  = 2.0

# Properties to re-import: prop_id → original Opendoor listing URL
TARGETS = {
    "05235e4d-baba-48ba-a0c6-d9cca834dafd":
        "https://www.opendoor.com/properties/5082-Sw-31st-St-Ocala-FL-34474"
        "/aid_d04fba97-26ad-5730-b1b3-da7ebb3c349d",
    "17486211-72ba-437b-920b-b62c1c02fe0e":
        "https://www.opendoor.com/properties/19745-E-Raven-Dr-Queen-Creek-AZ-85142"
        "/aid_1f497f03-3ac0-5cc1-9da0-396a513f2504",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def scrape_source_urls(listing_url):
    """Re-scrape an Opendoor page; return (address_str, [url, ...]).
    Returns (None, []) on failure — caller must treat empty list as a hard error."""
    from opendoor_scraper import scrape_opendoor_url
    rec = scrape_opendoor_url(listing_url, verbose=True)
    if rec is None:
        return None, []
    addr = "{}, {} {}".format(
        rec.get("address", "?"), rec.get("city", "?"), rec.get("state", "?"))
    raw = rec.get("original_image_urls", "[]")
    try:
        urls = json.loads(raw) if isinstance(raw, str) else list(raw)
    except Exception:
        urls = []
    return addr, [u for u in urls if u]


def dedup_cap(urls):
    """Mirror the pipeline's dedup + IK_MAX_PHOTOS cap."""
    seen, out = set(), []
    for u in urls:
        base = re.sub(r"(od-w\d+_h\d+_x\d+\.webp.*|s\.jpg)$", "", u.split("?")[0])
        if base in seen or u.endswith("s.jpg"):
            continue
        seen.add(base)
        out.append(u)
        if len(out) >= IK_MAX_PHOTOS:
            break
    return out


def upload_one(idx, url, prop_id):
    """Upload a single image to ImageKit. Returns (idx, ik_url, file_id, err)."""
    folder = "/properties/{}".format(prop_id)
    for attempt in range(1, IK_MAX_RETRIES + 1):
        try:
            rd = _req.get(url, timeout=25,
                          headers={"User-Agent": "Mozilla/5.0 Chrome/131"})
            if rd.status_code != 200 or not rd.content:
                if attempt < IK_MAX_RETRIES:
                    time.sleep(RETRY_BACKOFF * attempt)
                continue
            ct = rd.headers.get("Content-Type", "")
            if ct and not ct.lower().startswith("image/"):
                return idx, None, None, "non-image content-type: {}".format(ct[:40])
            ext   = "webp" if ("webp" in ct or ".webp" in url) else "jpg"
            fname = "photo_{:02d}.{}".format(idx + 1, ext)
            ru = _req.post(
                IK_UPLOAD_URL,
                headers={"Authorization": IK_AUTH},
                files={"file": (fname, rd.content, "image/{}".format(ext))},
                data={"fileName": fname, "folder": folder},
                timeout=60,
            )
            if ru.status_code == 200:
                d = ru.json()
                return idx, d.get("url"), d.get("fileId"), None
            if attempt < IK_MAX_RETRIES:
                time.sleep(RETRY_BACKOFF * attempt)
        except Exception:
            if attempt < IK_MAX_RETRIES:
                time.sleep(RETRY_BACKOFF * attempt)
    return idx, None, None, "exhausted {} retries".format(IK_MAX_RETRIES)


_STAGING_OFFSET = 1000   # display_order offset for staging rows


def _delete_staging(prop_id):
    """Best-effort cleanup of any staging rows left over from a failed swap."""
    _req.delete(
        "{}/rest/v1/property_photos".format(SUPABASE_URL),
        headers=SB_HEADERS,
        params={
            "property_id":   "eq.{}".format(prop_id),
            "display_order": "gte.{}".format(_STAGING_OFFSET),
        },
        timeout=15,
    )


def swap_db_rows(prop_id, results_by_idx):
    """
    Safe, compensating-rollback row replacement:

    Phase 1 — Insert new rows at staging offsets (display_order = 1000+idx).
               The old gallery rows (display_order < 1000) are untouched.
               If any staging insert fails → delete all staging rows → return
               error; old gallery remains intact.

    Phase 2 — Delete old rows (display_order < 1000).
               If DELETE fails → delete staging rows → return error;
               old gallery remains intact.

    Phase 3 — PATCH staging rows to final display_order (0, 1, 2, …).
               If any PATCH fails the data is already present (just at the
               wrong order index); return a partial-success error so the
               caller can surface it, but the gallery is usable.

    Returns (inserted_count, error_str_or_None).
    """
    # ── Phase 1: insert at staging offsets ───────────────────────────
    staged = set()
    failed_stage = []

    for idx in sorted(results_by_idx.keys()):
        ik_url, file_id = results_by_idx[idx]
        ri = _req.post(
            "{}/rest/v1/property_photos".format(SUPABASE_URL),
            headers=SB_HEADERS,
            json={
                "property_id":      prop_id,
                "url":              ik_url,
                "file_id":          file_id or "",
                "display_order":    _STAGING_OFFSET + idx,
                "is_hero":          False,   # finalized in Phase 3
                "watermark_status": "pending",
            },
            timeout=15,
        )
        if ri.status_code in (200, 201):
            staged.add(idx)
        else:
            failed_stage.append(
                "INSERT stage[{}]: {} {}".format(idx, ri.status_code, ri.text[:60]))

    if failed_stage:
        _delete_staging(prop_id)
        return 0, (
            "{} staging inserts failed — staging rows cleaned up, "
            "old gallery preserved: {}".format(len(failed_stage), "; ".join(failed_stage[:3]))
        )

    # ── Phase 2: delete old rows ──────────────────────────────────────
    rd = _req.delete(
        "{}/rest/v1/property_photos".format(SUPABASE_URL),
        headers=SB_HEADERS,
        params={
            "property_id":   "eq.{}".format(prop_id),
            "display_order": "lt.{}".format(_STAGING_OFFSET),
        },
        timeout=15,
    )
    if rd.status_code not in (200, 204):
        _delete_staging(prop_id)
        return 0, (
            "DELETE old rows failed ({} {}); staging rows cleaned up, "
            "old gallery preserved".format(rd.status_code, rd.text[:60])
        )

    # ── Phase 3: move staging rows to final display_order ────────────
    failed_patch = []
    for idx in sorted(results_by_idx.keys()):
        rp = _req.patch(
            "{}/rest/v1/property_photos".format(SUPABASE_URL),
            headers={**SB_HEADERS, "Prefer": "return=minimal"},
            params={
                "property_id":   "eq.{}".format(prop_id),
                "display_order": "eq.{}".format(_STAGING_OFFSET + idx),
            },
            json={"display_order": idx, "is_hero": idx == 0},
            timeout=15,
        )
        if rp.status_code not in (200, 204):
            failed_patch.append(idx)

    if failed_patch:
        # Data is present on ImageKit and in DB; only the order index is wrong.
        return len(staged), (
            "PATCH reorder failed for {} rows — photos uploaded and in DB "
            "but display_order may be offset by {}".format(
                len(failed_patch), _STAGING_OFFSET)
        )

    return len(staged), None


# ---------------------------------------------------------------------------
# Per-property re-import
# ---------------------------------------------------------------------------

def reimport(prop_id, listing_url):
    """
    Re-import all photos for one property.
    Returns (uploaded_count, failed_count, error_str_or_None).
    """
    # 1. Re-scrape
    print("  Re-scraping listing page...")
    addr, src_urls = scrape_source_urls(listing_url)
    if not src_urls:
        msg = "re-scrape returned 0 photos — aborting (existing gallery preserved)"
        print("  ERROR: {}".format(msg))
        return 0, 0, msg

    photo_urls = dedup_cap(src_urls)
    print("  {} source photos → {} to upload (cap={})".format(
        len(src_urls), len(photo_urls), IK_MAX_PHOTOS))

    # 2. Upload ALL to ImageKit — do NOT touch DB yet
    print("  Uploading to ImageKit ({} workers)...".format(IK_MAX_WORKERS))
    results   = {}   # idx -> (ik_url, file_id)
    failures  = {}   # idx -> err_str

    with ThreadPoolExecutor(max_workers=IK_MAX_WORKERS) as ex:
        futs = {ex.submit(upload_one, i, u, prop_id): i
                for i, u in enumerate(photo_urls)}
        for fut in as_completed(futs):
            idx, ik_url, file_id, err = fut.result()
            if ik_url:
                results[idx] = (ik_url, file_id or "")
            else:
                failures[idx] = err or "unknown error"
                print("  WARNING photo[{}]: {}".format(idx + 1, err))

    if failures:
        n_fail = len(failures)
        msg = ("{} of {} uploads failed — "
               "existing gallery preserved, no DB changes made").format(
               n_fail, len(photo_urls))
        print("  ERROR: {}".format(msg))
        return len(results), n_fail, msg

    # 3. All uploads succeeded — now atomically swap DB rows
    print("  All {} uploads OK — swapping DB rows...".format(len(results)))
    inserted, err = swap_db_rows(prop_id, results)
    if err:
        print("  ERROR: DB swap failed: {}".format(err))
        return inserted, 0, "DB swap failed: {}".format(err)

    hero_url = results.get(0, (None, None))[0]
    if hero_url:
        print("  hero → {}".format(hero_url))
    print("  Done: {}/{} photos in DB".format(inserted, len(photo_urls)))
    return inserted, 0, None


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    print("=" * 65)
    print("Choice Properties — Full Photo Re-import (IK_MAX_PHOTOS={})".format(IK_MAX_PHOTOS))
    print("=" * 65)

    if not SUPABASE_URL or not KEY or not IK_KEY:
        sys.exit(
            "ERROR: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, "
            "IMAGEKIT_PRIVATE_KEY must be set"
        )

    total_ok = total_fail = 0
    errors   = []

    for prop_id, listing_url in TARGETS.items():
        print("\n[{}]  {}".format(prop_id[:8], listing_url.split("/")[-2].replace("-", " ")))
        ok, fail, err = reimport(prop_id, listing_url)
        total_ok   += ok
        total_fail += fail
        if err:
            errors.append("{}: {}".format(prop_id[:8], err))
        time.sleep(2)

    print("\n" + "=" * 65)
    print("Done. Total: {} photos uploaded, {} failed.".format(total_ok, total_fail))
    if errors:
        print("\nErrors:")
        for e in errors:
            print("  - {}".format(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
