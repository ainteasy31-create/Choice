// ============================================================
// Choice Properties — Live Content Script (auto-updated)
// v3.0 — Browser-side photo download + ImageKit upload
// ============================================================
// This file is hosted on Cloudflare Pages and fetched by the
// extension's thin loader (content.js) on every page load.
// Edit this file → push to GitHub → Cloudflare auto-deploys
// → extension picks up changes automatically. No reinstall needed.
//
// v3.0: PHOTOS ARE DOWNLOADED IN THE BROWSER and uploaded to
// ImageKit BEFORE the listing is sent to the pipeline. This
// avoids Zillow/Realtor CDN blocking server-side requests.
// ============================================================
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────
  var EDGE_URL = (window.CP_CONFIG && window.CP_CONFIG.EDGE_URL) || 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
  var SECRET   = (window.CP_CONFIG && window.CP_CONFIG.IMPORT_SECRET) || 'cp_import_7Kx3m9P2w5';
  var VERSION  = '3.0.0-live';

  // ── SPA navigation handling ─────────────────────────────────
  var lastUrl = location.href;

  function isSupportedPage(url) {
    return /zillow\.com\/homedetails\//i.test(url) ||
           /realtor\.com\/realestateandhomes-detail\//i.test(url) ||
           /apartments\.com\//i.test(url) ||
           /redfin\.com\//i.test(url);
  }

  function removeButton() {
    var old = document.getElementById('cp-save-btn');
    if (old) old.remove();
  }

  function injectButton() {
    if (document.getElementById('cp-save-btn')) return;
    if (!isSupportedPage(location.href)) return;

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

    btn.addEventListener('click', handleSave);
    document.body.appendChild(btn);
  }

  // Watch for URL changes (SPA navigation)
  function watchUrlChanges() {
    setInterval(function () {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        removeButton();
        setTimeout(injectButton, 500);
      }
    }, 1000);
  }

  // ── Photo download + upload helpers (v3.0) ──────────────────
  // Downloads each image in the browser (using the user's cookies/IP)
  // and uploads to ImageKit via the imagekit-upload edge function.
  // This avoids Zillow/Realtor blocking datacenter IPs.
  async function downloadAndUploadPhotos(photoUrls, maxPhotos) {
    var uploaded = [];
    var failed = 0;
    var limit = Math.min(photoUrls.length, maxPhotos || 30);

    // Process in parallel batches of 3
    for (var i = 0; i < limit; i += 3) {
      var batch = photoUrls.slice(i, i + 3);
      var results = await Promise.all(batch.map(function(url) {
        return uploadOnePhoto(url, i + batch.indexOf(url));
      }));
      for (var j = 0; j < results.length; j++) {
        if (results[j]) uploaded.push(results[j]);
        else failed++;
      }
    }
    return { uploaded: uploaded, failed: failed };
  }

  async function uploadOnePhoto(url, index) {
    try {
      // 1. Download the image in the browser (uses user's cookies)
      var imgRes = await fetch(url, {
        mode: 'cors',
        credentials: 'include',
        headers: { 'Accept': 'image/*' }
      });
      if (!imgRes.ok) {
        console.warn('[CP] Photo fetch failed:', imgRes.status, url.slice(0, 80));
        return null;
      }

      // 2. Convert to base64
      var blob = await imgRes.blob();
      var base64 = await blobToBase64(blob);
      var ext = (blob.type || 'image/jpeg').split('/')[1] || 'jpg';
      if (ext === 'jpeg') ext = 'jpg';

      // 3. Upload to ImageKit via pipeline-photo-upload edge function
      var ikRes = await fetch('https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/pipeline-photo-upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-import-secret': SECRET
        },
        body: JSON.stringify({
          fileData: base64,
          fileName: 'photo_' + (index + 1) + '.' + ext,
          folder: '/pipeline/temp'
        })
      });
      var ikData = await ikRes.json();
      if (!ikData || !ikData.url) {
        console.warn('[CP] ImageKit upload failed:', ikData);
        return null;
      }
      return ikData.url;
    } catch (e) {
      console.warn('[CP] Photo upload error:', e.message);
      return null;
    }
  }

  function blobToBase64(blob) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function() { resolve(reader.result); };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function handleSave() {
    var btn = document.getElementById('cp-save-btn');
    if (!btn) return;
    btn.textContent = 'Saving…';
    btn.style.background = '#818cf8';
    btn.disabled = true;

    try {
      // Use the shared extractor registry
      var extractor = window.CP_Extractors && window.CP_Extractors.detect(location.href);
      if (!extractor) { setError('Unsupported page'); return; }

      var extracted = window.CP_Extractors.extract(location.href, document);
      if (!extracted) { setError('Could not read listing'); return; }

      // ── Extract photo URLs ──────────────────────────────────
      var photoUrls = [];
      try {
        var raw = extracted.original_image_urls || '[]';
        var parsed = JSON.parse(raw);
        photoUrls = Array.isArray(parsed) ? parsed.filter(function(u) { return u && u.startsWith('http'); }) : [];
      } catch (e) {
        photoUrls = extracted.photo_urls || [];
      }

      // ── Download + upload photos in browser (v3.0) ──────────
      btn.textContent = 'Downloading photos…';
      var photoResult = { uploaded: [], failed: 0 };
      if (photoUrls.length > 0) {
        photoResult = await downloadAndUploadPhotos(photoUrls, 30);
      }

      // ── Build payload with ImageKit URLs ────────────────────
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
        // Use ImageKit URLs if uploaded, otherwise fall back to source URLs
        original_image_urls: JSON.stringify(photoResult.uploaded.length > 0 ? photoResult.uploaded : photoUrls),
        _import: 'browser-extension-v3.0.0-live',
      };

      // ── Send to pipeline ────────────────────────────────────
      btn.textContent = 'Saving to pipeline…';
      var url = EDGE_URL + '?secret=' + encodeURIComponent(SECRET);
      var direct = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var resp = await direct.json();

      if (resp && resp.ok) {
        var photos = resp.photos || 0;
        var ikPhotos = resp.imagekit_photos || 0;
        btn.textContent = ikPhotos > 0 ? 'Saved! ' + ikPhotos + ' photos ✓' : 'Saved! ' + photos + ' source photos';
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
  }

  // ── Init ────────────────────────────────────────────────────
  injectButton();
  watchUrlChanges();

  function setError(msg) {
    var btn = document.getElementById('cp-save-btn');
    if (!btn) return;
    btn.textContent = 'Failed: ' + msg;
    btn.style.background = '#dc2626';
    btn.disabled = false;
    setTimeout(function () {
      if (btn) { btn.textContent = 'Save to Pipeline'; btn.style.background = '#6366f1'; }
    }, 4000);
  }
})();