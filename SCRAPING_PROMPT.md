# Choice Properties — AI Scraping Prompt Template

Use this file as the template when asking any AI assistant to run a scraping job on this project.
Copy the block below, fill in your criteria, and paste it to the AI.

---

## How to Use

1. Open this project in Replit
2. Copy the prompt block below
3. Fill in your property requirements
4. Paste it to the AI assistant

---

## The Prompt (copy from here)

```
# Choice Properties Scraper Prompt

## Source & Scraping Engine
- Use the HomeHarvest pipeline in this project to scrape rental property data from Realtor.com
- Read replit.md first — it explains the full project and the correct scraping method
- The correct entry point is scraper/pipeline.py via a city batch script (see scraper/PIPELINE_USAGE.md)
- All credentials are already in scraper/.env — no setup needed
- Follow all platform rules in scraper/PLATFORM_RULES.md automatically (enforced by pipeline.py)
- Never invent or estimate missing property information

## Property Requirements
**Location(s):** [City, State — include surrounding areas if applicable]
**Bedrooms:** [e.g. 2 exactly / 1–2 / 3+]
**Bathrooms:** [e.g. 1 or more / 2+]
**Property Type:** [Houses and single-family homes ONLY / Single-family + Townhomes / etc.]
**Monthly Budget:** [$X,XXX – $X,XXX]
**Quantity:** [10 properties]
**Additional Preferences:** [None specified / any special notes]

## Price Rules
**Scraping Range:** $[min] to $[max] (scrape strictly within this range)
**Published Budget:** $[max] maximum (never exceed)
**Price Adjustment Logic:**
- Scrape listings ONLY within the range above
- Do NOT scrape properties above the maximum
- Only publish properties at or below the maximum
- Security deposit = 1 month's rent (standardized)
- Description price must match published price
- Never leave conflicting prices anywhere

## Steps to Execute
1. Install dependencies: pip install homeharvest requests pillow
2. Check if a batch script already exists for this city in scraper/ — if yes, run it with updated args
3. If no batch script exists, create scraper/<city>_batch.py following the template in scraper/PIPELINE_USAGE.md
4. Run: python3 scraper/<city>_batch.py --target [quantity] --past-days 90
5. If fewer than target are published, try --past-days 120 or add more fallback locations
6. Return the live published URLs as a numbered list

## Output Format
After scraping, return ONLY the live published property URLs as a numbered list:

1. https://choice-properties-site.pages.dev/rent/[state]/[city]/[beds]br-[type]-[id]/ — [Full Address], [Beds]bd · $[Price]/mo

Example:
1. https://choice-properties-site.pages.dev/rent/oh/columbus/3br-single-family-64a3944d-63d6-421d-9772-fdc6f58dbe34/ — 4900 Kresge Dr, Columbus OH · 3bd · $2,195/mo

Do not include explanations or summaries.
```

---

## What the Pipeline Does Automatically

You do NOT need to specify these in your prompt — the pipeline handles them:

| Rule | Enforced by |
|---|---|
| Watermarked/branded listings rejected | `enrichment.py` |
| Competitor-branded photos filtered | `enrichment.py` |
| Minimum 6 photos required | `pipeline.py` |
| All photos uploaded to ImageKit | `imagekit_upload.py` |
| Descriptions cleaned of tour/showing/agent language | `enrichment.py` |
| External portal links removed (TurboTenant, Zillow, etc.) | `enrichment.py` |
| Application fee standardized to $50 | `enrichment.py` |
| Pets allowed = Yes (always) | `enrichment.py` |
| "Choice Properties" replaces agent/manager names | `enrichment.py` |
| Apply CTA appended to every description | `enrichment.py` |
| Security deposit = published rent | `enrichment.py` |
| Duplicate detection (address + source ID) | `pipeline.py` |
| Pre-publish validation gate | `enrichment.py` |

---

## Credentials Location

All credentials are already in `scraper/.env` — committed to this repo. No secrets needed from you.

| Credential | Where |
|---|---|
| Supabase URL + service role key | `scraper/.env` |
| ImageKit private key + endpoint | `scraper/.env` |
| Public/anon keys | `chrome-extension/config.js` |

---

## Important Notes for AI Assistants

- **This is NOT a Chrome extension project.** The `chrome-extension/` folder is a secondary tool — ignore it for scraping jobs.
- **Do NOT use `scraper/scraper.py` as a standalone entry point** for new city batches. It is called internally by `pipeline.py`.
- **Realtor.com only from Replit.** Zillow requires a residential IP and cannot run from Replit's servers.
- **Do not invent missing data.** If a field is missing, leave it blank or skip the property.
- **The live site is on Cloudflare Pages** (https://choice-properties-site.pages.dev) — Replit only runs the scraper.
- **`main.py` at the root is unused.** Ignore it.
- **Root `manifest.json` is the Chrome extension manifest.** Ignore it for scraping.

## Enrichment Rules — Quick Reference

**Read `scraper/RULES.md`** for a full scannable table of what is and isn't allowed.
**Read `scraper/enrichment.py` lines 1–60** for the AI quick-reference block embedded at the top.

The short version — these are enforced automatically, but you should know them:

| Always strip from descriptions | Always enforce |
|---|---|
| Tour / showing / "schedule a viewing" | Application fee = $50 |
| TurboTenant / portal application links | Security deposit = 1× rent |
| Agent / owner / manager names | Pets allowed = Yes |
| Brokerage / MLS branding | ≥ 6 photos per listing |
| Corporate fee schedules | Photos on ImageKit only |
| Wrong application fee amounts | Apply CTA at end of description |

**Competitor brands = drop the ENTIRE listing** (not just strip): FirstKey, Invitation Homes, Progress Residential, Tricon, Coldwell Banker, Keller Williams, RE/MAX, Century 21, Berkshire Hathaway, Main Street Renewal, AMH.
