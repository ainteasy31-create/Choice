// ============================================================
// Import to Choice Properties — Content Script v2.2
// Orion-optimized: uses shared-extractors.js (loaded via manifest),
// routes saves through the background worker so the offline queue works.
// ============================================================
(function () {
  'use strict';

  const EDGE_URL = 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
  const SECRET   = 'cp_import_7Kx3m9P2w5';

  if (document.getElementById('cp-save-btn')) return;

  // ── Inject button ───────────────────────────────────────────
  const btn = document.createElement('button');
  btn.id = 'cp-save-btn';
  btn.textContent = 'Save to Pipeline';
  Object.assign(btn.style, {
    position: 'fixed', bottom: 'max(24px, env(safe-area-inset-bottom))', right: 'max(24px, env(safe-area-inset-right))',
    zIndex: '2147483647',
    padding: '14px 24px', minWidth: '60px', height: '52px', background: '#6366f1',
    color: '#fff', border: 'none', borderRadius: '26px',
    fontFamily: '-apple-system, sans-serif', fontSize: '15px',
    fontWeight: '700', cursor: 'pointer', boxShadow: '0 4px 20px rgba(99,102,241,0.5)',
    touchAction: 'manipulation', userSelect: 'none', WebkitUserSelect: 'none',
  });

  btn.addEventListener('click', async () => {
    btn.textContent = 'Saving…';
    btn.style.background = '#818cf8';
    btn.disabled = true;

    try {
      // Use the shared extractor registry (loaded via manifest as shared-extractors.js)
      const extractor = window.CP_Extractors && window.CP_Extractors.detect(location.href);
      if (!extractor) { setError('Unsupported page'); return; }

      const payload = window.CP_Extractors.extract(location.href, document);
      if (!payload) { setError('Could not read listing'); return; }

      // Route through the background worker so the offline queue works.
      // Fall back to a direct POST if the background worker is unavailable (Orion edge cases).
      let resp = null;
      try {
        if (chrome.runtime && chrome.runtime.sendMessage) {
          resp = await chrome.runtime.sendMessage({
            type: 'UPLOAD_PAYLOAD',
            payload,
            settings: { offlineQueue: true },
          });
        }
      } catch (_) { /* background unavailable — fall through to direct */ }

      if (!resp) {
        // Direct POST fallback (header-only secret — never in the URL)
        const direct = await fetch(EDGE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-import-secret': SECRET },
          body: JSON.stringify(payload),
        });
        resp = await direct.json();
      }

      if (resp && resp.ok) {
        const photos = resp.photos || 0;
        btn.textContent = 'Saved! ' + photos + ' photos';
        btn.style.background = '#16a34a';
        setTimeout(() => { btn.remove(); }, 3000);
      } else if (resp && resp.duplicate) {
        btn.textContent = 'Already in pipeline';
        btn.style.background = '#a16207';
        setTimeout(() => { btn.remove(); }, 3000);
      } else if (resp && resp.queued) {
        btn.textContent = 'Queued offline (' + resp.queueLength + ')';
        btn.style.background = '#d97706';
        setTimeout(() => { btn.remove(); }, 3000);
      } else {
        setError(resp && resp.error ? resp.error.slice(0, 40) : 'Server error');
      }
    } catch (e) {
      console.error('[CP]', e);
      setError('Network error');
    }
  });

  document.body.appendChild(btn);

  function setError(msg) {
    btn.textContent = 'Failed: ' + msg;
    btn.style.background = '#dc2626';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Save to Pipeline'; btn.style.background = '#6366f1'; }, 4000);
  }
})();