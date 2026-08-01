// ============================================================
// Pages Function: /rent/<state>/<city>/<slug>
// ============================================================
// Edge-rendered property detail page — Phase C of the Properties
// improvement plan (.local/plans/properties/).
//
// What it does:
//   1. Extracts the property id from the trailing prop-XXXXXXXX
//      token in the slug.
//   2. Fetches the property (anon key, status='active' enforced
//      by RLS) and its photos.
//   3. Loads the static /property.html shell from the asset
//      bucket and rewrites the <head> with per-property title,
//      description, OG/Twitter tags, canonical URL, and a
//      RealEstateListing JSON-LD block — so search engines and
//      social previews see the right data on the first byte.
//   4. The body is unchanged; the existing js/property.js still
//      hydrates the rest of the page client-side (gallery,
//      apply CTA, etc).
//
// Caching: 5min browser, 10min edge, 24h SWR. The CSP nonce
// rewrite happens in functions/_middleware.js after this
// function returns.
// ============================================================

const ID_RE = /(prop-[a-z0-9]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(s) {
  // For HTML attributes — covers the same cases as escHtml.
  return escHtml(s);
}

function trim(s, n) {
  if (s == null) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).trim() + '…' : s;
}

function notFound(msg) {
  return new Response(msg || 'Property not found', {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60, s-maxage=60',
    },
  });
}

function makeJsonLd(p, photos, canonicalUrl) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': ['RealEstateListing', 'Product'],
    name: p.title || `Rental in ${p.city}, ${p.state}`,
    url: canonicalUrl,
    image: photos.slice(0, 8).map(ph => ph.url),
    datePosted: p.created_at || undefined,
    address: {
      '@type': 'PostalAddress',
      streetAddress: p.address || undefined,
      addressLocality: p.city || undefined,
      addressRegion: p.state || undefined,
      postalCode: p.zip || undefined,
      addressCountry: 'US',
    },
  };
  if (p.description) ld.description = trim(p.description, 500);
  if (p.lat != null && p.lng != null) {
    ld.geo = {
      '@type': 'GeoCoordinates',
      latitude: Number(p.lat),
      longitude: Number(p.lng),
    };
  }
  if (p.monthly_rent) {
    ld.offers = {
      '@type': 'Offer',
      price: Number(p.monthly_rent),
      priceCurrency: 'USD',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: Number(p.monthly_rent),
        priceCurrency: 'USD',
        unitCode: 'MON',
      },
      availability: 'https://schema.org/InStock',
      url: canonicalUrl,
    };
    if (p.available_date) ld.offers.availabilityStarts = p.available_date;
  }
  if (p.bedrooms != null) ld.numberOfRooms = Number(p.bedrooms);
  if (p.bathrooms != null) ld.numberOfBathroomsTotal = Number(p.bathrooms);
  if (p.square_footage) {
    ld.floorSize = {
      '@type': 'QuantitativeValue',
      value: Number(p.square_footage),
      unitCode: 'FTK', // square feet
    };
  }
  if (p.pets_allowed != null) ld.petsAllowed = !!p.pets_allowed;
  if (p.year_built) ld.yearBuilt = Number(p.year_built);

  // Strip undefined values so the JSON is clean.
  return JSON.stringify(ld, (_k, v) => (v === undefined ? undefined : v));
}

function buildMetaDescription(p) {
  const parts = [];
  if (p.bedrooms != null) parts.push(p.bedrooms === 0 ? 'Studio' : `${p.bedrooms}BR`);
  if (p.bathrooms) parts.push(`${p.bathrooms}BA`);
  if (p.square_footage) parts.push(`${Number(p.square_footage).toLocaleString()} sqft`);
  if (p.monthly_rent) parts.push(`$${Number(p.monthly_rent).toLocaleString()}/mo`);
  const head = parts.length ? parts.join(' · ') + '. ' : '';
  const where = `${p.city}, ${p.state}.`;
  const desc = p.description ? ' ' + trim(p.description, 200) : '';
  return trim(head + where + desc, 300);
}

function buildPageTitle(p) {
  const beds = p.bedrooms == null ? '' : (p.bedrooms === 0 ? 'Studio ' : `${p.bedrooms}BR `);
  const type = p.property_type ? p.property_type + ' ' : '';
  return trim(
    `${beds}${type}for Rent in ${p.city}, ${p.state} — Choice Properties`,
    65
  );
}

export async function onRequestGet({ env, params, request }) {
  const SUPA = env.SUPABASE_URL;
  const ANON = env.SUPABASE_ANON_KEY;
  const SITE = env.SITE_URL || new URL(request.url).origin;

  if (!SUPA || !ANON) return notFound('Backend not configured');

  // 1. Extract id (last prop-XXXXXXXX token in the slug)
  const slug = params.slug || '';
  const match = slug.match(ID_RE);
  if (!match) return notFound();
  // Normalise to lowercase for the URL; use ilike for the DB lookup so both
  // old lowercase IDs (prop-ajeh3ktf) and uppercase IDs (PROP-AC002CE4) match.
  const propertyIdLower = match[1].toLowerCase();

  // 2. Fetch property first (ilike = case-insensitive eq with no wildcards),
  //    then fetch photos using the exact id returned by the DB.
  const propRes = await fetch(
    `${SUPA}/rest/v1/properties?id=ilike.${encodeURIComponent(propertyIdLower)}` +
      `&status=eq.active` +
      `&select=id,title,description,address,city,state,zip,lat,lng,property_type,` +
      `bedrooms,bathrooms,square_footage,monthly_rent,security_deposit,available_date,` +
      `pets_allowed,year_built,created_at,updated_at`,
    {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
      cf: { cacheTtl: 60, cacheEverything: false },
    }
  );

  if (!propRes.ok) return notFound('Property lookup failed');
  const propArr = await propRes.json();
  if (!Array.isArray(propArr) || propArr.length === 0) return notFound();
  const p = propArr[0];

  // Use the exact id from the DB row so the FK lookup always matches.
  const photosRes = await fetch(
    `${SUPA}/rest/v1/property_photos?property_id=eq.${encodeURIComponent(p.id)}` +
      `&select=url,display_order&order=display_order.asc&limit=8`,
    { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } }
  );
  const photos = photosRes.ok ? await photosRes.json() : [];

  // 3. Canonical URL — always trailing slash, lower-cased state.
  // We rebuild it from the row to make sure the slug is normalized.
  const beds = p.bedrooms == null ? 'home' : (p.bedrooms === 0 ? 'studio' : `${p.bedrooms}br`);
  const slugSeg = s => String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const canonicalPath =
    `/rent/${(p.state || '').toLowerCase().slice(0, 2)}` +
    `/${slugSeg(p.city) || 'us'}` +
    `/${beds}-${slugSeg(p.property_type) || 'home'}-${propertyIdLower}/`;
  const canonicalUrl = `${SITE}${canonicalPath}`;

  // If the user landed on a non-canonical version of the slug, 301 to canonical.
  const reqUrl = new URL(request.url);
  if (reqUrl.pathname.replace(/\/+$/, '/') !== canonicalPath) {
    return new Response(null, {
      status: 301,
      headers: {
        location: canonicalUrl,
        'cache-control': 'public, max-age=86400, s-maxage=86400',
      },
    });
  }

  // 4. Load the static property.html shell
  const shellRes = await env.ASSETS.fetch(new URL('/property.html', request.url));
  if (!shellRes.ok) {
    return new Response('Shell unavailable', { status: 502 });
  }
  let html = await shellRes.text();

  // 5. Compute per-property head values
  const title = buildPageTitle(p);
  const desc = buildMetaDescription(p);
  const heroImg = (photos[0] && photos[0].url) || '';
  const ld = makeJsonLd(p, photos, canonicalUrl);

  // 6. Surgical replacements against the placeholders shipped in property.html.
  // Each replace targets a unique attribute string so order/whitespace
  // changes elsewhere in the file won't accidentally break a substitution.
  const swap = (needle, replacement) => {
    if (html.includes(needle)) html = html.replace(needle, replacement);
  };

  swap(
    '<title>Property — Choice Properties</title>',
    `<title>${escHtml(title)}</title>`
  );
  swap(
    '<meta name="description" content="View property details and apply online.">',
    `<meta name="description" content="${escAttr(desc)}">`
  );

  // OG tags
  swap(
    'id="ogTitle"       content="Rental Property — Choice Properties"',
    `id="ogTitle"       content="${escAttr(title)}"`
  );
  swap(
    'id="ogDescription" content="View property details and apply online."',
    `id="ogDescription" content="${escAttr(desc)}"`
  );
  swap(
    'id="ogUrl"         content=""',
    `id="ogUrl"         content="${escAttr(canonicalUrl)}"`
  );
  swap(
    'id="ogImage"       content=""',
    `id="ogImage"       content="${escAttr(heroImg)}"`
  );

  // Twitter tags
  swap(
    'id="twTitle"       content="Rental Property"',
    `id="twTitle"       content="${escAttr(title)}"`
  );
  swap(
    'id="twDescription" content="View property details and apply online."',
    `id="twDescription" content="${escAttr(desc)}"`
  );
  swap(
    'id="twImage"       content=""',
    `id="twImage"       content="${escAttr(heroImg)}"`
  );

  // Canonical link + JSON-LD: inject before </head>. property.html does
  // not currently ship a placeholder, so we insert next to the existing
  // preconnects via a stable anchor: the closing </head>.
  const headInjection =
    `<link rel="canonical" href="${escAttr(canonicalUrl)}">\n` +
    `<script type="application/ld+json" nonce="__CSP_NONCE__">${ld.replace(/</g, '\\u003c')}</script>\n`;
  html = html.replace('</head>', headInjection + '</head>');

  // Pass the property id to the client so js/property.js can hydrate
  // without needing a second fetch for the row data later. Kept on a
  // hidden element so the existing JS keeps reading window.location.
  // (No-op for current code; useful when js/property.js is updated to
  // accept pre-fetched data — that's a separate phase.)

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=86400',
      'cache-tag': `property:${propertyIdLower}`,
    },
  });
}
