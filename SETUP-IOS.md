# iPhone Setup — Import to Choice Properties

Save any Zillow listing to your pipeline with one tap from Safari. Takes about 3 minutes to set up.

---

## What you need

- iPhone with iOS 15 or later
- **Scriptable** (free) — [App Store link](https://apps.apple.com/app/scriptable/id1405459188)
- **Shortcuts** app (built into iOS — already on your phone)

---

## Step 1 — Install Scriptable

1. Open the App Store and search **Scriptable**
2. Install the free app by Simon Støvring
3. Open it once so it initialises — you can close it right after

---

## Step 2 — Add the script to Scriptable

1. On your iPhone, open Safari and go to:
   ```
   https://choice-properties-site.pages.dev/shortcuts/import-to-choice.js
   ```
2. The script code will appear on screen — that's fine, just **copy the entire URL** from the address bar
3. Open **Scriptable**
4. Tap **+** (top-right) to create a new script
5. Tap the script name at the top and rename it exactly:
   ```
   import-to-choice
   ```
   *(name must match exactly — no spaces, no capitals)*
6. Delete any placeholder text in the editor
7. Type this single line of code into the editor:
   ```javascript
   await importModule('https://choice-properties-site.pages.dev/shortcuts/import-to-choice.js').run();
   ```

   > **Easier alternative:** Instead of typing, open Safari, go to the URL above, select all the text, copy it, then paste it into the Scriptable editor. This gives you the full offline copy.

8. Tap **Done** (top-right)

---

## Step 3 — Create the iOS Shortcut

This is the part most people get wrong. Follow exactly — the Shortcut needs **4 actions** in this order:

1. Open the **Shortcuts** app
2. Tap **+** to create a new shortcut
3. Tap **Add Action** and add these 4 actions in order:

### Action 1 — Receive input
- Search: **Receive**
- Tap: **Receive [input] from Share Sheet**
- Set input types to include: **Safari web pages** and **URLs**
- "If there's no input" → **Continue**

### Action 2 — Extract the URL
- Tap **+** → search: **Get Details of Safari Web Page**
- Tap it → set the detail field to **URL**
- The input should be **Shortcut Input** (the magic variable from Action 1)

### Action 3 — Copy URL to clipboard
- Tap **+** → search: **Copy to Clipboard**
- Set the input to the **Safari Web Page URL** magic variable from Action 2

### Action 4 — Run the script
- Tap **+** → search: **Scriptable** → tap **Run Script**
- **Script** → select **import-to-choice**
- Leave **Parameter**, **URLs**, **Images**, **Files** all empty

4. Tap the shortcut **name** at the very top → rename it:
   ```
   Import to Choice
   ```
5. Tap the **settings icon (ⓘ)** next to the name
6. Scroll to **Add to Share Sheet** → toggle it **ON**
7. Under **Share Sheet Types** → make sure **Safari web pages** is listed
8. Tap **Done** → tap **Done** again

> **Why this works:** "Get Details of Safari Web Page → URL" correctly extracts the page URL from what Safari shares. Copying it to clipboard before running the script bypasses iOS type-conversion quirks — the script reads clipboard directly as its primary source.

---

## Step 4 — Test it

1. Open Safari and go to any Zillow listing detail page
   *(URL must contain `/homedetails/` — not a search results page)*
2. Tap the **Share button** (box with arrow, bottom centre of Safari)
3. Scroll down in the Share Sheet until you see **Import to Choice**
4. Tap it
5. Scriptable opens and runs automatically — you'll see a spinner then a success alert:
   ```
   ✓ Added to Pipeline
   123 Main St, Austin, TX · $1,800/mo · 24 photos captured
   ```
6. Open your [admin pipeline](https://choice-properties-site.pages.dev/admin/pipeline.html) to review the listing

---

## Quick verification checklist

Use this checklist after setup if the import fails on the first try:

1. The Scriptable script name must be exactly `import-to-choice`.
2. The Safari page URL must contain `/homedetails/` and show a real address and price.
3. The Shortcut must include these four actions in order: Receive input → Get Details of Safari Web Page → Copy to Clipboard → Run Script.
4. After tapping the shortcut, the Scriptable script should show either a success alert or a specific error message. If it says “No Data Returned”, wait a few seconds and try again on a fully loaded listing page.
5. If the import still fails, open the Safari page, scroll until the address and price are visible, then run the shortcut again.

## Optional: Verify-only test mode

If you want to confirm extraction without actually sending data to the pipeline, run the Scriptable script and choose the "Verify only" option when prompted. This will:

- Load the Zillow page and wait for hydration
- Inspect `__NEXT_DATA__`, `window.__NEXT_DATA__`, and any `script[type="application/json"]` blocks
- Report whether a `zpid` and key fields (address, price, photos) were found
- Show a small sample of the JSON the script inspected

Use this when setting up or debugging slow/blocked pages — it makes it easy to confirm that the Scriptable/WebView extraction will work before posting to the server.

## Troubleshooting

### "Shortcut Setup Needed" alert appears
The Shortcut is not correctly passing the URL. Rebuild it using the 4-action setup in Step 3:
1. **Receive input from Share Sheet** (Safari web pages)
2. **Get Details of Safari Web Page → URL**
3. **Copy to Clipboard** (the URL from step 2)
4. **Run Script → import-to-choice** (Parameter left empty)

The script reads the URL from clipboard — no parameter wiring needed.

### "Import to Choice" doesn't appear in the Share Sheet
- Open Shortcuts → open the shortcut → tap ⓘ
- Make sure **Add to Share Sheet** is toggled ON
- Make sure **Safari web pages** is listed under Share Sheet Types
- If it still doesn't appear: scroll further down in the Share Sheet and tap **Edit Actions** to pin it

### "Wrong Page" — not a listing detail page
Make sure the URL contains `/homedetails/`. Zillow search result pages won't work — tap any listing to open its detail page first.

### Script asks me to update
Tap **Run now** in the update alert. The script self-updates automatically — no reinstall needed.

### Nothing happens after tapping "Import to Choice"
Make sure Scriptable is installed. The shortcut can't run without it.

---

## After setup — how it works every time

1. Browse to a Zillow listing in Safari
2. Tap **Share → Import to Choice**
3. Done ✓ — listing is in your pipeline

The script auto-updates itself in the background. You'll only ever be asked to reinstall if the hosting URL changes (which it won't).

---

## Supported sites

| Site | Status |
|---|---|
| Zillow | ✅ Full support |
| Realtor.com | 🔜 Coming soon |
| Apartments.com | 🔜 Coming soon |
| Redfin | 🔜 Coming soon |
