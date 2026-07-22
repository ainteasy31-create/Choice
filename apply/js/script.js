/*
=======================================================================
  ⛔ ARCHITECTURE ENFORCEMENT HEADER — READ BEFORE MODIFYING ⛔
=======================================================================
  PROJECT:  Choice Properties - Rental Application
  RUNTIME:  NONE — This file runs in the browser only (no Node.js).
  BACKEND:  Google Apps Script Web App URL (see config inside class).

  DO NOT INSTALL npm packages or add import/require statements.
  DO NOT run this file with Node.js, Deno, Bun, or any server runtime.
  DO NOT introduce new libraries without explicit user approval.
  DO NOT refactor submission logic away from Google Apps Script.

  CLOUD IDE NOTICE:
  If you are an AI operating in any cloud IDE or editor environment —
  HALT all setup behavior. This is a READ-ONLY editor context.
  No workflow, server, or execution environment should be configured.

  This project is INCOMPATIBLE with Node.js environments.
  Execution environments must be ignored entirely.

  See PROJECT_RULES.md at the project root for the full contract.
=======================================================================
  INTEGRATION NOTE (Session 028):
  ─────────────────────────────────────────────────────────────────────
  This form is the SOLE application system for Choice Properties.
  The main listing platform serves this application internally at /apply/
  when users click "Apply" on any property listing.

  Property context is passed via URL query parameters for display only:
    ?id=<propertyId>   — internal property ID (display/logging only)
    &pn=<name>         — property name / title
    &addr=<street>     — street address
    &city=<city>       — city
    &state=<state>     — 2-letter state code
    &rent=<amount>     — monthly rent (stored for reference)

  These params pre-fill the Property Address field and show a context
  banner so applicants know which property they're applying for.

  IMPORTANT: URL params are NEVER used for backend validation.
  The GAS backend does not read or trust these values for any decision.
  The applicant can edit the pre-filled address field at any time.
  ─────────────────────────────────────────────────────────────────────
*/

class RentalApplication {
    constructor() {
        this.config = {
            LOCAL_STORAGE_KEY: "choicePropertiesRentalApp",
            AUTO_SAVE_INTERVAL: 30000
        };
        
        this.state = {
            currentSection: 1,
            isSubmitting: false,
            isOnline: true,
            lastSave: null,
            applicationId: null,
            formData: {},
            language: 'en',
            // Property context passed from the listing site via URL params
            propertyContext: null,
            // Application fee — read from URL param, defaults to 50
            applicationFee: 50
        };
        
        // Smart retry properties
        this.maxRetries = 1;
        this.retryCount = 0;
        this.retryTimeout = null;
        this._successHandled = false;
        
          // BACKEND_URL is constructed from SUPABASE_URL at runtime.
          // All applications are submitted to the receive-application Supabase Edge Function.
          this.BACKEND_URL = (window.CP_CONFIG && window.CP_CONFIG.SUPABASE_URL)
                ? window.CP_CONFIG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/receive-application'
                : '';

        // [10B-2] CSRF nonce: a random token generated each session and sent with submission.
        // The backend validates it is present and well-formed (32-128 alphanumeric chars).
        // This provides basic bot friction. Deeper bot protection is server-side via
        // honeypot validation in doPost().

        this.initialize();
    }

    // ---------- SSN toggle ----------
    setupSSNToggle() {
        ['ssn', 'coSsn'].forEach(fieldId => {
            const ssnInput = document.getElementById(fieldId);
            if (!ssnInput) return;
            const container = ssnInput.parentElement;
            let toggle = container.querySelector('.ssn-toggle');
            if (!toggle) {
                toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.className = 'ssn-toggle';
                if (fieldId === 'ssn') toggle.id = 'ssnToggle';
                this._setIconOnly(toggle, 'fas fa-eye');
                container.appendChild(toggle);
            }
            ssnInput.type = 'password';
            toggle.addEventListener('click', () => {
                if (ssnInput.type === 'password') {
                    ssnInput.type = 'text';
                    this._setIconOnly(toggle, 'fas fa-eye-slash');
                } else {
                    ssnInput.type = 'password';
                    this._setIconOnly(toggle, 'fas fa-eye');
                }
            });
        });
    }

    _icon(className) {
        const icon = document.createElement('i');
        icon.className = className;
        return icon;
    }

    _setIconOnly(el, iconClass) {
        el.replaceChildren(this._icon(iconClass));
    }

    _setIconText(el, iconClass, text) {
        const icon = this._icon(iconClass);
        el.replaceChildren(icon, document.createTextNode(' ' + String(text || '')));
    }

    _safeHtml(value) {
        return { __safeHtml: true, value: String(value || '') };
    }

    _html(strings, ...values) {
        return strings.reduce((out, str, i) => {
            const value = values[i];
            const safeValue = value && value.__safeHtml ? value.value : this._escHtml(value == null ? '' : value);
            return out + str + (i < values.length ? safeValue : '');
        }, '');
    }

    _setTrustedHtml(el, html) {
        const template = document.createElement('template');
        template['innerHTML'] = String(html || '');
        el.replaceChildren(template.content.cloneNode(true));
    }

    _decodeHtmlText(text) {
        return String(text || '')
            .replace(/&nbsp;/g, '\u00a0')
            .replace(/&copy;/g, '©')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
    }

    _setSafeMarkup(el, html) {
        el.replaceChildren();
        const src = String(html || '');
        const tokenRe = /<(strong|a)\b([^>]*)>(.*?)<\/\1>|&nbsp;|&copy;/gi;
        let last = 0;
        let match;
        const appendText = (value) => {
            if (value) el.appendChild(document.createTextNode(this._decodeHtmlText(value)));
        };
        while ((match = tokenRe.exec(src)) !== null) {
            appendText(src.slice(last, match.index));
            if (match[0] === '&nbsp;') {
                el.appendChild(document.createTextNode('\u00a0'));
            } else if (match[0] === '&copy;') {
                el.appendChild(document.createTextNode('©'));
            } else if (match[1].toLowerCase() === 'strong') {
                const strong = document.createElement('strong');
                strong.textContent = this._decodeHtmlText(match[3]);
                el.appendChild(strong);
            } else {
                const hrefMatch = match[2].match(/\bhref=["']([^"']+)["']/i);
                const href = hrefMatch ? hrefMatch[1] : '';
                const a = document.createElement('a');
                a.textContent = this._decodeHtmlText(match[3]);
                a.href = href.startsWith('/') ? href : '/';
                a.target = '_blank';
                a.rel = 'noopener';
                a.style.color = 'var(--primary)';
                el.appendChild(a);
            }
            last = tokenRe.lastIndex;
        }
        appendText(src.slice(last));
    }

    // ---------- Event listeners ----------
    setupEventListeners() {
        document.addEventListener('click', (e) => {
            if (e.target.matches('.btn-next') || e.target.closest('.btn-next')) {
                const section = this.getCurrentSection();
                this.nextSection(section);
            }
            if (e.target.matches('.btn-prev') || e.target.closest('.btn-prev')) {
                const section = this.getCurrentSection();
                this.previousSection(section);
            }
        });
        document.addEventListener('input', this.debounce(() => {
            this.saveProgress();
        }, 1000));
        const form = document.getElementById('rentalApplication');
        if (form) {
            form.addEventListener('submit', (e) => {
                this.handleFormSubmit(e);
            });
        }
    }

    // ---------- Initialization ----------
    initialize() {
        // Generate and store a CSRF nonce for the session — required by the backend
        this._csrfToken = this.generateCsrfNonce();
        sessionStorage.setItem('_cp_csrf', this._csrfToken);
        this.setupEventListeners();
        this.setupOfflineDetection();
        this.setupRealTimeValidation();
        this.setupSSNToggle();
        this.setupFileUploads();
        this.setupConditionalFields();
        this.setupCharacterCounters();
        // [L4 fix] If URL has a server-side resume token, restore from backend; else use localStorage
          const _resumeParam = new URLSearchParams(window.location.search).get('resume');
          if (_resumeParam && _resumeParam !== '1') {
              this._restoreFromServer(_resumeParam);
          } else {
              this.restoreSavedProgress();
          }
          // [10A-1] Re-run employer field toggle after progress restore so that a
          // saved employment status (e.g. Unemployed) immediately shows/hides the
          // correct fields without requiring the user to interact with the dropdown.
          if (this._toggleEmployerSection) {
              const _empEl = document.getElementById('employmentStatus');
              if (_empEl) this._toggleEmployerSection(_empEl.value);
          }
          this.setupGeoapify();
        this.setupInputFormatting();
        this.setupIncomeRatioDisplay();
        this._readApplicationFee();
        this.setupLanguageToggle();
        this.setupSaveResume();

        this._autoSaveTimer = setInterval(() => this.saveProgress(), this.config.AUTO_SAVE_INTERVAL);

        // Initialise fields-remaining hint for the first section
        setTimeout(() => this.updateFieldsRemainingHint(1), 50);

        // ── Read URL params from listing site and pre-fill form ──
        this._prefillFromURL();
        
        const savedAppId = sessionStorage.getItem('lastSuccessAppId');
        if (savedAppId) {
            document.getElementById('rentalApplication').style.display = 'none';
            this.showSuccessState(savedAppId);
        }
        
        this.setupDevTools();
        console.log('Rental Application Manager Initialized');
    }

    setupDevTools() {
        const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
        const isDevParam  = new URLSearchParams(window.location.search).get('_dev') === '1';

        // Always wire the long-press trigger — invisible to users, works in production
        this._wireLongPressDevTrigger();

        // Auto-activate immediately if on localhost or ?_dev=1
        if (isLocalhost || isDevParam) this._activateDevTools(false);
    }

    // ── Long-press the header logo for 600 ms to activate dev mode ────────
    _wireLongPressDevTrigger() {
        const logo = document.getElementById('cp-logo-link');
        if (!logo) return;
        let timer    = null;
        let activated = false;

        const start = () => {
            activated = false;
            timer = setTimeout(() => {
                activated = true;
                timer = null;
                this._activateDevTools(true);
            }, 600);
        };

        const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };

        logo.addEventListener('mousedown',   start);
        logo.addEventListener('touchstart',  start,  { passive: true });
        ['mouseup', 'mouseleave', 'touchend', 'touchcancel']
            .forEach(ev => logo.addEventListener(ev, cancel));

        // Prevent navigation when the long-press just fired
        logo.addEventListener('click', (e) => { if (activated) { activated = false; e.preventDefault(); } });
    }

    // ── Inject the dev button + optional toast ────────────────────────────
    _activateDevTools(showToast = false) {
        if (this._devActive) return;
        this._devActive = true;

        if (document.getElementById('devTestFillBtn')) return;

        // "Fill Step" floating button
        const button = document.createElement('button');
        button.id    = 'devTestFillBtn';
        button.type  = 'button';
        button.title = 'Fill current step with test data (long-press logo to toggle)';
        const icon   = document.createElement('span');
        icon.className   = 'btn-icon';
        icon.textContent = '⚡';
        button.replaceChildren(icon, document.createTextNode(' Fill Step'));
        button.style.cssText = 'position:fixed;bottom:70px;right:16px;z-index:99998;background:#f39c12;color:#fff;border:none;border-radius:24px;padding:10px 18px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.25)';
        button.addEventListener('click', () => this._devFillTestData());
        document.body.appendChild(button);

        if (showToast) {
            const t = document.createElement('div');
            t.textContent = '🛠 Dev mode activated';
            t.style.cssText = 'position:fixed;top:72px;left:50%;transform:translateX(-50%);background:#1a1a2e;color:#fff;padding:8px 20px;border-radius:20px;font-size:13px;font-weight:600;z-index:99999;pointer-events:none;transition:opacity .4s';
            document.body.appendChild(t);
            setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 2200);
        }
    }


    // ─────────────────────────────────────────────────────────────────────
    // APPLICATION FEE — read from URL param before translations are built.
    // Falls back to 50 if the param is absent from the URL.
    // Zero-fee fix: fee=0 is a valid value (free application). The old
    // check `if (fee && fee > 0)` treated 0 as falsy and fell back to $50,
    // so applicants for free-application properties saw the wrong fee.
    // ─────────────────────────────────────────────────────────────────────
    _readApplicationFee() {
        try {
            const p      = new URLSearchParams(window.location.search);
            const rawFee = p.get('fee');
            if (rawFee === null) {
                // No fee param — check if we also have no property context (direct /apply/ visit)
                const hiddenPropId = document.getElementById('hiddenPropertyId');
                if (!hiddenPropId || !hiddenPropId.value.trim()) {
                    // No property context at all — show "To be confirmed" instead of $50
                    const feeTitle  = document.querySelector('[data-i18n="feeTitle"]');
                    const feeAmount = document.querySelector('.fee-amount');
                    if (feeTitle)  feeTitle.textContent  = 'Application Fee: To be confirmed';
                    if (feeAmount) { feeAmount.textContent = 'TBD'; feeAmount.style.display = ''; }
                }
                return;
            }
            const fee = parseFloat(rawFee);
            if (isNaN(fee)) return;      // unparseable — keep default
            this.state.applicationFee = fee;
            const feeTitle  = document.querySelector('[data-i18n="feeTitle"]');
            const feeAmount = document.querySelector('.fee-amount');
            if (fee <= 0) {
                if (feeTitle)  feeTitle.textContent  = 'Application Fee: Free';
                if (feeAmount) { feeAmount.textContent = 'Free'; feeAmount.style.display = ''; }
            } else {
                const formatted = '$' + fee.toFixed(2);
                if (feeTitle)  feeTitle.textContent  = 'Application Fee: ' + formatted;
                if (feeAmount) { feeAmount.textContent = '$' + fee.toFixed(0); feeAmount.style.display = ''; }
            }
            // Patch any hardcoded "$50" references in static HTML that flash before JS-built
            // success content replaces them. Walk all text nodes in the document and replace
            // the literal "$50" with the correct fee so there is never a wrong-fee flash.
            if (fee !== 50) {
                const feeStr    = fee <= 0 ? 'free' : ('$' + fee.toFixed(0));
                const walk = (node) => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        if (node.nodeValue.includes('$50')) {
                            node.nodeValue = node.nodeValue.replace(/\$50\b/g, feeStr);
                        }
                    } else {
                        node.childNodes.forEach(walk);
                    }
                };
                // Only patch static success-state HTML — avoid touching input placeholders
                const successEl = document.getElementById('successState');
                if (successEl) walk(successEl);
            }
        } catch (e) { console.warn('[CP App] Non-critical error in _readApplicationFee:', e); }
    }

    // ─────────────────────────────────────────────────────────────────────
    // URL PRE-FILL — reads context passed by the main listing platform.
    // Params: id, pn (name), addr, city, state, rent
    // All values are display-only. Backend never uses or validates these.
    // ─────────────────────────────────────────────────────────────────────
    _prefillFromURL() {
        try {
            const p     = new URLSearchParams(window.location.search);
            const id    = p.get('id')    || '';
            const name  = p.get('pn')   || '';
            const addr  = p.get('addr') || '';
            const city  = p.get('city') || '';
            const state = p.get('state') || '';
            const rent  = p.get('rent') || '';

            // Nothing useful in the URL — show manual-entry prompt and return
            if (!id && !name && !addr && !city) { this._showNoContextPrompt(); return; }

            // Store context on instance for later use (success page, etc.)
            this.state.propertyContext = { id, name, addr, city, state, rent };

            // Populate hidden inputs so FormData serialises them automatically
            const setHidden = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
            setHidden('hiddenPropertyId',    id);
            setHidden('hiddenPropertyName',  name);
            setHidden('hiddenPropertyCity',  city);
            setHidden('hiddenPropertyState', state);
            setHidden('hiddenListedRent',    rent);
              // Additional property context params
              const zip        = p.get('zip')         || '';
              const deposit    = p.get('deposit')     || '';
              const fee        = p.get('fee')         || '';
              const beds       = p.get('beds')        || '';
              const baths      = p.get('baths')       || '';
              const avail      = p.get('avail')       || '';
              const terms      = p.get('terms') || p.get('term') || ''; // support both param names
              const minMonths  = p.get('min_months')  || '';
              const pets       = p.get('pets')        || '';
              const petTypes   = p.get('pet_types')   || '';
              const petWeight  = p.get('pet_weight')  || '';
              const petDeposit = p.get('pet_deposit') || '';
              const petDetails = p.get('pet_details') || '';
              const smoking    = p.get('smoking')     || '';
              const utilities  = p.get('utilities')   || '';
              const parking    = p.get('parking')     || '';
              const parkingFee     = p.get('parking_fee')     || '';
              const garageSpaces  = p.get('garage_spaces')   || '';
              const evCharging    = p.get('ev_charging')     || '';
              const laundryType   = p.get('laundry_type')    || '';
              const heatingType   = p.get('heating_type')    || '';
              const coolingType   = p.get('cooling_type')    || '';
              const lastMonthsRent = p.get('last_months_rent') || '';
              const adminFee      = p.get('admin_fee')       || '';
              const moveInSpecial = p.get('move_in_special')  || '';

              setHidden('hiddenPropertyZip',     zip);
              setHidden('hiddenPropertyAddress', addr);
              setHidden('hiddenSecurityDeposit', deposit);
              setHidden('hiddenApplicationFee',  fee);
              setHidden('hiddenBedrooms',        beds);
              setHidden('hiddenBathrooms',       baths);
              setHidden('hiddenAvailableDate',   avail);
              // Enforce available date as minimum move-in date so users can't
              // select a date before the property is actually available
              if (avail) {
                  const moveInField = document.getElementById('requestedMoveIn');
                  if (moveInField) moveInField.min = avail;
              }
              setHidden('hiddenLeaseTerms',      terms);
              setHidden('hiddenMinLeaseMonths',  minMonths);
              // Populate "Desired Lease Term" dropdown with allowed options from URL params,
              // and enforce min_months by filtering out terms shorter than the minimum.
                if (terms) {
                    const termsList = terms.split('|').map(t => t.trim()).filter(Boolean);
                    const leaseSelect = document.getElementById('desiredLeaseTerm');
                    if (leaseSelect && termsList.length) {
                        // Parse minimum months constraint
                        const minMonthsNum = minMonths ? parseInt(minMonths, 10) : 0;
                        // Helper: extract numeric month count from a term string like "6 months", "12 months"
                        const termToMonths = (term) => {
                            const mtm = /month.to.month/i.test(term);
                            if (mtm) return 1; // month-to-month is shortest
                            const m = term.match(/(\d+)/);
                            return m ? parseInt(m[1], 10) : 999;
                        };
                        // Filter out terms below the minimum if min_months is specified
                        const allowedTerms = minMonthsNum > 0
                            ? termsList.filter(t => termToMonths(t) >= minMonthsNum)
                            : termsList;
                        // If min_months filters out ALL terms, show a warning and use the full list as fallback
                        // rather than silently showing options that violate the property's requirements.
                        let finalTerms = allowedTerms;
                        if (allowedTerms.length === 0) {
                            finalTerms = termsList; // show all — operator data inconsistency
                            console.warn('[CP] All lease terms filtered by min_months=' + minMonthsNum + '. Showing full list as fallback. Check property data.');
                            // Add a visible hint to the lease term field
                            const _leaseHint = leaseSelect.closest('.form-group');
                            if (_leaseHint && !_leaseHint.querySelector('.lease-min-hint')) {
                                const _lh = document.createElement('div');
                                _lh.className = 'lease-min-hint field-hint';
                                _lh.style.color = '#e65100';
                                const _tLease = this.getTranslations();
                                const pre = document.createElement('span');
                                pre.setAttribute('data-i18n', 'minLeaseHintPre');
                                pre.textContent = _tLease.minLeaseHintPre || 'Minimum lease term:';
                                const post = document.createElement('span');
                                post.setAttribute('data-i18n', 'minLeaseHintPost');
                                post.textContent = _tLease.minLeaseHintPost || 'months. Please select a qualifying term.';
                                _lh.replaceChildren(this._icon('fas fa-info-circle'), document.createTextNode(' '), pre, document.createTextNode(' ' + minMonthsNum + ' '), post);
                                _leaseHint.appendChild(_lh);
                            }
                        }
                        // Remove all options except the placeholder
                        while (leaseSelect.options.length > 1) leaseSelect.remove(1);
                        finalTerms.forEach(term => {
                            const opt = document.createElement('option');
                            opt.value = term;
                            opt.textContent = term;
                            leaseSelect.appendChild(opt);
                        });
                        // Auto-select when only one term is available (no manual choice needed)
                        if (finalTerms.length === 1) {
                            leaseSelect.value = finalTerms[0];
                            leaseSelect.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }
                } else if (minMonths) {
                    // No explicit terms list but min_months is set — filter the default dropdown options
                    const minMonthsNum = parseInt(minMonths, 10);
                    const leaseSelect = document.getElementById('desiredLeaseTerm');
                    if (leaseSelect && minMonthsNum > 0) {
                        Array.from(leaseSelect.options).forEach(opt => {
                            if (!opt.value) return; // keep placeholder
                            const mtm = /month.to.month/i.test(opt.value);
                            if (mtm) { opt.style.display = 'none'; opt.disabled = true; return; }
                            const m = opt.value.match(/(\d+)/);
                            const optMonths = m ? parseInt(m[1], 10) : 999;
                            if (optMonths < minMonthsNum) { opt.style.display = 'none'; opt.disabled = true; }
                        });
                    }
                }
              // 9C-2: store source URL so success screen can link back to the original listing
              // SECURITY: only accept same-origin absolute URLs or root-relative paths.
              // Rejects javascript:, data:, vbscript:, protocol-relative (//evil.com), and cross-origin.
              const source = p.get('source') || '';
              if (source) {
                  let safeSource = '';
                  try {
                      const trimmed = String(source).trim();
                      if (trimmed && !trimmed.startsWith('//') && !/^[a-z]+:/i.test(trimmed.split('?')[0])) {
                          // Root-relative path like /listings.html or /property?id=...
                          if (trimmed.startsWith('/')) safeSource = trimmed;
                      } else if (trimmed) {
                          const u = new URL(trimmed, window.location.origin);
                          if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === window.location.origin) {
                              safeSource = u.pathname + u.search + u.hash;
                          }
                      }
                  } catch (_) { /* invalid URL — drop it */ }
                  if (safeSource) this.state.sourceUrl = safeSource;
              }

              setHidden('hiddenPetsAllowed',     pets);
              setHidden('hiddenPetTypes',        petTypes);
              setHidden('hiddenPetWeightLimit',  petWeight);
              setHidden('hiddenPetDeposit',      petDeposit);
              setHidden('hiddenPetDetails',      petDetails);
              setHidden('hiddenSmokingAllowed',  smoking);
              // Pet and smoking questions are left flexible — applicants may answer Yes or No regardless of property policy.


              setHidden('hiddenUtilities',       utilities);
              setHidden('hiddenParking',         parking);
              setHidden('hiddenParkingFee',      parkingFee);
              setHidden('hiddenGarageSpaces',    garageSpaces);
              setHidden('hiddenEvCharging',      evCharging);
              setHidden('hiddenLaundryType',     laundryType);
              setHidden('hiddenHeatingType',     heatingType);
              setHidden('hiddenCoolingType',     coolingType);
              setHidden('hiddenLastMonthsRent',  lastMonthsRent);
              setHidden('hiddenAdminFee',        adminFee);
              setHidden('hiddenMoveInSpecial',   moveInSpecial);

            // Build a formatted address string for the property address field
            const streetParts = [addr, city, state].filter(Boolean);
            const formattedAddr = streetParts.length
                ? streetParts.join(', ')
                : name; // fallback: use property name if no address parts

            // Pre-fill the property address field (Step 1) — URL params always take priority
            const addrField = document.getElementById('propertyAddress');
            if (addrField && formattedAddr) {
                addrField.value = formattedAddr;
                addrField.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // Show the property context banner (with extended listing details)
            this._showPropertyBanner({ id, name, addr, city, state, rent, beds, baths, deposit, avail, terms, lastMonthsRent, adminFee, moveInSpecial, laundryType, heatingType, coolingType, garageSpaces, evCharging, parkingFee });

            // Pre-populate the pet policy hint so it is ready when the user selects "Yes" for pets
            this._applyPetPolicyHint();

        } catch (err) {
            // Silent — never break the form over a missing URL param
            console.warn('_prefillFromURL error (non-fatal):', err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // PROPERTY CONTEXT BANNER — shown between header and progress bar.
    // Lets applicants confirm they're applying for the right property.
    // ─────────────────────────────────────────────────────────────────────
    _showPropertyBanner({ id, name, addr, city, state, rent, beds, baths, deposit, avail, terms, lastMonthsRent, adminFee, moveInSpecial, laundryType, heatingType, coolingType, garageSpaces, evCharging, parkingFee }) {
        if (!name && !addr && !city) return;

        const displayName = name || 'Selected Property';
        const locationParts = [city, state].filter(Boolean).map(s => this._escHtml(s));
        const locationLine = locationParts.length ? locationParts.join(', ') : '';
        const rentLine = rent
            ? '$' + parseFloat(rent).toLocaleString('en-US') + '/mo'
            : '';

        const metaParts = [locationLine, rentLine].filter(Boolean);
        const metaLine = metaParts.join(' &nbsp;·&nbsp; ');

        // Build listing detail chips (beds / baths / deposit / available / lease terms)
        const chips = [];
        if (beds)    chips.push('<span class="pcb-chip"><i class="fas fa-bed"></i> ' + this._escHtml(beds) + ' Bed</span>');
        if (baths)   chips.push('<span class="pcb-chip"><i class="fas fa-bath"></i> ' + this._escHtml(baths) + ' Bath</span>');
        if (deposit) chips.push('<span class="pcb-chip"><i class="fas fa-dollar-sign"></i> $' + parseFloat(deposit).toLocaleString('en-US') + ' Deposit</span>');
        if (avail)   chips.push('<span class="pcb-chip"><i class="fas fa-calendar-check"></i> Avail ' + this._escHtml(avail) + '</span>');
        if (terms) {
            const termsList = terms.split('|').map(function(t) { return t.trim(); }).filter(Boolean);
            if (termsList.length) {
                const termsLabel = termsList.map(function(t) {
                    return t.replace(/(\d+)\s*months?/i, '$1-mo');
                }).join(', ');
                chips.push('<span class="pcb-chip"><i class="fas fa-file-contract"></i> ' + this._escHtml(termsLabel) + '</span>');
            }
        }
        if (lastMonthsRent) chips.push('<span class="pcb-chip"><i class="fas fa-calendar-alt"></i> $' + parseFloat(lastMonthsRent).toLocaleString('en-US') + ' Last Mo. Rent</span>');
        if (adminFee)       chips.push('<span class="pcb-chip"><i class="fas fa-receipt"></i> $' + parseFloat(adminFee).toLocaleString('en-US') + ' Admin Fee</span>');
        if (moveInSpecial)  chips.push('<span class="pcb-chip pcb-chip-promo"><i class="fas fa-tag"></i> ' + this._escHtml(moveInSpecial) + '</span>');
        if (laundryType)    chips.push('<span class="pcb-chip"><i class="fas fa-shirt"></i> ' + this._escHtml(laundryType) + '</span>');
        if (heatingType)    chips.push('<span class="pcb-chip"><i class="fas fa-fire"></i> ' + this._escHtml(heatingType) + '</span>');
        if (coolingType)    chips.push('<span class="pcb-chip"><i class="fas fa-snowflake"></i> ' + this._escHtml(coolingType) + '</span>');
        if (garageSpaces)   chips.push('<span class="pcb-chip"><i class="fas fa-car-side"></i> ' + this._escHtml(garageSpaces) + ' Space(s)</span>');
        if (evCharging && evCharging !== 'none') chips.push('<span class="pcb-chip"><i class="fas fa-charging-station"></i> EV: ' + this._escHtml(evCharging) + '</span>');
        if (parkingFee)     chips.push('<span class="pcb-chip"><i class="fas fa-dollar-sign"></i> $' + parseFloat(parkingFee).toLocaleString('en-US') + '/mo Parking</span>');
        const chipsHtml = chips.length ? '<div class="pcb-chips">' + chips.join('') + '</div>' : '';

        // Back-to-listing link — only shown when a property ID was passed
        const backLinkHtml = id
            ? '<a href="' + this._escHtml((window.CP_CONFIG && window.CP_CONFIG.LISTING_SITE_URL ? window.CP_CONFIG.LISTING_SITE_URL : 'https://choice-properties-site.pages.dev') + '/property.html?id=' + encodeURIComponent(id)) + '" class="pcb-back-link" target="_blank" rel="noopener">' +
                  '<i class="fas fa-arrow-left"></i> <span data-i18n="viewListing">View listing</span>' +
              '</a>'
            : '';

        const banner = document.createElement('div');
        banner.id = 'propertyContextBanner';
        banner.className = 'property-context-banner';
        banner.setAttribute('role', 'note');
        banner.setAttribute('aria-label', 'Property you are applying for');
        this._setTrustedHtml(banner, this._html`
            <div class="pcb-inner">
                <div class="pcb-left">
                    <div class="pcb-icon"><i class="fas fa-home"></i></div>
                    <div class="pcb-text">
                        <div class="pcb-label" data-i18n="applyingFor">Applying for</div>
                        <div class="pcb-name">${displayName}</div>
                        ${this._safeHtml(metaLine ? '<div class="pcb-meta">' + metaLine + '</div>' : '')}
                        ${this._safeHtml(chipsHtml)}
                    </div>
                </div>
                <div class="pcb-right">
                    <div class="pcb-managed">
                        <i class="fas fa-shield-alt"></i>
                        <span><span data-i18n="managedBy">Managed by</span> <strong>Choice Properties</strong></span>
                    </div>
                    ${this._safeHtml(backLinkHtml)}
                </div>
            </div>
        `);

        // Insert before the progress bar
        const progressContainer = document.querySelector('.progress-container');
        if (progressContainer && progressContainer.parentNode) {
            progressContainer.parentNode.insertBefore(banner, progressContainer);
        } else {
            const container = document.querySelector('.container');
            if (container) container.insertBefore(banner, container.firstChild);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // NO-CONTEXT PROMPT — shown when the form is opened without URL params.
    // Guides the applicant to manually enter the property address on Step 1.
    // ─────────────────────────────────────────────────────────────────────
    _showNoContextPrompt() {
        const banner = document.createElement('div');
        banner.id = 'noContextBanner';
        banner.className = 'no-context-banner';
        banner.setAttribute('role', 'note');
        banner.setAttribute('aria-label', 'Property address required');
        const tNc = this.getTranslations();
        const listingSiteUrl = (window.CP_CONFIG && window.CP_CONFIG.LISTING_SITE_URL ? window.CP_CONFIG.LISTING_SITE_URL : 'https://choice-properties-site.pages.dev') + '/listings.html';
        this._setTrustedHtml(banner, this._html`
            <div class="ncb-inner">
                <div class="ncb-icon"><i class="fas fa-map-marker-alt"></i></div>
                <div class="ncb-text">
                    <div class="ncb-title" data-i18n="noContextTitle">${tNc.noContextTitle}</div>
                    <div class="ncb-sub" data-i18n="noContextSub">${tNc.noContextSub}</div>
                    <a href="${listingSiteUrl}" class="ncb-browse-link" data-i18n="browseListings">
                        <i class="fas fa-search"></i>Browse Available Listings
                    </a>
                </div>
            </div>
        `);

        const progressContainer = document.querySelector('.progress-container');
        if (progressContainer && progressContainer.parentNode) {
            progressContainer.parentNode.insertBefore(banner, progressContainer);
        } else {
            const container = document.querySelector('.container');
            if (container) container.insertBefore(banner, container.firstChild);
        }

        // Softly highlight the property address field when it is visible
        const addrField = document.getElementById('propertyAddress');
        if (addrField) {
            addrField.style.borderColor = '#c9a04a';
            addrField.style.boxShadow   = '0 0 0 3px rgba(201,160,74,0.18)';
            addrField.addEventListener('input', function onInput() {
                addrField.style.borderColor = '';
                addrField.style.boxShadow   = '';
                addrField.removeEventListener('input', onInput);
            }, { once: true });
        }
    }

    // Simple HTML escaper used in the property banner
    _escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ─────────────────────────────────────────────────────────────────────
    // PET POLICY HINT — reads pet_types and pet_weight URL params and
    // shows an informational banner inside the pet details section so the
    // applicant knows exactly what this property allows before they type.
    // Called when the user selects "Yes" for pets, and also after prefill.
    // ─────────────────────────────────────────────────────────────────────
    _applyPetPolicyHint() {
        try {
            const p = new URLSearchParams(window.location.search);
            const petTypes  = p.get('pet_types')   || '';
            const petWeight = p.get('pet_weight')  || '';
            const hintBox   = document.getElementById('petPolicyHint');
            const hintText  = document.getElementById('petPolicyHintText');
            const petArea   = document.getElementById('petDetails');
            if (!hintBox || !hintText) return;

            const parts = [];
            if (petTypes)  parts.push({ label: 'Allowed pet types: ', value: petTypes });
            if (petWeight) parts.push({ label: 'Max weight: ', value: petWeight + ' lbs' });

            if (parts.length) {
                hintText.replaceChildren();
                parts.forEach((part, index) => {
                    if (index > 0) hintText.appendChild(document.createTextNode(' \u00a0·\u00a0 '));
                    hintText.appendChild(document.createTextNode(part.label));
                    const strong = document.createElement('strong');
                    strong.textContent = part.value;
                    hintText.appendChild(strong);
                });
                hintText.appendChild(document.createTextNode('. Please describe your pet(s) accordingly.'));
                hintBox.style.display = 'block';
                // Update textarea placeholder to be more specific
                if (petArea) {
                    const typesLabel = petTypes ? petTypes : 'type';
                    const weightLabel = petWeight ? ', under ' + petWeight + ' lbs' : '';
                    petArea.placeholder = 'e.g., Labrador mix' + weightLabel + ' — include type, breed, weight';
                }
            } else {
                hintBox.style.display = 'none';
            }
        } catch (e) { /* non-fatal */ }
    }

    // ─────────────────────────────────────────────────────────────────────
    // PET DETAILS VALIDATION — called from validateStep(2) when Has Pets=Yes.
    // Warns (not hard-blocks) if the pet weight limit param is set and the
    // user's description doesn't appear to include a numeric weight at all.
    // ─────────────────────────────────────────────────────────────────────
    _validatePetDetails() {
        const petField = document.getElementById('petDetails');
        const errEl    = document.getElementById('petDetailsError');
        if (!petField || !errEl) return true;
        const val = petField.value.trim();
        if (!val) {
            errEl.textContent = 'Please describe your pet(s) — type, breed, and weight.';
            errEl.style.display = 'block';
            petField.classList.add('is-invalid');
            return false;
        }
        // Check weight limit if param present
        const p = new URLSearchParams(window.location.search);
        const petWeight = p.get('pet_weight');
        if (petWeight) {
            const limit = parseFloat(petWeight);
            if (!isNaN(limit)) {
                // Look for any number in the description that could be a weight
                const nums = val.match(/\d+(\.\d+)?/g);
                if (nums) {
                    const maxInDesc = Math.max(...nums.map(Number));
                    if (maxInDesc > limit) {
                        errEl.textContent = 'This property has a ' + limit + ' lb pet weight limit. Please confirm your pet meets this requirement.';
                        errEl.style.display = 'block';
                        petField.classList.add('is-invalid');
                        return false;
                    }
                }
            }
        }
        errEl.style.display = 'none';
        petField.classList.remove('is-invalid');
        return true;
    }



    setupOfflineDetection() {
        window.addEventListener('online', () => {
            this.setState({ isOnline: true });
        });
        window.addEventListener('offline', () => {
            this.setState({ isOnline: false });
        });
        this.setState({ isOnline: navigator.onLine });
    }

    setState(newState) {
        this.state = { ...this.state, ...newState };
        this.updateUIState();
    }

    updateUIState() {
        const offlineIndicator = document.getElementById('offlineIndicator');
        if (offlineIndicator) {
            offlineIndicator.style.display = this.state.isOnline ? 'none' : 'block';
        }
        const submitBtn = document.getElementById('mainSubmitBtn');
        if (submitBtn) {
            submitBtn.disabled = !this.state.isOnline;
            submitBtn.title = this.state.isOnline ? '' : 'You are offline';
        }
    }

    // ---------- Geoapify ----------
    setupGeoapify() {
        const apiKey = (window.CP_CONFIG && window.CP_CONFIG.GEOAPIFY_API_KEY) || '';
          if (!apiKey) {
              console.warn('[CP] GEOAPIFY_API_KEY not configured — address autocomplete disabled');
              return;
          }
        const fields = ['propertyAddress', 'currentAddress'];
        fields.forEach(id => {
            const input = document.getElementById(id);
            if (!input) return;
            // Wrap in a relative-positioned container for dropdown positioning
            // Use the existing form-group as the anchor if possible, else create a wrapper
            let container = input.closest('.form-group');
            if (!container) {
                container = document.createElement('div');
                container.style.position = 'relative';
                input.parentNode.insertBefore(container, input);
                container.appendChild(input);
            } else {
                // Ensure the form-group has relative positioning
                container.style.position = 'relative';
            }
            const dropdown = document.createElement('div');
            dropdown.className = 'autocomplete-dropdown';
            container.appendChild(dropdown);
            input.addEventListener('input', this.debounce(async (e) => {
                const text = e.target.value;
                if (text.length < 3) {
                    dropdown.style.display = 'none';
                    return;
                }
                try {
                    const response = await fetch(`https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(text)}&apiKey=${apiKey}`);
                    const data = await response.json();
                    if (data.features && data.features.length > 0) {
                        dropdown.replaceChildren();
                        data.features.forEach(feature => {
                            const item = document.createElement('div');
                            item.textContent = feature.properties.formatted;
                            item.addEventListener('click', () => {
                                input.value = feature.properties.formatted;
                                dropdown.style.display = 'none';
                                this.saveProgress();
                            });
                            dropdown.appendChild(item);
                        });
                        dropdown.style.display = 'block';
                    } else {
                        dropdown.style.display = 'none';
                    }
                } catch (err) {
                    console.error('Geocoding error:', err);
                }
            }, 300));
            document.addEventListener('click', (e) => {
                if (!container.contains(e.target)) dropdown.style.display = 'none';
            });
        });
    }

    // ---------- Input formatting (phone, SSN) ----------
    setupInputFormatting() {
        const phoneFields = ['phone', 'landlordPhone', 'supervisorPhone', 'ref1Phone', 'ref2Phone', 'emergencyPhone', 'coPhone'];
        phoneFields.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', (e) => {
                    let x = e.target.value.replace(/\D/g, '').match(/(\d{0,3})(\d{0,3})(\d{0,4})/);
                    e.target.value = !x[2] ? x[1] : '(' + x[1] + ') ' + x[2] + (x[3] ? '-' + x[3] : '');
                });
            }
        });
        const ssnEl = document.getElementById('ssn');
        if (ssnEl) {
            ssnEl.addEventListener('input', (e) => {
                let val = e.target.value.replace(/\D/g, '');
                if (val.length > 4) val = val.substring(0, 4);
                e.target.value = val;
                if (val.length === 4) this.clearError(ssnEl);
            });
            ssnEl.addEventListener('blur', () => this.validateField(ssnEl));
        }
        const coSsnEl = document.getElementById('coSsn');
        if (coSsnEl) {
            coSsnEl.addEventListener('input', (e) => {
                let val = e.target.value.replace(/\D/g, '');
                if (val.length > 4) val = val.substring(0, 4);
                e.target.value = val;
                if (val.length === 4) this.clearError(coSsnEl);
            });
        }
    }

    // ---------- Income-to-Rent Ratio Display ----------
    // Shows a live affordability indicator in Step 3 when the rent param is in the URL.
    // Updates whenever the applicant types in monthlyIncome or otherIncome.
    setupIncomeRatioDisplay() {
        const p = new URLSearchParams(window.location.search);
        const rent = parseFloat(p.get('rent'));
        if (!rent || isNaN(rent) || rent <= 0) return; // no rent param — skip

        const incomeEl    = document.getElementById('monthlyIncome');
        const otherEl     = document.getElementById('otherIncome');
        const incomeGroup = incomeEl && incomeEl.closest('.form-group');
        if (!incomeGroup) return;

        // Inject the ratio widget once, below the income field
        if (!document.getElementById('incomeRatioWidget')) {
            const widget = document.createElement('div');
            widget.id = 'incomeRatioWidget';
            widget.style.cssText = 'margin-top:10px;padding:12px 14px;border-radius:8px;font-size:13px;line-height:1.5;border:1px solid #e2e8f0;background:#f8fafc;display:none;';
            const header = document.createElement('div');
            header.style.cssText = 'font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:6px;';
            const chartIcon = this._icon('fas fa-chart-bar');
            chartIcon.style.color = 'var(--secondary)';
            const title = document.createElement('span');
            title.textContent = 'Affordability Check';
            const ratioBadge = document.createElement('span');
            ratioBadge.id = 'incomeRatioBadge';
            ratioBadge.style.cssText = 'margin-left:auto;font-size:12px;padding:2px 10px;border-radius:50px;font-weight:700;';
            const detail = document.createElement('div');
            detail.id = 'incomeRatioDetail';
            detail.style.color = '#5f6b7a';
            header.replaceChildren(chartIcon, title, ratioBadge);
            widget.replaceChildren(header, detail);
            // Insert after the income group, before the next sibling
            incomeGroup.parentNode.insertBefore(widget, incomeGroup.nextSibling);
        }

        const updateRatio = () => {
            const widget  = document.getElementById('incomeRatioWidget');
            const badge   = document.getElementById('incomeRatioBadge');
            const detail  = document.getElementById('incomeRatioDetail');
            if (!widget || !badge || !detail) return;

            const rawIncome = (incomeEl ? incomeEl.value : '').replace(/[$,\s]/g, '');
            const rawOther  = (otherEl  ? otherEl.value  : '').replace(/[$,\s]/g, '');
            const income    = parseFloat(rawIncome) || 0;
            const other     = parseFloat(rawOther)  || 0;
            const total     = income + other;

            if (!income) { widget.style.display = 'none'; return; }

            const ratio  = total / rent; // typically landlords require 2.5x–3x
            const pct    = Math.round((rent / total) * 100);
            widget.style.display = 'block';

            let color, bg, label, msg;
            if (ratio >= 3) {
                color = '#1b5e20'; bg = '#e8f5e9'; label = '✓ Qualifies';
                msg = 'Your income is ' + ratio.toFixed(1) + '× the monthly rent ($' +
                      rent.toLocaleString('en-US') + '), which meets the standard 3× requirement.';
            } else if (ratio >= 2.5) {
                color = '#e65100'; bg = '#fff8e1'; label = '⚠ Borderline';
                msg = 'Your income is ' + ratio.toFixed(1) + '× the monthly rent ($' +
                      rent.toLocaleString('en-US') + '). Most landlords require 2.5–3×. This may be reviewed closely.';
            } else {
                color = '#b71c1c'; bg = '#ffebee'; label = '✗ May Not Qualify';
                msg = 'Your income is ' + ratio.toFixed(1) + '× the monthly rent ($' +
                      rent.toLocaleString('en-US') + '). Most landlords require at least 2.5–3×. ' +
                      (other ? '' : 'Adding any additional income above may help.');
            }

            widget.style.background  = bg;
            widget.style.borderColor = color + '55';
            badge.textContent  = label;
            badge.style.cssText = 'margin-left:auto;font-size:12px;padding:2px 10px;border-radius:50px;font-weight:700;background:' + color + ';color:#fff;';
            const muted = document.createElement('span');
            muted.style.color = '#94a3b8';
            muted.textContent = '(' + pct + '% of income goes to rent)';
            detail.replaceChildren(document.createTextNode(msg + ' '), muted);
        };

        if (incomeEl) { incomeEl.addEventListener('input', updateRatio); incomeEl.addEventListener('change', updateRatio); }
        if (otherEl)  { otherEl.addEventListener('input',  updateRatio); otherEl.addEventListener('change',  updateRatio); }
        // Run once on setup in case progress was restored
        setTimeout(updateRatio, 100);
    }

    // ---------- Real-time validation ----------
    setupRealTimeValidation() {
        const form = document.getElementById('rentalApplication');
        if (!form) return;
        const inputs = form.querySelectorAll('input, select, textarea');
        inputs.forEach(input => {
            const refresh = () => {
                // Only validate if the field has been touched (has a value or is losing focus)
                if (input.value.trim() || input.checked) this.validateField(input);
                const activeSection = this.getCurrentSection();
                this.updateFieldsRemainingHint(activeSection);
            };
            input.addEventListener('input', refresh);
            input.addEventListener('change', refresh);
            input.addEventListener('blur', () => {
                this.validateField(input);
                const activeSection = this.getCurrentSection();
                this.updateFieldsRemainingHint(activeSection);
            });
        });
    }

    // ---------- Validation logic ----------
    validateField(field) {
        let isValid = true;
        let errorMessage = 'Required';
        if (field.id === 'ssn' || field.id === 'coSsn') {
            const ssnVal = field.value.replace(/\D/g, '');
            if (!ssnVal) {
                isValid = false;
                errorMessage = this.state.language === 'en' ? 'Please enter the last 4 digits of your SSN.' : 'Por favor ingrese los últimos 4 dígitos de su SSN.';
            } else if (ssnVal.length < 4) {
                isValid = false;
                errorMessage = this.state.language === 'en' ? 'SSN must contain 4 digits.' : 'El SSN debe contener 4 dígitos.';
            } else if (/[^0-9]/.test(field.value)) {
                isValid = false;
                errorMessage = this.state.language === 'en' ? 'SSN must contain numbers only.' : 'El SSN debe contener solo números.';
            }
        } else if (field.id === 'dob' || field.id === 'coDob') {
            const birthDate = this._parseLocalDate(field.value);
            // Build today as date-only integers (no time, no timezone) to avoid
            // the UTC-midnight parse bug where new Date('YYYY-MM-DD') returns
            // midnight UTC which shifts to the previous day in negative-offset zones.
            const now = new Date();
            const todayY = now.getFullYear();
            const todayM = now.getMonth() + 1; // 1-based
            const todayD = now.getDate();
            if (!field.value) {
                isValid = false;
                errorMessage = this.state.language === 'en' ? 'Please enter your date of birth.' : 'Por favor ingrese su fecha de nacimiento.';
            } else if (!birthDate) {
                isValid = false;
                errorMessage = this.state.language === 'en' ? 'Please enter a valid date of birth (18+ required).' : 'Por favor ingrese una fecha válida (18+ requerido).';
            } else {
                // Date-only age calculation: compare year/month/day integers directly.
                // birthDate was constructed by _parseLocalDate which uses new Date(y,m-1,d)
                // so its y/m/d values are always local and correct.
                const bY = birthDate.getFullYear();
                const bM = birthDate.getMonth() + 1; // 1-based
                const bD = birthDate.getDate();
                let age = todayY - bY;
                if (todayM < bM || (todayM === bM && todayD < bD)) age--;
                if (age < 18) {
                    isValid = false;
                    errorMessage = this.state.language === 'en' ? 'Applicants must be at least 18 years old.' : 'Los solicitantes deben tener al menos 18 años.';
                }
            }
        } else if (field.id === 'requestedMoveIn') {
            const moveInDate = this._parseLocalDate(field.value);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            if (!field.value) {
                isValid = false;
                errorMessage = this.state.language === 'en' ? 'Please select a move-in date.' : 'Por favor seleccione una fecha de mudanza.';
            } else if (!moveInDate || moveInDate < today) {
                isValid = false;
                errorMessage = this.state.language === 'en' ? 'Move-in date cannot be in the past.' : 'La fecha de mudanza no puede ser en el pasado.';
            } else {
                // Also validate against property availability date if set
                const availInput = document.getElementById('hiddenAvailableDate');
                const availVal = availInput ? availInput.value : '';
                if (availVal) {
                    const availDate = this._parseLocalDate(availVal);
                    if (availDate && moveInDate < availDate) {
                        isValid = false;
                        errorMessage = this.state.language === 'en'
                            ? `This property is not available until ${availVal}. Please select a date on or after that date.`
                            : `Esta propiedad no estará disponible hasta ${availVal}. Por favor seleccione una fecha en o después de esa fecha.`;
                    }
                }
            }
        } else if (field.hasAttribute('required')) {
            if (field.type === 'checkbox') {
                isValid = field.checked;
            } else if (!field.value.trim()) {
                isValid = false;
            }
            if (!isValid) {
                errorMessage = this.state.language === 'en' ? 'Required' : 'Campo obligatorio';
            }
        }
        if (isValid && field.value.trim()) {
            // Numeric validation for income fields
            if (field.id === 'monthlyIncome' || field.id === 'otherIncome' || field.id === 'coMonthlyIncome') {
                const numVal = field.value.replace(/[$,\s]/g, '');
                if (numVal !== '' && (isNaN(parseFloat(numVal)) || parseFloat(numVal) < 0)) {
                    isValid = false;
                    errorMessage = this.state.language === 'en'
                        ? 'Please enter a valid dollar amount (numbers only).'
                        : 'Por favor ingrese un monto válido (solo números).';
                }
            }
            if (field.type === 'email') {
                const email = field.value.trim();
                if (!email.includes('@')) {
                    isValid = false;
                    errorMessage = this.state.language === 'en' ? 'Email must include an @ symbol.' : 'El correo debe incluir un símbolo @.';
                } else {
                    const parts = email.split('@');
                    if (!parts[1] || !parts[1].includes('.')) {
                        isValid = false;
                        errorMessage = this.state.language === 'en' ? 'Add a valid domain (e.g., gmail.com).' : 'Agregue un dominio válido (ej. gmail.com).';
                    } else {
                        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                        isValid = emailRegex.test(email);
                        if (!isValid) {
                            errorMessage = this.state.language === 'en' ? 'Enter a valid email (example: name@email.com).' : 'Ingrese un correo válido (ejemplo: nombre@email.com).';
                        }
                    }
                }
            } else if (field.type === 'tel') {
                const phoneDigits = field.value.replace(/\D/g, '');
                isValid = phoneDigits.length >= 10;
                if (!isValid) {
                    errorMessage = this.state.language === 'en' ? 'Invalid phone' : 'Teléfono inválido';
                }
            }
        }
        if (isValid) {
            this.clearError(field);
            field.classList.add('is-valid');
            field.classList.remove('is-invalid');
        } else {
            this.showError(field, errorMessage);
            field.classList.add('is-invalid');
            field.classList.remove('is-valid');
            field.classList.add('shake');
            setTimeout(() => field.classList.remove('shake'), 400);
        }
        return isValid;
    }

    showError(field, message) {
        field.classList.add('error');
        const errorMsg = field.closest('.form-group')?.querySelector('.error-message');
        if (errorMsg) {
            errorMsg.textContent = message;
            errorMsg.style.display = 'block';
        }
    }

    clearError(field) {
        field.classList.remove('error');
        const errorMsg = field.closest('.form-group')?.querySelector('.error-message');
        if (errorMsg) {
            errorMsg.style.display = 'none';
        }
    }

    // ---------- Section navigation ----------
    getCurrentSection() {
        const activeSection = document.querySelector('.form-section.active');
        return activeSection ? parseInt(activeSection.id.replace('section', '')) : 1;
    }

    nextSection(currentSection) {
        if (!this.validateStep(currentSection)) return;
        this.hideSection(currentSection);
        this._slideDir = 'forward';
        this.showSection(currentSection + 1);
        this.updateProgressBar();
        if (currentSection + 1 === 6) this.generateApplicationSummary();
    }

    previousSection(currentSection) {
        if (currentSection > 1) {
            this.hideSection(currentSection);
            this._slideDir = 'back';
            this.showSection(currentSection - 1);
            this.updateProgressBar();
        }
    }

    hideSection(sectionNumber) {
        const section = document.getElementById(`section${sectionNumber}`);
        if (section) section.classList.remove('active', 'slide-back');
    }

    showSection(sectionNumber) {
        const section = document.getElementById(`section${sectionNumber}`);
        if (section) {
            section.classList.remove('slide-back');
            if (this._slideDir === 'back') section.classList.add('slide-back');
            this._slideDir = null;
            section.classList.add('active');
            window.scrollTo({ top: 0, behavior: 'smooth' });
            this.updateFieldsRemainingHint(sectionNumber);
            this._updateStartOverBtn(sectionNumber);
        }
    }

    // ---------- Start Over ----------
    _updateStartOverBtn(sectionNumber) {
        const btn = document.getElementById('startOverBtn');
        if (!btn) return;
        btn.classList.toggle('visible', sectionNumber > 1);
    }

    _openClearSheet() {
        document.getElementById('clearFormOverlay').classList.add('open');
        document.getElementById('clearFormSheet').classList.add('open');
    }

    _closeClearSheet() {
        document.getElementById('clearFormOverlay').classList.remove('open');
        document.getElementById('clearFormSheet').classList.remove('open');
    }

    _clearForm() {
        try { localStorage.removeItem(this.config.LOCAL_STORAGE_KEY); } catch(e) {}
        location.reload();
    }

    // ---------- Fields-remaining hint on Next button ----------
    updateFieldsRemainingHint(sectionNumber) {
        const section = document.getElementById(`section${sectionNumber}`);
        if (!section) return;
        const nextBtn = section.querySelector('.btn-next');
        if (!nextBtn) return;

        let hint = nextBtn.parentElement.querySelector('.btn-hint');
        if (!hint) {
            hint = document.createElement('span');
            hint.className = 'btn-hint';
            nextBtn.parentElement.appendChild(hint);
        }

        const inputs = section.querySelectorAll('input[required], select[required], textarea[required]');
        let emptyCount = 0;
        inputs.forEach(input => {
            if (input.type === 'checkbox') {
                if (!input.checked) emptyCount++;
            } else if (!input.value.trim()) {
                emptyCount++;
            }
        });

        if (emptyCount > 0) {
            hint.textContent = emptyCount === 1
                ? '1 required field still needs to be filled'
                : `${emptyCount} required fields still need to be filled`;
            hint.classList.add('has-remaining');
        } else {
            hint.textContent = '';
            hint.classList.remove('has-remaining');
        }
    }

    updateProgressBar() {
        const currentSection = this.getCurrentSection();
        const progress = ((currentSection - 1) / 5) * 100;
        const progressFill = document.getElementById('progressFill');
        if (progressFill) progressFill.style.width = `${progress}%`;
        const progressContainer = document.querySelector('.progress-container');
        const t = this.getTranslations();
        const stepNames = [t.step1Label, t.step2Label, t.step3Label, t.step4Label, t.step5Label, t.step6Label];
        const progressText = `${t.stepPrefix} ${currentSection} ${t.stepOf} 6: ${stepNames[currentSection-1]}`;
        if (progressContainer) progressContainer.setAttribute('data-progress-text', progressText);
        for (let i = 1; i <= 6; i++) {
            const step = document.getElementById(`step${i}`);
            if (step) {
                step.classList.remove('active', 'completed');
                if (i < currentSection) step.classList.add('completed');
                if (i === currentSection) step.classList.add('active');
            }
        }
    }

    // ---------- Step validation ----------
    validateStep(stepNumber) {
        if (stepNumber === 5) {
            const isUnique = this.validatePaymentSelections();
            if (!isUnique) {
                const warning = document.getElementById('paymentDuplicateWarning');
                if (warning) {
                    warning.classList.add('shake');
                    setTimeout(() => warning.classList.remove('shake'), 400);
                }
                return false;
            }
        }
        const section = document.getElementById(`section${stepNumber}`);
        if (!section) return true;
        const inputs = section.querySelectorAll('input, select, textarea');
        let isStepValid = true;
        let firstInvalidField = null;
        inputs.forEach(input => {
            // Skip inputs inside hidden containers (e.g. co-applicant section when not checked)
            if (input.type !== 'hidden' && !input.offsetParent) return;
            if (input.hasAttribute('required')) {
                if (!this.validateField(input)) {
                    isStepValid = false;
                    if (!firstInvalidField) firstInvalidField = input;
                }
            }
        });
        if (stepNumber === 1) {
            // Block progression if no property ID — visitor opened /apply/ directly
            const hiddenPropId = document.getElementById('hiddenPropertyId');
            if (!hiddenPropId || !hiddenPropId.value.trim()) {
                const existingErr = document.getElementById('noPropIdError');
                if (!existingErr) {
                    const errBanner = document.createElement('div');
                    errBanner.id = 'noPropIdError';
                    errBanner.className = 'no-context-banner';
                    errBanner.setAttribute('role', 'alert');
                    const listingUrl = (window.CP_CONFIG && window.CP_CONFIG.LISTING_SITE_URL
                        ? window.CP_CONFIG.LISTING_SITE_URL
                        : 'https://choice-properties-site.pages.dev') + '/listings.html';
                    errBanner.innerHTML = '<div class="ncb-inner" style="border:2px solid #e65100">' +
                        '<div class="ncb-icon"><i class="fas fa-exclamation-triangle" style="color:#e65100"></i></div>' +
                        '<div class="ncb-text">' +
                        '<div class="ncb-title" style="color:#e65100">No property selected</div>' +
                        '<div class="ncb-sub">Please choose a property from our listings before applying. Applications must be linked to an available property.</div>' +
                        '<a href="' + listingUrl + '" class="ncb-browse-link"><i class="fas fa-search"></i> Browse Available Listings</a>' +
                        '</div></div>';
                    const progressContainer = document.querySelector('.progress-container');
                    if (progressContainer && progressContainer.parentNode) {
                        progressContainer.parentNode.insertBefore(errBanner, progressContainer);
                    }
                    errBanner.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                isStepValid = false;
            }

            const hasCoApplicant = document.getElementById('hasCoApplicant');
            const coSection = document.getElementById('coApplicantSection');
            if (hasCoApplicant && hasCoApplicant.checked && coSection && coSection.style.display !== 'none') {
                const coInputs = coSection.querySelectorAll('input, select, textarea');
                coInputs.forEach(input => {
                    if (input.type === 'radio') {
                        const name = input.name;
                        const radios = coSection.querySelectorAll(`input[name="${name}"]`);
                        const checked = Array.from(radios).some(r => r.checked);
                        if (!checked) {
                            this.showError(radios[0], this.state.language === 'en' ? 'Please select a role' : 'Por favor seleccione un rol');
                            radios[0].classList.add('is-invalid');
                            isStepValid = false;
                            if (!firstInvalidField) firstInvalidField = radios[0];
                        } else {
                            radios.forEach(r => this.clearError(r));
                        }
                    } else if (input.type === 'checkbox') {
                        if (input.id === 'coConsent' && !input.checked) {
                            this.showError(input, this.state.language === 'en' ? 'You must authorize verification' : 'Debe autorizar la verificación');
                            input.classList.add('is-invalid');
                            isStepValid = false;
                            if (!firstInvalidField) firstInvalidField = input;
                        } else {
                            this.clearError(input);
                        }
                    } else {
                        if (input.hasAttribute('required') && !input.value.trim()) {
                            this.showError(input, this.state.language === 'en' ? 'Required' : 'Campo obligatorio');
                            input.classList.add('is-invalid');
                            isStepValid = false;
                            if (!firstInvalidField) firstInvalidField = input;
                        } else {
                            if (input.value.trim() && !this.validateField(input)) {
                                isStepValid = false;
                                if (!firstInvalidField) firstInvalidField = input;
                            } else {
                                this.clearError(input);
                            }
                        }
                    }
                });
            }
        }
        if (stepNumber === 5) {
              // Validate "Preferred Contact Method" — at least one checkbox required
              const _contactChecked = section.querySelectorAll('input[name="Preferred Contact Method"]:checked');
              const _contactErrEl   = document.getElementById('contactMethodError');
              if (_contactChecked.length === 0) {
                  const _firstContact = section.querySelector('input[name="Preferred Contact Method"]');
                  const _contactMsg   = this.state.language === 'en'
                      ? 'Please select at least one contact method'
                      : 'Por favor seleccione al menos un método de contacto';
                  if (_contactErrEl) { _contactErrEl.textContent = _contactMsg; _contactErrEl.style.display = 'block'; }
                  if (_firstContact) { _firstContact.classList.add('is-invalid'); }
                  isStepValid = false;
                  if (!firstInvalidField) firstInvalidField = _firstContact || _contactErrEl;
              } else {
                  if (_contactErrEl) _contactErrEl.style.display = 'none';
                  section.querySelectorAll('input[name="Preferred Contact Method"]').forEach(cb => cb.classList.remove('is-invalid'));
              }

              // Validate "Preferred Time" — at least one checkbox required
              const _timeChecked = section.querySelectorAll('input[name="Preferred Time"]:checked');
              const _timeErrEl   = document.getElementById('preferredTimeError');
              if (_timeChecked.length === 0) {
                  const _firstTime = section.querySelector('input[name="Preferred Time"]');
                  const _timeMsg   = this.state.language === 'en'
                      ? 'Please select at least one availability window'
                      : 'Por favor seleccione al menos una ventana de disponibilidad';
                  if (_timeErrEl) { _timeErrEl.textContent = _timeMsg; _timeErrEl.style.display = 'block'; }
                  if (_firstTime) { _firstTime.classList.add('is-invalid'); }
                  isStepValid = false;
                  if (!firstInvalidField) firstInvalidField = _firstTime || _timeErrEl;
              } else {
                  if (_timeErrEl) _timeErrEl.style.display = 'none';
                  section.querySelectorAll('input[name="Preferred Time"]').forEach(cb => cb.classList.remove('is-invalid'));
              }
          }
        // Step 2: validate pet details when user has pets
        if (stepNumber === 2) {
            const petsYes = document.getElementById('petsYes');
            if (petsYes && petsYes.checked) {
                if (!this._validatePetDetails()) {
                    isStepValid = false;
                    const petField = document.getElementById('petDetails');
                    if (!firstInvalidField) firstInvalidField = petField;
                }
            }
        }
        if (!isStepValid && firstInvalidField) this.scrollToInvalidField(firstInvalidField);
        return isStepValid;
    }

    validatePaymentSelections() {
        const s1 = document.getElementById('primaryPayment').value;
        const s2 = document.getElementById('secondaryPayment').value;
        const s3 = document.getElementById('thirdPayment').value;
        const warning = document.getElementById('paymentDuplicateWarning');
        let hasDuplicate = false;
        const values = [s1, s2, s3].filter(v => v && v !== 'Other');
        const uniqueValues = new Set(values);
        if (values.length !== uniqueValues.size) hasDuplicate = true;
        if (warning) warning.style.display = hasDuplicate ? 'block' : 'none';
        return !hasDuplicate;
    }

    scrollToInvalidField(field) {
        const scrollTarget = field.closest('.form-group') || field;
        scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
        field.classList.add('shake', 'highlight-field');
        setTimeout(() => field.focus(), 100);
        setTimeout(() => field.classList.remove('shake', 'highlight-field'), 2000);
    }

    // ---------- Conditional fields ----------
    setupConditionalFields() {
        const paymentSelectors = ['primaryPayment', 'secondaryPayment', 'thirdPayment'];
        paymentSelectors.forEach(id => {
            const select = document.getElementById(id);
            if (select) {
                select.addEventListener('change', (e) => {
                    const otherContainer = document.getElementById(`${id}OtherContainer`);
                    const otherInput = document.getElementById(`${id}Other`);
                    const isOther = e.target.value === 'Other';
                    if (otherContainer) otherContainer.style.display = isOther ? 'block' : 'none';
                    if (otherInput) {
                        if (isOther) {
                            otherInput.setAttribute('required', 'required');
                            otherInput.focus();
                        } else {
                            otherInput.removeAttribute('required');
                            otherInput.value = '';
                        }
                    }
                    this.validatePaymentSelections();
                });
            }
        });
        const petsRadio = document.getElementsByName('Has Pets');
        const petGroup = document.getElementById('petDetailsGroup');
        if (petsRadio && petGroup) {
            petsRadio.forEach(r => r.addEventListener('change', (e) => {
                const show = e.target.value === 'Yes';
                petGroup.style.display = show ? 'block' : 'none';
                // When showing the pet section, populate the policy hint from URL params
                if (show) this._applyPetPolicyHint();
            }));
        }
        const hasCoApplicantCheck = document.getElementById('hasCoApplicant');
        const coApplicantSection = document.getElementById('coApplicantSection');
        const coRequiredIds = ['coFirstName', 'coLastName', 'coEmail', 'coPhone', 'coDob', 'coSsn'];
        if (hasCoApplicantCheck && coApplicantSection) {
            hasCoApplicantCheck.addEventListener('change', (e) => {
                coApplicantSection.style.display = e.target.checked ? 'block' : 'none';
                if (e.target.checked) {
                    coRequiredIds.forEach(id => {
                        const el = document.getElementById(id);
                        if (el) el.setAttribute('required', 'required');
                    });
                    // coConsent must be checked when section is visible
                    const coConsentEl = document.getElementById('coConsent');
                    if (coConsentEl) coConsentEl.setAttribute('required', 'required');
                } else {
                    coRequiredIds.forEach(id => {
                        const el = document.getElementById(id);
                        if (el) { el.removeAttribute('required'); el.value = ''; }
                    });
                    // Remove required from coConsent and uncheck it when section hides
                    const coConsentEl = document.getElementById('coConsent');
                    if (coConsentEl) { coConsentEl.removeAttribute('required'); coConsentEl.checked = false; }
                    const inputs = coApplicantSection.querySelectorAll('input, select, textarea');
                    inputs.forEach(input => this.clearError(input));
                }
            });
        }
        const vehicleYes = document.getElementById('vehicleYes');
        const vehicleNo = document.getElementById('vehicleNo');
        const vehicleDetails = document.getElementById('vehicleDetailsSection');
        if (vehicleYes && vehicleNo && vehicleDetails) {
            const toggleVehicle = () => {
                vehicleDetails.style.display = vehicleYes.checked ? 'block' : 'none';
            };
            vehicleYes.addEventListener('change', toggleVehicle);
            vehicleNo.addEventListener('change', toggleVehicle);
        }

        // ── Employment status: conditionally show/label/require employer fields ──
        // Each status type shows different fields with different labels.
        const toggleEmployerSection = (status) => {
            const lang = this.state.language || 'en';
            const getLabel = (id) => document.querySelector(`label[for="${id}"]`);
            const rowsSeen = new Set();

            const showField = (id, required, labelEn, labelEs) => {
                const el = document.getElementById(id);
                if (!el) return;
                if (required) el.setAttribute('required', 'required');
                else el.removeAttribute('required');
                el.classList.remove('is-invalid');
                this.clearError(el);
                const lbl = getLabel(id);
                if (lbl && labelEn) lbl.textContent = lang === 'es' ? labelEs : labelEn;
                const col = el.closest('.form-col') || el.closest('.form-group');
                if (col && !rowsSeen.has(col)) { col.style.display = ''; rowsSeen.add(col); }
            };

            const hideField = (id) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.removeAttribute('required');
                el.value = '';
                el.classList.remove('is-invalid');
                this.clearError(el);
                const col = el.closest('.form-col') || el.closest('.form-group');
                if (col && !rowsSeen.has(col)) { col.style.display = 'none'; rowsSeen.add(col); }
            };

            if (status === 'Unemployed') {
                hideField('employer');
                hideField('jobTitle');
                hideField('employmentDuration');
                hideField('supervisorName');
                hideField('supervisorPhone');
            } else if (status === 'Retired') {
                showField('employer', false, 'Former Employer (Optional)', 'Empleador Anterior (Opcional)');
                showField('jobTitle', false, 'Former Job Title (Optional)', 'Cargo Anterior (Opcional)');
                showField('employmentDuration', false, 'How long at this job?', '¿Cuánto tiempo en este trabajo?');
                hideField('supervisorName');
                hideField('supervisorPhone');
            } else if (status === 'Student') {
                showField('employer', false, 'School / Institution Name (Optional)', 'Escuela / Institución (Opcional)');
                showField('jobTitle', false, 'Program / Field of Study (Optional)', 'Programa / Campo de Estudio (Opcional)');
                showField('employmentDuration', false, 'Years at Institution', 'Años en la institución');
                hideField('supervisorName');
                hideField('supervisorPhone');
            } else if (status === 'Self-employed') {
                showField('employer', true, 'Business Name', 'Nombre del Negocio');
                showField('jobTitle', true, 'Your Role / Title', 'Su Rol / Cargo');
                showField('employmentDuration', true, 'How long in business?', '¿Cuánto tiempo en el negocio?');
                hideField('supervisorName');
                hideField('supervisorPhone');
            } else {
                showField('employer', true, 'Employer', 'Empleador');
                showField('jobTitle', true, 'Job Title', 'Puesto');
                showField('employmentDuration', true, 'How long at this job?', '¿Cuánto tiempo en este trabajo?');
                showField('supervisorName', true, 'Supervisor Name', 'Nombre del supervisor');
                showField('supervisorPhone', true, 'Supervisor Phone', 'Teléfono del supervisor');
            }
        };

        const empStatusEl = document.getElementById('employmentStatus');
        if (empStatusEl) {
            empStatusEl.addEventListener('change', () => toggleEmployerSection(empStatusEl.value));
            toggleEmployerSection(empStatusEl.value);
        }
        this._toggleEmployerSection = toggleEmployerSection;
    }

    setupFileUploads() {
        this._uploadedFiles = [];
        const input = document.getElementById('docUpload');
        const zone  = document.getElementById('uploadZone');
        const list  = document.getElementById('uploadedFiles');
        if (!input || !zone || !list) return;

        const MAX_SIZE  = 1 * 1024 * 1024; // [10A-3] 1 MB per file — keeps total base64 payload safe
        const MAX_FILES = 4;
        const MAX_TOTAL = 3 * 1024 * 1024; // 3 MB combined — must match server payload guard

        const updateMeter = () => {
            const meter = document.getElementById('uploadMeter');
            const countEl = document.getElementById('uploadMeterCount');
            const usedEl  = document.getElementById('uploadMeterUsed');
            const barEl   = document.getElementById('uploadMeterBar');
            if (!meter) return;
            const count = this._uploadedFiles.length;
            const total = this._uploadedFiles.reduce((s, f) => s + f.size, 0);
            const pct = Math.min(100, Math.round((total / MAX_TOTAL) * 100));
            if (countEl) countEl.textContent = String(count);
            if (usedEl)  usedEl.textContent  = (total / 1024).toFixed(0);
            if (barEl) {
                barEl.style.width = pct + '%';
                barEl.style.background = pct >= 100 ? 'var(--danger, #dc2626)' : (pct >= 80 ? '#f59e0b' : 'var(--secondary)');
            }
            meter.style.display = count > 0 ? 'block' : 'none';
        };

        const renderList = () => {
            const items = this._uploadedFiles.map((f, i) => {
                const item = document.createElement('div');
                item.className = 'upload-file-item';

                const isImage = /\.(jpg|jpeg|png)$/i.test(f.name);
                const isPdf   = /\.pdf$/i.test(f.name);

                if (isImage && f._dataUrl) {
                    const thumb = document.createElement('img');
                    thumb.src = f._dataUrl;
                    thumb.alt = f.name;
                    thumb.style.cssText = 'width:40px;height:40px;object-fit:cover;border-radius:4px;flex-shrink:0;border:1px solid #e2e8f0;';
                    item.appendChild(thumb);
                } else if (isPdf) {
                    const badge = document.createElement('span');
                    badge.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;background:#fee2e2;border-radius:4px;flex-shrink:0;';
                    const pdfIcon = this._icon('fas fa-file-pdf');
                    pdfIcon.style.cssText = 'color:#dc2626;font-size:18px;';
                    badge.appendChild(pdfIcon);
                    item.appendChild(badge);
                } else {
                    const icon = this._icon('fas fa-file-alt');
                    icon.style.cssText = 'color:var(--secondary);flex-shrink:0;';
                    item.appendChild(icon);
                }

                const info = document.createElement('div');
                info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';

                const name = document.createElement('span');
                name.className = 'upload-file-name';
                name.style.cssText = 'display:flex;align-items:center;gap:4px;flex-wrap:wrap;';
                name.textContent = f.name;

                if (isPdf) {
                    const verified = document.createElement('span');
                    verified.style.cssText = 'display:inline-flex;align-items:center;gap:3px;font-size:10px;color:#059669;font-weight:600;white-space:nowrap;';
                    const checkIcon = this._icon('fas fa-check-circle');
                    checkIcon.style.cssText = 'font-size:10px;';
                    verified.appendChild(checkIcon);
                    verified.appendChild(document.createTextNode(' Uploaded'));
                    name.appendChild(verified);
                }

                const size = document.createElement('span');
                size.className = 'upload-file-size';
                size.textContent = '(' + (f.size / 1024).toFixed(0) + ' KB)';

                info.appendChild(name);
                info.appendChild(size);

                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'upload-remove-btn';
                remove.dataset.removeIdx = String(i);
                remove.setAttribute('aria-label', 'Remove ' + f.name);
                remove.replaceChildren(this._icon('fas fa-xmark'));

                item.appendChild(info);
                item.appendChild(remove);
                return item;
            });
            list.replaceChildren(...items);
            updateMeter();
        };
        list.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-remove-idx]');
            if (btn) {
                const idx = parseInt(btn.getAttribute('data-remove-idx'), 10);
                this._uploadedFiles.splice(idx, 1);
                renderList();
            }
        });

        const _showUploadErr = (msg) => {
              const _ue = document.getElementById('uploadError');
              if (_ue) { _ue.textContent = msg; _ue.style.display = 'block'; setTimeout(() => { _ue.style.display = 'none'; }, 5000); }
          };
  
        const handleFiles = (files) => {
            Array.from(files).forEach(file => {
                if (this._uploadedFiles.length >= MAX_FILES) {
                    _showUploadErr(`Maximum of ${MAX_FILES} files permitted.`); return;
                }
                if (file.size > MAX_SIZE) {
                    _showUploadErr(`"${file.name}" exceeds the 1 MB per-file limit (${(file.size/1024/1024).toFixed(1)} MB).`); return;
                }
                const currentTotal = this._uploadedFiles.reduce((s, f) => s + f.size, 0);
                if (currentTotal + file.size > MAX_TOTAL) {
                    _showUploadErr(`Adding "${file.name}" would exceed the 3 MB total limit. Remove an existing file before proceeding.`); return;
                }
                if (this._uploadedFiles.some(f => f.name === file.name)) return;
                const isImage = /\.(jpg|jpeg|png)$/i.test(file.name);
                if (isImage) {
                    const reader = new FileReader();
                    reader.onload = (e) => { file._dataUrl = e.target.result; renderList(); };
                    reader.readAsDataURL(file);
                }
                this._uploadedFiles.push(file);
            });
            renderList();
        };

        input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; this.saveProgress(); });
        zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
        zone.addEventListener('drop', e => {
            e.preventDefault(); zone.classList.remove('drag-over');
            handleFiles(e.dataTransfer.files);
            this.saveProgress();
        });

        // Re-render hook so draft-restore can repopulate the list after
        // _uploadedFiles has been re-hydrated from a saved/server draft.
        // setupFileUploads is only called once, so renderList lives in this
        // closure — exposing it via `this` is the cleanest bridge. (Issue #14)
        this._rerenderUploadedFiles = () => { renderList(); updateMeter(); };
    }

    // ---------- Save & Resume Later ----------
    setupSaveResume() {
        // Inject the modal HTML once
        if (!document.getElementById('saveResumeModal')) {
            const modal = document.createElement('div');
            modal.id = 'saveResumeModal';
            modal.className = 'save-resume-modal';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-label', 'Save progress and resume later');
            this._setTrustedHtml(modal, `
                <div class="save-resume-card">
                    <h3><i class="fas fa-bookmark" style="color:var(--secondary);margin-right:8px;"></i><span data-i18n="saveResumeLater">Save &amp; Resume Later</span></h3>
                    <p data-i18n="saveResumeDesc">Enter your email and we'll send you a link to resume your application exactly where you left off.</p>
                    <p style="font-size:12px;color:#27ae60;margin:4px 0 0;"><i class="fas fa-check-circle"></i> Your progress is saved for 7 days. The link works on any device or browser.</p>
                    <div class="form-group">
                        <input type="email" id="resumeEmailInput" placeholder="your@email.com" autocomplete="email" />
                    </div>
                    <div class="save-resume-actions">
                        <button class="btn-send-link" id="sendResumeLinkBtn">
                            <i class="fas fa-paper-plane"></i> <span data-i18n="sendLink">Send Link</span>
                        </button>
                        <button class="btn-cancel-resume" id="cancelResumeBtn" data-i18n="cancel">Cancel</button>
                    </div>
                    <div class="save-resume-success" id="saveResumeSuccess">
                        <i class="fas fa-check-circle"></i> <span data-i18n="linkSent">Link sent! Check your inbox.</span>
                    </div>
                </div>`);
            document.body.appendChild(modal);
        }

        // Inject "Save & Resume" bar below each step's nav buttons
        document.querySelectorAll('.form-section').forEach(section => {
            if (section.querySelector('.save-resume-bar')) return;
            const bar = document.createElement('div');
            bar.className = 'save-resume-bar';
            this._setTrustedHtml(bar, `<button type="button" class="btn-save-resume save-resume-trigger">
                <i class="fas fa-bookmark"></i> <span data-i18n="saveResumeLater">Save &amp; Resume Later</span>
            </button>`);
            section.appendChild(bar);
        });

        // Open modal
        document.addEventListener('click', (e) => {
            if (e.target.matches('.save-resume-trigger') || e.target.closest('.save-resume-trigger')) {
                const emailField = document.getElementById('rentalApplication')?.querySelector('#email');
                const prefill = emailField ? emailField.value.trim() : '';
                const input = document.getElementById('resumeEmailInput');
                if (input && prefill && !input.value) input.value = prefill;
                document.getElementById('saveResumeModal').classList.add('open');
                const successEl = document.getElementById('saveResumeSuccess');
                if (successEl) successEl.classList.remove('show');
                if (input) input.focus();
            }
        });

        // Close modal
        document.getElementById('cancelResumeBtn')?.addEventListener('click', () => {
            document.getElementById('saveResumeModal').classList.remove('open');
        });
        document.getElementById('saveResumeModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
        });

        // Send link
        document.getElementById('sendResumeLinkBtn')?.addEventListener('click', async () => {
              const emailInput = document.getElementById('resumeEmailInput');
              const sendBtn = document.getElementById('sendResumeLinkBtn');
              const email = emailInput ? emailInput.value.trim() : '';
              if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                  emailInput.style.borderColor = '#e74c3c';
                  emailInput.focus();
                  return;
              }
              emailInput.style.borderColor = '';

              // Generate a unique token for this draft
              const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

              // Collect progress snapshot (strip sensitive fields before sending to server)
              await this.saveProgress();
              const rawData = this.getAllFormData();
              ['SSN', 'Application ID', 'Co-Applicant SSN', 'DOB', 'Co-Applicant DOB'].forEach(k => delete rawData[k]);
              rawData._last_updated = new Date().toISOString();
              rawData._currentStep = this.getCurrentSection();
              rawData._language = this.state.language || 'en';
              const _urlP = new URLSearchParams(window.location.search);
              const propertyFingerprint = _urlP.get('id') || _urlP.get('addr') || '';
              rawData._propertyFingerprint = propertyFingerprint;
              // Issue #14: include attached documents in the server-side draft
              // so resuming on another device brings them back too.
              rawData._documents = await this._collectDocumentsForDraft();

              // Build resume URL — includes the token so any device can retrieve the draft
              const currentParams = new URLSearchParams(window.location.search);
              currentParams.set('resume', token);
              const resumeUrl = window.location.origin + window.location.pathname + '?' + currentParams.toString();

              // Show loading state
              if (sendBtn) { sendBtn.disabled = true; this._setIconText(sendBtn, 'fas fa-spinner fa-spin', 'Sending…'); }

              // POST draft to backend — stores it in Supabase and sends the email
              let emailSent = false;
              try {
                  const backendBase = (window.CP_CONFIG && window.CP_CONFIG.SUPABASE_URL)
                      ? window.CP_CONFIG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/save-draft'
                      : '';
                  if (backendBase) {
                      const res = await fetch(backendBase, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                              token,
                              email,
                              // resume_url is built server-side from the token (never trusted from client)
                              send_email: true,
                              data: rawData,
                              property_fingerprint: propertyFingerprint,
                          }),
                      });
                      if (res.ok) emailSent = true;
                  }
              } catch (err) {
                  console.warn('[CP App] save-draft request failed (non-fatal):', err);
              }

              if (sendBtn) { sendBtn.disabled = false; this._setIconText(sendBtn, 'fas fa-paper-plane', 'Send Link'); }

              const successEl = document.getElementById('saveResumeSuccess');
              if (successEl) {
                  this._setIconText(successEl, 'fas fa-check-circle', emailSent ? 'Link sent! Check your inbox.' : 'Progress saved on this device.');
                  successEl.classList.add('show');
              }
              setTimeout(() => {
                  document.getElementById('saveResumeModal').classList.remove('open');
                  if (successEl) successEl.classList.remove('show');
              }, 2800);
          });
    }

    setupCharacterCounters() {
        const textareas = document.querySelectorAll('textarea');
        textareas.forEach(textarea => {
            if (!textarea.hasAttribute('maxlength')) {
                textarea.setAttribute('maxlength', '500');
            }
            const parent = textarea.parentElement;
            const counter = document.createElement('div');
            counter.className = 'character-count';
            counter.style.fontSize = '11px';
            counter.style.textAlign = 'right';
            counter.style.color = '#7f8c8d';
            parent.appendChild(counter);
            const updateCounter = () => {
                const len = textarea.value.length;
                const max = textarea.getAttribute('maxlength');
                const tC = this.getTranslations();
                counter.textContent = `${len}/${max} ${tC.charCount}`;
            };
            textarea.addEventListener('input', updateCounter);
            updateCounter();
        });
    }

    // Show a top-of-page banner — used for friendly resume-link messages.
    _showResumeBanner(message, tone) {
        try {
            const existing = document.getElementById('resumeBanner');
            if (existing) existing.remove();
            const bg = tone === 'warn' ? '#fef3c7' : (tone === 'error' ? '#fee2e2' : '#dbeafe');
            const fg = tone === 'warn' ? '#92400e' : (tone === 'error' ? '#991b1b' : '#1e3a8a');
            const banner = document.createElement('div');
            banner.id = 'resumeBanner';
            banner.setAttribute('role', 'status');
            banner.style.cssText = `position:sticky;top:0;z-index:9000;background:${bg};color:${fg};padding:12px 16px;font-size:14px;line-height:1.45;border-bottom:1px solid rgba(0,0,0,0.08);display:flex;gap:10px;align-items:flex-start;`;
            const icon = document.createElement('i');
            icon.className = tone === 'error' ? 'fas fa-circle-exclamation' : 'fas fa-circle-info';
            icon.style.cssText = 'flex-shrink:0;margin-top:2px;';
            const text = document.createElement('div');
            text.style.cssText = 'flex:1;';
            text.textContent = message;
            const close = document.createElement('button');
            close.type = 'button';
            close.setAttribute('aria-label', 'Dismiss');
            close.textContent = '×';
            close.style.cssText = `background:transparent;border:none;color:${fg};font-size:20px;cursor:pointer;line-height:1;padding:0 4px;`;
            close.addEventListener('click', () => banner.remove());
            banner.replaceChildren(icon, text, close);
            document.body.insertBefore(banner, document.body.firstChild);
        } catch (_) { /* non-fatal */ }
    }

    // Restores saved progress using the resume token.
    // Fetches from the Supabase save-draft backend (cross-device), then falls
    // back to localStorage if the server is unreachable or the draft has expired.
    async _restoreFromServer(token) {
        let serverData = null;
        let tokenStatus = 'unknown'; // 'ok' | 'expired' | 'unreachable' | 'unknown'
        try {
            const backendBase = (window.CP_CONFIG && window.CP_CONFIG.SUPABASE_URL)
                ? window.CP_CONFIG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/save-draft'
                : '';
            if (backendBase && token) {
                const res = await fetch(backendBase + '?token=' + encodeURIComponent(token));
                if (res.ok) {
                    const json = await res.json();
                    if (json.found && json.data && typeof json.data === 'object') {
                        serverData = json.data;
                        tokenStatus = 'ok';

                        // Show expiry warning if fewer than 24 hours remain.
                        const msRemaining = typeof json.ms_remaining === 'number' ? json.ms_remaining : null;
                        if (msRemaining !== null && msRemaining < 24 * 60 * 60 * 1000) {
                            const hoursLeft = Math.floor(msRemaining / (60 * 60 * 1000));
                            const minutesLeft = Math.floor((msRemaining % (60 * 60 * 1000)) / 60000);
                            const timeLabel = hoursLeft > 0
                                ? `${hoursLeft} hour${hoursLeft !== 1 ? 's' : ''}${minutesLeft > 0 ? ` ${minutesLeft} min` : ''}`
                                : `${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}`;
                            this._showResumeBanner(
                                `⚠️ Your saved draft expires in ${timeLabel}. Submit your application today to avoid losing your progress.`,
                                'warn'
                            );
                        }
                    } else {
                        tokenStatus = 'expired';
                    }
                } else if (res.status === 404 || res.status === 410) {
                    tokenStatus = 'expired';
                } else {
                    tokenStatus = 'unreachable';
                }
            }
        } catch (err) {
            tokenStatus = 'unreachable';
            console.warn('[CP App] Draft restore from server failed (falling back to localStorage):', err);
        }

        // Surface a friendly message when the resume link can't load the draft.
        if (!serverData) {
            const hasLocal = (() => {
                try { return !!localStorage.getItem('rentalApplicationDraft'); } catch (_) { return false; }
            })();
            if (tokenStatus === 'expired' && !hasLocal) {
                this._showResumeBanner('This save-and-resume link has expired (links are valid for 7 days). You can start a new application below — your information is not lost if it was on the same device.', 'warn');
            } else if (tokenStatus === 'unreachable' && !hasLocal) {
                this._showResumeBanner('We could not reach the server to load your saved progress. Check your connection and refresh, or start a new application below.', 'error');
            } else if (tokenStatus === 'expired' && hasLocal) {
                this._showResumeBanner('Your save-and-resume link has expired, but we found a saved draft on this device and have restored it.', 'info');
            }
        }

        if (serverData) {
            // Server draft found — apply it to the form, then also mirror to
            // localStorage so subsequent auto-saves work normally.
            try {
                // SSN and DOB are kept in the draft so applicants don't have to re-enter them on resume.
                const SKIP = new Set(['Application ID', '_last_updated', '_language', '_currentStep', '_propertyFingerprint', '_documents']);
                const form = document.getElementById('rentalApplication');
                if (!form) return;
                Object.keys(serverData).forEach(key => {
                    if (SKIP.has(key)) return;
                    const value = serverData[key];
                    if (value === undefined || value === null) return;
                    const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    const els = form.querySelectorAll(`[name="${escaped}"]`);
                    if (!els.length) return;
                    const firstEl = els[0];
                    if (firstEl.type === 'radio') {
                        els.forEach(el => { if (el.value === value) el.checked = true; });
                    } else if (firstEl.type === 'checkbox') {
                        if (Array.isArray(value)) {
                            els.forEach(el => { el.checked = value.includes(el.value); });
                        } else {
                            els.forEach(el => { el.checked = (el.value === value); });
                        }
                    } else {
                        firstEl.value = value;
                    }
                });
                if (serverData._language) this.state.language = serverData._language;
                if (serverData._currentStep && serverData._currentStep > 1) {
                    const stepNum = parseInt(serverData._currentStep, 10);
                    if (stepNum >= 1 && stepNum <= 6) {
                        setTimeout(() => {
                            document.querySelectorAll('.form-section').forEach(s => s.classList.remove('active'));
                            const targetSection = document.getElementById('section' + stepNum);
                            if (targetSection) {
                                targetSection.classList.add('active');
                                this.updateProgressBar();
                                this._updateStartOverBtn(stepNum);
                            }
                        }, 10);
                    }
                }
                // Issue #14: re-attach documents that were saved with the draft.
                this._restoreDocumentsFromDraft(serverData._documents);
                // Mirror to localStorage so auto-save picks up from here
                try { localStorage.setItem(this.config.LOCAL_STORAGE_KEY, JSON.stringify(serverData)); } catch(e) {}
            } catch (e) {
                console.warn('[CP App] Error applying server draft data:', e);
                this.restoreSavedProgress();
            }
        } else {
            // No server draft — fall back to localStorage
            this.restoreSavedProgress();
        }
    }

      restoreSavedProgress() {
          const saved = (() => { try { return localStorage.getItem(this.config.LOCAL_STORAGE_KEY); } catch(e) { return null; } })();
        if (saved) {
            try {
                const data = JSON.parse(saved);

                // Property-context guard: if the current URL is for a different property
                // than what was saved, wipe the stale data and start fresh.
                // This prevents a half-filled application for Property A from loading
                // when the user clicks "Apply" on Property B.
                const _curP = new URLSearchParams(window.location.search);
                const _curFingerprint = _curP.get('id') || _curP.get('addr') || '';
                const _savedFingerprint = data._propertyFingerprint || '';
                if (_curFingerprint && _savedFingerprint && _curFingerprint !== _savedFingerprint) {
                    try { localStorage.removeItem(this.config.LOCAL_STORAGE_KEY); } catch(e) {}
                    return; // Different property — start completely fresh
                }

                // SSN and DOB are kept in the saved draft so applicants don't have to re-enter them on resume.
                const SKIP = new Set(['Application ID', '_last_updated', '_language', '_currentStep', '_propertyFingerprint', '_documents']);
                const form = document.getElementById('rentalApplication');
                if (!form) return;

                Object.keys(data).forEach(key => {
                    if (SKIP.has(key)) return;
                    const value = data[key];
                    if (value === undefined || value === null) return;
                    const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    const els = form.querySelectorAll(`[name="${escaped}"]`);
                    if (!els.length) return;
                    const firstEl = els[0];
                    if (firstEl.type === 'radio') {
                        els.forEach(el => { if (el.value === value) el.checked = true; });
                    } else if (firstEl.type === 'checkbox') {
                          // [L1 fix] Handle array (multi-checkbox group) and single values
                          if (Array.isArray(value)) {
                              els.forEach(el => { el.checked = value.includes(el.value); });
                          } else {
                              els.forEach(el => { el.checked = (el.value === value); });
                          }
                      } else {
                          firstEl.value = value;
                    }
                });
                if (data._language) this.state.language = data._language;
                if (data._currentStep && data._currentStep > 1) {
                    const stepNum = parseInt(data._currentStep, 10);
                    if (stepNum >= 1 && stepNum <= 6) {
                        setTimeout(() => {
                            document.querySelectorAll('.form-section').forEach(s => s.classList.remove('active'));
                            const targetSection = document.getElementById('section' + stepNum);
                            if (targetSection) {
                                targetSection.classList.add('active');
                                this.updateProgressBar();
                                this._updateStartOverBtn(stepNum);
                            }
                        }, 10);
                    }
                }
                // Issue #14: re-attach documents that were saved with the draft.
                this._restoreDocumentsFromDraft(data._documents);
            } catch (e) { console.warn('[CP App] Non-critical error in restoreSavedProgress:', e); }
        }
    }

    // Issue #14: drafts now persist attached supporting documents alongside
    // the form fields, so a browser crash or "save & resume" trip no longer
    // forces the applicant to re-attach their paystubs. Documents are
    // base64-encoded into the same JSON payload, capped at the same 3 MB
    // total used by the submit path so localStorage / draft_applications.data
    // stays bounded.
    async _encodeFileForDraft(file) {
        if (!file) return null;
        try {
            const buf = await file.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let bin = '';
            // Use a chunked loop to avoid blowing the JS call-stack on
            // ~1 MB binary buffers (apply.fromCharCode has arg limits).
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            return {
                name: file.name,
                type: file.type || 'application/octet-stream',
                size: file.size,
                base64: btoa(bin),
            };
        } catch (e) {
            console.warn('[CP App] Failed to encode draft document:', file?.name, e);
            return null;
        }
    }

    async _collectDocumentsForDraft() {
        const files = this._uploadedFiles || [];
        if (files.length === 0) return [];
        const MAX_TOTAL = 3 * 1024 * 1024;
        const total = files.reduce((s, f) => s + (f.size || 0), 0);
        if (total > MAX_TOTAL) return [];
        const out = [];
        for (const f of files) {
            const enc = await this._encodeFileForDraft(f);
            if (enc) out.push(enc);
        }
        return out;
    }

    // Issue #14 restore: turn the base64 docs back into real File objects so
    // the existing remove/upload/submit code paths see them as if they were
    // freshly attached. Mirrors the encoder in _encodeFileForDraft.
    _restoreDocumentsFromDraft(docs) {
        if (!Array.isArray(docs) || docs.length === 0) return;
        if (!this._uploadedFiles) this._uploadedFiles = [];
        for (const d of docs) {
            if (!d || typeof d.base64 !== 'string' || !d.name) continue;
            try {
                const bin = atob(d.base64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const file = new File([bytes], d.name, {
                    type: d.type || 'application/octet-stream',
                });
                if (!this._uploadedFiles.some(f => f.name === file.name)) {
                    this._uploadedFiles.push(file);
                }
            } catch (e) {
                console.warn('[CP App] Failed to decode draft document:', d.name, e);
            }
        }
        if (typeof this._rerenderUploadedFiles === 'function') {
            this._rerenderUploadedFiles();
        }
    }

    async saveProgress() {
        const data = this.getAllFormData();
        // Application ID is a server-issued identifier and must not be cached client-side.
        // SSN (last-4) and DOB are intentionally retained so applicants don't have to re-enter
        // them on resume; the draft is stored in the same browser/device localStorage and the
        // same encrypted server draft slot used for every other applicant field.
        const sensitiveKeys = ['Application ID'];
        sensitiveKeys.forEach(key => delete data[key]);
        data._last_updated = new Date().toISOString();
        data._language = this.state.language || 'en';
        data._currentStep = this.getCurrentSection();
        // Save property fingerprint so restore can detect a different-property session.
        // Uses the property ID URL param (most specific), falling back to the address param.
        const _urlP = new URLSearchParams(window.location.search);
        data._propertyFingerprint = _urlP.get('id') || _urlP.get('addr') || '';
        // Issue #14: include attached documents so draft restore brings them back.
        // Encoding is async — do it before the localStorage write so the saved
        // payload is internally consistent (auto-save callers don't await us;
        // that's fine, the flash indicator just fires after the encode finishes).
        try {
            data._documents = await this._collectDocumentsForDraft();
        } catch (_) {
            data._documents = [];
        }
        try { localStorage.setItem(this.config.LOCAL_STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
        this._flashAutoSave();
    }

    _flashAutoSave() {
        const indicator = document.getElementById('autoSaveIndicator');
        if (!indicator) return;
        clearTimeout(this._autoSaveFlashTimer);
        indicator.classList.add('visible');
        this._autoSaveFlashTimer = setTimeout(() => {
            indicator.classList.remove('visible');
        }, 2200);
    }

    getAllFormData() {
          const form = document.getElementById('rentalApplication');
          const formData = new FormData(form);
          const data = {};
          // [L1 fix] Collect duplicate keys (multi-checkboxes like Preferred Contact Method / Preferred Time) into arrays
          formData.forEach((value, key) => {
              if (Object.prototype.hasOwnProperty.call(data, key)) {
                  if (!Array.isArray(data[key])) data[key] = [data[key]];
                  data[key].push(value);
              } else {
                  data[key] = value;
              }
          });
          return data;
      }

    debounce(func, wait) {
        let timeout;
        return function() {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, arguments), wait);
        };
    }

    _parseLocalDate(dateStr) {
        if (!dateStr) return null;
        const parts = dateStr.split('-');
        if (parts.length !== 3) return null;
        const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        return isNaN(d.getTime()) ? null : d;
    }

    // ---------- Language toggle ----------
    setupLanguageToggle() {
        const fee     = this.state.applicationFee;
        const freeApp = fee <= 0; // zero-fee: no payment step needed
        const translations = {
            en: {
                langText: 'Español',
                logoText: 'Choice Properties',
                tagline: 'Professional Property Management',
                confidentialStamp: 'CONFIDENTIAL & SECURE',
                trustIndicator: 'Your information is encrypted and protected',
                timeEstimate: 'Estimated time: 15–20 minutes',
                step1Label: 'Property & Applicant',
                step2Label: 'Residency & Occupancy',
                step3Label: 'Employment & Income',
                step4Label: 'References & Emergency Contact',
                step5Label: 'Contact & Payment',
                step6Label: 'Review & Submit',
                stepPrefix: 'Step',
                stepOf: 'of',
                processing: 'Processing',
                validating: 'Validating',
                submitting: 'Submitting',
                complete: 'Complete',
                submittingTitle: 'Submitting Application',
                submissionMessage: 'Do not close this window. Processing may take a few moments.',
                successTitle: 'Application Received',
                successText: 'Your application has been received and is pending review.',
                appId: 'Application ID',
                clickToCopy: 'Copy ID',
                immediateNextSteps: 'Next Steps',
                paymentRequiredTitle: freeApp ? 'No Application Fee' : 'Application Fee Required',
                paymentRequiredDesc: freeApp
                    ? 'No application fee is required for this property. Your application will proceed directly to screening.'
                    : `An application fee of $${fee} is required to initiate the screening process. A representative will contact you to coordinate payment.`,
                completePaymentTitle: freeApp ? 'Application Submitted' : 'Fee Coordination',
                completePaymentDesc: freeApp
                    ? 'No payment is required. Your application has been submitted and will be reviewed as received.'
                    : `A representative will contact you using your indicated payment method to coordinate the $${fee} application fee.`,
                reviewBeginsTitle: 'Screening in Progress',
                reviewBeginsDesc: freeApp
                    ? 'Screening typically concludes within 24 to 72 hours. Application status is available online using your Application ID.'
                    : 'Screening typically concludes within 24 to 72 hours of fee confirmation. Application status is available online using your Application ID.',
                importantNote: 'Notice:',
                paymentUrgentText: freeApp
                    ? 'No application fee is required for this property. Your application has been submitted for review.'
                    : `Application fee processing will be coordinated separately. A representative will contact you using your indicated payment method.`,
                yourPreferences: 'Contact & Payment Preferences',
                contactMethod: 'Contact Method:',
                bestTimes: 'Preferred Hours:',
                paymentPref: 'Payment Method(s):',
                preferenceNote: 'These preferences will be used for post-submission communications.',
                questions: 'For assistance, contact',
                helpText: 'support or call 707-706-3137.',
                spamWarning: '📧 A confirmation has been sent to the email address provided. If not received within a few minutes, check your <strong>spam or junk folder</strong>.',
                trackStatus: 'Track Application Status',
                newApplication: 'Submit New Application',
                reapplicationPolicyTitle: 'Reapplication Policy',
                reapplicationPolicyText: 'In the event of denial, applicants may reapply for any available property within 30 days without a new application fee. Screening results remain valid for 60 days.',
                step1YouSubmit: '1. Application Submitted',
                step1Desc: 'Complete and submit this application in full.',
                step2PaymentArranged: freeApp ? '2. Application Received' : '2. Fee Coordination',
                step2Desc: freeApp ? 'No fee required. Application enters review immediately.' : `A representative contacts you to process the $${fee} fee.`,
                step3ReviewBegins: '3. Screening & Review',
                step3Desc: freeApp ? 'Typically completed within 24–72 hours.' : 'Typically completed within 24–72 hours of fee confirmation.',
                propertyHeader: 'Applicant Identification & Property',
                propertyInfo: 'Property Information',
                propertyAddressLabel: 'Property Address',
                propertyAddressPlaceholder: 'Street address, city, state, zip',
                errAddress: 'Property address is required.',
                moveInLabel: 'Requested Move-in Date',
                errRequired: 'Required',
                leaseTermLabel: 'Lease Term',
                selectTerm: 'Select term...',
                months6: '6 Months',
                months12: '12 Months',
                months18: '18 Months',
                months24: '24 Months',
                monthToMonth: 'Month-to-Month',
                primaryApplicantInfo: 'Primary Applicant',
                firstNameLabel: 'First Name',
                lastNameLabel: 'Last Name',
                emailLabel: 'Email Address',
                emailPlaceholder: 'email@example.com',
                emailHint: 'Used for application communications and confirmation.',
                errEmail: 'Invalid format',
                phoneLabel: 'Phone Number',
                phonePlaceholder: '(555) 000-0000',
                phoneHint: 'Used for application-related contact.',
                errPhone: 'Invalid format',
                dobLabel: 'Date of Birth',
                ssnLabel: 'Social Security Number (Last 4 Digits)',
                ssnHint: 'Last 4 digits only',
                ssnPlaceholder: '1234',
                coApplicantCheckbox: 'Include a co-applicant or guarantor on this application',
                coApplicantInfo: 'Co-Applicant / Guarantor',
                coRoleLabel: 'Role',
                roleCoApplicant: 'Co-Applicant (will occupy the unit)',
                roleGuarantor: 'Guarantor (financial guaranty only)',
                coFirstNameLabel: 'First Name',
                coLastNameLabel: 'Last Name',
                coEmailLabel: 'Email Address',
                coPhoneLabel: 'Phone Number',
                coDobLabel: 'Date of Birth',
                coSsnLabel: 'SSN (Last 4)',
                employmentIncome: 'Employment & Income',
                coEmployerLabel: 'Employer',
                coJobTitleLabel: 'Position / Title',
                coMonthlyIncomeLabel: 'Gross Monthly Income ($)',
                coMonthlyIncomePlaceholder: 'e.g., 4000',
                coEmploymentDurationLabel: 'Duration of Employment',
                coEmploymentDurationPlaceholder: 'e.g., 2 years',
                coConsentLabel: 'I authorize verification of all information provided for this co-applicant or guarantor, including credit and background screening.',
                contactPrefsHeader: 'Contact Preferences',
                prefContactMethod: 'Preferred Contact Method',
                contactMethodText: 'SMS / Text',
                contactMethodEmail: 'Email',
                contactMethodHint: 'Select one or both.',
                availabilityLabel: 'Preferred Contact Hours',
                weekdays: 'Weekdays',
                timeMorning: 'Morning (8:00 AM – 11:00 AM)',
                timeMidday: 'Midday (11:00 AM – 2:00 PM)',
                timeAfternoon: 'Afternoon (2:00 PM – 5:00 PM)',
                eveningsWeekends: 'Evenings & Weekends',
                timeEarlyEvening: 'Early Evening (5:00 PM – 8:00 PM)',
                timeLateEvening: 'Late Evening (8:00 PM – 10:00 PM)',
                timeWeekend: 'Weekend',
                flexible: 'Flexible',
                timeAnytime: 'No preference',
                additionalNotesLabel: 'Additional Notes (Optional)',
                additionalNotesPlaceholder: 'e.g., Available after 7:00 PM, unavailable Wednesdays',
                preferencesNote: 'These preferences will be used for post-submission communications.',
                nextStep: 'Continue',
                prevStep: 'Back',
                editSection: 'Edit',
                residencyHeader: 'Residency History & Occupancy',
                currentResidence: 'Current Residence',
                currentAddressLabel: 'Current Address',
                currentAddressPlaceholder: 'Street, Unit #, City, State, Zip',
                residencyStartLabel: 'Duration at Current Address',
                residencyStartPlaceholder: 'e.g., 2 years 3 months',
                rentAmountLabel: 'Current Monthly Rent / Mortgage',
                rentAmountPlaceholder: '$',
                reasonLeavingLabel: 'Reason for Vacating',
                landlordNameLabel: 'Current Landlord / Property Manager',
                landlordPhoneLabel: 'Landlord / Property Manager Phone',
                occupantsPets: 'Occupants & Pets',
                totalOccupantsLabel: 'Total Number of Occupants (including children)',
                occupantNamesLabel: 'Names and Ages of Additional Occupants',
                occupantNamesPlaceholder: 'Name, age, relationship (e.g., Jane Doe, 7, daughter)',
                hasPetsLabel: 'Pets',
                yes: 'Yes',
                no: 'No',
                petDetailsLabel: 'Pet Description (type, breed, weight)',
                petDetailsPlaceholder: 'Provide details for each pet.',
                vehicleInfo: 'Vehicle Information',
                hasVehicleLabel: 'Vehicle',
                vehicleMakeLabel: 'Make',
                vehicleModelLabel: 'Model',
                vehicleYearLabel: 'Year',
                vehicleYearPlaceholder: 'e.g., 2020',
                vehiclePlateLabel: 'License Plate (Optional)',
                employmentHeader: 'Employment & Income Information',
                currentEmployment: 'Employment Details',
                employmentStatusLabel: 'Employment Status',
                selectStatus: 'Select status...',
                fullTime: 'Full-Time',
                partTime: 'Part-Time',
                selfEmployed: 'Self-Employed',
                student: 'Student',
                retired: 'Retired',
                unemployed: 'Unemployed',
                employerLabel: 'Employer',
                jobTitleLabel: 'Position / Title',
                employmentDurationLabel: 'Duration of Employment',
                employmentDurationPlaceholder: 'e.g., 3 years',
                supervisorNameLabel: 'Direct Supervisor',
                supervisorPhoneLabel: 'Supervisor Contact Number',
                incomeVerification: 'Income Verification',
                monthlyIncomeLabel: 'Gross Monthly Income',
                monthlyIncomePlaceholder: 'e.g., 3500',
                incomeHint: 'Pre-tax gross income',
                otherIncomeLabel: 'Supplemental Monthly Income (Optional)',
                otherIncomePlaceholder: '$',
                otherIncomeHint: 'Supplemental sources (e.g., disability, support payments)',
                financialHeader: 'References & Emergency Contact',
                personalReferences: 'Personal References',
                referencesHint: 'Provide two references who are not family members.',
                ref1NameLabel: 'Reference 1 — Full Name',
                ref1PhoneLabel: 'Reference 1 — Phone',
                ref2NameLabel: 'Reference 2 — Full Name (Optional)',
                ref2PhoneLabel: 'Reference 2 — Phone (Optional)',
                emergencyInfo: 'Emergency Contact',
                emergencyNameLabel: 'Emergency Contact Name',
                emergencyPhoneLabel: 'Emergency Contact Phone',
                emergencyRelationshipLabel: 'Relationship to Applicant',
                emergencyRelationshipPlaceholder: 'e.g., Spouse, Parent, Sibling',
                additionalInfo: 'Disclosure Questions',
                evictedLabel: 'Prior Eviction History',
                smokerLabel: 'Tobacco / Smoking Use',
                paymentHeader: 'Contact & Payment Preferences',
                paymentIntro: freeApp
                    ? 'No application fee is required for this property. Please indicate your preferred contact method for review communications.'
                    : `Indicate your preferred payment method. A representative will use this information to coordinate the $${fee} application fee after submission.`,
                paymentImportant: freeApp
                    ? 'No application fee is required. Your application will be reviewed upon submission.'
                    : 'The application fee must be processed before screening can begin. You will be contacted after submission to arrange payment.',
                primaryPref: 'Primary Method',
                mainPaymentMethod: 'Primary Payment Method',
                mainPaymentDesc: 'Select the payment method you wish to use.',
                selectPrimary: '— Select primary method —',
                other: 'Other',
                otherPaymentPlaceholder: 'Specify payment method',
                backupPref: 'Alternative Methods (Optional)',
                otherMethods: 'Alternative Payment Methods',
                otherMethodsDesc: 'Select additional methods if applicable.',
                secondaryMethod: 'Second Method',
                selectBackup: '— Select alternative (optional) —',
                thirdMethod: 'Third Method (Optional)',
                selectAnother: '— Select alternative (optional) —',
                duplicateWarning: 'Each selection must be a different payment method.',
                reviewHeader: 'Application Review & Submission',
                feeTitle: freeApp ? 'Application Fee: Waived' : `Application Fee: $${fee}.00`,
                feeDesc: freeApp
                    ? 'No application fee is required for this property. Your application will proceed directly to review.'
                    : 'The application fee is required before screening can begin. A representative will contact you after submission to coordinate payment.',
                paymentReminderTitle: freeApp ? 'No Application Fee' : 'Application Fee Required',
                paymentReminderDesc: freeApp
                    ? 'No application fee is required for this property. Your application will proceed directly to review upon submission.'
                    : `Your application will not be activated until the $${fee} fee has been processed. A representative will contact you after submission.`,
                verificationTitle: 'Verify Contact Information',
                verificationDesc: freeApp
                    ? 'Confirm that the email address and phone number provided are accurate. These will be used for all application communications.'
                    : `Confirm that the email address and phone number provided are accurate. These will be used to coordinate the $${fee} fee and communicate application status.`,
                reapplicationPolicyTextShort: 'In the event of denial, applicants may reapply within 30 days without a new fee. Screening results valid for 60 days.',
                legalDeclaration: 'Applicant Declaration',
                legalCertify: 'I certify that all information provided in this application is true, accurate, and complete to the best of my knowledge. I understand that any material misrepresentation is grounds for denial or termination of tenancy.',
                legalAuthorize: 'I authorize Choice Properties and its designated agents to verify all information provided in this application, including employment, income, rental history, personal references, and to conduct a consumer credit and background screening.',
                termsAgreeLabel: 'I certify that all information provided in this application is accurate and complete, and I authorize Choice Properties to verify it.',
                submitBtn: 'Submit Application',
                submitDisclaimer: 'By submitting, you authorize Choice Properties to process this application in accordance with its Privacy Policy and Terms of Service.',
                privacyPolicy: 'Privacy Policy',
                termsOfService: 'Terms of Service',
                contactSupport: 'Contact Support',
                progressSaved: 'Draft Saved',
                offlineMessage: 'You are offline. Progress is being saved locally.',
                notSpecified: 'Not provided',
                notSelected: 'Not selected',
                retry: 'Retry',
                close: 'Close',
                offlineError: 'Connection unavailable. Please check your network and try again.',
                submissionFailed: 'Submission failed. Please try again.',
                backgroundQuestions: 'Disclosure Questions',
                ref1RelationshipLabel: 'Relationship to Applicant',
                ref1RelationshipPlaceholder: 'e.g., Former Landlord, Employer, Colleague',
                ref2RelationshipLabel: 'Relationship to Applicant (Optional)',
                ref2RelationshipPlaceholder: 'e.g., Former Landlord, Employer, Colleague',
                saveResumeLater: 'Save & Resume Later',
                saveResumeDesc: 'Enter your email address to receive a secure link to resume this application.',
                sendLink: 'Send Link',
                cancel: 'Cancel',
                linkSent: 'Link sent. Check your inbox.',
                ratioQualifies: 'Meets Requirement',
                ratioBorderline: 'Review Required',
                ratioLow: 'Below Threshold',
                noContextTitle: 'Property Not Specified',
                noContextSub: 'Enter the full property address in Step 1 to associate this application with the correct listing.',
                managedBy: 'Managed by',
                applyingFor: 'Applying for',
                viewListing: 'View listing',
                browseListings: 'Browse Available Listings',
                charCount: 'characters',
                summaryPropertyApplicant: 'Property & Applicant',
                summaryCoApplicant: 'Co-Applicant / Guarantor',
                summaryResidency: 'Residency History',
                summaryOccupancy: 'Occupants & Vehicles',
                summaryEmployment: 'Employment & Income',
                summaryFinancial: 'References & Emergency Contact',
                summaryPayment: 'Payment Preferences',
                retryIn: 'in',
                retryAttempt: 'attempt',
                pleaseAgreeDeclarations: 'All declarations must be acknowledged before submission.',
                networkError: 'Unable to reach the server. Please check your connection and try again.',
                networkExhausted: 'Submission status could not be confirmed due to a connection error. Your application may have been received — check your email for a confirmation. If no confirmation was received, contact us at 707-706-3137.',
                verifyingSubmission: 'Verifying submission status\u2026 Please wait.',
                serverError: 'The server is temporarily unavailable. Please try again in a few minutes, or contact 707-706-3137.',
                copied: 'Copied',
                pageTitle: 'Rental Application — Choice Properties',
                howItWorks: 'Application Process Overview',
                requiredField: 'Required field',
                autoSavedHint: 'Progress is automatically saved',
                uploadTitle: 'Supporting Documents',
                uploadOptional: '(Optional)',
                uploadDesc: 'Documents may be attached to expedite the review process. Image files (JPG, PNG) will display a preview after upload. PDF files will be confirmed with a verification badge. <strong>Accepted:</strong> PDF, JPG, PNG · Max 1 MB per file · Up to 4 files · 3 MB total.',
                uploadCta: 'Click to browse or drag files here',
                uploadHint: 'Government-issued ID &nbsp;·&nbsp; Pay stubs &nbsp;·&nbsp; Bank statements',
                creditApplied: 'Application Credit Applied',
                creditAppliedText: 'An application credit has been applied. The application fee is waived.',
                trustLine: 'Application data is transmitted securely and used solely for rental screening purposes.',
                feeAcknowledge: 'I acknowledge the application fee policy and consent to my personal information being reviewed by Choice Properties staff and the property owner solely for rental application screening. The application fee is <strong>non-refundable</strong> upon submission and payment processing, except as provided in the <a href="/application-credit-policy.html" target="_blank" rel="noopener" style="color:var(--primary);">Application Credit Policy</a>.',
                agreeTermsPrivacy: 'I have read and agree to the <a href="/terms.html" target="_blank" rel="noopener" style="color:var(--primary);">Terms of Service</a> (including the <strong>binding arbitration clause</strong> and <strong>class action waiver</strong> in Sections 18–19), the <a href="/privacy.html" target="_blank" rel="noopener" style="color:var(--primary);">Privacy Policy</a>, and the <a href="/policies.html" target="_blank" rel="noopener" style="color:var(--primary);">Complete Policy &amp; Legal Framework</a>. I confirm I am at least 18 years of age and have legal capacity to enter into this agreement.',
                smsConsent: 'I expressly consent to receive transactional SMS messages from Choice Properties at the mobile number provided, regarding application status, fee coordination, lease execution, and move-in scheduling. Message frequency varies. <strong>Message and data rates may apply.</strong> Reply HELP for assistance, STOP to opt out at any time. SMS consent is not a condition of application — leave unchecked to receive communications by email only.',
                footerCopyright: '&copy; 2026 Choice Properties. All rights reserved.',
                startOver: 'Start Over',
                startOverTitle: 'Discard Application?',
                startOverDesc: 'All entered information will be permanently cleared. You will be returned to Step 1.',
                keepInfo: 'Continue Application',
                yesStartOver: 'Discard & Restart',
                minLeaseHintPre: 'Minimum lease term:',
                minLeaseHintPost: 'months. Please select a qualifying term.'
            },
            es: {
                langText: 'English',
                logoText: 'Choice Properties',
                tagline: 'Soluciones Profesionales de Administración de Propiedades',
                confidentialStamp: 'CONFIDENCIAL & SEGURO',
                trustIndicator: 'Su información está encriptada y protegida',
                timeEstimate: 'Tiempo estimado: 15-20 minutos',
                step1Label: 'Propiedad y Solicitante',
                step2Label: 'Residencia y Ocupación',
                step3Label: 'Empleo e Ingresos',
                step4Label: 'Referencias y Contacto de Emergencia',
                step5Label: 'Preferencias de Pago',
                step6Label: 'Revisar y Enviar',
                stepPrefix: 'Paso',
                stepOf: 'de',
                processing: 'Procesando',
                validating: 'Validando',
                submitting: 'Enviando',
                complete: 'Completo',
                submittingTitle: 'Enviando su Solicitud',
                submissionMessage: 'Por favor no cierre esta ventana. Puede tomar unos momentos...',
                successTitle: 'Solicitud Recibida',
                successText: 'Su solicitud ha sido recibida y está pendiente de revisión.',
                appId: 'ID de Solicitud',
                clickToCopy: 'Copiar ID',
                immediateNextSteps: 'Próximos Pasos',
                paymentRequiredTitle: freeApp ? 'Sin Tarifa de Solicitud' : 'Tarifa de Solicitud Requerida',
                paymentRequiredDesc: freeApp
                    ? 'No se requiere tarifa de solicitud para esta propiedad. Su solicitud pasará directamente al proceso de verificación.'
                    : `Se requiere una tarifa de solicitud de $${fee} para iniciar el proceso de verificación. Un representante lo contactará para coordinar el pago.`,
                completePaymentTitle: freeApp ? 'Solicitud Enviada' : 'Coordinación de Tarifa',
                completePaymentDesc: freeApp
                    ? 'No se requiere pago. Su solicitud ha sido enviada y será revisada tal como fue recibida.'
                    : `Un representante lo contactará usando su método de pago indicado para coordinar la tarifa de solicitud de $${fee}.`,
                reviewBeginsTitle: 'Verificación en Proceso',
                reviewBeginsDesc: freeApp
                    ? 'La verificación generalmente concluye en 24 a 72 horas. El estado de la solicitud está disponible en línea usando su ID de Solicitud.'
                    : 'La verificación generalmente concluye en 24 a 72 horas tras la confirmación del pago. El estado de la solicitud está disponible en línea usando su ID de Solicitud.',
                importantNote: 'Aviso:',
                paymentUrgentText: freeApp
                    ? 'No se requiere tarifa de solicitud para esta propiedad. Su solicitud ha sido enviada para revisión.'
                    : `El procesamiento de la tarifa de solicitud se coordinará por separado. Un representante lo contactará usando su método de pago indicado.`,
                yourPreferences: 'Preferencias de Contacto y Pago',
                contactMethod: 'Método de Contacto:',
                bestTimes: 'Horario Preferido:',
                paymentPref: 'Método(s) de Pago:',
                preferenceNote: 'Estas preferencias se usarán para comunicaciones posteriores al envío.',
                questions: 'Para asistencia, contacte',
                helpText: 'soporte o llame al 707-706-3137.',
                spamWarning: '📧 Se ha enviado una confirmación al correo electrónico proporcionado. Si no lo recibe en unos minutos, revise su carpeta de <strong>spam o correo no deseado</strong>.',
                trackStatus: 'Ver Estado de Solicitud',
                newApplication: 'Enviar Nueva Solicitud',
                reapplicationPolicyTitle: 'Política de Reaplicación',
                reapplicationPolicyText: 'En caso de denegación, los solicitantes pueden volver a solicitar cualquier propiedad disponible dentro de 30 días sin nueva tarifa. Los resultados de verificación permanecen válidos por 60 días.',
                step1YouSubmit: '1. Solicitud Enviada',
                step1Desc: 'Complete y envíe esta solicitud en su totalidad.',
                step2PaymentArranged: freeApp ? '2. Solicitud Recibida' : '2. Coordinación de Tarifa',
                step2Desc: freeApp ? 'Sin tarifa. La solicitud entra en revisión de inmediato.' : `Un representante lo contacta para procesar la tarifa de $${fee}.`,
                step3ReviewBegins: '3. Verificación y Revisión',
                step3Desc: freeApp ? 'Generalmente concluye en 24–72 horas.' : 'Generalmente concluye en 24–72 horas tras la confirmación del pago.',
                propertyHeader: 'Identificación del Solicitante y Propiedad',
                propertyInfo: 'Información de la Propiedad',
                propertyAddressLabel: 'Dirección de la Propiedad',
                propertyAddressPlaceholder: 'Calle, ciudad, estado, código postal',
                errAddress: 'La dirección de la propiedad es obligatoria.',
                moveInLabel: 'Fecha de Mudanza Solicitada',
                errRequired: 'Obligatorio',
                leaseTermLabel: 'Plazo de Arrendamiento Deseado',
                selectTerm: 'Seleccionar plazo...',
                months6: '6 Meses',
                months12: '12 Meses',
                months18: '18 Meses',
                months24: '24 Meses',
                monthToMonth: 'Mes a mes',
                primaryApplicantInfo: 'Solicitante Principal',
                firstNameLabel: 'Nombre',
                lastNameLabel: 'Apellido',
                emailLabel: 'Correo Electrónico',
                emailPlaceholder: 'email@ejemplo.com',
                emailHint: 'Usado para comunicaciones y confirmación de solicitud.',
                errEmail: 'Formato inválido',
                phoneLabel: 'Número de Teléfono',
                phonePlaceholder: '(555) 000-0000',
                phoneHint: 'Usado para contacto relacionado con la solicitud.',
                errPhone: 'Formato inválido',
                dobLabel: 'Fecha de Nacimiento',
                ssnLabel: 'Número de Seguro Social (últimos 4 dígitos)',
                ssnHint: 'Solo últimos 4 dígitos requeridos',
                ssnPlaceholder: '1234',
                coApplicantCheckbox: 'Incluir un co-solicitante o garante en esta solicitud',
                coApplicantInfo: 'Co-Solicitante / Garante',
                coRoleLabel: 'Rol',
                roleCoApplicant: 'Co-Solicitante (ocupará la unidad)',
                roleGuarantor: 'Garante (garantía financiera únicamente)',
                coFirstNameLabel: 'Nombre',
                coLastNameLabel: 'Apellido',
                coEmailLabel: 'Correo Electrónico',
                coPhoneLabel: 'Teléfono',
                coDobLabel: 'Fecha de Nacimiento',
                coSsnLabel: 'SSN (últimos 4)',
                employmentIncome: 'Empleo e Ingresos',
                coEmployerLabel: 'Empleador',
                coJobTitleLabel: 'Puesto',
                coMonthlyIncomeLabel: 'Ingreso Mensual Bruto ($)',
                coMonthlyIncomePlaceholder: 'ej., 4000',
                coEmploymentDurationLabel: 'Tiempo en el empleo',
                coEmploymentDurationPlaceholder: 'ej., 2 años',
                coConsentLabel: 'Autorizo la verificación de toda la información proporcionada para este co-solicitante o garante, incluyendo verificación de crédito y antecedentes.',
                contactPrefsHeader: 'Preferencias de Contacto',
                prefContactMethod: 'Método de Contacto Preferido',
                contactMethodText: 'SMS / Texto',
                contactMethodEmail: 'Correo Electrónico',
                contactMethodHint: 'Seleccione uno o ambos.',
                availabilityLabel: 'Horario de Contacto Preferido',
                weekdays: 'Días de semana',
                timeMorning: 'Mañana (8am-11am)',
                timeMidday: 'Mediodía (11am-2pm)',
                timeAfternoon: 'Tarde (2pm-5pm)',
                eveningsWeekends: 'Tardes y Fines de Semana',
                timeEarlyEvening: 'Temprano en la tarde (5pm-8pm)',
                timeLateEvening: 'Tarde noche (8pm-10pm)',
                timeWeekend: 'Fin de semana',
                flexible: 'Flexible',
                timeAnytime: 'Sin preferencia',
                additionalNotesLabel: 'Notas Adicionales (Opcional)',
                additionalNotesPlaceholder: 'ej., Disponible después de las 7:00 PM, no disponible los miércoles',
                preferencesNote: 'Estas preferencias se usarán para comunicaciones posteriores al envío.',
                nextStep: 'Continuar',
                prevStep: 'Atrás',
                editSection: 'Editar',
                residencyHeader: 'Historial de Residencia y Ocupación',
                currentResidence: 'Residencia Actual',
                currentAddressLabel: 'Dirección Actual',
                currentAddressPlaceholder: 'Calle, Número, Ciudad, Estado, Código Postal',
                residencyStartLabel: 'Duración en la Dirección Actual',
                residencyStartPlaceholder: 'ej., 2 años 3 meses',
                rentAmountLabel: 'Renta / Hipoteca Mensual Actual',
                rentAmountPlaceholder: '$',
                reasonLeavingLabel: 'Motivo de Desocupación',
                landlordNameLabel: 'Propietario / Administrador Actual',
                landlordPhoneLabel: 'Teléfono del Propietario / Administrador',
                occupantsPets: 'Ocupantes y Mascotas',
                totalOccupantsLabel: 'Número Total de Ocupantes (incluyendo niños)',
                occupantNamesLabel: 'Nombres y Edades de Ocupantes Adicionales',
                occupantNamesPlaceholder: 'Nombre, edad, relación (ej., Juan Pérez, 7, hijo)',
                hasPetsLabel: 'Mascotas',
                yes: 'Sí',
                no: 'No',
                petDetailsLabel: 'Descripción de Mascotas (tipo, raza, peso)',
                petDetailsPlaceholder: 'Proporcione detalles de cada mascota.',
                vehicleInfo: 'Información del Vehículo',
                hasVehicleLabel: 'Vehículo',
                vehicleMakeLabel: 'Marca',
                vehicleModelLabel: 'Modelo',
                vehicleYearLabel: 'Año',
                vehicleYearPlaceholder: 'ej., 2020',
                vehiclePlateLabel: 'Placa (Opcional)',
                employmentHeader: 'Información de Empleo e Ingresos',
                currentEmployment: 'Detalles de Empleo',
                employmentStatusLabel: 'Estado de Empleo',
                selectStatus: 'Seleccionar estado...',
                fullTime: 'Tiempo completo',
                partTime: 'Medio tiempo',
                selfEmployed: 'Trabajador independiente',
                student: 'Estudiante',
                retired: 'Jubilado',
                unemployed: 'Desempleado',
                employerLabel: 'Empleador',
                jobTitleLabel: 'Puesto',
                employmentDurationLabel: 'Duración del Empleo',
                employmentDurationPlaceholder: 'ej., 3 años',
                supervisorNameLabel: 'Supervisor Directo',
                supervisorPhoneLabel: 'Número de Contacto del Supervisor',
                incomeVerification: 'Verificación de Ingresos',
                monthlyIncomeLabel: 'Ingreso Mensual Bruto',
                monthlyIncomePlaceholder: '$',
                incomeHint: 'Ingreso bruto antes de impuestos',
                otherIncomeLabel: 'Ingresos Suplementarios Mensuales (Opcional)',
                otherIncomePlaceholder: '$',
                otherIncomeHint: 'Fuentes suplementarias (ej., discapacidad, pensión)',
                financialHeader: 'Referencias y Contacto de Emergencia',
                personalReferences: 'Referencias Personales',
                referencesHint: 'Proporcione dos referencias que no sean familiares.',
                ref1NameLabel: 'Nombre de Referencia 1',
                ref1PhoneLabel: 'Teléfono de Referencia 1',
                ref2NameLabel: 'Nombre de Referencia 2 (Opcional)',
                ref2PhoneLabel: 'Teléfono de Referencia 2 (Opcional)',
                emergencyInfo: 'Contacto de Emergencia',
                emergencyNameLabel: 'Nombre de Contacto de Emergencia',
                emergencyPhoneLabel: 'Teléfono de Contacto de Emergencia',
                emergencyRelationshipLabel: 'Relación con el Solicitante',
                emergencyRelationshipPlaceholder: 'ej., Cónyuge, Padre, Hermano/a',
                additionalInfo: 'Preguntas de Divulgación',
                evictedLabel: 'Historial de Desalojo',
                smokerLabel: 'Uso de Tabaco / Cigarrillos',
                paymentHeader: 'Preferencias de Contacto y Pago',
                paymentIntro: freeApp
                    ? 'No se requiere tarifa de solicitud para esta propiedad. Indique su método de contacto preferido para las comunicaciones de revisión.'
                    : `Indique su método de pago preferido. Un representante usará esta información para coordinar la tarifa de solicitud de $${fee} tras el envío.`,
                paymentImportant: freeApp
                    ? 'No se requiere tarifa de solicitud. Su solicitud será revisada al momento del envío.'
                    : 'La tarifa de solicitud debe procesarse antes de que pueda iniciarse la verificación. Será contactado después del envío para coordinar el pago.',
                primaryPref: 'Método Principal',
                mainPaymentMethod: 'Método de Pago Principal',
                mainPaymentDesc: 'Seleccione el método de pago que desea utilizar.',
                selectPrimary: '— Seleccione método principal —',
                other: 'Otro',
                otherPaymentPlaceholder: 'Especifique método de pago',
                backupPref: 'Métodos Alternativos (Opcional)',
                otherMethods: 'Métodos de Pago Alternativos',
                otherMethodsDesc: 'Seleccione métodos adicionales si aplica.',
                secondaryMethod: 'Segundo Método',
                selectBackup: '— Seleccione alternativa (opcional) —',
                thirdMethod: 'Tercer Método (Opcional)',
                selectAnother: '— Seleccione alternativa (opcional) —',
                duplicateWarning: 'Cada selección debe ser un método de pago diferente.',
                reviewHeader: 'Revisión y Envío de Solicitud',
                feeTitle: freeApp ? 'Tarifa de Solicitud: Exonerada' : `Tarifa de Solicitud: $${fee}.00`,
                feeDesc: freeApp
                    ? 'No se requiere tarifa de solicitud para esta propiedad. Su solicitud pasará directamente a revisión.'
                    : 'La tarifa de solicitud es requerida antes de que pueda iniciarse la verificación. Un representante lo contactará después del envío para coordinar el pago.',
                paymentReminderTitle: freeApp ? 'Sin Tarifa de Solicitud' : 'Pago Requerido Antes de la Revisión',
                paymentReminderDesc: freeApp
                    ? 'Esta propiedad no tiene tarifa de solicitud. Su envío está completo y pasará directamente a revisión.'
                    : `Su solicitud no está completa hasta que se haya pagado la tarifa de $${fee}. Nuestro equipo lo contactará poco después del envío para organizar esto.`,
                verificationTitle: 'Verifique Su Información de Contacto',
                verificationDesc: freeApp
                    ? 'Por favor confirme que su correo electrónico y número de teléfono sean correctos. Así es como nuestro equipo lo contactará durante el proceso de revisión.'
                    : `Por favor confirme que su correo electrónico y número de teléfono sean correctos. Así es como nuestro equipo lo contactará acerca de la tarifa de $${fee}.`,
                reapplicationPolicyTextShort: 'Si es denegado, puede aplicar nuevamente dentro de 30 días sin nueva tarifa. Resultados de evaluación válidos por 60 días.',
                legalDeclaration: 'Declaración del Solicitante',
                legalCertify: 'Certifico que toda la información proporcionada en esta solicitud es verdadera, exacta y completa a mi leal saber y entender. Entiendo que cualquier tergiversación material es causa de denegación o terminación del arrendamiento.',
                legalAuthorize: 'Autorizo a Choice Properties y sus agentes designados a verificar toda la información proporcionada en esta solicitud, incluyendo empleo, ingresos, historial de arrendamiento, referencias personales, y a realizar una verificación de crédito y antecedentes del consumidor.',
                termsAgreeLabel: 'Certifico que toda la información proporcionada en esta solicitud es exacta y completa, y autorizo a Choice Properties a verificarla.',
                submitBtn: 'Enviar Solicitud',
                submitDisclaimer: 'Al enviar, autoriza a Choice Properties a procesar esta solicitud conforme a su Política de Privacidad y Términos de Servicio.',
                privacyPolicy: 'Política de Privacidad',
                termsOfService: 'Términos de Servicio',
                contactSupport: 'Contactar Soporte',
                progressSaved: 'Borrador Guardado',
                offlineMessage: 'Está sin conexión. El progreso se está guardando localmente.',
                notSpecified: 'No proporcionado',
                notSelected: 'No seleccionado',
                retry: 'Reintentar',
                close: 'Cerrar',
                offlineError: 'Conexión no disponible. Verifique su red e intente de nuevo.',
                submissionFailed: 'Error al enviar. Por favor intente de nuevo.',
                backgroundQuestions: 'Preguntas de Divulgación',
                ref1RelationshipLabel: 'Relación con el Solicitante',
                ref1RelationshipPlaceholder: 'ej., Propietario anterior, Empleador, Colega',
                ref2RelationshipLabel: 'Relación con el Solicitante (Opcional)',
                ref2RelationshipPlaceholder: 'ej., Propietario anterior, Empleador, Colega',
                saveResumeLater: 'Guardar y Continuar Después',
                saveResumeDesc: 'Ingrese su correo electrónico para recibir un enlace seguro para retomar esta solicitud.',
                sendLink: 'Enviar Enlace',
                cancel: 'Cancelar',
                linkSent: 'Enlace enviado. Revise su bandeja de entrada.',
                ratioQualifies: 'Cumple el Requisito',
                ratioBorderline: 'Revisión Requerida',
                ratioLow: 'Por Debajo del Umbral',
                noContextTitle: 'Propiedad No Especificada',
                noContextSub: 'Ingrese la dirección completa de la propiedad en el Paso 1 para asociar esta solicitud con el listado correcto.',
                managedBy: 'Administrado por',
                applyingFor: 'Solicitando para',
                viewListing: 'Ver anuncio',
                browseListings: 'Ver listados disponibles',
                charCount: 'caracteres',
                summaryPropertyApplicant: 'Propiedad y Solicitante',
                summaryCoApplicant: 'Co-Solicitante / Garante',
                summaryResidency: 'Historial de Residencia',
                summaryOccupancy: 'Ocupantes y Vehículos',
                summaryEmployment: 'Empleo e Ingresos',
                summaryFinancial: 'Referencias y Contacto de Emergencia',
                summaryPayment: 'Preferencias de Pago',
                retryIn: 'en',
                retryAttempt: 'intento',
                pleaseAgreeDeclarations: 'Todas las declaraciones deben ser reconocidas antes del envío.',
                networkError: 'No es posible conectarse con el servidor. Verifique su conexión e intente de nuevo.',
                networkExhausted: 'No fue posible confirmar el envío debido a un error de conexión. Su solicitud puede haber sido recibida — revise su correo electrónico. Si no recibió confirmación, contáctenos al 707-706-3137.',
                verifyingSubmission: 'Verificando el estado de su solicitud\u2026 Por favor espere un momento.',
                serverError: 'Nuestro sistema está temporalmente no disponible. Por favor intente de nuevo en unos minutos, o contáctenos al 707-706-3137.',
                copied: 'Copiado',
                pageTitle: 'Solicitud de Arrendamiento — Choice Properties',
                howItWorks: 'Descripción General del Proceso',
                requiredField: 'Campo requerido',
                autoSavedHint: 'El progreso se guarda automáticamente',
                uploadTitle: 'Documentos de Apoyo',
                uploadOptional: '(Opcional)',
                uploadDesc: 'Los documentos pueden adjuntarse para agilizar el proceso de revisión. Los archivos de imagen (JPG, PNG) mostrarán una vista previa al cargar. Los archivos PDF se confirmarán con un distintivo de verificación. <strong>Aceptados:</strong> PDF, JPG, PNG · Máx. 1 MB por archivo · Hasta 4 archivos · 3 MB total.',
                uploadCta: 'Haga clic para buscar o arrastre archivos aquí',
                uploadHint: 'Identificación oficial &nbsp;·&nbsp; Talones de pago &nbsp;·&nbsp; Estados de cuenta',
                creditApplied: 'Crédito de Solicitud Aplicado',
                creditAppliedText: 'Se ha aplicado un crédito de solicitud. La tarifa de solicitud está exonerada.',
                trustLine: 'Los datos de la solicitud se transmiten de forma segura y se utilizan exclusivamente para fines de verificación de arrendamiento.',
                feeAcknowledge: 'Reconozco la política de tarifas de solicitud y autorizo que mi información personal sea revisada por el personal de Choice Properties y el propietario de la propiedad únicamente para la verificación de arrendamiento. La tarifa de solicitud es <strong>no reembolsable</strong> al momento del envío y procesamiento del pago, excepto según lo previsto en la <a href="/application-credit-policy.html" target="_blank" rel="noopener" style="color:var(--primary);">Política de Crédito de Solicitud</a>.',
                agreeTermsPrivacy: 'He leído y acepto los <a href="/terms.html" target="_blank" rel="noopener" style="color:var(--primary);">Términos del Servicio</a> (incluyendo la <strong>cláusula de arbitraje vinculante</strong> y la <strong>renuncia a demanda colectiva</strong> en las Secciones 18–19), la <a href="/privacy.html" target="_blank" rel="noopener" style="color:var(--primary);">Política de Privacidad</a> y el <a href="/policies.html" target="_blank" rel="noopener" style="color:var(--primary);">Marco Completo de Políticas y Legal</a>. Confirmo que tengo al menos 18 años de edad y la capacidad legal para celebrar este acuerdo.',
                smsConsent: 'Doy mi consentimiento expreso para recibir mensajes SMS transaccionales de Choice Properties al número móvil proporcionado, relacionados con el estado de la solicitud, coordinación de tarifa, ejecución del contrato y programación de mudanza. La frecuencia de los mensajes varía. <strong>Pueden aplicar tarifas de mensajes y datos.</strong> Responda HELP para asistencia, STOP para cancelar en cualquier momento. El consentimiento de SMS no es condición de la solicitud — deje sin marcar para recibir comunicaciones únicamente por correo electrónico.',
                footerCopyright: '&copy; 2026 Choice Properties. Todos los derechos reservados.',
                startOver: 'Empezar de Nuevo',
                startOverTitle: '¿Descartar Solicitud?',
                startOverDesc: 'Toda la información ingresada se eliminará permanentemente. Será redirigido al Paso 1.',
                keepInfo: 'Continuar Solicitud',
                yesStartOver: 'Descartar y Reiniciar',
                minLeaseHintPre: 'Plazo mínimo de arrendamiento:',
                minLeaseHintPost: 'meses. Por favor seleccione un plazo que cumpla con el requisito.'
            }
        };

        this.translations = translations;
        const _savedLang = (() => {
            try {
                const _s = localStorage.getItem(this.config.LOCAL_STORAGE_KEY);
                return (_s ? (JSON.parse(_s)._language || 'en') : 'en');
            } catch (_e) { return 'en'; }
        })();
        this.state.language = _savedLang;
        const btn = document.getElementById('langToggle');
        const text = document.getElementById('langText');
        
        if (btn && text) {
            btn.addEventListener('click', () => {
                this.state.language = this.state.language === 'en' ? 'es' : 'en';
                const t = translations[this.state.language];
                text.textContent = t.langText;
                
                const HTML_KEYS = new Set(['spamWarning', 'uploadDesc', 'uploadHint', 'feeAcknowledge', 'agreeTermsPrivacy', 'smsConsent', 'footerCopyright']);
                document.querySelectorAll('[data-i18n]').forEach(el => {
                    const key = el.getAttribute('data-i18n');
                    if (t[key] !== undefined) {
                        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                            if (el.placeholder !== undefined) el.placeholder = t[key];
                        } else if (el.tagName === 'OPTION') {
                            el.textContent = t[key];
                        } else if (HTML_KEYS.has(key)) {
                            this._setSafeMarkup(el, t[key]);
                        } else {
                            el.textContent = t[key];
                        }
                    }
                });
                document.documentElement.setAttribute('lang', this.state.language);
                document.title = t.pageTitle;

                document.querySelectorAll('.btn-next').forEach(b => {
                    const span = b.querySelector('[data-i18n="nextStep"]') || b.querySelector('span');
                    if (span) span.textContent = t.nextStep;
                });
                document.querySelectorAll('.btn-prev').forEach(b => {
                    const span = b.querySelector('[data-i18n="prevStep"]') || b.querySelector('span');
                    if (span) span.textContent = t.prevStep;
                });

                this.updateProgressBar();

                if (this.getCurrentSection() === 6) {
                    this.generateApplicationSummary();
                }

                try {
                    const empEl = document.getElementById('employmentStatus');
                    if (empEl && this._toggleEmployerSection) {
                        this._toggleEmployerSection(empEl.value);
                    }
                } catch (_e) { /* Non-fatal: employer label refresh after language toggle */ }

                this.saveProgress();
            });
        }

        if (_savedLang === 'es' && btn && text) {
            const t = translations['es'];
            text.textContent = t.langText;
            const HTML_KEYS = new Set(['spamWarning', 'uploadDesc', 'uploadHint', 'feeAcknowledge', 'agreeTermsPrivacy', 'smsConsent', 'footerCopyright']);
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (t[key] !== undefined) {
                    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                        if (el.placeholder !== undefined) el.placeholder = t[key];
                    } else if (el.tagName === 'OPTION') {
                        el.textContent = t[key];
                    } else if (HTML_KEYS.has(key)) {
                        this._setSafeMarkup(el, t[key]);
                    } else {
                        el.textContent = t[key];
                    }
                }
            });
            document.documentElement.setAttribute('lang', 'es');
            document.title = t.pageTitle;
        }
    }

    // ---------- NEW: Distinguish error types ----------
    isTransientError(error) {
        if (error.isTransient) return true;
        const msg = error.message || error.toString();
        return msg.includes('network') || 
               msg.includes('timeout') || 
               msg.includes('Failed to fetch') ||
               msg.includes('ECONNREFUSED') ||
               msg.includes('Internet') ||
               msg.includes('offline') ||
               msg.includes('conexión') ||
               msg.includes('conexion');
    }

    // ---------- MODIFIED: showSubmissionError with auto-retry ----------
    showSubmissionError(error, isTransient = false) {
        const msgEl = document.getElementById('submissionMessage');
        const progressDiv = document.getElementById('submissionProgress');
        const statusArea = document.getElementById('statusArea');
        const spinner = document.getElementById('submissionSpinner');
        if (!msgEl || !progressDiv || !statusArea) return;

        const t = this.getTranslations();
        let errorMessage = error.message || error.toString();

        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }

        // Auto-retry logic
        if (isTransient && this.retryCount < this.maxRetries) {
            const delay = Math.pow(2, this.retryCount) * 1000; // 2,4,8 seconds
            this.retryCount++;
            
            msgEl.textContent = `${errorMessage} – ${t.retry} ${t.retryIn} ${delay/1000}s (${t.retryAttempt} ${this.retryCount}/${this.maxRetries})`;
            statusArea.classList.add('error');
            if (spinner) {
                spinner.className = 'fas fa-spinner fa-pulse';
                spinner.style.color = '#e74c3c';
            }

            this.retryTimeout = setTimeout(() => {
                this.retryTimeout = null;
                statusArea.classList.remove('error');
                if (spinner) {
                    spinner.className = 'fas fa-spinner fa-pulse';
                    spinner.style.color = '';
                }
                this.updateSubmissionProgress(1, t.processing);
                this.handleFormSubmit(new Event('submit'), true);
            }, delay);
            return;
        }

        // Permanent error or max retries reached
        // If we exhausted auto-retries on a transient (network) error AND the
        // background verify is still running, show a neutral "checking" state
        // instead of the scary error screen. The verify will call
        // handleSubmissionSuccess() if it finds the record, or will call
        // _showFinalNetworkError() after all attempts are exhausted.
        if (isTransient && this.retryCount >= this.maxRetries && this._verifyStarted) {
            msgEl.textContent = t.verifyingSubmission || 'Checking your submission status\u2026 Please wait.';
            statusArea.classList.remove('error');
            if (spinner) {
                spinner.className = 'fas fa-spinner fa-pulse';
                spinner.style.color = '#3498db';
            }
            return; // Don't show retry button yet — verify is still running
        }

        const finalMessage = (isTransient && this.retryCount >= this.maxRetries)
            ? (t.networkExhausted || t.serverError)
            : errorMessage;
        msgEl.textContent = finalMessage;
        statusArea.classList.add('error');
        if (spinner) {
            spinner.className = 'fas fa-exclamation-circle';
            spinner.style.color = '#e74c3c';
        }

        const currentStep = this.getCurrentSubmissionStep();
        if (currentStep) {
            const stepItem = document.getElementById(`stepItem${currentStep}`);
            if (stepItem) stepItem.classList.add('error');
        }

        let retryBtn = document.getElementById('submissionRetryBtn');
        if (!retryBtn) {
            retryBtn = document.createElement('button');
            retryBtn.id = 'submissionRetryBtn';
            retryBtn.className = 'btn-retry';
            this._setIconText(retryBtn, 'fas fa-redo-alt', t.retry);
            progressDiv.appendChild(retryBtn);
        }
        retryBtn.style.display = 'inline-flex';

        const newBtn = retryBtn.cloneNode(true);
        retryBtn.parentNode.replaceChild(newBtn, retryBtn);
        newBtn.addEventListener('click', () => {
            newBtn.style.display = 'none';
            const closeBtnEl = document.getElementById('submissionCloseBtn');
            if (closeBtnEl) closeBtnEl.style.display = 'none';
            statusArea.classList.remove('error');
            if (spinner) {
                spinner.className = 'fas fa-spinner fa-pulse';
                spinner.style.color = '';
            }
            if (currentStep) {
                const stepItem = document.getElementById(`stepItem${currentStep}`);
                if (stepItem) stepItem.classList.remove('error');
            }
            this.retryCount = 0;
            this._verifyStarted = false;
            this._successHandled = false;
            this.updateSubmissionProgress(1, t.processing);
            this.handleFormSubmit(new Event('submit'));
        });

        this._ensureSubmissionCloseBtn(progressDiv, t);
    }

    // ---------- _ensureSubmissionCloseBtn ----------
    // Adds (or shows) a Close button next to the Retry button so the user is
    // never stuck inside the submission overlay when an error appears.
    _ensureSubmissionCloseBtn(progressDiv, t) {
        if (!progressDiv) return;
        let closeBtn = document.getElementById('submissionCloseBtn');
        if (!closeBtn) {
            closeBtn = document.createElement('button');
            closeBtn.id = 'submissionCloseBtn';
            closeBtn.className = 'btn-close-error';
            closeBtn.type = 'button';
            closeBtn.setAttribute('aria-label', (t && t.close) || 'Close');
            progressDiv.appendChild(closeBtn);
        }
        this._setIconText(closeBtn, 'fas fa-times', (t && t.close) || 'Close');
        closeBtn.style.display = 'inline-flex';

        const fresh = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(fresh, closeBtn);
        fresh.addEventListener('click', () => {
            if (this.retryTimeout) {
                clearTimeout(this.retryTimeout);
                this.retryTimeout = null;
            }
            const statusArea = document.getElementById('statusArea');
            const spinner = document.getElementById('submissionSpinner');
            const retryBtn = document.getElementById('submissionRetryBtn');
            if (statusArea) statusArea.classList.remove('error');
            if (spinner) { spinner.className = 'fas fa-spinner fa-pulse'; spinner.style.color = ''; }
            if (retryBtn) retryBtn.style.display = 'none';
            for (let i = 1; i <= 4; i++) {
                const stepItem = document.getElementById(`stepItem${i}`);
                if (stepItem) stepItem.classList.remove('error');
            }
            fresh.style.display = 'none';
            this.hideSubmissionProgress();
            this.isSubmitting = false;
        });
    }

    getCurrentSubmissionStep() {
        for (let i = 1; i <= 4; i++) {
            const seg = document.getElementById(`progressSegment${i}`);
            if (seg && seg.classList.contains('active')) return i;
        }
        return null;
    }

    // ---------- updateSubmissionProgress ----------
    updateSubmissionProgress(step, customMessage) {
        const t = this.getTranslations();
        const messages = {
            1: t.processing,
            2: t.validating,
            3: t.submitting,
            4: t.complete
        };
        const msg = messages[step] || customMessage || '';
        const msgEl = document.getElementById('submissionMessage');
        if (msgEl) msgEl.textContent = msg;

        for (let i = 1; i <= 4; i++) {
            const seg = document.getElementById(`progressSegment${i}`);
            const stepItem = document.getElementById(`stepItem${i}`);
            if (seg) {
                seg.classList.remove('completed', 'active');
                if (i < step) seg.classList.add('completed');
                else if (i === step) seg.classList.add('active');
            }
            if (stepItem) {
                stepItem.classList.remove('completed', 'active', 'error');
                if (i < step) stepItem.classList.add('completed');
                else if (i === step) stepItem.classList.add('active');
            }
        }

        const spinner = document.getElementById('submissionSpinner');
        if (step === 4 && spinner) {
            spinner.className = 'fas fa-check-circle';
            spinner.style.color = '#27ae60';
        } else if (spinner) {
            spinner.className = 'fas fa-spinner fa-pulse';
            spinner.style.color = '';
        }
    }


    // Generates a 64-character hex nonce used as a bot-friction CSRF token.
    // The backend validates format only (32-128 alphanumeric chars); this satisfies that requirement.
    generateCsrfNonce() {
        try {
            const arr = new Uint8Array(32);
            window.crypto.getRandomValues(arr);
            return Array.from(arr, b => ('0' + b.toString(16)).slice(-2)).join('');
        } catch (_) {
            // Fallback for browsers without crypto API (extremely rare)
            let n = '';
            const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
            for (let i = 0; i < 40; i++) n += chars.charAt(Math.floor(Math.random() * chars.length));
            return n;
        }
    }
    isSupabaseBackend() {
        return true;
    }

    // ---------- MODIFIED: handleFormSubmit with retry reset ----------
    async handleFormSubmit(e, isRetry = false) {
        e.preventDefault();
        const t = this.getTranslations();

        // ── Duplicate submission guard ──────────────────────────────
        // Block if already mid-submission
        if (this.state.isSubmitting) return;
          // [10B-12] Guard: if BACKEND_URL was not injected by the build pipeline,
          // show a user-facing error rather than silently failing.
          if (!this.BACKEND_URL) {
              alert('The application system is temporarily unavailable. Please try again or call 707-706-3137.');
              return;
          }
          if (!(window.CP_CONFIG && window.CP_CONFIG.SUPABASE_ANON_KEY)) {
              this.showSubmissionError(new Error('The application system is missing a required security key. Please call 707-706-3137 so we can help you submit.'), false);
              return;
          }
        // Block if this session already produced a successful appId
        if (sessionStorage.getItem('lastSuccessAppId')) {
            const existingId = sessionStorage.getItem('lastSuccessAppId');
            this.showSuccessState(existingId);
            const form = document.getElementById('rentalApplication');
            if (form) form.style.display = 'none';
            return;
        }
        // ────────────────────────────────────────────────────────────

        if (!isRetry) {
            this.retryCount = 0;
            this._verifyStarted = false;
            this._successHandled = false;
        }
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }

        if (!navigator.onLine) {
            const t = this.getTranslations();
            this.showSubmissionError(new Error(t.offlineError), false);
            const submitBtn = document.getElementById('mainSubmitBtn');
            if (submitBtn) {
                submitBtn.classList.remove('loading');
                submitBtn.disabled = false;
            }
            this.setState({ isSubmitting: false });
            return;
        }

        const certify = document.getElementById('certifyCorrect');
        const authorize = document.getElementById('authorizeVerify');
        const feeAck = document.getElementById('feeAcknowledge');
        const agreeTP = document.getElementById('agreeTermsPrivacy');
        const smsConsent = document.getElementById('smsConsent');
        // Capture consent metadata before any validation gates
        try {
            const tsEl = document.getElementById('hiddenConsentTimestamp');
            if (tsEl) tsEl.value = new Date().toISOString();
            const smsEl = document.getElementById('hiddenSmsConsent');
            if (smsEl) smsEl.value = (smsConsent && smsConsent.checked) ? 'yes' : 'no';
            const termsEl = document.getElementById('hiddenTermsConsent');
            if (termsEl) termsEl.value = (agreeTP && agreeTP.checked) ? 'yes' : 'no';
        } catch (_) { /* non-blocking */ }
        const allDeclarations = [certify, authorize, feeAck, agreeTP].filter(Boolean);
        if (allDeclarations.some(cb => !cb.checked)) {
            // Show inline error instead of alert — scroll to first unchecked declaration
              const _firstUnchecked = allDeclarations.find(cb => !cb.checked);
              const _declErr = document.getElementById('declarationError');
              const _declMsg = t.pleaseAgreeDeclarations || 'Please check all required declarations before submitting.';
              if (_declErr) { _declErr.textContent = _declMsg; _declErr.style.display = 'block'; }
              if (_firstUnchecked) {
                  const _scrollTarget = _firstUnchecked.closest('.custom-checkbox') || _firstUnchecked;
                  _scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  _firstUnchecked.classList.add('shake');
                  setTimeout(() => _firstUnchecked.classList.remove('shake'), 600);
              }
            const submitBtn = document.getElementById('mainSubmitBtn');
            if (submitBtn) {
                submitBtn.classList.remove('loading');
                submitBtn.disabled = false;
            }
            this.setState({ isSubmitting: false });
            return;
        }
        // Clear any prior declaration error when all boxes are checked
          const _declErrEl = document.getElementById('declarationError');
          if (_declErrEl) _declErrEl.style.display = 'none';

        if (!isRetry) {
            for (let i = 1; i <= 5; i++) {
                if (!this.validateStep(i)) {
                    this.showSection(i);
                    this.updateProgressBar();
                    return;
                }
            }
        }

        const submitBtn = document.getElementById('mainSubmitBtn');
        if (submitBtn) {
            submitBtn.classList.add('loading');
            submitBtn.disabled = true;
        }

        this.setState({ isSubmitting: true });
        this.showSubmissionProgress();

        try {
            this.updateSubmissionProgress(1, t.processing);

            const form = document.getElementById('rentalApplication');
            const formData = new FormData(form);

            // Idempotency key — server uses this to dedupe accidental double-submits
            // (network retries, double-clicks, etc.). Generate once per attempt; if the
            // user clicks Submit a second time after a flaky network, we'll regenerate
            // a new UUID so it really does send a fresh attempt.
            try {
                const submissionUuid = (window.crypto && typeof crypto.randomUUID === 'function')
                    ? crypto.randomUUID()
                    : ('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                        const r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8); return v.toString(16);
                      }));
                formData.set('submission_uuid', submissionUuid);
            } catch (_) { /* non-fatal */ }

            // Property context fields are carried by hidden inputs in index.html
            // and serialised automatically by FormData — no manual appending needed.

            // [10A-3] Encode attached documents as base64 and append to form data.
            // Guard: if total raw size > 3 MB skip file attachment so the application
            // record is never lost due to payload size.
            if (this._uploadedFiles && this._uploadedFiles.length > 0) {
                const MAX_TOTAL_BYTES = 3 * 1024 * 1024; // 3 MB raw → ~4 MB base64
                const totalBytes = this._uploadedFiles.reduce((sum, f) => sum + f.size, 0);
                if (totalBytes > MAX_TOTAL_BYTES) {
                    console.warn('[CP] Files too large (' + (totalBytes / 1024 / 1024).toFixed(1) + ' MB total) — skipping attachments.');
                    const uploadWarn = document.getElementById('uploadError');
                    if (uploadWarn) {
                        uploadWarn.textContent = 'Your attached files are too large to submit together. They have been removed from this submission. Please email your documents to us separately after submitting.';
                        uploadWarn.style.display = 'block';
                        // Scroll the warning into view so it isn't missed on Step 6
                        uploadWarn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                } else {
                    const encodeFile = (file) => new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => {
                            const b64 = reader.result.split(',')[1];
                            resolve(b64);
                        };
                        reader.onerror = reject;
                        reader.readAsDataURL(file);
                    });
                    const encoded = await Promise.all(this._uploadedFiles.map(encodeFile));
                    encoded.forEach((b64, i) => {
                        formData.append(`_docFile_${i}_name`, this._uploadedFiles[i].name);
                        formData.append(`_docFile_${i}_type`, this._uploadedFiles[i].type || 'application/octet-stream');
                        formData.append(`_docFile_${i}_data`, b64);
                    });
                }
            }

                        this.updateSubmissionProgress(2, t.validating);

            // M4: Attach CSRF token to submission
            formData.append('_cp_csrf', this._csrfToken || sessionStorage.getItem('_cp_csrf') || '');

            let response;
            const _fetchController = new AbortController();
            const _fetchTimer = setTimeout(() => _fetchController.abort(), 120000);
            const _anonKey = (window.CP_CONFIG && window.CP_CONFIG.SUPABASE_ANON_KEY) || '';
            try {
                response = await fetch(this.BACKEND_URL, {
                    method: 'POST',
                    body: formData,
                    signal: _fetchController.signal,
                    headers: {
                        'Accept': 'application/json',
                        ..._anonKey ? { 'apikey': _anonKey, 'Authorization': 'Bearer ' + _anonKey } : {}
                    }
                });
            } catch (networkErr) {
                const netErr = new Error(t.networkError);
                netErr.isTransient = true;
                throw netErr;
            } finally {
                clearTimeout(_fetchTimer);
            }

            let result;
            const contentType = response.headers.get('content-type') || '';
            try {
                const rawText = await response.text();
                result = JSON.parse(rawText);
            } catch (parseErr) {
                throw new Error(response.ok ? t.serverError : 'The application system returned an unexpected response. Please call 707-706-3137 if this continues.');
            }
            if (!response.ok) {
                const serverMessage = result && result.error ? result.error : '';
                if (response.status === 401 || response.status === 403) {
                    throw new Error('The application system is not accepting submissions because of a configuration issue. Please call 707-706-3137 so we can help you submit.');
                }
                if (response.status === 422 && serverMessage) {
                    throw new Error(serverMessage);
                }
                throw new Error(serverMessage || t.serverError);
            }

            if (result.success) {
                this.updateSubmissionProgress(3, t.submitting);
                await this.delay(500);
                this.updateSubmissionProgress(4, t.complete);
                await this.delay(500);
                this.handleSubmissionSuccess(result.appId, result.portal_login_url);
            } else {
                // GAS returns this error when the form was already submitted successfully
                // but the original response was lost and the frontend retried. The App ID
                // embedded in the message proves the first submission went through — treat
                // it as success so the user sees the confirmation screen, not an error.
                const errMsg = result.error || '';
                if (errMsg.includes('already have an active application')) {
                    // GAS also returns existingAppId directly in the JSON — prefer that,
                    // fall back to parsing the Ref: from the message text
                    const refMatch = errMsg.match(/Ref:\s*([A-Z0-9\-]+)/i);
                    const extractedId = result.existingAppId || result.appId || (refMatch && refMatch[1]) || '';
                    this.updateSubmissionProgress(3, t.submitting);
                    await this.delay(300);
                    this.updateSubmissionProgress(4, t.complete);
                    await this.delay(300);
                    this.handleSubmissionSuccess(extractedId, result.portal_login_url);
                    return;
                }
                throw new Error(errMsg || 'Submission failed');
            }

        } catch (error) {
            console.error('Submission error:', error);
            const submitBtn = document.getElementById('mainSubmitBtn');
            if (submitBtn) {
                submitBtn.classList.remove('loading');
                submitBtn.disabled = false;
            }
            this.setState({ isSubmitting: false });

            const isTransient = this.isTransientError(error);
            this.showSubmissionError(error, isTransient);

            // After the FIRST network/transient error, check in the background
            // whether the Edge Function already saved the application.
            // _verifyStarted ensures we only launch one background check per attempt.
            if (isTransient && this.retryCount >= 1 && this.BACKEND_URL && !this._verifyStarted) {
                this._verifyStarted = true;
                this._autoVerifySubmission();
            }
        }
    }

    // ---------- _autoVerifySubmission ----------
    // Called in the background after the first network/transient error.
    // Polls the receive-application Edge Function every 3 s for up to 60 s
    // to confirm whether the submission was already saved.
    async _autoVerifySubmission() {
        try {
            const emailEl = document.getElementById('email');
            const email = emailEl ? emailEl.value.trim() : '';
            if (!email || !email.includes('@') || !this.BACKEND_URL) {
                this._verifyStarted = false;
                this._showFinalNetworkError();
                return;
            }

            const isSupabase = this.isSupabaseBackend();
            const INITIAL_DELAY = isSupabase ? 3000 : 20000;
            const MAX_ATTEMPTS = isSupabase ? 20 : 14;
            const POLL_INTERVAL = isSupabase ? 3000 : 5000;
            await this.delay(INITIAL_DELAY);

            const verify = new URL(this.BACKEND_URL);
            verify.searchParams.set('path', 'checkRecentSubmission');
            verify.searchParams.set('email', email);
            const verifyUrl = verify.toString();

            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                if (attempt > 0) await this.delay(POLL_INTERVAL);

                // If the POST response already showed success, stop polling
                if (this._successHandled) { this._verifyStarted = false; return; }

                // Abort individual requests after 12 s so a hung request
                // doesn't eat the whole poll slot
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 12000);
                const _vAnonKey = (window.CP_CONFIG && window.CP_CONFIG.SUPABASE_ANON_KEY) || '';
                try {
                    const resp = await fetch(verifyUrl, {
                        signal: ctrl.signal,
                        headers: _vAnonKey ? { 'apikey': _vAnonKey, 'Authorization': 'Bearer ' + _vAnonKey } : {}
                    });
                    clearTimeout(timer);
                    if (!resp.ok) continue;
                    let data;
                    try { data = JSON.parse(await resp.text()); } catch (_) { continue; }
                    if (data && data.found && data.appId) {
                        console.log('[CP] Auto-verify: confirmed — App ID:', data.appId);
                        if (this.retryTimeout) { clearTimeout(this.retryTimeout); this.retryTimeout = null; }
                        this._verifyStarted = false;
                        this.handleSubmissionSuccess(data.appId, data.portal_login_url);
                        return;
                    }
                } catch (_netErr) {
                    clearTimeout(timer);
                    // Network error on this attempt — keep trying
                }
            }

            // All attempts exhausted without finding the submission
            this._verifyStarted = false;
            this._showFinalNetworkError();
        } catch (e) {
            this._verifyStarted = false;
            this._showFinalNetworkError();
        }
    }

    // ---------- _showFinalNetworkError ----------
    // Called by _autoVerifySubmission after all verify attempts are exhausted.
    // At this point the user has been waiting a while — show the friendly
    // "may have been received" message with the manual Retry button.
    _showFinalNetworkError() {
        const t = this.getTranslations();
        const msgEl = document.getElementById('submissionMessage');
        const statusArea = document.getElementById('statusArea');
        const spinner = document.getElementById('submissionSpinner');
        const progressDiv = document.getElementById('submissionProgress');
        if (!msgEl || !progressDiv) return;

        msgEl.textContent = t.networkExhausted || t.serverError;
        if (statusArea) statusArea.classList.add('error');
        if (spinner) { spinner.className = 'fas fa-exclamation-circle'; spinner.style.color = '#e74c3c'; }

        let retryBtn = document.getElementById('submissionRetryBtn');
        if (!retryBtn) {
            retryBtn = document.createElement('button');
            retryBtn.id = 'submissionRetryBtn';
            retryBtn.className = 'btn-retry';
            progressDiv.appendChild(retryBtn);
        }
        this._setIconText(retryBtn, 'fas fa-redo-alt', t.retry);
        retryBtn.style.display = 'inline-flex';

        const newBtn = retryBtn.cloneNode(true);
        retryBtn.parentNode.replaceChild(newBtn, retryBtn);
        newBtn.addEventListener('click', () => {
            newBtn.style.display = 'none';
            const closeBtnEl = document.getElementById('submissionCloseBtn');
            if (closeBtnEl) closeBtnEl.style.display = 'none';
            if (statusArea) statusArea.classList.remove('error');
            if (spinner) { spinner.className = 'fas fa-spinner fa-pulse'; spinner.style.color = ''; }
            this.retryCount = 0;
            this._verifyStarted = false;
            this._successHandled = false;
            const translations = this.getTranslations();
            this.updateSubmissionProgress(1, translations.processing);
            this.handleFormSubmit(new Event('submit'));
        });

        this._ensureSubmissionCloseBtn(progressDiv, t);
    }

    // ---------- MODIFIED: show/hide progress with backdrop ----------
    showSubmissionProgress() {
        const progress = document.getElementById('submissionProgress');
        const backdrop = document.getElementById('modalBackdrop');
        const form = document.getElementById('rentalApplication');
        if (progress) progress.style.display = 'block';
        if (backdrop) backdrop.style.display = 'block';
        if (form) form.style.display = 'none';
    }

    hideSubmissionProgress() {
        const progress = document.getElementById('submissionProgress');
        const backdrop = document.getElementById('modalBackdrop');
        const form = document.getElementById('rentalApplication');
        if (progress) progress.style.display = 'none';
        if (backdrop) backdrop.style.display = 'none';
        if (form) form.style.display = 'block';
    }

    // ---------- handleSubmissionSuccess ----------
    handleSubmissionSuccess(appId, portalLoginUrl) {
        // Guard against being called twice (POST response + verify both succeed)
        if (this._successHandled) return;
        this._successHandled = true;
        this.hideSubmissionProgress();
        const form = document.getElementById('rentalApplication');
        if (form) form.style.display = 'none';
        const backdrop = document.getElementById('modalBackdrop');
        if (backdrop) backdrop.style.display = 'none';

        // Stash the one-click portal URL alongside the appId so the success
        // card's "Open Tenant Portal" button (and any reload of this page)
        // signs the applicant in straight away — no email re-entry needed.
        try {
            if (portalLoginUrl && /^https?:\/\//i.test(portalLoginUrl)) {
                sessionStorage.setItem('lastSuccessPortalUrl', portalLoginUrl);
            } else {
                sessionStorage.removeItem('lastSuccessPortalUrl');
            }
        } catch (_) { /* storage disabled — fall back to legacy login URL */ }

        this.showSuccessState(appId, portalLoginUrl);
        this.clearSavedProgress();
        sessionStorage.setItem('lastSuccessAppId', appId);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ---------- showSuccessState ----------
    showSuccessState(appId, portalLoginUrl) {
        const successState = document.getElementById('successState');
        if (!successState) return;

        const t = this.getTranslations();
        
        const getSelectedCheckboxValues = (name) => {
            const checkboxes = document.querySelectorAll(`input[name="${name}"]:checked`);
            return Array.from(checkboxes).map(cb => cb.value);
        };
        
        const contactMethods = getSelectedCheckboxValues('Preferred Contact Method');
        const contactMethodsDisplay = contactMethods.length > 0 ? contactMethods.join(', ') : t.notSpecified;
        
        const contactTimes = getSelectedCheckboxValues('Preferred Time');
        const contactTimesDisplay = contactTimes.length > 0 ? contactTimes.join(', ') : t.notSpecified;
        
        const primaryPayment = document.getElementById('primaryPayment')?.value;
        const secondaryPayment = document.getElementById('secondaryPayment')?.value;
        const thirdPayment = document.getElementById('thirdPayment')?.value;
        const email = document.getElementById('email')?.value?.trim() || '';
        // Prefer the one-click magic-login URL minted server-side by
        // receive-application; fall back to the legacy "enter your email"
        // login page if the URL is missing or no longer in storage.
        let savedPortalUrl = '';
        try { savedPortalUrl = sessionStorage.getItem('lastSuccessPortalUrl') || ''; } catch (_) {}
        const oneClickUrl = (portalLoginUrl && /^https?:\/\//i.test(portalLoginUrl))
            ? portalLoginUrl
            : (/^https?:\/\//i.test(savedPortalUrl) ? savedPortalUrl : '');
        const trackUrl = oneClickUrl
            || ('/tenant/login.html?app_id=' + encodeURIComponent(appId) + (email ? '&email=' + encodeURIComponent(email) : ''));

        let paymentPrefs = primaryPayment ? primaryPayment : t.notSelected;
        if (secondaryPayment && secondaryPayment.trim()) {
            paymentPrefs += `, ${secondaryPayment}`;
        }
        if (thirdPayment && thirdPayment.trim()) {
            paymentPrefs += `, ${thirdPayment}`;
        }

        // Build payment method chips for prominent display
        const paymentMethods = [primaryPayment, secondaryPayment, thirdPayment].filter(Boolean);
        const paymentChipsHtml = paymentMethods.length
            ? paymentMethods.map((m, i) => {
                const label = i === 0 ? '<strong>' + this._escHtml(m) + '</strong>' : this._escHtml(m);
                const badge = i === 0 ? ' <span style="font-size:10px;background:#1e3a8a;color:#fff;border-radius:4px;padding:1px 5px;vertical-align:middle;margin-left:4px;">PRIMARY</span>' : '';
                return '<span class="payment-method-chip" style="display:inline-flex;align-items:center;background:#f0f4ff;border:1.5px solid #c7d4f5;border-radius:20px;padding:5px 14px;margin:3px 4px 3px 0;font-size:0.92rem;color:#1e3a8a;">' + label + badge + '</span>';
              }).join('')
            : '<span style="color:#64748b;">' + this._escHtml(t.notSelected) + '</span>';

        // Primary method for the coordination callout
        const primaryMethodName = primaryPayment ? primaryPayment : 'your preferred method';
        const feeAmt = this.state.applicationFee > 0 ? '$' + this.state.applicationFee : 'the application fee';
        
        // Property context line for success card (if arrived from listing site)
        const ctx = this.state.propertyContext;
        const propertyLine = (ctx && (ctx.name || ctx.city))
            ? '<div class="success-property-line"><i class="fas fa-home"></i><span>' +
              this._escHtml(ctx.name || [ctx.city, ctx.state].filter(Boolean).join(', ')) +
              '</span></div>'
            : '';

        // 9C-2: 'Back to listing' link if user arrived from a specific property page
        const backLink = this.state.sourceUrl
            ? '<a href="' + this._escHtml(this.state.sourceUrl) + '" style="display:inline-block;margin-top:8px;font-size:0.9rem;color:#1a5276;text-decoration:none;">← Back to this listing</a>'
            : '';

        successState.style.display = 'block';
        this._setTrustedHtml(successState, this._html`
            <div class="success-card">
                <div class="success-header">
                    <i class="fas fa-check-circle"></i>
                    <h2>${t.successTitle}</h2>
                    <p class="success-subtitle">${t.successText}</p>
                    ${this._safeHtml(propertyLine)}
                    ${this._safeHtml(backLink)}
                </div>

                <div class="id-section">
                    <div class="id-label">${t.appId}</div>
                    <div class="id-number" id="successAppId">${appId}</div>
                    <button class="copy-btn" type="button">
                        <i class="fas fa-copy"></i> ${t.clickToCopy}
                    </button>
                    <p style="font-size:12px;color:#64748b;margin:8px 0 0;"><i class="fas fa-info-circle"></i> Save this ID — you will need it to reference your application.</p>
                </div>

                <div class="divider"></div>

                <div class="next-steps-box">
                    <h3><i class="fas fa-clock"></i> ${t.immediateNextSteps}</h3>
                    
                    <div class="step-row">
                        <div class="step-number">1</div>
                        <div class="step-content">
                            <strong>${t.paymentRequiredTitle}</strong>
                            <p>${t.paymentRequiredDesc}</p>
                        </div>
                    </div>

                    <div class="step-row">
                        <div class="step-number">2</div>
                        <div class="step-content">
                            <strong>${t.completePaymentTitle}</strong>
                            <p>${t.completePaymentDesc}</p>
                        </div>
                    </div>

                    <div class="step-row">
                        <div class="step-number">3</div>
                        <div class="step-content">
                            <strong>${t.reviewBeginsTitle}</strong>
                            <p>${t.reviewBeginsDesc}</p>
                        </div>
                    </div>
                </div>

                <div class="urgent-notice">
                    <i class="fas fa-exclamation-circle"></i>
                    <p><strong>${t.importantNote}</strong> ${t.paymentUrgentText}</p>
                </div>

                <div class="preference-summary">
                    <h4><i class="fas fa-credit-card"></i> ${t.yourPreferences}</h4>
                    <div style="margin-bottom:10px;padding:12px 14px;background:#fffbeb;border:1.5px solid #f59e0b;border-radius:8px;font-size:0.9rem;color:#92400e;line-height:1.5;">
                        <i class="fas fa-phone-alt" style="margin-right:6px;"></i>
                        <strong>A representative will contact you via ${primaryMethodName}</strong> to coordinate the ${feeAmt} application fee.
                    </div>
                    <div style="margin-bottom:8px;">
                        <div style="font-size:0.8rem;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">${t.paymentPref}</div>
                        ${this._safeHtml(paymentChipsHtml)}
                    </div>
                    <div class="preference-grid" style="margin-top:10px;">
                        <div class="pref-item">
                            <span class="pref-label">${t.contactMethod}</span>
                            <span class="pref-value">${contactMethodsDisplay}</span>
                        </div>
                        <div class="pref-item">
                            <span class="pref-label">${t.bestTimes}</span>
                            <span class="pref-value">${contactTimesDisplay}</span>
                        </div>
                    </div>
                    <p class="pref-note">${t.preferenceNote}</p>
                </div>

                <div class="policy-box">
                    <i class="fas fa-gem"></i>
                    <div>
                        <strong>${t.reapplicationPolicyTitle}</strong>
                        <p>${t.reapplicationPolicyText}</p>
                    </div>
                </div>

                <div class="action-buttons">
                    <a href="${trackUrl}" class="btn-track">
                        <i class="fas fa-search"></i> ${t.trackStatus}
                    </a>
                    <button type="button" class="btn-new">
                        <i class="fas fa-plus"></i> ${t.newApplication}
                    </button>
                </div>

                <div class="spam-warning-notice" style="background:#fff8e1;border:1px solid #ffe082;border-radius:10px;padding:14px 16px;margin:16px 0;font-size:13.5px;color:#5d4037;line-height:1.5;">
                    ${this._safeHtml(t.spamWarning)}
                </div>

                <div class="help-line">
                    ${t.questions} <strong>707-706-3137</strong> — ${t.helpText}
                </div>
            </div>
        `);

        const copyButton = successState.querySelector('.copy-btn');
        const newButton = successState.querySelector('.btn-new');
        sessionStorage.setItem('lastSuccessAppId', appId);
        sessionStorage.setItem('pendingPortalAppId', appId);
        if (copyButton) copyButton.addEventListener('click', () => window.copyAppId());
        if (newButton) {
            newButton.addEventListener('click', () => {
                sessionStorage.removeItem('lastSuccessAppId');
                sessionStorage.removeItem('pendingPortalAppId');
                location.reload();
            });
        }
        
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    getTranslations() {
        if (!this.translations) return {};
        return this.translations[this.state.language] || this.translations['en'];
    }

    clearSavedProgress() {
        try { localStorage.removeItem(this.config.LOCAL_STORAGE_KEY); } catch (e) {}
        if (this._autoSaveTimer) {
            clearInterval(this._autoSaveTimer);
            this._autoSaveTimer = null;
        }
    }

    generateApplicationSummary() {
        const summaryContainer = document.getElementById('applicationSummary');
        if (!summaryContainer) return;

        const data = this.getAllFormData();
        Object.keys(data).forEach(key => {
            if (Array.isArray(data[key])) {
                data[key] = data[key].join(', ');
            }
        });

        const t = this.getTranslations();

        const groups = [
            { id: 1, name: t.summaryPropertyApplicant, fields: [
                'Property Address', 'Requested Move-in Date', 'Desired Lease Term',
                'First Name', 'Last Name', 'Email', 'Phone', 'SSN'
            ]},
            { id: 1, name: t.summaryCoApplicant, fields: [
                'Has Co-Applicant', 'Additional Person Role',
                'Co-Applicant First Name', 'Co-Applicant Last Name',
                'Co-Applicant Email', 'Co-Applicant Phone',
                'Co-Applicant DOB',
                'Co-Applicant SSN',
                'Co-Applicant Employer', 'Co-Applicant Job Title',
                'Co-Applicant Monthly Income', 'Co-Applicant Employment Duration',
                'Co-Applicant Consent'
            ]},
            { id: 2, name: t.summaryResidency, fields: [
                'Current Address', 'Residency Duration', 'Current Rent Amount',
                'Reason for leaving', 'Current Landlord Name', 'Landlord Phone'
            ]},
            { id: 2, name: t.summaryOccupancy, fields: [
                'Total Occupants', 'Additional Occupants', 'Has Pets', 'Pet Details',
                'Has Vehicle', 'Vehicle Make', 'Vehicle Model', 'Vehicle Year', 'Vehicle License Plate'
            ]},
            { id: 3, name: t.summaryEmployment, fields: [
                'Employment Status', 'Employer', 'Job Title', 'Employment Duration',
                'Supervisor Name', 'Supervisor Phone', 'Monthly Income', 'Other Income'
            ]},
            { id: 4, name: t.summaryFinancial, fields: [
                'Emergency Contact Name', 'Emergency Contact Phone', 'Emergency Contact Relationship',
                'Reference 1 Name', 'Reference 1 Phone', 'Reference 2 Name', 'Reference 2 Phone'
            ]},
            { id: 5, name: t.summaryPayment, fields: [
                'Primary Payment Method', 'Primary Payment Method Other',
                'Alternative Payment Method', 'Alternative Payment Method Other',
                'Third Choice Payment Method', 'Third Choice Payment Method Other'
            ]}
        ];

        const displayLabels = {
            'SSN': 'SSN (Last 4 Digits)',
            'Co-Applicant SSN': 'Co-Applicant SSN (Last 4)',
            'Has Co-Applicant': 'Has Co-Applicant/Guarantor',
            'Additional Person Role': 'Role'
        };

        let summaryHtml = '';
        groups.forEach(group => {
            let groupFieldsHtml = '';
            group.fields.forEach(field => {
                const value = data[field];
                const displayLabel = displayLabels[field] || field;
                  if (value && value !== '') {
                      const isSensitive = field === 'SSN' || field === 'Co-Applicant SSN'; // [10B-4/19]
                      const displayValue = isSensitive ? '••••' : value;
                      groupFieldsHtml += this._html`
                          <div class="summary-item">
                              <div class="summary-label">${displayLabel}</div>
                              <div class="summary-value">${displayValue}</div>
                        </div>`;
                }
            });

            if (groupFieldsHtml) {
                summaryHtml += this._html`
                    <div class="summary-group" data-section-id="${group.id}" role="button" tabindex="0" aria-label="Edit ${group.name}" title="Tap to edit this section">
                        <div class="summary-header">
                            <span>${group.name}</span>
                            <span class="summary-edit-btn" aria-hidden="true">
                                <i class="fas fa-pencil-alt"></i> ${t.editSection}
                            </span>
                        </div>
                        <div class="summary-content">
                            ${this._safeHtml(groupFieldsHtml)}
                        </div>
                    </div>`;
            }
        });

        this._setTrustedHtml(summaryContainer, summaryHtml);
        summaryContainer.querySelectorAll('.summary-group[data-section-id]').forEach(groupEl => {
            const sectionId = parseInt(groupEl.dataset.sectionId, 10);
            if (!sectionId) return;
            groupEl.addEventListener('click', () => this.goToSection(sectionId));
            groupEl.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    this.goToSection(sectionId);
                }
            });
        });
    }

    // ================================================================
    // DEV / TEST — Fill helpers
    // _devFillAll()  : fills ALL 6 steps with random data, jumps to review
    // _devFillTestData(): fills only the current step (step-by-step mode)
    // ================================================================

    _devFillAll() {
        const pick = arr => arr[Math.floor(Math.random() * arr.length)];
        const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

        const firstNames = ['James', 'Alicia', 'Marcus', 'Priya', 'Derek', 'Fatima', 'Carlos', 'Mei', 'Jordan', 'Aisha'];
        const lastNames  = ['Williams', 'Nguyen', 'Thompson', 'Patel', 'Robinson', 'Johnson', 'Garcia', 'Lee', 'Davis', 'Wilson'];
        const streets    = ['Oak Street', 'Maple Avenue', 'Vine Court', 'Hillcrest Drive', 'Lakeview Blvd', 'Elm Way', 'Summit Road'];
        const cities     = ['Detroit, MI', 'Troy, MI', 'Sterling Heights, MI', 'Warren, MI', 'Dearborn, MI'];
        const employers  = ['Stellantis', 'Ford Motor Company', 'Trinity Health', 'DTE Energy', 'Ally Financial', 'Wayne County Govt', 'Amazon Fulfillment'];
        const titles     = ['Project Manager', 'Software Engineer', 'Registered Nurse', 'Operations Analyst', 'Account Executive', 'Financial Advisor'];
        const supNames   = ['Sandra Kim', 'Robert Owens', 'Lisa Tran', 'Kevin Morris', 'Angela Brown'];
        const landlords  = ['Jim Harrington', 'Patricia Moss', 'David Chen', 'Sunrise Property Mgmt', 'Metro Rentals LLC'];
        const payments   = ['Venmo', 'Zelle', 'Cash App', 'PayPal', 'Money Order'];
        const makes      = ['Toyota', 'Honda', 'Ford', 'Chevrolet', 'Nissan'];
        const models     = ['Camry', 'Accord', 'F-150', 'Malibu', 'Altima'];

        const fn = pick(firstNames);
        const ln = pick(lastNames);
        const fn2 = pick(firstNames.filter(n => n !== fn));
        const ln2 = pick(lastNames.filter(n => n !== ln));
        const city = pick(cities);
        const employer = pick(employers);
        const income = rand(3200, 8500);
        const rent = rand(1100, 2200);
        const apt = rand(1, 4);
        const unit = rand(100, 999);
        const plate = String.fromCharCode(65 + rand(0,25)) + String.fromCharCode(65 + rand(0,25)) + rand(10, 99) + String.fromCharCode(65 + rand(0,25)) + String.fromCharCode(65 + rand(0,25));
        const yrs = rand(1, 5);
        const mos = rand(0, 11);
        const empYrs = rand(1, 6);
        const dob = `${rand(1975, 1999)}-${String(rand(1,12)).padStart(2,'0')}-${String(rand(1,28)).padStart(2,'0')}`;
        const ssn = String(rand(1000, 9999));

        const moveIn = new Date();
        moveIn.setDate(moveIn.getDate() + rand(20, 60));
        const pad = n => String(n).padStart(2, '0');
        const moveInStr = `${moveIn.getFullYear()}-${pad(moveIn.getMonth()+1)}-${pad(moveIn.getDate())}`;

        const d   = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        const chk = (id, c) => { const el = document.getElementById(id); if (el) el.checked = c; };
        const sel = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('change')); } };
        const fire = id => { const el = document.getElementById(id); if (el) { el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); } };

        // ── Step 1 ──
        if (!document.getElementById('propertyAddress').value) {
            d('propertyAddress', `${rand(100, 9999)} ${pick(streets)}, ${city} ${rand(48000, 48399)}`);
        }
        d('requestedMoveIn', moveInStr);
        sel('desiredLeaseTerm', pick(['12 months', '12 months', '6 months', '24 months']));
        d('firstName', fn);
        d('lastName', ln);
        d('email', `${fn.toLowerCase()}.${ln.toLowerCase()}${rand(10,99)}@testmail.example`);
        d('phone', `(${rand(313,989)}) ${rand(200,999)}-${rand(1000,9999)}`);
        d('dob', dob);
        d('ssn', ssn);

        // ── Step 2 ──
        d('currentAddress', `${rand(100,9999)} ${pick(streets)}, Apt ${apt}${unit}, ${city} ${rand(48000,48399)}`);
        d('residencyStart', `${yrs} year${yrs !== 1 ? 's' : ''} ${mos > 0 ? mos + ' month' + (mos !== 1 ? 's' : '') : ''}`.trim());
        d('rentAmount', String(rent));
        d('landlordName', pick(landlords));
        d('landlordPhone', `(${rand(248,586)}) ${rand(200,999)}-${rand(1000,9999)}`);
        const rl = document.getElementById('reasonLeaving');
        if (rl) rl.value = pick([
            'Relocating for a new job opportunity.',
            'Looking for a larger space for my family.',
            'Building a newer chapter closer to work.',
            'Seeking a quieter neighborhood.',
            'Landlord is selling the property.',
        ]);
        d('totalOccupants', String(rand(1, 3)));
        chk('petsNo', true);
        chk('evictedNo', true);
        chk('smokeNo', true);
        const vToggle = document.querySelector('input[name="Has Vehicle"][value="Yes"]');
        if (vToggle) { vToggle.checked = true; vToggle.dispatchEvent(new Event('change')); }
        setTimeout(() => {
            d('vehicleMake', pick(makes));
            d('vehicleModel', pick(models));
            d('vehicleYear', String(rand(2015, 2024)));
            d('vehiclePlate', plate);
        }, 80);

        // ── Step 3 ──
        sel('employmentStatus', 'Full-time');
        d('employer', employer);
        d('jobTitle', pick(titles));
        d('employmentDuration', `${empYrs} year${empYrs !== 1 ? 's' : ''}`);
        d('supervisorName', pick(supNames));
        d('supervisorPhone', `(${rand(248,586)}) ${rand(200,999)}-${rand(1000,9999)}`);
        d('monthlyIncome', String(income));
        fire('monthlyIncome');

        // ── Step 4 ──
        d('ref1Name', pick(firstNames) + ' ' + pick(lastNames));
        d('ref1Phone', `(${rand(313,586)}) ${rand(200,999)}-${rand(1000,9999)}`);
        d('ref1Relationship', pick(['Former Landlord', 'Employer', 'Coworker', 'Friend']));
        d('ref2Name', pick(firstNames) + ' ' + pick(lastNames));
        d('ref2Phone', `(${rand(313,586)}) ${rand(200,999)}-${rand(1000,9999)}`);
        d('ref2Relationship', pick(['Coworker', 'Family Friend', 'Neighbor', 'Employer']));
        d('emergencyName', fn2 + ' ' + ln2);
        d('emergencyPhone', `(${rand(313,734)}) ${rand(200,999)}-${rand(1000,9999)}`);
        d('emergencyRelationship', pick(['Sibling', 'Parent', 'Spouse', 'Friend']));

        // ── Step 5 ──
        sel('primaryPayment', pick(payments));
        chk('contactMethodEmail', true);
        chk('timeMorning', true);
        chk('timeAfternoon', true);

        // ── Step 6 (review + declarations) ──
        // Navigate through all steps first, then settle on step 6
        const goTo = (n) => {
            this.hideSection(this.getCurrentSection());
            this.showSection(n);
            this.updateProgressBar();
        };

        setTimeout(() => {
            goTo(6);
            setTimeout(() => {
                chk('certifyCorrect', true);
                chk('authorizeVerify', true);
                chk('feeAcknowledge', true);
                chk('agreeTermsPrivacy', true);
                chk('smsConsent', true);
                this.generateApplicationSummary();

                const toast = document.createElement('div');
                toast.textContent = '\u26A1 All steps filled with random test data';
                toast.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#8e44ad;color:#fff;padding:10px 22px;border-radius:50px;font-size:14px;font-weight:700;z-index:99999;box-shadow:0 4px 14px rgba(0,0,0,0.3);pointer-events:none;';
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 3000);
            }, 120);
        }, 200);
    }

    _devFillTestData() {
        this._devFillStep(this.getCurrentSection());
    }

    _devFillStep(step) {
        const d   = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        const chk = (id, c) => { const el = document.getElementById(id); if (el) el.checked = c; };
        const sel = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('change')); } };
        const fire = id => { const el = document.getElementById(id); if (el) el.dispatchEvent(new Event('input')); };

        switch (step) {
            case 1: {
                const moveIn = new Date();
                moveIn.setDate(moveIn.getDate() + 33);
                const pad = n => String(n).padStart(2, '0');
                const moveInStr = `${moveIn.getFullYear()}-${pad(moveIn.getMonth()+1)}-${pad(moveIn.getDate())}`;
                d('propertyAddress', '742 Vineyard Court, Napa, CA 94558');
                d('requestedMoveIn', moveInStr);
                sel('desiredLeaseTerm', '12 months');
                d('firstName', 'Maria');
                d('lastName', 'Rodriguez');
                d('email', 'maria.test@example.com');
                d('phone', '(707) 555-1234');
                d('dob', '1990-06-15');
                d('ssn', '7890');
                break;
            }
            case 2: {
                d('currentAddress', '456 Oak Street, Apt 3B, Napa, CA 94559');
                d('residencyStart', '2 years 4 months');
                d('rentAmount', '1800');
                d('landlordName', 'John Peterson');
                d('landlordPhone', '(707) 555-9876');
                const rl = document.getElementById('reasonLeaving');
                if (rl) rl.value = 'Looking for a larger space closer to work. Great experience with current landlord.';
                d('totalOccupants', '2');
                chk('petsNo', true);
                const vToggle = document.querySelector('input[name="Has Vehicle"][value="Yes"]');
                if (vToggle) { vToggle.checked = true; vToggle.dispatchEvent(new Event('change')); }
                d('vehicleMake', 'Toyota');
                d('vehicleModel', 'Camry');
                d('vehicleYear', '2021');
                d('vehiclePlate', '7ABC123');
                chk('evictedNo', true);
                chk('smokeNo', true);
                break;
            }
            case 3: {
                sel('employmentStatus', 'Full-time');
                d('employer', 'Napa Valley Winery LLC');
                d('jobTitle', 'Marketing Manager');
                d('employmentDuration', '4 years');
                d('supervisorName', 'David Chen');
                d('supervisorPhone', '(707) 555-5432');
                d('monthlyIncome', '5500');
                fire('monthlyIncome');
                break;
            }
            case 4: {
                d('ref1Name', 'Sarah Johnson');
                d('ref1Phone', '(707) 555-2222');
                d('ref1Relationship', 'Former Landlord');
                d('ref2Name', 'Michael Torres');
                d('ref2Phone', '(707) 555-3333');
                d('ref2Relationship', 'Employer');
                d('emergencyName', 'Carlos Rodriguez');
                d('emergencyPhone', '(707) 555-4444');
                d('emergencyRelationship', 'Brother');
                break;
            }
            case 5: {
                sel('primaryPayment', 'Venmo');
                chk('contactMethodEmail', true);
                chk('timeMorning', true);
                chk('timeAfternoon', true);
                break;
            }
            case 6: {
                chk('certifyCorrect', true);
                chk('authorizeVerify', true);
                chk('feeAcknowledge', true);
                chk('agreeTermsPrivacy', true);
                chk('smsConsent', true);
                this.generateApplicationSummary();
                break;
            }
        }

        console.log(`[DEV] Step ${step} filled`);

        const toast = document.createElement('div');
        toast.textContent = `\uD83E\uDDEA Step ${step} filled`;
        toast.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#2ecc71;color:#fff;padding:10px 20px;border-radius:50px;font-size:14px;font-weight:700;z-index:99999;box-shadow:0 4px 14px rgba(0,0,0,0.25);pointer-events:none;';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2200);
    }
    // ================================================================

    goToSection(sectionNumber) {
        // NOTE: This method bypasses step validation intentionally.
        // Used only from the Step 6 "Edit Section" summary links.
        // Submission validation in handleFormSubmit() re-validates all steps 1-5
        // before allowing final submit, so data integrity is still enforced.
        this.hideSection(this.getCurrentSection());
        this.showSection(sectionNumber);
        this.updateProgressBar();
    }

}

// ---------- Global copy function (single authoritative definition) ----------
// Used by success-card copy buttons.
// The duplicate definition that existed in index.html has been removed.
window.copyAppId = function() {
    const el = document.getElementById('successAppId');
    if (!el) return;
    const appId = el.innerText.trim();
    if (!appId) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(appId).then(() => {
            const btn = document.querySelector('.copy-btn');
            if (btn) {
                const original = Array.from(btn.childNodes).map(node => node.cloneNode(true));
                const tCopy = (window.app && window.app.getTranslations) ? window.app.getTranslations() : {};
                const icon = document.createElement('i');
                icon.className = 'fas fa-check';
                btn.replaceChildren(icon, document.createTextNode(' ' + (tCopy.copied || 'Copied!')));
                setTimeout(() => { btn.replaceChildren(...original.map(node => node.cloneNode(true))); }, 2000);
            }
        }).catch(() => {
            // Clipboard API blocked — fall back to prompt
            window.prompt('Copy your Application ID:', appId);
        });
    } else {
        window.prompt('Copy your Application ID:', appId);
    }
};

// ============================================================
// Initialize app
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    window.app = new RentalApplication();
    const s1 = document.getElementById('section1');
    if (s1) s1.classList.add('active');

    // ── Dev / utility button listeners (replaces inline onclick — CSP safe) ──
    const startOverBtn   = document.getElementById('startOverBtn');
    const clearOverlay   = document.getElementById('clearFormOverlay');
    const clearCancel    = document.getElementById('clearFormCancel');
    const clearConfirm   = document.getElementById('clearFormConfirm');

    if (startOverBtn) startOverBtn.addEventListener('click', () => window.app._openClearSheet());
    if (clearOverlay) clearOverlay.addEventListener('click', () => window.app._closeClearSheet());
    if (clearCancel)  clearCancel.addEventListener('click',  () => window.app._closeClearSheet());
    if (clearConfirm) clearConfirm.addEventListener('click', () => window.app._clearForm());
});
