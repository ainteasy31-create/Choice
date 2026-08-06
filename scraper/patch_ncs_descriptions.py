#!/usr/bin/env python3
"""
patch_ncs_descriptions.py
=========================
One-off patch for the 5 North Charleston / Summerville properties published
on 2026-08-06. Fixes:

  - ALL-CAPS description on 8042 Thelen St
  - Surviving tour language ("Schedule to see this today!") on 110 Roberta Dr
  - "(PICTURES are of a similar unit)" disclaimer on 126 Langley Dr
  - Thin description on 125 Brush Blvd (missing pool / fresh-finish detail)
  - "monthnth" formatting artifact + bare fallback on 3722 Tim St

Also patches pets_allowed=True and infers laundry_type for all 5.

Usage:
  python3 scraper/patch_ncs_descriptions.py
  python3 scraper/patch_ncs_descriptions.py --dry-run
"""

import argparse
import os
import sys
import requests

sys.path.insert(0, os.path.dirname(__file__))
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

# ---------------------------------------------------------------------------
# CTA rotation (mirrors enrichment.py _APPLY_CTAS — deterministic by length)
# ---------------------------------------------------------------------------
_APPLY_CTAS = [
    "Ready to make this your new home? Submit your rental application today at Choice Properties.",
    "Love what you see? Apply now through Choice Properties and take the next step toward your new home.",
    "This home is ready for you. Submit your application now at Choice Properties.",
    "Interested? Apply today through Choice Properties — applications are reviewed promptly.",
    "Don't wait on a great home. Apply now at Choice Properties and secure this listing today.",
    "Your next home is waiting. Submit your application at Choice Properties to get started.",
    "Like what you see? Apply now — Choice Properties makes the rental process simple and straightforward.",
]


def _cta(body: str) -> str:
    """Append the deterministic CTA (same logic as enrichment.py)."""
    body = body.rstrip()
    if body and body[-1] not in ".!?":
        body += "."
    idx = len(body) % len(_APPLY_CTAS)
    return body + "\n\n" + _APPLY_CTAS[idx]


# ---------------------------------------------------------------------------
# Descriptions (content only — CTA appended below)
# ---------------------------------------------------------------------------

PATCHES = [
    # ------------------------------------------------------------------
    # 1. 8042 Thelen St, North Charleston — ALL-CAPS MLS dump
    # ------------------------------------------------------------------
    {
        "id": "c7416221-3928-48e0-9f92-804122647dbf",
        "label": "8042 Thelen St, North Charleston",
        "description_body": (
            "This 2-bedroom, 1.5-bath townhome in North Charleston spans 1,114 sq ft "
            "and is packed with character. The main living area features a wood-burning "
            "fireplace and wet bar — perfect for entertaining — with a private patio just "
            "off the main level for your own outdoor retreat. Both bedrooms are generously "
            "sized with large closets and dedicated vanity areas. The master suite stands "
            "out with vaulted ceilings and a private balcony — a peaceful escape at the "
            "end of the day. Central air keeps things comfortable year-round. "
            "Application Fee: $50."
        ),
        "pets_allowed": True,
        "laundry_type": None,  # no evidence in amenities or original description
    },

    # ------------------------------------------------------------------
    # 2. 110 Roberta Dr Unit B, Summerville — surviving tour language
    # ------------------------------------------------------------------
    {
        "id": "6de7b001-b514-4e74-8a07-75b28270e076",
        "label": "110 Roberta Dr Unit B, Summerville",
        "description_body": (
            "This 2-bedroom, 1.5-bath two-story townhouse in Summerville is available "
            "for immediate occupancy. The main level features durable ceramic tile "
            "flooring and an eat-in kitchen with a pantry, while the carpeted bedrooms "
            "upstairs offer a comfortable, quiet feel. Central A/C keeps the home cool "
            "year-round. A metal chain-link fence encloses the backyard, giving you a "
            "private outdoor space to relax or let pets roam. Renter's insurance is "
            "required. Application Fee: $50."
        ),
        "pets_allowed": True,
        "laundry_type": None,
    },

    # ------------------------------------------------------------------
    # 3. 126 Langley Dr Apt B, Summerville — "(PICTURES are of a similar unit)"
    # ------------------------------------------------------------------
    {
        "id": "25043b3a-3aab-40ec-981f-1e4eaecd832f",
        "label": "126 Langley Dr Apt B, Summerville",
        # Strip the disclaimer; keep the rest of the well-written description
        "description_body": (
            "This traditional-style 2-bedroom, 1.5-bath townhome in Summerville has "
            "been fully renovated and is move-in ready. New flooring was installed "
            "throughout — upstairs and down — along with fresh paint, new appliances, "
            "a new HVAC system, new blinds, and new door hardware, all completed in 2024. "
            "Both bedrooms are located upstairs and share a full hallway bathroom; one "
            "bedroom has two closets and the other has a large double-door closet. "
            "Downstairs you'll find a spacious den, a half bath, multiple closets, and "
            "a bright eat-in kitchen. A large utility room off the kitchen includes "
            "washer/dryer hookups and opens to your private back patio. "
            "Application Fee: $50."
        ),
        "pets_allowed": True,
        "laundry_type": "Washer/dryer hookups",
    },

    # ------------------------------------------------------------------
    # 4. 125 Brush Blvd, Goose Creek — thin description, missing pool
    # ------------------------------------------------------------------
    {
        "id": "11618fcc-5691-4830-82a4-d42e37d8fdef",
        "label": "125 Brush Blvd, Goose Creek",
        "description_body": (
            "This 2-bedroom, 1.5-bath townhome in Goose Creek comes with access to a "
            "community swimming pool and recreation facilities — a rare perk at this "
            "price point. Inside, fresh carpet in the bedrooms and new vinyl flooring "
            "in the kitchen and laundry area give the home a clean, move-in-ready feel. "
            "Ceiling fans throughout work alongside central air to keep things comfortable "
            "all year. The two-story layout offers a dedicated family room and an eat-in "
            "kitchen on the main level, with both bedrooms and a full bath upstairs. "
            "Community outdoor space and views round out the setting. "
            "Application Fee: $50."
        ),
        "pets_allowed": True,
        "laundry_type": "Washer/dryer hookups",
    },

    # ------------------------------------------------------------------
    # 5. 3722 Tim St, North Charleston — "monthnth" bug, bare fallback
    # ------------------------------------------------------------------
    {
        "id": "683db0b1-6c0f-4a00-af03-09a8bcd43223",
        "label": "3722 Tim St, North Charleston",
        "description_body": (
            "This 2-bedroom, 1-bath single-family home in North Charleston is a cozy, "
            "single-story rental in a well-established neighborhood. Built in 1968 and "
            "offering 630 sq ft of living space, it's an efficient, low-maintenance home "
            "with no shared walls and community outdoor space nearby. A straightforward "
            "layout makes it easy to settle in and make it your own. "
            "Application Fee: $50."
        ),
        "pets_allowed": True,
        "laundry_type": None,
    },
]


def patch_property(patch: dict, dry_run: bool = False) -> bool:
    pid = patch["id"]
    label = patch["label"]
    description = _cta(patch["description_body"])

    payload = {"description": description, "pets_allowed": patch["pets_allowed"]}
    if patch.get("laundry_type"):
        payload["laundry_type"] = patch["laundry_type"]

    print(f"\n── {label}")
    print(f"   Description ({len(description)} chars):")
    # Print a short preview
    preview = description[:200].replace("\n", " ")
    print(f"   {preview}…")
    if patch.get("laundry_type"):
        print(f"   laundry_type → {patch['laundry_type']}")
    print(f"   pets_allowed → True")

    if dry_run:
        print("   [DRY RUN — no DB write]")
        return True

    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/properties?id=eq.{pid}",
        json=payload,
        headers=HEADERS,
    )
    if r.status_code in (200, 204):
        print("   ✓ Patched")
        return True
    else:
        print(f"   ✗ Error {r.status_code}: {r.text[:200]}")
        return False


def main():
    ap = argparse.ArgumentParser(description="Patch NCS descriptions in Supabase")
    ap.add_argument("--dry-run", action="store_true", help="Preview changes without writing")
    args = ap.parse_args()

    print("=" * 60)
    print(f"Patching {len(PATCHES)} properties" + (" (DRY RUN)" if args.dry_run else ""))
    print("=" * 60)

    ok = sum(1 for p in PATCHES if patch_property(p, dry_run=args.dry_run))
    print(f"\n{'='*60}")
    print(f"Done: {ok}/{len(PATCHES)} patched successfully")


if __name__ == "__main__":
    main()
