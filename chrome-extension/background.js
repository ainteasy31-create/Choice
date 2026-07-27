// ============================================================
// Import to Choice Properties — Background Service Worker
// Tracks how many listings have been saved this session
// and updates the extension badge count.
// Uses chrome.storage.session so the count survives MV3
// service-worker suspension/wake cycles.
// ============================================================

async function getCount() {
  const data = await chrome.storage.session.get({ sessionCount: 0 });
  return data.sessionCount;
}

async function setCount(n) {
  await chrome.storage.session.set({ sessionCount: n });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SAVED') {
    (async () => {
      const n = (await getCount()) + 1;
      await setCount(n);
      chrome.action.setBadgeText({ text: String(n) });
      chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
      sendResponse({ ok: true, count: n });
    })();
    return true; // keep message channel open for async response
  }
});

// Restore badge on service-worker restart (e.g. browser reopen)
chrome.runtime.onStartup.addListener(async () => {
  await setCount(0);
  chrome.action.setBadgeText({ text: '' });
});

// On install/update, clear any stale badge
chrome.runtime.onInstalled.addListener(() => {
  setCount(0);
  chrome.action.setBadgeText({ text: '' });
});
