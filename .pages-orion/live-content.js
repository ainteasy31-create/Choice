// ============================================================
// Choice Properties — Live Content Script (auto-updated)
// This file is hosted on Cloudflare Pages and fetched by the
// extension's thin loader (content.js) on every page load.
// Edit this file → push to GitHub → Cloudflare auto-deploys
// → extension picks up changes automatically. No reinstall needed.
// ============================================================
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────
  var EDGE_URL = 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
  var SECRET   = 'cp_import_7Kx3m9P2w5';
  var VERSION  = '2.3.0-live';

  if (document.getElementById('cp-save-btn')) return;

  // ── Inject button ───────────────────────────────────────────
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
      // Use the shared extractor registry (loaded via manifest as shared-extractors.js)
      var extractor = window.CP_Extractors && window.CP_Extractors.detect(location.href);
      if (!extractor) { setError('Unsupported page'); return; }

      var extracted = window.CP_Extractors.extract(location.href, document);
      if (!extracted) { setError('Could not read listing'); return; }

      // Map extractor output to Edge Function expected payload format
      // (handles both live extractor field names and bundled extractor field names)
      var payload = {
        source: extracted.source,
        source_listing_id: extracted.source_listing_id,
        source_url: extracted.source_url || extracted.url || location.href,
        title: extracted.title,
        address: extracted.address,
        city: extracted.city,
        state: extracted.state,
        zip: extracted.zip,
        lat: extracted.lat,
        lng: extracted.lng,
        monthly_rent: extracted.monthly_rent != null ? extracted.monthly_rent : extracted.rent,
        bedrooms: extracted.bedrooms != null ? extracted.bedrooms : extracted.beds,
        bathrooms: extracted.bathrooms != null ? extracted.bathrooms : extracted.baths,
        half_bathrooms: extracted.half_bathrooms,
        square_footage: extracted.square_footage != null ? extracted.square_footage : extracted.sqft,
        lot_size_sqft: extracted.lot_size_sqft != null ? extracted.lot_size_sqft : extracted.lot_sqft,
        year_built: extracted.year_built,
        property_type: extracted.property_type,
        description: extracted.description,
        available_date: extracted.available_date,
        pets_allowed: extracted.pets_allowed,
        original_image_urls: extracted.original_image_urls || JSON.stringify(extracted.photo_urls || []),
        _import: 'browser-extension-v2.3.0-live',
      };

      // Direct POST with secret as query param (avoids CORS preflight issues on WebKit)
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
})();