# Import to Choice Properties — Chrome Extension

One-click listing importer for Zillow, Realtor.com, Apartments.com, and Redfin.  
Sends listing data (all fields + photos) directly to the Choice Properties pipeline.

## Stack

- Pure Chrome Extension (Manifest V3) — no build step, no server
- Supabase Edge Function (`receive-pipeline-import`) receives imports
- ImageKit stores listing photos
- `chrome.storage.local` for offline queue; `chrome.storage.session` for session count

## Project Structure

```
chrome-extension/
  config.js           ← ALL credentials & endpoints live here (committed to git)
  manifest.json       ← Extension config — loads config.js first
  background.js       ← Service worker: posts to Edge Function, manages queue & badge
  content.js          ← Injected on listing pages: extracts data, renders Save button
  shared-extractors.js← Per-site extraction logic (Zillow, Realtor, Apartments, Redfin)
  content.css         ← Floating button styles
  popup.html/js       ← Toolbar popup: session count, queue status, settings
  generate-icons.js   ← One-time icon generator (Node.js, no deps)
  icons/              ← Generated PNG icons (16/32/48/128px)
CREDENTIALS.md        ← Full credential inventory + rotation guide
```

## Credentials

All extension credentials are in `chrome-extension/config.js` — committed and ready.  
No setup required for anyone cloning or importing the repo.

The **Supabase service role key** lives in Replit Secrets (`SUPABASE_SERVICE_ROLE_KEY`) — 
server-side only, never in extension code.

See `CREDENTIALS.md` for the full inventory, where to find each key, and how to rotate.

## Loading the Extension (Developer)

```bash
# One-time: generate icons
cd chrome-extension && node generate-icons.js

# Then load in Chrome:
# chrome://extensions → Enable Developer mode → Load unpacked → select chrome-extension/
```

To update after code changes: click ↺ refresh on the extension card in `chrome://extensions`.

## User Preferences

- Keep all credentials in `chrome-extension/config.js` — never scattered across files
- Service role key and ImageKit private key are server-side only (Replit Secrets / Edge Function env)
- Do not introduce a build step unless explicitly requested
- Maintain existing MV3 structure and per-file organization
