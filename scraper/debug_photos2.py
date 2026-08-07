#!/usr/bin/env python3
"""Probe additional Rent Manager endpoints for multi-photo extraction."""
import re
import sys
import requests

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    "Referer": "https://cjproperties.org/unit-detail?unitID=1624",
}

urls_to_try = [
    # Try different templates for detail view
    "https://cjre.ua.rentmanager.com/search_result?command=Detail_View.aspx&corpid=cjre&unitid=1624&rmwebsvc_id=1624&rmwebsvc_command=Detail_View.aspx&rmwebsvc_corpid=cjre&rmwebsvc_location=1&rmwebsvc_mode=javaScript&rmwebsvc_template=unitdetail",
    # Try unitdetail template
    "https://cjre.ua.rentmanager.com/search_result?command=Detail_View.aspx&corpid=cjre&unitid=1624&rmwebsvc_id=1624&rmwebsvc_command=Detail_View.aspx&rmwebsvc_corpid=cjre&rmwebsvc_location=1&rmwebsvc_mode=javaScript&rmwebsvc_template=unitdetail&template=unitdetail",
    # Try UADL01 template
    "https://cjre.ua.rentmanager.com/search_result?command=Detail_View.aspx&corpid=cjre&unitid=1624&rmwebsvc_id=1624&rmwebsvc_command=Detail_View.aspx&rmwebsvc_corpid=cjre&rmwebsvc_location=1&rmwebsvc_mode=javaScript&rmwebsvc_template=UADL01",
    # Try search_results with photos template
    "https://cjre.ua.rentmanager.com/search_result?command=search_result&corpid=cjre&locations=Results,CJ Real Estate&fromsearch=fromsearch&mode=javaScript&template=searchresults&unituserdef_Allow_on_websitene=no&maxperpage=9999&headerfooter=false&displayphotos=all",
    # Try FileReader with different FKey patterns
    "https://cjre.ua.rentmanager.com/files/get/?EID=cjre&FKey=1624",
    # Try FotoAlbum endpoint
    "https://cjre.ua.rentmanager.com/FotoAlbum?corpid=cjre&unitid=1624",
    # Try photo gallery endpoint
    "https://cjre.ua.rentmanager.com/PhotoGallery?corpid=cjre&unitid=1624",
    # Try search_result with unitdetail command
    "https://cjre.ua.rentmanager.com/unitdetail?corpid=cjre&unitid=1624",
    # Try with rmwebsvc params like website does
    "https://cjre.ua.rentmanager.com/search_result?rmwebsvc_command=Detail_View.aspx&rmwebsvc_corpid=cjre&rmwebsvc_unitid=1624&rmwebsvc_mode=javaScript&rmwebsvc_template=searchresults",
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
            print(f"  Photo URLs: {len(photos)}, IMG tags: {len(img_tags)}")
            if photos:
                for p in photos[:3]:
                    print(f"    {p[:120]}")
            if img_tags:
                for src in img_tags[:3]:
                    print(f"    IMG: {src[:120]}")
            if len(r.text) < 500:
                print(f"  Content: {r.text[:200]}")
        print()
    except Exception as e:
        print(f"URL {i+1}: {url[:120]}")
        print(f"  ERROR: {str(e)[:100]}")
        print()