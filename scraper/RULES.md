# Choice Properties — Enrichment Rules Quick Reference

> **For AI assistants:** These rules are enforced automatically by `enrichment.py`
> via `apply_enrichment_pipeline()`. You do NOT need to implement them — just call
> the pipeline correctly (see `PIPELINE_USAGE.md`). This file is here so you know
> what is and isn't allowed in a published listing.

---

## 🚫 Things That Are NEVER Allowed on a Published Listing

| Rule | What to do |
|---|---|
| Tour / showing language | Strip: "Schedule a tour", "Book a showing", "Open house", "Contact for viewing" |
| External application portals | Strip: TurboTenant, Zillow application, Apartments.com application, RentSpree, AppFolio, Property ID references |
| Agent / owner / manager names | Strip: "Contact John Smith", "Managed by ABC Realty", "Leasing agent: Jane Doe" |
| Third-party brokerage branding | Strip: "Listed by Keller Williams", "MLS #12345", "Courtesy of RE/MAX" |
| Application fee ≠ $50 | Replace with "Application Fee: $50." — always, no exceptions |
| "Free application" / "$0 fee" | Replace with "Application Fee: $50." |
| Competitor brand in listing | Drop ENTIRE listing: FirstKey, Invitation Homes, Progress Residential, Tricon, Coldwell Banker, Keller Williams, RE/MAX, Century 21, Berkshire Hathaway, Main Street Renewal, AMH, eXp Realty |
| Fewer than 6 photos | Do NOT publish — minimum 6 source images required |
| External / hotlinked photo URLs | All photos MUST be on ImageKit before publishing |
| Conflicting rent in description | Description price must match published monthly_rent |
| Missing monthly_rent | Do NOT publish — rent is required |

---

## ✅ Things That Are ALWAYS Required

| Rule | What it looks like |
|---|---|
| Pets allowed = Yes | Every listing is published as pet-friendly |
| Security deposit = 1× rent | `security_deposit` = `monthly_rent` |
| Application fee = $50 | `application_fee` field = 50, description says "Application Fee: $50." |
| Apply CTA at end of description | Ends with "Apply now through Choice Properties…" or similar |
| All photos on ImageKit | `property_photos.url` = `https://ik.imagekit.io/21rg7lvzo/…` |
| Photos in original order | First photo = hero / featured image |

---

## ✅ What the Pipeline Does Automatically (You Don't Need to Implement These)

When you call `PipelineOrchestrator.run(criteria)`, the pipeline automatically:

1. Drops competitor-branded listings (watermark check)
2. Strips tour/showing/contact language from descriptions
3. Strips external portal application instructions
4. Strips agent/owner/broker name references
5. Strips third-party brokerage/MLS branding
6. Strips corporate fee schedules and marketing blocks (Mynd "RENT WITH MYND" block, Invitation Homes fee blocks, Progress Residential, Tricon)
7. Removes individual branded/agent photos from the image list
8. Normalizes HVAC fields from raw MLS blobs
9. Infers missing laundry, parking, pets, title, deposit from amenity tags
10. Fills missing available_date, lease term, deposit by scraping the listing page (Realtor only)
11. Enforces rent consistency between description text and `monthly_rent` field
12. Normalizes application fee to $50 in description text
13. Appends a "Apply now at Choice Properties" CTA to every description
14. Validates: photos ≥ 6, rent set, no banned language → blocks publish if any fail
15. Uploads all photos to ImageKit, verifies URLs, inserts into `property_photos`
16. Publishes, activates, and returns the live URL

---

## Property Type Allowed Values

| Use this string | Meaning |
|---|---|
| `"SINGLE_FAMILY"` | Houses / single-family homes |
| `"TOWNHOMES"` | Townhouses |
| `"APARTMENT"` | Apartments |
| `"CONDOS"` | Condos |
| `"MULTI_FAMILY"` | Multi-family units |

> For houses-only batches: `allowed_types = {"SINGLE_FAMILY"}`

---

## Scraping Source

- **Realtor.com via HomeHarvest** — works from Replit, no IP restriction
- **Zillow** — requires residential IP, does NOT work from Replit
- Always use `--source realtor` (the default) when running from Replit

---

## Credentials Location

All credentials are in `scraper/.env` — already committed, no setup needed.

```
SUPABASE_URL=https://tlfmwetmhthpyrytrcfo.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
IMAGEKIT_PRIVATE_KEY=...
IMAGEKIT_URL_ENDPOINT=https://ik.imagekit.io/21rg7lvzo
```

---

## The One Command That Runs Everything

```bash
python3 scraper/<city>_batch.py --target 10 --past-days 90
```

All 16 rules above are enforced automatically. You only define the city, bedrooms, bathrooms, rent range, and property type.
