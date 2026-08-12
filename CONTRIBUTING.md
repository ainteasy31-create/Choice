# Contributing to Choice Properties

Welcome! This project is set up for **open collaboration** — any user or AI that forks this repository should be able to work **end-to-end** with **no restrictions or manual credential setup**.

## How It Works for Forks

When you fork this repo:

1. **You already have everything you need.** The public Supabase URL + anon key + write secret are committed in `credentials-config.js` at the repo root.
2. **Load credentials automatically** — the `credentials_config` table in Supabase is **publicly readable**, so you can pull all credentials instantly:

   ```bash
   npm install
   npm run load-credentials
   ```

   This creates `.env.local` with all API credentials (Supabase URL, anon key, service role key, API token, GitHub token).

3. **Work end-to-end** — build, run the scraper pipeline, use the Chrome extension, deploy edge functions, etc. No credential prompts.

4. **Push your changes back** — open a PR to the main repo. The **auto-merge workflow** (`.github/workflows/auto-merge-forks.yml`) will automatically merge your PR into `main` once checks pass (assuming the repo owner has enabled it via the `AUTO_MERGE_ENABLED` secret).

## Getting Started (5 minutes)

```bash
# 1. Clone your fork
git clone https://github.com/YOUR_USERNAME/Choice
cd Choice

# 2. Install deps
npm install

# 3. Pull all credentials instantly (no manual entry)
npm run load-credentials

# 4. Start working
npm run build
```

That's it. No manual credential entry, no waiting for approvals.

## Quick Commands

| Command | What it does |
|---|---|
| `npm run load-credentials` | Pulls ALL credentials into `.env.local` |
| `npm run setup-credentials` | Opens the form to store/update credentials (one-time setup with write secret) |
| `npm run build` | Builds the site (generates config) |
| `npm run dev` | Starts local dev server |

## The Credentials Model

- **Read:** Public — anyone can fetch `credentials_config` with the anon key.
- **Write:** Gated by a **shared write secret** (committed in `credentials-config.js`) that all forks share. Anyone with the repo can update credentials — intentional for open collaboration.
- **Security note:** Because credentials are publicly readable, **do NOT store truly private secrets** in `credentials_config` (beyond what the site already shares publicly). For real secrets, use GitHub Secrets on the main repo.

## Auto-Merge of Fork PRs

To let fork PRs auto-merge into main, the **repo owner** must:
1. Go to Settings → Secrets and variables → Actions.
2. Add a repository secret `AUTO_MERGE_ENABLED` = `true`.

Once enabled, any PR from a fork (that doesn't touch protected paths like `supabase/migrations/`, `apply/`) will auto-merge via squash after CI passes.

## File Layout Overview

| Path | Purpose |
|---|---|
| `credentials-config.js` | Shared public config + write secret (committed) |
| `scraper/` | Python scraping pipeline (main tool) |
| `supabase/functions/` | Edge Functions |
| `supabase/migrations/` | Database migrations |
| `chrome-extension/` | Browser extension |
| `admin/` | Admin panel HTML |
| `docs/` | Documentation |

## Need Help?

Read `docs/CREDENTIALS_SETUP.md` for the full credential setup guide, or `docs/AI_COMMANDS.md` for AI-assistable pipeline commands.

Happy building!