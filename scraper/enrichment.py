#!/usr/bin/env python3
"""
Choice Properties -- Enrichment Pipeline (v1)
=============================================
Post-processing applied to every scraped record before DB insert:

  1. clean_description      -- strip TurboTenant / agent boilerplate + screening language
  2. is_watermarked         -- detect competitor-branded listings (drop before staging)
  3. rule_based_enrich      -- infer missing fields using simple rules, no API calls
  4. regex_extract_missing  -- fetch listing page and regex-extract missing fields
                               (Realtor/non-Zillow only; skips records scored >= 75)

Usage (from scraper.py):
  from enrichment import apply_enrichment_pipeline
  records, count_watermarked = apply_enrichment_pipeline(records, verbose=True)

iSH / Python 3.9 compatibility:
  * ASCII quotes only in all string literals.
  * No walrus operator (:=).
  * No match/case statements.
  * No dict-union operator (|).
  * f-strings use ASCII quotes only.
"""

import json
import logging
import random
import re
from datetime import date

logger = logging.getLogger(__name__)


# =============================================================================
# 1. Description cleaner
# =============================================================================

_BOILERPLATE_PATTERNS = [
    # TurboTenant / Cozy / other portal boilerplate
    r"To apply,?\s+visit\s+TurboTenant[^.]*\.",
    r"apply here on TurboTenant[^.]*\.",
    r"Applications are only received through\s+TurboTenant[^.]*\.",
    r"search for Property ID\s+\d+[^.]*\.",
    r"FOLLOW these STEPS to END YOUR SEARCH[\s\S]*?(?=\n\n|\Z)",
    r"Showing\s+ID[:\s]+\d+[^.]*\.",
    # Tour / contact CTAs (Choice Properties is "apply first, tour later")
    r"Schedule (?:a|your) (?:free )?(?:showing|tour|viewing|walk-through)[^.!?]*[.!?]",
    r"Tour (?:today|now|this|the|available)[^.!?]*[.!?]",
    r"Contact\s+(?:us|the agent|the landlord|your|our)[^.]*for (?:more|a) (?:info|showing|tour)[^.]*\.",
    r"For more information.*?call[^.]*\.",
    r"Call (?:today|now|us|for)[^.!?]*[.!?]",
    r"Visit our website for more properties[^.]*\.",
    r"Don['']t miss (?:this|out)[^!.]*[!.]",
    r"This (?:won['']t|will not) last[^!.]*[!.]",
    r"Apply Now[^\n]*",
    r"Apply (?:today|now|online)[^!.]*[!.]",
    r"Move-in (?:today|now|immediately) -- [^.]*\.",
    # Screening language (platform handles this transparently)
    r"[Cc]redit score\s+(?:of\s+)?\d+\+?\s*(?:or (?:above|higher|more))?[^.]*\.",
    r"[Mm]ust (?:earn|make|have income of)\s+[\d.]+x?\s*(?:the\s+)?rent[^.]*\.",
    r"[Ii]ncome\s+(?:requirement|must be)\s+[\d.]+x?\s*(?:the\s+)?(?:monthly\s+)?rent[^.]*\.",
    r"[Mm]inimum (?:income|salary)[^.]*\d+[^.]*\.",
    r"[Nn]o [Ss]ection 8[^.]*\.",
    r"[Ss]ection 8\s+(?:not\s+)?(?:accepted|welcome)[^.]*\.",
    r"[Bb]ackground check(?:s)? required[^.]*\.",
    r"[Cc]redit check required[^.]*\.",
    r"All applicants must[^.]*\.",
    r"We (?:do not|don['']t) accept[^.]*applications[^.]*\.",
    # Separator lines
    r"-{8,}",
    r"={8,}",
    r"\*{8,}",
    r"_{8,}",
]

_BOILERPLATE_RE = [re.compile(p, re.IGNORECASE) for p in _BOILERPLATE_PATTERNS]


def clean_description(text):
    """
    Strip agent boilerplate, CTA language, and screening criteria from a
    scraped listing description.  Returns the cleaned string.
    """
    if not text:
        return text
    for pat in _BOILERPLATE_RE:
        text = pat.sub("", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = text.strip()
    return text


# =============================================================================
# 2. Watermark / competitor-brand filter
# =============================================================================

_WATERMARKED_BRANDS = (
    "firstkey",
    "first key",
    "firstkey homes",
    "first key homes",
    "era real",
    "era realty",
    "coldwell banker",
    "century 21",
    "keller williams",
    "re/max",
    "remax",
    "berkshire hathaway",
    "sotheby",
    "compass realty",
    "exp realty",
    "better homes and garden",
    "howard hanna",
    "long & foster",
    "weichert",
    "exit realty",
    "tricon residential",
    "tricon",
    "american homes 4 rent",
    "invitation homes",
    "progress residential",
    "main street renewal",
    "amh",                     # American Homes for Rent ticker
    "invitation_homes",
    "nfm lending",
)


def _norm(s):
    """Lowercase + collapse non-alphanumeric to spaces."""
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def is_watermarked(record):
    """
    Return True if this listing is branded by a competitor we don't publish.
    Checks agent_name, broker_name, description, showing_instructions, and
    the original_data JSON blob for broker/office/branding keys.
    """
    parts = []
    for key in ("agent_name", "broker_name", "description", "showing_instructions"):
        v = record.get(key)
        if v and isinstance(v, str):
            parts.append(v)

    try:
        od = json.loads(record.get("original_data") or "{}")
        for bkey in ("advertiser", "broker_name", "agent_name", "office_name",
                     "branding", "listed_by", "listing_agent"):
            v = od.get(bkey)
            if v and isinstance(v, str):
                parts.append(v)
    except Exception:
        pass

    if not parts:
        return False

    combined = _norm(" ".join(parts))
    for brand in _WATERMARKED_BRANDS:
        if brand in combined:
            return True
    return False


def watermark_reason(record):
    """Return the matched brand name for log output, or None."""
    parts = []
    for key in ("agent_name", "broker_name", "description", "showing_instructions"):
        v = record.get(key)
        if v and isinstance(v, str):
            parts.append(v)
    combined = _norm(" ".join(parts))
    for brand in _WATERMARKED_BRANDS:
        if brand in combined:
            return brand
    return None


# =============================================================================
# 3. Rule-based enrichment  (no API calls, runs locally)
# =============================================================================

_PET_YES_RE = re.compile(
    r"pets\s+(?:ok|allowed|welcome|permitted|friendly)"
    r"|pet[- ]friendly"
    r"|dogs?\s+(?:ok|allowed|welcome|permitted)"
    r"|cats?\s+(?:ok|allowed|welcome|permitted)"
    r"|small pets allowed"
    r"|pets welcome",
    re.IGNORECASE,
)
_PET_NO_RE = re.compile(
    r"no\s+pets"
    r"|pets?\s+not\s+allowed"
    r"|pet[- ]free"
    r"|sorry[,\s]+no pets"
    r"|no animals"
    r"|no dogs"
    r"|no cats",
    re.IGNORECASE,
)


def rule_based_enrich(record):
    """
    Fill common missing fields using deterministic rules.
    No network calls.  Modifies record in-place; returns record.
    """

    # 1. Auto-title if blank
    if not record.get("title"):
        beds = record.get("bedrooms")
        ptype = (record.get("property_type") or "Rental").replace("_", " ").title()
        city = record.get("city") or ""
        if beds and city:
            record["title"] = str(beds) + "BR " + ptype + " in " + city
        elif record.get("address"):
            record["title"] = record["address"]

    # 2. Default available_date to today if missing
    if not record.get("available_date"):
        record["available_date"] = date.today().isoformat()

    # 3. Default security_deposit to 1x rent if missing
    if not record.get("security_deposit"):
        rent = record.get("monthly_rent")
        if rent and isinstance(rent, (int, float)) and rent > 0:
            record["security_deposit"] = int(rent)

    # 4. Infer pet policy from description text
    if record.get("pets_allowed") is None:
        desc = (record.get("description") or "").lower()
        showing = (record.get("showing_instructions") or "").lower()
        text = desc + " " + showing
        if _PET_NO_RE.search(text):
            record["pets_allowed"] = False
        elif _PET_YES_RE.search(text):
            record["pets_allowed"] = True

    # 5. Application fee floor: never below $50
    fee = record.get("application_fee")
    if fee is None or (isinstance(fee, (int, float)) and fee < 50):
        record["application_fee"] = 50

    return record


# =============================================================================
# 4. Regex extraction from listing detail page
# =============================================================================

_AVAIL_DATE_PATTERNS = [
    r"Available\s+([A-Z][a-z]+ \d{1,2},? \d{4})",
    r"Move[- ]in[:\s]+([A-Z][a-z]+ \d{4})",
    r"Available\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})",
    r"(?i)date\s+available[:\s]+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})",
    r"(?i)available[:\s]+(immediately|now|move[- ]?in[- ]?ready)",
]

_DEPOSIT_PATTERNS = [
    r"[Ss]ecurity [Dd]eposit[:\s]+\$([0-9,]+)",
    r"\$([0-9,]+)\s+(?:security )?deposit",
    r"[Dd]eposit[:\s]+\$([0-9,]+)",
    r"security deposit[:\s]*([0-9,]+)",
]

_LEASE_MONTHS_PATTERNS = [
    r"(\d{1,2})[- ]month\s+lease",
    r"lease term[:\s]+(\d{1,2})\s+months?",
    r"minimum lease[:\s]+(\d{1,2})\s+months?",
    r"(\d{1,2})[- ]month\s+minimum",
]

_LAUNDRY_RULES = [
    (
        r"(?i)in[- ]unit laundry"
        r"|washer.*?dryer\s+in\s+unit"
        r"|w/?d\s+in\s+unit"
        r"|washer\s*/?\s*dryer\s+included",
        "In-unit laundry",
    ),
    (
        r"(?i)washer[- ]dryer hookups?"
        r"|laundry hookups?"
        r"|w/?d\s+hookups?"
        r"|washer.*?dryer\s+hookup",
        "Washer/dryer hookups",
    ),
    (
        r"(?i)shared laundry"
        r"|laundry\s+on[- ]site"
        r"|laundry\s+room"
        r"|coin[- ]operated laundry"
        r"|communal laundry",
        "Shared laundry",
    ),
]

_HEATING_RULES = [
    (r"(?i)forced[- ]air|gas\s+forced", "Forced Air"),
    (r"(?i)electric heat(?:ing)?", "Electric"),
    (r"(?i)baseboard heat(?:ing)?", "Baseboard"),
    (r"(?i)radiant heat(?:ing)?|radiant floor", "Radiant"),
    (r"(?i)heat pump", "Heat Pump"),
    (r"(?i)natural gas|gas heat(?:ing)?", "Gas"),
]

_COOLING_RULES = [
    (r"(?i)central (?:air|a/?c|cooling)", "Central Air"),
    (r"(?i)window\s+a/?c|window\s+air", "Window A/C"),
    (r"(?i)mini[- ]split|ductless", "Mini-split"),
    (r"(?i)evaporative|swamp cool", "Evaporative"),
    (r"(?i)no\s+(?:a/?c|air conditioning|cooling)", "None"),
]

# Only fetch detail pages for records below this quality score
_DETAIL_FETCH_THRESHOLD = 75


def regex_extract_missing(record, verbose=False):
    """
    Fetch the listing's source_url and use regex to fill any fields that
    structured scraping missed.

    Only runs when:
      - record has a source_url
      - data_quality_score < _DETAIL_FETCH_THRESHOLD
      - URL is not Zillow / HotPads (those need residential IP)

    Modifies record in-place; returns record.
    """
    url = record.get("source_url")
    score = record.get("data_quality_score") or 0

    if not url:
        return record
    if score >= _DETAIL_FETCH_THRESHOLD:
        return record

    # Skip sources that require residential IP or have their own detail fetcher
    skip_hosts = ("zillow.com", "hotpads.com", "zillowstatic.com", "trulia.com")
    for host in skip_hosts:
        if host in url:
            return record

    try:
        import requests as _req
    except ImportError:
        return record

    _UA_POOL = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    ]

    try:
        hdrs = {
            "User-Agent": random.choice(_UA_POOL),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "max-age=0",
        }
        resp = _req.get(url.split("?")[0], headers=hdrs, timeout=15, allow_redirects=True)
        if resp.status_code != 200:
            return record
        raw_html = resp.text
    except Exception as exc:
        if verbose:
            logger.debug("detail_fetch HTTP error for %s: %s", url[:80], str(exc)[:60])
        return record

    # Strip HTML tags → cleaner text for regex matching
    plain = re.sub(r"<[^>]+>", " ", raw_html)
    plain = re.sub(r"\s+", " ", plain)

    # available_date
    if not record.get("available_date"):
        for pat in _AVAIL_DATE_PATTERNS:
            m = re.search(pat, plain)
            if m:
                record["available_date"] = m.group(1).strip()
                break

    # security_deposit
    if not record.get("security_deposit"):
        for pat in _DEPOSIT_PATTERNS:
            m = re.search(pat, plain)
            if m:
                try:
                    record["security_deposit"] = int(m.group(1).replace(",", ""))
                    break
                except Exception:
                    pass

    # minimum_lease_months
    if not record.get("minimum_lease_months"):
        for pat in _LEASE_MONTHS_PATTERNS:
            m = re.search(pat, plain)
            if m:
                try:
                    record["minimum_lease_months"] = int(m.group(1))
                    break
                except Exception:
                    pass

    # laundry_type
    if not record.get("laundry_type"):
        for pat, label in _LAUNDRY_RULES:
            if re.search(pat, plain):
                record["laundry_type"] = label
                break

    # heating_type
    if not record.get("heating_type"):
        for pat, label in _HEATING_RULES:
            if re.search(pat, plain):
                record["heating_type"] = label
                break

    # cooling_type
    if not record.get("cooling_type"):
        for pat, label in _COOLING_RULES:
            if re.search(pat, plain):
                record["cooling_type"] = label
                break

    # pets_allowed (secondary pass from the actual page text)
    if record.get("pets_allowed") is None:
        if _PET_NO_RE.search(plain):
            record["pets_allowed"] = False
        elif _PET_YES_RE.search(plain):
            record["pets_allowed"] = True

    if verbose:
        logger.debug("regex_extract done for %s (score was %d)", url[:60], score)

    return record


# =============================================================================
# 5. Combined pipeline entry-point
# =============================================================================

def apply_enrichment_pipeline(records, verbose=False, enable_detail_fetch=True):
    """
    Run the full enrichment pipeline over a list of pipeline records.

    Steps (in order):
      1. Watermark filter  -- drop competitor-branded listings
      2. Description clean -- strip boilerplate from every description
      3. Rule-based enrich -- infer title, dates, deposit, pet policy, fee floor
      4. Regex detail fetch -- fetch page HTML for low-score records (optional)
      5. Re-score          -- recalculate data_quality_score after enrichment

    Returns:
      (enriched_records, count_watermarked)
    """
    import json as _json

    count_watermarked = 0
    clean_records = []

    for rec in records:
        # Step 1: watermark filter
        if is_watermarked(rec):
            count_watermarked += 1
            if verbose:
                brand = watermark_reason(rec) or "?"
                addr = (rec.get("address") or "") + " " + (rec.get("city") or "")
                print("  [watermark] Dropped: " + addr.strip() + " (matched: " + brand + ")")
            continue

        # Step 2: clean description
        if rec.get("description"):
            rec["description"] = clean_description(rec["description"])

        # Step 3: rule-based enrichment
        rule_based_enrich(rec)

        # Step 4: regex detail fetch (non-blocking — skips Zillow / high-score records)
        if enable_detail_fetch:
            try:
                regex_extract_missing(rec, verbose=verbose)
            except Exception as exc:
                if verbose:
                    logger.debug("regex_extract_missing error: %s", str(exc)[:80])

        clean_records.append(rec)

    # Step 5: re-score after enrichment
    if clean_records:
        _rescore(clean_records)

    if verbose and count_watermarked:
        print("  [enrichment] " + str(count_watermarked) + " watermarked listing(s) dropped")

    return clean_records, count_watermarked


# =============================================================================
# Internal helpers
# =============================================================================

_RESCORE_IMPORTANT = [
    "address", "city", "state", "zip", "lat", "lng",
    "bedrooms", "bathrooms", "square_footage", "monthly_rent",
    "property_type", "description", "available_date",
]
_RESCORE_BONUS = [
    "county", "neighborhood", "year_built", "parking",
    "pets_allowed", "security_deposit", "amenities", "appliances",
    "heating_type", "cooling_type", "laundry_type",
]
_RESCORE_TRACKABLE = [
    "lat", "lng", "county", "neighborhood", "year_built", "square_footage",
    "parking", "pets_allowed", "security_deposit", "amenities", "appliances",
    "available_date", "heating_type", "cooling_type", "laundry_type",
]


def _rescore(records):
    """Re-calculate data_quality_score + missing_fields after enrichment."""
    import json as _json

    for r in records:
        sc = 0
        for f in _RESCORE_IMPORTANT:
            if r.get(f) not in (None, "", "[]"):
                sc += 6
        for f in _RESCORE_BONUS:
            v = r.get(f)
            if v is True or v is False:
                sc += 2  # bool fields count as present
            elif v not in (None, "", "[]"):
                sc += 2
        try:
            n = len(_json.loads(r.get("original_image_urls") or "[]"))
        except Exception:
            n = 0
        sc += 6 if n >= 5 else (3 if n >= 1 else 0)
        r["data_quality_score"] = min(sc, 100)
        r["missing_fields"] = _json.dumps(
            [f for f in _RESCORE_TRACKABLE if r.get(f) in (None, "", "[]")]
        )
