// ============================================================
// Import to Choice Properties — Popup Script
// ============================================================

(async function () {
  // Check how many saved this session (from badge text)
  try {
    const { action } = chrome;
    // Query the active tab to see if we're on a Zillow listing page
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isZillowListing = tab && tab.url && /zillow\.com\/homedetails\/.+_zpid/.test(tab.url);

    const countEl   = document.getElementById('session-count');
    const pillEl    = document.getElementById('page-pill');
    const rowEl     = document.getElementById('status-row');
    const tipDef    = document.getElementById('tip-default');
    const tipOn     = document.getElementById('tip-on-listing');

    // Get session count from badge
    const badgeText = await chrome.action.getBadgeText({});
    const count = parseInt(badgeText, 10) || 0;
    countEl.textContent = count > 0 ? String(count) : '0';

    if (isZillowListing) {
      pillEl.textContent = '✓ On Zillow listing';
      pillEl.className = 'pill';
      rowEl.className = 'status-row on-listing';
      tipDef.style.display = 'none';
      tipOn.style.display  = 'block';
    } else {
      pillEl.textContent = 'Not on Zillow listing';
      pillEl.className = 'pill inactive';
    }
  } catch (e) {
    // Permissions or API not available
    console.warn('[CP Popup]', e);
  }
})();
