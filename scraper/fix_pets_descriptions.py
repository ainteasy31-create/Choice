#!/usr/bin/env python3
"""
Fix pet restriction language in published property descriptions.
Finds all properties where the description contains any form of
"pets not allowed" and rewrites those phrases to "Pets are welcome."
"""
import os
import re
import sys

# Load credentials
for candidate in [".env", "../.env"]:
    if os.path.exists(candidate):
        with open(candidate) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    if k.strip() and k.strip() not in os.environ:
                        os.environ[k.strip()] = v.strip().strip('"').strip("'")

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY  = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json",
    "Accept": "application/json",
}

# All patterns that mean "pets not allowed"
PET_RESTRICTION_PATTERNS = [
    (re.compile(r"no\s+pets\s+allowed", re.IGNORECASE), "Pets are welcome."),
    (re.compile(r"pets?\s+are\s+not\s+allowed", re.IGNORECASE), "Pets are welcome."),
    (re.compile(r"pets?\s+not\s+allowed", re.IGNORECASE), "Pets are welcome."),
    (re.compile(r"no\s+pets", re.IGNORECASE), "Pets are welcome."),
    (re.compile(r"pets?\s+not\s+permitted", re.IGNORECASE), "Pets are welcome."),
    (re.compile(r"sorry[,\s]+no\s+pets", re.IGNORECASE), "Pets are welcome."),
    (re.compile(r"pet[\s\-]free", re.IGNORECASE), "Pet-friendly."),
    (re.compile(r"no\s+dogs?", re.IGNORECASE), "Dogs welcome."),
    (re.compile(r"no\s+cats?", re.IGNORECASE), "Cats welcome."),
]

def fix_description(desc: str) -> tuple[str, int]:
    """Apply all pet fixes. Returns (new_desc, number_of_replacements)."""
    count = 0
    for pattern, replacement in PET_RESTRICTION_PATTERNS:
        new_desc, n = pattern.subn(replacement, desc)
        if n:
            desc = new_desc
            count += n
    return desc, count

# ── Fetch all published properties ──────────────────────────────────────────
print("Fetching published properties...")

all_props = []
offset = 0
PAGE = 1000

while True:
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/properties",
        headers={**HEADERS, "Range": f"{offset}-{offset + PAGE - 1}"},
        params={"select": "id,description,address,city,state", "status": "eq.active", "order": "id"},
        timeout=30,
    )
    r.raise_for_status()
    batch = r.json()
    if not batch:
        break
    all_props.extend(batch)
    if len(batch) < PAGE:
        break
    offset += PAGE

print(f"Found {len(all_props)} active properties.")

# ── Find & fix affected descriptions ────────────────────────────────────────
fixed = 0
skipped = 0

for prop in all_props:
    desc = prop.get("description") or ""
    if not desc:
        skipped += 1
        continue

    new_desc, replacements = fix_description(desc)

    if replacements == 0:
        skipped += 1
        continue

    # PATCH the description
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/properties?id=eq.{prop['id']}",
        headers=HEADERS,
        json={"description": new_desc},
        timeout=20,
    )
    r.raise_for_status()
    fixed += 1
    addr = f"{prop.get('address','?')}, {prop.get('city','?')}"
    print(f"  ✅ Fixed ({replacements} change(s)): {addr}")

print(f"\n{'─'*50}")
print(f"Done. Fixed: {fixed} | Unchanged: {skipped}")
