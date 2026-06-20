---
name: Lease SELECT fields
description: Fields required in CP.Applications.getAll() SELECT for the lease generation form to pre-populate correctly.
---

## Rule
`rent_due_day_of_month` and `rent_proration_method` must be included in the `CP.Applications.getAll()` SELECT string (cp-api.js ~line 1002).

**Why:** The lease generation formSheet pre-populates fields from the `app` object returned by `findApp(id)`, which comes from `_rows` (the `getAll` result). If these columns are missing from the SELECT, the form always shows the hardcoded defaults (day=1, method='daily') even when the record has stored values, silently discarding previously-saved lease terms.

**How to apply:** Whenever adding a new application column that should appear in the lease form, also add it to the SELECT string in `CP.Applications.getAll()` in cp-api.js.
