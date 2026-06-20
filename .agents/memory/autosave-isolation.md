---
name: Autosave isolation
description: Draft autosave in property-detail.js must use sessionStorage, not localStorage.
---

## Rule
Use `sessionStorage` for `pd_draft_{propId}` autosave keys in the admin property edit panel.

**Why:** `localStorage` is shared across all tabs for the same origin. Two admin tabs editing the same property would overwrite each other's drafts, causing one tab to restore the other's stale snapshot silently. `sessionStorage` is per-tab, so each tab has its own independent draft.

**How to apply:** Any `localStorage.setItem/getItem/removeItem` call using the `pd_draft_*` key must use `sessionStorage` instead. All three call sites (write interval, restore on open, clear on save) must use the same storage type.
