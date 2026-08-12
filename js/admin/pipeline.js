(function(){
  'use strict';

  let S;            // AdminShell
  let _status   = 'scraped';
  let _source   = null;    // null = all, 'zillow', 'realtor'
  let _quality  = null;    // null = all, 'high' (≥80), 'mid' (60-79), 'low' (<60)
  let _search   = '';      // address search query
  let _page     = 0;
  const PAGE    = 40;
  let _hasMore  = false;
  let _loading  = false;
  let _pageData = [];   // all fetched listings (unfiltered by source/search)
  let _current  = null; // listing open in panel
  let _dirty    = {};   // unsaved field changes
  let _landlords = [];  // cache for publish landlord picker
  let _selected  = new Set(); // IDs of selected cards for bulk actions

  // ── Session cache (30 s TTL — avoid re-fetch on back-navigation) ──────────
  const _CPFX = 'pl_v1_';
  const _CTTL = 30000;
  function _cGet(k){ try{ const r=sessionStorage.getItem(_CPFX+k); if(!r) return null; const {t,d}=JSON.parse(r); return Date.now()-t>_CTTL?null:d; }catch{ return null; } }
  function _cSet(k,d){ try{ sessionStorage.setItem(_CPFX+k,JSON.stringify({t:Date.now(),d})); }catch{} }
  function _cClear(){ try{ Object.keys(sessionStorage).filter(k=>k.startsWith(_CPFX)).forEach(k=>sessionStorage.removeItem(k)); }catch{} }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function fmt$$(n){ return n != null ? '$' + Number(n).toLocaleString() : '—'; }
  function fmtBeds(l){ return [l.bedrooms != null ? l.bedrooms + ' bd' : null, l.bathrooms != null ? l.bathrooms + ' ba' : null].filter(Boolean).join(' · ') || '—'; }
  function fmtSqft(l){ return l.square_footage ? l.square_footage.toLocaleString() + ' sqft' : ''; }
  function parseJSON(s){ try{ return s ? JSON.parse(s) : null; }catch(_){ return null; } }

  // ── Pre-publish validation gate ──────────────────────────────────────────────
  // Mirrors validate_for_publish() in scraper/enrichment.py.
  // Must pass before any pipeline record is promoted to a live listing.
  // Returns { ok: boolean, failures: string[] }.
  //
  // Image check:
  //   - If the listing already has a choice_property_id (re-published before),
  //     fetch real photo count from property_photos (confirmed ImageKit uploads).
  //   - Otherwise check original_image_urls — source photos must exist so
  //     import-pipeline-photos can transfer them immediately post-publish.
  async function validateForPublish(listing) {
    const failures = [];
    const desc = listing.description || '';

    // 1. Image check — check both source URLs AND ImageKit URLs
    const sourceUrls = parseJSON(listing.original_image_urls) || [];
    const hasImages = sourceUrls.length > 0;
    const hasImageKit = sourceUrls.some(u => u.includes('ik.imagekit.io'));

    if (listing.choice_property_id) {
      // Already published once — count confirmed ImageKit photos.
      const { data: existingPhotos } = await CP.sb()
        .from('property_photos')
        .select('id')
        .eq('property_id', listing.choice_property_id);
      const transferred = existingPhotos ? existingPhotos.length : 0;
      if (transferred === 0 && !hasImages) {
        failures.push('No images available — add at least one photo before publishing');
      }
    } else {
      // First publish — source photos must exist (transferred post-publish by import-pipeline-photos)
      if (!hasImages) {
        failures.push('No source images available — add at least one photo before publishing');
      }
    }

    // 2. Rent must be set and reasonable
    if (!listing.monthly_rent || listing.monthly_rent <= 0) {
      failures.push('Monthly rent is not set');
    } else if (listing.monthly_rent > 100000) {
      failures.push('Monthly rent looks incorrect ($' + listing.monthly_rent + ') — please verify');
    }

    // 3. Free-application language in description
    const freeAppRe = /free\s+(?:to\s+)?apply|apply\s+for\s+free|no\s+(?:application\s+|app\s+)?fee|\$\s*0\.?0*\s+(?:application\s+|app\s+)?fee|zero\s+(?:application\s+)?fee|complimentary\s+application|application\s+(?:is\s+)?free|fee[- ]?free\s+application|free\s+application/i;
    if (freeAppRe.test(desc)) {
      failures.push('Description contains free-application language (must say "Application Fee: $50")');
    }

    // 4. Non-$50 application fee amount in description
    // Two patterns: trailing-dollar ("application fee: $35") and
    //               leading-dollar  ("$35 application fee").
    const _feeAmounts = [];
    const _feePat1 = /(?:application|app)\s+fee[:\s]+\$?\s*(\d+(?:\.\d{2})?)/gi;
    const _feePat2 = /\$\s*(\d+(?:\.\d{2})?)\s+(?:application|app)\s+fee/gi;
    let _fm;
    while ((_fm = _feePat1.exec(desc)) !== null) { _feeAmounts.push(parseFloat(_fm[1])); }
    while ((_fm = _feePat2.exec(desc)) !== null) { _feeAmounts.push(parseFloat(_fm[1])); }
    _feeAmounts.forEach(function(amt) {
      if (Math.abs(amt - 50) > 0.01) {
        failures.push('Description references a non-$50 application fee ($' + amt + ')');
      }
    });

    // 5. Tour / showing / contact CTA language
    const tourRe = /schedule\s+a\s+(?:tour|showing|viewing)|book\s+a\s+(?:tour|showing)|open\s+house|contact\s+(?:us|the\s+agent|the\s+landlord|owner)/i;
    if (tourRe.test(desc)) {
      failures.push('Description contains tour/showing/contact CTA language');
    }

    // 6. External portal application instructions
    const portalRe = /turbotenant|zillow\s+application|apartments\.com|apply\s+on\s+\w+|listing\s*id\s*#?\s*\d+/i;
    if (portalRe.test(desc)) {
      failures.push('Description references an external application portal');
    }

    return { ok: failures.length === 0, failures };
  }

  function qsClass(score){ if(score == null) return ''; return score >= 80 ? 'qs-high' : score >= 60 ? 'qs-mid' : 'qs-low'; }
  function qsBadge(score){
    if(score == null) return '';
    return `<span class="qs-badge ${qsClass(score)}" title="Data quality score">Q: ${score}</span>`;
  }
  function statusChip(status){
    const map = { scraped:'', edited:'info', published:'success', archived:'' };
    return S.statusPill ? S.statusPill(status) : `<span class="pill ${map[status]||''}">${status}</span>`;
  }
  function imageUrls(raw){
    const imgs = parseJSON(raw) || [];
    if (!Array.isArray(imgs)) return [];
    return imgs.map(function(item){
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && typeof item.url === 'string') return item.url;
      return null;
    }).filter(Boolean);
  }
  function thumbUrl(l){
    const imgs = imageUrls(l.original_image_urls);
    return (imgs && imgs.length) ? imgs[0] : null;
  }
  function photoUrls(l){
    return imageUrls(l.original_image_urls);
  }
  // Convert a stored JSON array to a user-editable comma-separated string
  function jArrToText(v){
    if(!v || v === '[]') return '';
    const arr = parseJSON(v);
    if(!arr || !arr.length) return typeof v === 'string' && !v.startsWith('[') ? v : '';
    return arr.map(function(item){
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && typeof item.url === 'string') return item.url;
      return '';
    }).filter(Boolean).join(', ');
  }
  // Convert a comma-separated text string back to a JSON array string for storage
  function textToJArr(s){
    if(!s || !s.trim()) return '[]';
    return JSON.stringify(s.split(',').map(x => x.trim()).filter(Boolean));
  }
  // Returns the import type for labelling in the panel
  // 'ios'       — imported via iOS Scriptable from Zillow detail page (has full data)
  // 'admin-url' — imported via admin "Import URL" button on desktop
  // 'enriched'  — Realtor.com Phase 2 detail scrape complete
  // 'search'    — basic search-results scrape only (limited data)
  function importSource(l){
    const od = parseJSON(l.original_data);
    if(od && od._import && String(od._import).startsWith('ios-scriptable')) return 'ios';
    if(od && od._import && String(od._import).startsWith('admin-url-import')) return 'admin-url';
    if(od && od._phase === 'detail') return 'enriched';
    return 'search';
  }

  // Returns true if the listing was enriched by Phase 2 detail scraping
  function isEnriched(l){
    const od = parseJSON(l.original_data);
    return od && od._phase === 'detail';
  }

  // Returns true if the listing has full detail data (either Phase 2 or iOS/admin import)
  function hasDetailData(l){
    const src = importSource(l);
    return src === 'ios' || src === 'enriched' || src === 'admin-url';
  }

  // Returns _pageData filtered by active source, quality, and search query
  function visibleListings(){
    let list = _pageData;
    if(_source) list = list.filter(l => (l.source || '') === _source);
    if(_quality){
      list = list.filter(l => {
        const s = l.data_quality_score ?? 0;
        if(_quality === 'high') return s >= 80;
        if(_quality === 'mid')  return s >= 60 && s < 80;
        if(_quality === 'low')  return s < 60;
        return true;
      });
    }
    if(_search){
      const q = _search.toLowerCase();
      list = list.filter(l => {
        const addr = (l.address  || '').toLowerCase();
        const city = (l.city    || '').toLowerCase();
        const st   = (l.state   || '').toLowerCase();
        const zip  = (l.zip     || '').toLowerCase();
        const unit = (l.unit_number || '').toLowerCase();
        return addr.includes(q) || city.includes(q) || st.includes(q) || zip.includes(q) || unit.includes(q);
      });
    }
    return list;
  }

  // Update search result count display
  function updateSearchCount(visible){
    const el  = document.getElementById('pl-search-count');
    const clr = document.getElementById('pl-search-clear');
    if(!el) return;
    if(_search){
      el.textContent  = visible.length + ' result' + (visible.length !== 1 ? 's' : '') + ' for "' + _search + '"';
      el.style.display = 'block';
      if(clr) clr.style.display = 'block';
    } else {
      el.style.display = 'none';
      if(clr) clr.style.display = 'none';
    }
  }

  // Sync the bulk action bar visibility + count
  function updateBulkBar(){
    const bar   = document.getElementById('pl-bulk-bar');
    const count = document.getElementById('pl-bulk-count');
    const chkAll = document.getElementById('pl-select-all');
    if(!bar) return;
    const n = _selected.size;
    if(n === 0){
      bar.classList.remove('visible');
    } else {
      bar.classList.add('visible');
      if(count) count.textContent = n + ' selected';
    }
    // Keep select-all checkbox in sync
    if(chkAll){
      const publishable = visibleListings().filter(l => l.status !== 'published' && l.status !== 'archived');
      chkAll.indeterminate = n > 0 && n < publishable.length;
      chkAll.checked = publishable.length > 0 && publishable.every(l => _selected.has(l.id));
    }
  }

  // ── Data ────────────────────────────────────────────────────────────────────

  async function fetchCounts(){
    const { data, error } = await CP.sb().rpc('pipeline_count');
    if(error || !data) return;
    const c = typeof data === 'string' ? JSON.parse(data) : data;
    const total = Object.values(c).reduce((a,b) => a + Number(b), 0);
    document.getElementById('cnt-scraped').textContent   = c.scraped   || 0;
    document.getElementById('cnt-edited').textContent    = c.edited    || 0;
    document.getElementById('cnt-published').textContent = c.published || 0;
    document.getElementById('cnt-archived').textContent  = c.archived  || 0;
    document.getElementById('cnt-all').textContent       = total;
  }

  async function fetchListings(status, page){
    const ck = status + '_' + page;
    const cv = _cGet(ck);
    if(cv){ _hasMore = cv.m; return cv.r; }
    const { data, error } = await CP.sb().rpc('pipeline_list', {
      p_status: status,
      p_limit:  PAGE + 1,
      p_offset: page * PAGE
    });
    if(error) throw error;
    const rows = typeof data === 'string' ? JSON.parse(data) : (data || []);
    _hasMore = rows.length > PAGE;
    const r = _hasMore ? rows.slice(0, PAGE) : rows;
    _cSet(ck, {r, m: _hasMore});
    return r;
  }

  async function loadLandlords(){
    if(_landlords.length) return _landlords;
    const { data } = await CP.sb().rpc('admin_list_landlords', { p_page: 0, p_per_page: 200 }).catch(() => ({ data: null }));
    const rows = Array.isArray(data) ? data : [];
    _landlords = rows.map(r => ({ id: r.id, name: r.contact_name || r.business_name || r.id }));
    return _landlords;
  }

  // ── Render: list ────────────────────────────────────────────────────────────

  function renderCard(l){
    const photos = photoUrls(l);
    const thumb = photos[0];
    const score = l.data_quality_score;
    const missing = parseJSON(l.missing_fields) || [];
    const isPublished = l.status === 'published';
    const isArchived  = l.status === 'archived';
    const isChecked   = _selected.has(l.id);
    const srcLabel = l.source === 'zillow' ? 'Zillow' : l.source === 'realtor' ? 'Realtor' : (l.source ? S.esc(l.source) : '');
    const srcImp = importSource(l);
    const folderBadge = l.folder_serial ? `<span class="qs-badge" style="background:rgba(99,102,241,.15);color:var(--brand)" title="Folder serial number">#${l.folder_serial}</span>` : '';

    return `<div class="pl-card${isChecked ? ' pl-card-selected' : ''}" data-pl-id="${S.esc(l.id)}" role="button" tabindex="0" aria-label="${S.esc((l.address||'Listing') + ', ' + (l.city||''))}">
      <div class="pl-thumb-wrap">
        ${photos.length > 1 ? `<div class="pl-thumb-strip">${photos.slice(0, Math.min(5, photos.length)).map((u, i) => `<img class="pl-thumb-strip-img" src="" data-src="${S.esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer"${i === 0 ? ' style="display:block;flex:0 0 100%"' : ''} onerror="this.style.display='none'">`).join('')}</div>` : (thumb ? `<img class="pl-thumb" src="" data-src="${S.esc(thumb)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : '')}
        <div class="pl-thumb-placeholder"${thumb ? ' style="display:none"' : ''}>
          <svg class="i" width="28" height="28" style="opacity:.2"><use href="#i-property"/></svg>
        </div>
        ${photos.length > 1 ? `<div class="pl-photo-count-badge">${photos.length} photos</div>` : ''}
        <label class="pl-card-check" onclick="event.stopPropagation()" title="Select">
          <input type="checkbox" class="pl-check" data-id="${S.esc(l.id)}" ${isChecked ? 'checked' : ''} aria-label="Select listing">
        </label>
        <div class="pl-card-badges">
          ${l.source ? `<span class="src-badge src-${S.esc(l.source)}">${srcLabel}</span>` : ''}
          ${qsBadge(score)}
          ${folderBadge}
          ${srcImp === 'admin-url' ? `<span class="qs-badge qs-high" title="Imported via admin URL import">🖥 Desktop</span>` : ''}
          ${isPublished && l.choice_property_id ? `<a href="/property.html?id=${S.esc(l.choice_property_id)}" class="qs-badge qs-high" style="text-decoration:none;pointer-events:auto" target="_blank" onclick="event.stopPropagation()">Live ↗</a>` : ''}
          ${isPublished && l.photo_import_status === 'failed' ? `<span class="qs-badge qs-low" title="${S.esc(l.last_photo_import_error || 'Photo transfer to ImageKit failed')} — listing stays hidden from the public site until photos are added">⏳ Pending images</span>` : ''}
          ${l.source_status && l.source_status !== 'available' ? `<span class="qs-badge ${l.source_status === 'pending' ? 'qs-mid' : 'qs-low'}" title="Source site status: ${S.esc(l.source_status)}">${l.source_status === 'pending' ? '⏳ Pending' : l.source_status === 'rented' ? '🔒 Rented' : '⚠ ' + S.esc(l.source_status)}</span>` : ''}
        </div>
      </div>
      <div class="pl-body">
        <div class="pl-addr">${S.esc(l.address || '(no address)')}${l.unit_number ? ' #'+S.esc(l.unit_number) : ''}</div>
        <div class="pl-meta">${S.esc([l.city, l.state].filter(Boolean).join(', '))}${l.zip ? ' '+S.esc(l.zip) : ''} · ${fmtBeds(l)}${l.square_footage ? ' · '+fmtSqft(l) : ''}</div>
        <div class="pl-rent">${fmt$$(l.monthly_rent)}/mo</div>
        <div class="pl-tags">
          ${missing.length ? `<span class="qs-badge qs-low" title="Missing: ${S.esc(missing.join(', '))}">${missing.length} missing</span>` : '<span class="qs-badge qs-high">✓ Complete</span>'}
          ${isEnriched(l) ? `<span class="qs-badge qs-high" title="Phase 2 scrape data available">Full data</span>` : ''}
          ${l.available_date ? `<span class="qs-badge" style="background:rgba(99,102,241,.1);color:var(--brand)">Avail ${S.esc(l.available_date)}</span>` : ''}
          ${l.listed_at ? `<span class="qs-badge" style="background:rgba(120,120,120,.08);color:var(--text-muted)" title="Original listing date on source site">Listed ${S.esc(new Date(l.listed_at + 'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'}))}</span>` : `<span class="qs-badge" style="background:rgba(120,120,120,.08);color:var(--text-muted)" title="No original listing date — using import date">Imported ${S.esc(new Date(l.scraped_at).toLocaleDateString('en-US',{month:'short',day:'numeric'}))}</span>`}
        </div>
      </div>
      <div class="pl-card-ft" onclick="event.stopPropagation()">
        ${!isArchived ? `<button class="btn btn-sm btn-ghost pl-arc-btn" data-id="${S.esc(l.id)}" title="Archive">Archive</button>` : '<span class="pill pill-muted" style="font-size:.68rem">Archived</span>'}
        ${!isPublished && !isArchived ? `<button class="btn btn-sm btn-primary pl-pub-btn" data-id="${S.esc(l.id)}" title="Publish to site">Publish →</button>` : ''}
        ${l.photo_import_status === 'failed' && !isArchived ? `<button class="btn btn-sm btn-outline pl-retry-photos-btn" data-id="${S.esc(l.id)}" data-prop-id="${S.esc(l.choice_property_id || '')}" title="Retry downloading photos to ImageKit">Retry photos</button>` : ''}
        ${isPublished && l.choice_property_id ? `<a class="btn btn-sm btn-ghost" href="/admin/property-detail.html?id=${S.esc(l.choice_property_id)}" target="_blank" onclick="event.stopPropagation()">Edit ↗</a>` : ''}
      </div>
    </div>`;
  }

  function renderList(listings, append){
    const wrap = document.getElementById('pl-list');
    updateSearchCount(listings);
    if(!append){
      wrap.innerHTML = listings.length
        ? listings.map(renderCard).join('')
        : `<div class="pl-empty">
             <svg class="i"><use href="#i-check"/></svg>
             <h3>${_search ? 'No matches' : 'Nothing here'}</h3>
             <p>${_search
               ? 'No listings match <strong>' + S.esc(_search) + '</strong>. Try a different address or clear the search.'
               : 'No listings with status "' + _status + '"' + (_source ? ' from ' + _source : '') + ' in the pipeline.'
             }</p>
           </div>`;
    } else {
      listings.forEach(l => wrap.insertAdjacentHTML('beforeend', renderCard(l)));
    }
    document.getElementById('load-more-wrap').style.display = _hasMore && !_search ? '' : 'none';
  }

  // ── Render: detail panel ─────────────────────────────────────────────────────

  function withTimeout(promise, ms){
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Photo request timed out')), ms))
    ]);
  }

  async function panelPhotos(l){
    const imgs = imageUrls(l.original_image_urls);
    
    // If published and has a choice_property_id, fetch the actual ImageKit photos
    // from property_photos (transferred by import-pipeline-photos).
    if(l.choice_property_id){
      try {
        const photoQuery = CP.sb()
          .from('property_photos')
          .select('url,display_order')
          .eq('property_id', l.choice_property_id)
          .order('display_order', { ascending: true })
          .limit(50);
        const { data: photos, error } = await withTimeout(photoQuery, 8000);
        
        if(!error && Array.isArray(photos) && photos.length){
          const urls = photos.map(p => p.url).filter(Boolean);
          return renderPhotoStatus(l) + renderGallery(urls, 'on ImageKit');
        }
      } catch(err){
        console.warn('[pipeline] property photo query failed; using source photos', err);
      }
    }
    
    if(!imgs.length) return renderPhotoStatus(l) + '<p class="pl-photo-count">No photos from source.</p>';

    // FIX: Zillow/Realtor CDN images block hotlinking from the admin domain.
    // Use the admin session token to proxy non-ImageKit URLs through the
    // proxy-image edge function so they display correctly.
    // ImageKit URLs (ik.imagekit.io) work directly.
    try {
      const session = await withTimeout(CP.sb().auth.getSession(), 3000);
      const token = session?.data?.session?.access_token || '';
      const supabaseUrl = (window.CONFIG?.SUPABASE_URL || '').replace(/\/+$/, '');
      const proxied = imgs.map(u => {
        if (u.includes('ik.imagekit.io')) return u;
        if (!token || !supabaseUrl) return u;
        return supabaseUrl + '/functions/v1/proxy-image?url=' + encodeURIComponent(u) + '&token=' + encodeURIComponent(token);
      });
      return renderGallery(proxied, 'from source');
    } catch(_) {
      return renderGallery(imgs, 'from source');
    }
  }

  // ── Modern photo gallery carousel ─────────────────────────────────────────
  function renderGallery(urls, label){
    if(!urls.length) return '<p class="pl-photo-count">No photos available.</p>';
    const thumbs = urls.slice(0, 20).map((u, i) =>
      `<img class="pl-gallery-thumb${i === 0 ? ' active' : ''}" src="${S.esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-idx="${i}" onclick="event.stopPropagation()">`
    ).join('');
    return `
    <div class="pl-gallery" id="pl-gallery">
      <div class="pl-gallery-main">
        <img id="pl-gallery-img" src="${S.esc(urls[0])}" alt="" referrerpolicy="no-referrer">
        ${urls.length > 1 ? `
          <button class="pl-gallery-nav prev" id="pl-gallery-prev" aria-label="Previous photo">‹</button>
          <button class="pl-gallery-nav next" id="pl-gallery-next" aria-label="Next photo">›</button>
          <div class="pl-gallery-counter" id="pl-gallery-counter">1 / ${urls.length}</div>
        ` : ''}
      </div>
      ${urls.length > 1 ? `<div class="pl-gallery-thumbs" id="pl-gallery-thumbs">${thumbs}</div>` : ''}
      <div class="pl-photo-count">${urls.length} photo${urls.length!==1?'s':''} ${label}</div>
    </div>`;
  }

  function renderPhotoStatus(l){
    const photos = imageUrls(l.original_image_urls);
    const hasSource = photos.length > 0;
    const imported = Boolean(l.choice_property_id);
    const status = l.photo_import_status;
    const labels = [];

    if (imported) {
      if (status === 'failed') {
        labels.push(`<div class="pl-panel-alert pl-panel-alert-warning">Photo transfer to ImageKit failed. <button class="btn btn-sm btn-outline" id="pl-transfer-photos-btn" data-id="${S.esc(l.id)}" data-prop-id="${S.esc(l.choice_property_id)}">Retry transfer</button></div>`);
      } else if (status === 'pending') {
        labels.push('<div class="pl-panel-alert pl-panel-alert-info">Photo transfer is pending. It may take a few minutes to complete.</div>');
      } else {
        labels.push('<div class="pl-panel-alert pl-panel-alert-success">Photos are stored on ImageKit and ready for the live listing.</div>');
      }
    } else if (hasSource) {
      labels.push(`<div class="pl-panel-alert pl-panel-alert-info">${photos.length} source photo${photos.length!==1?'s':''} available. They will be transferred after publish.</div>`);
    } else {
      labels.push('<div class="pl-panel-alert pl-panel-alert-warning">No source photos found. Add at least one photo before publishing.</div>');
    }

    return labels.join('');
  }

  function missingTags(l){
    const m = parseJSON(l.missing_fields) || [];
    if(!m.length) return '<span style="font-size:.75rem;color:var(--success)">✓ All key fields present</span>';
    return `<div class="missing-tags">${m.map(f => `<span class="missing-tag">${S.esc(f)}</span>`).join('')}</div>`;
  }

  function fi(id, label, value, type, required, full, opts){
    const req = required ? ' required' : '';
    const cls = (full ? 'pl-form-grid full' : '');
    const inner = opts
      ? `<select id="pf-${id}"${req}>${opts.map(o => `<option value="${S.esc(o.v)}"${value===o.v?' selected':''}>${S.esc(o.l)}</option>`).join('')}</select>`
      : type === 'textarea'
        ? `<textarea id="pf-${id}"${req}>${S.esc(value??'')}</textarea>`
        : `<input id="pf-${id}" type="${type||'text'}" value="${S.esc(String(value??''))}"${req}>`;
    return `<div class="pl-field${required?' required':''}${cls ? ' '+cls : ''}"><label for="pf-${id}">${label}</label>${inner}</div>`;
  }

  function renderPanel(l){
    const score = l.data_quality_score;
    const isPublished = l.status === 'published';
    const isArchived  = l.status === 'archived';
    const editedFields = parseJSON(l.edited_fields) || [];
    const enriched = isEnriched(l);
    const srcType  = importSource(l);
    const photoCount = (parseJSON(l.original_image_urls) || []).length;

    return `
    <div class="pl-panel-hd">
      <div class="pl-panel-hd-body">
        <div class="pl-panel-title">${S.esc(l.address || '(no address)')}</div>
        <div class="pl-panel-sub">${S.esc([l.city, l.state, l.zip].filter(Boolean).join(', '))}
          ${score != null ? ` · <span class="qs-badge ${qsClass(score)}">Q: ${score}/100</span>` : ''}
          ${srcType === 'ios'       ? ` · <span class="qs-badge qs-high" title="Imported from Zillow detail page via iOS Scriptable">📱 iOS import</span>` :
            srcType === 'admin-url' ? ` · <span class="qs-badge qs-high" title="Imported via admin URL import on desktop">🖥 Desktop import</span>` :
            srcType === 'enriched'  ? ` · <span class="qs-badge qs-high" title="Phase 2 detail scrape complete">✓ Full data</span>` :
                                      ` · <span class="qs-badge qs-low" title="Only basic search data — open the listing and re-import for full details">Search only</span>`}
          ${editedFields.length ? ` · <span style="font-size:.7rem;color:var(--brand)">${editedFields.length} fields edited</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap">
          ${l.source_url ? `<a href="${S.esc(l.source_url)}" target="_blank" rel="noopener" class="pl-source-link">
            <svg class="i i-sm"><use href="#i-arrow"/></svg> View on ${S.esc(l.source||'source')}
          </a>` : ''}
          ${l.source === 'zillow' && l.source_url && srcType === 'search' ? `<button class="btn btn-sm btn-outline" id="pl-reimport-btn" style="font-size:.72rem;padding:3px 10px" title="Re-import full listing data from Zillow via desktop">↑ Import full details</button>` : ''}
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" id="pl-close-btn" aria-label="Close panel">✕</button>
    </div>

    <div class="pl-panel-body">

      <!-- Photos -->
      <div class="pl-section">
        <div class="pl-section-title">Photos from source ${photoCount ? `<span style="font-weight:400;color:var(--muted-2)">(${photoCount})</span>` : ''}</div>
        <div id="panel-photos-container">${photoCount ? '<span style="font-size:.75rem;color:var(--muted-2)">Loading…</span>' : ''}</div>
      </div>

      <!-- Missing fields -->
      <div class="pl-section">
        <div class="pl-section-title">Data quality</div>
        ${missingTags(l)}
      </div>

      <!-- Core fields -->
      <div class="pl-section">
        <div class="pl-section-title">Listing details</div>
        <div class="pl-form-grid full">${fi('title','Title', l.title,'text',true,true)}</div>
        <div class="pl-form-grid" style="margin-top:10px">
          ${fi('address','Street address', l.address,'text',true)}
          ${fi('city','City', l.city,'text',true)}
          ${fi('state','State', l.state,'text',true)}
          ${fi('zip','ZIP', l.zip,'text',true)}
          ${fi('county','County', l.county,'text',false)}
          ${fi('neighborhood','Neighborhood', l.neighborhood,'text',false)}
        </div>
      </div>

      <!-- Pricing & Size -->
      <div class="pl-section">
        <div class="pl-section-title">Pricing &amp; size</div>
        <div class="pl-form-grid">
          ${fi('monthly_rent','Monthly rent ($)', l.monthly_rent,'number',true)}
          ${fi('security_deposit','Security deposit ($)', l.security_deposit,'number',false)}
          ${fi('application_fee','App fee ($)', l.application_fee,'number',false)}
          ${fi('pet_deposit','Pet deposit ($)', l.pet_deposit,'number',false)}
          ${fi('parking_fee','Parking fee ($)', l.parking_fee,'number',false)}
          ${fi('hoa_fee','HOA fee ($)', l.hoa_fee,'number',false)}
          ${fi('bedrooms','Bedrooms', l.bedrooms,'number',false)}
          ${fi('bathrooms','Bathrooms', l.bathrooms,'number',false)}
          ${fi('square_footage','Sqft', l.square_footage,'number',false)}
          ${fi('lot_size_sqft','Lot sqft', l.lot_size_sqft,'number',false)}
          ${fi('year_built','Year built', l.year_built,'number',false)}
          ${fi('floors','Floors / stories', l.floors,'number',false)}
          ${fi('garage_spaces','Garage spaces', l.garage_spaces,'number',false)}
          ${fi('property_type','Property type', l.property_type,'text',false,false,[
            {v:'',l:'— select —'},{v:'SINGLE_FAMILY',l:'Single family'},{v:'CONDOS',l:'Condo'},
            {v:'TOWNHOMES',l:'Townhouse'},{v:'APARTMENT',l:'Apartment'},{v:'MULTI_FAMILY',l:'Multi-family'},
            {v:'MOBILE',l:'Mobile'},{v:'LAND',l:'Land'},{v:'FARM',l:'Farm'}
          ])}
          ${fi('available_date','Available date', l.available_date,'date',false)}
          ${fi('minimum_lease_months','Min lease (mo)', l.minimum_lease_months,'number',false)}
        </div>
      </div>

      <!-- Features -->
      <div class="pl-section">
        <div class="pl-section-title">Features ${hasDetailData(l) ? '' : '<span style="font-size:.65rem;font-weight:400;color:var(--muted-2)">(populated by Phase 2 scrape)</span>'}</div>
        <div class="pl-form-grid">
          ${fi('heating_type','Heating', l.heating_type,'text',false)}
          ${fi('cooling_type','Cooling', l.cooling_type,'text',false)}
          ${fi('laundry_type','Laundry', l.laundry_type,'text',false)}
          ${fi('has_central_air','Central air', l.has_central_air,'text',false,false,[
            {v:'',l:'— unknown —'},{v:'true',l:'Yes'},{v:'false',l:'No'}
          ])}
          ${fi('has_basement','Basement', l.has_basement,'text',false,false,[
            {v:'',l:'— unknown —'},{v:'true',l:'Yes'},{v:'false',l:'No'}
          ])}
          ${fi('parking','Parking', l.parking,'text',false)}
        </div>
        <div class="pl-form-grid full" style="margin-top:10px">
          ${fi('flooring','Flooring (comma-separated)', jArrToText(l.flooring),'text',false,true)}
        </div>
      </div>

      <!-- Appliances & Utilities -->
      <div class="pl-section">
        <div class="pl-section-title">Appliances &amp; utilities ${hasDetailData(l) ? '' : '<span style="font-size:.65rem;font-weight:400;color:var(--muted-2)">(populated by Phase 2 scrape)</span>'}</div>
        <div class="pl-form-grid full">
          ${fi('appliances','Appliances (comma-separated)', jArrToText(l.appliances),'text',false,true)}
          ${fi('utilities_included','Utilities included (comma-separated)', jArrToText(l.utilities_included),'text',false,true)}
          ${fi('amenities','Amenities / tags (comma-separated)', jArrToText(l.amenities),'textarea',false,true)}
        </div>
      </div>

      <!-- Description -->
      <div class="pl-section">
        <div class="pl-section-title">Description &amp; instructions</div>
        <div class="pl-form-grid full">
          ${fi('description','Description', l.description,'textarea',false,true)}
          ${fi('showing_instructions','Showing instructions', l.showing_instructions,'textarea',false,true)}
          ${fi('move_in_special','Move-in special / concession', l.move_in_special,'text',false,true)}
          ${fi('location_context','Location context', l.location_context,'text',false,true)}
          ${fi('virtual_tour_url','Virtual tour URL', l.virtual_tour_url,'url',false,true)}
        </div>
      </div>

      <!-- Policies -->
      <div class="pl-section">
        <div class="pl-section-title">Policies</div>
        <div class="pl-form-grid">
          ${fi('pets_allowed','Pets allowed', l.pets_allowed,'text',false,false,[
            {v:'',l:'— unknown —'},{v:'true',l:'Yes'},{v:'false',l:'No'}
          ])}
          ${fi('smoking_allowed','Smoking', l.smoking_allowed,'text',false,false,[
            {v:'',l:'— unknown —'},{v:'true',l:'Yes'},{v:'false',l:'No'}
          ])}
          ${fi('pet_types_allowed','Pet types (comma-sep)', jArrToText(l.pet_types_allowed),'text',false)}
          ${fi('lease_terms','Lease terms (comma-sep)', jArrToText(l.lease_terms),'text',false)}
        </div>
      </div>

      ${isPublished && l.choice_property_id ? `
      <div class="pl-section">
        <div class="pl-section-title">Published</div>
        <div style="display:flex;gap:10px;align-items:center">
          <a class="btn btn-sm btn-outline" href="/property.html?id=${S.esc(l.choice_property_id)}" target="_blank">View live listing ↗</a>
          <a class="btn btn-sm btn-outline" href="/admin/property-detail.html?id=${S.esc(l.choice_property_id)}">Edit full listing</a>
        </div>
      </div>` : ''}

      <div style="height:20px"></div>

    </div>

    <div class="pl-panel-ft">
      ${!isArchived && !isPublished ? `<button class="btn btn-ghost pl-arc-btn-panel" data-id="${S.esc(l.id)}">Archive</button>` : ''}
      <div style="flex:1"></div>
      ${!isPublished ? `<button class="btn btn-outline pl-save-btn" data-id="${S.esc(l.id)}">Save changes</button>` : ''}
      ${!isPublished && !isArchived ? `<button class="btn btn-primary pl-pub-btn-panel" data-id="${S.esc(l.id)}">Publish as draft →</button>` : ''}
    </div>`;
  }

  // ── Panel open / close ──────────────────────────────────────────────────────

  // Auto-fill county (and neighborhood if missing) via Geoapify reverse geocode.
  // Only fires when lat+lng are known and county is empty.
  async function autoFillLocation(l){
    const apiKey = window.CONFIG && CONFIG.GEOAPIFY_API_KEY;
    if(!apiKey || !l.lat || !l.lng) return;
    if(l.county) return; // already set — don't overwrite

    const panel = document.getElementById('pl-panel');
    if(!panel) return;

    const countyEl = panel.querySelector('#pf-county');
    const neighEl  = panel.querySelector('#pf-neighborhood');
    if(!countyEl) return;

    // Show subtle loading hint
    countyEl.placeholder = 'Looking up…';

    try {
      const res  = await fetch(`https://api.geoapify.com/v1/geocode/reverse?lat=${encodeURIComponent(l.lat)}&lon=${encodeURIComponent(l.lng)}&apiKey=${encodeURIComponent(apiKey)}`);
      if(!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const props = json?.features?.[0]?.properties;
      if(!props) throw new Error('No result');

      // county field — Geoapify calls it "county"
      const county = props.county || '';
      if(county && countyEl && !countyEl.value.trim()){
        countyEl.value = county;
        countyEl.style.borderColor = 'var(--brand)';
        setTimeout(() => { if(countyEl) countyEl.style.borderColor = ''; }, 2000);
      }

      // neighborhood — prefer suburb, then district, then city_district
      const neighborhood = props.suburb || props.district || props.city_district || '';
      if(neighborhood && neighEl && !neighEl.value.trim() && !l.neighborhood){
        neighEl.value = neighborhood;
        neighEl.style.borderColor = 'var(--brand)';
        setTimeout(() => { if(neighEl) neighEl.style.borderColor = ''; }, 2000);
      }

      if(county || neighborhood){
        S.toast('County' + (neighborhood ? ' & neighborhood' : '') + ' auto-filled from coordinates', 'info');
      }
    } catch(e){
      // silently ignore — user can fill county manually
    } finally {
      if(countyEl) countyEl.placeholder = '';
    }
  }

  function openPanel(l){
    _current = l;
    _dirty   = {};
    const panel    = document.getElementById('pl-panel');
    const backdrop = document.getElementById('pl-backdrop');
    panel.innerHTML = renderPanel(l);
    requestAnimationFrame(() => {
      panel.classList.add('open');
      backdrop.classList.add('open');
      document.body.style.overflow = 'hidden';
      panel.querySelector('#pl-close-btn').addEventListener('click', closePanel);
      // Focus first focusable input for accessibility
      const firstInput = panel.querySelector('input,select,textarea,button');
      if(firstInput) setTimeout(() => firstInput.focus(), 100);
      // Auto-fill county/neighborhood from lat+lng if missing
      autoFillLocation(l);
    });

      const saveBtn = panel.querySelector('.pl-save-btn');
      if(saveBtn) saveBtn.addEventListener('click', () => doSave(l.id));

      const arcBtn = panel.querySelector('.pl-arc-btn-panel');
      if(arcBtn) arcBtn.addEventListener('click', () => doArchive(l.id));

      const pubBtn = panel.querySelector('.pl-pub-btn-panel');
      if(pubBtn) pubBtn.addEventListener('click', () => doPublish(l.id));

      // Load photos asynchronously (may fetch from ImageKit for published listings)
      // FIX: photoCount was referenced from renderPanel() scope (undefined here),
      // so panelPhotos() never ran and "Loading…" stayed stuck on screen.
      // Now it always runs — panelPhotos() handles the empty case itself.
      const photoContainer = panel.querySelector('#panel-photos-container');
      if(photoContainer){
        panelPhotos(l).then(html => {
          if(photoContainer) photoContainer.innerHTML = html;
          wireGalleryEvents();
          wirePanelPhotoActions();
        }).catch(err => {
          console.error('[pipeline] photo gallery load failed', err);
          if(photoContainer) {
            photoContainer.innerHTML = '<p class="pl-photo-count" style="color:var(--danger,#dc2626)">Unable to load photos. Retry opening this listing.</p>';
          }
        });
      }

    // "Import full details" pre-fills the Import URL modal with this listing's source URL
    const reimportBtn = panel.querySelector('#pl-reimport-btn');
    if(reimportBtn) reimportBtn.addEventListener('click', () => {
      openImportModal(l.source_url);
    });
  }

  // ── Gallery navigation events ─────────────────────────────────────────────
  function wireGalleryEvents(){
    const gallery = document.getElementById('pl-gallery');
    if(!gallery) return;
    const img = document.getElementById('pl-gallery-img');
    const counter = document.getElementById('pl-gallery-counter');
    const thumbs = gallery.querySelectorAll('.pl-gallery-thumb');
    const prev = document.getElementById('pl-gallery-prev');
    const next = document.getElementById('pl-gallery-next');
    if(!img) return;
    const urls = thumbs.length ? Array.from(thumbs).map(t => t.src) : [img.src];
    let idx = 0;

    function show(i){
      idx = (i + urls.length) % urls.length;
      img.src = urls[idx];
      if(counter) counter.textContent = (idx + 1) + ' / ' + urls.length;
      thumbs.forEach((t, ti) => t.classList.toggle('active', ti === idx));
    }

    if(prev) prev.addEventListener('click', e => { e.stopPropagation(); show(idx - 1); });
    if(next) next.addEventListener('click', e => { e.stopPropagation(); show(idx + 1); });
    thumbs.forEach(t => {
      t.addEventListener('click', e => {
        e.stopPropagation();
        show(parseInt(t.dataset.idx || '0', 10));
      });
    });
    // Swipe support for mobile
    let startX = 0;
    const main = gallery.querySelector('.pl-gallery-main');
    if(main){
      main.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
      main.addEventListener('touchend', e => {
        const dx = e.changedTouches[0].clientX - startX;
        if(Math.abs(dx) > 40) show(idx + (dx < 0 ? 1 : -1));
      }, { passive: true });
    }
  }

function wirePanelPhotoActions(){
    const btn = document.getElementById('pl-transfer-photos-btn');
    if(!btn) return;
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = 'Retrying…';
      await doTransferPhotos(btn.dataset.id, btn.dataset.propId);
      btn.disabled = false;
      btn.textContent = 'Retry transfer';
    });
  }

  function closePanel(){
    const panel    = document.getElementById('pl-panel');
    const backdrop = document.getElementById('pl-backdrop');
    panel.classList.remove('open');
    backdrop.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => { panel.innerHTML = ''; _current = null; _dirty = {}; }, 300);
  }

  // ── Import from URL (desktop import) ────────────────────────────────────────

  function openImportModal(prefillUrl){
    // Remove any existing modal
    const existing = document.getElementById('pl-import-modal');
    if(existing) existing.remove();

    const folder = _activeFolder ? _folders.find(f => f.id === _activeFolder) : null;
    const folderNotice = folder ? `<div style="margin-bottom:14px;padding:12px 14px;border-radius:12px;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.18);font-size:.82rem;color:var(--muted-2)">This listing will be imported into the active folder: <strong>${S.esc(folder.name)}</strong>.</div>` : '';

    const modal = document.createElement('div');
    modal.id = 'pl-import-modal';
    modal.innerHTML = `
      <div class="pl-import-backdrop"></div>
      <div class="pl-import-dialog" role="dialog" aria-modal="true" aria-label="Import Zillow listing">
        <div class="pl-import-hd">
          <div style="font-size:.95rem;font-weight:700">Import Zillow listing</div>
          <button class="pl-import-close" aria-label="Close">✕</button>
        </div>
        <div class="pl-import-body">
          <p style="font-size:.82rem;color:var(--muted-2);margin:0 0 14px">
            Paste any Zillow listing detail URL. The server will fetch and parse the listing data automatically.
            <br><span style="font-size:.75rem;opacity:.8">Note: Zillow occasionally blocks datacenter IPs. If that happens, use the iOS importer instead.</span>
          </p>
          ${folderNotice}
          <div class="pl-field" style="margin-bottom:14px">
            <label for="pl-import-url">Zillow listing URL</label>
            <input id="pl-import-url" type="url" placeholder="https://www.zillow.com/homedetails/…" autocomplete="off" spellcheck="false">
          </div>
          <input type="hidden" id="pl-import-folder-id" value="${folder ? S.esc(folder.id) : ''}">
          <div id="pl-import-result" style="display:none"></div>
        </div>
        <div class="pl-import-ft">
          <button class="btn btn-ghost" id="pl-import-cancel">Cancel</button>
          <div style="flex:1"></div>
          <button class="btn btn-primary" id="pl-import-submit">Import listing →</button>
        </div>
      </div>`;

    document.body.appendChild(modal);

    // Wire events
    modal.querySelector('.pl-import-backdrop').addEventListener('click', closeImportModal);
    modal.querySelector('.pl-import-close').addEventListener('click', closeImportModal);
    document.getElementById('pl-import-cancel').addEventListener('click', closeImportModal);
    document.getElementById('pl-import-submit').addEventListener('click', doImportFromUrl);

    // Allow Enter to submit
    document.getElementById('pl-import-url').addEventListener('keydown', e => {
      if(e.key === 'Enter') { e.preventDefault(); doImportFromUrl(); }
    });

    // Pre-fill URL if provided (e.g. from "Import full details" button)
    if(prefillUrl){
      setTimeout(() => {
        const input = document.getElementById('pl-import-url');
        if(input){ input.value = prefillUrl; input.focus(); }
      }, 50);
    } else {
      setTimeout(() => {
        const input = document.getElementById('pl-import-url');
        if(input) input.focus();
      }, 50);
    }

    // ESC to close
    modal._escHandler = e => { if(e.key === 'Escape') closeImportModal(); };
    document.addEventListener('keydown', modal._escHandler);
  }

  function closeImportModal(){
    const modal = document.getElementById('pl-import-modal');
    if(!modal) return;
    if(modal._escHandler) document.removeEventListener('keydown', modal._escHandler);
    modal.remove();
  }

  async function doImportFromUrl(){
    const urlInput  = document.getElementById('pl-import-url');
    const submitBtn = document.getElementById('pl-import-submit');
    const resultEl  = document.getElementById('pl-import-result');
    const folderId  = document.getElementById('pl-import-folder-id');
    if(!urlInput || !submitBtn || !resultEl) return;

    const url = urlInput.value.trim();
    if(!url){
      urlInput.focus();
      return;
    }
    if(!url.includes('zillow.com')){
      showImportResult('error', 'Please paste a Zillow URL (zillow.com).');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Importing…';
    resultEl.style.display = 'none';

    try {
      const payload = { url };
      if(folderId && folderId.value) payload.folder_id = folderId.value;
      const { data, error } = await CP.sb().functions.invoke('import-from-url', {
        body: payload
      });
      if(error) throw error;
      const res = typeof data === 'string' ? JSON.parse(data) : data;

      if(res?.ok){
        // Success
        const score = res.score ?? '?';
        const photos = res.photos ?? 0;
        const city   = res.city   ? ' in ' + res.city : '';
        const pop    = res.populated_fields?.length ?? '?';
        const miss   = res.missing_fields?.length   ?? 0;

        showImportResult('success',
          `<strong>✓ Added to pipeline!</strong><br>
           <span style="font-size:.78rem">${S.esc(res.title||'')}${city}</span><br>
           <span style="font-size:.75rem;color:var(--muted-2);margin-top:4px;display:block">
             Quality score: <strong>${score}/100</strong> · ${photos} photo${photos!==1?'s':''} · ${pop} fields populated
             ${miss ? ` · <span style="color:var(--danger)">${miss} missing</span>` : ' · <span style="color:var(--success)">Complete</span>'}
           </span>`
        );
        submitBtn.textContent = '✓ Imported';

        // Refresh the list in the background
        _cClear();
        fetchCounts().catch(()=>{});
        setTimeout(async () => {
          try {
            const [listings] = await Promise.all([fetchListings(_status, 0), Promise.resolve()]);
            _pageData = listings;
            renderList(visibleListings(), false);
            wireCardEvents();
          } catch(_){}
        }, 800);

        // Auto-close modal after 3s
        setTimeout(closeImportModal, 3000);

      } else if(res?.duplicate){
        showImportResult('info',
          `<strong>Already in pipeline</strong><br>
           <span style="font-size:.78rem">${S.esc(res.title||'')} (${S.esc(res.id||'')})</span><br>
           <span style="font-size:.75rem;color:var(--muted-2)">This listing has already been imported. Try a different URL.</span>`
        );
        submitBtn.disabled = false;
        submitBtn.textContent = 'Import listing →';

      } else if(res?.blocked){
        showImportResult('warning',
          `<strong>Zillow blocked the request</strong><br>
           <span style="font-size:.78rem">${S.esc(res.message||'Zillow blocked the server-side fetch.')}</span><br>
           <span style="font-size:.75rem;color:var(--muted-2);margin-top:4px;display:block">
             Use the <strong>iOS Scriptable importer</strong> instead — it runs from your phone's residential IP which Zillow allows.
           </span>`
        );
        submitBtn.disabled = false;
        submitBtn.textContent = 'Try another URL';

      } else {
        showImportResult('error',
          `<strong>Import failed</strong><br>
           <span style="font-size:.78rem">${S.esc(res?.error || 'Unknown error')}</span>`
        );
        submitBtn.disabled = false;
        submitBtn.textContent = 'Import listing →';
      }
    } catch(e){
      console.error('[pipeline] import-from-url failed', e);
      showImportResult('error',
        `<strong>Request failed</strong><br>
         <span style="font-size:.78rem">${S.esc(e.message||'Network error')}</span>`
      );
      submitBtn.disabled = false;
      submitBtn.textContent = 'Import listing →';
    }
  }

  function showImportResult(type, html){
    const el = document.getElementById('pl-import-result');
    if(!el) return;
    const colors = {
      success: { bg:'rgba(34,197,94,.1)', border:'rgba(34,197,94,.25)', color:'var(--text)' },
      error:   { bg:'rgba(239,68,68,.08)', border:'rgba(239,68,68,.25)', color:'var(--text)' },
      warning: { bg:'rgba(234,179,8,.08)', border:'rgba(234,179,8,.25)', color:'var(--text)' },
      info:    { bg:'rgba(99,102,241,.08)', border:'rgba(99,102,241,.2)', color:'var(--text)' },
    };
    const c = colors[type] || colors.info;
    el.style.cssText = `display:block;padding:12px 14px;border-radius:8px;border:1px solid ${c.border};background:${c.bg};color:${c.color};font-size:.82rem;line-height:1.5;margin-top:4px`;
    el.innerHTML = html;
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  function collectPatch(){
    const panel = document.getElementById('pl-panel');
    if(!panel || !_current) return {};
    const l = _current;
    const patch = {};

    // Plain text fields
    const textFields = [
      'title','address','city','state','zip','county','neighborhood',
      'description','showing_instructions','move_in_special','location_context','virtual_tour_url',
      'property_type','available_date',
      'heating_type','cooling_type','laundry_type','parking',
    ];
    // Integer fields
    const intFields = [
      'monthly_rent','security_deposit','application_fee',
      'pet_deposit','parking_fee','hoa_fee',
      'bedrooms','square_footage','minimum_lease_months','garage_spaces',
      'year_built','floors','lot_size_sqft',
    ];
    // Float fields
    const floatFields = ['bathrooms'];
    // Boolean fields (stored as true/false/null)
    const boolFields = ['pets_allowed','smoking_allowed','has_central_air','has_basement'];
    // JSON-array fields stored as comma-separated text in the form
    const jArrFields = ['appliances','utilities_included','amenities','flooring','pet_types_allowed','lease_terms'];

    textFields.forEach(f => {
      const el = panel.querySelector('#pf-'+f);
      if(!el) return;
      const v = el.value.trim() || null;
      const oldV = l[f] != null ? String(l[f]).trim() : null;
      if(v !== oldV) patch[f] = v;
    });
    intFields.forEach(f => {
      const el = panel.querySelector('#pf-'+f);
      if(!el) return;
      const raw = el.value.trim();
      const v   = raw ? parseInt(raw, 10) : null;
      if(v !== l[f]) patch[f] = v;
    });
    floatFields.forEach(f => {
      const el = panel.querySelector('#pf-'+f);
      if(!el) return;
      const raw = el.value.trim();
      const v   = raw ? parseFloat(raw) : null;
      if(v !== l[f]) patch[f] = v;
    });
    boolFields.forEach(f => {
      const el = panel.querySelector('#pf-'+f);
      if(!el) return;
      const raw = el.value;
      const v   = raw === '' ? null : raw === 'true';
      if(v !== l[f]) patch[f] = v;
    });
    jArrFields.forEach(f => {
      const el = panel.querySelector('#pf-'+f);
      if(!el) return;
      const newArr = textToJArr(el.value);
      const oldArr = l[f] || '[]';
      if(newArr !== oldArr) patch[f] = newArr;
    });

    return patch;
  }

  async function doSave(id){
    const patch = collectPatch();
    if(!Object.keys(patch).length){ S.toast('No changes to save', 'info'); return; }
    _cClear();
    const btn = document.querySelector('.pl-save-btn');
    if(btn){ btn.disabled = true; btn.textContent = 'Saving…'; }
    const { data, error } = await CP.sb().rpc('pipeline_save', { p_id: id, p_patch: patch });
    if(btn){ btn.disabled = false; btn.textContent = 'Save changes'; }
    if(error){ S.toast('Save failed: ' + error.message, 'error'); return; }
    const res = typeof data === 'string' ? JSON.parse(data) : data;
    if(!res?.ok){ S.toast('Save failed: ' + (res?.error||'unknown'), 'error'); return; }
    S.toast('Saved', 'success');
    Object.assign(_current, patch);
    if(_current.status === 'scraped') _current.status = 'edited';
    refreshCard(id);
    fetchCounts().catch(()=>{});
  }

  async function doArchive(id){
    const ok = await S.confirm('Archive this listing?', 'It will be hidden from the pipeline. You can still find it under the Archived filter.');
    if(!ok) return;
    _cClear();
    const { data, error } = await CP.sb().rpc('pipeline_archive', { p_id: id });
    if(error){ S.toast('Archive failed: ' + error.message, 'error'); return; }
    const res = typeof data === 'string' ? JSON.parse(data) : data;
    if(!res?.ok){ S.toast('Archive failed: ' + (res?.error||'unknown'), 'error'); return; }
    S.toast('Archived', 'success');
    removeCard(id);
    closePanel();
    fetchCounts().catch(()=>{});
  }

  // Transfer source photos to ImageKit in the background after publish
  async function doTransferPhotos(pipelineId, propertyId){
    const listing = _pageData.find(l => l.id === pipelineId);
    const urls = listing ? (parseJSON(listing.original_image_urls) || []) : [];
    if(!urls.length) return;

    S.toast(`Transferring ${Math.min(urls.length, 20)} photo${urls.length !== 1 ? 's' : ''} to ImageKit…`, 'info');

    try {
      const { data, error } = await CP.sb().functions.invoke('import-pipeline-photos', {
        body: { pipeline_id: pipelineId, property_id: propertyId }
      });
      if(error) throw error;
      const res = typeof data === 'string' ? JSON.parse(data) : data;
      if(res?.transferred > 0){
        S.toast(`${res.transferred} photo${res.transferred !== 1 ? 's' : ''} added to ImageKit ✓`, 'success');
      } else if(res?.skipped > 0){
        S.toast('Photos could not be transferred — add manually in property edit', 'info');
      }
    } catch(e){
      console.warn('[pipeline] photo transfer failed', e);
      // Non-fatal — property is published, photos can be added manually
    }
  }

  async function doPublish(id){
    const panel = document.getElementById('pl-panel');
    const required = ['pf-title','pf-address','pf-city','pf-state','pf-zip'];
    const missing = [];
    required.forEach(fid => {
      const el = panel && panel.querySelector('#'+fid);
      if(el && !el.value.trim()) missing.push(fid.replace('pf-',''));
    });
    if(missing.length){
      S.toast('Please fill required fields: ' + missing.join(', '), 'error');
      return;
    }

    // Save any unsaved changes first
    const patch = collectPatch();
    if(Object.keys(patch).length){
      const { error: se } = await CP.sb().rpc('pipeline_save', { p_id: id, p_patch: patch });
      if(se){ S.toast('Could not save changes before publishing: ' + se.message, 'error'); return; }
    }

    // Merge unsaved patch into _current so validation sees the just-saved values.
    const l = Object.assign({}, _current || {}, patch);

    // ── Pre-publish validation gate ──────────────────────────────────────────
    // Must run before any RPC call. Mirrors validate_for_publish() in enrichment.py.
    const validation = await validateForPublish(l);
    if (!validation.ok) {
      S.toast(
        'Cannot publish — fix these issues first:\n• ' + validation.failures.join('\n• '),
        'error'
      );
      return;
    }

    const desc = [l.address, l.city, l.state].filter(Boolean).join(', ');
    const ok = await S.confirm(
      'Publish "' + desc + '" as a draft?',
      'A draft property will be created in your listings. Photos will be transferred to ImageKit automatically.'
    );
    if(!ok) return;
    _cClear();

    const btn = document.querySelector('.pl-pub-btn-panel');
    if(btn){ btn.disabled = true; btn.textContent = 'Publishing…'; }

    const { data, error } = await CP.sb().rpc('pipeline_publish', { p_id: id, p_landlord_id: null });
    if(btn){ btn.disabled = false; btn.textContent = 'Publish as draft →'; }
    if(error){ S.toast('Publish failed: ' + error.message, 'error'); return; }
    const res = typeof data === 'string' ? JSON.parse(data) : data;
    if(!res?.ok){ S.toast('Publish failed: ' + (res?.error||'unknown'), 'error'); return; }

    const propId = res.choice_property_id;
    S.toast('Published! Opening edit page…', 'success');
    removeCard(id);
    closePanel();
    fetchCounts().catch(()=>{});

    // Transfer photos in background (non-blocking)
    doTransferPhotos(id, propId);

    // Open edit page
    setTimeout(() => {
      window.open('/admin/property-detail.html?id=' + encodeURIComponent(propId), '_blank');
    }, 400);
  }

  async function doBulkPublish(){
    const ids = [..._selected];
    if(!ids.length) return;

    // Only publish non-published, non-archived
    const publishable = ids.filter(id => {
      const l = _pageData.find(x => x.id === id);
      return l && l.status !== 'published' && l.status !== 'archived';
    });

    if(!publishable.length){
      S.toast('No publishable listings selected (already published or archived)', 'info');
      return;
    }

    const ok = await S.confirm(
      `Publish ${publishable.length} listing${publishable.length !== 1 ? 's' : ''} as drafts?`,
      'Each will become a draft property. Photos are not auto-transferred for bulk publish — add them individually from each property\'s edit page.'
    );
    if(!ok) return;

    const bar = document.getElementById('pl-bulk-pub');
    if(bar){ bar.disabled = true; bar.textContent = 'Publishing…'; }

    let succeeded = 0;
    let failed = 0;
    let blocked = 0;

    for(const id of publishable){
      try {
        const listing = _pageData.find(x => x.id === id);
        if (!listing) { failed++; continue; }

        // Pre-publish validation gate — skip invalid records in bulk mode
        const validation = await validateForPublish(listing);
        if (!validation.ok) {
          console.warn('[pipeline] bulk publish blocked for', id, validation.failures);
          blocked++;
          continue;
        }

        const { data, error } = await CP.sb().rpc('pipeline_publish', { p_id: id, p_landlord_id: null });
        if(error) throw error;
        const res = typeof data === 'string' ? JSON.parse(data) : data;
        if(!res?.ok) throw new Error(res?.error || 'unknown');
        succeeded++;
        removeCard(id);
        _selected.delete(id);
      } catch(e){
        console.error('[pipeline] bulk publish failed for', id, e);
        failed++;
      }
    }

    if(bar){ bar.disabled = false; bar.textContent = 'Publish all →'; }
    updateBulkBar();
    fetchCounts().catch(()=>{});

    if(succeeded > 0 && failed === 0 && blocked === 0){
      S.toast(`${succeeded} listing${succeeded !== 1 ? 's' : ''} published as drafts ✓`, 'success');
    } else if(succeeded > 0 && blocked > 0){
      S.toast(`${succeeded} published, ${blocked} blocked (fix photos/descriptions first)`, 'info');
    } else if(succeeded > 0){
      S.toast(`${succeeded} published, ${failed} failed`, 'info');
    } else if(blocked > 0){
      S.toast(`All ${blocked} listing${blocked !== 1 ? 's' : ''} blocked by validation — fix photos and descriptions`, 'error');
    } else {
      S.toast('Bulk publish failed — try again or publish individually', 'error');
    }
  }

  // ── Card DOM helpers ─────────────────────────────────────────────────────────

  function removeCard(id){
    const el = document.querySelector(`.pl-card[data-pl-id="${CSS.escape(id)}"]`);
    if(el) el.remove();
    // Remove from page data too
    _pageData = _pageData.filter(l => l.id !== id);
    const list = document.getElementById('pl-list');
    if(list && !list.querySelector('.pl-card')){
      list.innerHTML = `<div class="pl-empty"><svg class="i"><use href="#i-check"/></svg><h3>All done</h3><p>No more listings with this status.</p></div>`;
    }
  }

  function refreshCard(id){
    const el = document.querySelector(`.pl-card[data-pl-id="${CSS.escape(id)}"]`);
    if(!el || !_current) return;
    el.outerHTML = renderCard(_current);
    wireCardEvents();
  }

  // ── Lazy-load card thumbnails via IntersectionObserver ───────────────────────
  function setupLazyLoad(){
    const imgs = document.querySelectorAll('.pl-thumb[data-src], .pl-thumb-strip-img[data-src]');
    if(!imgs.length) return;
    if(!('IntersectionObserver' in window)){
      imgs.forEach(img => { img.src = img.dataset.src; img.removeAttribute('data-src'); });
      return;
    }
    const obs = new IntersectionObserver((entries, ob) => {
      entries.forEach(e => {
        if(!e.isIntersecting) return;
        const img = e.target;
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
        ob.unobserve(img);
      });
    }, { rootMargin: '160px' });
    imgs.forEach(img => obs.observe(img));
  }

  // ── Event wiring ─────────────────────────────────────────────────────────────

  function wireCardEvents(){
    document.querySelectorAll('.pl-card').forEach(card => {
      card.onclick = null;
      card.onclick = () => {
        const id = card.dataset.plId;
        const listing = _pageData.find(l => l.id === id);
        if(listing) openPanel(listing);
      };
      card.onkeydown = e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); card.click(); } };
    });

    // Publish buttons on cards
    document.querySelectorAll('.pl-pub-btn').forEach(btn => {
      btn.onclick = e => { e.stopPropagation(); doPublish(btn.dataset.id); };
    });

    // Archive buttons on cards
    document.querySelectorAll('.pl-arc-btn').forEach(btn => {
      btn.onclick = e => { e.stopPropagation(); doArchive(btn.dataset.id); };
    });

    // Retry photos buttons on cards (photo_import_status === 'failed')
    document.querySelectorAll('.pl-retry-photos-btn').forEach(btn => {
      btn.onclick = async e => {
        e.stopPropagation();
        btn.disabled = true;
        btn.textContent = 'Retrying…';
        await doTransferPhotos(btn.dataset.id, btn.dataset.propId);
        btn.disabled = false;
        btn.textContent = 'Retry photos';
        load(false).catch(()=>{});
      };
    });

    // Selection checkboxes
    document.querySelectorAll('.pl-check').forEach(chk => {
      chk.onchange = e => {
        const id = chk.dataset.id;
        if(chk.checked){
          _selected.add(id);
        } else {
          _selected.delete(id);
        }
        const card = chk.closest('.pl-card');
        if(card) card.classList.toggle('pl-card-selected', chk.checked);
        updateBulkBar();
      };
    });

    // Lazy-load thumbnails after cards are in the DOM
    setupLazyLoad();
  }

  function wireChips(){
    const chips = document.getElementById('status-chips');
    if(!chips) return;
    chips.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if(!chip || !chip.dataset.plStatus) return;
      chips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      _status = chip.dataset.plStatus;
      _page   = 0;
      _selected.clear();
      updateBulkBar();
      load(false);
    });
  }

  function wireSourceChips(){
    const row = document.getElementById('source-chips');
    if(!row) return;
    row.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if(!chip || !('plSource' in chip.dataset)) return;
      row.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      _source = chip.dataset.plSource || null;
      _selected.clear();
      updateBulkBar();
      // Re-render from cached page data — no server round trip
      renderList(visibleListings(), false);
      wireCardEvents();
    });
  }

  function wireBulkBar(){
    const selectAll = document.getElementById('pl-select-all');
    if(selectAll){
      selectAll.addEventListener('change', () => {
        const publishable = visibleListings().filter(l => l.status !== 'published' && l.status !== 'archived');
        if(selectAll.checked){
          publishable.forEach(l => _selected.add(l.id));
        } else {
          publishable.forEach(l => _selected.delete(l.id));
        }
        // Re-render to reflect checkbox states
        renderList(visibleListings(), false);
        wireCardEvents();
        updateBulkBar();
      });
    }

    const clearBtn = document.getElementById('pl-bulk-clear');
    if(clearBtn){
      clearBtn.addEventListener('click', () => {
        _selected.clear();
        renderList(visibleListings(), false);
        wireCardEvents();
        updateBulkBar();
      });
    }

    const pubBtn = document.getElementById('pl-bulk-pub');
    if(pubBtn){
      pubBtn.addEventListener('click', () => doBulkPublish());
    }
  }

  function wireSearch(){
    const input = document.getElementById('pl-search');
    const clear = document.getElementById('pl-search-clear');
    if(!input) return;

    let _debounce;
    input.addEventListener('input', () => {
      clearTimeout(_debounce);
      _debounce = setTimeout(() => {
        _search = input.value.trim();
        _selected.clear();
        updateBulkBar();
        renderList(visibleListings(), false);
        wireCardEvents();
      }, 200);
    });

    if(clear){
      clear.addEventListener('click', () => {
        input.value = '';
        _search = '';
        _selected.clear();
        updateBulkBar();
        renderList(visibleListings(), false);
        wireCardEvents();
        input.focus();
      });
    }
  }

  function wireQualityChips(){
    const row = document.getElementById('quality-chips');
    if(!row) return;
    row.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if(!chip || !('plQuality' in chip.dataset)) return;
      row.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      _quality = chip.dataset.plQuality || null;
      _selected.clear();
      updateBulkBar();
      renderList(visibleListings(), false);
      wireCardEvents();
    });
  }

  function wireImportButton(){
    const btn = document.getElementById('pl-import-url-btn');
    if(btn) btn.addEventListener('click', openImportModal);
  }

  function wireRefreshButton(){
    const btn = document.getElementById('pl-refresh-btn');
    if(!btn) return;
    btn.addEventListener('click', async () => {
      if(_loading) return;
      btn.disabled = true;
      btn.style.opacity = '.5';
      _cClear();
      _page = 0;
      try {
        await load(false);
        S.toast('Pipeline refreshed', 'success');
      } catch(_){
        S.toast('Refresh failed', 'error');
      } finally {
        btn.disabled = false;
        btn.style.opacity = '';
      }
    });
  }

  function wireBackdrop(){
    document.getElementById('pl-backdrop').addEventListener('click', closePanel);
  }

  function wireLoadMore(){
    document.getElementById('load-more-btn').addEventListener('click', async () => {
      if(_loading) return;
      _page++;
      _loading = true;
      try {
        const more = await fetchListings(_status, _page);
        _pageData.push(...more);
        // Only append the subset matching the active source filter
        const visible = _source ? more.filter(l => (l.source || '') === _source) : more;
        if(visible.length){
          renderList(visible, true);
          wireCardEvents();
        }
      } catch(e){
        S.toast('Failed to load more', 'error');
        _page--;
      } finally {
        _loading = false;
      }
    });
  }

  // ── Folder system ─────────────────────────────────────────────────────────────

  let _folders = [];       // list of folders
  let _activeFolder = null; // currently selected folder (null = all)
  let _pendingFolderIds = null; // selected items to assign when creating a new folder

  async function loadFolders(){
    try {
      const { data, error } = await CP.sb().rpc('pipeline_folder_list');
      if(error) throw error;
      _folders = typeof data === 'string' ? JSON.parse(data) : (data || []);
      renderFolderSidebar();
      renderFolderBanner();
    } catch(e){
      console.warn('[pipeline] loadFolders failed', e);
    }
  }

  function renderFolderBanner(){
    const banner = document.getElementById('pl-folder-banner');
    const actions = document.getElementById('pl-folder-actions');
    if(!_activeFolder || !banner || !actions){
      if(banner) banner.classList.remove('visible');
      if(actions) actions.style.display = 'none';
      return;
    }

    const folder = _folders.find(f => f.id === _activeFolder);
    if(!folder){
      banner.classList.remove('visible');
      actions.style.display = 'none';
      return;
    }

    const published = folder.published_count || 0;
    const archived = folder.archived_count || 0;
    const total = folder.property_count || 0;
    const missing = _pageData.filter(l => !l.choice_property_id && l.status !== 'archived').length;

    banner.innerHTML = `
      <div>
        <div class="pl-folder-banner-title">Working in "${S.esc(folder.name)}"</div>
        <div class="pl-folder-banner-meta">${total} listing${total !== 1 ? 's' : ''} · ${published} published · ${archived} archived · ${missing} needs review</div>
      </div>
      <div class="pl-folder-banner-actions">
        <button class="btn btn-sm btn-outline" id="pl-banner-close-folder-btn">Close folder</button>
        <button class="btn btn-sm btn-primary" id="pl-banner-publish-folder-btn">Publish folder</button>
      </div>
    `;

    banner.classList.add('visible');
    actions.style.display = 'flex';

    const closeBtn = document.getElementById('pl-banner-close-folder-btn');
    const pubBtn = document.getElementById('pl-banner-publish-folder-btn');
    if(closeBtn) closeBtn.addEventListener('click', closeActiveFolder);
    if(pubBtn) pubBtn.addEventListener('click', publishActiveFolder);
  }

  function renderFolderSidebar(){
    const wrap = document.getElementById('pl-folders');
    if(!wrap) return;
    if(!_folders.length){
      wrap.innerHTML = '<div class="pl-folder-empty">No folders yet.<br><button class="btn btn-sm btn-outline" id="pl-new-folder-btn">+ New Folder</button></div>';
      const btn = document.getElementById('pl-new-folder-btn');
      if(btn) btn.addEventListener('click', () => openCreateFolderModal());
      renderFolderBanner();
      return;
    }

    const allItem = `
      <div class="pl-folder-item${_activeFolder === null ? ' active' : ''}" data-folder-id="" role="button" tabindex="0">
        <div class="pl-folder-name">📂 All pipeline</div>
        <div class="pl-folder-count">${_pageData.length || ''}</div>
      </div>
    `;

    wrap.innerHTML = allItem + _folders.map(f => `
      <div class="pl-folder-item${_activeFolder === f.id ? ' active' : ''}" data-folder-id="${S.esc(f.id)}" role="button" tabindex="0">
        <div class="pl-folder-name">📁 ${S.esc(f.name)}</div>
        <div class="pl-folder-count">${f.property_count || 0}</div>
      </div>
    `).join('') + '<div class="pl-folder-item pl-folder-new" id="pl-new-folder-item" role="button" tabindex="0">+ New Folder</div>';

    wrap.querySelectorAll('.pl-folder-item[data-folder-id]').forEach(el => {
      el.addEventListener('click', () => selectFolder(el.dataset.folderId || null));
    });
    const newBtn = document.getElementById('pl-new-folder-item');
    if(newBtn) newBtn.addEventListener('click', () => openCreateFolderModal(_selected.size ? [..._selected] : null));
    renderFolderBanner();
  }

  async function selectFolder(folderId){
    _activeFolder = folderId;
    renderFolderSidebar();
    if(!folderId){
      _selected.clear();
      updateBulkBar();
      await load(false);
      return;
    }
    try {
      const { data, error } = await CP.sb().rpc('pipeline_folder_properties', { p_folder_id: folderId });
      if(error) throw error;
      const rows = typeof data === 'string' ? JSON.parse(data) : (data || []);
      _pageData = rows;
      renderList(visibleListings(), false);
      wireCardEvents();
      renderFolderBanner();
    } catch(e){
      console.error('[pipeline] selectFolder failed', e);
      S.toast('Failed to load folder', 'error');
    }
  }

  function openCreateFolderModal(selectedIds = null){
    _pendingFolderIds = Array.isArray(selectedIds) ? selectedIds : null;
    const modal = document.createElement('div');
    modal.id = 'pl-folder-modal';
    modal.innerHTML = `
      <div class="pl-import-backdrop"></div>
      <div class="pl-import-dialog" role="dialog" aria-modal="true" aria-label="Create folder">
        <div class="pl-import-hd">
          <div style="font-size:.95rem;font-weight:700">Create New Folder</div>
          <button class="pl-import-close" aria-label="Close">✕</button>
        </div>
        <div class="pl-import-body">
          <div class="pl-field" style="margin-bottom:14px">
            <label for="pl-folder-name">Folder name</label>
            <input id="pl-folder-name" type="text" placeholder="e.g. Wisdom, Columbus Q3, Fix Descriptions" autocomplete="off" spellcheck="false">
          </div>
          <div class="pl-field" style="margin-bottom:14px">
            <label for="pl-folder-desc">Description (optional)</label>
            <input id="pl-folder-desc" type="text" placeholder="What is this folder for?" autocomplete="off">
          </div>
          <div id="pl-folder-result" style="display:none"></div>
        </div>
        <div class="pl-import-ft">
          <button class="btn btn-ghost" id="pl-folder-cancel">Cancel</button>
          <div style="flex:1"></div>
          <button class="btn btn-primary" id="pl-folder-create">Create Folder →</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    modal.querySelector('.pl-import-backdrop').addEventListener('click', closeFolderModal);
    modal.querySelector('.pl-import-close').addEventListener('click', closeFolderModal);
    document.getElementById('pl-folder-cancel').addEventListener('click', closeFolderModal);
    document.getElementById('pl-folder-create').addEventListener('click', doCreateFolder);
    document.getElementById('pl-folder-name').addEventListener('keydown', e => {
      if(e.key === 'Enter') doCreateFolder();
    });
    setTimeout(() => document.getElementById('pl-folder-name').focus(), 50);
  }

  function closeFolderModal(){
    const modal = document.getElementById('pl-folder-modal');
    if(modal) modal.remove();
  }

  async function doCreateFolder(){
    const nameInput = document.getElementById('pl-folder-name');
    const descInput = document.getElementById('pl-folder-desc');
    const resultEl  = document.getElementById('pl-folder-result');
    if(!nameInput || !resultEl) return;
    const name = nameInput.value.trim();
    if(!name){
      nameInput.focus();
      return;
    }
    const btn = document.getElementById('pl-folder-create');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const { data, error } = await CP.sb().rpc('pipeline_folder_create', {
        p_name: name,
        p_description: descInput ? descInput.value.trim() || null : null
      });
      if(error) throw error;
      const res = typeof data === 'string' ? JSON.parse(data) : data;
      if(!res?.ok){
        resultEl.style.cssText = 'display:block;padding:10px 12px;border-radius:8px;background:rgba(239,68,68,.1);color:#dc2626;font-size:.8rem;margin-top:4px';
        resultEl.textContent = res?.error || 'Failed to create folder';
        btn.disabled = false;
        btn.textContent = 'Create Folder →';
        return;
      }
      S.toast('Folder "' + res.name + '" created ✓', 'success');
      closeFolderModal();
      await loadFolders();
      if(_pendingFolderIds && _pendingFolderIds.length){
        await addSelectedToNewFolder(res.id, _pendingFolderIds);
        _pendingFolderIds = null;
      }
    } catch(e){
      resultEl.style.cssText = 'display:block;padding:10px 12px;border-radius:8px;background:rgba(239,68,68,.1);color:#dc2626;font-size:.8rem;margin-top:4px';
      resultEl.textContent = e.message || 'Failed to create folder';
      btn.disabled = false;
      btn.textContent = 'Create Folder →';
    }
  }

  async function addSelectedToFolder(){
    const ids = [..._selected];
    if(!ids.length) return;
    if(!_folders.length){
      S.toast('Create a folder first', 'info');
      openCreateFolderModal(ids);
      return;
    }
    openFolderPicker({ selectedIds: ids });
  }

  async function addSelectedToNewFolder(folderId, ids){
    if(!folderId || !ids?.length) return;
    let succeeded = 0;
    for(const id of ids){
      try {
        const { data, error } = await CP.sb().rpc('pipeline_folder_add_property', {
          p_property_id: id,
          p_folder_id: folderId
        });
        if(!error && data?.ok) succeeded++;
      } catch(e){ /* ignore */ }
    }
    if(succeeded > 0){
      S.toast(`${succeeded} listing${succeeded !== 1 ? 's' : ''} added to the new folder ✓`, 'success');
      _selected.clear();
      updateBulkBar();
      await loadFolders();
      selectFolder(folderId);
    }
  }

  function openFolderPicker(options = {}){
    const ids = Array.isArray(options.selectedIds) ? options.selectedIds : null;
    const modal = document.createElement('div');
    modal.id = 'pl-folder-modal';
    modal.innerHTML = `
      <div class="pl-import-backdrop"></div>
      <div class="pl-import-dialog" role="dialog" aria-modal="true" aria-label="Add to folder">
        <div class="pl-import-hd">
          <div style="font-size:.95rem;font-weight:700">Add to folder</div>
          <button class="pl-import-close" aria-label="Close">✕</button>
        </div>
        <div class="pl-import-body">
          <div style="margin-bottom:14px;font-size:.85rem;color:var(--muted-2)">Select an existing folder or create a new one.</div>
          <div id="pl-folder-picker-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px"></div>
          <button class="btn btn-outline" id="pl-folder-picker-new">Create new folder</button>
          <div id="pl-folder-result" style="display:none"></div>
        </div>
        <div class="pl-import-ft">
          <button class="btn btn-ghost" id="pl-folder-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    modal.querySelector('.pl-import-backdrop').addEventListener('click', closeFolderModal);
    modal.querySelector('.pl-import-close').addEventListener('click', closeFolderModal);
    document.getElementById('pl-folder-cancel').addEventListener('click', closeFolderModal);
    document.getElementById('pl-folder-picker-new').addEventListener('click', () => {
      closeFolderModal();
      openCreateFolderModal(ids);
    });

    const listWrapper = document.getElementById('pl-folder-picker-list');
    if(listWrapper){
      if(!_folders.length){
        listWrapper.innerHTML = '<div class="pl-folder-empty">No folders exist yet. Create one below.</div>';
      } else {
        listWrapper.innerHTML = _folders.map(f => `
          <button class="btn btn-ghost" type="button" data-folder-id="${S.esc(f.id)}" style="justify-content:space-between;display:flex;align-items:center">
            <span>${S.esc(f.name)}</span>
            <span style="opacity:.7">${f.property_count || 0}</span>
          </button>
        `).join('');
        listWrapper.querySelectorAll('button[data-folder-id]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const folderId = btn.dataset.folderId;
            closeFolderModal();
            await addSelectedToNewFolder(folderId, ids);
          });
        });
      }
    }
  }

  async function deleteActiveFolder(){
    if(!_activeFolder) return;
    const folder = _folders.find(f => f.id === _activeFolder);
    if(!folder) return;
    const ok = await S.confirm(
      `Archive folder "${folder.name}"?`,
      `This will archive all non-published listings in the folder. Published listings will remain live but be removed from the folder.`
    );
    if(!ok) return;
    try {
      const { data, error } = await CP.sb().rpc('pipeline_folder_delete', { p_folder_id: _activeFolder });
      if(error) throw error;
      const res = typeof data === 'string' ? JSON.parse(data) : data;
      if(!res?.ok) throw new Error(res?.error || 'Failed to archive folder');
      S.toast(`Folder "${res.name}" archived — ${res.archived || 0} properties archived`, 'success');
      _activeFolder = null;
      await loadFolders();
      await load(false);
    } catch(e){
      S.toast('Archive failed: ' + e.message, 'error');
    }
  }

  async function publishActiveFolder(){
    if(!_activeFolder) return;
    const folder = _folders.find(f => f.id === _activeFolder);
    if(!folder) return;
    const ok = await S.confirm(
      `Publish all in "${folder.name}"?`,
      `This will publish all ${folder.property_count || 0} properties in this folder as drafts.`
    );
    if(!ok) return;
    try {
      const { data, error } = await CP.sb().rpc('pipeline_folder_publish', { p_folder_id: _activeFolder });
      if(error) throw error;
      const res = typeof data === 'string' ? JSON.parse(data) : data;
      if(!res?.ok) throw new Error(res?.error || 'Failed to publish folder');
      S.toast(`${res.published} published, ${res.failed} failed`, res.failed > 0 ? 'info' : 'success');
      await loadFolders();
      selectFolder(_activeFolder);
    } catch(e){
      S.toast('Publish failed: ' + e.message, 'error');
    }
  }

  async function renameActiveFolder(){
    if(!_activeFolder) return;
    const folder = _folders.find(f => f.id === _activeFolder);
    if(!folder) return;
    const name = window.prompt('Rename folder', folder.name);
    if(!name || !name.trim() || name.trim() === folder.name) return;
    try {
      const { data, error } = await CP.sb().rpc('pipeline_folder_rename', {
        p_folder_id: _activeFolder,
        p_new_name: name.trim(),
      });
      if(error) throw error;
      const res = typeof data === 'string' ? JSON.parse(data) : data;
      if(!res?.ok){
        S.toast('Rename failed: ' + (res?.error || 'unknown'), 'error');
        return;
      }
      S.toast(`Renamed folder to "${res.name}"`, 'success');
      await loadFolders();
    } catch(e){
      S.toast('Rename failed: ' + (e.message || 'unknown'), 'error');
    }
  }

  async function closeActiveFolder(){
    if(!_activeFolder) return;
    _activeFolder = null;
    _selected.clear();
    updateBulkBar();
    renderFolderSidebar();
    await load(false);
  }

  function wireFolderButtons(){
    const addBtn = document.getElementById('pl-add-to-folder-btn');
    if(addBtn) addBtn.addEventListener('click', addSelectedToFolder);

    const renameFolderBtn = document.getElementById('pl-rename-folder-btn');
    if(renameFolderBtn) renameFolderBtn.addEventListener('click', renameActiveFolder);

    const pubFolderBtn = document.getElementById('pl-publish-folder-btn');
    if(pubFolderBtn) pubFolderBtn.addEventListener('click', publishActiveFolder);

    const delFolderBtn = document.getElementById('pl-delete-folder-btn');
    if(delFolderBtn) delFolderBtn.addEventListener('click', deleteActiveFolder);

    const closeFolderBtn = document.getElementById('pl-close-folder-btn');
    if(closeFolderBtn) closeFolderBtn.addEventListener('click', closeActiveFolder);
  }

  // ── Main load ─────────────────────────────────────────────────────────────────

  async function load(showSkeleton){
    const list = document.getElementById('pl-list');
    _loading = true;
    if(showSkeleton !== false){
      list.innerHTML = '<div class="pl-empty" style="padding:40px"><div class="skeleton sk-line" style="width:60%;margin:0 auto"></div></div>';
    }
    try {
      const [listings] = await Promise.all([
        fetchListings(_status, 0),
        fetchCounts()
      ]);
      _pageData = listings;
      renderList(visibleListings(), false);
      wireCardEvents();
    } catch(e){
      console.error('[pipeline] load failed', e);
      list.innerHTML = `<div class="pl-empty"><svg class="i"><use href="#i-alert"/></svg><h3>Failed to load</h3><p>${S.esc(e.message||'Unknown error')}</p></div>`;
    } finally {
      _loading = false;
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────

  (window.CPShell && window.CPShell.ready ? window.CPShell.ready : Promise.resolve(window.AdminShell))
    .then(async shell => {
      S = shell || window.AdminShell;
      const ok = await S.requireAdmin();
      if(!ok) return;
      // Always clear the session cache on page load so newly-imported listings
      // are visible immediately without waiting for the 30-second TTL to expire.
      _cClear();
      wireChips();
      wireSourceChips();
      wireQualityChips();
      wireSearch();
      wireBackdrop();
      wireLoadMore();
      wireBulkBar();
      wireImportButton();
      wireRefreshButton();
      wireFolderButtons();
      // ESC key closes the detail panel
      document.addEventListener('keydown', e => {
        if(e.key === 'Escape' && _current) closePanel();
      });
      load(false);
      loadFolders();
    })
    .catch(err => console.error('[pipeline] boot failed', err));

})();
