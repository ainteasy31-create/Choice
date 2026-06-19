(function(){
  'use strict';
  let _statusFilter = 'all';
  let _landlordFilter = null;
  let _q = '';
  let _debounce = null;
  let _allCache = [];
  let _rendered  = 0;
  const PAGE_SIZE = 20;
  const CACHE_KEY = 'cp_props_v2';
  const CACHE_TTL = 60_000;

  try {
    const usp = new URLSearchParams(location.search);
    if(usp.get('status')) {
      _statusFilter = usp.get('status');
    } else if(!usp.get('landlord')) {
      const saved = sessionStorage.getItem('cp_prop_status');
      if(saved) _statusFilter = saved;
    }
    if(usp.get('landlord')) _landlordFilter = usp.get('landlord');
  } catch(e){}

  function pill(s){
    const m = { active:'pill-success', rented:'pill-info', inactive:'pill-muted', maintenance:'pill-warning', draft:'pill-muted', paused:'pill-warning', archived:'pill-muted' };
    return '<span class="pill '+(m[s]||'pill-muted')+'">'+(s||'unknown')+'</span>';
  }
  function fmtMoney(v){ if(v==null) return '—'; return '$'+Number(v).toLocaleString('en-US'); }

  function card(p){
    const S = AdminShell;
    const rawUrl = p.cover_url || (p.photo_urls && p.photo_urls[0]);
    const imgSrc = rawUrl && window.CONFIG && CONFIG.img ? CONFIG.img(rawUrl, 'card') : rawUrl;
    const img = imgSrc
      ? '<img class="prop-img" src="'+S.esc(imgSrc)+'" alt="" loading="lazy" decoding="async">'
      : '<div class="prop-img-ph"><svg class="i"><use href="#i-property"/></svg></div>';
    const meta = [
      p.bedrooms!=null ? p.bedrooms+'bd' : null,
      p.bathrooms!=null ? p.bathrooms+'ba' : null,
      p.monthly_rent ? fmtMoney(p.monthly_rent)+'/mo' : null,
      p.square_footage ? p.square_footage+' sqft' : null
    ].filter(Boolean).join(' · ');
    const featuredBadge = p.featured ? ' <span class="pill pill-warning" style="font-size:.62rem">★ Featured</span>' : '';
    return ''
      + '<div class="prop-card" data-prop-id="'+S.esc(p.id)+'">'
      +   img
      +   '<div class="prop-body">'
      +     '<div class="row-title">'+S.esc(p.title||'Untitled')+featuredBadge+'</div>'
      +     '<div class="row-sub">'+S.esc(p.address||p.location||'No address')+'</div>'
      +     '<div>'+pill(p.status)+(p.landlords ? ' <span class="pill pill-muted" style="font-size:.65rem">'+S.esc(p.landlords.business_name||p.landlords.contact_name||'')+'</span>' : '')+'</div>'
      +     '<div class="row-sub" style="color:var(--muted-2)">'+S.esc(meta)+'</div>'
      +     '<div class="prop-actions">'
      +       '<a class="btn btn-ghost btn-sm" href="/admin/property-detail.html?id='+S.esc(p.id)+'&edit=1">Edit</a>'
      +       '<a class="btn btn-ghost btn-sm" href="/admin/property-detail.html?id='+S.esc(p.id)+'">View</a>'
      +       '<button class="btn btn-ghost btn-sm prop-quick-btn" data-action="quick-edit" data-id="'+S.esc(p.id)+'" title="Quick actions">⋮</button>'
      +       '<button class="btn btn-ghost btn-sm" data-action="delete-prop" data-id="'+S.esc(p.id)+'" style="color:#dc2626;margin-left:auto" aria-label="Delete property forever">Delete</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
  }

  function _cacheKey(){ return CACHE_KEY+'_'+_statusFilter+'_'+(_landlordFilter||'all'); }

  async function load(fromCache){
    const grid = document.getElementById('prop-grid');
    const moreBtn = document.getElementById('load-more-btn');

    if(fromCache){
      try {
        const raw = sessionStorage.getItem(_cacheKey());
        if(raw){
          const { ts, data } = JSON.parse(raw);
          if(Date.now() - ts < CACHE_TTL && Array.isArray(data) && data.length){
            _allCache = data;
            _rendered = 0;
            _renderFiltered(true);
            document.getElementById('page-sub').textContent = data.length + ' propert'+(data.length===1?'y':'ies')+' (cached)';
            _doLoad().catch(()=>{});
            return;
          }
        }
      } catch(e){}
    }

    grid.innerHTML = '<div class="skeleton sk-line lg" style="height:220px;border-radius:12px"></div>'.repeat(3);
    if(moreBtn) moreBtn.style.display = 'none';
    document.getElementById('page-sub').textContent = 'Loading…';
    await _doLoad();
  }

  async function _doLoad(){
    const grid = document.getElementById('prop-grid');
    let q = CP.sb()
      .from('properties')
      .select('id,title,address,location,city,state,status,bedrooms,bathrooms,monthly_rent,square_footage,featured,landlord_id,created_at,updated_at,landlords(business_name,contact_name)')
      .order('created_at',{ascending:false})
      .limit(300);
    if(_statusFilter !== 'all') q = q.eq('status', _statusFilter);
    if(_landlordFilter) q = q.eq('landlord_id', _landlordFilter);
    const { data, error } = await q;
    if(error){
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><svg class="i"><use href="#i-alert"/></svg><h3>Error</h3><p>'+AdminShell.esc(error.message)+'</p></div>';
      document.getElementById('page-sub').textContent = 'Error';
      return;
    }
    const props = data || [];

    const ids = props.map(p => p.id);
    let coverMap = {};
    if(ids.length){
      const { data: photos } = await CP.sb()
        .from('property_photos')
        .select('property_id,url,display_order')
        .in('property_id', ids)
        .order('display_order', {ascending:true});
      if(photos){
        photos.forEach(ph => {
          if(!coverMap[ph.property_id]) coverMap[ph.property_id] = ph.url;
        });
      }
    }

    _allCache = props.map(p => ({ ...p, cover_url: coverMap[p.id] || null }));

    try {
      sessionStorage.setItem(_cacheKey(), JSON.stringify({ ts: Date.now(), data: _allCache }));
    } catch(e){}

    _rendered = 0;
    _renderFiltered(true);
  }

  function _getFiltered(){
    const q = _q.trim().toLowerCase();
    return q
      ? _allCache.filter(p =>
          (p.title||'').toLowerCase().includes(q) ||
          (p.address||'').toLowerCase().includes(q) ||
          (p.city||'').toLowerCase().includes(q) ||
          (p.landlords && ((p.landlords.business_name||'')+' '+(p.landlords.contact_name||'')).toLowerCase().includes(q)))
      : _allCache;
  }

  function _renderFiltered(reset) {
    const grid = document.getElementById('prop-grid');
    if(!grid) return;
    if(reset) { _rendered = 0; grid.innerHTML = ''; }

    const filtered = _getFiltered();
    const countEl = document.getElementById('page-sub');
    let moreBtn = document.getElementById('load-more-btn');

    if(!filtered.length){
      const q = _q.trim();
      grid.innerHTML = q
        ? `<div class="empty" style="grid-column:1/-1"><svg class="i"><use href="#i-search"/></svg><h3>No results</h3><p>No properties match "<em>${AdminShell.esc(q)}</em>".</p></div>`
        : '<div class="empty" style="grid-column:1/-1"><svg class="i"><use href="#i-property"/></svg><h3>No properties</h3><p>Tap + to add one.</p></div>';
      if(countEl) countEl.textContent = q ? '0 results' : '0 properties';
      if(moreBtn) moreBtn.style.display = 'none';
      return;
    }

    const slice = filtered.slice(_rendered, _rendered + PAGE_SIZE);
    grid.insertAdjacentHTML('beforeend', slice.map(card).join(''));
    _rendered += slice.length;

    const hasMore = _rendered < filtered.length;
    if(!moreBtn){
      moreBtn = document.createElement('div');
      moreBtn.id = 'load-more-btn';
      moreBtn.style.cssText = 'grid-column:1/-1;display:flex;justify-content:center;padding:8px 0';
      moreBtn.innerHTML = '<button class="btn btn-ghost" id="load-more-inner">Load more</button>';
      grid.parentNode.insertBefore(moreBtn, grid.nextSibling);
      document.getElementById('load-more-inner')?.addEventListener('click', () => _renderFiltered(false));
    }
    moreBtn.style.display = hasMore ? 'flex' : 'none';

    if(countEl){
      const q = _q.trim();
      const showing = Math.min(_rendered, filtered.length);
      const suffix = hasMore ? ` (showing ${showing} of ${filtered.length})` : (q ? ' (filtered)' : '');
      countEl.textContent = filtered.length + ' propert'+(filtered.length===1?'y':'ies')+suffix;
    }
  }

  function fields(p){
    p = p || {};
    return [
      { name:'title',          label:'Title',         type:'text',     value:p.title||'',          required:true,  placeholder:'2BR/1BA Apartment in Downtown' },
      { name:'status',         label:'Status',        type:'select',   value:p.status||'draft', options:[
          {value:'draft',label:'Draft (not visible)'},{value:'active',label:'Active'},{value:'inactive',label:'Inactive'},
          {value:'rented',label:'Rented'},{value:'maintenance',label:'Maintenance'},{value:'paused',label:'Paused'},{value:'archived',label:'Archived'}
        ]},
      { name:'address',        label:'Street address', type:'text',    value:p.address||p.location||'', required:true, placeholder:'123 Main St' },
      { name:'city',           label:'City',          type:'text',     value:p.city||'',               placeholder:'San Francisco' },
      { name:'state',          label:'State',         type:'select',   value:p.state||'', options:[
          {value:'',label:'Select…'},
          ...['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'].map(s=>({value:s,label:s}))
        ]},
      { name:'zip',            label:'Zip code',      type:'text',     value:p.zip||'',                placeholder:'94101' },
      { name:'property_type',  label:'Property type', type:'select',   value:p.property_type||'', options:[
          {value:'',label:'Select…'},{value:'apartment',label:'Apartment'},{value:'house',label:'House'},
          {value:'condo',label:'Condo'},{value:'townhouse',label:'Townhouse'},{value:'studio',label:'Studio'},
          {value:'duplex',label:'Duplex'},{value:'room',label:'Room'},{value:'land',label:'Land'}
        ]},
      { name:'bedrooms',       label:'Bedrooms',      type:'number',   value:p.bedrooms!=null?p.bedrooms:'', placeholder:'2' },
      { name:'bathrooms',      label:'Bathrooms',     type:'number',   value:p.bathrooms!=null?p.bathrooms:'', placeholder:'1' },
      { name:'square_footage', label:'Square footage (sqft)', type:'number', value:p.square_footage||'', placeholder:'850' },
      { name:'monthly_rent',   label:'Monthly rent ($)', type:'number', value:p.monthly_rent||'', placeholder:'1500' },
      { name:'security_deposit', label:'Security deposit ($)', type:'number', value:p.security_deposit||'', placeholder:'1500' },
      { name:'application_fee', label:'Application fee ($)',  type:'number', value:p.application_fee!=null?p.application_fee:'', placeholder:'50' },
      { name:'available_date', label:'Available date', type:'date',    value:p.available_date||'' },
      { name:'description',    label:'Description',   type:'textarea', value:p.description||'', rows:3, placeholder:'Describe the property…' },
      { name:'amenities',      label:'Amenities',     type:'text',     value:(p.amenities||[]).join(', '), placeholder:'Pool, Gym, In-unit Laundry, AC', help:'Comma-separated — more can be added in the full editor' }
    ];
  }

  async function openForm(p){
    const isEdit = !!(p && p.id);

    let landlordOptions = [{ value: '', label: '— Unassigned —' }];
    if (!isEdit) {
      try {
        const { data: lData } = await CP.sb().rpc('admin_list_landlords', { p_page: 0, p_per_page: 200 });
        const rows = (lData && lData.rows) || [];
        if (rows.length) {
          landlordOptions = [{ value: '', label: '— Unassigned —' },
            ...rows.map(l => ({ value: l.id, label: l.business_name || l.contact_name || l.email || l.id }))];
        }
      } catch(e) {}
    }

    const allFields = fields(p);
    if (!isEdit) {
      allFields.push({ name: 'landlord_id', label: 'Assign to landlord', type: 'select', value: '', options: landlordOptions });
    }

    const data = await AdminShell.formSheet({
      title: isEdit ? 'Edit property' : 'Add property',
      submit: isEdit ? 'Save changes' : 'Create property',
      fields: allFields
    });
    if(!data) return;
    if(!data.title || !data.address){
      AdminShell.toast('Title and address are required','error'); return;
    }
    const _n = (k) => data[k] !== '' && data[k] != null ? Number(data[k]) : null;
    const patch = {
      title: data.title.trim(),
      address: data.address.trim(),
      city: (data.city || '').trim() || null,
      state: data.state || null,
      zip: (data.zip || '').trim() || null,
      status: data.status || 'draft',
      property_type: data.property_type || null,
      bedrooms: _n('bedrooms'),
      bathrooms: _n('bathrooms'),
      monthly_rent: _n('monthly_rent'),
      security_deposit: _n('security_deposit'),
      application_fee: _n('application_fee'),
      square_footage: _n('square_footage'),
      available_date: data.available_date || null,
      description: (data.description||'').trim() || null,
      amenities: data.amenities ? data.amenities.split(',').map(s => s.trim()).filter(Boolean) : [],
      updated_at: new Date().toISOString()
    };
    if (!isEdit && data.landlord_id) patch.landlord_id = data.landlord_id;
    let error;
    if(isEdit){
      const r = await CP.sb().from('properties').update(patch).eq('id', p.id); error = r.error;
      if(error){ AdminShell.toast('Save failed: '+error.message,'error'); return; }
      AdminShell.toast('Updated','success');
      _clearCache();
      load(false);
    } else {
      patch.created_at = new Date().toISOString();
      const r = await CP.sb().from('properties').insert([patch]).select('id').single();
      error = r.error;
      if(error){ AdminShell.toast('Save failed: '+error.message,'error'); return; }
      AdminShell.toast('Property created — opening detail page…','success');
      const newId = r.data && r.data.id;
      CP.sb().auth.getUser().then(({ data: ud }) => {
        CP.sb().from('admin_actions').insert([{
          user_id: ud?.user?.id || null,
          action: 'property.create',
          target_type: 'property',
          target_id: newId ? String(newId) : null,
          metadata: { title: patch.title, address: patch.address, status: patch.status, landlord_id: patch.landlord_id || null, created_at: patch.created_at }
        }]).catch(() => {});
      }).catch(() => {});
      if(newId){
        setTimeout(() => { location.href = '/admin/property-detail.html?id='+encodeURIComponent(newId)+'&edit=1'; }, 600);
      } else {
        _clearCache();
        load(false);
      }
    }
  }

  async function openQuickEdit(id){
    const p = _allCache.find(x => x.id === id);
    if(!p) return;
    const S = AdminShell;
    const data = await S.formSheet({
      title: (p.title || 'Property').slice(0,40),
      submit: 'Save',
      fields: [
        { name:'status', label:'Status', type:'select', value:p.status||'draft', options:[
            {value:'active',label:'Active'},{value:'inactive',label:'Inactive'},
            {value:'rented',label:'Rented'},{value:'maintenance',label:'Maintenance'},
            {value:'draft',label:'Draft'},{value:'paused',label:'Paused'},{value:'archived',label:'Archived'}
          ]},
        { name:'featured', label:'Featured listing', type:'select', value:p.featured?'true':'false',
          options:[{value:'false',label:'No'},{value:'true',label:'Yes — show as featured'}] },
        { name:'monthly_rent', label:'Monthly rent ($)', type:'number', value:p.monthly_rent||'', placeholder:'1500' }
      ]
    });
    if(!data) return;
    const patch = {
      status:       data.status || p.status,
      featured:     data.featured === 'true',
      monthly_rent: data.monthly_rent !== '' && data.monthly_rent != null ? Number(data.monthly_rent) : p.monthly_rent,
      updated_at:   new Date().toISOString()
    };
    const { error } = await CP.sb().from('properties').update(patch).eq('id', id);
    if(error){ S.toast('Failed: '+error.message,'error'); return; }
    Object.assign(p, patch);
    _clearCache();
    const cardEl = document.querySelector('[data-prop-id="'+id+'"]');
    if(cardEl) cardEl.outerHTML = card(p);
    S.toast('Updated','success');
    if(patch.status !== p.status){
      CP.sb().auth.getUser().then(({ data: ud }) => {
        CP.sb().from('admin_actions').insert([{
          user_id: ud?.user?.id || null, action:'property.status_change',
          target_type:'property', target_id:String(id),
          metadata:{ from:p.status, to:patch.status }
        }]).catch(()=>{});
      }).catch(()=>{});
    }
  }

  async function confirmAndDelete(id){
    const S = AdminShell;
    const p = _allCache.find(x => x.id === id);
    if(!p){ S.toast('Property not found','error'); return; }

    let inqN = 0, phN = 0, savN = 0, appN = 0;
    try {
      const [inq, ph, sav, app] = await Promise.all([
        CP.sb().from('inquiries').select('id', { count:'exact', head:true }).eq('property_id', id),
        CP.sb().from('property_photos').select('id', { count:'exact', head:true }).eq('property_id', id),
        CP.sb().from('saved_properties').select('property_id', { count:'exact', head:true }).eq('property_id', id),
        CP.sb().from('applications').select('id', { count:'exact', head:true }).eq('property_id', id)
      ]);
      inqN = inq.count || 0; phN = ph.count || 0; savN = sav.count || 0; appN = app.count || 0;
    } catch(e) {}

    const lines = [
      'Delete "' + (p.title||'Untitled') + '"',
      (p.address||''),
      '',
      'Cascade: this will also permanently delete:',
      '  • ' + inqN + ' inquir' + (inqN===1?'y':'ies'),
      '  • ' + phN + ' photo' + (phN===1?'':'s'),
      '  • ' + savN + ' tenant save' + (savN===1?'':'s')
    ];
    if(appN) lines.push('', appN + ' application' + (appN===1?'':'s') + ' will be kept but unlinked from this property.');
    lines.push('', 'This cannot be undone.');

    const ok = await S.confirm({
      title: 'Delete this property forever?',
      message: lines.join('\n'),
      ok: 'Delete forever',
      cancel: 'Cancel',
      danger: true
    });
    if(!ok) return;

    let userId = null;
    try {
      const u = await CP.sb().auth.getUser();
      userId = u.data && u.data.user ? u.data.user.id : null;
    } catch(e) {}

    const audit = await CP.sb().from('admin_actions').insert([{
      user_id: userId,
      action: 'property.hard_delete',
      target_type: 'property',
      target_id: String(id),
      metadata: {
        title: p.title || null, address: p.address || null, status: p.status || null,
        monthly_rent: p.monthly_rent || null, landlord_id: p.landlord_id || null,
        cascade: { inquiries: inqN, photos: phN, saves: savN, applications: appN },
        deleted_at: new Date().toISOString()
      }
    }]);
    if(audit.error){ S.toast('Delete blocked: audit log failed (' + audit.error.message + ')', 'error'); return; }

    const { error } = await CP.sb().from('properties').delete().eq('id', id);
    if(error){ S.toast('Delete failed: ' + error.message, 'error'); return; }

    S.toast('Property deleted', 'success');
    _allCache = _allCache.filter(x => x.id !== id);
    _clearCache();
    const cardEl = document.querySelector('[data-prop-id="'+id+'"]');
    if(cardEl) cardEl.remove();
    const remaining = document.querySelectorAll('#prop-grid [data-prop-id]').length;
    const countElDel = document.getElementById('page-sub');
    if(countElDel) countElDel.textContent = remaining + ' propert' + (remaining === 1 ? 'y' : 'ies');
  }

  function _clearCache(){
    try { sessionStorage.removeItem(_cacheKey()); } catch(e){}
  }

  function readyDeps(){ return window.AdminShell && window.CP && CP.sb && CP.Auth; }
  function waitReady(ms){
    return new Promise((res,rej)=>{
      const start=Date.now();
      (function tick(){
        if(readyDeps()) return res();
        if(Date.now()-start>ms) return rej(new Error('Admin tools failed to load.'));
        setTimeout(tick,80);
      })();
    });
  }

  document.addEventListener('cp:realtime', () => { _clearCache(); load(false).catch(()=>{}); });
  document.addEventListener('DOMContentLoaded', async () => {
    try { await waitReady(8000); }
    catch(e){
      document.getElementById('prop-grid').innerHTML =
        '<div class="empty"><h3>Could not load admin tools</h3><p>'+e.message+'</p></div>';
      return;
    }
    const ok = await AdminShell.requireAdmin();
    if(!ok) return;

    AdminShell.on('refresh', () => { _clearCache(); load(false); });
    AdminShell.on('add-prop', (target, e) => { e.preventDefault(); openForm(null); });

    document.getElementById('prop-grid').addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-action="delete-prop"]');
      if(delBtn){
        e.preventDefault();
        const id = delBtn.getAttribute('data-id');
        if(id) confirmAndDelete(id).catch(err => AdminShell.toast('Delete error: '+(err && err.message || err), 'error'));
        return;
      }
      const quickBtn = e.target.closest('[data-action="quick-edit"]');
      if(quickBtn){
        e.preventDefault();
        const id = quickBtn.getAttribute('data-id');
        if(id) openQuickEdit(id).catch(err => AdminShell.toast('Error: '+(err && err.message || err), 'error'));
        return;
      }
    });

    AdminShell.on('toggle-featured', async (target) => {
      const id = target.getAttribute('data-id');
      const isFeatured = target.getAttribute('data-featured') === '1';
      if(!id) return;
      const { error } = await CP.sb().from('properties').update({ featured: !isFeatured, updated_at: new Date().toISOString() }).eq('id', id);
      if(error){ AdminShell.toast('Failed: '+error.message, 'error'); return; }
      AdminShell.toast(isFeatured ? 'Removed featured flag' : 'Marked as featured', 'success');
      const p = _allCache.find(x => x.id === id);
      if(p){ p.featured = !isFeatured; _clearCache(); }
      load(false);
    });

    document.querySelectorAll('#chips .chip').forEach(c => {
      c.classList.toggle('active', (c.dataset.status || 'all') === _statusFilter);
    });

    document.getElementById('chips').addEventListener('click', e => {
      const c = e.target.closest('.chip');
      if(!c) return;
      document.querySelectorAll('#chips .chip').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      _statusFilter = c.dataset.status || 'all';
      try { sessionStorage.setItem('cp_prop_status', _statusFilter); } catch(e2){}
      _clearCache();
      load(false);
    });
    document.getElementById('search').addEventListener('input', e => {
      _q = e.target.value;
      clearTimeout(_debounce); _debounce = setTimeout(() => _renderFiltered(true), 150);
    });

    if(_landlordFilter){
      const banner = document.getElementById('landlord-banner');
      if(banner){
        banner.style.display = 'flex';
        CP.sb().rpc('admin_list_landlords', { p_page: 0, p_per_page: 200 }).then(({ data }) => {
          const rows = (data && data.rows) || [];
          const lname = document.getElementById('landlord-banner-name');
          if(lname){
            const l = rows.find(r => r.id === _landlordFilter);
            lname.textContent = l ? (l.business_name || l.contact_name || l.email || _landlordFilter) : _landlordFilter;
          }
        }).catch(()=>{});
      }
    }

    load(true);
  });
})();
