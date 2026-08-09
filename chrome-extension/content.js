// ============================================================
// Import to Choice Properties — Content Script v2.1
// Orion-optimized: self-contained, no background worker needed.
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
    position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
    padding: '14px 24px', height: '52px', background: '#6366f1',
    color: '#fff', border: 'none', borderRadius: '26px',
    fontFamily: '-apple-system, sans-serif', fontSize: '15px',
    fontWeight: '700', cursor: 'pointer', boxShadow: '0 4px 20px rgba(99,102,241,0.5)',
    touchAction: 'manipulation',
  });

  btn.addEventListener('click', async () => {
    btn.textContent = 'Saving…';
    btn.style.background = '#818cf8';
    btn.disabled = true;

    try {
      const payload = extractListing();
      if (!payload) { setError('Could not read listing'); return; }

      const resp = await fetch(EDGE_URL + '?secret=' + encodeURIComponent(SECRET), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();

      if (data && data.ok) {
        const photos = data.photos || 0;
        btn.textContent = 'Saved! ' + photos + ' photos';
        btn.style.background = '#16a34a';
        setTimeout(() => { btn.remove(); }, 3000);
      } else if (data && data.duplicate) {
        btn.textContent = 'Already in pipeline';
        btn.style.background = '#a16207';
        setTimeout(() => { btn.remove(); }, 3000);
      } else {
        setError(data && data.error ? data.error.slice(0, 40) : 'Server error');
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

  // ── Zillow extractor (only) ─────────────────────────────────
  function extractListing() {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    let nd;
    try { nd = JSON.parse(el.textContent); } catch (_) { return null; }

    let prop = null;
    const paths = [
      ['props', 'pageProps', 'componentProps', 'gdpClientCache'],
      ['props', 'pageProps', 'gdpClientCache'],
    ];
    for (const path of paths) {
      let node = nd;
      for (const key of path) { if (!node) break; node = node[key]; }
      if (!node) continue;
      try {
        const cache = typeof node === 'string' ? JSON.parse(node) : node;
        for (const k of Object.keys(cache)) {
          const v = cache[k];
          if (v && v.property && v.property.zpid) { prop = v.property; break; }
          if (v && v.data && v.data.property && v.data.property.zpid) { prop = v.data.property; break; }
        }
      } catch (_) {}
      if (prop) break;
    }
    if (!prop) return null;

    const rf = prop.resoFacts || {};
    const addr = prop.address || {};
    const zpid = String(prop.zpid || '');
    const street = addr.streetAddress || prop.streetAddress || '';
    const city = addr.city || prop.city || '';
    const state = addr.state || prop.state || '';
    const zip = addr.zipcode || prop.zipcode || '';
    const beds = prop.bedrooms != null ? prop.bedrooms : null;
    const baths = prop.bathrooms != null ? Math.floor(prop.bathrooms) : null;
    const halfBath = prop.bathrooms != null && prop.bathrooms !== Math.floor(prop.bathrooms) ? 1 : null;
    const lat = prop.latitude || null;
    const lng = prop.longitude || null;
    const sqft = prop.livingArea || null;
    const yr = prop.yearBuilt || rf.yearBuilt || null;
    const propType = prop.homeType ? String(prop.homeType).toUpperCase() : null;

    // Collect photos
    const photos = [];
    const seen = new Set();
    const add = (u) => { if (u && typeof u === 'string' && u.startsWith('http') && !seen.has(u)) { photos.push(u); seen.add(u); } };
    for (const p of (prop.responsivePhotos || [])) { if (p && p.mixedSources && p.mixedSources.jpeg) { let best = null, bestW = 0; for (const j of p.mixedSources.jpeg) { if ((j.width||0) > bestW) { bestW = j.width||0; best = j.url; } } if (best) add(best); } }
    for (const p of (prop.photos || [])) add(typeof p === 'string' ? p : (p && p.url));
    add(prop.heroImage);

    return {
      source: 'zillow',
      source_listing_id: zpid,
      source_url: location.href,
      title: (beds ? beds + 'BR ' : '') + (propType || 'Rental') + (city ? ' in ' + city : ''),
      address: street, city, state, zip, lat, lng,
      monthly_rent: prop.price ? parseInt(String(prop.price).replace(/[^0-9]/g, ''), 10) || null : null,
      bedrooms: beds, bathrooms: baths, half_bathrooms: halfBath,
      square_footage: sqft ? parseInt(String(sqft), 10) : null,
      year_built: yr ? parseInt(String(yr), 10) : null,
      property_type: propType,
      description: prop.description || null,
      neighborhood: prop.neighborhoodName || null,
      county: addr.county || null,
      available_date: rf.dateAvailable ? String(rf.dateAvailable).slice(0, 10) : null,
      pets_allowed: prop.isPetFriendly != null ? !!prop.isPetFriendly : null,
      parking: rf.parkingFeatures ? rf.parkingFeatures.join(', ') : null,
      security_deposit: rf.securityDeposit ? parseInt(String(rf.securityDeposit), 10) || null : null,
      original_image_urls: JSON.stringify(photos.slice(0, 50)),
      _import: 'orion-extension-v2.1',
    };
  }
})();