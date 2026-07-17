#!/usr/bin/env python3
"""
North Metro Atlanta — Batch Publish Script
==========================================
Applies batch pricing rules, updates descriptions, publishes 7 qualifying
pipeline records, activates listings, and triggers ImageKit photo import.

ZIP targets: 30157, 30132, 30144, 30101, 30102
Rent range:  $1,500–$1,900 scraped → published at $1,500–$1,600
"""

import os
import sys
import json
import time
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scraper import _load_dotenv  # reuse .env loader
_load_dotenv()

SUPABASE_URL     = "https://tlfmwetmhthpyrytrcfo.supabase.co"
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not SERVICE_ROLE_KEY:
    sys.exit("❌  SUPABASE_SERVICE_ROLE_KEY not set")

# ── Headers ────────────────────────────────────────────────────────────────────
H_PL = {          # pipeline schema headers
    "apikey":           SERVICE_ROLE_KEY,
    "Authorization":    "Bearer " + SERVICE_ROLE_KEY,
    "Content-Type":     "application/json",
    "Accept-Profile":   "pipeline",
    "Content-Profile":  "pipeline",
    "Prefer":           "return=representation",
}
H_PUB = {         # public schema headers (for properties / photos / RPC)
    "apikey":           SERVICE_ROLE_KEY,
    "Authorization":    "Bearer " + SERVICE_ROLE_KEY,
    "Content-Type":     "application/json",
    "Prefer":           "return=representation",
}

# ── Pricing table (per spec) ───────────────────────────────────────────────────
#   $1,501–$1,600 → publish as-is
#   $1,601–$1,700 → reduce $75–$100     → target $1,500–$1,625 (cap $1,600)
#   $1,701–$1,800 → reduce $125–$175    → target $1,525–$1,675 (cap $1,600)
#   $1,801–$1,900 → dynamic reduction   → land $1,500–$1,600
#
# We use per-property adjustments for natural variation across the batch.
PRICE_PLAN = {
    "PP-A15CF80C": {"adj_rent": 1590, "note": "orig $1715, reduced $125"},
    "PP-ED2FF130": {"adj_rent": 1575, "note": "orig $1750, reduced $175"},
    "PP-5534B3D0": {"adj_rent": 1600, "note": "orig $1800, reduced $200"},
    "PP-C4A66B47": {"adj_rent": 1575, "note": "orig $1850, reduced $275"},
    "PP-CA39EF0F": {"adj_rent": 1565, "note": "orig $1850, reduced $285"},
    "PP-75589BB7": {"adj_rent": 1545, "note": "orig $1895, reduced $350"},
    "PP-C0077582": {"adj_rent": 1550, "note": "orig $1900, reduced $350"},
}

# ── Enriched descriptions (professionally rewritten, per spec) ─────────────────
DESCRIPTIONS = {

"PP-A15CF80C": """\
Nestled in a quiet Dallas neighborhood within the established community of Paulding County, \
this 3-bedroom, 2-bathroom home at 50 King Alfred Ct offers a comfortable, move-in-ready living \
experience. Built in 1997, the home is situated on a peaceful cul-de-sac-style street with the \
added benefit of HOA-maintained common areas.

Inside, the layout flows naturally through three bedrooms and two full bathrooms, providing \
ample space for families or those seeking extra room. The home spans approximately 1,200 square \
feet of well-organized living space designed for everyday functionality.

Pet owners will appreciate that this home is pet-friendly, making it a welcome choice for \
households with animals. Residents benefit from proximity to top-rated Paulding County schools, \
everyday shopping and dining along Dallas-Acworth Highway, and the growing retail corridor of \
Seven Hills. Commuters enjoy convenient access to US-278 and SR-120, connecting to the greater \
North Metro Atlanta area with ease.

Application Fee: $50. Security deposit equal to one month's rent. All applicants subject to \
credit and background screening through Choice Properties.\
""",

"PP-ED2FF130": """\
This updated 3-bedroom, 2-bathroom single-family home at 232 Hampton Dr in Dallas, GA puts \
comfort and convenience front and center. Built in 1993 and thoughtfully maintained, the home \
welcomes you with strong curb appeal, a wide driveway with space for multiple vehicles, and an \
attached 2-car garage.

Step inside to discover an open living room with modern laminate flooring and soaring 9-foot \
ceilings on every level, creating an airy, spacious feel throughout. The layout is ideal for \
everyday living, with generous bedroom proportions and a walk-in closet in the primary suite. \
Disappearing attic stairs provide convenient access to overhead storage. Central air and heat \
keep the home comfortable year-round. The kitchen is equipped with a dishwasher and refrigerator, \
with laundry hookups in a dedicated closet or laundry room.

Outside, an expansive yard offers plenty of room for outdoor activities and entertaining. \
Street-lit roads add an extra layer of safety and community feel.

Located in Paulding County's 30132 corridor, residents are close to Dallas-Acworth Hwy retail, \
Silver Comet Trail access points, and a short drive to downtown Dallas and Hiram. Commuters \
connect easily to US-278 and I-20.

Application Fee: $50. Security deposit equal to one month's rent.\
""",

"PP-5534B3D0": """\
Set on approximately 3.4 acres of private land in Acworth's Cobb County corridor, this \
3-bedroom, 2-bathroom home at 3210 Baker Rd NW is a rare find for tenants seeking space, \
privacy, and versatility. Built in 1972 and sitting on a generous lot, the home's in-law \
floor plan includes a separate private living area with its own kitchen and bedroom — perfect \
for multi-generational households, a home office, or extra guest accommodations.

The main residence features a master bedroom on the main level for single-story convenience, \
with two additional bedrooms rounding out the layout. Laminate flooring runs throughout the \
primary living areas, and the kitchen is equipped with a dishwasher, range, and refrigerator. \
A large basement adds significant storage capacity. Central air and central heat provide \
year-round comfort. An attached carport shelters up to two vehicles from the elements, and an \
in-hall laundry closet keeps daily routines efficient.

The expansive acreage delivers outdoor privacy that is simply not found in typical subdivision \
homes — ideal for gardeners, outdoor enthusiasts, or anyone who values open space. The property \
sits within Cobb County's school district, with quick access to Wade Green Rd, I-75, and the \
amenities of both Kennesaw and Acworth.

Application Fee: $50. Security deposit equal to one month's rent.\
""",

"PP-C4A66B47": """\
Offering an impressive 1,743 square feet of living space, this 3-bedroom, 2-bathroom townhome \
at 5020 Sand Wedge Cir NW in Kennesaw combines generous proportions with a flexible layout \
that adapts easily to a variety of lifestyles. Built in 1984, the home sits on a quiet \
cul-de-sac adjacent to Pine Tree Golf Club — a setting that combines suburban tranquility \
with community character.

Inside, soaring high ceilings create an open, comfortable atmosphere throughout the main \
living areas. A den and a bonus game room give residents exceptional flexibility for a home \
office, media room, or hobby space. The primary bedroom suite is well-sized with a dedicated \
bathroom, while two additional bedrooms and a fully renovated second bath with a walk-in \
shower serve family members or guests. A cozy fireplace anchors the main living room for \
cooler evenings. The kitchen includes a dishwasher, microwave, range, and refrigerator. \
Carpet, laminate, and vinyl flooring are featured throughout. The home also includes a \
full basement for additional storage or flex use.

Covered parking is provided via a 1-car garage. Central air and central heat ensure \
year-round comfort. The neighborhood's proximity to Kennesaw State University, I-75, \
I-575, and the dining and retail of Barrett Parkway makes this an excellent base for \
professionals, students, and families alike.

Application Fee: $50. Security deposit equal to one month's rent.\
""",

"PP-CA39EF0F": """\
This well-appointed 3-bedroom, 2.5-bathroom home at 121 Creekwood Trl in Acworth delivers \
the space and features that today's renters are looking for, set within a desirable Cherokee \
County neighborhood. Built in 2007, the home spans 1,594 square feet and is move-in ready, \
with quality finishes and a practical layout designed for comfortable daily living.

Hardwood floors run throughout the main level, and the soaring 2-story entrance foyer makes \
an immediate impression. The kitchen opens directly to a family room anchored by a direct-vent \
fireplace, creating a natural hub for everyday gatherings. Nine-foot ceilings on the main level \
add to the airy feel. The kitchen is equipped with a dishwasher, disposal, gas water heater, \
microwave, refrigerator, and self-cleaning oven — everything you need for efficient meal prep.

Upstairs, the spacious owner's suite features a generous walk-in closet and a double-vanity \
bathroom with separate tub and shower. Two additional secondary bedrooms share a well-sized \
full bath on the upper level, with a dedicated laundry room for added convenience. Disappearing \
attic stairs and an unfinished basement provide exceptional storage capacity. The 2-car garage \
accommodates vehicles and additional gear with ease.

Residents enjoy the community's outdoor spaces and security features, with Cherokee County \
schools, I-575, Downtown Woodstock, and Acworth's lakeside shops and dining all within a short \
drive.

Application Fee: $50. Security deposit equal to one month's rent.\
""",

"PP-75589BB7": """\
Ideally positioned in the heart of Kennesaw, this 3-bedroom, 2-bathroom townhome at \
5065 Sand Wedge Cir NW blends comfort, style, and location in a package that is hard \
to beat. Built in 1983 and spanning 1,458 square feet, the home has been thoughtfully \
updated to deliver a fresh, move-in-ready experience for its next residents.

Cathedral ceilings elevate the main living area, filling the space with natural light \
and an open, airy feel. Luxury vinyl plank flooring and tile run throughout — durable, \
attractive, and easy to maintain. A den off the main living space provides the extra \
room that today's residents need, whether for a home office, reading nook, or play area. \
Updated countertops and sinks add a modern finish to the kitchen, which is fully equipped \
with a gas cooktop, electric oven, dishwasher, microwave, and refrigerator.

Step outside to enjoy a private fenced yard — rare for a townhome — perfect for \
morning coffee, evening relaxation, or a space for pets to roam. This home is \
pet-friendly. Community amenities include a clubhouse, outdoor gathering spaces, \
and gated security features. Driveway parking accommodates vehicles conveniently. \
Central air and heat provide year-round comfort.

The location is exceptional: minutes from Kennesaw State University, I-75 and I-575 \
interchanges, Pine Tree Country Club, Kennesaw Mountain National Battlefield Park, \
and the extensive dining and retail options along Barrett Parkway and Town Center Mall.

Application Fee: $50. Security deposit equal to one month's rent.\
""",

"PP-C0077582": """\
Move-in-ready and perfectly situated on the Cherokee/Cobb County line, this 3-bedroom, \
2-bathroom townhome at 538 Oakside Pl in Acworth checks every box for tenants seeking \
quality, community, and connectivity. Built in 2010, the home was designed with modern \
living in mind, delivering generous living spaces and premium community amenities at an \
exceptional value.

Step inside to discover soaring high ceilings and elegant tray ceilings that give the main \
living areas a polished, upscale feel. The open floor plan flows naturally from the living \
room into the kitchen, which is equipped with a dishwasher, disposal, and refrigerator. \
Carpet and vinyl flooring run throughout, offering a comfortable underfoot experience. \
Generous walk-in closets in the bedrooms ensure no shortage of storage. Upstairs laundry — \
accessible from both the hall and a dedicated laundry closet — keeps routines organized.

The attached 1-car garage provides protected parking and direct entry into the home. \
Community residents enjoy access to a swimming pool, playground, and beautifully landscaped \
park spaces — amenities that make everyday living feel like a retreat. Central air and \
electric heating provide reliable year-round comfort.

Location is one of this home's strongest features: within minutes of I-575 and I-75, \
Downtown Woodstock's lively restaurant and retail scene, Downtown Acworth's charming \
lakeside district, and a full array of grocery stores, schools, and medical services.

Application Fee: $50. Security deposit equal to one month's rent.\
""",
}

# ── Helpers ────────────────────────────────────────────────────────────────────

def patch_pipeline(pipeline_id, patch):
    r = requests.patch(
        SUPABASE_URL + "/rest/v1/pipeline_properties",
        headers=H_PL,
        params={"id": "eq." + pipeline_id},
        json=patch,
    )
    if r.status_code not in (200, 204):
        raise RuntimeError(f"PATCH pipeline {pipeline_id} failed {r.status_code}: {r.text[:300]}")
    return r.json() if r.text else {}


def publish_via_rpc(pipeline_id):
    """Call pipeline_publish RPC. Returns choice_property_id on success."""
    r = requests.post(
        SUPABASE_URL + "/rest/v1/rpc/pipeline_publish",
        headers=H_PUB,
        json={"p_id": pipeline_id, "p_landlord_id": None},
    )
    if r.status_code not in (200, 201):
        raise RuntimeError(f"RPC failed {r.status_code}: {r.text[:500]}")
    result = r.json()
    if not result.get("ok"):
        raise RuntimeError(f"RPC returned ok=false: {result.get('error')}")
    return result["choice_property_id"]


def activate_property(prop_id):
    """Set property status to active and mark it as featured."""
    r = requests.patch(
        SUPABASE_URL + "/rest/v1/properties",
        headers=H_PUB,
        params={"id": "eq." + prop_id},
        json={"status": "active"},
    )
    if r.status_code not in (200, 204):
        raise RuntimeError(f"Activate {prop_id} failed {r.status_code}: {r.text[:300]}")


def trigger_photo_import(prop_id, pipeline_id):
    """Call import-pipeline-photos Edge Function to transfer source photos to ImageKit."""
    r = requests.post(
        SUPABASE_URL + "/functions/v1/import-pipeline-photos",
        headers={
            "apikey":        SERVICE_ROLE_KEY,
            "Authorization": "Bearer " + SERVICE_ROLE_KEY,
            "Content-Type":  "application/json",
        },
        json={"property_id": prop_id, "pipeline_id": pipeline_id},
        timeout=120,
    )
    if r.status_code not in (200, 201):
        return False, f"HTTP {r.status_code}: {r.text[:200]}"
    data = r.json()
    if not data.get("success"):
        return False, data.get("error", "unknown error")
    return True, f"transferred={data.get('transferred',0)} skipped={data.get('skipped',0)}"


def get_property_url(prop_id):
    r = requests.get(
        SUPABASE_URL + "/rest/v1/properties",
        headers=H_PUB,
        params={"select": "id,address,city,zip", "id": "eq." + prop_id},
    )
    data = r.json()
    if data:
        p = data[0]
        # URL format used on the live site
        slug = (p["address"] + " " + p["city"] + " " + p["zip"]).lower()
        slug = slug.replace(",", "").replace("  ", " ").replace(" ", "-")
        return f"https://choice-properties-site.pages.dev/property.html?id={prop_id}"
    return f"https://choice-properties-site.pages.dev/property.html?id={prop_id}"


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    print("\n" + "=" * 60)
    print("  North Metro Atlanta — Batch Publish")
    print("  ZIPs: 30157, 30132, 30144, 30101, 30102")
    print("=" * 60)

    published_report = []

    for pipeline_id, plan in PRICE_PLAN.items():
        adj_rent = plan["adj_rent"]
        note     = plan["note"]
        desc     = DESCRIPTIONS[pipeline_id]

        print(f"\n{'─'*55}")
        print(f"  Pipeline: {pipeline_id}")
        print(f"  Pricing:  {note}  →  published ${adj_rent:,}/mo")

        # ── Step 1: Update pipeline record with adjusted price + new description ──
        print(f"  [1/4] Updating pipeline record...")
        try:
            patch_pipeline(pipeline_id, {
                "monthly_rent":     adj_rent,
                "security_deposit": adj_rent,   # spec: deposit = published rent when adjusted
                "application_fee":  50,
                "description":      desc,
                "edited_fields":    json.dumps(["monthly_rent", "security_deposit",
                                                "application_fee", "description"]),
            })
            print(f"       ✅  Pipeline updated")
        except Exception as e:
            print(f"       ❌  Failed: {e}")
            continue

        time.sleep(0.3)

        # ── Step 2: Publish via RPC ──────────────────────────────────────────────
        print(f"  [2/4] Publishing via pipeline_publish RPC...")
        try:
            choice_id = publish_via_rpc(pipeline_id)
            print(f"       ✅  Published → {choice_id}")
        except Exception as e:
            print(f"       ❌  Publish failed: {e}")
            continue

        time.sleep(0.3)

        # ── Step 3: Activate (draft → active) ───────────────────────────────────
        print(f"  [3/4] Activating listing...")
        try:
            activate_property(choice_id)
            print(f"       ✅  Status set to active")
        except Exception as e:
            print(f"       ❌  Activate failed: {e}")
            # Non-fatal — property is published but needs manual activation

        time.sleep(0.3)

        # ── Step 4: Trigger ImageKit photo import ────────────────────────────────
        print(f"  [4/4] Importing photos to ImageKit...")
        ok, msg = trigger_photo_import(choice_id, pipeline_id)
        if ok:
            print(f"       ✅  Photos imported: {msg}")
        else:
            print(f"       ⚠   Photo import issue: {msg}")

        url = get_property_url(choice_id)
        published_report.append({
            "pipeline_id": pipeline_id,
            "choice_id":   choice_id,
            "url":         url,
        })

    # ── Final report ─────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("  PUBLISHED LISTINGS REPORT")
    print("=" * 60)
    for i, p in enumerate(published_report, 1):
        print(f"\n{i}. Pipeline: {p['pipeline_id']}")
        print(f"   Property: {p['choice_id']}")
        print(f"   URL:      {p['url']}")

    print(f"\n✅  Total published: {len(published_report)}")
    return published_report


if __name__ == "__main__":
    main()
