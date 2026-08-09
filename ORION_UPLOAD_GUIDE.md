# Orion Extension — Quick Install

## Ready-to-use package
The fixed extension is already packaged for you:
- **`chrome-extension-orion.zip`** in your project root (`c:\Users\HP\Choice\`)

## Install on iPhone (3 steps)

1. **Send the ZIP to your iPhone**
   - Easiest: email it to yourself, or use AirDrop / iCloud Drive / Google Drive.
   - On iPhone, download and open the ZIP — iOS auto-unzips to a folder named `chrome-extension`.

2. **Load in Orion**
   - Open Orion → Settings (gear icon) → Extensions
   - Turn ON **Developer Mode**
   - Tap **"Load Unpacked Extension"** or **"Add Extension"**
   - Select the unzipped `chrome-extension` folder (the one that contains `manifest.json`)

3. **Verify it works**
   - Open any Zillow listing detail page on Orion
   - You should see a purple **"Save to Pipeline"** button appear
   - Tap it — it saves directly to your admin pipeline

## What to do if it fails
- **"Cannot load extension"**: make sure you selected the folder that **contains** `manifest.json`, not a parent folder
- **Button doesn't appear**: reload the listing page; make sure the extension toggle is ON
- **"Network error"**: the extension is already fixed — this should not happen. Check Orion console for `[CP]` logs under Settings → Developer → Console

## Notes
- The ZIP is built from `chrome-extension/` and includes the latest Orion/mobile fixes.
- If you need to rebuild it later: `powershell Compress-Archive -Path "chrome-extension\*" -DestinationPath "chrome-extension-orion.zip" -Force`
