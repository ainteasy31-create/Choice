# Credentials & Configuration — Import to Choice Properties

All credentials for this project live in **`chrome-extension/config.js`**.  
That file is committed to the repository and travels with the project everywhere.  
Anyone cloning or importing the repo gets full working credentials automatically.

---

## Credential Inventory

### Supabase

| Key | Where it lives | Notes |
|---|---|---|
| Project URL | `config.js → SUPABASE_URL` | `https://tlfmwetmhthpyrytrcfo.supabase.co` |
| Anon key | `config.js → SUPABASE_ANON_KEY` | Public/safe to commit. Protected by RLS. |
| Import secret | `config.js → IMPORT_SECRET` | Sent as `x-import-secret` header to Edge Function. Must match Edge Function env var. |
| **Service role key** | **Replit Secrets → `SUPABASE_SERVICE_ROLE_KEY`** | ⚠️ Server-side ONLY. Never put in extension JS. Bypasses all RLS. |

**Where to find Supabase keys:**  
Supabase Dashboard → Project Settings → API → Project API keys

---

### ImageKit

| Key | Where it lives | Notes |
|---|---|---|
| URL Endpoint | `config.js → IMAGEKIT_URL_ENDPOINT` | `https://ik.imagekit.io/21rg7lvzo` |
| Public key | `config.js → IMAGEKIT_PUBLIC_KEY` | Safe to commit. Used for client-side upload auth. |
| **Private key** | **Never in extension** | If needed for signed uploads, must live in the Edge Function env only. |

**Where to find ImageKit keys:**  
ImageKit Dashboard → Developer Options → API Keys

---

## How to Rotate a Credential

1. Generate the new key/secret in the relevant dashboard (Supabase, ImageKit, etc.)
2. Open `chrome-extension/config.js` and update the value
3. If rotating `IMPORT_SECRET`: also update it in Supabase → Edge Functions → `receive-pipeline-import` → Secrets → `IMPORT_SECRET`
4. If rotating the service role key: update it in Replit Secrets → `SUPABASE_SERVICE_ROLE_KEY`
5. Go to `chrome://extensions` → click ↺ refresh on the extension card
6. Reload any open listing tabs

---

## What NOT to Add Here

- `service_role` key → Replit Secrets only (server-side)
- ImageKit private key → Edge Function env only (server-side)
- Any credential that grants unrestricted database/storage write access

---

## New Developer Setup

1. Clone / import the repo
2. Run `cd chrome-extension && node generate-icons.js` (one-time, generates PNG icons)
3. Open Chrome → `chrome://extensions` → Enable Developer mode → Load unpacked → select `chrome-extension/`
4. Done — all credentials are already in `config.js`, nothing extra to configure

For server-side work (Replit scripts, Edge Functions): ask the project owner for the `SUPABASE_SERVICE_ROLE_KEY`.
