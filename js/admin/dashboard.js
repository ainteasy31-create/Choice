(function(){
  'use strict';
  // NOTE: refresh + open-more actions are registered by cp-chrome.js.
  // This page only handles its own data loading.

  function greetingFor(d){
    const h = d.getHours();
    if(h < 12) return 'Good morning';
    if(h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function actionCard(opts){
    const aria = (opts.count + ' ' + opts.label + '. ' + (opts.cta||'Review'));
    return `<a class="action-card ${opts.tone||''}" href="${opts.href}" aria-label="${S.esc(aria)}">
      <div class="ac-icon" aria-hidden="true"><svg class="i"><use href="#${opts.icon}"/></svg></div>
      <div class="ac-body">
        <div class="ac-count">${opts.count}</div>
        <div class="ac-label">${S.esc(opts.label)}</div>
      </div>
      <div class="ac-cta" aria-hidden="true">${S.esc(opts.cta||'Review')} <svg class="i i-sm"><use href="#i-arrow"/></svg></div>
    </a>`;
  }
  function kpi(opts){
    const isZero = (Number(opts.value) === 0);
    const valCls = 'k-value' + (isZero ? ' is-zero' : '');
    const aria = opts.label + ': ' + opts.value + (opts.sub ? ' (' + opts.sub + ')' : '');
    return `<a class="kpi-chip ${opts.tone||''}" href="${opts.href||'#'}" aria-label="${S.esc(aria)}">
      <div class="k-label">${S.esc(opts.label)}</div>
      <div class="${valCls}">${opts.value}</div>
      <div class="k-sub">${S.esc(opts.sub||'')}</div>
    </a>`;
  }
  function activityRow(a){
    const tone = a.status==='approved'?'success':a.status==='denied'?'danger':a.status==='waitlisted'?'warning':'';
    const initials = S.initials(a.first_name, a.last_name);
    const name = (a.first_name||'') + ' ' + (a.last_name||'');
    // Deep-link straight to this application's card on the applications page.
    const href = 'applications.html?id=' + encodeURIComponent(a.app_id || a.id || '');
    return `<a class="activity-row ${tone}" href="${href}" style="text-decoration:none;color:inherit" aria-label="${S.esc(name.trim()||'Applicant')} — ${S.esc(a.status||'')}">
      <div class="dot" style="background:${S.avatarColor(a.email||name)};color:#fff;font-size:.78rem;font-weight:700" aria-hidden="true">${S.esc(initials)}</div>
      <div class="a-body">
        <div class="a-text"><strong>${S.esc(name.trim()||'Applicant')}</strong> ${S.statusPill(a.status)}</div>
        <div class="a-meta">${S.esc(a.property_address||'—')} · ${S.fmtRelative(a.created_at)}</div>
      </div>
    </a>`;
  }

  let S; // populated when AdminShell is ready
  let _range = 'all'; // selected date-range key ('1d' | '7d' | '30d' | 'all')

  // Convert range key → ISO timestamp for RPC / queries.
  function rangeStartISO(key){
    if(key === 'all') return null;
    const ms = { '1d': 86400000, '7d': 604800000, '30d': 2592000000 }[key];
    if(!ms) return null;
    return new Date(Date.now() - ms).toISOString();
  }

  // Single-shot: try the dashboard_pulse RPC, fall back to the legacy 4-query
  // path if the function isn't there yet (deploy-order safety).
  async function fetchPulse(rangeKey){
    const range_start = rangeStartISO(rangeKey);
    try {
      const { data, error } = await CP.sb().rpc('dashboard_pulse', { range_start, recent_limit: 8 });
      // PostgREST may return an array (SETOF) or direct object depending on function definition
      const row = Array.isArray(data) ? data[0] : data;
      if(!error && row && row.counts) {
        return { ok:true, counts: row.counts, recent: row.recent || [], source:'rpc' };
      }
      // PostgREST returns code 'PGRST202' when an RPC doesn't exist; any
      // other error → still try fallback so the dashboard renders something.
    } catch(_) { /* fall through */ }
    return await fetchPulseLegacy(range_start);
  }

  async function fetchPulseLegacy(rangeISO){
    // Legacy path: 4 round-trips. Used when the dashboard_pulse RPC has not
    // been deployed yet, or returns an error.
    const [{ ok: countsOk, data: counts }, { ok: appsOk, data: recent }, listingsRes, failedRes] = await Promise.all([
      CP.Applications.getCounts().catch(e => ({ ok:false, error:e })),
      CP.Applications.getAll({ limit: 8 }).catch(e => ({ ok:false, error:e })),
      CP.sb().from('properties').select('status').then(r => r).catch(() => ({ data: [] })),
      CP.sb().from('email_logs').select('id,type,recipient,created_at').eq('status','failed').gte('created_at', new Date(Date.now()-172800000).toISOString()).limit(20).then(r => r).catch(() => ({ data: [] }))
    ]);
    const c = countsOk ? (counts || {}) : {};
    // Fold listings + failed-emails into the counts object so the rest of
    // the render code can treat both code paths the same way.
    c.active_listings  = (listingsRes?.data || []).filter(l => l.status === 'active').length;
    c.failed_emails_48h = (failedRes?.data || []).length;
    // Apply range filter client-side to the headline totals (best-effort —
    // the RPC does this server-side which is more accurate).
    if(rangeISO && countsOk){
      // Legacy getCounts already returned all-time numbers; we can't
      // re-scope without re-querying, so leave them alone and just label
      // the source as 'legacy' so the UI can show a hint if desired.
    }
    return { ok: countsOk || appsOk, counts: c, recent: appsOk ? (recent || []) : [], source:'legacy' };
  }

  // ── Pipeline stats ─────────────────────────────────────────────────────────
  // Calls the pipeline_stats() RPC (SECURITY DEFINER — can read pipeline schema).
  // Renders a KPI strip showing scraped / edited / published counts.
  async function loadPipelineStats(queue){
    const section = document.getElementById('pipeline-section');
    const strip   = document.getElementById('pipeline-kpi-strip');
    const stamp   = document.getElementById('pipeline-stamp');
    if(!section) return;

    try {
      const { data, error } = await CP.sb().rpc('pipeline_stats');
      if(error || !data) { section.style.display = 'none'; return; }

      const p = (typeof data === 'string') ? JSON.parse(data) : data;
      const scraped   = Number(p.scraped   || 0);
      const edited    = Number(p.edited    || 0);
      const published = Number(p.published || 0);
      const archived  = Number(p.archived  || 0);
      const total     = Number(p.total     || 0);

      if(total === 0) { section.style.display = 'none'; return; }

      // Surface action card if listings are pending review
      const reviewable = scraped + edited;
      if(reviewable > 0){
        queue.push(actionCard({
          icon:  'i-spark',
          tone:  'info',
          count: reviewable,
          label: reviewable === 1 ? 'Scraped listing awaiting pipeline review' : 'Scraped listings awaiting pipeline review',
          cta:   'Open pipeline',
          href:  'pipeline.html',
        }));
      }

      strip.innerHTML = [
        kpi({ label:'Scraped (new)',  value:scraped,   tone: scraped > 0 ? 'warn' : '',    sub:'Pending review',     href:'pipeline.html?status=scraped' }),
        kpi({ label:'Edited',         value:edited,    tone: edited  > 0 ? 'info' : '',    sub:'Ready to publish',   href:'pipeline.html?status=edited' }),
        kpi({ label:'Published',      value:published, tone:'success',                      sub:'Sent to live site',  href:'/listings.html' }),
        kpi({ label:'Archived',       value:archived,  tone:'',                             sub:'In pipeline archive',href:'pipeline.html?status=archived' }),
      ].join('');

      stamp.textContent = total.toLocaleString() + ' total in pipeline';
      section.style.display = '';
    } catch(e) {
      console.warn('[dashboard] pipeline_stats failed:', e);
      section.style.display = 'none';
    }
  }

  // ── New location notifications ─────────────────────────────────────────────
  // Calls get_location_notifications() RPC; surfaces action card when any
  // undismissed city+state combos are waiting for review.
  async function loadLocationNotifications(queue){
    try {
      const { data, error } = await CP.sb().rpc('get_location_notifications');
      if(error || !data) return;
      const rows = Array.isArray(data) ? data : [];
      if(rows.length > 0){
        queue.push(actionCard({
          icon:  'i-listings',
          tone:  'info',
          count: rows.length,
          label: rows.length === 1 ? 'New location detected — review location page' : 'New locations detected — review location pages',
          cta:   'Review',
          href:  'location-notifications.html',
        }));
      }
    } catch(e) {
      // Non-fatal — don't break dashboard if RPC not deployed yet
    }
  }

  async function load(){
    const stamp = document.getElementById('greeting-stamp');
    const okAuth = await S.requireAdmin();
    if(!okAuth) return;

    const user = await CP.Auth.getUser();
    const display = (user?.email||'').split('@')[0] || 'Admin';
    document.getElementById('greeting-name').textContent = greetingFor(new Date()) + ', ' + display.charAt(0).toUpperCase() + display.slice(1);

    const pulse = await fetchPulse(_range);
    const c = pulse.counts || {};
    const recent = pulse.recent || [];
    const appsOk = pulse.ok;
    const activeListings = c.active_listings || 0;
    const failedEmails = c.failed_emails_48h || 0;

    // ── Action queue ──
    const queue = [];
    if((c.pending||0) > 0)        queue.push(actionCard({ icon:'i-clock',  tone:'warn',    count:c.pending,        label:'Applications pending review',          cta:'Review',      href:'applications.html?status=pending' }));
    if((c.unpaid_approved||0) > 0)queue.push(actionCard({ icon:'i-alert',  tone:'urgent',  count:c.unpaid_approved,label:'Approved but fee unpaid',               cta:'Chase',       href:'applications.html?status=approved' }));
    if((c.lease_pending||0) > 0)  queue.push(actionCard({ icon:'i-leases', tone:'info',    count:c.lease_pending,  label:'Leases not yet generated',              cta:'Generate',    href:'leases.html?lease_status=none' }));
    if((c.lease_signed||0) > 0)   queue.push(actionCard({ icon:'i-check',  tone:'urgent',  count:c.lease_signed,   label:'Leases awaiting your countersignature', cta:'Countersign', href:'leases.html?lease_status=signed' }));
    if((c.movein_pending||0) > 0) queue.push(actionCard({ icon:'i-door',   tone:'info',    count:c.movein_pending, label:'Move-ins to confirm',                   cta:'Confirm',     href:'move-ins.html' }));
    if(failedEmails > 0) queue.push(actionCard({ icon:'i-mail', tone:'urgent', count:failedEmails, label:'Failed emails (last 48h)', cta:'Investigate', href:'email-logs.html?status=failed' }));

    // Load pipeline stats; it appends its own action card to queue.
    await loadPipelineStats(queue);

    // Load new location notifications; appends action card if any pending.
    await loadLocationNotifications(queue);

    document.getElementById('action-queue').innerHTML = queue.length
      ? queue.join('')
      : `<div class="card"><div class="card-body" style="text-align:center;padding:32px 16px">
           <div style="font-size:2rem;margin-bottom:8px">✓</div>
           <div class="text-strong">All clear</div>
           <div class="muted text-sm">Nothing needs your attention right now.</div>
         </div></div>`;
    document.getElementById('aq-count').textContent = queue.length ? (queue.length + ' item' + (queue.length>1?'s':'')) : '';

    // ── KPI strip ──
    const rangeLabel = { '1d':'last 24h', '7d':'last 7 days', '30d':'last 30 days' }[_range] || 'all time';
    const legacyNote = (pulse.source === 'legacy' && _range !== 'all') ? ' ⚠ range n/a' : '';
    document.getElementById('kpi-strip').innerHTML = [
      kpi({ label:'Active listings',   value:activeListings,                tone:'gold',    sub:'Live on platform', href:'/listings.html' }),
      kpi({ label:'Total apps',        value:c.total||0,                    tone:'brand',   sub:(_range !== 'all' ? (c.this_period||c.this_month||0) + ' ' + rangeLabel : (c.this_month||0) + ' this month') + legacyNote, href:'applications.html' }),
      kpi({ label:'Pending',           value:c.pending||0,                  tone:'warn',    sub:'Awaiting decision', href:'applications.html?status=pending' }),
      kpi({ label:'Approved',          value:c.approved||0,                 tone:'success', sub:(c.unpaid_approved||0) + ' unpaid', href:'applications.html?status=approved' }),
      kpi({ label:'Leases sent',       value:c.lease_sent||0,               tone:'',        sub:(c.lease_signed||0) + ' signed', href:'leases.html' }),
      kpi({ label:'Move-ins confirmed',value:c.movein_confirmed||0,         tone:'success', sub:rangeLabel, href:'move-ins.html' })
    ].join('');

    // ── Recent feed ──
    const feed = document.getElementById('recent-feed');
    if(!appsOk){
      feed.innerHTML = `<div class="empty"><svg class="i"><use href="#i-alert"/></svg><h3>Could not load activity</h3><p>Try refreshing the page.</p></div>`;
    } else if(!recent?.length){
      feed.innerHTML = `<div class="empty"><svg class="i"><use href="#i-clock"/></svg><h3>No activity yet</h3><p>Applications will appear here as they come in.</p></div>`;
    } else {
      feed.innerHTML = '<div class="activity-feed">' + recent.map(activityRow).join('') + '</div>';
    }

    // ── Stamp ──
    stamp.textContent = 'Live — last refreshed at ' + S.fmtTime(new Date());
  }

  // Wire date-range chips. (Auto-a11y attrs are applied by cp-shell.js'
  // chip-row MutationObserver, so we only need the click handler here.)
  function wireRangeChips(){
    const tabs = document.getElementById('range-tabs');
    if(!tabs) return;
    tabs.addEventListener('click', e => {
      const btn = e.target.closest('.chip');
      if(!btn || !btn.dataset.range) return;
      tabs.querySelectorAll('.chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _range = btn.dataset.range;
      load().catch(err => { console.error('[dashboard] range reload failed', err); S.toast('Failed to reload dashboard data', 'error'); });
    });
  }

  // Wait for shell + run; cp-shell.js exposes Shell.ready as a Promise.
  (window.CPShell && window.CPShell.ready ? window.CPShell.ready : Promise.resolve(window.AdminShell))
    .then(shell => {
      S = shell || window.AdminShell;
      wireRangeChips();
      document.addEventListener('cp:realtime', () => load().catch(()=>{}));
      load().catch(err => {
        console.error('[dashboard] load failed', err);
        S.toast('Failed to load dashboard', 'error');
      });
    })
    .catch(err => { console.error('[dashboard] shell ready failed', err); });
})();
