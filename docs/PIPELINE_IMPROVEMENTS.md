# Pipeline Quality, Mobile & Cleanliness Improvement Plan

## 1. Why Scores Are Stuck at 78/100

Current score formula:
- **13 core fields** × 6 pts = 78 (address, city, state, zip, lat, lng, beds, baths, sqft, rent, type, description, available_date)
- **11 bonus fields** × 2 pts = 22 (county, neighborhood, year_built, parking, pets, deposit, amenities, appliances, heating, cooling, laundry)
- **Photos** ≥5 = 6 pts

**Problem:** Orion/Zillow imports get 72-78 because bonus fields are `null`. Zillow stores this data in `facts` arrays and `amenityCategories` that the current extractor doesn't parse.

### Diagnosed Gap (from your 4 Dallas listings)
- 4021 Adrian Dr: 78/100 (18 images, missing 1 core + all 11 bonus)
- 10069 Spice Ln: 78/100 (11 images)
- 5405 Worth St: 78/100 (21 images)
- 1021 Nomass St: 75/100 (1 image — blocked by 6-photo min)

---

## 2. Extractor Fixes (highest impact — could raise scores to 90+)

### 2a. Parse Zillow `attrMap.facts` array
Zillow's `__NEXT_DATA__` contains an `attrMap` object with named facts:
```json
"attrMap": {
  "Year built": "1955",
  "Heating": "Natural gas",
  "Cooling": "Central",
  "Parking": "Garage - Attached",
  "Lot Size": "6,534 sqft",
  "Property Type": "Single Family",
  "Appliances": "Dishwasher, Disposal, Microwave",
  "Laundry": "Washer/Dryer Hookups",
  "Basement": "Full, Finished",
  "Flooring": "Carpet, Hardwood"
}
```

Parse these into: `year_built`, `heating_type`, `cooling_type`, `parking`, `lot_size_sqft`, `appliances`, `laundry_type`, `has_basement`, `flooring`.

### 2b. Parse Zillow `amenityCategories`
Zillow provides a structured list of amenities:
```json
"amenityCategories": [
  { "category": "Interior Features", "amenities": ["Washer/Dryer Hookups", "Walk-In Closet"] },
  { "category": "Exterior", "amenities": ["Patio", "Fenced Yard"] },
  { "category": "Pets", "amenities": ["Cats OK", "Dogs OK"] }
]
```

Map to: `amenities`, `pets_allowed`, `pet_types_allowed`.

### 2c. Backup DOM scraping when `__NEXT_DATA__` lacks facts
Fall back to reading the `/listing-details/scroller` and fact-value HTML pairs on the page when the JSON is incomplete.

### 2d. Reverse-geocode fallback for county
If `county` is null but `lat`/`lng` exist, call Geoapify reverse geocode (same as admin panel already does) to fill `county` + `neighborhood` — adding +4 points.

---

## 3. Quality Score Improvements

| Change | Point Impact |
|--------|-------------|
| Parse Zillow facts/amenities | +22 (9 bonus fields × 2) |
| Photo dedup fix (Nomass case) | +3 |
| Reverse-geocode county | +2 |
| **Projected new max score** | **~96-100** |

### Score display
- Threshold for "Ready to publish" should stay at 80 — but with better extraction most listings will pass naturally
- Add a `quality_score_detail` JSON column so admins can see WHICH fields are dragging the score down in the UI

---

## 4. Mobile Optimization (pipeline admin)

| Change | Benefit |
|--------|---------|
| Folder sidebar collapses to a horizontal scroll row on mobile | Easier one-handed use |
| Cards already responsive (grid 1→2→3 cols) — keep as-is | Good |
| Bulk action bar already slides up — good for thumbs | Good |
| Add pull-to-refresh gesture | Native mobile feel |
| Increase touch target size to ≥44px for checkboxes/buttons | Accessibility |
| Panel is already a bottom sheet on mobile — keep | Good |

---

## 5. Pipeline Cleanliness & Optimization

### Automatic cleanup (add to migration + RPC)
1. **Auto-archive published listings** — after 30 days post-publish, move from `published` → `archived` (reduces "All" view clutter)
2. **Auto-archive failed listings** — `status='failed'` older than 7 days
3. **Reap zero-photo listings** — `status='scraped'` with `original_image_urls='[]'` older than 3 days → `archived`

### ImageKit storage optimization
- Already fixed: temp `/properties/PP-*` folders auto-deleted after publish
- Add `photo_cleanup_status` tracking (already in schema) — admin dashboard shows pending cleanups
- New RPC: `pipeline_cleanup_orphans()` finds pipeline records with no `choice_property_id` and no photos, archives them

### Folder system (already built)
- Use folders to segment work batches — after publish all, delete folder to archive
- This keeps the pipeline focused on what needs attention

---

## 6. Implementation Priority

| # | Task | Effort | Score Impact |
|---|------|--------|--------------|
| 1 | Parse Zillow `attrMap.facts` + `amenityCategories` | Medium | +22 pts (biggest win) |
| 2 | Backup DOM fact-value extraction | Medium | +4 (when JSON incomplete) |
| 3 | Reverse-geocode county/neighborhood | Small | +4 |
| 4 | Auto-archive cleanup RPCs | Small | cleanliness |
| 5 | Mobile folder row + touch targets | Small | UX |
| 6 | Quality detail column | Small | transparency |

---

## 7. Expected Results After Implementing #1-3

- **Typical Orion/Zillow import:** 90-96/100 (was 78)
- **All listings pass the 80 threshold** without manual edits
- **Fewer admin edits** — county, year_built, parking, pets, appliances, heating filled automatically
- **Faster publish turnaround** — less back-and-forth on missing fields