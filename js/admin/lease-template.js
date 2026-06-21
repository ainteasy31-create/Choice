// Choice Properties — Admin: lease template editor (state-aware)
  //
  // Edits the active row in lease_templates per state, and publishes
  // immutable snapshots into lease_template_versions via
  // publish_lease_template(). Surfaces the full version history per
  // state so admins can see exactly what each pinned-by-application
  // snapshot contains.
  //
  // Phase 03 changes:
  //   - State selector at the top loads the active template for that
  //     state. Switching states re-loads.
  //   - legal_review_status badge displayed alongside the editor.
  //   - Publish writes p_state_code so the new version inherits it.
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
    let _activeId        = null;     // id of the lease_templates row we're editing
    let _activeStateCode = null;
    let _versions        = [];
    let _states          = [];       // [{state_code, state_name}]

    const REVIEW_LABEL = {
      statute_derived:    'Statute-derived',
      attorney_reviewed:  'Attorney-reviewed',
      outdated:           'Outdated',
    };

    const VARIABLES = [
      ['tenant_full_name',    'Primary applicant full name'],
      ['tenant_email',        'Primary applicant email'],
      ['tenant_phone',        'Primary applicant phone'],
      ['property_address',    'Property street address'],
      ['lease_start_date',    'Lease start date (formatted)'],
      ['lease_end_date',      'Lease end date (formatted)'],
      ['monthly_rent',        'Monthly rent (formatted)'],
      ['security_deposit',    'Security deposit (formatted)'],
      ['move_in_costs',       'Total due at move-in (formatted)'],
      ['landlord_name',       'Landlord legal name'],
      ['landlord_address',    'Landlord mailing address'],
      ['late_fee_flat',       'Late fee — flat (formatted)'],
      ['late_fee_daily',      'Late fee — daily (formatted)'],
      ['state_code',          'State code (2-letter)'],
      ['pets_policy',         'Pets policy clause'],
      ['smoking_policy',      'Smoking policy clause'],
      ['desired_lease_term',  'Desired lease term (text)'],
      ['app_id',              'Application ID'],
      ['signature_date',      'Tenant signature date (formatted)'],
      ['tenant_signature',    'Tenant typed signature'],
      ['co_applicant_signature', 'Co-applicant typed signature'],
    ];

    function fmtDateTime(s) {
      if (!s) return '—';
      try { return new Date(s).toLocaleString('en-US', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }
      catch { return s; }
    }

    function setReviewBadge(status) {
      const el = document.getElementById('tpl-review-badge');
      if (!el) return;
      const s = (status || 'statute_derived');
      el.className = 'review-badge ' + s;
      el.textContent = REVIEW_LABEL[s] || s;
    }

    function renderVarList() {
      const html = VARIABLES.map(([k, label]) =>
        `<div style="margin-bottom:8px">
           <span class="var-pill" data-var="${k}">{{${k}}}</span>
           <span class="text-xs muted" style="margin-left:6px">${S.esc(label)}</span>
         </div>`
      ).join('');
      document.getElementById('var-list').innerHTML = html;
      document.getElementById('var-list').addEventListener('click', e => {
        const pill = e.target.closest('.var-pill');
        if (!pill) return;
        const tok = '{{' + pill.dataset.var + '}}';
        const ta = document.getElementById('tpl-body');
        const start = ta.selectionStart, end = ta.selectionEnd;
        ta.value = ta.value.slice(0, start) + tok + ta.value.slice(end);
        ta.focus();
        ta.setSelectionRange(start + tok.length, start + tok.length);
      });
    }

    function renderVersions() {
      const el = document.getElementById('ver-list');
      document.getElementById('ver-count').textContent =
        _versions.length + ' version' + (_versions.length !== 1 ? 's' : '');
      if (!_versions.length) {
        el.innerHTML = '<div style="padding:14px;text-align:center" class="text-sm muted">No versions yet for this state. Click <strong>Save &amp; Publish</strong> to create v1.</div>';
        return;
      }
      el.innerHTML = _versions.map(v => {
        const reviewSlug  = v.legal_review_status || 'statute_derived';
        const reviewLabel = REVIEW_LABEL[reviewSlug] || reviewSlug;
        return `<div class="ver-row">
           <div style="flex:1;min-width:0">
             <span class="ver-num">v${v.version_number}</span>
             <span class="text-xs muted" style="margin-left:6px">${S.esc(fmtDateTime(v.published_at))}</span>
             ${v.published_by ? `<span class="text-xs muted" style="margin-left:6px">by ${S.esc(v.published_by)}</span>` : ''}
             <span class="review-badge ${reviewSlug}" style="margin-left:8px;font-size:.62rem;padding:1px 6px">${reviewLabel}</span>
             ${v.notes ? `<div class="text-xs" style="margin-top:3px;color:var(--text)">${S.esc(v.notes)}</div>` : ''}
           </div>
           <div>
             <button class="btn btn-ghost btn-sm" data-action="load-version" data-id="${S.esc(v.id)}">Load</button>
           </div>
         </div>`;
      }).join('');
    }

    async function loadStates() {
      const sb = CP.sb();
      const { data, error } = await sb.from('state_lease_law')
        .select('state_code, state_name').order('state_code', { ascending: true });
      if (error) { S.toast('Could not load states list: ' + error.message, 'error'); return; }
      _states = data || [];
      const sel = document.getElementById('state-filter');
      sel.innerHTML = '<option value="">— pick a state —</option>' +
        _states.map(s => `<option value="${S.esc(s.state_code)}">${S.esc(s.state_code)} — ${S.esc(s.state_name)}</option>`).join('');
    }

    async function loadTemplateForState(stateCode) {
      const sb = CP.sb();
      if (!stateCode) {
        _activeId = null; _activeStateCode = null; _versions = [];
        document.getElementById('tpl-name').value = '';
        document.getElementById('tpl-state').value = '';
        document.getElementById('tpl-body').value = '';
        document.getElementById('tpl-notes').value = '';
        document.getElementById('state-meta').textContent = 'Pick a state above to load that state\u2019s active lease template.';
        setReviewBadge('statute_derived');
        renderVersions();
        return;
      }

      document.getElementById('state-meta').textContent = 'Loading ' + stateCode + '\u2026';

      // Pull the active template for this state, falling back to the
      // most recently updated row if there is no active one.
      let tmpl = null;
      {
        const { data, error } = await sb.from('lease_templates')
          .select('*').eq('state_code', stateCode).eq('is_active', true)
          .order('updated_at', { ascending: false }).limit(1).maybeSingle();
        if (error) { S.toast('Could not load template: ' + error.message, 'error'); return; }
        tmpl = data;
      }
      if (!tmpl) {
        const { data } = await sb.from('lease_templates')
          .select('*').eq('state_code', stateCode)
          .order('updated_at', { ascending: false }).limit(1).maybeSingle();
        tmpl = data;
      }

      if (!tmpl) {
        _activeId = null; _activeStateCode = stateCode; _versions = [];
        document.getElementById('tpl-name').value = stateCode + ' Standard Residential Lease';
        document.getElementById('tpl-state').value = stateCode;
        document.getElementById('tpl-body').value = '';
        document.getElementById('tpl-notes').value = '';
        setReviewBadge('statute_derived');
        document.getElementById('state-meta').textContent =
          'No template exists yet for ' + stateCode + '. Use this editor to create v1.';
        renderVersions();
        return;
      }

      _activeId = tmpl.id;
      _activeStateCode = tmpl.state_code || stateCode;
      document.getElementById('tpl-name').value = tmpl.name || '';
      document.getElementById('tpl-state').value = tmpl.state_code || stateCode;
      document.getElementById('tpl-body').value = tmpl.template_body || '';
      document.getElementById('tpl-notes').value = '';
      setReviewBadge(tmpl.legal_review_status || 'statute_derived');

      const stateName = (_states.find(x => x.state_code === stateCode) || {}).state_name || stateCode;
      document.getElementById('state-meta').textContent =
        'Editing the active ' + stateName + ' (' + stateCode + ') template — ' +
        (REVIEW_LABEL[tmpl.legal_review_status || 'statute_derived']);

      // Load versions for this template id (if any)
      const { data: vers } = await sb.from('lease_template_versions')
        .select('id, version_number, name, published_by, published_at, notes, legal_review_status, state_code')
        .eq('template_id', _activeId)
        .order('version_number', { ascending: false });
      _versions = vers || [];
      renderVersions();
    }

    async function loadVersion(versionId) {
      const sb = CP.sb();
      const { data: v, error } = await sb.from('lease_template_versions')
        .select('*').eq('id', versionId).single();
      if (error || !v) { S.toast('Could not load version', 'error'); return; }
      document.getElementById('tpl-name').value = v.name || '';
      document.getElementById('tpl-body').value = v.template_body || '';
      document.getElementById('tpl-notes').value = v.notes || '';
      setReviewBadge(v.legal_review_status || 'statute_derived');
      S.toast(`Loaded v${v.version_number} into editor (not yet saved).`);
    }

    async function publish() {
      const stateCode = (_activeStateCode || document.getElementById('state-filter').value || '').toUpperCase();
      if (!stateCode) { S.toast('Pick a state at the top first.', 'error'); return; }

      const name = document.getElementById('tpl-name').value.trim();
      const body = document.getElementById('tpl-body').value;
      const notes = document.getElementById('tpl-notes').value.trim();

      if (!name) { S.toast('Template name is required', 'error'); return; }
      if (!body || body.length < 100) { S.toast('Template body looks too short. Are you sure?', 'error'); return; }

      const ok = await S.confirm({
        title: 'Publish new template version?',
        message: `A new immutable version will be created for ${stateCode}. Applications generated AFTER this point will use it. Existing applications keep their pinned snapshot.`,
        ok: 'Publish version',
      });
      if (!ok) return;

      const sb = CP.sb();
      const session = await CP.Auth.getSession();
      if (!session?.access_token) { S.toast('Session expired. Please sign in again.', 'error'); return; }

      // Pre-set state_code on the existing template BEFORE calling the RPC so the
      // unique-active-per-state index always sees the correct value from the moment
      // is_active is flipped to true — closing the race window.
      if (_activeId) {
        await sb.from('lease_templates').update({ state_code: stateCode }).eq('id', _activeId);
      }

      const { data, error } = await sb.rpc('publish_lease_template', {
        p_template_id:   _activeId,
        p_name:          name,
        p_template_body: body,
        p_variables:     { state_code: stateCode },
        p_notes:         notes || null,
        p_make_active:   true,
      });
      if (error) { S.toast('Publish failed: ' + error.message, 'error'); return; }
      if (!data?.success) { S.toast('Publish failed: ' + (data?.error || 'unknown'), 'error'); return; }

      // After publish, ensure the new template row and version both have state_code.
      // For existing templates the template row was already updated above; here we
      // handle newly-created templates and always stamp the version row.
      const tmplUpdateNeeded = data.template_id && !_activeId;
      if (data.template_id) {
        const updates = [];
        if (tmplUpdateNeeded) {
          updates.push(sb.from('lease_templates').update({ state_code: stateCode }).eq('id', data.template_id));
        }
        if (data.version_id) {
          updates.push(sb.from('lease_template_versions').update({ state_code: stateCode }).eq('id', data.version_id));
        }
        if (updates.length) await Promise.all(updates);
      }

      _activeId = data.template_id;
      document.getElementById('tpl-notes').value = '';
      S.toast(`Published v${data.version_number} for ${stateCode}.`, 'success');
      await loadTemplateForState(stateCode);
    }

    async function previewPDF() {
      const sb = CP.sb();
      const stateCode = _activeStateCode || document.getElementById('state-filter').value;
      if (!stateCode) { S.toast('Pick a state first.', 'error'); return; }

      // Find the most recent application for this state with a lease,
      // else any approved application for this state.
      let targetAppId = null;
      {
        const { data } = await sb.from('applications')
          .select('app_id').eq('lease_state_code', stateCode)
          .not('lease_pdf_url','is', null)
          .order('updated_at', { ascending:false }).limit(1);
        targetAppId = data?.[0]?.app_id;
      }
      if (!targetAppId) {
        const { data } = await sb.from('applications')
          .select('app_id').eq('lease_state_code', stateCode).eq('status','approved')
          .order('updated_at', { ascending:false }).limit(1);
        targetAppId = data?.[0]?.app_id;
      }
      if (!targetAppId) {
        S.toast('No approved applications in ' + stateCode + ' yet — preview needs at least one to render against.', 'error');
        return;
      }

      S.toast('Generating preview\u2026');
      const res = await S.callFn('/generate-lease', { app_id: targetAppId, dry_run: true });
      if (!res) return;
      if (!res.ok || !res.json.preview_url) { S.toast(res.json.error || 'Preview failed', 'error'); return; }
      window.open(res.json.preview_url, '_blank');
      S.toast('Preview opened. Note: preview reflects the saved active template, not unsaved editor changes.');
    }

    document.addEventListener('DOMContentLoaded', async () => {
      try { await waitReady(8000); }
      catch (e) {
        const main = document.querySelector('main');
        if (main) main.innerHTML = '<div class="empty"><h3>Could not load admin tools</h3><p>'+e.message+'</p></div>';
        return;
      }
      S = window.AdminShell;

      document.getElementById('btn-publish').addEventListener('click', publish);
      document.getElementById('btn-preview').addEventListener('click', previewPDF);
      document.getElementById('state-filter').addEventListener('change', e => loadTemplateForState(e.target.value));
      document.addEventListener('click', e => {
        const t = e.target.closest('[data-action="load-version"]');
        if (t) loadVersion(t.dataset.id);
      });

      renderVarList();

      const okAuth = await S.requireAdmin();
      if (!okAuth) return;

      await loadStates();

      // Default selection: pick the first state that has an active template
      // (most likely MI in current data); else leave blank.
      const sb = CP.sb();
      const { data: firstActive } = await sb.from('lease_templates')
        .select('state_code').eq('is_active', true)
        .order('updated_at', { ascending:false }).limit(1).maybeSingle();
      const defaultState = firstActive?.state_code || '';
      if (defaultState) {
        document.getElementById('state-filter').value = defaultState;
        await loadTemplateForState(defaultState);
      } else {
        await loadTemplateForState('');
      }
    });
  })();
  