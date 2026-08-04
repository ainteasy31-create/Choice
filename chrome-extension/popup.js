// ============================================================
// Import to Choice Properties — Popup Script v2.0
// ============================================================

(async function () {
  try {
    // Query the active tab to see context
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

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

    // Get session count from badge
    const badgeText = await chrome.action.getBadgeText({});
    const count = parseInt(badgeText, 10) || 0;
    countEl.textContent = count > 0 ? String(count) : '0';

    // Queue status
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
    const settings = await chrome.storage.local.get({ cp_settings: { downloadToPC: true, offlineQueue: true } });
    const s = settings.cp_settings;

    const dlToggle = document.getElementById('toggle-download');
    const oqToggle = document.getElementById('toggle-queue');
    dlToggle.checked = s.downloadToPC;
    oqToggle.checked = s.offlineQueue;

    const save = async () => {
      await chrome.storage.local.set({
        cp_settings: { downloadToPC: dlToggle.checked, offlineQueue: oqToggle.checked }
      });
    };
    dlToggle.addEventListener('change', save);
    oqToggle.addEventListener('change', save);
  } catch (e) {
    console.warn('[CP Popup]', e);
  }
})();
