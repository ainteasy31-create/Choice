#!/usr/bin/env python3
"""
Choice Properties -- ImageKit Upload Module
===========================================
Uploads scraped property images to ImageKit CDN.

This is PERMANENT scraper infrastructure. Every future scraping job calls
this module automatically. Do NOT remove or bypass it.

For every listing, this module:
  1. Downloads each source image (Zillow/Realtor CDN)
  2. Uploads it to ImageKit's API
  3. Verifies each ImageKit URL is accessible
  4. Returns the final ImageKit URL list (preserving original order)
  5. Retries failed uploads automatically (up to MAX_UPLOAD_RETRIES)
  6. Logs failures instead of silently dropping images

Required environment variables (.env or shell):
  IMAGEKIT_PRIVATE_KEY   -- ImageKit private API key (find in ImageKit dashboard)
  IMAGEKIT_URL_ENDPOINT  -- e.g. https://ik.imagekit.io/yourID

If these vars are not set, upload is skipped gracefully and the caller
falls back to storing original source URLs.

iSH / Python 3.9 compatibility:
  * No walrus operator (:=)
  * No f-strings (print() calls use .format() or + concatenation)
  * No match/case
"""

import os
import re
import time
import base64
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests as _req
    _REQUESTS_OK = True
except ImportError:
    _REQUESTS_OK = False

# -- Constants -----------------------------------------------------------------

IMAGEKIT_UPLOAD_URL  = "https://upload.imagekit.io/api/v1/files/upload"
VERIFY_TIMEOUT       = 10    # seconds for HEAD check per URL
UPLOAD_TIMEOUT       = 45    # seconds per upload request
DOWNLOAD_TIMEOUT     = 25    # seconds per image download
MAX_UPLOAD_RETRIES   = 3     # retry count per image (total attempts = retries + 1)
RETRY_BACKOFF        = 2.0   # base seconds between retries (multiplied by attempt #)
MAX_WORKERS          = 4     # concurrent upload threads
MAX_IMAGE_BYTES      = 20 * 1024 * 1024  # 20 MB hard cap per image

logger = logging.getLogger("imagekit_upload")


# -- Credential helpers --------------------------------------------------------

def _get_credentials():
    """Return (private_key, url_endpoint) from environment variables."""
    key      = os.environ.get("IMAGEKIT_PRIVATE_KEY", "").strip()
    endpoint = os.environ.get("IMAGEKIT_URL_ENDPOINT", "").strip().rstrip("/")
    return key, endpoint


def is_configured():
    """Return True if both required ImageKit env vars are set."""
    key, endpoint = _get_credentials()
    return bool(key and endpoint)


# -- Path helpers --------------------------------------------------------------

def _make_folder(listing_id):
    """
    Derive a clean ImageKit folder path from a pipeline listing ID.
    e.g. 'PP-A1B2C3D4' -> 'properties/PP-A1B2C3D4'
    """
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", str(listing_id or "unknown"))
    return "properties/" + safe


def _ext_from_url_or_content_type(url, content_type):
    """
    Derive file extension from URL path or Content-Type header.
    Falls back to 'jpg'.
    """
    ct = (content_type or "").lower()
    if "png" in ct:
        return "png"
    if "webp" in ct:
        return "webp"
    if "jpeg" in ct or "jpg" in ct:
        return "jpg"
    # Try URL path extension
    try:
        path = url.split("?")[0].rstrip("/")
        last = path.split("/")[-1]
        parts = last.rsplit(".", 1)
        if len(parts) == 2:
            ext = parts[-1].lower()
            if ext in ("jpg", "jpeg", "png", "webp"):
                return "jpg" if ext == "jpeg" else ext
    except Exception:
        pass
    return "jpg"


def _safe_filename(index, ext):
    """Return a safe, numbered filename for position `index` (0-based)."""
    return "photo_{:02d}.{}".format(index + 1, ext)


# -- Image download ------------------------------------------------------------

def _download_image(url):
    """
    Download an image from `url`.
    Returns (bytes_data, extension_str) or (None, None) on any failure.
    Hard-caps at MAX_IMAGE_BYTES to prevent memory exhaustion.
    """
    if not _REQUESTS_OK:
        return None, None
    try:
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/128.0.0.0 Safari/537.36"
            ),
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Referer": "https://www.zillow.com/",
        }
        r = _req.get(url, headers=headers, timeout=DOWNLOAD_TIMEOUT, stream=True)
        if r.status_code != 200:
            logger.debug("Download HTTP %d: %s", r.status_code, url[:80])
            return None, None

        ext = _ext_from_url_or_content_type(url, r.headers.get("Content-Type", ""))

        chunks = []
        total = 0
        for chunk in r.iter_content(chunk_size=65536):
            if chunk:
                total += len(chunk)
                if total > MAX_IMAGE_BYTES:
                    logger.warning("  [IK] Image exceeds 20 MB size cap — skipping: %s", url[:80])
                    return None, None
                chunks.append(chunk)
        return b"".join(chunks), ext

    except Exception as e:
        logger.debug("  [IK] Download error for %s: %s", url[:80], str(e)[:80])
        return None, None


# -- Upload one image ----------------------------------------------------------

def _upload_one(source_url, index, listing_id, private_key):
    """
    Download source_url and upload to ImageKit.
    Retries up to MAX_UPLOAD_RETRIES times on failure.
    Returns ImageKit URL string on success, or None after all retries exhausted.
    """
    folder = _make_folder(listing_id)

    for attempt in range(1, MAX_UPLOAD_RETRIES + 1):

        data, ext = _download_image(source_url)
        if data is None:
            logger.warning(
                "  [IK] image %d download failed (attempt %d/%d): %s",
                index + 1, attempt, MAX_UPLOAD_RETRIES, source_url[:80],
            )
            if attempt < MAX_UPLOAD_RETRIES:
                time.sleep(RETRY_BACKOFF * attempt)
            continue

        fname       = _safe_filename(index, ext)
        credentials = base64.b64encode((private_key + ":").encode()).decode()
        mime        = "image/jpeg" if ext == "jpg" else ("image/" + ext)

        try:
            files  = {"file": (fname, data, mime)}
            fields = {"fileName": fname, "folder": folder}
            r = _req.post(
                IMAGEKIT_UPLOAD_URL,
                headers={"Authorization": "Basic " + credentials},
                files=files,
                data=fields,
                timeout=UPLOAD_TIMEOUT,
            )
            if r.status_code == 200:
                ik_url = r.json().get("url")
                if ik_url:
                    return ik_url
                logger.warning(
                    "  [IK] Upload returned 200 but no URL for image %d (listing %s)",
                    index + 1, listing_id,
                )
            else:
                logger.warning(
                    "  [IK] Upload HTTP %d for image %d, attempt %d: %s",
                    r.status_code, index + 1, attempt, r.text[:120],
                )
        except Exception as e:
            logger.warning(
                "  [IK] Upload exception image %d attempt %d: %s",
                index + 1, attempt, str(e)[:100],
            )

        if attempt < MAX_UPLOAD_RETRIES:
            time.sleep(RETRY_BACKOFF * attempt)

    return None  # all attempts exhausted


# -- URL verification ----------------------------------------------------------

def _verify_url(url):
    """
    HEAD-check that an ImageKit URL is actually accessible.
    Returns True if the URL responds with HTTP < 400, False otherwise.
    Skips silently if requests is unavailable.
    """
    if not _REQUESTS_OK:
        return True  # cannot verify without requests -- assume ok
    try:
        r = _req.head(url, timeout=VERIFY_TIMEOUT, allow_redirects=True)
        return r.status_code < 400
    except Exception:
        return False


# -- Public entry point --------------------------------------------------------

def upload_images(source_urls, listing_id, verify=True, verbose=True):
    """
    Upload all images for a single listing to ImageKit. This is the permanent
    entry point called by the scraper pipeline for EVERY new listing.

    Rules enforced permanently:
      - First image becomes the featured image (position preserved)
      - All source images are uploaded (complete gallery)
      - Failed uploads are retried automatically
      - Each URL is verified accessible before being returned
      - Failures are logged; incomplete listings are NOT silently accepted

    Args:
        source_urls  : list of original image URLs (Zillow / Realtor CDN)
        listing_id   : pipeline record ID, e.g. 'PP-A1B2C3D4' (used as folder)
        verify       : if True, HEAD-check each ImageKit URL before returning
        verbose      : if True, print progress to stdout

    Returns:
        (imagekit_urls, failed_count)
          imagekit_urls -- ordered list of verified ImageKit URLs
          failed_count  -- count of images that could not be uploaded or verified
    """
    if not source_urls:
        return [], 0

    if not _REQUESTS_OK:
        if verbose:
            print("  [IK] requests not installed -- skipping ImageKit upload")
        return [], len(source_urls)

    private_key, url_endpoint = _get_credentials()
    if not private_key:
        if verbose:
            print("  [IK] IMAGEKIT_PRIVATE_KEY not set -- skipping upload")
        return [], len(source_urls)
    if not url_endpoint:
        if verbose:
            print("  [IK] IMAGEKIT_URL_ENDPOINT not set -- skipping upload")
        return [], len(source_urls)

    if verbose:
        print("  [IK] Uploading " + str(len(source_urls)) + " image(s) for " + str(listing_id) + " ...")

    # Upload all images concurrently (order preserved via index)
    results = [None] * len(source_urls)
    workers = min(MAX_WORKERS, len(source_urls))

    with ThreadPoolExecutor(max_workers=workers) as ex:
        future_map = {
            ex.submit(_upload_one, url, i, listing_id, private_key): i
            for i, url in enumerate(source_urls)
        }
        for fut in as_completed(future_map):
            idx = future_map[fut]
            try:
                results[idx] = fut.result()
            except Exception as e:
                logger.warning("  [IK] Worker exception image %d: %s", idx + 1, str(e)[:80])

    # Verify + collect (in original order to preserve gallery sequence)
    failed = 0
    imagekit_urls = []
    for idx, ik_url in enumerate(results):
        if ik_url is None:
            failed += 1
            if verbose:
                print(
                    "  [IK] FAILED image " + str(idx + 1) + " -- "
                    "upload exhausted all retries: " + source_urls[idx][:60]
                )
            continue

        if verify:
            ok = _verify_url(ik_url)
            if not ok:
                failed += 1
                if verbose:
                    print(
                        "  [IK] FAILED image " + str(idx + 1) + " -- "
                        "ImageKit URL not accessible: " + ik_url
                    )
                continue

        imagekit_urls.append(ik_url)

    if verbose:
        print(
            "  [IK] Done: " + str(len(imagekit_urls)) + " uploaded OK, "
            + str(failed) + " failed"
        )

    return imagekit_urls, failed
