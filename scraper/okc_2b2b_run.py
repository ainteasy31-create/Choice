#!/usr/bin/env python3
"""
One-off: scrape & publish 3 single-family 2bd/2ba homes in OKC.
"""
import sys
from pipeline import PipelineOrchestrator, BatchCriteria

def pricing_fn(original_rent, seen_rents=None):
    if original_rent is None:
        return None, None
    rent = float(original_rent)
    # Broad band to maximise results for 2/2 SFH in OKC
    if rent < 900 or rent > 2000:
        return None, None
    published = int(round(rent))
    if seen_rents and published in seen_rents:
        for nudge in (5, -5, 10, -10, 15, -15):
            c = published + nudge
            if 900 <= c <= 2000 and c not in seen_rents:
                published = c
                break
    return published, rent

criteria = BatchCriteria(
    batch_name="OKC 2bd2ba SFH",
    locations=[
        "Oklahoma City, OK",
        "Moore, OK",
        "Edmond, OK",
        "Midwest City, OK",
        "Norman, OK",
    ],
    allowed_types={"SINGLE_FAMILY"},
    beds_exact=2,
    baths_min=2.0,
    rent_min=900,
    rent_max=2000,
    rent_floor=900,
    rent_cap=2000,
    target=3,
    past_days=90,
    limit=300,
    min_score=30,
    pricing_fn=pricing_fn,
)

orchestrator = PipelineOrchestrator(verbose=True)
result = orchestrator.run(criteria)

print("\n=== RESULT ===")
print(f"Scraped  : {result.scraped}")
print(f"Staged   : {result.staged}")
print(f"Published: {result.published}")
if result.published_urls:
    print("Published URLs:")
    for url in result.published_urls:
        print(f"  {url}")
if result.errors:
    print(f"Errors   : {len(result.errors)}")
    for e in result.errors[:5]:
        print(f"  {e}")

sys.exit(0 if result.published >= 3 else 1)
