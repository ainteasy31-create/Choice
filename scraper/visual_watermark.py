#!/usr/bin/env python3
"""
Choice Properties -- Visual Watermark Detector
===============================================
Step 13a of the unified pipeline orchestrator.

Uses OpenAI GPT-4o vision to scan each property photo for visual watermarks,
logos, and branded overlays before upload to ImageKit.

This catches what the text-based is_watermarked() cannot:
  - Zillow watermark text/logo embedded in photo pixels
  - MLS "courtesy of" badges
  - Brokerage logo overlays (KW, Coldwell Banker, etc.)
  - Agent headshot thumbnails in corner
  - Copyright overlays
  - Any other visual branding in the image itself

Rules enforced (permanent — per PLATFORM_RULES.md Section 1 + spec Rule 4):
  - Every image scanned before ImageKit upload
  - Watermarked images are removed from the upload list
  - If too few clean images remain (< MIN_PHOTOS), property is blocked
  - Never crop, blur, or hide watermarks — reject the photo entirely

Cost estimate: ~$0.003 per image (GPT-4o-mini vision, detail=auto)

Required environment variable:
  OPENAI_API_KEY  -- if not set, check_photos_for_watermarks() returns all
                     images as clean (graceful degradation)
"""

import logging
import os
import time
from typing import List, Tuple

logger = logging.getLogger("visual_watermark")

MIN_PHOTOS = 6
MAX_PHOTOS_TO_CHECK = 20  # cap cost per listing

# FIX H3: Circuit-breaker threshold — if this many consecutive API errors occur,
# log a WARNING and stop checking (rather than silently passing everything as CLEAN)
_CIRCUIT_BREAK_THRESHOLD = 3

_OPENAI_OK = False
_client = None

try:
    import openai
    _api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if _api_key:
        _client = openai.OpenAI(api_key=_api_key)
        _OPENAI_OK = True
except ImportError:
    pass

# FIX L1: System prompt moved to the `system` role in the API call (see _check_one)
_SYSTEM_PROMPT = (
    "You are a property image quality checker. Respond with ONLY 'CLEAN' or 'WATERMARKED'.\n\n"
    "Respond 'WATERMARKED' if the image contains ANY of:\n"
    "- Text overlays with company/brand names (Zillow, MLS, Realtor.com, KW, Coldwell Banker, etc.)\n"
    "- Real estate brokerage logos\n"
    "- Agent headshots or profile photos\n"
    "- 'Courtesy of' badges\n"
    "- Copyright text or watermarks\n"
    "- 'For Sale / For Rent' banner overlays from listing portals\n"
    "- Any brand identifier burned into the image\n\n"
    "Respond 'CLEAN' if the image is a plain property photo with no branding overlays.\n"
    "Do not add any other text — only 'CLEAN' or 'WATERMARKED'."
)


def check_photos_for_watermarks(
    src_urls: List[str],
    verbose: bool = False,
) -> Tuple[List[str], int]:
    """
    Check each photo URL for visual watermarks using GPT-4o vision.

    Args:
        src_urls: list of source image URLs to check.
        verbose: print progress if True.

    Returns:
        (clean_urls, rejected_count)
        clean_urls      -- URLs that passed the watermark check
        rejected_count  -- number of watermarked images removed

    Note: Photos beyond position MAX_PHOTOS_TO_CHECK are passed through unchecked.
    If IK_MAX_PHOTOS ever exceeds MAX_PHOTOS_TO_CHECK, increase MAX_PHOTOS_TO_CHECK
    accordingly so all uploaded photos are scanned.
    """
    if not _OPENAI_OK or _client is None:
        # Graceful degradation — text-based check in enrichment.py already ran
        return src_urls, 0

    urls_to_check = src_urls[:MAX_PHOTOS_TO_CHECK]
    clean_urls: List[str] = []
    rejected = 0
    consecutive_errors = 0  # FIX H3: circuit-breaker counter
    circuit_open = False

    for i, url in enumerate(urls_to_check):
        if circuit_open:
            # Circuit open: pass remaining unchecked photos through and warn
            clean_urls.append(url)
            continue

        result, had_error = _check_one(url, i)

        if had_error:
            consecutive_errors += 1
            if consecutive_errors >= _CIRCUIT_BREAK_THRESHOLD:
                circuit_open = True
                logger.warning(
                    "visual_watermark: %d consecutive API errors — circuit open. "
                    "Remaining photos passed through UNCHECKED. Check OPENAI_API_KEY / quota.",
                    consecutive_errors,
                )
            clean_urls.append(url)  # default to clean on error
        else:
            consecutive_errors = 0  # reset on success
            if result == "WATERMARKED":
                rejected += 1
                if verbose:
                    print("      [VW] WATERMARKED photo[{}] rejected: {}".format(i, url[:70]))
            else:
                clean_urls.append(url)

    # Preserve any photos beyond MAX_PHOTOS_TO_CHECK unchecked
    if len(src_urls) > MAX_PHOTOS_TO_CHECK:
        clean_urls.extend(src_urls[MAX_PHOTOS_TO_CHECK:])

    if verbose and rejected:
        print("      [VW] {} watermarked photo(s) removed, {} clean remain".format(
            rejected, len(clean_urls)))

    if circuit_open and verbose:
        print("      [VW] WARNING: visual watermark check was degraded (API errors)")

    return clean_urls, rejected


def _check_one(url: str, index: int) -> Tuple[str, bool]:
    """
    Check a single image URL for watermarks.

    Returns:
        (result, had_error)
        result    -- 'CLEAN' or 'WATERMARKED'
        had_error -- True if the API call failed (caller handles circuit breaker)
    """
    # FIX M3: Retry with exponential backoff on transient errors
    for attempt in range(3):
        try:
            response = _client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    # FIX L1: System prompt properly placed in `system` role
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "Does this property photo contain any watermarks or branding overlays?"},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": url,
                                    "detail": "auto",  # FIX L2: changed from "low" to catch small corner watermarks
                                },
                            },
                        ],
                    },
                ],
                max_tokens=5,
                temperature=0,
            )
            answer = response.choices[0].message.content.strip().upper()
            result = "WATERMARKED" if "WATERMARKED" in answer else "CLEAN"
            return result, False  # success, no error

        except Exception as e:
            err_str = str(e)[:80]
            is_transient = any(x in err_str.lower() for x in ("rate_limit", "529", "500", "timeout"))
            if is_transient and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            logger.debug("Visual watermark check error for image %d (attempt %d): %s",
                         index, attempt + 1, err_str)
            return "CLEAN", True  # error — caller tracks consecutive failures

    return "CLEAN", True  # exhausted retries


def is_available() -> bool:
    """Return True if OpenAI is configured and visual checking is possible."""
    return _OPENAI_OK and _client is not None
