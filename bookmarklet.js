// ============================================================
// Choice Properties — Zillow Bookmarklet v1.0
// Hosted on Replit. Loaded remotely so fixes apply instantly.
// ============================================================
(function () {
  'use strict';

  const EDGE_URL = 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
  const SECRET   = 'cp_import_7Kx3m9P2w5';

  // ── Guard: must be on a Zillow listing page ───────────────────────────────
  if (!location.href.includes('zillow.com') || !location.href.includes('/homedetails/')) {
    showToast('error', '⚠ Open a Zillow listing first', 'Navigate to a Zillow property detail page, then click the bookmarklet.');
    return;
  }

  // ── Prevent double-run ────────────────────────────────────────────────────
  if (document.getElementById('cp-bm-overlay')) {
    document.getElementById('cp-bm-overlay').remove();
  }

  // ── Inject keyframe CSS ───────────────────────────────────────────────────
  if (!document.getElementById('cp-bm-styles')) {
    const style = document.createElement('style');
    style.id = 'cp-bm-styles';
    style.textContent = `
      @keyframes cp-slide-in  { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      @keyframes cp-slide-out { from { transform: translateY(0);    opacity: 1; } to { transform: translateY(24px); opacity: 0; } }
      @keyframes cp-spin      { to   { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  // ── Show loading panel immediately ───────────────────────────────────────
  const panel = createPanel();
  setLoading(panel);

  // ── Extract + send ────────────────────────────────────────────────────────
  let payload;
  try {
    payload = extractListing();
  } catch (err) {
    setResult(panel, 'error', '⚠ Extraction error', 'Could not read listing data from this page. Try reloading Zillow and clicking again.\n\nDetails: ' + err.message);
    return;
  }

  if (!payload) {
    setResult(panel, 'error', '⚠ No listing found', 'Make sure you\'re on a Zillow property detail page (the URL should contain /homedetails/).');
    return;
  }

  fetch(EDGE_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-import-secret': SECRET },
    body:    JSON.stringify(payload),
  })
    .then(function (r) { return r.json(); })
    .then(function (resp) {
      if (resp && resp.ok) {
        const photos = resp.photos || 0;
        const score  = resp.score != null ? ' · Quality: ' + resp.score + '/100' : '';
        const addr   = [payload.address, payload.city, payload.state].filter(Boolean).join(', ');
        setResult(panel, 'success',
          '✓ Saved to Pipeline',
          (payload.title || 'Listing') + '\n' + addr + (payload.monthly_rent ? '\n$' + Number(payload.monthly_rent).toLocaleString() + '/mo' : '') + '\n' + photos + ' photo' + (photos !== 1 ? 's' : '') + ' captured' + score
        );
      } else if (resp && resp.duplicate) {
        setResult(panel, 'duplicate', '⊙ Already in pipeline', 'This listing is already saved.\n\nCheck your admin pipeline to review it.');
      } else {
        const msg = (resp && resp.error) ? resp.error : 'Unknown server error.';
        setResult(panel, 'error', '✕ Save failed', msg + '\n\nTry clicking again in a moment.');
      }
    })
    .catch(function (err) {
      setResult(panel, 'error', '✕ Network error', 'Could not reach the server. Check your internet connection and try again.\n\nDetails: ' + err.message);
    });

  // ── UI helpers ────────────────────────────────────────────────────────────

  function createPanel() {
    const el = document.createElement('div');
    el.id = 'cp-bm-overlay';
    Object.assign(el.style, {
      position:      'fixed',
      bottom:        '24px',
      right:         '24px',
      zIndex:        '2147483647',
      width:         '320px',
      background:    '#fff',
      borderRadius:  '14px',
      boxShadow:     '0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.1)',
      fontFamily:    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize:      '14px',
      lineHeight:    '1.5',
      color:         '#111',
      overflow:      'hidden',
      animation:     'cp-slide-in 0.25s ease',
      boxSizing:     'border-box',
    });

    // Header bar
    const header = document.createElement('div');
    Object.assign(header.style, {
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'space-between',
      padding:        '12px 16px',
      background:     '#6366f1',
      color:          '#fff',
    });
    const title = document.createElement('span');
    title.textContent = 'Choice Properties';
    Object.assign(title.style, { fontWeight: '700', fontSize: '13px', letterSpacing: '0.01em' });
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      background: 'transparent', border: 'none', color: '#fff',
      cursor: 'pointer', fontSize: '14px', padding: '0', lineHeight: '1',
      opacity: '0.8',
    });
    closeBtn.addEventListener('click', function () { dismissPanel(el); });
    header.appendChild(title);
    header.appendChild(closeBtn);

    // Body
    const body = document.createElement('div');
    body.id = 'cp-bm-body';
    Object.assign(body.style, { padding: '16px' });

    el.appendChild(header);
    el.appendChild(body);
    document.body.appendChild(el);
    return el;
  }

  function setLoading(panel) {
    const body = panel.querySelector('#cp-bm-body');
    body.innerHTML = '';

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '10px' });

    const spinner = document.createElement('div');
    Object.assign(spinner.style, {
      width: '18px', height: '18px', flexShrink: '0',
      border: '2.5px solid #e0e0e0', borderTopColor: '#6366f1',
      borderRadius: '50%', animation: 'cp-spin 0.7s linear infinite',
    });

    const txt = document.createElement('span');
    txt.textContent = 'Saving to pipeline…';
    Object.assign(txt.style, { color: '#555' });

    row.appendChild(spinner);
    row.appendChild(txt);
    body.appendChild(row);
  }

  function setResult(panel, type, headline, detail) {
    const COLORS = { success: '#16a34a', error: '#dc2626', duplicate: '#a16207' };
    const body = panel.querySelector('#cp-bm-body');
    body.innerHTML = '';

    const h = document.createElement('div');
    h.textContent = headline;
    Object.assign(h.style, {
      fontWeight: '700', fontSize: '15px',
      color: COLORS[type] || '#111', marginBottom: '8px',
    });

    const d = document.createElement('div');
    d.textContent = detail;
    Object.assign(d.style, { color: '#555', fontSize: '13px', whiteSpace: 'pre-line', lineHeight: '1.55' });

    body.appendChild(h);
    body.appendChild(d);

    if (type === 'success' || type === 'duplicate') {
      const link = document.createElement('a');
      link.textContent = 'Open pipeline →';
      link.href = 'https://choice-properties-site.pages.dev/admin/pipeline.html';
      link.target = '_blank';
      Object.assign(link.style, {
        display: 'inline-block', marginTop: '12px',
        color: '#6366f1', fontWeight: '600', textDecoration: 'none', fontSize: '13px',
      });
      body.appendChild(link);
      // Auto-dismiss after 8 s
      setTimeout(function () { if (panel.isConnected) dismissPanel(panel); }, 8000);
    }
  }

  function dismissPanel(panel) {
    panel.style.animation = 'cp-slide-out 0.2s ease forwards';
    setTimeout(function () { if (panel.isConnected) panel.remove(); }, 220);
  }

  function showToast(type, headline, detail) {
    // Fallback when not on a listing page — just alert
    alert(headline + '\n\n' + detail);
  }

  // ── Listing extractor (same logic as content.js, self-contained) ──────────

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
          if (v.property && v.property.zpid)                                              { prop = v.property; break; }
          if (v.data && v.data.property && v.data.property.zpid)                          { prop = v.data.property; break; }
          if (v.zpid !== undefined && (v.bedrooms !== undefined || v.price !== undefined)) { prop = v; break; }
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
    const addPhoto = function (u) { if (u && typeof u === 'string' && u.startsWith('http') && !seen.has(u)) { photos.push(u); seen.add(u); } };
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
    const addA = function (v) { if(v&&typeof v==='string'){const t=v.trim();if(t) amenityMap[t]=true;} };
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

    const fmtType = function (t) { return !t ? 'Rental' : t.replace(/_/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();}); };
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
      has_central_air:      !!(rf.hasCooling || (rf.cooling && rf.cooling.some(function(c){return c.toLowerCase().includes('central');}))),
      original_image_urls:  JSON.stringify(photos.slice(0,50)),
      agent_name:           (prop.attributionInfo && prop.attributionInfo.agentName)  || null,
      broker_name:          (prop.attributionInfo && prop.attributionInfo.brokerName) || null,
      _import:              'bookmarklet-v1',
    };
  }

})();
