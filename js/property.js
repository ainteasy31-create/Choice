// ============================================================
// property.js — page-specific logic for /property.html
// Extracted from inline <script type="module"> in property.html
// as part of issue #16 (separate concerns + de-duplicate helpers).
// Loaded as: <script type="module" src="/js/property.js?v=...">.
// ============================================================
import { supabase, buildApplyURL, incrementCounter, getSession, SavedProperties } from '/js/cp-api.js';
import { updateNav as _updateNav } from '/js/cp-api.js';

// Shared helpers — defined globally by /js/cp-ui.js (loaded before this module).
//   - esc:            HTML-escape, null-safe (CP.UI.esc)
//   - showToast:      legacy public-page toast, uses #toastContainer
//   - setupScrollTop: scroll-to-top button wiring (not used on this page,
//                     but available if needed)
const esc = CP.UI.esc;
const showToast = window.showToast;

// Extended nav init — wires both navAuthLink and drawerAuthLink, populates contacts
async function updateNav() {
  await _updateNav();
  // Wire drawerAuthLink to match navAuthLink after _updateNav resolves
  const navLink    = document.getElementById('navAuthLink');
  const drawerLink = document.getElementById('drawerAuthLink');
  if (navLink && drawerLink) {
    drawerLink.href = navLink.href;
    drawerLink.textContent = navLink.textContent;
  }
  // Populate CONFIG-driven contacts
  if (window.CONFIG) {
    const df = document.getElementById('drawerFooterEmail');
    if (df) { df.href = 'mailto:' + CONFIG.COMPANY_EMAIL; df.textContent = CONFIG.COMPANY_EMAIL; }
    document.querySelectorAll('[data-cfg-email]').forEach(el => { el.href = 'mailto:' + CONFIG.COMPANY_EMAIL; el.textContent = CONFIG.COMPANY_EMAIL; });
    document.querySelectorAll('[data-cfg-phone]').forEach(el => { el.href = 'tel:' + CONFIG.COMPANY_PHONE.replace(/\D/g,''); el.textContent = CONFIG.COMPANY_PHONE; });
  }
}

updateNav();

const params    = new URLSearchParams(window.location.search);
const isPreview = params.get('preview') === 'true';

// Resolve the property id from either:
//   1) the legacy ?id=PROP-XXXXXXXX query string, or
//   2) the trailing prop-xxxxxxxx token of the canonical slug URL
//      `/rent/<state>/<city>/<beds>-<type>-prop-xxxxxxxx/`
//      (rendered by functions/rent/[state]/[city]/[slug].js).
// Matching the same regex the edge function uses keeps the two
// in lock-step. Without this fallback, every click on a card on
// the live site shows "Property not found." and redirects to
// /listings.html because the canonical URL has no ?id=.
function resolvePropertyId() {
  const fromQuery = (params.get('id') || '').trim();
  if (fromQuery) return fromQuery;
  const m = window.location.pathname.match(/(prop-[a-z0-9]{8})\/?$/i);
  return m ? m[1].toUpperCase() : '';
}
const propertyId = resolvePropertyId();

if (!propertyId && !isPreview) {
  // Show an error toast then redirect to the listings page
  if (window.CP && window.CP.UI) {
    window.CP.UI.toast('Property not found.', 'error');
    setTimeout(() => { window.location.href = '/listings.html'; }, 800);
  } else {
    window.location.href = '/listings.html';
  }
}

let currentProperty = null;
let photoIndex      = 0;
let allPhotos       = [];
let savedIds = new Set(JSON.parse(localStorage.getItem('cp_saved') || '[]'));

if (isPreview) {
  // ── Preview mode — load from sessionStorage ──
  const raw = sessionStorage.getItem('cp_listing_preview');
  if (!raw) { window.location.href = '/index.html'; } else {
    const previewProp = JSON.parse(raw);
    // Inject preview banner
    const banner = document.createElement('div');
    banner.id = 'previewBanner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#f59e0b;color:#0a1628;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;box-shadow:0 2px 12px rgba(0,0,0,0.2);font-family:"Inter",sans-serif;font-size:14px;font-weight:600';
    banner.innerHTML = `
      <span><i class="fas fa-eye" style="margin-right:6px"></i>Preview Mode — This listing has not been published yet.</span>
      <button onclick="history.back()" style="background:#0a1628;color:#f59e0b;border:none;border-radius:6px;padding:6px 14px;font-size:13px;font-weight:700;cursor:pointer">← Back to Editor</button>`;
    document.body.prepend(banner);
    document.body.style.paddingTop = '48px';
    currentProperty = previewProp;
    renderProperty(previewProp);
    // Disable apply buttons in preview mode
    requestAnimationFrame(() => {
      ['applyBtn','mobApplyBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.href = '#';
          el.style.pointerEvents = 'none';
          el.style.opacity = '0.5';
          el.title = 'Apply button disabled in preview mode';
          el.addEventListener('click', e => e.preventDefault());
        }
      });
    });
  }
} else {
  loadProperty(propertyId);
}

async function loadProperty(id) {
  // Phase 1 — DB lookup. Only this phase may legitimately raise the
  // "Property not found." toast + redirect, because only this phase can
  // tell us the row truly does not exist (or is hidden by RLS).
  let prop;
  try {
    const { data, error } = await supabase
      .from('properties')
      .select('*, landlords(id, user_id, business_name, contact_name, avatar_url, tagline, verified), property_photos(url, file_id, display_order)')
      .eq('id', id)
      .single();
    if (error || !data) throw new Error('Not found');
    prop = data;
  } catch (e) {
    console.error('[property] lookup failed for id=', id, e);
    showToast('Property not found.', 'error');
    setTimeout(() => window.location.href = '/index.html', 2000);
    return;
  }

  // Phase 3c: derive photo_urls / photo_file_ids from the property_photos join
  // (the legacy array columns were dropped; property_photos is now the source of truth)
  if (Array.isArray(prop.property_photos)) {
    const _sorted = prop.property_photos.slice().sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    prop.photo_urls     = _sorted.map(p => p.url).filter(Boolean);
    prop.photo_file_ids = _sorted.map(p => p.file_id ?? null);
  } else {
    prop.photo_urls     = [];
    prop.photo_file_ids = [];
  }

  // Guard non-active listings from public view
  if (prop.status !== 'active') {
    try {
      const session    = await getSession();
      const viewerId   = session?.user?.id || null;
      const ownerId    = prop.landlords?.user_id || null;
      const isOwner    = viewerId && ownerId && viewerId === ownerId;
      if (!isOwner) {
        renderUnavailable(prop.status);
        return;
      }
    } catch (e) {
      console.warn('[property] session check failed; treating as anonymous', e);
      renderUnavailable(prop.status);
      return;
    }
  }

  currentProperty = prop;

  // Phase 2 — view-counter bump. Pure side-effect; never block render
  // and never trip the not-found path if the RPC errors out.
  try {
    await incrementCounter('properties', id, 'views_count');
  } catch (e) {
    console.warn('[property] increment_counter failed (non-fatal)', e);
  }

  // Phase 3 — render. If anything in renderProperty throws, the row
  // really does exist, so DO NOT show "Property not found." and DO NOT
  // redirect away — that destroys the user's session for what is
  // almost certainly a UI bug. Surface the real error to the console
  // and the error reporter so we can fix it.
  try {
    renderProperty(prop);
  } catch (e) {
    console.error('[property] renderProperty crashed:', e);
    if (typeof window.cpReportError === 'function') {
      try { window.cpReportError(e); } catch (_) { /* swallow */ }
    }
    showToast('Some details could not be displayed. Please refresh.', 'error');
  }

  // Refresh save state from Supabase for authenticated users (non-blocking).
  // Wrapped so a thrown TypeError (e.g. SavedProperties undefined in a
  // partial-import edge case) cannot bubble up and trigger a redirect.
  try {
    SavedProperties.getIds().then(ids => {
      savedIds = ids;
      const saveBtn = document.getElementById('savePropBtn');
      if (saveBtn) {
        if (savedIds.has(prop.id)) {
          saveBtn.innerHTML = '<i class="fas fa-heart" style="color:#dc2626"></i> Saved';
        } else {
          saveBtn.innerHTML = '<i class="far fa-heart"></i> Save';
        }
      }
    }).catch(err => console.warn('[property] saved-state load failed', err));
  } catch (e) {
    console.warn('[property] saved-state init failed', e);
  }
}

function renderUnavailable(status) {
  document.title = 'Listing Unavailable — Choice Properties';
  document.getElementById('gallery').style.display = 'none';
  document.querySelector('.property-detail').innerHTML = `
    <div class="container" style="padding:80px 16px;text-align:center;max-width:540px;margin:0 auto">
      <div style="font-size:48px;margin-bottom:16px;color:var(--m-brand)"><i class="fas fa-house-circle-exclamation"></i></div>
      <h1 style="font-size:1.5rem;font-weight:700;color:var(--m-ink);margin-bottom:12px">
        This listing is not currently available.
      </h1>
      <p style="color:var(--m-muted);font-size:15px;margin-bottom:32px">
        ${status === 'rented'
          ? 'This property has already been rented.'
          : 'This listing has been paused or removed by the landlord.'}
      </p>
      <a href="/index.html" class="btn btn-primary" style="display:inline-block">
        Browse All Listings
      </a>
    </div>`;
}

/* ── Amenity icon helpers ── */
function amenityIcon(text) {
  const t = text.toLowerCase();
  if (/wi.?fi|internet|wireless/.test(t))              return 'fa-wifi';
  if (/gym|fitness|workout/.test(t))                   return 'fa-dumbbell';
  if (/pool|swimming/.test(t))                         return 'fa-water-ladder';
  if (/air.?cond|a\/c|cooling|central air/.test(t))   return 'fa-snowflake';
  if (/\bheat\b|furnace|radiant/.test(t))              return 'fa-fire';
  if (/laundry|washer|dryer/.test(t))                  return 'fa-shirt';
  if (/dishwasher/.test(t))                            return 'fa-sink';
  if (/parking|garage|driveway/.test(t))               return 'fa-car-side';
  if (/pet|dog|cat/.test(t))                           return 'fa-paw';
  if (/balcony|patio|deck|terrace/.test(t))            return 'fa-umbrella-beach';
  if (/storage|closet/.test(t))                        return 'fa-box';
  if (/elevator|lift/.test(t))                         return 'fa-elevator';
  if (/security|camera|doorbell|alarm/.test(t))        return 'fa-shield-halved';
  if (/hardwood|flooring/.test(t))                     return 'fa-layer-group';
  if (/microwave|oven|stove|range/.test(t))            return 'fa-utensils';
  if (/refrigerator|fridge/.test(t))                   return 'fa-temperature-low';
  if (/smoke|carbon monoxide/.test(t))                 return 'fa-triangle-exclamation';
  if (/cable|tv|television/.test(t))                   return 'fa-tv';
  if (/furnish|furniture/.test(t))                     return 'fa-couch';
  if (/yard|garden|lawn|outdoor/.test(t))              return 'fa-seedling';
  if (/wheel|accessible|handicap/.test(t))             return 'fa-wheelchair';
  if (/concierge|doorman/.test(t))                     return 'fa-user-tie';
  if (/solar|green|eco/.test(t))                       return 'fa-leaf';
  if (/rooftop|roof/.test(t))                          return 'fa-building';
  return 'fa-circle-check';
}
function amenityIconColor(text) {
  const t = text.toLowerCase();
  if (/wi.?fi|internet|wireless|cable|tv/.test(t))     return 'icon-sky';
  if (/pool|swimming|balcony|patio|deck|yard/.test(t)) return 'icon-teal';
  if (/gym|fitness|workout/.test(t))                   return 'icon-purple';
  if (/pet|dog|cat/.test(t))                           return 'icon-rose';
  if (/solar|green|eco|yard|garden|lawn/.test(t))      return 'icon-green';
  if (/smoke|carbon|alarm|security/.test(t))           return 'icon-amber';
  return '';
}

function renderProperty(p) {
  document.title = `${p.title} — Choice Properties`;

  // Build apply URL early — used by both the structured data potentialAction
  // and the Apply button wiring later in this function.
  const applyURL = buildApplyURL(p);

  // OG meta
  const ogImg  = CONFIG.img(p.photo_urls?.[0] || '', 'og') || '/assets/placeholder-property.jpg';
  const ogDesc = `${p.bedrooms === 0 ? 'Studio' : (p.bedrooms + ' bed')} · ${p.bathrooms} bath · ${p.monthly_rent != null ? '$' + Number(p.monthly_rent).toLocaleString() + '/mo' : 'Rent TBD'} · ${p.address}, ${p.city}, ${p.state}`;
  ['ogTitle','twTitle'].forEach(id => setMeta(id, `${p.title} — Choice Properties`));
  ['ogDescription','twDescription'].forEach(id => setMeta(id, ogDesc));
  ['ogImage','twImage'].forEach(id => setMeta(id, ogImg));
  document.querySelector('meta[name="description"]')?.setAttribute('content', ogDesc);

  // Phase C: canonical URL — always points to the keyword-rich slug URL.
  // The slug-router edge function (functions/rent/[state]/[city]/[slug].js)
  // injects this into the initial HTML for crawlers, but for legacy
  // /property.html?id=… requests that bypass the redirector (e.g. backend
  // unavailable), this client-side fallback makes sure search engines and
  // social cards still see the canonical URL.
  const canonicalUrl = (window.CP?.UI?.propertyUrl)
    ? new URL(window.CP.UI.propertyUrl(p), window.location.origin).href
    : window.location.href;
  let canonLink = document.querySelector('link[rel="canonical"]');
  if (!canonLink) {
    canonLink = document.createElement('link');
    canonLink.rel = 'canonical';
    document.head.appendChild(canonLink);
  }
  canonLink.href = canonicalUrl;
  setMeta('ogUrl', canonicalUrl);

  // ── I-059: Structured data — RealEstateListing schema for Google Rich Results ──
  // Added: potentialAction (RentalAction), numberOfRooms, floorSize, leaseLength,
  // amenityFeature, and BreadcrumbList. These fields are required or strongly
  // recommended for Google's RentalListing rich result eligibility.
  const sd = document.createElement('script');
  sd.type = 'application/ld+json';
  const amenities = [];
  if (p.parking)      amenities.push({ "@type": "LocationFeatureSpecification", "name": "Parking",        "value": true });
  if (p.pets_allowed) amenities.push({ "@type": "LocationFeatureSpecification", "name": "Pets Allowed",   "value": true });
  if (p.laundry)      amenities.push({ "@type": "LocationFeatureSpecification", "name": "Laundry",        "value": p.laundry });
  if (p.ac)           amenities.push({ "@type": "LocationFeatureSpecification", "name": "Air Conditioning","value": true });
  sd.textContent = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "RealEstateListing",
    "name": p.title,
    "description": p.description || undefined,
    "url": window.location.href,
    "image": p.photo_urls?.[0] ? CONFIG.img(p.photo_urls[0], 'og') : undefined,
    "datePosted": p.created_at ? p.created_at.split('T')[0] : undefined,
    "address": {
      "@type": "PostalAddress",
      "streetAddress": p.address,
      "addressLocality": p.city,
      "addressRegion": p.state,
      "postalCode": p.zip || undefined,
      "addressCountry": "US"
    },
    "geo": (p.lat && p.lng) ? {
      "@type": "GeoCoordinates",
      "latitude": p.lat,
      "longitude": p.lng
    } : undefined,
    "offers": {
      "@type": "Offer",
      "price": p.monthly_rent,
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock",
      "priceSpecification": {
        "@type": "UnitPriceSpecification",
        "price": p.monthly_rent,
        "priceCurrency": "USD",
        "unitCode": "MON",
        "referenceQuantity": { "@type": "QuantitativeValue", "value": 1, "unitCode": "MON" }
      }
    },
    "numberOfRooms": p.bedrooms,
    "numberOfBathroomsTotal": p.bathrooms,
    "floorSize": p.square_footage ? {
      "@type": "QuantitativeValue",
      "value": p.square_footage,
      "unitCode": "FTK"
    } : undefined,
    "leaseLength": p.lease_terms?.length ? p.lease_terms.join(", ") : undefined,
    "amenityFeature": amenities.length ? amenities : undefined,
    "potentialAction": {
      "@type": "RentAction",
      "name": "Apply for Lease",
      "target": {
        "@type": "EntryPoint",
        "urlTemplate": applyURL,
        "actionPlatform": [
          "https://schema.org/DesktopWebPlatform",
          "https://schema.org/MobileWebPlatform"
        ]
      }
    }
  });
  document.head.appendChild(sd);

  // BreadcrumbList — separate JSON-LD block, also recommended by Google
  const bcSd = document.createElement('script');
  bcSd.type = 'application/ld+json';
  bcSd.textContent = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home",     "item": window.location.origin + "/" },
      { "@type": "ListItem", "position": 2, "name": "Listings", "item": window.location.origin + "/listings.html" },
      { "@type": "ListItem", "position": 3, "name": p.title,    "item": window.location.href }
    ]
  });
  document.head.appendChild(bcSd);
  // ── End I-059 ─────────────────────────────────────────────

  document.getElementById('breadcrumbCity').textContent = `${p.city}, ${p.state}`;
  const bcGroup = document.getElementById('breadcrumbTitleGroup');
  const bcTitle = document.getElementById('breadcrumbTitle');
  if (bcTitle && bcGroup) { bcTitle.textContent = p.title; bcGroup.style.display = ''; }

  // Gallery
  allPhotos = p.photo_urls?.length ? p.photo_urls : ['/assets/placeholder-property.jpg'];
  renderGallery(allPhotos);

  // Header
  document.getElementById('detailPrice').innerHTML = `${p.monthly_rent != null ? '$' + Number(p.monthly_rent).toLocaleString() : 'TBD'}<span>/month</span>`;
  document.getElementById('detailTitle').textContent = p.title;
  const _addrUnit = p.unit_number ? ` ${esc(p.unit_number)}` : '';
  document.getElementById('detailAddress').innerHTML = `<i class="fas fa-map-marker-alt"></i> ${esc(p.address)}${_addrUnit}, ${esc(p.city)}, ${esc(p.state)} ${esc(p.zip || '')}`;

  // Listed-by attribution
  if (p.landlords) {
    const ll = p.landlords;
    const name = ll.business_name || ll.contact_name;
    const attr = document.createElement('div');
    attr.className = 'detail-listed-by';
    attr.innerHTML = `<i class="fas fa-user"></i> Listed by <span>${esc(name)}</span>`;
    document.getElementById('detailAddress').insertAdjacentElement('afterend', attr);
  }

  // Meta row
  const metas = [];
  if (p.bedrooms != null) metas.push({ label:'Bedrooms', value: p.bedrooms === 0 ? 'Studio' : p.bedrooms, icon:'fa-bed' });
  if (p.bathrooms) {
    const bathVal = p.half_bathrooms
      ? `${p.bathrooms} + ½`
      : p.bathrooms;
    metas.push({ label:'Bathrooms', value: bathVal, icon:'fa-bath' });
  }
  if (p.square_footage)   metas.push({ label:'Sq. Ft.', value: p.square_footage.toLocaleString(), icon:'fa-ruler-combined' });
  if (p.property_type)    metas.push({ label:'Type', value: capitalize(p.property_type), icon:'fa-home' });
  if (p.pets_allowed != null) metas.push({ label:'Pets', value: p.pets_allowed ? 'Allowed' : 'No Pets', icon:'fa-paw' });
  if (p.year_built)     metas.push({ label:'Year Built', value: p.year_built, icon:'fa-calendar-days' });
  if (p.floors > 1)    metas.push({ label:'Floors', value: p.floors, icon:'fa-layer-group' });
  if (p.lot_size_sqft)  metas.push({ label:'Lot Size', value: Number(p.lot_size_sqft).toLocaleString() + ' sqft', icon:'fa-ruler' });
  document.getElementById('detailMeta').innerHTML = metas.map(m => `
    <div class="detail-meta-item">
      <div class="detail-meta-icon"><i class="fas ${m.icon}"></i></div>
      <div class="detail-meta-text">
        <div class="detail-meta-label">${m.label}</div>
        <div class="detail-meta-value">${esc(m.value)}</div>
      </div>
    </div>`).join('');

  const descEl = document.getElementById('detailDesc');
  const descText = p.description || 'No additional description provided.';
  const descParas = descText.split(/\n+/).map(s => s.trim()).filter(Boolean);
  descEl.innerHTML = descParas.map(s => `<p>${s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>`).join('');
  if (descText.length > 300) {
    descEl.classList.add('truncated');
    const rmBtn = document.createElement('button');
    rmBtn.className = 'detail-read-more';
    rmBtn.innerHTML = '<i class="fas fa-chevron-down" style="font-size:11px"></i> Read more';
    rmBtn.addEventListener('click', () => {
      descEl.classList.remove('truncated');
      rmBtn.remove();
    });
    descEl.insertAdjacentElement('afterend', rmBtn);
  }
  if (p.virtual_tour_url) {
    const vtBtn = document.createElement('a');
    vtBtn.href = /^https?:\/\//i.test(p.virtual_tour_url) ? p.virtual_tour_url : '#';
    vtBtn.target = '_blank';
    vtBtn.rel = 'noopener noreferrer';
    vtBtn.className = 'btn btn-outline';
    vtBtn.style.cssText = 'display:inline-flex;align-items:center;gap:8px;margin-top:14px;font-size:.875rem';
    vtBtn.innerHTML = '<i class="fas fa-vr-cardboard"></i> Virtual Tour';
    descEl.closest('.detail-section').appendChild(vtBtn);
  }

  let hasAmenities = false, hasUtilities = false, hasLease = false;

  if (p.amenities?.length) {
    hasAmenities = true;
    document.getElementById('amenitiesGrid').innerHTML = p.amenities.map(a =>
      `<div class="amenity-item"><i class="fas ${amenityIcon(a)} ${amenityIconColor(a)}"></i>${esc(a)}</div>`).join('');
  }
  if (p.appliances?.length) {
    hasAmenities = true;
    document.getElementById('appliancesSection').style.display = '';
    document.getElementById('appliancesGrid').innerHTML = p.appliances.map(a =>
      `<div class="amenity-item"><i class="fas ${amenityIcon(a)}"></i>${esc(a)}</div>`).join('');
  }
  if (p.flooring?.length) {
    hasAmenities = true;
    const flooringSec = document.getElementById('appliancesSection');
    let flooringDiv = document.getElementById('flooringSection');
    if (!flooringDiv) {
      flooringDiv = document.createElement('div');
      flooringDiv.id = 'flooringSection';
      flooringDiv.style.marginTop = '20px';
      flooringDiv.innerHTML = `
        <div style="font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--m-muted-2);margin-bottom:10px">Flooring</div>
        <div class="amenities-grid" id="flooringGrid"></div>`;
      flooringSec.insertAdjacentElement('afterend', flooringDiv);
    }
    flooringDiv.style.display = '';
    document.getElementById('flooringGrid').innerHTML = p.flooring.map(f =>
      `<div class="amenity-item"><i class="fas fa-layer-group"></i>${esc(f)}</div>`).join('');
  }

  const utilRows = [];
  if (p.utilities_included?.length) utilRows.push(...p.utilities_included.map(u =>
    `<div class="amenity-item"><i class="fas fa-bolt icon-amber"></i>${esc(u)} Included</div>`));
  if (p.parking) utilRows.push(`<div class="amenity-item"><i class="fas fa-car"></i>Parking: ${esc(p.parking)}</div>`);
    if (p.laundry_type) utilRows.push(`<div class="amenity-item"><i class="fas fa-shirt"></i>Laundry: ${esc(p.laundry_type)}</div>`);
    if (p.heating_type) utilRows.push(`<div class="amenity-item"><i class="fas fa-fire"></i>Heating: ${esc(p.heating_type)}</div>`);
    if (p.cooling_type) utilRows.push(`<div class="amenity-item"><i class="fas fa-snowflake"></i>Cooling: ${esc(p.cooling_type)}</div>`);
    if (p.garage_spaces) utilRows.push(`<div class="amenity-item"><i class="fas fa-car-side"></i>Parking Spaces: ${p.garage_spaces}</div>`);
    if (p.parking_fee) utilRows.push(`<div class="amenity-item"><i class="fas fa-dollar-sign icon-amber"></i>Parking Fee: ${Number(p.parking_fee).toLocaleString()}/mo</div>`);
  if (utilRows.length) {
    hasUtilities = true;
    document.getElementById('utilitiesGrid').innerHTML = utilRows.join('');
  }

  const leaseItems = [];
  if (p.lease_terms?.length) leaseItems.push(`<div class="amenity-item"><i class="fas fa-file-contract"></i>${p.lease_terms.map(esc).join(', ')}</div>`);
  if (p.minimum_lease_months) leaseItems.push(`<div class="amenity-item"><i class="fas fa-calendar-check"></i>Min. Lease: ${p.minimum_lease_months} month${p.minimum_lease_months !== 1 ? 's' : ''}</div>`);
  if (p.security_deposit) leaseItems.push(`<div class="amenity-item"><i class="fas fa-shield-alt"></i>Security Deposit: $${Number(p.security_deposit).toLocaleString()}</div>`);
  if (p.last_months_rent) leaseItems.push(`<div class="amenity-item"><i class="fas fa-calendar-alt"></i>Last Month's Rent: $${Number(p.last_months_rent).toLocaleString()}</div>`);
  if (p.admin_fee) leaseItems.push(`<div class="amenity-item"><i class="fas fa-receipt"></i>Admin / Move-in Fee: $${Number(p.admin_fee).toLocaleString()}</div>`);
  if (p.move_in_special) leaseItems.push(`<div class="amenity-item" style="grid-column:1/-1"><i class="fas fa-tag icon-green"></i><span><strong>Move-in Special:</strong> ${esc(p.move_in_special)}</span></div>`);
  if (p.pet_deposit) leaseItems.push(`<div class="amenity-item"><i class="fas fa-paw"></i>Pet Deposit: $${Number(p.pet_deposit).toLocaleString()}</div>`);
  if (p.pet_types_allowed?.length) leaseItems.push(`<div class="amenity-item"><i class="fas fa-paw"></i>Pet Types: ${p.pet_types_allowed.map(esc).join(', ')}</div>`);
  if (p.pet_weight_limit) leaseItems.push(`<div class="amenity-item"><i class="fas fa-weight-scale"></i>Pet Weight Limit: ${esc(p.pet_weight_limit)} lbs max</div>`);
  if (p.pet_details) leaseItems.push(`<div class="amenity-item" style="grid-column:1/-1"><i class="fas fa-paw icon-teal"></i><span><strong>Pet Policy:</strong> ${esc(p.pet_details)}</span></div>`);
  if (p.smoking_allowed != null) leaseItems.push(`<div class="amenity-item"><i class="fas ${p.smoking_allowed ? 'fa-smoking icon-amber' : 'fa-ban icon-rose'}"></i>${p.smoking_allowed ? 'Smoking Permitted' : 'No Smoking'}</div>`);
  if (p.showing_instructions) leaseItems.push(`<div class="amenity-item" style="grid-column:1/-1"><i class="fas fa-key"></i><span><strong>Showings:</strong> ${esc(p.showing_instructions)}</span></div>`);
  if (leaseItems.length) {
    hasLease = true;
    document.getElementById('leaseGrid').innerHTML = leaseItems.join('');
  }

  // Show tabbed section and configure visible tabs
  if (hasAmenities || hasUtilities || hasLease) {
    document.getElementById('detailTabsSection').style.display = '';
    const tabConfig = [
      { tabId: 'tabAmenities', panelId: 'panelAmenities', has: hasAmenities },
      { tabId: 'tabUtilities', panelId: 'panelUtilities', has: hasUtilities },
      { tabId: 'tabLease',     panelId: 'panelLease',     has: hasLease     },
    ];
    let firstActive = null;
    tabConfig.forEach(({ tabId, panelId, has }) => {
      const tabEl   = document.getElementById(tabId);
      const panelEl = document.getElementById(panelId);
      if (has) {
        tabEl.style.display = '';
        if (!firstActive) firstActive = { tabEl, panelEl };
      } else {
        tabEl.style.display = 'none';
        panelEl.classList.remove('active');
      }
    });
    if (firstActive) {
      document.querySelectorAll('.detail-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      document.querySelectorAll('.detail-tab-panel').forEach(pl => pl.classList.remove('active'));
      firstActive.tabEl.classList.add('active');
      firstActive.tabEl.setAttribute('aria-selected', 'true');
      firstActive.panelEl.classList.add('active');
    }
  }

  // Map — Leaflet if lat/lng, fallback to Google embed
  renderMap(p);

  // Open in Maps button
  const mapOpenBtn = document.getElementById('mapOpenBtn');
  if (mapOpenBtn) {
    const mapAddr = encodeURIComponent(`${p.address}, ${p.city}, ${p.state} ${p.zip || ''}`);
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    mapOpenBtn.href = isIOS
      ? `maps://maps.apple.com/?q=${mapAddr}`
      : `https://maps.google.com/maps?q=${mapAddr}`;
    mapOpenBtn.style.display = '';
  }

  const availNow = !p.available_date || new Date(p.available_date) <= new Date();

  // Sidebar
  document.getElementById('sidebarPrice').innerHTML = `${p.monthly_rent != null ? '$' + Number(p.monthly_rent).toLocaleString() : 'TBD'}<span>/month</span>`;
  document.getElementById('sidebarAvail').innerHTML = `<i class="fas fa-circle" style="color:${availNow?'#10b981':'#d4a017'}"></i> ${availNow ? 'Available Now' : 'Available ' + formatDate(p.available_date)}`;
  document.getElementById('sidebarRent').textContent    = `${p.monthly_rent != null ? '$' + Number(p.monthly_rent).toLocaleString() : 'TBD'}`;
  document.getElementById('sidebarDeposit').textContent = p.security_deposit ? `$${Number(p.security_deposit).toLocaleString()}` : 'Contact landlord';
  document.getElementById('sidebarFee').textContent     = (p.application_fee != null && p.application_fee > 0) ? `$${Number(p.application_fee).toLocaleString()}` : 'Free';
  if (p.available_date) {
    document.getElementById('sidebarMoveInRow').style.display = '';
    document.getElementById('sidebarMoveIn').textContent = formatDate(p.available_date);
  }
  if (p.last_months_rent) {
    document.getElementById('sidebarLastMonthRow').style.display = '';
    document.getElementById('sidebarLastMonth').textContent = `${Number(p.last_months_rent).toLocaleString()}`;
  }
  if (p.admin_fee) {
    document.getElementById('sidebarAdminFeeRow').style.display = '';
    document.getElementById('sidebarAdminFee').textContent = `${Number(p.admin_fee).toLocaleString()}`;
  }
  if (p.move_in_special) {
    document.getElementById('sidebarMoveInSpecialRow').style.display = '';
    document.getElementById('sidebarMoveInSpecial').textContent = p.move_in_special;
  }

  // Landlord card
  if (p.landlords) {
    const ll = p.landlords;
    const name = ll.business_name || ll.contact_name;
    const card = document.getElementById('landlordCard');
    card.style.display = 'flex';
    document.getElementById('landlordName').textContent = name;
    if (ll.tagline) document.getElementById('landlordTagline').textContent = ll.tagline;
    const avatarEl = document.getElementById('landlordAvatar');
    if (ll.avatar_url) {
      avatarEl.innerHTML = `<img src="${esc(CONFIG.img(ll.avatar_url,'avatar'))}" alt="${esc(name)}" loading="lazy">`;
      const avatarImg = avatarEl.querySelector('img');
      if (avatarImg) avatarImg.onerror = function() { this.onerror = null; this.src = '/assets/avatar-placeholder.svg'; };
    }
    else avatarEl.textContent = name.charAt(0).toUpperCase();
    if (ll.verified) document.getElementById('landlordVerified').style.display = 'inline';
  }

  // Apply button — wire URL with full property context for form prefill
  const _wireApply = (id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.href = applyURL;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        showToast('Taking you to our secure application portal…', 'info');
        setTimeout(() => { window.location.href = applyURL; }, 700);
      });
    };
    _wireApply('applyBtn');

      // Wire "Track your application" link to internal application portal
      const _trackLink = document.getElementById('trackAppLink');
      if (_trackLink) {
        const _applyBase = (typeof CONFIG !== 'undefined' && CONFIG.APPLY_FORM_URL)
          ? CONFIG.APPLY_FORM_URL
          : '/apply';
        _trackLink.href = _applyBase + '/?path=dashboard';
      }

  // Guard apply button for non-active listings
  if (p.status !== 'active') {
    const applyBtn = document.getElementById('applyBtn');
    applyBtn.removeAttribute('href');
    applyBtn.style.pointerEvents = 'none';
    applyBtn.style.opacity       = '0.5';
    applyBtn.style.cursor        = 'not-allowed';
    applyBtn.innerHTML = `<i class="fas fa-ban" style="font-size:14px"></i> ${p.status === 'rented' ? 'No Longer Available' : 'Not Currently Available'}`;
    document.getElementById('sidebarAvail').innerHTML = `<i class="fas fa-circle" style="color:#c0392b"></i> ${p.status === 'rented' ? 'Rented' : 'Unavailable'}`;
  }

  // Mobile sticky Apply bar — only for active listings
  if (p.status === 'active') {
    document.getElementById('mobBarRent').textContent = `${p.monthly_rent != null ? '$' + Number(p.monthly_rent).toLocaleString() + '/mo' : 'Rent TBD'}`;
    _wireApply('mobApplyBtn');
    document.getElementById('mobile-apply-bar').classList.add('active');
    document.body.classList.add('mob-bar-active');
  }

  // Save button state
  const saveBtn = document.getElementById('savePropBtn');
  if (savedIds.has(p.id)) saveBtn.innerHTML = '<i class="fas fa-heart" style="color:#dc2626"></i> Saved';
  saveBtn.addEventListener('click', () => toggleSave(p.id, saveBtn));
}

/* ── Leaflet mini-map (lazy-loaded via IntersectionObserver) ── */
// M-10: Leaflet CSS+JS (~180KB gzipped) is only injected when the map
// container scrolls into the viewport, saving bandwidth on every page visit.
const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const LEAFLET_JS  = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';

function loadLeaflet() {
  return new Promise((resolve, reject) => {
    if (window.L) { resolve(); return; }
    // Inject CSS first (non-blocking)
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    }
    // Inject JS and resolve when loaded
    const script = document.createElement('script');
    script.src = LEAFLET_JS;
    script.crossOrigin = 'anonymous';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function _initLeafletMap(p) {
  const container = document.getElementById('mapContainer');
  const lat = parseFloat(p.lat);
  const lng = parseFloat(p.lng);
  container.innerHTML = '<div id="propertyMiniMap"></div>';
  const map = L.map('propertyMiniMap', { zoomControl: true, scrollWheelZoom: false }).setView([lat, lng], 15);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        maxZoom: 19
      }).addTo(map);
  const icon = L.divIcon({
    className: '',
    html: `<div style="background:#0e0e0f;color:white;padding:6px 12px;border-radius:20px;font-weight:700;font-size:12px;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3)">${p.monthly_rent != null ? '$' + Number(p.monthly_rent).toLocaleString() + '/mo' : 'Rent TBD'}</div>`,
    iconAnchor: [45, 16], iconSize: [90, 32]
  });
  L.marker([lat, lng], { icon }).addTo(map).bindPopup(`<b>${p.title}</b><br>${p.address}`);
}

function renderMap(p) {
  const container = document.getElementById('mapContainer');
  if (p.lat && p.lng) {
    const lat = parseFloat(p.lat);
    const lng = parseFloat(p.lng);
    if (!isNaN(lat) && !isNaN(lng)) {
      // Use IntersectionObserver to defer Leaflet load until map is in viewport
      const observer = new IntersectionObserver((entries, obs) => {
        if (!entries[0].isIntersecting) return;
        obs.disconnect();
        loadLeaflet()
          .then(() => _initLeafletMap(p))
          .catch(() => {
            // Leaflet failed to load — fall back to Google embed
            const mapAddr = encodeURIComponent(`${p.address}, ${p.city}, ${p.state} ${p.zip}`);
            container.innerHTML = `<iframe src="https://maps.google.com/maps?q=${mapAddr}&output=embed&z=15" title="Property location" loading="lazy" style="width:100%;height:100%;border:none"></iframe>`;
          });
      }, { rootMargin: '200px' });
      observer.observe(container);
      return;
    }
  }
  // Fallback: Google embed (no lat/lng available)
  const mapAddr = encodeURIComponent(`${p.address}, ${p.city}, ${p.state} ${p.zip}`);
  document.getElementById('mapAddressLabel').textContent = `${p.address}, ${p.city}`;
  container.innerHTML = `<iframe src="https://maps.google.com/maps?q=${mapAddr}&output=embed&z=15" title="Property location" loading="lazy" style="width:100%;height:100%;border:none"></iframe>`;
}

/* ── Gallery Mosaic ── */
function renderGallery(photos) {
  photoIndex = 0;
  const mainImg    = document.getElementById('mosaicMainImg');
  const mosaicMain = document.getElementById('mosaicMain');
  const mosaicSide = document.getElementById('mosaicSide');
  const expandBtn  = document.getElementById('mosaicExpandBtn');
  const mobileCount = document.getElementById('mosaicMobileCount');
  const prevBtn    = document.getElementById('mosaicPrev');
  const nextBtn    = document.getElementById('mosaicNext');

  // Remove skeleton once we have real photos to show
  document.getElementById('gallery').classList.remove('skeleton-loading');

  // Hero image — LCP candidate, load at high priority with srcset for retina
  mainImg.src    = CONFIG.img(photos[0], 'gallery');
  mainImg.srcset = `${CONFIG.img(photos[0], 'card')} 600w, ${CONFIG.img(photos[0], 'gallery')} 1200w, ${CONFIG.img(photos[0], 'gallery_2x')} 2400w`;
  mainImg.sizes  = '(max-width: 768px) 100vw, (max-width: 1280px) 65vw, 55vw';
  mainImg.alt    = 'Property photo 1';
  mainImg.onerror = function() { this.onerror = null; this.srcset = ''; this.src = '/assets/placeholder-property.jpg'; };

  // LQIP blur-up for hero image — tiny blurred placeholder fades out once full image loads
  const heroLqip = lqipUrl(photos[0]);
  if (heroLqip) {
    const lqBg = document.createElement('div');
    lqBg.className = 'lqip-bg';
    lqBg.style.backgroundImage = `url('${heroLqip}')`;
    mosaicMain.insertBefore(lqBg, mainImg);
    const fadeLqip = () => lqBg.classList.add('faded');
    mainImg.addEventListener('load', fadeLqip, { once: true });
    if (mainImg.complete && mainImg.naturalWidth > 0) fadeLqip();
  }

  mosaicMain.addEventListener('click', () => openLightbox(0));

  // Side 2×2 grid — use gallery preset for crisp quality, lazy-load each cell
  const sidePanels = photos.slice(1, 5);
  if (sidePanels.length > 0) {
    mosaicSide.innerHTML = sidePanels.map((url, i) => {
      const idx = i + 1;
      const isLast = (i === sidePanels.length - 1) && (photos.length > 5);
      const remaining = photos.length - 5;
      const lqUrl = lqipUrl(url);
      return `
        <div class="mosaic-cell" data-idx="${idx}">
          ${lqUrl ? `<div class="lqip-bg" style="background-image:url('${lqUrl}')"></div>` : ''}
          <img src="${CONFIG.img(url,'gallery')}"
               srcset="${CONFIG.img(url,'gallery')} 1x, ${CONFIG.img(url,'gallery_2x')} 2x"
               sizes="(max-width: 768px) 50vw, 25vw"
               alt="Property photo ${idx+1}"
               loading="${i === 0 ? 'eager' : 'lazy'}"
               ${i === 0 ? 'fetchpriority="high"' : ''}
               decoding="async">
          ${isLast ? `
            <div class="mosaic-cell-overlay">
              <span class="mosaic-overlay-icon"><i class="fas fa-images"></i></span>
              <span class="mosaic-overlay-label">+${remaining} more</span>
            </div>` : ''}
        </div>`;
    }).join('');
    // Fade out each cell's LQIP placeholder once its image loads;
    // wire CSP-safe onerror via JS (not HTML attribute — blocked by nonce CSP)
    mosaicSide.querySelectorAll('.mosaic-cell').forEach(cell => {
      cell.addEventListener('click', () => openLightbox(parseInt(cell.dataset.idx)));
      const img = cell.querySelector('img');
      const bg  = cell.querySelector('.lqip-bg');
      if (img) {
        img.onerror = function() { this.onerror = null; this.srcset = ''; this.src = '/assets/placeholder-property.jpg'; };
        if (bg) {
          const fadeBg = () => bg.classList.add('faded');
          img.addEventListener('load', fadeBg, { once: true });
          if (img.complete && img.naturalWidth > 0) fadeBg();
        }
      }
    });
  } else {
    mosaicSide.style.display = 'none';
    document.getElementById('gallery').style.gridTemplateColumns = '1fr';
  }

  expandBtn.innerHTML = `<i class="fas fa-th-large"></i> <span class="mosaic-expand-label">See All Photos</span> <span class="mosaic-photo-count">${photos.length}</span>`;
  expandBtn.addEventListener('click', () => openLightbox(0));

  if (mobileCount) mobileCount.textContent = `1 / ${photos.length}`;
  prevBtn.addEventListener('click', () => showPhoto((photoIndex - 1 + photos.length) % photos.length));
  nextBtn.addEventListener('click', () => showPhoto((photoIndex + 1) % photos.length));

  // Touch swipe on mosaic (mobile carousel) — velocity-aware
  let touchX = 0, touchT = 0;
  mosaicMain.addEventListener('touchstart', e => {
    touchX = e.touches[0].clientX;
    touchT = Date.now();
  }, { passive: true });
  mosaicMain.addEventListener('touchend', e => {
    const diff = touchX - e.changedTouches[0].clientX;
    const dt   = Date.now() - touchT;
    const vel  = Math.abs(diff) / dt; // px/ms
    if (Math.abs(diff) > 30 || vel > 0.3) {
      showPhoto((photoIndex + (diff > 0 ? 1 : -1) + photos.length) % photos.length);
    }
  }, { passive: true });

  // Keyboard — lightbox arrows + escape
  document.addEventListener('keydown', e => {
    if (document.getElementById('lightbox').classList.contains('open')) {
      if (e.key === 'ArrowLeft')  lightboxNav(-1);
      if (e.key === 'ArrowRight') lightboxNav(1);
      if (e.key === 'Escape')     closeLightbox();
    }
  });

  document.getElementById('galleryExpand').addEventListener('click', () => openLightbox(photoIndex));

  // Build thumbnail strip
  buildGalleryStrip(photos);
}

/* ── Thumbnail Strip ── */
function buildGalleryStrip(photos) {
  const strip = document.getElementById('galleryStrip');
  if (!strip) return;
  if (photos.length < 2) { strip.style.display = 'none'; return; }

  strip.innerHTML = photos.map((url, i) => `
    <button class="gallery-strip-thumb${i === 0 ? ' active' : ''}"
            data-idx="${i}" role="listitem"
            aria-label="View photo ${i + 1}" aria-pressed="${i === 0 ? 'true' : 'false'}">
      <img src="${CONFIG.img(url, 'strip')}"
           srcset="${CONFIG.img(url, 'strip')} 1x, ${CONFIG.img(url, 'thumb')} 2x"
           alt="Photo ${i + 1}"
           loading="${i < 5 ? 'eager' : 'lazy'}"
           decoding="async">
    </button>`).join('');

  strip.querySelectorAll('.gallery-strip-thumb').forEach(btn => {
    btn.addEventListener('click', () => showPhoto(parseInt(btn.dataset.idx)));
  });
}

function syncStripActive(idx) {
  const thumbs = document.querySelectorAll('.gallery-strip-thumb');
  thumbs.forEach((t, i) => {
    const active = i === idx;
    t.classList.toggle('active', active);
    t.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const activeThumb = document.querySelector('.gallery-strip-thumb.active');
  if (activeThumb) {
    activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
}

function showPhoto(idx) {
  photoIndex = idx;
  const mainImg = document.getElementById('mosaicMainImg');
  mainImg.style.opacity = '0';
  mainImg.style.transition = 'opacity 150ms';
  setTimeout(() => {
    mainImg.src    = CONFIG.img(allPhotos[idx], 'gallery');
    mainImg.srcset = `${CONFIG.img(allPhotos[idx], 'card')} 600w, ${CONFIG.img(allPhotos[idx], 'gallery')} 1200w, ${CONFIG.img(allPhotos[idx], 'gallery_2x')} 2400w`;
    mainImg.alt    = `Property photo ${idx + 1}`;
    mainImg.style.opacity = '1';
  }, 150);
  const mobileCount = document.getElementById('mosaicMobileCount');
  if (mobileCount) mobileCount.textContent = `${idx + 1} / ${allPhotos.length}`;
  syncStripActive(idx);
}

/* ── Lightbox ── */
let lightboxThumbsBuilt = false;
let _lbOpener = null;  // element that opened the lightbox — restored on close

// Focus trap — keep keyboard navigation inside the lightbox while open
function _lbFocusTrap(e) {
  const lb = document.getElementById('lightbox');
  if (!lb.classList.contains('open')) return;
  const focusable = lb.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];
  if (e.key === 'Tab') {
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
    }
  }
}

function openLightbox(idx) {
  _lbOpener = document.activeElement;
  const lb = document.getElementById('lightbox');
  lb.classList.add('open');
  document.body.style.overflow = 'hidden';
  if (!lightboxThumbsBuilt) {
    buildLightboxThumbs();
    lightboxThumbsBuilt = true;
  }
  lightboxShow(idx);
  document.addEventListener('keydown', _lbFocusTrap);
  // Move keyboard focus into the lightbox for accessibility
  requestAnimationFrame(() => document.getElementById('lightboxClose').focus());
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
  document.removeEventListener('keydown', _lbFocusTrap);
  // Return focus to the element that triggered the lightbox
  if (_lbOpener && typeof _lbOpener.focus === 'function') _lbOpener.focus();
  _lbOpener = null;
}

function buildLightboxThumbs() {
  const thumbsEl = document.getElementById('lightboxThumbs');
  if (!thumbsEl || !allPhotos.length) return;
  thumbsEl.innerHTML = allPhotos.map((url, i) =>
    `<button class="lb-thumb" data-idx="${i}" aria-label="View photo ${i + 1}">
      <img src="${CONFIG.img(url, 'thumb')}" alt="" loading="lazy" decoding="async">
    </button>`
  ).join('');
  thumbsEl.querySelectorAll('.lb-thumb').forEach(btn => {
    btn.addEventListener('click', () => lightboxShow(parseInt(btn.dataset.idx)));
  });
}

let _lbNavDir = 0;  // -1 = prev, 1 = next, 0 = direct click

function lightboxShow(idx) {
  photoIndex = idx;
  const wrap    = document.getElementById('lightboxImgWrap');
  const img     = document.getElementById('lightboxImg');
  const spinner = document.getElementById('lbSpinner');
  const lqipBg  = document.getElementById('lbLqipBg');

  // Directional slide-out animation on previous image
  if (_lbNavDir !== 0) {
    const outClass = _lbNavDir > 0 ? 'slide-out-left' : 'slide-out-right';
    wrap.classList.remove('slide-in-left', 'slide-in-right', 'slide-out-left', 'slide-out-right');
    wrap.classList.add(outClass);
  }

  const slideInClass = _lbNavDir > 0 ? 'slide-in-left' : _lbNavDir < 0 ? 'slide-in-right' : null;

  // Show LQIP blur-up while the full image loads
  if (lqipBg) {
    const lqip = lqipUrl(allPhotos[idx]);
    if (lqip) {
      lqipBg.style.backgroundImage = `url('${lqip}')`;
      lqipBg.classList.remove('faded');
      lqipBg.classList.add('visible');
    } else {
      lqipBg.classList.remove('visible');
    }
  }

  setTimeout(() => {
    // Hide image and show spinner while new src loads
    img.classList.add('loading');
    spinner.classList.add('visible');

    wrap.classList.remove('slide-in-left', 'slide-in-right', 'slide-out-left', 'slide-out-right');

    // Full-quality lightbox image with srcset for retina screens
    const newSrc = CONFIG.img(allPhotos[idx], 'lightbox');
    img.src    = newSrc;
    img.srcset = `${CONFIG.img(allPhotos[idx], 'gallery')} 1200w, ${CONFIG.img(allPhotos[idx], 'gallery_2x')} 2400w, ${CONFIG.img(allPhotos[idx], 'lightbox')} 4000w`;
    img.sizes  = '100vw';
    img.alt    = `Property photo ${idx + 1}`;

    const reveal = () => {
      img.classList.remove('loading');
      spinner.classList.remove('visible');
      // Fade out the LQIP once the real image has loaded
      if (lqipBg) { lqipBg.classList.add('faded'); }
      if (slideInClass) {
        wrap.classList.add(slideInClass);
        // Clean up animation class after it completes
        const cleanup = () => { wrap.classList.remove(slideInClass); wrap.removeEventListener('animationend', cleanup); };
        wrap.addEventListener('animationend', cleanup, { once: true });
      }
      // Preload surrounding images for instant navigation
      preloadLightboxAdjacentImages(idx);
    };

    if (img.complete && img.naturalWidth > 0) {
      reveal();
    } else {
      img.addEventListener('load',  reveal, { once: true });
      img.addEventListener('error', reveal, { once: true });
    }
  }, _lbNavDir !== 0 ? 120 : 0);

  document.getElementById('lightboxCounter').textContent = `${idx + 1} / ${allPhotos.length}`;

  // Sync lightbox filmstrip
  document.querySelectorAll('.lb-thumb').forEach((t, i) => {
    t.classList.toggle('active', i === idx);
  });
  const activeThumb = document.querySelector('.lb-thumb.active');
  if (activeThumb) {
    activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  // Also sync the main page thumbnail strip so it tracks lightbox navigation
  syncStripActive(idx);
}

function lightboxNav(dir) {
  _lbNavDir = dir;
  lightboxShow((photoIndex + dir + allPhotos.length) % allPhotos.length);
  _lbNavDir = 0;
}

/* Lightbox swipe support — velocity-aware */
(function() {
  let lbTouchX = 0, lbTouchT = 0;
  const lb = document.getElementById('lightbox');
  lb.addEventListener('touchstart', e => {
    lbTouchX = e.touches[0].clientX;
    lbTouchT = Date.now();
  }, { passive: true });
  lb.addEventListener('touchend', e => {
    const diff = lbTouchX - e.changedTouches[0].clientX;
    const dt   = Date.now() - lbTouchT;
    const vel  = Math.abs(diff) / dt; // px/ms
    if (Math.abs(diff) > 30 || vel > 0.3) lightboxNav(diff > 0 ? 1 : -1);
  }, { passive: true });
})();

document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
document.getElementById('lightboxPrev').addEventListener('click', () => lightboxNav(-1));
document.getElementById('lightboxNext').addEventListener('click', () => lightboxNav(1));
document.getElementById('lightbox').addEventListener('click', e => {
  if (e.target === document.getElementById('lightbox') ||
      e.target === document.getElementById('lightboxImgWrap')) closeLightbox();
});

/* ── Inquiry ── */
document.getElementById('inqMessage').addEventListener('input', function() {
  document.getElementById('inqCharCount').textContent = this.value.length;
});

let inquiryCooldown = false;
document.getElementById('sendInquiryBtn').addEventListener('click', async () => {
  if (inquiryCooldown) { showToast('Please wait before sending another message.', 'info'); return; }

  const name    = document.getElementById('inqName').value.trim();
  const email   = document.getElementById('inqEmail').value.trim();
  const phone   = document.getElementById('inqPhone').value.trim();
  const message = document.getElementById('inqMessage').value.trim();
  if (!name || !email || !message) { showToast('Please fill in name, email, and message.', 'error'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast('Please enter a valid email address.', 'error'); return; }

  const btn = document.getElementById('sendInquiryBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-pulse"></i> Sending\u2026';

  // Use CP.Inquiries.submit() so the edge function fires confirmation + landlord emails.
  const { error } = await CP.Inquiries.submit({
    property_id:  currentProperty.id,
    tenant_name:  name,
    tenant_email: email,
    tenant_phone: phone || null,
    message
  });

  if (error) {
    showToast('Failed to send. Please try again.', 'error');
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Message';
  } else {
    showToast('Message sent! The landlord will be in touch soon.', 'success');
    btn.innerHTML = '<i class="fas fa-check"></i> Sent!';

    // Clear form fields after successful send
    document.getElementById('inqName').value    = '';
    document.getElementById('inqEmail').value   = '';
    document.getElementById('inqPhone').value   = '';
    document.getElementById('inqMessage').value = '';

    // 60-second rate limit cooldown
    inquiryCooldown = true;
    let secs = 60;
    const countdown = setInterval(() => {
      secs--;
      if (secs <= 0) {
        clearInterval(countdown);
        inquiryCooldown = false;
        btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Message';
        btn.disabled = false;
      } else {
        btn.innerHTML = `<i class="fas fa-clock"></i> Wait ${secs}s`;
      }
    }, 1000);
  }
});

/* ── Detail Tabs ── */
document.getElementById('detailTabs')?.addEventListener('click', e => {
  const tab = e.target.closest('.detail-tab');
  if (!tab || tab.classList.contains('active')) return;
  document.querySelectorAll('.detail-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  document.querySelectorAll('.detail-tab-panel').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');
  tab.setAttribute('aria-selected', 'true');
  const panelId = tab.dataset.panel;
  document.getElementById(panelId)?.classList.add('active');
});

/* ── Contact Drawer (mobile) ── */
(function() {
  const contactCard     = document.getElementById('contactCard');
  const drawerOverlay   = document.getElementById('contactDrawerOverlay');
  const mobMsgBtn       = document.getElementById('mobMsgBtn');
  const drawerCloseBtn  = document.getElementById('contactDrawerCloseBtn');

  function openContactDrawer() {
    contactCard?.classList.add('drawer-open');
    drawerOverlay?.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
  function closeContactDrawer() {
    contactCard?.classList.remove('drawer-open');
    drawerOverlay?.classList.remove('active');
    document.body.style.overflow = '';
  }

  mobMsgBtn?.addEventListener('click', openContactDrawer);
  drawerOverlay?.addEventListener('click', closeContactDrawer);
  drawerCloseBtn?.addEventListener('click', closeContactDrawer);
})();

/* ── Share & Save ── */
window.shareProp = () => {
  if (navigator.share) navigator.share({ title: currentProperty?.title, url: window.location.href });
  else { navigator.clipboard.writeText(window.location.href); showToast('Link copied!', 'success'); }
};

async function toggleSave(id, btn) {
  btn.disabled = true;
  try {
    const { saved } = await SavedProperties.toggle(id);
    if (saved) {
      savedIds.add(id);
      btn.innerHTML = '<i class="fas fa-heart" style="color:#dc2626"></i> Saved';
      showToast('Property saved!', 'success');
    } else {
      savedIds.delete(id);
      btn.innerHTML = '<i class="far fa-heart"></i> Save';
    }
  } catch(_) {
    // Fallback: localStorage only
    if (savedIds.has(id)) {
      savedIds.delete(id); btn.innerHTML = '<i class="far fa-heart"></i> Save';
    } else {
      savedIds.add(id); btn.innerHTML = '<i class="fas fa-heart" style="color:#dc2626"></i> Saved';
      showToast('Property saved!', 'success');
    }
    localStorage.setItem('cp_saved', JSON.stringify([...savedIds]));
  } finally {
    btn.disabled = false;
  }
}

/* ── Helpers ── */
function setMeta(id, val) { document.getElementById(id)?.setAttribute('content', val); }
function formatDate(str) {
  // Append T00:00:00 so JS parses as local time, not UTC midnight (avoids day-off bug)
  const d = new Date(str.includes('T') ? str : str + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ── LQIP helper — delegates to CP.UI.lqipUrl (defined in cp-api.js) ── */
function lqipUrl(url) { return CP.UI.lqipUrl(url); }

/* ── Preload ±2 adjacent lightbox images for instant prev/next navigation ── */
function preloadLightboxAdjacentImages(idx) {
  const n = allPhotos.length;
  if (n < 2) return;
  [-1, 1, -2, 2].forEach(offset => {
    const i = (idx + offset + n) % n;
    if (i !== idx) {
      const pre = new Image();
      pre.src = CONFIG.img(allPhotos[i], 'lightbox');
    }
  });
}


