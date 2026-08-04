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

This is the part most people get wrong. Follow exactly:

1. Open the **Shortcuts** app
2. Tap **+** to create a new shortcut
3. Tap **Add Action**
4. Search for **Scriptable** (scroll down to apps or search)
5. Tap **Run Script**
6. In the "Run Script" action that appears:
   - **Script** → tap "Choose" → select **import-to-choice**
   - **Parameter** → tap the field → tap the blue **Shortcut Input** token (it must say "Shortcut Input", not a typed URL)
   - Leave everything else as-is
7. Tap the shortcut **name** at the very top of the screen → rename it:
   ```
   Import to Choice
   ```
8. Tap the **settings icon (ⓘ)** next to the name
9. Scroll to **Add to Share Sheet** → toggle it **ON**
10. Under **Share Sheet Types** → tap **+** and add:
    - ✅ **Safari web pages**
    - ✅ **URLs** (optional but helpful)
11. Tap **Done** → tap **Done** again

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

## Troubleshooting

### "Shortcut Setup Needed" alert appears
The Shortcut is not passing the URL to the script. Fix:
- Open Shortcuts → open "Import to Choice"
- In the "Run Script" action, check the **Parameter** field
- It must show the blue **Shortcut Input** token — if it's blank or shows typed text, tap it and select **Shortcut Input**

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
