// ============================================================
// Import to Choice Properties — Background Service Worker v2.0
// Tracks session count, flushes the offline queue when online,
// and updates the extension badge.
// ============================================================

const EDGE_URL = 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
const SECRET   = 'cp_import_7Kx3m9P2w5';

async function getCount() {
  const data = await chrome.storage.session.get({ sessionCount: 0 });
  return data.sessionCount;
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

async function flushQueue() {
  const data = await chrome.storage.local.get({ cp_queue: [] });
  const queue = data.cp_queue || [];
  if (queue.length === 0) return;

  const remaining = [];
  let flushed = 0;

  for (const item of queue) {
    try {
      const res = await fetch(EDGE_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-import-secret': SECRET },
        body:    JSON.stringify(item),
      });
      const resp = await res.json();
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

  if (msg.type === 'FLUSH_QUEUE') {
    (async () => {
      const flushed = await flushQueue();
      sendResponse({ ok: true, flushed });
    })();
    return true;
  }
});

// Retry queue when the browser comes back online
chrome.runtime.onStartup.addListener(async () => {
  await setCount(0);
  chrome.action.setBadgeText({ text: '' });
  await updateBadge();
  await flushQueue();
});

// On install/update, clear any stale badge and flush
chrome.runtime.onInstalled.addListener(async () => {
  await setCount(0);
  await updateBadge();
  await flushQueue();
});

// Network status change — flush queue when back online
if (typeof navigator !== 'undefined' && navigator.onLine !== undefined) {
  self.addEventListener('online', async () => { await flushQueue(); });
}

// Periodic retry (every 15 min) so queued items eventually sync
setInterval(async () => { await flushQueue(); }, 15 * 60 * 1000);
