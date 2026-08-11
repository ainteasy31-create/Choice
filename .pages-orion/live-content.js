// ============================================================
// Choice Properties — Live Content Script (auto-updated)
// v3.1 — Background-worker photo download + ImageKit upload
// ============================================================
// This file is hosted on Cloudflare Pages and fetched by the
// extension's thin loader (content.js) on every page load.
// Edit this file → push to GitHub → Cloudflare auto-deploys
// → extension picks up changes automatically. No reinstall needed.
//
// v3.1: PHOTOS ARE DOWNLOADED VIA THE BACKGROUND SERVICE WORKER
// (which has host_permissions for Zillow/Realtor CDNs, bypassing
// CORS restrictions that block content-script fetches) and uploaded
// to ImageKit BEFORE the listing is sent to the pipeline.
//
// FALLBACK CHAIN:
//   1. Background worker download (best — no CORS issues)
//   2. Direct content-script fetch (works for some CDNs)
//   3. Send source URLs to server — server tries to download
//   4. If all fail, listing still saves with source URLs for retry
// ============================================================
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────
  var EDGE_URL = (window.CP_CONFIG && window.CP_CONFIG.EDGE_URL) || 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
  var SECRET   = (window.CP_CONFIG && window.CP_CONFIG.IMPORT_SECRET) || 'cp_import_7Kx3m9P2w5';
  var VERSION  = '3.1.0-live';

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

  // ── Photo download + upload helpers (v3.1) ──────────────────
  // Downloads each image via the background service worker (which
  // has host_permissions for Zillow/Realtor CDNs, bypassing CORS)
  // and uploads to ImageKit via the pipeline-photo-upload edge function.
  async function downloadAndUploadPhotos(photoUrls, maxPhotos) {
    var uploaded = [];
    var failed = 0;
    var limit = Math.min(photoUrls.length, maxPhotos || 30);

    // Process in parallel batches of 3
    for (var i = 0; i < limit; i += 3) {
      var batch = photoUrls.slice(i, i + 3);
      var results = await Promise.all(batch.map(function(url, batchIndex) {
        return uploadOnePhoto(url, i + batchIndex);
      }));
      for (var j = 0; j < results.length; j++) {
        if (results[j]) uploaded.push(results[j]);
        else failed++;
      }
    }
    return { uploaded: uploaded, failed: failed };
  }

  // Download a photo via the background worker (bypasses CORS)
  async function downloadViaBackground(url) {
    return new Promise(function(resolve) {
      try {
        // This live file is injected into the page's main world. The
        // extension API is only exposed to the isolated content script, so
        // ask that script to relay the request through a postMessage bridge.
        if (!window.chrome || !window.chrome.runtime || !window.chrome.runtime.sendMessage) {
          var requestId = 'cp-photo-' + Date.now() + '-' + Math.random().toString(36).slice(2);
          var timer = setTimeout(function () {
            window.removeEventListener('message', onResult);
            resolve(null);
          }, 25000);
          function onResult(event) {
            var data = event && event.data;
            if (event.source !== window || !data ||
                data.type !== 'CP_DOWNLOAD_PHOTO_RESULT' ||
                data.requestId !== requestId) return;
            clearTimeout(timer);
            window.removeEventListener('message', onResult);
            resolve(data.ok && data.dataUri ? data : null);
          }
          window.addEventListener('message', onResult);
          window.postMessage({ type: 'CP_DOWNLOAD_PHOTO', requestId: requestId, url: url }, '*');
          return;
        }
        chrome.runtime.sendMessage(
          { type: 'DOWNLOAD_PHOTO', url: url },
          function(response) {
            if (chrome.runtime.lastError) {
              console.warn('[CP] Background download error:', chrome.runtime.lastError.message);
              resolve(null);
              return;
            }
            if (response && response.ok && response.dataUri) {
              resolve(response);
            } else {
              resolve(null);
            }
          }
        );
      } catch (e) {
        console.warn('[CP] Background download exception:', e.message);
        resolve(null);
      }
    });
  }

  // Fallback: try direct fetch from content script (works for some CDNs)
  async function downloadViaDirectFetch(url) {
    try {
      var imgRes = await fetch(url, {
        mode: 'cors',
        credentials: 'include',
        headers: { 'Accept': 'image/jpeg,image/png,image/webp,image/*;q=0.8' }
      });
      if (!imgRes.ok) return null;
      var blob = await imgRes.blob();
      var base64 = await blobToBase64(blob);
      var ext = (blob.type || 'image/jpeg').split('/')[1] || 'jpg';
      if (ext === 'jpeg') ext = 'jpg';
      return {
        dataUri: base64,
        contentType: blob.type || 'image/jpeg',
        ext: ext,
        size: blob.size,
      };
    } catch (e) {
      return null;
    }
  }

  async function uploadOnePhoto(url, index) {
    try {
      // 1. Try background worker download first (bypasses CORS)
      var photo = await downloadViaBackground(url);

      // 2. Fallback: direct content-script fetch
      if (!photo) {
        photo = await downloadViaDirectFetch(url);
      }

      // 3. If both failed, return null (will be retried server-side)
      if (!photo) {
        console.warn('[CP] All download methods failed for:', url.slice(0, 100));
        return null;
      }

      // 4. Upload to ImageKit via pipeline-photo-upload edge function
      var ikRes = await fetch('https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/pipeline-photo-upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-import-secret': SECRET
        },
        body: JSON.stringify({
          fileData: photo.dataUri,
          fileName: 'photo_' + (index + 1) + '.' + photo.ext,
          folder: '/pipeline/temp'
        })
      });
      var ikData = await ikRes.json();
      if (!ikData || !ikData.url) {
        console.warn('[CP] ImageKit upload failed:', ikData);
        return null;
      }
          return {
            url: ikData.url,
            fileId: ikData.fileId || null,
            width: ikData.width || null,
            height: ikData.height || null,
          };
        var parsed = JSON.parse(raw);
        photoUrls = Array.isArray(parsed) ? parsed.filter(function(u) { return u && u.startsWith('http'); }) : [];
      } catch (e) {
        photoUrls = extracted.photo_urls || [];
      }

      // ── Download + upload photos (v3.1) ─────────────────────
      // Show progress: "Downloading photos (1/12)…"
      var photoResult = { uploaded: [], failed: 0 };
      if (photoUrls.length > 0) {
        btn.textContent = 'Downloading photos…';
        photoResult = await downloadAndUploadPhotos(photoUrls, 30);
      }

      // ── Build payload with ImageKit image objects ─────────────
      // Preserve fileId and size metadata if upload succeeded.
      var finalUrls = photoResult.uploaded.length > 0
        ? photoResult.uploaded
        : photoUrls.map(function(url) { return { url: url }; });
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
        original_image_urls: JSON.stringify(finalUrls),
        _import: 'browser-extension-v3.1.0-live',
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
        var failedPhotos = resp.imagekit_failed || 0;
        if (ikPhotos > 0) {
          btn.textContent = 'Saved! ' + ikPhotos + ' photos ✓';
        } else if (failedPhotos > 0) {
          btn.textContent = 'Saved! Photos pending retry';
        } else {
          btn.textContent = 'Saved! ' + photos + ' source photos';
        }
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