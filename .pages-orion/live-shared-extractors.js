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

    var props = walk(data, 'props.pageProps') || {};
    var listing = props.listing || props.gdp || props.initialReduxState || {};

    // Try multiple paths for the actual listing data
    var zpid = walk(listing, 'zpid') || walk(listing, 'property.zpid') || null;
    var address = walk(listing, 'address') || {};
    var price = walk(listing, 'price') || walk(listing, 'listPrice') || null;
    var beds = walk(listing, 'bedrooms') || walk(listing, 'beds') || null;
    var baths = walk(listing, 'bathrooms') || walk(listing, 'baths') || null;
    var sqft = walk(listing, 'livingArea') || walk(listing, 'livingAreaValue') || null;
    var lot = walk(listing, 'lotSize') || walk(listing, 'lotAreaValue') || null;
    var yearBuilt = walk(listing, 'yearBuilt') || null;
    var homeType = walk(listing, 'homeType') || walk(listing, 'propertyType') || null;
    var description = walk(listing, 'description') || walk(listing, 'resoFacts.description') || null;
    var lat = walk(listing, 'latitude') || walk(listing, 'latLong.latitude') || null;
    var lng = walk(listing, 'longitude') || walk(listing, 'latLong.longitude') || null;
    var photos = walk(listing, 'responsivePhotos') || walk(listing, 'photos') || [];

    // Extract photo URLs
    var photoUrls = [];
    if (Array.isArray(photos)) {
      photos.forEach(function (p) {
        if (p && p.url) photoUrls.push(p.url);
        else if (p && p.href) photoUrls.push(p.href);
        else if (p && p.originalUrl) photoUrls.push(p.originalUrl);
      });
    }

    // Fallback: try to find photos in __NEXT_DATA__ media
    if (photoUrls.length === 0) {
      var media = walk(listing, 'media') || {};
      if (media.allPhotos && Array.isArray(media.allPhotos)) {
        media.allPhotos.forEach(function (p) {
          if (p && p.url) photoUrls.push(p.url);
        });
      }
    }

    var city = address.city || null;
    var state = address.state || null;
    var zip = address.zipcode || address.zip || null;
    var street = address.streetAddress || address.street || null;

    var title = [street, city, state].filter(Boolean).join(', ') || null;

    return {
      source: 'zillow',
      source_listing_id: zpid ? String(zpid) : null,
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