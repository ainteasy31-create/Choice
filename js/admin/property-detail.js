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
    CP.sb().auth.getUser().then(({ data: ud }) => {
      CP.sb().from('admin_actions').insert([{
        user_id:     ud?.user?.id || null,
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
      return '<div class="pd-no-photo"><span>No photos uploaded</span></div>';
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

    return main + strip;
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
      document.addEventListener('keydown', lbKeyHandler);
    }
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
    if (!el || el.dataset.built) return;
    el.dataset.built = '1';
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

    const extraBadges = (p.featured || p.property_type)
      ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
          ${p.featured ? '<span class="pill pill-warning">Featured</span>' : ''}
          ${p.property_type ? '<span class="pill pill-muted">' + esc(capitalize(p.property_type)) + '</span>' : ''}
        </div>`
      : '';

    const actionsHtml = `<div class="pd-actions">
      <button class="btn btn-primary btn-sm" id="pd-btn-edit"><i class="fas fa-pen-to-square"></i> Edit property</button>
      <button class="btn btn-ghost btn-sm" id="pd-btn-photos"><i class="fas fa-images"></i> Manage photos</button>
      <a class="btn btn-ghost btn-sm" href="/property.html?id=${esc(p.id)}" target="_blank" rel="noopener">Public listing ↗</a>
    </div>`;

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
    let wmHtml = '';
    if (wmPhotos.length) {
      const flagged = wmPhotos.filter(ph => ph.watermark_status === 'watermark' || ph.watermark_status === 'branding').length;
      wmHtml = `<div class="pd-section">
        <div class="pd-section-title">Watermark scan</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          ${flagged > 0 ? `<span class="pill pill-warning">${flagged} photo${flagged===1?'':'s'} flagged</span>` : '<span class="pill pill-success">All clear</span>'}
          <a class="btn btn-ghost btn-sm" href="/admin/watermark-review.html" style="font-size:.72rem">Open review</a>
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
              <a href="/admin/landlords.html" style="font-size:.74rem;color:var(--brand)">View full profile →</a>
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
    const appsHtml = `<div class="pd-section">
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
    const inqsHtml = `<div class="pd-section">
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

    document.getElementById('pd-root').innerHTML =
      galleryHtml
      + headerHtml
      + statusHtml
      + extraBadges
      + actionsHtml
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

    // Inquiry message expand (click row to read full message)
    document.querySelectorAll('.pd-inq-row').forEach(row => {
      row.addEventListener('click', () => {
        const msg = row.dataset.msg;
        if (!msg) return;
        const name = row.querySelector('td') ? row.querySelector('td').textContent : 'Inquiry';
        S.toast(name + ': ' + msg, 'info', 8000);
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
                <label class="pd-edit-label">State <input class="pd-edit-input" name="state" type="text" value="${esc(p.state || '')}" placeholder="CA" maxlength="2"></label>
                <label class="pd-edit-label">Zip <input class="pd-edit-input" name="zip" type="text" value="${esc(p.zip || '')}" placeholder="94101"></label>
              </div>
              <label class="pd-edit-label">Unit number
                <input class="pd-edit-input" name="unit_number" type="text" value="${esc(p.unit_number || '')}" placeholder="Apt 4B">
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
                <textarea class="pd-edit-input" name="description" rows="4" placeholder="Describe the property…">${esc(p.description || '')}</textarea>
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
              <label class="pd-edit-label">Move-in special
                <input class="pd-edit-input" name="move_in_special" type="text" value="${esc(p.move_in_special || '')}" placeholder="First month free!">
              </label>
            </div>

            <div class="pd-edit-group">
              <div class="pd-edit-group-title">Amenities & Features</div>
              <label class="pd-edit-label">Amenities <span class="pd-edit-hint">comma-separated</span>
                <input class="pd-edit-input" name="amenities" type="text" value="${esc((Array.isArray(p.amenities) ? p.amenities : []).join(', '))}" placeholder="Pool, Gym, Rooftop, In-unit Laundry">
              </label>
              <label class="pd-edit-label">Appliances <span class="pd-edit-hint">comma-separated</span>
                <input class="pd-edit-input" name="appliances" type="text" value="${esc((Array.isArray(p.appliances) ? p.appliances : []).join(', '))}" placeholder="Dishwasher, Refrigerator, Oven">
              </label>
              <label class="pd-edit-label">Flooring <span class="pd-edit-hint">comma-separated</span>
                <input class="pd-edit-input" name="flooring" type="text" value="${esc((Array.isArray(p.flooring) ? p.flooring : []).join(', '))}" placeholder="Hardwood, Tile, Carpet">
              </label>
              <label class="pd-edit-label">Utilities included <span class="pd-edit-hint">comma-separated</span>
                <input class="pd-edit-input" name="utilities_included" type="text" value="${esc((Array.isArray(p.utilities_included) ? p.utilities_included : []).join(', '))}" placeholder="Water, Trash, Internet">
              </label>
              <div class="pd-edit-row">
                <label class="pd-edit-label">Parking
                  <input class="pd-edit-input" name="parking" type="text" value="${esc(p.parking || '')}" placeholder="Street, Garage, Lot">
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
                  <input class="pd-edit-input" name="laundry_type" type="text" value="${esc(p.laundry_type || '')}" placeholder="In-unit, Shared, None">
                </label>
                <label class="pd-edit-label">Heating
                  <input class="pd-edit-input" name="heating_type" type="text" value="${esc(p.heating_type || '')}" placeholder="Central, Forced air">
                </label>
                <label class="pd-edit-label">Cooling
                  <input class="pd-edit-input" name="cooling_type" type="text" value="${esc(p.cooling_type || '')}" placeholder="Central AC, Window units">
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
                <select class="pd-edit-input" name="landlord_id" id="pd-landlord-select">
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
    requestAnimationFrame(() => panel.classList.add('open'));

    const closePanel = () => { panel.classList.remove('open'); setTimeout(() => panel.remove(), 300); };
    document.getElementById('pd-edit-close').addEventListener('click', closePanel);
    document.getElementById('pd-edit-cancel').addEventListener('click', closePanel);
    document.getElementById('pd-edit-overlay').addEventListener('click', closePanel);
    document.getElementById('pd-edit-save').addEventListener('click', () => saveEdit(closePanel));

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
      } catch (err) {
        S.toast('Geocode failed: ' + (err.message || err), 'error');
      } finally {
        btn.disabled = false; btn.innerHTML = '<i class="fas fa-location-dot"></i> Get coords from address';
      }
    });

    // ── Populate landlord dropdown ──
    CP.sb().rpc('admin_list_landlords', { p_page: 0, p_per_page: 200 }).then(({ data, error }) => {
      const sel = document.getElementById('pd-landlord-select');
      if (!sel) return;
      if (error || !data) { sel.innerHTML = '<option value="">— Could not load landlords —</option>'; return; }
      const rows = data.rows || [];
      sel.innerHTML = '<option value="">— Unassigned —</option>' +
        rows.map(l => {
          const label = esc(l.business_name || l.contact_name || l.id);
          const selected = l.id === p.landlord_id ? ' selected' : '';
          return `<option value="${esc(l.id)}"${selected}>${label}</option>`;
        }).join('');
    }).catch(() => {
      const sel = document.getElementById('pd-landlord-select');
      if (sel) sel.innerHTML = '<option value="">— Could not load landlords —</option>';
    });
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

    const saveBtn = document.getElementById('pd-edit-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

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
      virtual_tour_url:   get('virtual_tour_url') || null,
      monthly_rent:       getNum('monthly_rent'),
      security_deposit:   getNum('security_deposit'),
      application_fee:    getNum('application_fee'),
      admin_fee:          getNum('admin_fee'),
      last_months_rent:   getNum('last_months_rent'),
      available_date:     get('available_date') || null,
      minimum_lease_months: getNum('minimum_lease_months'),
      move_in_special:    get('move_in_special') || null,
      amenities:          getArr('amenities'),
      appliances:         getArr('appliances'),
      flooring:           getArr('flooring'),
      utilities_included: getArr('utilities_included'),
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
      featured:           get('featured') === 'true',
      showing_instructions: get('showing_instructions') || null,
      lat:                getNum('lat'),
      lng:                getNum('lng'),
      landlord_id:        get('landlord_id') || null,
      updated_at:         new Date().toISOString(),
    };

    const { error } = await CP.sb().from('properties').update(patch).eq('id', propId);

    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-check"></i> Save changes'; }

    if (error) { S.toast('Save failed: ' + error.message, 'error'); return; }

    S.toast('Property saved!', 'success');

    // Refresh the inline status toggle if status changed
    if (patch.status && patch.status !== _prop.status) {
      _prop.status = patch.status;
      const toggle = document.getElementById('pd-status-toggle');
      if (toggle) { toggle.outerHTML = renderStatusBar(patch.status); bindStatusToggle(); }
    }

    closePanel();

    // ── Audit log (non-blocking) ──
    CP.sb().auth.getUser().then(({ data: ud }) => {
      const uid = ud && ud.user ? ud.user.id : null;
      CP.sb().from('admin_actions').insert([{
        user_id: uid,
        action: 'property.edit',
        target_type: 'property',
        target_id: String(propId),
        metadata: { title: patch.title, fields_changed: Object.keys(patch), updated_at: patch.updated_at }
      }]).catch(() => {});
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

  // ── Photo manager ────────────────────────────────────────────────────────────
  function openPhotoManager() {
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
          <p class="pd-pm-hint"><i class="fas fa-grip-dots-vertical"></i> Drag photos to reorder them. The first photo is the cover image.</p>
          <div class="pd-pm-grid" id="pd-pm-grid">
            ${_photos.map((ph, i) => `
              <div class="pd-pm-item" data-photo-id="${esc(String(ph.id || ''))}" data-url="${esc(ph.url || '')}" draggable="true">
                <div class="pd-pm-handle" title="Drag to reorder"><i class="fas fa-grip-vertical"></i></div>
                <img src="${esc(thumbUrl(ph.url || ''))}" alt="Photo ${i+1}" loading="lazy">
                <div class="pd-pm-order">${i + 1}</div>
                ${ph.watermark_status && ph.watermark_status !== 'applied' ? `<div class="pd-pm-badge">⚠</div>` : ''}
                <button class="pd-pm-delete" data-photo-id="${esc(String(ph.id || ''))}" title="Delete photo" aria-label="Delete photo">
                  <i class="fas fa-trash"></i>
                </button>
              </div>`).join('')}
          </div>
          ${!_photos.length ? '<div class="pd-empty-row" style="text-align:center;padding:32px">No photos uploaded yet.</div>' : ''}
        </div>
        <div class="pd-edit-footer">
          <button class="btn btn-ghost" id="pd-pm-cancel">Cancel</button>
          <button class="btn btn-primary" id="pd-pm-save">
            <i class="fas fa-check"></i> Save order
          </button>
        </div>
      </div>`;

    document.body.appendChild(panel);
    requestAnimationFrame(() => panel.classList.add('open'));

    const closePanel = () => { panel.classList.remove('open'); setTimeout(() => panel.remove(), 300); };
    document.getElementById('pd-pm-close').addEventListener('click', closePanel);
    document.getElementById('pd-pm-cancel').addEventListener('click', closePanel);
    document.getElementById('pd-pm-overlay').addEventListener('click', closePanel);
    document.getElementById('pd-pm-save').addEventListener('click', () => savePhotoOrder(closePanel));

    // Delete buttons
    panel.addEventListener('click', async e => {
      const btn = e.target.closest('.pd-pm-delete');
      if (!btn) return;
      const id = btn.dataset.photoId;
      if (!id) return;
      const ok = await S.confirm({ title: 'Delete this photo?', message: 'This cannot be undone.', ok: 'Delete', cancel: 'Cancel', danger: true });
      if (!ok) return;
      const { error } = await CP.sb().from('property_photos').delete().eq('id', id);
      if (error) { S.toast('Delete failed: ' + error.message, 'error'); return; }
      _photos = _photos.filter(ph => String(ph.id) !== String(id));
      const item = btn.closest('.pd-pm-item');
      if (item) item.remove();
      refreshOrderBadges();
      S.toast('Photo deleted', 'success');
    });

    bindDragToReorder(document.getElementById('pd-pm-grid'));
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
      // Determine insert position
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
  }

  async function savePhotoOrder(closePanel) {
    const items = document.querySelectorAll('#pd-pm-grid .pd-pm-item');
    if (!items.length) { closePanel(); return; }

    const saveBtn = document.getElementById('pd-pm-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…'; }

    const updates = Array.from(items).map((item, i) => ({
      id: item.dataset.photoId,
      display_order: i
    }));

    let hadError = false;
    for (const u of updates) {
      if (!u.id) continue;
      const { error } = await CP.sb().from('property_photos').update({ display_order: u.display_order }).eq('id', u.id);
      if (error) { S.toast('Failed to save order: ' + error.message, 'error'); hadError = true; break; }
    }

    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-check"></i> Save order'; }

    if (!hadError) {
      S.toast('Photo order saved!', 'success');
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
    if (!ok) return;

    const [propRes, appsRes, inqsRes] = await Promise.all([
      CP.sb()
        .from('properties')
        .select('*, landlords(id,user_id,business_name,contact_name,avatar_url,tagline,verified), property_photos(id,url,display_order,watermark_status,file_id)')
        .eq('id', propId)
        .single(),
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

    if (propRes.error || !propRes.data) {
      document.getElementById('pd-root').innerHTML =
        `<div class="empty"><h3>Property not found</h3><p>${S.esc((propRes.error || {}).message || 'No data returned.')}</p></div>`;
      return;
    }

    render(propRes.data, appsRes.data || [], inqsRes.data || []);

    // Auto-open edit panel if ?edit=1 in URL
    if (params.get('edit') === '1') {
      openEditPanel(propRes.data);
      // Clean up URL so refresh doesn't re-open
      const cleanUrl = location.pathname + '?id=' + encodeURIComponent(propId);
      history.replaceState(null, '', cleanUrl);
    }
  });
})();
