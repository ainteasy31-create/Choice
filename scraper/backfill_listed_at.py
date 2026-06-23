#!/usr/bin/env python3
"""
backfill_listed_at.py
=====================
Looks up original Realtor.com listing dates for properties that have no
pipeline record (manually-entered / pre-pipeline imports).

Searches Realtor.com city-by-city via HomeHarvest, matches results to our
property records by normalised address, then patches listed_at in Supabase.

Usage (run from repo root):

    # Step 1 — generate the input file via code_execution (already done if
    #           /tmp/props_to_backfill.json exists):
    #   see backfill_listed_at_prep.js

    # Step 2 — dry run (preview matches, no DB writes):
    python3 scraper/backfill_listed_at.py --dry-run

    # Step 3 — live run:
    python3 scraper/backfill_listed_at.py

    # Single city only:
    python3 scraper/backfill_listed_at.py --city "Austin, TX"

    # Adjust how far back to search (default 365 days):
    python3 scraper/backfill_listed_at.py --past-days 180
"""

import os, sys, re, time, json, argparse
import urllib.request, urllib.parse
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

try:
    from homeharvest import scrape_property
except ImportError:
    sys.exit('homeharvest not installed.  Run: pip install homeharvest')

# ── Supabase (REST API with service role key — works from shell) ─────────────
SUPABASE_URL = os.getenv('SUPABASE_URL', 'https://tlfmwetmhthpyrytrcfo.supabase.co')
SERVICE_KEY  = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
if not SERVICE_KEY:
    sys.exit('ERROR: SUPABASE_SERVICE_ROLE_KEY not found in scraper/.env')

REST_HEADERS = {
    'apikey': SERVICE_KEY,
    'Authorization': f'Bearer {SERVICE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
}

def patch_property(prop_id, listed_at_str):
    """PATCH listed_at for a single property via Supabase REST API."""
    encoded_id = urllib.parse.quote(prop_id, safe='')
    url = f'{SUPABASE_URL}/rest/v1/properties?id=eq.{encoded_id}'
    payload = json.dumps({'listed_at': listed_at_str}).encode()
    req = urllib.request.Request(url, data=payload, method='PATCH',
          headers={**REST_HEADERS, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status

# ── Input file written by code_execution ─────────────────────────────────────
INPUT_FILE = '/tmp/props_to_backfill.json'

# ── Address normalisation ─────────────────────────────────────────────────────
ABBREV = {
    r'\bstreet\b': 'st',  r'\bavenue\b': 'ave',    r'\bboulevard\b': 'blvd',
    r'\bdrive\b':  'dr',  r'\broad\b':   'rd',      r'\blane\b':      'ln',
    r'\bcourt\b':  'ct',  r'\bplace\b':  'pl',      r'\bway\b':       'way',
    r'\bcircle\b': 'cir', r'\bterrace\b':'ter',     r'\btrail\b':     'trl',
    r'\bparkway\b':'pkwy',r'\bhighway\b':'hwy',
}

def normalise(addr):
    if not addr:
        return ''
    s = addr.lower().strip()
    s = re.sub(r'\b(apt|unit|suite|ste|#)\s*[\w-]+', '', s)
    for pat, rep in ABBREV.items():
        s = re.sub(pat, rep, s)
    s = re.sub(r'[^\w\s]', '', s)
    return re.sub(r'\s+', ' ', s).strip()

def addr_key(addr):
    """(street_number, first_word_of_street_name) for fuzzy matching."""
    parts = normalise(addr).split()
    if len(parts) >= 2:
        return (parts[0], parts[1])
    return (parts[0] if parts else '', '')

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true',
                        help='Preview matches, no DB writes')
    parser.add_argument('--city',
                        help='Only process one city, e.g. "Austin, TX"')
    parser.add_argument('--past-days', type=int, default=365,
                        help='How far back to search on Realtor.com (default 365)')
    parser.add_argument('--input', default=INPUT_FILE,
                        help=f'Path to properties JSON (default {INPUT_FILE})')
    parser.add_argument('--start-idx', type=int, default=0,
                        help='Start from this city index (0-based, for batching)')
    parser.add_argument('--end-idx', type=int, default=None,
                        help='Stop before this city index (exclusive, for batching)')
    args = parser.parse_args()

    if not os.path.exists(args.input):
        sys.exit(
            f'Input file not found: {args.input}\n'
            'Generate it first by running the prep step in code_execution.'
        )

    with open(args.input) as f:
        rows = json.load(f)
    print(f'Loaded {len(rows)} properties from {args.input}')

    # Group by city+state
    from collections import defaultdict
    by_city = defaultdict(list)
    for r in rows:
        by_city[(r['city'], r['state'])].append(r)

    if args.city:
        parts = [p.strip() for p in args.city.split(',')]
        if len(parts) == 2:
            filter_key = (parts[0], parts[1])
            by_city = {k: v for k, v in by_city.items() if k == filter_key}
            if not by_city:
                sys.exit(f'City not found in input: {args.city}')
        else:
            sys.exit('--city format: "City, ST"  e.g. "Austin, TX"')

    all_cities = sorted(by_city.items())
    start = args.start_idx
    end   = args.end_idx if args.end_idx is not None else len(all_cities)
    batch = all_cities[start:end]
    total_cities = len(batch)
    print(f'Processing cities {start+1}–{start+total_cities} of {len(all_cities)} total')

    matched_total = 0
    updated_total = 0
    failed_updates = []

    for idx, ((city, state), props) in enumerate(batch, start + 1):
        location = f'{city}, {state}'
        print(f'\n[{idx}/{total_cities}] {location} — {len(props)} properties')

        # Build lookup: addr_key → property record
        lookup = {}
        for p in props:
            k = addr_key(p['address'])
            if k in lookup:
                # duplicate key — keep both under a list to avoid false matches
                existing = lookup[k]
                if isinstance(existing, list):
                    existing.append(p)
                else:
                    lookup[k] = [existing, p]
            else:
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

        if listings is None or len(listings) == 0:
            print('  No results returned')
            time.sleep(1)
            continue

        matched_in_city = 0

        for _, row in listings.iterrows():
            _sa = row.get('street', '')
            raw_addr = '' if _sa is None or str(_sa) in ('', '<NA>', 'nan', 'None') else str(_sa)
            if not raw_addr:
                continue
            k = addr_key(raw_addr)
            prop = lookup.get(k)
            if prop is None:
                continue
            # Skip ambiguous duplicates
            if isinstance(prop, list):
                continue

            list_date = row.get('list_date', None)
            if list_date is None or str(list_date) in ('NaT', 'None', ''):
                continue

            try:
                date_str = (list_date.date().isoformat()
                            if hasattr(list_date, 'date')
                            else str(list_date)[:10])
            except Exception:
                continue

            print(f'  MATCH  {prop["address"]} -> listed {date_str}')
            matched_in_city += 1
            matched_total += 1
            del lookup[k]  # prevent double-match

            if not args.dry_run:
                try:
                    patch_property(prop['id'], date_str)
                    updated_total += 1
                except Exception as e:
                    print(f'  ERROR patching {prop["id"]}: {e}')
                    failed_updates.append(prop['id'])

        print(f'  Matched {matched_in_city}/{len(props)}', end='')
        if not args.dry_run and matched_in_city:
            print(f'  |  Updated {matched_in_city} rows', end='')
        print()

        time.sleep(1.5)  # be polite to Realtor.com

    print(f'\n{"="*60}')
    print(f'Cities searched : {total_cities}')
    print(f'Properties matched: {matched_total}')
    if not args.dry_run:
        print(f'DB rows updated : {updated_total}')
        if failed_updates:
            print(f'Failed updates  : {len(failed_updates)}')
            for fid in failed_updates:
                print(f'  {fid}')
    else:
        print('[dry-run] No DB writes made.')

if __name__ == '__main__':
    main()
