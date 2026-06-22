// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: blue; icon-glyph: arrow.down.circle.fill;

// ============================================================
// Import to Choice Properties
// Version 1.0 — June 2026
//
// Imports the current Zillow listing page into the Choice
// Properties admin pipeline — no computer required.
//
// HOW TO USE:
//   1. Open any Zillow listing page in Safari (the full detail
//      page, not a search results page).
//   2. Tap the Share button → scroll down → tap "Import to Choice".
//   3. The listing is added to your admin pipeline instantly.
//
// FIRST-TIME SETUP:
//   See /admin/pipeline.html → "Install iPhone Importer" section.
// ============================================================

const EDGE_URL = 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
const SECRET   = 'cp_import_7Kx3m9P2w5';

// ── 1. Get URL from Share Sheet ───────────────────────────────────────────────
const sharedUrl = args.urls && args.urls.length > 0 ? args.urls[0] : null;

if (!sharedUrl) {
  const a = new Alert();
  a.title = 'No URL Found';
  a.message = 'Open a Zillow listing in Safari, then tap Share \u2192 Run Script \u2192 Import to Choice.\n\nDo not run this script directly from the Scriptable app.';
  a.addAction('OK');
  await a.present();
  Script.complete();
}

if (!sharedUrl.includes('zillow.com')) {
  const a = new Alert();
  a.title = 'Wrong Page';
  a.message = 'This script only works on Zillow listing pages.\n\nPage received:\n' + sharedUrl;
  a.addAction('OK');
  await a.present();
  Script.complete();
}

// ── 2. Load page in WebView using phone's residential IP ──────────────────────
const wv = new WebView();
try {
  await wv.loadURL(sharedUrl);
} catch (loadErr) {
  const a = new Alert();
  a.title = 'Page Load Failed';
  a.message = 'Could not load the Zillow page:\n' + loadErr.message + '\n\nMake sure you have an internet connection.';
  a.addAction('OK');
  await a.present();
  Script.complete();
}

// ── 3. Extract listing data from __NEXT_DATA__ ────────────────────────────────
const extractionCode = `
(function() {
  try {
    var el = document.getElementById('__NEXT_DATA__');
    if (!el) {
      return JSON.stringify({_error: 'No listing data found. Make sure you are on a Zillow listing DETAIL page (not a search results page).'});
    }

    var nd = JSON.parse(el.textContent);
    var prop = null;

    var cachePaths = [
      ['props','pageProps','componentProps','gdpClientCache'],
      ['props','pageProps','initialData','gdpClientCache'],
      ['props','pageProps','gdpClientCache']
    ];

    for (var ci = 0; ci < cachePaths.length && !prop; ci++) {
      try {
        var node = nd;
        for (var pi = 0; pi < cachePaths[ci].length; pi++) { node = node[cachePaths[ci][pi]]; }
        if (!node) continue;
        var cache = typeof node === 'string' ? JSON.parse(node) : node;
        var ckeys = Object.keys(cache);
        for (var ki = 0; ki < ckeys.length && !prop; ki++) {
          var v = cache[ckeys[ki]];
          if (!v || typeof v !== 'object') continue;
          if (v.property && typeof v.property === 'object' && v.property.zpid) { prop = v.property; break; }
          if (v.data && v.data.property && v.data.property.zpid) { prop = v.data.property; break; }
          if (v.zpid !== undefined && (v.bedrooms !== undefined || v.price !== undefined)) { prop = v; break; }
        }
      } catch(e2) {}
    }

    if (!prop) {
      return JSON.stringify({_error: 'Could not find listing object in page data. Try navigating directly to the full listing detail page and run the script again.'});
    }

    var rf   = prop.resoFacts || {};
    var addr = prop.address   || {};

    var photos = [];
    var pSrc = [prop.responsivePhotos, prop.hugePhotos, prop.largePhotos, prop.photos];
    for (var si = 0; si < pSrc.length && photos.length === 0; si++) {
      var arr = pSrc[si];
      if (!arr || !arr.length) continue;
      for (var ai = 0; ai < arr.length && photos.length < 50; ai++) {
        var p = arr[ai];
        var u = p.url || null;
        if (!u && p.mixedSources && p.mixedSources.jpeg && p.mixedSources.jpeg.length > 0) {
          u = p.mixedSources.jpeg[p.mixedSources.jpeg.length - 1].url;
        }
        if (u) photos.push(u);
      }
    }

    var rawPrice = prop.price || prop.unformattedPrice;
    var rent = null;
    if (typeof rawPrice === 'number' && rawPrice > 0) { rent = rawPrice; }
    else if (typeof rawPrice === 'string') {
      var digits = rawPrice.replace(/[^0-9]/g, '');
      rent = digits ? parseInt(digits, 10) : null;
    }

    var bathsRaw = prop.bathrooms || prop.baths;
    var bathF = (bathsRaw !== null && bathsRaw !== undefined) ? Math.floor(bathsRaw) : null;
    var bathH = (bathsRaw && bathsRaw !== bathF) ? 1 : null;

    var amenities = JSON.stringify(prop.tags || rf.communityFeatures || []);
    var appliances = JSON.stringify(rf.appliances || []);
    var utilities = JSON.stringify(rf.utilities || rf.utilitiesIncluded || []);
    var heating = rf.heating && rf.heating.length ? rf.heating.join(', ') : null;
    var cooling = rf.cooling && rf.cooling.length ? rf.cooling.join(', ') : null;
    var laundry = rf.laundryFeatures && rf.laundryFeatures.length ? rf.laundryFeatures.join(', ') : null;
    var parking = null;
    if (rf.parkingFeatures && rf.parkingFeatures.length) { parking = rf.parkingFeatures.join(', '); }
    else if (prop.parkingType) { parking = String(prop.parkingType).replace(/_/g, ' '); }

    var zpid      = String(prop.zpid || '');
    var street    = addr.streetAddress || prop.streetAddress || '';
    var city      = addr.city    || prop.city    || '';
    var state     = addr.state   || prop.state   || '';
    var zip       = addr.zipcode || prop.zipcode || '';
    var beds      = prop.bedrooms || prop.beds || null;
    var sqft      = prop.livingArea || prop.area || null;
    var yr        = prop.yearBuilt || rf.yearBuilt || null;
    var lat       = prop.latitude  || (prop.latLong && prop.latLong.latitude)  || null;
    var lng       = prop.longitude || (prop.latLong && prop.latLong.longitude) || null;
    var pets      = (prop.isPetFriendly !== undefined) ? prop.isPetFriendly : (rf.petsAllowed !== undefined ? rf.petsAllowed : null);
    var avail     = rf.dateAvailable || rf.availableFrom || prop.dateAvailable || null;
    var vtour     = prop.virtualTourUrl || prop.threeDimensionalTourUrl || null;
    var deposit   = rf.securityDeposit ? parseInt(String(rf.securityDeposit), 10) : null;
    var hood      = prop.neighborhoodName || prop.neighborhood || rf.subdivision || null;
    var county    = prop.county || addr.county || null;
    var basement  = rf.basement && rf.basement !== 'None' && rf.basement !== 'No basement';
    var centralAir = !!(rf.hasCooling || (rf.cooling && rf.cooling.some(function(c) { return c.toLowerCase().indexOf('central') >= 0; })));
    var petTypes  = [];
    if (rf.catsAllowed) petTypes.push('cats');
    if (rf.dogsAllowed) petTypes.push('dogs');

    var typeMap = {'APARTMENT':'Apartment','CONDO':'Condo','SINGLE_FAMILY':'Single Family','TOWNHOUSE':'Townhouse','MULTI_FAMILY':'Multi-Family','LOT':'Land','MANUFACTURED':'Manufactured'};
    var rawType  = (prop.homeType || '').toUpperCase();
    var propType = typeMap[rawType] || (rawType ? rawType : null);
    var title    = city ? ((beds ? beds + 'BR ' : '') + (propType || 'Rental') + ' in ' + city) : (street || 'Zillow Rental');

    var agentName  = (prop.attributionInfo && prop.attributionInfo.agentName)  || null;
    var brokerName = (prop.attributionInfo && prop.attributionInfo.brokerName) || null;

    return JSON.stringify({
      source:               'zillow',
      source_listing_id:    zpid,
      source_url:           window.location.href,
      title:                title,
      address:              street,
      city:                 city,
      state:                state,
      zip:                  zip,
      lat:                  lat,
      lng:                  lng,
      monthly_rent:         rent,
      bedrooms:             beds,
      bathrooms:            bathF,
      half_bathrooms:       bathH,
      square_footage:       sqft ? parseInt(String(sqft), 10) : null,
      year_built:           yr   ? parseInt(String(yr),   10) : null,
      property_type:        propType,
      description:          prop.description || null,
      neighborhood:         hood,
      county:               county,
      pets_allowed:         pets,
      pet_types_allowed:    JSON.stringify(petTypes),
      available_date:       avail,
      security_deposit:     (deposit && deposit > 0) ? deposit : null,
      parking:              parking,
      amenities:            amenities,
      appliances:           appliances,
      utilities_included:   utilities,
      heating_type:         heating,
      cooling_type:         cooling,
      laundry_type:         laundry,
      virtual_tour_url:     vtour,
      has_basement:         basement,
      has_central_air:      centralAir,
      original_image_urls:  JSON.stringify(photos),
      agent_name:           agentName,
      broker_name:          brokerName
    });
  } catch(e) {
    return JSON.stringify({_error: 'Extraction error: ' + e.message});
  }
})()
`;

let raw;
try {
  raw = await wv.evaluateJavaScript(extractionCode);
} catch (evalErr) {
  const a = new Alert();
  a.title = 'Script Error';
  a.message = 'JavaScript extraction failed:\n' + evalErr.message;
  a.addAction('OK');
  await a.present();
  Script.complete();
}

let data;
try {
  data = JSON.parse(raw);
} catch (parseErr) {
  const a = new Alert();
  a.title = 'Parse Error';
  a.message = 'Could not read extraction result. Raw output:\n' + String(raw).slice(0, 200);
  a.addAction('OK');
  await a.present();
  Script.complete();
}

if (data._error) {
  const a = new Alert();
  a.title = 'Import Failed';
  a.message = data._error;
  a.addAction('OK');
  await a.present();
  Script.complete();
}

// ── 4. POST to edge function ──────────────────────────────────────────────────
const httpReq = new Request(EDGE_URL);
httpReq.method  = 'POST';
httpReq.headers = {'Content-Type': 'application/json', 'x-import-secret': SECRET};
httpReq.body    = JSON.stringify(data);

let resp;
try {
  resp = await httpReq.loadJSON();
} catch (netErr) {
  const a = new Alert();
  a.title = 'Network Error';
  a.message = 'Could not reach the server:\n' + netErr.message + '\n\nCheck your internet connection.';
  a.addAction('OK');
  await a.present();
  Script.complete();
}

// ── 5. Show result ────────────────────────────────────────────────────────────
const resultAlert = new Alert();
if (resp && resp.ok) {
  resultAlert.title   = '\u2713 Added to Pipeline';
  const addr = [data.address, data.city, data.state].filter(Boolean).join(', ');
  const rent = data.monthly_rent ? '$' + Number(data.monthly_rent).toLocaleString() + '/mo' : '';
  resultAlert.message = (resp.title || 'Listing') + '\n' + addr + (rent ? '\n' + rent : '') + '\n\nOpen your admin pipeline to review and publish.';
} else if (resp && resp.duplicate) {
  resultAlert.title   = 'Already in Pipeline';
  resultAlert.message = (resp.title || 'This listing') + ' is already in your pipeline.\n\nID: ' + resp.id;
} else {
  resultAlert.title   = 'Import Failed';
  resultAlert.message = (resp && resp.error) ? resp.error : 'Unknown server error. Try again.';
}
resultAlert.addAction('OK');
await resultAlert.present();

Script.complete();
