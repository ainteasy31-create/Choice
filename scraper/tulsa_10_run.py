#!/usr/bin/env python3
"""
Choice Properties — Tulsa, OK Metro Batch
==========================================
Target  : 10 single-family homes + townhomes in Tulsa metro
Price   : $1,100/mo or less
Beds    : Any
Baths   : Any
Exclude : North Tulsa (north of Admiral Blvd / Hwy 244)
Source  : Realtor.com

Geographic control via ZIP codes — only south/central Tulsa,
Broken Arrow, Jenks; fallback to Bixby, Owasso (south), Sand Springs (east).
"""

import re
import sys
from typing import Optional, Set

from pipeline import PipelineOrchestrator, BatchCriteria

# ---------------------------------------------------------------------------
# Geography — ZIP-level control to exclude North Tulsa
# ---------------------------------------------------------------------------
PRIMARY_ZIPS = [
    # South & Central Tulsa (south of Admiral Blvd / Hwy 244)
    "74103", "74104", "74105", "74107", "74108",
    "74112", "74114", "74115", "74119", "74120",
    "74129", "74132", "74133", "74134", "74135",
    "74136", "74137", "74145", "74146",
    # Broken Arrow
    "74011", "74012", "74014",
    # Jenks
    "74037",
]

FALLBACK_LOCATIONS = [
    "Bixby, OK",
    "Owasso, OK",       # south of 76th St N
    "Sand Springs, OK", # east of Hwy 97
]

PRIMARY_LOCATIONS = [
    "Tulsa, OK",
    "Broken Arrow, OK",
    "Jenks, OK",
]

# ---------------------------------------------------------------------------
# Smoking restriction patterns to strip from descriptions
# ---------------------------------------------------------------------------
SMOKING_STRIP = re.compile(
    r"(no[\s\-]smoking|smoke[\s\-]free|non[\s\-]smoking|smoking\s+(is\s+)?prohibited"
    r"|smoking\s+not\s+allowed|tobacco[\s\-]free|vaping\s+not\s+allowed)[^.]*\.",
    re.IGNORECASE,
)

def _enforce_policies(rec: dict) -> dict:
    """Force pets_allowed=True and strip smoking restriction language."""
    rec["pets_allowed"] = True

    desc = rec.get("description") or ""
    # Strip smoking restriction sentences
    desc = SMOKING_STRIP.sub("", desc)
    # Clean up double spaces/newlines left behind
    desc = re.sub(r"\n{3,}", "\n\n", desc).strip()
    rec["description"] = desc

    return rec

# ---------------------------------------------------------------------------
# Pricing — publish at original rent, cap at $1,100
# ---------------------------------------------------------------------------
RENT_MAX = 1100

def pricing_fn(original_rent, seen_rents: Optional[Set[int]] = None):
    if original_rent is None:
        return None, None
    rent = float(original_rent)
    if rent > RENT_MAX:
        return None, None
    published = int(round(rent))
    if seen_rents and published in seen_rents:
        for nudge in (5, -5, 10, -10):
            c = published + nudge
            if c <= RENT_MAX and c not in seen_rents:
                published = c
                break
    return published, rent

# ---------------------------------------------------------------------------
# Monkey-patch apply_enrichment_pipeline to enforce Choice Properties policies
# ---------------------------------------------------------------------------
import pipeline as _pipeline_mod

_original_enrich = _pipeline_mod.apply_enrichment_pipeline

def _patched_enrich(records, **kwargs):
    records, wm_count = _original_enrich(records, **kwargs)
    for rec in records:
        _enforce_policies(rec)
    return records, wm_count

_pipeline_mod.apply_enrichment_pipeline = _patched_enrich

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
criteria = BatchCriteria(
    batch_name="Tulsa Metro, OK",
    locations=PRIMARY_LOCATIONS,
    zip_codes=PRIMARY_ZIPS,
    fallback_locations=FALLBACK_LOCATIONS,
    allowed_types={"SINGLE_FAMILY", "TOWNHOMES"},
    beds_exact=None,      # any bedroom count
    baths_min=0.0,        # any bathroom count
    rent_min=0,
    rent_max=RENT_MAX,
    rent_floor=0,
    rent_cap=RENT_MAX,
    target=10,
    past_days=90,
    limit=400,
    min_score=30,
    pricing_fn=pricing_fn,
)

orchestrator = PipelineOrchestrator(verbose=True)
result = orchestrator.run(criteria)

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
print("\n" + "=" * 60)
print("TULSA PUBLISHING REPORT")
print("=" * 60)
print(f"Total scraped      : {result.scraped}")
print(f"Passed filters     : {result.passed_filter}")
print(f"Passed validation  : {result.passed_validation}")
print(f"Published          : {result.published}")
print(f"Photos uploaded    : {result.photos_ok}")
print(f"Watermarked dropped: {result.watermarked_dropped}")

if result.published_urls:
    print(f"\n{'─'*60}")
    print(f"PUBLISHED LISTINGS ({result.published})")
    print(f"{'─'*60}")
    for i, url in enumerate(result.published_urls, 1):
        print(f"{i}. {url}")

shortfall = 10 - result.published
if shortfall > 0:
    print(f"\n⚠ Shortfall: {shortfall} listing(s) below target of 10.")
    print("  Reasons for drops:")
    if result.errors:
        for e in result.errors[:10]:
            print(f"  - {e}")

sys.exit(0 if result.published > 0 else 1)
