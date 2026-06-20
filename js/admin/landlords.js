(function(){
  'use strict';

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

  const S = () => window.AdminShell;
  let _data = [];
  let _search = '';
  let _debounce = null;

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function esc(s){ return S().esc ? S().esc(s) : String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmt(d){ if(!d) return '—'; try{ return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }catch{ return d; } }
  function fmtRel(d){ return S().fmtRelative ? S().fmtRelative(d) : fmt(d); }

  function avatarColor(seed){
    if(S().avatarColor) return S().avatarColor(seed);
    const hue = Array.from(String(seed||'')).reduce((h,c)=>h+c.charCodeAt(0),0) % 360;
    return `hsl(${hue},55%,45%)`;
  }

  // ── Row renderer ─────────────────────────────────────────────────────────────
  function row(l){
    const name     = l.contact_name || l.business_name || l.email || '—';
    const initials = name.trim().charAt(0).toUpperCase();
    const verPill  = l.verified
      ? '<span class="pill pill-success" style="font-size:.65rem">Verified</span>'
      : '<span class="pill pill-muted"   style="font-size:.65rem">Unverified</span>';
    const sub = [
      l.business_name && l.contact_name ? esc(l.business_name) : null,
      l.email   ? esc(l.email)   : null,
      l.phone   ? esc(l.phone)   : null,
      l.state   ? esc(l.state)   : null,
    ].filter(Boolean).join(' · ');

    return ''
      + '<div class="list-row" data-id="'+esc(l.id)+'" data-verified="'+(l.verified?'1':'0')+'" style="cursor:pointer">'
      +   '<div class="list-row-inner">'
      +     '<div class="row-avatar" style="background:'+avatarColor(l.email||name)+'">'+esc(initials)+'</div>'
      +     '<div class="row-body">'
      +       '<div class="row-title">'+esc(name)+' '+verPill+'</div>'
      +       '<div class="row-sub" style="word-break:break-all">'+sub+'</div>'
      +     '</div>'
      +     '<div class="row-meta">'+fmtRel(l.created_at)+'</div>'
      +   '</div>'
      + '</div>';
  }

  // ── Filter (client-side) ─────────────────────────────────────────────────────
  function filtered(){
    if(!_search.trim()) return _data;
    const q = _search.trim().toLowerCase();
    return _data.filter(l =>
      (l.contact_name   || '').toLowerCase().includes(q) ||
      (l.business_name  || '').toLowerCase().includes(q) ||
      (l.email          || '').toLowerCase().includes(q) ||
      (l.phone          || '').toLowerCase().includes(q) ||
      (l.state          || '').toLowerCase().includes(q)
    );
  }

  function renderList(){
    const list = document.getElementById('lord-list');
    const cnt  = document.getElementById('count-label');
    const rows = filtered();
    cnt.textContent = rows.length + ' of ' + _data.length + ' account' + (_data.length===1?'':'s');
    if(!rows.length){
      list.innerHTML = '<div class="empty"><h3>'+ (_search ? 'No matches for "'+esc(_search)+'"' : 'No landlord accounts yet') +'</h3></div>';
      return;
    }
    list.innerHTML = '<div class="list">' + rows.map(row).join('') + '</div>';
  }

  // ── Load via admin RPC ────────────────────────────────────────────────────────
  async function load(){
    const list = document.getElementById('lord-list');
    const sub  = document.getElementById('page-sub');
    const cnt  = document.getElementById('count-label');
    sub.textContent  = 'Loading…';
    cnt.textContent  = '';
    list.innerHTML   = '<div class="list">'
      + '<div class="list-row"><div class="list-row-inner"><div class="skeleton sk-circle"></div><div style="flex:1"><div class="skeleton sk-line lg" style="width:55%"></div><div class="skeleton sk-line sm" style="width:35%"></div></div></div></div>'.repeat(4)
      + '</div>';

    // admin_list_landlords is SECURITY DEFINER — returns phone+email for admins
    const { data, error } = await CP.sb().rpc('admin_list_landlords', { p_page: 0, p_per_page: 500 });

    if(error){
      list.innerHTML = '<div class="empty"><h3>Failed to load landlords</h3><p>'+esc(error.message)+'</p></div>';
      sub.textContent = 'Error';
      return;
    }

    _data = (data && data.rows) ? data.rows : (Array.isArray(data) ? data : []);
    sub.textContent = _data.length + ' total';
    renderList();
  }

  // ── Detail slide-out ──────────────────────────────────────────────────────────
  async function openDetail(landlordId){
    const l = _data.find(x => x.id === landlordId);
    if(!l) return;

    const existing = document.getElementById('lord-detail-panel');
    if(existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'lord-detail-panel';
    panel.className = 'pd-edit-panel';
    panel.innerHTML = `
      <div class="pd-edit-overlay" id="lord-det-overlay"></div>
      <div class="pd-edit-drawer" style="max-width:520px">
        <div class="pd-edit-header">
          <h3>${esc(l.contact_name || l.business_name || 'Landlord')}</h3>
          <button class="pd-edit-close" id="lord-det-close" aria-label="Close">✕</button>
        </div>
        <div class="pd-edit-body">

          <div class="pd-edit-group">
            <div class="pd-edit-group-title">Contact</div>
            <div class="pd-detail-rows">
              <div class="pd-detail-row"><span>Contact name</span><span>${esc(l.contact_name||'—')}</span></div>
              <div class="pd-detail-row"><span>Business name</span><span>${esc(l.business_name||'—')}</span></div>
              <div class="pd-detail-row"><span>Email</span><span><a href="mailto:${esc(l.email||'')}">${esc(l.email||'—')}</a></span></div>
              <div class="pd-detail-row"><span>Phone</span><span><a href="tel:${esc(l.phone||'')}">${esc(l.phone||'—')}</a></span></div>
              <div class="pd-detail-row"><span>State</span><span>${esc(l.state||'—')}</span></div>
              <div class="pd-detail-row"><span>Tagline</span><span>${esc(l.tagline||'—')}</span></div>
              <div class="pd-detail-row"><span>Verified</span><span>${l.verified?'<span class="pill pill-success">Yes</span>':'<span class="pill pill-muted">No</span>'}</span></div>
              <div class="pd-detail-row"><span>Joined</span><span>${fmt(l.created_at)}</span></div>
            </div>
          </div>

          <div class="pd-edit-group">
            <div class="pd-edit-group-title">Actions</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;padding:4px 0 8px">
              <button class="btn btn-ghost btn-sm" id="lord-det-toggle-verify">
                ${l.verified ? '<i class="fas fa-times-circle"></i> Unverify' : '<i class="fas fa-check-circle"></i> Verify'}
              </button>
              <a class="btn btn-ghost btn-sm" href="/listings.html?landlord=${esc(l.id)}">
                <i class="fas fa-building"></i> View properties
              </a>
            </div>
          </div>

          <div class="pd-edit-group">
            <div class="pd-edit-group-title">Properties <span id="lord-det-prop-count" class="text-xs muted"></span></div>
            <div id="lord-det-props"><div class="pd-empty-row">Loading…</div></div>
          </div>

        </div>
        <div class="pd-edit-footer">
          <button class="btn btn-ghost" id="lord-det-close2">Close</button>
        </div>
      </div>`;

    document.body.appendChild(panel);
    requestAnimationFrame(() => panel.classList.add('open'));

    const close = () => { panel.classList.remove('open'); setTimeout(() => panel.remove(), 300); };
    document.getElementById('lord-det-close').addEventListener('click', close);
    document.getElementById('lord-det-close2').addEventListener('click', close);
    document.getElementById('lord-det-overlay').addEventListener('click', close);

    // Verify toggle
    document.getElementById('lord-det-toggle-verify').addEventListener('click', async () => {
      const newVal = !l.verified;
      const ok = await S().confirm({
        title: newVal ? 'Verify landlord?' : 'Remove verification?',
        message: newVal
          ? 'Mark this landlord as Verified. They will get a verified badge.'
          : 'This landlord will no longer appear as Verified to applicants.',
        ok: newVal ? 'Verify' : 'Unverify',
        danger: !newVal
      });
      if(!ok) return;
      const { error: verErr } = await CP.sb().from('landlords').update({ verified: newVal }).eq('id', l.id);
      if(verErr){ S().toast('Error: '+verErr.message,'error'); return; }
      l.verified = newVal;
      S().toast(newVal ? 'Landlord verified!' : 'Verification removed.', 'success');
      close();
      await load();
    });

    // Load properties for this landlord
    CP.sb()
      .from('properties')
      .select('id,title,address,status,monthly_rent')
      .eq('landlord_id', landlordId)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data: props, error: propErr }) => {
        const el = document.getElementById('lord-det-props');
        const countEl = document.getElementById('lord-det-prop-count');
        if(!el) return;
        if(propErr){ el.innerHTML = '<div class="pd-empty-row">Could not load properties.</div>'; return; }
        const list = props || [];
        countEl.textContent = '(' + list.length + ')';
        if(!list.length){ el.innerHTML = '<div class="pd-empty-row">No properties assigned.</div>'; return; }
        const pillMap = { active:'pill-success', rented:'pill-info', inactive:'pill-muted', maintenance:'pill-warning', draft:'pill-muted', paused:'pill-warning', archived:'pill-muted' };
        el.innerHTML = '<div class="list" style="margin:0">'
          + list.map(p => ''
            + '<div class="list-row" style="padding:10px 0">'
            +   '<div class="list-row-inner">'
            +     '<div class="row-body">'
            +       '<div class="row-title" style="font-size:.88rem"><a href="/property.html?id='+esc(p.id)+'" style="color:inherit;text-decoration:none">'+esc(p.title||'Untitled')+'</a></div>'
            +       '<div class="row-sub">'+esc(p.address||'—')+'</div>'
            +     '</div>'
            +     '<div class="row-meta" style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">'
            +       '<span class="pill '+( pillMap[p.status]||'pill-muted' )+'">'+esc(p.status||'—')+'</span>'
            +       (p.monthly_rent ? '<span class="text-xs muted">$'+Number(p.monthly_rent).toLocaleString('en-US')+'</span>' : '')
            +     '</div>'
            +   '</div>'
            + '</div>'
          ).join('')
          + '</div>';
      }).catch(() => {
        const el = document.getElementById('lord-det-props');
        if(el) el.innerHTML = '<div class="pd-empty-row">Could not load properties.</div>';
      });
  }

  // ── Event delegation ─────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    try { await waitReady(8000); } catch(e){
      document.getElementById('lord-list').innerHTML =
        '<div class="empty"><h3>Could not load admin tools</h3><p>'+esc(e.message)+'</p></div>';
      return;
    }

    const ok = await S().requireAdmin();
    if(!ok) return;

    // Search input
    const searchEl = document.getElementById('lord-search');
    if(searchEl){
      searchEl.addEventListener('input', e => {
        _search = e.target.value;
        clearTimeout(_debounce);
        _debounce = setTimeout(renderList, 200);
      });
    }

    // Row clicks → detail panel
    document.getElementById('lord-list').addEventListener('click', e => {
      const rowEl = e.target.closest('.list-row[data-id]');
      if(!rowEl) return;
      openDetail(rowEl.dataset.id);
    });

    S().on && S().on('refresh', () => load());
    document.addEventListener('cp:realtime', () => load().catch(()=>{}));

    // Deep-link: ?id= auto-opens the landlord detail slide-out
    const _deepId = new URLSearchParams(location.search).get('id');
    load().then(() => {
      if (_deepId) openDetail(_deepId);
    }).catch(err => {
      console.error('[landlords]', err);
      S().toast('Failed to load landlords', 'error');
    });
  });
})();
