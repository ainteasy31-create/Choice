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
  const params  = new URLSearchParams(location.search);
  const propId  = params.get('id');

  // ── Formatters ──────────────────────────────────────────────────────────
  function fmt(d)     { if (!d) return '—'; try { return new Date(d).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}); } catch { return d; } }
  function fmtMoney(v){ if (v == null) return '—'; return '$' + Number(v).toLocaleString('en-US'); }
  function pill(s)    {
    const m = { active:'pill-success', rented:'pill-info', inactive:'pill-muted', maintenance:'pill-warning',
                pending:'pill-warning', approved:'pill-success', declined:'pill-muted', submitted:'pill-info' };
    return '<span class="pill '+(m[s]||'pill-muted')+'">'+(s||'—')+'</span>';
  }
  function initials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).map(w => w[0]).join('').slice(0,2).toUpperCase();
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function render(p, apps, inqs) {
    const photos = Array.isArray(p.property_photos)
      ? p.property_photos.slice().sort((a,b) => (a.display_order||0)-(b.display_order||0)).map(x => x.url).filter(Boolean)
      : [];

    const landlord = p.landlords;

    // Gallery
    const galleryHtml = photos.length
      ? '<div class="pd-gallery">' + photos.map(u =>
          '<img src="' + S.esc(u) + '" alt="Property photo" loading="lazy">'
        ).join('') + '</div>'
      : '<div class="pd-no-photo"><span>No photos uploaded</span></div>';

    // Status + badges
    const statusBar = '<div class="pd-status-bar">'
      + pill(p.status)
      + (p.featured ? '<span class="pill pill-warning">Featured</span>' : '')
      + (p.property_type ? '<span class="pill pill-muted">' + S.esc(p.property_type) + '</span>' : '')
      + '</div>';

    // Action buttons
    const actions = '<div class="pd-actions">'
      + '<button class="btn btn-primary btn-sm" id="pd-btn-edit">Edit property</button>'
      + '<a class="btn btn-ghost btn-sm" href="/property.html?id=' + S.esc(p.id) + '" target="_blank" rel="noopener">Public listing ↗</a>'
      + '</div>';

    // Key fields grid
    const fields = [
      { label:'Monthly rent',   value: fmtMoney(p.monthly_rent) },
      { label:'Bedrooms',       value: p.bedrooms != null ? (p.bedrooms === 0 ? 'Studio' : p.bedrooms) : '—' },
      { label:'Bathrooms',      value: p.bathrooms != null ? p.bathrooms : '—' },
      { label:'Square footage', value: p.square_footage ? Number(p.square_footage).toLocaleString() + ' sqft' : '—' },
      { label:'Available',      value: fmt(p.available_date) },
      { label:'Created',        value: fmt(p.created_at) },
      { label:'Pets allowed',   value: p.pets_allowed ? 'Yes' : 'No' },
      { label:'Parking',        value: p.parking ? 'Yes' : 'No' },
      { label:'Utilities',      value: Array.isArray(p.utilities_included) && p.utilities_included.length
          ? p.utilities_included.join(', ') : (p.utilities_included ? 'Yes' : 'No') },
    ];
    const fieldsHtml = '<div class="pd-grid">'
      + fields.map(f => '<div class="pd-field"><div class="pd-field-label">' + f.label + '</div><div class="pd-field-value">' + S.esc(String(f.value)) + '</div></div>').join('')
      + '</div>';

    // Description
    const descHtml = p.description
      ? '<div class="pd-section"><div class="pd-section-title">Description</div><div class="pd-desc">' + S.esc(p.description) + '</div></div>'
      : '';

    // Amenities
    const amenities = Array.isArray(p.amenities) ? p.amenities : [];
    const amenHtml = amenities.length
      ? '<div class="pd-section"><div class="pd-section-title">Amenities</div><div class="pd-amenity-list">'
          + amenities.map(a => '<span class="pd-amenity">' + S.esc(a) + '</span>').join('')
          + '</div></div>'
      : '';

    // Landlord
    const landlordHtml = landlord
      ? '<div class="pd-section"><div class="pd-section-title">Landlord</div><div class="pd-landlord">'
          + '<div class="pd-landlord-avatar">' + initials(landlord.name || landlord.full_name) + '</div>'
          + '<div class="pd-landlord-info">'
            + '<div class="pd-landlord-name">' + S.esc(landlord.name || landlord.full_name || '—') + (landlord.verified ? ' <span class="pill pill-success" style="font-size:.62rem;padding:2px 8px">Verified</span>' : '') + '</div>'
            + '<div class="pd-landlord-meta">' + S.esc(landlord.email || '—') + (landlord.phone ? ' · ' + S.esc(landlord.phone) : '') + '</div>'
          + '</div>'
        + '</div></div>'
      : '';

    // Applications table
    const appRows = apps.length
      ? apps.map(a => {
          const tenant = a.tenants || {};
          return '<tr>'
            + '<td>' + S.esc(tenant.full_name || tenant.name || '—') + '</td>'
            + '<td>' + S.esc(tenant.email || '—') + '</td>'
            + '<td>' + pill(a.status) + '</td>'
            + '<td>' + fmt(a.created_at) + '</td>'
            + '<td><a class="btn btn-ghost btn-sm" href="/admin/applications.html" style="font-size:.72rem">View</a></td>'
            + '</tr>';
        }).join('')
      : '<tr><td colspan="5" class="pd-empty-row">No applications for this property.</td></tr>';

    const appsHtml = '<div class="pd-section"><div class="pd-section-title">Applications (' + apps.length + ')</div>'
      + '<div style="overflow-x:auto"><table class="pd-table"><thead><tr>'
      + '<th>Tenant</th><th>Email</th><th>Status</th><th>Submitted</th><th></th>'
      + '</tr></thead><tbody>' + appRows + '</tbody></table></div></div>';

    // Inquiries table
    const inqRows = inqs.length
      ? inqs.map(i =>
          '<tr>'
          + '<td>' + S.esc(i.name || '—') + '</td>'
          + '<td>' + S.esc(i.email || '—') + '</td>'
          + '<td>' + S.esc(i.phone || '—') + '</td>'
          + '<td>' + fmt(i.created_at) + '</td>'
          + '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + S.esc(i.message || '—') + '</td>'
          + '</tr>'
        ).join('')
      : '<tr><td colspan="5" class="pd-empty-row">No inquiries yet.</td></tr>';

    const inqsHtml = '<div class="pd-section"><div class="pd-section-title">Inquiries (' + inqs.length + ')</div>'
      + '<div style="overflow-x:auto"><table class="pd-table"><thead><tr>'
      + '<th>Name</th><th>Email</th><th>Phone</th><th>Date</th><th>Message</th>'
      + '</tr></thead><tbody>' + inqRows + '</tbody></table></div></div>';

    // Photos watermark status summary
    const wmPhotos = (p.property_photos || []).filter(ph => ph.watermark_status && ph.watermark_status !== 'applied');
    let wmHtml = '';
    if (wmPhotos.length) {
      const flagged = wmPhotos.filter(ph => ph.watermark_status === 'watermark' || ph.watermark_status === 'branding').length;
      wmHtml = '<div class="pd-section"><div class="pd-section-title">Watermark scan</div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
        + (flagged > 0
            ? '<span class="pill pill-warning">' + flagged + ' photo' + (flagged===1?'':'s') + ' flagged</span>'
            : '<span class="pill pill-success">All clear</span>')
        + '<a class="btn btn-ghost btn-sm" href="/admin/watermark-review.html" style="font-size:.72rem">Open review</a>'
        + '</div></div>';
    }

    document.getElementById('pd-root').innerHTML =
      galleryHtml
      + '<h2 style="font-size:1.15rem;font-weight:800;margin:0 0 4px">' + S.esc(p.title || 'Untitled') + '</h2>'
      + '<div style="font-size:.8rem;color:var(--muted);margin-bottom:12px">' + S.esc([p.address, p.city, p.state].filter(Boolean).join(', ') || '—') + '</div>'
      + statusBar
      + actions
      + '<div class="pd-section"><div class="pd-section-title">Details</div>' + fieldsHtml + '</div>'
      + descHtml
      + amenHtml
      + landlordHtml
      + wmHtml
      + appsHtml
      + inqsHtml;

    // Update page subtitle
    const sub = document.querySelector('[data-page-sub], #page-sub');
    if (sub) sub.textContent = p.title || 'Property detail';

    // Edit button
    document.getElementById('pd-btn-edit').addEventListener('click', () => {
      location.href = '/admin/properties.html#edit=' + encodeURIComponent(p.id);
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    try { await waitReady(8000); }
    catch (e) {
      document.getElementById('pd-root').innerHTML =
        '<div class="empty"><h3>Could not load admin tools</h3><p>' + e.message + '</p></div>';
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

    // Parallel fetch: property, applications, inquiries
    const [propRes, appsRes, inqsRes] = await Promise.all([
      CP.sb()
        .from('properties')
        .select('*, landlords(id,name,full_name,email,phone,verified), property_photos(url,display_order,watermark_status)')
        .eq('id', propId)
        .single(),
      CP.sb()
        .from('applications')
        .select('id,status,created_at,monthly_rent,tenants(full_name,name,email)')
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
        '<div class="empty"><h3>Property not found</h3><p>' + S.esc((propRes.error||{}).message || 'No data returned.') + '</p></div>';
      return;
    }

    render(propRes.data, appsRes.data || [], inqsRes.data || []);
  });
})();
