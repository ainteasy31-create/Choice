#!/usr/bin/env python3
"""
Overland / Maryland Heights, St. Louis County — Batch Publish
=============================================================
Correct ordering:
  1. Patch pipeline record (price + description)
  2. pipeline_publish RPC  →  status = 'draft'
  3. Import photos to ImageKit (REQUIRED — keeps listing as draft if fails)
  4. Verify photo count > 0 in DB
  5. Activate (draft → active) — only after confirmed photos
"""

import base64, json, os, sys, time
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scraper import _load_dotenv
_load_dotenv()

SUPABASE_URL     = "https://tlfmwetmhthpyrytrcfo.supabase.co"
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
IK_PRIVATE_KEY   = os.environ.get("IMAGEKIT_PRIVATE_KEY", "")
IK_ENDPOINT      = os.environ.get("IMAGEKIT_URL_ENDPOINT", "").rstrip("/")

for var, name in [(SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY"),
                  (IK_PRIVATE_KEY,   "IMAGEKIT_PRIVATE_KEY"),
                  (IK_ENDPOINT,      "IMAGEKIT_URL_ENDPOINT")]:
    if not var:
        sys.exit(f"❌  {name} not set")

H_PL = {
    "apikey": SERVICE_ROLE_KEY, "Authorization": "Bearer " + SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    "Accept-Profile": "pipeline", "Content-Profile": "pipeline",
    "Prefer": "return=representation",
}
H_PUB = {
    "apikey": SERVICE_ROLE_KEY, "Authorization": "Bearer " + SERVICE_ROLE_KEY,
    "Content-Type": "application/json", "Prefer": "return=representation",
}

MAX_PHOTOS = 20
DOWNLOAD_TIMEOUT = 25
UPLOAD_TIMEOUT   = 45
MAX_RETRIES      = 3
RETRY_BACKOFF    = 2.0

# ── Batch plan ────────────────────────────────────────────────────────────────
PRICE_PLAN = {
    "PP-DD003B48": {"adj_rent": 1300, "note": "orig $1300 — publish original"},
    "PP-6C2C0D39": {"adj_rent": 1300, "note": "orig $1300 — publish original"},
    "PP-EA9C1FFC": {"adj_rent": 1295, "note": "orig $1450, reduced $155"},
    "PP-DC30973B": {"adj_rent": 1295, "note": "orig $1440, reduced $145"},
    "PP-3127406E": {"adj_rent": 1280, "note": "orig $1480, reduced $200"},
    "PP-169094CB": {"adj_rent": 1295, "note": "orig $1397, reduced $102"},
    "PP-A7A02488": {"adj_rent": 1275, "note": "orig $1600, reduced $325"},
    "PP-5FBA53C8": {"adj_rent": 1285, "note": "orig $1370, reduced $85"},
    "PP-F1CFFEF3": {"adj_rent": 1295, "note": "orig $1395, reduced $100"},
    "PP-EADEF228": {"adj_rent": 1285, "note": "orig $1540, reduced $255"},
}

DESCRIPTIONS = {

"PP-DD003B48": """\
This well-maintained 2-bedroom, 1-bathroom single-family home at 1422 Tamerton Ave in \
University City combines classic St. Louis character with thoughtful updates that make \
everyday living comfortable and easy. Built in 1947, the home sits in one of the \
region's most walkable and well-connected communities, with a fenced yard offering \
private outdoor space and room to relax.

Inside, the updated kitchen is a highlight — equipped with an electric cooktop and \
refrigerator, with laundry hookups available in the basement for added convenience. \
Central air and forced-air heat keep the home comfortable year-round. The open den \
layout flows naturally between living spaces, and vinyl flooring throughout delivers \
durability with a clean, modern feel. The basement offers excellent storage capacity \
for everything from seasonal items to household gear.

Residents enjoy immediate access to University City's vibrant corridor of shops, \
restaurants, and cultural attractions along Delmar Boulevard, as well as nearby \
parks and community outdoor space. MetroLink and major routes including I-170 and \
Olive Blvd connect commuters quickly to Clayton, downtown St. Louis, and beyond.

Application Fee: $50. Security deposit equal to one month's rent ($1,300).\
""",

"PP-6C2C0D39": """\
Sitting in Berkeley's established residential grid, this move-in-ready 3-bedroom, \
1-bathroom home at 6108 Eaton Dr delivers excellent value, a flexible layout, and \
rare convenience features at an accessible price point. Built in 1950 and \
thoughtfully maintained, the home sits on a quiet street within easy reach of \
North St. Louis County's major employers and transit corridors.

The center-hall floor plan keeps the home well-organized, with three bedrooms \
providing ample space for families or those needing a dedicated home office or \
hobby room. Laminate flooring runs throughout the main living areas for easy \
upkeep. A 1-car garage and carport offer covered parking for multiple vehicles — \
a genuine advantage in any weather. Central air and forced-air heat deliver \
year-round comfort. The basement accommodates laundry (washer/dryer hookups \
available) and provides significant additional storage. A gas range and refrigerator \
are included in the kitchen. The patio gives residents a private outdoor retreat, \
and the home is pet-friendly.

Located minutes from Lambert-St. Louis International Airport, Walmart Neighborhood \
Market, community parks, and shopping along Natural Bridge Ave, with quick access \
to I-70 and I-170 for commuters.

Application Fee: $50. Security deposit equal to one month's rent ($1,300).\
""",

"PP-EA9C1FFC": """\
Tucked into a quiet street in Saint Ann — one of the most convenient communities \
in the St. Louis metro, sitting just minutes from both Overland and Maryland Heights \
— this charming 2-bedroom, 1-bathroom single-family home at 3135 LA Vista Dr blends \
classic mid-century character with practical updates renters actually appreciate.

Built in 1942 and well-maintained, the home features original hardwood floors \
throughout the main living areas, a fenced yard providing private outdoor space \
for entertaining or pets, and a 1-car garage for protected parking. Inside, the \
kitchen is fully equipped with a portable dishwasher, microwave, gas range, and \
refrigerator — everything needed for efficient daily meal prep. Central air and \
forced-air heating keep every room comfortable year-round. Laundry hookups are \
available in the basement, which also serves as generous additional storage. \
The home is pet-friendly.

Saint Ann's location is genuinely hard to beat: Natural Bridge Ave and \
St. Charles Rock Rd provide direct access to Overland, Maryland Heights, Bridgeton, \
and the broader North County corridor. I-70 and I-270 are minutes away, connecting \
residents to downtown St. Louis, Clayton, and Lambert-St. Louis International Airport.

Application Fee: $50. Security deposit equal to one month's rent ($1,295).\
""",

"PP-DC30973B": """\
This beautifully preserved 2-bedroom, 1-bathroom brick bungalow at 4028 Schiller Pl \
in the Tower Grove South neighborhood of St. Louis brings together period character \
and practical modern updates in one of the city's most desirable residential pockets. \
Built in 1914, the home has been well cared for and is ready for its next residents.

Hardwood floors run throughout the main living areas — original and beautifully \
maintained — complemented by a fenced yard for private outdoor use and off-street \
driveway parking. Inside, the kitchen is equipped with a dishwasher, freezer, \
microwave, range/oven, and refrigerator. A den provides flexible space for a home \
office or reading room. Central air and forced-air heat ensure comfort in all \
seasons. The basement adds meaningful storage capacity. The home is single-story \
and pet-friendly, and the neighborhood provides immediate access to medical services, \
parks, and views of the surrounding tree-lined streets.

Tower Grove South offers a lively neighborhood character with acclaimed restaurants, \
coffee shops, and independent retail along South Grand Blvd and Morganford Rd. \
Highway 44 and I-55 provide straightforward connections to the rest of the metro.

Application Fee: $50. Security deposit equal to one month's rent ($1,295).\
""",

"PP-3127406E": """\
Spacious, move-in-ready, and packed with practical features, this 3-bedroom, \
1-bathroom single-family home at 10048 Hedge Dr in St. Louis (63137) delivers \
exceptional square footage and comfort for the price. The single-story layout \
keeps everyday living simple and accessible, while the attached garage and \
washer/dryer hookups mean two of the most common renter frustrations are already \
solved.

The open kitchen features granite countertops, a dishwasher, range/oven, and \
refrigerator — a well-equipped workspace for everyday cooking. Central heat \
(forced air) and a den for flexible use round out the interior. Three bedrooms \
offer ample room for families, roommates, or dedicated work-from-home setups. \
The home's basement adds substantial storage capacity. A garage lot provides \
off-street parking. This home is pet-friendly.

Located in North St. Louis County near the Bellefontaine Neighbors border, \
the property sits close to Halls Ferry Rd and I-270, connecting residents to \
Florissant, Ferguson, and the broader St. Louis metro quickly. Nearby parks, \
grocery stores, and neighborhood shops are all within a short drive.

Application Fee: $50. Security deposit equal to one month's rent ($1,280).\
""",

"PP-169094CB": """\
Offering more square footage than most in its price range, this 3-bedroom, \
1-bathroom single-family home at 4760 Alaska Ave in the Dutchtown neighborhood \
of St. Louis delivers 1,250 square feet of well-configured living space at an \
outstanding value. Single-story living, practical features, and a central location \
make this a standout choice for families and working professionals alike.

The home includes garage parking, washer/dryer hookups for in-unit laundry \
convenience, and a range/oven and refrigerator in the kitchen. Three bedrooms \
provide versatility for different household configurations — ideal for families \
needing extra rooms or tenants who want a dedicated home office. Central heating \
(forced air) keeps the home warm in colder months, and the basement adds \
significant storage to an already generous layout. The home is pet-friendly.

Dutchtown's dense commercial corridor along Chippewa St and Gravois Ave puts \
grocery stores, restaurants, and services within walking distance. Quick access \
to I-55 and I-44 makes commuting to downtown St. Louis, Affton, or South County \
straightforward.

Application Fee: $50. Security deposit equal to one month's rent ($1,295).\
""",

"PP-A7A02488": """\
Set in one of Florissant's most established residential neighborhoods, this \
spacious 3-bedroom, 2-bathroom home at 3726 Briargrove Dr offers 1,292 square \
feet of character-filled living space with rare features — a wood-burning fireplace, \
original hardwood floors, and a modern kitchen — all at an accessible price point \
that is uncommon for a home this size in North St. Louis County.

The open kitchen design creates a natural connection to the main living areas, \
making daily routines feel easy and social. A dedicated laundry room adds \
convenience for busy households. The patio and large yard provide generous \
outdoor space — excellent for entertaining, gardening, or simply enjoying \
Florissant's tree-lined neighborhood setting. The 1-car garage offers protected \
parking year-round. With two full bathrooms, the home accommodates families or \
roommate situations with ease. Pet-friendly. Built in 1969.

Florissant is one of St. Louis County's most livable communities, offering \
strong public schools, abundant parks, and a full complement of shopping and \
dining along New Florissant Rd and Lindbergh Blvd. I-270 provides a direct \
connection to the rest of the metro.

Application Fee: $50. Security deposit equal to one month's rent ($1,275).\
""",

"PP-5FBA53C8": """\
Clean, comfortable, and priced to deliver real value, this 2-bedroom, 1-bathroom \
single-family home at 3309 Osage St in St. Louis offers 1,024 square feet of \
well-maintained living space in the Fox Park neighborhood — one of the city's \
most charming and walkable residential districts.

The interior features a practical single-story layout with a full living room, \
dedicated den for flexible use, and a kitchen fully equipped with a dishwasher, \
range/oven, and refrigerator. Washer/dryer hookups add laundry convenience. \
Central heating (forced air) keeps the home comfortable in colder months. \
The basement provides strong storage capacity. The home is pet-friendly, and \
on-site maintenance is available to residents.

Fox Park's compact, walkable streets put Benton Park, Tower Grove Park, \
and the South Grand dining corridor all within easy reach. I-44 and I-55 \
connect commuters to downtown St. Louis, the medical corridor, and South \
County in minutes.

Application Fee: $50. Security deposit equal to one month's rent ($1,285).\
""",

"PP-F1CFFEF3": """\
Move-in-ready and generously sized for the price, this 3-bedroom, 1-bathroom \
single-family home at 710 Derhake Rd in Florissant offers a well-maintained \
interior, an updated kitchen, and a large yard — all the basics that make a house \
feel like home, without the premium price tag.

Built in 1953, the home sits on a quiet street in North Florissant with driveway \
parking and a big yard that's ideal for outdoor activities, gardening, or simply \
having space to spread out. The updated kitchen is a practical improvement that \
makes daily cooking more enjoyable, and the dedicated laundry room keeps \
household routines organized. Three bedrooms provide flexibility for families, \
guests, or a home office setup. Nearby parks and shopping make errands and \
recreation convenient. Pet-friendly.

Florissant offers excellent access to North St. Louis County's employment \
corridors and is well-connected via I-270 and I-70 to the broader metro area. \
Schools, grocery stores, and community amenities are all close at hand.

Application Fee: $50. Security deposit equal to one month's rent ($1,295).\
""",

"PP-EADEF228": """\
Compact, updated, and full of character, this 2-bedroom, 1-bathroom home at \
5324 Nagel Ave in the Bevo Mill neighborhood of St. Louis packs impressive \
livability into 768 square feet of smartly designed space. A front porch, big \
yard, hardwood floors, and an updated kitchen give this home an inviting \
personality that photos alone can't fully capture.

The open-concept floor plan maximizes the footprint, keeping the living areas \
bright and connected. Hardwood floors run throughout for a warm, timeless \
aesthetic. The updated kitchen delivers a modern workspace for daily cooking. \
The large private yard is an exceptional asset for a home in this price range, \
perfect for outdoor dining, gardening, or a pet-friendly space to roam. \
The front porch is a classic St. Louis feature for relaxed mornings and evening \
unwinding. Basement storage is included. Pet-friendly.

Bevo Mill's neighborhood character is quiet and residential, with convenient \
access to the South Grand dining district, Carondelet Park, and the city's \
medical and university corridors. Highway 55 and Gravois Ave connect to the \
rest of the metro quickly.

Application Fee: $50. Security deposit equal to one month's rent ($1,285).\
""",
}


# ── Photo helpers ─────────────────────────────────────────────────────────────

def _get_source_urls(pipeline_id):
    r = requests.get(SUPABASE_URL + "/rest/v1/pipeline_properties", headers=H_PL,
        params={"select": "original_image_urls", "id": "eq." + pipeline_id})
    rows = r.json()
    if not rows:
        return []
    return json.loads(rows[0].get("original_image_urls") or "[]")


def _download(url):
    hdrs = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"),
        "Accept":  "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Referer": "https://www.realtor.com/",
    }
    try:
        resp = requests.get(url, headers=hdrs, timeout=DOWNLOAD_TIMEOUT)
        if resp.status_code == 200:
            return resp.content, resp.headers.get("Content-Type", "image/jpeg")
    except Exception:
        pass
    return None, None


def _upload_ik(img_bytes, filename, folder):
    b64 = base64.b64encode(img_bytes).decode()
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post("https://upload.imagekit.io/api/v1/files/upload",
                auth=(IK_PRIVATE_KEY, ""),
                data={"file": b64, "fileName": filename, "folder": folder},
                timeout=UPLOAD_TIMEOUT)
            if resp.status_code in (200, 201):
                d = resp.json()
                return d.get("url"), d.get("fileId", "")
        except Exception:
            pass
        if attempt < MAX_RETRIES - 1:
            time.sleep(RETRY_BACKOFF * (attempt + 1))
    return None, None


def _insert_photo(property_id, ik_url, file_id, order, is_hero):
    r = requests.post(SUPABASE_URL + "/rest/v1/property_photos", headers=H_PUB,
        json={"property_id": property_id, "url": ik_url, "file_id": file_id,
              "display_order": order, "is_hero": is_hero,
              "watermark_status": "pending", "alt_text": ""})
    return r.status_code in (200, 201)


def import_photos(pipeline_id, property_id):
    src_urls = _get_source_urls(pipeline_id)
    if not src_urls:
        raise RuntimeError("No source image URLs in pipeline record")
    urls = src_urls[:MAX_PHOTOS]
    folder = "properties/" + property_id.replace("-", "")
    transferred = 0
    skipped = 0
    for idx, url in enumerate(urls):
        is_hero = (idx == 0)
        ext = "jpg"
        lower = url.lower().split("?")[0]
        if ".png" in lower: ext = "png"
        elif ".webp" in lower: ext = "webp"
        filename = f"photo_{idx+1:03d}.{ext}"
        img_bytes, _ = _download(url)
        if not img_bytes:
            skipped += 1
            print(f"       ⚠   [{idx+1}/{len(urls)}] download failed")
            continue
        ik_url, file_id = _upload_ik(img_bytes, filename, folder)
        if not ik_url:
            skipped += 1
            print(f"       ⚠   [{idx+1}/{len(urls)}] IK upload failed")
            continue
        if _insert_photo(property_id, ik_url, file_id, idx, is_hero):
            transferred += 1
            tag = " [HERO]" if is_hero else ""
            print(f"       ✅  [{idx+1}/{len(urls)}]{tag} uploaded")
        else:
            skipped += 1
            print(f"       ⚠   [{idx+1}/{len(urls)}] DB insert failed")
        time.sleep(0.15)
    if transferred == 0:
        raise RuntimeError(f"Zero photos transferred (skipped={skipped})")
    return transferred, skipped


# ── DB helpers ────────────────────────────────────────────────────────────────

def patch_pipeline(pipeline_id, patch):
    r = requests.patch(SUPABASE_URL + "/rest/v1/pipeline_properties",
        headers=H_PL, params={"id": "eq." + pipeline_id}, json=patch)
    if r.status_code not in (200, 204):
        raise RuntimeError(f"PATCH pipeline {r.status_code}: {r.text[:300]}")


def publish_rpc(pipeline_id):
    r = requests.post(SUPABASE_URL + "/rest/v1/rpc/pipeline_publish",
        headers=H_PUB,
        json={"p_id": pipeline_id, "p_landlord_id": None})
    if r.status_code not in (200, 201):
        raise RuntimeError(f"RPC {r.status_code}: {r.text[:400]}")
    result = r.json()
    if not result.get("ok"):
        raise RuntimeError(f"RPC ok=false: {result.get('error')}")
    return result["choice_property_id"]


def verify_photo_count(property_id):
    r = requests.get(SUPABASE_URL + "/rest/v1/property_photos",
        headers=H_PUB, params={"select": "id", "property_id": "eq." + property_id})
    data = r.json()
    return len(data) if isinstance(data, list) else 0


def activate(property_id):
    r = requests.patch(SUPABASE_URL + "/rest/v1/properties",
        headers=H_PUB, params={"id": "eq." + property_id},
        json={"status": "active", "pets_allowed": True})
    if r.status_code not in (200, 204):
        raise RuntimeError(f"Activate {r.status_code}: {r.text[:300]}")


def prop_url(pid):
    return f"https://choice-properties-site.pages.dev/property.html?id={pid}"


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("\n" + "=" * 62)
    print("  Overland / Maryland Heights, St. Louis County")
    print("  Batch Publish — 10 properties")
    print("  Max published rent: $1,300/mo")
    print("=" * 62)

    published = []
    failed    = []

    for pipeline_id, plan in PRICE_PLAN.items():
        adj_rent = plan["adj_rent"]
        note     = plan["note"]
        desc     = DESCRIPTIONS[pipeline_id]

        print(f"\n{'─'*58}")
        print(f"  {pipeline_id}  ({note}  → ${adj_rent:,}/mo)")

        # 1 — Patch pipeline
        print("  [1/5] Patching pipeline...")
        try:
            patch_pipeline(pipeline_id, {
                "monthly_rent":     adj_rent,
                "security_deposit": adj_rent,
                "application_fee":  50,
                "description":      desc,
                "edited_fields":    json.dumps(["monthly_rent", "security_deposit",
                                                "application_fee", "description"]),
            })
            print("       ✅  Done")
        except Exception as e:
            print(f"       ❌  {e}")
            failed.append((pipeline_id, f"Step 1: {e}"))
            continue
        time.sleep(0.3)

        # 2 — Publish → draft
        print("  [2/5] Publishing (→ draft)...")
        choice_id = None
        try:
            choice_id = publish_rpc(pipeline_id)
            print(f"       ✅  draft → {choice_id}")
        except Exception as e:
            print(f"       ❌  {e}")
            failed.append((pipeline_id, f"Step 2: {e}"))
            continue
        time.sleep(0.3)

        # 3 — Photos (required before activation)
        print("  [3/5] Importing photos (required before activation)...")
        try:
            transferred, skipped = import_photos(pipeline_id, choice_id)
            print(f"       ✅  {transferred} transferred, {skipped} skipped")
        except Exception as e:
            print(f"       ❌  {e}")
            print("       ⛔  Stays draft — activation skipped")
            failed.append((pipeline_id, f"Step 3: {e}"))
            continue
        time.sleep(0.3)

        # 4 — Verify photo count
        print("  [4/5] Verifying photo count in DB...")
        count = verify_photo_count(choice_id)
        if count == 0:
            print("       ❌  Zero photos in DB — skipping activation")
            failed.append((pipeline_id, "Step 4: zero photos confirmed"))
            continue
        print(f"       ✅  {count} photos confirmed")

        # 5 — Activate (photos confirmed)
        print("  [5/5] Activating...")
        try:
            activate(choice_id)
            print("       ✅  Active (pets_allowed=true)")
        except Exception as e:
            print(f"       ❌  {e}")
            failed.append((pipeline_id, f"Step 5: {e}"))
            continue

        published.append({"pipeline_id": pipeline_id, "choice_id": choice_id,
                          "photos": count, "rent": adj_rent})

    # ── Report ────────────────────────────────────────────────────────────────
    print("\n" + "=" * 62)
    print(f"  RESULT: {len(published)} published, {len(failed)} failed")
    print("=" * 62)

    if published:
        print("\n  Successfully published:")
        for i, p in enumerate(published, 1):
            print(f"\n  {i}. Pipeline: {p['pipeline_id']}")
            print(f"     Property: {p['choice_id']}")
            print(f"     Rent:     ${p['rent']:,}/mo")
            print(f"     Photos:   {p['photos']}")
            print(f"     URL:      {prop_url(p['choice_id'])}")

    if failed:
        print("\n  Failed (left as draft):")
        for pid, reason in failed:
            print(f"  • {pid}: {reason}")

    if not published:
        sys.exit(1)


if __name__ == "__main__":
    main()
