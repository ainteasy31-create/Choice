#!/usr/bin/env python3
"""
Choice Properties -- AI Description Rewriter
============================================
Step 6 of the unified pipeline orchestrator.

Rewrites scraped listing descriptions from scratch using OpenAI GPT-4o-mini.
The AI is given only verified property facts — it never invents amenities or
features. The original listing text is used solely as a fact-extraction input.

Rules enforced (permanent — per PLATFORM_RULES.md Section 2):
  - Never publish the original listing description verbatim
  - AI generates a new, professional, natural, SEO-friendly description
  - Strictly fact-based: no invented amenities or features
  - Free from repetitive AI wording
  - Output is then passed through the enrichment pipeline for cleanup/branding

Required environment variable:
  OPENAI_API_KEY  -- if not set, rewrite_description() returns None gracefully
"""

import os
import json
import re
import time
import logging
import unicodedata

logger = logging.getLogger("ai_description")


def _sanitize(text: str) -> str:
    """
    Normalize Unicode to ASCII-safe text before sending to OpenAI.
    Replaces smart quotes, curly apostrophes, dashes, and other non-ASCII
    characters that cause codec errors in the HTTP request layer.
    """
    if not text:
        return text
    # Replace common Unicode punctuation with ASCII equivalents
    replacements = {
        "\u2018": "'", "\u2019": "'",   # curly single quotes / apostrophes
        "\u201c": '"', "\u201d": '"',   # curly double quotes
        "\u2013": "-", "\u2014": "--",  # en-dash, em-dash
        "\u2026": "...",                # ellipsis
        "\u00a0": " ",                  # non-breaking space
    }
    for ch, rep in replacements.items():
        text = text.replace(ch, rep)
    # NFKD normalize then drop any remaining non-ASCII
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", errors="ignore").decode("ascii")
    return text

_OPENAI_OK = False
_client = None

try:
    import openai
    _api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if _api_key:
        # Validate the key is ASCII-clean before passing to the SDK.
        # A key containing Unicode (e.g. curly apostrophes from a copy-paste
        # error) causes a codec crash deep inside the HTTP layer on every call.
        try:
            _api_key.encode("ascii")
        except UnicodeEncodeError:
            logger.error(
                "OPENAI_API_KEY contains non-ASCII characters — the key is "
                "invalid (likely a copy-paste error with curly quotes or "
                "special characters). AI rewrites are disabled until the key "
                "is replaced with a valid sk-... token."
            )
            _api_key = ""
        if _api_key:
            _client = openai.OpenAI(api_key=_api_key)
            _OPENAI_OK = True
except ImportError:
    pass

# ---------------------------------------------------------------------------
# Mandatory closing paragraph that must appear in every description
# ---------------------------------------------------------------------------
_REQUIRED_CLOSING = (
    "Application Required Before Viewing: To provide an efficient leasing process, "
    "applications are required before scheduling a property viewing. Property viewings "
    "are arranged only after an application has been submitted and approved."
)

# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are a professional real estate copywriter for Choice Properties,
a nationwide rental property marketplace. Your job is to write listing descriptions
that are:

- Professional and polished
- Natural and human-sounding (not AI-robotic)
- SEO-friendly and easy to read
- Strictly factual — never invent or imply features not confirmed in the property data
- Free from repetitive phrases like "nestled", "boasting", "stunning", "cozy", "charming"

Never include:
- Tour/showing language ("schedule a tour", "call to view", "contact agent")
- References to other platforms (Zillow, Realtor.com, TurboTenant, etc.)
- Agent or owner contact information
- MLS numbers, listing IDs, or property codes
- Any application fee other than $50
- Third-party application instructions

Always end with exactly this paragraph:
"Application Required Before Viewing: To provide an efficient leasing process, applications are required before scheduling a property viewing. Property viewings are arranged only after an application has been submitted and approved."

Output only the description text — no headlines, no JSON, no extra commentary."""

_USER_PROMPT_TEMPLATE = """Write a new rental listing description for this property.
Use ONLY the verified facts provided below. Do not invent or assume any feature not listed.

VERIFIED PROPERTY FACTS:
  Address: {address}
  City, State: {city}, {state}
  Bedrooms: {bedrooms}
  Bathrooms: {bathrooms}
  Property type: {property_type}
  Square footage: {sqft}
  Monthly rent: ${rent}/month
  Security deposit: ${deposit}
  Application fee: $50
  Pets: {pets}
  Parking: {parking}
  Laundry: {laundry}
  Heating: {heating}
  Cooling: {cooling}
  Available date: {available_date}
  Lease term: {lease_term}
  Amenities: {amenities}

ORIGINAL LISTING TEXT (for fact extraction only — do not copy verbatim):
{original_description}

Write the new description now (2–4 paragraphs, 150–300 words):"""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def rewrite_description(record: dict) -> "str | None":
    """
    Generate a fresh professional description for a pipeline record.

    Args:
        record: pipeline_properties dict with property fields.

    Returns:
        New description string, or None if OpenAI is unavailable or fails.
        Caller should fall back to the cleaned original description.
    """
    if not _OPENAI_OK or _client is None:
        return None

    # Extract amenities safely
    amenities_raw = record.get("amenities") or "[]"
    try:
        amenities_list = json.loads(amenities_raw) if isinstance(amenities_raw, str) else amenities_raw
        amenities_str = ", ".join(str(a) for a in amenities_list[:20]) if amenities_list else "Not specified"
    except Exception:
        amenities_str = "Not specified"

    # Pets
    pets_val = record.get("pets_allowed")
    if pets_val is True:
        pets_str = "Allowed"
    elif pets_val is False:
        pets_str = "Not allowed"
    else:
        pets_str = "Contact for policy"

    prompt = _USER_PROMPT_TEMPLATE.format(
        address=_sanitize(record.get("address") or "Not specified"),
        city=_sanitize(record.get("city") or "Not specified"),
        state=_sanitize(record.get("state") or "Not specified"),
        bedrooms=record.get("bedrooms") or "Not specified",
        bathrooms=record.get("bathrooms") or "Not specified",
        property_type=(record.get("property_type") or "").replace("_", " ").title() or "Not specified",
        sqft=record.get("square_footage") or "Not specified",
        rent="{:,}".format(int(record["monthly_rent"])) if record.get("monthly_rent") else "Contact for pricing",
        deposit="{:,}".format(int(record["security_deposit"])) if record.get("security_deposit") else "Equal to rent",
        pets=pets_str,
        parking=_sanitize(record.get("parking") or "Not specified"),
        laundry=_sanitize(record.get("laundry_type") or "Not specified"),
        heating=_sanitize(record.get("heating_type") or "Not specified"),
        cooling=_sanitize(record.get("cooling_type") or "Not specified"),
        available_date=record.get("available_date") or "Contact for availability",
        lease_term="{} months".format(record["minimum_lease_months"]) if record.get("minimum_lease_months") else "Not specified",
        amenities=_sanitize(amenities_str),
        original_description=_sanitize(
            (record.get("description") or "No original description provided.")[:1500]
        ),
    )

    # FIX M3: Retry with exponential backoff on transient errors
    last_error = None
    for attempt in range(3):
        try:
            response = _client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.35,   # FIX M2: lowered from 0.7 for consistent, fact-based copy
                max_tokens=750,     # FIX L3: raised from 600 to avoid clipping required closing paragraph
            )
            text = response.choices[0].message.content.strip()

            if len(text) < 80:
                logger.warning("AI rewrite returned unexpectedly short text (%d chars)", len(text))
                return None

            # FIX L3: Ensure mandatory closing paragraph is present; append if missing
            if "Application Required Before Viewing" not in text:
                text = text.rstrip() + "\n\n" + _REQUIRED_CLOSING

            logger.debug("AI rewrite OK for %s (%d chars)", record.get("address", "?"), len(text))
            return text

        except Exception as e:
            last_error = e
            err_str = str(e)[:120]
            # FIX M3: Retry on rate limit or server errors; bail immediately on auth errors
            if "rate_limit" in err_str.lower() or "529" in err_str or "500" in err_str:
                wait = 2 ** attempt
                logger.warning(
                    "OpenAI transient error for %s (attempt %d/3, retry in %ds): %s",
                    record.get("address", "?"), attempt + 1, wait, err_str,
                )
                time.sleep(wait)
            else:
                logger.warning("OpenAI API error for %s: %s", record.get("address", "?"), err_str)
                break

    if last_error:
        logger.warning("OpenAI API failed after retries for %s: %s",
                       record.get("address", "?"), str(last_error)[:120])
    return None


def is_available() -> bool:
    """Return True if OpenAI is configured and rewriting is possible."""
    return _OPENAI_OK and _client is not None
