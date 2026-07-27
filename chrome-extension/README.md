# Import to Choice Properties — Chrome Extension

One-click Zillow → Pipeline importer. No server fetch, no IP blocking, all photos captured.

## How it works

When you open any Zillow listing detail page, the extension injects a purple **"Save to Pipeline"** button in the bottom-right corner. Click it and the listing — every field and every photo — is sent directly to your Choice Properties pipeline.

**Why it never gets blocked:** The extension reads `__NEXT_DATA__` directly from the already-loaded page (same data your browser is already displaying). No outbound fetch to Zillow, no datacenter IP, nothing to block.

---

## Install (takes ~30 seconds)

### Step 1 — Generate icons (one time only)

```bash
cd chrome-extension
node generate-icons.js
```

This creates `icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`.

### Step 2 — Load into Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `chrome-extension/` folder from this project
5. Done ✓

The extension icon appears in your Chrome toolbar.

### Step 3 — Use it

1. Browse to any Zillow listing detail page  
   *(URL pattern: `zillow.com/homedetails/…/12345_zpid`)*
2. Click the purple **↓ Save to Pipeline** button (bottom-right corner)
3. Button turns green: "✓ Saved! 24 photos · San Francisco · Q:88/100"
4. Open your [admin pipeline](https://choice-properties-site.pages.dev/admin/pipeline.html) to review and publish

---

## What gets captured

| Field | Source |
|---|---|
| Address, city, state, ZIP | `address` object |
| Lat / lng | `latitude`, `longitude` |
| Rent, deposit, fees | `price`, `resoFacts.*` |
| Beds, baths, sqft, lot, year built | Direct fields |
| Property type | `homeType` → normalized |
| Available date | `resoFacts.dateAvailable` |
| Description | `description` |
| Pets, smoking policy | `isPetFriendly`, `resoFacts.petsAllowed` |
| HVAC, laundry, parking | `resoFacts.heating/cooling/laundry/parking` |
| Appliances, amenities, utilities | `resoFacts.appliances/communityFeatures/…` |
| Walk / transit / bike scores | `walkScore`, `transitScore`, `bikeScore` |
| Virtual tour URL | `virtualTourUrl` |
| All photos (up to 50) | `responsivePhotosOriginalRatio` (full-res JPEG) |
| Agent / broker name | `attributionInfo` |

Photos are stored as source URLs and transferred to ImageKit automatically when you publish the listing from the pipeline.

---

## Updating

The extension lives in this repo under `chrome-extension/`. To update:

1. Edit `content.js` (extraction logic) or `content.css` (button style)
2. Go to `chrome://extensions` → click the **↺ refresh** icon on the extension card
3. Reload any open Zillow tabs

No reinstall needed for code changes — just refresh.

---

## Works on

- Chrome / Chromium (primary)
- Microsoft Edge (Chromium-based) — same install steps
- Brave, Arc, or any Chromium browser

---

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension config (MV3) |
| `content.js` | Injected on Zillow — extracts data + renders button |
| `content.css` | Floating button styles |
| `background.js` | Service worker — tracks session count, updates badge |
| `popup.html` / `popup.js` | Toolbar popup — shows session count, pipeline link |
| `generate-icons.js` | One-time icon generator (pure Node.js, no deps) |
| `icons/` | Generated PNG icons (16 / 32 / 48 / 128 px) |
