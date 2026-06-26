// /js/locations-hub.js
// Hub page: shows all active city+state combos with listing counts.
// Loaded from listings/index.html

const STATE_NAMES = {
  'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California',
  'CO':'Colorado','CT':'Connecticut','DE':'Delaware','FL':'Florida','GA':'Georgia',
  'HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa',
  'KS':'Kansas','KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland',
  'MA':'Massachusetts','MI':'Michigan','MN':'Minnesota','MS':'Mississippi',
  'MO':'Missouri','MT':'Montana','NE':'Nebraska','NV':'Nevada',
  'NH':'New Hampshire','NJ':'New Jersey','NM':'New Mexico','NY':'New York',
  'NC':'North Carolina','ND':'North Dakota','OH':'Ohio','OK':'Oklahoma',
  'OR':'Oregon','PA':'Pennsylvania','RI':'Rhode Island','SC':'South Carolina',
  'SD':'South Dakota','TN':'Tennessee','TX':'Texas','UT':'Utah',
  'VT':'Vermont','VA':'Virginia','WA':'Washington','WV':'West Virginia',
  'WI':'Wisconsin','WY':'Wyoming','DC':'District of Columbia'
};

function stateToSlug(code) {
  const name = STATE_NAMES[code] || code;
  return name.toLowerCase().replace(/\s+/g, '-');
}

function cityToSlug(city) {
  return city.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function fmtRent(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? '$' + n.toLocaleString() : null;
}

async function waitForCP(ms = 8000) {
  const start = Date.now();
  while (!window.CP?.Locations || !window.CONFIG) {
    if (Date.now() - start > ms) throw new Error('Dependencies did not load. Please refresh.');
    await new Promise(r => setTimeout(r, 50));
  }
}

let allLocations = [];

function renderLocationCard(loc) {
  const stateSlug = stateToSlug(loc.state);
  const citySlug  = cityToSlug(loc.city);
  const href      = `/listings/${stateSlug}/${citySlug}`;
  const stateName = STATE_NAMES[loc.state] || loc.state;
  const minRent   = fmtRent(loc.min_rent);
  const maxRent   = fmtRent(loc.max_rent);
  const rentRange = minRent && maxRent && minRent !== maxRent
    ? `${minRent} – ${maxRent}/mo`
    : minRent ? `From ${minRent}/mo` : '';

  return `<a class="loc-card" href="${href}">
    <div class="loc-card__city">${loc.city}</div>
    <div class="loc-card__state">${stateName}</div>
    <span class="loc-card__count"><i class="fas fa-home" aria-hidden="true"></i> ${loc.count.toLocaleString()} listing${loc.count === 1 ? '' : 's'}</span>
    ${rentRange ? `<div class="loc-card__range">${rentRange}</div>` : ''}
    <div class="loc-card__arrow">Browse listings <i class="fas fa-arrow-right" aria-hidden="true"></i></div>
  </a>`;
}

function renderGrid(locs) {
  const grid = document.getElementById('hubGrid');
  if (!grid) return;

  if (!locs.length) {
    grid.innerHTML = `<div class="hub-empty" style="grid-column:1/-1">
      <span class="hub-empty__icon">🗺️</span>
      <h2 class="hub-empty__title">No active listings found</h2>
      <p class="hub-empty__sub">We don't have any active listings right now. Check back soon — new properties are added regularly.</p>
      <a class="hub-empty__cta" href="/listings.html">Browse all listings</a>
    </div>`;
    return;
  }

  // Group by state
  const byState = {};
  for (const loc of locs) {
    if (!byState[loc.state]) byState[loc.state] = [];
    byState[loc.state].push(loc);
  }

  const stateKeys = Object.keys(byState).sort((a, b) => {
    const na = STATE_NAMES[a] || a;
    const nb = STATE_NAMES[b] || b;
    return na.localeCompare(nb);
  });

  let html = '<div style="grid-column:1/-1">';
  for (const state of stateKeys) {
    const stateName = STATE_NAMES[state] || state;
    const cities    = byState[state].sort((a, b) => b.count - a.count);
    html += `<div class="hub-state-group">
      <h2 class="hub-state-label">${stateName}</h2>
      <div class="hub-grid">${cities.map(renderLocationCard).join('')}</div>
    </div>`;
  }
  html += '</div>';

  grid.innerHTML = html;
}

function filterAndRender(query) {
  if (!query) {
    renderGrid(allLocations);
    return;
  }
  const q = query.toLowerCase();
  const filtered = allLocations.filter(loc =>
    loc.city.toLowerCase().includes(q) ||
    (STATE_NAMES[loc.state] || '').toLowerCase().includes(q) ||
    loc.state.toLowerCase().includes(q)
  );
  renderGrid(filtered);
}

async function init() {
  try {
    await waitForCP();

    const result = await window.CP.Locations.getAll();
    if (!result.ok) throw new Error(result.error || 'Failed to load locations');

    allLocations = result.data || [];

    // Update totals
    const totalCities   = document.getElementById('totalCities');
    const totalListings = document.getElementById('totalListings');
    const hubTotals     = document.getElementById('hubTotals');
    if (totalCities)   totalCities.textContent   = allLocations.length.toLocaleString();
    if (totalListings) totalListings.textContent  = allLocations.reduce((s, l) => s + Number(l.count), 0).toLocaleString();
    if (hubTotals)     hubTotals.style.display    = 'flex';

    renderGrid(allLocations);

    // Wire search
    const searchEl = document.getElementById('citySearch');
    if (searchEl) {
      let debounce;
      searchEl.addEventListener('input', e => {
        clearTimeout(debounce);
        debounce = setTimeout(() => filterAndRender(e.target.value.trim()), 150);
      });
    }

  } catch (err) {
    console.error('[locations-hub]', err);
    const grid = document.getElementById('hubGrid');
    if (grid) {
      grid.innerHTML = `<div class="hub-empty" style="grid-column:1/-1">
        <span class="hub-empty__icon">⚠️</span>
        <h2 class="hub-empty__title">Could not load locations</h2>
        <p class="hub-empty__sub">Please refresh the page to try again.</p>
        <a class="hub-empty__cta" href="/listings.html">Browse all listings</a>
      </div>`;
    }
  }
}

init();
