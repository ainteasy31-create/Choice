// ============================================================
// Choice Properties — Live Multi-site Listing Extractor Registry
// This file is hosted on Cloudflare Pages and fetched by the
// extension's thin loader (content.js) on every page load.
// Edit this file → push to GitHub → Cloudflare auto-deploys
// → extension picks up changes automatically. No reinstall needed.
// ============================================================
(function (global) {
  'use strict';

  // ── DOM helpers ──────────────────────────────────────────────
  function getNextData(source) {
    if (!source) return null;
    if (typeof source.getElementById === 'function') {
      var el = source.getElementById('__NEXT_DATA__');
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
    var node = obj;
    var parts = path.split('.');
    for (var i = 0; i < parts.length; i++) {
      if (node == null) return undefined;
      node = node[parts[i]];
    }
    return node;
  }

  function firstDefined() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return null;
  }

  function toNum(v) {
    if (v === undefined || v === null) return null;
    var n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
    return isNaN(n) ? null : n;
  }

  function toStr(v) {
    if (v === undefined || v === null) return null;
    return String(v).trim() || null;
  }

  function normalizeSource(url) {
    if (/zillow\.com/i.test(url)) return 'zillow';
    if (/realtor\.com/i.test(url)) return 'realtor';
    if (/apartments\.com/i.test(url)) return 'apartments';
    if (/redfin\.com/i.test(url)) return 'redfin';
    return 'unknown';
  }

  // ── Zillow extractor ─────────────────────────────────────────
  function extractZillow(url, doc) {
    var data = getNextData(doc);
    if (!data) return null;

    // Zillow stores listing data in gdpClientCache (often a JSON string)
    // Search multiple paths to find the actual property object.
    var prop = null;
    var cachePaths = [
      ['props', 'pageProps', 'componentProps', 'gdpClientCache'],
      ['props', 'pageProps', 'initialData', 'gdpClientCache'],
      ['props', 'pageProps', 'gdpClientCache'],
    ];
    for (var pi = 0; pi < cachePaths.length; pi++) {
      if (prop) break;
      try {
        var node = data;
        var path = cachePaths[pi];
        for (var ki = 0; ki < path.length; ki++) {
          node = node[path[ki]];
          if (!node) break;
        }
        if (!node) continue;
        var cache = typeof node === 'string' ? JSON.parse(node) : node;
        if (!cache || typeof cache !== 'object') continue;
        for (var k in cache) {
          var v = cache[k];
          if (!v || typeof v !== 'object') continue;
          if (v.property && v.property.zpid) { prop = v.property; break; }
          if (v.data && v.data.property && v.data.property.zpid) { prop = v.data.property; break; }
          if (v.zpid !== undefined && (v.bedrooms !== undefined || v.price !== undefined)) { prop = v; break; }
        }
      } catch (_) {}
    }
    if (!prop) {
      try {
        var cp = data.props.pageProps.componentProps;
        if (cp && cp.homeDetails && cp.homeDetails.zpid) prop = cp.homeDetails;
      } catch (_) {}
    }

    // Fallback: extract zpid from URL (e.g. /351626407_zpid/)
    var urlZpid = null;
    var urlMatch = url.match(/(\d+)_zpid/i);
    if (urlMatch) urlZpid = urlMatch[1];

    // If no property found but we have a URL zpid, build a minimal payload
    if (!prop && urlZpid) {
      return {
        source: 'zillow',
        source_listing_id: urlZpid,
        title: null,
        address: null,
        city: null,
        state: null,
        zip: null,
        lat: null,
        lng: null,
        rent: null,
        deposit: null,
        beds: null,
        baths: null,
        sqft: null,
        lot_sqft: null,
        year_built: null,
        property_type: null,
        description: null,
        available_date: null,
        pets_allowed: null,
        photo_urls: [],
        url: url,
      };
    }
    if (!prop) return null;

    var rf = prop.resoFacts || {};
    var addr = prop.address || {};
    var zpid = String(prop.zpid || urlZpid || '');
    var street = addr.streetAddress || prop.streetAddress || null;
    var city = addr.city || prop.city || null;
    var state = addr.state || prop.state || null;
    var zip = addr.zipcode || prop.zipcode || null;
    var beds = prop.bedrooms != null ? prop.bedrooms : (prop.beds != null ? prop.beds : null);
    var bathsR = prop.bathrooms != null ? prop.bathrooms : (prop.baths != null ? prop.baths : null);
    var bathF = bathsR != null ? Math.floor(bathsR) : null;
    var bathH = bathsR != null && bathsR !== bathF ? 1 : null;
    var lat = prop.latitude || (prop.latLong && prop.latLong.latitude) || null;
    var lng = prop.longitude || (prop.latLong && prop.latLong.longitude) || null;
    var sqft = prop.livingArea || prop.area || null;
    var lot = prop.lotSize || prop.lotAreaValue || null;
    var yearBuilt = prop.yearBuilt || rf.yearBuilt || null;
    var homeType = prop.homeType || prop.propertyType || null;
    var description = prop.description || rf.description || null;
    var price = prop.price || prop.unformattedPrice || null;
    var rentZestimate = prop.rentZestimate || null;

    // Photos
    var photoUrls = [];
    var seen = {};
    function addPhoto(u) {
      if (u && typeof u === 'string' && u.indexOf('http') === 0 && !seen[u]) {
        photoUrls.push(u);
        seen[u] = true;
      }
    }
    function bestJpeg(ms) {
      var jpegs = (ms && ms.jpeg) || [];
      var best = null, bestW = 0;
      for (var j = 0; j < jpegs.length; j++) {
        if ((jpegs[j].width || 0) > bestW) { bestW = jpegs[j].width || 0; best = jpegs[j].url || null; }
      }
      return best;
    }
    var photoSources = [
      prop.responsivePhotosOriginalRatio || [],
      prop.responsivePhotos || [],
      prop.hugePhotos || prop.largePhotos || [],
      prop.photos || [],
    ];
    for (var si = 0; si < photoSources.length; si++) {
      var arr = photoSources[si];
      if (!Array.isArray(arr)) continue;
      for (var pi2 = 0; pi2 < arr.length; pi2++) {
        var p = arr[pi2];
        if (typeof p === 'string') addPhoto(p);
        else if (p) addPhoto(bestJpeg(p.mixedSources) || p.url || p.href || p.originalUrl);
      }
    }
    addPhoto(prop.desktopWebHdpImageLink);
    addPhoto(prop.heroImage);

    // Rent parsing
    var rent = null;
    if (typeof price === 'number' && price > 0) rent = price;
    else if (price) {
      var d = String(price).replace(/[^0-9]/g, '');
      rent = d ? parseInt(d, 10) : null;
    }
    if (!rent && rentZestimate) rent = parseInt(String(rentZestimate), 10) || null;

    var title = [street, city, state].filter(Boolean).join(', ') || null;

    return {
      source: 'zillow',
      source_listing_id: zpid,
      title: title,
      address: street,
      city: city,
      state: state,
      zip: zip,
      lat: lat ? toNum(lat) : null,
      lng: lng ? toNum(lng) : null,
      rent: rent,
      deposit: null,
      beds: beds != null ? toNum(beds) : null,
      baths: bathF,
      half_bathrooms: bathH,
      sqft: sqft ? toNum(sqft) : null,
      lot_sqft: lot ? toNum(lot) : null,
      year_built: yearBuilt ? toNum(yearBuilt) : null,
      property_type: homeType ? toStr(homeType) : null,
      description: description ? toStr(description) : null,
      available_date: null,
      pets_allowed: null,
      photo_urls: photoUrls.slice(0, 50),
      url: url,
    };
  }

  // ── Realtor.com extractor ────────────────────────────────────
  function extractRealtor(url, doc) {
    var data = getNextData(doc);
    if (!data) return null;

    var props = walk(data, 'props.pageProps') || {};
    var listing = props.listing || props.initialState || {};

    var address = walk(listing, 'address') || {};
    var price = walk(listing, 'list_price') || walk(listing, 'price') || null;
    var beds = walk(listing, 'beds') || walk(listing, 'bedrooms') || null;
    var baths = walk(listing, 'baths') || walk(listing, 'bathrooms') || null;
    var sqft = walk(listing, 'sqft') || walk(listing, 'building_size') || null;
    var lot = walk(listing, 'lot_size') || null;
    var yearBuilt = walk(listing, 'year_built') || null;
    var homeType = walk(listing, 'property_type') || null;
    var description = walk(listing, 'description') || null;
    var lat = walk(listing, 'lat') || walk(listing, 'latitude') || null;
    var lng = walk(listing, 'lng') || walk(listing, 'longitude') || null;
    var photos = walk(listing, 'photos') || [];

    var photoUrls = [];
    if (Array.isArray(photos)) {
      photos.forEach(function (p) {
        if (typeof p === 'string') photoUrls.push(p);
        else if (p && p.href) photoUrls.push(p.href);
        else if (p && p.url) photoUrls.push(p.url);
      });
    }

    var city = address.city || null;
    var state = address.state || null;
    var zip = address.postal_code || address.zip || null;
    var street = address.line || address.street || null;

    var title = [street, city, state].filter(Boolean).join(', ') || null;

    return {
      source: 'realtor',
      source_listing_id: walk(listing, 'property_id') ? String(walk(listing, 'property_id')) : null,
      title: title,
      address: street,
      city: city,
      state: state,
      zip: zip,
      lat: lat ? toNum(lat) : null,
      lng: lng ? toNum(lng) : null,
      rent: price ? toNum(price) : null,
      deposit: null,
      beds: beds ? toNum(beds) : null,
      baths: baths ? toNum(baths) : null,
      sqft: sqft ? toNum(sqft) : null,
      lot_sqft: lot ? toNum(lot) : null,
      year_built: yearBuilt ? toNum(yearBuilt) : null,
      property_type: homeType ? toStr(homeType) : null,
      description: description ? toStr(description) : null,
      available_date: null,
      pets_allowed: null,
      photo_urls: photoUrls.slice(0, 50),
      url: url,
    };
  }

  // ── Apartments.com extractor ─────────────────────────────────
  function extractApartments(url, doc) {
    var data = getNextData(doc);
    if (!data) return null;

    var props = walk(data, 'props.pageProps') || {};
    var listing = props.listing || props.property || {};

    var address = walk(listing, 'address') || {};
    var price = walk(listing, 'price') || walk(listing, 'rent') || null;
    var beds = walk(listing, 'beds') || walk(listing, 'bedrooms') || null;
    var baths = walk(listing, 'baths') || walk(listing, 'bathrooms') || null;
    var sqft = walk(listing, 'sqft') || walk(listing, 'squareFeet') || null;
    var description = walk(listing, 'description') || null;
    var lat = walk(listing, 'latitude') || walk(listing, 'lat') || null;
    var lng = walk(listing, 'longitude') || walk(listing, 'lng') || null;
    var photos = walk(listing, 'photos') || [];

    var photoUrls = [];
    if (Array.isArray(photos)) {
      photos.forEach(function (p) {
        if (typeof p === 'string') photoUrls.push(p);
        else if (p && p.url) photoUrls.push(p.url);
        else if (p && p.href) photoUrls.push(p.href);
      });
    }

    var city = address.city || null;
    var state = address.state || null;
    var zip = address.zip || address.postalCode || null;
    var street = address.street || address.line1 || null;

    var title = [street, city, state].filter(Boolean).join(', ') || null;

    return {
      source: 'apartments',
      source_listing_id: walk(listing, 'id') ? String(walk(listing, 'id')) : null,
      title: title,
      address: street,
      city: city,
      state: state,
      zip: zip,
      lat: lat ? toNum(lat) : null,
      lng: lng ? toNum(lng) : null,
      rent: price ? toNum(price) : null,
      deposit: null,
      beds: beds ? toNum(beds) : null,
      baths: baths ? toNum(baths) : null,
      sqft: sqft ? toNum(sqft) : null,
      lot_sqft: null,
      year_built: null,
      property_type: 'apartment',
      description: description ? toStr(description) : null,
      available_date: null,
      pets_allowed: null,
      photo_urls: photoUrls.slice(0, 50),
      url: url,
    };
  }

  // ── Redfin extractor ─────────────────────────────────────────
  function extractRedfin(url, doc) {
    var data = getNextData(doc);
    if (!data) return null;

    var props = walk(data, 'props.pageProps') || {};
    var listing = props.listingInfo || props.listing || {};

    var address = walk(listing, 'address') || {};
    var price = walk(listing, 'price') || walk(listing, 'listPrice') || null;
    var beds = walk(listing, 'beds') || walk(listing, 'bedrooms') || null;
    var baths = walk(listing, 'baths') || walk(listing, 'bathrooms') || null;
    var sqft = walk(listing, 'sqft') || walk(listing, 'livingArea') || null;
    var lot = walk(listing, 'lotSize') || null;
    var yearBuilt = walk(listing, 'yearBuilt') || null;
    var homeType = walk(listing, 'propertyType') || null;
    var description = walk(listing, 'description') || null;
    var lat = walk(listing, 'latitude') || walk(listing, 'lat') || null;
    var lng = walk(listing, 'longitude') || walk(listing, 'lng') || null;
    var photos = walk(listing, 'photos') || [];

    var photoUrls = [];
    if (Array.isArray(photos)) {
      photos.forEach(function (p) {
        if (typeof p === 'string') photoUrls.push(p);
        else if (p && p.url) photoUrls.push(p.url);
        else if (p && p.href) photoUrls.push(p.href);
      });
    }

    var city = address.city || null;
    var state = address.state || null;
    var zip = address.zip || address.postalCode || null;
    var street = address.street || address.line || null;

    var title = [street, city, state].filter(Boolean).join(', ') || null;

    return {
      source: 'redfin',
      source_listing_id: walk(listing, 'id') ? String(walk(listing, 'id')) : null,
      title: title,
      address: street,
      city: city,
      state: state,
      zip: zip,
      lat: lat ? toNum(lat) : null,
      lng: lng ? toNum(lng) : null,
      rent: price ? toNum(price) : null,
      deposit: null,
      beds: beds ? toNum(beds) : null,
      baths: baths ? toNum(baths) : null,
      sqft: sqft ? toNum(sqft) : null,
      lot_sqft: lot ? toNum(lot) : null,
      year_built: yearBuilt ? toNum(yearBuilt) : null,
      property_type: homeType ? toStr(homeType) : null,
      description: description ? toStr(description) : null,
      available_date: null,
      pets_allowed: null,
      photo_urls: photoUrls.slice(0, 50),
      url: url,
    };
  }

  // ── Registry ─────────────────────────────────────────────────
  var extractors = {
    zillow: { match: /zillow\.com\/homedetails\//i, extract: extractZillow },
    realtor: { match: /realtor\.com\/realestateandhomes-detail\//i, extract: extractRealtor },
    apartments: { match: /apartments\.com\//i, extract: extractApartments },
    redfin: { match: /redfin\.com\//i, extract: extractRedfin },
  };

  global.CP_Extractors = {
    detect: function (url) {
      for (var key in extractors) {
        if (extractors[key].match.test(url)) return extractors[key];
      }
      return null;
    },
    extract: function (url, doc) {
      var ex = this.detect(url);
      if (!ex) return null;
      return ex.extract(url, doc);
    },
    version: '2.3.0-live',
  };
})(typeof window !== 'undefined' ? window : this);