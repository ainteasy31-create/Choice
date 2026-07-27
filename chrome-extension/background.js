// ============================================================
// Import to Choice Properties — Background Service Worker
// Tracks how many listings have been saved this session
// and updates the extension badge count.
// ============================================================

let sessionCount = 0;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SAVED') {
    sessionCount++;
    chrome.action.setBadgeText({ text: String(sessionCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
  }
});

// Clear badge when browser session starts
chrome.runtime.onStartup.addListener(() => {
  sessionCount = 0;
  chrome.action.setBadgeText({ text: '' });
});
