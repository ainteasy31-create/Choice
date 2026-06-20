(function(){
  'use strict';

  let S;            // AdminShell
  let _status   = 'scraped';
  let _source   = null;    // null = all, 'zillow', 'realtor'
  let _page     = 0;
  const PAGE    = 40;
  let _hasMore  = false;
  let _loading  = false;
  let _pageData = [];   // all fetched listings (unfiltered by source)
  let _current  = null; // listing open in panel
  let _dirty    = {};   // unsaved field changes
  let _landlords = [];  // cache for publish landlord picker
  let _selected  = new Set(); // IDs of selected cards for bulk actions

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function fmt$$(n){ return n != null ? '$' + Number(n).toLocaleString() : '—'; }
  function fmtBeds(l){ return [l.bedrooms != null ? l.bedrooms + ' bd' : null, l.bathrooms != null ? l.bathrooms + ' ba' : null].filter(Boolean).join(' · ') || '—'; }
  function fmtSqft(l){ return l.square_footage ? l.square_footage.toLocaleString() + ' sqft' : ''; }
  function parseJSON(s){ try{ return s ? JSON.parse(s) : null; }catch(_){ return null; } }
  function qsClass(score){ if(score == null) return ''; return score >= 80 ? 'qs-high' : score >= 60 ? 'qs-mid' : 'qs-low'; }
  function qsBadge(score){
    if(score == null) return '';
    return `<span class="qs-badge ${qsClass(score)}" title="Data quality score">Q: ${score}</span>`;
  }
  function statusChip(status){
    const map = { scraped:'', edited:'info', published:'success', archived:'' };
    return S.statusPill ? S.statusPill(status) : `<span class="pill ${map[status]||''}">${status}</span>`;
  }
  function thumbUrl(l){
    const imgs = parseJSON(l.original_image_urls);
    return (imgs && imgs.length) ? imgs[0] : null;
  }

  // Returns _pageData filtered by the active source chip
  function visibleListings(){
    if(!_source) return _pageData;
    return _pageData.filter(l => (l.source || '') === _source);
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
    const { data, error } = await CP.sb().rpc('pipeline_list', {
      p_status: status,
      p_limit:  PAGE + 1,
      p_offset: page * PAGE
    });
    if(error) throw error;
    const rows = typeof data === 'string' ? JSON.parse(data) : (data || []);
    _hasMore = rows.length > PAGE;
    return _hasMore ? rows.slice(0, PAGE) : rows;
  }

  async function loadLandlords(){
    if(_landlords.length) return _landlords;
    const { data } = await CP.sb().rpc('admin_list_landlords', { lim: 200 }).catch(() => ({ data: null }));
    const rows = Array.isArray(data) ? data : [];
    _landlords = rows.map(r => ({ id: r.id, name: r.contact_name || r.business_name || r.id }));
    return _landlords;
  }

  // ── Render: list ────────────────────────────────────────────────────────────

  function renderCard(l){
    const thumb = thumbUrl(l);
    const score = l.data_quality_score;
    const missing = parseJSON(l.missing_fields) || [];
    const isPublished = l.status === 'published';
    const isArchived  = l.status === 'archived';
    const isChecked   = _selected.has(l.id);

    return `<div class="pl-card${isChecked ? ' pl-card-selected' : ''}" data-pl-id="${S.esc(l.id)}" role="button" tabindex="0" aria-label="${S.esc((l.address||'Listing') + ', ' + (l.city||''))}">
      <div class="pl-thumb-wrap">
        ${thumb
          ? `<img class="pl-thumb" src="${S.esc(thumb)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          : ''}
        <div class="pl-thumb-placeholder" style="${thumb ? 'display:none' : ''}">
          <svg class="i" width="24" height="24" style="opacity:.3"><use href="#i-listings"/></svg>
        </div>
        <label class="pl-card-check" onclick="event.stopPropagation()" title="Select">
          <input type="checkbox" class="pl-check" data-id="${S.esc(l.id)}" ${isChecked ? 'checked' : ''} aria-label="Select listing">
        </label>
      </div>
      <div class="pl-body">
        <div class="pl-addr">${S.esc(l.address || '(no address)')}${l.unit_number ? ' #'+l.unit_number : ''}</div>
        <div class="pl-meta">${S.esc([l.city, l.state].filter(Boolean).join(', '))} ${S.esc(l.zip||'')} · ${fmtBeds(l)}${l.square_footage ? ' · ' + fmtSqft(l) : ''}</div>
        <div class="pl-tags">
          <strong style="font-size:.82rem;color:var(--text)">${fmt$$(l.monthly_rent)}/mo</strong>
          ${l.source ? `<span class="src-badge src-${S.esc(l.source)}" title="Listing source">${l.source === 'zillow' ? 'Zillow' : l.source === 'realtor' ? 'Realtor' : S.esc(l.source)}</span>` : ''}
          ${qsBadge(score)}
          ${missing.length ? `<span class="qs-badge qs-low" title="Missing fields">${missing.length} missing</span>` : ''}
          ${isPublished && l.choice_property_id ? `<a href="/property.html?id=${S.esc(l.choice_property_id)}" class="qs-badge qs-high" style="text-decoration:none" target="_blank">Live ↗</a>` : ''}
        </div>
      </div>
      <div class="pl-actions" onclick="event.stopPropagation()">
        ${!isPublished && !isArchived ? `<button class="btn btn-sm btn-outline pl-pub-btn" data-id="${S.esc(l.id)}" title="Publish to site">Publish →</button>` : ''}
        ${!isArchived ? `<button class="btn btn-sm btn-ghost pl-arc-btn" data-id="${S.esc(l.id)}" title="Archive">Archive</button>` : ''}
      </div></div>`;
  }

  function renderList(listings, append){
    const wrap = document.getElementById('pl-list');
    if(!append){
      wrap.innerHTML = listings.length
        ? listings.map(renderCard).join('')
        : `<div class="pl-empty">
             <svg class="i"><use href="#i-check"/></svg>
             <h3>Nothing here</h3>
             <p>No listings with status "${_status}"${_source ? ' from ' + _source : ''} in the pipeline.</p>
           </div>`;
    } else {
      listings.forEach(l => wrap.insertAdjacentHTML('beforeend', renderCard(l)));
    }
    document.getElementById('load-more-wrap').style.display = _hasMore ? '' : 'none';
  }

  // ── Render: detail panel ─────────────────────────────────────────────────────

  function panelPhotos(l){
    const imgs = parseJSON(l.original_image_urls) || [];
    if(!imgs.length) return '<p class="pl-photo-count">No photos from source.</p>';
    return `<div class="pl-photo-strip">${imgs.slice(0,12).map(u => `<img src="${S.esc(u)}" alt="" loading="lazy">`).join('')}</div>
    <div class="pl-photo-count">${imgs.length} photo${imgs.length!==1?'s':''} from source — transferred to ImageKit automatically on publish.</div>`;
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

    return `
    <div class="pl-panel-hd">
      <div class="pl-panel-hd-body">
        <div class="pl-panel-title">${S.esc(l.address || '(no address)')}</div>
        <div class="pl-panel-sub">${S.esc([l.city, l.state, l.zip].filter(Boolean).join(', '))}
          ${score != null ? ` · <span class="qs-badge ${qsClass(score)}">Q: ${score}/100</span>` : ''}
          ${editedFields.length ? ` · <span style="font-size:.7rem;color:var(--brand)">${editedFields.length} fields edited</span>` : ''}
        </div>
        ${l.source_url ? `<a href="${S.esc(l.source_url)}" target="_blank" rel="noopener" class="pl-source-link" style="margin-top:4px">
          <svg class="i i-sm"><use href="#i-arrow"/></svg> View on ${S.esc(l.source||'source')}
        </a>` : ''}
      </div>
      <button class="btn btn-ghost btn-sm" id="pl-close-btn" aria-label="Close panel">✕</button>
    </div>

    <div class="pl-panel-body">

      <!-- Photos -->
      <div class="pl-section">
        <div class="pl-section-title">Photos (source)</div>
        ${panelPhotos(l)}
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
          ${fi('bedrooms','Bedrooms', l.bedrooms,'number',false)}
          ${fi('bathrooms','Bathrooms', l.bathrooms,'number',false)}
          ${fi('square_footage','Sqft', l.square_footage,'number',false)}
          ${fi('property_type','Type', l.property_type,'text',false,false,[
            {v:'',l:'— select —'},{v:'single_family',l:'Single family'},{v:'condo',l:'Condo'},
            {v:'townhouse',l:'Townhouse'},{v:'apartment',l:'Apartment'},{v:'multi_family',l:'Multi-family'},
            {v:'mobile',l:'Mobile'},{v:'land',l:'Land'},{v:'other',l:'Other'}
          ])}
          ${fi('available_date','Available date', l.available_date,'date',false)}
          ${fi('minimum_lease_months','Min lease (mo)', l.minimum_lease_months,'number',false)}
          ${fi('garage_spaces','Garage spaces', l.garage_spaces,'number',false)}
        </div>
      </div>

      <!-- Description -->
      <div class="pl-section">
        <div class="pl-section-title">Description &amp; instructions</div>
        <div class="pl-form-grid full">
          ${fi('description','Description', l.description,'textarea',false,true)}
          ${fi('showing_instructions','Showing instructions', l.showing_instructions,'textarea',false,true)}
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
          ${fi('has_central_air','Central air', l.has_central_air,'text',false,false,[
            {v:'',l:'— unknown —'},{v:'true',l:'Yes'},{v:'false',l:'No'}
          ])}
          ${fi('has_basement','Basement', l.has_basement,'text',false,false,[
            {v:'',l:'— unknown —'},{v:'true',l:'Yes'},{v:'false',l:'No'}
          ])}
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

  function openPanel(l){
    _current = l;
    _dirty   = {};
    const panel    = document.getElementById('pl-panel');
    const backdrop = document.getElementById('pl-backdrop');
    panel.innerHTML = renderPanel(l);
    requestAnimationFrame(() => {
      panel.classList.add('open');
      backdrop.classList.add('open');
      panel.querySelector('#pl-close-btn').addEventListener('click', closePanel);
    });

    const saveBtn = panel.querySelector('.pl-save-btn');
    if(saveBtn) saveBtn.addEventListener('click', () => doSave(l.id));

    const arcBtn = panel.querySelector('.pl-arc-btn-panel');
    if(arcBtn) arcBtn.addEventListener('click', () => doArchive(l.id));

    const pubBtn = panel.querySelector('.pl-pub-btn-panel');
    if(pubBtn) pubBtn.addEventListener('click', () => doPublish(l.id));
  }

  function closePanel(){
    const panel    = document.getElementById('pl-panel');
    const backdrop = document.getElementById('pl-backdrop');
    panel.classList.remove('open');
    backdrop.classList.remove('open');
    setTimeout(() => { panel.innerHTML = ''; _current = null; _dirty = {}; }, 300);
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  function collectPatch(){
    const panel = document.getElementById('pl-panel');
    if(!panel || !_current) return {};
    const l = _current;
    const patch = {};
    const textFields = ['title','address','city','state','zip','county','neighborhood',
      'description','showing_instructions','location_context','virtual_tour_url',
      'property_type','available_date'];
    const intFields  = ['monthly_rent','security_deposit','application_fee',
      'bedrooms','square_footage','minimum_lease_months','garage_spaces'];
    const floatFields = ['bathrooms'];
    const boolFields  = ['pets_allowed','smoking_allowed','has_central_air','has_basement'];

    textFields.forEach(f => {
      const el = panel.querySelector('#pf-'+f);
      if(!el) return;
      const v = el.value.trim() || null;
      if(v !== (l[f]??'').toString().trim()) patch[f] = v;
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
    return patch;
  }

  async function doSave(id){
    const patch = collectPatch();
    if(!Object.keys(patch).length){ S.toast('No changes to save', 'info'); return; }
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

    const l = _current || {};
    const desc = [l.address, l.city, l.state].filter(Boolean).join(', ');
    const ok = await S.confirm(
      'Publish "' + desc + '" as a draft?',
      'A draft property will be created in your listings. Photos will be transferred to ImageKit automatically.'
    );
    if(!ok) return;

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

    for(const id of publishable){
      try {
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

    if(succeeded > 0 && failed === 0){
      S.toast(`${succeeded} listing${succeeded !== 1 ? 's' : ''} published as drafts ✓`, 'success');
    } else if(succeeded > 0){
      S.toast(`${succeeded} published, ${failed} failed`, 'info');
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
      wireChips();
      wireSourceChips();
      wireBackdrop();
      wireLoadMore();
      wireBulkBar();
      load(false);
    })
    .catch(err => console.error('[pipeline] boot failed', err));

})();
