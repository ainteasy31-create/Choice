/* ============================================================
   Choice Properties — Mobile Sticky Search (Phase L2)
   ------------------------------------------------------------
   On viewports ≤768px, after the hero search scrolls out of
   view, a sticky pill appears at the top of the viewport.
   Tapping it opens a full-screen sheet with the same search
   fields. On submit, values are copied back to the original
   hero form and #searchBtn.click() is fired so the existing
   navigation logic (goToListings) runs unchanged.

   ESC closes, swipe-down-on-handle closes, tap-outside closes.
   Focus trap while open. Body scroll lock while open.
   Respects prefers-reduced-motion.

   No external dependencies. Loaded as a deferred <script>.
   ============================================================ */
(function () {
  'use strict';

  var MOBILE_QUERY = '(max-width: 768px)';
  var pill, sheet, sheetBackdrop, originalSearchForm, originalSearchBtn;
  var mLocation, mBeds, mPrice, mForm, mClose, mHandle;
  var lastFocus = null;
  var observer = null;
  var isMobile = false;

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }

  function init() {
    pill              = $('.mv2-msearch-pill');
    sheet             = $('.mv2-msearch-sheet');
    sheetBackdrop     = $('.mv2-msearch-sheet-backdrop');
    originalSearchForm = $('.mv2-hero__search');
    originalSearchBtn = document.getElementById('searchBtn');

    if (!pill || !sheet || !originalSearchForm || !originalSearchBtn) return;

    mLocation = document.getElementById('m-searchInput');
    mBeds     = document.getElementById('m-bedroomsFilter');
    mPrice    = document.getElementById('m-maxRentFilter');
    mForm     = $('.mv2-msearch-sheet__form');
    mClose    = $('.mv2-msearch-sheet__close');
    mHandle   = $('.mv2-msearch-sheet__handle');

    isMobile = window.matchMedia(MOBILE_QUERY).matches;
    setupObserver();
    bindEvents();
    window.matchMedia(MOBILE_QUERY).addEventListener
      ? window.matchMedia(MOBILE_QUERY).addEventListener('change', onViewportChange)
      : window.matchMedia(MOBILE_QUERY).addListener(onViewportChange);
  }

  function onViewportChange(e) {
    isMobile = e.matches;
    if (!isMobile) {
      hidePill();
      closeSheet();
    } else {
      setupObserver();
    }
  }

  /* ── Show pill once the hero search has scrolled out of view ── */
  function setupObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    if (!isMobile) return;
    if (!('IntersectionObserver' in window)) {
      // Fallback: always show on mobile after a small scroll
      window.addEventListener('scroll', onScrollFallback, { passive: true });
      return;
    }
    observer = new IntersectionObserver(function (entries) {
      var e = entries[0];
      if (!e) return;
      if (e.isIntersecting) hidePill();
      else showPill();
    }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });
    observer.observe(originalSearchForm);
  }

  function onScrollFallback() {
    if (window.scrollY > 320) showPill(); else hidePill();
  }

  function showPill() {
    if (!isMobile) return;
    pill.setAttribute('data-visible', 'true');
  }
  function hidePill() {
    pill.setAttribute('data-visible', 'false');
  }

  /* ── Sheet open / close ──────────────────────────────────────── */
  function openSheet() {
    if (!isMobile) return;
    syncFromOriginal();
    lastFocus = document.activeElement;
    sheet.setAttribute('data-open', 'true');
    sheetBackdrop.setAttribute('data-open', 'true');
    document.body.style.overflow = 'hidden';
    sheet.setAttribute('aria-hidden', 'false');
    // Focus the location input shortly after the open animation
    window.setTimeout(function () { if (mLocation) mLocation.focus(); }, 220);
    document.addEventListener('keydown', onKey);
  }

  function closeSheet() {
    sheet.setAttribute('data-open', 'false');
    sheetBackdrop.setAttribute('data-open', 'false');
    document.body.style.overflow = '';
    sheet.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onKey);
    if (lastFocus && lastFocus.focus) {
      try { lastFocus.focus(); } catch (_) {}
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
    if (e.key === 'Tab') trapFocus(e);
  }

  function trapFocus(e) {
    var focusables = sheet.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ── Value sync between sheet and original form ─────────────── */
  function syncFromOriginal() {
    var oLoc = document.getElementById('searchInput');
    var oBeds = document.getElementById('bedroomsFilter');
    var oPrice = document.getElementById('maxRentFilter');
    if (oLoc && mLocation) mLocation.value = oLoc.value || '';
    if (oBeds && mBeds) mBeds.value = oBeds.value || '';
    if (oPrice && mPrice) mPrice.value = oPrice.value || '';
  }
  function syncToOriginal() {
    var oLoc = document.getElementById('searchInput');
    var oBeds = document.getElementById('bedroomsFilter');
    var oPrice = document.getElementById('maxRentFilter');
    if (oLoc && mLocation) oLoc.value = mLocation.value || '';
    if (oBeds && mBeds) oBeds.value = mBeds.value || '';
    if (oPrice && mPrice) oPrice.value = mPrice.value || '';
  }

  /* ── Submit: copy values, fire original button ──────────────── */
  function submitSearch(e) {
    if (e) e.preventDefault();
    syncToOriginal();
    closeSheet();
    // Fire original navigation handler (goToListings)
    try { originalSearchBtn.click(); }
    catch (_) {
      // Fallback navigation
      var p = new URLSearchParams();
      if (mLocation && mLocation.value) p.set('q', mLocation.value);
      if (mBeds && mBeds.value) p.set('beds', mBeds.value);
      if (mPrice && mPrice.value) p.set('maxrent', mPrice.value);
      var qs = p.toString();
      window.location.href = '/listings.html' + (qs ? '?' + qs : '');
    }
  }

  /* ── Swipe-down-on-handle to close ──────────────────────────── */
  function bindSwipeClose() {
    if (!mHandle) return;
    var startY = null;
    mHandle.addEventListener('touchstart', function (e) {
      if (!e.touches || !e.touches[0]) return;
      startY = e.touches[0].clientY;
    }, { passive: true });
    mHandle.addEventListener('touchmove', function (e) {
      if (startY === null || !e.touches || !e.touches[0]) return;
      var dy = e.touches[0].clientY - startY;
      if (dy > 60) { closeSheet(); startY = null; }
    }, { passive: true });
    mHandle.addEventListener('touchend', function () { startY = null; }, { passive: true });
  }

  /* ── Wire up everything ─────────────────────────────────────── */
  /* ── Live sync: hero form changes push to the mobile sheet ──── */
  function bindLiveSync() {
    var oLoc  = document.getElementById('searchInput');
    var oBeds = document.getElementById('bedroomsFilter');
    var oPrice = document.getElementById('maxRentFilter');
    var sync = function () { syncFromOriginal(); };
    if (oLoc)  oLoc.addEventListener('input',  sync);
    if (oLoc)  oLoc.addEventListener('change', sync);
    if (oBeds) oBeds.addEventListener('change', sync);
    if (oPrice) oPrice.addEventListener('change', sync);
  }

  function bindEvents() {
    pill.addEventListener('click', openSheet);
    if (mClose) mClose.addEventListener('click', closeSheet);
    if (sheetBackdrop) sheetBackdrop.addEventListener('click', closeSheet);
    if (mForm) mForm.addEventListener('submit', submitSearch);
    bindSwipeClose();
    bindLiveSync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
