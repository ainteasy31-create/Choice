#!/usr/bin/env python3
"""Debug script to test the scraper's parsing logic."""
import sys, os, json, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cjproperties_scraper import (
    _extract_html_from_js, _extract_property_blocks, _extract_header,
    _extract_address, _extract_details, _extract_description,
    _extract_image_urls, _extract_unit_url, _unescape_js_string,
)

# Read the saved API response
with open(os.path.join(os.path.dirname(__file__), '..', 'artifacts', 'cjproperties-search-api-test.html'), 'r', encoding='utf-8') as f:
    js_text = f.read()

print("Raw response length:", len(js_text))
print("Starts with:", repr(js_text[:80]))
print()

# Test _unescape_js_string
unescaped = _unescape_js_string(js_text)
print("After unescape length:", len(unescaped))
print("After unescape starts with:", repr(unescaped[:80]))
print()

# Test _extract_html_from_js
html_content = _extract_html_from_js(js_text)
print("Extracted HTML length:", len(html_content))
print("Extracted HTML starts with:", repr(html_content[:120]))
print()

# Test _extract_property_blocks
blocks = _extract_property_blocks(html_content)
print("Found {} property blocks".format(len(blocks)))
print()

# Test extraction on first block
if blocks:
    block = blocks[0]
    print("First block unitid:", block["unitid"])
    print("First block HTML length:", len(block["html"]))
    print()

    header = _extract_header(block["html"])
    print("Header:", repr(header))

    address = _extract_address(block["html"])
    print("Address:", address)

    details = _extract_details(block["html"])
    print("Details:", details)

    description = _extract_description(block["html"])
    print("Description (first 200):", repr(description[:200]) if description else None)

    image_urls = _extract_image_urls(block["html"])
    print("Image URLs count:", len(image_urls))
    if image_urls:
        print("First image URL:", image_urls[0][:100])

    unit_url = _extract_unit_url(block["html"])
    print("Unit URL:", unit_url)
