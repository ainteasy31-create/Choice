// /js/listings.js
  // Extracted from listings.html (issue #26). Loaded as <script type="module">.
  // Depends on globals provided by:
  //   - /js/cp-ui.js  -> CP.UI.esc, window.showToast, window.setupScrollTop
  //   - /js/cp-api.js -> CP.API (loaded as module)
  //   - /js/components.js, /js/card-builder.js
  // External-script CSP allows 'self' so no nonce is required for this file.

  // esc, showToast, setupScrollTop come from /js/cp-ui.js (window globals).
  const esc = (window.CP && CP.UI && CP.UI.esc) || (s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'));

// CSP-safe image load/error handling (inline onload/onerror blocked by Cloudflare CSP nonce policy)
document.addEventListener('load', function(e) {
  if (e.target.tagName === 'IMG') e.target.classList.add('cp-img-loaded');
}, true);
document.addEventListener('error', function(e) {
  var t = e.target;
  if (t.tagName !== 'IMG') return;
  t.classList.add('cp-img-loaded');
  if (t.src !== location.origin + '/assets/placeholder-property.jpg') {
    t.src = '/assets/placeholder-property.jpg';
  }
}, true);

// ── State ────────────────────────────────────────────────────────────────
let activeType     = 'all';
let activeBeds     = '';
let activeMaxRent  = '';
let activeMinRent  = '';
let activeSearch   = '';
let activeMinBaths = '';
let activeLaundry  = '';
let activeHeating  = '';
let activePetType  = '';
let sortBy         = 'newest';
let currentPage    = 1;
let totalPages     = 1;
let totalCount     = 0;
let currentView    = 'list';
let isLoading      = false;
let mapInstance    = null;
let mapMarkers     = [];
let savedIds       = loadSavedIds();
// Phase C: cache the rows from the most-recent fetch so the
// click-anywhere-on-card handler can build the canonical slug URL
// without a second API call.
let pageProperties = [];
const PER_PAGE     = 24;

function loadSavedIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem('cp_saved') || '[]'));
  } catch {
    localStorage.removeItem('cp_saved');
    return new Set();
  }
}

async function waitForCP(timeoutMs = 8000) {
  const start = Date.now();
  while (!window.CP?.Properties || !window.CP?.UI || !window.CONFIG) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Listing dependencies did not load. Please refresh the page.');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function fmtRent(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `$${n.toLocaleString()}` : 'Rent TBD';
}

// ── Read URL → state ──────────────────────────────────────────────────────
function readURL() {
  const p = new URLSearchParams(window.location.search);
  activeSearch   = p.get('q')        || '';
  activeBeds     = p.get('beds')     || '';
  activeMaxRent  = p.get('maxrent')  || '';
  activeMinRent  = p.get('minrent')  || '';
  activeMinBaths = p.get('minbaths') || '';
  activeType     = p.get('type')     || 'all';
  sortBy         = p.get('sort')     || 'newest';
  currentPage    = parseInt(p.get('page') || '1', 10);
}

// ── Write state → URL ─────────────────────────────────────────────────────
function pushURL(replace = false) {
  const p = new URLSearchParams();
  if (activeSearch)   p.set('q',        activeSearch);
  if (activeBeds)     p.set('beds',     activeBeds);
  if (activeMaxRent)  p.set('maxrent',  activeMaxRent);
  if (activeMinRent)  p.set('minrent',  activeMinRent);
  if (activeMinBaths) p.set('minbaths', activeMinBaths);
  if (activeType && activeType !== 'all') p.set('type', activeType);
  if (sortBy && sortBy !== 'newest') p.set('sort', sortBy);
  if (currentPage > 1) p.set('page', currentPage);
  const url = p.toString() ? `?${p}` : window.location.pathname;
  if (replace) history.replaceState(null, '', url);
  else         history.pushState(null, '', url);
}

// ── Sync UI controls to current state ────────────────────────────────────
function syncControls() {
  const si = document.getElementById('searchInput');
  const bf = document.getElementById('bedroomsFilter');
  const ss = document.getElementById('sortSelect');
  if (si) si.value = activeSearch;
  if (bf) bf.value = activeBeds;
  const mrf = document.getElementById('maxRentFilter');
  if (mrf) mrf.value = activeMaxRent;
  if (ss) ss.value = sortBy;
  document.querySelectorAll('.filter-pill[data-filter]').forEach(pill => {
    pill.classList.toggle('active', pill.dataset.filter === activeType);
  });
  const at    = document.getElementById('advTypeFilter');
  const ab    = document.getElementById('advMinBeds');
  const abath = document.getElementById('advMinBaths');
  const amin  = document.getElementById('advMinRent');
  const amax  = document.getElementById('advMaxRent');
  if (at)    at.value    = ['apartment','house','condo','townhouse'].includes(activeType) ? activeType : '';
  if (ab)    ab.value    = activeBeds;
  if (abath) abath.value = activeMinBaths;
  if (amin)  amin.value  = activeMinRent;
  if (amax)  amax.value  = activeMaxRent;
  updateFilterBadge();
}

// ── Boot ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    await waitForCP();
    // Refresh saved IDs from Supabase for authenticated users (non-blocking)
    window.CP.SavedProperties.getIds().then(ids => { savedIds = ids; }).catch(() => {});
    setupScrollTop();
    setupGridDelegation(); // P1-A: wire delegated listeners once at boot
    readURL();
    syncControls();
    setupFilters();
    // Restore filter dropdown state from sessionStorage (for mobile progressive disclosure)
    const filterDropdown = document.getElementById('moreFiltersDropdown');
    if (filterDropdown && sessionStorage.getItem('filters_dropdown_open') === 'true') {
      filterDropdown.classList.add('open');
    }
    await fetchAndRender();
    window.addEventListener('popstate', async () => {
      readURL();
      syncControls();
      await fetchAndRender();
    });
  } catch (err) {
    console.error('Listings boot error:', err);
    renderError(err.message || 'Failed to load listings');
  }
})();

// ── Core fetch ────────────────────────────────────────────────────────────
async function fetchAndRender() {
  if (isLoading) return;
  isLoading = true;

  // ── Use server-injected initial data on first unfiltered page-1 load ──
  // The server embeds window.__INITIAL_LISTINGS__ directly into listings.html
  // so properties paint immediately without waiting for a Supabase round-trip.
  const hasNoFilters = !activeSearch && (activeType === 'all' || !activeType) &&
    !activeBeds && !activeMinRent && !activeMaxRent && !activeMinBaths &&
    !activeLaundry && !activeHeating && !activePetType && currentPage === 1 &&
    sortBy === 'newest';
  // Only use the build-time snapshot when it has actual rows.
  // If rows is empty (build happened before listings were active, or Supabase
  // was slow during deploy), fall through to the live API call below so
  // users always see the current state of the database.
  if (hasNoFilters && window.__INITIAL_LISTINGS__ && window.__INITIAL_LISTINGS__.rows?.length > 0) {
    const cached = window.__INITIAL_LISTINGS__;
    window.__INITIAL_LISTINGS__ = null; // consume once; filter changes use live API
    isLoading = false;
    const { rows, total, total_pages } = cached;
    totalCount = total;
    totalPages = total_pages;
    pageProperties = rows || [];
    renderProperties(rows);
    renderPagination();
    return;
  }
  // Discard empty snapshot so live API takes over
  if (window.__INITIAL_LISTINGS__) window.__INITIAL_LISTINGS__ = null;

  showSkeletons();

  // Swap min/max rent if user entered them backwards — prevents silent empty results
    if (activeMinRent && activeMaxRent) {
      const _minR = parseFloat(activeMinRent);
      const _maxR = parseFloat(activeMaxRent);
      if (!isNaN(_minR) && !isNaN(_maxR) && _minR > _maxR) {
        activeMinRent = String(_maxR);
        activeMaxRent = String(_minR);
        const minEl = document.getElementById('advMinRent');
        const maxEl = document.getElementById('advMaxRent');
        if (minEl) minEl.value = activeMinRent;
        if (maxEl) maxEl.value = activeMaxRent;
      }
    }

    try {
    const fetchTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out. Please check your connection and try again.')), 10000)
    );
    const result = await Promise.race([
      CP.Properties.getListings({
        q:            activeSearch,
        type:         activeType,
        beds:         activeBeds,
        min_baths:    activeMinBaths,
        min_rent:     activeMinRent,
        max_rent:     activeMaxRent,
        laundry_type: activeLaundry,
        heating_type: activeHeating,
        pet_type:     activePetType,
        sort:         sortBy,
        page:      currentPage,
        per_page:  PER_PAGE,
      }),
      fetchTimeout,
    ]);

    if (!result.ok) {
      console.error('Failed to load listings:', result.error);
      if (subheading) {
        subheading.innerHTML = '<span style="color:var(--color-error);font-size:0.9rem;"><i class="fas fa-exclamation-circle"></i> Unable to load listings. Please try again.</span>';
      }
      renderError();
      return;
    }

    const { rows, total, total_pages } = result.data;
    totalCount = total;
    totalPages = total_pages;
    pageProperties = rows || [];

    renderProperties(rows);
    renderPagination();
    if (currentView === 'map') initMap(rows);
  } catch (err) {
    console.error('fetchAndRender error:', err);
    renderError(err?.message);
  } finally {
    isLoading = false;
  }
}

// ── Trigger search (resets to page 1) ─────────────────────────────────────
async function refreshResults() {
  currentPage = 1;
  pushURL();
  await fetchAndRender();
}

// ── Skeletons ─────────────────────────────────────────────────────────────
function showSkeletons() {
  const grid = document.getElementById('propertyGrid');
  const sk = (w1, w2, w3) => `
    <div class="property-card property-card-skeleton">
      <div class="property-card-img skeleton-img skeleton"></div>
      <div class="property-card-body" style="gap:10px;padding:20px">
        <div class="skeleton skeleton-line" style="height:26px;width:${w1}%"></div>
        <div class="skeleton skeleton-line" style="width:${w2}%"></div>
        <div class="skeleton skeleton-line" style="width:${w3}%"></div>
        <div class="skeleton skeleton-line" style="height:12px;width:40%;margin-top:8px"></div>
      </div>
    </div>`;
  grid.innerHTML = [sk(35,80,55),sk(38,75,60),sk(32,85,50),sk(40,78,58),sk(36,82,52),sk(34,76,62)].join('');
  const pg = document.getElementById('paginationBar');
  if (pg) pg.innerHTML = '';
}

// ── updateNav ─────────────────────────────────────────────────────────────
async function updateNav() {
  const session    = await CP.Auth.getSession();
  const authLink   = document.getElementById('navAuthLink');
  const drawerLink = document.getElementById('drawerAuthLink');
  const drawerListLink = document.getElementById('drawerListPropertyLink');
  const dest  = session ? '/landlord/dashboard.html' : '/landlord/login.html';
  const label = session ? 'My Dashboard' : 'Landlord Login';
  if (authLink)   { authLink.href = dest;   authLink.textContent = label; }
  if (drawerLink) { drawerLink.href = dest; drawerLink.textContent = label; }
  if (session && drawerListLink) drawerListLink.href = '/landlord/new-listing.html';
  if (window.CONFIG) {
    const footerEmail = document.getElementById('drawerFooterEmail');
    if (footerEmail) { footerEmail.href = `mailto:${CONFIG.COMPANY_EMAIL}`; footerEmail.textContent = CONFIG.COMPANY_EMAIL; }
    document.querySelectorAll('[data-cfg-email]').forEach(el => { el.href = `mailto:${CONFIG.COMPANY_EMAIL}`; el.textContent = CONFIG.COMPANY_EMAIL; });
    document.querySelectorAll('[data-cfg-phone]').forEach(el => { el.href = `tel:${CONFIG.COMPANY_PHONE.replace(/\D/g,'')}`; el.textContent = CONFIG.COMPANY_PHONE; });
  }
}

// ── renderProperties ──────────────────────────────────────────────────────
function renderProperties(props) {
  const grid      = document.getElementById('propertyGrid');
  if (!grid) return;
  const heading   = document.getElementById('listingsHeading');
  const hasFilters = activeType !== 'all' || activeSearch || activeBeds || activeMaxRent || activeMinRent || activeMinBaths;

  if (heading) heading.textContent = hasFilters
    ? 'Results'
    : 'All Listings';

  if (!props.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;text-align:center;padding:var(--s-16) var(--s-6)">
        <div class="empty-state-icon"><i class="fas fa-search" style="font-size:40px;color:var(--color-text-muted)"></i></div>
        <h3 style="margin:var(--s-4) 0 var(--s-2)">No listings match your filters</h3>
        <p style="color:var(--color-text-secondary)">Try adjusting your search or <button onclick="window.clearAllFilters()" style="background:none;border:none;color:var(--color-brand);cursor:pointer;font-size:inherit;padding:0;text-decoration:underline">clearing all filters</button></p>
      </div>`;
    return;
  }

  grid.innerHTML = props.map(p => buildCard(p)).join('');

  // Mark saved state only — click events handled by delegated listeners (P1-A)
  grid.querySelectorAll('.property-card-save').forEach(btn => {
    if (savedIds.has(btn.dataset.id)) { btn.classList.add('saved'); btn.innerHTML = '<i class="fas fa-heart"></i>'; }
  });

  lazyInitCarousels(grid); // P1-C: initialize carousels only as cards enter viewport
  animateCards();
}

// ── Pagination ────────────────────────────────────────────────────────────
function renderPagination() {
  const bar = document.getElementById('paginationBar');
  if (!bar) return;
  if (totalPages <= 1) { bar.innerHTML = ''; return; }

  const show   = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1].filter(n => n >= 1 && n <= totalPages));
  const sorted = [...show].sort((a, b) => a - b);

  let html = `<div class="pagination">`;
  html += `<button class="pg-btn pg-prev" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}" aria-label="Previous page"><i class="fas fa-chevron-left"></i></button>`;
  let prev = 0;
  for (const n of sorted) {
    if (prev && n - prev > 1) html += `<span class="pg-ellipsis">…</span>`;
    html += `<button class="pg-btn${n === currentPage ? ' pg-active' : ''}" data-page="${n}">${n}</button>`;
    prev = n;
  }
  html += `<button class="pg-btn pg-next" ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}" aria-label="Next page"><i class="fas fa-chevron-right"></i></button>`;
  html += `</div>`;
  bar.innerHTML = html;

  bar.querySelectorAll('.pg-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      currentPage = parseInt(btn.dataset.page);
      pushURL();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await fetchAndRender();
    });
  });
}

/* ─── Build card ─── */
// Delegates to the unified card builder in /js/card-builder.js
function buildCard(p) {
  return buildPropertyCard(p);
}

/* ─── Animate Cards ─── */
function animateCards() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.querySelectorAll('.property-card:not(.property-card-skeleton)').forEach(c => c.classList.add('cp-card-visible'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('cp-card-visible'); observer.unobserve(e.target); }
    });
  }, { threshold: 0.06 });
  let i = 0;
  document.querySelectorAll('.property-card:not(.property-card-skeleton)').forEach(card => {
    card.style.setProperty('--cp-delay', Math.min(i * 55, 320) + 'ms');
    observer.observe(card);
    i++;
  });
}

/* ─── Carousel ─── */
// Delegates to the unified carousel in /js/card-builder.js
function initCarousel(card) {
  initCardCarousel(card);
}

/* ─── P1-A: Grid event delegation ───────────────────────────────────────────
   Set up once at boot — survives every re-render without re-attaching.
   Replaces 72+ per-card listeners (save × 24, share × 24, click-through × 24)
   with 4 permanent listeners on the container.
   ─────────────────────────────────────────────────────────────────────────── */
function setupGridDelegation() {
  const grid = document.getElementById('propertyGrid');
  if (!grid || grid._delegated) return;
  grid._delegated = true;

  // Save (heart)
  grid.addEventListener('click', e => {
    const btn = e.target.closest('.property-card-save');
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    toggleSave(btn.dataset.id, btn);
  });

  // Share — native share API / clipboard fallback
  grid.addEventListener('click', e => {
    const btn = e.target.closest('.property-card-share');
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    const url   = location.origin + btn.dataset.url;
    const title = btn.dataset.title || 'Check out this property';
    if (navigator.share) {
      navigator.share({ title, url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(url)
        .then(() => showToast('Link copied to clipboard!', 'success'))
        .catch(() => showToast('Could not copy link', 'error'));
    }
  });

  // Card click-through (not on links or buttons).
  // Phase C: Navigate to the canonical slug URL using the property data
  // we already cached from the search response. Falls back to the legacy
  // ?id= URL only when the cached row is missing.
  grid.addEventListener('click', e => {
    if (e.target.closest('a, button')) return;
    const card = e.target.closest('.property-card');
    if (!card) return;
    const id = card.dataset.id;
    const cached = (pageProperties || []).find(p => p && p.id === id);
    const href = (window.CP && window.CP.UI && window.CP.UI.propertyUrl && cached)
      ? window.CP.UI.propertyUrl(cached)
      : `/property.html?id=${encodeURIComponent(id)}`;
    window.location.href = href;
  });

  // P1-D: Switch non-first slide images from lazy → eager on first hover
  grid.addEventListener('mouseover', e => {
    const card = e.target.closest('.property-card');
    if (!card || card._preloaded) return;
    card._preloaded = true;
    card.querySelectorAll('.property-card-slide img[loading="lazy"]').forEach(img => {
      img.loading = 'eager';
    });
  });
}

/* ─── P1-C: Lazy carousel initialization ────────────────────────────────────
   Defer initCarousel until each card enters a 200px margin around the viewport.
   Cuts JS work at initial render by ~75% on a full 24-card grid.
   ─────────────────────────────────────────────────────────────────────────── */
function lazyInitCarousels(grid) {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        initCarousel(entry.target);
        observer.unobserve(entry.target);
      }
    });
  }, { rootMargin: '200px 0px' });
  grid.querySelectorAll('.property-card').forEach(card => observer.observe(card));
}

/* ─── Map ─── */
// M-10: Leaflet CSS+JS (~180KB gzipped) is loaded on demand only when the
// user clicks "Map View". Saves bandwidth on every listing page visit.
const _LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const _LEAFLET_JS  = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';

function loadLeaflet() {
  return new Promise((resolve, reject) => {
    if (window.L) { resolve(); return; }
    if (!document.querySelector(`link[href="${_LEAFLET_CSS}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = _LEAFLET_CSS;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = _LEAFLET_JS;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      // Remove map loading spinner when Leaflet loads
      const mapSpinner = document.getElementById('mapLoadingSpinner');
      if (mapSpinner) mapSpinner.style.display = 'none';
      resolve();
    };
    script.onerror = () => {
      // Hide spinner on error  
      const mapSpinner = document.getElementById('mapLoadingSpinner');
      if (mapSpinner) mapSpinner.style.display = 'none';
      reject();
    };
    document.head.appendChild(script);
  });
}

function initMap(props) {
  if (!mapInstance) {
    mapInstance = L.map('listingsMap', { zoomControl: false }).setView([39.5, -98.35], 4);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>', maxZoom: 18
    }).addTo(mapInstance);
    L.control.zoom({ position: 'bottomright' }).addTo(mapInstance);
  }
  mapMarkers.forEach(m => m.remove()); mapMarkers = [];
  const bounds = [];
  props.forEach(p => {
    if (!p.lat || !p.lng) return;
    const lat = parseFloat(p.lat), lng = parseFloat(p.lng);
    if (isNaN(lat) || isNaN(lng)) return;
    const safeId = encodeURIComponent(p.id || '');
    const safeTitle = esc(p.title || 'Rental property');
    const safeImg = esc(CONFIG.img(p.photo_urls?.[0] || '','card'));
    const safeRent = Number(p.monthly_rent || 0);
    // Phase C: canonical slug URL when we have the data, legacy URL otherwise.
    const popupHref = esc(
      (window.CP && window.CP.UI && window.CP.UI.propertyUrl)
        ? window.CP.UI.propertyUrl(p)
        : `/property.html?id=${safeId}`
    );
    bounds.push([lat, lng]);
    const icon = L.divIcon({
      className: '',
      html: `<div class="map-marker-price">$${(safeRent/1000).toFixed(safeRent >= 1000 ? 1 : 0)}${safeRent >= 1000 ? 'k' : ''}</div>`,
      iconAnchor: [30, 16], iconSize: [60, 32],
    });
    const marker = L.marker([lat, lng], { icon }).addTo(mapInstance);
    marker.bindPopup(`
      <a href="${popupHref}" class="map-popup-card">
        <img class="map-popup-img" src="${safeImg}" alt="${safeTitle}" loading="lazy">
        <div class="map-popup-body">
          <div class="map-popup-price">$${safeRent.toLocaleString()}<span>/mo</span></div>
          <div class="map-popup-title">${safeTitle}</div>
          <div class="map-popup-meta">
            ${p.bedrooms != null ? `<span>${p.bedrooms === 0 ? 'Studio' : p.bedrooms + ' bd'}</span>` : ''}
            ${p.bathrooms ? `<span>${p.bathrooms} ba</span>` : ''}
          </div>
          <a href="${popupHref}" class="map-popup-apply">View Property →</a>
        </div>
      </a>`, { maxWidth: 260 });
    mapMarkers.push(marker);
  });
  if (bounds.length) mapInstance.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  setTimeout(() => mapInstance.invalidateSize(), 50);
}

/* ─── View toggle ─── */
document.getElementById('btnListView').addEventListener('click', () => {
  currentView = 'list';
  document.getElementById('listPanel').style.display = '';
  document.getElementById('mapPanel').style.display = 'none';
  document.getElementById('btnListView').classList.add('active');
  document.getElementById('btnMapView').classList.remove('active');
});
document.getElementById('btnMapView').addEventListener('click', async () => {
  currentView = 'map';
  document.getElementById('listPanel').style.display = 'none';
  document.getElementById('mapPanel').style.display = 'block';
  document.getElementById('btnMapView').classList.add('active');
  document.getElementById('btnListView').classList.remove('active');
  // Show loading spinner while Leaflet loads
  const mapSpinner = document.getElementById('mapLoadingSpinner');
  if (mapSpinner) mapSpinner.style.display = 'flex';
  // Lazy-load Leaflet on first map view, then fetch and render markers
  await loadLeaflet();
  const result = await CP.Properties.getListings({
    q: activeSearch, type: activeType, beds: activeBeds,
    min_baths: activeMinBaths, min_rent: activeMinRent, max_rent: activeMaxRent,
    sort: sortBy, page: currentPage, per_page: PER_PAGE,
  });
  if (result.ok) initMap(result.data.rows);
});

/* ─── Filters ─── */
function setupFilters() {
  document.querySelectorAll('.filter-pill[data-filter]').forEach(pill => {
    pill.addEventListener('click', () => {
      activeType = pill.dataset.filter;
      refreshResults();
    });
  });

  // Debounce helper — prevents API calls on every keystroke
  function debounce(fn, delay) {
    let timer;
    return function(...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), delay); };
  }
  const debouncedSearch = debounce(doSearch, 400);

  document.getElementById('searchBtn').addEventListener('click', doSearch);
  document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  document.getElementById('searchInput').addEventListener('input', debouncedSearch);
  document.getElementById('bedroomsFilter').addEventListener('change', e => { activeBeds = e.target.value; refreshResults(); });
  document.getElementById('maxRentFilter').addEventListener('change', e => { activeMaxRent = e.target.value; refreshResults(); });
  document.getElementById('sortSelect').addEventListener('change', e => { sortBy = e.target.value; refreshResults(); });

  document.getElementById('moreFiltersBtn').addEventListener('click', e => {
      e.stopPropagation();
      const dropdown = document.getElementById('moreFiltersDropdown');
      dropdown.classList.toggle('open');
      const isOpen = dropdown.classList.contains('open');
      sessionStorage.setItem('filters_dropdown_open', isOpen ? 'true' : 'false');
    });

    // Fix 2: Mobile Filters button opens the same dropdown bottom-sheet
    const mfBtn = document.getElementById('mobileFiltersBtn');
    if (mfBtn) {
      mfBtn.addEventListener('click', e => {
        e.stopPropagation();
        const dropdown = document.getElementById('moreFiltersDropdown');
        dropdown.classList.toggle('open');
        sessionStorage.setItem('filters_dropdown_open', dropdown.classList.contains('open') ? 'true' : 'false');
      });
    }

    // Fix 3: Clear All pill (desktop bar)
    const clearAllPill = document.getElementById('clearAllPill');
    if (clearAllPill) clearAllPill.addEventListener('click', () => window.clearAllFilters());

    // Fix 3: Clear All inside dropdown header (mobile)
    const clearAllMobile = document.getElementById('clearAllMobile');
    if (clearAllMobile) clearAllMobile.addEventListener('click', () => {
      ['advMinBeds','advMinBaths','advMinRent','advMaxRent','advLaundryFilter','advHeatingFilter','advPetTypeFilter'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
      });
      window.clearAllFilters();
      document.getElementById('moreFiltersDropdown').classList.remove('open');
      sessionStorage.setItem('filters_dropdown_open', 'false');
    });
  document.addEventListener('click', e => {
    if (!document.getElementById('moreFiltersWrap').contains(e.target)) {
      document.getElementById('moreFiltersDropdown').classList.remove('open');
      sessionStorage.setItem('filters_dropdown_open', 'false');
    }
  });

  document.getElementById('applyAdvFilters').addEventListener('click', () => {
    activeMinRent  = document.getElementById('advMinRent').value;
    activeMaxRent  = document.getElementById('advMaxRent').value || activeMaxRent;
    activeMinBaths = document.getElementById('advMinBaths').value;
    activeLaundry  = document.getElementById('advLaundryFilter').value;
    activeHeating  = document.getElementById('advHeatingFilter').value;
    activePetType  = document.getElementById('advPetTypeFilter').value;
    const advBeds = document.getElementById('advMinBeds').value;
    if (advBeds !== '') activeBeds = advBeds;
    document.getElementById('moreFiltersDropdown').classList.remove('open');
    sessionStorage.setItem('filters_dropdown_open', 'false');
    refreshResults();
    showToast('Filters applied', 'success');
  });

  document.getElementById('clearAdvFilters').addEventListener('click', () => {
    ['advTypeFilter','advMinBeds','advMinBaths','advMinRent','advMaxRent','advLaundryFilter','advHeatingFilter','advPetTypeFilter'].forEach(id => {
      document.getElementById(id).value = '';
    });
    window.clearAllFilters();
    document.getElementById('moreFiltersDropdown').classList.remove('open');
    sessionStorage.setItem('filters_dropdown_open', 'false');
  });
}

window.clearAllFilters = function() {
  activeType = 'all'; activeSearch = ''; activeBeds = '';
  activeMaxRent = ''; activeMinRent = ''; activeMinBaths = '';
  activeLaundry = ''; activeHeating = ''; activePetType = '';
  sortBy = 'newest'; currentPage = 1;
  syncControls();
  pushURL(true);
  fetchAndRender();
};

function doSearch() {
  activeSearch = document.getElementById('searchInput').value.trim();
  refreshResults();
}

function updateFilterBadge() {
    const badge = document.getElementById('filterActiveBadge');
    const clearAllPill = document.getElementById('clearAllPill');
    const mobileBadge = document.getElementById('mobileFiltersBadge');
    const count = [activeType && activeType !== 'all', !!activeBeds, !!activeMaxRent, !!activeMinRent, !!activeMinBaths, !!activeSearch, !!activeLaundry, !!activeHeating, !!activePetType].filter(Boolean).length;
    if (badge) { badge.textContent = count || ''; badge.style.display = count > 0 ? 'inline-flex' : 'none'; }
    if (clearAllPill) clearAllPill.style.display = count > 0 ? '' : 'none';
    if (mobileBadge) { mobileBadge.textContent = count || ''; mobileBadge.style.display = count > 0 ? 'inline-flex' : 'none'; }
  }

/* ─── Utilities ─── */
/* setupScrollTop() and showToast() are provided as window globals by /js/cp-ui.js (issue #16 dedup). */

function renderError(errorMsg = 'Failed to load listings') {
  const grid = document.getElementById('propertyGrid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="empty-state" style="grid-column:1/-1;text-align:center;padding:var(--space-16) var(--space-6)">
      <div class="empty-state-icon"><i class="fas fa-exclamation-triangle" style="font-size:48px;color:var(--color-error);margin-bottom:16px;opacity:0.7"></i></div>
      <h3 style="margin:var(--space-4) 0 var(--space-2);color:var(--color-text-primary);font-size:1.1rem">Something went wrong</h3>
      <p style="color:var(--color-text-secondary);margin-bottom:24px;max-width:360px;margin-left:auto;margin-right:auto;line-height:1.5">
        ${errorMsg || 'We couldn\'t load listings from the server. Please check your connection and try again.'}
      </p>
      <button onclick="refreshResults()" style="background:var(--color-brand);color:#fff;border:none;border-radius:8px;padding:12px 28px;cursor:pointer;font-size:0.9rem;font-weight:500;transition:background 160ms ease">
        <i class="fas fa-redo" style="margin-right:6px"></i>Retry
      </button>
    </div>`;
}


// showToast() is provided as a window global by /js/cp-ui.js (issue #16 dedup).

async function toggleSave(id, btn) {
  btn.disabled = true;
  try {
    const { saved } = await window.CP.SavedProperties.toggle(id);
    if (saved) {
      savedIds.add(id);
      btn.classList.add('saved');
      btn.innerHTML = '<i class="fas fa-heart"></i>';
      showToast('Property saved!', 'success');
    } else {
      savedIds.delete(id);
      btn.classList.remove('saved');
      btn.innerHTML = '<i class="far fa-heart"></i>';
    }
  } catch(_) {
    // Fallback: localStorage only
    if (savedIds.has(id)) {
      savedIds.delete(id); btn.classList.remove('saved'); btn.innerHTML = '<i class="far fa-heart"></i>';
    } else {
      savedIds.add(id); btn.classList.add('saved'); btn.innerHTML = '<i class="fas fa-heart"></i>';
      showToast('Property saved!', 'success');
    }
    localStorage.setItem('cp_saved', JSON.stringify([...savedIds]));
  } finally {
    btn.disabled = false;
  }
}

/* ─── Mobile Drawer ─── */
