#!/usr/bin/env python3
"""Probe CJ Properties Rent Manager API for multi-photo extraction options."""
import re
import sys
import requests

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    "Referer": "https://cjproperties.org/unit-detail?unitID=1624",
}

urls_to_try = [
    # Standard search results (known to work)
    "https://cjre.ua.rentmanager.com/search_result?command=search_result&corpid=cjre&locations=Results,CJ Real Estate&fromsearch=fromsearch&mode=javaScript&template=searchresults&unituserdef_Allow_on_websitene=no&maxperpage=9999&headerfooter=false",
    # Detail view
    "https://cjre.ua.rentmanager.com/search_result?command=Detail_View.aspx&corpid=cjre&unitid=1624&rmwebsvc_id=1624&rmwebsvc_command=Detail_View.aspx&rmwebsvc_corpid=cjre&rmwebsvc_location=1&rmwebsvc_mode=javaScript&rmwebsvc_template=searchresults",
    # Direct unit endpoint
    "https://cjre.ua.rentmanager.com/?unitid=1624",
    # API endpoint with unit ID
    "https://cjre.ua.rentmanager.com/search_result?command=search_result&corpid=cjre&unitid=1624&fromsearch=fromsearch&mode=javaScript&template=searchresults&unituserdef_Allow_on_websitene=no&maxperpage=9999&headerfooter=false",
    # Rent Manager API v1
    "https://cjre.ua.rentmanager.com/api/units/1624",
    # Rent Manager API v2
    "https://cjre.ua.rentmanager.com/api/v1/units/1624",
    # Photo endpoint
    "https://cjre.ua.rentmanager.com/files/get/?EID=cjre&FKey=Zm1tNU1wRGhmYkU9STBCUnB2d2dQQmxZZU1Id0FNZlJSdz09aTVmSUxT",
]

for i, url in enumerate(urls_to_try):
    try:
        r = requests.get(url, headers=headers, timeout=30)
        print(f"URL {i+1}: {url[:100]}")
        print(f"  Status={r.status_code}, Size={len(r.text)}")
        if r.status_code == 200 and r.text:
            # Count photo URLs
            photos = re.findall(
                r'https://rm12filereader\.rentmanager\.com/files/get/\?EID=cjre&FKey=[^"\\\s]+',
                r.text,
            )
            print(f"  Photo URLs: {len(photos)}")
            if photos:
                for p in photos[:5]:
                    print(f"    {p[:120]}")
            # Also look for image tags
            img_tags = re.findall(r'<img[^>]+src=["\']([^"\']+)["\']', r.text)
            if img_tags:
                print(f"  IMG tags: {len(img_tags)}")
                for src in img_tags[:5]:
                    print(f"    {src[:120]}")
        print()
    except Exception as e:
        print(f"URL {i+1}: {url[:100]}")
        print(f"  ERROR: {str(e)[:100]}")
        print()