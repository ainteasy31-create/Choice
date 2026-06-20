---
name: Bulk action pattern
description: The established pattern for bulk property operations in listings.js.
---

## Rule
All bulk operations in `listings.js` follow this sequence: confirm → resolve session once → `Promise.all` with per-item old-value lookup from `pageProperties` → audit log each success → clear selection → re-render.

**Why:** Resolving session inside the map would make N auth calls. Reading `pageProperties` before the update captures the pre-change value for the audit `from` field. Confirming before disabling the button prevents accidental double-submits. Re-rendering after clears stale card state (badges, featured overlays).

**How to apply:**
```js
async function _bulkDoSomething(value) {
  const ids = [..._adminSelected];
  if (!ids.length) return;

  const confirmed = window.confirm(`Do X to ${ids.length} properties?`);
  if (!confirmed) return;

  const btn = document.getElementById('bulkXBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  let userId = null;
  try { userId = (await window.CP.Auth.getSession())?.user?.id || null; } catch (_) {}

  let ok = 0, fail = 0;
  await Promise.all(ids.map(async id => {
    try {
      const oldVal = pageProperties.find(p => String(p.id) === String(id))?.field ?? null;
      const res = await window.CP.Properties.update(id, { field: value });
      if (res && res.ok !== false) {
        ok++;
        try {
          if (userId) await window.CP.sb().from('admin_actions').insert({ ... });
        } catch (_) {}
      } else { fail++; }
    } catch { fail++; }
  }));

  if (btn) { btn.disabled = false; btn.textContent = 'Original label'; }
  window.showToast?.(ok + ' updated' + (fail ? ', ' + fail + ' failed' : ''), fail ? 'error' : 'success');
  _adminSelected.clear();
  _updateBulkBar();
  document.querySelectorAll('[data-admin-id]').forEach(c => { c.checked = false; });
  await fetchAndRender();
}
```
