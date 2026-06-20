---
name: Audit log pattern
description: How to correctly write admin_actions audit log entries in this codebase.
---

## Rule
Use `CP.Auth.getSession()` to get `userId` — never `CP.sb().auth.getUser().then(...)`. Insert to `admin_actions` non-blocking inside its own `try/catch`. For batch operations include `source: 'bulk'` in metadata.

**Why:** `auth.getUser()` makes a network round-trip every call. `getSession()` reads from the local token cache. Using `getUser().then()` inside a `Promise.all` map means N extra network calls per batch. The `.then()` chaining pattern also loses the result if the outer try/catch swallows errors before the insert fires.

**How to apply:**
```js
let userId = null;
try {
  const session = await window.CP.Auth.getSession();
  userId = session?.user?.id || null;
} catch (_) {}

// inside per-item logic:
try {
  if (userId) {
    await window.CP.sb().from('admin_actions').insert({
      action:      'property.status_change',
      target_type: 'property',
      target_id:   id,
      metadata:    { from: oldStatus, to: newStatus, source: 'bulk' },
      user_id:     userId,
    });
  }
} catch (_) {}
```

Known action keys (add new ones here as they are introduced):
- `property.edit`
- `property.status_change`
- `property.hard_delete`
- `property.photo_delete`
- `property.photo_reorder`
- `property.featured_change`
