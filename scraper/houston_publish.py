#!/usr/bin/env python3
"""
Publish all staged Houston-area 1BR pipeline listings.

Steps per listing:
  1. Call pipeline_publish() RPC  -> creates public.properties row (status=draft)
  2. Call import-pipeline-photos edge function -> transfers photos + flips to active

Usage:
    python scraper/houston_publish.py
    python scraper/houston_publish.py --dry-run   (shows IDs, makes no changes)
"""
import os, sys, json, time, argparse, requests

sys.path.insert(0, os.path.dirname(__file__))
try:
    from scraper import _load_dotenv
    _load_dotenv()
except Exception:
    pass

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://tlfmwetmhthpyrytrcfo.supabase.co").rstrip("/")
SERVICE_KEY  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

PIPELINE_IDS = [
    "PP-126A2EC6",  # 3615 Paluxy Cir, Missouri City
    "PP-C8790462",  # 21322 Monterrico Bay Dr, Cypress
    "PP-96DCD949",  # 728 Hogan Dr, Conroe
    "PP-613E42A7",  # 2322 Shady Pine Dr, Conroe
    "PP-B6DAED35",  # 2308 Stevens St, Houston
    "PP-455F81E2",  # 905 74th St Unit 2, Houston
    "PP-3742F748",  # 2025 Augusta Dr Apt 1005, Houston
    "PP-393D654D",  # 3231 Ashton Park Dr, Houston
    "PP-0759FDA6",  # 7910 Ford St, Houston
    "PP-6F47CE63",  # 3726 Herald St, Houston
    "PP-98351555",  # 7356 Cayton St, Houston
    "PP-F4EBDD61",  # 523 Cresline St Rm 1, Houston
    "PP-654B364D",  # 1836 Cortlandt St, Houston
    "PP-27E921FB",  # 12755 Mill Ridge Dr Apt 402, Cypress
]

RPC_HEADERS = {
    "apikey":        SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type":  "application/json",
    "Accept-Profile":"public",
}

EDGE_HEADERS = {
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type":  "application/json",
}

SITE_BASE = "https://choice-properties-site.pages.dev/property"


def publish_one(pipeline_id, dry_run=False):
    """Returns (choice_property_id, error_str)."""
    if dry_run:
        return f"DRY-{pipeline_id}", None

    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/rpc/pipeline_publish",
        headers=RPC_HEADERS,
        json={"p_id": pipeline_id, "p_landlord_id": None},
        timeout=20,
    )
    if resp.status_code not in (200, 201):
        return None, f"HTTP {resp.status_code}: {resp.text[:200]}"

    data = resp.json()
    if not data.get("ok"):
        return None, data.get("error", "Unknown RPC error")

    return data["choice_property_id"], None


def import_photos(pipeline_id, property_id, dry_run=False):
    """Returns (transferred, error_str)."""
    if dry_run:
        return 0, None

    resp = requests.post(
        f"{SUPABASE_URL}/functions/v1/import-pipeline-photos",
        headers=EDGE_HEADERS,
        json={"pipeline_id": pipeline_id, "property_id": property_id},
        timeout=120,
    )
    if resp.status_code not in (200, 201):
        return 0, f"HTTP {resp.status_code}: {resp.text[:200]}"

    data = resp.json()
    if not data.get("success"):
        # 409 already_imported is fine — photos are there
        if data.get("already_imported"):
            return data.get("existing", 0), None
        return 0, data.get("error", "Photo import failed")

    return data.get("transferred", 0), None


def fetch_addresses():
    """Pull address+city for the 14 IDs so we can label output."""
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/pipeline_properties",
        headers={**RPC_HEADERS, "Accept-Profile": "pipeline"},
        params={
            "select": "id,address,city",
            "id": "in.(" + ",".join(PIPELINE_IDS) + ")",
        },
        timeout=15,
    )
    if resp.status_code != 200:
        return {}
    return {r["id"]: f"{r['address']}, {r['city']}" for r in resp.json()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    labels = fetch_addresses()

    results = []
    print(f"\n{'DRY RUN — ' if args.dry_run else ''}Publishing {len(PIPELINE_IDS)} Houston listings...\n")

    for i, pid in enumerate(PIPELINE_IDS, 1):
        label = labels.get(pid, pid)

        # Step 1: publish
        choice_id, err = publish_one(pid, args.dry_run)
        if err:
            print(f"  [{i:02d}] ❌  {label}\n       PUBLISH ERROR: {err}")
            results.append((i, label, None, err))
            continue

        # Step 2: import photos
        transferred, photo_err = import_photos(pid, choice_id, args.dry_run)
        if photo_err:
            url = f"{SITE_BASE}/{choice_id}"
            print(f"  [{i:02d}] ⚠️   {label}\n       Published (id={choice_id}) but photo import failed: {photo_err}\n       {url}")
            results.append((i, label, choice_id, f"photo_err: {photo_err}"))
        else:
            url = f"{SITE_BASE}/{choice_id}"
            print(f"  [{i:02d}] ✅  {label}\n       {url}  ({transferred} photos{'  [dry run]' if args.dry_run else ''})")
            results.append((i, label, choice_id, None))

        if not args.dry_run:
            time.sleep(0.3)   # gentle pacing

    ok  = sum(1 for r in results if r[2] and not r[3])
    err = sum(1 for r in results if r[3])
    print(f"\n{'─'*60}")
    print(f"Done — {ok} published, {err} error(s)\n")

    if ok:
        print("Final URLs:")
        for n, label, cid, e in results:
            if cid and not e:
                print(f"  {n}. {SITE_BASE}/{cid}  — {label}")


if __name__ == "__main__":
    main()
