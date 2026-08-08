# Orion Browser Testing Guide

## Prerequisites
- iPhone with iOS 15 or later
- Stable internet connection
- 10 minutes of time

---

## Step 1: Install Orion Browser

1. Open **App Store** on your iPhone
2. Search for **"Orion Browser"**
3. Tap **Get** → **Install**
4. Wait for download to complete
5. Open Orion from home screen

---

## Step 2: Enable Developer Mode

1. Open **Orion** app
2. Tap **Settings** (gear icon, bottom right)
3. Scroll down to **"Extensions"**
4. Toggle **"Developer Mode"** ON
5. You should see a new **"Developer"** section appear

---

## Step 3: Load the Extension

### Method A: From GitHub (RECOMMENDED)

1. On your iPhone, open **Safari**
2. Go to: `https://github.com/choice121/Choice`
3. Tap the **green "Code" button**
4. Tap **"Download ZIP"**
5. Once downloaded, tap the ZIP file to extract
6. Open **Files** app → find the extracted `Choice-main` folder
7. Long press the folder → **Share** → **Copy**
8. Switch back to **Orion**
9. Go to **Settings** → **Extensions** → **Developer**
10. Tap **"Load Extension"**
11. Long press in the file picker → **Paste**
12. Select the `chrome-extension` folder
13. Extension should load!

### Method B: Direct URL (if hosted)

1. In Orion, go to **Settings** → **Extensions** → **Developer**
2. Tap **"Load from URL"**
3. Enter: `https://choice121.github.io/Choice/chrome-extension/manifest.json`
4. Tap **Load**

---

## Step 4: Grant Permissions

1. After loading, you should see **"Import to Choice Properties"** in extensions list
2. Tap on it
3. Make sure these permissions are enabled:
   - ✅ **Storage** (for settings)
   - ✅ **Downloads** (for saving listings)
   - ✅ **Alarms** (for offline queue)
   - ✅ **Host permissions** for zillow.com, realtor.com, apartments.com, redfin.com

4. If any are disabled, toggle them ON

---

## Step 5: Test on Zillow

1. In **Orion**, go to **Zillow.com**
2. Navigate to any rental listing (e.g., `https://www.zillow.com/homedetails/...`)
3. Wait 2-3 seconds for page to fully load
4. Look for a **purple button** in the **bottom-right corner** that says **"Save to Pipeline"**

### Expected Behavior:
- ✅ Button appears automatically
- ✅ Button is purple with white text
- ✅ Button says "Save to Pipeline"
- ✅ Button is easy to tap (large enough)

### If Button Doesn't Appear:
1. Refresh the page
2. Check if you're on a `/homedetails/` URL (not search page)
3. Check Orion console for errors: Settings → Developer → Console
4. Make sure extension is enabled

---

## Step 6: Test Saving a Listing

1. Tap the **"Save to Pipeline"** button
2. Button should show **spinner** and say **"Saving..."**
3. After 2-3 seconds, button should turn **green** and say:
   - **"Saved! 15 photos · Q:85"** (or similar)
4. Button should then **shrink** to a small purple circle
5. Success! Listing is saved to your pipeline

### Expected Results:
- ✅ Button shows loading state
- ✅ Button shows success message with photo count and quality score
- ✅ Button auto-collapses after 4 seconds
- ✅ No errors in console

---

## Step 7: Verify in Admin Panel

1. Open **Safari** (or any browser)
2. Go to: `https://choice-properties-site.pages.dev/admin/pipeline.html`
3. Log in as admin
4. You should see the listing you just saved
5. Click on it to verify:
   - ✅ All fields are populated
   - ✅ Photos are visible
   - ✅ Quality score is displayed

---

## Troubleshooting

### Button Doesn't Appear
**Solution:**
- Make sure you're on a Zillow detail page (`/homedetails/`)
- Refresh the page
- Check extension is enabled in Orion settings
- Check console for errors

### Button is Too Small
**Solution:**
- This should be fixed in the latest version
- If still small, report back with screenshot

### "Server Error" When Saving
**Solution:**
- Check internet connection
- Make sure CORS is enabled (should be already)
- Check console for specific error message
- Try again

### Photos Don't Load
**Solution:**
- Photos may take a minute to transfer to ImageKit
- Check if listing shows "Retry photos" button
- Click retry if available

### Extension Keeps Reloading
**Solution:**
- Normal behavior for developer mode
- Should stabilize after first load
- If persists, report with console logs

---

## Reporting Issues

### What to Include:
1. **Device:** iPhone model (e.g., iPhone 13, iPhone 15 Pro)
2. **iOS Version:** Settings → General → About → Software Version
3. **Orion Version:** Settings → About Orion
4. **Zillow URL:** The listing you were testing
5. **Screenshot:** Of the issue
6. **Console Errors:** Settings → Developer → Console → Copy errors
7. **Steps to reproduce:** What you did

### Where to Report:
- Reply to this conversation with the above info
- I'll fix issues and push updates

---

## Success Criteria

You've successfully tested if:
- ✅ Button appears on Zillow pages
- ✅ Button is large enough to tap easily
- ✅ Listing saves without errors
- ✅ Photos are captured
- ✅ Listing appears in admin pipeline
- ✅ All fields are populated

---

## Next Steps After Testing

1. **If everything works:**
   - 🎉 You're done!
   - You can use Orion as your primary mobile browser
   - Extension will auto-update when I push changes

2. **If there are issues:**
   - Report them with details above
   - I'll fix and push updates
   - You reload extension and test again

3. **If you want PWA too:**
   - PWA is already available at `choice-properties-site.pages.dev/import`
   - Can use both Orion (extension) and Safari (PWA)
   - Maximum flexibility

---

## Tips for Daily Use

### Making Orion Your Default Browser:
1. Open **Settings** on iPhone
2. Scroll down → **Safari**
3. Tap **Default Browser**
4. Select **Orion**

### Quick Access to Zillow:
1. In Orion, go to Zillow.com
2. Tap **Share** → **Add to Home Screen**
3. Now you have a Zillow app icon

### Extension Auto-Updates:
- When I push updates to GitHub
- Go to Orion → Settings → Extensions
- Tap **"Reload All"** to get latest version

---

**Ready to test?** Install Orion and follow these steps. Let me know the results!