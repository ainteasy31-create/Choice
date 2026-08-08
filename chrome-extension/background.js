// ============================================================
// Import to Choice Properties — Background Service Worker v2.0
// Tracks session count, flushes the offline queue when online,
// and updates the extension badge.
// ============================================================

// Load project config (credentials & endpoints — see config.js)
importScripts('config.js');

const EDGE_URL = CP_CONFIG.EDGE_URL;
const SECRET   = CP_CONFIG.IMPORT_SECRET;
const ALARM_NAME = 'flushQueue';
const MAX_QUEUE_ITEMS = 75;

async function getCount() {
  const data = await chrome.storage.session.get({ sessionCount: 0 });
  return data.sessionCount;
}

async function getQueue() {
  const data = await chrome.storage.local.get({ cp_queue: [] });
  return data.cp_queue || [];
}

async function setQueue(queue) {
  await chrome.storage.local.set({ cp_queue: queue });
}

function queueItemKey(item) {
  return `${item.source || 'unknown'}|${item.source_listing_id || 'unknown'}`;
}

function trimQueue(queue) {
  if (queue.length <= MAX_QUEUE_ITEMS) return queue;
  return queue.slice(-MAX_QUEUE_ITEMS);
}

async function addQueueItem(item) {
  const queue = await getQueue();
  const exists = queue.some(q => queueItemKey(q) === queueItemKey(item));
  if (exists) return queue.length;
  queue.push(Object.assign({}, item, { _queued_at: Date.now() }));
  const trimmed = trimQueue(queue);
  await setQueue(trimmed);
  await updateBadge();
  return trimmed.length;
}

function getPhotoUrls(payload) {
  let urls = [];
  if (Array.isArray(payload.original_image_urls)) {
    urls = payload.original_image_urls;
  } else if (typeof payload.original_image_urls === 'string') {
    try { urls = JSON.parse(payload.original_image_urls); } catch (_) { urls = [payload.original_image_urls]; }
  }
  return Array.isArray(urls) ? urls.filter(u => typeof u === 'string' && u.startsWith('http')) : [];
}

function extractExtension(url) {
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.(jpe?g|png|gif|webp|avif|bmp)(?:$|\?)/i);
    return match ? match[1].toLowerCase() : 'jpg';
  } catch (_) {
    return 'jpg';
  }
}

async function downloadToPC(payload) {
  const id = payload.source_listing_id || String(Date.now());
  const folder = `ChoiceImports/${id}`;

  const jsonBlob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const jsonUrl = URL.createObjectURL(jsonBlob);
  await chrome.downloads.download({ url: jsonUrl, filename: `${folder}/listing.json`, saveAs: false });
  setTimeout(() => URL.revokeObjectURL(jsonUrl), 60000);

  const photos = getPhotoUrls(payload).slice(0, 50);
  for (let i = 0; i < photos.length; i++) {
    const photoUrl = photos[i];
    const ext = extractExtension(photoUrl);
    try {
      await chrome.downloads.download({
        url: photoUrl,
        filename: `${folder}/photos/photo-${String(i + 1).padStart(2, '0')}.${ext}`,
        saveAs: false,
      });
    } catch (err) {
      console.warn('[CP] background photo download failed:', photoUrl, err);
    }
  }
}

async function setCount(n) {
  await chrome.storage.session.set({ sessionCount: n });
}

async function updateBadge() {
  const data = await chrome.storage.local.get({ cp_queue: [] });
  const q = data.cp_queue || [];
  if (q.length > 0) {
    chrome.action.setBadgeText({ text: String(q.length) });
    chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
  } else {
    const n = await getCount();
    if (n > 0) {
      chrome.action.setBadgeText({ text: String(n) });
      chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  }
}

// ── Offline queue flush ─────────────────────────────────────────────────────

async function postPayload(payload) {
  const res = await fetch(EDGE_URL, {
    method:  'POST',
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
  const data = await chrome.storage.local.get({ cp_queue: [] });
  const queue = data.cp_queue || [];
  if (queue.length === 0) return;

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
    await chrome.storage.local.set({ cp_queue: remaining });
  } else {
    await chrome.storage.local.set({ cp_queue: [] });
    if (flushed > 0) {
      await setCount((await getCount()) + flushed);
    }
  }
  await updateBadge();
  return flushed;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SAVED') {
    (async () => {
      const n = (await getCount()) + 1;
      await setCount(n);
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
        // The request reached the server, so preserve its actionable error.
        // Only actual fetch failures should enter the offline queue.
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

  if (msg.type === 'DOWNLOAD_PAYLOAD') {
    (async () => {
      try {
        await downloadToPC(msg.payload);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'TRANSFER_PHOTOS') {
    (async () => {
      try {
        const { pipeline_id, property_id } = msg;
        // Trigger the import-pipeline-photos Edge Function
        const resp = await postPayload({
          source_listing_id: pipeline_id,
          source: 'chrome-extension',
          _import: 'browser-extension-v2',
        });
        sendResponse(resp);
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

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    flushQueue().catch(err => console.warn('[CP] alarm flushQueue failed:', err));
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await setCount(0);
  chrome.action.setBadgeText({ text: '' });
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 15 });
  await updateBadge();
  await flushQueue();
});

chrome.runtime.onInstalled.addListener(async () => {
  await setCount(0);
  await updateBadge();
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 15 });
  await flushQueue();
});

// Network status change — flush queue when back online
if (typeof navigator !== 'undefined' && navigator.onLine !== undefined) {
  self.addEventListener('online', async () => { await flushQueue(); });
}
