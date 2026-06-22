// ─────────────────────────────────────────────────────────────────────
// admin/deposit-accounting.js — Phase 09 chunk 4/5
//
// Admin index of all applications that have a recorded move-out date
// (applications.move_out_date_actual IS NOT NULL). For each one we
// surface the security-deposit accounting state:
//   - whether a lease_deposit_accountings row exists yet
//   - how many deductions are itemized
//   - whether the letter PDF has been generated
//   - whether we're past the per-state return deadline (LATE pill)
//   - whether the tenant has filed a dispute
//
// Clicking "Edit" opens a modal where the admin can:
//   - Add / remove / edit deduction line-items
//   - Click "Recompute totals" to call generate-deposit-letter with
//     dry_run=true, so the totals + late_generated flag refresh from
//     the server without rendering a PDF
//   - Click "Generate & finalize letter" to render + persist the PDF
//     (chunk 2 edge fn). On success, a download link to the PDF is
//     surfaced and lease_pdf_versions gets a new row.
// ─────────────────────────────────────────────────────────────────────

(function(){
  'use strict';

  const VALID_CATS = [
    ['rent_arrears',      'Unpaid rent'],
    ['cleaning',          'Cleaning'],
    ['damages',           'Property damage'],
    ['unpaid_utilities',  'Unpaid utilities'],
    ['early_termination', 'Early-termination charges'],
    ['other',             'Other'],
  ];
  const PDF_BUCKET = 'lease-pdfs';

  let _all      = [];           // raw join rows (apps + accounting + counts)
  let _filter   = 'all';
  let _search   = '';
  let _editing  = null;          // currently-edited row (in modal)
  let _editingDeds = [];         // working set of deductions in modal
  let _editingNotes = '';
  let _editingTotals = null;     // last computed totals from dry_run

  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);}
  function fmtMoney(n){const v=Number.isFinite(Number(n))?Number(n):0;return '$'+v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');}
  function fmtDate(d){if(!d)return '—';try{return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});}catch{return d;}}
  function fmtDateLong(d){if(!d)return '—';try{return new Date(d).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});}catch{return d;}}
  function todayISO(){return new Date().toISOString().slice(0,10);}
  function $(s, root){return (root||document).querySelector(s);}
  function $$(s, root){return Array.from((root||document).querySelectorAll(s));}

  function toast(msg, kind){
    // Delegate to AdminShell when available (consistent portal toasts)
    if(window.AdminShell && AdminShell.toast){
      AdminShell.toast(msg, kind === 'error' ? 'error' : kind === 'ok' ? 'success' : undefined);
      return;
    }
    // Fallback: in-page toast (for edge cases where AdminShell hasn't loaded)
    const t = $('#toast');
    if(!t) return;
    t.textContent = msg;
    t.className = 'toast show ' + (kind || 'ok');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = 'toast'; }, kind === 'error' ? 5500 : 3500);
  }

  // ── Load: apps with move_out_date_actual + their accounting ──────
  async function load(){
    const sb = window.CP && window.CP.sb && window.CP.sb();
    if (!sb) { $('#loading').textContent = 'Auth not ready.'; return; }

    // Apps + accountings fetched in parallel for speed
    const [appsResult, accsAllResult] = await Promise.all([
      sb.from('applications')
        .select(`id, app_id, first_name, last_name, email,
                 property_address,
                 move_in_date_actual, move_out_date_actual,
                 lease_state_code, security_deposit, pet_deposit, key_deposit,
                 updated_at, created_at`)
        .not('move_out_date_actual', 'is', null)
        .order('move_out_date_actual', { ascending: false })
        .limit(500),
      sb.from('lease_deposit_accountings')
        .select(`id, app_id, total_deposit_held, amount_withheld,
                 refund_owed_to_tenant, interest_accrued,
                 state_code_snapshot, state_return_days_snapshot,
                 state_return_deadline, late_generated,
                 letter_pdf_path, letter_pdf_sha256, letter_pdf_bytes,
                 generated_at, sent_at, tenant_disputed_at,
                 admin_notes, lease_termination_id`)
        .order('created_at', { ascending: false })
        .limit(500)
    ]);
    const { data: apps, error: appErr } = appsResult;
    if (appErr) {
      $('#loading').textContent = 'Failed to load: ' + appErr.message;
      return;
    }
    if (!apps || !apps.length) {
      $('#loading').style.display = 'none';
      $('#empty').style.display = 'block';
      $('#summary').innerHTML = renderSummary([]);
      return;
    }
    const appIds = apps.map(a => a.id);

    // Filter accountings to only those matching our app IDs (already fetched above)
    const accs = (accsAllResult.data || []).filter(a => appIds.includes(a.app_id));
    const accByApp = new Map();
    for (const a of (accs || [])) accByApp.set(a.app_id, a);

    // Deduction counts
    const accIds = (accs || []).map(a => a.id);
    const dedCount = new Map();
    if (accIds.length) {
      const { data: deds } = await sb
        .from('lease_deposit_deductions')
        .select('accounting_id, amount')
        .in('accounting_id', accIds);
      for (const d of (deds || [])) {
        const cur = dedCount.get(d.accounting_id) || { n: 0, sum: 0 };
        cur.n++; cur.sum += Number(d.amount) || 0;
        dedCount.set(d.accounting_id, cur);
      }
    }

    _all = apps.map(app => {
      const acc = accByApp.get(app.id) || null;
      const dc  = acc ? (dedCount.get(acc.id) || { n: 0, sum: 0 }) : { n: 0, sum: 0 };
      const today = todayISO();
      const isLatePotential = acc?.state_return_deadline && today > acc.state_return_deadline && !acc.generated_at;
      return { app, acc, ded_count: dc.n, ded_sum: dc.sum, late_potential: isLatePotential };
    });

    $('#loading').style.display = 'none';
    document.body.dataset.pageSub = `${_all.length} application${_all.length===1?'':'s'} with move-out`;
    render();
  }

  // ── Render: list ─────────────────────────────────────────────────
  function renderSummary(rows){
    const total     = rows.length;
    const withAcct  = rows.filter(r => r.acc).length;
    const generated = rows.filter(r => r.acc?.generated_at).length;
    const late      = rows.filter(r => r.acc?.late_generated || r.late_potential).length;
    const disputed  = rows.filter(r => r.acc?.tenant_disputed_at).length;
    return `
      <div class="summary-tile"><div class="num">${total}</div><div class="lbl">Move-outs</div></div>
      <div class="summary-tile"><div class="num">${withAcct}</div><div class="lbl">Accountings opened</div></div>
      <div class="summary-tile ok"><div class="num">${generated}</div><div class="lbl">Letters generated</div></div>
      <div class="summary-tile late"><div class="num">${late}</div><div class="lbl">Past deadline</div></div>
      <div class="summary-tile warn"><div class="num">${disputed}</div><div class="lbl">Disputed</div></div>
    `;
  }

  function rowMatches(r){
    if (_filter === 'needs_letter' && r.acc?.generated_at) return false;
    if (_filter === 'late' && !(r.acc?.late_generated || r.late_potential)) return false;
    if (_filter === 'sent'      && !r.acc?.sent_at)            return false;
    if (_filter === 'disputed'  && !r.acc?.tenant_disputed_at) return false;
    if (_search) {
      const q = _search.toLowerCase();
      const a = r.app;
      const hay = [a.first_name, a.last_name, a.property_address, a.lease_state_code, a.app_id, a.email]
        .filter(Boolean).map(x => String(x).toLowerCase()).join(' ');
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function statusPills(r){
    const out = [];
    if (!r.acc) out.push('<span class="pill pill-muted">No accounting yet</span>');
    else if (!r.acc.generated_at) out.push('<span class="pill pill-warn">Draft (not generated)</span>');
    else out.push('<span class="pill pill-ok">Letter generated</span>');
    if (r.acc?.late_generated) out.push('<span class="pill pill-late">LATE generated</span>');
    else if (r.late_potential) out.push('<span class="pill pill-late">Past deadline</span>');
    if (r.acc?.tenant_disputed_at) out.push('<span class="pill pill-warn">Tenant disputed</span>');
    if (r.acc?.sent_at) out.push('<span class="pill pill-info">Sent ' + esc(fmtDate(r.acc.sent_at)) + '</span>');
    return out.join('');
  }

  function card(r){
    const a = r.app;
    const tenantName = ((a.first_name||'') + ' ' + (a.last_name||'')).trim() || 'Unknown';
    const stateCode = (a.lease_state_code || a.state || '').toUpperCase();
    const deposit = Number(a.security_deposit||0) + Number(a.pet_deposit||0) + Number(a.key_deposit||0);
    const refund = r.acc?.refund_owed_to_tenant != null
      ? fmtMoney(r.acc.refund_owed_to_tenant)
      : '—';
    return `
      <div class="dep-card" data-app-id="${esc(a.id)}">
        <div class="row-flex between" style="align-items:flex-start;flex-wrap:wrap;gap:12px">
          <div style="min-width:0;flex:1">
            <div class="text-xs muted" style="font-family:monospace">${esc(a.app_id || a.id)}</div>
            <div class="row-title">${esc(tenantName)}</div>
            <div class="row-sub">${esc(a.property_address || '—')}${a.city?' · '+esc(a.city):''}${stateCode?', '+esc(stateCode):''}</div>
            <div style="margin-top:6px">${statusPills(r)}</div>
          </div>
          <div style="text-align:right;min-width:160px">
            <div style="font-size:.7rem;color:var(--muted-2);text-transform:uppercase;letter-spacing:.06em;font-weight:700">Refund owed</div>
            <div style="font-size:1.25rem;font-weight:800;color:${r.acc?.refund_owed_to_tenant>0?'#86efac':'#fcd34d'}">${refund}</div>
            <button class="btn btn-primary" data-action="edit" style="margin-top:8px">${r.acc?.generated_at?'Review / Re-issue':r.acc?'Edit accounting':'Open accounting'}</button>
          </div>
        </div>
        <div class="dep-meta">
          <div><div class="k">Move-in</div><div class="v">${esc(fmtDate(a.move_in_date_actual))}</div></div>
          <div><div class="k">Move-out</div><div class="v">${esc(fmtDate(a.move_out_date_actual))}</div></div>
          <div><div class="k">Deposit held</div><div class="v">${esc(fmtMoney(deposit))}</div></div>
          <div><div class="k">Deductions</div><div class="v">${r.ded_count} item(s) — ${esc(fmtMoney(r.ded_sum))}</div></div>
          <div><div class="k">Return window</div><div class="v">${r.acc?.state_return_days_snapshot||'?'} days (${esc(stateCode||'?')})</div></div>
          <div><div class="k">Return deadline</div><div class="v" style="${r.late_potential?'color:#fca5a5':''}">${esc(fmtDate(r.acc?.state_return_deadline))}</div></div>
        </div>
      </div>
    `;
  }

  function render(){
    const matches = _all.filter(rowMatches);
    $('#summary').innerHTML = renderSummary(_all);
    if (!matches.length) {
      $('#list').innerHTML = '';
      $('#empty').style.display = 'block';
      return;
    }
    $('#empty').style.display = 'none';
    $('#list').innerHTML = matches.map(card).join('');
    $$('#list [data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', e => {
        const cardEl = e.target.closest('.dep-card');
        const id = cardEl?.dataset.appId;
        const row = _all.find(r => r.app.id === id);
        if (row) openEditor(row);
      });
    });
  }

  // ── Editor modal ─────────────────────────────────────────────────
  async function openEditor(row){
    _editing = row;
    _editingDeds = [];
    _editingTotals = null;
    _editingNotes = row.acc?.admin_notes || '';

    $('#editorTitle').textContent = `Deposit accounting · ${(row.app.first_name||'')+' '+(row.app.last_name||'')}`;
    $('#editorSub').textContent = `${row.app.property_address || ''}  ·  Move-out ${fmtDateLong(row.app.move_out_date_actual)}`;
    $('#adminNotes').value = _editingNotes;
    $('#btnDownload').style.display = row.acc?.letter_pdf_path ? 'inline-block' : 'none';

    // Late-generated banner
    const today = todayISO();
    const deadline = row.acc?.state_return_deadline;
    const lateBox = $('#editorLate');
    if (deadline && today > deadline && !row.acc?.generated_at) {
      lateBox.innerHTML = `<div class="late-banner"><strong>Past statutory deadline.</strong> The state-mandated return deadline for this lease was <strong>${esc(fmtDateLong(deadline))}</strong> (${row.acc?.state_return_days_snapshot} days). If you generate the letter now it will be flagged <strong>late_generated</strong> and visible to the tenant.</div>`;
    } else if (row.acc?.late_generated) {
      lateBox.innerHTML = `<div class="late-banner"><strong>This letter was generated past the statutory deadline.</strong> Deadline was <strong>${esc(fmtDateLong(deadline))}</strong>; the letter PDF carries a "GENERATED PAST STATUTORY DEADLINE" banner on its cover page.</div>`;
    } else {
      lateBox.innerHTML = '';
    }

    // Header grid
    const a = row.app;
    const stateCode = (a.lease_state_code || a.state || '').toUpperCase();
    const depositHeld = Number(a.security_deposit||0) + Number(a.pet_deposit||0) + Number(a.key_deposit||0);
    $('#editorGrid').innerHTML = `
      <div class="field"><div class="k">Application ID</div><div class="v" style="font-family:monospace;font-size:.74rem">${esc(a.app_id || a.id)}</div></div>
      <div class="field"><div class="k">State</div><div class="v">${esc(stateCode || '—')}</div></div>
      <div class="field"><div class="k">Return window</div><div class="v">${row.acc?.state_return_days_snapshot || '—'} days</div></div>
      <div class="field"><div class="k">Return deadline</div><div class="v">${esc(fmtDate(deadline))}</div></div>
      <div class="field"><div class="k">Deposit held</div><div class="v">${esc(fmtMoney(depositHeld))}</div></div>
      <div class="field"><div class="k">Generated</div><div class="v">${esc(fmtDate(row.acc?.generated_at))}</div></div>
    `;

    // Load existing deductions
    if (row.acc) {
      const sb = window.CP.sb();
      const { data: deds } = await sb
        .from('lease_deposit_deductions')
        .select('id, category, description, amount, sort_order')
        .eq('accounting_id', row.acc.id)
        .order('sort_order', { ascending: true });
      _editingDeds = (deds || []).map(d => ({
        category:    d.category,
        description: d.description || '',
        amount:      Number(d.amount) || 0,
        sort_order:  d.sort_order ?? 0,
      }));
    }
    if (!_editingDeds.length) _editingDeds = [];
    renderDeds();
    renderTotals();

    $('#editorBg').classList.add('open');
  }

  function closeEditor(){
    $('#editorBg').classList.remove('open');
    _editing = null; _editingDeds = []; _editingTotals = null;
  }

  function renderDeds(){
    const tbody = $('#dedRows');
    if (!_editingDeds.length) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted-2);padding:18px">No deductions — full deposit will be refunded.</td></tr>`;
      return;
    }
    tbody.innerHTML = _editingDeds.map((d, i) => `
      <tr data-idx="${i}">
        <td class="col-cat">
          <select data-field="category">
            ${VALID_CATS.map(([v, lbl]) => `<option value="${v}"${v===d.category?' selected':''}>${esc(lbl)}</option>`).join('')}
          </select>
        </td>
        <td><input type="text" data-field="description" value="${esc(d.description)}" placeholder="e.g. Patch &amp; paint living room (3 walls)"></td>
        <td class="col-amt"><input type="number" min="0" step="0.01" data-field="amount" value="${esc(d.amount)}"></td>
        <td class="col-act"><button class="icon-btn" data-action="del" title="Remove">&times;</button></td>
      </tr>
    `).join('');
    // Wire row inputs
    $$('#dedRows tr[data-idx]').forEach(tr => {
      const idx = Number(tr.dataset.idx);
      $$('input,select', tr).forEach(inp => {
        inp.addEventListener('input', () => {
          const f = inp.dataset.field;
          if (f === 'amount') _editingDeds[idx][f] = Number(inp.value) || 0;
          else _editingDeds[idx][f] = inp.value;
          // Live local total
          renderTotals(true);
        });
      });
      $('[data-action="del"]', tr).addEventListener('click', () => {
        _editingDeds.splice(idx, 1);
        renderDeds(); renderTotals(true);
      });
    });
  }

  function renderTotals(localOnly){
    const a = _editing?.app;
    if (!a) return;
    const held = Number(a.security_deposit||0) + Number(a.pet_deposit||0) + Number(a.key_deposit||0);
    const withheld = _editingDeds.reduce((s,d) => s + (Number(d.amount)||0), 0);
    const interest = Number(_editingTotals?.interest_accrued || 0);
    const refund   = Math.max(0, held - withheld + interest);
    const overWith = withheld > held + interest;
    $('#totalsBox').innerHTML = `
      <div class="dep-totals-row"><span>Total deposit held</span><span class="v">${esc(fmtMoney(held))}</span></div>
      <div class="dep-totals-row"><span>Itemized deductions</span><span class="v" style="color:#fca5a5">- ${esc(fmtMoney(withheld))}</span></div>
      <div class="dep-totals-row"><span>Interest accrued</span><span class="v">${esc(fmtMoney(interest))}</span></div>
      <div class="dep-totals-row emph"><span>Net refund owed to tenant</span><span class="v ${refund>0?'refund':'zero'}">${esc(fmtMoney(refund))}</span></div>
      ${overWith?'<div style="font-size:.78rem;color:#fca5a5;margin-top:4px">Withheld exceeds deposit held + interest. The letter will still generate; the tenant\'s account will reflect $0 refund (no negative balance).</div>':''}
      ${localOnly?'<div style="font-size:.7rem;color:var(--muted-2);margin-top:4px">Local preview — click "Recompute totals" to refresh server-side computation.</div>':''}
    `;
  }

  // ── Server actions: dry-run + finalize ───────────────────────────
  async function callEdge(payload){
    const token = await window.CP.Auth.getAccessToken();
    if (!token) {
      window.location.href = '/admin/login.html';
      throw new Error('Session expired — redirecting to login.');
    }
    const url = (window.CONFIG?.SUPABASE_URL || '') + '/functions/v1/generate-deposit-letter';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(payload),
    });
    if (resp.status === 401) {
      window.location.href = '/admin/login.html';
      throw new Error('Session expired — redirecting to login.');
    }
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body?.message || ('HTTP ' + resp.status));
    return body;
  }

  async function recomputeTotals(){
    if (!_editing) return;
    try {
      const result = await callEdge({
        app_id:      _editing.app.id,
        deductions:  _editingDeds.map((d, i) => ({
          category: d.category, description: d.description, amount: Number(d.amount)||0,
          sort_order: i, supporting_photo_paths: [], receipt_paths: [],
        })),
        interest_accrued: 0,
        admin_notes:      $('#adminNotes').value || null,
        dry_run:          true,
      });
      _editingTotals = result.totals;
      // Refresh _editing.acc with the latest server snapshot for late banner
      _editing.acc = Object.assign({}, _editing.acc || {}, {
        state_code_snapshot:        result.state_code,
        state_return_days_snapshot: result.state_return_days,
        state_return_deadline:      result.state_return_deadline,
        late_generated:             result.late_generated,
        total_deposit_held:         result.totals.total_deposit_held,
        amount_withheld:            result.totals.amount_withheld,
        refund_owed_to_tenant:      result.totals.refund_owed_to_tenant,
        interest_accrued:           result.totals.interest_accrued,
      });
      renderTotals();
      toast('Totals recomputed', 'ok');
    } catch (e) {
      console.error(e);
      toast('Recompute failed: ' + e.message, 'error');
    }
  }

  async function generateLetter(){
    if (!_editing) return;
    if (!confirm('Generate and finalize the deposit accounting letter PDF? This will replace any existing letter for this application.')) return;
    const btn = $('#btnGenerate');
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      const result = await callEdge({
        app_id:      _editing.app.id,
        deductions:  _editingDeds.map((d, i) => ({
          category: d.category, description: d.description, amount: Number(d.amount)||0,
          sort_order: i, supporting_photo_paths: [], receipt_paths: [],
        })),
        interest_accrued: 0,
        admin_notes:      $('#adminNotes').value || null,
        dry_run:          false,
      });
      toast(`Letter generated (${result.page_count} pages, ${(result.letter_pdf_bytes/1024).toFixed(1)} KB)`, 'ok');
      $('#btnDownload').style.display = 'inline-block';
      _editing.acc = Object.assign({}, _editing.acc || {}, {
        id:                         result.accounting_id,
        letter_pdf_path:            result.letter_pdf_path,
        letter_pdf_sha256:          result.letter_pdf_sha256,
        letter_pdf_bytes:           result.letter_pdf_bytes,
        late_generated:             result.late_generated,
        state_code_snapshot:        result.state_code,
        state_return_days_snapshot: result.state_return_days,
        state_return_deadline:      result.state_return_deadline,
        total_deposit_held:         result.totals.total_deposit_held,
        amount_withheld:            result.totals.amount_withheld,
        refund_owed_to_tenant:      result.totals.refund_owed_to_tenant,
        interest_accrued:           result.totals.interest_accrued,
        generated_at:               new Date().toISOString(),
      });
      _editing.ded_count = _editingDeds.length;
      _editing.ded_sum   = _editingDeds.reduce((s,d) => s+Number(d.amount||0), 0);
      render();
    } catch (e) {
      console.error(e);
      toast('Generate failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Generate & finalize letter';
    }
  }

  async function downloadLetter(){
    if (!_editing?.acc?.letter_pdf_path) return;
    try {
      const sb = window.CP.sb();
      const { data, error } = await sb.storage.from(PDF_BUCKET).createSignedUrl(_editing.acc.letter_pdf_path, 600);
      if (error || !data?.signedUrl) throw error || new Error('No signed URL');
      window.open(data.signedUrl, '_blank', 'noopener');
    } catch (e) {
      toast('Download link failed: ' + e.message, 'error');
    }
  }

  // ── Wire up DOM ──────────────────────────────────────────────────
  function wire(){
    $('#q').addEventListener('input', e => { _search = e.target.value || ''; render(); });
    $$('#chips .chip').forEach(btn => btn.addEventListener('click', () => {
      $$('#chips .chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _filter = btn.dataset.filter;
      render();
    }));
    $('#addDed').addEventListener('click', () => {
      _editingDeds.push({ category: 'damages', description: '', amount: 0, sort_order: _editingDeds.length });
      renderDeds(); renderTotals(true);
    });
    $('#btnCancel').addEventListener('click', closeEditor);
    $('#btnPreview').addEventListener('click', recomputeTotals);
    $('#btnGenerate').addEventListener('click', generateLetter);
    $('#btnDownload').addEventListener('click', downloadLetter);
    $('#editorBg').addEventListener('click', e => { if (e.target.id === 'editorBg') closeEditor(); });
  }

  let _bootAttempts = 0;
  function boot(){
    if (!window.AdminShell || !window.CP || !window.CP.sb) {
      if (++_bootAttempts > 100) { console.error('deposit-accounting: dependencies never loaded'); return; }
      setTimeout(boot, 80); return;
    }
    AdminShell.requireAdmin().then(ok => {
      if (!ok) return;
      wire();
      load();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
