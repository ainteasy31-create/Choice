#!/usr/bin/env python3
"""
# ============================================================
# AI ASSISTANT QUICK REFERENCE — READ THIS FIRST
# ============================================================
# This file enforces ALL mandatory platform rules automatically.
# You do NOT need to implement them manually in any batch script.
# Just call: PipelineOrchestrator(verbose=True).run(criteria)
#
# WHAT THIS FILE DOES (in order):
#   1. Drops listings branded by competitors (FirstKey, Invitation Homes,
#      Progress Residential, Tricon, Coldwell Banker, Keller Williams,
#      RE/MAX, Century 21, Berkshire Hathaway, Main Street Renewal, etc.)
#   2. Strips tour/showing/contact CTAs from descriptions
#   3. Strips external portal application instructions (TurboTenant,
#      Zillow/Apartments.com applications, Property ID references)
#   4. Strips agent/owner/manager name references
#   5. Strips brokerage/MLS branding
#   6. Strips corporate fee schedules
#   7. Removes individual branded/agent photos from the image list
#   8. Normalizes heating/cooling from raw MLS blobs
#   9. Infers missing: laundry, parking, pets, title, deposit
#  10. Fetches listing page HTML to fill low-score records
#  11. Enforces rent consistency (description must match monthly_rent)
#  12. Normalizes application fee to $50 in description
#  13. Appends "Apply now at Choice Properties" CTA
#  14. Validates before publish: ≥6 photos, rent set, no banned language
#  15. Re-scores every record (0–100 quality score)
#
# MANDATORY RULES (never bypass):
#   - Application fee = $50 always
#   - Security deposit = 1× monthly rent
#   - Pets allowed = Yes (always published as pet-friendly)
#   - Min 6 photos required before publishing
#   - All photos must be on ImageKit (never external URLs)
#   - Description must NOT contain: tour language, portal links,
#     agent names, competitor branding, wrong fee amounts
#   - Description MUST end with a Choice Properties apply CTA
#
# QUICK REFERENCE: see scraper/RULES.md (short, scannable version)
# FULL RULES:      see scraper/PLATFORM_RULES.md
# ============================================================

Choice Properties -- Enrichment Pipeline (v2)
=============================================
Post-processing applied to every scraped record before DB insert:

  1. clean_description                     -- strip TurboTenant / agent boilerplate + screening language
  1b. strip_external_application_instructions -- remove references to applying via a third-party portal
  1c. replace_owner_manager_references     -- remove property manager / owner / leasing-agent name references
  1d. strip_third_party_branding           -- remove brokerage / MLS / other-platform branding
  1e. normalize_application_fee_in_description -- replace any non-$50 fee or "free application" language
  2. strip_corporate_fees   -- remove management company fee blocks from descriptions
  3. is_watermarked         -- detect competitor-branded listings (drop before staging)
  4. normalize_hvac         -- parse raw MLS blobs into separate heating vs cooling fields
  5. rule_based_enrich      -- infer missing fields: laundry, parking, pets, title, deposit
  6. regex_extract_missing  -- fetch listing page and regex-extract missing fields
                               (Realtor/non-Zillow only; skips records scored >= 75)
  6a. enforce_price_consistency -- rewrite any stale rent figure in the description to match
                                   the final published monthly_rent

These are permanent rules applied to every scraped listing. Temporary,
batch-specific pricing/deposit adjustments (e.g. a one-off rent cap for a
particular scrape run) belong in a standalone script, not here — see
scraper/apply_batch_pricing.py.

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
    # ── Tour / showing / contact CTAs ──────────────────────────────────────────
    # Choice Properties policy: apply first, tour later. Strip ALL tour/contact
    # CTAs from scraped descriptions and replace with an apply-now CTA.
    r"Schedule (?:a|your|an) (?:free |private |self-guided )?(?:showing|tour|viewing|walk-?through|appointment|visit)[^.!?]*[.!?]",
    r"Tour (?:today|now|this|the|available|it)[^.!?]*[.!?]",
    r"(?:Book|Request|Arrange) (?:a|your|an) (?:private |self-guided |free )?(?:tour|showing|viewing|appointment|visit)[^.!?]*[.!?]",
    r"(?:In-person|Virtual|Self-guided) (?:tours?|showings?|viewings?) (?:available|scheduled|offered|by appointment)[^.!?]*[.!?]",
    r"(?:Available|Ready|Open) for (?:immediate |private )?(?:viewing|showing|tours?)[^.!?]*[.!?]",
    r"Contact\s+(?:us|the agent|the landlord|your|our|the owner|property management)[^.]*for (?:more|a) (?:info|showing|tour|viewing|details?)[^.!?]*[.!?]",
    r"Contact\s+(?:us|me|the (?:owner|landlord|agent|manager|management))[^.]*(?:to (?:schedule|arrange|view|see)|for (?:a|more))[^.!?]*[.!?]",
    r"(?:To|For) (?:schedule|arrange|book|request) (?:a|an|your)[^.!?]*(?:viewing|showing|tour|appointment|visit)[^.!?]*[.!?]",
    r"(?:Interested|Inquire|For (?:more )?(?:info|details?|information))[^.]*(?:contact|call|email|text|reach out|message)[^.!?]*[.!?]",
    r"For more (?:information|details?|info)[^.]*(?:contact|call|email|visit|reach)[^.!?]*[.!?]",
    r"For more information.*?call[^.]*\.",
    r"Call (?:today|now|us|for|to schedule)[^.!?]*[.!?]",
    r"(?:Email|Text|Message|Reach out to?) (?:us|me|the (?:owner|landlord|agent))[^.!?]*[.!?]",
    r"Visit our website for more properties[^.]*\.",
    r"Don['']t miss (?:this|out)[^!.]*[!.]",
    r"This (?:won['']t|will not) last[^!.]*[!.]",
    r"Apply Now[^\n]*",
    r"Apply (?:today|now|online)[^!.]*[!.]",
    r"Move-in (?:today|now|immediately) -- [^.]*\.",
    r"(?:contact|call|email) (?:for|to) (?:schedule|set up|arrange) (?:a |an )?(?:tour|showing|viewing)[^.!?]*[.!?]",
    # Additional tour/scheduling variants not caught above
    r"Schedule to (?:see|view|visit|tour)[^.!?]*[.!?]",
    r"[Vv]acant and (?:easy|available for|ready for) (?:view|viewing|showing)[^.!?]*\.?",
    # Photo disclaimer variants — "(PICTURES are of a similar unit)"
    r"\(PICTURES?\s+are\s+of\s+a\s+similar\s+unit[^)]*\)[.!?]?",
    r"\([Pp]hotos?\s+(?:are\s+of|may\s+(?:be\s+of|depict|show))\s+(?:a\s+)?similar\s+unit[^)]*\)[.!?]?",
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


def normalize_allcaps_description(text):
    """
    Convert fully ALL-CAPS descriptions to sentence case.

    If more than 70% of alphabetic characters are uppercase, the entire text
    is treated as an accidental ALL-CAPS MLS dump and converted to readable
    sentence case.  Normal mixed-case text is returned unchanged.
    """
    if not text:
        return text
    alpha = [c for c in text if c.isalpha()]
    if not alpha:
        return text
    upper_ratio = sum(1 for c in alpha if c.isupper()) / len(alpha)
    if upper_ratio < 0.70:
        return text  # already mixed-case — leave alone

    # Lower-case everything, then re-capitalize sentence starters
    lowered = text.lower()

    def _cap_after_punct(m):
        return m.group(1) + m.group(2).upper()

    result = re.sub(r"([.!?]\s+)([a-z])", _cap_after_punct, lowered)
    # Capitalize the very first character
    if result:
        result = result[0].upper() + result[1:]
    return result


# =============================================================================
# 2. Corporate management company fee block stripper
# =============================================================================

_CORPORATE_FEE_PATTERNS = [
    # Mynd / Invitation Homes / Progress Residential / Tricon style fee blocks
    r"ONE-TIME FEES[\s\S]*?(?=\n\n|\Z)",
    r"REQUIRED MONTHLY CHARGES[*\s\S]*?(?=\n\n|\Z)",
    r"Residents Benefits Package[^.]*\$[\d.]+[^.]*\.",
    r"Utility Management Fee[^.]*\.",
    r"\$\d+\.?\d*\s*/\s*month[:\s]+Residents Benefits",
    r"Non-refundable\s+\$\d+\.?\d*\s+Application Fee Per Adult",
    r"One Time Move In Fee\s+\$\d+[^.]*\.",
    r"utility set up fee[^.]*\.",
    r"Identity Theft Protection[^.]*\.",
    r"rewards program[^.]*\.",
    r"Federal Occupancy Guidelines[^.]*\.",
    r"(?:Mynd|Progress Residential|Tricon|Invitation Homes|Main Street Renewal)"
    r"[^.]*(?:Equal Opportunity|License #|Property Management)[^.]*\.",
    # Mynd "RENT WITH MYND" marketing block (full block and individual bullet lines)
    r"RENT WITH MYND[\s\S]*?(?=\n\n|\Z)",
    r"-\s*Fast Online Application\s*\([^)]*\)[^\n.]*\.?",
    r"-\s*Mobile App to Pay Rent[^\n.]*\.?",
    r"-\s*Affordable Renter['\u2019]?s Insurance[^\n.]*\.?",
    r"Lease term:\s*\d+\s*months?\.?",
    r"License #\s*\d+[^.]*\.",
    r"(?:does not advertise on Craigslist|never ask you to wire money)[^.]*\.",
    r"Please report any fraudulent ads[^.]*\.",
    r"Service provided through AT&T[^.]*\.",
    r"Second Nature[^.]*\.",
    r"No data caps[^\n]*\n?",
    r"No installation or hidden fees[^\n]*\n?",
    r"All equipment included[^\n]*\n?",
    r"See our website[^\n]*\n?",
]

_CORPORATE_FEE_RE = [re.compile(p, re.IGNORECASE) for p in _CORPORATE_FEE_PATTERNS]


def strip_corporate_fees(text):
    """
    Remove management company fee schedules and boilerplate that contradict
    Choice Properties' own $50 flat application fee.
    """
    if not text:
        return text
    for pat in _CORPORATE_FEE_RE:
        text = pat.sub("", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# =============================================================================
# 1b. External application instructions — remove references to applying
#     through any third-party portal or listing site.
# =============================================================================

_EXTERNAL_APPLICATION_PATTERNS = [
    r"[Aa]pply (?:through|via|on|at)\s+(?:TurboTenant|Zillow|Apartments\.com|Apartment List|RentSpree|RentCafe|Cozy|AppFolio|Rently|ShowMojo)[^.!?]*[.!?]",
    r"(?:TurboTenant|RentSpree|RentCafe|Cozy|AppFolio|Rently|ShowMojo)\s+application[^.!?]*[.!?]",
    r"[Aa]pplications?\s+(?:are\s+)?(?:only\s+)?(?:accepted|received|processed|submitted)\s+(?:through|via|on)\s+[A-Z][\w. ]*[.!?]",
    r"[Ss]earch\s+(?:for\s+)?[Pp]roperty\s*ID\s*#?\s*\d+[^.!?]*[.!?]",
    r"[Ll]isting\s*ID\s*#?\s*\d+[^.!?]*[.!?]",
    r"[Uu]se\s+(?:listing|property)\s+(?:ID|code)\s*#?\s*[\w-]+[^.!?]*[.!?]",
    r"[Vv]isit\s+(?:Zillow|Apartments\.com|Apartment List|Realtor\.com|Trulia|Hotpads)[^.!?]*[.!?]",
    r"[Cc]lick\s+(?:the\s+)?[\"']?[Aa]pply[\"']?\s+(?:button|link)[^.!?]*[.!?]",
]
_EXTERNAL_APPLICATION_RE = [re.compile(p) for p in _EXTERNAL_APPLICATION_PATTERNS]


def strip_external_application_instructions(text):
    """Remove any instructions to apply through a third-party portal/site."""
    if not text:
        return text
    for pat in _EXTERNAL_APPLICATION_RE:
        text = pat.sub("", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# =============================================================================
# 1c. Property manager / owner / third-party brand references — replace with
#     "Choice Properties" (owner/manager mentions) or remove outright
#     (brokerage / MLS / other-platform branding).
# =============================================================================

_OWNER_MANAGER_PATTERNS = [
    r"[Cc]ontact\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:to|for|at)[^.!?]*[.!?]",
    r"[Mm]anaged\s+by\s+[A-Z][\w.&' -]+[.!?]",
    r"[Pp]roperty\s+manager[:\s]+[A-Z][\w.&' -]+[.!?]?",
    r"[Ll]easing\s+agent[:\s]+[A-Z][\w.&' -]+[.!?]?",
    r"[Oo]wner[:\s]+[A-Z][\w.&' -]+[.!?]?",
    r"[Cc]all\s+or\s+text\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:at|for)[^.!?]*[.!?]",
]
_OWNER_MANAGER_RE = [re.compile(p) for p in _OWNER_MANAGER_PATTERNS]

_THIRD_PARTY_BRAND_PATTERNS = [
    r"[Ll]isted\s+by\s+[A-Z][\w.&' -]+[.!?]?",
    r"[Cc]ourtesy\s+of\s+[A-Z][\w.&' -]+[.!?]?",
    r"MLS\s*#?\s*[\w-]+",
    r"[Bb]rokered\s+by\s+[A-Z][\w.&' -]+[.!?]?",
    r"[Pp]resented\s+by\s+[A-Z][\w.&' -]+[.!?]?",
]
_THIRD_PARTY_BRAND_RE = [re.compile(p) for p in _THIRD_PARTY_BRAND_PATTERNS]

# Brand names from the existing watermark list double as brokerage/company
# names to strip outright when they appear inline in a description that is
# otherwise being kept (e.g. "Also listed with Keller Williams"). Built lazily
# since _WATERMARKED_BRANDS is defined further down in this module.
_INLINE_BRAND_RE = None


def _inline_brand_re():
    global _INLINE_BRAND_RE
    if _INLINE_BRAND_RE is None:
        _INLINE_BRAND_RE = re.compile(
            r"\b(?:" + "|".join(re.escape(b) for b in _WATERMARKED_BRANDS if len(b) > 3) + r")\b",
            re.IGNORECASE,
        )
    return _INLINE_BRAND_RE


def replace_owner_manager_references(text):
    """
    Remove property-manager/owner/leasing-agent name references. Choice
    Properties is the public-facing representative for every listing, so we
    strip the personal reference rather than substitute a sentence back in
    (avoids inventing contact instructions we don't actually offer).
    """
    if not text:
        return text
    for pat in _OWNER_MANAGER_RE:
        text = pat.sub("", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def strip_third_party_branding(text):
    """Remove brokerage / MLS / other-platform branding from descriptions."""
    if not text:
        return text
    for pat in _THIRD_PARTY_BRAND_RE:
        text = pat.sub("", text)
    text = _inline_brand_re().sub("", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


# =============================================================================
# 1d. Price consistency — a description must never quote a rent figure that
#     differs from the property's final published monthly_rent.
# =============================================================================

_PRICE_MENTION_RE = re.compile(r"\$\s?[\d,]+(?:\.\d{2})?\s*(?:/\s*(?:mo|month)|per\s+month|monthly)?", re.IGNORECASE)


def enforce_price_consistency(text, published_rent):
    """
    Replace any dollar figure in the description that looks like a rent
    quote with the final published rent, so the description never
    contradicts the price shown on the listing (e.g. after a price
    adjustment). Only touches amounts followed/preceded by rent-ish context
    ("/mo", "per month", "rent of $X") to avoid mangling unrelated dollar
    figures such as deposits or fees mentioned elsewhere.
    """
    if not text or not published_rent:
        return text

    rent_str = "${:,.0f}/month".format(published_rent)

    def _sub(match):
        snippet = match.group(0)
        # Only replace if this mention has explicit monthly-rent context.
        if re.search(r"/\s*(?:mo|month)|per\s+month|monthly", snippet, re.IGNORECASE):
            return rent_str
        return snippet

    return _PRICE_MENTION_RE.sub(_sub, text)


# =============================================================================
# 1e. Application fee normalization in descriptions
#     Choice Properties charges a flat $50 application fee.
#     Any description that mentions a different fee amount — or states the
#     application is free — must be corrected before the listing goes live.
# =============================================================================

# Matches explicit fee amounts: $35, $40.00, "fee of 75", "fee: 60", etc.
_APP_FEE_AMOUNT_RE = re.compile(
    r"""
    (?:
        # Pattern A: "$XX" or "$XX.00" optionally followed by fee context
        \$\s*0*(\d{1,4}(?:\.\d{2})?)\s*
        (?:(?:application|app|rental|non[- ]?refundable)[\s\w]*fee)?
    |
        # Pattern B: "application fee" label then an amount (with or without $)
        (?:application|app)\s+fee[:\s]+\$?\s*0*(\d{1,4}(?:\.\d{2})?)
    |
        # Pattern C: "fee of/is XX dollars" narrative forms
        (?:fee\s+(?:of|is|:)\s+\$?\s*0*(\d{1,4}(?:\.\d{2})?)
        |0*(\d{1,4})\s+dollars?\s+(?:application|app)\s+fee)
    )
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Matches any wording that indicates the application is free
_FREE_APP_RE = re.compile(
    r"""
    (?:
        free\s+(?:to\s+)?apply(?:\s+today)?               # free to apply, free apply
    |   apply\s+for\s+free                                # apply for free
    |   no\s+(?:application\s+|app\s+)?fee               # no application fee, no app fee, no fee
    |   \$\s*0\.?0*\s+(?:application\s+|app\s+)?fee      # $0 application fee, $0.00 fee
    |   zero\s+(?:application\s+|app\s+)?fee              # zero application fee
    |   complimentary\s+application                       # complimentary application
    |   application\s+(?:is\s+)?free                      # application is free, application free
    |   fee[- ]?free\s+application                        # fee-free application
    |   free\s+application                                # free application
    )
    [^.!?\n]*                                             # rest of the sentence
    [.!?\n]?                                              # optional sentence terminator
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Sentence-level patterns that explicitly state fee amounts in context
_FEE_SENTENCE_RE = re.compile(
    r"[^.!?\n]*"
    r"(?:application|app|rental)\s+fee[^.!?\n]*"
    r"[.!?\n]",
    re.IGNORECASE,
)

_NORMALIZED_FEE_STATEMENT = "Application Fee: $50."


def normalize_application_fee_in_description(text):
    """
    Enforce Choice Properties' $50 application fee throughout a listing
    description.

    Two passes:
      1. Free-application language  -- any wording that implies $0 or "free"
         is replaced with "Application Fee: $50."
      2. Other fee amounts          -- sentences that reference a specific fee
         amount other than $50 are rewritten to "Application Fee: $50."

    Only the description text is changed; structured fields (application_fee)
    are handled separately by rule_based_enrich.
    """
    if not text:
        return text

    # Pass 1: replace free-application wording
    text = _FREE_APP_RE.sub(_NORMALIZED_FEE_STATEMENT + " ", text)

    # Pass 2: find remaining explicit fee-sentence mentions and normalize them.
    # We look for sentences that talk about an "application fee" and contain
    # a dollar amount that is not $50 / 50.
    def _fix_fee_sentence(m):
        sentence = m.group(0)
        # Extract any dollar amount from the sentence
        amounts = re.findall(r"\$?\s*(\d+(?:\.\d{2})?)", sentence)
        for amt_str in amounts:
            try:
                amt = float(amt_str.replace(",", ""))
            except ValueError:
                continue
            # If the amount is not $50, replace the whole sentence
            if abs(amt - 50) > 0.01:
                return _NORMALIZED_FEE_STATEMENT + " "
        return sentence

    text = _FEE_SENTENCE_RE.sub(_fix_fee_sentence, text)

    # Collapse any double spaces or triple newlines left by substitutions
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# =============================================================================
# Pre-publish validation gate
#     Call validate_for_publish(record) before any pipeline_publish action.
#     Returns (True, []) on success or (False, [reason1, reason2, ...]).
#     These checks mirror the mandatory publishing requirements defined in
#     scraper/PLATFORM_RULES.md.
# =============================================================================

def validate_for_publish(record, transferred_photo_count=None):
    """
    Gate check executed before a pipeline record is promoted to a live listing.

    Args:
        record: pipeline_properties dict.
        transferred_photo_count: number of photos already confirmed uploaded to
            ImageKit (from property_photos table). Pass this when the record has
            already been published once and ImageKit transfer status is known.
            If None, falls back to checking original_image_urls (source photos
            exist and will be transferred by import-pipeline-photos post-publish).

    Returns:
        (ok: bool, failures: list[str])

    A record must pass ALL checks to receive ok=True. Any failure keeps the
    record in the pipeline at 'pending_review' status and must be logged.
    """
    failures = []
    desc = record.get("description") or ""

    # 1. Image check — two-tier:
    #    Tier A (preferred): caller provides the actual ImageKit transfer count.
    #    Tier B (fallback):  inspect original_image_urls to verify source photos
    #                        exist that can be transferred post-publish.
    MIN_PHOTOS = 6
    if transferred_photo_count is not None:
        # Real ImageKit signal — use it directly
        if transferred_photo_count < MIN_PHOTOS:
            failures.append(
                "Only {} photo(s) on ImageKit; minimum is {} before publishing".format(
                    transferred_photo_count, MIN_PHOTOS)
            )
    else:
        # Fallback: source photos must exist (import-pipeline-photos will
        # transfer them immediately after publish)
        raw_urls = record.get("original_image_urls") or "[]"
        try:
            urls = raw_urls if isinstance(raw_urls, list) else __import__("json").loads(raw_urls)
        except Exception:
            urls = []
        if len(urls) < MIN_PHOTOS:
            failures.append(
                "Only {} source photo(s) found; minimum is {} before publishing".format(
                    len(urls), MIN_PHOTOS)
            )

    # 2. Description must not imply a free application
    if _FREE_APP_RE.search(desc):
        failures.append("Description contains free-application language")

    # 3. Description must not reference an application fee other than $50.
    # Two patterns are checked:
    #   a. Trailing-dollar: "application fee: $35" or "application fee 40"
    #   b. Leading-dollar:  "$35 application fee" or "a $40 app fee"
    _fee_amounts = []
    for m in re.finditer(r"(?:application|app)\s+fee[:\s]+\$?\s*(\d+(?:\.\d{2})?)", desc, re.IGNORECASE):
        _fee_amounts.append(m.group(1))
    for m in re.finditer(r"\$\s*(\d+(?:\.\d{2})?)\s+(?:application|app)\s+fee", desc, re.IGNORECASE):
        _fee_amounts.append(m.group(1))
    for amt_str in _fee_amounts:
        try:
            if abs(float(amt_str) - 50) > 0.01:
                failures.append("Description references a non-$50 application fee: $" + amt_str)
        except ValueError:
            pass

    # 4. Description must not contain tour/showing/contact CTAs
    _TOUR_CHECK = re.compile(
        r"schedule\s+a\s+(?:tour|showing|viewing)"
        r"|book\s+a\s+(?:tour|showing)"
        r"|open\s+house"
        r"|contact\s+(?:us|the\s+agent|the\s+landlord|owner)",
        re.IGNORECASE,
    )
    if _TOUR_CHECK.search(desc):
        failures.append("Description contains tour/showing/contact CTA language")

    # 5. Description must not reference external application portals
    _PORTAL_CHECK = re.compile(
        r"turbotenant|zillow\s+application|apartments\.com|apply\s+on\s+\w+",
        re.IGNORECASE,
    )
    if _PORTAL_CHECK.search(desc):
        failures.append("Description references an external application portal")

    # 6. Rent must be set
    if not record.get("monthly_rent"):
        failures.append("monthly_rent is missing")

    return (len(failures) == 0, failures)


# =============================================================================
# 3. Watermark / competitor-brand filter
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
    "amh",
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
# 3b. Branded photo filter — remove individual photos showing company branding
# =============================================================================
#
# Two-tier strategy (no vision AI required):
#   Tier 1 — URL pattern matching: many corporate/agent branded photos carry
#             the company name or a recognisable path segment in their CDN URL.
#   Tier 2 — Domain-level blocking: photos served from known real-estate-agent
#             CDNs that never host raw property shots.
#
# If a photo passes both checks it is kept.  If ALL photos are removed this
# way the record is NOT dropped — the pipeline still has the listing text and
# can be published without photos, or a staff member can add photos manually.
# Whole-listing removal for brand-pervasive listings is already handled by
# is_watermarked() at step 1.

_BRANDED_PHOTO_URL_PATTERNS = [
    # ── Known corporate real-estate brand names in URLs ──────────────────────
    r"firstkeyhomes?",
    r"invitationhomes?",
    r"progressresidential",
    r"triconresidential",
    r"mainstreet(?:renewal|homes?)",
    r"amhresidential",
    r"coldwellbanker",
    r"century21",
    r"kellerwilliams",
    r"(?:re[_/-]?max|remax)",
    r"berkshirehathaway",
    r"compassrealty",
    r"exprealty",
    r"howardhanna",
    r"weichert",
    r"sothebysrealty",
    # ── Agent / brokerage photo paths (headshots, team shots, logos) ─────────
    r"/agent[_-](?:photo|image|headshot|portrait|pic)",
    r"/broker[_-](?:photo|image|headshot)",
    r"/headshot",
    r"/team[_-]photo",
    r"/staff[_-]photo",
    r"/office[_-](?:exterior|photo|image|building)",
    r"/company[_-](?:logo|photo|image|brand)",
    r"/brand[_-](?:logo|photo|image)",
    r"/agent_avatar",
    r"/realtor[_-](?:photo|image|headshot)",
    r"[?&]source=agent",
    r"[?&]type=agent",
    r"/logo\.",
    r"/watermark",
    # ── Domains that serve only agent / listing-service branding ─────────────
    r"agent\.realtor\.com/",
    r"headshots\.realtor\.com/",
    r"photos\.cbkw\.com/",  # Coldwell Banker KW
]

_BRANDED_PHOTO_RE = [re.compile(p, re.IGNORECASE) for p in _BRANDED_PHOTO_URL_PATTERNS]


def filter_branded_photos(photo_urls):
    """
    Given a list of photo URLs, remove any that appear to show company
    branding, agent headshots, or office photos rather than the property.
    URLs that match any _BRANDED_PHOTO_RE pattern are removed.
    Returns the filtered list (may be empty — caller decides what to do).
    """
    if not photo_urls:
        return photo_urls

    filtered = []
    for url in photo_urls:
        if not url:
            continue
        branded = any(pat.search(url) for pat in _BRANDED_PHOTO_RE)
        if not branded:
            filtered.append(url)

    return filtered


def filter_record_photos(record):
    """
    Apply filter_branded_photos to the original_image_urls field of a record.
    Modifies record in-place and returns it.
    Logs how many photos were removed if any.
    """
    raw = record.get("original_image_urls")
    if not raw:
        return record

    try:
        urls = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(urls, list):
            return record
        filtered = filter_branded_photos(urls)
        removed = len(urls) - len(filtered)
        if removed:
            logger.debug(
                "filter_record_photos: removed %d branded photo(s) from %s",
                removed,
                (record.get("address") or record.get("source_listing_id") or "?"),
            )
        record["original_image_urls"] = json.dumps(filtered)
    except Exception:
        pass

    return record


# =============================================================================
# 3c. Apply Now CTA — append a Choice Properties call-to-action to every
#     description so every listing ends with an invitation to apply.
# =============================================================================

_APPLY_CTAS = [
    "Ready to make this your new home? Submit your rental application today at Choice Properties.",
    "Love what you see? Apply now through Choice Properties and take the next step toward your new home.",
    "This home is ready for you. Submit your application now at Choice Properties.",
    "Interested? Apply today through Choice Properties — applications are reviewed promptly.",
    "Don't wait on a great home. Apply now at Choice Properties and secure this listing today.",
    "Your next home is waiting. Submit your application at Choice Properties to get started.",
    "Like what you see? Apply now — Choice Properties makes the rental process simple and straightforward.",
]

# Detect if a CTA-like phrase already appears at the TAIL of the description
# (last ~300 chars) so we don't double-add while still appending when "apply"
# language appears only in the body of the text (e.g. "you can apply here on
# TurboTenant" that survived cleaning, or amenity text mentioning "applicable").
_CTA_ALREADY_RE = re.compile(
    r"apply\s+now|submit\s+(?:your\s+)?application|apply\s+today|apply\s+online"
    r"|choice\s+properties.*apply",
    re.IGNORECASE,
)

_CTA_TAIL_CHARS = 300   # how many characters from the end to scan


def append_apply_cta(description):
    """
    Append a Choice Properties 'apply now' call-to-action to the end of the
    description, unless one is already present AT THE END.

    Scans only the final _CTA_TAIL_CHARS characters so incidental 'apply'
    language that appears earlier in the body (e.g. surviving portal copy or
    amenity text) does not suppress CTA insertion.

    Uses a stable selection (based on description length) so re-enriching the
    same record produces the same CTA — no randomness required.
    """
    if not description:
        return description

    # Only skip if a CTA is already present in the TAIL of the description.
    tail = description[-_CTA_TAIL_CHARS:]
    if _CTA_ALREADY_RE.search(tail):
        return description

    # Pick CTA deterministically (stable across re-runs of same description)
    idx = len(description) % len(_APPLY_CTAS)
    cta = _APPLY_CTAS[idx]

    description = description.rstrip()
    if description and description[-1] not in ".!?":
        description += "."

    return description + "\n\n" + cta


# =============================================================================
# 4. HVAC normalization — parse raw MLS blobs into separate heating/cooling
# =============================================================================

def normalize_heating_type(raw):
    """
    Extract the heating type from a raw MLS combined text like:
      "Cooling Features: Central, Ceiling Fan(s), Heating Features: Central, Gas, ..."
    or a bare fireplace descriptor like "Number of Fireplaces: 1".

    Returns a clean heating label or None if no real heating info found.
    """
    if not raw:
        return None

    text = str(raw).strip()

    # If the blob contains "Heating Features:", extract just that portion
    m = re.search(r"Heating Features?[:\s]+([^,]+(?:,\s*[^,]+){0,3})", text, re.IGNORECASE)
    if m:
        val = m.group(1).strip()
        # Stop at the next keyword label (e.g. "Cooling Features:", "Number of")
        val = re.split(r",?\s*(?:Cooling|Fireplace|Number of|Ceiling|Heating:)", val)[0].strip()
        val = val.rstrip(",").strip()
        if val and len(val) > 2:
            return val

    # If it's just "Number of Fireplaces: N" with nothing else heating-related, return None
    # (fireplaces are an amenity, not a heating system)
    if re.match(r"^Number of Fireplaces\s*:", text, re.IGNORECASE):
        return None

    # Apply rule-based labels to the full text
    for pat, label in _HEATING_RULES:
        if re.search(pat, text):
            return label

    # If there's no heating signal at all in the blob, return None
    if not re.search(r"heat|furnace|boiler|gas|electric|radiator|baseboard", text, re.IGNORECASE):
        return None

    return None


def normalize_cooling_type(raw):
    """
    Extract the cooling type from a raw MLS combined text.
    Returns a clean cooling label or None if no real cooling info found.
    """
    if not raw:
        return None

    text = str(raw).strip()

    # If the blob contains "Cooling Features:", extract just that portion
    m = re.search(r"Cooling Features?[:\s]+([^,]+(?:,\s*[^,]+){0,3})", text, re.IGNORECASE)
    if m:
        val = m.group(1).strip()
        val = re.split(r",?\s*(?:Heating|Fireplace|Number of|Ceiling|Cooling:)", val)[0].strip()
        val = val.rstrip(",").strip()
        if val and len(val) > 2:
            return val

    # Fireplace-only descriptor has no cooling info
    if re.match(r"^Number of Fireplaces\s*:", text, re.IGNORECASE):
        return None

    # Apply rule-based labels
    for pat, label in _COOLING_RULES:
        if re.search(pat, text):
            return label

    if not re.search(r"cool|air|ac|a/c|refrigerat|central|hvac", text, re.IGNORECASE):
        return None

    return None


def normalize_hvac(record):
    """
    Normalize heating_type and cooling_type in-place.
    - If both are identical raw blobs, parse them separately.
    - Strip fireplace descriptors that aren't real HVAC data.
    - Apply rule-based labels from the raw text.
    """
    ht = record.get("heating_type")
    ct = record.get("cooling_type")

    # Both identical (the common MLS blob duplication bug) or either is raw MLS text
    raw_signals = [
        "Cooling Features:",
        "Heating Features:",
        "Number of Fireplaces:",
        "Ceiling Fan",
        "Fireplace Features:",
    ]

    def _looks_raw(v):
        if not v:
            return False
        return any(sig.lower() in v.lower() for sig in raw_signals)

    if _looks_raw(ht) or _looks_raw(ct):
        # Use the richer of the two blobs as source for both
        source = ht if (len(str(ht or "")) >= len(str(ct or ""))) else ct
        record["heating_type"] = normalize_heating_type(source)
        record["cooling_type"] = normalize_cooling_type(source)
    elif ht == ct and ht is not None:
        # Identical but not obviously raw — still try to separate
        record["heating_type"] = normalize_heating_type(ht)
        record["cooling_type"] = normalize_cooling_type(ct)

    return record


# =============================================================================
# 5. Rule-based enrichment  (no API calls, runs locally)
# =============================================================================

_PET_YES_RE = re.compile(
    r"pets\s+(?:ok|allowed|welcome|permitted|friendly|are allowed)"
    r"|pet[- ]friendly"
    r"|dogs?\s+(?:ok|allowed|welcome|permitted)"
    r"|cats?\s+(?:ok|allowed|welcome|permitted)"
    r"|small pets allowed"
    r"|pets welcome"
    r"|pets\s+are\s+allowed"
    r"|animals\s+(?:ok|allowed|welcome)"
    r"|pet\s+(?:ok|friendly)",
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

# Laundry inference — checked against amenity tags (lowercase)
_LAUNDRY_IN_UNIT_TAGS = {
    "washer_dryer", "washer/dryer", "in_unit_laundry", "in-unit_laundry",
    "laundry_in_unit", "washer_and_dryer", "full_size_w_d",
}
_LAUNDRY_HOOKUP_TAGS = {
    "washer_dryer_hookups", "laundry_hookup", "w/d_hookup",
    "washer_dryer_connections", "laundry_connections",
}

_LAUNDRY_IN_UNIT_RE = re.compile(
    r"washer[/\s-]*dryer\s+(?:in\s+unit|included|in\s+home|in\s+apartment)"
    r"|in[- ]unit\s+(?:laundry|washer)"
    r"|w/?d\s+in\s+unit"
    r"|(?:washer|dryer)\s+included",
    re.IGNORECASE,
)
_LAUNDRY_HOOKUP_RE = re.compile(
    r"washer[/\s-]*dryer\s+hookups?"
    r"|laundry\s+hookups?"
    r"|w/?d\s+hookups?"
    r"|washer\s+and\s+dryer\s+hookup",
    re.IGNORECASE,
)

# Parking inference from amenity tags
_GARAGE_TAGS_RE = re.compile(
    r"garage_(\d+)_or_more|garage_spaces?_(\d+)|attached_garage|detached_garage",
    re.IGNORECASE,
)
_PARKING_DESC_RE = re.compile(
    r"(\d+)[- ]car\s+(?:attached\s+)?garage"
    r"|(\d+)\s+car\s+garage"
    r"|two[- ]car\s+garage"
    r"|2[- ]car\s+garage",
    re.IGNORECASE,
)

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


def _infer_laundry(record):
    """
    Infer laundry_type from amenity tags and description.
    Priority: in-unit > hookups > shared > keep existing.
    """
    existing = record.get("laundry_type")
    desc = (record.get("description") or "").lower()
    amenities_raw = record.get("amenities") or "[]"

    try:
        amenities_list = json.loads(amenities_raw) if isinstance(amenities_raw, str) else amenities_raw
    except Exception:
        amenities_list = []

    amenity_tags = set(str(a).lower().replace(" ", "_") for a in amenities_list)

    # Check amenity tags for in-unit signals
    if amenity_tags & _LAUNDRY_IN_UNIT_TAGS:
        return "In-unit"

    # Check description for in-unit signals
    if _LAUNDRY_IN_UNIT_RE.search(desc):
        return "In-unit"

    # Check amenity tags for hookup signals
    if amenity_tags & _LAUNDRY_HOOKUP_TAGS:
        return "Washer/dryer hookups"

    # Check description for hookup signals
    if _LAUNDRY_HOOKUP_RE.search(desc):
        return "Washer/dryer hookups"

    # If existing is "Shared laundry" but description mentions laundry room (in-building),
    # keep it — shared laundry is correct in that case.
    # If existing is "Shared laundry" but no supporting evidence, clear it.
    if existing == "Shared laundry":
        if re.search(r"shared laundry|laundry\s+on[- ]site|coin[- ]operated|communal laundry", desc, re.IGNORECASE):
            return "Shared laundry"
        # Laundry_room tag alone is ambiguous — could be in-unit or shared building laundry room
        if "laundry_room" in amenity_tags:
            # If description also hints at in-unit room, treat as in-unit
            if re.search(r"laundry\s+room\s+(?:in|inside|within|attached)", desc, re.IGNORECASE):
                return "In-unit"
            # Otherwise keep shared since that's what the MLS said
            return "Shared laundry"
        # No evidence for shared — clear the false default
        return None

    return existing


def _infer_parking(record):
    """
    Infer parking description from amenity tags and description text.
    Returns a parking string or None.
    """
    if record.get("parking"):
        return record["parking"]

    desc = record.get("description") or ""
    amenities_raw = record.get("amenities") or "[]"

    try:
        amenities_list = json.loads(amenities_raw) if isinstance(amenities_raw, str) else amenities_raw
    except Exception:
        amenities_list = []

    amenity_tags = " ".join(str(a).lower().replace(" ", "_").replace("-", "_") for a in amenities_list)
    desc_and_tags = desc + " " + amenity_tags

    # Check amenity tags for garage info
    m = _GARAGE_TAGS_RE.search(amenity_tags)
    if m:
        n = m.group(1) or m.group(2)
        if n:
            return n + "-car garage"
        if "attached" in amenity_tags:
            return "Attached garage"
        return "Garage"

    # Detect attached/detached garage in amenities text
    if "attached_garage" in amenity_tags or "garage attached" in amenity_tags:
        return "Attached garage"
    if "detached_garage" in amenity_tags:
        return "Detached garage"
    if re.search(r"\bgarage\b", amenity_tags):
        # Try to get count from description
        md = _PARKING_DESC_RE.search(desc)
        if md:
            n = md.group(1) or md.group(2)
            if n:
                return n + "-car garage"
            if "two" in (md.group(0) or "").lower():
                return "2-car garage"
        return "Garage"

    # Check description for garage mentions
    md = _PARKING_DESC_RE.search(desc)
    if md:
        n = md.group(1) or md.group(2)
        if n:
            return n + "-car garage"
        if "two" in (md.group(0) or "").lower():
            return "2-car garage"
        return "Attached garage"

    # Driveway / off-street
    if re.search(r"\bdriveway\b|\boff[- ]street\b", desc_and_tags, re.IGNORECASE):
        return "Driveway"

    # Carport
    if re.search(r"\bcarport\b", desc_and_tags, re.IGNORECASE):
        return "Carport"

    return None


def rule_based_enrich(record):
    """
    Fill common missing fields using deterministic rules.
    No network calls.  Modifies record in-place; returns record.
    """

    def _normalize_text(value):
        if not value:
            return ""
        if isinstance(value, str):
            return value.strip()
        return str(value).strip()

    def _normalize_amenity_tags(amenities_raw):
        try:
            alist = json.loads(amenities_raw) if isinstance(amenities_raw, str) else amenities_raw
        except Exception:
            alist = []
        tags = []
        seen = set()
        for item in alist:
            s = str(item).strip()
            if not s:
                continue
            lowered = s.lower()
            if lowered in seen:
                continue
            tags.append(s)
            seen.add(lowered)
        return tags

    # 1. Auto-title with key feature
    if not record.get("title"):
        beds = record.get("bedrooms")
        ptype = (record.get("property_type") or "Rental").replace("_", " ").title()
        city = record.get("city") or ""
        if beds and city:
            record["title"] = str(beds) + "BR " + ptype + " in " + city
        elif record.get("address"):
            record["title"] = record["address"]

    # 1b. Improve generic title with a key feature
    title = record.get("title") or ""
    if title and re.match(r"^\d+BR\s+\w+\s+in\s+\w+", title):
        feature = None
        amenities_raw = record.get("amenities") or "[]"
        atags = " ".join(str(a).lower() for a in _normalize_amenity_tags(amenities_raw))
        if re.search(r"garage|garage_\d", atags):
            feature = "w/ Garage"
        elif re.search(r"pool|swimming", atags):
            feature = "w/ Pool"
        elif re.search(r"fenced_yard|big_yard", atags):
            feature = "w/ Yard"
        elif re.search(r"pet|pets", atags):
            feature = "w/ Pets"
        if feature:
            record["title"] = title + " " + feature

    # 2. available_date: only default to today if listing signals "available now"
    if not record.get("available_date"):
        desc = (record.get("description") or "").lower()
        if re.search(r"available\s+(?:now|immediately)|move[- ]in\s+ready|immediate(?:ly)?\s+available", desc):
            record["available_date"] = date.today().isoformat()
        # Otherwise leave as None — don't mislead with today's date

    # 3. Default security_deposit to 1x rent if missing
    if not record.get("security_deposit"):
        rent = record.get("monthly_rent")
        if rent and isinstance(rent, (int, float)) and rent > 0:
            record["security_deposit"] = int(rent)

    # 4. Infer pet policy from description + amenity tags
    if record.get("pets_allowed") is None:
        desc = (record.get("description") or "").lower()
        showing = (record.get("showing_instructions") or "").lower()
        text = desc + " " + showing

        # Also check amenity tags for pet signals
        amenities_raw = record.get("amenities") or "[]"
        try:
            alist = json.loads(amenities_raw) if isinstance(amenities_raw, str) else amenities_raw
        except Exception:
            alist = []
        atags = " ".join(str(a).lower().replace(" ", "_").replace("-", "_") for a in alist)
        if "pets_allowed" in atags or "pet_friendly" in atags or "cats_allowed" in atags or "dogs_allowed" in atags:
            record["pets_allowed"] = True
        elif "no_pets" in atags or "pets_not_allowed" in atags:
            record["pets_allowed"] = False
        elif _PET_NO_RE.search(text):
            record["pets_allowed"] = False
        elif _PET_YES_RE.search(text):
            record["pets_allowed"] = True

    # 5. Application fee floor: never below $50
    fee = record.get("application_fee")
    if fee is None or (isinstance(fee, (int, float)) and fee < 50):
        record["application_fee"] = 50

    # 6. Infer laundry_type from amenities + description
    inferred_laundry = _infer_laundry(record)
    if inferred_laundry != record.get("laundry_type"):
        record["laundry_type"] = inferred_laundry

    # 7. Infer parking from amenities + description
    inferred_parking = _infer_parking(record)
    if inferred_parking and not record.get("parking"):
        record["parking"] = inferred_parking

    # 7b. Add a more explicit parking inference for amenity tags even when the
    # description is sparse or absent.
    if not record.get("parking"):
        amenities_raw = record.get("amenities") or "[]"
        tags = [str(tag).lower() for tag in _normalize_amenity_tags(amenities_raw)]
        if any("garage" in tag for tag in tags):
            if any("garage_2" in tag or "2_car_garage" in tag for tag in tags):
                record["parking"] = "2-car garage"
            elif any("garage_1" in tag or "1_car_garage" in tag for tag in tags):
                record["parking"] = "1-car garage"
            else:
                record["parking"] = "Garage"

    # 8. Normalize amenities: strip raw MLS label prefixes, keep clean tags
    amenities_raw = record.get("amenities") or "[]"
    try:
        alist = json.loads(amenities_raw) if isinstance(amenities_raw, str) else amenities_raw
    except Exception:
        alist = []
    clean_amenities = []
    seen_a = set()
    for item in alist:
        s = str(item).strip()
        # Strip known MLS prefix patterns like "Interior Amenities: ...", "Flooring: ..."
        cleaned = re.sub(
            r"^(?:Interior Amenities|Exterior Amenities|Pool Features|Porch|Patio|"
            r"Flooring|Walk-In Closet\(s\)|Smoke Detector\(s\)|Excl Some Window Treatmnt"
            r"|Interior Features|Community Features)[:\s]+",
            "", s, flags=re.IGNORECASE
        ).strip()
        # Only keep items that don't look like raw MLS descriptors (no ":" remaining unless measurement)
        if ":" in cleaned and not re.match(r"\d+\s*(?:sq|sf|ft)", cleaned, re.IGNORECASE):
            continue
        if cleaned and cleaned.lower() not in seen_a and len(cleaned) > 2:
            clean_amenities.append(cleaned)
            seen_a.add(cleaned.lower())
    if clean_amenities:
        record["amenities"] = json.dumps(clean_amenities)

    # 9. Create a rich fallback description when the source description is empty
    #    (or very thin — under 200 chars). Uses all structured fields rather than
    #    just beds/baths, so thin MLS descriptions get a proper write-up.
    desc = _normalize_text(record.get("description"))
    if not desc or len(desc) < 200:
        record["description"] = _build_fallback_description(record, existing=desc if desc else None)

    return record


def _build_fallback_description(record, existing=None):
    """
    Generate a multi-paragraph rental description from the structured fields
    on any pipeline record. Called when the scraped description is absent or
    too thin to be useful (< 80 chars).

    ``existing`` -- any short scraped text to prepend as a seed sentence.
    """
    beds   = record.get("bedrooms")
    baths  = record.get("bathrooms")
    half   = record.get("half_bathrooms")
    sqft   = record.get("square_footage")
    yr     = record.get("year_built")
    city   = (record.get("city") or "").strip()
    state  = (record.get("state") or "").strip()
    hood   = (record.get("neighborhood") or "").strip()
    ptype  = (record.get("property_type") or "rental").replace("_", " ").title()
    rent   = record.get("monthly_rent")
    lot    = record.get("lot_size_sqft")
    heat   = record.get("heating_type")
    cool   = record.get("cooling_type")
    laundry = record.get("laundry_type")
    parking = record.get("parking")
    pets    = record.get("pets_allowed")
    avail   = record.get("available_date")
    basement = record.get("has_basement")
    central_air = record.get("has_central_air")

    try:
        appliances = json.loads(record.get("appliances") or "[]")
    except Exception:
        appliances = []
    try:
        amenities_raw = record.get("amenities") or "[]"
        amenities = json.loads(amenities_raw) if isinstance(amenities_raw, str) else amenities_raw
    except Exception:
        amenities = []

    amenity_lower = " ".join(str(a).lower() for a in amenities)
    paragraphs = []

    # ── Paragraph 1: overview ────────────────────────────────────────────────
    loc_parts = []
    if hood:
        loc_parts.append("the {} neighborhood".format(hood))
    if city and state:
        loc_parts.append("{}, {}".format(city, state))
    elif city:
        loc_parts.append(city)
    loc_str = " in " + " of ".join(loc_parts) if loc_parts else ""

    beds_str = None
    if beds == 0:
        beds_str = "studio"
    elif beds:
        beds_str = "{}-bedroom".format(int(beds))

    baths_str = None
    if baths:
        baths_str = "{} bath{}".format(int(baths), "s" if baths != 1 else "")
        if half:
            baths_str += " + half bath"

    if beds_str and baths_str:
        opener = "This {}, {} {}{}".format(beds_str, baths_str, ptype.lower(), loc_str)
    elif beds_str:
        opener = "This {} {}{}".format(beds_str, ptype.lower(), loc_str)
    else:
        opener = "This {}{}".format(ptype.lower(), loc_str)

    details = []
    if yr:
        details.append("built in {}".format(yr))
    if sqft:
        details.append("offering {:,} sq ft of living space".format(int(sqft)))
    if lot:
        if lot >= 43560:
            details.append("on a {:.2f}-acre lot".format(lot / 43560))
        else:
            details.append("on a {:,} sq ft lot".format(int(lot)))

    sentence = opener
    if details:
        sentence += ", " + ", ".join(details)
    sentence += " is available for rent"
    if rent:
        sentence += " at ${:,.0f}/month".format(rent)
    sentence += "."

    if existing and existing.strip():
        paragraphs.append(existing.strip() + " " + sentence)
    else:
        paragraphs.append(sentence)

    # ── Paragraph 2: interior features ──────────────────────────────────────
    interior = []
    if heat and cool and heat.lower() != cool.lower():
        interior.append("{} heating and {} cooling".format(heat, cool.lower()))
    elif heat:
        interior.append("{} heating".format(heat))
    elif cool:
        interior.append("{} cooling".format(cool))
    elif central_air:
        interior.append("central air conditioning")

    laundry_map = {
        "In-unit": "in-unit washer/dryer",
        "Washer/dryer hookups": "washer/dryer hookups",
        "Shared laundry": "shared laundry facilities",
    }
    if laundry:
        interior.append(laundry_map.get(laundry, laundry.lower()))

    if basement:
        interior.append("a full basement")

    clean_apps = [str(a).replace("_", " ") for a in appliances if a]
    if clean_apps:
        if len(clean_apps) <= 3:
            interior.append(", ".join(clean_apps[:-1] or []) + (" and " if len(clean_apps) > 1 else "") + clean_apps[-1])
        else:
            interior.append(", ".join(clean_apps[:3]) + ", and more")

    if interior:
        paragraphs.append("Interior highlights include " + ", ".join(interior) + ".")

    # ── Paragraph 3: parking & outdoor ──────────────────────────────────────
    outdoor = []
    if parking:
        outdoor.append(parking.lower())
    if re.search(r"\bpool\b|\bswimming pool\b", amenity_lower):
        outdoor.append("a swimming pool")
    if re.search(r"\bfenced.{0,5}yard\b|\bbackyard\b", amenity_lower):
        outdoor.append("a fenced backyard")
    elif re.search(r"\byard\b", amenity_lower):
        outdoor.append("a yard")
    if re.search(r"\bpatio\b|\bdeck\b|\bporch\b", amenity_lower):
        outdoor.append("outdoor patio or deck space")

    if outdoor:
        if len(outdoor) == 1:
            paragraphs.append("The property features {}.".format(outdoor[0]))
        else:
            paragraphs.append(
                "The property features " + ", ".join(outdoor[:-1]) + " and " + outdoor[-1] + "."
            )

    # ── Paragraph 4: policies & availability ────────────────────────────────
    policy = []
    if pets is True:
        policy.append("Pets are welcome")
    elif pets is False:
        policy.append("No pets allowed")

    if avail:
        try:
            from datetime import date as _d
            avail_date = _d.fromisoformat(str(avail))
            if avail_date <= _d.today():
                policy.append("Available for immediate move-in")
            else:
                policy.append("Available from {}".format(avail_date.strftime("%B %-d, %Y")))
        except Exception:
            policy.append("Availability: {}".format(avail))

    if policy:
        paragraphs.append(". ".join(policy) + ".")

    return "\n\n".join(p for p in paragraphs if p.strip()) or "A well-maintained rental property available now."


# =============================================================================
# 6. Regex extraction from listing detail page
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
    r"Lease term[:\s]+(\d{1,2})\s+months?",
]

_LAUNDRY_RULES = [
    (
        r"(?i)in[- ]unit laundry"
        r"|washer.*?dryer\s+in\s+unit"
        r"|w/?d\s+in\s+unit"
        r"|washer\s*/?\s*dryer\s+included",
        "In-unit",
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
        r"|coin[- ]operated laundry"
        r"|communal laundry",
        "Shared laundry",
    ),
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

    # Strip HTML tags -> cleaner text for regex matching
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

    # laundry_type (only if not already inferred from amenities)
    if not record.get("laundry_type"):
        for pat, label in _LAUNDRY_RULES:
            if re.search(pat, plain):
                record["laundry_type"] = label
                break

    # heating_type (only if still missing after normalization)
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
# 7. Combined pipeline entry-point
# =============================================================================

def apply_enrichment_pipeline(records, verbose=False, enable_detail_fetch=True):
    """
    Run the full enrichment pipeline over a list of pipeline records.

    Steps (in order):
      1. Watermark filter       -- drop competitor-branded listings (entire record)
      2. Description clean      -- strip boilerplate, tour/contact CTAs
      3. Corporate fee strip    -- remove management company fee blocks
      3b. Photo brand filter    -- strip individual branded/agent photos from image list
      4. HVAC normalize         -- parse raw MLS heating/cooling blobs separately
      5. Rule-based enrich      -- infer laundry, parking, pets, title, deposit, fee
      6. Regex detail fetch     -- fetch page HTML for low-score records (optional)
      6b. Apply Now CTA         -- append Choice Properties apply-now CTA to description
      7. Re-score               -- recalculate data_quality_score after enrichment

    Returns:
      (enriched_records, count_watermarked)
    """
    import json as _json

    count_watermarked = 0
    count_photos_filtered = 0
    clean_records = []

    for rec in records:
        # Step 1: watermark filter — drop the entire listing if all branding
        # signals indicate a competitor-managed property
        if is_watermarked(rec):
            count_watermarked += 1
            if verbose:
                brand = watermark_reason(rec) or "?"
                addr = (rec.get("address") or "") + " " + (rec.get("city") or "")
                print("  [watermark] Dropped: " + addr.strip() + " (matched: " + brand + ")")
            continue

        # Step 2: clean description — strip tour/contact CTAs and boilerplate
        if rec.get("description"):
            rec["description"] = clean_description(rec["description"])

        # Step 2a: normalize ALL-CAPS descriptions from MLS raw data dumps
        if rec.get("description"):
            rec["description"] = normalize_allcaps_description(rec["description"])

        # Step 2b: strip external application instructions (TurboTenant,
        # Zillow/Apartments.com applications, property-ID application refs)
        if rec.get("description"):
            rec["description"] = strip_external_application_instructions(rec["description"])

        # Step 2c: remove property manager / owner / leasing-agent references
        if rec.get("description"):
            rec["description"] = replace_owner_manager_references(rec["description"])

        # Step 2d: strip third-party brokerage / MLS / other-platform branding
        if rec.get("description"):
            rec["description"] = strip_third_party_branding(rec["description"])

        # Step 3: strip corporate fee blocks
        if rec.get("description"):
            rec["description"] = strip_corporate_fees(rec["description"])

        # Step 3b: filter branded/agent photos from the image list.
        # Step 3b: filter branded/agent photos from the image list.
        # If ALL photos are watermarked (none survive the filter), the entire
        # listing is rejected — we never publish a property with zero usable
        # photos. If only SOME photos are watermarked, the clean ones are kept.
        before_raw = rec.get("original_image_urls") or "[]"
        filter_record_photos(rec)
        after_raw = rec.get("original_image_urls") or "[]"
        all_watermarked = False
        try:
            b_count = len(_json.loads(before_raw)) if isinstance(before_raw, str) else len(before_raw)
            a_count = len(_json.loads(after_raw))  if isinstance(after_raw,  str) else len(after_raw)
            count_photos_filtered += max(0, b_count - a_count)
            if b_count > 0 and a_count == 0:
                all_watermarked = True
        except Exception:
            pass

        if all_watermarked:
            count_watermarked += 1
            if verbose:
                addr = (rec.get("address") or "") + " " + (rec.get("city") or "")
                print("  [watermark] Dropped: " + addr.strip() + " (all photos watermarked)")
            continue

        # Step 4: normalize heating/cooling from raw MLS blobs
        normalize_hvac(rec)

        # Step 5: rule-based enrichment
        rule_based_enrich(rec)

        # Step 6: regex detail fetch (non-blocking -- skips Zillow / high-score records)
        if enable_detail_fetch:
            try:
                regex_extract_missing(rec, verbose=verbose)
            except Exception as exc:
                if verbose:
                    logger.debug("regex_extract_missing error: %s", str(exc)[:80])

        # Step 6a: enforce price consistency — the description must never
        # quote a rent figure that differs from the final published rent
        # (catches stale prices left over from a pre-publish price adjustment).
        if rec.get("description") and rec.get("monthly_rent"):
            rec["description"] = enforce_price_consistency(rec["description"], rec["monthly_rent"])

        # Step 6a-cleanup: remove garbled "/month" artifacts that can arise
        # when a format-string result and regex substitution interact on the
        # same token (e.g. "/monthnth", "/monthly" treated as one token).
        if rec.get("description"):
            rec["description"] = re.sub(
                r"/month[a-z]{1,3}\b", "/month", rec["description"], flags=re.IGNORECASE
            )

        # Step 6aa: normalize application fee language in the description.
        # Replace any mention of a free application, $0 fee, or a fee amount
        # other than $50 with the canonical "Application Fee: $50." statement.
        # This is a mandatory platform rule — Choice Properties charges $50.
        if rec.get("description"):
            rec["description"] = normalize_application_fee_in_description(rec["description"])

        # Step 6b: append Choice Properties apply-now CTA so every description
        # ends with an invitation to submit an application.
        if rec.get("description"):
            rec["description"] = append_apply_cta(rec["description"])

        clean_records.append(rec)

    # Step 7: re-score after enrichment
    if clean_records:
        _rescore(clean_records)

    if verbose:
        if count_watermarked:
            print("  [enrichment] " + str(count_watermarked) + " fully-branded listing(s) dropped")
        if count_photos_filtered:
            print("  [enrichment] " + str(count_photos_filtered) + " branded photo(s) removed from kept listings")

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
