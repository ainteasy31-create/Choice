(function(){
  'use strict';
  let _all = [];
  let _status = '';
  let _q = '';
  let _debounce = null;

  function pill(s){
    const m = { active:'pill-success', draft:'pill-muted', paused:'pill-warning', rented:'pill-info', archived:'pill-muted' };
    return '<span class="pill '+(m[s]||'pill-muted')+'">'+AdminShell.esc(s||'—')+'</span>';
  }
  function fmtMoney(n){
    if(n==null||n===''||isNaN(Number(n))) return '—';
    try{ return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(Number(n)); }
    catch{ return '$'+n; }
  }

  function row(p){
    const S = AdminShell;
    const landlord = p.landlords && (p.landlords.business_name || p.landlords.contact_name);
    const sub = [
      p.address ? (p.address+(p.city?', '+p.city:'')+(p.state?', '+p.state:'')) : null,
      (p.bedrooms||0)+'bd / '+(p.bathrooms||0)+'ba',
      fmtMoney(p.monthly_rent)+'/mo',
      landlord ? 'Landlord: '+landlord : null
    ].filter(Boolean).map(S.esc).join(' · ');
    return ''
      + '<div class="list-row" data-id="'+S.esc(p.id)+'" data-status="'+S.esc(p.status||'')+'">'
      +   '<div class="list-row-inner">'
      +     '<div class="row-body">'
      +       '<div class="row-title">'+S.esc(p.title||'Untitled')+' '+pill(p.status)+'</div>'
      +       '<div class="row-sub">'+sub+'</div>'
      +       '<div class="row-sub" style="color:var(--muted-2)">'+(p.views_count||0)+' views · '+(p.applications_count||0)+' apps · listed '+S.fmtRelative(p.created_at)+'</div>'
      +     '</div>'
      +     '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0">'
      +       '<a class="btn btn-ghost btn-sm" href="property-detail.html?id='+S.esc(p.id)+'">View ↗</a>'
      +       '<button class="btn btn-ghost btn-sm" data-action="status">Status</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
  }

  function applyFilter(){
    const f = _all.filter(p => {
      if(_status && p.status !== _status) return false;
      if(_q && !((p.title||'')+' '+(p.address||'')).toLowerCase().includes(_q)) return false;
      return true;
    });
    document.getElementById('page-sub').textContent = f.length+' listing'+(f.length===1?'':'s');
    AdminShell.renderList('#list-list', f, {
      render: row,
      emptyIcon: 'i-list',
      emptyTitle: 'No listings found',
      emptySub: 'Try a different filter.'
    });
  }

  async function load(){
    AdminShell.renderList('#list-list', 'loading', { skeleton: 5 });
    document.getElementById('page-sub').textContent = 'Loading…';
    const { data, error } = await CP.sb()
      .from('properties')
      .select('*,landlords(contact_name,business_name)')
      .order('created_at',{ascending:false});
    if(error){
      AdminShell.renderList('#list-list', { error: error.message });
      document.getElementById('page-sub').textContent = 'Error';
      return;
    }
    _all = data || [];
    applyFilter();
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

  AdminShell && AdminShell.on && AdminShell.on('status', async (target) => {
    const rowEl = target.closest('.list-row');
    if(!rowEl) return;
    const id = rowEl.dataset.id;
    const current = rowEl.dataset.status;
    const data = await AdminShell.formSheet({
      title: 'Change status',
      submit: 'Save',
      fields: [{
        name: 'status', label: 'New status', type: 'select', value: current,
        options: [
          {value:'active',label:'Active'},
          {value:'draft',label:'Draft'},
          {value:'paused',label:'Paused'},
          {value:'rented',label:'Rented'},
          {value:'inactive',label:'Inactive'},
          {value:'maintenance',label:'Maintenance'},
          {value:'archived',label:'Archived'}
        ]
      }]
    });
    if(!data) return;
    const { error } = await CP.sb().from('properties').update({ status: data.status }).eq('id', id);
    if(error){ AdminShell.toast('Failed: '+error.message,'error'); return; }
    AdminShell.toast('Status updated to '+data.status,'success');
    await load();
  });

  document.addEventListener('cp:realtime', () => load().catch(()=>{}));
  document.addEventListener('DOMContentLoaded', async () => {
    try { await waitReady(8000); }
    catch(e){
      document.getElementById('list-list').innerHTML =
        '<div class="empty"><h3>Could not load admin tools</h3><p>'+e.message+'</p></div>';
      return;
    }
    const ok = await AdminShell.requireAdmin();
    if(!ok) return;

    document.getElementById('chips').addEventListener('click', e => {
      const c = e.target.closest('.chip');
      if(!c) return;
      document.querySelectorAll('#chips .chip').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      _status = c.dataset.status || '';
      applyFilter();
    });
    document.getElementById('search').addEventListener('input', e => {
      _q = e.target.value.toLowerCase();
      clearTimeout(_debounce); _debounce = setTimeout(applyFilter, 200);
    });

    AdminShell.on('refresh', () => load());
    load();
  });
})();
