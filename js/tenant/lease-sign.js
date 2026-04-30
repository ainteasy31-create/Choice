// Choice Properties - Tenant lease signing page (Phases 1.5 -> 12)
//
// One page handles three signer flows, identified by the URL:
//
//   /lease-sign.html?token=...              -> primary tenant OR co-applicant
//                                             (server resolves which via
//                                             lookup_signer_for_token)
//   /lease-sign.html?amendment_token=...    -> amendment (addendum) signing
//   /lease-sign.html?token=...&lang=es      -> force Spanish UI
//
// Phase 12 additions:
//   - SIGN_UI bilingual dictionary (EN / ES)
//   - T() translation helper
//   - detectLocale() — ?lang= URL param or app.negotiation_language
//   - renderAtAGlance() — plain-language lease summary panel
//   - WCAG 2.1 AA improvements wired through JS
//   - aria-disabled sync on buttons
(function () {
  'use strict';

  // HTML-escape helper
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);}

  // ---- Phase 12: i18n ------------------------------------------------
  // Self-contained dictionary so no network round-trip is needed.
  // Keys mirror _shared/i18n.ts STRINGS['sign_page.*'].
  const SIGN_UI = {
    en: {
      'header_sub':         'Lease Signing Portal',
      'loading':            'Loading your lease\u2026',
      'loading_wait':       'Please wait a moment.',
      'err_no_token_title': 'No Signing Token',
      'err_no_token_body':  'This page requires a valid signing link from your email.',
      'err_conn_title':     'Connection Error',
      'err_conn_body':      'Could not connect to the signing server. Please try again.',
      'err_expired_title':  'Link Expired or Invalid',
      'err_already_title':  'Already Signed',
      'success_title':      'Lease Signed Successfully',
      'success_body':       'Thank you! Your signature has been recorded and a confirmation email is on its way to you.',
      'success_view':       '\u21e9 View & Download',
      'atag_heading':       'Your Lease at a Glance',
      'atag_monthly_rent':  'Monthly Rent',
      'atag_property':      'Property',
      'atag_lease_term':    'Lease Term',
      'atag_term_to':       'to',
      'atag_deposit':       'Security Deposit',
      'atag_notice':        'Written notice required to end the tenancy \u2014 check the lease for the exact number of days.',
      'atag_late':          'A late fee may apply if rent is not received by the due date \u2014 see the full lease for details.',
      'atag_pets':          'All pets must be pre-approved in writing \u2014 check the addenda for the pet policy.',
      'card_subhead':       'Application ID:',
      'card_review':        'Please review carefully before signing.',
      'signer_primary':     'You are signing as the <strong>primary applicant</strong>',
      'signer_coapp':       'You are signing as the <strong>co-applicant</strong>. The primary applicant has already signed.',
      'signer_amend':       'You are signing a <strong>lease amendment</strong>. Your existing lease remains in effect.',
      'label_tenant':       'Tenant',
      'label_property':     'Property',
      'label_start':        'Lease Start',
      'label_end':          'Lease End',
      'label_rent':         'Monthly Rent',
      'label_deposit':      'Security Deposit',
      'label_for_tenant':   'For Tenant',
      'scroll_hint':        'Scroll to review full lease',
      'amend_notice':       'Amendment to your existing lease',
      'addenda_intro':      '<strong>Required disclosures and addenda.</strong> The following documents form an integral part of your lease and are required by federal, state, or local law. <strong>Please review each one and check the acknowledgment box</strong> before signing the lease below.',
      'addenda_all_acked':  '\u2713 All {n} addenda acknowledged',
      'addenda_progress':   '{done} of {n} addenda acknowledged',
      'ack_label':          'I have read and agree to this addendum ({title}).',
      'sign_title':         'Sign Your Lease',
      'sign_title_coapp':   'Sign as Co-Applicant',
      'sign_title_amend':   'Sign Amendment',
      'sign_help':          'Type your full legal name as your electronic signature, optionally draw your signature below, then check the agreement box.',
      'sign_help_coapp':    'By signing you become jointly and severally liable for the lease alongside the primary applicant.',
      'sign_help_amend':    'Type your full legal name to sign this amendment. Your original lease is unaffected.',
      'email_label':        'Your Email Address (the one we contacted you at)',
      'name_label':         'Full Legal Name (as it appears on your ID)',
      'name_placeholder':   'e.g. Jane Marie Doe',
      'sig_preview_empty':  'Your signature will appear here',
      'draw_label':         'Draw your signature (optional)',
      'draw_hint':          'For added verification \u00b7 the typed name above is what is legally binding',
      'pad_clear':          'Clear drawing',
      'agree_label':        'I have read and agree to all terms and conditions of this lease agreement and to each of the required addenda above. I understand this constitutes a legally binding electronic signature under the federal E-SIGN Act.',
      'btn_sign':           'Sign Lease Agreement',
      'btn_sign_coapp':     'Sign as Co-Applicant',
      'btn_sign_amend':     'Sign Amendment',
      'btn_submitting':     'Submitting\u2026',
      'err_conn':           'Connection error. Please try again.',
      'btn_consent_text':   'I Consent \u2014 Continue to the Document',
      'consent_submitting': 'Submitting\u2026',
    },
    es: {
      'header_sub':         'Portal de Firma de Contrato',
      'loading':            'Cargando su contrato\u2026',
      'loading_wait':       'Por favor espere un momento.',
      'err_no_token_title': 'Sin Token de Firma',
      'err_no_token_body':  'Esta p\u00e1gina requiere un enlace de firma v\u00e1lido de su correo electr\u00f3nico.',
      'err_conn_title':     'Error de Conexi\u00f3n',
      'err_conn_body':      'No se pudo conectar al servidor de firmas. Por favor intente de nuevo.',
      'err_expired_title':  'Enlace Vencido o No V\u00e1lido',
      'err_already_title':  'Ya Firmado',
      'success_title':      'Contrato Firmado Exitosamente',
      'success_body':       '\u00a1Gracias! Su firma ha sido registrada y un correo de confirmaci\u00f3n est\u00e1 en camino.',
      'success_view':       '\u21e9 Ver y Descargar',
      'atag_heading':       'Resumen de Su Contrato',
      'atag_monthly_rent':  'Renta Mensual',
      'atag_property':      'Propiedad',
      'atag_lease_term':    'Per\u00edodo de Arrendamiento',
      'atag_term_to':       'hasta',
      'atag_deposit':       'Dep\u00f3sito de Seguridad',
      'atag_notice':        'Se requiere aviso por escrito para terminar el arrendamiento \u2014 consulte el contrato para el n\u00famero exacto de d\u00edas.',
      'atag_late':          'Puede aplicarse un cargo por mora si la renta no se recibe en la fecha de vencimiento \u2014 consulte el contrato completo.',
      'atag_pets':          'Toda mascota debe ser pre-aprobada por escrito \u2014 consulte los adendos para la pol\u00edtica de mascotas.',
      'card_subhead':       'ID de Solicitud:',
      'card_review':        'Por favor revise cuidadosamente antes de firmar.',
      'signer_primary':     'Usted est\u00e1 firmando como <strong>solicitante principal</strong>',
      'signer_coapp':       'Usted est\u00e1 firmando como <strong>co-solicitante</strong>. El solicitante principal ya firm\u00f3.',
      'signer_amend':       'Usted est\u00e1 firmando una <strong>enmienda al contrato</strong>. Su contrato vigente permanece en efecto.',
      'label_tenant':       'Inquilino',
      'label_property':     'Propiedad',
      'label_start':        'Inicio del Contrato',
      'label_end':          'Fin del Contrato',
      'label_rent':         'Renta Mensual',
      'label_deposit':      'Dep\u00f3sito de Seguridad',
      'label_for_tenant':   'Para Inquilino',
      'scroll_hint':        'Desp\u00e1cese para revisar el contrato completo',
      'amend_notice':       'Enmienda a su contrato vigente',
      'addenda_intro':      '<strong>Divulgaciones y adendos requeridos.</strong> Los siguientes documentos forman parte integral de su contrato y son requeridos por ley federal, estatal o local. <strong>Por favor revise cada uno y marque la casilla de reconocimiento</strong> antes de firmar el contrato abajo.',
      'addenda_all_acked':  '\u2713 Los {n} adendos reconocidos',
      'addenda_progress':   '{done} de {n} adendos reconocidos',
      'ack_label':          'He le\u00eddo y acepto este adendo ({title}).',
      'sign_title':         'Firme Su Contrato',
      'sign_title_coapp':   'Firmar como Co-Solicitante',
      'sign_title_amend':   'Firmar Enmienda',
      'sign_help':          'Escriba su nombre legal completo como firma electr\u00f3nica, opcionalmente dibuje su firma abajo, luego marque la casilla de acuerdo.',
      'sign_help_coapp':    'Al firmar, usted se convierte en solidariamente responsable del contrato junto con el solicitante principal.',
      'sign_help_amend':    'Escriba su nombre legal completo para firmar esta enmienda. Su contrato original no se ve afectado.',
      'email_label':        'Su Correo Electr\u00f3nico (el que usamos para contactarle)',
      'name_label':         'Nombre Legal Completo (como aparece en su identificaci\u00f3n)',
      'name_placeholder':   'p. ej. Jane Marie Doe',
      'sig_preview_empty':  'Su firma aparecer\u00e1 aqu\u00ed',
      'draw_label':         'Dibuje su firma (opcional)',
      'draw_hint':          'Para verificaci\u00f3n adicional \u00b7 el nombre escrito arriba es el que tiene validez legal',
      'pad_clear':          'Borrar dibujo',
      'agree_label':        'He le\u00eddo y acepto todos los t\u00e9rminos y condiciones de este contrato de arrendamiento y de cada uno de los adendos requeridos arriba. Entiendo que esto constituye una firma electr\u00f3nica legalmente vinculante bajo la Ley Federal E-SIGN.',
      'btn_sign':           'Firmar Contrato de Arrendamiento',
      'btn_sign_coapp':     'Firmar como Co-Solicitante',
      'btn_sign_amend':     'Firmar Enmienda',
      'btn_submitting':     'Enviando\u2026',
      'err_conn':           'Error de conexi\u00f3n. Por favor intente de nuevo.',
      'btn_consent_text':   'Doy Mi Consentimiento \u2014 Continuar al Documento',
      'consent_submitting': 'Enviando\u2026',
    },
  };

  // Active locale — mutated by detectLocale()
  let _locale = 'en';

  /**
   * Translate a key from the SIGN_UI dictionary.
   * Supports {placeholder} substitution via the vars object.
   */
  function T(key, vars) {
    const dict = SIGN_UI[_locale] || SIGN_UI.en;
    const raw  = dict[key] != null ? dict[key] : (SIGN_UI.en[key] != null ? SIGN_UI.en[key] : key);
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] != null ? String(vars[k]) : ''));
  }

  /**
   * Detect and apply the locale for the signing session.
   * Priority: ?lang= URL param > app.negotiation_language > 'en'.
   * Updates document.documentElement.lang so screen readers announce correctly.
   */
  function detectLocale(app) {
    const urlLang = params.get('lang');
    const appLang = app && app.negotiation_language;
    const raw     = urlLang || appLang || 'en';
    const tag     = String(raw).toLowerCase().split(/[-_]/)[0];
    _locale = (tag === 'es') ? 'es' : 'en';
    document.documentElement.lang = _locale;
  }

  // ---- URL params -------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const token          = params.get('token');
  const amendmentToken = params.get('amendment_token');

  const SERVER_BASE = typeof CONFIG !== 'undefined' && CONFIG.SUPABASE_URL
    ? CONFIG.SUPABASE_URL + '/functions/v1' : '';
  const ANON_KEY    = typeof CONFIG !== 'undefined' ? (CONFIG.SUPABASE_ANON_KEY || '') : '';

  // ----- Mode (set after server response) -----
  let _mode = null;
  let _activeToken = null;
  let _appForLink = null;

  // Phase 04 - per-addendum ack state
  let _addendaSlugs = [];
  const _addendaAcked = new Set();

  // Phase 05 - E-SIGN consent state
  let _consentRequired       = false;
  let _disclosureVersion     = null;
  let _signerEmailFromServer = '';

  // ----- State helpers -----
  function showState(state) {
    ['loading', 'error', 'success', 'form'].forEach(s => {
      const el = document.getElementById('state-' + s);
      if (el) el.style.display = (s === state ? '' : 'none');
    });
  }
  function fmtMoney(v) {
    if (v == null || v === '') return '\u2014';
    return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 });
  }
  function fmtDate(d) {
    if (!d) return '\u2014';
    try { return new Date(d).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }); }
    catch { return d; }
  }

  // ---- Phase 12: at-a-glance summary panel ----------------------------
  function renderAtAGlance(app) {
    const section = document.getElementById('atag-section');
    if (!section || !app) return;

    const rentStr = fmtMoney(app.monthly_rent);
    const propStr = app.property_address || '\u2014';
    const startStr = fmtDate(app.lease_start_date);
    const endStr   = fmtDate(app.lease_end_date);
    const depStr   = fmtMoney(app.security_deposit);

    section.innerHTML = `
      <div class="atag-section" role="region" aria-label="${esc(T('atag_heading'))}">
        <div class="atag-header">
          <span aria-hidden="true" style="font-size:1.1rem">&#128203;</span>
          <h3>${esc(T('atag_heading'))}</h3>
        </div>
        <div class="atag-body">
          <div class="atag-rent-label">${esc(T('atag_monthly_rent'))}</div>
          <div class="atag-rent" aria-label="${esc(T('atag_monthly_rent'))}: ${esc(rentStr)}">${esc(rentStr)}</div>
          <div class="atag-grid">
            <div class="atag-field">
              <span class="atag-label">${esc(T('atag_property'))}</span>
              <span class="atag-val">${esc(propStr)}</span>
            </div>
            <div class="atag-field">
              <span class="atag-label">${esc(T('atag_deposit'))}</span>
              <span class="atag-val">${esc(depStr)}</span>
            </div>
            <div class="atag-field" style="grid-column:1/-1">
              <span class="atag-label">${esc(T('atag_lease_term'))}</span>
              <span class="atag-val">${esc(startStr)} ${esc(T('atag_term_to'))} ${esc(endStr)}</span>
            </div>
          </div>
          <div class="atag-notices" role="list">
            <div class="atag-notice" role="listitem">
              <span class="atag-notice-icon" aria-hidden="true">&#128276;</span>
              <span>${esc(T('atag_notice'))}</span>
            </div>
            <div class="atag-notice" role="listitem">
              <span class="atag-notice-icon" aria-hidden="true">&#128197;</span>
              <span>${esc(T('atag_late'))}</span>
            </div>
            <div class="atag-notice" role="listitem">
              <span class="atag-notice-icon" aria-hidden="true">&#128062;</span>
              <span>${esc(T('atag_pets'))}</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  // ---- Apply locale to static page chrome ----------------------------
  function applyLocaleToChrome() {
    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const setHtml = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML  = html; };

    setText('header-sub-text',   T('header_sub'));
    setText('loading-heading',   T('loading'));
    setText('loading-sub',       T('loading_wait'));
    setText('card-subhead-text', T('card_subhead'));
    setText('card-review-text',  T('card_review'));
    setText('success-title',     T('success_title'));
    setText('success-message',   T('success_body'));
    const svt = document.getElementById('success-view-text');
    if (svt) svt.textContent = T('success_view').replace('\u21e9 ', '');

    // Sign section
    setText('sign-section-title', T('sign_title'));
    setText('sign-section-help',  T('sign_help'));
    // Email label
    const emailLabel = document.getElementById('signer-email-label');
    if (emailLabel) emailLabel.textContent = T('email_label');
    // Name label
    const nameLabel = document.getElementById('sig-input-label');
    if (nameLabel) nameLabel.textContent = T('name_label');
    // sig-input placeholder (attribute only)
    const sigIn = document.getElementById('sig-input');
    if (sigIn) sigIn.placeholder = T('name_placeholder');
    // sig preview empty text
    const sigPrev = document.getElementById('sig-preview');
    if (sigPrev && !sigPrev.classList.contains('filled')) sigPrev.textContent = T('sig_preview_empty');
    // pad labels
    const padLabelEl = document.getElementById('pad-label-text');
    if (padLabelEl) {
      const hintEl = padLabelEl.querySelector('#pad-hint-text');
      if (hintEl) hintEl.textContent = T('draw_hint');
      const mainSpan = padLabelEl.querySelector('span:not(#pad-hint-text)');
      if (mainSpan) mainSpan.textContent = T('draw_label');
    }
    // pad clear button
    const padClearBtn = document.getElementById('pad-clear');
    if (padClearBtn) {
      padClearBtn.textContent = T('pad_clear');
      padClearBtn.setAttribute('aria-label', T('pad_clear') + ' signature drawing');
    }
    // agree label
    setText('agree-label', T('agree_label'));
    // btn-sign text (set based on current mode, or default)
    const bst = document.getElementById('btn-sign-text');
    if (bst && !_mode) bst.textContent = T('btn_sign');

    // Addenda intro
    setHtml('addenda-intro-text', T('addenda_intro'));

    // Canvas aria-label
    const cnv = document.getElementById('sig-canvas');
    if (cnv) cnv.setAttribute('aria-label', 'Signature drawing pad \u2014 optional. Use mouse or touch to draw your signature.');

    // Page title
    if (_locale === 'es') document.title = 'Firme Su Contrato \u2014 Choice Properties';
  }

  function buildInfoGrid(app, mode) {
    const items = [
      [mode === 'amendment' ? T('label_for_tenant') : T('label_tenant'), `${app.first_name||''} ${app.last_name||''}`],
      [T('label_property'),   app.property_address || '\u2014'],
      [T('label_start'),      fmtDate(app.lease_start_date)],
      [T('label_end'),        fmtDate(app.lease_end_date)],
      [T('label_rent'),       fmtMoney(app.monthly_rent)],
      [T('label_deposit'),    fmtMoney(app.security_deposit)],
    ];
    return items.map(([label, val]) =>
      `<div class="info-item"><span class="info-label">${esc(label)}</span><span class="info-val">${esc(val || '\u2014')}</span></div>`
    ).join('');
  }

  function applySignerMode(mode, signerName) {
    const banner        = document.getElementById('signer-banner');
    const titleEl       = document.getElementById('form-title');
    const sectionTitle  = document.getElementById('sign-section-title');
    const sectionHelp   = document.getElementById('sign-section-help');
    const labelEl       = document.getElementById('lease-text-label');
    const btnText       = document.getElementById('btn-sign-text');
    const successTitle  = document.getElementById('success-title');

    banner.style.display = 'flex';
    if (mode === 'co_applicant') {
      banner.className = 'signer-banner coapp';
      banner.innerHTML = `<span class="b-mark" aria-hidden="true">2</span><span>${T('signer_coapp')}</span>`;
      sectionTitle.textContent = T('sign_title_coapp');
      sectionHelp.textContent  = T('sign_help_coapp');
      btnText.textContent      = T('btn_sign_coapp');
      successTitle.textContent = T('success_title');
    } else if (mode === 'amendment') {
      banner.className = 'signer-banner amend';
      banner.innerHTML = `<span class="b-mark" aria-hidden="true">+</span><span>${T('signer_amend')}</span>`;
      if (labelEl) labelEl.textContent     = 'Amendment Document';
      sectionTitle.textContent = T('sign_title_amend');
      sectionHelp.textContent  = T('sign_help_amend');
      btnText.textContent      = T('btn_sign_amend');
      successTitle.textContent = T('success_title');
    } else {
      banner.className = 'signer-banner tenant';
      banner.innerHTML = `<span class="b-mark" aria-hidden="true">1</span><span>${T('signer_primary')}${signerName ? ` (${esc(signerName)})` : ''}.</span>`;
      sectionTitle.textContent = T('sign_title');
      sectionHelp.textContent  = T('sign_help');
      btnText.textContent      = T('btn_sign');
      successTitle.textContent = T('success_title');
    }
  }

  // ----- Phase 04: addenda renderer -----
  function pillClassForJurisdiction(j) {
    const x = String(j || '').toLowerCase();
    if (x === 'federal' || x === 'common') return 'addendum-jurisdiction-pill ' + x;
    return 'addendum-jurisdiction-pill';
  }
  function jurisdictionLabel(j) {
    const x = String(j || '').toLowerCase();
    if (x === 'federal') return 'Federal';
    if (x === 'common')  return 'All States';
    return String(j || '').toUpperCase();
  }

  function updateAddendaCounter() {
    const total = _addendaSlugs.length;
    const done  = _addendaAcked.size;
    const el = document.getElementById('addenda-counter');
    if (!el) return;
    if (total === 0) { el.textContent = ''; return; }
    if (done === total) {
      el.innerHTML = '<strong>' + T('addenda_all_acked', { n: total }) + '</strong>';
    } else {
      el.innerHTML = T('addenda_progress', { done, n: total });
    }
  }

  function renderAddenda(list) {
    const section = document.getElementById('addenda-section');
    const listEl  = document.getElementById('addenda-list');
    if (!section || !listEl) return;

    _addendaSlugs = (list || []).map(a => a.slug);
    _addendaAcked.clear();

    if (!list || list.length === 0) {
      section.style.display = 'none';
      updateSignBtn();
      return;
    }

    section.style.display = '';
    listEl.innerHTML = list.map((a, i) => {
      const ackId  = 'ack-' + i;
      const bodyId = 'addbody-' + i;
      const ackLbl = T('ack_label', { title: a.title || '' });
      return `
        <div class="addendum-card" data-slug="${esc(a.slug)}">
          <div class="addendum-head" data-toggle="${bodyId}">
            <span class="${pillClassForJurisdiction(a.jurisdiction)}">${esc(jurisdictionLabel(a.jurisdiction))}</span>
            <div class="addendum-titlebox">
              <div class="a-title">${esc(a.title)}</div>
              <div class="a-citation">Authority: ${esc(a.citation || '\u2014')}</div>
            </div>
            <button type="button" class="addendum-toggle" data-toggle="${bodyId}" aria-expanded="false" aria-controls="${bodyId}">Read</button>
          </div>
          <div class="addendum-body" id="${bodyId}" role="region" aria-label="${esc(a.title)}">${esc(a.body || '')}</div>
          <label class="addendum-ack" for="${ackId}">
            <input type="checkbox" id="${ackId}" data-slug="${esc(a.slug)}" aria-describedby="addenda-counter">
            <span>${esc(ackLbl)}</span>
          </label>
        </div>`;
    }).join('');

    // Wire toggles
    listEl.querySelectorAll('[data-toggle]').forEach(el => {
      el.addEventListener('click', (ev) => {
        if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.closest('.addendum-ack'))) return;
        const id = el.getAttribute('data-toggle');
        const body = document.getElementById(id);
        if (body) {
          body.classList.toggle('expanded');
          const toggleBtn = el.tagName === 'BUTTON' ? el : el.querySelector('.addendum-toggle');
          if (toggleBtn) {
            const expanded = body.classList.contains('expanded');
            toggleBtn.textContent = expanded ? 'Hide' : 'Read';
            toggleBtn.setAttribute('aria-expanded', String(expanded));
          }
        }
      });
    });

    // Wire ack checkboxes
    listEl.querySelectorAll('input[type="checkbox"][data-slug]').forEach(cb => {
      cb.addEventListener('change', () => {
        const slug = cb.getAttribute('data-slug');
        if (cb.checked) _addendaAcked.add(slug);
        else _addendaAcked.delete(slug);
        const card = cb.closest('.addendum-card');
        if (card) card.classList.toggle('acked', cb.checked);
        updateAddendaCounter();
        updateSignBtn();
      });
    });

    updateAddendaCounter();
    updateSignBtn();
  }

  // ----- Phase 05: E-SIGN consent panel -----
  function renderConsentPanel(disclosure, signerEmail) {
    const introEl  = document.getElementById('consent-intro');
    const hwEl     = document.getElementById('ack-hardware-body');
    const paperEl  = document.getElementById('ack-paper-body');
    const wdEl     = document.getElementById('ack-withdrawal-body');
    const procEl   = document.getElementById('consent-procedures');

    if (introEl) introEl.textContent  = disclosure.intro || '';
    if (hwEl)    hwEl.textContent     = disclosure.hardware_software || '';
    if (paperEl) paperEl.textContent  = disclosure.paper_copy_right || '';
    if (wdEl)    wdEl.textContent     = disclosure.withdrawal_right || '';
    if (procEl) {
      procEl.innerHTML =
        '<strong>How to request a paper copy:</strong> ' + esc(disclosure.paper_copy_procedure || '') +
        '<br><strong>How to withdraw consent:</strong> ' + esc(disclosure.withdrawal_procedure || '') +
        '<br><strong>Contact:</strong> ' + esc(disclosure.contact_email || '') + ' &middot; ' + esc(disclosure.contact_phone || '');
    }

    const emailInputC = document.getElementById('consent-email');
    if (emailInputC && signerEmail) emailInputC.value = signerEmail;

    document.getElementById('consent-section').style.display = '';
    document.querySelector('.lease-text-wrap').style.display = 'none';
    const addSec = document.getElementById('addenda-section');
    if (addSec) addSec.style.display = 'none';
    document.querySelector('.sign-section').style.display = 'none';

    const ackIds  = ['ack-hardware', 'ack-paper', 'ack-withdrawal'];
    const btnC    = document.getElementById('btn-consent');
    const updateConsentBtn = () => {
      const allAcked = ackIds.every(id => document.getElementById(id).checked);
      const emailVal = (emailInputC?.value || '').trim();
      const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal);
      const disabled = !(allAcked && hasEmail);
      btnC.disabled = disabled;
      btnC.setAttribute('aria-disabled', String(disabled));
    };
    ackIds.forEach(id => {
      const cb = document.getElementById(id);
      cb.addEventListener('change', () => {
        cb.closest('.consent-ack').classList.toggle('checked', cb.checked);
        updateConsentBtn();
      });
    });
    if (emailInputC) emailInputC.addEventListener('input', updateConsentBtn);
    updateConsentBtn();

    btnC.addEventListener('click', submitConsent);

    // Localise consent button
    const btnConsentText = document.getElementById('btn-consent-text');
    if (btnConsentText) btnConsentText.textContent = T('btn_consent_text');
  }

  async function submitConsent() {
    const btnC    = document.getElementById('btn-consent');
    const errEl   = document.getElementById('consent-error');
    const emailEl = document.getElementById('consent-email');
    const txtEl   = document.getElementById('btn-consent-text');
    if (!btnC || !errEl || !emailEl) return;

    btnC.disabled = true;
    btnC.setAttribute('aria-disabled', 'true');
    txtEl.textContent = T('consent_submitting');
    errEl.style.display = 'none';

    const body = {
      token:                          _activeToken,
      signer_email:                   emailEl.value.trim(),
      hardware_software_acknowledged: document.getElementById('ack-hardware').checked,
      paper_copy_right_acknowledged:  document.getElementById('ack-paper').checked,
      withdrawal_right_acknowledged:  document.getElementById('ack-withdrawal').checked,
      user_agent:                     navigator.userAgent,
      disclosure_version:             _disclosureVersion,
    };

    let resp, json;
    try {
      resp = await fetch(SERVER_BASE + '/record-esign-consent', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY },
        body:    JSON.stringify(body),
      });
      json = await resp.json();
    } catch {
      errEl.textContent = T('err_conn');
      errEl.style.display = 'block';
      btnC.disabled = false;
      btnC.setAttribute('aria-disabled', 'false');
      txtEl.textContent = T('btn_consent_text');
      return;
    }

    if (!resp.ok || !json.success) {
      errEl.textContent = json.error || T('err_conn');
      errEl.style.display = 'block';
      btnC.disabled = false;
      btnC.setAttribute('aria-disabled', 'false');
      txtEl.textContent = T('btn_consent_text');
      return;
    }

    _consentRequired = false;
    document.getElementById('consent-section').style.display = 'none';
    document.querySelector('.lease-text-wrap').style.display = '';
    const addSec = document.getElementById('addenda-section');
    if (addSec && _addendaSlugs.length) addSec.style.display = '';
    document.querySelector('.sign-section').style.display = '';
    const emailInput2 = document.getElementById('signer-email');
    if (emailInput2 && !emailInput2.value) emailInput2.value = body.signer_email;
    updateSignBtn();
  }

  // ----- Loading -----
  async function loadLease() {
    if (!token && !amendmentToken) {
      document.getElementById('err-title').textContent   = T('err_no_token_title');
      document.getElementById('err-message').textContent = T('err_no_token_body');
      showState('error');
      return;
    }

    _activeToken = token || amendmentToken;
    const isAmendment = !!amendmentToken;
    const url = SERVER_BASE + (isAmendment ? '/get-amendment' : '/get-lease');

    let resp, json;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY },
        body: JSON.stringify({ token: _activeToken }),
      });
      json = await resp.json();
    } catch {
      document.getElementById('err-title').textContent   = T('err_conn_title');
      document.getElementById('err-message').textContent = T('err_conn_body');
      showState('error');
      return;
    }

    if (!resp.ok) {
      document.getElementById('err-title').textContent   =
        resp.status === 410 ? T('err_already_title') : T('err_expired_title');
      document.getElementById('err-message').textContent =
        json.error || 'This signing link is no longer valid.';
      showState('error');
      return;
    }

    const app = json.app;
    _appForLink = app;

    // Phase 12 — detect locale before rendering anything
    detectLocale(app);
    applyLocaleToChrome();

    // Phase 05 - cache consent state
    _consentRequired       = !!json.consent_required;
    _disclosureVersion     = json.esign_disclosure_version || null;
    _signerEmailFromServer = (json.signer && json.signer.email) || (app && app.email) || '';

    if (isAmendment) {
      _mode = 'amendment';
      applySignerMode('amendment', json.signer?.name);
      document.getElementById('form-prop').textContent  = json.amendment.title || 'Amendment';
      document.getElementById('form-appid').textContent = app.app_id || '\u2014';
      document.getElementById('info-grid').innerHTML    = buildInfoGrid(app, 'amendment');
      document.getElementById('lease-text-body').textContent =
        `${json.amendment.title}\n\n${json.amendment.body}`;
      const rn = document.getElementById('rendered-notice');
      if (rn) rn.textContent = T('amend_notice');
      renderAddenda([]);
    } else {
      _mode = json.signer?.type || 'tenant';
      applySignerMode(_mode, json.signer?.name);
      document.getElementById('form-prop').textContent  = app.property_address || 'your property';
      document.getElementById('form-appid').textContent = app.app_id || '\u2014';
      document.getElementById('info-grid').innerHTML    = buildInfoGrid(app, _mode);
      const rendered = json.rendered_lease || '';
      document.getElementById('lease-text-body').textContent =
        rendered || 'Lease template unavailable. Please contact Choice Properties.';
      const rn = document.getElementById('rendered-notice');
      if (rendered && rn) rn.textContent = T('scroll_hint');
      renderAddenda(json.addenda || []);
    }

    // Phase 12 — plain-language at-a-glance summary (above info-grid)
    renderAtAGlance(app);

    // Phase 05 - E-SIGN consent gate
    if (_consentRequired && json.esign_disclosure) {
      renderConsentPanel(json.esign_disclosure, _signerEmailFromServer);
    }

    showState('form');
  }

  // ----- Canvas signature pad -----
  const canvas = document.getElementById('sig-canvas');
  const ctx = canvas.getContext('2d');
  let _drawing = false, _hasInk = false;
  let _lastX = 0, _lastY = 0;
  let _resizeTimer = null;

  function applyCtxStyle() {
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1e293b';
  }

  function resizeCanvas() {
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const newW = Math.round(rect.width * ratio);
    const newH = Math.round(rect.height * ratio);
    // Skip if dimensions genuinely haven't changed (e.g. iOS address-bar hide).
    if (canvas.width === newW && canvas.height === newH) {
      applyCtxStyle();
      return;
    }
    // Snapshot existing ink before canvas.width assignment wipes pixels.
    const snapshot = _hasInk ? canvas.toDataURL('image/png') : null;
    canvas.width = newW;
    canvas.height = newH;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(ratio, ratio);
    applyCtxStyle();
    // Restore ink after resize (async because Image load is async).
    if (snapshot) {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, rect.width, rect.height);
      };
      img.src = snapshot;
    }
  }

  // Debounce resize so mobile keyboard show/hide doesn't flicker the canvas.
  function onWindowResize() {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(resizeCanvas, 150);
  }

  function evtPos(e) {
    const rect = canvas.getBoundingClientRect();
    const t = (e.touches && e.touches[0]) || e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }

  function startDraw(e) { e.preventDefault(); _drawing = true; const p = evtPos(e); _lastX = p.x; _lastY = p.y; }
  function moveDraw(e) {
    if (!_drawing) return;
    e.preventDefault();
    const p = evtPos(e);
    ctx.beginPath(); ctx.moveTo(_lastX, _lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
    _lastX = p.x; _lastY = p.y;
    if (!_hasInk) { _hasInk = true; canvas.classList.add('filled'); }
  }
  function endDraw(e) { e && e.preventDefault && e.preventDefault(); _drawing = false; }

  function clearPad() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    _hasInk = false;
    canvas.classList.remove('filled');
  }
  function getSignaturePngDataUrl() { return _hasInk ? canvas.toDataURL('image/png') : null; }

  canvas.addEventListener('pointerdown', startDraw);
  canvas.addEventListener('pointermove', moveDraw);
  canvas.addEventListener('pointerup', endDraw);
  canvas.addEventListener('pointercancel', endDraw);
  canvas.addEventListener('pointerleave', endDraw);
  canvas.addEventListener('touchstart',  startDraw, { passive: false });
  canvas.addEventListener('touchmove',   moveDraw,  { passive: false });
  canvas.addEventListener('touchend',    endDraw);

  // WCAG 2.1 AA — keyboard activation on canvas (Space = clear)
  canvas.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); clearPad(); }
  });

  document.getElementById('pad-clear').addEventListener('click', clearPad);
  window.addEventListener('resize', onWindowResize);
  // Also handle visibility changes (tab switch, browser minimize/restore).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resizeCanvas();
  });
  setTimeout(resizeCanvas, 60);

  // ----- Form state -----
  const sigInput   = document.getElementById('sig-input');
  const emailInput = document.getElementById('signer-email');
  const sigPreview = document.getElementById('sig-preview');
  const agreeCheck = document.getElementById('agree-check');
  const btnSign    = document.getElementById('btn-sign');

  function updateSignBtn() {
    const hasSig   = sigInput.value.trim().length >= 5;
    const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.value.trim());
    const hasAgree = agreeCheck.checked;
    const allAddendaAcked = _addendaSlugs.every(s => _addendaAcked.has(s));
    const disabled = !(hasSig && hasEmail && hasAgree && allAddendaAcked);
    btnSign.disabled = disabled;
    btnSign.setAttribute('aria-disabled', String(disabled));
  }

  sigInput.addEventListener('input', () => {
    const val = sigInput.value.trim();
    if (val) {
      sigPreview.textContent = val;
      sigPreview.classList.add('filled');
    } else {
      sigPreview.textContent = T('sig_preview_empty');
      sigPreview.classList.remove('filled');
    }
    updateSignBtn();
  });
  emailInput.addEventListener('input', updateSignBtn);
  agreeCheck.addEventListener('change', updateSignBtn);
  btnSign.addEventListener('click', submitSignature);

  async function submitSignature() {
    const signature = sigInput.value.trim();
    if (!signature || !_mode || !_activeToken) return;

    btnSign.disabled = true;
    btnSign.setAttribute('aria-disabled', 'true');
    document.getElementById('btn-sign-text').textContent = T('btn_submitting');

    const errEl = document.getElementById('sign-error');
    errEl.style.display = 'none';

    const endpoint = _mode === 'co_applicant' ? '/sign-lease-co-applicant'
                   : _mode === 'amendment'    ? '/sign-amendment'
                   : '/sign-lease';

    const body = {
      token:           _activeToken,
      signature,
      signature_image: getSignaturePngDataUrl(),
      applicant_email: emailInput.value.trim(),
      user_agent:      navigator.userAgent,
      acknowledged_addenda: Array.from(_addendaAcked),
    };

    function resetBtn() {
      btnSign.disabled = false;
      btnSign.setAttribute('aria-disabled', 'false');
      document.getElementById('btn-sign-text').textContent =
        _mode === 'co_applicant' ? T('btn_sign_coapp')
        : _mode === 'amendment'  ? T('btn_sign_amend')
        : T('btn_sign');
    }

    let resp;
    // Step 1: network — real connection error if this throws.
    try {
      resp = await fetch(SERVER_BASE + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY },
        body: JSON.stringify(body),
      });
    } catch {
      errEl.textContent = T('err_conn');
      errEl.style.display = 'block';
      resetBtn();
      return;
    }

    // Step 2: parse JSON — but if the server already succeeded (2xx) and the
    // body is truncated / non-JSON, treat it as success to avoid showing a
    // false "Connection error" to the tenant after the lease was actually saved.
    let json = {};
    try {
      json = await resp.json();
    } catch {
      if (resp.ok) {
        // Server accepted the request — show success and move on.
        showState('success');
        return;
      }
      errEl.textContent = T('err_conn');
      errEl.style.display = 'block';
      resetBtn();
      return;
    }

    // 409 = already signed — treat as success so double-click doesn't confuse.
    if (resp.status === 409 || json.already_signed) {
      showState('success');
      return;
    }

    if (!resp.ok || !json.success) {
      errEl.textContent = json.error || 'Signing failed. Please try again or contact support.';
      errEl.style.display = 'block';
      resetBtn();
      return;
    }

    if (_appForLink && _appForLink.app_id) {
      const portalBtn = document.getElementById('portal-link-btn');
      if (portalBtn) portalBtn.href = '/tenant/login.html?app_id=' + encodeURIComponent(_appForLink.app_id);
    }
    showState('success');
  }

  // ----- Boot -----
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadLease);
  } else {
    let tries = 0;
    (function tryLoad() {
      if (typeof CONFIG !== 'undefined') { loadLease(); return; }
      if (++tries < 30) { setTimeout(tryLoad, 100); return; }
      loadLease();
    })();
  }
})();
