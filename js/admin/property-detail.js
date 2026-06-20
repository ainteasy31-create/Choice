(function () {
  'use strict';

  function readyDeps() { return window.AdminShell && window.CP && CP.sb && CP.Auth; }
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
  const params = new URLSearchParams(location.search);
  const propId  = params.get('id');

  let _prop      = null;
  let _photos    = [];  // sorted property_photos objects {id,url,display_order,watermark_status}
  let _lightboxOpen = false;
  let _lbIdx     = 0;

  // ── Formatters ──────────────────────────────────────────────────────────────
  function esc(s) { return S ? S.esc(s) : String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmt(d) { if (!d) return '—'; try { return new Date(d).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}); } catch { return d; } }
  function fmtMoney(v) { if (v == null) return '—'; return '$' + Number(v).toLocaleString('en-US'); }
  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function initials(name) { if (!name) return '?'; return name.trim().split(/\s+/).map(w => w[0]).join('').slice(0,2).toUpperCase(); }
  function pillCls(s) {
    return {active:'pill-success',rented:'pill-info',inactive:'pill-muted',maintenance:'pill-warning',
            draft:'pill-muted',paused:'pill-warning',archived:'pill-muted',
            pending:'pill-warning',approved:'pill-success',declined:'pill-muted',submitted:'pill-info',
            reviewing:'pill-info',waitlisted:'pill-warning'}[s] || 'pill-muted';
  }

  // ── Option constants ──────────────────────────────────────────────────────────
  const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
  const AMENITY_OPTIONS    = ['Pool','Gym / Fitness Center','Rooftop Access','Elevator','Doorman / Concierge','Storage Unit','Bike Room','BBQ / Grill Area','Courtyard / Garden','Balcony / Patio','In-unit Laundry','Washer/Dryer Hookups','Fireplace','EV Charging','Dog Run','High Ceilings','City Views','Smart Home'];
  const APPLIANCE_OPTIONS  = ['Dishwasher','Refrigerator','Oven / Range','Microwave','Washer','Dryer','Garbage Disposal','Ice Maker'];
  const FLOORING_OPTIONS   = ['Hardwood','Tile','Carpet','Vinyl / LVP','Laminate','Concrete','Marble'];
  const UTILITY_OPTIONS    = ['Water','Trash','Electric','Gas','Internet','Cable / TV','Heat','Sewer'];
  const LAUNDRY_OPTIONS    = ['','In-unit','Washer/Dryer Hookups','Shared (On-site)','Laundromat Nearby','None'];
  const HEATING_OPTIONS    = ['','Central','Forced Air','Baseboard','Radiant','Heat Pump','Wall Unit','None'];
  const COOLING_OPTIONS    = ['','Central AC','Window Units','Mini-Split','None'];
  const PARKING_TYPE_OPTIONS = ['','None','Street Parking','Garage (Included)','Garage (Fee)','Carport','Parking Lot','Assigned Space'];

  function _tagPicker(name, options, current) {
    const currentSet = new Set((Array.isArray(current) ? current : []).map(s => s.trim()));
    const known = options.filter(Boolean);
    const unknown = [...currentSet].filter(v => !known.includes(v));
    return `<div class="pd-tag-grid" id="pd-tags-${name}">
      ${known.map(o => `<label class="pd-tag"><input type="checkbox" data-tag="${name}" value="${esc(o)}"${currentSet.has(o)?' checked':''}> ${esc(o)}</label>`).join('')}
    </div>
    <input class="pd-edit-input" name="${name}_other" type="text" value="${esc(unknown.join(', '))}" placeholder="Other (comma-separated)" style="margin-top:6px">`;
  }

  function _readTags(form, name, optionsList) {
    const checked = [...form.querySelectorAll(`[data-tag="${name}"]:checked`)].map(el => el.value);
    const other = (form.elements[name + '_other']?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    return [...checked, ...other.filter(v => !optionsList.includes(v))];
  }

  function _makeSelect(name, options, current, labelFn) {
    return `<select class="pd-edit-input" name="${name}">${options.map(v => {
      const label = labelFn ? labelFn(v) : (v || '—');
      return `<option value="${esc(v)}"${current===v?' selected':''}>${esc(label)}</option>`;
    }).join('')}</select>`;
  }

  let _editOriginal = null;
  let _formDirty = false;
  let _autosaveTimer = null;
  let _landlordCache = null;
  let _lastSavedAt = null;
  let _editPendingPhotos = new Map(); // files queued in edit panel, upload on save

  // ── Status toggle ────────────────────────────────────────────────────────────
  const STATUS_OPTIONS = [
    { value:'active',      label:'Active',      cls:'pd-status-chip active' },
    { value:'rented',      label:'Rented',      cls:'pd-status-chip rented' },
    { value:'inactive',    label:'Inactive',    cls:'pd-status-chip inactive' },
    { value:'maintenance', label:'Maintenance', cls:'pd-status-chip maintenance' },
    { value:'draft',       label:'Draft',       cls:'pd-status-chip inactive' },
    { value:'paused',      label:'Paused',      cls:'pd-status-chip maintenance' },
    { value:'archived',    label:'Archived',    cls:'pd-status-chip inactive' },
  ];

  function renderStatusBar(currentStatus) {
    return '<div class="pd-status-toggle" id="pd-status-toggle" role="group" aria-label="Property status">'
      + STATUS_OPTIONS.map(opt =>
          '<button class="' + opt.cls + (currentStatus === opt.value ? ' is-current' : '') + '" '
          + 'data-status-val="' + opt.value + '" '
          + 'aria-pressed="' + (currentStatus === opt.value) + '">'
          + opt.label
          + (currentStatus === opt.value ? ' <span class="pd-status-check" aria-hidden="true">✓</span>' : '')
          + '</button>'
        ).join('')
      + '</div>';
  }

  async function handleStatusChange(newStatus) {
    if (!_prop || newStatus === _prop.status) return;
    const prevStatus = _prop.status;
    const toggle = document.getElementById('pd-status-toggle');
    if (toggle) toggle.style.opacity = '0.5';
    const { error } = await CP.sb().from('properties').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', propId);
    if (toggle) toggle.style.opacity = '1';
    if (error) { S.toast('Failed to update status: ' + error.message, 'error'); return; }
    _prop.status = newStatus;
    if (toggle) { toggle.outerHTML = renderStatusBar(newStatus); bindStatusToggle(); }
    S.toast('Status updated to ' + newStatus, 'success');
    // Audit log (non-blocking)
    CP.Auth.getSession().then(({ data }) => {
      CP.sb().from('admin_actions').insert([{
        user_id:     data?.session?.user?.id || null,
        action:      'property.status_change',
        target_type: 'property',
        target_id:   propId,
        metadata:    { from: prevStatus, to: newStatus }
      }]).then(() => {}).catch(() => {});
    }).catch(() => {});
  }

  function bindStatusToggle() {
    const toggle = document.getElementById('pd-status-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', e => {
      const btn = e.target.closest('[data-status-val]');
      if (!btn) return;
      const val = btn.dataset.statusVal;
      if (val && val !== _prop.status) handleStatusChange(val);
    });
  }

  // ── Gallery ──────────────────────────────────────────────────────────────────
  function galleryPhotoUrl(url) {
    if (!url) return '/assets/placeholder-property.jpg';
    if (window.CONFIG && CONFIG.img) return CONFIG.img(url, 'gallery');
    return url;
  }
  function thumbUrl(url) {
    if (!url) return '/assets/placeholder-property.jpg';
    if (window.CONFIG && CONFIG.img) return CONFIG.img(url, 'strip');
    return url;
  }

  function renderGallery(photos) {
    const urls = photos.map(p => p.url).filter(Boolean);
    if (!urls.length) {
      return '<div id="pd-gallery-wrap"><div class="pd-no-photo pd-no-photo-btn" id="pd-no-photo-zone" role="button" tabindex="0" title="Click to upload photos"><i class="fas fa-camera" style="font-size:1.4rem;color:var(--brand);margin-bottom:6px"></i><span>No photos — tap to upload</span></div></div>';
    }
    const main = `<div class="pd-mosaic">
      <div class="pd-mosaic-main" id="pd-mosaic-main" data-idx="0">
        <img src="${esc(galleryPhotoUrl(urls[0]))}" alt="Photo 1" id="pd-main-img" loading="eager">
        ${urls.length > 1 ? '<button class="pd-mosaic-prev" id="pd-prev" aria-label="Previous">‹</button><button class="pd-mosaic-next" id="pd-next" aria-label="Next">›</button>' : ''}
        <div class="pd-photo-count" id="pd-photo-count">${urls.length > 1 ? '1 / ' + urls.length : ''}</div>
        <button class="pd-expand-btn" id="pd-expand-btn" title="View all photos"><i class="fas fa-expand"></i> ${urls.length} photo${urls.length !== 1 ? 's' : ''}</button>
      </div>
      ${urls.length > 1 ? `<div class="pd-mosaic-side">
        ${urls.slice(1, 5).map((u, i) => {
          const idx = i + 1;
          const isLast = i === Math.min(urls.length - 2, 3) && urls.length > 5;
          return `<div class="pd-mosaic-cell" data-idx="${idx}">
            <img src="${esc(galleryPhotoUrl(u))}" alt="Photo ${idx + 1}" loading="lazy">
            ${isLast ? `<div class="pd-mosaic-overlay"><span>+${urls.length - 5} more</span></div>` : ''}
          </div>`;
        }).join('')}
      </div>` : ''}
    </div>`;

    const strip = urls.length > 1
      ? `<div class="pd-gallery-strip" id="pd-gallery-strip">
          ${urls.map((u, i) => `<button class="pd-strip-thumb${i === 0 ? ' active' : ''}" data-idx="${i}" aria-label="Photo ${i+1}">
            <img src="${esc(thumbUrl(u))}" alt="" loading="lazy">
          </button>`).join('')}
        </div>`
      : '';

    return '<div id="pd-gallery-wrap">' + main + strip + '</div>';
  }

  function refreshGalleryInPlace() {
    const wrap = document.getElementById('pd-gallery-wrap');
    if (!wrap) return;
    wrap.outerHTML = renderGallery(_photos);
    const urls = _photos.map(p => p.url).filter(Boolean);
    bindGallery(urls);
    const noPhotoZone = document.getElementById('pd-no-photo-zone');
    if (noPhotoZone) noPhotoZone.addEventListener('click', () => openPhotoManager(true));
    const photosBtn = document.getElementById('pd-btn-photos');
    if (photosBtn) photosBtn.textContent = _photos.length ? 'All photos (' + _photos.length + ')' : 'Manage photos';
  }

  function bindGallery(urls) {
    let idx = 0;
    const mainImg  = document.getElementById('pd-main-img');
    const countEl  = document.getElementById('pd-photo-count');
    const expandBtn= document.getElementById('pd-expand-btn');
    const prevBtn  = document.getElementById('pd-prev');
    const nextBtn  = document.getElementById('pd-next');

    function goTo(i) {
      idx = (i + urls.length) % urls.length;
      mainImg.style.opacity = '0';
      setTimeout(() => { mainImg.src = galleryPhotoUrl(urls[idx]); mainImg.style.opacity = '1'; }, 150);
      if (countEl) countEl.textContent = (idx + 1) + ' / ' + urls.length;
      document.querySelectorAll('.pd-strip-thumb').forEach((t, ti) => t.classList.toggle('active', ti === idx));
      document.querySelectorAll('.pd-mosaic-cell').forEach(c => c.classList.toggle('active-cell', parseInt(c.dataset.idx) === idx));
    }

    if (prevBtn) prevBtn.addEventListener('click', e => { e.stopPropagation(); goTo(idx - 1); });
    if (nextBtn) nextBtn.addEventListener('click', e => { e.stopPropagation(); goTo(idx + 1); });

    document.getElementById('pd-mosaic-main')?.addEventListener('click', () => openLightbox(idx, urls));
    document.querySelectorAll('.pd-mosaic-cell').forEach(cell => {
      cell.addEventListener('click', () => openLightbox(parseInt(cell.dataset.idx), urls));
    });
    if (expandBtn) expandBtn.addEventListener('click', e => { e.stopPropagation(); openLightbox(idx, urls); });

    document.querySelectorAll('.pd-strip-thumb').forEach(btn => {
      btn.addEventListener('click', () => goTo(parseInt(btn.dataset.idx)));
    });

    let tx = 0;
    mainImg?.parentElement?.addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, { passive: true });
    mainImg?.parentElement?.addEventListener('touchend', e => {
      const diff = tx - e.changedTouches[0].clientX;
      if (Math.abs(diff) > 40) goTo(diff > 0 ? idx + 1 : idx - 1);
    }, { passive: true });
  }

  // ── Lightbox ─────────────────────────────────────────────────────────────────
  function openLightbox(startIdx, urls) {
    _lbIdx = startIdx;
    _lightboxOpen = true;
    let lb = document.getElementById('pd-lightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'pd-lightbox';
      lb.className = 'pd-lightbox';
      lb.innerHTML = `
        <div class="pd-lb-overlay" id="pd-lb-overlay"></div>
        <div class="pd-lb-inner">
          <button class="pd-lb-close" id="pd-lb-close" aria-label="Close">✕</button>
          <button class="pd-lb-prev" id="pd-lb-prev" aria-label="Previous">‹</button>
          <button class="pd-lb-next" id="pd-lb-next" aria-label="Next">›</button>
          <div class="pd-lb-img-wrap" id="pd-lb-img-wrap">
            <img id="pd-lb-img" src="" alt="Property photo">
          </div>
          <div class="pd-lb-counter" id="pd-lb-counter"></div>
          <div class="pd-lb-thumbs" id="pd-lb-thumbs"></div>
        </div>`;
      document.body.appendChild(lb);
      document.getElementById('pd-lb-close').addEventListener('click', closeLightbox);
      document.getElementById('pd-lb-overlay').addEventListener('click', closeLightbox);
      document.getElementById('pd-lb-prev').addEventListener('click', () => lbNav(-1, urls));
      document.getElementById('pd-lb-next').addEventListener('click', () => lbNav(1, urls));
    }
    // Always refresh keydown listener so it captures the current urls closure
    document.removeEventListener('keydown', lbKeyHandler);
    document.addEventListener('keydown', lbKeyHandler);
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
    buildLbThumbs(urls);
    lbShow(_lbIdx, urls);
  }

  function closeLightbox() {
    _lightboxOpen = false;
    const lb = document.getElementById('pd-lightbox');
    if (lb) lb.classList.remove('open');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', lbKeyHandler);
  }

  function lbKeyHandler(e) {
    if (!_lightboxOpen) return;
    if (e.key === 'Escape')     closeLightbox();
    if (e.key === 'ArrowLeft')  lbNav(-1, _photos.map(p => p.url).filter(Boolean));
    if (e.key === 'ArrowRight') lbNav(1, _photos.map(p => p.url).filter(Boolean));
  }

  function lbNav(dir, urls) { lbShow((_lbIdx + dir + urls.length) % urls.length, urls); }

  function lbShow(idx, urls) {
    _lbIdx = idx;
    const img = document.getElementById('pd-lb-img');
    if (img) { img.style.opacity = '0'; setTimeout(() => { img.src = galleryPhotoUrl(urls[idx]); img.style.opacity = '1'; }, 100); }
    const counter = document.getElementById('pd-lb-counter');
    if (counter) counter.textContent = (idx + 1) + ' / ' + urls.length;
    document.querySelectorAll('.pd-lb-thumb').forEach((t, i) => t.classList.toggle('active', i === idx));
  }

  function buildLbThumbs(urls) {
    const el = document.getElementById('pd-lb-thumbs');
    if (!el) return;
    el.innerHTML = urls.map((u, i) =>
      `<button class="pd-lb-thumb" data-idx="${i}"><img src="${esc(thumbUrl(u))}" alt="" loading="lazy"></button>`
    ).join('');
    el.querySelectorAll('.pd-lb-thumb').forEach(btn =>
      btn.addEventListener('click', () => lbShow(parseInt(btn.dataset.idx), urls))
    );
  }

  // ── Map (Leaflet lazy-loaded) ────────────────────────────────────────────────
  function renderMap(p) {
    if (!p.lat || !p.lng) return '';
    return `<div class="pd-section">
      <div class="pd-section-title">Location</div>
      <div class="pd-map-wrap" id="pd-map-container" data-lat="${esc(String(p.lat))}" data-lng="${esc(String(p.lng))}" data-rent="${esc(String(p.monthly_rent||''))}">
        <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:.82rem">Loading map…</div>
      </div>
    </div>`;
  }

  function initMap() {
    const container = document.getElementById('pd-map-container');
    if (!container) return;
    const lat  = parseFloat(container.dataset.lat);
    const lng  = parseFloat(container.dataset.lng);
    const rent = container.dataset.rent;
    if (isNaN(lat) || isNaN(lng)) return;

    const load = () => {
      const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
      const LEAFLET_JS  = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
      if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
        const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = LEAFLET_CSS; link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
      }
      if (window.L) { _doInitMap(container, lat, lng, rent); return; }
      const script = document.createElement('script'); script.src = LEAFLET_JS; script.crossOrigin = 'anonymous';
      script.onload = () => _doInitMap(container, lat, lng, rent);
      document.head.appendChild(script);
    };

    const obs = new IntersectionObserver(entries => { if (entries[0].isIntersecting) { obs.disconnect(); load(); } }, { rootMargin: '200px' });
    obs.observe(container);
  }

  function _doInitMap(container, lat, lng, rent) {
    container.innerHTML = '<div id="pd-mini-map" style="width:100%;height:100%"></div>';
    const map = L.map('pd-mini-map', { zoomControl: true, scrollWheelZoom: false }).setView([lat, lng], 15);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO', maxZoom: 19
    }).addTo(map);
    const icon = L.divIcon({
      className: '',
      html: `<div style="background:#0e0e0f;color:white;padding:6px 12px;border-radius:20px;font-weight:700;font-size:12px;white-space:nowrap;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3)">${rent ? '$' + Number(rent).toLocaleString() + '/mo' : 'Rent TBD'}</div>`,
      iconAnchor: [45, 16], iconSize: [90, 32]
    });
    L.marker([lat, lng], { icon }).addTo(map).bindPopup(_prop ? `<b>${_prop.title}</b><br>${_prop.address}` : '');
  }

  // ── Full page render ─────────────────────────────────────────────────────────
  function render(p, apps, inqs) {
    _prop   = p;
    _photos = Array.isArray(p.property_photos)
      ? p.property_photos.slice().sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
      : [];

    const urls     = _photos.map(x => x.url).filter(Boolean);
    const landlord = p.landlords;

    // ── Gallery HTML ──
    const galleryHtml = renderGallery(_photos);

    // ── Header ──
    const headerHtml = `
      <div class="pd-header">
        <div class="pd-header-price">${p.monthly_rent != null ? '$' + Number(p.monthly_rent).toLocaleString() : 'TBD'}<span>/month</span></div>
        <h2 class="pd-header-title">${esc(p.title || 'Untitled')}</h2>
        <div class="pd-header-address"><i class="fas fa-map-marker-alt"></i> ${esc([p.address, p.city, p.state, p.zip].filter(Boolean).join(', ') || '—')}</div>
        ${landlord ? `<div class="pd-listed-by">Listed by <strong>${esc(landlord.business_name || landlord.contact_name || '—')}</strong></div>` : ''}
      </div>`;

    // ── Status + actions ──
    const statusHtml = `<div class="pd-section" style="margin-bottom:14px">
      <div class="pd-section-title">Status</div>
      ${renderStatusBar(p.status)}
    </div>`;

    const extraBadges = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
        ${p.property_type ? `<span class="pill pill-muted">${esc(capitalize(p.property_type))}</span>` : ''}
        ${p.featured ? '<span class="pill pill-warning">★ Featured</span>' : ''}
      </div>`;

    // ── Metrics strip ──
    const daysListed = p.created_at ? Math.floor((Date.now() - new Date(p.created_at).getTime()) / 86400000) : null;
    const metricsHtml = `<div class="pd-metrics-strip">
      <div class="pd-metric"><span class="pd-metric-val">${daysListed !== null ? daysListed : '—'}</span><span class="pd-metric-lbl">days listed</span></div>
      <div class="pd-metric"><span class="pd-metric-val" id="pd-metric-apps">—</span><span class="pd-metric-lbl">applications</span></div>
      <div class="pd-metric"><span class="pd-metric-val" id="pd-metric-inqs">—</span><span class="pd-metric-lbl">inquiries</span></div>
      <div class="pd-metric"><span class="pd-metric-val">${p.views_count != null ? Number(p.views_count).toLocaleString() : '—'}</span><span class="pd-metric-lbl">views</span></div>
    </div>`;

    const actionsHtml = `<div class="pd-actions">
      <button class="btn btn-primary btn-sm" id="pd-btn-edit"><i class="fas fa-pen-to-square"></i> Edit &amp; Upload</button>
      <button class="btn btn-ghost btn-sm" id="pd-btn-photos"><i class="fas fa-images"></i> ${_photos.length ? 'All photos ('+_photos.length+')' : 'Manage photos'}</button>
      <a class="btn btn-ghost btn-sm" href="/property.html?id=${esc(p.id)}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i> Public listing</a>
      <button class="btn btn-ghost btn-sm" id="pd-btn-duplicate" title="Clone this listing as a new draft"><i class="fas fa-copy"></i> Duplicate</button>
    </div>
    ${_lastSavedAt ? `<div id="pd-lastsaved" class="pd-lastsaved">Last saved ${_lastSavedAt}</div>` : ''}
    ${metricsHtml}`;

    // ── Key fields grid ──
    const fields = [
      { label:'Monthly rent',   value: fmtMoney(p.monthly_rent) },
      { label:'Security deposit', value: p.security_deposit ? fmtMoney(p.security_deposit) : '—' },
      { label:'Application fee', value: p.application_fee != null ? fmtMoney(p.application_fee) : '—' },
      { label:'Bedrooms',       value: p.bedrooms != null ? (p.bedrooms === 0 ? 'Studio' : p.bedrooms) : '—' },
      { label:'Bathrooms',      value: p.bathrooms != null ? p.bathrooms + (p.half_bathrooms ? ' + ½' : '') : '—' },
      { label:'Sq. footage',    value: p.square_footage ? Number(p.square_footage).toLocaleString() + ' sqft' : '—' },
      { label:'Type',           value: p.property_type ? capitalize(p.property_type) : '—' },
      { label:'Year built',     value: p.year_built || '—' },
      { label:'Floors',         value: p.floors || '—' },
      { label:'Available',      value: fmt(p.available_date) },
      { label:'Pets allowed',   value: p.pets_allowed ? 'Yes' : 'No' },
      { label:'Parking',        value: p.parking || 'No' },
      { label:'Laundry',        value: p.laundry_type || '—' },
      { label:'Heating',        value: p.heating_type || '—' },
      { label:'Cooling',        value: p.cooling_type || '—' },
      { label:'Smoking',        value: p.smoking_allowed != null ? (p.smoking_allowed ? 'Allowed' : 'Not allowed') : '—' },
      { label:'Garage spaces',  value: p.garage_spaces || '—' },
      { label:'Views',          value: p.views_count != null ? Number(p.views_count).toLocaleString() : '—' },
      { label:'Created',        value: fmt(p.created_at) },
      { label:'Updated',        value: fmt(p.updated_at) },
    ];
    const fieldsHtml = `<div class="pd-section">
      <div class="pd-section-title">Details</div>
      <div class="pd-grid">
        ${fields.map(f => `<div class="pd-field"><div class="pd-field-label">${f.label}</div><div class="pd-field-value">${esc(String(f.value))}</div></div>`).join('')}
      </div>
    </div>`;

    // ── Description ──
    const descHtml = p.description
      ? `<div class="pd-section">
          <div class="pd-section-title">Description</div>
          <div class="pd-desc">${esc(p.description)}</div>
        </div>`
      : '';

    // ── Amenities / Utilities / Lease tabs ──
    const amenities = Array.isArray(p.amenities) ? p.amenities : [];
    const appliances = Array.isArray(p.appliances) ? p.appliances : [];
    const flooring = Array.isArray(p.flooring) ? p.flooring : [];
    const leaseTerms = Array.isArray(p.lease_terms) ? p.lease_terms : [];

    const amenItems = [
      ...amenities.map(a => `<div class="pd-amenity-item"><i class="fas fa-circle-check"></i>${esc(a)}</div>`),
      ...appliances.map(a => `<div class="pd-amenity-item"><i class="fas fa-blender"></i>${esc(a)}</div>`),
      ...flooring.map(f => `<div class="pd-amenity-item"><i class="fas fa-layer-group"></i>${esc(f)}</div>`),
    ];

    const utilItems = [];
    if (Array.isArray(p.utilities_included) && p.utilities_included.length) {
      p.utilities_included.forEach(u => utilItems.push(`<div class="pd-amenity-item"><i class="fas fa-bolt"></i>${esc(u)} Included</div>`));
    }
    if (p.parking) utilItems.push(`<div class="pd-amenity-item"><i class="fas fa-car"></i>Parking: ${esc(p.parking)}</div>`);
    if (p.laundry_type) utilItems.push(`<div class="pd-amenity-item"><i class="fas fa-shirt"></i>Laundry: ${esc(p.laundry_type)}</div>`);
    if (p.heating_type) utilItems.push(`<div class="pd-amenity-item"><i class="fas fa-fire"></i>Heating: ${esc(p.heating_type)}</div>`);
    if (p.cooling_type) utilItems.push(`<div class="pd-amenity-item"><i class="fas fa-snowflake"></i>Cooling: ${esc(p.cooling_type)}</div>`);
    if (p.garage_spaces) utilItems.push(`<div class="pd-amenity-item"><i class="fas fa-car-side"></i>Parking Spaces: ${p.garage_spaces}</div>`);
    if (p.parking_fee) utilItems.push(`<div class="pd-amenity-item"><i class="fas fa-dollar-sign"></i>Parking Fee: $${Number(p.parking_fee).toLocaleString()}/mo</div>`);

    const leaseItems = [];
    if (leaseTerms.length) leaseItems.push(`<div class="pd-amenity-item"><i class="fas fa-file-contract"></i>${leaseTerms.map(esc).join(', ')}</div>`);
    if (p.minimum_lease_months) leaseItems.push(`<div class="pd-amenity-item"><i class="fas fa-calendar-check"></i>Min. Lease: ${p.minimum_lease_months} month${p.minimum_lease_months !== 1 ? 's' : ''}</div>`);
    if (p.security_deposit) leaseItems.push(`<div class="pd-amenity-item"><i class="fas fa-shield-alt"></i>Security Deposit: $${Number(p.security_deposit).toLocaleString()}</div>`);
    if (p.last_months_rent) leaseItems.push(`<div class="pd-amenity-item"><i class="fas fa-calendar-alt"></i>Last Month's Rent: $${Number(p.last_months_rent).toLocaleString()}</div>`);
    if (p.admin_fee) leaseItems.push(`<div class="pd-amenity-item"><i class="fas fa-receipt"></i>Admin/Move-in Fee: $${Number(p.admin_fee).toLocaleString()}</div>`);
    if (p.pet_deposit) leaseItems.push(`<div class="pd-amenity-item"><i class="fas fa-paw"></i>Pet Deposit: $${Number(p.pet_deposit).toLocaleString()}</div>`);
    if (p.pet_types_allowed?.length) leaseItems.push(`<div class="pd-amenity-item"><i class="fas fa-paw"></i>Pet Types: ${p.pet_types_allowed.map(esc).join(', ')}</div>`);
    if (p.pet_weight_limit) leaseItems.push(`<div class="pd-amenity-item"><i class="fas fa-weight-scale"></i>Pet Weight Limit: ${esc(String(p.pet_weight_limit))} lbs max</div>`);
    if (p.pet_details) leaseItems.push(`<div class="pd-amenity-item" style="grid-column:1/-1"><i class="fas fa-paw"></i><span><strong>Pet Policy:</strong> ${esc(p.pet_details)}</span></div>`);
    if (p.smoking_allowed != null) leaseItems.push(`<div class="pd-amenity-item"><i class="fas ${p.smoking_allowed ? 'fa-smoking' : 'fa-ban'}"></i>${p.smoking_allowed ? 'Smoking Permitted' : 'No Smoking'}</div>`);
    if (p.minimum_income_multiplier) leaseItems.push(`<div class="pd-amenity-item"><i class="fas fa-coins"></i>Min. Income: ${p.minimum_income_multiplier}× rent/mo</div>`);
    if (p.minimum_credit_score) leaseItems.push(`<div class="pd-amenity-item"><i class="fas fa-chart-line"></i>Min. Credit Score: ${p.minimum_credit_score}</div>`);
    if (p.move_in_special) leaseItems.push(`<div class="pd-amenity-item" style="grid-column:1/-1"><i class="fas fa-tag"></i><strong>Move-in Special:</strong> ${esc(p.move_in_special)}</div>`);
    if (p.showing_instructions) leaseItems.push(`<div class="pd-amenity-item" style="grid-column:1/-1"><i class="fas fa-key"></i><strong>Showings:</strong> ${esc(p.showing_instructions)}</div>`);

    const hasAmen  = amenItems.length > 0;
    const hasUtil  = utilItems.length > 0;
    const hasLease = leaseItems.length > 0;

    let tabsHtml = '';
    if (hasAmen || hasUtil || hasLease) {
      tabsHtml = `<div class="pd-section">
        <div class="pd-section-title">Features</div>
        <div class="pd-tabs" id="pd-tabs">
          ${hasAmen  ? '<button class="pd-tab active" data-panel="pd-panel-amen">Amenities</button>' : ''}
          ${hasUtil  ? '<button class="pd-tab' + (!hasAmen ? ' active' : '') + '" data-panel="pd-panel-util">Utilities</button>' : ''}
          ${hasLease ? '<button class="pd-tab' + (!hasAmen && !hasUtil ? ' active' : '') + '" data-panel="pd-panel-lease">Lease</button>' : ''}
        </div>
        ${hasAmen  ? `<div class="pd-panel${' active'}" id="pd-panel-amen"><div class="pd-amenity-grid">${amenItems.join('')}</div></div>` : ''}
        ${hasUtil  ? `<div class="pd-panel${!hasAmen ? ' active' : ''}" id="pd-panel-util"><div class="pd-amenity-grid">${utilItems.join('')}</div></div>` : ''}
        ${hasLease ? `<div class="pd-panel${!hasAmen && !hasUtil ? ' active' : ''}" id="pd-panel-lease"><div class="pd-amenity-grid">${leaseItems.join('')}</div></div>` : ''}
      </div>`;
    }

    // ── Watermark ──
    const wmPhotos = _photos.filter(ph => ph.watermark_status && ph.watermark_status !== 'applied');
    const unwmPhotos = _photos.filter(ph => !ph.watermark_status || ph.watermark_status === 'applied' || ph.watermark_status === 'unscanned');
    let wmHtml = '';
    if (_photos.length) {
      const flagged = wmPhotos.filter(ph => ph.watermark_status === 'watermark' || ph.watermark_status === 'branding').length;
      wmHtml = `<div class="pd-section">
        <div class="pd-section-title">Watermark scan</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          ${wmPhotos.length > 0
            ? (flagged > 0 ? `<span class="pill pill-warning">${flagged} photo${flagged===1?'':'s'} flagged</span>` : '<span class="pill pill-success">All clear</span>')
            : '<span class="pill pill-muted">Not scanned yet</span>'}
          <a class="btn btn-ghost btn-sm" href="/admin/watermark-review.html?property_id=${esc(propId)}" style="font-size:.72rem">Scan &amp; review</a>
          <button class="btn btn-ghost btn-sm" id="pd-btn-apply-wm" style="font-size:.72rem" title="Apply watermark to all photos via ImageKit">
            <i class="fas fa-droplet"></i> Apply watermark
          </button>
        </div>
      </div>`;
    }

    // ── Landlord ──
    let landlordHtml = '';
    if (landlord) {
      const name = landlord.business_name || landlord.contact_name || '—';
      landlordHtml = `<div class="pd-section">
        <div class="pd-section-title">Landlord</div>
        <div class="pd-landlord">
          <div class="pd-landlord-avatar">
            ${landlord.avatar_url
              ? `<img src="${esc(window.CONFIG && CONFIG.img ? CONFIG.img(landlord.avatar_url, 'avatar') : landlord.avatar_url)}" alt="${esc(name)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
              : initials(name)}
          </div>
          <div class="pd-landlord-info">
            <div class="pd-landlord-name">${esc(name)} ${landlord.verified ? '<span class="pill pill-success" style="font-size:.6rem;padding:2px 8px">Verified</span>' : ''}</div>
            ${landlord.tagline ? `<div class="pd-landlord-tagline">${esc(landlord.tagline)}</div>` : ''}
            <div class="pd-landlord-meta">
              <a href="/admin/landlords.html?id=${esc(landlord.id)}" style="font-size:.74rem;color:var(--brand)">View full profile →</a>
            </div>
          </div>
        </div>
      </div>`;
    }

    // ── Applications ──
    const appRows = apps.length
      ? apps.map(a => {
          const t = a.tenants || {};
          return `<tr>
            <td>${esc(t.full_name || t.name || '—')}</td>
            <td>${esc(t.email || '—')}</td>
            <td><span class="pill ${pillCls(a.status)}">${esc(a.status || '—')}</span></td>
            <td>${fmt(a.created_at)}</td>
            <td><a class="btn btn-ghost btn-sm" href="/admin/applications.html?id=${esc(a.id)}" style="font-size:.72rem">Open</a></td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="5" class="pd-empty-row">No applications for this property.</td></tr>';

    const appsTitleSuffix = apps.length === 25 ? `${apps.length}+ <a href="/admin/applications.html?property=${esc(propId)}" style="font-size:.72rem;color:var(--brand);font-weight:500">View all ↗</a>` : String(apps.length);
    const appsHtml = `<div class="pd-section" id="pd-apps-section">
      <div class="pd-section-title">Applications (${appsTitleSuffix})</div>
      <div style="overflow-x:auto"><table class="pd-table"><thead><tr>
        <th>Tenant</th><th>Email</th><th>Status</th><th>Submitted</th><th></th>
      </tr></thead><tbody>${appRows}</tbody></table></div>
    </div>`;

    // ── Inquiries ──
    const inqRows = inqs.length
      ? inqs.map(i =>
          `<tr class="pd-inq-row" style="cursor:pointer" data-msg="${esc(i.message||'')}" title="Click to read message">
            <td>${esc(i.name || '—')}</td>
            <td>${esc(i.email || '—')}</td>
            <td>${esc(i.phone || '—')}</td>
            <td>${fmt(i.created_at)}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--brand)">${i.message ? '💬 ' + esc(i.message.slice(0,60)) + (i.message.length > 60 ? '…' : '') : '—'}</td>
          </tr>`
        ).join('')
      : '<tr><td colspan="5" class="pd-empty-row">No inquiries yet.</td></tr>';

    const inqsTitleSuffix = inqs.length === 25 ? `${inqs.length}+` : String(inqs.length);
    const inqsHtml = `<div class="pd-section" id="pd-inqs-section">
      <div class="pd-section-title">Inquiries (${inqsTitleSuffix})</div>
      <div style="overflow-x:auto"><table class="pd-table"><thead><tr>
        <th>Name</th><th>Email</th><th>Phone</th><th>Date</th><th>Message (click to expand)</th>
      </tr></thead><tbody>${inqRows}</tbody></table></div>
    </div>`;

    // ── Virtual tour ──
    const vtHtml = p.virtual_tour_url
      ? `<div class="pd-section">
          <div class="pd-section-title">Virtual Tour</div>
          <a href="${esc(p.virtual_tour_url)}" class="btn btn-ghost btn-sm" target="_blank" rel="noopener">
            <i class="fas fa-vr-cardboard"></i> Open virtual tour ↗
          </a>
        </div>`
      : '';

    // ── Admin notes (read-only display, admin-only) ──
    const adminNotesHtml = p.admin_notes
      ? `<div class="pd-section" style="border-left:3px solid var(--brand);padding-left:12px">
          <div class="pd-section-title" style="color:var(--brand)"><i class="fas fa-note-sticky"></i> Admin Notes (internal)</div>
          <div class="pd-desc" style="font-style:italic;color:var(--muted)">${esc(p.admin_notes)}</div>
        </div>`
      : '';

    document.getElementById('pd-root').innerHTML =
      galleryHtml
      + headerHtml
      + statusHtml
      + extraBadges
      + actionsHtml
      + adminNotesHtml
      + fieldsHtml
      + descHtml
      + vtHtml
      + tabsHtml
      + renderMap(p)
      + landlordHtml
      + wmHtml
      + appsHtml
      + inqsHtml;

    // Update page subtitle
    const sub = document.querySelector('[data-page-sub]');
    if (sub) sub.textContent = p.title || 'Property detail';

    // ── Bind interactions ──
    bindGallery(urls);
    bindStatusToggle();
    initMap();

    // Tabs
    document.getElementById('pd-tabs')?.addEventListener('click', e => {
      const tab = e.target.closest('.pd-tab');
      if (!tab) return;
      document.querySelectorAll('.pd-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.pd-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = document.getElementById(tab.dataset.panel);
      if (panel) panel.classList.add('active');
    });

    // Edit button
    document.getElementById('pd-btn-edit')?.addEventListener('click', () => openEditPanel(p));

    // Manage photos button
    document.getElementById('pd-btn-photos')?.addEventListener('click', () => openPhotoManager());

    // Apply watermark button — calls imagekit-watermark edge fn for every photo without a confirmed-clean status
    document.getElementById('pd-btn-apply-wm')?.addEventListener('click', async () => {
      const btn = document.getElementById('pd-btn-apply-wm');
      if (!btn) return;
      const photosToWm = _photos.filter(ph => ph.url);
      if (!photosToWm.length) { S.toast('No photos to watermark.', 'info'); return; }
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Applying…';
      let ok = 0, fail = 0;
      const token = await CP.Auth.getAccessToken().catch(() => null);
      if (!token) { S.toast('Session expired — please sign in again.', 'error'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-droplet"></i> Apply watermark'; return; }
      for (const ph of photosToWm) {
        try {
          const resp = await fetch((window.CONFIG?.SUPABASE_URL || '') + '/functions/v1/imagekit-watermark', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': window.CONFIG?.SUPABASE_ANON_KEY || '', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ url: ph.url, file_id: ph.file_id || null, property_id: propId }),
          });
          if (resp.ok) ok++; else fail++;
        } catch (_) { fail++; }
      }
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-droplet"></i> Apply watermark';
      if (ok)   S.toast(`Watermark applied to ${ok} photo${ok===1?'':'s'}.`, 'success');
      if (fail) S.toast(`${fail} photo${fail===1?'':'s'} failed.`, 'error');
    });

    // Upload photos shortcut — opens photo manager focused on the upload zone
    document.getElementById('pd-btn-upload')?.addEventListener('click', () => openPhotoManager(true));

    // No-photo zone click → open photo manager for upload
    const noPhotoZone = document.getElementById('pd-no-photo-zone');
    if (noPhotoZone) {
      noPhotoZone.addEventListener('click', () => openPhotoManager(true));
      noPhotoZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPhotoManager(true); } });
    }

    // Duplicate property button
    document.getElementById('pd-btn-duplicate')?.addEventListener('click', async () => {
      const ok = await S.confirm({
        title: 'Duplicate this property?',
        message: 'Creates a new Draft copy of "' + (p.title || 'Untitled') + '" with all details but no photos.\nYou will be taken to the new listing.',
        ok: 'Duplicate',
        cancel: 'Cancel',
        danger: false,
      });
      if (!ok) return;
      const clone = {
        title: (p.title || 'Untitled') + ' (Copy)',
        address: p.address || null, city: p.city || null, state: p.state || null, zip: p.zip || null,
        county: p.county || null, neighborhood: p.neighborhood || null,
        location_context: p.location_context || null,
        unit_number: p.unit_number || null, property_type: p.property_type || null,
        bedrooms: p.bedrooms ?? null, bathrooms: p.bathrooms ?? null, half_bathrooms: p.half_bathrooms ?? null,
        square_footage: p.square_footage ?? null, lot_size_sqft: p.lot_size_sqft ?? null,
        year_built: p.year_built ?? null, floors: p.floors ?? null,
        has_basement: p.has_basement ?? null, has_central_air: p.has_central_air ?? null,
        monthly_rent: p.monthly_rent ?? null, security_deposit: p.security_deposit ?? null,
        application_fee: p.application_fee ?? null, admin_fee: p.admin_fee ?? null,
        last_months_rent: p.last_months_rent ?? null, minimum_lease_months: p.minimum_lease_months ?? null,
        minimum_income_multiplier: p.minimum_income_multiplier ?? null, minimum_credit_score: p.minimum_credit_score ?? null,
        available_date: null, description: p.description || null, virtual_tour_url: p.virtual_tour_url || null,
        amenities: Array.isArray(p.amenities) ? [...p.amenities] : [],
        appliances: Array.isArray(p.appliances) ? [...p.appliances] : [],
        flooring: Array.isArray(p.flooring) ? [...p.flooring] : [],
        utilities_included: Array.isArray(p.utilities_included) ? [...p.utilities_included] : [],
        lease_terms: Array.isArray(p.lease_terms) ? [...p.lease_terms] : [],
        parking: p.parking || null, garage_spaces: p.garage_spaces ?? null, parking_fee: p.parking_fee ?? null,
        laundry_type: p.laundry_type || null, heating_type: p.heating_type || null, cooling_type: p.cooling_type || null,
        pets_allowed: p.pets_allowed ?? null, pet_deposit: p.pet_deposit ?? null,
        pet_weight_limit: p.pet_weight_limit ?? null, pet_types_allowed: p.pet_types_allowed ?? [],
        pet_details: p.pet_details || null, smoking_allowed: p.smoking_allowed ?? null,
        showing_instructions: p.showing_instructions || null,
        lat: p.lat ?? null, lng: p.lng ?? null,
        landlord_id: p.landlord_id || null,
        status: 'draft',
      };
      const { data: nd, error: ne } = await CP.sb().from('properties').insert([clone]).select('id').single();
      if (ne) { S.toast('Duplicate failed: ' + ne.message, 'error'); return; }
      S.toast('Property duplicated — opening new draft…', 'success');
      // Audit log for duplicate (non-blocking)
      try {
        const { data: { session: _dupSess } } = await CP.Auth.getSession();
        CP.sb().from('admin_actions').insert([{
          user_id:     _dupSess?.user?.id || null,
          action:      'property.duplicate',
          target_type: 'property',
          target_id:   String(nd.id),
          metadata:    { source_id: propId, source_title: p.title || null, status: 'draft' }
        }]).catch(() => {});
      } catch (_) {}
      setTimeout(() => { location.href = '/admin/property-detail.html?id=' + encodeURIComponent(nd.id) + '&edit=1'; }, 700);
    });

    // Inquiry message expand (click row → modal dialog)
    document.querySelectorAll('.pd-inq-row').forEach(row => {
      row.addEventListener('click', () => {
        const msg = row.dataset.msg;
        if (!msg) return;
        const cells = row.querySelectorAll('td');
        const name  = cells[0] ? cells[0].textContent.trim() : 'Inquiry';
        const email = cells[1] ? cells[1].textContent.trim() : '';
        S.confirm({
          title:   name + (email && email !== '—' ? ' — ' + email : ''),
          message: msg,
          ok:      'Close',
          cancel:  '',
          danger:  false,
        });
      });
    });
  }

  // ── Edit panel ───────────────────────────────────────────────────────────────
  function openEditPanel(p) {
    const existing = document.getElementById('pd-edit-panel');
    if (existing) existing.remove();

    const PROPERTY_TYPE_OPTIONS = ['', 'apartment', 'house', 'condo', 'townhouse', 'studio', 'duplex', 'room', 'land'].map(v =>
      `<option value="${v}" ${p.property_type === v ? 'selected' : ''}>${v ? (v.charAt(0).toUpperCase() + v.slice(1)) : 'Select type…'}</option>`
    ).join('');

    const panel = document.createElement('div');
    panel.id = 'pd-edit-panel';
    panel.className = 'pd-edit-panel';
    panel.innerHTML = `
      <div class="pd-edit-overlay" id="pd-edit-overlay"></div>
      <div class="pd-edit-drawer">
        <div class="pd-edit-header">
          <h3>Edit Property</h3>
          <button class="pd-edit-close" id="pd-edit-close" aria-label="Close">✕</button>
        </div>
        <div class="pd-edit-body">
          <form id="pd-edit-form" autocomplete="off">

            <!-- ── Photos section ── -->
            <div class="pd-edit-group" id="pd-edit-photos-group">
              <div class="pd-edit-group-title">Photos <span id="pd-edit-photo-count" style="font-weight:400;color:var(--muted)">(${_photos.length})</span></div>
              <div id="pd-edit-thumbs" class="pd-edit-thumb-grid">
                ${_photos.length ? _photos.map((ph, i) => `<div class="pd-edit-thumb-item" data-photo-id="${esc(ph.id)}">
                  <img src="${esc(thumbUrl(ph.url))}" alt="Photo ${i+1}" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">
                  ${i === 0 ? '<span class="pd-cover-badge">Cover</span>' : ''}
                </div>`).join('') : '<div style="font-size:.78rem;color:var(--muted);padding:8px 2px">No photos yet — add some below.</div>'}
              </div>
              <div id="pd-edit-pending-zone" class="pd-edit-thumb-grid" style="margin-top:${_photos.length ? '8px' : '0'}"></div>
              <div style="display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap">
                <label class="btn btn-ghost btn-sm" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px">
                  <i class="fas fa-camera"></i> Add photos
                  <input type="file" id="pd-edit-file-input" accept="image/*" multiple style="display:none">
                </label>
                <span id="pd-edit-photo-status" style="font-size:.72rem;color:var(--brand);display:none"></span>
              </div>
            </div>

            <div class="pd-edit-group">
              <div class="pd-edit-group-title">Basic Information</div>
              <label class="pd-edit-label">Title <span style="color:#ef4444">*</span>
                <input class="pd-edit-input" name="title" type="text" value="${esc(p.title || '')}" required placeholder="2BR/1BA Apartment in Downtown">
              </label>
              <label class="pd-edit-label">Address <span style="color:#ef4444">*</span>
                <input class="pd-edit-input" name="address" type="text" value="${esc(p.address || '')}" required placeholder="123 Main St">
              </label>
              <div class="pd-edit-row">
                <label class="pd-edit-label">City <input class="pd-edit-input" name="city" type="text" value="${esc(p.city || '')}" placeholder="San Francisco"></label>
                <label class="pd-edit-label">State
                  <select class="pd-edit-input" name="state">
                    <option value="">—</option>
                    ${US_STATES.map(s => `<option value="${s}"${p.state===s?' selected':''}>${s}</option>`).join('')}
                  </select>
                </label>
                <label class="pd-edit-label">Zip <input class="pd-edit-input" name="zip" type="text" value="${esc(p.zip || '')}" placeholder="94101"></label>
              </div>
              <label class="pd-edit-label">Unit number
                <input class="pd-edit-input" name="unit_number" type="text" value="${esc(p.unit_number || '')}" placeholder="Apt 4B">
              </label>
              <div class="pd-edit-row">
                <label class="pd-edit-label">County
                  <input class="pd-edit-input" name="county" type="text" value="${esc(p.county || '')}" placeholder="Los Angeles County">
                </label>
                <label class="pd-edit-label">Neighborhood
                  <input class="pd-edit-input" name="neighborhood" type="text" value="${esc(p.neighborhood || '')}" placeholder="Silver Lake">
                </label>
              </div>
              <label class="pd-edit-label">Location context
                <input class="pd-edit-input" name="location_context" type="text" value="${esc(p.location_context || '')}" placeholder="Near downtown, 5 min walk to transit">
              </label>
              <label class="pd-edit-label">Status
                <span class="pd-edit-hint">Changes here override the inline status toggle</span>
                <select class="pd-edit-input" name="status">
                  ${['active','rented','inactive','maintenance','draft','paused','archived'].map(v =>
                    `<option value="${v}"${p.status===v?' selected':''}>${v.charAt(0).toUpperCase()+v.slice(1)}</option>`
                  ).join('')}
                </select>
              </label>
            </div>

            <div class="pd-edit-group">
              <div class="pd-edit-group-title">Property Details</div>
              <div class="pd-edit-row">
                <label class="pd-edit-label">Type
                  <select class="pd-edit-input" name="property_type">${PROPERTY_TYPE_OPTIONS}</select>
                </label>
                <label class="pd-edit-label">Year built
                  <input class="pd-edit-input" name="year_built" type="number" value="${esc(String(p.year_built || ''))}" placeholder="1995" min="1800" max="2030">
                </label>
                <label class="pd-edit-label">Floors
                  <input class="pd-edit-input" name="floors" type="number" value="${esc(String(p.floors || ''))}" placeholder="2" min="1">
                </label>
              </div>
              <div class="pd-edit-row">
                <label class="pd-edit-label">Bedrooms
                  <input class="pd-edit-input" name="bedrooms" type="number" value="${esc(String(p.bedrooms != null ? p.bedrooms : ''))}" placeholder="2" min="0">
                </label>
                <label class="pd-edit-label">Bathrooms
                  <input class="pd-edit-input" name="bathrooms" type="number" value="${esc(String(p.bathrooms != null ? p.bathrooms : ''))}" placeholder="1" min="0" step="0.5">
                </label>
                <label class="pd-edit-label">Half baths
                  <input class="pd-edit-input" name="half_bathrooms" type="number" value="${esc(String(p.half_bathrooms != null ? p.half_bathrooms : ''))}" placeholder="0" min="0">
                </label>
              </div>
              <div class="pd-edit-row">
                <label class="pd-edit-label">Square footage
                  <input class="pd-edit-input" name="square_footage" type="number" value="${esc(String(p.square_footage || ''))}" placeholder="850" min="0">
                </label>
                <label class="pd-edit-label">Lot size (sqft)
                  <input class="pd-edit-input" name="lot_size_sqft" type="number" value="${esc(String(p.lot_size_sqft || ''))}" placeholder="5000" min="0">
                </label>
              </div>
              <label class="pd-edit-label">Description
                <textarea class="pd-edit-input" name="description" rows="4" placeholder="Describe the property…" id="pd-desc-textarea" maxlength="5000">${esc(p.description || '')}</textarea>
                <span class="pd-char-counter" id="pd-desc-counter">${(p.description||'').length} / 5000</span>
              </label>
              <label class="pd-edit-label">Virtual tour URL
                <input class="pd-edit-input" name="virtual_tour_url" type="url" value="${esc(p.virtual_tour_url || '')}" placeholder="https://…">
              </label>
            </div>

            <div class="pd-edit-group">
              <div class="pd-edit-group-title">Pricing & Availability</div>
              <div class="pd-edit-row">
                <label class="pd-edit-label">Monthly rent ($)
                  <input class="pd-edit-input" name="monthly_rent" type="number" value="${esc(String(p.monthly_rent || ''))}" placeholder="1500" min="0">
                </label>
                <label class="pd-edit-label">Security deposit ($)
                  <input class="pd-edit-input" name="security_deposit" type="number" value="${esc(String(p.security_deposit || ''))}" placeholder="1500" min="0">
                </label>
              </div>
              <div class="pd-edit-row">
                <label class="pd-edit-label">Application fee ($)
                  <input class="pd-edit-input" name="application_fee" type="number" value="${esc(String(p.application_fee != null ? p.application_fee : ''))}" placeholder="50" min="0">
                </label>
                <label class="pd-edit-label">Admin/move-in fee ($)
                  <input class="pd-edit-input" name="admin_fee" type="number" value="${esc(String(p.admin_fee || ''))}" placeholder="0" min="0">
                </label>
                <label class="pd-edit-label">Last month rent ($)
                  <input class="pd-edit-input" name="last_months_rent" type="number" value="${esc(String(p.last_months_rent || ''))}" placeholder="0" min="0">
                </label>
              </div>
              <div class="pd-edit-row">
                <label class="pd-edit-label">Available date
                  <input class="pd-edit-input" name="available_date" type="date" value="${esc(p.available_date ? p.available_date.split('T')[0] : '')}">
                </label>
                <label class="pd-edit-label">Min. lease (months)
                  <input class="pd-edit-input" name="minimum_lease_months" type="number" value="${esc(String(p.minimum_lease_months || ''))}" placeholder="12" min="1">
                </label>
              </div>
              <div class="pd-edit-row">
                <label class="pd-edit-label">Min. income multiplier
                  <span class="pd-edit-hint">e.g. 3 = tenant must earn 3× monthly rent</span>
                  <input class="pd-edit-input" name="minimum_income_multiplier" type="number" value="${esc(String(p.minimum_income_multiplier || ''))}" placeholder="3" min="1" max="10" step="0.5">
                </label>
                <label class="pd-edit-label">Min. credit score
                  <input class="pd-edit-input" name="minimum_credit_score" type="number" value="${esc(String(p.minimum_credit_score || ''))}" placeholder="620" min="300" max="850">
                </label>
              </div>
              <label class="pd-edit-label">Move-in special
                <input class="pd-edit-input" name="move_in_special" type="text" value="${esc(p.move_in_special || '')}" placeholder="First month free!">
              </label>
            </div>

            <div class="pd-edit-group">
              <div class="pd-edit-group-title">Amenities & Features</div>
              <label class="pd-edit-label">Amenities <span class="pd-edit-hint">check all that apply, add others below</span>
                ${_tagPicker('amenities', AMENITY_OPTIONS, p.amenities)}
              </label>
              <label class="pd-edit-label">Appliances
                ${_tagPicker('appliances', APPLIANCE_OPTIONS, p.appliances)}
              </label>
              <label class="pd-edit-label">Flooring
                ${_tagPicker('flooring', FLOORING_OPTIONS, p.flooring)}
              </label>
              <label class="pd-edit-label">Utilities included
                ${_tagPicker('utilities_included', UTILITY_OPTIONS, p.utilities_included)}
              </label>
              <div class="pd-edit-row">
                <label class="pd-edit-label">Parking type
                  ${_makeSelect('parking', PARKING_TYPE_OPTIONS, p.parking || '')}
                </label>
                <label class="pd-edit-label">Garage spaces
                  <input class="pd-edit-input" name="garage_spaces" type="number" value="${esc(String(p.garage_spaces || ''))}" placeholder="1" min="0">
                </label>
                <label class="pd-edit-label">Parking fee ($)
                  <input class="pd-edit-input" name="parking_fee" type="number" value="${esc(String(p.parking_fee || ''))}" placeholder="0" min="0">
                </label>
              </div>
              <div class="pd-edit-row">
                <label class="pd-edit-label">Laundry
                  ${_makeSelect('laundry_type', LAUNDRY_OPTIONS, p.laundry_type || '')}
                </label>
                <label class="pd-edit-label">Heating
                  ${_makeSelect('heating_type', HEATING_OPTIONS, p.heating_type || '')}
                </label>
                <label class="pd-edit-label">Cooling
                  ${_makeSelect('cooling_type', COOLING_OPTIONS, p.cooling_type || '')}
                </label>
              </div>
              <div class="pd-edit-row">
                <label class="pd-edit-label">Basement
                  <select class="pd-edit-input" name="has_basement">
                    <option value="" ${p.has_basement === null || p.has_basement === undefined ? 'selected' : ''}>—</option>
                    <option value="true"  ${p.has_basement === true  ? 'selected' : ''}>Yes</option>
                    <option value="false" ${p.has_basement === false ? 'selected' : ''}>No</option>
                  </select>
                </label>
                <label class="pd-edit-label">Central air
                  <select class="pd-edit-input" name="has_central_air">
                    <option value="" ${p.has_central_air === null || p.has_central_air === undefined ? 'selected' : ''}>—</option>
                    <option value="true"  ${p.has_central_air === true  ? 'selected' : ''}>Yes</option>
                    <option value="false" ${p.has_central_air === false ? 'selected' : ''}>No</option>
                  </select>
                </label>
              </div>
              <label class="pd-edit-label">Lease terms <span class="pd-edit-hint">comma-separated</span>
                <input class="pd-edit-input" name="lease_terms" type="text" value="${esc((Array.isArray(p.lease_terms) ? p.lease_terms : []).join(', '))}" placeholder="Month-to-month, 12-month">
              </label>
            </div>

            <div class="pd-edit-group">
              <div class="pd-edit-group-title">Pet Policy</div>
              <div class="pd-edit-row">
                <label class="pd-edit-label">Pets allowed
                  <select class="pd-edit-input" name="pets_allowed">
                    <option value="" ${p.pets_allowed === null ? 'selected' : ''}>—</option>
                    <option value="true"  ${p.pets_allowed === true  ? 'selected' : ''}>Yes</option>
                    <option value="false" ${p.pets_allowed === false ? 'selected' : ''}>No</option>
                  </select>
                </label>
                <label class="pd-edit-label">Pet deposit ($)
                  <input class="pd-edit-input" name="pet_deposit" type="number" value="${esc(String(p.pet_deposit || ''))}" placeholder="500" min="0">
                </label>
                <label class="pd-edit-label">Weight limit (lbs)
                  <input class="pd-edit-input" name="pet_weight_limit" type="number" value="${esc(String(p.pet_weight_limit || ''))}" placeholder="50" min="0">
                </label>
              </div>
              <label class="pd-edit-label">Pet types allowed <span class="pd-edit-hint">comma-separated</span>
                <input class="pd-edit-input" name="pet_types_allowed" type="text" value="${esc((Array.isArray(p.pet_types_allowed) ? p.pet_types_allowed : []).join(', '))}" placeholder="Dogs, Cats">
              </label>
              <label class="pd-edit-label">Pet policy details
                <textarea class="pd-edit-input" name="pet_details" rows="2" placeholder="Additional pet policy details…">${esc(p.pet_details || '')}</textarea>
              </label>
            </div>

            <div class="pd-edit-group">
              <div class="pd-edit-group-title">Other</div>
              <div class="pd-edit-row">
                <label class="pd-edit-label">Smoking
                  <select class="pd-edit-input" name="smoking_allowed">
                    <option value="" ${p.smoking_allowed === null ? 'selected' : ''}>—</option>
                    <option value="true"  ${p.smoking_allowed === true  ? 'selected' : ''}>Allowed</option>
                    <option value="false" ${p.smoking_allowed === false ? 'selected' : ''}>Not allowed</option>
                  </select>
                </label>
                <label class="pd-edit-label">Featured
                  <select class="pd-edit-input" name="featured">
                    <option value="false" ${!p.featured ? 'selected' : ''}>No</option>
                    <option value="true"  ${p.featured ? 'selected' : ''}>Yes</option>
                  </select>
                </label>
              </div>
              <label class="pd-edit-label">Showing instructions
                <textarea class="pd-edit-input" name="showing_instructions" rows="2" placeholder="Contact landlord to schedule…">${esc(p.showing_instructions || '')}</textarea>
              </label>
              <label class="pd-edit-label">Admin notes <span class="pd-edit-hint">Internal only — never shown to landlords or tenants</span>
                <textarea class="pd-edit-input" name="admin_notes" rows="3" placeholder="Internal memo, flags, follow-up reminders…" id="pd-admin-notes-ta">${esc(p.admin_notes || '')}</textarea>
              </label>
              <div class="pd-edit-row">
                <label class="pd-edit-label">Latitude
                  <input class="pd-edit-input" name="lat" type="number" value="${esc(String(p.lat || ''))}" placeholder="37.7749" step="any">
                </label>
                <label class="pd-edit-label">Longitude
                  <input class="pd-edit-input" name="lng" type="number" value="${esc(String(p.lng || ''))}" placeholder="-122.4194" step="any">
                </label>
              </div>
              <button type="button" id="pd-geocode-btn" class="btn btn-ghost btn-sm" style="margin-top:4px;align-self:flex-start">
                <i class="fas fa-location-dot"></i> Get coords from address
              </button>
            </div>

            <div class="pd-edit-group">
              <div class="pd-edit-group-title">Landlord Assignment</div>
              <label class="pd-edit-label">Assigned landlord
                <span class="pd-edit-hint">Change which landlord manages this property</span>
                <input type="text" id="pd-landlord-search" class="pd-edit-input" placeholder="Search landlords…"
                  style="margin-bottom:6px" autocomplete="off">
                <select class="pd-edit-input" name="landlord_id" id="pd-landlord-select" size="4"
                  style="height:auto;min-height:80px">
                  <option value="${esc(String(p.landlord_id || ''))}">Loading landlords…</option>
                </select>
              </label>
            </div>

          </form>
        </div>
        <div class="pd-edit-footer">
          <button class="btn btn-ghost" id="pd-edit-cancel">Cancel</button>
          <button class="btn btn-primary" id="pd-edit-save">
            <i class="fas fa-check"></i> Save changes
          </button>
        </div>
      </div>`;

    document.body.appendChild(panel);

    // Insert autosave toast badge if not present
    if (!document.getElementById('pd-autosave-badge')) {
      const badge = document.createElement('div');
      badge.id = 'pd-autosave-badge';
      badge.textContent = 'Draft auto-saved';
      document.body.appendChild(badge);
    }

    requestAnimationFrame(() => panel.classList.add('open'));

    // ── Swipe-to-dismiss: drag down > 100px to close ──
    let _swipeY0 = 0;
    panel.addEventListener('touchstart', e => { _swipeY0 = e.touches[0].clientY; }, { passive: true });
    panel.addEventListener('touchmove', e => {
      const dy = e.touches[0].clientY - _swipeY0;
      if (dy > 0) panel.style.transform = `translateY(${Math.min(dy, 260)}px)`;
    }, { passive: true });
    panel.addEventListener('touchend', e => {
      const dy = e.changedTouches[0].clientY - _swipeY0;
      panel.style.transform = '';
      if (dy > 100) {
        panel.classList.remove('open');
        setTimeout(() => { if (panel.parentNode) panel.parentNode.removeChild(panel); }, 300);
        // stopAutosave inline — no separate function needed
        clearInterval(_autosaveTimer); _autosaveTimer = null; _formDirty = false;
      }
    }, { passive: true });

    // ── Store original snapshot for diff audit log ──
    _editOriginal = JSON.parse(JSON.stringify(_prop || {}));
    _formDirty = false;

    function _markDirty() {
      if (_formDirty) return;
      _formDirty = true;
      const h3 = panel.querySelector('.pd-edit-header h3');
      if (h3 && !h3.querySelector('.pd-dirty-dot')) {
        const dot = document.createElement('span');
        dot.className = 'pd-dirty-dot';
        dot.title = 'Unsaved changes';
        h3.appendChild(dot);
      }
    }

    // Mark dirty on any input change
    panel.querySelector('#pd-edit-form')?.addEventListener('input', _markDirty);
    panel.querySelector('#pd-edit-form')?.addEventListener('change', _markDirty);

    // ── Description character counter ──
    const descTA = document.getElementById('pd-desc-textarea');
    const descCtr = document.getElementById('pd-desc-counter');
    if (descTA && descCtr) {
      descTA.addEventListener('input', () => {
        const len = descTA.value.length;
        descCtr.textContent = len + ' / 5000';
        descCtr.classList.toggle('over', len > 4800);
      });
    }

    // ── sessionStorage autosave every 30 s (per-tab, avoids multi-tab collisions) ──
    const _autoKey = 'pd_draft_' + propId;
    if (_autosaveTimer) clearInterval(_autosaveTimer);
    _autosaveTimer = setInterval(() => {
      const form = document.getElementById('pd-edit-form');
      if (!form || !_formDirty) return;
      try {
        const fd = new FormData(form);
        const snap = {};
        for (const [k, v] of fd.entries()) snap[k] = v;
        // Capture tag picker states — checkboxes have no `name` so FormData misses them
        for (const [tn, opts] of [['amenities', AMENITY_OPTIONS], ['appliances', APPLIANCE_OPTIONS], ['flooring', FLOORING_OPTIONS], ['utilities_included', UTILITY_OPTIONS]]) {
          snap['_tags_' + tn] = _readTags(form, tn, opts);
        }
        sessionStorage.setItem(_autoKey, JSON.stringify({ ts: Date.now(), data: snap }));
        const badge = document.getElementById('pd-autosave-badge');
        if (badge) {
          badge.classList.add('show');
          setTimeout(() => badge.classList.remove('show'), 2000);
        }
      } catch (e) { /* storage unavailable */ }
    }, 30_000);

    // Check for a saved draft (sessionStorage is per-tab — no cross-tab collision)
    try {
      const saved = JSON.parse(sessionStorage.getItem(_autoKey) || 'null');
      if (saved && saved.ts && Date.now() - saved.ts < 24 * 3600_000) {
        const form = document.getElementById('pd-edit-form');
        if (form) {
          for (const [k, v] of Object.entries(saved.data || {})) {
            const el = form.elements[k];
            if (el && el.type !== 'checkbox') el.value = v;
          }
          // Restore tag picker checkboxes and any custom "other" values
          for (const [tn, opts] of [['amenities', AMENITY_OPTIONS], ['appliances', APPLIANCE_OPTIONS], ['flooring', FLOORING_OPTIONS], ['utilities_included', UTILITY_OPTIONS]]) {
            const vals = new Set(saved.data['_tags_' + tn] || []);
            form.querySelectorAll(`[data-tag="${tn}"]`).forEach(cb => { cb.checked = vals.has(cb.value); });
            // Repopulate the "other" text input with non-standard values from _tags_*
            const otherEl = form.elements[tn + '_other'];
            if (otherEl) {
              const custom = [...vals].filter(v => !opts.includes(v));
              if (custom.length) otherEl.value = custom.join(', ');
            }
          }
          _markDirty();
          S.toast('Draft restored from auto-save', 'success');
        }
      }
    } catch (e) { /* ignore */ }

    const _guardedClose = async () => {
      if (_formDirty) {
        const leave = await S.confirm({
          title: 'Discard changes?',
          message: 'You have unsaved changes. Leave without saving?',
          ok: 'Discard',
          cancel: 'Keep editing',
          danger: true,
        });
        if (!leave) return;
      }
      clearInterval(_autosaveTimer);
      _autosaveTimer = null;
      _formDirty = false;
      panel.classList.remove('open');
      setTimeout(() => panel.remove(), 300);
    };

    document.getElementById('pd-edit-close').addEventListener('click', _guardedClose);
    document.getElementById('pd-edit-cancel').addEventListener('click', _guardedClose);
    document.getElementById('pd-edit-overlay').addEventListener('click', _guardedClose);
    document.getElementById('pd-edit-save').addEventListener('click', () => saveEdit(() => {
      clearInterval(_autosaveTimer);
      _autosaveTimer = null;
      _formDirty = false;
      try { sessionStorage.removeItem('pd_draft_' + propId); } catch(e) {}
      panel.classList.remove('open');
      setTimeout(() => panel.remove(), 300);
    }));

    // ── Geocode button ──
    document.getElementById('pd-geocode-btn').addEventListener('click', async () => {
      const form = document.getElementById('pd-edit-form');
      const addr = [
        form.elements.address.value,
        form.elements.city.value,
        form.elements.state.value,
        form.elements.zip.value
      ].filter(Boolean).join(', ');
      if (!addr) { S.toast('Enter an address first', 'error'); return; }
      const apiKey = window.CONFIG && CONFIG.GEOAPIFY_API_KEY;
      if (!apiKey) { S.toast('Geocoding not configured', 'error'); return; }
      const btn = document.getElementById('pd-geocode-btn');
      btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Looking up…';
      try {
        const res = await fetch(`https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(addr)}&limit=1&apiKey=${encodeURIComponent(apiKey)}`);
        const json = await res.json();
        const feat = json && json.features && json.features[0];
        if (!feat) { S.toast('Address not found', 'error'); return; }
        const lat = feat.geometry.coordinates[1];
        const lng = feat.geometry.coordinates[0];
        form.elements.lat.value = lat.toFixed(6);
        form.elements.lng.value = lng.toFixed(6);
        S.toast('Coordinates updated!', 'success');
        // Audit log (non-blocking)
        CP.Auth.getSession().then(({ data }) => {
          CP.sb().from('admin_actions').insert([{
            user_id:     data?.session?.user?.id || null,
            action:      'property.geocode',
            target_type: 'property',
            target_id:   String(propId),
            metadata:    { lat, lng, address: addr, method: 'manual_button' }
          }]).catch(() => {});
        }).catch(() => {});
      } catch (err) {
        S.toast('Geocode failed: ' + (err.message || err), 'error');
      } finally {
        btn.disabled = false; btn.innerHTML = '<i class="fas fa-location-dot"></i> Get coords from address';
      }
    });

    // ── Photo upload wiring (inside edit panel) ──
    _editPendingPhotos.clear();
    const _editFileInput   = document.getElementById('pd-edit-file-input');
    const _editPendingZone = document.getElementById('pd-edit-pending-zone');
    const _editPhotoStatus = document.getElementById('pd-edit-photo-status');

    function _addEditPendingFile(file) {
      if (!file.type.startsWith('image/')) return;
      if (['image/heic', 'image/heif'].includes(file.type.toLowerCase()) || /\.heic$/i.test(file.name)) {
        S.toast(`"${file.name}" is HEIC format. Convert to JPG or PNG first.`, 'error'); return;
      }
      if (file.size > 10 * 1024 * 1024) { S.toast('"' + file.name + '" exceeds 10 MB.', 'error'); return; }
      for (const f of _editPendingPhotos.values()) {
        if (f.name === file.name && f.size === file.size) return;
      }
      const sid = 'ep' + Date.now() + Math.random().toString(36).slice(2, 6);
      _editPendingPhotos.set(sid, file);

      const item = document.createElement('div');
      item.className = 'pd-edit-thumb-item pd-edit-thumb-pending';
      item.dataset.pendingSid = sid;
      item.style.cssText = 'position:relative;overflow:hidden;border-radius:6px;background:var(--surface-2);border:2px dashed var(--brand)';
      item.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;z-index:2">
        <i class="fas fa-clock" style="font-size:.9rem;color:var(--brand)"></i>
        <span style="font-size:.6rem;color:var(--muted);text-align:center;padding:0 4px;word-break:break-all">${esc(file.name.length > 18 ? file.name.slice(0, 15) + '…' : file.name)}</span>
        <button type="button" data-remove-sid="${sid}" style="font-size:.6rem;padding:1px 6px;border-radius:3px;background:rgba(220,38,38,.85);color:#fff;border:none;cursor:pointer">Remove</button>
      </div>`;
      const reader = new FileReader();
      reader.onload = ev => {
        const img = document.createElement('img');
        img.src = ev.target.result; img.alt = 'Preview';
        img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.35;z-index:1';
        item.insertBefore(img, item.firstChild);
      };
      reader.readAsDataURL(file);
      _editPendingZone?.appendChild(item);
      if (_editPhotoStatus) { _editPhotoStatus.style.display = ''; _editPhotoStatus.textContent = _editPendingPhotos.size + ' new photo' + (_editPendingPhotos.size > 1 ? 's' : '') + ' queued'; }
    }

    _editFileInput?.addEventListener('change', e => {
      [...e.target.files].forEach(_addEditPendingFile);
      _editFileInput.value = '';
    });

    _editPendingZone?.addEventListener('click', e => {
      const btn = e.target.closest('[data-remove-sid]');
      if (!btn) return;
      const sid = btn.dataset.removeSid;
      _editPendingPhotos.delete(sid);
      _editPendingZone.querySelector(`[data-pending-sid="${sid}"]`)?.remove();
      if (_editPhotoStatus) {
        _editPhotoStatus.textContent = _editPendingPhotos.size > 0 ? _editPendingPhotos.size + ' new photo' + (_editPendingPhotos.size > 1 ? 's' : '') + ' queued' : '';
        _editPhotoStatus.style.display = _editPendingPhotos.size > 0 ? '' : 'none';
      }
    });

    // ── Populate landlord dropdown with live search filter ──
    function _populateLandlordSel(rows, filter) {
      const sel = document.getElementById('pd-landlord-select');
      if (!sel) return;
      const q = (filter || '').toLowerCase().trim();
      const visible = q ? rows.filter(l => {
        const name = (l.business_name || l.contact_name || '').toLowerCase();
        return name.includes(q) || String(l.id).includes(q);
      }) : rows;
      sel.innerHTML = '<option value="">— Unassigned —</option>' +
        visible.map(l => {
          const label = esc(l.business_name || l.contact_name || l.id);
          const selected = l.id === p.landlord_id ? ' selected' : '';
          return `<option value="${esc(l.id)}"${selected}>${label}</option>`;
        }).join('');
      // Re-select current landlord if still visible
      if (p.landlord_id) {
        const cur = sel.querySelector(`option[value="${esc(String(p.landlord_id))}"]`);
        if (cur) cur.selected = true;
      }
    }
    function _initLandlordSearch(rows) {
      _populateLandlordSel(rows);
      const search = document.getElementById('pd-landlord-search');
      if (search) {
        search.addEventListener('input', () => _populateLandlordSel(rows, search.value));
      }
    }
    if (_landlordCache) {
      _initLandlordSearch(_landlordCache);
    } else {
      CP.sb().rpc('admin_list_landlords', { p_page: 0, p_per_page: 200 }).then(({ data, error }) => {
        if (error || !data) {
          const sel = document.getElementById('pd-landlord-select');
          if (sel) sel.innerHTML = '<option value="">— Could not load landlords —</option>';
          return;
        }
        _landlordCache = data.rows || [];
        _initLandlordSearch(_landlordCache);
      }).catch(() => {
        const sel = document.getElementById('pd-landlord-select');
        if (sel) sel.innerHTML = '<option value="">— Could not load landlords —</option>';
      });
    }
  }

  async function saveEdit(closePanel) {
    const form = document.getElementById('pd-edit-form');
    if (!form) return;
    const fd = new FormData(form);
    const get = (k) => (fd.get(k) || '').trim();
    const getNum = (k) => { const v = get(k); return v !== '' ? Number(v) : null; };
    const getArr = (k) => { const v = get(k); return v ? v.split(',').map(s => s.trim()).filter(Boolean) : []; };
    const getBool = (k) => { const v = get(k); return v === 'true' ? true : v === 'false' ? false : null; };

    if (!get('title') || !get('address')) {
      S.toast('Title and address are required', 'error'); return;
    }

    // ── Coordinate validation ──
    const latVal = getNum('lat');
    const lngVal = getNum('lng');
    if (latVal !== null && (latVal < -90 || latVal > 90)) {
      S.toast('Latitude must be between −90 and 90', 'error'); return;
    }
    if (lngVal !== null && (lngVal < -180 || lngVal > 180)) {
      S.toast('Longitude must be between −180 and 180', 'error'); return;
    }

    // ── Virtual tour URL validation ──
    const vtUrl = get('virtual_tour_url');
    if (vtUrl) {
      try { new URL(vtUrl); } catch (_) {
        S.toast('Virtual tour URL is not a valid URL (must start with https://)', 'error'); return;
      }
      if (!vtUrl.startsWith('http://') && !vtUrl.startsWith('https://')) {
        S.toast('Virtual tour URL must start with http:// or https://', 'error'); return;
      }
    }

    const saveBtn = document.getElementById('pd-edit-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

    // ── Upload any photos queued in the edit panel ──
    if (_editPendingPhotos.size > 0) {
      const statusEl = document.getElementById('pd-edit-photo-status');
      if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Uploading photos…'; }
      if (saveBtn) saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading…';

      const entries = [..._editPendingPhotos.entries()];
      const baseOrder = _photos.length ? Math.max(..._photos.map(ph => ph.display_order ?? 0)) + 1 : 0;
      let uploadedCnt = 0;

      for (let i = 0; i < entries.length; i++) {
        const [, file] = entries[i];
        if (statusEl) statusEl.textContent = `Uploading photo ${i + 1} of ${entries.length}…`;
        try {
          const result = await _uploadAdminPhoto(file, propId, () => {});
          const { data: newPhotoRows } = await CP.sb()
            .rpc('add_property_photo', { p_property_id: propId, p_url: result.url, p_file_id: result.fileId || null });
          const newPhoto = newPhotoRows && newPhotoRows[0];
          if (newPhoto) { _photos.push(newPhoto); uploadedCnt++; }
        } catch (uploadErr) {
          S.toast('Photo upload failed: ' + (uploadErr.message || uploadErr), 'error');
        }
        // Brief pause between uploads to avoid CDN rate limiting
        if (i < entries.length - 1) await new Promise(r => setTimeout(r, 400));
      }

      _editPendingPhotos.clear();
      if (statusEl) { statusEl.textContent = uploadedCnt > 0 ? `${uploadedCnt} photo${uploadedCnt > 1 ? 's' : ''} uploaded!` : ''; }
      if (saveBtn) saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';
    }

    // ── Auto-geocode if address filled but no coords yet ──
    let resolvedLat = latVal, resolvedLng = lngVal;
    if (resolvedLat === null && resolvedLng === null && get('address')) {
      const apiKey = window.CONFIG && CONFIG.GEOAPIFY_API_KEY;
      if (apiKey) {
        try {
          const addr = [get('address'), get('city'), get('state'), get('zip')].filter(Boolean).join(', ');
          const res = await fetch(`https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(addr)}&limit=1&apiKey=${encodeURIComponent(apiKey)}`);
          const json = await res.json();
          const feat = json && json.features && json.features[0];
          if (feat) {
            resolvedLat = parseFloat(feat.geometry.coordinates[1].toFixed(6));
            resolvedLng = parseFloat(feat.geometry.coordinates[0].toFixed(6));
            // Update form fields so user sees the result
            if (form.elements.lat) form.elements.lat.value = resolvedLat;
            if (form.elements.lng) form.elements.lng.value = resolvedLng;
          }
        } catch (e) { /* geocode failure is non-fatal */ }
      }
    }

    const patch = {
      title:              get('title'),
      status:             get('status') || _prop.status || 'active',
      address:            get('address'),
      city:               get('city') || null,
      state:              get('state') || null,
      zip:                get('zip') || null,
      unit_number:        get('unit_number') || null,
      property_type:      get('property_type') || null,
      year_built:         getNum('year_built'),
      floors:             getNum('floors'),
      bedrooms:           getNum('bedrooms'),
      bathrooms:          getNum('bathrooms'),
      half_bathrooms:     getNum('half_bathrooms'),
      square_footage:     getNum('square_footage'),
      lot_size_sqft:      getNum('lot_size_sqft'),
      description:        get('description') || null,
      county:             get('county') || null,
      neighborhood:       get('neighborhood') || null,
      location_context:   get('location_context') || null,
      has_basement:       getBool('has_basement'),
      has_central_air:    getBool('has_central_air'),
      virtual_tour_url:   get('virtual_tour_url') || null,
      monthly_rent:       getNum('monthly_rent'),
      security_deposit:   getNum('security_deposit'),
      application_fee:    getNum('application_fee'),
      admin_fee:          getNum('admin_fee'),
      last_months_rent:   getNum('last_months_rent'),
      available_date:     get('available_date') || null,
      minimum_lease_months:        getNum('minimum_lease_months'),
      minimum_income_multiplier:   getNum('minimum_income_multiplier'),
      minimum_credit_score:        getNum('minimum_credit_score'),
      move_in_special:             get('move_in_special') || null,
      amenities:          _readTags(form, 'amenities', AMENITY_OPTIONS),
      appliances:         _readTags(form, 'appliances', APPLIANCE_OPTIONS),
      flooring:           _readTags(form, 'flooring', FLOORING_OPTIONS),
      utilities_included: _readTags(form, 'utilities_included', UTILITY_OPTIONS),
      parking:            get('parking') || null,
      garage_spaces:      getNum('garage_spaces'),
      parking_fee:        getNum('parking_fee'),
      laundry_type:       get('laundry_type') || null,
      heating_type:       get('heating_type') || null,
      cooling_type:       get('cooling_type') || null,
      lease_terms:        getArr('lease_terms'),
      pets_allowed:       getBool('pets_allowed'),
      pet_deposit:        getNum('pet_deposit'),
      pet_weight_limit:   getNum('pet_weight_limit'),
      pet_types_allowed:  getArr('pet_types_allowed'),
      pet_details:        get('pet_details') || null,
      smoking_allowed:    getBool('smoking_allowed'),
      showing_instructions: get('showing_instructions') || null,
      admin_notes:        get('admin_notes') || null,
      featured:           getBool('featured') ?? false,
      lat:                resolvedLat,
      lng:                resolvedLng,
      landlord_id:        get('landlord_id') || null,
      updated_at:         new Date().toISOString(),
    };

    const { error } = await CP.sb().from('properties').update(patch).eq('id', propId);

    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-check"></i> Save changes'; }

    if (error) { S.toast('Save failed: ' + error.message, 'error'); return; }

    S.toast('Property saved!', 'success');
    _lastSavedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const lsi = document.getElementById('pd-lastsaved');
    if (lsi) lsi.textContent = 'Last saved ' + _lastSavedAt;

    // Refresh the inline status toggle if status changed
    if (patch.status && patch.status !== _prop.status) {
      _prop.status = patch.status;
      const toggle = document.getElementById('pd-status-toggle');
      if (toggle) { toggle.outerHTML = renderStatusBar(patch.status); bindStatusToggle(); }
    }

    closePanel();

    // ── Real-diff audit log (non-blocking) ──
    CP.Auth.getSession().then(({ data }) => {
      const uid = data?.session?.user?.id || null;
      const orig = _editOriginal || {};
      const changes = {};
      const skip = new Set(['updated_at']);
      for (const [k, v] of Object.entries(patch)) {
        if (skip.has(k)) continue;
        const oldV = orig[k];
        const newV = v;
        const oldS = JSON.stringify(oldV ?? null);
        const newS = JSON.stringify(newV ?? null);
        if (oldS !== newS) changes[k] = { from: oldV ?? null, to: newV ?? null };
      }
      if (Object.keys(changes).length) {
        CP.sb().from('admin_actions').insert([{
          user_id: uid,
          action: 'property.edit',
          target_type: 'property',
          target_id: String(propId),
          metadata: { title: patch.title, changes, updated_at: patch.updated_at }
        }]).catch(() => {});
      }
    }).catch(() => {});

    // Reload page data
    const { data } = await CP.sb()
      .from('properties')
      .select('*, landlords(id,user_id,business_name,contact_name,avatar_url,tagline,verified), property_photos(id,url,display_order,watermark_status,file_id)')
      .eq('id', propId)
      .single();
    if (data) {
      const [appsRes, inqsRes] = await Promise.all([
        CP.sb().from('applications').select('id,status,created_at,tenants(full_name,name,email)').eq('property_id', propId).order('created_at',{ascending:false}).limit(25),
        CP.sb().from('inquiries').select('id,created_at,name,email,phone,message').eq('property_id', propId).order('created_at',{ascending:false}).limit(25)
      ]);
      render(data, appsRes.data || [], inqsRes.data || []);
    }
  }

  // ── Admin photo upload helpers ────────────────────────────────────────────────
  // Mirrors imagekit.js logic — inline here because property-detail.js is a
  // non-module IIFE and cannot use ES-module imports.
  async function _compressPhoto(file, maxPx = 2048, quality = 0.85) {
    let bmp;
    try { bmp = await createImageBitmap(file); }
    catch {
      if (file.size > 4 * 1024 * 1024)
        throw new Error(`"${file.name}" is too large (${(file.size / 1048576).toFixed(1)} MB). Use a smaller image.`);
      return file;
    }
    const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width  = Math.round(bmp.width  * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    return new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('Compression failed')), 'image/jpeg', quality)
    );
  }

  function _blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = () => res(r.result);
      r.onerror = () => rej(new Error('Failed to read file'));
      r.readAsDataURL(blob);
    });
  }

  async function _uploadAdminPhoto(file, pid, onProgress) {
    if (!window.CONFIG?.SUPABASE_URL || !window.CONFIG?.SUPABASE_ANON_KEY)
      throw new Error('Upload service not configured');
    const { data: { session } } = await CP.sb().auth.getSession();
    if (!session?.access_token) throw new Error('Session expired — please log back in');
    const userToken = session.access_token;
    onProgress?.(5);
    const compressed = await _compressPhoto(file);
    onProgress?.(20);
    const base64 = await _blobToBase64(compressed);
    onProgress?.(35);
    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const folder   = `/properties/${pid}`;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(40 + Math.round((e.loaded / e.total) * 45));
      };
      xhr.onload = () => {
        onProgress?.(100);
        let d; try { d = JSON.parse(xhr.responseText); } catch { d = {}; }
        if (d.success) resolve({ url: d.url, fileId: d.fileId ?? null });
        else reject(new Error(d.error || `Upload failed (HTTP ${xhr.status})`));
      };
      xhr.onerror   = () => reject(new Error('Network error — check your connection'));
      xhr.ontimeout = () => reject(new Error('Upload timed out — please try again'));
      xhr.timeout   = 55_000;
      xhr.open('POST', `${CONFIG.SUPABASE_URL}/functions/v1/imagekit-upload`);
      xhr.setRequestHeader('apikey',        CONFIG.SUPABASE_ANON_KEY);
      xhr.setRequestHeader('Authorization', `Bearer ${userToken}`);
      xhr.setRequestHeader('Content-Type',  'application/json');
      xhr.send(JSON.stringify({ fileData: base64, fileName: safeName, folder }));
    });
  }

  // ── Incremental apps/inqs update (after deferred fetch) ─────────────────────
  function _updateAppsInqs(apps, inqs) {
    // Update metrics strip counters
    const metricApps = document.getElementById('pd-metric-apps');
    const metricInqs = document.getElementById('pd-metric-inqs');
    if (metricApps && apps !== null) {
      metricApps.textContent = apps.length === 25 ? '25+' : String(apps.length);
    }
    if (metricInqs && inqs !== null) {
      metricInqs.textContent = inqs.length === 25 ? '25+' : String(inqs.length);
    }

    const appsSection = document.getElementById('pd-apps-section');
    const inqsSection = document.getElementById('pd-inqs-section');

    if (appsSection && apps !== null) {
      const appRows = apps.length
        ? apps.map(a => {
            const t = a.tenants || {};
            return `<tr>
              <td>${esc(t.full_name || t.name || '—')}</td>
              <td>${esc(t.email || '—')}</td>
              <td><span class="pill ${pillCls(a.status)}">${esc(a.status || '—')}</span></td>
              <td>${fmt(a.created_at)}</td>
              <td><a class="btn btn-ghost btn-sm" href="/admin/applications.html?id=${esc(a.id)}" style="font-size:.72rem">Open</a></td>
            </tr>`;
          }).join('')
        : '<tr><td colspan="5" class="pd-empty-row">No applications for this property.</td></tr>';
      const suffix = apps.length === 25
        ? `${apps.length}+ <a href="/admin/applications.html?property=${esc(propId)}" style="font-size:.72rem;color:var(--brand);font-weight:500">View all ↗</a>`
        : String(apps.length);
      appsSection.innerHTML = `<div class="pd-section-title">Applications (${suffix})</div>
        <div style="overflow-x:auto"><table class="pd-table"><thead><tr>
          <th>Tenant</th><th>Email</th><th>Status</th><th>Submitted</th><th></th>
        </tr></thead><tbody>${appRows}</tbody></table></div>`;
    }

    if (inqsSection && inqs !== null) {
      const inqRows = inqs.length
        ? inqs.map(i =>
            `<tr class="pd-inq-row" style="cursor:pointer" data-msg="${esc(i.message||'')}" title="Click to read message">
              <td>${esc(i.name || '—')}</td>
              <td>${esc(i.email || '—')}</td>
              <td>${esc(i.phone || '—')}</td>
              <td>${fmt(i.created_at)}</td>
              <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--brand)">${i.message ? '💬 ' + esc(i.message.slice(0,60)) + (i.message.length > 60 ? '…' : '') : '—'}</td>
            </tr>`
          ).join('')
        : '<tr><td colspan="5" class="pd-empty-row">No inquiries yet.</td></tr>';
      const inqSuffix = inqs.length === 25 ? `${inqs.length}+` : String(inqs.length);
      inqsSection.innerHTML = `<div class="pd-section-title">Inquiries (${inqSuffix})</div>
        <div style="overflow-x:auto"><table class="pd-table"><thead><tr>
          <th>Name</th><th>Email</th><th>Phone</th><th>Date</th><th>Message (click to expand)</th>
        </tr></thead><tbody>${inqRows}</tbody></table></div>`;
      inqsSection.querySelectorAll('.pd-inq-row').forEach(row => {
        row.addEventListener('click', () => {
          const msg = row.dataset.msg;
          if (!msg) return;
          const cells = row.querySelectorAll('td');
          const name  = cells[0] ? cells[0].textContent.trim() : 'Inquiry';
          const email = cells[1] ? cells[1].textContent.trim() : '';
          S.confirm({ title: name + (email && email !== '—' ? ' — ' + email : ''), message: msg, ok: 'Close', cancel: '', danger: false });
        });
      });
    }
  }

  // ── Photo manager ────────────────────────────────────────────────────────────
  function openPhotoManager(focusUpload) {
    const existing = document.getElementById('pd-photo-manager');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'pd-photo-manager';
    panel.className = 'pd-edit-panel';
    panel.innerHTML = `
      <div class="pd-edit-overlay" id="pd-pm-overlay"></div>
      <div class="pd-edit-drawer">
        <div class="pd-edit-header">
          <h3>Manage Photos</h3>
          <button class="pd-edit-close" id="pd-pm-close" aria-label="Close">✕</button>
        </div>
        <div class="pd-edit-body">
          <p class="pd-pm-hint"><i class="fas fa-grip-dots-vertical"></i> Drag to reorder &middot; First photo is the cover image.</p>
          <div class="pd-pm-grid" id="pd-pm-grid">
            ${_photos.map((ph, i) => `
              <div class="pd-pm-item" data-photo-id="${esc(String(ph.id || ''))}" data-url="${esc(ph.url || '')}" draggable="true">
                <div class="pd-pm-handle" title="Drag (or touch the handle) to reorder"><i class="fas fa-grip-vertical"></i></div>
                <img src="${esc(thumbUrl(ph.url || ''))}" alt="Photo ${i + 1}" loading="lazy">
                <div class="pd-pm-order">${i + 1}</div>
                ${ph.watermark_status && ph.watermark_status !== 'applied' ? '<div class="pd-pm-badge">⚠</div>' : ''}
                <button class="pd-pm-cover-btn${i === 0 ? ' is-cover' : ''}" data-set-cover="${esc(String(ph.id || ''))}" title="${i === 0 ? 'Cover photo' : 'Set as cover'}">${i === 0 ? '★ Cover' : 'Set cover'}</button>
                <button class="pd-pm-delete" data-photo-id="${esc(String(ph.id || ''))}" data-file-id="${esc(String(ph.file_id || ''))}" title="Delete photo" aria-label="Delete photo">
                  <i class="fas fa-trash"></i>
                </button>
              </div>`).join('')}
          </div>
          ${!_photos.length ? '<div class="pd-empty-row" style="text-align:center;padding:24px 16px">No photos yet — add some below.</div>' : ''}

          <div class="pd-pm-upload-zone" id="pd-pm-upload-zone">
            <input type="file" id="pd-pm-file-input" accept="image/jpeg,image/png,image/webp,image/*" multiple>
            <i class="fas fa-cloud-upload-alt"></i>
            <strong>Add photos</strong>
            <p>JPG, PNG or WEBP &middot; max 10 MB each &middot; drop files here or click to browse</p>
          </div>

          <div class="pd-pm-upload-progress" id="pd-pm-upload-progress">
            <div class="pd-pm-upload-progress-row">
              <span id="pd-pm-upload-text">Uploading…</span>
              <span id="pd-pm-upload-pct">0%</span>
            </div>
            <div class="pd-pm-upload-bar-wrap">
              <div class="pd-pm-upload-bar" id="pd-pm-upload-bar"></div>
            </div>
          </div>

          <div class="pd-pm-grid" id="pd-pm-pending-grid" style="margin-top:10px"></div>
        </div>
        <div class="pd-edit-footer">
          <button class="btn btn-ghost" id="pd-pm-cancel">Cancel</button>
          <button class="btn btn-primary" id="pd-pm-save">
            <i class="fas fa-check"></i> Save
          </button>
        </div>
      </div>`;

    document.body.appendChild(panel);
    requestAnimationFrame(() => {
      panel.classList.add('open');
      if (focusUpload) {
        setTimeout(() => {
          const zone = document.getElementById('pd-pm-upload-zone');
          if (zone) zone.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Trigger file picker on mobile for direct upload
          const fi = document.getElementById('pd-pm-file-input');
          if (fi && window.innerWidth < 768) fi.click();
        }, 350);
      }
    });

    const closePanel = () => { panel.classList.remove('open'); setTimeout(() => panel.remove(), 300); };
    document.getElementById('pd-pm-close').addEventListener('click', closePanel);
    document.getElementById('pd-pm-cancel').addEventListener('click', closePanel);
    document.getElementById('pd-pm-overlay').addEventListener('click', closePanel);

    // ── Delete existing photos ────────────────────────────────────────────────
    panel.addEventListener('click', async e => {
      const btn = e.target.closest('.pd-pm-delete[data-photo-id]');
      if (!btn) return;
      const id     = btn.dataset.photoId;
      const fileId = btn.dataset.fileId || null;
      if (!id) return;
      const ok = await S.confirm({ title: 'Delete this photo?', message: 'This cannot be undone.', ok: 'Delete', cancel: 'Cancel', danger: true });
      if (!ok) return;
      const { error } = await CP.sb().from('property_photos').delete().eq('id', id);
      if (error) { S.toast('Delete failed: ' + error.message, 'error'); return; }
      _photos = _photos.filter(ph => String(ph.id) !== String(id));
      const item = btn.closest('.pd-pm-item');
      if (item) item.remove();
      refreshOrderBadges();
      refreshGalleryInPlace();
      S.toast('Photo deleted', 'success');
      // Best-effort CDN cleanup (fire-and-forget, never surfaced to user)
      if (fileId && window.CONFIG?.SUPABASE_URL && window.CONFIG?.SUPABASE_ANON_KEY) {
        CP.sb().auth.getSession().then(({ data: { session } }) => {
          if (!session?.access_token) return;
          fetch(`${CONFIG.SUPABASE_URL}/functions/v1/imagekit-delete`, {
            method: 'POST',
            headers: {
              'Content-Type':  'application/json',
              'apikey':        CONFIG.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ fileId }),
          }).catch(() => {});
        }).catch(() => {});
      }
      // Audit log (non-blocking)
      CP.Auth.getSession().then(({ data }) => {
        CP.sb().from('admin_actions').insert([{
          user_id:     data?.session?.user?.id || null,
          action:      'property.photo_delete',
          target_type: 'property',
          target_id:   String(propId),
          metadata:    { photo_id: String(id) }
        }]).catch(() => {});
      }).catch(() => {});
    });

    // ── Set as cover (move to position 0) ────────────────────────────────────
    panel.addEventListener('click', e => {
      const btn = e.target.closest('[data-set-cover]');
      if (!btn || btn.classList.contains('is-cover')) return;
      const id = btn.dataset.setCover;
      const grid = document.getElementById('pd-pm-grid');
      const item = grid?.querySelector(`[data-photo-id="${id}"]`);
      if (!item || !grid) return;
      grid.insertBefore(item, grid.firstChild);
      refreshOrderBadges();
      // Update cover button states
      grid.querySelectorAll('.pd-pm-cover-btn').forEach((cb, idx) => {
        cb.classList.toggle('is-cover', idx === 0);
        cb.textContent = idx === 0 ? '★ Cover' : 'Set cover';
        cb.title = idx === 0 ? 'Cover photo' : 'Set as cover';
      });
      S.toast('Cover photo updated — tap Save to confirm', 'success');
    });

    bindDragToReorder(document.getElementById('pd-pm-grid'));

    // ── Upload zone ───────────────────────────────────────────────────────────
    const fileInput   = document.getElementById('pd-pm-file-input');
    const uploadZone  = document.getElementById('pd-pm-upload-zone');
    const pendingGrid = document.getElementById('pd-pm-pending-grid');
    const uploadProg  = document.getElementById('pd-pm-upload-progress');
    const uploadBar   = document.getElementById('pd-pm-upload-bar');
    const uploadText  = document.getElementById('pd-pm-upload-text');
    const uploadPct   = document.getElementById('pd-pm-upload-pct');

    // Map of safeId → File, preserving insertion order
    const _pendingMap = new Map();
    let _uploading    = false;

    function _addPendingFile(file) {
      if (['image/heic', 'image/heif'].includes(file.type.toLowerCase()) || /\.heic$/i.test(file.name)) {
        S.toast(`"${file.name}" is HEIC format. Convert to JPG first.`, 'error'); return;
      }
      if (file.size > 10 * 1024 * 1024) {
        S.toast(`"${file.name}" exceeds the 10 MB limit.`, 'error'); return;
      }
      // Deduplicate by name+size
      for (const f of _pendingMap.values()) {
        if (f.name === file.name && f.size === file.size) return;
      }
      const sid  = `pp${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      _pendingMap.set(sid, file);

      const item = document.createElement('div');
      item.className = 'pd-pm-uploading-item';
      item.dataset.pendingId = sid;
      item.innerHTML = `
        <div class="pd-pm-uploading-overlay" id="pd-pm-ovl-${sid}">
          <i class="fas fa-clock" style="color:rgba(255,255,255,.8)"></i>
          <span style="color:#fff;font-size:.72rem;text-align:center;max-width:110px;word-break:break-word">${esc(file.name.length > 22 ? file.name.slice(0, 19) + '…' : file.name)}</span>
          <button data-remove-pending="${sid}" style="padding:2px 10px;border-radius:4px;font-size:.7rem;background:rgba(220,38,38,.85);color:#fff;border:none;cursor:pointer;margin-top:2px">Remove</button>
        </div>`;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = document.createElement('img');
        img.src = ev.target.result; img.alt = 'Preview';
        img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.35';
        item.insertBefore(img, item.firstChild);
      };
      reader.readAsDataURL(file);
      pendingGrid.appendChild(item);
    }

    // Remove a pending file
    pendingGrid.addEventListener('click', e => {
      const btn = e.target.closest('[data-remove-pending]');
      if (!btn || _uploading) return;
      const sid = btn.dataset.removePending;
      _pendingMap.delete(sid);
      pendingGrid.querySelector(`[data-pending-id="${sid}"]`)?.remove();
    });

    fileInput.addEventListener('change', e => {
      [...e.target.files].forEach(_addPendingFile);
      fileInput.value = '';
    });
    uploadZone.addEventListener('dragover',  e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
    uploadZone.addEventListener('drop', e => {
      e.preventDefault(); uploadZone.classList.remove('drag-over');
      [...e.dataTransfer.files].forEach(_addPendingFile);
    });

    // ── Save / Upload handler ─────────────────────────────────────────────────
    async function _onSave() {
      if (_uploading) return;
      if (!_pendingMap.size) { savePhotoOrder(closePanel); return; }

      _uploading = true;
      const saveBtn = document.getElementById('pd-pm-save');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading…'; }
      uploadProg.style.display = '';

      const entries  = [..._pendingMap.entries()]; // [[sid, File], …]
      const total    = entries.length;
      let successCnt = 0;

      // Sequential uploads — one at a time to avoid CDN rate limits
      const baseOrder = _photos.length ? Math.max(..._photos.map(ph => ph.display_order ?? 0)) + 1 : 0;
      for (let idx = 0; idx < total; idx++) {
        const [sid, file] = entries[idx];
        const itemEl = pendingGrid.querySelector(`[data-pending-id="${sid}"]`);
        const ovlEl  = document.getElementById(`pd-pm-ovl-${sid}`);
        if (ovlEl) ovlEl.innerHTML = '<i class="fas fa-spinner fa-spin" style="color:var(--brand)"></i><span style="color:#fff;font-size:.72rem">Uploading…</span>';
        const pctBase = Math.round((idx / total) * 100);
        uploadBar.style.width = pctBase + '%';
        uploadPct.textContent = pctBase + '%';
        uploadText.textContent = `Uploading ${idx + 1} of ${total}…`;
        try {
          const result = await _uploadAdminPhoto(file, propId, (pct) => {
            const overall = Math.round(((idx + pct / 100) / total) * 100);
            uploadBar.style.width = overall + '%';
            uploadPct.textContent = overall + '%';
          });
          const { error: insErr } = await CP.sb()
            .rpc('add_property_photo', { p_property_id: propId, p_url: result.url, p_file_id: result.fileId || null });
          if (insErr) throw new Error(insErr.message);
          successCnt++;
          if (ovlEl) ovlEl.innerHTML = '<i class="fas fa-check-circle" style="color:#4ade80"></i><span style="color:#fff;font-size:.72rem">Uploaded</span>';
          if (itemEl) itemEl.style.borderColor = 'rgba(34,197,94,.6)';
        } catch (err) {
          const msg = String(err?.message || err).slice(0, 80);
          if (ovlEl) ovlEl.innerHTML = `<i class="fas fa-times-circle" style="color:#f87171"></i><span style="color:#f87171;font-size:.7rem">Failed</span><span style="color:rgba(255,255,255,.7);font-size:.64rem;text-align:center;max-width:110px;word-break:break-word">${esc(msg)}</span>`;
          if (itemEl) itemEl.classList.add('error');
        }
        // Small pause between uploads to avoid CDN rate limiting
        if (idx < total - 1) await new Promise(r => setTimeout(r, 400));
      }

      uploadBar.style.width = '100%';
      uploadPct.textContent = '100%';
      _uploading = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-check"></i> Save'; }

      if (successCnt > 0) {
        S.toast(`${successCnt} photo${successCnt > 1 ? 's' : ''} uploaded!`, 'success');
        // Audit log (non-blocking)
        CP.Auth.getSession().then(({ data }) => {
          CP.sb().from('admin_actions').insert([{
            user_id:     data?.session?.user?.id || null,
            action:      'property.photo_upload',
            target_type: 'property',
            target_id:   String(propId),
            metadata:    { count: successCnt }
          }]).catch(() => {});
        }).catch(() => {});
        // Brief pause so user sees the Done state, then save order + close
        setTimeout(() => { uploadProg.style.display = 'none'; savePhotoOrder(closePanel); }, 900);
      } else {
        S.toast('All uploads failed — see errors above.', 'error');
        uploadProg.style.display = 'none';
      }
    }

    document.getElementById('pd-pm-save').addEventListener('click', _onSave);
  }

  function refreshOrderBadges() {
    document.querySelectorAll('#pd-pm-grid .pd-pm-item').forEach((item, i) => {
      const badge = item.querySelector('.pd-pm-order');
      if (badge) badge.textContent = i + 1;
    });
  }

  function bindDragToReorder(grid) {
    if (!grid) return;
    let dragItem = null;
    let dragOver = null;

    // ── Mouse drag ──
    grid.addEventListener('dragstart', e => {
      dragItem = e.target.closest('.pd-pm-item');
      if (dragItem) { dragItem.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; }
    });
    grid.addEventListener('dragend', () => {
      if (dragItem) dragItem.classList.remove('dragging');
      if (dragOver) dragOver.classList.remove('drag-over');
      dragItem = null; dragOver = null;
    });
    grid.addEventListener('dragover', e => {
      e.preventDefault();
      const target = e.target.closest('.pd-pm-item');
      if (!target || target === dragItem) return;
      if (dragOver && dragOver !== target) dragOver.classList.remove('drag-over');
      dragOver = target;
      dragOver.classList.add('drag-over');
      const rect = target.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2 || e.clientX > rect.left + rect.width / 2;
      if (after) { grid.insertBefore(dragItem, target.nextSibling); }
      else        { grid.insertBefore(dragItem, target); }
      refreshOrderBadges();
    });
    grid.addEventListener('dragleave', e => {
      if (dragOver && !grid.contains(e.relatedTarget)) dragOver.classList.remove('drag-over');
    });
    grid.addEventListener('drop', e => {
      e.preventDefault();
      if (dragOver) dragOver.classList.remove('drag-over');
    });

    // ── Touch drag (mobile) ──
    let touchItem = null;
    let touchClone = null;

    function _touchItem(e) {
      const item = e.target.closest('.pd-pm-item');
      if (!item) return;
      // Only start drag on handle touch or long-press simulation
      touchItem = item;
      touchItem.classList.add('dragging');
      touchClone = touchItem.cloneNode(true);
      touchClone.style.cssText = 'position:fixed;opacity:.7;pointer-events:none;z-index:99999;width:' + touchItem.offsetWidth + 'px;height:' + touchItem.offsetHeight + 'px;border-radius:8px;border:2px solid var(--brand)';
      document.body.appendChild(touchClone);
      const rect = touchItem.getBoundingClientRect();
      const touch = e.touches[0];
      const offsetX = touch.clientX - rect.left;
      const offsetY = touch.clientY - rect.top;
      touchClone._ox = offsetX;
      touchClone._oy = offsetY;
      _moveTouchClone(touch);
    }

    function _moveTouchClone(touch) {
      if (!touchClone) return;
      touchClone.style.left = (touch.clientX - touchClone._ox) + 'px';
      touchClone.style.top  = (touch.clientY - touchClone._oy) + 'px';
    }

    grid.addEventListener('touchstart', e => {
      const handle = e.target.closest('.pd-pm-handle');
      if (!handle) return;
      e.preventDefault();
      _touchItem(e);
    }, { passive: false });

    grid.addEventListener('touchmove', e => {
      if (!touchItem) return;
      e.preventDefault();
      const touch = e.touches[0];
      _moveTouchClone(touch);
      touchClone.style.display = 'none';
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      touchClone.style.display = '';
      const target = el && el.closest('.pd-pm-item');
      if (target && target !== touchItem) {
        const rect = target.getBoundingClientRect();
        const after = touch.clientY > rect.top + rect.height / 2 || touch.clientX > rect.left + rect.width / 2;
        if (after) { grid.insertBefore(touchItem, target.nextSibling); }
        else        { grid.insertBefore(touchItem, target); }
        refreshOrderBadges();
      }
    }, { passive: false });

    grid.addEventListener('touchend', () => {
      if (touchItem) { touchItem.classList.remove('dragging'); touchItem = null; }
      if (touchClone) { touchClone.remove(); touchClone = null; }
    });
  }

  async function savePhotoOrder(closePanel) {
    const items = document.querySelectorAll('#pd-pm-grid .pd-pm-item');
    if (!items.length) { closePanel(); return; }

    const saveBtn = document.getElementById('pd-pm-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

    // ── Batch upsert: single DB call instead of N individual UPDATEs ──
    const updates = Array.from(items)
      .map((item, i) => ({ id: item.dataset.photoId, display_order: i }))
      .filter(u => u.id);

    const { error } = await CP.sb()
      .from('property_photos')
      .upsert(updates, { onConflict: 'id' });

    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-check"></i> Save order'; }

    if (error) { S.toast('Failed to save order: ' + error.message, 'error'); return; }

    S.toast('Photo order saved!', 'success');
    // Audit log (non-blocking)
    CP.Auth.getSession().then(({ data }) => {
      CP.sb().from('admin_actions').insert([{
        user_id:     data?.session?.user?.id || null,
        action:      'property.photo_reorder',
        target_type: 'property',
        target_id:   String(propId),
        metadata:    { count: updates.length }
      }]).catch(() => {});
    }).catch(() => {});
    closePanel();
    // Reload page
    const { data } = await CP.sb()
      .from('properties')
      .select('*, landlords(id,user_id,business_name,contact_name,avatar_url,tagline,verified), property_photos(id,url,display_order,watermark_status,file_id)')
      .eq('id', propId).single();
    if (data) {
      const [appsRes, inqsRes] = await Promise.all([
        CP.sb().from('applications').select('id,status,created_at,tenants(full_name,name,email)').eq('property_id', propId).order('created_at',{ascending:false}).limit(25),
        CP.sb().from('inquiries').select('id,created_at,name,email,phone,message').eq('property_id', propId).order('created_at',{ascending:false}).limit(25)
      ]);
      render(data, appsRes.data || [], inqsRes.data || []);
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    try { await waitReady(8000); }
    catch (e) {
      document.getElementById('pd-root').innerHTML =
        '<div class="empty"><h3>Could not load admin tools</h3><p>' + String(e.message) + '</p></div>';
      return;
    }
    S = window.AdminShell;

    if (!propId) {
      document.getElementById('pd-root').innerHTML =
        '<div class="empty"><h3>No property ID</h3><p>Open this page from the Properties list.</p></div>';
      return;
    }

    const ok = await S.requireAdmin();
    if (!ok) {
      document.getElementById('pd-root').innerHTML =
        '<div class="empty"><h3>Access denied</h3><p>You don\'t have admin access, or your session expired.</p>' +
        '<a href="/admin/login.html" class="btn btn-primary" style="margin-top:14px">Sign in as admin</a></div>';
      return;
    }

    // Phase 1: load property first for fast first paint
    const propRes = await CP.sb()
      .from('properties')
      .select('*, landlords(id,user_id,business_name,contact_name,avatar_url,tagline,verified), property_photos(id,url,display_order,watermark_status,file_id)')
      .eq('id', propId)
      .single();

    if (propRes.error || !propRes.data) {
      document.getElementById('pd-root').innerHTML =
        `<div class="empty"><h3>Property not found</h3><p>${S.esc((propRes.error || {}).message || 'No data returned.')}</p></div>`;
      return;
    }

    // Render immediately with empty apps/inqs (shows loading placeholders)
    try {
      render(propRes.data, [], []);
    } catch (renderErr) {
      document.getElementById('pd-root').innerHTML =
        `<div class="empty"><h3>Render error</h3><p>${String(renderErr && renderErr.message || renderErr)}</p></div>`;
      console.error('property-detail render error:', renderErr);
      return;
    }

    // Phase 2: fetch apps & inquiries in the background
    const _loadAppsInqs = async () => {
      try {
        const [appsRes, inqsRes] = await Promise.all([
          CP.sb()
            .from('applications')
            .select('id,status,created_at,tenants(full_name,name,email)')
            .eq('property_id', propId)
            .order('created_at', { ascending: false })
            .limit(25),
          CP.sb()
            .from('inquiries')
            .select('id,created_at,name,email,phone,message')
            .eq('property_id', propId)
            .order('created_at', { ascending: false })
            .limit(25)
        ]);
        _updateAppsInqs(appsRes.data || [], inqsRes.data || []);
      } catch (e) {
        // Show error state rather than leaving the sections in "loading" state forever
        const s1 = document.getElementById('pd-apps-section');
        const s2 = document.getElementById('pd-inqs-section');
        if (s1) s1.innerHTML = '<div class="pd-section-title">Applications</div><div class="pd-empty-row" style="color:var(--muted)">Could not load applications — refresh to retry.</div>';
        if (s2) s2.innerHTML = '<div class="pd-section-title">Inquiries</div><div class="pd-empty-row" style="color:var(--muted)">Could not load inquiries — refresh to retry.</div>';
      }
    };
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(_loadAppsInqs, { timeout: 3000 });
    } else {
      setTimeout(_loadAppsInqs, 300);
    }

    // Auto-open edit panel if ?edit=1 in URL
    if (params.get('edit') === '1') {
      openEditPanel(propRes.data);
      // Clean up URL so refresh doesn't re-open
      const cleanUrl = location.pathname + '?id=' + encodeURIComponent(propId);
      history.replaceState(null, '', cleanUrl);
    }
  });
})();
