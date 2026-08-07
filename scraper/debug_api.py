#!/usr/bin/env python3
"""Debug script to test the Rent Manager API call."""
import requests, os, sys

url = 'https://cjre.ua.rentmanager.com/search_result'
params = {
    'command': 'search_result',
    'corpid': 'cjre',
    'locations': 'Results,CJ Real Estate',
    'fromsearch': 'fromsearch',
    'mode': 'javaScript',
    'template': 'searchresults',
    'unituserdef_Allow_on_websitene': 'no',
    'maxperpage': '9999',
    'headerfooter': 'false'
}
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://cjproperties.org/properties/',
    'Connection': 'keep-alive',
}

print("Making API request...")
sys.stdout.flush()
r = requests.get(url, params=params, headers=headers, timeout=30)
print('Status:', r.status_code)
print('Size:', len(r.text), 'bytes')
print('Content-Type:', r.headers.get('Content-Type', 'unknown'))

# Save the response with UTF-8 encoding
outpath = os.path.join(os.path.dirname(__file__), '..', 'artifacts', 'cjproperties-search-api-test.html')
with open(outpath, 'w', encoding='utf-8') as f:
    f.write(r.text)
print('Saved to', outpath)

# Show first 2000 chars
print("\n--- First 2000 chars ---")
print(r.text[:2000])
print("\n--- Last 1000 chars ---")
print(r.text[-1000:])
