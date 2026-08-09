# Orion Extension — Quick Install

## Ready-to-use package
The portable extension package is ready:
- **`chrome-extension-orion.zip`** in the project root

This archive is built with standard forward-slash paths for iPhone/Orion.
Do not use older `chrome-extension-orion-fixed.zip` or Windows-created copies.

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
   - Open any Zillow listing detail page on Orion
   - You should see a purple **"Save to Pipeline"** button appear
   - Tap it — it saves directly to your admin pipeline

## What to do if it fails
- **"Error loading manifest file"**: delete the old extracted folder and download the current `chrome-extension-orion.zip` again; select the folder that contains `manifest.json` directly
- **"Cannot load extension"**: make sure you selected the folder that contains `manifest.json`, not a parent folder
- **Button doesn't appear**: reload the listing page; make sure the extension toggle is ON
- **"Network error"**: the extension is already fixed — this should not happen. Check Orion console for `[CP]` logs under Settings → Developer → Console

## Notes
- The ZIP is built from `chrome-extension/` and includes the latest Orion/mobile fixes.
- Rebuild it with a ZIP tool that writes portable `/` paths; do not use Windows `Compress-Archive`, which can create backslash paths that Orion cannot resolve.

## Quick download (release)
If you want the packaged ZIP without browsing the repo, download the release asset I uploaded:

- https://github.com/approvalhub466-a11y/Choice/releases/tag/v2.2.0-orion-test

Use this on your iPhone: download the ZIP from the release, extract in Files, then load the extracted folder in Orion's Developer → Load Unpacked.
