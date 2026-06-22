(function(){
  'use strict';
  const PAGE_SIZE = 50;
  let currentPage = 1, totalCount = 0;
  let activeAction = '', activeAppId = '';

  const ACTION_LABELS = {
    update_status:'Update status', mark_paid:'Mark paid', mark_movein:'Mark move-in',
    generate_lease:'Generate lease', resend_lease:'Resend lease', void_lease:'Void lease',
    tenant_signed_lease:'Tenant signed', co_applicant_signed_lease:'Co-applicant signed',
    'property.create':'Property created', 'property.edit':'Property edited',
    'property.hard_delete':'Property deleted', 'property.duplicate':'Property duplicated',
    'property.photo_reorder':'Photos reordered', 'property.photo_delete':'Photo deleted',
    'property.photo_upload':'Photo uploaded',
    'property.status_change':'Status changed', 'property.geocode':'Geocode updated'
  };
  const ACTION_PILL = {
    update_status:'pill-info', mark_paid:'pill-success', mark_movein:'pill-purple',
    generate_lease:'pill-warning', resend_lease:'pill-warning', void_lease:'pill-danger',
    tenant_signed_lease:'pill-success', co_applicant_signed_lease:'pill-success',
    'property.create':'pill-success', 'property.edit':'pill-info',
    'property.hard_delete':'pill-danger', 'property.duplicate':'pill-info',
    'property.photo_reorder':'pill-muted', 'property.photo_delete':'pill-warning',
    'property.photo_upload':'pill-muted',
    'property.status_change':'pill-info', 'property.geocode':'pill-muted'
  };

  // Route target links based on target_type and ID format
  function targetLink(r){
    const S = AdminShell;
    if(!r.target_id) return '<span class="muted">'+S.esc(r.target_type||'—')+'</span>';
    const id = r.target_id;
    const type = r.target_type || '';
    if(type === 'property'){
      return '<a href="/property.html?id='+S.esc(id)+'" style="font-family:monospace">'+S.esc(id.slice(0,8))+'… ↗</a>';
    }
    // APP-XXXX format → link to applications page (works as deep-link anchor)
    if(type === 'application' || /^APP-/i.test(id)){
      return '<a href="applications.html?id='+S.esc(id)+'" style="font-family:monospace">'+S.esc(id)+'</a>';
    }
    // Raw UUID for other target types — show truncated, no broken link
    return '<span class="muted text-xs" style="font-family:monospace" title="'+S.esc(type)+': '+S.esc(id)+'">'+S.esc(id.slice(0,8))+'…</span>';
  }

  function row(r){
    const S = AdminShell;
    const label = ACTION_LABELS[r.action] || r.action;
    const cls = ACTION_PILL[r.action] || 'pill-muted';
    const target = targetLink(r);
    const meta = (r.metadata && typeof r.metadata === 'object')
      ? Object.entries(r.metadata).filter(([,v]) => v!=null && v!=='')
          .map(([k,v]) => '<span class="meta-pill">'+S.esc(k)+': '+S.esc(String(v).slice(0,40))+'</span>').join('')
      : '';
    const actor = r.user_id
      ? '<span class="muted text-xs" title="User ID: '+S.esc(r.user_id)+'">'+S.esc(r.user_id.slice(0,8))+'…</span>'
      : '<span class="muted text-xs" style="font-style:italic">System / Tenant</span>';
    return ''
      + '<div class="audit-row">'
      +   '<div class="arow-head">'
      +     '<span class="pill '+cls+'">'+S.esc(label)+'</span>'
      +     '<span class="row-meta" title="'+S.esc(r.created_at)+'">'+S.fmtRelative(r.created_at)+'</span>'
      +   '</div>'
      +   '<div class="row-sub">'+target+' · '+actor+'</div>'
      +   (meta ? '<div class="arow-meta">'+meta+'</div>' : '')
      + '</div>';
  }

  async function loadPage(page){
    currentPage = Math.max(1, page);
    document.getElementById('audit-list').innerHTML = AdminShell.skeletonRows(5, { avatar:false });
    const from = (currentPage-1)*PAGE_SIZE, to = from+PAGE_SIZE-1;
    let q = CP.sb().from('admin_actions').select('*',{count:'exact'}).order('created_at',{ascending:false}).range(from,to);
    if(activeAction) q = q.eq('action', activeAction);
    if(activeAppId)  q = q.eq('target_id', activeAppId);
    const { data, count, error } = await q;
    if(error){
      document.getElementById('audit-list').innerHTML =
        '<div class="empty"><svg class="i"><use href="#i-alert"/></svg><h3>Failed to load</h3><p>'+AdminShell.esc(error.message)+'</p></div>';
      return;
    }
    totalCount = count || 0;
    const rows = data || [];
    if(!rows.length){
      document.getElementById('audit-list').innerHTML =
        '<div class="empty"><svg class="i"><use href="#i-history"/></svg><h3>No entries</h3><p>Admin actions will appear here.</p></div>';
    } else {
      document.getElementById('audit-list').innerHTML = rows.map(row).join('');
    }
    const totalPages = Math.max(1, Math.ceil(totalCount/PAGE_SIZE));
    document.getElementById('page-info').textContent = totalCount ? ('Page '+currentPage+' of '+totalPages) : '—';
    document.getElementById('btn-prev').disabled = currentPage <= 1;
    document.getElementById('btn-next').disabled = currentPage >= totalPages;
    document.getElementById('result-count').textContent = totalCount.toLocaleString()+' entr'+(totalCount===1?'y':'ies');
    document.getElementById('page-sub').textContent = totalCount.toLocaleString()+' total';
  }

  function applyFilters(){
    activeAction = document.getElementById('f-action').value;
    activeAppId  = document.getElementById('f-app').value.trim();
    loadPage(1);
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

  document.addEventListener('DOMContentLoaded', async () => {
    try { await waitReady(8000); }
    catch(e){
      document.getElementById('audit-list').innerHTML =
        '<div class="empty"><h3>Could not load admin tools</h3><p>'+e.message+'</p></div>';
      return;
    }
    const ok = await AdminShell.requireAdmin();
    if(!ok) return;

    let deb = null;
    document.getElementById('f-action').addEventListener('change', applyFilters);
    document.getElementById('f-app').addEventListener('input', () => {
      clearTimeout(deb); deb = setTimeout(applyFilters, 250);
    });
    document.getElementById('btn-prev').addEventListener('click', () => loadPage(currentPage-1));
    document.getElementById('btn-next').addEventListener('click', () => loadPage(currentPage+1));

    AdminShell.on('refresh', () => loadPage(currentPage));

    // CSV export — exports the current visible page of audit rows
    AdminShell.on('export-csv', async () => {
      const S = AdminShell;
      const from = (currentPage-1)*PAGE_SIZE, to = from+PAGE_SIZE-1;
      let q = CP.sb().from('admin_actions').select('*').order('created_at',{ascending:false}).range(from,to);
      if(activeAction) q = q.eq('action', activeAction);
      if(activeAppId)  q = q.eq('target_id', activeAppId);
      const { data } = await q;
      if(!data || !data.length){ S.toast('No rows to export','error'); return; }
      const cols = ['action','target_type','target_id','user_id','created_at'];
      const header = cols.join(',');
      const csvRows = data.map(r =>
        cols.map(c => {
          let v = r[c];
          if(c === 'created_at' && v) v = new Date(v).toISOString();
          if(c === 'action') v = ACTION_LABELS[v] || v;
          return v == null ? '' : '"' + String(v).replace(/"/g,'""') + '"';
        }).join(',')
      );
      const csv = [header, ...csvRows].join('\n');
      const blob = new Blob([csv], { type:'text/csv' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = 'audit-log-p'+currentPage+'.csv'; a.click();
      URL.revokeObjectURL(url);
      S.toast('CSV exported','success');
    });

    loadPage(1);
  });
})();
