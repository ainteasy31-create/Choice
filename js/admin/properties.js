(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────────
  let _view = 'card';
  try { _view = localStorage.getItem('cp_prop_view') || 'card'; } catch (e) {}

  let _statusFilter = 'all';
  let _landlordFilter = null;
  let _q = '';
  let _sort = 'newest';
  let _debounce = null;
  let _allCache = [];
  let _rendered = 0;
  let _selected = new Set();
  const PAGE_SIZE = 24;
  const CACHE_KEY = 'cp_props_v4';
  const CACHE_TTL = 60_000;

  try {
    const usp = new URLSearchParams(location.search);
    if (usp.get('status')) {
      _statusFilter = usp.get('status');
    } else if (!usp.get('landlord')) {
      const saved = sessionStorage.getItem('cp_prop_status_v2');
      if (saved) _statusFilter = saved;
    }
    if (usp.get('landlord')) _landlordFilter = usp.get('landlord');
  } catch (e) {}

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtMoney(v) {
    if (v == null || v === '') return '—';
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(v)); }
    catch (e) { return '$' + v; }
  }

  function pillCls(s) {
    return { active: 'pill-success', rented: 'pill-info', inactive: 'pill-muted', maintenance: 'pill-warning', draft: 'pill-muted', paused: 'pill-warning', archived: 'pill-muted' }[s] || 'pill-muted';
  }

  function pill(s) { return '<span class="pill ' + pillCls(s) + '">' + esc(s || 'unknown') + '</span>'; }

  // ── Card renderer ────────────────────────────────────────────────────────────
  function card(p) {
    const rawUrl = p.cover_url;
    const imgSrc = rawUrl && window.CONFIG && CONFIG.img ? CONFIG.img(rawUrl, 'card') : rawUrl;
    const img = imgSrc
      ? '<img class="prop-img" src="' + esc(imgSrc) + '" alt="" loading="lazy" decoding="async">'
      : '<div class="prop-img-ph"><svg class="i" style="width:36px;height:36px"><use href="#i-property"/></svg></div>';
    const meta = [
      p.bedrooms != null ? p.bedrooms + 'bd' : null,
      p.bathrooms != null ? p.bathrooms + 'ba' : null,
      p.monthly_rent != null ? fmtMoney(p.monthly_rent) + '/mo' : null,
      p.square_footage ? Number(p.square_footage).toLocaleString() + ' sqft' : null,
    ].filter(Boolean).join(' · ');
    const landlordPill = p.landlords
      ? '<span class="pill pill-muted" style="font-size:.6rem">' + esc(p.landlords.business_name || p.landlords.contact_name || '') + '</span>'
      : '';
    const featuredBadge = p.featured ? '<span class="pill pill-warning" style="font-size:.6rem">★ Featured</span>' : '';
    const isSelected = _selected.has(p.id);
    return '<div class="prop-card' + (isSelected ? ' is-selected' : '') + '" data-prop-id="' + esc(p.id) + '">'
      + '<label class="prop-select-check" title="Select" onclick="event.stopPropagation()">'
      + '<input type="checkbox" class="prop-check" data-id="' + esc(p.id) + '"' + (isSelected ? ' checked' : '') + '>'
      + '</label>'
      + img
      + '<div class="prop-body">'
      + '<div class="row-title">' + esc(p.title || 'Untitled') + '</div>'
      + '<div class="row-sub">' + esc([p.address, p.city, p.state].filter(Boolean).join(', ') || 'No address') + '</div>'
      + '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-top:2px">'
      + pill(p.status) + ' ' + landlordPill + ' ' + featuredBadge
      + '</div>'
      + (meta ? '<div class="row-sub" style="color:var(--muted-2);margin-top:2px">' + esc(meta) + '</div>' : '')
      + '<div class="prop-actions">'
      + '<a class="btn btn-ghost btn-sm" href="/admin/property-detail.html?id=' + esc(p.id) + '&edit=1">Edit</a>'
      + '<a class="btn btn-ghost btn-sm" href="/admin/property-detail.html?id=' + esc(p.id) + '">View</a>'
      + '<button class="btn btn-ghost btn-sm" data-action="quick-edit" data-id="' + esc(p.id) + '" title="Quick status / rent update">⋮</button>'
      + '<button class="btn btn-ghost btn-sm" data-action="delete-prop" data-id="' + esc(p.id) + '" style="color:#dc2626;margin-left:auto" aria-label="Delete">Delete</button>'
      + '</div>'
      + '</div>'
      + '</div>';
  }

  // ── Row renderer (list view) ─────────────────────────────────────────────────
  function row(p) {
    const rawUrl = p.cover_url;
    const imgSrc = rawUrl && window.CONFIG && CONFIG.img ? CONFIG.img(rawUrl, 'avatar') : rawUrl;
    const thumb = imgSrc
      ? '<img src="' + esc(imgSrc) + '" alt="" loading="lazy" style="width:40px;height:40px;object-fit:cover;border-radius:6px;flex-shrink:0">'
      : '<div style="width:40px;height:40px;border-radius:6px;background:var(--surface-2);flex-shrink:0;display:flex;align-items:center;justify-content:center"><svg class="i" style="width:16px;height:16px"><use href="#i-property"/></svg></div>';
    const landlord = p.landlords ? (p.landlords.business_name || p.landlords.contact_name || '') : '';
    const meta = [
      p.bedrooms != null ? p.bedrooms + 'bd' : null,
      p.bathrooms != null ? p.bathrooms + 'ba' : null,
      p.monthly_rent != null ? fmtMoney(p.monthly_rent) + '/mo' : null,
    ].filter(Boolean).join(' · ');
    const isSelected = _selected.has(p.id);
    return '<div class="prop-row' + (isSelected ? ' is-selected' : '') + '" data-prop-id="' + esc(p.id) + '">'
      + '<label class="prop-select-check" title="Select" onclick="event.stopPropagation()">'
      + '<input type="checkbox" class="prop-check" data-id="' + esc(p.id) + '"' + (isSelected ? ' checked' : '') + '>'
      + '</label>'
      + thumb
      + '<div class="prop-row-body">'
      + '<div class="row-title">' + esc(p.title || 'Untitled') + ' ' + pill(p.status)
      + (p.featured ? ' <span class="pill pill-warning" style="font-size:.58rem">★</span>' : '') + '</div>'
      + '<div class="row-sub">' + esc([p.address, p.city, p.state].filter(Boolean).join(', ')) + (landlord ? ' · ' + esc(landlord) : '') + '</div>'
      + (meta ? '<div class="row-sub" style="color:var(--muted-2)">' + esc(meta) + '</div>' : '')
      + '</div>'
      + '<div class="prop-row-actions">'
      + '<a class="btn btn-ghost btn-sm" href="/admin/property-detail.html?id=' + esc(p.id) + '&edit=1" style="white-space:nowrap">Edit</a>'
      + '<a class="btn btn-ghost btn-sm" href="/admin/property-detail.html?id=' + esc(p.id) + '" style="white-space:nowrap">View ↗</a>'
      + '<button class="btn btn-ghost btn-sm" data-action="quick-edit" data-id="' + esc(p.id) + '">⋮</button>'
      + '<button class="btn btn-ghost btn-sm" data-action="delete-prop" data-id="' + esc(p.id) + '" style="color:#dc2626">Delete</button>'
      + '</div>'
      + '</div>';
  }

  // ── Cache ────────────────────────────────────────────────────────────────────
  function _cacheKey() { return CACHE_KEY + '_' + _statusFilter + '_' + (_landlordFilter || 'all'); }
  function _clearCache() { try { sessionStorage.removeItem(_cacheKey()); } catch (e) {} }

  // ── Sort ─────────────────────────────────────────────────────────────────────
  function _sortProps(props, sort) {
    const arr = props.slice();
    switch (sort) {
      case 'rent_high': return arr.sort(function (a, b) { return (b.monthly_rent || 0) - (a.monthly_rent || 0); });
      case 'rent_low':  return arr.sort(function (a, b) { return (a.monthly_rent || 0) - (b.monthly_rent || 0); });
      case 'beds':      return arr.sort(function (a, b) { return (b.bedrooms || 0) - (a.bedrooms || 0); });
      case 'status':    return arr.sort(function (a, b) { return (a.status || '').localeCompare(b.status || ''); });
      case 'title':     return arr.sort(function (a, b) { return (a.title || '').localeCompare(b.title || ''); });
      case 'oldest':    return arr.sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
      default:          return arr.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    }
  }

  function _getFiltered() {
    const q = _q.trim().toLowerCase();
    let base = _allCache;
    if (q) {
      base = base.filter(function (p) {
        return (p.title || '').toLowerCase().includes(q)
          || (p.address || '').toLowerCase().includes(q)
          || (p.city || '').toLowerCase().includes(q)
          || (p.zip || '').toLowerCase().includes(q)
          || (p.landlords && ((p.landlords.business_name || '') + ' ' + (p.landlords.contact_name || '')).toLowerCase().includes(q));
      });
    }
    return _sortProps(base, _sort);
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  function _renderFiltered(reset) {
    const container = document.getElementById('prop-container');
    if (!container) return;

    if (reset) {
      _rendered = 0;
      container.innerHTML = _view === 'card'
        ? '<div class="prop-grid" id="prop-inner"></div>'
        : '<div class="prop-list" id="prop-inner"></div>';
    }

    const inner = document.getElementById('prop-inner');
    if (!inner) return;

    const filtered = _getFiltered();
    const countEl = document.getElementById('page-sub');
    let moreBtn = document.getElementById('load-more-btn');

    if (!filtered.length) {
      const q = _q.trim();
      inner.innerHTML = q
        ? '<div class="empty" style="' + (_view === 'card' ? 'grid-column:1/-1' : '') + '"><svg class="i"><use href="#i-search"/></svg><h3>No results</h3><p>No properties match &ldquo;' + esc(q) + '&rdquo;.</p></div>'
        : '<div class="empty" style="' + (_view === 'card' ? 'grid-column:1/-1' : '') + '"><svg class="i"><use href="#i-property"/></svg><h3>No properties yet</h3><p>Tap <strong>+</strong> to create one.</p></div>';
      if (countEl) countEl.textContent = q ? '0 results' : '0 properties';
      if (moreBtn) moreBtn.style.display = 'none';
      return;
    }

    const slice = filtered.slice(_rendered, _rendered + PAGE_SIZE);
    inner.insertAdjacentHTML('beforeend', slice.map(_view === 'card' ? card : row).join(''));
    _rendered += slice.length;

    const hasMore = _rendered < filtered.length;
    if (!moreBtn) {
      moreBtn = document.createElement('div');
      moreBtn.id = 'load-more-btn';
      moreBtn.style.cssText = 'display:none;justify-content:center;padding:16px 0';
      moreBtn.innerHTML = '<button class="btn btn-ghost" id="load-more-inner" style="min-width:140px">Load more</button>';
      const after = container.nextSibling;
      container.parentNode.insertBefore(moreBtn, after);
      document.getElementById('load-more-inner').addEventListener('click', function () { _renderFiltered(false); });
    }
    moreBtn.style.display = hasMore ? 'flex' : 'none';

    if (countEl) {
      const total = filtered.length;
      const q = _q.trim();
      const label = total + ' propert' + (total === 1 ? 'y' : 'ies');
      const showing = Math.min(_rendered, total);
      countEl.textContent = label + (hasMore ? ' (showing ' + showing + ')' : '') + (q ? ' — filtered' : '');
    }
  }

  // ── Load from DB ─────────────────────────────────────────────────────────────
  async function load(useCache) {
    const container = document.getElementById('prop-container');
    if (!container) return;

    if (useCache) {
      try {
        const raw = sessionStorage.getItem(_cacheKey());
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Date.now() - parsed.ts < CACHE_TTL && Array.isArray(parsed.data) && parsed.data.length) {
            _allCache = parsed.data;
            _rendered = 0;
            _selected.clear();
            _updateBulkToolbar();
            _renderFiltered(true);
            const sub = document.getElementById('page-sub');
            if (sub) sub.textContent = parsed.data.length + ' propert' + (parsed.data.length === 1 ? 'y' : 'ies') + ' (cached)';
            _doLoad().catch(function () {});
            return;
          }
        }
      } catch (e) {}
    }

    container.innerHTML = '<div class="prop-grid" id="prop-inner">'
      + '<div class="skeleton sk-line" style="height:220px;border-radius:12px"></div>'
      + '<div class="skeleton sk-line" style="height:220px;border-radius:12px"></div>'
      + '<div class="skeleton sk-line" style="height:220px;border-radius:12px"></div>'
      + '</div>';
    const sub = document.getElementById('page-sub');
    if (sub) sub.textContent = 'Loading…';
    await _doLoad();
  }

  async function _doLoad() {
    const container = document.getElementById('prop-container');
    if (!container) return;

    let q = CP.sb()
      .from('properties')
      .select('id,title,address,city,state,zip,status,bedrooms,bathrooms,monthly_rent,square_footage,property_type,landlord_id,created_at,updated_at,available_date,featured,landlords(business_name,contact_name),property_photos(url,display_order)')
      .limit(500);

    if (_statusFilter !== 'all') q = q.eq('status', _statusFilter);
    if (_landlordFilter) q = q.eq('landlord_id', _landlordFilter);

    const { data, error } = await q;
    if (error) {
      container.innerHTML = '<div class="empty"><svg class="i"><use href="#i-alert"/></svg><h3>Error loading properties</h3><p>' + esc(error.message) + '</p></div>';
      const sub = document.getElementById('page-sub');
      if (sub) sub.textContent = 'Error';
      return;
    }

    // Extract cover photo from embedded array (no second network round-trip)
    const props = (data || []).map(function (p) {
      const photos = Array.isArray(p.property_photos) ? p.property_photos : [];
      const sorted = photos.slice().sort(function (a, b) { return (a.display_order || 0) - (b.display_order || 0); });
      return Object.assign({}, p, { cover_url: sorted.length ? sorted[0].url : null });
    });

    _allCache = _sortProps(props, _sort);

    try { sessionStorage.setItem(_cacheKey(), JSON.stringify({ ts: Date.now(), data: _allCache })); } catch (e) {}

    _rendered = 0;
    _selected.clear();
    _updateBulkToolbar();
    _renderFiltered(true);
  }

  // ── Bulk selection ───────────────────────────────────────────────────────────
  function _updateBulkToolbar() {
    const toolbar = document.getElementById('bulk-toolbar');
    const countEl = document.getElementById('bulk-count');
    if (!toolbar) return;
    toolbar.style.display = _selected.size > 0 ? 'flex' : 'none';
    if (countEl) countEl.textContent = _selected.size + ' selected';
  }

  function _toggleSelect(id) {
    if (_selected.has(id)) _selected.delete(id);
    else _selected.add(id);
    const el = document.querySelector('[data-prop-id="' + id + '"]');
    if (el) {
      el.classList.toggle('is-selected', _selected.has(id));
      const cb = el.querySelector('.prop-check[data-id="' + id + '"]');
      if (cb) cb.checked = _selected.has(id);
    }
    _updateBulkToolbar();
  }

  function _selectAll() {
    _getFiltered().forEach(function (p) { _selected.add(p.id); });
    document.querySelectorAll('.prop-check').forEach(function (cb) { cb.checked = true; });
    document.querySelectorAll('[data-prop-id]').forEach(function (el) { el.classList.add('is-selected'); });
    _updateBulkToolbar();
  }

  function _clearSelection() {
    _selected.clear();
    document.querySelectorAll('.prop-check').forEach(function (cb) { cb.checked = false; });
    document.querySelectorAll('[data-prop-id]').forEach(function (el) { el.classList.remove('is-selected'); });
    _updateBulkToolbar();
  }

  async function _bulkStatusChange() {
    if (!_selected.size) return;
    const S = AdminShell;
    const data = await S.formSheet({
      title: 'Change status for ' + _selected.size + ' propert' + (_selected.size === 1 ? 'y' : 'ies'),
      submit: 'Apply',
      fields: [{
        name: 'status', label: 'New status', type: 'select', value: '',
        options: [
          { value: '', label: 'Select…' },
          { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' },
          { value: 'rented', label: 'Rented' }, { value: 'maintenance', label: 'Maintenance' },
          { value: 'draft', label: 'Draft' }, { value: 'paused', label: 'Paused' },
          { value: 'archived', label: 'Archived' },
        ],
      }],
    });
    if (!data || !data.status) return;

    const ids = Array.from(_selected);
    S.toast('Updating ' + ids.length + ' propert' + (ids.length === 1 ? 'y' : 'ies') + '…', 'success');

    const { error } = await CP.sb().from('properties')
      .update({ status: data.status, updated_at: new Date().toISOString() })
      .in('id', ids);

    if (error) { S.toast('Bulk update failed: ' + error.message, 'error'); return; }

    CP.sb().auth.getUser().then(function (res) {
      const uid = res.data && res.data.user ? res.data.user.id : null;
      ids.forEach(function (id) {
        const p = _allCache.find(function (x) { return x.id === id; });
        CP.sb().from('admin_actions').insert([{
          user_id: uid, action: 'property.status_change', target_type: 'property', target_id: String(id),
          metadata: { from: p ? p.status : null, to: data.status, source: 'bulk' },
        }]).catch(function () {});
      });
    }).catch(function () {});

    S.toast('Updated ' + ids.length + ' propert' + (ids.length === 1 ? 'y' : 'ies') + ' to ' + data.status, 'success');
    _clearCache();
    _clearSelection();
    load(false);
  }

  async function _bulkDelete() {
    if (!_selected.size) return;
    const S = AdminShell;
    const ids = Array.from(_selected);
    const ok = await S.confirm({
      title: 'Delete ' + ids.length + ' propert' + (ids.length === 1 ? 'y' : 'ies') + '?',
      message: 'Permanently deletes ' + ids.length + ' propert' + (ids.length === 1 ? 'y' : 'ies') + ', including all photos, inquiries, and saves. Cannot be undone.',
      ok: 'Delete all', cancel: 'Cancel', danger: true,
    });
    if (!ok) return;

    let userId = null;
    try { const u = await CP.sb().auth.getUser(); userId = u.data && u.data.user ? u.data.user.id : null; } catch (e) {}

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const p = _allCache.find(function (x) { return x.id === id; });
      CP.sb().from('admin_actions').insert([{
        user_id: userId, action: 'property.hard_delete', target_type: 'property', target_id: String(id),
        metadata: { title: p ? p.title : null, address: p ? p.address : null, status: p ? p.status : null, source: 'bulk', deleted_at: new Date().toISOString() },
      }]).catch(function () {});
    }

    const { error } = await CP.sb().from('properties').delete().in('id', ids);
    if (error) { S.toast('Bulk delete failed: ' + error.message, 'error'); return; }

    S.toast('Deleted ' + ids.length + ' propert' + (ids.length === 1 ? 'y' : 'ies'), 'success');
    _allCache = _allCache.filter(function (p) { return !_selected.has(p.id); });
    _clearCache();
    _clearSelection();
    _renderFiltered(true);
    const countEl = document.getElementById('page-sub');
    if (countEl) countEl.textContent = _allCache.length + ' propert' + (_allCache.length === 1 ? 'y' : 'ies');
  }

  // ── Create / Quick-edit forms ─────────────────────────────────────────────────
  const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

  async function openForm(p) {
    const isEdit = !!(p && p.id);
    let landlordOptions = [{ value: '', label: '— Unassigned —' }];
    if (!isEdit) {
      try {
        const { data: lData } = await CP.sb().rpc('admin_list_landlords', { p_page: 0, p_per_page: 200 });
        const rows = (lData && lData.rows) || [];
        if (rows.length) {
          landlordOptions = [{ value: '', label: '— Unassigned —' }].concat(rows.map(function (l) {
            return { value: l.id, label: l.business_name || l.contact_name || l.email || l.id };
          }));
        }
      } catch (e) {}
    }

    const allFields = [
      { name: 'title', label: 'Title', type: 'text', value: (p && p.title) || '', required: true, placeholder: '2BR/1BA Apartment in Downtown' },
      { name: 'status', label: 'Status', type: 'select', value: (p && p.status) || 'draft', options: [
        { value: 'draft', label: 'Draft (not visible)' }, { value: 'active', label: 'Active' },
        { value: 'inactive', label: 'Inactive' }, { value: 'rented', label: 'Rented' },
        { value: 'maintenance', label: 'Maintenance' }, { value: 'paused', label: 'Paused' },
        { value: 'archived', label: 'Archived' },
      ]},
      { name: 'address', label: 'Street address', type: 'text', value: (p && p.address) || '', required: true, placeholder: '123 Main St' },
      { name: 'city', label: 'City', type: 'text', value: (p && p.city) || '', placeholder: 'San Francisco' },
      { name: 'state', label: 'State', type: 'select', value: (p && p.state) || '', options: [{ value: '', label: 'Select…' }].concat(US_STATES.map(function (s) { return { value: s, label: s }; })) },
      { name: 'zip', label: 'Zip code', type: 'text', value: (p && p.zip) || '', placeholder: '94101' },
      { name: 'property_type', label: 'Property type', type: 'select', value: (p && p.property_type) || '', options: [
        { value: '', label: 'Select…' }, { value: 'apartment', label: 'Apartment' }, { value: 'house', label: 'House' },
        { value: 'condo', label: 'Condo' }, { value: 'townhouse', label: 'Townhouse' }, { value: 'studio', label: 'Studio' },
        { value: 'duplex', label: 'Duplex' }, { value: 'room', label: 'Room' }, { value: 'land', label: 'Land' },
      ]},
      { name: 'bedrooms', label: 'Bedrooms', type: 'number', value: (p && p.bedrooms != null) ? p.bedrooms : '', placeholder: '2' },
      { name: 'bathrooms', label: 'Bathrooms', type: 'number', value: (p && p.bathrooms != null) ? p.bathrooms : '', placeholder: '1' },
      { name: 'square_footage', label: 'Square footage (sqft)', type: 'number', value: (p && p.square_footage) || '', placeholder: '850' },
      { name: 'monthly_rent', label: 'Monthly rent ($)', type: 'number', value: (p && p.monthly_rent) || '', placeholder: '1500' },
      { name: 'security_deposit', label: 'Security deposit ($)', type: 'number', value: (p && p.security_deposit) || '', placeholder: '1500' },
      { name: 'application_fee', label: 'Application fee ($)', type: 'number', value: (p && p.application_fee != null) ? p.application_fee : '', placeholder: '50' },
      { name: 'available_date', label: 'Available date', type: 'date', value: (p && p.available_date) ? p.available_date.slice(0, 10) : '' },
      { name: 'description', label: 'Description', type: 'textarea', value: (p && p.description) || '', rows: 3, placeholder: 'Describe the property…' },
    ];
    if (!isEdit) {
      allFields.push({ name: 'landlord_id', label: 'Assign to landlord', type: 'select', value: '', options: landlordOptions });
    }

    const data = await AdminShell.formSheet({ title: isEdit ? 'Edit property' : 'Add property', submit: isEdit ? 'Save changes' : 'Create property', fields: allFields });
    if (!data) return;
    if (!data.title || !data.address) { AdminShell.toast('Title and address are required', 'error'); return; }

    function _n(k) { return data[k] !== '' && data[k] != null ? Number(data[k]) : null; }
    const patch = {
      title: data.title.trim(), address: data.address.trim(),
      city: (data.city || '').trim() || null, state: data.state || null, zip: (data.zip || '').trim() || null,
      status: data.status || 'draft', property_type: data.property_type || null,
      bedrooms: _n('bedrooms'), bathrooms: _n('bathrooms'), monthly_rent: _n('monthly_rent'),
      security_deposit: _n('security_deposit'), application_fee: _n('application_fee'),
      square_footage: _n('square_footage'), available_date: data.available_date || null,
      description: (data.description || '').trim() || null, updated_at: new Date().toISOString(),
    };
    if (!isEdit && data.landlord_id) patch.landlord_id = data.landlord_id;

    if (isEdit) {
      const r = await CP.sb().from('properties').update(patch).eq('id', p.id);
      if (r.error) { AdminShell.toast('Save failed: ' + r.error.message, 'error'); return; }
      AdminShell.toast('Updated', 'success');
      _clearCache(); load(false);
    } else {
      patch.created_at = new Date().toISOString();
      const r = await CP.sb().from('properties').insert([patch]).select('id').single();
      if (r.error) { AdminShell.toast('Save failed: ' + r.error.message, 'error'); return; }
      AdminShell.toast('Property created — opening detail page…', 'success');
      const newId = r.data && r.data.id;
      CP.sb().auth.getUser().then(function (res) {
        const uid = res.data && res.data.user ? res.data.user.id : null;
        CP.sb().from('admin_actions').insert([{
          user_id: uid, action: 'property.create', target_type: 'property', target_id: newId ? String(newId) : null,
          metadata: { title: patch.title, status: patch.status, landlord_id: patch.landlord_id || null },
        }]).catch(function () {});
      }).catch(function () {});
      if (newId) {
        setTimeout(function () { location.href = '/admin/property-detail.html?id=' + encodeURIComponent(newId) + '&edit=1'; }, 600);
      } else { _clearCache(); load(false); }
    }
  }

  async function openQuickEdit(id) {
    const S = AdminShell;
    const p = _allCache.find(function (x) { return x.id === id; });
    if (!p) return;
    const data = await S.formSheet({
      title: (p.title || 'Property').slice(0, 40), submit: 'Save',
      fields: [
        { name: 'status', label: 'Status', type: 'select', value: p.status || 'draft', options: [
          { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' },
          { value: 'rented', label: 'Rented' }, { value: 'maintenance', label: 'Maintenance' },
          { value: 'draft', label: 'Draft' }, { value: 'paused', label: 'Paused' }, { value: 'archived', label: 'Archived' },
        ]},
        { name: 'monthly_rent', label: 'Monthly rent ($)', type: 'number', value: p.monthly_rent || '', placeholder: '1500' },
        { name: 'featured', label: 'Featured listing', type: 'select', value: p.featured ? 'true' : 'false', options: [
          { value: 'false', label: 'No' }, { value: 'true', label: 'Yes — show as featured' },
        ]},
      ],
    });
    if (!data) return;

    const prevStatus = p.status;
    const newStatus = data.status || p.status;
    const patch = {
      status: newStatus,
      monthly_rent: data.monthly_rent !== '' && data.monthly_rent != null ? Number(data.monthly_rent) : p.monthly_rent,
      featured: data.featured === 'true',
      updated_at: new Date().toISOString(),
    };
    const { error } = await CP.sb().from('properties').update(patch).eq('id', id);
    if (error) { S.toast('Failed: ' + error.message, 'error'); return; }

    Object.assign(p, patch);
    _clearCache();
    const el = document.querySelector('[data-prop-id="' + id + '"]');
    if (el) el.outerHTML = _view === 'card' ? card(p) : row(p);
    S.toast('Updated', 'success');

    if (newStatus !== prevStatus) {
      CP.sb().auth.getUser().then(function (res) {
        const uid = res.data && res.data.user ? res.data.user.id : null;
        CP.sb().from('admin_actions').insert([{
          user_id: uid, action: 'property.status_change', target_type: 'property', target_id: String(id),
          metadata: { from: prevStatus, to: newStatus },
        }]).catch(function () {});
      }).catch(function () {});
    }
  }

  async function confirmAndDelete(id) {
    const S = AdminShell;
    const p = _allCache.find(function (x) { return x.id === id; });
    if (!p) { S.toast('Property not found', 'error'); return; }

    let inqN = 0, phN = 0, savN = 0, appN = 0;
    try {
      const res = await Promise.all([
        CP.sb().from('inquiries').select('id', { count: 'exact', head: true }).eq('property_id', id),
        CP.sb().from('property_photos').select('id', { count: 'exact', head: true }).eq('property_id', id),
        CP.sb().from('saved_properties').select('property_id', { count: 'exact', head: true }).eq('property_id', id),
        CP.sb().from('applications').select('id', { count: 'exact', head: true }).eq('property_id', id),
      ]);
      inqN = res[0].count || 0; phN = res[1].count || 0; savN = res[2].count || 0; appN = res[3].count || 0;
    } catch (e) {}

    const lines = [
      'Permanently delete "' + (p.title || 'Untitled') + '"', p.address || '',
      '', 'This will also permanently delete:',
      '  • ' + inqN + ' inquir' + (inqN === 1 ? 'y' : 'ies'),
      '  • ' + phN + ' photo' + (phN === 1 ? '' : 's'),
      '  • ' + savN + ' tenant save' + (savN === 1 ? '' : 's'),
    ];
    if (appN > 0) lines.push('', appN + ' application' + (appN === 1 ? '' : 's') + ' will be kept but unlinked.');
    lines.push('', 'This cannot be undone.');

    const ok = await S.confirm({ title: 'Delete this property forever?', message: lines.join('\n'), ok: 'Delete forever', cancel: 'Cancel', danger: true });
    if (!ok) return;

    let userId = null;
    try { const u = await CP.sb().auth.getUser(); userId = u.data && u.data.user ? u.data.user.id : null; } catch (e) {}

    const audit = await CP.sb().from('admin_actions').insert([{
      user_id: userId, action: 'property.hard_delete', target_type: 'property', target_id: String(id),
      metadata: {
        title: p.title || null, address: p.address || null, status: p.status || null, monthly_rent: p.monthly_rent || null,
        landlord_id: p.landlord_id || null, cascade: { inquiries: inqN, photos: phN, saves: savN, applications: appN },
        deleted_at: new Date().toISOString(),
      },
    }]);
    if (audit.error) { S.toast('Delete blocked: audit log failed (' + audit.error.message + ')', 'error'); return; }

    const { error } = await CP.sb().from('properties').delete().eq('id', id);
    if (error) { S.toast('Delete failed: ' + error.message, 'error'); return; }

    S.toast('Property deleted', 'success');
    _allCache = _allCache.filter(function (x) { return x.id !== id; });
    _selected.delete(id);
    _clearCache();
    const el = document.querySelector('[data-prop-id="' + id + '"]');
    if (el) el.remove();
    const countEl = document.getElementById('page-sub');
    if (countEl) countEl.textContent = _allCache.length + ' propert' + (_allCache.length === 1 ? 'y' : 'ies');
    _updateBulkToolbar();
  }

  // ── View toggle ───────────────────────────────────────────────────────────────
  function _setView(v) {
    _view = v;
    try { localStorage.setItem('cp_prop_view', v); } catch (e) {}
    document.querySelectorAll('[data-view-btn]').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.viewBtn === v);
      btn.setAttribute('aria-pressed', btn.dataset.viewBtn === v ? 'true' : 'false');
    });
    _rendered = 0;
    _renderFiltered(true);
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  function waitReady(ms) {
    return new Promise(function (res, rej) {
      const start = Date.now();
      (function tick() {
        if (window.AdminShell && window.CP && CP.sb && CP.Auth) return res();
        if (Date.now() - start > ms) return rej(new Error('Admin tools failed to load.'));
        setTimeout(tick, 80);
      })();
    });
  }

  document.addEventListener('DOMContentLoaded', async function () {
    try { await waitReady(8000); } catch (e) {
      const c = document.getElementById('prop-container');
      if (c) c.innerHTML = '<div class="empty"><h3>Could not load admin tools</h3><p>' + esc(e.message) + '</p></div>';
      return;
    }

    const ok = await AdminShell.requireAdmin();
    if (!ok) return;

    // Initial view button state
    document.querySelectorAll('[data-view-btn]').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.viewBtn === _view);
      btn.setAttribute('aria-pressed', btn.dataset.viewBtn === _view ? 'true' : 'false');
    });

    // Status chips
    document.querySelectorAll('#chips .chip').forEach(function (c) {
      c.classList.toggle('active', (c.dataset.status || 'all') === _statusFilter);
    });
    document.getElementById('chips').addEventListener('click', function (e) {
      const c = e.target.closest('.chip');
      if (!c) return;
      document.querySelectorAll('#chips .chip').forEach(function (x) { x.classList.remove('active'); });
      c.classList.add('active');
      _statusFilter = c.dataset.status || 'all';
      try { sessionStorage.setItem('cp_prop_status_v2', _statusFilter); } catch (e2) {}
      _clearCache();
      load(false);
    });

    // Search
    document.getElementById('search').addEventListener('input', function (e) {
      _q = e.target.value;
      clearTimeout(_debounce);
      _debounce = setTimeout(function () { _renderFiltered(true); }, 180);
    });

    // Sort
    const sortSel = document.getElementById('sort-select');
    if (sortSel) {
      sortSel.value = _sort;
      sortSel.addEventListener('change', function (e) {
        _sort = e.target.value;
        _rendered = 0;
        _renderFiltered(true);
      });
    }

    // View toggle buttons
    document.querySelectorAll('[data-view-btn]').forEach(function (btn) {
      btn.addEventListener('click', function () { _setView(btn.dataset.viewBtn); });
    });

    // Container delegation (clicks on cards / rows)
    document.getElementById('prop-container').addEventListener('click', function (e) {
      const cb = e.target.closest('.prop-check');
      if (cb) { _toggleSelect(cb.dataset.id); return; }
      const delBtn = e.target.closest('[data-action="delete-prop"]');
      if (delBtn) { e.preventDefault(); confirmAndDelete(delBtn.dataset.id).catch(function (err) { AdminShell.toast('Error: ' + (err && err.message || err), 'error'); }); return; }
      const qBtn = e.target.closest('[data-action="quick-edit"]');
      if (qBtn) { e.preventDefault(); openQuickEdit(qBtn.dataset.id).catch(function (err) { AdminShell.toast('Error: ' + (err && err.message || err), 'error'); }); return; }
    });

    // FAB
    document.querySelector('[data-action="add-prop"]')?.addEventListener('click', function (e) { e.preventDefault(); openForm(null); });

    // Bulk toolbar
    document.getElementById('bulk-status-btn')?.addEventListener('click', function () { _bulkStatusChange().catch(function (err) { AdminShell.toast('Error: ' + (err && err.message), 'error'); }); });
    document.getElementById('bulk-delete-btn')?.addEventListener('click', function () { _bulkDelete().catch(function (err) { AdminShell.toast('Error: ' + (err && err.message), 'error'); }); });
    document.getElementById('bulk-select-all-btn')?.addEventListener('click', _selectAll);
    document.getElementById('bulk-clear-btn')?.addEventListener('click', _clearSelection);

    // CSV export
    document.getElementById('export-csv-btn')?.addEventListener('click', function () {
      const rows = _getFiltered();
      if (!rows.length) { AdminShell.toast('No properties to export', 'error'); return; }
      if (window.CPPropertyShared) {
        CPPropertyShared.exportCSV(rows, 'properties-' + new Date().toISOString().slice(0, 10) + '.csv');
        AdminShell.toast('CSV exported (' + rows.length + ' rows)', 'success');
      } else {
        AdminShell.toast('Export not available', 'error');
      }
    });

    // Landlord filter banner
    if (_landlordFilter) {
      const banner = document.getElementById('landlord-banner');
      if (banner) {
        banner.style.display = 'flex';
        CP.sb().rpc('admin_list_landlords', { p_page: 0, p_per_page: 200 }).then(function (res) {
          const rows = (res.data && res.data.rows) || [];
          const lname = document.getElementById('landlord-banner-name');
          if (lname) {
            const l = rows.find(function (r) { return r.id === _landlordFilter; });
            lname.textContent = l ? (l.business_name || l.contact_name || l.email || _landlordFilter) : _landlordFilter;
          }
        }).catch(function () {});
      }
    }

    load(true);
  });
})();
