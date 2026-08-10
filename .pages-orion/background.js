// ============================================================
// Import to Choice Properties — Background Service Worker v2.1
// Orion-compatible: no importScripts, no alarms dependency.
// ============================================================

// Inline config (Orion doesn't reliably support importScripts)
// Read from window.CP_CONFIG (set by config.js) with fallback
// to hardcoded values for backward compatibility with already-installed extensions.
const EDGE_URL = (typeof window !== 'undefined' && window.CP_CONFIG && window.CP_CONFIG.EDGE_URL) || 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
const SECRET   = (typeof window !== 'undefined' && window.CP_CONFIG && window.CP_CONFIG.IMPORT_SECRET) || 'cp_import_7Kx3m9P2w5';
const MAX_QUEUE_ITEMS = 75;

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