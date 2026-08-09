# Orion Extension — Quick Install (v2.2.1)

## ⚠️ Root cause: the old `-fixed.zip` was broken

If the extension **wouldn't install**, it was because the old `chrome-extension-orion-fixed.zip` was **catastrophically broken** — it contained only **3 files** (3,047 bytes total):

| File in old broken zip | Problem |
|---|---|
| `manifest.json` (v2.1.0) | No `background` service_worker, no `action`, no `icons`, only `storage` permission, **no `shared-extractors.js` listed in content_scripts** |
| `content.js` (v2.1, older) | Zillow-only inline extractor, secret passed via URL query param |
| `config.js` (58 bytes) | Just a comment |

**Why it failed:**

1. **`shared-extractors.js` missing** → `window.CP_Extractors` was never defined → extraction returned `null` → **zero results**
2. **`background.js` missing** → service worker never started → **manifest validation failure**
3. **`icons/` missing** → manifest referenced files that didn't exist → **manifest validation failure**
4. **`popup.html` / `popup.js` missing** → `default_popup` pointed to a non-existent file → **manifest validation failure**
5. **No `m.zillow.com/*` matches** → content script wouldn't inject on mobile Zillow

## ⚠️ Root cause #2: "Network error" when saving

After fixing the zip (extension installs), clicking "Save to Pipeline" returned **"Network error"**. The cause was a **CORS mismatch**:

- The `receive-pipeline-import` Edge Function only allowed `chrome-extension://` origins
- Orion on iOS (WebKit-based) sends `Origin: null` from content script `fetch()` calls — WebKit does this when the extension context origin can't be determined
- `null` origin was **not** in the allowlist → server echoed back the production domain → browser CORS check failed → `fetch()` threw → **"Network error"**

**Fix applied (v2.2.1):**
1. **CORS** (`supabase/functions/_shared/cors.ts`): Added a **permissive CORS path** for the `receive-pipeline-import` function that echoes back any Origin (including `null`), since auth is via shared secret, not cookies. Also added `orion-extension://` and `moz-extension://` to the strict allowlist.
2. **content.js**: Added a **5-second timeout** on `chrome.runtime.sendMessage` (Orion's WebKit may not start the MV3 service worker). If it times out, falls back to a direct `fetch()` with the secret in the URL query parameter (avoids the custom `x-import-secret` header that can fail CORS preflight on WebKit).
3. **Edge Function** (`receive-pipeline-import/index.ts`): Now uses the permissive CORS functions.

## Ready-to-use package

The portable extension package is ready:
- **`chrome-extension-orion.zip`** in the project root (`c:\Users\HP\Choice\`)

This archive is built with standard forward-slash paths for iPhone/Orion. It contains all 17 files including `shared-extractors.js`, `background.js`, icons, popup, etc.

> 💻 **On your computer** (to verify the zip is correct): it should be ~23 KB with 17 entries. If it's only ~3 KB with 3 files, it's the old broken version.

### Quick download (release)

You can also download the packaged ZIP directly from the GitHub release:

- **https://github.com/choice121/Choice/releases/tag/v2.2.1-orion**

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

- **"Error loading manifest file"**: delete the old extracted folder, download the current `chrome-extension-orion.zip`, and select the folder that **contains** `manifest.json` directly
- **"Cannot load extension"**: make sure you selected the folder that **contains** `manifest.json`, not a parent folder
- **Button doesn't appear**: reload the listing page; make sure the extension toggle is ON in Settings → Extensions. Also verify you're on a Zillow listing detail page (`zillow.com/homedetails/...`), not the search results page
- **"Network error"** (after successful save attempt): this means the Edge Function CORS blocked the request. The v2.2.1 update fixes this — make sure you're using the latest zip. If it persists, check Orion console for `[CP]` logs under Settings → Developer → Console
- **"Could not read listing"**: the Zillow page's `__NEXT_DATA__` wasn't found — try scrolling down to let the page fully load, then click the button again
- **"Unsupported page"**: you're not on a supported listing detail page

## Notes

- The ZIP is built from `chrome-extension/` and includes all Orion/mobile fixes (v2.2.1 manifest with background service worker, icons, shared-extractors, popup, mobile URL matches).
- Rebuild it with a ZIP tool that writes portable `/` paths; do not use Windows `Compress-Archive` alone, which can miss the `icons/` subdirectory.
- The Edge Function `receive-pipeline-import` uses permissive CORS (echoes any Origin) because it authenticates via a shared secret, not user cookies. This is safe because the secret is embedded in the extension code.
