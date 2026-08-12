# Credentials Setup — One-Time Configuration

## Overview

This project uses a **secure, centralized credential management system** stored in Supabase. All your API credentials (Supabase and GitHub) are stored once in a shared database table that all forks can access automatically.

**Credentials stored:**
- ✅ Supabase Project URL
- ✅ Supabase Anon Key
- ✅ Supabase Service Role Key
- ✅ Supabase API Token
- ✅ GitHub Personal Access Token

## Why This Approach?

- ✅ **One-time setup** — All 5 credentials entered once, never again
- ✅ **Secure** — Credentials never exposed in GitHub, commits, or environment files
- ✅ **Scalable** — Any new fork automatically has access to all credentials
- ✅ **Maintainable** — Update credentials in one place for all forks
- ✅ **Non-intrusive** — Works across different GitHub accounts
- ✅ **Complete** — Handles Supabase AND GitHub credentials

## First-Time Setup (One Time Only)

### Step 1: Open the Setup Form

Run this command to open an interactive form in your browser:

```bash
npm run setup-credentials
```

This will:
- Start a local server on `http://localhost:3000`
- Open the setup form in your default browser
- Display instructions

### Step 2: Enter Your Credentials

The form asks for five values from your services:

1. **Supabase Project URL**
   - Go to: Supabase Dashboard → Settings → API
   - Copy: "Project URL"
   - Example: `https://your-project.supabase.co`

2. **Supabase Anon Key**
   - Same location as above
   - Copy: "anon public" key (the shorter one)
   - It's safe to share this

3. **Supabase Service Role Key**
   - Same location as above
   - Copy: "service_role secret" key (the long one)
   - ⚠️ Keep this secret!

4. **Supabase API Token**
   - Go to: Supabase Dashboard → Settings → API → Personal Tokens
   - Click "Generate new token"
   - Give it a name (e.g., "Choice Credentials")
   - Copy the token
   - ⚠️ Keep this secret!

5. **GitHub Personal Access Token**
   - Go to: GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
   - Click "Generate new token (classic)"
   - Select scopes: `repo`, `read:user`
   - Copy the token
   - ⚠️ Keep this secret!

### Step 3: Submit

Click "Store Credentials Securely" and you'll see confirmation.

The form will:
- Encrypt your credentials
- Store them in Supabase `credentials_config` table
- Make them available to all forks

### Step 4: Close the Form

Once successful, press `Ctrl+C` in your terminal to stop the setup server.

---

## Using Credentials After Setup

### For Local Development

Load credentials into `.env.local`:

```bash
npm run load-credentials
```

This script:
- Connects to Supabase using your project URL and anon key
- Fetches stored credentials from the config table
- Creates `.env.local` with all values
- Works automatically — no manual input needed

### For GitHub Actions

Workflows can fetch credentials at runtime using the Supabase client with service role access.

---

## For New Forks

When you fork to a new GitHub account:

```bash
# Clone your fork
git clone https://github.com/yourname/Choice

# Install dependencies
npm install

# Create .env.local with credentials (automatic!)
npm run load-credentials

# Done! Start working
npm run build
```

**That's it.** No manual credential setup needed. All forks share the same centralized credentials.

---

## Updating Credentials

If your Supabase credentials change:

1. Run the setup form again:
   ```bash
   npm run setup-credentials
   ```

2. Enter the new values — they'll overwrite the old ones

3. All forks automatically use the updated credentials

---

## Security Notes

- ✅ Credentials stored in Supabase `credentials_config` table
- ✅ RLS policies prevent public access (service_role only)
- ✅ `.env.local` is `.gitignore`d (never committed)
- ✅ No credentials in GitHub Secrets or code
- ⚠️ Service Role Key has full database access — keep it secure
- ⚠️ Supabase API Token has admin access — keep it secure
- ⚠️ GitHub Token can access your repos — keep it secure
- ⚠️ Only trusted developers should access the setup form

---

## Troubleshooting

### Form won't open in browser
- Manually visit: `http://localhost:3000` in your phone/computer browser
- Make sure the command didn't exit

### "Credentials stored securely" but nothing happens
- Refresh the page
- Check browser console for errors
- Ensure you have network connectivity

### `npm run load-credentials` fails
- Verify Supabase URL and Anon Key are correct
- Check that `credentials_config` table exists (migration might need to run)
- Check `.gitignore` includes `.env.local`

### Different GitHub account shows old credentials
- All forks share the same `credentials_config` table (by design)
- Update credentials in the form to change them for everyone

---

## Architecture

```
Supabase Database
├── public.credentials_config (encrypted)
│   ├── SUPABASE_URL
│   ├── SUPABASE_ANON_KEY
│   ├── SUPABASE_SERVICE_ROLE_KEY
│   ├── SUPABASE_API_TOKEN
│   └── GITHUB_API_TOKEN
│
├── Supabase Edge Functions
│   └── store-credentials (secure write endpoint)
│
└── RLS Policies
    └── Service role only access
```

All forks → `npm run load-credentials` → reads from shared table → automatic access

---

## Related Commands

```bash
# Start credential setup form
npm run setup-credentials

# Load credentials into .env.local
npm run load-credentials

# View migration that created the config table
cat supabase/migrations/20260812150000_create_credentials_config.sql

# View Edge Function that stores credentials
cat supabase/functions/store-credentials/index.ts
```

---

## Questions?

Check:
- `setup-credentials.html` — The form UI
- `scripts/setup-credentials.mjs` — Load credentials script
- `scripts/open-setup.mjs` — Setup form server
- `supabase/functions/store-credentials/index.ts` — Backend function
