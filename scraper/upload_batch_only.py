#!/usr/bin/env python3
"""
Upload two photo batches to ImageKit under a pre-allocated pipeline ID.
Prints the ordered URL list for use in the finish script.
"""
import json, os, sys, time, uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

SUPABASE_URL   = os.environ["SUPABASE_URL"]
IK_PRIVATE_KEY = os.environ["IMAGEKIT_PRIVATE_KEY"]
IK_UPLOAD_URL  = "https://upload.imagekit.io/api/v1/files/upload"
IK_AUTH        = requests.auth.HTTPBasicAuth(IK_PRIVATE_KEY, "")

REPO_ROOT = Path(__file__).parent.parent

# Batch A — exterior/backyard shots
BATCH_A = sorted(
    p for p in REPO_ROOT.glob("attached_assets/*.webp")
    if "1784564388882" in p.name or "1784564388883" in p.name or "1784564388884" in p.name
)
# Batch B — interior shots
BATCH_B = sorted(
    p for p in REPO_ROOT.glob("attached_assets/*.webp")
    if "1784564883061" in p.name or "1784564883062" in p.name or "1784564883063" in p.name
)

ALL_PHOTOS = BATCH_A + BATCH_B
PIPELINE_ID = "PP-" + uuid.uuid4().hex[:8].upper()
IK_FOLDER   = "/properties/{}".format(PIPELINE_ID)

print("Pipeline ID: {}".format(PIPELINE_ID))
print("Batch A: {} files, Batch B: {} files, Total: {}".format(
    len(BATCH_A), len(BATCH_B), len(ALL_PHOTOS)))

def upload_photo(idx, path, folder):
    fname = "photo_{:02d}.webp".format(idx + 1)
    for attempt in range(1, 4):
        try:
            data = open(path, "rb").read()
            r = requests.post(
                IK_UPLOAD_URL,
                auth=IK_AUTH,
                files={"file": (fname, data, "image/webp")},
                data={"fileName": fname, "folder": folder},
                timeout=60,
            )
            if r.status_code == 200:
                url = r.json().get("url")
                if url:
                    print("  [{:02d}] OK".format(idx + 1))
                    return idx, url
            print("  [{:02d}] HTTP {} attempt {}: {}".format(idx+1, r.status_code, attempt, r.text[:60]))
        except Exception as e:
            print("  [{:02d}] Error attempt {}: {}".format(idx+1, attempt, str(e)[:60]))
        if attempt < 3:
            time.sleep(2 * attempt)
    return idx, None

print("\nUploading {} photos...".format(len(ALL_PHOTOS)))
results = [None] * len(ALL_PHOTOS)
with ThreadPoolExecutor(max_workers=6) as ex:
    futures = {ex.submit(upload_photo, i, p, IK_FOLDER): i for i, p in enumerate(ALL_PHOTOS)}
    for fut in as_completed(futures):
        idx, url = fut.result()
        results[idx] = url

ik_urls = [u for u in results if u]
failed  = results.count(None)
print("\nDone: {} OK, {} failed".format(len(ik_urls), failed))

if failed:
    print("FAILED indices: {}".format([i for i, u in enumerate(results) if u is None]))
    sys.exit(1)

print("\nPIPELINE_ID={}".format(PIPELINE_ID))
print("IK_URLS={}".format(json.dumps(results)))
