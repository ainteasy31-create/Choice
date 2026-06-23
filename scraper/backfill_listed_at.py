#!/usr/bin/env python3
"""
backfill_listed_at.py
=====================
Looks up original Realtor.com listing dates for properties that have no
pipeline record (manually-entered / pre-pipeline imports).

Searches Realtor.com city-by-city via HomeHarvest, matches results to our
property records by normalised address, then patches listed_at in Supabase.

Run from Replit shell (Realtor.com is reachable from datacenter IPs):

    python3 scraper/backfill_listed_at.py                 # live run
    python3 scraper/backfill_listed_at.py --dry-run       # preview only
    python3 scraper/backfill_listed_at.py --city "Austin, TX"  # single city
"""

import os, sys, re, time, json, argparse
import urllib.request
from datetime import date, timedelta
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

try:
    from homeharvest import scrape_property
except ImportError:
    sys.exit('homeharvest not installed. Run: pip install homeharvest')

# ── Supabase ────────────────────────────────────────────────────────────────
MGMT_TOKEN = (
    os.environ.get('SUPABASE_MANAGEMENT_TOKEN') or
    os.environ.get('SUPABASE_ACCESS_TOKEN')
)
MGMT_URL = 'https://api.supabase.com/v1/projects/tlfmwetmhthpyrytrcfo/database/query'

def db(sql):
    if not MGMT_TOKEN:
        sys.exit('ERROR: SUPABASE_MANAGEMENT_TOKEN env var not set.')
    payload = json.dumps({'query': sql}).encode()
    req = urllib.request.Request(
        MGMT_URL, data=payload,
        headers={'Authorization': f'Bearer {MGMT_TOKEN}',
                 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        result = json.loads(r.read())
    if isinstance(result, dict) and 'message' in result:
        raise RuntimeError(f'DB error: {result["message"]}')
    return result

# ── Address normalisation ────────────────────────────────────────────────────
ABBREV = {
    r'\bstreet\b': 'st', r'\bavenue\b': 'ave', r'\bboulevard\b': 'blvd',
    r'\bdrive\b': 'dr', r'\broad\b': 'rd', r'\blane\b': 'ln',
    r'\bcourt\b': 'ct', r'\bplace\b': 'pl', r'\bway\b': 'way',
    r'\bcircle\b': 'cir', r'\bterrace\b': 'ter', r'\btrail\b': 'trl',
    r'\bparkway\b': 'pkwy', r'\bhighway\b': 'hwy',
}

def normalise(addr):
    if not addr:
        return ''
    s = addr.lower().strip()
    # strip unit/apt suffixes
    s = re.sub(r'\b(apt|unit|suite|ste|#)\s*[\w-]+', '', s)
    for pat, rep in ABBREV.items():
        s = re.sub(pat, rep, s)
    s = re.sub(r'[^\w\s]', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def addr_key(addr):
    """(street_number, first_word_of_street_name) — used for matching."""
    parts = normalise(addr).split()
    if len(parts) >= 2:
        return (parts[0], parts[1])
    if parts:
        return (parts[0], '')
    return ('', '')

# ── Main ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='Backfill listed_at from Realtor.com')
    parser.add_argument('--dry-run', action='store_true', help='Preview matches, no DB writes')
    parser.add_argument('--city', help='Only process one city, e.g. "Austin, TX"')
    parser.add_argument('--past-days', type=int, default=365,
                        help='How far back to search on Realtor.com (default 365)')
    args = parser.parse_args()

    print('Fetching properties without pipeline records ...')
    rows = db("""
        SELECT p.id, p.address, p.city, p.state, p.zip, p.created_at::date AS created_date
        FROM public.properties p
        WHERE NOT EXISTS (
            SELECT 1 FROM pipeline.pipeline_properties pp
            WHERE pp.choice_property_id = p.id
        )
        ORDER BY p.city, p.state, p.address
    """)
    print(f'  {len(rows)} properties to process')

    # Group by city+state
    from collections import defaultdict
    by_city = defaultdict(list)
    for r in rows:
        key = (r['city'], r['state'])
        by_city[key].append(r)

    if args.city:
        parts = [p.strip() for p in args.city.split(',')]
        if len(parts) == 2:
            filter_key = (parts[0], parts[1])
            by_city = {k: v for k, v in by_city.items() if k == filter_key}
            if not by_city:
                sys.exit(f'City not found: {args.city}')
        else:
            sys.exit('--city format: "City, ST" e.g. "Austin, TX"')

    total_cities = len(by_city)
    matched_total = 0
    updated_total = 0

    for idx, ((city, state), props) in enumerate(sorted(by_city.items()), 1):
        location = f'{city}, {state}'
        print(f'\n[{idx}/{total_cities}] {location} — {len(props)} properties')

        # Build lookup: addr_key → property record
        lookup = {}
        for p in props:
            k = addr_key(p['address'])
            lookup[k] = p

        try:
            listings = scrape_property(
                location=location,
                listing_type='for_rent',
                past_days=args.past_days,
            )
        except Exception as e:
            print(f'  WARN: scrape failed — {e}')
            time.sleep(2)
            continue

        if listings is None or (hasattr(listings, '__len__') and len(listings) == 0):
            print(f'  No results returned')
            time.sleep(1)
            continue

        matched_in_city = 0
        updates = []

        for _, row in listings.iterrows():
            raw_addr = str(row.get('street', '') or '')
            if not raw_addr:
                continue
            k = addr_key(raw_addr)
            if k not in lookup:
                continue

            prop = lookup[k]
            list_date = row.get('list_date', None)
            if list_date is None or (hasattr(list_date, '__class__') and 'NaT' in str(list_date)):
                continue

            # Convert to date string
            try:
                if hasattr(list_date, 'date'):
                    date_str = list_date.date().isoformat()
                else:
                    date_str = str(list_date)[:10]
            except Exception:
                continue

            prop_id = prop['id'].replace("'", "''")
            print(f'  MATCH: {prop["address"]} → listed {date_str}')
            updates.append((prop_id, date_str))
            matched_in_city += 1
            matched_total += 1
            # Remove from lookup so we don't double-match
            del lookup[k]

        print(f'  Matched {matched_in_city}/{len(props)}')

        if updates and not args.dry_run:
            # Batch update via CASE statement
            case_clauses = '\n'.join(
                f"  WHEN id = '{pid}' THEN '{dt}'::date"
                for pid, dt in updates
            )
            id_list = ', '.join(f"'{pid}'" for pid, _ in updates)
            sql = f"""
                UPDATE public.properties
                SET listed_at = CASE
                {case_clauses}
                END
                WHERE id IN ({id_list})
            """
            try:
                db(sql)
                updated_total += len(updates)
                print(f'  Updated {len(updates)} rows in DB')
            except Exception as e:
                print(f'  ERROR updating DB: {e}')

        elif updates and args.dry_run:
            print(f'  [dry-run] Would update {len(updates)} rows')

        time.sleep(1.5)  # be polite to Realtor.com

    print(f'\n{"="*60}')
    print(f'Done. Matched {matched_total} properties across {total_cities} cities.')
    if not args.dry_run:
        print(f'Updated {updated_total} rows in Supabase.')
    else:
        print('[dry-run] No DB writes made.')

if __name__ == '__main__':
    main()
