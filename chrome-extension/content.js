// ============================================================
// Import to Choice Properties — Content Script
// Injected on: https://www.zillow.com/homedetails/*
//
// Reads __NEXT_DATA__ directly from the DOM (no server fetch,
// no IP blocking), extracts all listing fields + every photo,
// and POSTs to the receive-pipeline-import Edge Function.
// ============================================================

(function () {
  'use strict';

  const EDGE_URL = 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
  const SECRET   = 'cp_import_7Kx3m9P2w5';
  const BTN_ID   = 'cp-save-btn';

  // ── Inject button once page is ready ──────────────────────────────────────
  // Zillow is a Next.js SPA — the URL changes without a full reload.
  // We use a MutationObserver to detect navigation and re-inject if needed.

  function isListingPage() {
    return /\/homedetails\/.+\/(\d+)_zpid/.test(window.location.pathname);
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return; // already injected
    if (!isListingPage()) return;

    const btn = document.createElement('div');
    btn.id = BTN_ID;
    btn.innerHTML = `
      <div class="cp-btn-inner" id="cp-btn-inner">
        <span class="cp-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.5"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2v13M5 9l7 7 7-7"/>
            <path d="M3 20h18"/>
          </svg>
        </span>
        <span class="cp-label">Save to Pipeline</span>
      </div>
      <div class="cp-spinner" id="cp-spinner" style="display:none">
        <div class="cp-spin-ring"></div>
        <span>Saving…</span>
      </div>
      <div class="cp-result" id="cp-result" style="display:none"></div>
    `;

    btn.addEventListener('click', handleSave);
    document.body.appendChild(btn);
  }

  // Re-inject on SPA navigation
  let _lastPath = window.location.pathname;
  const _navObserver = new MutationObserver(() => {
    if (window.location.pathname !== _lastPath) {
      _lastPath = window.location.pathname;
      const existing = document.getElementById(BTN_ID);
      if (existing) existing.remove();
      setTimeout(injectButton, 800); // brief delay for Next.js to settle
    }
  });
  _navObserver.observe(document.body, { childList: true, subtree: true });

  // Initial inject (may need a short delay if Zillow JS hasn't run yet)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(injectButton, 500));
  } else {
    setTimeout(injectButton, 500);
  }

  // ── Button state helpers ──────────────────────────────────────────────────

  function setState(state, message) {
    const btn      = document.getElementById(BTN_ID);
    const inner    = document.getElementById('cp-btn-inner');
    const spinner  = document.getElementById('cp-spinner');
    const result   = document.getElementById('cp-result');
    if (!btn) return;

    // Remove all state classes
    btn.className = '';
    btn.id = BTN_ID;

    inner.style.display   = 'none';
    spinner.style.display = 'none';
    result.style.display  = 'none';

    if (state === 'idle') {
      inner.style.display = 'flex';
    } else if (state === 'loading') {
      btn.classList.add('cp-loading');
      spinner.style.display = 'flex';
    } else if (state === 'success') {
      btn.classList.add('cp-success');
      result.style.display = 'flex';
      result.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.5"
             stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span>${escHtml(message || 'Saved!')}</span>
      `;
      // Auto-collapse after 4 s
      setTimeout(() => { if (btn) btn.classList.add('cp-collapsed'); }, 4000);
      // Allow re-click to expand again
      btn.addEventListener('click', () => btn.classList.remove('cp-collapsed'), { once: true });
    } else if (state === 'duplicate') {
      btn.classList.add('cp-duplicate');
      result.style.display = 'flex';
      result.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.5"
             stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>${escHtml(message || 'Already in pipeline')}</span>
      `;
    } else if (state === 'error') {
      btn.classList.add('cp-error');
      result.style.display = 'flex';
      result.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.5"
             stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <span>${escHtml(message || 'Error — tap to retry')}</span>
      `;
      // Allow retry
      setTimeout(() => setState('idle'), 5000);
    }
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Main save handler ─────────────────────────────────────────────────────

  async function handleSave(e) {
    e.stopPropagation();
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    // Don't re-trigger while loading or after success
    if (btn.classList.contains('cp-loading')) return;
    if (btn.classList.contains('cp-success'))  { btn.classList.remove('cp-collapsed'); return; }

    setState('loading');

    // 1. Extract data from __NEXT_DATA__
    let payload;
    try {
      payload = extractListing();
    } catch (err) {
      setState('error', 'Could not read listing data — are you on a detail page?');
      console.error('[CP Importer] extraction error:', err);
      return;
    }

    if (!payload) {
      setState('error', 'No listing data found. Open a specific property page first.');
      return;
    }

    // 2. POST to edge function
    let resp;
    try {
      const res = await fetch(EDGE_URL, {
        method:  'POST',
        headers: {
          'Content-Type':    'application/json',
          'x-import-secret': SECRET,
        },
        body: JSON.stringify(payload),
      });
      resp = await res.json();
    } catch (netErr) {
      setState('error', 'Network error — check your connection');
      console.error('[CP Importer] network error:', netErr);
      return;
    }

    // 3. Handle response
    if (resp && resp.ok) {
      const photos = resp.photos || 0;
      const score  = resp.score  != null ? `Q:${resp.score}` : '';
      const city   = resp.city   ? ` · ${resp.city}` : '';
      const msg    = `Saved! ${photos} photos${city}${score ? ' · ' + score + '/100' : ''}`;
      setState('success', msg);

      // Notify background to update badge
      try {
        chrome.runtime.sendMessage({ type: 'SAVED', title: resp.title || '' });
      } catch (_) {}

    } else if (resp && resp.duplicate) {
      setState('duplicate', 'Already in your pipeline');
    } else {
      const errMsg = (resp && resp.error) ? resp.error : 'Server error';
      setState('error', errMsg.slice(0, 60));
      console.error('[CP Importer] server error:', resp);
    }
  }

  // ── Listing data extraction from __NEXT_DATA__ ────────────────────────────
  // Ported directly from the iOS Scriptable importer (v3.2) which has been
  // proven against live Zillow pages. Runs in the content script context,
  // so it reads the DOM directly — no fetch, no blocking.

  function extractListing() {
    // ── Locate __NEXT_DATA__ ─────────────────────────────────────────────────
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) throw new Error('No __NEXT_DATA__ element found');

    let nd;
    try { nd = JSON.parse(el.textContent); }
    catch (pe) { throw new Error('Could not parse __NEXT_DATA__: ' + pe.message); }

    // ── Extract property object from gdpClientCache ──────────────────────────
    let prop = null;
    const cachePaths = [
      ['props', 'pageProps', 'componentProps', 'gdpClientCache'],
      ['props', 'pageProps', 'initialData',    'gdpClientCache'],
      ['props', 'pageProps', 'gdpClientCache'],
    ];

    for (const path of cachePaths) {
      if (prop) break;
      try {
        let node = nd;
        for (const key of path) { node = node[key]; if (!node) break; }
        if (!node) continue;
        const cache = (typeof node === 'string') ? JSON.parse(node) : node;
        if (typeof cache !== 'object' || !cache) continue;
        for (const k of Object.keys(cache)) {
          const v = cache[k];
          if (!v || typeof v !== 'object') continue;
          if (v.property && typeof v.property === 'object' && v.property.zpid) { prop = v.property; break; }
          if (v.data && v.data.property && v.data.property.zpid)               { prop = v.data.property; break; }
          if (v.zpid !== undefined && (v.bedrooms !== undefined || v.price !== undefined)) { prop = v; break; }
        }
      } catch (_) {}
    }

    // Fallback: homeDetails on componentProps
    if (!prop) {
      try {
        const cp = nd.props.pageProps.componentProps;
        if (cp && cp.homeDetails && cp.homeDetails.zpid) prop = cp.homeDetails;
      } catch (_) {}
    }

    if (!prop) return null; // Not a detail page

    const rf   = prop.resoFacts || {};
    const addr = prop.address   || {};

    // ── Photos — highest resolution, fully deduplicated ──────────────────────
    function bestJpeg(ms) {
      const jpegs = (ms && ms.jpeg) || [];
      let best = null, bestW = 0;
      for (const j of jpegs) {
        const w = j.width || 0;
        if (w > bestW) { bestW = w; best = j.url || null; }
      }
      return best;
    }

    const photos = [], seen = new Set();
    function addPhoto(u) {
      if (u && typeof u === 'string' && u.startsWith('http') && !seen.has(u)) {
        photos.push(u); seen.add(u);
      }
    }

    // Source 1: responsivePhotosOriginalRatio — original aspect-ratio, full-res
    for (const p of (prop.responsivePhotosOriginalRatio || [])) {
      addPhoto(bestJpeg(p.mixedSources) || p.url || null);
    }
    // Source 2: responsivePhotos — standard Zillow set
    for (const p of (prop.responsivePhotos || [])) {
      addPhoto(bestJpeg(p.mixedSources) || p.url || null);
    }
    // Source 3: hugePhotos / largePhotos (older format)
    for (const p of (prop.hugePhotos || prop.largePhotos || [])) {
      addPhoto(typeof p === 'string' ? p : (p && (p.url || p.href || p.src)));
    }
    // Source 4: flat photos array
    for (const p of (prop.photos || [])) {
      addPhoto(typeof p === 'string' ? p : (p && (p.url || p.href || p.src)));
    }
    // Source 5: absolute fallbacks
    addPhoto(prop.desktopWebHdpImageLink);
    addPhoto(prop.heroImage);

    const photoUrls = photos.slice(0, 50);

    // ── Rent ─────────────────────────────────────────────────────────────────
    const rawPrice = prop.price || prop.unformattedPrice;
    let rent = null;
    if (typeof rawPrice === 'number' && rawPrice > 0) {
      rent = rawPrice;
    } else if (typeof rawPrice === 'string') {
      const d = rawPrice.replace(/[^0-9]/g, '');
      rent = d ? parseInt(d, 10) : null;
    }
    if (!rent && prop.rentZestimate) rent = parseInt(String(prop.rentZestimate), 10) || null;

    // ── Baths ────────────────────────────────────────────────────────────────
    const bathsRaw = (prop.bathrooms != null) ? prop.bathrooms : (prop.baths != null ? prop.baths : null);
    const bathF    = (bathsRaw != null) ? Math.floor(bathsRaw) : null;
    const bathH    = (bathsRaw != null && bathsRaw !== bathF) ? 1 : null;

    // ── Core location ────────────────────────────────────────────────────────
    const zpid   = String(prop.zpid || '');
    const street = addr.streetAddress || prop.streetAddress || '';
    const city   = addr.city    || prop.city    || '';
    const state  = addr.state   || prop.state   || '';
    const zip    = addr.zipcode || prop.zipcode || '';
    const beds   = (prop.bedrooms != null) ? prop.bedrooms : (prop.beds != null ? prop.beds : null);
    const sqft   = prop.livingArea || prop.area || null;
    const yr     = prop.yearBuilt || rf.yearBuilt || null;
    const lat    = prop.latitude  || (prop.latLong && prop.latLong.latitude)  || null;
    const lng    = prop.longitude || (prop.latLong && prop.latLong.longitude) || null;
    const hood   = prop.neighborhoodName || prop.neighborhood || rf.subdivision || addr.neighborhood || null;
    const county = prop.county || addr.county || null;
    const vtour  = prop.virtualTourUrl || prop.threeDimensionalTourUrl || null;

    // ── Property type ─────────────────────────────────────────────────────────
    const TYPE_MAP = {
      'SINGLE_FAMILY':'SINGLE_FAMILY','MULTI_FAMILY':'MULTI_FAMILY',
      'CONDO':'CONDOS','CONDO_TOWNHOME':'CONDOS','TOWNHOUSE':'TOWNHOMES',
      'APARTMENT':'APARTMENT','MANUFACTURED':'MOBILE','MOBILE':'MOBILE',
      'LOT':'LAND','LAND':'LAND','FARM':'FARM',
    };
    const rawType  = (prop.homeType || '').toUpperCase();
    const propType = TYPE_MAP[rawType] || rawType || null;

    // ── Available date → YYYY-MM-DD ──────────────────────────────────────────
    function parseDate(v) {
      if (!v) return null;
      const s = String(v).trim();
      const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) return m[1];
      if (/^\d{13}$/.test(s)) { try { return new Date(parseInt(s,10)).toISOString().slice(0,10); } catch(_){} }
      if (/^\d{10}$/.test(s)) { try { return new Date(parseInt(s,10)*1000).toISOString().slice(0,10); } catch(_){} }
      try { const d = new Date(s); if (!isNaN(d.getTime())) return d.toISOString().slice(0,10); } catch(_){}
      return s.slice(0, 40);
    }
    const avail = parseDate(rf.dateAvailable || rf.availableFrom || prop.dateAvailable);

    // ── Fees ─────────────────────────────────────────────────────────────────
    function safeIntStr(v) {
      if (v == null || v === '' || v === false) return null;
      const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
      return (isNaN(n) || n <= 0) ? null : n;
    }
    const deposit      = safeIntStr(rf.securityDeposit);
    const petDeposit   = safeIntStr(rf.petFee || rf.petDepositFee || rf.petDeposit);
    const adminFee     = safeIntStr(rf.adminFee);
    const parkingFee   = safeIntStr(rf.parkingFee);
    const appFee       = safeIntStr(rf.applicationFeeAmount || rf.applicationFee);
    const hoaFee       = safeIntStr(prop.monthlyHoaFee || prop.hoaFee);
    const lastMonthRnt = safeIntStr(rf.lastMonthRent);
    const moveInSpcl   = rf.concessions ? String(rf.concessions).slice(0, 200) : null;

    // ── Physical features ─────────────────────────────────────────────────────
    const floors      = safeIntStr(prop.stories || rf.stories);
    const garageSpc   = safeIntStr(prop.garageParkingCapacity || prop.garageSpaces || rf.garageSpaces);
    const totalUnits  = safeIntStr(prop.unitCount || prop.numberOfUnitsTotal);

    // Lot size → sqft
    let lotSqft = null;
    if (prop.lotAreaValue) {
      const lv = parseFloat(String(prop.lotAreaValue));
      const lu = String(prop.lotAreaUnit || '').toLowerCase();
      if (!isNaN(lv) && lv > 0) {
        lotSqft = lu.includes('acre') ? Math.round(lv * 43560) : Math.round(lv);
      }
    } else if (prop.lotSize) {
      const ls = parseFloat(String(prop.lotSize));
      if (!isNaN(ls) && ls > 0) lotSqft = Math.round(ls);
    }

    // Min lease months
    let minLease = null;
    const ltRaw = rf.leaseTerm || rf.leaseTerms || rf.minimumLease || null;
    if (ltRaw) {
      const lt = String(ltRaw).toLowerCase();
      const mmo = lt.match(/(\d+)\s*month/);
      if (mmo)                                    { minLease = parseInt(mmo[1], 10); }
      else if (/month.to.month|m2m|mtm/.test(lt)) { minLease = 1; }
      else if (/\byear\b|12[\s-]*month|annual/.test(lt)) { minLease = 12; }
    }

    // ── Policies ──────────────────────────────────────────────────────────────
    const smokingAllowed = (rf.smokingAllowed !== undefined && rf.smokingAllowed !== null)
      ? !!rf.smokingAllowed : null;

    const pets = (prop.isPetFriendly !== undefined && prop.isPetFriendly !== null)
      ? prop.isPetFriendly
      : (rf.petsAllowed !== undefined ? rf.petsAllowed : null);

    const petTypes = [];
    if (rf.catsAllowed) petTypes.push('cats');
    if (rf.dogsAllowed) petTypes.push('dogs');

    // ── HVAC / laundry / parking ──────────────────────────────────────────────
    const heating = (rf.heating && rf.heating.length)       ? rf.heating.join(', ')        : null;
    const cooling = (rf.cooling && rf.cooling.length)       ? rf.cooling.join(', ')        : null;
    const laundry = (rf.laundryFeatures && rf.laundryFeatures.length) ? rf.laundryFeatures.join(', ') : null;
    let parking = null;
    if (rf.parkingFeatures && rf.parkingFeatures.length) {
      parking = rf.parkingFeatures.join(', ');
    } else if (prop.parkingType) {
      parking = String(prop.parkingType).replace(/_/g, ' ');
    }

    // ── Amenities ─────────────────────────────────────────────────────────────
    const amenityMap = {};
    const addAmenity = (v) => { if (v && typeof v === 'string') { const t = v.trim(); if (t) amenityMap[t] = true; } };
    for (const t of (prop.tags || [])) addAmenity(t);
    for (const f of [
      ...(rf.communityFeatures      || []),
      ...(rf.interiorFeatures       || []),
      ...(rf.exteriorFeatures       || []),
      ...(rf.lotFeatures            || []),
      ...(rf.poolFeatures           || []),
      ...(rf.accessibilityFeatures  || []),
    ]) addAmenity(f);

    const amenities  = JSON.stringify(Object.keys(amenityMap));
    const appliances = JSON.stringify(rf.appliances || []);
    const utilities  = JSON.stringify(rf.utilities  || rf.utilitiesIncluded || []);

    // ── Basement / central air ────────────────────────────────────────────────
    const basement   = !!(rf.basement && rf.basement !== 'None' && rf.basement !== 'No basement'
                        && rf.basement !== 'false' && rf.basement !== false);
    const centralAir = !!(rf.hasCooling || (rf.cooling && rf.cooling.some(c => c.toLowerCase().includes('central'))));

    // ── Walk / transit / bike scores ──────────────────────────────────────────
    const ctxParts = [];
    if (prop.walkScore    != null) ctxParts.push('Walk score: '    + prop.walkScore);
    if (prop.transitScore != null) ctxParts.push('Transit score: ' + prop.transitScore);
    if (prop.bikeScore    != null) ctxParts.push('Bike score: '    + prop.bikeScore);
    const locationContext = ctxParts.length ? ctxParts.join('; ') : null;

    // ── Agent / broker ────────────────────────────────────────────────────────
    const ai        = prop.attributionInfo || {};
    const agentName = ai.agentName  || null;
    const brokerName= ai.brokerName || null;

    // ── Title ─────────────────────────────────────────────────────────────────
    const fmtType = (t) => !t ? 'Rental' : t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const title = city
      ? ((beds ? beds + 'BR ' : '') + fmtType(propType) + ' in ' + city)
      : (street || 'Zillow Rental');

    // ── Return payload matching receive-pipeline-import exactly ───────────────
    return {
      source:               'zillow',
      source_listing_id:    zpid,
      source_url:           window.location.href,
      title,
      address:              street,
      city,
      state,
      zip,
      lat,
      lng,
      monthly_rent:         rent,
      bedrooms:             beds,
      bathrooms:            bathF,
      half_bathrooms:       bathH,
      square_footage:       sqft ? parseInt(String(sqft), 10) : null,
      year_built:           yr   ? parseInt(String(yr),   10) : null,
      lot_size_sqft:        lotSqft,
      floors,
      garage_spaces:        garageSpc,
      total_units:          totalUnits,
      property_type:        propType,
      description:          prop.description || null,
      neighborhood:         hood,
      county,
      location_context:     locationContext,
      pets_allowed:         pets,
      pet_types_allowed:    JSON.stringify(petTypes),
      available_date:       avail,
      minimum_lease_months: minLease,
      smoking_allowed:      smokingAllowed,
      security_deposit:     deposit,
      pet_deposit:          petDeposit,
      admin_fee:            adminFee,
      parking_fee:          parkingFee,
      application_fee:      appFee,
      hoa_fee:              hoaFee,
      last_months_rent:     lastMonthRnt,
      move_in_special:      moveInSpcl,
      parking,
      amenities,
      appliances,
      utilities_included:   utilities,
      heating_type:         heating,
      cooling_type:         cooling,
      laundry_type:         laundry,
      virtual_tour_url:     vtour,
      has_basement:         basement,
      has_central_air:      centralAir,
      original_image_urls:  JSON.stringify(photoUrls),
      agent_name:           agentName,
      broker_name:          brokerName,
      // Tag the source so the pipeline panel shows "Desktop" badge
      _import: 'browser-extension-v1',
    };
  }

})();
