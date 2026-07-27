// ============================================================
// Import to Choice Properties — Content Script v1.4
// Injected on: https://www.zillow.com/homedetails/*
// ============================================================

(function () {
  'use strict';

  const EDGE_URL = 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
  const SECRET   = 'cp_import_7Kx3m9P2w5';
  const BTN_ID   = 'cp-save-btn';

  // ── Base inline styles ────────────────────────────────────────────────────
  // Zillow's CSS is extremely aggressive and overrides external stylesheets.
  // Every visual property MUST be set via inline style so nothing can clobber it.
  const BASE_STYLES = {
    position:       'fixed',
    bottom:         '24px',
    right:          '24px',
    zIndex:         '2147483647',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            '8px',
    padding:        '0 18px',
    height:         '46px',
    minWidth:       '44px',
    maxWidth:       '320px',
    background:     '#6366f1',
    color:          '#fff',
    border:         'none',
    borderRadius:   '23px',
    boxShadow:      '0 4px 20px rgba(99,102,241,0.5), 0 2px 6px rgba(0,0,0,0.2)',
    fontFamily:     '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:       '14px',
    fontWeight:     '700',
    letterSpacing:  '0.01em',
    lineHeight:     '1',
    whiteSpace:     'nowrap',
    cursor:         'pointer',
    userSelect:     'none',
    outline:        'none',
    overflow:       'hidden',
    transition:     'background 0.15s, box-shadow 0.15s, transform 0.12s, max-width 0.3s, padding 0.3s, opacity 0.2s',
    textDecoration: 'none',
    boxSizing:      'border-box',
    verticalAlign:  'middle',
  };

  // ── Button HTML ───────────────────────────────────────────────────────────

  const ICON_SAVE = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2.5"
         stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
      <path d="M12 2v13M5 9l7 7 7-7"/>
      <path d="M3 20h18"/>
    </svg>`;

  const ICON_CHECK = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2.5"
         stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
      <polyline points="20 6 9 17 4 12"/>
    </svg>`;

  const ICON_X = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2.5"
         stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>`;

  const SPINNER_HTML = `
    <span style="
      display:inline-block;
      width:15px;height:15px;
      border:2px solid rgba(255,255,255,0.35);
      border-top-color:#fff;
      border-radius:50%;
      animation:cp-spin 0.7s linear infinite;
      flex-shrink:0;
    "></span>`;

  function labelHtml(icon, text) {
    return `${icon}<span style="display:inline-block">${text}</span>`;
  }

  // ── State colours ─────────────────────────────────────────────────────────
  const BG = {
    idle:      '#6366f1',
    hover:     '#4f46e5',
    loading:   '#818cf8',
    success:   '#16a34a',
    duplicate: '#a16207',
    error:     '#dc2626',
  };

  // ── Inject button ─────────────────────────────────────────────────────────
  let _attempts = 0;

  function tryInject() {
    _attempts++;
    if (document.getElementById(BTN_ID)) return;
    if (!document.body)                                     { if (_attempts < 20) setTimeout(tryInject, 800); return; }
    if (!location.href.includes('/homedetails/'))           { if (_attempts < 20) setTimeout(tryInject, 800); return; }

    // Inject keyframe for spinner via a <style> tag (inline style can't define @keyframes)
    if (!document.getElementById('cp-spin-style')) {
      const s = document.createElement('style');
      s.id = 'cp-spin-style';
      s.textContent = '@keyframes cp-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(s);
    }

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.setAttribute('title', 'Save this listing to Choice Properties pipeline');

    // Apply every base style inline — the only reliable way on Zillow
    Object.assign(btn.style, BASE_STYLES);

    btn.innerHTML = labelHtml(ICON_SAVE, 'Save to Pipeline');

    btn.addEventListener('mouseenter', () => {
      if (!btn.dataset.state || btn.dataset.state === 'idle') {
        btn.style.background = BG.hover;
        btn.style.transform  = 'translateY(-1px)';
        btn.style.boxShadow  = '0 6px 24px rgba(99,102,241,0.55), 0 2px 6px rgba(0,0,0,0.2)';
      }
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.dataset.state || btn.dataset.state === 'idle') {
        btn.style.background = BG.idle;
        btn.style.transform  = '';
        btn.style.boxShadow  = BASE_STYLES.boxShadow;
      }
      if (btn.dataset.state === 'collapsed') {
        collapseBtn(btn);
      }
    });
    btn.addEventListener('mouseenter', () => {
      if (btn.dataset.state === 'collapsed') expandBtn(btn);
    });

    btn.addEventListener('click', handleSave);
    document.body.appendChild(btn);
  }

  // Start immediately, then back-off retries for slow Next.js hydration
  setTimeout(tryInject,  500);
  setTimeout(tryInject, 1500);
  setTimeout(tryInject, 3000);
  setTimeout(tryInject, 6000);

  // SPA navigation — Zillow changes URL without a full page reload
  let _lastUrl = location.href;
  setInterval(() => {
    if (location.href !== _lastUrl) {
      _lastUrl = location.href;
      const old = document.getElementById(BTN_ID);
      if (old) old.remove();
      _attempts = 0;
      setTimeout(tryInject,  800);
      setTimeout(tryInject, 2000);
    }
  }, 500);

  // ── Button state helpers ──────────────────────────────────────────────────

  function setIdle(btn) {
    btn.dataset.state   = 'idle';
    btn.disabled        = false;
    btn.style.background = BG.idle;
    btn.style.cursor     = 'pointer';
    btn.style.opacity    = '1';
    btn.style.maxWidth   = '320px';
    btn.style.padding    = '0 18px';
    btn.innerHTML = labelHtml(ICON_SAVE, 'Save to Pipeline');
  }

  function setLoading(btn) {
    btn.dataset.state    = 'loading';
    btn.disabled         = true;
    btn.style.background = BG.loading;
    btn.style.cursor     = 'wait';
    btn.innerHTML        = labelHtml(SPINNER_HTML, 'Saving…');
  }

  function setSuccess(btn, text) {
    btn.dataset.state    = 'success';
    btn.disabled         = false;
    btn.style.background = BG.success;
    btn.style.cursor     = 'default';
    btn.style.boxShadow  = '0 4px 20px rgba(22,163,74,0.4), 0 2px 6px rgba(0,0,0,0.12)';
    btn.innerHTML        = labelHtml(ICON_CHECK, text);
    // Collapse to a small pill after 4 s
    setTimeout(() => { if (btn.isConnected) collapseBtn(btn); }, 4000);
  }

  function setDuplicate(btn) {
    btn.dataset.state    = 'duplicate';
    btn.disabled         = false;
    btn.style.background = BG.duplicate;
    btn.style.cursor     = 'default';
    btn.innerHTML        = labelHtml(ICON_CHECK, 'Already in pipeline');
    setTimeout(() => { if (btn.isConnected) collapseBtn(btn); }, 4000);
  }

  function setError(btn, text) {
    btn.dataset.state    = 'error';
    btn.disabled         = false;
    btn.style.background = BG.error;
    btn.style.cursor     = 'pointer';
    btn.style.boxShadow  = '0 4px 16px rgba(220,38,38,0.3), 0 2px 6px rgba(0,0,0,0.12)';
    btn.innerHTML        = labelHtml(ICON_X, text);
    setTimeout(() => { if (btn.isConnected) setIdle(btn); }, 3500);
  }

  function collapseBtn(btn) {
    btn.dataset.state   = 'collapsed';
    btn.style.maxWidth  = '46px';
    btn.style.padding   = '0';
    btn.style.opacity   = '0.75';
    btn.style.cursor    = 'pointer';
  }

  function expandBtn(btn) {
    btn.style.maxWidth = '320px';
    btn.style.padding  = '0 18px';
    btn.style.opacity  = '1';
  }

  // ── Save handler ─────────────────────────────────────────────────────────

  async function handleSave() {
    const btn = document.getElementById(BTN_ID);
    if (!btn || btn.disabled) return;
    if (btn.dataset.state === 'success' || btn.dataset.state === 'duplicate') return;

    setLoading(btn);

    // Extract listing data
    let payload;
    try {
      payload = extractListing();
    } catch (err) {
      setError(btn, 'Extraction error');
      console.error('[CP] extraction error:', err);
      return;
    }

    if (!payload) {
      setError(btn, 'Open a full listing page');
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
      setError(btn, 'Network error — try again');
      console.error('[CP] network error:', netErr);
      return;
    }

    if (resp && resp.ok) {
      const photos = resp.photos || 0;
      const score  = resp.score  != null ? ` · Q:${resp.score}` : '';
      setSuccess(btn, `Saved! ${photos} photo${photos !== 1 ? 's' : ''}${score}`);
      chrome.runtime.sendMessage({ type: 'SAVED' });

    } else if (resp && resp.duplicate) {
      setDuplicate(btn);

    } else {
      const msg = (resp && resp.error) ? resp.error.slice(0, 38) : 'Server error';
      setError(btn, 'Failed: ' + msg);
    }
  }

  // ── Data extraction from __NEXT_DATA__ ────────────────────────────────────

  function extractListing() {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;

    let nd;
    try { nd = JSON.parse(el.textContent); } catch (e) { return null; }

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
          if (v.property && v.property.zpid)                                               { prop = v.property; break; }
          if (v.data && v.data.property && v.data.property.zpid)                           { prop = v.data.property; break; }
          if (v.zpid !== undefined && (v.bedrooms !== undefined || v.price !== undefined))  { prop = v; break; }
        }
      } catch (_) {}
    }

    if (!prop) {
      try {
        const cp = nd.props.pageProps.componentProps;
        if (cp && cp.homeDetails && cp.homeDetails.zpid) prop = cp.homeDetails;
      } catch (_) {}
    }

    if (!prop) return null;

    const rf   = prop.resoFacts || {};
    const addr = prop.address   || {};

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

    const rawPrice = prop.price || prop.unformattedPrice;
    let rent = null;
    if (typeof rawPrice === 'number' && rawPrice > 0) rent = rawPrice;
    else if (rawPrice) { const d = String(rawPrice).replace(/[^0-9]/g,''); rent = d ? parseInt(d,10) : null; }
    if (!rent && prop.rentZestimate) rent = parseInt(String(prop.rentZestimate),10) || null;

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

    const TYPE_MAP = {
      SINGLE_FAMILY:'SINGLE_FAMILY', MULTI_FAMILY:'MULTI_FAMILY', CONDO:'CONDOS',
      CONDO_TOWNHOME:'CONDOS', TOWNHOUSE:'TOWNHOMES', APARTMENT:'APARTMENT',
      MANUFACTURED:'MOBILE', MOBILE:'MOBILE', LOT:'LAND', LAND:'LAND', FARM:'FARM',
    };
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
