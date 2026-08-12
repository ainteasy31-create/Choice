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

  // Remote live-content.js runs in the page's main world, where
  // chrome.runtime is unavailable. Relay photo-download requests from that
  // world through this isolated content-script context.
  window.addEventListener('message', function (event) {
    var data = event && event.data;
    if (event.source !== window || !data || data.type !== 'CP_DOWNLOAD_PHOTO') return;
    if (!data.requestId || typeof data.url !== 'string') return;
    if (!/^https:\/\/([a-z0-9-]+\.)?(zillowstatic\.com|rdcpix\.com|apartments\.com|redfin\.com)\//i.test(data.url)) return;
    try {
      chrome.runtime.sendMessage(
        { type: 'DOWNLOAD_PHOTO', url: data.url },
        function (response) {
          var runtimeError = chrome.runtime.lastError;
          window.postMessage({
            type: 'CP_DOWNLOAD_PHOTO_RESULT',
            requestId: data.requestId,
            ok: !runtimeError && !!(response && response.ok),
            dataUri: response && response.dataUri,
            contentType: response && response.contentType,
            ext: response && response.ext,
            size: response && response.size,
            error: runtimeError ? runtimeError.message : (response && response.error)
          }, '*');
        }
      );
    } catch (error) {
      window.postMessage({
        type: 'CP_DOWNLOAD_PHOTO_RESULT',
        requestId: data.requestId,
        ok: false,
        error: String(error && error.message || error)
      }, '*');
    }
  });

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
      // Read config from window.CP_CONFIG (set by config.js) with fallback
      // to the hardcoded value for backward compatibility with already-installed extensions.
      var EDGE_URL = (window.CP_CONFIG && window.CP_CONFIG.EDGE_URL) || 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
      var SECRET = (window.CP_CONFIG && window.CP_CONFIG.IMPORT_SECRET) || 'cp_import_7Kx3m9P2w5';

      // SPA navigation handling
      var lastUrl = location.href;
      var PHOTO_BATCH_SIZE = 5;
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

      // ── Photo download via background worker (v3.0) ──────────
      // The background service worker has host_permissions for
      // Zillow/Realtor CDNs, so it can fetch images without CORS.
      function downloadViaBackground(url) {
        return new Promise(function(resolve) {
          try {
            if (!chrome.runtime || !chrome.runtime.sendMessage) {
              resolve(null);
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

      function blobToBase64(blob) {
        return new Promise(function(resolve, reject) {
          var reader = new FileReader();
          reader.onload = function() { resolve(reader.result); };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }

      async function uploadOnePhoto(url, index) {
        try {
          // Download via background worker (bypasses CORS)
          var photo = await downloadViaBackground(url);
          if (!photo) {
            // Fallback: direct fetch
            try {
              var imgRes = await fetch(url, {
                mode: 'cors',
                credentials: 'include',
                headers: { 'Accept': 'image/*' }
              });
              if (imgRes.ok) {
                var blob = await imgRes.blob();
                var base64 = await blobToBase64(blob);
                var ext = (blob.type || 'image/jpeg').split('/')[1] || 'jpg';
                if (ext === 'jpeg') ext = 'jpg';
                photo = { dataUri: base64, ext: ext };
              }
            } catch (_) {}
          }
          if (!photo) return null;

          // Upload to ImageKit
          var ikRes = await fetch('https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/pipeline-photo-upload', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-import-secret': SECRET
            },
            body: JSON.stringify({
              fileData: photo.dataUri,
              fileName: 'photo_' + (index + 1) + '.' + (photo.ext || 'jpg'),
              folder: '/pipeline/temp'
            })
          });
          var ikData = await ikRes.json();
          if (!ikData || !ikData.url) return null;
          return {
            url: ikData.url,
            fileId: ikData.fileId || null,
            width: ikData.width || null,
            height: ikData.height || null,
          };
        } catch (e) {
          return null;
        }
      }

      async function downloadAndUploadPhotos(photoUrls, maxPhotos, progressCallback) {
        var uploaded = [];
        var failed = 0;
        var urls = dedupePhotoUrls(photoUrls);
        var limit = Math.min(urls.length, maxPhotos || MAX_PHOTOS);
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

          // Extract photo URLs
          var photoUrls = extractPhotoUrls(extracted.original_image_urls);
          if (!photoUrls.length && Array.isArray(extracted.photo_urls)) {
            extracted.photo_urls.forEach(function(u) {
              if (typeof u === 'string') photoUrls.push(u);
            });
          }

          // Download + upload photos via background worker
          var photoResult = { uploaded: [], failed: 0, total: 0 };
          if (photoUrls.length > 0) {
            btn.textContent = 'Extracting photos…';
            photoResult = await downloadAndUploadPhotos(photoUrls, MAX_PHOTOS, function(completed, total) {
              btn.textContent = 'Importing photos ' + completed + '/' + total + '…';
            });
          }

          // Build payload with ImageKit URLs if available
          var finalUrls = photoResult.uploaded.length > 0 ? photoResult.uploaded : photoUrls;
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
            _import: 'browser-extension-v3.1.0',
          };

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

      injectButton();
      watchUrlChanges();
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