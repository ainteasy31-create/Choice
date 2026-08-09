// ============================================================
// Import to Choice Properties — Content Script v2.0
// Injected on: zillow.com/homedetails/*, realtor.com, apartments.com, redfin.com
// Uses CP_Extractors (shared-extractors.js) for multi-site extraction.
// Features: one-click save, Download-to-PC, offline queue.
// ============================================================

(function () {
  'use strict';

  const BTN_ID = 'cp-save-btn';

  // ── Base inline styles ────────────────────────────────────────────────────
  const BASE_STYLES = {
    position:       'fixed',
    bottom:         'max(24px, env(safe-area-inset-bottom))',
    right:          'max(24px, env(safe-area-inset-right))',
    zIndex:         '2147483647',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            '8px',
    padding:        '0 20px',
    height:         '52px',
    minWidth:       '60px',
    maxWidth:       '340px',
    background:     '#6366f1',
    color:          '#fff',
    border:         'none',
    borderRadius:   '26px',
    boxShadow:      '0 4px 20px rgba(99,102,241,0.5), 0 2px 6px rgba(0,0,0,0.2)',
    fontFamily:     '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:       '15px',
    fontWeight:     '700',
    letterSpacing:  '0.01em',
    lineHeight:     '1',
    whiteSpace:     'nowrap',
    cursor:         'pointer',
    userSelect:     'none',
    outline:        'none',
    overflow:       'hidden',
    transition:     'background 0.15s, box-shadow 0.15s, transform 0.12s, max-width 0.3s, padding 0.3s, opacity 0.2s',
    textDecoration: 'none',
    boxSizing:      'border-box',
    verticalAlign:  'middle',
    touchAction:    'manipulation',
  };

  // ── Button HTML ───────────────────────────────────────────────────────────
  const ICON_SAVE = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2.5"
         stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
      <path d="M12 2v13M5 9l7 7 7-7"/>
      <path d="M3 20h18"/>
    </svg>`;

  const ICON_CHECK = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2.5"
         stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
      <polyline points="20 6 9 17 4 12"/>
    </svg>`;

  const ICON_X = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2.5"
         stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>`;

  const SPINNER_HTML = `
    <span style="
      display:inline-block;
      width:15px;height:15px;
      border:2px solid rgba(255,255,255,0.35);
      border-top-color:#fff;
      border-radius:50%;
      animation:cp-spin 0.7s linear infinite;
      flex-shrink:0;
    "></span>`;

  function labelHtml(icon, text) {
    return `${icon}<span style="display:inline-block">${text}</span>`;
  }

  // ── State colours ─────────────────────────────────────────────────────────
  const BG = {
    idle:      '#6366f1',
    hover:     '#4f46e5',
    loading:   '#818cf8',
    success:   '#16a34a',
    duplicate: '#a16207',
    error:     '#dc2626',
  };

  // ── Inject button ─────────────────────────────────────────────────────────
  let _attempts = 0;

  function tryInject() {
    _attempts++;
    if (document.getElementById(BTN_ID)) return;
    if (!document.body)                                     { if (_attempts < 20) setTimeout(tryInject, 800); return; }
    if (!CP_Extractors || !CP_Extractors.detect(location.href)) { if (_attempts < 20) setTimeout(tryInject, 800); return; }

    // Inject keyframe for spinner via a <style> tag
    if (!document.getElementById('cp-spin-style')) {
      const s = document.createElement('style');
      s.id = 'cp-spin-style';
      s.textContent = '@keyframes cp-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(s);
    }

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.setAttribute('title', 'Save this listing to Choice Properties pipeline');

    Object.assign(btn.style, BASE_STYLES);

    btn.innerHTML = labelHtml(ICON_SAVE, 'Save to Pipeline');

    btn.addEventListener('mouseenter', () => {
      if (!btn.dataset.state || btn.dataset.state === 'idle') {
        btn.style.background = BG.hover;
        btn.style.transform  = 'translateY(-1px)';
        btn.style.boxShadow  = '0 6px 24px rgba(99,102,241,0.55), 0 2px 6px rgba(0,0,0,0.2)';
      }
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.dataset.state || btn.dataset.state === 'idle') {
        btn.style.background = BG.idle;
        btn.style.transform  = '';
        btn.style.boxShadow  = BASE_STYLES.boxShadow;
      }
      if (btn.dataset.state === 'collapsed') {
        collapseBtn(btn);
      }
    });
    btn.addEventListener('mouseenter', () => {
      if (btn.dataset.state === 'collapsed') expandBtn(btn);
    });

    btn.addEventListener('click', handleSave);
    document.body.appendChild(btn);
  }

  // Start immediately, then back-off retries for slow Next.js hydration
  setTimeout(tryInject,  500);
  setTimeout(tryInject, 1500);
  setTimeout(tryInject, 3000);
  setTimeout(tryInject, 6000);

  // SPA navigation — sites change URL without a full page reload
  let _lastUrl = location.href;
  setInterval(() => {
    if (location.href !== _lastUrl) {
      _lastUrl = location.href;
      const old = document.getElementById(BTN_ID);
      if (old) old.remove();
      _attempts = 0;
      setTimeout(tryInject,  800);
      setTimeout(tryInject, 2000);
    }
  }, 500);

  // ── Button state helpers ──────────────────────────────────────────────────

  function setIdle(btn) {
    btn.dataset.state    = 'idle';
    btn.disabled         = false;
    btn.style.background = BG.idle;
    btn.style.cursor     = 'pointer';
    btn.style.opacity    = '1';
    btn.style.maxWidth   = '340px';
    btn.style.padding    = '0 20px';
    btn.innerHTML = labelHtml(ICON_SAVE, 'Save to Pipeline');
  }

  function setLoading(btn) {
    btn.dataset.state    = 'loading';
    btn.disabled         = true;
    btn.style.background = BG.loading;
    btn.style.cursor     = 'wait';
    btn.innerHTML        = labelHtml(SPINNER_HTML, 'Saving…');
  }

  function setSuccess(btn, text) {
    btn.dataset.state    = 'success';
    btn.disabled         = false;
    btn.style.background = BG.success;
    btn.style.cursor     = 'default';
    btn.style.boxShadow  = '0 4px 20px rgba(22,163,74,0.4), 0 2px 6px rgba(0,0,0,0.12)';
    btn.innerHTML        = labelHtml(ICON_CHECK, text);
    setTimeout(() => { if (btn.isConnected) collapseBtn(btn); }, 4000);
  }

  function setDuplicate(btn) {
    btn.dataset.state    = 'duplicate';
    btn.disabled         = false;
    btn.style.background = BG.duplicate;
    btn.style.cursor     = 'default';
    btn.innerHTML        = labelHtml(ICON_CHECK, 'Already in pipeline');
    setTimeout(() => { if (btn.isConnected) collapseBtn(btn); }, 4000);
  }

  function setError(btn, text) {
    btn.dataset.state    = 'error';
    btn.disabled         = false;
    btn.style.background = BG.error;
    btn.style.cursor     = 'pointer';
    btn.style.boxShadow  = '0 4px 16px rgba(220,38,38,0.3), 0 2px 6px rgba(0,0,0,0.12)';
    btn.innerHTML        = labelHtml(ICON_X, text);
    setTimeout(() => { if (btn.isConnected) setIdle(btn); }, 3500);
  }

  function collapseBtn(btn) {
    btn.dataset.state   = 'collapsed';
    btn.style.maxWidth  = '52px';
    btn.style.padding   = '0';
    btn.style.opacity   = '0.75';
    btn.style.cursor    = 'pointer';
  }

  function expandBtn(btn) {
    btn.style.maxWidth = '320px';
    btn.style.padding  = '0 18px';
    btn.style.opacity  = '1';
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async function getSettings() {
    try {
      if (!chrome.storage || !chrome.storage.local) {
        console.warn('[CP] chrome.storage not available, using defaults');
        return { downloadToPC: true, offlineQueue: true };
      }
      const data = await chrome.storage.local.get({ cp_settings: { downloadToPC: true, offlineQueue: true } });
      return data.cp_settings;
    } catch (err) {
      console.warn('[CP] storage error, using defaults:', err);
      return { downloadToPC: true, offlineQueue: true };
    }
  }

  // ── Save handler ─────────────────────────────────────────────────────────

  async function queuePayload(payload) {
    if (!chrome.storage || !chrome.storage.local) {
      throw new Error('chrome.storage.local not available');
    }
    const data = await chrome.storage.local.get({ cp_queue: [] });
    const queue = data.cp_queue || [];
    const key = `${payload.source || 'unknown'}|${payload.source_listing_id || 'unknown'}`;
    const exists = queue.some(q => `${q.source || 'unknown'}|${q.source_listing_id || 'unknown'}` === key);
    if (exists) return queue.length;
    queue.push(Object.assign({}, payload, { _queued_at: Date.now() }));
    const trimmed = queue.slice(-75); // MAX_QUEUE_ITEMS
    await chrome.storage.local.set({ cp_queue: trimmed });
    return trimmed.length;
  }

  async function handleSave() {
    const btn = document.getElementById(BTN_ID);
    if (!btn || btn.disabled) return;
    if (btn.dataset.state === 'success' || btn.dataset.state === 'duplicate') return;

    setLoading(btn);

    // Extract via multi-site registry
    let payload;
    try {
      payload = CP_Extractors.extract(location.href, document);
    } catch (err) {
      setError(btn, 'Extraction error');
      console.error('[CP] extraction error:', err);
      return;
    }

    if (!payload) {
      setError(btn, 'Open a full listing page');
      return;
    }

    if (!payload.source_listing_id) {
      setError(btn, 'Listing ID not found');
      console.error('[CP] extractor returned no source_listing_id:', payload);
      return;
    }

    const settings = await getSettings();

    // Download to PC first (best-effort; pipeline is primary)
    if (settings.downloadToPC) {
      try {
        if (chrome.runtime && chrome.runtime.sendMessage) {
          await chrome.runtime.sendMessage({ type: 'DOWNLOAD_PAYLOAD', payload });
        }
      } catch (err) {
        console.warn('[CP] download request error:', err);
      }
    }

    // POST to edge function directly from content script (bypasses service worker
    // for better Orion/iOS compatibility). Send secret as query parameter
    // to avoid CORS preflight issues with custom headers.
    let resp;
    try {
      const url = new URL(CP_CONFIG.EDGE_URL);
      url.searchParams.set('secret', CP_CONFIG.IMPORT_SECRET);
      
      const uploadResp = await fetch(url.toString(), {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      let body;
      try {
        body = await uploadResp.json();
      } catch (_) {
        body = {};
      }

      if (!uploadResp.ok) {
        body = body && typeof body === 'object' ? body : {};
        body.ok = false;
        body.httpStatus = uploadResp.status;
        body.error = body.error || `Server rejected import (HTTP ${uploadResp.status})`;
      }

      resp = body;
    } catch (netErr) {
      console.error('[CP] upload request failed:', netErr);
      // Try to queue for later if offline queue is enabled
      if (settings.offlineQueue) {
        try {
          const queueLength = await queuePayload(payload);
          resp = { ok: false, queued: true, queueLength };
        } catch (queueErr) {
          resp = { ok: false, error: 'Network error' };
        }
      } else {
        resp = { ok: false, error: 'Network error' };
      }
    }

    if (resp && resp.ok) {
      const photos = resp.photos || 0;
      const score  = resp.score  != null ? ` · Q:${resp.score}` : '';
      setSuccess(btn, `Saved! ${photos} photo${photos !== 1 ? 's' : ''}${score}`);
      if (chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'SAVED' }).catch(() => {});
      }

      // Auto-trigger ImageKit photo transfer for published listings
      // This ensures photos are permanently available in the pipeline
      if (resp.choice_property_id && photos > 0 && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'TRANSFER_PHOTOS',
          pipeline_id: resp.id,
          property_id: resp.choice_property_id
        }).catch(() => {
          // Non-blocking: photos can be transferred later from admin panel
          console.warn('[CP] Photo transfer request failed (non-critical)');
        });
      }

    } else if (resp && resp.duplicate) {
      setDuplicate(btn);

    } else if (resp && resp.queued) {
      setSuccess(btn, 'Queued offline — will sync');
      if (chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'SAVED' }).catch(() => {});
      }

    } else {
      const rawError = resp && resp.error;
      const msg = rawError ? String(rawError).slice(0, 60) : 'Server error';
      setError(btn, 'Failed: ' + msg);
    }
  }

})();