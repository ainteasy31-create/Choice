# Choice Properties — Ongoing Scrape Preferences

Every scrape run for this project must follow these market targets and content
rules. Run the scraper with the commands listed under each market.

---

## Active Markets

### Market 3 — Dallas, GA (West Paulding County / West Cobb / I-75 Corridor)

| Criteria | Value |
|---|---|
| Locations | Dallas, GA · Hiram, GA · Powder Springs, GA · Acworth, GA + Kennesaw, Marietta, Austell, Smyrna, Villa Rica (fallback) |
| Property types | Houses (SINGLE_FAMILY), Townhouses (TOWNHOMES) — NO apartments, condos, duplexes |
| Bedrooms | 3 exactly |
| Bathrooms | 2+ |
| Scraped rent range | $1,250–$1,500 / month |
| Published rent cap | $1,250 / month (tiered proportional reduction — see batch script) |
| Security deposit | Equal to published rent |
| Goal | 15 published listings per batch |

**Tiered pricing (this market):**

| Original rent | Published rent range |
|---|---|
| $1,250 | $1,250 (as-is) |
| $1,251–$1,299 | $1,200–$1,250 (proportional) |
| $1,300–$1,349 | $1,175–$1,225 (proportional) |
| $1,350–$1,399 | $1,150–$1,200 (proportional) |
| $1,400–$1,449 | $1,150–$1,200 (proportional) |
| $1,450–$1,500 | $1,200–$1,250, cap $1,250 (proportional) |

**Batch script (runs the full scrape → filter → price → publish → photo import pipeline):**
```bash
cd /home/runner/workspace
python3 scraper/dallas_ga_batch.py
# Options:
#   --dry-run          preview without writing to DB
#   --target 15        number of listings to publish (default 15)
#   --past-days 90     lookback window (default 90)
#   --min-score 30     minimum data quality score (default 30)
```

---

### Market 1 — Milwaukee / Menomonee Falls, WI

| Criteria | Value |
|---|---|
| Locations | Downtown Milwaukee, WI · Menomonee Falls, WI |
| Bedrooms | 1–2 |
| Max rent | $1,200 / month |
| Preferred | Utilities included |
| Pet policy | Must allow cats (1 cat) |
| Features | Updated kitchen & appliances, good closet space |
| Neighborhood | Safe, quiet; close to grocery & pharmacy |

**Scraper command:**
```bash
cd /home/runner/workspace
scraper/venv/bin/python scraper/scraper.py \
  --location "Milwaukee, WI" \
  --location "Menomonee Falls, WI" \
  --beds-min 1 --beds-max 2 \
  --price-max 1200 \
  --source realtor \
  --past-days 14 \
  --min-score 40
```

---

### Market 2 — Memphis, TN

| Criteria | Value |
|---|---|
| Locations | Memphis, TN + surrounding area |
| Bedrooms | 2 |
| Bathrooms | 2 |
| Max rent | $1,350 / month |

**Scraper command:**
```bash
cd /home/runner/workspace
scraper/venv/bin/python scraper/scraper.py \
  --location "Memphis, TN" \
  --location "Germantown, TN" \
  --location "Bartlett, TN" \
  --location "Collierville, TN" \
  --beds-min 2 --beds-max 2 \
  --price-max 1350 \
  --source realtor \
  --past-days 14 \
  --min-score 40
```

---

## Content Rules (apply to every scrape, always)

These rules are enforced automatically by `enrichment.py`. They are documented
here so any future code changes maintain the same standards.

### 1. Listing — drop entire listing if branded by a competitor
If a listing's text metadata (agent name, broker name, description, showing
instructions, or the raw MLS data blob) contains a known competitor brand
(e.g. FirstKey Homes, Invitation Homes, Progress Residential, Coldwell Banker,
Keller Williams, RE/MAX, etc.) the **entire listing is dropped** and never
enters the pipeline. This is a text/metadata heuristic — not a per-photo
analysis — so it catches corporate-managed properties reliably before any
photos are fetched.
→ Enforced by `is_watermarked()` in `enrichment.py`.

### 2. Photo — remove branded individual photos, keep the rest
If a listing has mostly clean property photos but one or more photos show
company logos, agent headshots, office exteriors, or brokerage branding, those
**specific photos are removed** while the rest of the listing is kept.
→ Enforced by `filter_record_photos()` / `filter_branded_photos()` in `enrichment.py`.

### 3. Description — remove all "schedule a tour" / "contact for viewing" language
Any sentence asking the reader to schedule a showing, contact an agent, call,
email, or arrange a viewing must be stripped from the description. This includes
all variants: "Book a tour", "Contact us for more info", "Schedule a private
showing", "Call today", "Reach out to schedule", etc.
→ Enforced by `clean_description()` in `enrichment.py`.

### 4. Description — every listing must end with an "Apply Now" CTA
Every published description must end with an invitation to submit a rental
application through Choice Properties. The CTA is appended automatically if
one is not already present.
→ Enforced by `append_apply_cta()` in `enrichment.py`.

### 5. Photo — never publish properties where all photos carry initials/watermarks
Same as rule 1, restated for clarity: if every photo has an agent initial, a
brokerage watermark, or a competitor logo overlaid, skip the listing entirely.

### 6. Photo — minimum 6 photos required per listing
Any listing with fewer than 6 source photos is dropped during filter and
rejected by the pre-publish validation gate. Sparse galleries (1–5 photos)
look poor on the property detail page and reduce conversion.
→ Enforced in `filter_records()` and `validate()` in every batch script,
  and in `validate_for_publish()` in `enrichment.py`.

### 7. Photo quality — Realtor CDN images are upgraded to maximum resolution
When scraping from Realtor.com, photo URLs are upgraded to `w-2016,q-95`
(the CDN's maximum quality tier) rather than stripped to the bare URL.
This avoids the default CDN resolution (often 1024px) and ensures every
scraped photo arrives at 2016px wide / 95% quality before ImageKit
re-encodes it.
→ Enforced by `_upgrade_photo_url()` in `scraper.py`.

---

## How to Run

```bash
# 1. Activate the venv (installed in scraper/venv/)
cd /home/runner/workspace

# 2. Run Market 1
scraper/venv/bin/python scraper/scraper.py \
  --location "Milwaukee, WI" --location "Menomonee Falls, WI" \
  --beds-min 1 --beds-max 2 --price-max 1200 --source realtor

# 3. Run Market 2
scraper/venv/bin/python scraper/scraper.py \
  --location "Memphis, TN" --location "Germantown, TN" \
  --location "Bartlett, TN" --location "Collierville, TN" \
  --beds-min 2 --beds-max 2 --price-max 1350 --source realtor

# 4. Open the admin pipeline to review and publish
#    https://choice-properties-site.pages.dev/admin/pipeline.html
```

> **Note:** The Zillow scraper requires a residential IP and cannot run from
> Replit. Use Realtor.com (--source realtor) for Replit-based scraping.
> For Zillow, run from an iPhone using the iSH Shell as documented in replit.md.
