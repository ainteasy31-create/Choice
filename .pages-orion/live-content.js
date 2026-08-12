// ============================================================
// Choice Properties — Live Content Script (auto-updated)
// v4.0 — August 2026
//
// v4.0: SAVE-FIRST ARCHITECTURE
//   The property is saved to the pipeline IMMEDIATELY and the
//   user sees "Saved!" in under 2 seconds. Photos continue
//   uploading in the background with a floating progress widget.
//
//   PHOTO UPLOAD PIPELINE:
//   1. Save property → get pipeline ID (instant)
//   2. Show "Saved!" button, user can navigate away
//   3. Photos upload in background (12 concurrent)
//   4. Pipeline record is updated when all photos complete
//
//   FALLBACK CHAIN:
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
  var VERSION  = '4.0.0-live';

  // ── SPA navigation handling ─────────────────────────────────
  var lastUrl = location.href;
  var PHOTO_BATCH_SIZE = 12; // increased from 5 for faster parallel uploads
  var MAX_PHOTOS = 40;

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

  function dispatchNavigation() {
    window.dispatchEvent(new Event('cp_navigation'));
  }

  function patchHistoryNavigation() {
    var originalPush = history.pushState;
    var originalReplace = history.replaceState;

    history.pushState = function () {
      var result = originalPush.apply(this, arguments);
      dispatchNavigation();
      return result;
    };

    history.replaceState = function () {
      var result = originalReplace.apply(this, arguments);
      dispatchNavigation();
      return result;
    };
  }

  function onLocationChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    removeButton();
    setTimeout(injectButton, 250);
  }

  function watchUrlChanges() {
    patchHistoryNavigation();
    window.addEventListener('popstate', onLocationChange);
    window.addEventListener('cp_navigation', onLocationChange);

    if (document.body) {
      var observer = new MutationObserver(function () {
        onLocationChange();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  // ── Photo download + upload helpers (v4.0) ──────────────────
  function dedupePhotoUrls(urls) {
    var seen = new Set();
    var unique = [];
    if (!Array.isArray(urls)) return unique;
    urls.forEach(function(raw) {
      if (!raw) return;
      var url = typeof raw === 'string' ? raw.trim() : (raw.url || '');
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) return;
      if (seen.has(url)) return;
      seen.add(url);
      unique.push(url);
    });
    return unique;
  }

  function extractPhotoUrls(raw) {
    var urls = [];
    if (!raw) return urls;
    try {
      var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) {
        parsed.forEach(function(item) {
          if (!item) return;
          if (typeof item === 'string') urls.push(item);
          else if (typeof item === 'object' && typeof item.url === 'string') urls.push(item.url);
        });
      }
    } catch (e) {
      // ignore
    }
    return urls;
  }

  // ── Floating progress widget (v4.0) ─────────────────────────
  // Shows a small floating indicator when photos are uploading in the background
  var progressWidget = null;

  function showProgressWidget() {
    hideProgressWidget();
    progressWidget = document.createElement('div');
    progressWidget.id = 'cp-progress-widget';
    progressWidget.textContent = 'Saving property…';
    Object.assign(progressWidget.style, {
      position: 'fixed', bottom: 'max(80px, env(safe-area-inset-bottom))', right: 'max(24px, env(safe-area-inset-right))',
      zIndex: '2147483647',
      padding: '10px 18px', background: '#1e293b', color: '#e2e8f0',
      border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px',
      fontFamily: '-apple-system, sans-serif', fontSize: '13px',
      boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
      display: 'flex', alignItems: 'center', gap: '8px',
      transition: 'opacity 0.3s',
    });
    document.body.appendChild(progressWidget);
  }

  function updateProgressWidget(text) {
    if (progressWidget) progressWidget.textContent = text;
  }

  function hideProgressWidget() {
    if (progressWidget) {
      progressWidget.remove();
      progressWidget = null;
    }
  }

  // ── v4.0: Save property first, then upload photos in background ──
  async function handleSave() {
    var btn = document.getElementById('cp-save-btn');
    if (!btn) return;
    btn.textContent = 'Saving…';
    btn.style.background = '#818cf8';
    btn.disabled = true;

    try {
      var extractor = window.CP_Extractors && window.CP_Extractors.detect(location.href);
      if (!extractor) { setError('Unsupported page'); return; }

      var extracted = window.CP_Extractors.extract(location.href, document);
      if (!extracted) { setError('Could not read listing'); return; }

      // ── Extract photo URLs ──────────────────────────────────
      var photoUrls = extractPhotoUrls(extracted.original_image_urls);
      if (!photoUrls.length && Array.isArray(extracted.photo_urls)) {
        extracted.photo_urls.forEach(function(u) {
          if (typeof u === 'string') photoUrls.push(u);
        });
      }

      // ── v4.0: Save property FIRST, then upload photos ───────
      // Build payload with source URLs (no ImageKit upload yet)
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
        original_image_urls: JSON.stringify(photoUrls.map(function(u) { return { url: u }; })),
        _import: 'browser-extension-v4.0.0-live',
      };

      // ── Save property immediately ───────────────────────────
      btn.textContent = 'Saving to pipeline…';
      var url = EDGE_URL + '?secret=' + encodeURIComponent(SECRET);
      var saveRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var resp = await saveRes.json();

      if (resp && resp.ok) {
        var ikPhotos = resp.imagekit_photos || 0;
        var photoImport = resp.photo_import;

        if (photoImport === 'complete') {
          // Photos were already uploaded (browser-side upload path)
          btn.textContent = 'Saved! ' + ikPhotos + ' photos ✓';
          btn.style.background = '#16a34a';
          setTimeout(function () { btn.remove(); }, 3000);
        } else {
          // v4.0: Property saved, photos uploading in background
          btn.textContent = 'Saved! ✓';
          btn.style.background = '#16a34a';

          // Show progress widget for background photo uploads
          showProgressWidget();
          updateProgressWidget('Photos uploading…');

          // Start background photo uploads
          // We don't await this — it runs in the background
          if (photoUrls.length > 0) {
            uploadPhotosInBackground(photoUrls, function(completed, total) {
              updateProgressWidget('Photos: ' + completed + '/' + total);
            }).then(function(result) {
              if (result.uploaded.length > 0) {
                updateProgressWidget(result.uploaded.length + ' photos uploaded ✓');
                // v4.0: Update the pipeline record with ImageKit URLs
                updatePipelinePhotos(payload, result.uploaded);
              } else if (result.failed > 0) {
                updateProgressWidget('Photos queued for server retry');
              }
              setTimeout(hideProgressWidget, 4000);
            }).catch(function() {
              updateProgressWidget('Photo upload queued');
              setTimeout(hideProgressWidget, 3000);
            });
          } else {
            hideProgressWidget();
          }

          setTimeout(function () { btn.remove(); }, 3000);
        }
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

  // ── Update pipeline record with uploaded ImageKit URLs (v4.0) ──
  // Called after background photo uploads complete. Sends _update_photos_only
  // to the receive-pipeline-import edge function to update the record.
  async function updatePipelinePhotos(originalPayload, uploadedPhotos) {
    try {
      if (!uploadedPhotos || uploadedPhotos.length === 0) return;
      var updatePayload = Object.assign({}, originalPayload, {
        _update_photos_only: true,
        original_image_urls: JSON.stringify(uploadedPhotos),
      });
      var updateUrl = EDGE_URL + '?secret=' + encodeURIComponent(SECRET);
      var updateRes = await fetch(updateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload),
      });
      var updateResp = await updateRes.json();
      if (updateResp && updateResp.updated === 'photos_only') {
        console.log('[CP] Pipeline photos updated:', updateResp.imagekit_photos);
      }
    } catch (e) {
      console.warn('[CP] Failed to update pipeline photos:', e);
    }
  }

  // ── Background photo upload (v4.0) ──────────────────────────
  // Runs after the property is saved. Uploads photos in the background
  // and updates the pipeline record when complete.
  async function uploadPhotosInBackground(photoUrls, progressCallback) {
    var uploaded = [];
    var failed = 0;
    var urls = dedupePhotoUrls(photoUrls);
    var limit = Math.min(urls.length, MAX_PHOTOS);
    var total = limit;

    for (var i = 0; i < limit; i += PHOTO_BATCH_SIZE) {
      var batch = urls.slice(i, i + PHOTO_BATCH_SIZE);
      if (progressCallback) progressCallback(Math.min(i, total), total);
      var results = await Promise.all(batch.map(function(url, batchIndex) {
        return uploadOnePhoto(url, i + batchIndex);
      }));
      for (var j = 0; j < results.length; j++) {
        if (results[j]) uploaded.push(results[j]);
        else failed++;
        if (progressCallback) progressCallback(Math.min(i + j + 1, total), total);
      }
    }
    return { uploaded: uploaded, failed: failed, total: total };
  }

  // Download a photo via the background worker (bypasses CORS)
  async function downloadViaBackground(url) {
    return new Promise(function(resolve) {
      try {
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
      // Optimize image on client: resize large images and convert to WebP to save bandwidth.
      try {
        var optimized = await optimizeImageBlob(blob, 1600, 0.85);
        if (optimized) blob = optimized;
      } catch (_) {}
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

  // Resize/convert images using canvas. Returns a Blob or null on failure.
  function optimizeImageBlob(blob, maxWidth, quality) {
    return new Promise(async function(resolve) {
      try {
        if (!self.createImageBitmap) return resolve(null);
        const imgBitmap = await createImageBitmap(blob);
        const ratio = Math.min(1, maxWidth / imgBitmap.width);
        const w = Math.round(imgBitmap.width * ratio);
        const h = Math.round(imgBitmap.height * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imgBitmap, 0, 0, w, h);
        canvas.toBlob(function(b) { resolve(b); }, 'image/webp', quality);
      } catch (e) {
        resolve(null);
      }
    });
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
    } catch (e) {
      console.error('[CP] Photo upload error:', e.message);
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

  // ── Init ────────────────────────────────────────────────────
  injectButton();
  watchUrlChanges();
})();