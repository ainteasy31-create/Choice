// ─────────────────────────────────────────────────────────────────────
// admin/inspections.js — Phase 08 chunk 4/N + closeout
// Admin index of all condition reports across all applications. Filters
// by inspection type, by signature state, and free-text on tenant name
// / property address / app_id. Click a row → opens the unified
// landlord/inspection-review page (which auto-detects admin role from
// auth and uses the same record-inspection edge fn for any updates).
//
// Closeout (Phase 8 acceptance criterion): in the 9 states that legally
// require a move-in checklist before any deposit can be deducted
// (CA, GA, KY, MD, MA, NH, NJ, VA, WA), surface a warning banner for
// every fully-executed lease whose tenant has been in the unit for >7
// days without a recorded move_in inspection.
// ─────────────────────────────────────────────────────────────────────

(function(){
  'use strict';

  // States that mandate a move-in condition report as a precondition
  // for withholding any portion of the security deposit at move-out.
  const REQUIRED_MOVE_IN_STATES = ['CA','GA','KY','MD','MA','NH','NJ','VA','WA'];
  const REQUIRED_STATE_NAMES = {
    CA: 'California',     GA: 'Georgia',     KY: 'Kentucky',
    MD: 'Maryland',       MA: 'Massachusetts', NH: 'New Hampshire',
    NJ: 'New Jersey',     VA: 'Virginia',    WA: 'Washington',
  };
  const WARN_GRACE_DAYS = 7;

  let _all       = [];
  let _warnings  = [];
  let _typeFilter   = 'all';
  let _statusFilter = 'all';
  let _search       = '';

  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);}
  function fmtDate(d){if(!d)return '—';try{return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});}catch{return d;}}
  function labelType(t){return t==='move_in'?'Move-in':t==='move_out'?'Move-out':t==='mid_term'?'Mid-term':t;}
  function statusOf(insp){
    if (insp.tenant_signed_at && insp.landlord_signed_at) return 'complete';
    if (insp.tenant_signed_at && !insp.landlord_signed_at) return 'awaiting_landlord';
    if (!insp.tenant_signed_at && insp.landlord_signed_at) return 'awaiting_tenant';
    return 'awaiting_tenant';
  }
  function statusPill(s){
    if (s === 'complete')          return '<span class="pill pill-ok">Both signed</span>';
    if (s === 'awaiting_landlord') return '<span class="pill pill-warn">Awaiting landlord</span>';
    if (s === 'awaiting_tenant')   return '<span class="pill pill-warn">Awaiting tenant</span>';
    return '<span class="pill pill-muted">' + esc(s) + '</span>';
  }

  function card(row){
    const a = row.applications || {};
    const tenantName = ((a.first_name||'') + ' ' + (a.last_name||'')).trim() || 'Unknown';
    const reviewLink = `/landlord/inspection-review.html?id=${encodeURIComponent(row.id)}`;
    const status = statusOf(row);
    return ''
      + '<div class="insp-card">'
      +   '<div class="row-flex between" style="align-items:flex-start">'
      +     '<div style="min-width:0">'
      +       '<div class="text-xs muted" style="font-family:monospace">' + esc(a.app_id || row.app_id) + '</div>'
      +       '<div class="row-title">' + esc(tenantName) + ' — ' + esc(labelType(row.inspection_type)) + '</div>'
      +       '<div class="row-sub">' + esc(a.property_address || '—') + '</div>'
      +       '<div style="margin-top:6px">'
      +         '<span class="pill pill-info">' + esc(labelType(row.inspection_type)) + '</span>'
      +         statusPill(status)
      +         (row.photos_count ? '<span class="pill pill-muted">' + row.photos_count + ' photo' + (row.photos_count===1?'':'s') + '</span>' : '')
      +       '</div>'
      +     '</div>'
      +     '<div class="row-meta" style="text-align:right">'
      +       'Updated <strong>' + esc(fmtDate(row.updated_at || row.created_at)) + '</strong>'
      +       (row.tenant_signed_at  ? '<br>Tenant: <strong style="color:var(--success)">' + esc(fmtDate(row.tenant_signed_at)) + '</strong>' : '')
      +       (row.landlord_signed_at ? '<br>Landlord: <strong style="color:var(--success)">' + esc(fmtDate(row.landlord_signed_at)) + '</strong>' : '')
      +     '</div>'
      +   '</div>'
      +   '<div class="insp-meta">'
      +     '<div><div class="k">Created</div><div class="v">' + esc(fmtDate(row.created_at)) + '</div></div>'
      +     '<div><div class="k">Status</div><div class="v">' + statusPill(status) + '</div></div>'
      +     '<div><div class="k">Type</div><div class="v">' + esc(labelType(row.inspection_type)) + '</div></div>'
      +     '<div><div class="k">Photos</div><div class="v">' + (row.photos_count ?? 0) + '</div></div>'
      +   '</div>'
      +   '<div class="row-flex between" style="align-items:center;gap:8px;flex-wrap:wrap">'
      +     '<a class="btn btn-primary btn-sm" href="' + reviewLink + '">Open review →</a>'
      +     '<a class="btn btn-ghost btn-sm" href="/admin/applications.html?id=' + encodeURIComponent(row.app_id) + '">View application</a>'
      +   '</div>'
      + '</div>';
  }

  function filtered(){
    return _all.filter(r => {
      if (_typeFilter !== 'all' && r.inspection_type !== _typeFilter) return false;
      if (_statusFilter !== 'all' && statusOf(r) !== _statusFilter) return false;
      if (_search) {
        const a = r.applications || {};
        const hay = [
          a.first_name || '', a.last_name || '', a.email || '',
          a.property_address || '', a.app_id || '', r.app_id, r.id,
        ].join(' ').toLowerCase();
        if (!hay.includes(_search.toLowerCase())) return false;
      }
      return true;
    });
  }

  function renderSummary(){
    const total = _all.length;
    const moveIn = _all.filter(r => r.inspection_type === 'move_in').length;
    const awaitingLord = _all.filter(r => statusOf(r) === 'awaiting_landlord').length;
    const complete = _all.filter(r => statusOf(r) === 'complete').length;
    document.getElementById('summary').innerHTML = ''
      + tile(total, 'Total reports')
      + tile(moveIn, 'Move-in reports')
      + tile(awaitingLord, 'Need your sign-off')
      + tile(complete, 'Fully signed');
  }
  function tile(n, lbl){
    return '<div class="summary-tile"><div class="num">' + n + '</div><div class="lbl">' + esc(lbl) + '</div></div>';
  }

  // ── 7-day warning banner (Phase 8 acceptance criterion) ─────────────
  function renderWarnings(){
    const host = document.getElementById('warnings');
    if (!host) return;
    if (!_warnings.length) { host.innerHTML = ''; return; }
    const items = _warnings.map(w => {
      const tName = ((w.first_name||'') + ' ' + (w.last_name||'')).trim() || 'Unknown tenant';
      const stateName = REQUIRED_STATE_NAMES[w.lease_state_code] || w.lease_state_code;
      const inspectLink = '/landlord/inspection-review.html?app=' + encodeURIComponent(w.app_id) + '&type=move_in';
      const appLink = '/admin/applications.html?id=' + encodeURIComponent(w.app_id);
      return ''
        + '<li class="warn-item">'
        +   '<div class="warn-item-main">'
        +     '<div class="warn-item-name">' + esc(tName) + ' · <span class="warn-item-state">' + esc(stateName) + '</span></div>'
        +     '<div class="warn-item-addr">' + esc(w.property_address || '—') + '</div>'
        +     '<div class="warn-item-meta">Moved in <strong>' + esc(fmtDate(w.move_in_date_actual)) + '</strong>'
        +       ' · <strong>' + w.daysOverdue + ' day' + (w.daysOverdue===1?'':'s') + '</strong> past 7-day grace</div>'
        +   '</div>'
        +   '<div class="warn-item-acts">'
        +     '<a class="btn btn-sm btn-primary" href="' + inspectLink + '">Start move-in inspection →</a>'
        +     '<a class="btn btn-sm btn-ghost" href="' + appLink + '">View application</a>'
        +   '</div>'
        + '</li>';
    }).join('');
    host.innerHTML = ''
      + '<div class="warn-banner">'
      +   '<div class="warn-banner-head">'
      +     '<span class="warn-icon" aria-hidden="true">!</span>'
      +     '<div>'
      +       '<div class="warn-title">Move-in checklist required for ' + _warnings.length + ' lease' + (_warnings.length===1?'':'s') + '</div>'
      +       '<div class="warn-sub">These states require a documented move-in condition report before any portion of the security deposit can be withheld at move-out.</div>'
      +     '</div>'
      +   '</div>'
      +   '<ul class="warn-list">' + items + '</ul>'
      + '</div>';
  }

  function render(){
    renderWarnings();
    renderSummary();
    const list = filtered();
    const host = document.getElementById('list');
    document.getElementById('empty').style.display = list.length ? 'none' : '';
    host.innerHTML = list.map(card).join('');
    document.body.setAttribute('data-page-sub', _all.length + ' total · showing ' + list.length);
  }

  async function loadWarnings(sb){
    // Find executed leases in required states whose move-in date is >7d ago
    // and which have NO move_in inspection on file.
    const cutoff = new Date(Date.now() - WARN_GRACE_DAYS * 86400000).toISOString().slice(0, 10);
    const { data: needsReport, error: appErr } = await sb.from('applications')
      .select('id, app_id, first_name, last_name, property_address, lease_state_code, move_in_date_actual')
      .eq('lease_status', 'co_signed')
      .in('lease_state_code', REQUIRED_MOVE_IN_STATES)
      .not('move_in_date_actual', 'is', null)
      .lte('move_in_date_actual', cutoff);
    if (appErr) { console.warn('warning query failed:', appErr.message); _warnings = []; return; }
    if (!needsReport || !needsReport.length) { _warnings = []; return; }
    const appIds = needsReport.map(a => a.id);
    const { data: existing, error: existingErr } = await sb.from('lease_inspections')
      .select('app_id').eq('inspection_type', 'move_in').in('app_id', appIds);
    if (existingErr) { console.warn('lease_inspections query failed:', existingErr.message); _warnings = []; return; }
    const haveMoveIn = new Set((existing || []).map(x => x.app_id));
    const today = Date.now();
    _warnings = needsReport
      .filter(a => !haveMoveIn.has(a.id))
      .map(a => ({
        ...a,
        daysOverdue: Math.max(0, Math.floor((today - new Date(a.move_in_date_actual).getTime()) / 86400000) - WARN_GRACE_DAYS),
      }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue);
  }

  async function load(){
    try {
      const sb = (window.CP && CP.sb) ? CP.sb() : null;
      if (!sb) throw new Error('Supabase not initialised');
      // RLS: admin row in admin_roles required; the policies on lease_inspections
      // already allow admins to read everything.
      const [inspectionsRes] = await Promise.all([
        sb.from('lease_inspections')
          .select(`
            id, app_id, inspection_type, photos_count, completed_at,
            tenant_signed_at, landlord_signed_at,
            created_at, updated_at,
            applications:app_id ( app_id, first_name, last_name, email, property_address )
          `)
          .order('updated_at', { ascending: false })
          .limit(500),
        loadWarnings(sb),
      ]);
      if (inspectionsRes.error) throw inspectionsRes.error;
      _all = inspectionsRes.data || [];
      document.getElementById('loading').style.display = 'none';
      render();
    } catch (e) {
      console.error(e);
      document.getElementById('loading').innerHTML =
        '<div style="color:#fca5a5">Failed to load inspections: ' + esc((e && e.message) || 'unknown error') + '</div>';
    }
  }

  function wire(){
    document.querySelectorAll('#chips .chip').forEach(c => c.addEventListener('click', () => {
      document.querySelectorAll('#chips .chip').forEach(x => x.classList.toggle('active', x === c));
      _typeFilter = c.dataset.type; render();
    }));
    document.querySelectorAll('#chips2 .chip').forEach(c => c.addEventListener('click', () => {
      document.querySelectorAll('#chips2 .chip').forEach(x => x.classList.toggle('active', x === c));
      _statusFilter = c.dataset.status; render();
    }));
    let t;
    document.getElementById('q').addEventListener('input', e => {
      clearTimeout(t);
      t = setTimeout(() => { _search = (e.target.value || '').trim(); render(); }, 150);
    });
  }

  // Wait for AdminShell + CP, enforce admin role, then load
  function ready(){
    if (!window.AdminShell || !window.CP || !CP.sb) { setTimeout(ready, 80); return; }
    AdminShell.requireAdmin().then(ok => {
      if (!ok) return;
      wire();
      load();
    });
  }
  document.addEventListener('DOMContentLoaded', ready);
})();
