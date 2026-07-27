// ============================================================
// Import to Choice Properties — Content Script v1.3
// Injected on: https://www.zillow.com/homedetails/*
// ============================================================

(function () {
  'use strict';

  const EDGE_URL = 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
  const SECRET   = 'cp_import_7Kx3m9P2w5';
  const BTN_ID   = 'cp-save-btn';

  // ── Button HTML templates ─────────────────────────────────────────────────

  const HTML_IDLE = `
    <div class="cp-btn-inner">
      <span class="cp-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.5"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2v13M5 9l7 7 7-7"/>
          <path d="M3 20h18"/>
        </svg>
      </span>
      <span class="cp-label">Save to Pipeline</span>
    </div>`;

  const HTML_LOADING = `
    <div class="cp-spinner">
      <div class="cp-spin-ring"></div>
      <span>Saving…</span>
    </div>`;

  function htmlResult(svgPath, text) {
    return `
    <div class="cp-result">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round">
        ${svgPath}
      </svg>
      <span>${text}</span>
    </div>`;
  }

  // ── Button state helpers ──────────────────────────────────────────────────

  const STATE_CLASSES = ['cp-loading', 'cp-success', 'cp-duplicate', 'cp-error', 'cp-collapsed'];

  function setState(btn, state, html) {
    STATE_CLASSES.forEach(c => btn.classList.remove(c));
    if (state) btn.classList.add(state);
    if (html !== undefined) btn.innerHTML = html;
  }

  // ── Inject button — retries for up to ~10 s ───────────────────────────────
  // Zillow is a heavy Next.js app; we retry to handle slow renders.

  let _attempts = 0;

  function tryInject() {
    _attempts++;

    if (document.getElementById(BTN_ID)) return;
    if (!document.body) { if (_attempts < 15) setTimeout(tryInject, 800); return; }
    if (!window.location.href.includes('/homedetails/')) { if (_attempts < 15) setTimeout(tryInject, 800); return; }

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.setAttribute('title', 'Save this listing to Choice Properties pipeline');

    // Only positioning via inline styles — prevents Zillow overriding our fixed placement.
    // All visual styles (color, font, shape, states) are handled by content.css.
    Object.assign(btn.style, {
      position: 'fixed',
      bottom:   '24px',
      right:    '24px',
      zIndex:   '2147483647',
      border:   'none',      // reset browser default button border
      outline:  'none',
    });

    btn.innerHTML = HTML_IDLE;
    btn.addEventListener('click', handleSave);
    document.body.appendChild(btn);
  }

  setTimeout(tryInject, 600);
  setTimeout(tryInject, 1500);
  setTimeout(tryInject, 3000);

  // SPA navigation — Zillow changes URL without a full reload
  let _lastUrl = location.href;
  setInterval(() => {
    if (location.href !== _lastUrl) {
      _lastUrl = location.href;
      const old = document.getElementById(BTN_ID);
      if (old) old.remove();
      _attempts = 0;
      setTimeout(tryInject, 800);
      setTimeout(tryInject, 2000);
    }
  }, 500);

  // ── Save handler ─────────────────────────────────────────────────────────

  async function handleSave() {
    const btn = document.getElementById(BTN_ID);
    if (!btn || btn.disabled || btn.dataset.saved) return;

    btn.disabled = true;
    setState(btn, 'cp-loading', HTML_LOADING);

    // Extract listing data
    let payload;
    try {
      payload = extractListing();
    } catch (err) {
      showError(btn, 'Error — not a listing page');
      console.error('[CP] extraction error:', err);
      return;
    }

    if (!payload) {
      showError(btn, 'Open a listing page first');
      return;
    }

    // POST to edge function
    let resp;
    try {
      const res = await fetch(EDGE_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-import-secret': SECRET },
        body:    JSON.stringify(payload),
      });
      resp = await res.json();
    } catch (netErr) {
      showError(btn, 'Network error — try again');
      console.error('[CP] network error:', netErr);
      return;
    }

    if (resp && resp.ok) {
      const photos = resp.photos || 0;
      const score  = resp.score  != null ? ` · Q:${resp.score}` : '';
      btn.dataset.saved = '1';
      btn.disabled = false;
      setState(btn, 'cp-success', htmlResult(
        '<polyline points="20 6 9 17 4 12"/>',
        `Saved! ${photos} photo${photos !== 1 ? 's' : ''}${score}`
      ));
      // Collapse to a pill after 4 s so it stays accessible but unobtrusive
      setTimeout(() => {
        if (btn.dataset.saved) btn.classList.add('cp-collapsed');
      }, 4000);
      // Notify background service worker → increments badge count
      chrome.runtime.sendMessage({ type: 'SAVED' });

    } else if (resp && resp.duplicate) {
      btn.dataset.saved = '1';
      btn.disabled = false;
      setState(btn, 'cp-duplicate', htmlResult(
        '<polyline points="20 6 9 17 4 12"/>',
        'Already in pipeline'
      ));

    } else {
      const msg = (resp && resp.error) ? resp.error.slice(0, 40) : 'Server error';
      showError(btn, 'Failed: ' + msg);
    }
  }

  function showError(btn, text) {
    btn.disabled = false;
    setState(btn, 'cp-error', htmlResult(
      '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
      text
    ));
    setTimeout(() => {
      delete btn.dataset.saved;
      setState(btn, null, HTML_IDLE);
    }, 3500);
  }

  // ── Data extraction from __NEXT_DATA__ ────────────────────────────────────

  function extractListing() {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;

    let nd;
    try { nd = JSON.parse(el.textContent); } catch (e) { return null; }

    // Find the property object inside gdpClientCache
    let prop = null;
    const cachePaths = [
      ['props','pageProps','componentProps','gdpClientCache'],
      ['props','pageProps','initialData','gdpClientCache'],
      ['props','pageProps','gdpClientCache'],
    ];

    for (const path of cachePaths) {
      if (prop) break;
      try {
        let node = nd;
        for (const key of path) { node = node[key]; if (!node) break; }
        if (!node) continue;
        const cache = typeof node === 'string' ? JSON.parse(node) : node;
        if (!cache || typeof cache !== 'object') continue;
        for (const k of Object.keys(cache)) {
          const v = cache[k];
          if (!v || typeof v !== 'object') continue;
          if (v.property && v.property.zpid)                                            { prop = v.property; break; }
          if (v.data && v.data.property && v.data.property.zpid)                        { prop = v.data.property; break; }
          if (v.zpid !== undefined && (v.bedrooms !== undefined || v.price !== undefined)) { prop = v; break; }
        }
      } catch (_) {}
    }

    // Fallback
    if (!prop) {
      try {
        const cp = nd.props.pageProps.componentProps;
        if (cp && cp.homeDetails && cp.homeDetails.zpid) prop = cp.homeDetails;
      } catch (_) {}
    }

    if (!prop) return null;

    const rf   = prop.resoFacts || {};
    const addr = prop.address   || {};

    // ── Photos ────────────────────────────────────────────────────────────
    function bestJpeg(ms) {
      const jpegs = (ms && ms.jpeg) || [];
      let best = null, bestW = 0;
      for (const j of jpegs) { if ((j.width||0) > bestW) { bestW = j.width||0; best = j.url||null; } }
      return best;
    }
    const photos = [], seen = new Set();
    const addPhoto = (u) => { if (u && typeof u === 'string' && u.startsWith('http') && !seen.has(u)) { photos.push(u); seen.add(u); } };
    for (const p of (prop.responsivePhotosOriginalRatio || [])) addPhoto(bestJpeg(p.mixedSources) || p.url);
    for (const p of (prop.responsivePhotos || []))              addPhoto(bestJpeg(p.mixedSources) || p.url);
    for (const p of (prop.hugePhotos || prop.largePhotos || [])) addPhoto(typeof p === 'string' ? p : (p && p.url));
    for (const p of (prop.photos || []))                         addPhoto(typeof p === 'string' ? p : (p && p.url));
    addPhoto(prop.desktopWebHdpImageLink);
    addPhoto(prop.heroImage);

    // ── Rent ──────────────────────────────────────────────────────────────
    const rawPrice = prop.price || prop.unformattedPrice;
    let rent = null;
    if (typeof rawPrice === 'number' && rawPrice > 0) rent = rawPrice;
    else if (rawPrice) { const d = String(rawPrice).replace(/[^0-9]/g,''); rent = d ? parseInt(d,10) : null; }
    if (!rent && prop.rentZestimate) rent = parseInt(String(prop.rentZestimate),10) || null;

    // ── Core fields ───────────────────────────────────────────────────────
    const zpid   = String(prop.zpid || '');
    const street = addr.streetAddress || prop.streetAddress || '';
    const city   = addr.city    || prop.city    || '';
    const state  = addr.state   || prop.state   || '';
    const zip    = addr.zipcode || prop.zipcode || '';
    const beds   = prop.bedrooms != null ? prop.bedrooms : (prop.beds != null ? prop.beds : null);
    const bathsR = prop.bathrooms != null ? prop.bathrooms : (prop.baths != null ? prop.baths : null);
    const bathF  = bathsR != null ? Math.floor(bathsR) : null;
    const bathH  = bathsR != null && bathsR !== bathF ? 1 : null;
    const lat    = prop.latitude  || (prop.latLong && prop.latLong.latitude)  || null;
    const lng    = prop.longitude || (prop.latLong && prop.latLong.longitude) || null;
    const sqft   = prop.livingArea || prop.area || null;
    const yr     = prop.yearBuilt || rf.yearBuilt || null;
    const hood   = prop.neighborhoodName || prop.neighborhood || rf.subdivision || addr.neighborhood || null;
    const county = prop.county || addr.county || null;
    const vtour  = prop.virtualTourUrl || prop.threeDimensionalTourUrl || null;

    const TYPE_MAP = { SINGLE_FAMILY:'SINGLE_FAMILY',MULTI_FAMILY:'MULTI_FAMILY',CONDO:'CONDOS',
      CONDO_TOWNHOME:'CONDOS',TOWNHOUSE:'TOWNHOMES',APARTMENT:'APARTMENT',
      MANUFACTURED:'MOBILE',MOBILE:'MOBILE',LOT:'LAND',LAND:'LAND',FARM:'FARM' };
    const propType = TYPE_MAP[(prop.homeType||'').toUpperCase()] || (prop.homeType||'').toUpperCase() || null;

    function parseDate(v) {
      if (!v) return null;
      const s = String(v).trim();
      const m = s.match(/^(\d{4}-\d{2}-\d{2})/); if (m) return m[1];
      if (/^\d{13}$/.test(s)) { try { return new Date(parseInt(s,10)).toISOString().slice(0,10); } catch(_){} }
      if (/^\d{10}$/.test(s)) { try { return new Date(parseInt(s,10)*1000).toISOString().slice(0,10); } catch(_){} }
      try { const d=new Date(s); if(!isNaN(d.getTime())) return d.toISOString().slice(0,10); } catch(_){}
      return s.slice(0,40);
    }

    function safeI(v) { if(!v && v!==0) return null; const n=parseInt(String(v).replace(/[^0-9]/g,''),10); return isNaN(n)||n<=0?null:n; }

    const ctxParts = [];
    if (prop.walkScore    != null) ctxParts.push('Walk score: '    + prop.walkScore);
    if (prop.transitScore != null) ctxParts.push('Transit score: ' + prop.transitScore);
    if (prop.bikeScore    != null) ctxParts.push('Bike score: '    + prop.bikeScore);

    const amenityMap = {};
    const addA = (v) => { if(v&&typeof v==='string'){const t=v.trim();if(t) amenityMap[t]=true;} };
    for (const t of (prop.tags||[])) addA(t);
    for (const f of [...(rf.communityFeatures||[]),...(rf.interiorFeatures||[]),...(rf.exteriorFeatures||[]),...(rf.poolFeatures||[])]) addA(f);

    let parking = null;
    if (rf.parkingFeatures && rf.parkingFeatures.length) parking = rf.parkingFeatures.join(', ');
    else if (prop.parkingType) parking = String(prop.parkingType).replace(/_/g,' ');

    const pets = prop.isPetFriendly != null ? prop.isPetFriendly : (rf.petsAllowed != null ? rf.petsAllowed : null);
    const petTypes = [];
    if (rf.catsAllowed) petTypes.push('cats');
    if (rf.dogsAllowed) petTypes.push('dogs');

    let minLease = null;
    const ltRaw = rf.leaseTerm || rf.leaseTerms || rf.minimumLease || null;
    if (ltRaw) {
      const lt = String(ltRaw).toLowerCase();
      const mmo = lt.match(/(\d+)\s*month/);
      if (mmo) minLease = parseInt(mmo[1],10);
      else if (/month.to.month|m2m|mtm/.test(lt)) minLease = 1;
      else if (/\byear\b|12[\s-]*month|annual/.test(lt)) minLease = 12;
    }

    const fmtType = (t) => !t ? 'Rental' : t.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
    const title = city ? ((beds?beds+'BR ':'')+fmtType(propType)+' in '+city) : (street||'Zillow Rental');

    return {
      source:               'zillow',
      source_listing_id:    zpid,
      source_url:           window.location.href,
      title,
      address:              street,
      city, state, zip, lat, lng,
      monthly_rent:         rent,
      bedrooms:             beds,
      bathrooms:            bathF,
      half_bathrooms:       bathH,
      square_footage:       sqft ? parseInt(String(sqft),10) : null,
      year_built:           yr   ? parseInt(String(yr),10)   : null,
      lot_size_sqft:        null,
      floors:               safeI(prop.stories || rf.stories),
      garage_spaces:        safeI(prop.garageParkingCapacity || prop.garageSpaces),
      total_units:          safeI(prop.unitCount),
      property_type:        propType,
      description:          prop.description || null,
      neighborhood:         hood,
      county,
      location_context:     ctxParts.length ? ctxParts.join('; ') : null,
      pets_allowed:         pets,
      pet_types_allowed:    JSON.stringify(petTypes),
      available_date:       parseDate(rf.dateAvailable || rf.availableFrom || prop.dateAvailable),
      minimum_lease_months: minLease,
      smoking_allowed:      rf.smokingAllowed != null ? !!rf.smokingAllowed : null,
      security_deposit:     safeI(rf.securityDeposit),
      pet_deposit:          safeI(rf.petFee || rf.petDepositFee),
      admin_fee:            safeI(rf.adminFee),
      parking_fee:          safeI(rf.parkingFee),
      application_fee:      safeI(rf.applicationFeeAmount || rf.applicationFee),
      hoa_fee:              safeI(prop.monthlyHoaFee || prop.hoaFee),
      last_months_rent:     safeI(rf.lastMonthRent),
      move_in_special:      rf.concessions ? String(rf.concessions).slice(0,200) : null,
      parking,
      amenities:            JSON.stringify(Object.keys(amenityMap)),
      appliances:           JSON.stringify(rf.appliances || []),
      utilities_included:   JSON.stringify(rf.utilities  || rf.utilitiesIncluded || []),
      heating_type:         rf.heating && rf.heating.length ? rf.heating.join(', ') : null,
      cooling_type:         rf.cooling && rf.cooling.length ? rf.cooling.join(', ') : null,
      laundry_type:         rf.laundryFeatures && rf.laundryFeatures.length ? rf.laundryFeatures.join(', ') : null,
      virtual_tour_url:     vtour,
      has_basement:         !!(rf.basement && rf.basement !== 'None' && rf.basement !== 'false' && rf.basement !== false),
      has_central_air:      !!(rf.hasCooling || (rf.cooling && rf.cooling.some(c => c.toLowerCase().includes('central')))),
      original_image_urls:  JSON.stringify(photos.slice(0,50)),
      agent_name:           (prop.attributionInfo && prop.attributionInfo.agentName)  || null,
      broker_name:          (prop.attributionInfo && prop.attributionInfo.brokerName) || null,
      _import:              'browser-extension-v1',
    };
  }

})();
