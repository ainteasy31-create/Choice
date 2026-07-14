# Choice Properties — Permanent Platform Rules

**These rules are mandatory and apply to every scraper, publisher, and enrichment
step — current or future. They must never be bypassed without an explicit
administrator decision.**

---

## 1. Image Requirements (Highest Priority)

Every property **must** have all images uploaded to ImageKit before it can be
published.

- Download every original image from the source listing at the highest quality
  available.
- Upload every image to the Choice Properties ImageKit account.
- **Never** store external/hotlinked image URLs in the database.
- **Never** publish a property if ImageKit upload has not completed successfully.
- If ImageKit is unavailable or any upload fails:
  - Keep the property in the pipeline with status `pending_images`.
  - Log the reason for the failure.
  - Retry automatically when ImageKit becomes available.
- Preserve the original image order; use the first image as the featured image.
- Verify every ImageKit URL loads successfully after upload.

---

## 2. Description Enrichment

All the following rules run automatically via `apply_enrichment_pipeline()` in
`enrichment.py`. **Do not skip or bypass this pipeline.**

### 2a. Tour & Showing Language — REMOVE
Strip any phrasing that invites a visitor to schedule a tour or contact the
owner/agent, including but not limited to:

- "Schedule a tour / showing / viewing"
- "Book a tour / showing"
- "Request a viewing"
- "Tour today / now"
- "Open house"
- "Showing available"
- "Contact for viewing / showing"
- Equivalent rewordings detected by regex

### 2b. External Application Instructions — REMOVE
Remove any instruction that directs applicants to another platform:

- TurboTenant, Zillow, Apartments.com, Realtor.com, Homes.com, RentSpree, etc.
- "Copy Property ID", "Listing ID", "Property ID #XXXX"
- "Apply on [other site]"
- External application links or portal instructions

### 2c. Property Manager / Owner References — REMOVE / REPLACE
Remove personal agent/owner/management references. Replace public-facing
phrases with **Choice Properties** where appropriate:

- Property Manager, Leasing Office, Leasing Agent
- Contact Owner / Contact Landlord
- Management Company
- Call / Text / Email [agent name]

### 2d. Third-Party Branding — REMOVE
Strip brokerage names, MLS identifiers, and other platform branding from
descriptions.

---

## 3. Application Fee Normalization (Mandatory)

**Choice Properties charges a flat $50 application fee. No listing may ever
state or imply a different amount.**

### 3a. Explicit fee amounts — normalize to $50
Any mention of an application fee amount other than $50 in the description must
be replaced with "Application Fee: $50."

Examples that must be caught and corrected:

| Original wording | Corrected output |
|---|---|
| `$35 application fee` | `Application Fee: $50.` |
| `Application fee is 45` | `Application Fee: $50.` |
| `Fee: $60` | `Application Fee: $50.` |
| `40 dollars application fee` | `Application Fee: $50.` |

### 3b. Free-application language — replace with $50 statement
Any wording indicating the application is free or costs $0 must be replaced with
"Application Fee: $50." This includes but is not limited to:

| Phrase (and similar wordings) | Corrected output |
|---|---|
| `Free application` | `Application Fee: $50.` |
| `Apply for free` | `Application Fee: $50.` |
| `No application fee` | `Application Fee: $50.` |
| `Zero application fee` | `Application Fee: $50.` |
| `$0 application fee` | `Application Fee: $50.` |
| `Complimentary application` | `Application Fee: $50.` |
| `Free to apply` | `Application Fee: $50.` |
| `No fee to apply` | `Application Fee: $50.` |

---

## 4. Rent & Security Deposit Consistency

Every mention of rent or deposit in the description must match the property's
published `monthly_rent` and `security_deposit` fields. Conflicting amounts
are replaced by `enforce_price_consistency()` in the enrichment pipeline.

---

## 5. Pre-Publish Validation Gate

Before any property transitions from the pipeline to a live listing, it must
pass `validate_for_publish()` in `enrichment.py`. The check verifies:

- [ ] Images successfully uploaded to ImageKit
- [ ] No "free application" language in description
- [ ] No application fee other than $50 referenced in description
- [ ] No tour/showing/contact CTA language
- [ ] No external portal application instructions
- [ ] `monthly_rent` is set

A property that fails any check **must not be published**. Log all failures.

---

## 6. Structured Field Enforcement

The `application_fee` database field must always be `50`. This is enforced by
`rule_based_enrich()` in the enrichment pipeline (step 5, application fee floor).

---

## 7. Inheriting These Rules

Every new scraper or import script added to the project must call
`apply_enrichment_pipeline()` from `scraper/enrichment.py` before inserting
records into the pipeline. This single call enforces all rules above
automatically.

```python
from enrichment import apply_enrichment_pipeline, validate_for_publish

records, watermarked_count = apply_enrichment_pipeline(records, verbose=True)

# Optional: gate individual records before publish
ok, failures = validate_for_publish(record)
if not ok:
    print("Publish blocked:", failures)
```

---

*Last updated: 2026-07-14*
*These rules are enforced in: `scraper/enrichment.py` → `apply_enrichment_pipeline()`*
