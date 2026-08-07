#!/usr/bin/env python3
"""Probe Rent Manager photo browsing endpoints."""
import re
import sys
import requests

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    "Referer": "https://cjproperties.org/unit-detail?unitID=1624",
}

urls_to_try = [
    # Try file browser / photo gallery endpoints
    "https://cjre.ua.rentmanager.com/Files/Browse?corpid=cjre&unitid=1624",
    "https://cjre.ua.rentmanager.com/Files?corpid=cjre&unitid=1624",
    "https://cjre.ua.rentmanager.com/files/browse/?corpid=cjre&unitid=1624",
    "https://cjre.ua.rentmanager.com/photo?corpid=cjre&unitid=1624",
    "https://cjre.ua.rentmanager.com/files/?EID=cjre&unitid=1624",
    # Try unit photo / unit photos endpoint
    "https://cjre.ua.rentmanager.com/unitphotos?corpid=cjre&unitid=1624",
    "https://cjre.ua.rentmanager.com/unit-photos?corpid=cjre&unitid=1624",
    # Try detail view with rmwebsvc params
    "https://cjre.ua.rentmanager.com/search_result?command=Detail_View.aspx&corpid=cjre&rmwebsvc_unitid=1624&rmwebsvc_id=1624&rmwebsvc_command=Detail_View.aspx&rmwebsvc_corpid=cjre&rmwebsvc_location=1&rmwebsvc_mode=javaScript&rmwebsvc_template=searchresults&rmwebsvc_AvailabilityDate=8/7/2026",
    # Try photo list
    "https://cjre.ua.rentmanager.com/files/list?corpid=cjre&unitid=1624",
    # Try files API
    "https://cjre.ua.rentmanager.com/api/files?corpid=cjre&unitid=1624",
    # Try WordPress uploads for this unit
    "https://cjproperties.org/wp-json/wp/v2/media?search=1624",
    # Check WordPress attachment
    "https://cjproperties.org/wp-json/wp/v2/media?parent=185",
]

for i, url in enumerate(urls_to_try):
    try:
        r = requests.get(url, headers=headers, timeout=30)
        print(f"URL {i+1}: {url[:120]}")
        print(f"  Status={r.status_code}, Size={len(r.text)}")
        if r.status_code == 200 and r.text:
            photos = re.findall(
                r'https://rm12filereader\.rentmanager\.com/files/get/\?EID=cjre&FKey=[^"\\\s]+',
                r.text,
            )
            img_tags = re.findall(r'<img[^>]+src=["\']([^"\']+)["\']', r.text)
            json_urls = re.findall(r'https?://[^"\\\s]+\.(?:jpg|jpeg|png|gif|webp)', r.text, re.IGNORECASE)
            print(f"  Photo URLs: {len(photos)}, IMG tags: {len(img_tags)}, JSON URLs: {len(json_urls)}")
            if photos:
                for p in photos[:3]:
                    print(f"    {p[:120]}")
            if img_tags:
                for src in img_tags[:5]:
                    print(f"    IMG: {src[:120]}")
            if json_urls:
                for u in json_urls[:5]:
                    print(f"    JSON: {u[:120]}")
            if len(r.text) < 300:
                print(f"  Content: {r.text[:200]}")
        print()
    except Exception as e:
        print(f"URL {i+1}: {url[:120]}")
        print(f"  ERROR: {str(e)[:100]}")
        print()