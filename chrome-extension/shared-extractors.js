// ============================================================
// Choice Properties — Multi-site Listing Extractor Registry
// GENERATED FILE — DO NOT EDIT DIRECTLY.
// Edit src/extractors/shared-extractors.js and run:
//   node scripts/build-extractors.js
// ============================================================
// ============================================================
// Choice Properties — Canonical Multi-site Listing Extractor
// ============================================================
// THIS IS THE SINGLE SOURCE OF TRUTH for all listing extraction.
// Do NOT edit the generated copies in:
//   - chrome-extension/shared-extractors.js
//   - .pages-orion/live-shared-extractors.js
//   - supabase/functions/_shared/zillow-extract.ts
//
// To update: edit this file, then run: node scripts/build-extractors.js
// This generates all runtime variants from this one source.
//
// Supported sites: Zillow, Realtor.com, Apartments.com, Redfin
// ============================================================
(function (global) {
  'use strict';

  // ── DOM helpers ──────────────────────────────────────────────
  function getNextData(source) {
    if (!source) return null;
    if (typeof source.getElementById === 'function') {
      const el = source.getElementById('__NEXT_DATA__');
      if (!el) return null;
      try { return JSON.parse(el.textContent); } catch (_) { return null; }
    }
    if (typeof source === 'string') {
      try { return JSON.parse(source); } catch (_) { return null; }
    }
    if (typeof source === 'object') {
      return source;
    }
    return null;
  }

  function walk(obj, path) {
    let node = obj;
    for (const key of path) {
      if (!node || typeof node !== 'object') return null;
      node = node[key];
    }
    return node;
  }

  // ── Value helpers ────────────────────────────────────────────
  function bestJpeg(ms) {
    const jpegs = (ms && ms.jpeg) || [];
    let best = null, bestW = 0;
    for (const j of jpegs) { if ((j.width || 0) > bestW) { bestW = j.width || 0; best = j.url || null; } }
    return best;
  }

  // Zillow CDN serves the same photo at multiple variant suffixes.
  // Dedup by base image hash, keep highest-resolution variant.
  function dedupZillowPhotos(urls) {
    const byHash = new Map();
    const scoreOf = (u) => {
      if (/-uncropped_scaled_within_1536_1152\.jpg/.test(u)) return 3;
      if (/-cc_ft_1536\.jpg/.test(u)) return 2;
      if (/-p_h\.jpg/.test(u)) return 1;
      return 0;
    };
    for (const u of urls) {
      const m = u.match(/\/fp\/([a-f0-9]{16,})-/i);
      const hash = m ? m[1] : u;
      const score = scoreOf(u);
      const cur = byHash.get(hash);
      if (!cur || score > cur.score) byHash.set(hash, { url: u, score });
    }
    return [...byHash.values()].map(v => v.url);
  }

  function collectPhotos(prop) {
    const photos = [], seen = new Set();
    const add = (u) => { if (u && typeof u === 'string' && u.startsWith('http') && !seen.has(u)) { photos.push(u); seen.add(u); } };
    for (const p of (prop.responsivePhotosOriginalRatio || [])) add(bestJpeg(p.mixedSources) || p.url);
    for (const p of (prop.responsivePhotos || []))              add(bestJpeg(p.mixedSources) || p.url);
    for (const p of (prop.hugePhotos || prop.largePhotos || [])) add(typeof p === 'string' ? p : (p && p.url));
    for (const p of (prop.photos || []))                         add(typeof p === 'string' ? p : (p && p.url));
    add(prop.desktopWebHdpImageLink);
    add(prop.heroImage);
    return dedupZillowPhotos(photos).slice(0, 50);
  }

  function collectPhotoUrls(prop, keys) {
    const photos = [], seen = new Set();
    const add = (u) => { if (u && typeof u === 'string' && u.startsWith('http') && !seen.has(u)) { photos.push(u); seen.add(u); } };
    for (const key of keys) {
      for (const p of (prop[key] || [])) add(typeof p === 'string' ? p : (p && (p.href || p.url)));
    }
    return photos.slice(0, 50);
  }

  function parseDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/); if (m) return m[1];
    if (/^\d{13}$/.test(s)) { try { return new Date(parseInt(s, 10)).toISOString().slice(0, 10); } catch (_) {} }
    if (/^\d{10}$/.test(s)) { try { return new Date(parseInt(s, 10) * 1000).toISOString().slice(0, 10); } catch (_) {} }
    try { const d = new Date(s); if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10); } catch (_) {}
    return s.slice(0, 40);
  }

  function safeI(v) {
    if (!v && v !== 0) return null;
    const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
    return isNaN(n) || n <= 0 ? null : n;
  }

  function parseRent(rawPrice, rentZestimate) {
    let rent = null;
    if (typeof rawPrice === 'number' && rawPrice > 0) rent = rawPrice;
    else if (rawPrice) { const d = String(rawPrice).replace(/[^0-9]/g, ''); rent = d ? parseInt(d, 10) : null; }
    if (!rent && rentZestimate) rent = parseInt(String(rentZestimate), 10) || null;
    return rent;
  }

  function safeInt(v) {
    if (v == null || v === '') return null;
    const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
    return isNaN(n) || n <= 0 ? null : n;
  }

  function parseLeaseMonths(leaseTerm) {
    if (!leaseTerm) return null;
    const s = String(leaseTerm).toLowerCase();
    const m = s.match(/(\d+)\s*month/);
    if (m) return parseInt(m[1], 10);
    if (/month.to.month|m2m|mtm/.test(s)) return 1;
    if (/\byear\b|12[\s-]*month|annual/.test(s)) return 12;
    return null;
  }

  function buildLocationContext(prop, rf) {
    const parts = [];
    const ws = prop.walkScore || (prop.walkScoreData && prop.walkScoreData.walkScore);
    const ts = prop.transitScore || (prop.walkScoreData && prop.walkScoreData.transitScore);
    const bs = prop.bikeScore || (prop.walkScoreData && prop.walkScoreData.bikeScore);
    if (ws != null) parts.push('Walk score: ' + ws);
    if (ts != null) parts.push('Transit score: ' + ts);
    if (bs != null) parts.push('Bike score: ' + bs);
    const district = rf.schoolDistrict || prop.schoolDistrict;
    if (district) parts.push('School district: ' + district);
    const zoning = rf.zoning || rf.zoningDescription;
    if (zoning) parts.push('Zoning: ' + zoning);
    return parts.length ? parts.join('; ') : null;
  }

  // Sample a small portion of __NEXT_DATA__ / prop for debugging without
  // sending huge payloads. Truncate long strings and arrays.
  function sampleValue(v, depth) {
    if (depth <= 0) return null;
    if (v == null) return v;
    if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '...' : v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.slice(0, 6).map(i => sampleValue(i, depth - 1));
    if (typeof v === 'object') {
      const out = {};
      const keys = Object.keys(v).slice(0, 12);
      for (const k of keys) out[k] = sampleValue(v[k], depth - 1);
      return out;
    }
    return null;
  }

  const TYPE_MAP = {
    SINGLE_FAMILY: 'SINGLE_FAMILY', MULTI_FAMILY: 'MULTI_FAMILY', CONDO: 'CONDOS',
    CONDO_TOWNHOME: 'CONDOS', TOWNHOUSE: 'TOWNHOMES', APARTMENT: 'APARTMENT',
    MANUFACTURED: 'MOBILE', MOBILE: 'MOBILE', LOT: 'LAND', LAND: 'LAND', FARM: 'FARM',
  };
  function normalizeType(homeType) {
    const t = (homeType || '').toUpperCase();
    return TYPE_MAP[t] || t || null;
  }
  function fmtType(t) {
    return !t ? 'Rental' : t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  function buildTitle(beds, propType, city, street) {
    return city ? ((beds ? beds + 'BR ' : '') + fmtType(propType) + ' in ' + city) : (street || 'Rental Listing');
  }

  // Zillow URLs embed the zpid at the end: .../12345_zpid/
  // If the URL's zpid doesn't match the data's zpid, rebuild a canonical URL.
  function canonicalZillowUrl(url, zpid) {
    if (!zpid) return url;
    const m = url.match(/(https?:\/\/[^/]+\/homedetails\/[^/]+)\/\d+_zpid\/?/i);
    if (m) {
      const urlZpid = (url.match(/(\d+)_zpid/i) || [])[1];
      if (urlZpid && urlZpid !== zpid) {
        return m[1] + '/' + zpid + '_zpid/';
      }
    }
    return url;
  }

  // ── Base payload (all nulls; extractors override what they know) ──
  function basePayload(source, id, url, overrides) {
    return Object.assign({
      source, source_listing_id: id, source_url: url,
      title: null, address: null, city: null, state: null, zip: null, lat: null, lng: null,
      monthly_rent: null, bedrooms: null, bathrooms: null, half_bathrooms: null,
      square_footage: null, year_built: null, lot_size_sqft: null, floors: null,
      garage_spaces: null, total_units: null, property_type: null, description: null,
      neighborhood: null, county: null, location_context: null, pets_allowed: null,
      pet_types_allowed: null, available_date: null, minimum_lease_months: null,
      smoking_allowed: null, security_deposit: null, pet_deposit: null, admin_fee: null,
      parking_fee: null, application_fee: null, hoa_fee: null, last_months_rent: null,
      move_in_special: null, parking: null, amenities: null, appliances: null,
      utilities_included: null, heating_type: null, cooling_type: null, laundry_type: null,
      virtual_tour_url: null, has_basement: null, has_central_air: null,
      original_image_urls: '[]', agent_name: null, broker_name: null,
      _import: 'browser-extension-v2'
    }, overrides);
  }

  // ── Zillow attrMap helper ────────────────────────────────────
  // Zillow stores rich facts as a label→value object in prop.attrMap
  // (and occasionally in prop.facts). The resoFacts (rf) object often
  // lacks these. Parse attrMap to fill in bonus fields that raise the
  // quality score (county, year_built, parking, pets, appliances,
  // heating, cooling, laundry, basement, lot size, flooring).
  function fromAttrMap(prop) {
    const facts = {};
    const src   = prop.attrMap || prop.facts || {};
    if (Array.isArray(src)) {
      for (const f of src) {
        if (f && typeof f === 'object') {
          const label = f.label || f.name || f.type || '';
          const val   = f.value || f.text || '';
          if (label && val != null) facts[String(label).trim().toLowerCase()] = String(val).trim();
        }
      }
    } else if (src && typeof src === 'object') {
      for (const k of Object.keys(src)) {
        const v = src[k];
        if (v != null && v !== '') facts[String(k).trim().toLowerCase()] = String(v).trim();
      }
    }
    return facts;
  }

  function factYearBuilt(facts, current) {
    if (current) return current;
    for (const k of ['year built', 'yearbuilt', 'built in', 'year']) {
      if (facts[k]) { const n = parseInt(String(facts[k]).replace(/[^0-9]/g, ''), 10); if (n && n > 1800) return n; }
    }
    return null;
  }

  function factLotSize(facts, current) {
    if (current) return current;
    for (const k of ['lot size', 'lot', 'lotsize']) {
      if (facts[k]) {
        const n = parseInt(String(facts[k]).replace(/[^0-9]/g, ''), 10);
        if (n) return n;
      }
    }
    return null;
  }

  function factList(facts, current, keys) {
    if (current && current.length) return current;
    for (const k of keys) {
      if (facts[k]) {
        const parts = String(facts[k]).split(',').map(s => s.trim()).filter(Boolean);
        if (parts.length) return parts;
      }
    }
    return current || [];
  }

  function factBool(facts, current, keys) {
    if (current != null) return current;
    for (const k of keys) {
      if (facts[k]) {
        const v = String(facts[k]).toLowerCase();
        return !(v === 'none' || v === 'no' || v === 'false' || v === '0');
      }
    }
    return null;
  }

  function factPets(facts, current) {
    if (current != null) return current;
    for (const k of ['pet friendly', 'pets allowed', 'pets', 'pet policy']) {
      if (facts[k]) {
        const v = String(facts[k]).toLowerCase();
        return !(v === 'no' || v === 'false' || v === 'not allowed');
      }
    }
    return null;
  }

  // ── Zillow ───────────────────────────────────────────────────
  function extractZillow(doc, url) {
    const nd = getNextData(doc);
    if (!nd) return null;

    let prop = null;
    const cachePaths = [
      ['props', 'pageProps', 'componentProps', 'gdpClientCache'],
      ['props', 'pageProps', 'initialData', 'gdpClientCache'],
      ['props', 'pageProps', 'gdpClientCache'],
    ];
    for (const path of cachePaths) {
      if (prop) break;
      try {
        let node = nd;
        for (const key of path) { node = node[key]; if (!node) break; }
        if (!node) continue;
        const cache = typeof node === 'string' ? JSON.parse(node) : node;
        if (!cache || typeof cache !== 'object') continue;
        for (const k of Object.keys(cache)) {
          const v = cache[k];
          if (!v || typeof v !== 'object') continue;
          if (v.property && v.property.zpid) { prop = v.property; break; }
          if (v.data && v.data.property && v.data.property.zpid) { prop = v.data.property; break; }
          if (v.zpid !== undefined && (v.bedrooms !== undefined || v.price !== undefined)) { prop = v; break; }
        }
      } catch (_) {}
    }
    if (!prop) {
      try {
        const cp = nd.props.pageProps.componentProps;
        if (cp && cp.homeDetails && cp.homeDetails.zpid) prop = cp.homeDetails;
      } catch (_) {}
    }
    if (!prop) return null;

    const rf   = prop.resoFacts || {};
    const addr = prop.address   || {};
    const zpid = String(prop.zpid || '');
    const street = addr.streetAddress || prop.streetAddress || '';
    const city   = addr.city    || prop.city    || '';
    const state  = addr.state   || prop.state   || '';
    const zip    = addr.zipcode || prop.zipcode || '';
    const beds   = prop.bedrooms != null ? prop.bedrooms : (prop.beds != null ? prop.beds : null);
    const bathsR = prop.bathrooms != null ? prop.bathrooms : (prop.baths != null ? prop.baths : null);
    const bathF  = bathsR != null ? Math.floor(bathsR) : null;
    const bathH  = bathsR != null && bathsR !== bathF ? 1 : null;
    const lat    = prop.latitude  || (prop.latLong && prop.latLong.latitude)  || null;
    const lng    = prop.longitude || (prop.latLong && prop.latLong.longitude) || null;
    const sqft   = prop.livingArea || prop.area || null;
    const yr     = prop.yearBuilt || rf.yearBuilt || null;
    const hood   = prop.neighborhoodName || prop.neighborhood || rf.subdivision || addr.neighborhood || null;
    const county = prop.county || addr.county || null;
    const vtour  = prop.virtualTourUrl || prop.threeDimensionalTourUrl || null;
    const propType = normalizeType(prop.homeType);

    const ctxParts = [];
    if (prop.walkScore    != null) ctxParts.push('Walk score: '    + prop.walkScore);
    if (prop.transitScore != null) ctxParts.push('Transit score: ' + prop.transitScore);
    if (prop.bikeScore    != null) ctxParts.push('Bike score: '    + prop.bikeScore);

    const amenityMap = {};
    const addA = (v) => { if (v && typeof v === 'string') { const t = v.trim(); if (t) amenityMap[t] = true; } };
    for (const t of (prop.tags || [])) addA(t);
    for (const f of [...(rf.communityFeatures || []), ...(rf.interiorFeatures || []), ...(rf.exteriorFeatures || []), ...(rf.poolFeatures || [])]) addA(f);

    // Parse Zillow's amenityCategories (structured groups of amenities)
    try {
      if (prop.amenityCategories && Array.isArray(prop.amenityCategories)) {
        for (const cat of prop.amenityCategories) {
          if (!cat) continue;
          // cat may be { name: 'Community', amenities: ['Pool','Gym'] } or similar
          if (Array.isArray(cat.amenities)) {
            for (const a of cat.amenities) addA(typeof a === 'string' ? a : (a && a.name));
          }
          if (cat.name && typeof cat.name === 'string') addA(cat.name);
        }
      }
    } catch (_) {}

    // ── attrMap fallback ───────────────────────────────────────
    // Zillow's resoFacts sometimes omits fields that are only present
    // in prop.attrMap (a label→value object). Parse it to fill any
    // bonus fields that came back null from resoFacts.
    const facts = fromAttrMap(prop);

    let parking = null;
    if (rf.parkingFeatures && rf.parkingFeatures.length) parking = rf.parkingFeatures.join(', ');
    else if (prop.parkingType) parking = String(prop.parkingType).replace(/_/g, ' ');
    parking = parking || (facts.parking ? String(facts.parking) : null);

    const pets = prop.isPetFriendly != null ? prop.isPetFriendly : (rf.petsAllowed != null ? rf.petsAllowed : factPets(facts, null));
    const petTypes = [];
    if (rf.catsAllowed) petTypes.push('cats');
    if (rf.dogsAllowed) petTypes.push('dogs');
    if (!petTypes.length) {
      const pv = (facts['pet types allowed'] || facts['pets']) || (pets ? 'dogs and cats' : '');
      if (pv) [pv.match(/cat/i) && petTypes.push('cats'), pv.match(/dog/i) && petTypes.push('dogs')];
    }

    let minLease = null;
    const ltRaw = rf.leaseTerm || rf.leaseTerms || rf.minimumLease || null;
    if (ltRaw) {
      const lt = String(ltRaw).toLowerCase();
      const mmo = lt.match(/(\d+)\s*month/);
      if (mmo) minLease = parseInt(mmo[1], 10);
      else if (/month.to.month|m2m|mtm/.test(lt)) minLease = 1;
      else if (/\byear\b|12[\s-]*month|annual/.test(lt)) minLease = 12;
    }

    const yrBuilt = factYearBuilt(facts, yr ? parseInt(String(yr), 10) : null);
    const lotSize = factLotSize(facts, null);
    const heating = (rf.heating && rf.heating.length ? rf.heating.join(', ') : null)
                  || (facts.heating ? String(facts.heating) : null);
    const cooling = (rf.cooling && rf.cooling.length ? rf.cooling.join(', ') : null)
                  || (facts.cooling ? String(facts.cooling) : null);
    const laundry = (rf.laundryFeatures && rf.laundryFeatures.length ? rf.laundryFeatures.join(', ') : null)
                  || (facts.laundry ? String(facts.laundry) : null);
    const appliances = (rf.appliances && rf.appliances.length ? rf.appliances : factList(facts, [], ['appliances']));
    const smoking = rf.smokingAllowed != null ? !!rf.smokingAllowed : factBool(facts, null, ['smoking']);

    // Expand amenities from attrMap facts when resoFacts had none
    if (!amenityMap.size || Object.keys(amenityMap).length < 4) {
      const extra = factList(facts, [], ['amenities', 'features', 'interior features', 'exterior features']);
      for (const a of extra) addA(a);
    }

    const secDeposit = safeI(rf.securityDeposit) || safeI(facts['security deposit']) || null;

    // Sample a small original_data excerpt to help debugging missing fields
    let sampled = null;
    try {
      sampled = {
        zpid: zpid,
        attrMap: sampleValue(prop.attrMap || prop.facts || {}, 2),
        amenityCategories: sampleValue(prop.amenityCategories || [], 2),
        resoFacts: sampleValue(rf || {}, 2),
      };
    } catch (_) { sampled = null; }

    return basePayload('zillow', zpid, canonicalZillowUrl(url, zpid), {
      title: buildTitle(beds, propType, city, street),
      address: street, city, state, zip, lat, lng,
      monthly_rent: parseRent(prop.price || prop.unformattedPrice, prop.rentZestimate),
      bedrooms: beds, bathrooms: bathF, half_bathrooms: bathH,
      square_footage: sqft ? parseInt(String(sqft), 10) : null,
      year_built: yrBuilt,
      lot_size_sqft: lotSize,
      floors: safeI(prop.stories || rf.stories),
      garage_spaces: safeI(prop.garageParkingCapacity || prop.garageSpaces),
      total_units: safeI(prop.unitCount),
      property_type: propType,
      description: prop.description || null,
      neighborhood: hood || (facts['neighborhood'] ? String(facts['neighborhood']) : null),
      county: county || (facts['county'] ? String(facts['county']) : null),
      location_context: ctxParts.length ? ctxParts.join('; ') : null,
      pets_allowed: pets != null ? !!pets : null,
      pet_types_allowed: JSON.stringify(petTypes),
      available_date: parseDate(rf.dateAvailable || rf.availableFrom || prop.dateAvailable || facts['available']),
      minimum_lease_months: minLease,
      smoking_allowed: smoking,
      security_deposit: secDeposit,
      pet_deposit: safeI(rf.petFee || rf.petDepositFee),
      admin_fee: safeI(rf.adminFee),
      parking_fee: safeI(rf.parkingFee),
      application_fee: safeI(rf.applicationFeeAmount || rf.applicationFee),
      hoa_fee: safeI(prop.monthlyHoaFee || prop.hoaFee),
      last_months_rent: safeI(rf.lastMonthRent),
      move_in_special: rf.concessions ? String(rf.concessions).slice(0, 200) : null,
      parking,
      amenities: JSON.stringify(Object.keys(amenityMap)),
      appliances: JSON.stringify(appliances),
      utilities_included: JSON.stringify(rf.utilities || rf.utilitiesIncluded || []),
      heating_type: heating,
      cooling_type: cooling,
      laundry_type: laundry,
      virtual_tour_url: vtour,
      has_basement: !!(rf.basement && rf.basement !== 'None' && rf.basement !== 'false' && rf.basement !== false),
      has_central_air: !!(rf.hasCooling || (rf.cooling && rf.cooling.some(c => c.toLowerCase().includes('central')))),
      original_image_urls: JSON.stringify(collectPhotos(prop)),
      original_data: sampled ? JSON.stringify(sampled) : null,
      agent_name: (prop.attributionInfo && prop.attributionInfo.agentName)  || null,
      broker_name: (prop.attributionInfo && prop.attributionInfo.brokerName) || null,
    });
  }

  // ── Realtor.com ──────────────────────────────────────────────
  function extractRealtor(doc, url) {
    const nd = getNextData(doc);
    if (!nd) return null;

    let prop = null;
    const paths = [
      ['props', 'pageProps', 'initialReduxState', 'propertyDetails'],
      ['props', 'pageProps', 'initialReduxState', 'searchResults', 'homeDetails'],
      ['props', 'pageProps', 'initialReduxState', 'listing'],
      ['props', 'pageProps', 'property'],
    ];
    for (const p of paths) {
      const v = walk(nd, p);
      if (v && (v.property_id || v.address || v.rdc_web_url)) { prop = v; break; }
    }
    if (!prop) return null;

    const addr = prop.address || {};
    const street = addr.line || addr.streetAddress || prop.line || '';
    const city   = addr.city || prop.city || '';
    const state  = addr.state_code || addr.state || prop.state || '';
    const zip    = addr.postal_code || addr.zipcode || prop.zipcode || '';
    const beds   = prop.beds != null ? prop.beds : (prop.bedrooms != null ? prop.bedrooms : null);
    const bathsR = prop.baths != null ? prop.baths : (prop.bathrooms != null ? prop.bathrooms : null);
    const bathF  = bathsR != null ? Math.floor(bathsR) : null;
    const bathH  = bathsR != null && bathsR !== bathF ? 1 : null;
    const lat    = prop.lat || addr.lat || null;
    const lng    = prop.lng || addr.lng || null;
    const sqft   = prop.sqft || prop.square_feet || null;
    const yr     = prop.year_built || null;
    const propType = normalizeType(prop.prop_type || prop.property_type || prop.home_type);

    const photos = collectPhotoUrls(prop, ['photos']);
    if (prop.primary_photo) {
      const u = typeof prop.primary_photo === 'string' ? prop.primary_photo : prop.primary_photo.href;
      if (u && !photos.includes(u)) photos.unshift(u);
    }

    return basePayload('realtor', String(prop.property_id || prop.rdc_web_url || ''), url, {
      title: buildTitle(beds, propType, city, street),
      address: street, city, state, zip, lat, lng,
      monthly_rent: parseRent(prop.price || prop.list_price, null),
      bedrooms: beds, bathrooms: bathF, half_bathrooms: bathH,
      square_footage: sqft ? parseInt(String(sqft), 10) : null,
      year_built: yr ? parseInt(String(yr), 10) : null,
      property_type: propType,
      description: prop.description || prop.text || null,
      neighborhood: prop.neighborhood_name || null,
      county: prop.county || null,
      available_date: parseDate(prop.available_date || prop.date_available),
      virtual_tour_url: prop.virtual_tour_url || null,
      original_image_urls: JSON.stringify(photos.slice(0, 50)),
    });
  }

  // ── Apartments.com ───────────────────────────────────────────
  function extractApartments(doc, url) {
    const nd = getNextData(doc);
    if (!nd) return null;

    let prop = null;
    const paths = [
      ['props', 'pageProps', 'listing'],
      ['props', 'pageProps', 'initialState', 'listing'],
      ['props', 'pageProps', 'property'],
      ['props', 'pageProps', 'apartment'],
    ];
    for (const p of paths) {
      const v = walk(nd, p);
      if (v && (v.id || v.address || v.name)) { prop = v; break; }
    }
    if (!prop) return null;

    const addr = prop.address || {};
    const street = addr.street || addr.line || '';
    const city   = addr.city || '';
    const state  = addr.state || addr.stateCode || '';
    const zip    = addr.zip || addr.postalCode || '';
    const beds   = prop.bedrooms != null ? prop.bedrooms : null;
    const bathsR = prop.bathrooms != null ? prop.bathrooms : null;
    const bathF  = bathsR != null ? Math.floor(bathsR) : null;
    const bathH  = bathsR != null && bathsR !== bathF ? 1 : null;
    const lat    = prop.latitude || (prop.geo && prop.geo.lat) || null;
    const lng    = prop.longitude || (prop.geo && prop.geo.lng) || null;
    const sqft   = prop.squareFeet || prop.sqft || null;
    const yr     = prop.yearBuilt || null;

    const photos = collectPhotoUrls(prop, ['photos', 'images']);

    return basePayload('apartments', String(prop.id || ''), url, {
      title: buildTitle(beds, 'APARTMENT', city, street),
      address: street, city, state, zip, lat, lng,
      monthly_rent: parseRent(prop.price || prop.minPrice, null),
      bedrooms: beds, bathrooms: bathF, half_bathrooms: bathH,
      square_footage: sqft ? parseInt(String(sqft), 10) : null,
      year_built: yr ? parseInt(String(yr), 10) : null,
      property_type: 'APARTMENT',
      description: prop.description || null,
      neighborhood: prop.neighborhood || null,
      pets_allowed: prop.petsAllowed != null ? !!prop.petsAllowed : null,
      available_date: parseDate(prop.availableDate || prop.availabilityDate),
      original_image_urls: JSON.stringify(photos.slice(0, 50)),
    });
  }

  // ── Redfin ───────────────────────────────────────────────────
  function extractRedfin(doc, url) {
    const nd = getNextData(doc);
    if (!nd) return null;

    let prop = null;
    const paths = [
      ['props', 'pageProps', 'initialReduxState', 'searchResults', 'homeDetails'],
      ['props', 'pageProps', 'initialReduxState', 'propertyData'],
      ['props', 'pageProps', 'initialReduxState', 'homeDetails'],
      ['props', 'pageProps', 'property'],
    ];
    for (const p of paths) {
      const v = walk(nd, p);
      if (v && (v.propertyId || v.address || v.id)) { prop = v; break; }
    }
    if (!prop) return null;

    const addr = prop.address || {};
    const street = addr.streetAddress || addr.line || '';
    const city   = addr.city || '';
    const state  = addr.state || addr.stateCode || '';
    const zip    = addr.zip || addr.postalCode || '';
    const beds   = prop.beds != null ? prop.beds : null;
    const bathsR = prop.baths != null ? prop.baths : null;
    const bathF  = bathsR != null ? Math.floor(bathsR) : null;
    const bathH  = bathsR != null && bathsR !== bathF ? 1 : null;
    const lat    = prop.latitude || (prop.location && prop.location.latitude) || null;
    const lng    = prop.longitude || (prop.location && prop.location.longitude) || null;
    const sqft   = prop.sqft || prop.livingArea || null;
    const yr     = prop.yearBuilt || null;
    const propType = normalizeType(prop.propertyType || prop.homeType);

    const photos = collectPhotoUrls(prop, ['photos', 'images', 'media']);

    return basePayload('redfin', String(prop.propertyId || prop.id || ''), url, {
      title: buildTitle(beds, propType, city, street),
      address: street, city, state, zip, lat, lng,
      monthly_rent: parseRent(prop.price || prop.rent, null),
      bedrooms: beds, bathrooms: bathF, half_bathrooms: bathH,
      square_footage: sqft ? parseInt(String(sqft), 10) : null,
      year_built: yr ? parseInt(String(yr), 10) : null,
      property_type: propType,
      description: prop.description || null,
      neighborhood: prop.neighborhood || null,
      available_date: parseDate(prop.availableDate || prop.dateAvailable),
      virtual_tour_url: prop.virtualTourUrl || null,
      original_image_urls: JSON.stringify(photos.slice(0, 50)),
    });
  }

  // ── Registry + detection ─────────────────────────────────────
  const EXTRACTORS = [
    { id: 'zillow',     match: /zillow\.com\/homedetails\//i,            fn: extractZillow },
    { id: 'realtor',    match: /realtor\.com\/realestateandhomes-detail\//i, fn: extractRealtor },
    { id: 'apartments', match: /apartments\.com\//i,                     fn: extractApartments },
    { id: 'redfin',     match: /redfin\.com\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/[^/]+/i, fn: extractRedfin },
  ];

  function detect(url) {
    for (const e of EXTRACTORS) {
      if (e.match.test(url || '')) return e;
    }
    return null;
  }

  function extract(url, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return null;
    const e = detect(url);
    if (!e) return null;
    try { return e.fn(d, url); } catch (_) { return null; }
  }

  const api = { detect, extract, extractZillow, extractRealtor, extractApartments, extractRedfin, EXTRACTORS };
  global.CP_Extractors = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);