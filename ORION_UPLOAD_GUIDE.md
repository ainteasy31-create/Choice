# How to Get the Chrome Extension onto Orion (iPhone)

## Overview
You need to get the `chrome-extension/` folder from your computer to your iPhone, then load it into Orion. Here are the easiest methods.

---

## Method 1: Zip + AirDrop (Easiest)

### Step 1: Create a ZIP of the extension folder

On your Windows PC:

1. Open File Explorer
2. Navigate to `c:\Users\HP\Choice`
3. Right-click on the **`chrome-extension`** folder
4. Select **Send to → Compressed (zipped) folder**
5. This creates `chrome-extension.zip`

### Step 2: Send the ZIP to your iPhone

**Option A: AirDrop (requires Mac)**
- If you have a Mac, AirDrop the ZIP to your iPhone

**Option B: Email**
- Email the ZIP to yourself
- Open the email on your iPhone
- Tap the attachment to download it

**Option C: iCloud Drive**
- Upload the ZIP to iCloud Drive from your PC (iCloud for Windows)
- Open Files app on iPhone → iCloud Drive → tap the ZIP

**Option D: Google Drive / Dropbox**
- Upload the ZIP to any cloud storage
- Open the app on iPhone → download the ZIP

### Step 3: Unzip on iPhone

1. Open the **Files** app on your iPhone
2. Find the downloaded `chrome-extension.zip`
3. Tap it — iOS will automatically unzip it
4. You'll now have a `chrome-extension` folder

---

## Method 2: Load Directly from URL (Orion Developer Mode)

### Step 1: Host the extension files

If you have the extension hosted somewhere (like GitHub), you can load it directly:

1. Push the `chrome-extension/` folder to GitHub
2. Get the raw file URLs

### Step 2: Load in Orion

1. Open Orion on your iPhone
2. Go to **Settings → Extensions**
3. Enable **Developer Mode** (toggle at bottom)
4. Tap **"Load Extension from URL"** or **"Add Extension"**
5. Enter the URL to your hosted `manifest.json`
6. Orion loads the extension

---

## Method 3: Use the ZIP file already in your project

You already have `chrome-extension-v2.0.0.zip` in your project folder. But **this may not have the latest Orion fix**. You should create a fresh ZIP using Method 1.

---

## Loading the Extension in Orion (After You Have the Folder)

### Step 1: Open Orion Settings

1. Open **Orion** on your iPhone
2. Tap the **gear icon** (Settings) in the bottom toolbar
3. Scroll down and tap **Extensions**

### Step 2: Enable Developer Mode

1. In Extensions settings, scroll to the bottom
2. Toggle **Developer Mode** ON

### Step 3: Load the Extension

1. Tap **"Load Unpacked Extension"** or **"Add Extension"**
2. Navigate to the `chrome-extension` folder you unzipped
3. Select the folder (make sure you select the folder that contains `manifest.json`)
4. Orion loads the extension

### Step 4: Verify It's Loaded

1. You should see "Import to Choice Properties" in your extensions list
2. Make sure the toggle is ON

---

## Testing

1. Open Orion and go to any Zillow listing: `https://www.zillow.com/homedetails/...`
2. Wait a few seconds for the purple **"Save to Pipeline"** button to appear
3. Tap it
4. It should show "Saving..." then "Saved! X photos · Q:XX"

---

## Troubleshooting

### "Cannot load extension" error
- Make sure you selected the folder that **contains** `manifest.json` (not the parent folder)
- Make sure the folder name doesn't have spaces or special characters
- Try renaming the folder to just `chrome-extension`

### Button doesn't appear on Zillow
- Make sure you're on a **listing detail page** (URL contains `/homedetails/`)
- Try reloading the page
- Check that the extension is enabled in Orion Settings → Extensions

### Still getting "Network error"
- Make sure you're using the **latest** `chrome-extension/` folder (with the Orion fix)
- The fix sends the secret as a query parameter instead of a header
- Check Orion's console for `[CP]` logs (Settings → Developer → Console)

---

## Quick Reference

| Item | Location |
|---|---|
| Correct extension folder | `c:\Users\HP\Choice\chrome-extension\` |
| Manifest file | `chrome-extension\manifest.json` |
| Main content script | `chrome-extension\content.js` |
| Config (URLs & secret) | `chrome-extension\config.js` |
| Edge Function (deployed) | `https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import` |