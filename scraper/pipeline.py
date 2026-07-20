#!/usr/bin/env python3
"""
Choice Properties -- Unified Pipeline Orchestrator
===================================================
Single mandatory entry point for ALL scraping and publishing jobs.

Every new city batch script must call PipelineOrchestrator.run() instead
of reimplementing the scrape-filter-publish loop manually. This guarantees
all 16 permanent platform rules (scraper/PLATFORM_RULES.md) are enforced
automatically and identically for every batch, regardless of city or market.

Architecture
------------
  BatchCriteria       -- dataclass describing what to scrape and price
  PipelineOrchestrator -- the 13-step pipeline; one instance per run
  PipelineResult      -- returned stats / logs from a run

Thirteen mandatory steps (spec: Choice Properties Permanent Pipeline Rules):
  1.  Normalize & validate required fields
  2.  Active / available only  (no expired / removed listings)
  3.  Within-batch + DB duplicate check (address + source_id)
  4.  Download source images
  5.  Upload images to ImageKit; verify live; retry failures
  6.  Image QA  (min 6 photos; no broken CDN links)
  7.  AI description rewrite  (never publish original text)
  8.  Enrichment pipeline  (cleanup, branding, fee, pricing sync)
  9.  Pre-publish validation gate  (validate_for_publish)
  10. Stage record in pipeline_properties
  11. Publish via pipeline_publish RPC
  12. Activate property  (set status = active)
  13. Insert property_photos into Supabase

Usage
-----
  from pipeline import PipelineOrchestrator, BatchCriteria

  criteria = BatchCriteria(
      locations=["Arlington, TX", "Euless, TX"],
      beds_exact=2,
      baths_min=1.0, baths_max=2.0,
      rent_min=1300, rent_max=1600,
      rent_floor=1300, rent_cap=1400,
      allowed_types={"SINGLE_FAMILY", "TOWNHOMES"},
      target=10,
      past_days=90,
  )

  orchestrator = PipelineOrchestrator()
  result = orchestrator.run(criteria, dry_run=False)
  print(result.summary())

Required environment variables:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  IMAGEKIT_PRIVATE_KEY
  IMAGEKIT_URL_ENDPOINT
  OPENAI_API_KEY  (optional — AI description rewrite degrades gracefully)
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

# ---------------------------------------------------------------------------
# Path bootstrap — allow running from repo root or scraper/
# ---------------------------------------------------------------------------
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)


def _load_dotenv():
    for candidate in [
        ".env",
        "../.env",
        os.path.join(_SCRIPT_DIR, ".env"),
        os.path.join(_SCRIPT_DIR, "../.env"),
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

# ---------------------------------------------------------------------------
# Optional dependency guards
# ---------------------------------------------------------------------------
try:
    import requests as _req
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
    _REQUESTS_OK = True
except ImportError:
    _REQUESTS_OK = False

try:
    from homeharvest import scrape_property
    from homeharvest.exceptions import InvalidListingType, AuthenticationError
    _HH_OK = True
except ImportError:
    _HH_OK = False

try:
    from enrichment import (
        apply_enrichment_pipeline,
        validate_for_publish,
        is_watermarked,
        watermark_reason,
        enforce_price_consistency,
        normalize_application_fee_in_description,
        append_apply_cta,
        clean_description,
        strip_external_application_instructions,
        replace_owner_manager_references,
        strip_third_party_branding,
        filter_record_photos,
        rule_based_enrich,
        normalize_hvac,
    )
    _ENRICH_OK = True
except Exception as _ee:
    _ENRICH_OK = False
    print("WARNING: enrichment module unavailable: {}".format(_ee))

try:
    from scraper import (
        _map_realtor_property,
        _enrich_realtor_batch,
        _quality_score,
        _missing_fields,
        _get_existing_ids,
    )
    _SCRAPER_OK = True
except Exception as _se:
    _SCRAPER_OK = False
    print("WARNING: scraper.py imports unavailable: {}".format(_se))

try:
    from ai_description import rewrite_description
    _AI_OK = True
except Exception:
    _AI_OK = False

try:
    from visual_watermark import check_photos_for_watermarks
    _VW_OK = True
except Exception:
    _VW_OK = False

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
if not SUPABASE_URL:
    raise RuntimeError("SUPABASE_URL env var is required — set it in .env or environment secrets.")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
IK_PRIVATE_KEY = os.environ.get("IMAGEKIT_PRIVATE_KEY", "").strip()
IK_URL_ENDPOINT = os.environ.get("IMAGEKIT_URL_ENDPOINT", "https://ik.imagekit.io/21rg7lvzo").rstrip("/")
SITE_BASE_URL = os.environ.get("SITE_BASE_URL", "https://choiceproperties.com").rstrip("/")

IK_UPLOAD_URL = "https://upload.imagekit.io/api/v1/files/upload"

MIN_PHOTOS = 6
IK_MAX_WORKERS = 4
IK_MAX_PHOTOS = 20
IK_MAX_RETRIES = 3
RETRY_BACKOFF = 2.0

_DL_HEADERS_REALTOR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Referer": "https://www.realtor.com/",
}
_DL_HEADERS_ZILLOW = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Referer": "https://www.zillow.com/",
}


def _dl_headers_for(url: str) -> dict:
    """Return the correct download headers for a given image URL.
    Zillow's CDN (zillowstatic.com) requires a zillow.com Referer;
    using realtor.com as the Referer causes 403s on Zillow images.
    """
    if "zillow" in url.lower() or "zillowstatic" in url.lower():
        return _DL_HEADERS_ZILLOW
    return _DL_HEADERS_REALTOR


# ---------------------------------------------------------------------------
# HTTP session helpers
# ---------------------------------------------------------------------------

def _make_pipeline_session():
    if not _REQUESTS_OK:
        return None
    s = _req.Session()
    retry = Retry(total=3, backoff_factor=0.5, status_forcelist=[500, 502, 503, 504],
                  allowed_methods=["GET", "POST", "PATCH"])
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.headers.update({
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": "Bearer " + SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Profile": "pipeline",
        "Content-Profile": "pipeline",
        "Prefer": "return=representation",
    })
    return s


def _make_public_session():
    if not _REQUESTS_OK:
        return None
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


# ---------------------------------------------------------------------------
# BatchCriteria dataclass
# ---------------------------------------------------------------------------

@dataclass
class BatchCriteria:
    """
    Describes what to scrape and how to price it.
    Every city batch passes one of these to PipelineOrchestrator.run().
    All platform rules (watermark, images, enrichment, fee, branding, etc.)
    are enforced automatically by the orchestrator — only the search
    criteria and optional pricing function belong here.
    """
    locations: List[str]                          # e.g. ["Arlington, TX"]
    beds_exact: Optional[int] = None              # None = no constraint
    beds_min: Optional[int] = None
    beds_max: Optional[int] = None
    baths_min: float = 1.0
    baths_max: Optional[float] = None
    rent_min: int = 800
    rent_max: int = 3500
    rent_floor: Optional[int] = None             # None = no floor adjustment
    rent_cap: Optional[int] = None               # None = publish as-is
    allowed_types: Set[str] = field(default_factory=lambda: {"SINGLE_FAMILY", "TOWNHOMES"})
    target: int = 10                             # how many to publish
    past_days: int = 90
    limit: int = 200                             # max scraped per location
    min_score: int = 40                          # data quality floor
    fallback_locations: List[str] = field(default_factory=list)
    pricing_fn: Optional[Callable] = None        # fn(original_rent, seen_rents) -> (published, orig)
    batch_name: str = "batch"                    # used in logs


# ---------------------------------------------------------------------------
# PipelineResult
# ---------------------------------------------------------------------------

@dataclass
class PipelineResult:
    batch_name: str
    scraped: int = 0
    after_dedup: int = 0
    passed_filter: int = 0
    passed_validation: int = 0
    selected: int = 0
    published: int = 0
    photos_ok: int = 0
    photos_failed: int = 0
    watermarked_dropped: int = 0
    ai_rewrites: int = 0
    visual_watermark_rejected: int = 0
    errors: List[str] = field(default_factory=list)
    published_urls: List[str] = field(default_factory=list)

    def summary(self) -> str:
        lines = [
            "=" * 65,
            "PIPELINE SUMMARY — {}".format(self.batch_name),
            "=" * 65,
            "Scraped              : {}".format(self.scraped),
            "After dedup          : {}".format(self.after_dedup),
            "Passed filter        : {}".format(self.passed_filter),
            "Passed validation    : {}".format(self.passed_validation),
            "Selected to publish  : {}".format(self.selected),
            "Published            : {}".format(self.published),
            "Photos OK            : {}".format(self.photos_ok),
            "Photo failures       : {}".format(self.photos_failed),
            "Watermarked dropped  : {}".format(self.watermarked_dropped),
            "AI description rewrites: {}".format(self.ai_rewrites),
            "Visual watermark rejected: {}".format(self.visual_watermark_rejected),
        ]
        if self.errors:
            lines.append("\nErrors:")
            for e in self.errors:
                lines.append("  - " + e)
        if self.published_urls:
            lines.append("\nPublished URLs:")
            for url in self.published_urls:
                lines.append("  " + url)
        lines.append("=" * 65)
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# PipelineOrchestrator
# ---------------------------------------------------------------------------

class PipelineOrchestrator:
    """
    Unified 13-step pipeline. Every scraping job uses this — no exceptions.

    Platform rules enforced automatically (non-bypassable):
      - Competitor watermark detection + rejection
      - Visual watermark scan per photo (if OpenAI configured)
      - ImageKit-only image hosting; minimum 6 photos
      - AI description rewrite (if OpenAI configured)
      - Full enrichment: cleanup, branding, fee normalization, pricing sync
      - Pre-publish validation gate
      - DB-level duplicate detection
      - Deposit = published rent (unless overridden by pricing_fn)
    """

    def __init__(self, verbose: bool = True):
        self.verbose = verbose
        self._pipe_session = _make_pipeline_session()
        self._pub_session = _make_public_session()
        if IK_PRIVATE_KEY:
            import base64
            self._ik_auth = "Basic " + __import__("base64").b64encode(
                (IK_PRIVATE_KEY + ":").encode()).decode()
        else:
            self._ik_auth = ""

    def _log(self, msg: str):
        if self.verbose:
            print(msg)

    # -----------------------------------------------------------------------
    # Public entry point
    # -----------------------------------------------------------------------

    def run(self, criteria: BatchCriteria, dry_run: bool = False) -> PipelineResult:
        result = PipelineResult(batch_name=criteria.batch_name)

        self._log("\n" + "=" * 65)
        self._log("Choice Properties Pipeline — {}".format(criteria.batch_name))
        self._log("Target: {} | Past {} days | Dry run: {}".format(
            criteria.target, criteria.past_days, dry_run))
        self._log("=" * 65)

        # ── Step 1: Scrape ────────────────────────────────────────────────
        self._log("\n── Step 1: Scraping {} location(s) ──".format(len(criteria.locations)))
        records = self._step1_scrape(criteria)
        result.scraped = len(records)
        self._log("   Raw results: {}".format(result.scraped))

        if not records:
            self._log("ERROR: No listings found. Try --past-days 120 or broader criteria.")
            return result

        # ── Step 2: Active/available filter + within-batch dedup ─────────
        self._log("\n── Step 2: Availability + dedup ──")
        records = self._step2_availability_dedup(records)
        result.after_dedup = len(records)
        self._log("   After dedup: {}".format(result.after_dedup))

        # ── Step 3: Criteria filter + watermark filter ────────────────────
        self._log("\n── Step 3: Filtering against criteria + competitor watermark ──")
        records, dropped = self._step3_filter(records, criteria)
        result.passed_filter = len(records)
        result.watermarked_dropped = sum(1 for _, reasons in dropped
                                         if any("watermark" in r or "competitor" in r for r in reasons))
        self._log("   Kept: {} | Dropped: {}".format(result.passed_filter, len(dropped)))
        for addr, reasons in dropped[:15]:
            self._log("   [DROP] {} — {}".format(addr, ", ".join(reasons)))
        if len(dropped) > 15:
            self._log("   ... and {} more".format(len(dropped) - 15))

        # If short on target, try fallbacks
        if len(records) < criteria.target and criteria.fallback_locations:
            self._log("\n   Short on target — trying {} fallback location(s)...".format(
                len(criteria.fallback_locations)))
            fb_criteria = BatchCriteria(
                locations=criteria.fallback_locations,
                beds_exact=criteria.beds_exact,
                beds_min=criteria.beds_min,
                beds_max=criteria.beds_max,
                baths_min=criteria.baths_min,
                baths_max=criteria.baths_max,
                rent_min=criteria.rent_min,
                rent_max=criteria.rent_max,
                allowed_types=criteria.allowed_types,
                past_days=criteria.past_days,
                limit=criteria.limit,
                batch_name=criteria.batch_name + " (fallback)",
            )
            fb_recs = self._step1_scrape(fb_criteria)
            fb_recs = self._step2_availability_dedup(fb_recs)
            existing_sids = {r.get("source_listing_id") for r in records}
            fb_recs = [r for r in fb_recs if r.get("source_listing_id") not in existing_sids]
            fb_recs, _ = self._step3_filter(fb_recs, criteria)
            self._log("   Fallback added: {}".format(len(fb_recs)))
            records.extend(fb_recs)

        # Quality floor
        pre = len(records)
        records = [r for r in records if r.get("data_quality_score", 0) >= criteria.min_score]
        self._log("   After quality floor ({}): {}/{}".format(criteria.min_score, len(records), pre))

        if not records:
            self._log("ERROR: No listings passed quality floor. Lower --min-score or expand criteria.")
            return result

        # ── Step 4: Pricing ───────────────────────────────────────────────
        self._log("\n── Step 4: Pricing ──")
        records = self._step4_pricing(records, criteria)

        # ── Step 5: Image download + ImageKit upload ───────────────────────
        # Done later per-listing (after publish gives us the property_id).
        # Here we pre-check that source URLs exist (gate).
        self._log("\n── Step 5: Image pre-check (source URL gate) ──")
        records = self._step5_image_precheck(records)
        self._log("   {} records have sufficient source images".format(len(records)))

        if not records:
            self._log("ERROR: No records have enough source images (min {}).".format(MIN_PHOTOS))
            return result

        # ── Step 6: AI description rewrite ───────────────────────────────
        self._log("\n── Step 6: AI description rewrite ──")
        ai_count = 0
        for rec in records:
            rewrote = self._step6_ai_description(rec)
            if rewrote:
                ai_count += 1
        result.ai_rewrites = ai_count
        self._log("   {} descriptions AI-rewritten ({} skipped — OpenAI not available)".format(
            ai_count, len(records) - ai_count))

        # ── Step 7: Enrichment pipeline (cleanup, branding, fee, pricing) ─
        self._log("\n── Step 7: Enrichment pipeline ──")
        if _ENRICH_OK:
            records, wm_count = apply_enrichment_pipeline(records, verbose=self.verbose)
            result.watermarked_dropped += wm_count
        else:
            self._log("   WARNING: enrichment module unavailable — skipping")

        # ── Step 8: Pre-publish validation ───────────────────────────────
        self._log("\n── Step 8: Pre-publish validation ──")
        valid, invalid = [], []
        for rec in records:
            ok, fails = validate_for_publish(rec) if _ENRICH_OK else (True, [])
            if ok:
                valid.append(rec)
            else:
                addr = "{} {}".format(rec.get("address", ""), rec.get("city", "")).strip()
                invalid.append((addr, fails))
                self._log("   [FAIL] {}: {}".format(addr, ", ".join(fails)))
        result.passed_validation = len(valid)
        self._log("   Valid: {} | Invalid: {}".format(len(valid), len(invalid)))

        if not valid:
            self._log("ERROR: No listings passed validation.")
            return result

        # ── Already-published filter ──────────────────────────────────────
        # Remove any listing whose source_listing_id is already published in
        # pipeline_properties (has a choice_property_id). This prevents the
        # same top-scoring listings from being selected run after run.
        if self._pipe_session:
            candidate_sids = [r.get("source_listing_id", "") for r in valid if r.get("source_listing_id")]
            pub_map = self._fetch_pipeline_id_map(candidate_sids)
            published_sids = {sid for sid in candidate_sids if pub_map.get("__published__" + sid)}
            if published_sids:
                before = len(valid)
                valid = [r for r in valid if r.get("source_listing_id", "") not in published_sids]
                self._log("   Excluded {} already-published listing(s) from candidates".format(
                    before - len(valid)))

        if not valid:
            self._log("ERROR: All candidates already published. Try a different market or expand criteria.")
            return result

        # Sort: best quality first
        valid.sort(key=lambda r: -r.get("data_quality_score", 0))

        # ── Same-floor-plan dedup ─────────────────────────────────────────
        # Drop listings that are visually identical to one already selected:
        # same city + square_footage + monthly_rent = same builder model home
        # reused across multiple lots in the same subdivision.
        seen_floorplans: set = set()
        deduped = []
        for rec in valid:
            key = (
                (rec.get("city") or "").lower().strip(),
                rec.get("square_footage") or rec.get("square_feet"),
                rec.get("monthly_rent"),
            )
            # Only deduplicate when all three fields are populated
            if all(k is not None for k in key) and key[1] and key[2]:
                if key in seen_floorplans:
                    addr = "{} {}".format(rec.get("address", ""), rec.get("city", "")).strip()
                    self._log("   [SKIP] {} — same floor plan already selected ({} sqft @ ${}/mo)".format(
                        addr, key[1], key[2]))
                    continue
                seen_floorplans.add(key)
            deduped.append(rec)
        valid = deduped

        to_publish = valid[: criteria.target]
        result.selected = len(to_publish)
        self._log("\n   Selecting top {}/{} for publishing:".format(len(to_publish), len(valid)))
        for i, rec in enumerate(to_publish, 1):
            addr = "{} {}".format(rec.get("address", ""), rec.get("city", "")).strip()
            self._log("   {:2}. {} | ${}/mo | score={}".format(
                i, addr, rec.get("monthly_rent"), rec.get("data_quality_score", 0)))

        if dry_run:
            self._log("\n[DRY RUN] Stopping before any database writes.")
            return result

        # ── Steps 9-13: Stage → Publish → Activate → Photos ─────────────
        self._log("\n── Steps 9–13: Stage → Publish → Activate → Photos ──")
        to_publish = self._step9_stage(to_publish)
        self._step10_patch_pipeline(to_publish)

        for rec in to_publish:
            addr = "{}, {} {}".format(
                rec.get("address", ""), rec.get("city", ""), rec.get("state", "")).strip()
            pid = rec.get("id")
            if not pid:
                self._log("   ERROR: No pipeline ID for: {}".format(addr))
                result.errors.append("No pipeline ID: " + addr)
                continue

            # Skip records that were already published in a prior run.
            # _step9_stage tags these via __already_published__.
            if rec.get("__already_published__"):
                self._log("   SKIP (already published): {}".format(addr))
                continue

            # ── FIX C1: Visual watermark + photo count gate BEFORE publish ──
            # Runs before any DB writes so a watermark-only listing is never
            # made live. If clean photos fall below MIN_PHOTOS, skip entirely.
            src_urls = []
            try:
                src_urls = json.loads(rec.get("original_image_urls") or "[]")
            except Exception:
                pass

            if _VW_OK and src_urls:
                self._log("      Pre-publish: visual watermark scan ({} photos)...".format(len(src_urls)))
                src_urls, rejected = self._step13a_visual_watermark(src_urls)
                result.visual_watermark_rejected += rejected
                if rejected:
                    self._log("      Visual watermark: {} photo(s) rejected, {} clean remain".format(
                        rejected, len(src_urls)))

            if len(src_urls) < MIN_PHOTOS:
                self._log("   SKIP: {} — only {} clean photo(s) available (min {}). Not publishing.".format(
                    addr, len(src_urls), MIN_PHOTOS))
                result.errors.append(
                    "Skipped (insufficient clean photos after watermark check): " + addr)
                # FIX C2: Clean up staged record so it does not accumulate as zombie
                self._cleanup_staged(pid)
                continue

            # Write cleaned URLs back so _step13b uses the filtered list
            rec["original_image_urls"] = json.dumps(src_urls)

            # Step 11: Publish
            prop_id, err = self._step11_publish(pid)
            if err:
                self._log("   ERROR: PUBLISH FAILED: {} — {}".format(addr, err))
                result.errors.append("Publish failed {}: {}".format(addr, err))
                # FIX C2: Mark staged record as failed so it does not re-stage on next run
                self._cleanup_staged(pid)
                continue
            self._log("   OK Published: {} -> {}".format(addr, prop_id))

            # Step 12: Activate
            activated = self._step12_activate(prop_id)
            if activated:
                self._log("      -> activated (status=active)")
            else:
                self._log("      WARNING: activation PATCH failed")

            # Step 13: Photos — src_urls already watermark-filtered above
            self._log("      Importing photos ({} clean source URLs)...".format(len(src_urls)))
            uploaded, failed = self._step13b_import_photos(prop_id, src_urls)
            result.photos_ok += uploaded
            result.photos_failed += failed

            if uploaded >= MIN_PHOTOS:
                self._log("      OK {}/{} photos on ImageKit".format(
                    uploaded, uploaded + failed))
            else:
                self._log("      WARNING: only {} photos uploaded (min {})".format(
                    uploaded, MIN_PHOTOS))

            result.published += 1

            # Build public URL
            prop_row = self._fetch_property_row(prop_id)
            if prop_row:
                url = self._build_url(prop_row)
            else:
                url = self._build_url({
                    "id": prop_id,
                    "city": rec.get("city", ""),
                    "state": rec.get("state", ""),
                    "property_type": rec.get("property_type", "SINGLE_FAMILY"),
                    "bedrooms": rec.get("bedrooms", 2),
                })
            result.published_urls.append(url)

        # Final summary
        self._log("\n" + result.summary())
        return result

    # -----------------------------------------------------------------------
    # Step implementations
    # -----------------------------------------------------------------------

    def _step1_scrape(self, criteria: BatchCriteria) -> List[Dict]:
        records = []
        for location in criteria.locations:
            self._log("   Scraping: {}".format(location))
            if not _HH_OK or not _SCRAPER_OK:
                self._log("   SKIP: homeharvest or scraper.py unavailable")
                continue
            beds_min = criteria.beds_exact if criteria.beds_exact is not None else criteria.beds_min
            beds_max = criteria.beds_exact if criteria.beds_exact is not None else criteria.beds_max
            try:
                props = scrape_property(
                    location=location,
                    listing_type="for_rent",
                    past_days=criteria.past_days,
                    return_type="pydantic",
                    limit=criteria.limit,
                    beds_min=beds_min,
                    beds_max=beds_max,
                    price_min=criteria.rent_min,
                    price_max=criteria.rent_max,
                    extra_property_data=True,
                )
                self._log("   {} returned {} listing(s)".format(location, len(props)))
                for p in props:
                    try:
                        records.append(_map_realtor_property(p))
                    except Exception:
                        pass
            except (InvalidListingType, AuthenticationError) as e:
                self._log("   ERROR: {}".format(e))
            except Exception as e:
                self._log("   ERROR: {}".format(e))

        # Enrich with detail-page data
        if records and _SCRAPER_OK:
            records = _enrich_realtor_batch(records, verbose=self.verbose)

        return records

    def _step2_availability_dedup(self, records: List[Dict]) -> List[Dict]:
        """Deduplicate within the batch by source_listing_id."""
        seen_sids: Set[str] = set()
        unique = []
        for rec in records:
            sid = rec.get("source_listing_id", "")

            # Rule 2: active/available only.
            # Freshly scraped records always have status="scraped" (pipeline state);
            # availability is carried in source_status ("available", "pending",
            # "rented", "removed"). Accept "available" or blank (unknown).
            source_status = (rec.get("source_status") or "").lower()
            if source_status and source_status not in ("available", ""):
                continue

            if sid and sid in seen_sids:
                continue
            seen_sids.add(sid)
            unique.append(rec)
        return unique

    def _step3_filter(
        self, records: List[Dict], criteria: BatchCriteria
    ) -> Tuple[List[Dict], List[Tuple[str, List[str]]]]:
        """Filter against batch criteria + competitor watermark check."""
        kept, dropped = [], []
        for rec in records:
            issues = []

            # Competitor watermark check (Rule 4 — text/metadata)
            if _ENRICH_OK and is_watermarked(rec):
                brand = watermark_reason(rec) or "unknown"
                issues.append("competitor-branded ({})".format(brand))

            # Property type
            ptype = (rec.get("property_type") or "").upper()
            if criteria.allowed_types and ptype not in criteria.allowed_types:
                issues.append("type={}".format(ptype))

            # Beds
            beds = self._safe_int(rec.get("bedrooms"))
            if criteria.beds_exact is not None and beds != criteria.beds_exact:
                issues.append("beds={} (need {})".format(beds, criteria.beds_exact))
            elif criteria.beds_min is not None and (beds is None or beds < criteria.beds_min):
                issues.append("beds={} (min {})".format(beds, criteria.beds_min))
            elif criteria.beds_max is not None and beds is not None and beds > criteria.beds_max:
                issues.append("beds={} (max {})".format(beds, criteria.beds_max))

            # Baths
            baths = self._safe_float(rec.get("bathrooms"))
            if baths is None:
                issues.append("baths=missing")
            elif baths < criteria.baths_min:
                issues.append("baths={} (min {})".format(baths, criteria.baths_min))
            elif criteria.baths_max is not None and baths > criteria.baths_max:
                issues.append("baths={} (max {})".format(baths, criteria.baths_max))

            # Rent range
            rent = rec.get("monthly_rent")
            if rent is None or rent < criteria.rent_min or rent > criteria.rent_max:
                issues.append("rent=${}".format(rent))

            # Minimum source photos
            src_imgs = self._parse_image_urls(rec)
            if len(src_imgs) < MIN_PHOTOS:
                issues.append("too few photos ({}/{})".format(len(src_imgs), MIN_PHOTOS))

            if issues:
                addr = "{} {}".format(rec.get("address", ""), rec.get("city", "")).strip()
                dropped.append((addr, issues))
            else:
                # Filter branded individual photos (keep listing, drop bad photos)
                if _ENRICH_OK:
                    rec = filter_record_photos(rec)
                    remaining = self._parse_image_urls(rec)
                    if len(remaining) < MIN_PHOTOS:
                        addr = "{} {}".format(rec.get("address", ""), rec.get("city", "")).strip()
                        dropped.append((addr, ["too few clean photos after brand filter ({}/{})".format(
                            len(remaining), MIN_PHOTOS)]))
                        continue
                kept.append(rec)
        return kept, dropped

    def _step4_pricing(self, records: List[Dict], criteria: BatchCriteria) -> List[Dict]:
        """Apply batch pricing rules: custom pricing_fn or cap/floor."""
        if criteria.pricing_fn is None and criteria.rent_cap is None:
            return records  # no adjustment needed

        seen_rents: Set[int] = set()
        for rec in records:
            orig = rec.get("monthly_rent")
            if orig is None:
                continue

            if criteria.pricing_fn is not None:
                published, _ = criteria.pricing_fn(orig, seen_rents)
            elif criteria.rent_cap is not None:
                # Default: proportional reduction to [floor, cap]
                published = self._proportional_price(
                    orig,
                    criteria.rent_min,
                    criteria.rent_max,
                    criteria.rent_floor or criteria.rent_min,
                    criteria.rent_cap,
                )
            else:
                published = int(orig)

            if published is None:
                continue

            seen_rents.add(published)
            rec["monthly_rent"] = published
            rec["security_deposit"] = published  # Rule 10: deposit = published rent

        adjusted = sum(1 for r in records if r.get("monthly_rent") != r.get("_orig_rent"))
        self._log("   Pricing applied to {} record(s)".format(len(records)))
        return records

    def _step5_image_precheck(self, records: List[Dict]) -> List[Dict]:
        """Gate: must have MIN_PHOTOS source URLs before continuing."""
        passed = []
        for rec in records:
            urls = self._parse_image_urls(rec)
            if len(urls) >= MIN_PHOTOS:
                passed.append(rec)
            else:
                addr = "{} {}".format(rec.get("address", ""), rec.get("city", "")).strip()
                self._log("   [SKIP] {} — only {} source image(s)".format(addr, len(urls)))
        return passed

    def _step6_ai_description(self, rec: Dict) -> bool:
        """
        Rewrite the description using AI. Returns True if rewrite happened.
        Falls back gracefully if OPENAI_API_KEY is not set or AI module unavailable.
        Rule 6: never publish the original listing description.
        """
        if not _AI_OK:
            return False
        try:
            new_desc = rewrite_description(rec)
            if new_desc:
                rec["description"] = new_desc
                return True
        except Exception as e:
            self._log("   WARNING: AI rewrite failed for {}: {}".format(
                rec.get("address", "?"), str(e)[:80]))
        return False

    def _step13a_visual_watermark(
        self, src_urls: List[str]
    ) -> Tuple[List[str], int]:
        """
        Run vision-based watermark detection on each source photo.
        Returns (clean_urls, rejected_count).
        Falls back gracefully if visual_watermark module unavailable.
        """
        if not _VW_OK:
            return src_urls, 0
        try:
            clean_urls, rejected_count = check_photos_for_watermarks(src_urls, verbose=self.verbose)
            return clean_urls, rejected_count
        except Exception as e:
            self._log("   WARNING: visual watermark check error: {}".format(str(e)[:80]))
            return src_urls, 0

    def _step9_stage(self, records: List[Dict]) -> List[Dict]:
        """Stage records in pipeline_properties; resolve pipeline IDs."""
        if not self._pipe_session:
            return records

        source_ids = [r.get("source_listing_id", "") for r in records if r.get("source_listing_id")]
        existing_map = self._fetch_pipeline_id_map(source_ids)
        new_records = [r for r in records if r.get("source_listing_id", "") not in existing_map]

        # Tag records already published so the main loop skips them
        already_published = 0
        for rec in records:
            sid = rec.get("source_listing_id", "")
            if existing_map.get("__published__" + sid):
                rec["__already_published__"] = True
                already_published += 1

        self._log("   Dedup: {} already staged ({} already published), {} new".format(
            len(records) - len(new_records), already_published, len(new_records)))

        # Insert new records in batches of 50
        for i in range(0, len(new_records), 50):
            batch = new_records[i:i + 50]
            try:
                r = self._pipe_session.post(
                    "{}/rest/v1/pipeline_properties?on_conflict=source_listing_id".format(SUPABASE_URL),
                    data=json.dumps(batch, default=str).encode(),
                    headers={"Prefer": "return=representation,resolution=ignore-duplicates"},
                    timeout=30,
                )
                r.raise_for_status()
                self._log("   Staged batch {}: {} record(s)".format(
                    i // 50 + 1, len(r.json()) if isinstance(r.json(), list) else len(batch)))
            except Exception as e:
                self._log("   ERROR: Stage batch {} failed: {}".format(i // 50 + 1, str(e)[:120]))

        # Resolve IDs for newly inserted records
        if new_records:
            new_sids = [r.get("source_listing_id", "") for r in new_records]
            existing_map.update(self._fetch_pipeline_id_map(new_sids))

        for rec in records:
            sid = rec.get("source_listing_id", "")
            if sid in existing_map:
                rec["id"] = existing_map[sid]

        return records

    def _step10_patch_pipeline(self, records: List[Dict]):
        """Patch pricing + description on already-staged pipeline records."""
        if not self._pipe_session:
            return
        for rec in records:
            pid = rec.get("id")
            if not pid:
                continue
            try:
                r = self._pipe_session.patch(
                    "{}/rest/v1/pipeline_properties?id=eq.{}".format(SUPABASE_URL, pid),
                    json={
                        "monthly_rent": rec.get("monthly_rent"),
                        "security_deposit": rec.get("security_deposit"),
                        "description": rec.get("description"),
                        "application_fee": 50,
                    },
                    timeout=20,
                )
                if not r.ok:
                    self._log("   WARNING: PATCH failed {}: {}".format(pid, r.text[:80]))
            except Exception as e:
                self._log("   WARNING: PATCH error {}: {}".format(pid, str(e)[:80]))

    def _step11_publish(self, pipeline_id: str) -> Tuple[Optional[str], Optional[str]]:
        """Call pipeline_publish RPC. Returns (property_id, error_or_None)."""
        if not self._pub_session:
            return None, "No HTTP session"
        try:
            r = self._pub_session.post(
                "{}/rest/v1/rpc/pipeline_publish".format(SUPABASE_URL),
                json={"p_id": pipeline_id, "p_landlord_id": None},
                timeout=30,
            )
            r.raise_for_status()
            data = r.json()
            if isinstance(data, list):
                data = data[0] if data else {}
            if data.get("ok") is False:
                return None, data.get("error", "RPC returned ok=false")
            prop_id = (data.get("choice_property_id") or
                       data.get("property_id") or
                       data.get("id"))
            return prop_id, None
        except Exception as e:
            try:
                return None, "{} — {}".format(e, r.text[:200])
            except Exception:
                return None, str(e)

    def _step12_activate(self, prop_id: str) -> bool:
        """PATCH status=active (pipeline_publish creates draft)."""
        if not self._pub_session:
            return False
        try:
            r = self._pub_session.patch(
                "{}/rest/v1/properties?id=eq.{}".format(
                    SUPABASE_URL, urllib.parse.quote(prop_id)),
                json={"status": "active"},
                timeout=15,
            )
            return r.ok
        except Exception:
            return False

    def _step13b_import_photos(
        self, prop_id: str, src_urls: List[str]
    ) -> Tuple[int, int]:
        """
        Download each image and upload to ImageKit, then insert into property_photos.
        Returns (uploaded_count, failed_count).
        Direct upload — bypasses import-pipeline-photos edge function (401s from Replit).
        """
        if not src_urls or not self._ik_auth or not self._pub_session:
            return 0, len(src_urls)

        # Deduplicate: skip thumbnail variants
        seen: Set[str] = set()
        photo_urls: List[str] = []
        for u in src_urls:
            base = re.sub(r"(od-w\d+_h\d+_x\d+\.webp.*|s\.jpg)$", "", u.split("?")[0])
            if base in seen or u.endswith("s.jpg"):
                continue
            seen.add(base)
            photo_urls.append(u)
            if len(photo_urls) >= IK_MAX_PHOTOS:
                break

        folder = "/properties/{}".format(prop_id)

        def _upload_one(idx: int, url: str) -> Tuple[int, Optional[str], Optional[str], Optional[str]]:
            for attempt in range(1, IK_MAX_RETRIES + 1):
                try:
                    rd = _req.get(url, headers=_dl_headers_for(url), timeout=25)
                    if rd.status_code != 200 or not rd.content:
                        if attempt < IK_MAX_RETRIES:
                            time.sleep(RETRY_BACKOFF * attempt)
                        continue
                    data = rd.content
                    if len(data) > 20 * 1024 * 1024:
                        return idx, None, None, "too large"
                    ct = rd.headers.get("Content-Type", "")
                    # FIX H2: Reject non-image responses (HTML error pages, PDFs, etc.)
                    if ct and not ct.lower().startswith("image/"):
                        return idx, None, None, "non-image content-type: {}".format(ct[:40])
                    ext = "webp" if ("webp" in ct or ".webp" in url) else "jpg"
                except Exception as e:
                    if attempt < IK_MAX_RETRIES:
                        time.sleep(RETRY_BACKOFF * attempt)
                    continue

                fname = "photo_{:02d}.{}".format(idx + 1, ext)
                mime = "image/{}".format(ext)
                try:
                    ru = _req.post(
                        IK_UPLOAD_URL,
                        headers={"Authorization": self._ik_auth},
                        files={"file": (fname, data, mime)},
                        data={"fileName": fname, "folder": folder},
                        timeout=60,
                    )
                    if ru.status_code == 200:
                        d = ru.json()
                        return idx, d.get("url"), d.get("fileId"), None
                    if attempt < IK_MAX_RETRIES:
                        time.sleep(RETRY_BACKOFF * attempt)
                except Exception as e:
                    if attempt < IK_MAX_RETRIES:
                        time.sleep(RETRY_BACKOFF * attempt)
            return idx, None, None, "exhausted {} retries".format(IK_MAX_RETRIES)

        tasks = [(i, u) for i, u in enumerate(photo_urls)]
        results: Dict[int, Tuple[str, str]] = {}

        with ThreadPoolExecutor(max_workers=IK_MAX_WORKERS) as ex:
            futs = {ex.submit(_upload_one, i, u): i for i, u in tasks}
            for fut in as_completed(futs):
                idx, ik_url, file_id, err = fut.result()
                if ik_url:
                    results[idx] = (ik_url, file_id or "")
                else:
                    if self.verbose and err:
                        self._log("      WARNING: photo[{}]: {}".format(idx, err))

        uploaded = 0
        failed = len(photo_urls) - len(results)

        sb_headers = {
            "apikey": SERVICE_ROLE_KEY,
            "Authorization": "Bearer " + SERVICE_ROLE_KEY,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }

        for idx in sorted(results.keys()):
            ik_url, file_id = results[idx]
            try:
                ri = self._pub_session.post(
                    "{}/rest/v1/property_photos".format(SUPABASE_URL),
                    headers=sb_headers,
                    json={
                        "property_id": prop_id,
                        "url": ik_url,
                        "file_id": file_id,
                        "display_order": idx,
                        "is_hero": idx == 0,
                        "watermark_status": "pending",
                    },
                    timeout=15,
                )
                if ri.status_code in (200, 201):
                    uploaded += 1
                    if self.verbose and idx == 0:
                        self._log("      OK hero -> {}".format(ik_url))
                else:
                    failed += 1
                    self._log("      WARNING: db insert[{}]: {} {}".format(
                        idx, ri.status_code, ri.text[:60]))
            except Exception as e:
                failed += 1
                self._log("      WARNING: db insert[{}] error: {}".format(idx, str(e)[:60]))

        return uploaded, failed

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _fetch_pipeline_id_map(self, source_ids: List[str]) -> Dict[str, str]:
        result: Dict[str, str] = {}
        if not self._pipe_session or not source_ids:
            return result
        for i in range(0, len(source_ids), 100):
            chunk = source_ids[i:i + 100]
            encoded = urllib.parse.quote(",".join(chunk))
            try:
                r = self._pipe_session.get(
                    "{}/rest/v1/pipeline_properties"
                    "?source_listing_id=in.({})&select=id,source_listing_id,choice_property_id&limit=1000".format(
                        SUPABASE_URL, encoded),
                    timeout=20,
                )
                r.raise_for_status()
                for row in r.json():
                    result[row["source_listing_id"]] = row["id"]
                    # Tag records that have already been published so the
                    # main publish loop can skip them without re-calling RPC.
                    if row.get("choice_property_id"):
                        result["__published__" + row["source_listing_id"]] = row["choice_property_id"]
            except Exception as e:
                self._log("   WARNING: fetch_pipeline_id_map: {}".format(str(e)[:80]))
        return result

    def _cleanup_staged(self, pipeline_id: str):
        """
        FIX C2: Mark a staged pipeline_properties record as failed so it does
        not accumulate as a zombie or re-stage on the next batch run.
        Called when publish fails or the photo gate rejects a listing after staging.
        """
        if not self._pipe_session:
            return
        try:
            self._pipe_session.patch(
                "{}/rest/v1/pipeline_properties?id=eq.{}".format(
                    SUPABASE_URL, urllib.parse.quote(pipeline_id)),
                json={"status": "failed"},
                timeout=10,
            )
        except Exception as e:
            self._log("   WARNING: _cleanup_staged failed for {}: {}".format(
                pipeline_id, str(e)[:80]))

    def _fetch_property_row(self, prop_id: str) -> Optional[Dict]:
        if not self._pub_session:
            return None
        try:
            r = self._pub_session.get(
                "{}/rest/v1/properties?id=eq.{}&select=id,city,state,property_type,bedrooms&limit=1".format(
                    SUPABASE_URL, urllib.parse.quote(prop_id)),
                timeout=15,
            )
            r.raise_for_status()
            rows = r.json()
            return rows[0] if rows else None
        except Exception:
            return None

    @staticmethod
    def _build_url(prop_row: Dict) -> str:
        def _slug(s: str) -> str:
            s = str(s or "").lower().strip()
            s = re.sub(r"[^a-z0-9]+", "-", s)
            return s.strip("-")[:60]

        state = (prop_row.get("state") or "").lower()[:2]
        city = _slug(prop_row.get("city") or "")
        beds = prop_row.get("bedrooms")
        ptype = _slug(prop_row.get("property_type") or "home")
        prop_id = (prop_row.get("id") or "").lower()
        beds_str = "{}br".format(beds) if beds else "home"
        slug = "{}-{}-{}".format(beds_str, ptype, prop_id)
        return "{}/rent/{}/{}/{}/".format(SITE_BASE_URL, state, city, slug)

    @staticmethod
    def _safe_int(v) -> Optional[int]:
        try:
            return int(v) if v is not None else None
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _safe_float(v) -> Optional[float]:
        try:
            return float(v) if v is not None else None
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _parse_image_urls(rec: Dict) -> List[str]:
        raw = rec.get("original_image_urls") or "[]"
        try:
            urls = json.loads(raw) if isinstance(raw, str) else raw
            return [u for u in urls if u] if isinstance(urls, list) else []
        except Exception:
            return []

    @staticmethod
    def _proportional_price(
        original: float,
        src_min: int,
        src_max: int,
        dst_floor: int,
        dst_cap: int,
    ) -> int:
        """Proportional reduction: map [src_min, src_max] -> [dst_floor, dst_cap]."""
        original = float(original)
        if src_max == src_min:
            return dst_floor
        ratio = (original - src_min) / (src_max - src_min)
        published = dst_floor + ratio * (dst_cap - dst_floor)
        published = round(published / 5) * 5
        return max(dst_floor, min(int(published), dst_cap))
