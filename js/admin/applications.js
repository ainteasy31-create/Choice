(function(){
  'use strict';
  // I-410: Inline scripts run before deferred scripts. window.AdminShell is
  // undefined at this point, so the previous early-return left the page
  // spinning forever. Use the same waitReady pattern as the working pages.
  function readyDeps(){ return window.AdminShell && window.CP && CP.Applications && CP.Auth; }
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
  let S; // assigned after waitReady resolves

  let _allData=[], _status='all', _search='', _payFilter='', _debounce;
  // Bulk-selection state. Set of application UUIDs (db id) currently checked.
  // Cleared whenever loadApps() runs so stale selections never linger after
  // a filter / search change.
  const _selected = new Set();

  // ───── URL pre-seed (so dashboard deep-links with ?status=… work) ─────
  try {
    const usp = new URLSearchParams(location.search);
    if(usp.get('status')) _status = usp.get('status');
  } catch{}

  function fmtDate(d){ if(!d) return '—'; try{ return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }catch{ return d; } }
  function fmtMoney(v){ if(v==null||v==='') return '—'; return '$' + Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function avatar(app){
    const initials = S.initials(app.first_name, app.last_name);
    const seed = app.email || (app.first_name||'') + (app.last_name||'');
    return `<div class="avatar" style="background:${S.avatarColor(seed)}">${S.esc(initials)}</div>`;
  }

  function statusBadge(s){
    const m={pending:'b-pending',under_review:'b-under_review',approved:'b-approved',denied:'b-denied',waitlisted:'b-waitlisted',withdrawn:'b-withdrawn',archived:'b-archived'};
    const l={pending:'Pending',under_review:'In Review',approved:'Approved',denied:'Denied',waitlisted:'Waitlisted',withdrawn:'Withdrawn',archived:'Archived'};
    return `<span class="badge ${m[s]||'b-pending'}">${S.esc(l[s]||s||'—')}</span>`;
  }
  function payBadge(s){
    const m={paid:'b-paid',unpaid:'b-unpaid',waived:'b-waived',refunded:'b-refunded'};
    return `<span class="badge ${m[s]||'b-unpaid'}">${S.esc(s||'unpaid')}</span>`;
  }
  function leaseBadge(s){
    if(!s||s==='none') return '';
    const m={sent:'b-lease-sent',signed:'b-lease-signed',co_signed:'b-lease-signed',awaiting_co_sign:'b-lease-sent'};
    const l={sent:'Lease sent',signed:'Lease signed',co_signed:'Fully executed',awaiting_co_sign:'Awaiting co-sign',voided:'Voided',expired:'Expired'};
    return `<span class="badge ${m[s]||''}">${S.esc(l[s]||s)}</span>`;
  }

  // ───── Render card ─────
  function renderCard(app){
    const name = ((app.first_name||'') + ' ' + (app.last_name||'')).trim() || '(no name)';
    const prop = app.property_address || app.property_id || '—';
    const isPaid = app.payment_status === 'paid';
    const isWaived = app.payment_status === 'waived';
    const isApproved = app.status === 'approved';
    const isDenied = app.status === 'denied';
    const isWaitlisted = app.status === 'waitlisted';
    const isArchived = app.status === 'archived';
    const hfRequested = !!app.holding_fee_requested;
    const hfPaid = !!app.holding_fee_paid;

    // Show confirmed/collected fields when present (authoritative); fall back to recorded fields.
    const hasConfirmed = app.payment_amount_collected || app.payment_method_confirmed || app.payment_confirmed_at;
    const paymentInfo = hasConfirmed
      ? `<span class="text-xs muted">${app.payment_amount_collected?fmtMoney(app.payment_amount_collected):''} ${app.payment_method_confirmed?'via '+S.esc(app.payment_method_confirmed):''} ${app.payment_confirmed_at?'· confirmed '+fmtDate(app.payment_confirmed_at):''}</span>`
      : (app.payment_amount_recorded||app.payment_method_recorded)
        ? `<span class="text-xs muted">${app.payment_amount_recorded?fmtMoney(app.payment_amount_recorded):''} ${app.payment_method_recorded?'via '+S.esc(app.payment_method_recorded):''} ${app.payment_date?'· '+fmtDate(app.payment_date):''}</span>`
        : '';

    // Payment method coordination chip — shown on unpaid apps so team sees preferred method at a glance
    const prefMethod = app.primary_payment_method || '';
    const payMethodChip = (prefMethod && app.payment_status !== 'paid' && app.payment_status !== 'waived')
      ? `<span title="Applicant's preferred payment method" style="display:inline-flex;align-items:center;gap:4px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:2px 9px;font-size:11px;font-weight:600;color:#1d4ed8;margin-left:4px;"><svg viewBox="0 0 24 24" width="11" height="11" style="stroke:currentColor;fill:none;stroke-width:2;flex-shrink:0"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>${S.esc(prefMethod)}</span>`
      : '';

    const ds = `data-id="${S.esc(app.id)}" data-app-id="${S.esc(app.app_id||app.id)}" data-name="${S.esc(name)}" data-status="${S.esc(app.status||'')}"`;

    const checked = _selected.has(app.id) ? 'checked' : '';
    return `<div class="app-card" id="card-${S.esc(app.id)}">
      <div class="app-card-header" data-action="toggle" ${ds}>
        <input type="checkbox" class="bulk-cb" data-id="${S.esc(app.id)}" data-app-id="${S.esc(app.app_id||app.id)}" data-name="${S.esc(name)}" data-status="${S.esc(app.status||'')}" data-payment="${S.esc(app.payment_status||'')}" aria-label="Select ${S.esc(name)}" onclick="event.stopPropagation()" ${checked}>
        ${avatar(app)}
        <div class="app-info">
          <div class="app-id-row">
            <span>${S.esc(app.app_id||app.id)}</span>
            <span class="app-date">${fmtDate(app.created_at)}</span>
            ${app.has_co_applicant ? '<span class="badge b-co">Co-App</span>' : ''}
            ${app.has_pets ? '<span class="badge b-pets">Pets</span>' : ''}
          </div>
          <div class="app-name">${S.esc(name)}</div>
          <div class="app-addr">${S.esc(prop)}</div>
          <div class="badges-row">
            ${statusBadge(app.status)}
            ${payBadge(app.payment_status)}
            ${leaseBadge(app.lease_status)}
            ${payMethodChip}
            ${paymentInfo}
          </div>
        </div>
        <svg class="i chev" id="chev-${S.esc(app.id)}"><use href="#i-arrow"/></svg>
      </div>

      <div class="card-actions">
        ${!isArchived && !isApproved   ? `<button class="btn-act btn-approve"  data-action="status" data-set="approved"   ${ds}><svg class="i i-sm"><use href="#i-check"/></svg> Approve</button>` : ''}
        ${!isArchived && !isDenied     ? `<button class="btn-act btn-deny"     data-action="status" data-set="denied"     ${ds}><svg class="i i-sm"><use href="#i-x"/></svg> Deny</button>` : ''}
        ${!isArchived && !isWaitlisted ? `<button class="btn-act btn-waitlist" data-action="status" data-set="waitlisted" ${ds}><svg class="i i-sm"><use href="#i-clock"/></svg> Waitlist</button>` : ''}
        ${!isArchived && app.status!=='pending' ? `<button class="btn-act btn-pending" data-action="status" data-set="pending" ${ds}><svg class="i i-sm"><use href="#i-refresh"/></svg> Reset</button>` : ''}
        ${!isArchived ? `<button class="btn-act btn-archive" data-action="status" data-set="archived" ${ds} style="opacity:.7"><svg class="i i-sm"><use href="#i-trash"/></svg> Archive</button>` : `<button class="btn-act btn-pending" data-action="status" data-set="pending" ${ds}><svg class="i i-sm"><use href="#i-refresh"/></svg> Unarchive</button>`}

        ${!isPaid && !isWaived ? `<button class="btn-act btn-pay"   data-action="pay"   ${ds}><svg class="i i-sm"><use href="#i-card"/></svg> Mark paid</button>` : ''}
        ${isPaid                ? `<button class="btn-act btn-unpay" data-action="unpay" ${ds}><svg class="i i-sm"><use href="#i-refresh"/></svg> Mark unpaid</button>` : ''}
        ${isPaid                ? `<button class="btn-act btn-refund" data-action="refund" ${ds}>Refund</button>` : ''}
        ${!isWaived             ? `<button class="btn-act"           data-action="waive"  ${ds}>Waive</button>` : ''}

        ${isApproved && !hfRequested ? `<button class="btn-act btn-hf-send"  data-action="hf-send" ${ds} title="Send holding fee request email and reserve the unit"><svg class="i i-sm"><use href="#i-clock"/></svg> Send holding</button>` : ''}
        ${hfRequested && !hfPaid     ? `<button class="btn-act btn-hf-paid"  data-action="hf-paid" ${ds} title="Mark holding fee as received and notify applicant"><svg class="i i-sm"><use href="#i-card"/></svg> Mark holding paid</button>` : ''}
        ${hfPaid                     ? `<button class="btn-act btn-hf-undo"  data-action="hf-undo" ${ds} title="Undo: mark holding fee unpaid"><svg class="i i-sm"><use href="#i-refresh"/></svg> Undo holding paid</button>` : ''}

        <button class="btn-act btn-email" data-action="resend" ${ds} title="Resend any notification email"><svg class="i i-sm"><use href="#i-mail"/></svg> Resend</button>
        <button class="btn-act"           data-action="toggle" ${ds}>Details</button>
      </div>

      <div class="detail-panel" id="detail-${S.esc(app.id)}">
        <div id="detail-inner-${S.esc(app.id)}">
          <div class="muted text-sm">Loading details…</div>
        </div>
      </div>
    </div>`;
  }

  // ───── Render detail ─────
  function row(k,v){ return `<div class="detail-row"><span class="detail-key">${S.esc(k)}</span><span class="detail-val">${S.esc(String(v||'—'))}</span></div>`; }

  function renderDetail(app, coapp){
    const coappHtml = coapp ? `
      <div class="coapp-card">
        <div class="coapp-title">Co-applicant</div>
        <div class="detail-grid">
          ${row('Name', (coapp.first_name||'') + ' ' + (coapp.last_name||''))}
          ${row('Email', coapp.email)}
          ${row('Phone', coapp.phone)}
          ${row('DOB', coapp.dob)}
          ${row('Role', coapp.role)}
          ${row('Employer', coapp.employer)}
          ${row('Job title', coapp.job_title)}
          ${row('Income/mo', coapp.monthly_income)}
          ${row('Employment', coapp.employment_duration)}
          ${row('Status', coapp.employment_status)}
          ${app.co_applicant_ssn ? row('SSN (last 4)', app.co_applicant_ssn) : ''}
        </div>
      </div>` : (app.has_co_applicant ? '<div class="coapp-card"><div class="coapp-title">Co-applicant (details not yet submitted)</div></div>' : '');

    return `
      <div class="detail-section">
        <div class="detail-section-title">Personal</div>
        <div class="detail-grid">
          ${row('Email', app.email)}
          ${row('Phone', app.phone)}
          ${row('DOB', app.dob)}
          ${row('SSN (last 4)', app.ssn)}
          ${row('Gov ID type', app.government_id_type)}
          ${row('Gov ID #', app.government_id_number)}
          ${row('Move-in date', app.requested_move_in_date)}
          ${row('Lease term', app.desired_lease_term)}
          ${row('Occupants', app.total_occupants)}
          ${row('Ever evicted', app.ever_evicted?'Yes':'No')}
          ${row('Smoker', app.smoker?'Yes':'No')}
        </div>
        ${coappHtml}
      </div>
      <div class="detail-section">
        <div class="detail-section-title">Residence</div>
        <div class="detail-grid">
          ${row('Current address', app.current_address)}
          ${row('Duration', app.residency_duration)}
          ${row('Current rent', app.current_rent_amount)}
          ${row('Reason leaving', app.reason_for_leaving)}
          ${row('Current landlord', app.current_landlord_name)}
          ${row('Landlord phone', app.landlord_phone)}
          ${row('Prior address', app.previous_address)}
          ${row('Prior duration', app.previous_residency_duration)}
          ${row('Prior landlord', app.previous_landlord_name)}
          ${row('Prior landlord ph.', app.previous_landlord_phone)}
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">Employment</div>
        <div class="detail-grid">
          ${row('Status', app.employment_status)}
          ${row('Employer', app.employer)}
          ${row('Employer address', app.employer_address)}
          ${row('Job title', app.job_title)}
          ${row('Start date', app.employment_start_date)}
          ${row('Duration', app.employment_duration)}
          ${row('Supervisor', app.supervisor_name)}
          ${row('Supervisor ph.', app.supervisor_phone)}
          ${row('Monthly income', app.monthly_income)}
          ${row('Other income', app.other_income)}
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">Background</div>
        <div class="detail-grid">
          ${row('Bankruptcy', app.has_bankruptcy ? 'Yes — ' + (app.bankruptcy_explanation||'') : 'No')}
          ${row('Criminal history', app.has_criminal_history ? 'Yes — ' + (app.criminal_history_explanation||'') : 'No')}
          ${row('Evicted', app.ever_evicted?'Yes':'No')}
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">References & emergency contact</div>
        <div class="detail-grid">
          ${row('Reference 1', app.reference_1_name ? (app.reference_1_name + ' — ' + (app.reference_1_phone||'')) : '—')}
          ${row('Reference 2', app.reference_2_name ? (app.reference_2_name + ' — ' + (app.reference_2_phone||'')) : '—')}
          ${row('Emergency contact', app.emergency_contact_name ? (app.emergency_contact_name + ' (' + (app.emergency_contact_relationship||'') + ') ' + (app.emergency_contact_phone||'')) : '—')}
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">Vehicle & preferences</div>
        <div class="detail-grid">
          ${row('Vehicle', [app.vehicle_year, app.vehicle_make, app.vehicle_model].filter(Boolean).join(' ') || '—')}
          ${row('License plate', app.vehicle_license_plate)}
          ${row('Preferred contact', app.preferred_contact_method)}
          ${row('Best time', app.preferred_time)}
        </div>
        ${app.pet_details ? `<div class="detail-row"><span class="detail-key">Pet details</span><span class="detail-val">${S.esc(app.pet_details)}</span></div>` : ''}
      </div>
      <div class="detail-section" style="border-left:3px solid #3b82f6;">
        <div class="detail-section-title" style="color:#1d4ed8;">💳 Payment Coordination</div>
        ${(app.payment_status !== 'paid' && app.payment_status !== 'waived') ? `
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;margin-bottom:10px;font-size:0.88rem;color:#1e40af;line-height:1.5;">
          <i class="fas fa-info-circle"></i> <strong>Contact this applicant using their preferred method below</strong> to arrange the ${app.application_fee ? fmtMoney(app.application_fee) : ''} fee, then record payment once confirmed.
        </div>` : ''}
        <div class="detail-grid">
          ${app.primary_payment_method ? `<div class="detail-row"><span class="detail-key">Primary method</span><span class="detail-val" style="font-weight:700;color:#1d4ed8;">${S.esc(app.primary_payment_method)}${app.primary_payment_method_other?' ('+S.esc(app.primary_payment_method_other)+')':''}</span></div>` : ''}
          ${app.alternative_payment_method ? `<div class="detail-row"><span class="detail-key">2nd choice</span><span class="detail-val">${S.esc(app.alternative_payment_method)}${app.alternative_payment_method_other?' ('+S.esc(app.alternative_payment_method_other)+')':''}</span></div>` : ''}
          ${app.third_choice_payment_method ? `<div class="detail-row"><span class="detail-key">3rd choice</span><span class="detail-val">${S.esc(app.third_choice_payment_method)}${app.third_choice_payment_method_other?' ('+S.esc(app.third_choice_payment_method_other)+')':''}</span></div>` : ''}
          ${(!app.primary_payment_method && !app.alternative_payment_method) ? `<div class="detail-row"><span class="detail-key muted">No preference recorded</span></div>` : ''}
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">Payment record</div>
        <div class="detail-grid">
          ${row('Fee', fmtMoney(app.application_fee))}
          ${row('Status', app.payment_status||'—')}
          ${row('Amount collected', fmtMoney(app.payment_amount_recorded))}
          ${row('Method', app.payment_method_recorded)}
          ${row('Date', fmtDate(app.payment_date))}
          ${row('Notes', app.payment_notes)}
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">Documents</div>
        <div id="docs-${S.esc(app.id)}">
          <button class="btn-act" data-action="docs" data-id="${S.esc(app.id)}" data-app-id="${S.esc(app.app_id||app.id)}">View documents</button>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">Admin notes <span class="text-xs muted" style="text-transform:none;font-weight:400">(not visible to applicant)</span></div>
        <textarea class="notes-area" id="notes-${S.esc(app.id)}" placeholder="Internal notes…">${S.esc(app.admin_notes||'')}</textarea>
        <div style="margin-top:6px"><button class="btn-act" data-action="save-notes" data-id="${S.esc(app.id)}">Save notes</button></div>
      </div>`;
  }

  // ───── Toggle detail ─────
  async function toggleDetail(id){
    const panel = document.getElementById('detail-' + id);
    const chev = document.getElementById('chev-' + id);
    if(!panel) return;
    const isOpen = panel.classList.contains('open');
    if(isOpen){ panel.classList.remove('open'); if(chev) chev.classList.remove('open'); return; }
    panel.classList.add('open');
    if(chev) chev.classList.add('open');
    if(panel.dataset.loaded) return;
    panel.dataset.loaded = '1';
    const app = _allData.find(a => String(a.id) === String(id));
    if(!app) return;
    let coapp = null;
    if(app.has_co_applicant){
      const { data } = await CP.sb().from('co_applicants').select('*').eq('app_id', app.app_id).maybeSingle();
      coapp = data;
    }
    document.getElementById('detail-inner-' + id).innerHTML = renderDetail(app, coapp);
  }

  // ───── Load + stats ─────
  function withTimeout(p, ms, label){
    return Promise.race([p, new Promise((_,rej)=>setTimeout(()=>rej(new Error((label||'Operation') + ' timed out after ' + ms + 'ms')), ms))]);
  }

  // ═══════════════════════════════════════════════════════════
  // Bulk-action helpers (Batch B #4)
  // ═══════════════════════════════════════════════════════════

  function clearSelection(){
    _selected.clear();
    document.querySelectorAll('.bulk-cb').forEach(cb => { cb.checked = false; });
    const all = document.getElementById('bulk-cb-all');
    if(all){ all.checked = false; all.indeterminate = false; }
    refreshBulkBar();
  }

  function refreshSelectAllState(){
    const all = document.getElementById('bulk-cb-all');
    if(!all) return;
    const visible = document.querySelectorAll('.bulk-cb');
    const total = visible.length;
    const sel = Array.from(visible).filter(cb => cb.checked).length;
    all.checked = (total > 0 && sel === total);
    all.indeterminate = (sel > 0 && sel < total);
  }

  function refreshBulkBar(){
    const slot = document.getElementById('bulk-bar-slot');
    if(!slot) return;
    const n = _selected.size;
    if(n === 0){ slot.innerHTML = ''; return; }
    slot.innerHTML = `
      <div class="bulk-bar" role="region" aria-label="Bulk actions">
        <span class="bulk-bar-count">${n} selected</span>
        <div class="bulk-bar-actions">
          <button class="btn-act btn-approve"  data-action="bulk-status" data-set="approved">✓ Approve all</button>
          <button class="btn-act btn-deny"     data-action="bulk-status" data-set="denied">✗ Deny all</button>
          <button class="btn-act btn-waitlist" data-action="bulk-status" data-set="waitlisted">⧗ Waitlist all</button>
          <button class="btn-act"              data-action="bulk-status" data-set="archived" style="opacity:.7">🗄 Archive all</button>
          <button class="btn-act btn-pay"      data-action="bulk-pay">$ Mark paid</button>
          <button class="btn-act"               data-action="bulk-waive">Waive fees</button>
          <button class="btn-act"               data-action="bulk-unpay">↺ Mark unpaid</button>
          <button class="btn-act"               data-action="bulk-clear">Clear</button>
        </div>
      </div>`;
    refreshSelectAllState();
  }

  // Run bulk operation against every selected app id.
  // `fn` returns the API promise for one row. We process sequentially to
  // avoid hammering the database; with typical selections of <50 rows the
  // user-perceived latency is dominated by the email sends, not the DB.
  async function runBulk(label, fn, opts){
    const ids = Array.from(_selected);
    if(!ids.length) return;
    opts = opts || {};
    const confirmMsg = opts.confirm !== false
      ? await S.confirm({
          title: label + '?',
          message: 'This will affect ' + ids.length + ' application' + (ids.length===1?'':'s') + '. Are you sure?',
          ok: label,
          danger: !!opts.danger
        })
      : true;
    if(!confirmMsg) return;
    let okN = 0, failN = 0;
    const failures = [];
    for(let i = 0; i < ids.length; i++){
      const id = ids[i];
      try {
        const res = await fn(id, i);
        if(res && res.ok === false){ failN++; failures.push(res.error || 'unknown'); }
        else okN++;
      } catch(e){
        failN++; failures.push(e.message || String(e));
      }
    }
    const msg = okN + ' succeeded' + (failN ? ', ' + failN + ' failed' : '');
    S.toast(msg, failN ? 'warn' : 'success');
    if(failN && failures.length) console.warn('[bulk] failures:', failures);
    clearSelection();
    await loadApps();
  }

  function bulkSetStatus(status){
    const label = ({ approved:'Approve', denied:'Deny', waitlisted:'Waitlist', archived:'Archive', withdrawn:'Withdraw' })[status] || 'Update status';
    return runBulk(label, (id) => CP.Applications.updateStatus(id, status), { danger: status === 'denied' });
  }
  function bulkMarkPaid(){
    return runBulk('Mark paid', (id) => CP.Applications.updatePayment(id, 'paid'));
  }
  function bulkMarkUnpaid(){
    return runBulk('Mark unpaid', (id) => CP.Applications.updatePayment(id, 'unpaid'));
  }
  function bulkWaive(){
    return runBulk('Waive fee', (id) => CP.Applications.updatePayment(id, 'waived'));
  }

  // Wire row-level checkbox changes (delegated, so it survives re-renders).
  function wireBulkSelection(){
    const list = document.getElementById('apps-list');
    if(!list) return;
    list.addEventListener('change', e => {
      const cb = e.target.closest('.bulk-cb');
      if(!cb) return;
      const id = cb.dataset.id;
      if(cb.checked) _selected.add(id); else _selected.delete(id);
      refreshSelectAllState();
      refreshBulkBar();
    });
    const all = document.getElementById('bulk-cb-all');
    if(all){
      all.addEventListener('change', () => {
        const want = all.checked;
        document.querySelectorAll('.bulk-cb').forEach(cb => {
          cb.checked = want;
          if(want) _selected.add(cb.dataset.id); else _selected.delete(cb.dataset.id);
        });
        refreshBulkBar();
      });
    }
  }

  async function loadApps(){
    const list = document.getElementById('apps-list');
    list.innerHTML = '<div class="list">' + S.skeletonRows(5) + '</div>';
    // Wipe any prior selection — the row IDs about to render may not match.
    _selected.clear();
    refreshBulkBar();
    const filters = { status:_status, search:_search };
    if(_payFilter) filters.payment_status = _payFilter;
    let res;
    try { res = await withTimeout(CP.Applications.getAll(filters), 15000, 'Applications query'); }
    catch(e){
      list.innerHTML = '<div class="empty"><svg class="i"><use href="#i-alert"/></svg><h3>Request timed out</h3><p>' + S.esc(e.message) + '</p><p style="margin-top:12px"><button class="btn btn-primary" data-action="reload-apps">Retry</button></p></div>';
      return;
    }
    if(!res.ok){
      list.innerHTML = '<div class="empty"><svg class="i"><use href="#i-alert"/></svg><h3>Error loading</h3><p>' + S.esc(res.error||'Unknown') + '</p><p style="margin-top:12px"><button class="btn btn-primary" data-action="reload-apps">Retry</button></p></div>';
      return;
    }
    _allData = res.data || [];
    document.querySelector('.appbar-sub').textContent =
      _allData.length + ' application' + (_allData.length!==1?'s':'') + (_status!=='all' ? ' · ' + _status : '');
    updateStats(_allData);
    if(!_allData.length){
      list.innerHTML = '<div class="empty"><svg class="i"><use href="#i-apps"/></svg><h3>No applications found</h3><p>Try adjusting the filters.</p></div>';
      // Hide the select-all / bulk toolbar when there are zero rows.
      const tr = document.getElementById('bulk-toolbar-row');
      if(tr) tr.hidden = true;
      return;
    }
    list.innerHTML = _allData.map(renderCard).join('');
    // Reveal the select-all toolbar once we have rows to act on.
    const tr = document.getElementById('bulk-toolbar-row');
    if(tr) tr.hidden = false;
    refreshSelectAllState();
  }

  function updateStats(rows){
    const bar = document.getElementById('stats-bar');
    if(!bar) return;
    bar.style.display = 'grid';
    const c = { total: rows.length, pending:0, approved:0, waitlisted:0, denied:0, unpaid:0, archived:0 };
    rows.forEach(r => {
      if(r.status === 'pending') c.pending++;
      if(r.status === 'approved') c.approved++;
      if(r.status === 'waitlisted') c.waitlisted++;
      if(r.status === 'denied') c.denied++;
      if(r.status === 'archived') c.archived++;
      if(r.payment_status === 'unpaid' && r.status === 'approved') c.unpaid++;
    });
    bar.innerHTML = `
      <div class="stat-card"><div class="stat-num">${c.total}</div><div class="stat-label">Total</div></div>
      <div class="stat-card"><div class="stat-num" style="color:var(--warning)">${c.pending}</div><div class="stat-label">Pending</div></div>
      <div class="stat-card"><div class="stat-num" style="color:var(--success)">${c.approved}</div><div class="stat-label">Approved</div></div>
      <div class="stat-card"><div class="stat-num" style="color:#a855f7">${c.waitlisted}</div><div class="stat-label">Waitlisted</div></div>
      <div class="stat-card"><div class="stat-num" style="color:var(--danger)">${c.denied}</div><div class="stat-label">Denied</div></div>
      <div class="stat-card"><div class="stat-num" style="color:#f97316">${c.unpaid}</div><div class="stat-label">Unpaid + approved</div></div>
      ${c.archived ? `<div class="stat-card"><div class="stat-num" style="color:#9ca3af">${c.archived}</div><div class="stat-label">Archived</div></div>` : ''}`;
  }

  // ───── Status change ─────
  async function setStatus(dbId, appId, status){
    const willEmail = ['approved','denied','waitlisted'].includes(status);
    const labels = { approved:'Approve application?', denied:'Deny application?', waitlisted:'Move to waitlist?', pending:'Reset to pending?', new:'Reset to new?', archived:'Archive application?', withdrawn:'Mark as withdrawn?' };
    const verbs  = { approved:'Approve', denied:'Deny', waitlisted:'Waitlist', pending:'Reset', new:'Reset', archived:'Archive', withdrawn:'Withdraw' };
    const proceed = await S.confirm({
      title: labels[status] || ('Set status to ' + status + '?'),
      message: willEmail
        ? 'The applicant will be notified by email that their application is ' + status + '.'
        : 'The application status will be changed to "' + status + '".',
      ok: verbs[status] || 'Confirm',
      danger: status === 'denied'
    });
    if(!proceed) return;
    const card = document.getElementById('card-' + dbId);
    if(card) card.style.opacity = '.55';
    const { ok, error } = await CP.Applications.updateStatus(dbId, status);
    if(!ok){ S.toast('Error: ' + error, 'error'); if(card) card.style.opacity = '1'; return; }
    if(willEmail) await autoSendEmail(appId, status);
    S.toast('Status updated to ' + status + '.');
    await loadApps();
  }

  async function autoSendEmail(appId, type, message){
    try {
      const session = await CP.Auth.getSession();
      const token = session?.access_token || CONFIG.SUPABASE_ANON_KEY;
      const body = { app_id: appId, type };
      if(message) body.message = message;
      const res = await fetch(CONFIG.SUPABASE_URL + '/functions/v1/send-email', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'apikey': CONFIG.SUPABASE_ANON_KEY, 'Authorization':'Bearer ' + token },
        body: JSON.stringify(body)
      });
      const json = await res.json().catch(() => ({}));
      if(!res.ok || json.success === false) S.toast('Status saved, email failed: ' + (json.error||res.statusText), 'warn');
      else S.toast('Email sent to applicant.');
    } catch(e){ S.toast('Email error: ' + e.message, 'warn'); }
  }

  // ───── Payment ─────
  async function openPaySheet(dbId, appId, name){
    const data = await S.formSheet({
      title: 'Mark as paid · ' + name,
      submit: 'Mark as paid',
      fields: [
        { name:'amount', label:'Amount collected ($)', type:'number', placeholder:'e.g. 50.00' },
        { name:'method', label:'Payment method', type:'select', value:'', options:[
          { value:'', label:'(none selected)' },
          // Mirrors the application form (apply/index.html) — keep in sync.
          { value:'Venmo', label:'Venmo' },
          { value:'PayPal', label:'PayPal' },
          { value:'Cash App', label:'Cash App' },
          { value:'Apple Pay', label:'Apple Pay' },
          { value:'Zelle', label:'Zelle' },
          { value:'Chime', label:'Chime' },
          { value:'Credit / Debit Card', label:'Credit / Debit Card' },
          { value:'Other', label:'Other' }
        ]},
        { name:'notes', label:'Notes / reference', type:'textarea', rows:2 },
        { name:'send_email', type:'checkbox', label:'Email', checkLabel:'Send payment confirmation email to applicant', value:true }
      ]
    });
    if(!data) return;
    const amount = data.amount ? parseFloat(data.amount) : null;
    const method = data.method || null;
    const notes  = data.notes || null;
    const { ok, error } = await CP.Applications.updatePaymentWithDetails(dbId, 'paid', amount, method, notes);
    if(!ok){ S.toast('Error: ' + error, 'error'); return; }
    if(data.send_email && appId){
      try {
        const session = await CP.Auth.getSession();
        const token = session?.access_token || CONFIG.SUPABASE_ANON_KEY;
        const body = { app_id: appId, type:'payment_confirmed' };
        if(amount != null) body.amount_collected = amount;
        if(method) body.payment_method = method;
        if(notes) body.transaction_ref = notes;
        const res = await fetch(CONFIG.SUPABASE_URL + '/functions/v1/send-email', {
          method:'POST',
          headers:{ 'Content-Type':'application/json', 'apikey': CONFIG.SUPABASE_ANON_KEY, 'Authorization':'Bearer ' + token },
          body: JSON.stringify(body)
        });
        const json = await res.json().catch(() => ({}));
        if(!res.ok || json.success === false) S.toast('Payment saved, email failed: ' + (json.error||''), 'warn');
        else S.toast('Payment confirmation email sent.');
      } catch(e){ S.toast('Email error: ' + e.message, 'warn'); }
    }
    S.toast('Payment recorded.','success');
    await loadApps();
  }

  async function markUnpaid(dbId){
    const proceed = await S.confirm({
      title: 'Mark as unpaid?',
      message: 'This reverses any recorded payment for this application. The applicant will not be notified.',
      ok: 'Mark unpaid',
      danger: true
    });
    if(!proceed) return;
    const { ok, error } = await CP.Applications.updatePayment(dbId, 'unpaid');
    if(!ok){ S.toast('Error: ' + error, 'error'); return; }
    S.toast('Marked as unpaid.');
    await loadApps();
  }
  async function markWaived(dbId){
    const ok2 = await S.confirm({ title:'Waive application fee?', message:'The applicant will not be charged.', ok:'Waive fee' });
    if(!ok2) return;
    const { ok, error } = await CP.Applications.updatePayment(dbId, 'waived');
    if(!ok){ S.toast('Error: ' + error, 'error'); return; }
    S.toast('Fee waived.');
    await loadApps();
  }

  async function openRefundSheet(dbId, name){
    const data = await S.formSheet({
      title: 'Refund payment · ' + name,
      submit: 'Confirm refund', danger:true,
      fields: [
        { name:'notes', label:'Refund notes / reason', type:'textarea', rows:3, placeholder:'Optional notes about this refund…' }
      ]
    });
    if(!data) return;
    const notes = data.notes || null;
    const { error } = await CP.sb().from('applications')
      .update({ payment_status:'refunded', payment_notes:notes, updated_at: new Date().toISOString() })
      .eq('id', dbId);
    if(error){ S.toast('Error: ' + error.message, 'error'); return; }
    S.toast('Marked as refunded.','success');
    await loadApps();
  }

  // ───── Holding fee ─────
  async function openHoldingSendSheet(dbId, appId, name){
    const due = new Date(); due.setDate(due.getDate() + 2);
    const dueStr = due.toISOString().slice(0,10);
    const data = await S.formSheet({
      title: 'Send holding fee request · ' + name,
      submit: 'Send request',
      fields: [
        { name:'fee_amount', label:'Holding fee amount ($)', type:'number', placeholder:'e.g. 500.00' },
        { name:'due_date',   label:'Due by', type:'date', value: dueStr, help:'Typically 24–48 hours from now.' }
      ]
    });
    if(!data) return;
    const fee_amount = data.fee_amount ? parseFloat(data.fee_amount) : null;
    const due_date   = data.due_date || null;
    if(!fee_amount || fee_amount <= 0){ S.toast('Enter a holding fee amount.', 'error'); return; }
    try {
      const session = await CP.Auth.getSession();
      const token = session?.access_token || CONFIG.SUPABASE_ANON_KEY;
      const body = { app_id: appId, type:'holding_fee_request', fee_amount, due_date };
      const res = await fetch(CONFIG.SUPABASE_URL + '/functions/v1/send-email', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'apikey': CONFIG.SUPABASE_ANON_KEY, 'Authorization':'Bearer ' + token },
        body: JSON.stringify(body)
      });
      const json = await res.json().catch(() => ({}));
      if(!res.ok || json.success === false){
        S.toast('Holding fee request failed: ' + (json.error||res.statusText), 'error');
        return;
      }
      S.toast('Holding fee request sent.', 'success');
      await loadApps();
    } catch(e){ S.toast('Error: ' + e.message, 'error'); }
  }

  async function markHoldingPaid(dbId, appId, name){
    const ok2 = await S.confirm({ title:'Mark holding fee as paid?', message:'This confirms the holding fee for ' + name + ' and emails the applicant.', ok:'Mark paid' });
    if(!ok2) return;
    try {
      const session = await CP.Auth.getSession();
      const token = session?.access_token || CONFIG.SUPABASE_ANON_KEY;
      const body = { app_id: appId, type:'holding_fee_received' };
      const res = await fetch(CONFIG.SUPABASE_URL + '/functions/v1/send-email', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'apikey': CONFIG.SUPABASE_ANON_KEY, 'Authorization':'Bearer ' + token },
        body: JSON.stringify(body)
      });
      const json = await res.json().catch(() => ({}));
      if(!res.ok || json.success === false){
        S.toast('Could not mark holding paid: ' + (json.error||res.statusText), 'error');
        return;
      }
      S.toast('Holding fee marked paid.', 'success');
      await loadApps();
    } catch(e){ S.toast('Error: ' + e.message, 'error'); }
  }

  async function undoHoldingPaid(dbId){
    const ok2 = await S.confirm({ title:'Undo holding fee paid?', message:'Reverts the holding fee to "requested but unpaid". No email is sent.', ok:'Undo' });
    if(!ok2) return;
    const { error } = await CP.sb().from('applications')
      .update({ holding_fee_paid:false, holding_fee_paid_at:null, updated_at: new Date().toISOString() })
      .eq('id', dbId);
    if(error){ S.toast('Error: ' + error.message, 'error'); return; }
    S.toast('Holding fee marked unpaid.');
    await loadApps();
  }

  // ───── Resend notification ─────
  const RESEND_TYPE_DESC = {
    approved: 'Sends the full approval email with congratulations, next steps, and a link to the tenant portal.',
    denied: 'Sends the denial email with thank-you message and reapplication encouragement.',
    waitlisted: 'Notifies the applicant they are on the active waitlist and will be contacted if a unit becomes available.',
    payment_confirmed: 'Confirms receipt of the application fee and lets the applicant know their file is now in active review (24–72h target).',
    holding_fee_request: 'Asks the selected applicant to complete the holding fee — reserves the unit and removes it from active availability. Time-sensitive (24–48h).',
    holding_fee_received: 'Confirms holding fee received — the unit is reserved for the applicant while the lease is finalized.',
    lease_ready: 'Notifies the applicant their lease is ready and provides a link to e-sign.',
    lease_signing_reminder: 'Friendly 48-hour reminder that the lease is awaiting their signature.',
    lease_fully_executed: 'Congratulatory email confirming both parties have signed — lease is fully executed.',
    movein_confirmed: 'Sends the official move-in date, key pickup details, and what to expect on move-in day.',
    move_in_prep: 'Detailed move-in preparation guide: utilities, mail forwarding, what to bring, etc.',
    lease_expiry_alert: 'Internal admin alert (sent to admin inbox) — lease has been unsigned for 48+ hours.',
    admin_review_summary: 'Internal admin summary email with full applicant profile for lease generation.'
  };

  async function openResendSheet(appId, currentStatus, name){
    const defaultType = ({ approved:'approved', denied:'denied', waitlisted:'waitlisted' })[currentStatus] || 'approved';
    const options = Object.keys(RESEND_TYPE_DESC).map(k => ({ value:k, label:k.replace(/_/g,' ') }));
    const data = await S.formSheet({
      title: 'Resend notification · ' + name,
      submit: 'Send email',
      fields: [
        { name:'type', label:'Email type', type:'select', value:defaultType, options },
        { name:'message', label:'Optional custom message', type:'textarea', rows:3, help:'If the template supports it, this message will be inserted.' }
      ]
    });
    if(!data) return;
    await autoSendEmail(appId, data.type, data.message || undefined);
  }

  // ───── Notes ─────
  async function saveNotes(id){
    const ta = document.getElementById('notes-' + id);
    if(!ta) return;
    const { ok, error } = await CP.Applications.saveNotes(id, ta.value);
    if(!ok){ S.toast('Error: ' + error, 'error'); return; }
    S.toast('Notes saved.');
  }

  // ───── Documents ─────
  async function loadDocs(dbId, appId){
    const container = document.getElementById('docs-' + dbId);
    if(!container) return;
    container.innerHTML = '<span class="text-sm muted">Loading…</span>';
    try {
      const folder = appId + '/applicant_upload';
      const { data: files, error } = await CP.sb().storage.from('application-docs')
        .list(folder, { limit:50, sortBy:{ column:'created_at', order:'desc' } });
      if(error){ container.innerHTML = '<span class="text-sm" style="color:var(--danger)">Error: ' + S.esc(error.message) + '</span>'; return; }
      if(!files || !files.length){ container.innerHTML = '<span class="text-sm muted">No documents uploaded yet.</span>'; return; }
      const rows = files.map(f => `<div class="doc-row">
        <span style="flex:1">${S.esc(f.name||'—')}</span>
        <button class="btn-act" data-action="download-doc" data-path="${S.esc(folder + '/' + f.name)}">Download</button>
      </div>`).join('');
      container.innerHTML = '<div style="margin-top:6px">' + rows + '</div>';
    } catch(e){ container.innerHTML = '<span class="text-sm" style="color:var(--danger)">Error loading docs.</span>'; }
  }
  async function downloadDoc(path){
    const { data, error } = await CP.sb().storage.from('application-docs').createSignedUrl(path, 300);
    if(error || !data?.signedUrl){ S.toast('Could not get download link', 'error'); return; }
    window.open(data.signedUrl, '_blank');
  }

  // ───── Init ─────
  document.addEventListener('DOMContentLoaded', async () => {
    try { await waitReady(8000); }
    catch(e){
      const el = document.getElementById('apps-list');
      if(el) el.innerHTML = '<div class="empty"><h3>Could not load admin tools</h3><p>'+e.message+'</p></div>';
      return;
    }
    S = window.AdminShell;

    // ───── Wiring (after S is available) ─────
    S.on('toggle',       (t) => toggleDetail(t.dataset.id));
    S.on('status',       (t) => setStatus(t.dataset.id, t.dataset.appId, t.dataset.set));
    S.on('pay',          (t) => openPaySheet(t.dataset.id, t.dataset.appId, t.dataset.name));
    S.on('unpay',        (t) => markUnpaid(t.dataset.id));
    S.on('refund',       (t) => openRefundSheet(t.dataset.id, t.dataset.name));
    S.on('waive',        (t) => markWaived(t.dataset.id));
    S.on('resend',       (t) => openResendSheet(t.dataset.appId, t.dataset.status, t.dataset.name));
    S.on('hf-send',      (t) => openHoldingSendSheet(t.dataset.id, t.dataset.appId, t.dataset.name));
    S.on('hf-paid',      (t) => markHoldingPaid(t.dataset.id, t.dataset.appId, t.dataset.name));
    S.on('hf-undo',      (t) => undoHoldingPaid(t.dataset.id));
    S.on('docs',         (t) => loadDocs(t.dataset.id, t.dataset.appId));
    S.on('save-notes',   (t) => saveNotes(t.dataset.id));
    S.on('download-doc', (t) => downloadDoc(t.dataset.path));
    S.on('reload-apps',  () => loadApps());
    // Bulk-action handlers (Batch B #4)
    S.on('bulk-status',  (t) => bulkSetStatus(t.dataset.set));
    S.on('bulk-pay',     () => bulkMarkPaid());
    S.on('bulk-unpay',   () => bulkMarkUnpaid());
    S.on('bulk-waive',   () => bulkWaive());
    S.on('bulk-clear',   () => clearSelection());
    wireBulkSelection();

    // Pre-select chip from URL
    document.querySelectorAll('#filter-tabs .chip').forEach(b => {
      b.classList.toggle('active', b.dataset.status === _status);
    });

    document.getElementById('filter-tabs').addEventListener('click', async e => {
      const btn = e.target.closest('.chip');
      if(!btn) return;
      document.querySelectorAll('#filter-tabs .chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _status = btn.dataset.status;
      await loadApps();
    });

    document.getElementById('search-input').addEventListener('input', e => {
      _search = e.target.value;
      clearTimeout(_debounce);
      _debounce = setTimeout(loadApps, 350);
    });

    document.getElementById('pay-filter').addEventListener('change', e => {
      _payFilter = e.target.value;
      loadApps();
    });

    document.getElementById('btn-nudge-drafts').addEventListener('click', async () => {
      const btn = document.getElementById('btn-nudge-drafts');
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        const { ok: pOk, json: pJson } = await S.callFn('/nudge-expiring-drafts', { dry_run: true });
        if (!pOk) return;
        const count = pJson?.would_nudge ?? 0;
        if (count === 0) {
          S.toast('No drafts in the expiry window right now — nothing to nudge.', 'success', 4000);
          return;
        }
        const confirmed = window.confirm(
          `Found ${count} draft${count !== 1 ? 's' : ''} expiring within 48 hours that haven't been emailed yet.\n\nSend reminder email${count !== 1 ? 's' : ''} now?`
        );
        if (!confirmed) return;
        btn.textContent = 'Sending…';
        const { ok: dOk, json: dJson } = await S.callFn('/nudge-expiring-drafts', {});
        if (!dOk) return;
        const nudged = dJson?.nudged ?? count;
        const failed = dJson?.failed ?? 0;
        const msg = failed > 0
          ? `Sent ${nudged} nudge${nudged !== 1 ? 's' : ''}, ${failed} failed — check console.`
          : `Sent ${nudged} expiry reminder${nudged !== 1 ? 's' : ''} successfully.`;
        S.toast(msg, failed > 0 ? 'warn' : 'success', 5000);
      } finally {
        btn.disabled = false;
        btn.textContent = '📧 Nudge expiring';
      }
    });

    document.getElementById('btn-cleanup-drafts').addEventListener('click', async () => {
      const btn = document.getElementById('btn-cleanup-drafts');
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        const { ok: pOk, json: pJson } = await S.callFn('/cleanup-expired-drafts', { dry_run: true });
        if (!pOk) return;  // callFn already toasted the error
        const count = pJson?.would_delete ?? 0;
        if (count === 0) {
          S.toast('No expired drafts found — everything is clean.', 'success', 4000);
          return;
        }
        const confirmed = window.confirm(
          `Found ${count} draft application${count !== 1 ? 's' : ''} older than 7 days.\n\nDelete them permanently?`
        );
        if (!confirmed) return;
        btn.textContent = 'Deleting…';
        const { ok: dOk, json: dJson } = await S.callFn('/cleanup-expired-drafts', {});
        if (!dOk) return;
        const deleted = dJson?.deleted ?? count;
        S.toast(`Deleted ${deleted} expired draft${deleted !== 1 ? 's' : ''}.`, 'success', 5000);
      } finally {
        btn.disabled = false;
        btn.textContent = '🗑 Clean drafts';
      }
    });

    const okAuth = await S.requireAdmin();
    if(!okAuth) return;

    await loadApps().catch(err => {
      console.error('[applications] load failed', err);
      S.toast('Failed to load applications', 'error');
    });

    // Deep-link: ?id=APP-XXXX or ?id=<uuid> from dashboard / email-logs / audit-log.
    // Find the matching card, expand its detail panel, and scroll it into view.
    try {
      const targetId = (new URLSearchParams(location.search)).get('id');
      if(targetId){
        const t = String(targetId).trim();
        const match = _allData.find(a => String(a.app_id) === t || String(a.id) === t);
        if(match){
          await toggleDetail(match.id);
          const el = document.getElementById('card-' + match.id);
          if(el) el.scrollIntoView({ behavior:'smooth', block:'center' });
        } else {
          S.toast('Application ' + t + ' not found in the current view.', 'warn', 4000);
        }
      }
    } catch(e){ console.warn('[applications] deep-link failed', e); }
  });
})();
