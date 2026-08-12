# Credentials Setup — One-Time Configuration

## Overview

This project uses a **centralized credential management system** stored in Supabase. All API credentials are stored in a shared database table (`credentials_config`) that **any fork can read automatically** — no manual setup needed.

**Credentials stored:**
- ✅ Supabase Project URL
- ✅ Supabase Anon Key
- ✅ Supabase Service Role Key
- ✅ Supabase API Token
- ✅ GitHub Personal Access Token

## The Open Collaboration Model

This repo is designed so that **any user or AI that forks it can work end-to-end with zero restrictions**:

- **Reading credentials:** The `credentials_config` table is **publicly readable**. Any fork can run `npm run load-credentials` and instantly get all credentials into `.env.local` — no manual entry, no waiting.
- **Writing/updating credentials:** Gated by a **shared write secret** committed in `credentials-config.js` (repo root). Anyone with the repo can update the shared credentials — intentional for open collaboration.
- **Pushing changes:** Fork PRs can **auto-merge** into main via `.github/workflows/auto-merge-forks.yml` (enabled by the `AUTO_MERGE_ENABLED` repo secret).

## First-Time Setup (For the Repo Owner / When Credentials Change)

Normally forks don't need to do this — they just run `npm run load-credentials`. But to **store or update** the shared credentials, use the form:

### Step 1: Open the Setup Form

```bash
npm run setup-credentials
```

This starts a local server and opens `http://localhost:3000` in your browser.

### Step 2: Enter Your Credentials

The form asks for five values plus the write secret:

1. **Supabase Project URL** — Settings → API → Project URL
2. **Supabase Anon Key** — Settings → API → "anon public" key (safe to share)
3. **Supabase Service Role Key** — Settings → API → "service_role secret" (keep secret)
4. **Supabase API Token** — Settings → API → Personal Tokens (keep secret)
5. **GitHub Personal Access Token** — GitHub Settings → Developer settings → Tokens (classic), scopes: `repo`, `read:user` (keep secret)
6. **Write Secret** — found in `credentials-config.js` (the `WRITE_SECRET` value)

### Step 3: Submit

Click "Store Credentials Securely". The form sends the credentials (with the write secret) to the `store-credentials` Edge Function, which validates the secret and writes to `credentials_config`.

### Step 4: Close the Form

Press `Ctrl+C` in your terminal to stop the setup server.

## Using Credentials After Setup

### For Any Fork (All Developers & AIs)

```bash
npm run load-credentials
```

This **automatically**:
1. Connects to Supabase using the committed public URL + anon key (from `credentials-config.js`)
2. Fetches all stored credentials from the publicly-readable `credentials_config` table
3. Creates `.env.local` with all values
4. No manual input needed

### Direct CLI Storage (No Browser)

```bash
SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_API_TOKEN=... GITHUB_API_TOKEN=... npm run setup-direct
```

## Security Model

- **Read:** Public (`credentials_config` is readable by anon). This matches the open-collaboration goal.
- **Write:** Gated by the shared `WRITE_SECRET` (validated in the `store-credentials` Edge Function). Anyone with the repo knows it — intentional.
- **⚠️ Important:** Because credentials are publicly readable, **do NOT store truly private secrets** in `credentials_config` (beyond what the site already shares publicly). For genuinely sensitive secrets, use **GitHub Secrets** on the main repository.
- `.env.local` is `.gitignore`d (never committed).

## Architecture

```
Supabase Database
├── public.credentials_config  (PUBLICLY READABLE)
│   ├── SUPABASE_URL
│   ├── SUPABASE_ANON_KEY
│   ├── SUPABASE_SERVICE_ROLE_KEY
│   ├── SUPABASE_API_TOKEN
│   ├── GITHUB_API_TOKEN
│   └── WRITE_SECRET
│
├── Edge Function: store-credentials
│   └── Validates WRITE_SECRET → writes via service_role
│
└── RLS Policies
    ├── Public SELECT (anon)
    └── Service_role write only
```

Any fork → `npm run load-credentials` → reads shared table → automatic access.

## Enabling Auto-Merge for Fork PRs (Repo Owner)

1. Go to **Settings → Secrets and variables → Actions**.
2. Add a repository secret: `AUTO_MERGE_ENABLED` = `true`.
3. Fork PRs (not touching protected paths) auto-merge into main.

## Related Files

| File | Purpose |
|---|---|
| `credentials-config.js` | Shared public config + write secret (committed) |
| `setup-credentials.html` | The setup form UI |
| `scripts/open-setup.mjs` | Setup form server |
| `scripts/setup-credentials.mjs` | Load credentials script |
| `setup-direct.mjs` | Direct CLI credential storage |
| `supabase/functions/store-credentials/index.ts` | Backend store function |
| `supabase/migrations/20260812170000_credentials_open_read.sql` | Public-read migration |
| `CONTRIBUTING.md` | Fork onboarding guide |

## Troubleshooting

### `npm run load-credentials` fails
- Verify the migration `20260812170000_credentials_open_read.sql` has been applied (table must be publicly readable).
- Check you have network connectivity to Supabase.
- Check `.gitignore` includes `.env.local`.

### "Credentials stored securely" but nothing happens
- Refresh the page.
- Check browser console (F12) for errors.
- Verify the write secret matches `credentials-config.js`.

### Store fails with 403
- The `write_secret` doesn't match. Check `credentials-config.js` for the current `WRITE_SECRET`.

### Table doesn't exist
- Run the migration `supabase/migrations/20260812170000_credentials_open_read.sql` against your Supabase project, or use the `supabase-deploy.yml` workflow which applies migrations automatically.