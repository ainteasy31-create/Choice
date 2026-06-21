/* =====================================================================
   Choice Properties — cp-shell.js  (Phase 2 rename of admin-shell.js)
   Shared mobile shell for the Operations Console design system.
   Used by admin, landlord, and tenant portals.

   Provides: bottom nav highlighting, swipe-to-act,
   bottom sheet, toast, skeletons, realtime live indicator, CSP-safe
   data-action delegation, and helpers.

   Exposes BOTH `window.CPShell` and `window.AdminShell` (alias) so
   pages migrated in Phase 1 keep working unchanged.
   No external deps. Loads after supabase + cp-api.
   ===================================================================== */
(function(window, document){
  'use strict';

  const Shell = {};
  const $  = (s, r) => (r||document).querySelector(s);
  const $$ = (s, r) => Array.from((r||document).querySelectorAll(s));

  // ───────────────────────── Format helpers ─────────────────────────
  Shell.esc = function(s){
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  };
  Shell.fmtDate = function(d){
    if(!d) return '—';
    try { return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
    catch { return d; }
  };
  Shell.fmtTime = function(d){
    if(!d) return '';
    try { return new Date(d).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
    catch { return ''; }
  };
  Shell.fmtRelative = function(d){
    if(!d) return '—';
    const t = new Date(d).getTime();
    if(isNaN(t)) return '—';
    const diff = (Date.now() - t) / 1000;
    if(diff < 60) return 'just now';
    if(diff < 3600) return Math.floor(diff/60) + 'm ago';
    if(diff < 86400) return Math.floor(diff/3600) + 'h ago';
    if(diff < 604800) return Math.floor(diff/86400) + 'd ago';
    if(diff < 2592000) return Math.floor(diff/604800) + 'w ago';
    return Shell.fmtDate(d);
  };
  Shell.initials = function(first, last){
    const f = (first||'').trim().charAt(0).toUpperCase();
    const l = (last ||'').trim().charAt(0).toUpperCase();
    return (f + l) || '?';
  };
  Shell.avatarColor = function(seed){
    const palettes = [
      'linear-gradient(135deg,#006aff,#a855f7)',
      'linear-gradient(135deg,#22c55e,#3b82f6)',
      'linear-gradient(135deg,#f59e0b,#ef4444)',
      'linear-gradient(135deg,#a855f7,#ec4899)',
      'linear-gradient(135deg,#06b6d4,#3b82f6)',
      'linear-gradient(135deg,#d4a017,#a855f7)'
    ];
    let h = 0;
    for(const c of String(seed||'')) h = (h*31 + c.charCodeAt(0)) >>> 0;
    return palettes[h % palettes.length];
  };
  Shell.statusPill = function(status){
    const s = (status||'pending').toLowerCase();
    const map = {
      pending:    { cls:'pill-warning', label:'Pending'   },
      under_review:{cls:'pill-info',    label:'In Review' },
      approved:   { cls:'pill-success', label:'Approved'  },
      denied:     { cls:'pill-danger',  label:'Denied'    },
      waitlisted: { cls:'pill-purple',  label:'Waitlisted'},
      withdrawn:  { cls:'pill-muted',   label:'Withdrawn' },
      paid:       { cls:'pill-success', label:'Paid'      },
      unpaid:     { cls:'pill-danger',  label:'Unpaid'    },
      waived:     { cls:'pill-warning', label:'Waived'    },
      sent:       { cls:'pill-info',    label:'Sent'      },
      signed:     { cls:'pill-success', label:'Signed'    },
      confirmed:  { cls:'pill-success', label:'Confirmed' }
    };
    const m = map[s] || { cls:'pill-muted', label: s };
    return '<span class="pill '+m.cls+'">'+Shell.esc(m.label)+'</span>';
  };

  // ───────────────────────── Toast ─────────────────────────
  function ensureToastStack(){
    let stack = $('.toast-stack');
    if(!stack){ stack = document.createElement('div'); stack.className='toast-stack'; document.body.appendChild(stack); }
    return stack;
  }
  Shell.toast = function(msg, type, ttl){
    const stack = ensureToastStack();
    const el = document.createElement('div');
    el.className = 'toast ' + (type||'');
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(-8px)'; el.style.transition='opacity .25s, transform .25s'; setTimeout(()=>el.remove(), 260); }, ttl || 3000);
  };

  // ───────────────────────── Bottom sheet ─────────────────────────
  Shell.openSheet = function(opts){
    opts = opts || {};
    let backdrop = $('.sheet-backdrop'), sheet = $('.sheet');
    if(!backdrop){ backdrop = document.createElement('div'); backdrop.className='sheet-backdrop'; document.body.appendChild(backdrop); }
    if(!sheet){
      sheet = document.createElement('div'); sheet.className='sheet';
      sheet.innerHTML = '<div class="sheet-handle"></div><div class="sheet-header"><div class="sheet-title"></div><button class="btn-icon" data-shell-close-sheet aria-label="Close"><svg class="i" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div><div class="sheet-body"></div>';
      document.body.appendChild(sheet);
    }
    sheet.querySelector('.sheet-title').textContent = opts.title || '';
    sheet.querySelector('.sheet-body').innerHTML = opts.body || '';
    requestAnimationFrame(() => { backdrop.classList.add('open'); sheet.classList.add('open'); });
    backdrop.onclick = Shell.closeSheet;
  };
  Shell.closeSheet = function(){
    const backdrop = $('.sheet-backdrop'), sheet = $('.sheet');
    if(backdrop) backdrop.classList.remove('open');
    if(sheet)    sheet.classList.remove('open');
  };

  // ───────────────────────── Swipe to act ─────────────────────────
  function initSwipeRows(){
    let active = null, startX = 0, dx = 0;
    document.addEventListener('touchstart', (e) => {
      const inner = e.target.closest('.list-row-inner');
      if(!inner) return;
      const row = inner.closest('.list-row');
      if(!row || !row.querySelector('.swipe-actions')) return;
      active = inner; startX = e.touches[0].clientX; dx = 0;
      inner.style.transition = 'none';
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if(!active) return;
      dx = e.touches[0].clientX - startX;
      const row = active.closest('.list-row');
      const hasLeft  = !!row.querySelector('.swipe-actions.left');
      const hasRight = !!row.querySelector('.swipe-actions.right');
      if(dx > 0 && !hasLeft)  dx = 0;
      if(dx < 0 && !hasRight) dx = 0;
      dx = Math.max(-160, Math.min(160, dx));
      active.style.transform = 'translateX('+dx+'px)';
    }, { passive: true });
    document.addEventListener('touchend', () => {
      if(!active) return;
      const row = active.closest('.list-row');
      active.style.transition = 'transform .25s';
      if(Math.abs(dx) > 80){
        const target = dx > 0 ? 100 : -100;
        active.style.transform = 'translateX('+target+'px)';
      } else {
        active.style.transform = 'translateX(0)';
      }
      active = null;
    }, { passive: true });
    // Tap outside any open swipe row to reset
    document.addEventListener('click', (e) => {
      if(e.target.closest('.swipe-btn')) return;
      $$('.list-row-inner').forEach(el => { el.style.transition = 'transform .2s'; el.style.transform = 'translateX(0)'; });
    });
  }

  // ───────────────────────── CSP-safe data-action delegation ─────────────────────────
  const handlers = {};
  Shell.on = function(name, fn){ handlers[name] = fn; };
  function initActions(){
    document.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if(!target) return;
      const action = target.getAttribute('data-action');
      // Built-in actions
      if(action === 'sign-out'){
        if(window.CP && CP.Auth && CP.Auth.signOut) CP.Auth.signOut();
        else if(window.CP && CP.sb) CP.sb().auth.signOut().then(() => location.href = 'login.html');
        else location.href = 'login.html';
        return;
      }
      if(action === 'close-sheet'){ Shell.closeSheet(); return; }
      if(action === 'go-back'){ history.length > 1 ? history.back() : (location.href = 'dashboard.html'); return; }
      // User-registered actions
      if(handlers[action]){ e.preventDefault(); handlers[action](target, e); }
    });
    // Built-in close-sheet via data-shell-close-sheet attribute
    document.addEventListener('click', (e) => {
      if(e.target.closest('[data-shell-close-sheet]')) Shell.closeSheet();
    });
  }

  // ───────────────────────── Realtime live indicator ─────────────────────────
  // Coalesce bursts of postgres_changes events into a single cp:realtime
  // dispatch per 400ms window to avoid hammering page-level load() handlers.
  let _rtTimer = null;
  let _rtPending = new Set();
  function _emitRealtime(table){
    _rtPending.add(table);
    if(_rtTimer) return;
    _rtTimer = setTimeout(() => {
      const tables = Array.from(_rtPending);
      _rtPending.clear();
      _rtTimer = null;
      tables.forEach(t => {
        document.dispatchEvent(new CustomEvent('cp:realtime', { detail: { table: t } }));
      });
    }, 400);
  }
  function initLiveIndicator(){
    if(!window.CP || !CP.sb) return;
    try {
      const channel = CP.sb()
        .channel('admin-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'applications' }, () => _emitRealtime('applications'))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'leases' },       () => _emitRealtime('leases'))
        .subscribe((status) => {
          const dots = $$('.live-dot');
          if(status === 'SUBSCRIBED') dots.forEach(d => d.style.background = 'var(--success)');
          else dots.forEach(d => d.style.background = 'var(--muted-2)');
        });
      window.__cpLiveChannel = channel;
    } catch(err){ console.warn('[admin-shell] realtime init failed', err); }
  }

  // ───────────────────────── Tab bar / sidebar active state ─────────────────────────
  function initActiveNav(){
    const path = location.pathname.split('/').pop() || 'dashboard.html';
    $$('[data-nav]').forEach(el => {
      const target = el.getAttribute('data-nav');
      if(target === path || (target === 'dashboard.html' && (path === '' || path === 'index.html'))) el.classList.add('active');
    });
  }

  // ───────────────────────── Skeleton helpers ─────────────────────────
  Shell.skeletonRows = function(n, opts){
    opts = opts || {};
    let html = '';
    for(let i=0;i<n;i++){
      html += '<div class="list-row"><div class="list-row-inner">'
        + (opts.avatar !== false ? '<div class="skeleton sk-circle"></div>' : '')
        + '<div style="flex:1"><div class="skeleton sk-line lg" style="width:'+(40+Math.random()*40)+'%"></div><div class="skeleton sk-line sm" style="width:'+(30+Math.random()*30)+'%"></div></div>'
        + '</div></div>';
    }
    return html;
  };
  Shell.skeletonKpis = function(n){
    let html = '';
    for(let i=0;i<n;i++){
      html += '<div class="kpi-chip"><div class="skeleton sk-line sm" style="width:60%"></div><div class="skeleton sk-line lg" style="width:40%;margin-top:8px"></div></div>';
    }
    return html;
  };

  // ───────────────────────── Confirm dialog (sheet-based) ─────────────────────────
  Shell.confirm = function(opts){
    opts = opts || {};
    return new Promise(resolve => {
      const id = 'cf_' + Math.random().toString(36).slice(2);
      const danger = opts.danger ? 'btn-danger' : 'btn-primary';
      Shell.openSheet({
        title: opts.title || 'Confirm',
        body:
          '<p style="margin:0 0 16px;color:var(--muted);font-size:.88rem;line-height:1.5">' +
            Shell.esc(opts.message || 'Are you sure?') +
          '</p>' +
          '<div class="row-flex gap-2" style="justify-content:flex-end">' +
            '<button class="btn btn-ghost" id="'+id+'_cancel">'+Shell.esc(opts.cancel||'Cancel')+'</button>' +
            '<button class="btn '+danger+'" id="'+id+'_ok">'+Shell.esc(opts.ok||'Confirm')+'</button>' +
          '</div>'
      });
      const finish = (val) => { Shell.closeSheet(); resolve(val); };
      setTimeout(() => {
        const ok = document.getElementById(id+'_ok');
        const cancel = document.getElementById(id+'_cancel');
        if(ok) ok.onclick = () => finish(true);
        if(cancel) cancel.onclick = () => finish(false);
        const bd = $('.sheet-backdrop');
        if(bd) bd.onclick = () => finish(false);
      }, 0);
    });
  };

  // ───────────────────────── Form sheet ─────────────────────────
  // Opens a sheet with arbitrary form HTML and returns the submitted FormData
  // (or null if cancelled). Caller passes an array of {name,label,type,value,
  // required,options,placeholder,help,rows} field descriptors.
  Shell.formSheet = function(opts){
    opts = opts || {};
    return new Promise(resolve => {
      const id = 'fs_' + Math.random().toString(36).slice(2);
      const fields = (opts.fields||[]).map(f => {
        // Phase 07 — non-input field types for layout + custom widgets:
        //   type:'html'     → emits raw HTML (caller responsible for escaping).
        //                    Useful for section dividers, help blocks, or
        //                    custom widgets whose values are read separately
        //                    from the standard FormData pass.
        //   type:'section'  → shorthand for a divider with f.label as heading.
        if(f.type === 'html'){
          return '<div class="form-row form-row-html">'+(f.html||'')+'</div>';
        }
        if(f.type === 'section'){
          return '<div class="form-row form-row-section" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">'+
                 '<div class="form-label" style="font-size:.85rem;font-weight:700;color:var(--text)">'+Shell.esc(f.label||'')+'</div>'+
                 (f.help ? '<div class="form-help">'+Shell.esc(f.help)+'</div>' : '')+
                 '</div>';
        }
        const lbl = '<label class="form-label">'+Shell.esc(f.label||f.name)+(f.required?' *':'')+'</label>';
        const help = f.help ? '<div class="form-help">'+Shell.esc(f.help)+'</div>' : '';
        let input;
        const common = 'name="'+Shell.esc(f.name)+'" '+(f.required?'required':'')+
          ' placeholder="'+Shell.esc(f.placeholder||'')+'"';
        if(f.type === 'textarea'){
          input = '<textarea class="form-input" rows="'+(f.rows||3)+'" '+common+'>'+Shell.esc(f.value||'')+'</textarea>';
        } else if(f.type === 'select'){
          const opts2 = (f.options||[]).map(o =>
            '<option value="'+Shell.esc(o.value)+'"'+(String(o.value)===String(f.value||'')?' selected':'')+'>'+Shell.esc(o.label||o.value)+'</option>'
          ).join('');
          input = '<select class="form-input" '+common+'>'+opts2+'</select>';
        } else if(f.type === 'checkbox'){
          input = '<label class="form-check"><input type="checkbox" name="'+Shell.esc(f.name)+'"'+(f.value?' checked':'')+'> '+Shell.esc(f.checkLabel||f.label||'')+'</label>';
          return '<div class="form-row">'+input+(help)+'</div>';
        } else {
          input = '<input class="form-input" type="'+(f.type||'text')+'" value="'+Shell.esc(f.value==null?'':f.value)+'" '+common+'>';
        }
        return '<div class="form-row">'+lbl+input+help+'</div>';
      }).join('');
      const danger = opts.danger ? 'btn-danger' : 'btn-primary';
      Shell.openSheet({
        title: opts.title || 'Edit',
        body:
          '<form id="'+id+'_form" class="form-stack">'+fields+
          '<div class="row-flex gap-2" style="justify-content:flex-end;margin-top:8px">'+
            '<button type="button" class="btn btn-ghost" id="'+id+'_cancel">'+Shell.esc(opts.cancel||'Cancel')+'</button>'+
            '<button type="submit" class="btn '+danger+'">'+Shell.esc(opts.submit||'Save')+'</button>'+
          '</div></form>'
      });
      const finish = (val) => { Shell.closeSheet(); resolve(val); };
      setTimeout(() => {
        const form = document.getElementById(id+'_form');
        const cancel = document.getElementById(id+'_cancel');
        if(cancel) cancel.onclick = () => finish(null);
        if(form) form.onsubmit = (e) => {
          e.preventDefault();
          const data = {};
          new FormData(form).forEach((v,k) => { data[k] = v; });
          // Include unchecked checkboxes as false
          (opts.fields||[]).forEach(f => { if(f.type==='checkbox' && !(f.name in data)) data[f.name] = ''; });
          finish(data);
        };
        const bd = $('.sheet-backdrop');
        if(bd) bd.onclick = () => finish(null);
      }, 0);
    });
  };

  // ───────────────────────── List rendering helper ─────────────────────────
  // renderList(target, items, {render, empty, error, loading})
  // Mounts skeletons / empty / error / list rows into a container.
  Shell.renderList = function(target, state, opts){
    const el = (typeof target === 'string') ? $(target) : target;
    if(!el) return;
    opts = opts || {};
    if(state === 'loading'){
      el.innerHTML = Shell.skeletonRows(opts.skeleton || 5);
      return;
    }
    if(state && state.error){
      el.innerHTML = '<div class="empty"><svg class="i"><use href="#i-alert"/></svg>'+
        '<h3>'+Shell.esc(opts.errorTitle||'Could not load')+'</h3>'+
        '<p>'+Shell.esc(state.error)+'</p></div>';
      return;
    }
    const items = Array.isArray(state) ? state : (state && state.items) || [];
    if(!items.length){
      el.innerHTML = '<div class="empty">'+
        (opts.emptyIcon ? '<svg class="i"><use href="#'+opts.emptyIcon+'"/></svg>' : '')+
        '<h3>'+Shell.esc(opts.emptyTitle||'Nothing here yet')+'</h3>'+
        (opts.emptySub ? '<p>'+Shell.esc(opts.emptySub)+'</p>' : '')+
        '</div>';
      return;
    }
    el.innerHTML = '<div class="list">'+items.map(opts.render).join('')+'</div>';
  };

  // ───────────────────────── Auth boot helper ─────────────────────────
  Shell.requireAdmin = async function(){
    if(!window.CP || !CP.Auth) return false;
    try {
      const ok = await CP.Auth.requireAdmin();
      if(!ok) return false;
      const user = await CP.Auth.getUser();
      const nameEl = $('#admin-name');
      if(nameEl) nameEl.textContent = user?.email || 'Admin';
      return true;
    } catch(e){ console.error('[admin-shell] requireAdmin', e); return false; }
  };

  // ───────────────────────── Edge-function caller ─────────────────────────
  // Single, hardened wrapper for Edge Function calls from any portal page.
  // Replaces the per-page `callFn` copies that swallowed CONFIG-missing and
  // auth-expired failures silently. Returns { ok, json } — never throws.
  //
  // Failure modes that used to silently no-op now produce a visible toast +
  // (where appropriate) a redirect to the correct login page:
  //   • CONFIG missing or SUPABASE_URL blank  → toast + STAY (caller decides)
  //   • Access token missing/expired           → toast + redirect to login
  //   • Network error                          → toast, returns { ok:false }
  //   • Non-2xx response                       → toast with server error text
  Shell.callFn = async function(path, body, opts){
    opts = opts || {};
    const loginPath = opts.loginPath || (location.pathname.includes('/admin/')
      ? '/admin/login.html'
      : (location.pathname.includes('/landlord/') ? '/landlord/login.html' : '/tenant/login.html'));

    if(!window.CONFIG || !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY){
      Shell.toast('Configuration not loaded — try a hard refresh (Ctrl/Cmd+Shift+R).', 'error', 6000);
      return { ok:false, json:{ error:'CONFIG missing' } };
    }
    if(!window.CP || !CP.Auth || typeof CP.Auth.getAccessToken !== 'function'){
      Shell.toast('Auth library not loaded — refresh the page.', 'error', 6000);
      return { ok:false, json:{ error:'CP.Auth missing' } };
    }

    const token = await CP.Auth.getAccessToken();
    if(!token){
      Shell.toast('Your session has expired — sending you to the login page.', 'error', 4000);
      setTimeout(() => { location.href = loginPath; }, 1200);
      return { ok:false, json:{ error:'Session expired' } };
    }

    const url = CONFIG.SUPABASE_URL + '/functions/v1' + (path.startsWith('/') ? path : '/' + path);
    try {
      const resp = await fetch(url, {
        method: opts.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'apikey': CONFIG.SUPABASE_ANON_KEY
        },
        body: body == null ? undefined : JSON.stringify(body)
      });
      let json = {};
      try { json = await resp.json(); } catch(_) {}
      const ok = resp.ok && json.success !== false;
      if(!ok && opts.toastErrors !== false){
        Shell.toast(json.error || ('Request failed (' + resp.status + ')'), 'error');
      }
      return { ok, json, status: resp.status };
    } catch(e){
      Shell.toast('Network error: ' + (e.message || e), 'error');
      return { ok:false, json:{ error: e.message || String(e) } };
    }
  };

  // ───────────────────────── Bottom tab bar (Wave B) ─────────────────────────
  // Mobile bottom nav for landlord portal. Auto-injected on all landlord pages.
  function initBottomTabs(){
    if (document.querySelector('.cp-bottom-tabs')) return;
    const portal = document.body.getAttribute('data-portal');
    if (portal !== 'landlord') return;
    const path = location.pathname;
    const ICONS = {
      home:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/></svg>',
      inbox:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
      msg:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
      user:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
    };
    const tabs = [
      { href:'/landlord/dashboard.html',    label:'Dashboard', icon:ICONS.home,  match:['/landlord/dashboard.html','/landlord/edit-listing.html','/landlord/new-listing.html'] },
      { href:'/landlord/applications.html', label:'Apps',      icon:ICONS.inbox, match:['/landlord/applications.html'] },
      { href:'/landlord/inquiries.html',    label:'Messages',  icon:ICONS.msg,   match:['/landlord/inquiries.html'] },
      { href:'/landlord/profile.html',      label:'Account',   icon:ICONS.user,  match:['/landlord/profile.html','/landlord/settings.html'] }
    ];
    const bar = document.createElement('nav');
    bar.className = 'cp-bottom-tabs';
    bar.setAttribute('aria-label','Primary navigation');
    bar.innerHTML = tabs.map(t => {
      const active = t.match.some(m => path === m || (m.endsWith('/') && path.startsWith(m)));
      return '<a href="'+t.href+'" class="cp-bt-item'+(active?' active':'')+'" aria-current="'+(active?'page':'false')+'">' +
             '<span class="cp-bt-icon">'+t.icon+'</span>' +
             '<span class="cp-bt-label">'+t.label+'</span>' +
             '</a>';
    }).join('');
    document.body.appendChild(bar);
    document.body.classList.add('has-cp-bottom-tabs');
  }

  // ───────────────────────── Chip a11y auto-sync ─────────────────────────
  // Page chip rows toggle `.active` on click. Mirror that into role/aria-selected
  // so screen readers and keyboard users get the right semantics — without
  // requiring per-page changes. Also wires arrow-key navigation within a row.
  function _syncChipAria(row){
    if(!row.hasAttribute('role')) row.setAttribute('role','tablist');
    const chips = row.querySelectorAll('.chip');
    chips.forEach(c => {
      if(!c.hasAttribute('role'))     c.setAttribute('role','tab');
      if(!c.hasAttribute('tabindex')) c.setAttribute('tabindex', c.classList.contains('active') ? '0' : '-1');
      c.setAttribute('aria-selected', c.classList.contains('active') ? 'true' : 'false');
    });
  }
  function initChipA11y(){
    $$('.chip-row').forEach(_syncChipAria);
    const mo = new MutationObserver(muts => {
      const rows = new Set();
      muts.forEach(m => {
        const t = m.target;
        if(t && t.classList && t.classList.contains('chip')){
          const row = t.closest('.chip-row');
          if(row) rows.add(row);
        }
      });
      rows.forEach(_syncChipAria);
    });
    $$('.chip-row').forEach(row => mo.observe(row, { attributes:true, subtree:true, attributeFilter:['class'] }));
    document.addEventListener('keydown', (e) => {
      if(e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      const c = document.activeElement;
      if(!c || !c.classList.contains('chip')) return;
      const row = c.closest('.chip-row');
      if(!row) return;
      const chips = Array.from(row.querySelectorAll('.chip'));
      const i = chips.indexOf(c);
      let next = i;
      if(e.key === 'ArrowLeft')  next = (i - 1 + chips.length) % chips.length;
      if(e.key === 'ArrowRight') next = (i + 1) % chips.length;
      if(e.key === 'Home') next = 0;
      if(e.key === 'End')  next = chips.length - 1;
      if(next !== i){ e.preventDefault(); chips[next].focus(); chips[next].click(); }
    });
  }

  // ───────────────────────── Keyboard shortcuts ─────────────────────────
  // `/`           focus first visible search input
  // `g d/a/l/m/p` go to Dashboard / Applications / Leases / Move-ins / Properties
  // `?`           show shortcut help sheet
  // `Esc`         close any open sheet
  // Suppressed when typing in inputs / textareas / selects / contenteditable.
  function _isTyping(){
    const a = document.activeElement;
    if(!a) return false;
    const tag = a.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if(a.isContentEditable) return true;
    return false;
  }
  function _portalDir(){
    const p = location.pathname;
    if(p.includes('/admin/'))    return '/admin/';
    if(p.includes('/landlord/')) return '/landlord/';
    if(p.includes('/tenant/'))   return '/tenant/';
    return '/';
  }
  function _showShortcutHelp(){
    Shell.openSheet({
      title: 'Keyboard shortcuts',
      body:
        '<div class="form-stack" style="font-size:.88rem">' +
          '<div class="row-flex between"><span><kbd>/</kbd></span><span>Focus search</span></div>' +
          '<div class="row-flex between"><span><kbd>g</kbd> <kbd>d</kbd></span><span>Go to Dashboard</span></div>' +
          '<div class="row-flex between"><span><kbd>g</kbd> <kbd>a</kbd></span><span>Go to Applications</span></div>' +
          '<div class="row-flex between"><span><kbd>g</kbd> <kbd>l</kbd></span><span>Go to Leases</span></div>' +
          '<div class="row-flex between"><span><kbd>g</kbd> <kbd>m</kbd></span><span>Go to Move-ins</span></div>' +
          '<div class="row-flex between"><span><kbd>g</kbd> <kbd>p</kbd></span><span>Go to Properties</span></div>' +
          '<div class="row-flex between"><span><kbd>?</kbd></span><span>Show this help</span></div>' +
          '<div class="row-flex between"><span><kbd>Esc</kbd></span><span>Close sheet</span></div>' +
        '</div>'
    });
  }
  function initKeyboardShortcuts(){
    let gPending = null;
    document.addEventListener('keydown', (e) => {
      if(e.key === 'Escape'){
        if($('.sheet.open') || $('.sheet-backdrop')) Shell.closeSheet();
        return;
      }
      if(_isTyping()) return;
      if(e.metaKey || e.ctrlKey || e.altKey) return;
      if(e.key === '?'){ e.preventDefault(); _showShortcutHelp(); return; }
      if(e.key === '/'){
        const sel = '#search-input, #search, #f-app, .search input[type="text"], input[type="search"]';
        const inp = $(sel);
        if(inp){ e.preventDefault(); inp.focus(); inp.select && inp.select(); }
        return;
      }
      if(gPending){
        clearTimeout(gPending.t);
        const map = { d:'dashboard.html', a:'applications.html', l:'leases.html', m:'move-ins.html', p:'../listings.html' };
        const target = map[e.key];
        gPending = null;
        if(target){ e.preventDefault(); location.href = _portalDir() + target; }
        return;
      }
      if(e.key === 'g'){
        gPending = { t: setTimeout(() => { gPending = null; }, 1200) };
        return;
      }
    });
  }

  // ───────────────────────── Error capture ─────────────────────────
  // Captures the last 30 unhandled errors / promise rejections into a ring
  // buffer. Surfaces a single discreet toast on the first error per page (so
  // silent failures stop being silent), and exposes Shell.diagnostics() text
  // for support copy-paste.
  Shell.__errors = [];
  let _firstErrToasted = false;
  function _record(kind, payload){
    try {
      Shell.__errors.push(Object.assign({
        ts: new Date().toISOString(),
        kind,
        url: location.pathname + location.search,
        ua: navigator.userAgent
      }, payload));
      if(Shell.__errors.length > 30) Shell.__errors.splice(0, Shell.__errors.length - 30);
      if(!_firstErrToasted){
        _firstErrToasted = true;
        Shell.toast('A background error occurred — see console.', 'warn', 4000);
      }
    } catch(_){ /* never let logging itself break the page */ }
  }
  Shell.diagnostics = function(){
    return JSON.stringify({
      page: location.href,
      generated_at: new Date().toISOString(),
      errors: Shell.__errors
    }, null, 2);
  };
  function initErrorCapture(){
    window.addEventListener('error', (e) => {
      _record('error', {
        message: e.message || String(e.error||''),
        source: e.filename || '', line: e.lineno||0, col: e.colno||0,
        stack: (e.error && e.error.stack) ? String(e.error.stack).slice(0, 1200) : ''
      });
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason;
      _record('unhandledrejection', {
        message: (r && (r.message || String(r))) || 'Unknown rejection',
        stack: (r && r.stack) ? String(r.stack).slice(0, 1200) : ''
      });
    });
  }

  // ───────────────────────── Ready promise ─────────────────────────
  // Replaces ad-hoc whenShellReady polling. Pages can do:
  //   await Shell.ready;     OR     document.addEventListener('cp:shell-ready', …)
  // Resolves once boot() has finished.
  let _readyResolve;
  Shell.ready = new Promise(res => { _readyResolve = res; });

  // ───────────────────────── Theme management (light / auto / dark) ─────────────────────────
  // Mirrors the tenant portal toggle so admin and landlord shells get the same control.
  // Saved key (`cp-theme`) is shared, so a tenant who picks dark also sees admin in dark.
  const THEME_KEY = 'cp-theme';
  function readTheme(){
    try { return localStorage.getItem(THEME_KEY) || 'auto'; }
    catch(_) { return 'auto'; }
  }
  function applyTheme(mode){
    const root = document.documentElement;
    let resolved = mode;
    if(mode === 'auto'){
      resolved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    // The CSS uses [data-theme="light"] to override the dark default, so an
    // explicit `dark` resolves by removing the attribute (or setting it to "dark"
    // which doesn't match any rule and falls through to :root).
    root.setAttribute('data-theme', resolved);
    document.querySelectorAll('.theme-toggle button').forEach(b => {
      b.dataset.active = (b.dataset.themeMode === mode) ? '1' : '0';
      b.setAttribute('aria-pressed', b.dataset.themeMode === mode ? 'true' : 'false');
    });
    const meta = document.querySelector('meta[name="theme-color"]');
    if(meta) meta.setAttribute('content', resolved === 'dark' ? '#0a0f1e' : '#ffffff');
    const scheme = document.querySelector('meta[name="color-scheme"]');
    if(scheme) scheme.setAttribute('content', 'light dark');
  }
  function initTheme(){
    if(!document.querySelector('.theme-toggle')){
      const wrap = document.createElement('div');
      wrap.className = 'theme-toggle';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', 'Theme');
      wrap.innerHTML =
        '<button type="button" data-theme-mode="light" aria-label="Light mode" title="Light"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-sun"/></svg></button>' +
        '<button type="button" data-theme-mode="auto"  aria-label="Auto theme" title="Auto"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-spark"/></svg></button>' +
        '<button type="button" data-theme-mode="dark"  aria-label="Dark mode" title="Dark"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-moon"/></svg></button>';
      document.body.appendChild(wrap);
      wrap.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => {
          const m = b.dataset.themeMode;
          try { localStorage.setItem(THEME_KEY, m); } catch(_) {}
          applyTheme(m);
        });
      });
    }
    applyTheme(readTheme());
    if(window.matchMedia){
      try {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => { if(readTheme() === 'auto') applyTheme('auto'); };
        mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
      } catch(_) {}
    }
    // Keep tabs in sync if the user changes the theme in another tab.
    window.addEventListener('storage', (e) => {
      if(e.key === THEME_KEY) applyTheme(readTheme());
    });
  }
  Shell.applyTheme = applyTheme;

  // ───────────────────────── Boot ─────────────────────────
  function boot(){
    initTheme();
    initActions();
    initActiveNav();
    initSwipeRows();
    initBottomTabs();
    initChipA11y();
    initKeyboardShortcuts();
    initErrorCapture();
    // Cross-tab session sync: if user signs out in another tab, follow.
    window.addEventListener('storage', (e) => {
      if(!e.key) return;
      if(e.key.startsWith('sb-') && e.key.endsWith('-auth-token') && e.newValue === null){
        Shell.toast('Signed out in another tab.', null, 2500);
        const path = location.pathname;
        const target = path.includes('/admin/') ? '/admin/login.html'
                     : path.includes('/landlord/') ? '/landlord/login.html'
                     : path.includes('/tenant/') ? '/tenant/login.html'
                     : '/';
        setTimeout(() => { location.href = target; }, 600);
      }
    });
    // Defer realtime to after CP is ready
    setTimeout(initLiveIndicator, 800);
    // Signal readiness — replaces per-page whenShellReady polling.
    try { _readyResolve && _readyResolve(Shell); } catch(_){}
    document.dispatchEvent(new CustomEvent('cp:shell-ready', { detail: { shell: Shell } }));
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.CPShell    = Shell;
  window.AdminShell = Shell; // backward-compat alias (removed in Phase 8)
})(window, document);
