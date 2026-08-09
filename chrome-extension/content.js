// ============================================================
// Import to Choice Properties — Content Script v2.3.0 (Live Loader)
// This is a THIN LOADER. It fetches the latest logic from
// Cloudflare Pages on every page load, so updates are automatic.
//
// HOW IT WORKS:
//   1. On page load, this script fetches live-shared-extractors.js
//      and live-content.js from the hosted URL.
//   2. It executes them via injected <script> tags.
//   3. If the fetch fails (offline), it falls back to the bundled
//      shared-extractors.js and inline logic below.
//
// TO UPDATE THE EXTENSION:
//   Edit .pages-orion/live-content.js or .pages-orion/live-shared-extractors.js
//   → push to GitHub → Cloudflare auto-deploys → extension picks up
//   changes on next page load. NO reinstall needed.
// ============================================================
(function () {
  'use strict';

  var LIVE_BASE = 'https://choice-properties-site.pages.dev/.pages-orion/';
  var LIVE_EXTRACTORS = LIVE_BASE + 'live-shared-extractors.js';
  var LIVE_CONTENT = LIVE_BASE + 'live-content.js';

  if (document.getElementById('cp-save-btn')) return;

  // ── Load live code from Cloudflare Pages ─────────────────────
  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + url)); };
      document.head.appendChild(s);
    });
  }

  async function loadLive() {
    try {
      // Load extractors first, then content logic
      await loadScript(LIVE_EXTRACTORS);
      await loadScript(LIVE_CONTENT);
      return true;
    } catch (e) {
      console.warn('[CP] Live load failed, using bundled fallback:', e.message);
      return false;
    }
  }

  // ── Bundled fallback (used only if live fetch fails) ─────────
  function runBundledFallback() {
    // If live extractors loaded but live-content failed, use bundled content
    if (window.CP_Extractors && !document.getElementById('cp-save-btn')) {
      // The live-content.js should have run. If not, inject the bundled logic.
      var EDGE_URL = 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
      var SECRET = 'cp_import_7Kx3m9P2w5';

      var btn = document.createElement('button');
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

      btn.addEventListener('click', async function () {
        btn.textContent = 'Saving…';
        btn.style.background = '#818cf8';
        btn.disabled = true;

        try {
          var extractor = window.CP_Extractors && window.CP_Extractors.detect(location.href);
          if (!extractor) { setError('Unsupported page'); return; }

          var payload = window.CP_Extractors.extract(location.href, document);
          if (!payload) { setError('Could not read listing'); return; }

          var url = EDGE_URL + '?secret=' + encodeURIComponent(SECRET);
          var direct = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          var resp = await direct.json();

          if (resp && resp.ok) {
            var photos = resp.photos || 0;
            btn.textContent = 'Saved! ' + photos + ' photos';
            btn.style.background = '#16a34a';
            setTimeout(function () { btn.remove(); }, 3000);
          } else if (resp && resp.duplicate) {
            btn.textContent = 'Already in pipeline';
            btn.style.background = '#a16207';
            setTimeout(function () { btn.remove(); }, 3000);
          } else if (resp && resp.queued) {
            btn.textContent = 'Queued offline (' + resp.queueLength + ')';
            btn.style.background = '#d97706';
            setTimeout(function () { btn.remove(); }, 3000);
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
        setTimeout(function () { btn.textContent = 'Save to Pipeline'; btn.style.background = '#6366f1'; }, 4000);
      }
    }
  }

  // ── Init ─────────────────────────────────────────────────────
  // Wait for DOM to be ready, then try to load live code.
  // If live code loads, it handles everything. If not, use bundled fallback.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    loadLive().then(function (loaded) {
      if (!loaded) {
        runBundledFallback();
      }
    });
  }
})();