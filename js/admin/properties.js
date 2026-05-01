(function(){
    'use strict';
    let _statusFilter = 'all';
    let _q = '';
    let _debounce = null;
    let _allCache = [];

    function pill(s){
      const m = { active:'pill-success', rented:'pill-info', inactive:'pill-muted', maintenance:'pill-warning' };
      return '<span class="pill '+(m[s]||'pill-muted')+'">'+(s||'unknown')+'</span>';
    }
    function fmtMoney(v){ if(v==null) return '—'; return '$'+Number(v).toLocaleString('en-US'); }

    function card(p){
      const S = AdminShell;
      const img = (p.photo_urls && p.photo_urls[0])
        ? '<img class="prop-img" src="'+S.esc(p.photo_urls[0])+'" alt="" loading="lazy">'
        : '<div class="prop-img-ph"><svg class="i"><use href="#i-property"/></svg></div>';
      const meta = [
        p.bedrooms!=null ? p.bedrooms+'bd' : null,
        p.bathrooms!=null ? p.bathrooms+'ba' : null,
        p.monthly_rent ? fmtMoney(p.monthly_rent)+'/mo' : null,
        p.square_footage ? p.square_footage+' sqft' : null
      ].filter(Boolean).join(' · ');
      return ''
        + '<div class="prop-card" data-prop-id="'+S.esc(p.id)+'">'
        +   img
        +   '<div class="prop-body">'
        +     '<div class="row-title">'+S.esc(p.title||'Untitled')+'</div>'
        +     '<div class="row-sub">'+S.esc(p.address||p.location||'No address')+'</div>'
        +     '<div>'+pill(p.status)+'</div>'
        +     '<div class="row-sub" style="color:var(--muted-2)">'+S.esc(meta)+'</div>'
        +     '<div class="prop-actions">'
        +       '<button class="btn btn-ghost btn-sm" data-action="edit-prop" data-id="'+S.esc(p.id)+'">Edit</button>'
        +       '<a class="btn btn-ghost btn-sm" href="/admin/property-detail.html?id='+S.esc(p.id)+'">View</a>'
        +       '<button class="btn btn-ghost btn-sm" data-action="delete-prop" data-id="'+S.esc(p.id)+'" style="color:#dc2626;margin-left:auto" title="Delete property forever" aria-label="Delete property forever">Delete</button>'
        +     '</div>'
        +   '</div>'
        + '</div>';
    }

    async function load(){
      const grid = document.getElementById('prop-grid');
      grid.innerHTML = '<div class="skeleton sk-line lg" style="height:220px;border-radius:12px"></div>'.repeat(3);
      document.getElementById('page-sub').textContent = 'Loading…';
      let q = CP.sb().from('properties').select('*, property_photos(url,display_order)').order('created_at',{ascending:false});
      if(_statusFilter !== 'all') q = q.eq('status', _statusFilter);
      if(_q.trim()){
        const s = _q.trim().replace(/'/g,"''");
        q = q.or('title.ilike.%'+s+'%,address.ilike.%'+s+'%');
      }
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
      document.getElementById('page-sub').textContent = _allCache.length+' propert'+(_allCache.length===1?'y':'ies');
      if(!_allCache.length){
        grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><svg class="i"><use href="#i-property"/></svg><h3>No properties</h3><p>Tap + to add one.</p></div>';
        return;
      }
      grid.innerHTML = _allCache.map(card).join('');
    }

    function fields(p){
      p = p || {};
      return [
        { name:'title',          label:'Title',         type:'text',     value:p.title||'',          required:true,  placeholder:'2BR/1BA Apartment' },
        { name:'status',         label:'Status',        type:'select',   value:p.status||'active', options:[
            {value:'active',label:'Active'},{value:'inactive',label:'Inactive'},{value:'rented',label:'Rented'},{value:'maintenance',label:'Maintenance'}
          ]},
        { name:'address',        label:'Address',       type:'text',     value:p.address||p.location||'', required:true, placeholder:'123 Main St, City, State 12345' },
        { name:'bedrooms',       label:'Bedrooms',      type:'number',   value:p.bedrooms!=null?p.bedrooms:'', placeholder:'2' },
        { name:'bathrooms',      label:'Bathrooms',     type:'number',   value:p.bathrooms!=null?p.bathrooms:'', placeholder:'1' },
        { name:'monthly_rent',   label:'Monthly rent',  type:'number',   value:p.monthly_rent||'', placeholder:'1500' },
        { name:'property_type',  label:'Type',          type:'select',   value:p.property_type||'', options:[
            {value:'',label:'Select…'},{value:'apartment',label:'Apartment'},{value:'house',label:'House'},
            {value:'condo',label:'Condo'},{value:'townhouse',label:'Townhouse'},{value:'studio',label:'Studio'},{value:'duplex',label:'Duplex'}
          ]},
        { name:'square_footage', label:'Sq ft',         type:'number',   value:p.square_footage||'', placeholder:'850' },
        { name:'available_date', label:'Available',     type:'date',     value:p.available_date||'' },
        { name:'description',    label:'Description',   type:'textarea', value:p.description||'', rows:3 },
        { name:'amenities',      label:'Amenities',     type:'text',     value:(p.amenities||[]).join(', '), placeholder:'Parking, Laundry, AC, Pets OK', help:'Comma-separated' }
      ];
    }

    async function openForm(p){
      const isEdit = !!(p && p.id);
      const data = await AdminShell.formSheet({
        title: isEdit ? 'Edit property' : 'Add property',
        submit: isEdit ? 'Save changes' : 'Create property',
        fields: fields(p)
      });
      if(!data) return;
      if(!data.title || !data.address){
        AdminShell.toast('Title and address are required','error'); return;
      }
      const patch = {
        title: data.title.trim(),
        address: data.address.trim(),
        status: data.status || 'active',
        property_type: data.property_type || null,
        bedrooms: data.bedrooms !== '' ? Number(data.bedrooms) : null,
        bathrooms: data.bathrooms !== '' ? Number(data.bathrooms) : null,
        monthly_rent: data.monthly_rent !== '' ? Number(data.monthly_rent) : null,
        square_footage: data.square_footage !== '' ? Number(data.square_footage) : null,
        available_date: data.available_date || null,
        description: (data.description||'').trim() || null,
        amenities: data.amenities ? data.amenities.split(',').map(s => s.trim()).filter(Boolean) : [],
        updated_at: new Date().toISOString()
      };
      let error;
      if(isEdit){
        const r = await CP.sb().from('properties').update(patch).eq('id', p.id); error = r.error;
      } else {
        patch.created_at = new Date().toISOString();
        const r = await CP.sb().from('properties').insert([patch]); error = r.error;
      }
      if(error){ AdminShell.toast('Save failed: '+error.message,'error'); return; }
      AdminShell.toast(isEdit ? 'Updated' : 'Property added','success');
      load();
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
      // Remove the card immediately for snappy UX, then reload to resync counts
      const cardEl = document.querySelector('[data-prop-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if(cardEl && cardEl.parentNode) cardEl.parentNode.removeChild(cardEl);
      load();
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
      AdminShell.on('edit-prop', (target) => {
        const id = target.getAttribute('data-id');
        const p = _allCache.find(x => x.id === id);
        if(p) openForm(p);
      });
      AdminShell.on('delete-prop', (target) => {
        const id = target.getAttribute('data-id');
        if(id) confirmAndDelete(id).catch(err => AdminShell.toast('Delete error: '+(err && err.message || err), 'error'));
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

      document.getElementById('chips').addEventListener('click', e => {
        const c = e.target.closest('.chip');
        if(!c) return;
        document.querySelectorAll('#chips .chip').forEach(x => x.classList.remove('active'));
        c.classList.add('active');
        _statusFilter = c.dataset.status;
        load();
      });
      document.getElementById('search').addEventListener('input', e => {
        _q = e.target.value;
        clearTimeout(_debounce); _debounce = setTimeout(load, 300);
      });

      load();
    });
  })();
  