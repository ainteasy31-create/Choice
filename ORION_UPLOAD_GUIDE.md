# Orion Extension — Quick Install (Fixed)

## ⚠️ What was broken (and why it didn't install)

The previous `chrome-extension-orion-fixed.zip` was **catastrophically broken** — it contained only **3 files** (3,047 bytes total):

| File in old broken zip | Problem |
|---|---|
| `manifest.json` (v2.1.0) | Stripped-down manifest: **no `background` service_worker, no `action`, no `icons`, only `storage` permission, no `shared-extractors.js` in content_scripts** |
| `content.js` (v2.1, older) | Zillow-only extractor (inline, not using shared-extractors.js), secret passed via URL query param |
| `config.js` (58 bytes) | Just a comment — config inlined |

**What was MISSING (causing install failure + zero results):**

1. **`background.js`** — The manifest referenced a service worker, but the file wasn't in the zip → Orion cannot start the extension → **fails to install**
2. **`shared-extractors.js`** — The extraction logic was not in the zip, AND the stripped-down v2.1 manifest didn't even list it in `content_scripts.js` → `window.CP_Extractors` was undefined → **zero results when extracting**
3. **`icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`** — Referenced by the manifest but not in the zip → **manifest validation failure**
4. **`popup.html` / `popup.js`** — Referenced as `default_popup` but not in the zip → **manifest validation failure**
5. **`content.css`** — Not included (minor, since styles are inlined in content.js)

### The v2.1 manifest inside the broken zip had these critical omissions:

```json
{
  "version": "2.1.0",
  "permissions": ["storage"],                        // ← MISSING: tabs, downloads, alarms
  "content_scripts": [{
    "js": ["config.js", "content.js"],             // ← MISSING: shared-extractors.js
    "matches": ["https://www.zillow.com/homedetails/*"]  // ← MISSING: m.zillow.com (mobile!)
  }]
  // ← MISSING: "background": { "service_worker": "background.js" }
  // ← MISSING: "action": { ... }
  // ← MISSING: "icons": { ... }
}
```

## ✅ What's fixed now

The rebuilt `chrome-extension-orion-fixed.zip` (23,487 bytes) now contains **all 17 files** from the `chrome-extension/` directory with the correct **v2.2.0 manifest**:

```
background.js          (5,596 bytes)   ← service worker for offline queue + messaging
config.js                 (58 bytes)    ← Orion compatibility shim
content.css             (4,720 bytes)   ← button styles
content.js              (3,982 bytes)   ← v2.2 content script (uses CP_Extractors)
manifest.json           (1,398 bytes)   ← v2.2.0 manifest (full MV3)
shared-extractors.js     (24,494 bytes)  ← ALL extractors: Zillow, Realtor, Apartments, Redfin
popup.html                 (8,312 bytes)  ← extension popup UI
popup.js                  (4,041 bytes)  ← popup logic
icons/icon16.png              (116 bytes)
icons/icon32.png              (176 bytes)
icons/icon48.png              (219 bytes)
icons/icon128.png             (497 bytes)
[plus dev/test files: generate-icons.js, README.md, test-extractors.js]
```

---

## Ready-to-use package

**`chrome-extension-orion-fixed.zip`** in your project root (`c:\Users\HP\Choice\`) — now properly packaged with all 17 files.

## Install on iPhone (3 steps)

### Step 1 — Send the ZIP to your iPhone
- **Easiest:** Email the `chrome-extension-orion-fixed.zip` to yourself, or AirDrop it.
- On iPhone, download the ZIP → iOS auto-unzips to a folder.
- **Important:** Use the folder that **contains** `manifest.json` (not a parent folder).

### Step 2 — Load in Orion
1. Open **Orion** → tap **Settings** (gear icon) → **Extensions**
2. Toggle **Developer Mode** ON
3. Tap **Load Unpacked Extension**
4. Navigate to and select the unzipped `chrome-extension` folder (the one containing `manifest.json`)
5. The extension should load immediately

### Step 3 — Verify it works
1. Open any Zillow listing detail page: `https://www.zillow.com/homedetails/...`
2. Wait 2-3 seconds for the page to fully load
3. You should see a **purple "Save to Pipeline"** button in the bottom-right corner
4. Tap it → button turns green: "Saved! N photos"

---

## What to do if it fails

### "Cannot load extension" / "Invalid manifest"
- Make sure you selected the folder that **contains** `manifest.json` (not the parent or a subfolder).
- If the zip has a folder prefix (e.g., `chrome-extension/manifest.json`), select the `chrome-extension` folder inside.
- Check that all 17 files are present in the unzipped folder.

### Button doesn't appear
1. **Reload the listing page** — content script runs at `document_idle`; a refresh ensures it injects.
2. **Check the URL** — must be a listing detail page (`/homedetails/`), not a search results page.
3. **Check mobile vs desktop:** Orion may render `m.zillow.com` (mobile). The manifest now matches both `www.zillow.com/homedetails/*` AND `m.zillow.com/homedetails/*`.
4. **Check Orion console:** Settings → Developer → Console → look for `[CP]` error logs.
5. **Make sure the extension toggle is ON** in Settings → Extensions.

### "Could not read listing" / "Unsupported page"
- This means `__NEXT_DATA__` (the embedded JSON Zillow uses) wasn't found. Try:
  - Reload the page fully (wait for all content to render)
  - Try a different Zillow listing
  - Make sure JavaScript is enabled in Orion (it is by default)

### "Server error" or "Network error"
- Check internet connection.
- The Edge Function at `tlfmwetmhthpyrytrcfo.supabase.co` accepts Chrome extension origins via CORS. This was already fixed.
- Check Orion console for CORS errors. If you see CORS issues, the origin may need to be re-allowed.

### "Already in pipeline"
- This listing was already saved. No action needed.

---

## Notes

- The ZIP is built from `chrome-extension/` and includes all Orion/mobile fixes.
- **Rebuild command** (from project root, if you need to update later):
  ```powershell
  python -c "import zipfile,os; zf=zipfile.ZipFile('chrome-extension-orion-fixed.zip','w',zipfile.ZIP_DEFLATED); [zf.write(os.path.join(r,f),os.path.relpath(os.path.join(r,f),'chrome-extension')) for r,d,fs in os.walk('chrome-extension') for f in fs]; zf.close()"
  ```
  Or simpler:
  ```bash
  cd chrome-extension && powershell Compress-Archive -Path * -DestinationPath "..\chrome-extension-orion-fixed.zip" -Force
  ```
  > ✅ Make sure `Compress-Archive` includes the `icons/` subdirectory! Use `-Recurse` or the Python approach above to guarantee all files (including `icons/`) are included.