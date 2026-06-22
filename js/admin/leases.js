(function(){
  'use strict';
  // I-410: Inline <script> at end of body runs DURING parsing — BEFORE deferred
  // scripts like cp-shell.js execute. So window.AdminShell is undefined here and
  // the previous early-return left the page spinning forever. Use the same
  // waitReady polling pattern used by properties.html / landlords.html instead.
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

  let _filter = 'all';
  let _rows = [];

  // ───────── Helpers ─────────
  function fmtDate(d){ if(!d) return '—'; try{ return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }catch{ return d; } }
  function fmtMoney(v){ if(v==null||v==='') return '—'; return '$' + Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }

  function leaseBadgeTone(s){
    return ({
      sent:'warn', awaiting_co_sign:'warn',
      signed:'success', co_signed:'success',
      voided:'danger', expired:'danger'
    })[s] || '';
  }
  function leaseBadgeLabel(s){
    return ({
      none:'No lease', sent:'Lease sent', awaiting_co_sign:'Awaiting co-sign',
      signed:'Signed', co_signed:'Fully executed',
      voided:'Voided', expired:'Expired'
    })[s] || (s || 'No lease');
  }

  // ───────── Card render ─────────
  function renderCard(app){
    const name = ((app.first_name||'') + ' ' + (app.last_name||'')).trim() || '(no name)';
    const prop = app.property_address || app.property_id || '—';
    const tone = leaseBadgeTone(app.lease_status);
    const labelText = leaseBadgeLabel(app.lease_status);
    const isCounter = !!app.management_cosigned;
    const sentLine   = app.lease_sent_date   ? `Sent ${S.esc(fmtDate(app.lease_sent_date))}` : '';
    const signedLine = app.lease_signed_date ? `Signed ${S.esc(fmtDate(app.lease_signed_date))}` : '';
    const generateLabel = ['sent','signed','co_signed'].includes(app.lease_status) ? 'Regenerate & Send' : 'Generate & Send';
    return `<div class="card" style="margin-bottom:12px" id="lcard-${S.esc(app.id)}">
      <div class="card-body">
        <div class="row-flex between" style="align-items:flex-start;gap:12px">
          <div style="min-width:0;flex:1">
            <div class="text-xs muted" style="font-family:ui-monospace,monospace;letter-spacing:.04em">${S.esc(app.app_id||app.id)}</div>
            <div class="text-strong" style="font-size:1rem;margin-top:2px">${S.esc(name)}</div>
            <div class="text-sm muted" style="margin-top:2px">${S.esc(prop)}</div>
            <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
              <span class="badge ${tone}">${S.esc(labelText)}</span>
              ${isCounter ? '<span class="badge success">Countersigned</span>' : ''}
              ${app.has_co_applicant ? '<span class="badge">Co-applicant</span>' : ''}
            </div>
          </div>
          <div class="text-xs muted" style="text-align:right;flex-shrink:0;line-height:1.5">
            ${sentLine ? `<div>${sentLine}</div>` : ''}
            ${signedLine ? `<div style="color:var(--success);font-weight:600">${signedLine}</div>` : ''}
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:14px 0;padding:12px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
          <div><div class="text-xs muted">Lease start</div><div class="text-sm text-strong">${fmtDate(app.lease_start_date)}</div></div>
          <div><div class="text-xs muted">Lease end</div><div class="text-sm text-strong">${fmtDate(app.lease_end_date)}</div></div>
          <div><div class="text-xs muted">Monthly rent</div><div class="text-sm text-strong">${fmtMoney(app.monthly_rent)}</div></div>
          <div><div class="text-xs muted">Security deposit</div><div class="text-sm text-strong">${fmtMoney(app.security_deposit)}</div></div>
          <div><div class="text-xs muted">Move-in costs</div><div class="text-sm text-strong">${fmtMoney(app.move_in_costs)}</div></div>
          <div><div class="text-xs muted">Tenant signed</div><div class="text-sm text-strong">${app.signature_timestamp ? fmtDate(app.signature_timestamp) : 'Not yet'}</div></div>
        </div>

        <div class="row-flex gap-2" style="flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" data-action="generate" data-id="${S.esc(app.id)}" data-app-id="${S.esc(app.app_id||'')}">${generateLabel}</button>
          <a class="btn btn-ghost btn-sm" href="/admin/lease-detail.html?app_id=${encodeURIComponent(app.app_id||'')}">Detail &amp; history</a>
          ${app.lease_pdf_url ? `<button class="btn btn-ghost btn-sm" data-action="download" data-app-id="${S.esc(app.app_id||'')}"><svg class="i i-sm"><use href="#i-out"/></svg> Download PDF</button>` : ''}
          ${app.lease_status === 'sent' ? `<button class="btn btn-ghost btn-sm" data-action="remind" data-app-id="${S.esc(app.app_id||'')}"><svg class="i i-sm"><use href="#i-bell"/></svg> Send reminder</button>` : ''}
          ${app.lease_status === 'sent' ? `<button class="btn btn-ghost btn-sm" data-action="expiry-alert" data-app-id="${S.esc(app.app_id||'')}">&#9888; Expiry alert</button>` : ''}
          ${(app.lease_status === 'signed' || app.lease_status === 'co_signed') && !isCounter ? `<button class="btn btn-ghost btn-sm" data-action="cosign" data-id="${S.esc(app.id)}" data-app-id="${S.esc(app.app_id||'')}"><svg class="i i-sm"><use href="#i-check"/></svg> Countersign</button>` : ''}
          ${app.lease_status === 'sent' || app.lease_status === 'awaiting_co_sign' ? `<button class="btn btn-danger btn-sm" data-action="void" data-id="${S.esc(app.id)}">Void</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-action="toggle-detail" data-id="${S.esc(app.id)}">Notes</button>
        </div>

        <div id="ldetail-${S.esc(app.id)}" style="display:none;margin-top:12px;padding:12px;background:var(--surface-2);border-radius:var(--r-md);font-size:.82rem">
          ${app.lease_notes ? `<div style="margin-bottom:6px"><strong>Lease notes:</strong> ${S.esc(app.lease_notes)}</div>` : ''}
          <div class="text-sm muted"><strong>Email:</strong> ${S.esc(app.email||'—')} &nbsp;·&nbsp; <strong>Landlord email:</strong> ${S.esc(app.landlord_email||'—')}</div>
          ${app.tenant_signature ? `<div class="text-xs" style="color:var(--success);margin-top:6px">Tenant signed: ${fmtDate(app.signature_timestamp)}</div>` : ''}
          <div class="text-xs muted" style="margin-top:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:700">Admin notes</div>
          <textarea class="form-input" id="lnotes-${S.esc(app.id)}" rows="3" placeholder="Internal lease notes…">${S.esc(app.admin_notes||'')}</textarea>
          <div style="margin-top:8px"><button class="btn btn-ghost btn-sm" data-action="save-notes" data-id="${S.esc(app.id)}">Save notes</button></div>
        </div>
      </div>
    </div>`;
  }

  // ───────── Load ─────────
  async function load(){
    S.renderList('#leases-list', 'loading', { skeleton:5 });
    const filters = (_filter === 'all') ? { status:'approved' } : { lease_status:_filter };
    const res = await CP.Applications.getAll(filters).catch(e => ({ ok:false, error: e.message }));
    if(!res.ok){
      S.renderList('#leases-list', { error: res.error || 'Failed to load' });
      document.getElementById('count-label').textContent = '';
      return;
    }
    _rows = res.data || [];
    document.getElementById('count-label').textContent =
      _rows.length + ' record' + (_rows.length!==1?'s':'');
    document.querySelector('.appbar-sub').textContent =
      _filter === 'all' ? 'Approved applications' : ('Filter: ' + leaseBadgeLabel(_filter));
    if(!_rows.length){
      document.getElementById('leases-list').innerHTML =
        '<div class="empty"><svg class="i"><use href="#i-leases"/></svg>'+
        '<h3>No records</h3><p>No applications match this filter.</p></div>';
      return;
    }
    document.getElementById('leases-list').innerHTML = _rows.map(renderCard).join('');
  }

  function findApp(id){ return _rows.find(r => String(r.id) === String(id)); }

  // ───────── Generate / preview ─────────
  // I-407: All Edge Function calls go through S.callFn (cp-shell.js).
  // Local copy removed — was silently no-op'ing on missing CONFIG and
  // showing a single-line "Session expired" toast that users missed.
  // S.callFn now hard-redirects to login on missing token + visible toasts
  // for CONFIG / network / non-2xx failures.
  const callFn = (path, body) => S.callFn(path, body);

  // Phase 07 — itemized financials + utility responsibility matrix.
  //
  // The 13 standard utility keys must stay in sync with
  // _shared/utility-matrix.ts so the admin form, the JSONB on disk, and
  // the PDF renderer all agree.
  const UTILITY_KEYS = [
    ['electric',         'Electric'],
    ['gas',              'Gas'],
    ['water',            'Water'],
    ['sewer',            'Sewer'],
    ['trash',            'Trash / Garbage'],
    ['recycling',        'Recycling'],
    ['internet',         'Internet'],
    ['cable',            'Cable / Satellite TV'],
    ['hoa',              'HOA Dues'],
    ['lawn_care',        'Lawn Care'],
    ['snow_removal',     'Snow Removal'],
    ['pest_control',     'Pest Control'],
    ['pool_maintenance', 'Pool Maintenance'],
  ];
  const RESP_OPTS = [
    { value:'n/a',      label:'— Not applicable —' },
    { value:'tenant',   label:'Tenant' },
    { value:'landlord', label:'Landlord' },
    { value:'shared',   label:'Shared' },
  ];

  function existingUtility(app, key){
    const m = app.utility_responsibilities;
    if(!m || typeof m !== 'object') return { responsibility:'n/a', notes:'' };
    const v = m[key];
    if(v == null) return { responsibility:'n/a', notes:'' };
    if(typeof v === 'string') return { responsibility:v, notes:'' };
    return {
      responsibility: typeof v.responsibility === 'string' ? v.responsibility : 'n/a',
      notes:          typeof v.notes === 'string' ? v.notes : '',
    };
  }

  function buildUtilityMatrixHtml(app){
    const rows = UTILITY_KEYS.map(([key, label]) => {
      const cur = existingUtility(app, key);
      const sel = RESP_OPTS.map(o =>
        '<option value="'+o.value+'"'+(o.value===cur.responsibility?' selected':'')+'>'+o.label+'</option>'
      ).join('');
      return (
        '<tr>'+
          '<td style="padding:4px 6px;font-size:.78rem;color:var(--text)">'+label+'</td>'+
          '<td style="padding:4px 6px"><select class="form-input" name="util_resp_'+key+'" style="padding:4px 6px;font-size:.78rem">'+sel+'</select></td>'+
          '<td style="padding:4px 6px"><input class="form-input" type="text" name="util_notes_'+key+'" value="'+(cur.notes||'').replace(/"/g,'&quot;')+'" placeholder="optional" style="padding:4px 6px;font-size:.78rem"></td>'+
        '</tr>'
      );
    }).join('');
    return (
      '<div style="font-size:.78rem;color:var(--muted);margin-bottom:6px">'+
        'Pick who pays for each utility. Rows left as "Not applicable" are hidden from the lease.'+
      '</div>'+
      '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.78rem">'+
        '<thead><tr style="background:var(--surface-2)">'+
          '<th style="padding:4px 6px;text-align:left">Utility</th>'+
          '<th style="padding:4px 6px;text-align:left">Paid by</th>'+
          '<th style="padding:4px 6px;text-align:left">Notes</th>'+
        '</tr></thead><tbody>'+rows+'</tbody></table></div>'
    );
  }

  async function openGenerateSheet(id, appId){
    const app = findApp(id) || {};
    // Warn before overwriting a lease the tenant has already signed
    if(['signed','co_signed'].includes(app.lease_status)){
      const proceed = await S.confirm({
        title: 'Regenerate signed lease?',
        message: 'The tenant has already signed this lease. Regenerating will send a new signing link, invalidating their existing signature. This cannot be undone.',
        ok: 'Yes, regenerate',
        danger: true
      });
      if(!proceed) return;
    }
    const moneyVal = (v) => (v == null || v === '') ? '' : v;

    const data = await S.formSheet({
      title: 'Generate & send lease',
      submit: 'Generate & send',
      fields: [
        // ───────── Lease basics ─────────
        { type:'section', label:'Lease basics' },
        { name:'lease_start_date',  label:'Lease start date', type:'date', value: app.lease_start_date ? String(app.lease_start_date).slice(0,10) : '' },
        { name:'lease_end_date',    label:'Lease end date',   type:'date', value: app.lease_end_date   ? String(app.lease_end_date).slice(0,10)   : '' },
        { name:'monthly_rent',      label:'Monthly rent ($)', type:'number', value: moneyVal(app.monthly_rent), placeholder:'1200.00' },
        { name:'lease_state_code',  label:'State code (2-letter)', value: app.lease_state_code || 'MI', placeholder:'MI' },

        // ───────── Itemized financials (Phase 07) ─────────
        { type:'section', label:'Itemized financials',
          help:'Replace the lump-sum "Move-in costs" with discrete components. Leave blank to skip a row.' },
        { name:'first_month_rent',  label:'First month rent ($)',  type:'number', value: moneyVal(app.first_month_rent),
          placeholder:'(defaults to monthly rent if blank)' },
        { name:'last_month_rent',   label:'Last month rent ($)',   type:'number', value: moneyVal(app.last_month_rent),  placeholder:'optional' },
        { name:'security_deposit',  label:'Security deposit ($)',  type:'number', value: moneyVal(app.security_deposit), placeholder:'1200.00' },
        { name:'pet_deposit',       label:'Pet deposit ($)',       type:'number', value: moneyVal(app.pet_deposit),      placeholder:'optional' },
        { name:'pet_rent',          label:'Pet rent ($/month)',    type:'number', value: moneyVal(app.pet_rent),         placeholder:'optional' },
        { name:'admin_fee',         label:'Administrative fee ($)',type:'number', value: moneyVal(app.admin_fee),        placeholder:'optional' },
        { name:'key_deposit',       label:'Key deposit ($)',       type:'number', value: moneyVal(app.key_deposit),      placeholder:'optional' },
        { name:'parking_fee',       label:'Parking fee ($/month)', type:'number', value: moneyVal(app.parking_fee),      placeholder:'optional' },
        { name:'cleaning_fee',      label:'Cleaning fee ($)',      type:'number', value: moneyVal(app.cleaning_fee),     placeholder:'optional' },
        { name:'cleaning_fee_refundable', type:'checkbox', label:'Cleaning fee refundable', checkLabel:'Cleaning fee is refundable (required in CA, MD)', value: app.cleaning_fee_refundable === true },
        { name:'rent_due_day_of_month', label:'Rent due day of month (1–28)', type:'number', value: app.rent_due_day_of_month || 1, placeholder:'1' },
        { name:'rent_proration_method', label:'First-month proration method', type:'select',
          value: app.rent_proration_method || 'daily',
          options: [
            { value:'daily',  label:'Daily — rent ÷ days in move-in month × days occupied' },
            { value:'30day',  label:'30-day — rent ÷ 30 × days occupied' },
            { value:'none',   label:'None — full month charged regardless' },
          ] },

        // Legacy lump-sum (kept editable for backward compat — leave blank to use itemized total)
        { name:'move_in_costs', label:'Legacy move-in lump sum ($) — optional override', type:'number',
          value: moneyVal(app.move_in_costs),
          placeholder:'(leave blank to use itemized total)',
          help:'Backward-compatibility field. If left blank, the lease uses the sum of the itemized components above.' },

        { name:'lease_late_fee_flat', label:'Late fee (flat $)', type:'number', value: moneyVal(app.lease_late_fee_flat), placeholder:'50' },

        // ───────── Utility responsibility matrix (Phase 07) ─────────
        { type:'section', label:'Utility responsibility matrix' },
        { type:'html', html: buildUtilityMatrixHtml(app) },

        // ───────── Policies & landlord ─────────
        { type:'section', label:'Policies & landlord' },
        { name:'lease_landlord_name',    label:'Landlord name',    value: app.lease_landlord_name    || 'Choice Properties' },
        { name:'lease_landlord_address', label:'Landlord address', value: app.lease_landlord_address || '2265 Livernois Suite 500, Troy MI 48083' },
        { name:'lease_pets_policy',      label:'Pets policy',      value: app.lease_pets_policy     || '', placeholder:'No pets allowed.' },
        { name:'lease_smoking_policy',   label:'Smoking policy',   value: app.lease_smoking_policy  || '', placeholder:'No smoking permitted on premises.' },
        { name:'lease_notes',            label:'Lease notes (internal)', type:'textarea', rows:2, value: app.lease_notes || '' },
        { name:'preview_only', type:'checkbox', label:'Preview only', checkLabel:'Preview PDF without sending email', value:false }
      ]
    });
    if(!data) return;

    // Validate lease date range
    if(data.lease_start_date && data.lease_end_date && data.lease_end_date <= data.lease_start_date){
      S.toast('Lease end date must be after start date.', 'error');
      return;
    }

    // The utility matrix selects/inputs aren't in formSheet's standard
    // FormData pass-through (they live inside the type:'html' block), so
    // we read them directly off the still-mounted form just before submit.
    // formSheet has already closed the sheet by the time it resolves, so
    // we mirror its DOM lookup using the rendered selects' generated names.
    // Workaround: since the sheet is already torn down, capture the
    // utility values from `data` itself — formSheet's FormData walk picks
    // up native form controls regardless of where they were embedded.
    const utility_responsibilities = {};
    UTILITY_KEYS.forEach(([key]) => {
      const r = data['util_resp_'+key];
      const n = data['util_notes_'+key];
      utility_responsibilities[key] = {
        responsibility: (typeof r === 'string' && r) ? r : 'n/a',
        notes:          (typeof n === 'string') ? n.trim() : '',
      };
    });

    const num = (v) => (v == null || v === '') ? null : (Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);

    const leaseData = {
      lease_start_date:       data.lease_start_date || null,
      lease_end_date:         data.lease_end_date   || null,
      monthly_rent:           num(data.monthly_rent),
      security_deposit:       num(data.security_deposit),
      move_in_costs:          num(data.move_in_costs),
      lease_late_fee_flat:    num(data.lease_late_fee_flat),
      lease_landlord_name:    data.lease_landlord_name    || 'Choice Properties',
      lease_landlord_address: data.lease_landlord_address || '2265 Livernois Suite 500, Troy MI 48083',
      lease_state_code:       data.lease_state_code       || 'MI',
      lease_pets_policy:      data.lease_pets_policy      || null,
      lease_smoking_policy:   data.lease_smoking_policy   || null,
      lease_notes:            data.lease_notes            || null,

      // Phase 07 — itemized financials
      first_month_rent:        num(data.first_month_rent),
      last_month_rent:         num(data.last_month_rent),
      pet_deposit:             num(data.pet_deposit),
      pet_rent:                num(data.pet_rent),
      admin_fee:               num(data.admin_fee),
      key_deposit:             num(data.key_deposit),
      parking_fee:             num(data.parking_fee),
      cleaning_fee:            num(data.cleaning_fee),
      cleaning_fee_refundable: data.cleaning_fee_refundable === 'on'
                                 || data.cleaning_fee_refundable === true
                                 || data.cleaning_fee_refundable === 'true',
      rent_due_day_of_month:   (() => {
                                 const v = parseInt(data.rent_due_day_of_month, 10);
                                 return Number.isFinite(v) ? Math.max(1, Math.min(28, v)) : 1;
                               })(),
      rent_proration_method:   data.rent_proration_method || 'daily',
      application_fee:         num(app.application_fee),
      utility_responsibilities,
    };

    const dryRun = !!(data.preview_only === 'on' || data.preview_only === true || data.preview_only === 'true');
    S.toast(dryRun ? 'Generating preview…' : 'Generating lease…');
    const res = await callFn('/generate-lease', { app_id: appId, lease_data: leaseData, dry_run: dryRun });
    if(!res){ return; }
    if(!res.ok){ S.toast(res.json.error || 'Generation failed', 'error'); return; }
    if(dryRun && res.json.preview_url){ window.open(res.json.preview_url, '_blank'); S.toast('Preview ready.'); return; }
    S.toast('Lease generated and signing email sent!', 'success');
    await load();
  }

  async function openCosignSheet(id, appId){
    const data = await S.formSheet({
      title: 'Management countersignature',
      submit: 'Countersign lease',
      fields: [
        { name:'signer_name', label:'Management signer name', required:true, placeholder:'e.g. John Smith, Property Manager' },
        { name:'notes', label:'Internal notes (optional)', type:'textarea', rows:2 }
      ]
    });
    if(!data) return;
    if(!data.signer_name || !data.signer_name.trim()){ S.toast('Signer name is required','error'); return; }
    S.toast('Counter-signing…');
    const res = await callFn('/countersign', { app_id: appId, signer_name: data.signer_name.trim(), notes: (data.notes||'').trim() });
    if(!res) return;
    if(!res.ok){ S.toast(res.json.error || 'Countersign failed','error'); return; }
    S.toast('Lease countersigned. Fully-executed email sent.','success');
    await load();
  }

  async function sendReminder(appId){
    const ok = await S.confirm({ title:'Send signing reminder?', message:'A reminder email will be sent to the tenant.', ok:'Send reminder' });
    if(!ok) return;
    const res = await S.callFn('/send-email', { app_id: appId, type:'lease_signing_reminder' });
    if(!res || !res.ok){ S.toast('Email failed: ' + ((res && res.json && res.json.error) || 'Unknown error'),'error'); return; }
    S.toast('Reminder sent to tenant.','success');
  }

  async function sendExpiryAlert(appId){
    const ok = await S.confirm({ title:'Send unsigned-lease alert?', message:'An alert email will be sent to all admin addresses flagging this unsigned lease. Use when a lease has been pending signature too long.', ok:'Send alert' });
    if(!ok) return;
    const res = await S.callFn('/send-email', { app_id: appId, type:'lease_expiry_alert' });
    if(!res || !res.ok){ S.toast('Alert failed: ' + ((res && res.json && res.json.error) || 'Unknown error'),'error'); return; }
    S.toast('Expiry alert sent to admin.','success');
  }

  async function voidLease(id){
    const ok = await S.confirm({ title:'Void this lease?', message:'The tenant will no longer be able to sign. This cannot be undone.', ok:'Void lease', danger:true });
    if(!ok) return;
    const { error } = await CP.sb().from('applications')
      .update({ lease_status:'voided', updated_at: new Date().toISOString() })
      .eq('id', id);
    if(error){ S.toast('Error: ' + error.message,'error'); return; }
    S.toast('Lease voided.','success');
    await load();
  }

  async function downloadLease(appId){
    S.toast('Generating download link…');
    const res = await callFn('/download-lease', { app_id: appId });
    if(!res) return;
    if(!res.ok || !res.json.signed_url){ S.toast(res.json.error || 'Could not get download link','error'); return; }
    window.open(res.json.signed_url, '_blank');
  }

  async function saveNotes(id){
    const ta = document.getElementById('lnotes-' + id);
    if(!ta) return;
    const { ok, error } = await CP.Applications.saveNotes(id, ta.value);
    if(!ok){ S.toast('Error: ' + error,'error'); return; }
    S.toast('Notes saved.');
  }

  function toggleDetail(id){
    const el = document.getElementById('ldetail-' + id);
    if(!el) return;
    el.style.display = (el.style.display === 'block') ? 'none' : 'block';
  }

  document.addEventListener('DOMContentLoaded', async () => {
    try { await waitReady(8000); }
    catch(e){
      const el = document.getElementById('leases-list');
      if(el) el.innerHTML = '<div class="empty"><h3>Could not load admin tools</h3><p>'+e.message+'</p></div>';
      return;
    }
    S = window.AdminShell;

    // ───────── Wiring (after S is available) ─────────
    S.on('generate',      (t) => openGenerateSheet(t.dataset.id, t.dataset.appId));
    S.on('cosign',        (t) => openCosignSheet(t.dataset.id, t.dataset.appId));
    S.on('remind',        (t) => sendReminder(t.dataset.appId));
    S.on('expiry-alert',  (t) => sendExpiryAlert(t.dataset.appId));
    S.on('void',          (t) => voidLease(t.dataset.id));
    S.on('download',      (t) => downloadLease(t.dataset.appId));
    S.on('save-notes',    (t) => saveNotes(t.dataset.id));
    S.on('toggle-detail', (t) => toggleDetail(t.dataset.id));

    document.getElementById('btn-check-renewals').addEventListener('click', async () => {
      const action = await new Promise(resolve => {
        S.confirm({
          title:'Check lease renewals',
          message:'Preview which tenants are within 70 days of their lease end (and have not been nudged in the last 14 days). You can then send the renewal emails.',
          ok:'Preview only',
        }).then(ok => resolve(ok ? 'preview' : null));
      });
      if (!action) return;

      S.toast('Checking renewals…');
      const preview = await callFn('/check-renewals', { dry_run:true });
      if (!preview || !preview.ok) { S.toast(preview?.json?.error || 'Check failed','error'); return; }
      const j = preview.json;
      if (!j.eligible_for_nudge) {
        S.toast(`No tenants need a renewal nudge right now. (${j.total_in_window} in window)`, 'success');
        return;
      }
      const sendOk = await S.confirm({
        title:`Send ${j.eligible_for_nudge} renewal email${j.eligible_for_nudge===1?'':'s'}?`,
        message: j.candidates.slice(0,8).map(c =>
          `• ${c.email} — ${c.days_until_end} days remaining (${c.app_id})`
        ).join('\n') + (j.candidates.length > 8 ? `\n…and ${j.candidates.length-8} more` : ''),
        ok:'Send renewal emails',
      });
      if (!sendOk) return;
      S.toast('Sending…');
      const send = await callFn('/check-renewals', {});
      if (!send || !send.ok) { S.toast(send?.json?.error || 'Send failed','error'); return; }
      S.toast(`Sent ${send.json.sent_count}, failed ${send.json.failed_count}.`, 'success');
    });

    document.getElementById('filter-tabs').addEventListener('click', async e => {
      const btn = e.target.closest('.chip');
      if(!btn) return;
      document.querySelectorAll('#filter-tabs .chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _filter = btn.dataset.lease;
      await load();
    });

    // Pre-filter from URL param — e.g. dashboard links to ?lease_status=signed
    const _urlLease = new URLSearchParams(location.search).get('lease_status');
    if (_urlLease) {
      _filter = _urlLease;
      const chip = document.querySelector(`#filter-tabs [data-lease="${_urlLease}"]`);
      if (chip) {
        document.querySelectorAll('#filter-tabs .chip').forEach(b => b.classList.remove('active'));
        chip.classList.add('active');
      }
    }

    const okAuth = await S.requireAdmin();
    if(!okAuth) return;
    await load().catch(err => {
      console.error('[leases] load failed', err);
      S.toast('Failed to load leases','error');
    });
  });
})();
