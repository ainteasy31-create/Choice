// /js/location-page.js
// Dynamic city+state location page — loaded from listings/location.html
// URL format: /listings/:stateSlug/:citySlug  (e.g. /listings/texas/houston)

// ── State slug → 2-letter code ───────────────────────────────────────────────
const STATE_MAP = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
  'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
  'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
  'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV',
  'new-hampshire':'NH','new-jersey':'NJ','new-mexico':'NM','new-york':'NY',
  'north-carolina':'NC','north-dakota':'ND','ohio':'OH','oklahoma':'OK',
  'oregon':'OR','pennsylvania':'PA','rhode-island':'RI','south-carolina':'SC',
  'south-dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT',
  'vermont':'VT','virginia':'VA','washington':'WA','west-virginia':'WV',
  'wisconsin':'WI','wyoming':'WY','district-of-columbia':'DC'
};

const STATE_NAMES = Object.fromEntries(
  Object.entries(STATE_MAP).map(([slug, code]) => [code, slug
    .split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')])
);

function slugToDisplayName(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── Parse URL ─────────────────────────────────────────────────────────────────
// Expected: /listings/:stateSlug/:citySlug
function parseLocationURL() {
  const parts = window.location.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  // parts = ['listings', 'texas', 'houston']
  if (parts.length < 3 || parts[0] !== 'listings') return null;
  const stateSlug = parts[1];
  const citySlug  = parts[2];
  const stateCode = STATE_MAP[stateSlug] || stateSlug.toUpperCase();
  const cityName  = slugToDisplayName(citySlug);
  const stateName = STATE_NAMES[stateCode] || slugToDisplayName(stateSlug);
  return { stateSlug, citySlug, stateCode, cityName, stateName };
}

// ── Filter/page state ─────────────────────────────────────────────────────────
let activeBeds    = '';
let activeMaxRent = '';
let activeSort    = 'newest';
let currentPage   = 1;
let totalPages    = 1;
let totalCount    = 0;
let isLoading     = false;
const PER_PAGE    = 24;

function readURLParams() {
  const p = new URLSearchParams(window.location.search);
  activeBeds    = p.get('beds')    || '';
  activeMaxRent = p.get('maxrent') || '';
  activeSort    = p.get('sort')    || 'newest';
  currentPage   = parseInt(p.get('page') || '1', 10);
}

function pushURLParams(replace = false) {
  const p = new URLSearchParams();
  if (activeBeds)    p.set('beds',    activeBeds);
  if (activeMaxRent) p.set('maxrent', activeMaxRent);
  if (activeSort && activeSort !== 'newest') p.set('sort', activeSort);
  if (currentPage > 1) p.set('page', currentPage);
  const url = p.toString() ? `?${p}` : window.location.pathname;
  if (replace) history.replaceState(null, '', url);
  else         history.pushState(null, '', url);
}

function syncControls() {
  const beds = document.getElementById('bedsFilter');
  const rent = document.getElementById('maxRentFilter');
  const sort = document.getElementById('sortFilter');
  if (beds) beds.value = activeBeds;
  if (rent) rent.value = activeMaxRent;
  if (sort) sort.value = activeSort;
  const hasFilters = activeBeds || activeMaxRent || (activeSort && activeSort !== 'newest');
  const clearBtn = document.getElementById('clearFiltersBtn');
  if (clearBtn) clearBtn.style.display = hasFilters ? '' : 'none';
}

// ── Wait for CP ───────────────────────────────────────────────────────────────
async function waitForCP(ms = 8000) {
  const start = Date.now();
  while (!window.CP?.Properties || !window.CONFIG) {
    if (Date.now() - start > ms) throw new Error('Dependencies did not load. Please refresh.');
    await new Promise(r => setTimeout(r, 50));
  }
}

async function waitForCardBuilder(ms = 8000) {
  const start = Date.now();
  while (!window.buildPropertyCard) {
    if (Date.now() - start > ms) return false;
    await new Promise(r => setTimeout(r, 50));
  }
  return true;
}

// ── Card rendering ────────────────────────────────────────────────────────────
function fmtRent(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? '$' + n.toLocaleString() + '/mo' : 'Contact for rent';
}

function fmtBeds(n) {
  if (n === 0) return 'Studio';
  return n + (n === 1 ? ' Bed' : ' Beds');
}

function renderCardFallback(p) {
  const img = (p.photo_urls && p.photo_urls[0]) || '/assets/placeholder-property.jpg';
  const title = p.title || [p.city, p.state].filter(Boolean).join(', ') || 'Rental Property';
  const addr  = [p.address, p.neighborhood].filter(Boolean).join(' · ') || [p.city, p.state].filter(Boolean).join(', ');
  const beds  = p.bedrooms != null ? fmtBeds(p.bedrooms) : '';
  const baths = p.bathrooms ? p.bathrooms + (p.bathrooms === 1 ? ' Bath' : ' Baths') : '';
  const sqft  = p.square_footage ? p.square_footage.toLocaleString() + ' sqft' : '';
  const meta  = [beds, baths, sqft].filter(Boolean).join(' · ');

  return `<a class="property-card" href="/property.html?id=${encodeURIComponent(p.id)}" style="text-decoration:none;color:inherit;display:flex;overflow:hidden;background:#fff;border-radius:18px;box-shadow:0 1px 4px rgba(0,0,0,.06);transition:box-shadow 180ms ease">
    <div class="property-card-img" style="position:relative;width:260px;flex-shrink:0;overflow:hidden;background:#e4e8ef;border-radius:18px 0 0 18px">
      <img src="${img}" alt="${title}" loading="lazy" style="width:100%;height:100%;object-fit:cover" onerror="this.src='/assets/placeholder-property.jpg'">
    </div>
    <div style="flex:1;padding:18px 20px;display:flex;flex-direction:column;gap:6px;min-width:0">
      <div style="font-size:1.25rem;font-weight:700;color:#1d4ed8">${fmtRent(p.monthly_rent)}</div>
      <div style="font-weight:600;font-size:15px;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${title}</div>
      <div style="font-size:13px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${addr}</div>
      ${meta ? `<div style="font-size:13px;color:#374151;font-weight:500">${meta}</div>` : ''}
    </div>
  </a>`;
}

function renderCard(p, useCB) {
  if (useCB && window.buildPropertyCard) {
    try { return window.buildPropertyCard(p, {}); }
    catch (e) { /* fall through */ }
  }
  return renderCardFallback(p);
}

// ── Skeleton loading ─────────────────────────────────────────────────────────
function renderSkeletons(n = 6) {
  return Array.from({ length: n }, () =>
    `<div class="skeleton-card">
      <div class="skeleton-card__img"></div>
      <div class="skeleton-card__body">
        <div class="sk-line" style="height:20px;width:50%"></div>
        <div class="sk-line" style="height:16px;width:75%"></div>
        <div class="sk-line" style="height:14px;width:60%"></div>
        <div class="sk-line" style="height:14px;width:40%"></div>
      </div>
    </div>`
  ).join('');
}

// ── Fetch & render ────────────────────────────────────────────────────────────
async function loadListings(loc) {
  if (isLoading) return;
  isLoading = true;

  const grid  = document.getElementById('propertyGrid');
  const errEl = document.getElementById('errorBanner');
  const pgEl  = document.getElementById('pagination');
  const cntEl = document.getElementById('header-count');
  const cntNum = document.getElementById('header-count-num');

  grid.innerHTML = renderSkeletons();
  if (errEl) errEl.style.display = 'none';
  if (pgEl)  pgEl.style.display  = 'none';

  try {
    const result = await window.CP.Properties.getListings({
      city:     loc.cityName,
      state:    loc.stateCode,
      beds:     activeBeds,
      max_rent: activeMaxRent,
      sort:     activeSort,
      page:     currentPage,
      per_page: PER_PAGE,
    });

    if (!result.ok) throw new Error(result.error || 'Failed to load listings');

    const { rows, total, total_pages } = result.data;
    totalCount = total;
    totalPages = total_pages;

    // Update header count
    if (cntEl && cntNum) {
      cntNum.textContent = total.toLocaleString();
      cntEl.style.display = total > 0 ? '' : 'none';
    }

    // Update page title count
    document.title = `${total > 0 ? total + ' ' : ''}Rentals in ${loc.cityName}, ${loc.stateCode} — Choice Properties`;

    const useCB = await waitForCardBuilder(3000);

    if (!rows.length) {
      const hasFilters = activeBeds || activeMaxRent;
      grid.innerHTML = `<div class="loc-empty" style="grid-column:1/-1">
        <span class="loc-empty__icon">🏠</span>
        <h2 class="loc-empty__title">${hasFilters ? 'No listings match your filters' : `No listings in ${loc.cityName}, ${loc.stateCode} yet`}</h2>
        <p class="loc-empty__sub">${hasFilters
          ? 'Try adjusting your filters to see more results.'
          : 'We don't have any active rentals in this area right now. Check back soon — new listings are added regularly.'
        }</p>
        ${hasFilters
          ? `<button onclick="clearAllFilters()" style="background:#006aff;color:#fff;border:none;border-radius:10px;padding:12px 28px;font-weight:700;font-size:15px;cursor:pointer">Clear filters</button>`
          : `<a class="loc-empty__cta" href="/listings.html">Browse all listings</a>`
        }
      </div>`;
    } else {
      grid.innerHTML = rows.map(p => renderCard(p, useCB)).join('');
    }

    // Pagination
    if (totalPages > 1 && pgEl) {
      document.getElementById('prevBtn').disabled  = currentPage <= 1;
      document.getElementById('nextBtn').disabled  = currentPage >= totalPages;
      document.getElementById('pageInfo').textContent =
        `Page ${currentPage} of ${totalPages} · ${total.toLocaleString()} listings`;
      pgEl.style.display = 'flex';
    }

  } catch (err) {
    console.error('[location-page]', err);
    grid.innerHTML = '';
    if (errEl) {
      errEl.textContent = 'Could not load listings. Please try refreshing the page.';
      errEl.style.display = '';
    }
  } finally {
    isLoading = false;
  }
}

// ── Page init ─────────────────────────────────────────────────────────────────
window.clearAllFilters = function() {
  activeBeds = activeMaxRent = '';
  activeSort = 'newest';
  currentPage = 1;
  syncControls();
  pushURLParams(true);
  loadListings(window._loc);
};

async function init() {
  const loc = parseLocationURL();
  window._loc = loc;

  if (!loc) {
    document.title = 'Location Not Found — Choice Properties';
    document.getElementById('header-title').textContent = 'Location not found';
    document.getElementById('header-sub').textContent = 'The URL format should be /listings/state/city';
    return;
  }

  // Set page metadata
  document.getElementById('page-title').textContent =
    `Rentals in ${loc.cityName}, ${loc.stateCode} — Choice Properties`;
  document.getElementById('page-desc').setAttribute('content',
    `Browse verified rental listings in ${loc.cityName}, ${loc.stateCode}. Filter by price, bedrooms, and more. Apply online in minutes.`);
  document.getElementById('header-title').innerHTML =
    `Rentals in <em>${loc.cityName}</em>`;
  document.getElementById('header-sub').textContent =
    `${loc.cityName}, ${loc.stateCode} · ${loc.stateName}`;
  document.getElementById('header-eyebrow').textContent = 'Rentals in';

  // Breadcrumb
  const stateLink = document.getElementById('breadcrumb-state');
  if (stateLink) {
    stateLink.textContent = loc.stateName;
    stateLink.href = '#';
  }

  document.title = `Rentals in ${loc.cityName}, ${loc.stateCode} — Choice Properties`;

  // Read URL params and sync controls
  readURLParams();
  syncControls();

  // Wire filter controls
  const bedsEl    = document.getElementById('bedsFilter');
  const rentEl    = document.getElementById('maxRentFilter');
  const sortEl    = document.getElementById('sortFilter');
  const clearBtn  = document.getElementById('clearFiltersBtn');
  const prevBtn   = document.getElementById('prevBtn');
  const nextBtn   = document.getElementById('nextBtn');

  function onFilterChange() {
    activeBeds    = bedsEl ? bedsEl.value : '';
    activeMaxRent = rentEl ? rentEl.value : '';
    activeSort    = sortEl ? sortEl.value : 'newest';
    currentPage   = 1;
    syncControls();
    pushURLParams();
    loadListings(loc);
  }

  if (bedsEl)   bedsEl.addEventListener('change',  onFilterChange);
  if (rentEl)   rentEl.addEventListener('change',  onFilterChange);
  if (sortEl)   sortEl.addEventListener('change',  onFilterChange);
  if (clearBtn) clearBtn.addEventListener('click',  window.clearAllFilters);

  if (prevBtn) prevBtn.addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; pushURLParams(); loadListings(loc); window.scrollTo(0,0); }
  });
  if (nextBtn) nextBtn.addEventListener('click', () => {
    if (currentPage < totalPages) { currentPage++; pushURLParams(); loadListings(loc); window.scrollTo(0,0); }
  });

  window.addEventListener('popstate', () => {
    readURLParams();
    syncControls();
    loadListings(loc);
  });

  // ── Copy shareable link button ────────────────────────────────────────────
  const copyBtn = document.getElementById('copyLinkBtn');
  if (copyBtn) {
    // Build the clean base URL (no query params — just the slug path)
    const cleanURL = window.location.origin + window.location.pathname;
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cleanURL);
      } catch {
        // Fallback for non-secure contexts
        const ta = document.createElement('textarea');
        ta.value = cleanURL;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      // Show "Copied!" state briefly
      copyBtn.classList.add('copied');
      copyBtn.querySelector('.copy-icon').style.display = 'none';
      copyBtn.querySelector('.copied-icon').style.display = '';
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.querySelector('.copy-icon').style.display = '';
        copyBtn.querySelector('.copied-icon').style.display = 'none';
      }, 2000);
    });
  }

  // Load data
  try {
    await waitForCP();
    await loadListings(loc);
  } catch (err) {
    console.error('[location-page] init failed:', err);
    const errEl = document.getElementById('errorBanner');
    if (errEl) {
      errEl.textContent = err.message || 'Failed to load. Please refresh.';
      errEl.style.display = '';
    }
    const grid = document.getElementById('propertyGrid');
    if (grid) grid.innerHTML = '';
  }
}

init();
