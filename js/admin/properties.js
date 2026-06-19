(function(){
    'use strict';
    let _statusFilter = 'all';
    let _landlordFilter = null;
    let _q = '';
    let _debounce = null;
    let _allCache = [];

    // ── Pre-seed from URL, then sessionStorage fallback ──
    try {
      const usp = new URLSearchParams(location.search);
      if(usp.get('status')) {
        _statusFilter = usp.get('status');
      } else if(!usp.get('landlord')) {
        // Restore last-used chip only when not filtering by landlord
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
      const rawUrl = p.photo_urls && p.photo_urls[0];
      const imgSrc = rawUrl && window.CONFIG && CONFIG.img ? CONFIG.img(rawUrl, 'card') : rawUrl;
      const img = imgSrc
        ? '<img class="prop-img" src="'+S.esc(imgSrc)+'" alt="" loading="lazy">'
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
        +       '<button class="btn btn-ghost btn-sm" data-action="toggle-featured" data-id="'+S.esc(p.id)+'" data-featured="'+(p.featured?'1':'0')+'" title="'+(p.featured?'Remove featured flag':'Mark as featured')+'">'+(p.featured?'★ Unfeature':'☆ Feature')+'</button>'
        +       '<button class="btn btn-ghost btn-sm" data-action="delete-prop" data-id="'+S.esc(p.id)+'" style="color:#dc2626;margin-left:auto" title="Delete property forever" aria-label="Delete property forever">Delete</button>'
        +     '</div>'
        +   '</div>'
        + '</div>';
    }

    async function load(){
      const grid = document.getElementById('prop-grid');
      grid.innerHTML = '<div class="skeleton sk-line lg" style="height:220px;border-radius:12px"></div>'.repeat(3);
      document.getElementById('page-sub').textContent = 'Loading…';
      let q = CP.sb().from('properties').select('*, landlords(business_name,contact_name), property_photos(url,display_order)').order('created_at',{ascending:false}).limit(200);
      if(_statusFilter !== 'all') q = q.eq('status', _statusFilter);
      if(_landlordFilter) q = q.eq('landlord_id', _landlordFilter);
      const { data, error } = await q;
      if(error){
        grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><svg class="i"><use href="#i-alert"/></svg><h3>Error</h3><p>'+AdminShell.esc(error.message)+'</p></div>';
        document.getElementById('page-sub').textContent = 'Error';
        return;
      }
      // Phase 3c: derive photo_urls from property_photos join (legacy array columns dropped)
      _allCache = (data || []).map(function(p) {
        if (Array.isArray(p.property_photos) && p.property_photos.length) {
          var sorted = p.property_photos.slice().sort(function(a,b){ return (a.display_order||0)-(b.display_order||0); });
          p.photo_urls = sorted.map(function(x){ return x.url; }).filter(Boolean);
        } else {
          p.photo_urls = [];
        }
        return p;
      });
      _renderFiltered();
    }

    function _renderFiltered() {
      const grid = document.getElementById('prop-grid');
      if (!grid) return;
      const q = _q.trim().toLowerCase();
      const filtered = q
        ? _allCache.filter(p =>
            (p.title || '').toLowerCase().includes(q) ||
            (p.address || '').toLowerCase().includes(q) ||
            (p.city || '').toLowerCase().includes(q) ||
            (p.landlords && ((p.landlords.business_name || '') + ' ' + (p.landlords.contact_name || '')).toLowerCase().includes(q)))
        : _allCache;
      const countEl = document.getElementById('page-sub');
      if (!filtered.length) {
        grid.innerHTML = q
          ? `<div class="empty" style="grid-column:1/-1"><svg class="i"><use href="#i-search"/></svg><h3>No results</h3><p>No properties match "<em>${AdminShell.esc(q)}</em>".</p></div>`
          : '<div class="empty" style="grid-column:1/-1"><svg class="i"><use href="#i-property"/></svg><h3>No properties</h3><p>Tap + to add one.</p></div>';
        if (countEl) countEl.textContent = q ? '0 results' : '0 properties';
        return;
      }
      grid.innerHTML = filtered.map(card).join('');
      if (countEl) countEl.textContent = filtered.length + ' propert' + (filtered.length === 1 ? 'y' : 'ies') + (q ? ' (filtered)' : '');
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

      // Pre-load landlords for new property creation
      let landlordOptions = [{ value: '', label: '— Unassigned —' }];
      if (!isEdit) {
        try {
          const { data: lData } = await CP.sb().rpc('admin_list_landlords', { p_page: 0, p_per_page: 200 });
          const rows = (lData && lData.rows) || [];
          if (rows.length) {
            landlordOptions = [{ value: '', label: '— Unassigned —' },
              ...rows.map(l => ({ value: l.id, label: l.business_name || l.contact_name || l.email || l.id }))];
          }
        } catch(e) { /* keep default — landlord can be set on detail page */ }
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
        load();
      } else {
        patch.created_at = new Date().toISOString();
        const r = await CP.sb().from('properties').insert([patch]).select('id').single();
        error = r.error;
        if(error){ AdminShell.toast('Save failed: '+error.message,'error'); return; }
        AdminShell.toast('Property created — opening detail page…','success');
        const newId = r.data && r.data.id;
        // Audit log (non-blocking)
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
          load();
        }
      }
    }

    // ─────────────────────── Hard delete (admin-only) ───────────────────────
    async function confirmAndDelete(id){
      const S = AdminShell;
      const p = _allCache.find(x => x.id === id);
      if(!p){ S.toast('Property not found','error'); return; }

      // Cascade impact: count children that will be deleted/affected
      let inqN = 0, phN = 0, savN = 0, appN = 0;
      try {
        const [inq, ph, sav, app] = await Promise.all([
          CP.sb().from('inquiries').select('id', { count:'exact', head:true }).eq('property_id', id),
          CP.sb().from('property_photos').select('id', { count:'exact', head:true }).eq('property_id', id),
          CP.sb().from('saved_properties').select('property_id', { count:'exact', head:true }).eq('property_id', id),
          CP.sb().from('applications').select('id', { count:'exact', head:true }).eq('property_id', id)
        ]);
        inqN = inq.count || 0; phN = ph.count || 0; savN = sav.count || 0; appN = app.count || 0;
      } catch(e) { /* counts are best-effort; proceed even if they fail */ }

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

      // Audit log first — must succeed before delete
      let userId = null;
      try {
        const u = await CP.sb().auth.getUser();
        userId = u.data && u.data.user ? u.data.user.id : null;
      } catch(e) { /* fall through with null user_id */ }

      const audit = await CP.sb().from('admin_actions').insert([{
        user_id: userId,
        action: 'property.hard_delete',
        target_type: 'property',
        target_id: String(id),
        metadata: {
          title: p.title || null,
          address: p.address || null,
          status: p.status || null,
          monthly_rent: p.monthly_rent || null,
          landlord_id: p.landlord_id || null,
          cascade: { inquiries: inqN, photos: phN, saves: savN, applications: appN },
          deleted_at: new Date().toISOString()
        }
      }]);
      if(audit.error){
        S.toast('Delete blocked: audit log failed (' + audit.error.message + ')', 'error');
        return;
      }

      const { error } = await CP.sb().from('properties').delete().eq('id', id);
      if(error){
        S.toast('Delete failed: ' + error.message, 'error');
        return;
      }

      S.toast('Property deleted', 'success');
      _allCache = _allCache.filter(x => x.id !== id);
      const cardEl = document.querySelector('[data-prop-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if(cardEl && cardEl.parentNode) cardEl.parentNode.removeChild(cardEl);
      const remaining = document.querySelectorAll('#prop-grid [data-prop-id]').length;
      const countElDel = document.getElementById('page-sub');
      if (countElDel) countElDel.textContent = remaining + ' propert' + (remaining === 1 ? 'y' : 'ies');
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

    document.addEventListener('cp:realtime', () => load().catch(()=>{}));
    document.addEventListener('DOMContentLoaded', async () => {
      try { await waitReady(8000); }
      catch(e){
        document.getElementById('prop-grid').innerHTML =
          '<div class="empty"><h3>Could not load admin tools</h3><p>'+e.message+'</p></div>';
        return;
      }
      const ok = await AdminShell.requireAdmin();
      if(!ok) return;

      AdminShell.on('refresh', () => load());
      AdminShell.on('add-prop', (target, e) => { e.preventDefault(); openForm(null); });
      AdminShell.on('delete-prop', (target) => {
        const id = target.getAttribute('data-id');
        if(id) confirmAndDelete(id).catch(err => AdminShell.toast('Delete error: '+(err && err.message || err), 'error'));
      });
      AdminShell.on('toggle-featured', async (target) => {
        const id = target.getAttribute('data-id');
        const isFeatured = target.getAttribute('data-featured') === '1';
        if(!id) return;
        const { error } = await CP.sb().from('properties').update({ featured: !isFeatured, updated_at: new Date().toISOString() }).eq('id', id);
        if(error){ AdminShell.toast('Failed: '+error.message, 'error'); return; }
        AdminShell.toast(isFeatured ? 'Removed featured flag' : 'Marked as featured', 'success');
        load();
      });

      // Belt-and-suspenders: also delegate clicks directly on the grid in case AdminShell.on
      // ever stops matching after a re-render.
      document.getElementById('prop-grid').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="delete-prop"]');
        if(!btn) return;
        e.preventDefault();
        const id = btn.getAttribute('data-id');
        if(id) confirmAndDelete(id).catch(err => AdminShell.toast('Delete error: '+(err && err.message || err), 'error'));
      });

      // Reflect pre-seeded filter on chips (URL or sessionStorage)
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
        load();
      });
      document.getElementById('search').addEventListener('input', e => {
        _q = e.target.value;
        clearTimeout(_debounce); _debounce = setTimeout(_renderFiltered, 100);
      });

      // Show landlord filter banner if ?landlord= is set
      if(_landlordFilter){
        const banner = document.getElementById('landlord-banner');
        if(banner){
          banner.style.display = 'flex';
          // Try to resolve landlord name via RPC
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

      load();
    });
  })();
  