# Orion Extension — Quick Install

## ⚠️ Root cause: the old `-fixed.zip` was broken

If the extension **wouldn't install** or showed **"Save to Pipeline" but returned zero results**, it was because the old `chrome-extension-orion-fixed.zip` was **catastrophically broken** — it contained only **3 files** (3,047 bytes total):

| File in old broken zip | Problem |
|---|---|
| `manifest.json` (v2.1.0) | No `background` service_worker, no `action`, no `icons`, only `storage` permission, **no `shared-extractors.js` listed in content_scripts** |
| `content.js` (v2.1, older) | Zillow-only inline extractor, secret passed via URL query param |
| `config.js` (58 bytes) | Just a comment |

**Why it failed:**

1. **`shared-extractors.js` missing** → `window.CP_Extractors` was never defined → extraction returned `null` → **zero results**
2. **`background.js` missing** → service worker never started → **extension fails to install**
3. **`icons/` missing** → manifest referenced files that didn't exist → **manifest validation failure**
4. **`popup.html` / `popup.js` missing** → `default_popup` pointed to a non-existent file → **manifest validation failure**
5. **No `m.zillow.com/*` matches** → content script wouldn't inject on mobile Zillow

This has been fixed — the zip is now rebuilt from the actual `chrome-extension/` directory with **all 17 files** and the correct **v2.2.0 manifest**.

## Ready-to-use package

The portable extension package is ready:
- **`chrome-extension-orion.zip`** in the project root (`c:\Users\HP\Choice\`)

This archive is built with standard forward-slash paths for iPhone/Orion. It contains all 17 files including `shared-extractors.js`, `background.js`, icons, popup, etc.

Do **not** use older `chrome-extension-orion-fixed.zip` or Windows-created copies — use `chrome-extension-orion.zip` instead.

> 💻 **On your computer** (to verify the zip is correct): it should be ~23 KB with 17 entries. If it's only ~3 KB with 3 files, it's the old broken version.

### Quick download (release)

You can also download the packaged ZIP directly from the GitHub release:

- **https://github.com/choice121/Choice/releases/tag/v2.2.0-orion-test**

Use this on your iPhone: download the ZIP from the release, extract in Files, then load the extracted folder in Orion's Developer → Load Unpacked.

---

## Install on iPhone (3 steps)

1. **Send the ZIP to your iPhone**
   - Easiest: email it to yourself, or use AirDrop / iCloud Drive / Google Drive.
   - On iPhone, download and open the ZIP — iOS extracts it to a folder.

2. **Load in Orion**
   - Open Orion → Settings (gear icon) → Extensions
   - Turn ON **Developer Mode**
   - Tap **"Load Unpacked Extension"** or **"Add Extension"**
   - Select the extracted folder whose contents show `manifest.json` directly inside it

3. **Verify it works**
   - Open any Zillow listing detail page: `https://www.zillow.com/homedetails/...`
   - Wait 2-3 seconds for the page to fully load
   - You should see a **purple "Save to Pipeline"** button in the bottom-right corner
   - Tap it → button turns green: "Saved! N photos"

---

## What to do if it fails

- **"Error loading manifest file"**: delete the old extracted folder and download the current `chrome-extension-orion.zip` again; select the folder that contains `manifest.json` directly
- **"Cannot load extension"**: make sure you selected the folder that **contains** `manifest.json`, not a parent folder
- **Button doesn't appear**: reload the listing page; make sure the extension toggle is ON in Settings → Extensions
- **Check Orion console**: Settings → Developer → Console → look for `[CP]` logs
- **"Network error"**: the extension is already fixed — this should not happen. Check Orion console for `[CP]` logs under Settings → Developer → Console

## Notes

- The ZIP is built from `chrome-extension/` and includes all Orion/mobile fixes (v2.2.0 manifest with background service worker, icons, shared-extractors, popup, mobile URL matches).
- Rebuild it with a ZIP tool that writes portable `/` paths; do not use Windows `Compress-Archive` alone, which can miss the `icons/` subdirectory.
