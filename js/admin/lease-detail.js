// Choice Properties — Admin: lease detail page
//
// Renders the full audit picture for a single application:
//   • Header card (status, tenant, property, key dates)
//   • Sign-events timeline
//   • PDF version history with download links
//   • Lease amendments list + "Create amendment" action
//
// Reads ?app_id=APP_ID from the URL.
(function () {
  'use strict';

  function readyDeps() { return window.AdminShell && window.CP && CP.Auth; }
  function waitReady(ms) {
    return new Promise((res, rej) => {
      const start = Date.now();
      (function tick() {
        if (readyDeps()) return res();
        if (Date.now() - start > ms) return rej(new Error('Admin tools failed to load.'));
        setTimeout(tick, 80);
      })();
    });
  }

  let S;
  let _appId = null;
  let _app = null;

  function fmt(d) { if (!d) return '—'; try { return new Date(d).toLocaleString('en-US',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); } catch { return d; } }
  function fmtDate(d) { if (!d) return '—'; try { return new Date(d).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}); } catch { return d; } }
  function fmtMoney(v) { if (v == null || v === '') return '—'; return '$' + Number(v).toLocaleString('en-US',{minimumFractionDigits:2}); }

  // Phase 07 — read-only render of the itemized money breakdown.
  // Falls back gracefully on legacy applications where only `move_in_costs`
  // was set and none of the per-component fields are populated.
  function renderMoneyBreakdownCard(app){
    const num = (v) => (v == null || v === '') ? null : (Number.isFinite(Number(v)) && Number(v) !== 0 ? Number(v) : null);
    const rows = [];
    const prorated = num(app.prorated_first_month);
    const firstMo  = num(app.first_month_rent);
    const monthly  = num(app.monthly_rent);
    if (prorated != null)      rows.push(['First month (prorated)', prorated]);
    else if (firstMo != null)  rows.push(['First month rent',       firstMo]);
    else if (monthly != null)  rows.push(['First month rent',       monthly]);
    const lastMo = num(app.last_month_rent);
    if (lastMo != null)        rows.push(['Last month rent',        lastMo]);
    const sec = num(app.security_deposit);
    if (sec != null)           rows.push(['Security deposit (refundable)', sec]);
    const petDep = num(app.pet_deposit);
    if (petDep != null)        rows.push(['Pet deposit',            petDep]);
    const adminFee = num(app.admin_fee);
    if (adminFee != null)      rows.push(['Administrative fee',     adminFee]);
    const keyDep = num(app.key_deposit);
    if (keyDep != null)        rows.push(['Key deposit',            keyDep]);
    const parking = num(app.parking_fee);
    if (parking != null)       rows.push(['Parking fee (first month)', parking]);
    const cleaning = num(app.cleaning_fee);
    if (cleaning != null) {
      const refLabel = app.cleaning_fee_refundable === true
        ? ' (refundable)'
        : (app.cleaning_fee_refundable === false ? ' (non-refundable)' : '');
      rows.push(['Cleaning fee' + refLabel, cleaning]);
    }

    let body;
    if (rows.length === 0) {
      const legacy = num(app.move_in_costs);
      if (legacy == null) {
        body = '<div class="text-sm muted">No itemized financials set yet. Click "Generate &amp; send lease" to enter them.</div>';
      } else {
        body =
          '<div class="text-sm muted" style="margin-bottom:6px">Legacy lease (no itemized breakdown). Single move-in lump sum:</div>'+
          '<div class="row-flex between" style="font-weight:700;border-top:2px solid var(--border);padding-top:6px">'+
            '<span>Total due at move-in</span><span>'+fmtMoney(legacy)+'</span>'+
          '</div>';
      }
    } else {
      const total = rows.reduce((s, r) => s + r[1], 0);
      const recurring = (num(app.pet_rent) || 0) + (num(app.parking_fee) || 0);
      const recurringLine = recurring > 0
        ? '<div class="row-flex between text-xs muted" style="margin-top:8px">'+
            '<span>Plus recurring (pet rent + parking)</span><span>+ '+fmtMoney(recurring)+' / mo</span>'+
          '</div>'
        : '';
      body = rows.map(([label, amt]) =>
        '<div class="row-flex between text-sm" style="padding:4px 0;border-bottom:1px solid var(--border)">'+
          '<span class="muted">'+S.esc(label)+'</span><span class="text-strong">'+fmtMoney(amt)+'</span>'+
        '</div>'
      ).join('') +
      '<div class="row-flex between" style="margin-top:8px;font-weight:700;border-top:2px solid var(--accent);padding-top:6px">'+
        '<span>Total due at move-in</span><span>'+fmtMoney(total)+'</span>'+
      '</div>' + recurringLine;
    }

    const dueDay  = app.rent_due_day_of_month || 1;
    const method  = app.rent_proration_method || 'daily';
    const methodLabel = { daily:'Daily', '30day':'30-day', none:'Full month (no proration)' }[method] || method;

    return (
      '<div class="card" style="margin-bottom:14px"><div class="card-body">'+
        '<h3 style="font-size:.92rem;font-weight:700;margin-bottom:10px">Money breakdown</h3>'+
        body +
        '<div class="text-xs muted" style="margin-top:10px;border-top:1px dashed var(--border);padding-top:8px">'+
          'Rent due day: <span class="text-strong">'+S.esc(String(dueDay))+'</span>'+
          ' · Proration: <span class="text-strong">'+S.esc(methodLabel)+'</span>'+
        '</div>'+
      '</div></div>'
    );
  }

  function renderUtilityMatrixCard(app){
    const STD = [
      ['electric','Electric'],['gas','Gas'],['water','Water'],['sewer','Sewer'],
      ['trash','Trash / Garbage'],['recycling','Recycling'],['internet','Internet'],
      ['cable','Cable / Satellite TV'],['hoa','HOA Dues'],['lawn_care','Lawn Care'],
      ['snow_removal','Snow Removal'],['pest_control','Pest Control'],['pool_maintenance','Pool Maintenance'],
    ];
    const RESP = { tenant:'Tenant', landlord:'Landlord', shared:'Shared', 'n/a':'—' };
    const m = app.utility_responsibilities;
    const rows = [];
    if (m && typeof m === 'object') {
      STD.forEach(([key, label]) => {
        const v = m[key];
        if (!v) return;
        const r = (typeof v === 'string') ? v : (typeof v.responsibility === 'string' ? v.responsibility : 'n/a');
        const notes = (typeof v === 'object' && typeof v.notes === 'string') ? v.notes : '';
        if (r === 'n/a' && !notes) return;
        rows.push(
          '<tr>'+
            '<td style="padding:4px 8px;font-size:.78rem;border-bottom:1px solid var(--border)">'+S.esc(label)+'</td>'+
            '<td style="padding:4px 8px;font-size:.78rem;border-bottom:1px solid var(--border)" class="text-strong">'+S.esc(RESP[r] || r)+'</td>'+
            '<td style="padding:4px 8px;font-size:.78rem;border-bottom:1px solid var(--border);color:var(--muted)">'+S.esc(notes||'')+'</td>'+
          '</tr>'
        );
      });
    }

    const body = rows.length
      ? '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">'+
          '<thead><tr style="background:var(--surface-2)">'+
            '<th style="padding:4px 8px;text-align:left;font-size:.75rem;color:var(--muted)">Utility</th>'+
            '<th style="padding:4px 8px;text-align:left;font-size:.75rem;color:var(--muted)">Paid by</th>'+
            '<th style="padding:4px 8px;text-align:left;font-size:.75rem;color:var(--muted)">Notes</th>'+
          '</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>'
      : '<div class="text-sm muted">No utility responsibilities set. They will default to the lease body\'s blanket "Utilities" clause.</div>';

    return (
      '<div class="card" style="margin-bottom:14px"><div class="card-body">'+
        '<h3 style="font-size:.92rem;font-weight:700;margin-bottom:10px">Utility responsibilities</h3>'+
        body +
      '</div></div>'
    );
  }

  function eventLabel(t) {
    return ({
      tenant:        'Primary applicant signed',
      co_applicant:  'Co-applicant signed',
      admin:         'Management countersigned',
    })[t] || t;
  }

  function pdfEventLabel(e) {
    return ({
      pre_sign:      'PDF generated and sent for signing',
      tenant_signed: 'Re-rendered with tenant signature',
      co_signed:     'Re-rendered with co-applicant signature',
      countersigned: 'Re-rendered with management signature',
      amended:       'Lease amendment PDF',
      renewed:       'Renewal PDF',
      manual:        'Manual upload',
    })[e] || e;
  }

  async function loadAll() {
    const sb = CP.sb();
    const url = new URL(location.href);
    _appId = url.searchParams.get('app_id');
    const queryLeaseId = url.searchParams.get('lease_id');
    // Audit fix R-1 (2026-04-27): also accept legacy ?id=, which various
    // dashboard / email-log / audit-log links still use. The value can be
    // either an app_id (e.g. "APP-XXXXXX") or an applications.id UUID;
    // we detect by shape and resolve to app_id.
    const queryGenericId = url.searchParams.get('id');
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!_appId && queryGenericId) {
      if (UUID_RE.test(queryGenericId)) {
        const { data: ar } = await sb.from('applications').select('app_id').eq('id', queryGenericId).maybeSingle();
        if (ar?.app_id) _appId = ar.app_id;
      } else {
        _appId = queryGenericId; // already an app_id
      }
    }

    // Phase 10 -- accept ?lease_id= and resolve to its app_id.
    // Lets admins deep-link directly to a specific lease (renewals etc).
    if (!_appId && queryLeaseId) {
      const { data: lr } = await sb.from('leases').select('app_id').eq('id', queryLeaseId).maybeSingle();
      if (lr?.app_id) _appId = lr.app_id;
    }

    if (!_appId) {
      document.getElementById('lease-detail-root').innerHTML =
        '<div class="empty"><h3>Missing app_id, lease_id, or id</h3><p>Open a lease from the pipeline to view its detail.</p></div>';
      return;
    }

    // Use allSettled so a failure in secondary queries (tokens, leases, admin_actions)
    // does not block the whole page from rendering when the application was found.
    const results = await Promise.allSettled([
      sb.from('applications').select('*').eq('app_id', _appId).single(),
      sb.from('sign_events').select('*').eq('app_id', _appId).order('signed_at', { ascending: false }),
      sb.from('lease_pdf_versions').select('*').eq('app_id', _appId).order('version_number', { ascending: false }),
      sb.from('lease_amendments').select('*').eq('app_id', _appId).order('created_at', { ascending: false }),
      sb.from('admin_actions').select('action, created_at, metadata').eq('target_id', _appId).eq('target_type','application').order('created_at',{ascending:false}).limit(50),
      // Phase 05 - signing-token registry (active/used/revoked/expired)
      sb.from('lease_signing_tokens_admin').select('*').eq('app_id', _appId).order('created_at', { ascending: false }),
      // Phase 10 - all leases attached to this application (chronological)
      sb.from('leases').select('id, lease_status, lease_start_date, lease_end_date, monthly_rent, created_at').eq('app_id', _appId).order('created_at', { ascending: false }),
    ]);

    const unwrap = (r) => r.status === 'fulfilled' ? r.value : { data: null, error: r.reason };
    const [appRes, eventsRes, pdfsRes, amendmentsRes, ver, tokensRes, leasesRes] = results.map(unwrap);

    if (appRes.error || !appRes.data) {
      document.getElementById('lease-detail-root').innerHTML =
        '<div class="empty"><h3>Application not found</h3><p>'+(appRes.error?.message||'')+'</p></div>';
      return;
    }
    _app = appRes.data;

    document.body.dataset.pageSub = `${_app.first_name||''} ${_app.last_name||''} · ${_app.property_address||''}`;
    document.title = `Lease ${_appId} · Choice Properties Admin`;

    render({
      app: _app,
      events: eventsRes.data || [],
      pdfs:   pdfsRes.data || [],
      amends: amendmentsRes.data || [],
      actions: ver.data || [],
      tokens:  tokensRes.data || [],
      leases:  leasesRes.data || [],
    });
  }

  // Phase 05 -- map status -> badge class + label
  function tokenStatusBadge(status) {
    const cls = ({
      active:  'badge success',
      used:    'badge',
      revoked: 'badge error',
      expired: 'badge warn',
    })[status] || 'badge';
    return `<span class="${cls}">${status}</span>`;
  }
  function tokenRoleLabel(role) {
    return ({
      tenant:       'Primary tenant',
      co_applicant: 'Co-applicant',
      amendment:    'Amendment',
    })[role] || role;
  }

  function render({ app, events, pdfs, amends, actions, tokens, leases }) {
    const name = `${app.first_name||''} ${app.last_name||''}`.trim() || '(no name)';
    const root = document.getElementById('lease-detail-root');

    const eventsHtml = events.length
      ? events.map(e => `<div class="ev">
            <div class="ev-time">${S.esc(fmt(e.signed_at))}</div>
            <div class="ev-title">${S.esc(eventLabel(e.signer_type))} &mdash; ${S.esc(e.signer_name||'')}</div>
            <div class="ev-meta">
              ${e.signer_email ? `${S.esc(e.signer_email)} &middot; ` : ''}
              IP ${S.esc(e.ip_address||'—')}
              ${e.signature_image ? `<div style="margin-top:6px"><img class="sig-thumb" src="${S.esc(e.signature_image)}" alt="Signature image"></div>` : ''}
            </div>
          </div>`).join('')
      : '<div class="text-sm muted" style="padding:8px 0">No signature events recorded yet.</div>';

    const actionsHtml = actions.length
      ? actions.map(a => `<div class="ev">
            <div class="ev-time">${S.esc(fmt(a.created_at))}</div>
            <div class="ev-title">${S.esc(a.action.replace(/_/g,' '))}</div>
            ${a.metadata?.actor ? `<div class="ev-meta">by ${S.esc(a.metadata.actor)}</div>` : ''}
          </div>`).join('')
      : '<div class="text-sm muted" style="padding:8px 0">No admin actions logged yet.</div>';

    const pdfsHtml = pdfs.length
      ? pdfs.map(p => `<div class="pdf-row">
            <div style="flex:1;min-width:0">
              <span class="pdf-num">v${p.version_number}</span>
              <span class="text-xs" style="margin-left:6px">${S.esc(pdfEventLabel(p.event))}</span>
              <div class="text-xs muted" style="margin-top:2px">${S.esc(fmt(p.created_at))} ${p.created_by ? '· '+S.esc(p.created_by) : ''}</div>
            </div>
            <button class="btn btn-ghost btn-sm" data-action="dl-pdf" data-path="${S.esc(p.storage_path)}">Download</button>
          </div>`).join('')
      : '<div class="text-sm muted" style="padding:14px;text-align:center">No PDF versions yet.</div>';

    // Phase 05 -- signing-token registry rows
    const tokensHtml = (tokens && tokens.length)
      ? tokens.map(t => {
          const masked = (t.token || '').slice(0, 8) + '\u2026' + (t.token || '').slice(-4);
          const isActive = t.status === 'active';
          const tokenAttr = S.esc(t.token || '');
          const roleAttr  = S.esc(t.signer_role || '');
          const amendAttr = t.amendment_id ? S.esc(t.amendment_id) : '';
          const reasonLine = t.revoke_reason
            ? `<div class="text-xs muted">Reason: ${S.esc(t.revoke_reason)}</div>` : '';
          const usedLine = t.used_at
            ? `<div class="text-xs muted">Used ${S.esc(fmt(t.used_at))}</div>` : '';
          const ipLine = t.ip_locked_to
            ? `<div class="text-xs muted">IP locked to ${S.esc(String(t.ip_locked_to))}</div>` : '';
          return `<div class="pdf-row" style="flex-wrap:wrap;gap:8px">
            <div style="flex:1;min-width:240px">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                ${tokenStatusBadge(t.status)}
                <span class="text-strong" style="font-size:.84rem">${S.esc(tokenRoleLabel(t.signer_role))}</span>
                ${t.signer_email ? `<span class="text-xs muted">&middot; ${S.esc(t.signer_email)}</span>` : ''}
              </div>
              <div class="text-xs muted" style="margin-top:4px;font-family:ui-monospace,monospace">${S.esc(masked)}</div>
              <div class="text-xs muted">Issued ${S.esc(fmt(t.created_at))}${t.expires_at ? ' &middot; expires ' + S.esc(fmt(t.expires_at)) : ''}</div>
              ${usedLine}${ipLine}${reasonLine}
            </div>
            <div class="row-flex gap-2">
              ${isActive ? `<button class="btn btn-ghost btn-sm" data-action="revoke-token" data-token="${tokenAttr}" data-role="${roleAttr}">Revoke</button>` : ''}
              ${isActive ? `<button class="btn btn-ghost btn-sm" data-action="resend-token" data-role="${roleAttr}"${amendAttr ? ` data-amendment="${amendAttr}"` : ''}>Resend</button>` : ''}
            </div>
          </div>`;
        }).join('')
      : '<div class="text-sm muted" style="padding:14px;text-align:center">No signing tokens have been issued for this lease yet.</div>';

    const amendsHtml = amends.length
      ? amends.map(a => `<div class="amend-card">
            <div class="row-flex between">
              <div>
                <div class="amend-title">${S.esc(a.title)}</div>
                <div class="text-xs muted">${S.esc(a.kind)} · created ${S.esc(fmt(a.created_at))} · status: <strong>${S.esc(a.status)}</strong></div>
              </div>
              <div class="row-flex gap-2">
                ${a.pdf_path ? `<button class="btn btn-ghost btn-sm" data-action="dl-pdf" data-path="${S.esc(a.pdf_path)}">PDF</button>` : ''}
              </div>
            </div>
            <div class="amend-body">${S.esc(a.body)}</div>
            ${a.tenant_signature ? `<div class="text-xs" style="color:var(--success);margin-top:6px">Signed ${S.esc(fmt(a.signed_at))} by ${S.esc(a.tenant_signature)}</div>` : ''}
          </div>`).join('')
      : '<div class="text-sm muted" style="padding:8px 0">No amendments on this lease.</div>';

    // Phase 10 -- list leases attached to this application (for visibility into renewals/voids)
    const currentLeaseId = app.current_lease_id || null;
    const leasesHtml = (leases && leases.length)
      ? leases.map(L => {
          const isCurrent = L.id === currentLeaseId;
          const statusCls = ({
            active:           'badge success',
            partially_signed: 'badge warn',
            fully_signed:     'badge warn',
            draft:            'badge',
            void:             'badge error',
            superseded:       'badge',
            terminated:       'badge error',
            ended:            'badge',
          })[L.lease_status] || 'badge';
          return `<div class="pdf-row" style="flex-wrap:wrap;gap:8px">
            <div style="flex:1;min-width:240px">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span class="${statusCls}">${S.esc(L.lease_status||'—')}</span>
                ${isCurrent ? '<span class="badge success">CURRENT</span>' : ''}
                <span class="text-xs muted" style="font-family:ui-monospace,monospace">${S.esc(L.id)}</span>
              </div>
              <div class="text-xs muted" style="margin-top:4px">
                ${fmtDate(L.lease_start_date)} \u2192 ${fmtDate(L.lease_end_date)} &middot; ${fmtMoney(L.monthly_rent)}/mo &middot; created ${S.esc(fmt(L.created_at))}
              </div>
            </div>
          </div>`;
        }).join('')
      : '<div class="text-sm muted" style="padding:14px;text-align:center">No leases on file. (Pre-Phase-10 application.)</div>';

    root.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-body">
          <div class="row-flex between" style="flex-wrap:wrap;gap:12px">
            <div>
              <div class="text-xs muted" style="font-family:ui-monospace,monospace">${S.esc(app.app_id)}</div>
              <div class="text-strong" style="font-size:1.1rem">${S.esc(name)}</div>
              <div class="text-sm muted">${S.esc(app.property_address||'—')}</div>
              <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
                <span class="badge">${S.esc(app.lease_status||'—')}</span>
                ${app.management_cosigned ? '<span class="badge success">Countersigned</span>' : ''}
                ${app.has_co_applicant ? '<span class="badge">Co-applicant</span>' : ''}
                ${currentLeaseId ? `<span class="badge" title="Current lease id" style="font-family:ui-monospace,monospace;font-size:.66rem">lease ${S.esc(currentLeaseId.slice(0,8))}</span>` : ''}
              </div>
            </div>
            <div class="row-flex gap-2" style="flex-wrap:wrap">
              <button class="btn btn-primary btn-sm" data-action="new-amendment">+ New Amendment</button>
              ${app.lease_pdf_url ? `<button class="btn btn-ghost btn-sm" data-action="dl-latest">Download latest PDF</button>` : ''}
              ${currentLeaseId ? `<button class="btn btn-ghost btn-sm" data-action="gen-renewal" data-lease-id="${S.esc(currentLeaseId)}">&#x1F504; Renew Lease</button>` : ''}
              ${currentLeaseId ? `<button class="btn btn-ghost btn-sm" data-action="gen-termination" data-lease-id="${S.esc(currentLeaseId)}">&#x26A0; Termination Notice</button>` : ''}
              ${currentLeaseId ? `<button class="btn btn-ghost btn-sm" data-action="gen-rent-increase" data-lease-id="${S.esc(currentLeaseId)}">&#x1F4C8; Rent Increase</button>` : ''}
            </div>
          </div>

          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
            <div><div class="text-xs muted">Lease start</div><div class="text-sm text-strong">${fmtDate(app.lease_start_date)}</div></div>
            <div><div class="text-xs muted">Lease end</div><div class="text-sm text-strong">${fmtDate(app.lease_end_date)}</div></div>
            <div><div class="text-xs muted">Monthly rent</div><div class="text-sm text-strong">${fmtMoney(app.monthly_rent)}</div></div>
            <div><div class="text-xs muted">Security deposit</div><div class="text-sm text-strong">${fmtMoney(app.security_deposit)}</div></div>
            <div><div class="text-xs muted">Tenant signed</div><div class="text-sm text-strong">${fmtDate(app.signature_timestamp)}</div></div>
            <div><div class="text-xs muted">Co-app signed</div><div class="text-sm text-strong">${fmtDate(app.co_applicant_signature_timestamp)}</div></div>
            <div><div class="text-xs muted">Mgmt countersigned</div><div class="text-sm text-strong">${fmtDate(app.management_cosigned_at)}</div></div>
            <div><div class="text-xs muted">Template version</div><div class="text-sm text-strong">${app.lease_template_version_id ? 'pinned' : '—'}</div></div>
          </div>
        </div>
      </div>

      ${renderMoneyBreakdownCard(app)}
      ${renderUtilityMatrixCard(app)}

      <div class="card" style="margin-bottom:14px">
        <div class="card-body">
          <div class="row-flex between" style="margin-bottom:10px">
            <h3 style="font-size:.92rem;font-weight:700">Leases on this application</h3>
            <span class="text-xs muted">Phase 10 \u2014 leases as first-class entities</span>
          </div>
          <p class="text-xs muted" style="margin-bottom:10px">Each row is a lease that has existed for this application (originals, renewals, voided drafts). Only one lease can be CURRENT.</p>
          <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden">${leasesHtml}</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-body">
          <h3 style="font-size:.92rem;font-weight:700;margin-bottom:10px">Signature events</h3>
          <div class="timeline">${eventsHtml}</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-body">
          <h3 style="font-size:.92rem;font-weight:700;margin-bottom:10px">PDF version history</h3>
          <p class="text-xs muted" style="margin-bottom:10px">Every signature event creates a new PDF. Older versions are preserved for audit and never overwritten.</p>
          <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden">${pdfsHtml}</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-body">
          <div class="row-flex between" style="margin-bottom:10px">
            <h3 style="font-size:.92rem;font-weight:700">Signing tokens</h3>
            <span class="text-xs muted">Single-use links sent to signers</span>
          </div>
          <p class="text-xs muted" style="margin-bottom:10px">Each row is a signing link. Active links can be revoked or replaced; revoking immediately invalidates the link the signer received in their email.</p>
          <div style="border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden">${tokensHtml}</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-body">
          <h3 style="font-size:.92rem;font-weight:700;margin-bottom:10px">Amendments &amp; addenda</h3>
          ${amendsHtml}
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <h3 style="font-size:.92rem;font-weight:700;margin-bottom:10px">Admin action log</h3>
          <div class="timeline">${actionsHtml}</div>
        </div>
      </div>
    `;
  }

  async function downloadPath(path) {
    if (!path) { S.toast('No file path', 'error'); return; }
    const sb = CP.sb();
    const { data, error } = await sb.storage.from('lease-pdfs').createSignedUrl(path, 600);
    if (error || !data?.signedUrl) { S.toast('Could not get download link: ' + (error?.message||'unknown'), 'error'); return; }
    window.open(data.signedUrl, '_blank');
  }

  // Phase 05 -- revoke a single signing token
  async function revokeToken(token, role) {
    if (!token) return;
    const reason = await S.formSheet({
      title: 'Revoke signing token',
      submit: 'Revoke link',
      fields: [
        { name: 'reason', label: 'Reason (visible in audit log)', required: true,
          placeholder: 'e.g. signer requested a fresh link' },
      ],
    });
    if (!reason) return;
    if (!reason.reason || !reason.reason.trim()) { S.toast('Reason required', 'error'); return; }

    S.toast('Revoking link\u2026');
    const res = await S.callFn('/revoke-signing-token', {
      token,
      reason: reason.reason.trim(),
    });
    if (!res) return;
    if (!res.ok) { S.toast(res.json.error || 'Revoke failed', 'error'); return; }
    S.toast('Signing link revoked. The signer can no longer use it.', 'success');
    await loadAll();
  }

  // Phase 05 -- reissue a fresh signing token (and email it)
  async function resendToken(role, amendmentId) {
    if (!role) return;
    const data = await S.formSheet({
      title: 'Resend signing link',
      submit: 'Reissue & send',
      fields: [
        { name: 'send_email', type: 'checkbox', label: 'Email',
          checkLabel: 'Email the new link to the signer immediately', value: true },
      ],
    });
    if (!data) return;

    const payload = {
      app_id: _appId,
      role,
      send_email: !!data.send_email,
    };
    if (amendmentId) payload.amendment_id = amendmentId;

    S.toast('Reissuing link\u2026');
    const res = await S.callFn('/resend-signing-link', payload);
    if (!res) return;
    if (!res.ok) { S.toast(res.json.error || 'Reissue failed', 'error'); return; }
    S.toast(data.send_email
      ? 'New link issued and emailed. Any prior link for this signer has been revoked.'
      : 'New link issued. Any prior link for this signer has been revoked.', 'success');
    await loadAll();
  }

  // Phase 11 — generate a renewal lease for the current lease
  async function generateRenewal(leaseId) {
    if (!leaseId) return;
    const data = await S.formSheet({
      title: 'Generate Renewal Lease',
      submit: 'Create Renewal',
      fields: [
        { name: 'new_monthly_rent', label: 'New monthly rent (leave blank to keep current)', type: 'number',
          placeholder: _app ? String(_app.monthly_rent || '') : '' },
        { name: 'new_lease_start_date', label: 'New lease start date (YYYY-MM-DD, leave blank to auto)',
          placeholder: 'Auto: day after current lease ends' },
        { name: 'new_lease_end_date', label: 'New lease end date (YYYY-MM-DD, leave blank to auto)',
          placeholder: 'Auto: same duration as current lease' },
        { name: 'notes', label: 'Admin notes (optional)', type: 'textarea', rows: 3,
          placeholder: 'Internal note — not shown to tenant' },
      ],
    });
    if (!data) return;

    const payload = { lease_id: leaseId };
    if (data.new_monthly_rent && parseFloat(data.new_monthly_rent) > 0)
      payload.new_monthly_rent = parseFloat(data.new_monthly_rent);
    if (data.new_lease_start_date && data.new_lease_start_date.trim())
      payload.new_lease_start_date = data.new_lease_start_date.trim();
    if (data.new_lease_end_date && data.new_lease_end_date.trim())
      payload.new_lease_end_date = data.new_lease_end_date.trim();
    if (data.notes && data.notes.trim())
      payload.notes = data.notes.trim();

    S.toast('Generating renewal lease\u2026');
    const res = await S.callFn('/generate-renewal', payload);
    if (!res) return;
    if (!res.ok) { S.toast(res.json?.error || 'Renewal generation failed', 'error'); return; }
    const d = res.json;
    S.toast(
      `Renewal lease created (ID: ${(d.renewal_lease_id || '').slice(0, 8)}\u2026).` +
      (d.is_large_increase ? ' NOTE: Large rent increase — extended notice required.' : '') +
      ' The parent lease is now superseded.',
      'success'
    );
    await loadAll();
  }

  // Phase 11 — generate a termination notice for the current lease
  async function generateTerminationNotice(leaseId) {
    if (!leaseId) return;
    const data = await S.formSheet({
      title: 'Generate Termination Notice',
      submit: 'Generate Notice',
      fields: [
        { name: 'notice_type', label: 'Notice type', type: 'select', required: true, options: [
          { value: 'landlord_nonpayment',      label: 'Notice to Pay Rent or Quit (non-payment)' },
          { value: 'landlord_lease_violation', label: 'Notice to Cure or Quit (lease violation)' },
          { value: 'landlord_no_renewal',      label: 'Notice of Non-Renewal (landlord)' },
          { value: 'tenant_initiated_30_day',  label: 'Notice of Intent to Vacate (tenant)' },
          { value: 'mutual',                   label: 'Mutual Agreement to Terminate' },
        ]},
        { name: 'effective_date', label: 'Effective / vacate-by date (YYYY-MM-DD)', required: true,
          placeholder: 'e.g. 2026-07-01' },
        { name: 'reason_text', label: 'Reason / just-cause statement (required for just-cause states & no-renewal)',
          type: 'textarea', rows: 4, placeholder: 'Describe the reason. Required for just-cause jurisdictions.' },
      ],
    });
    if (!data) return;
    if (!data.notice_type || !data.effective_date) { S.toast('Notice type and effective date are required', 'error'); return; }

    S.toast('Generating termination notice\u2026');
    const res = await S.callFn('/generate-termination-notice', {
      lease_id:      leaseId,
      notice_type:   data.notice_type,
      effective_date: data.effective_date.trim(),
      reason_text:   data.reason_text ? data.reason_text.trim() : undefined,
    });
    if (!res) return;
    if (!res.ok) { S.toast(res.json?.error || 'Notice generation failed', 'error'); return; }
    const d = res.json;
    S.toast(
      `Termination notice generated. ` +
      `State-required notice: ${d.notice_days_required} day(s). ` +
      (d.just_cause_warnings && d.just_cause_warnings.length ? 'Just-cause warning on file. ' : '') +
      'PDF saved — download from PDF version history.',
      'success'
    );
    await loadAll();
  }

  // Phase 11 — generate a rent increase letter for the current lease
  async function generateRentIncreaseLetter(leaseId) {
    if (!leaseId) return;
    const data = await S.formSheet({
      title: 'Generate Rent Increase Letter',
      submit: 'Generate Letter',
      fields: [
        { name: 'new_monthly_rent', label: 'New monthly rent ($)', type: 'number', required: true,
          placeholder: _app ? String((_app.monthly_rent || 0) + 50) : '' },
        { name: 'effective_date', label: 'Effective date (YYYY-MM-DD)', required: true,
          placeholder: 'Must meet state notice period' },
        { name: 'override_cap_check', type: 'checkbox', label: 'Override',
          checkLabel: 'Override statutory rent-cap check (CA/OR only — confirm with attorney first)' },
      ],
    });
    if (!data) return;
    if (!data.new_monthly_rent || !data.effective_date) { S.toast('New rent and effective date are required', 'error'); return; }

    S.toast('Generating rent increase letter\u2026');
    const res = await S.callFn('/generate-rent-increase-letter', {
      lease_id:          leaseId,
      new_monthly_rent:  parseFloat(data.new_monthly_rent),
      effective_date:    data.effective_date.trim(),
      override_cap_check: !!data.override_cap_check,
    });
    if (!res) return;
    if (!res.ok) { S.toast(res.json?.error || 'Letter generation failed', 'error'); return; }
    const d = res.json;
    S.toast(
      `Rent increase letter generated (${d.rent_increase_pct}% increase, ` +
      `effective ${data.effective_date}). ` +
      `Notice period: ${d.notice_days_required} day(s)` +
      (d.is_large_increase ? ' (large-increase extended notice applied)' : '') +
      '. PDF saved — download from PDF version history.',
      'success'
    );
    await loadAll();
  }

  async function newAmendment() {
    if (!_app) return;
    if (!_app.management_cosigned) {
      S.toast('Amendments can only be added to fully executed leases.', 'error');
      return;
    }
    const data = await S.formSheet({
      title: 'New lease amendment',
      submit: 'Create &amp; send',
      fields: [
        { name:'kind',  label:'Kind', type:'select', options:[
          { value:'parking',     label:'Parking addendum' },
          { value:'pet',         label:'Pet addendum' },
          { value:'rent_change', label:'Rent change' },
          { value:'roommate',    label:'Roommate / occupant change' },
          { value:'other',       label:'Other' },
        ]},
        { name:'title', label:'Title (shown to tenant)', required:true, placeholder:'e.g. Pet Addendum — One Cat' },
        { name:'body',  label:'Amendment body (supports {{variables}})', type:'textarea', rows:8, required:true },
        { name:'send_email', type:'checkbox', label:'Send', checkLabel:'Email signing link to tenant immediately', value:true },
      ],
    });
    if (!data) return;
    if (!data.title || !data.body) { S.toast('Title and body are required', 'error'); return; }

    S.toast('Creating amendment…');
    const res = await S.callFn('/create-amendment', {
      app_id: _appId,
      kind:   data.kind,
      title:  data.title.trim(),
      body:   data.body.trim(),
      send_email: !!data.send_email,
    });
    if (!res) return;
    if (!res.ok) { S.toast(res.json.error || 'Create failed', 'error'); return; }
    S.toast(data.send_email ? 'Amendment created and email sent.' : 'Amendment saved as draft.', 'success');
    await loadAll();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    try { await waitReady(8000); }
    catch (e) {
      const root = document.getElementById('lease-detail-root');
      if (root) root.innerHTML = '<div class="empty"><h3>Could not load admin tools</h3><p>'+e.message+'</p></div>';
      return;
    }
    S = window.AdminShell;

    document.addEventListener('click', e => {
      const dl = e.target.closest('[data-action="dl-pdf"]');
      if (dl) return downloadPath(dl.dataset.path);
      const dlLatest = e.target.closest('[data-action="dl-latest"]');
      if (dlLatest && _app) return downloadPath(_app.lease_pdf_url);
      const newAmd = e.target.closest('[data-action="new-amendment"]');
      if (newAmd) return newAmendment();
      // Phase 05 -- signing-token actions
      const rev = e.target.closest('[data-action="revoke-token"]');
      if (rev) return revokeToken(rev.dataset.token, rev.dataset.role);
      const rs  = e.target.closest('[data-action="resend-token"]');
      if (rs) return resendToken(rs.dataset.role, rs.dataset.amendment || null);
      // Phase 11 -- lifecycle document generators
      const genR = e.target.closest('[data-action="gen-renewal"]');
      if (genR) return generateRenewal(genR.dataset.leaseId);
      const genT = e.target.closest('[data-action="gen-termination"]');
      if (genT) return generateTerminationNotice(genT.dataset.leaseId);
      const genRi = e.target.closest('[data-action="gen-rent-increase"]');
      if (genRi) return generateRentIncreaseLetter(genRi.dataset.leaseId);
    });

    const okAuth = await S.requireAdmin();
    if (!okAuth) return;
    try {
      await loadAll();
    } catch (e) {
      console.error('lease-detail loadAll failed:', e);
      const root = document.getElementById('lease-detail-root');
      if (root) root.innerHTML = '<div class="empty"><h3>Failed to load lease</h3><p>' + (e.message || 'Unknown error') + '</p></div>';
    }
  });
})();
