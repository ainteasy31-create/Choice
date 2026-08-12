// ============================================================
// Import to Choice Properties — Background Service Worker v4.0
// Orion-compatible: no importScripts, no alarms dependency.
//
// v4.0: IMAGE OPTIMIZATION IN SERVICE WORKER
//   Photos are downloaded, resized to max 1600px, and converted
//   to WebP (or JPEG fallback) BEFORE returning to the content
//   script for upload. This reduces payload size by 60-80%,
//   making uploads dramatically faster.
//
//   Download timeout reduced to 8s for fast-fail on blocked images.
//   High concurrency: content script sends up to 12 parallel requests.
// ============================================================

// Inline config (Orion doesn't reliably support importScripts)
const EDGE_URL = (typeof window !== 'undefined' && window.CP_CONFIG && window.CP_CONFIG.EDGE_URL) || 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
const SECRET   = (typeof window !== 'undefined' && window.CP_CONFIG && window.CP_CONFIG.IMPORT_SECRET) || 'cp_import_7Kx3m9P2w5';
const MAX_QUEUE_ITEMS = 75;
const MAX_IMAGE_WIDTH = 1600;
const IMAGE_QUALITY = 0.82;
const DOWNLOAD_TIMEOUT = 8000; // reduced from 20000ms for fast-fail

async function getCount() {
  try {
    const data = await chrome.storage.session.get({ sessionCount: 0 });
    return data.sessionCount;
  } catch (_) {
    return 0;
  }
}

async function getQueue() {
  try {
    const data = await chrome.storage.local.get({ cp_queue: [] });
    return data.cp_queue || [];
  } catch (_) {
    return [];
  }
}

async function setQueue(queue) {
  try {
    await chrome.storage.local.set({ cp_queue: queue });
  } catch (_) {}
}

function queueItemKey(item) {
  return `${item.source || 'unknown'}|${item.source_listing_id || 'unknown'}`;
}

async function addQueueItem(item) {
  const queue = await getQueue();
  const exists = queue.some(q => queueItemKey(q) === queueItemKey(item));
  if (exists) return queue.length;
  queue.push(Object.assign({}, item, { _queued_at: Date.now() }));
  const trimmed = queue.slice(-MAX_QUEUE_ITEMS);
  await setQueue(trimmed);
  await updateBadge();
  return trimmed.length;
}

async function updateBadge() {
  try {
    const q = await getQueue();
    if (q.length > 0) {
      await chrome.action.setBadgeText({ text: String(q.length) });
      await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
    } else {
      const n = await getCount();
      if (n > 0) {
        await chrome.action.setBadgeText({ text: String(n) });
        await chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
      } else {
        await chrome.action.setBadgeText({ text: '' });
      }
    }
  } catch (_) {}
}

async function postPayload(payload) {
  const res = await fetch(EDGE_URL, {
    method:  'POST',
    mode:    'cors',
    headers: { 'Content-Type': 'application/json', 'x-import-secret': SECRET },
    body:    JSON.stringify(payload),
  });
  let body;
  try {
    body = await res.json();
  } catch (_) {
    body = {};
  }
  if (!res.ok) {
    body = body && typeof body === 'object' ? body : {};
    body.ok = false;
    body.httpStatus = res.status;
    body.error = body.error || `Server rejected import (HTTP ${res.status})`;
  }
  return body;
}

async function flushQueue() {
  const queue = await getQueue();
  if (queue.length === 0) return 0;

  const remaining = [];
  let flushed = 0;

  for (const item of queue) {
    try {
      const resp = await postPayload(item);
      if (resp && (resp.ok || resp.duplicate)) {
        flushed++;
      } else {
        remaining.push(item);
      }
    } catch (err) {
      remaining.push(item);
    }
  }

  if (remaining.length > 0) {
    await setQueue(remaining);
  } else {
    await setQueue([]);
    if (flushed > 0) {
      await chrome.storage.session.set({ sessionCount: (await getCount()) + flushed });
    }
  }
  await updateBadge();
  return flushed;
}

// ── Image optimization (v4.0) ───────────────────────────────
// Resize image to max width and convert to WebP in the service worker.
// This dramatically reduces upload payload sizes.
async function optimizeImageBlob(blob, maxWidth, quality) {
  try {
    if (!('createImageBitmap' in self) || !('OffscreenCanvas' in self)) {
      return blob; // fallback: return original
    }
    // Try to detect image type by magic bytes
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer.slice(0, 12));
    let isImage = false;
    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) isImage = true;
    // PNG: 89 50 4E 47
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) isImage = true;
    // WebP: RIFF....WEBP
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) isImage = true;
    if (!isImage) return blob;

    const img = await createImageBitmap(new Blob([buffer], { type: blob.type }));
    const ratio = Math.min(1, (maxWidth || MAX_IMAGE_WIDTH) / img.width);
    const w = Math.round(img.width * ratio);
    const h = Math.round(img.height * ratio);
    
    // Skip optimization for small images (< maxWidth)
    if (w >= img.width && h >= img.height) {
      img.close();
      return blob;
    }

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    img.close();

    let outBlob;
    try {
      outBlob = await canvas.convertToBlob({ type: 'image/webp', quality: (quality || IMAGE_QUALITY) });
    } catch (_) {
      outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: (quality || IMAGE_QUALITY) });
    }
    return outBlob;
  } catch (err) {
    return blob; // fallback: return original on any error
  }
}

// ── Photo download helper (v4.0) ─────────────────────────────
// The background service worker has host_permissions for
// Zillow/Realtor/Apartments/Redfin CDNs, so it can fetch images
// without CORS restrictions. Downloads, optimizes, and returns
// the image as a base64 data URI.
async function downloadPhoto(url) {
  try {
    const parsedUrl = new URL(url);
    const allowedHosts = /(^|\.)((zillowstatic\.com)|(rdcpix\.com)|(apartments\.com)|(redfin\.com))$/i;
    if (parsedUrl.protocol !== 'https:' || !allowedHosts.test(parsedUrl.hostname)) {
      console.warn('[CP] Refusing photo download from unsupported host:', parsedUrl.hostname);
      return null;
    }
    // Try with a browser-like User-Agent and Referer
    const headers = {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Accept': 'image/jpeg,image/png,image/webp,image/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };

    // Add Referer based on the URL host
    try {
      const u = new URL(url);
      if (u.hostname.includes('zillow')) headers['Referer'] = 'https://www.zillow.com/';
      else if (u.hostname.includes('realtor')) headers['Referer'] = 'https://www.realtor.com/';
      else if (u.hostname.includes('apartments')) headers['Referer'] = 'https://www.apartments.com/';
      else if (u.hostname.includes('redfin')) headers['Referer'] = 'https://www.redfin.com/';
    } catch (_) {}

    const res = await fetch(url, {
      headers,
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
    });

    if (!res.ok) {
      console.warn('[CP] Background photo fetch failed:', res.status, url.slice(0, 100));
      return null;
    }

    let blob = await res.blob();
    const originalContentType = blob.type || 'image/jpeg';

    // Optimize image in the service worker (v4.0)
    try {
      const optimized = await optimizeImageBlob(blob, MAX_IMAGE_WIDTH, IMAGE_QUALITY);
      if (optimized && optimized.size < blob.size) {
        blob = optimized;
      }
    } catch (_) {}

    const contentType = blob.type || originalContentType;
    const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');

    // Convert blob to base64 data URI
    const base64 = await blobToBase64(blob);
    return {
      dataUri: base64,
      contentType: contentType,
      ext: ext,
      size: blob.size,
    };
  } catch (err) {
    console.warn('[CP] Background photo download error:', err.message, url.slice(0, 100));
    return null;
  }
}

function blobToBase64(blob) {
  // FileReader is not available in MV3/Orion service workers. Convert the
  // response bytes directly so successful CDN downloads reach ImageKit.
  return blob.arrayBuffer().then(function(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return 'data:' + (blob.type || 'image/jpeg') + ';base64,' + btoa(binary);
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SAVED') {
    (async () => {
      const n = (await getCount()) + 1;
      await chrome.storage.session.set({ sessionCount: n });
      await updateBadge();
      sendResponse({ ok: true, count: n });
    })();
    return true;
  }

  if (msg.type === 'QUEUE_UPDATED') {
    (async () => {
      await updateBadge();
      const flushed = await flushQueue();
      sendResponse({ ok: true, flushed });
    })();
    return true;
  }

  if (msg.type === 'QUEUE_PAYLOAD') {
    (async () => {
      try {
        const queueLength = await addQueueItem(msg.payload);
        sendResponse({ ok: true, queued: true, queueLength });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'UPLOAD_PAYLOAD') {
    (async () => {
      try {
        const resp = await postPayload(msg.payload);
        if (resp && (resp.ok || resp.duplicate)) {
          sendResponse(resp);
          return;
        }
        sendResponse({
          ...(resp || {}),
          ok: false,
          error: resp?.error || 'Server rejected import',
        });
        return;
      } catch (err) {
        if (!msg.settings?.offlineQueue) {
          sendResponse({ ok: false, error: String(err) });
          return;
        }
      }

      if (msg.settings?.offlineQueue) {
        try {
          const queueLength = await addQueueItem(msg.payload);
          sendResponse({ ok: false, queued: true, queueLength });
        } catch (queueErr) {
          sendResponse({ ok: false, error: String(queueErr) });
        }
      } else {
        sendResponse({ ok: false, error: 'Network error' });
      }
    })();
    return true;
  }

  // ── DOWNLOAD_PHOTO handler (v4.0) ──────────────────────────
  // Content script sends { type: 'DOWNLOAD_PHOTO', url } and
  // receives { ok: true, dataUri, contentType, ext } or { ok: false }.
  if (msg.type === 'DOWNLOAD_PHOTO') {
    (async () => {
      try {
        const result = await downloadPhoto(msg.url);
        if (result) {
          sendResponse({ ok: true, ...result });
        } else {
          sendResponse({ ok: false, error: 'Download failed' });
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'TRANSFER_PHOTOS') {
    (async () => {
      try {
        const pipelineId = msg.pipeline_id;
        if (!pipelineId) {
          sendResponse({ ok: false, error: 'pipeline_id is required' });
          return;
        }
        const resp = await fetch(
          'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/import-pipeline-photos?secret=' + encodeURIComponent(SECRET),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pipeline_id: pipelineId }),
          }
        );
        const body = await resp.json().catch(() => ({}));
        sendResponse({ ok: true, ...body });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'FLUSH_QUEUE') {
    (async () => {
      const flushed = await flushQueue();
      sendResponse({ ok: true, flushed });
    })();
    return true;
  }
});

// Flush queue when network comes back online
try {
  if (typeof navigator !== 'undefined' && navigator.onLine !== undefined) {
    self.addEventListener('online', async () => { await flushQueue(); });
  }
} catch (_) {}