// ============================================================
// Import to Choice Properties — Popup Script v2.1
// Orion-compatible: handles missing chrome APIs gracefully.
// ============================================================

(async function () {
  try {
    // Query the active tab to see context
    let tab = null;
    try {
      if (chrome.tabs && chrome.tabs.query) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = tabs && tabs[0];
      }
    } catch (_) {}

    const isSupportedListing = tab && tab.url && (
      /zillow\.com\/homedetails\//i.test(tab.url) ||
      /realtor\.com\/realestateandhomes-detail\//i.test(tab.url) ||
      /apartments\.com\//i.test(tab.url) ||
      /redfin\.com\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/]+/i.test(tab.url)
    );

    const countEl   = document.getElementById('session-count');
    const pillEl    = document.getElementById('page-pill');
    const rowEl     = document.getElementById('status-row');
    const tipDef    = document.getElementById('tip-default');
    const tipOn     = document.getElementById('tip-on-listing');
    const queueRow  = document.getElementById('queue-row');
    const queueCount = document.getElementById('queue-count');
    const flushBtn  = document.getElementById('flush-btn');

    // Get session count from badge (fallback to "—" if API not available)
    let count = 0;
    try {
      if (chrome.action && chrome.action.getBadgeText) {
        const badgeText = await chrome.action.getBadgeText({});
        count = parseInt(badgeText, 10) || 0;
      }
    } catch (_) {}
    countEl.textContent = count > 0 ? String(count) : '0';

    // Queue status
    try {
      if (chrome.storage && chrome.storage.local) {
        const data = await chrome.storage.local.get({ cp_queue: [] });
        const queue = data.cp_queue || [];
        if (queue.length > 0) {
          queueRow.style.display = 'flex';
          queueCount.textContent = String(queue.length);
          flushBtn.disabled = false;
        } else {
          queueRow.style.display = 'none';
        }

        flushBtn.addEventListener('click', async () => {
          flushBtn.disabled = true;
          flushBtn.textContent = 'Syncing…';
          try {
            await chrome.runtime.sendMessage({ type: 'FLUSH_QUEUE' });
          } catch (_) {}
          setTimeout(() => window.close(), 800);
        });
      }
    } catch (_) {}

    if (isSupportedListing) {
      pillEl.textContent = '✓ On supported listing';
      pillEl.className = 'pill';
      rowEl.className = 'status-row on-listing';
      tipDef.style.display = 'none';
      tipOn.style.display  = 'block';
    } else {
      pillEl.textContent = 'Not on listing';
      pillEl.className = 'pill inactive';
    }

    // ── Settings toggles ──────────────────────────────────────
    try {
      let s = { downloadToPC: true, offlineQueue: true };
      if (chrome.storage && chrome.storage.local) {
        const settings = await chrome.storage.local.get({ cp_settings: { downloadToPC: true, offlineQueue: true } });
        s = settings.cp_settings || s;
      }

      const dlToggle = document.getElementById('toggle-download');
      const oqToggle = document.getElementById('toggle-queue');
      dlToggle.checked = s.downloadToPC;
      oqToggle.checked = s.offlineQueue;

      const save = async () => {
        try {
          if (chrome.storage && chrome.storage.local) {
            await chrome.storage.local.set({
              cp_settings: { downloadToPC: dlToggle.checked, offlineQueue: oqToggle.checked }
            });
          }
        } catch (_) {}
      };
      dlToggle.addEventListener('change', save);
      oqToggle.addEventListener('change', save);
    } catch (_) {}
  } catch (e) {
    console.warn('[CP Popup]', e);
  }
})();