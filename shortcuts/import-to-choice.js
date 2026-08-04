// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: blue; icon-glyph: arrow.down.circle.fill;

// ============================================================
// Import to Choice Properties
// Version 3.1 — June 2026
//
// HOW TO USE (best — via iOS Shortcut, one tap from Safari):
//   1. Open any Zillow listing DETAIL page in Safari.
//   2. Tap Share → "Import to Choice" (iOS Shortcut).
//   3. Done. Listing appears in your admin pipeline.
//
// HOW TO USE (fallback — clipboard method):
//   1. Open any Zillow listing DETAIL page in Safari.
//   2. Tap the address bar → Copy.
//   3. Switch to Scriptable → tap "import-to-choice".
//
// UPDATES: The script checks for updates automatically on every
// run. When a new version is available it self-updates and asks
// you to tap Run once more — no manual reinstall ever needed.
// ============================================================

const VERSION      = '3.7';
const VERSION_URL  = 'https://choice-properties-site.pages.dev/shortcuts/version.json';
const SCRIPT_URL   = 'https://choice-properties-site.pages.dev/shortcuts/import-to-choice.js';
const EDGE_URL     = 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import';
const SECRET       = 'cp_import_7Kx3m9P2w5';

;(async function main() {

// ── 0. Self-update check — runs silently, never blocks import on failure ──────
try {
  const verReq = new Request(VERSION_URL);
  verReq.timeoutInterval = 6;
  const manifest = await verReq.loadJSON();

  if (manifest && manifest.version && manifest.version !== VERSION) {
    // Newer version available — download and overwrite this script on disk
    const scriptReq = new Request(SCRIPT_URL);
    scriptReq.timeoutInterval = 20;
    const newCode = await scriptReq.loadString();

    if (newCode && newCode.length > 500) {
      // Try iCloud FileManager first (default Scriptable setup), fall back to local
      let fm;
      try { fm = FileManager.iCloud(); fm.documentsDirectory(); }
      catch(e) { fm = FileManager.local(); }

      const scriptPath = fm.joinPath(fm.documentsDirectory(), Script.name() + '.js');
      fm.writeString(scriptPath, newCode);

      const ua = new Alert();
      ua.title   = '\u2728 Script Updated';
      ua.message = 'Import to Choice updated to v' + manifest.version + '.'
        + (manifest.changelog ? '\n\n' + manifest.changelog : '')
        + '\n\nTap Run again to use the new version.';
      ua.addAction('Run now');
      await ua.present();
      Script.complete();
      return;
    }
  }
} catch (updateErr) {
  // Update check failed (no network, server down, etc.) — continue normally.
  // The import itself will still work; update will retry next run.
}

// ── 1. Get URL ────────────────────────────────────────────────────────────────
// Priority: iOS Shortcut input → Share Sheet args → clipboard → manual prompt
let sharedUrl = null;

// Source A: iOS Shortcuts "Run Script" action passes the URL as shortcutParameter.
//
// CORRECT SHORTCUT SETUP (pass "Shortcut Input" directly — do NOT use "Get URLs from Input"):
//   Receive input from Share Sheet
//   Run import-to-choice with [Shortcut Input]
//
// WHY: "Get URLs from Input" on a Safari web page returns an empty list on iOS 16+
// because Safari web page is a different Shortcuts type from URL items.
// Passing Shortcut Input directly gives Scriptable the Safari page object, which
// has a .url property containing the actual page URL.
if (args.shortcutParameter) {
  let sp = args.shortcutParameter;

  // Unwrap array — some Shortcut configurations pass a list; take the first item.
  if (Array.isArray(sp) && sp.length > 0) {
    sp = sp[0];
  }

  let candidate = null;
  if (typeof sp === 'string') {
    candidate = sp.trim();
  } else if (typeof sp === 'object' && sp !== null) {
    // Safari web page object passed as Shortcut Input: .url holds the page URL.
    // Also try other common property names from different Shortcuts URL types.
    candidate = sp.url || sp.URL || sp.href || sp.link || sp.pageUrl
              || sp.URLString || sp.absoluteString || null;
    if (!candidate) {
      // Last resort: coerce to string — Safari web page objects often stringify to their URL
      const s = String(sp).trim();
      if (s.startsWith('http')) candidate = s;
    }
  }
  if (candidate && typeof candidate === 'string' && candidate.startsWith('http')) {
    sharedUrl = candidate;
  }
}

// Source B: Share Sheet URL args (direct Scriptable share extension)
if (!sharedUrl && args.urls && args.urls.length > 0) {
  sharedUrl = String(args.urls[0]).trim();
}

// Source C: Share Sheet plain text
if (!sharedUrl && args.plainTexts && args.plainTexts.length > 0 && args.plainTexts[0].includes('zillow.com')) {
  sharedUrl = args.plainTexts[0].trim();
}

// Source D: Clipboard — primary delivery method for the recommended Shortcut setup.
// The Shortcut copies the Zillow URL to clipboard before running this script,
// so Pasteboard.paste() reliably returns it regardless of args.shortcutParameter quirks.
if (!sharedUrl) {
  const clip = Pasteboard.paste();
  if (clip && typeof clip === 'string' && clip.trim().startsWith('http')) {
    sharedUrl = clip.trim();
  }
}

if (!sharedUrl) {
  // ── Shortcut misconfiguration detected ───────────────────────────────────
  const fixAlert = new Alert();
  fixAlert.title   = '⚙️ Shortcut Setup Needed';
  fixAlert.message = 'No URL was received. Rebuild the Shortcut exactly as follows:\n\n'
    + '1. Open Shortcuts → open "Import to Choice"\n'
    + '2. Delete all existing actions except "Receive input from Share Sheet"\n'
    + '3. Add action: "Get Details of Safari Web Page" → set field to URL\n'
    + '4. Add action: "Copy to Clipboard" → set input to the URL from step 3\n'
    + '5. Add action: "Run Script" → Script: import-to-choice (Parameter: leave empty)\n'
    + '6. Tap ⓘ → Share Sheet Types → Safari web pages ✓\n\n'
    + 'Or paste the Zillow URL below to import right now:';
  fixAlert.addTextField('https://www.zillow.com/homedetails/...');
  fixAlert.addAction('Import');
  fixAlert.addCancelAction('Cancel');
  const choice = await fixAlert.present();
  if (choice === -1) { Script.complete(); return; }
  sharedUrl = fixAlert.textFieldValue(0).trim();
}

if (!sharedUrl || !sharedUrl.startsWith('http')) {
  const a = new Alert();
  a.title   = 'No URL';
  a.message = 'Enter a valid Zillow listing URL.';
  a.addAction('OK');
  await a.present();
  Script.complete();
  return;
}

if (!sharedUrl.includes('zillow.com')) {
  const a = new Alert();
  a.title   = 'Wrong Page';
  a.message = 'This script only works on Zillow listing pages.\n\nURL received:\n' + sharedUrl;
  a.addAction('OK');
  await a.present();
  Script.complete();
  return;
}

// ── 2. Load page in WebView ───────────────────────────────────────────────────
const wv = new WebView();
try {
  await wv.loadURL(sharedUrl);
} catch (loadErr) {
  const a = new Alert();
  a.title   = 'Page Load Failed';
  a.message = 'Could not load the Zillow page:\n' + loadErr.message + '\n\nCheck your internet connection.';
  a.addAction('OK');
  await a.present();
  Script.complete();
  return;
}

// ── 3. Extract all listing data from __NEXT_DATA__ ────────────────────────────
// Wait longer by default and expose JSON-script inspection to handle
// Zillow hydration delays and alternate JSON embeddings.
async function waitForListingPage(wv, maxAttempts) {
  const attempts = typeof maxAttempts === 'number' ? maxAttempts : 12;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const stateRaw = await wv.evaluateJavaScript(`
      (function() {
        try {
          return JSON.stringify({
            readyState: document.readyState,
            href: location.href,
            hasNextDataElement: !!document.getElementById('__NEXT_DATA__'),
            hasNextDataWindow: typeof window.__NEXT_DATA__ !== 'undefined',
            jsonScripts: Array.from(document.querySelectorAll('script[type="application/json"]')).map(function(el){ return { id: el.id || null, len: (el.textContent || '').length }; }).filter(Boolean),
            sampleJson: (function(){
              try {
                var s = document.querySelector('script[type="application/json"]');
                return s ? String(s.textContent).slice(0,600) : null;
              } catch(e) { return null; }
            })()
          });
        } catch (e) {
          return JSON.stringify({ error: String(e.message) });
        }
      })()
    `);

    let state = null;
    try { state = JSON.parse(stateRaw); } catch (_) {}
    if (state && !state.error && (
      state.hasNextDataElement || state.hasNextDataWindow ||
      (state.href || '').includes('/homedetails/')
    )) {
      return state;
    }

    if (attempt < attempts - 1) {
      await new Promise(function(resolve) { setTimeout(resolve, 2000); });
    }
  }
  return null;
}

const extractionCode = `
(function() {
  try {
    // Helper: try parse any JSON script nodes and return the first one
    function scanJsonScriptsForNextData() {
      try {
        var scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        for (var i = 0; i < scripts.length; i++) {
          var txt = scripts[i].textContent;
          if (!txt || txt.length < 10) continue;
          try {
            var candidate = JSON.parse(txt);
            if (candidate) return candidate;
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
      return null;
    }

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
      if (typeof source === 'object' && source !== null) {
        return source;
      }
      return null;
    }

    function bestJpeg(ms) {
      var jpegs = (ms && ms.jpeg) || [];
      var best = null, bestW = 0;
      for (var i = 0; i < jpegs.length; i++) {
        var w = jpegs[i].width || 0;
        if (w > bestW) { bestW = w; best = jpegs[i].url || null; }
      }
      return best;
    }

    function dedupZillowPhotos(urls) {
      var byHash = {};
      function scoreOf(u) {
        if (/-uncropped_scaled_within_1536_1152\.jpg/i.test(u)) return 3;
        if (/-cc_ft_1536\.jpg/i.test(u)) return 2;
        if (/-p_h\.jpg/i.test(u)) return 1;
        return 0;
      }
      for (var i = 0; i < urls.length; i++) {
        var u = urls[i];
        if (!u || typeof u !== 'string') continue;
        var m = u.match(/\/fp\/([a-f0-9]{16,})-/i);
        var hash = m ? m[1] : u;
        var score = scoreOf(u);
        var cur = byHash[hash];
        if (!cur || score > cur.score) { byHash[hash] = { url: u, score: score }; }
      }
      var deduped = [];
      for (var key in byHash) {
        if (Object.prototype.hasOwnProperty.call(byHash, key)) {
          deduped.push(byHash[key].url);
        }
      }
      return deduped;
    }

    function collectPhotos(prop) {
      var photos = [];
      var seen = {};
      function add(u) {
        if (u && typeof u === 'string' && u.indexOf('http') === 0 && !seen[u]) {
          photos.push(u);
          seen[u] = true;
        }
      }
      for (var i = 0; i < (prop.responsivePhotosOriginalRatio || []).length; i++) {
        var p = prop.responsivePhotosOriginalRatio[i];
        add(bestJpeg(p.mixedSources) || p.url);
      }
      for (var i = 0; i < (prop.responsivePhotos || []).length; i++) {
        var p = prop.responsivePhotos[i];
        add(bestJpeg(p.mixedSources) || p.url);
      }
      var source3 = prop.hugePhotos || prop.largePhotos || [];
      for (var i = 0; i < source3.length; i++) {
        var p = source3[i];
        add(typeof p === 'string' ? p : (p && p.url));
      }
      for (var i = 0; i < (prop.photos || []).length; i++) {
        var p = prop.photos[i];
        add(typeof p === 'string' ? p : (p && p.url));
      }
      add(prop.desktopWebHdpImageLink);
      add(prop.heroImage);
      var deduped = dedupZillowPhotos(photos);
      if (deduped.length > 50) deduped = deduped.slice(0, 50);
      return deduped;
    }

    function parseDate(v) {
      if (!v) return null;
      var s = String(v).trim();
      var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) return m[1];
      if (/^\d{13}$/.test(s)) {
        try { return new Date(parseInt(s, 10)).toISOString().slice(0, 10); } catch (_) {}
      }
      if (/^\d{10}$/.test(s)) {
        try { return new Date(parseInt(s, 10) * 1000).toISOString().slice(0, 10); } catch (_) {}
      }
      try { var d = new Date(s); if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10); } catch (_) {}
      return s.slice(0, 40);
    }

    function safeI(v) {
      if (!v && v !== 0) return null;
      var n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
      return isNaN(n) || n <= 0 ? null : n;
    }

    function parseRent(rawPrice, rentZestimate) {
      var rent = null;
      if (typeof rawPrice === 'number' && rawPrice > 0) rent = rawPrice;
      else if (rawPrice) { var d = String(rawPrice).replace(/[^0-9]/g, ''); rent = d ? parseInt(d, 10) : null; }
      if (!rent && rentZestimate) rent = parseInt(String(rentZestimate), 10) || null;
      return rent;
    }

    var TYPE_MAP = {
      SINGLE_FAMILY: 'SINGLE_FAMILY', MULTI_FAMILY: 'MULTI_FAMILY', CONDO: 'CONDOS',
      CONDO_TOWNHOME: 'CONDOS', TOWNHOUSE: 'TOWNHOMES', APARTMENT: 'APARTMENT',
      MANUFACTURED: 'MOBILE', MOBILE: 'MOBILE', LOT: 'LAND', LAND: 'LAND', FARM: 'FARM'
    };

    function normalizeType(homeType) {
      var t = (homeType || '').toUpperCase();
      return TYPE_MAP[t] || t || null;
    }

    function fmtType(t) {
      if (!t) return 'Rental';
      return t.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    }

    function buildTitle(beds, propType, city, street) {
      return city ? ((beds ? beds + 'BR ' : '') + fmtType(propType) + ' in ' + city) : (street || 'Rental Listing');
    }

    function canonicalZillowUrl(url, zpid) {
      if (!zpid) return url;
      var m = url.match(/(https?:\/\/[^/]+\/homedetails\/[^/]+)\/\d+_zpid\/?/i);
      if (m) {
        var urlZpid = (url.match(/(\d+)_zpid/i) || [])[1];
        if (urlZpid && urlZpid !== zpid) {
          return m[1] + '/' + zpid + '_zpid/';
        }
      }
      return url;
    }

    function basePayload(source, id, url, overrides) {
      var base = {
        source: source, source_listing_id: id, source_url: url,
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
        original_image_urls: '[]', agent_name: null, broker_name: null
      };
      for (var key in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
          base[key] = overrides[key];
        }
      }
      return base;
    }

    function extractZillow(doc, url) {
      var nd = getNextData(doc);
      // Fallback: try window.__NEXT_DATA__ or scan JSON scripts
      if (!nd && typeof window !== 'undefined' && typeof window.__NEXT_DATA__ !== 'undefined') nd = window.__NEXT_DATA__;
      if (!nd) nd = scanJsonScriptsForNextData();
      if (!nd) return null;
      var prop = null;
      var cachePaths = [
        ['props', 'pageProps', 'componentProps', 'gdpClientCache'],
        ['props', 'pageProps', 'initialData', 'gdpClientCache'],
        ['props', 'pageProps', 'gdpClientCache']
      ];
      for (var ci = 0; ci < cachePaths.length && !prop; ci++) {
        try {
          var node = nd;
          for (var pi = 0; pi < cachePaths[ci].length; pi++) { node = node[cachePaths[ci][pi]]; }
          if (!node) continue;
          var cache = (typeof node === 'string') ? JSON.parse(node) : node;
          if (typeof cache !== 'object' || !cache) continue;
          var ckeys = Object.keys(cache);
          for (var ki = 0; ki < ckeys.length && !prop; ki++) {
            var v = cache[ckeys[ki]];
            if (!v || typeof v !== 'object') continue;
            if (v.property && v.property.zpid) { prop = v.property; break; }
            if (v.data && v.data.property && v.data.property.zpid) { prop = v.data.property; break; }
            if (v.zpid !== undefined && (v.bedrooms !== undefined || v.price !== undefined)) { prop = v; break; }
          }
        } catch (e) {}
      }
      if (!prop) {
        try {
          var cp = nd.props.pageProps.componentProps;
          if (cp && cp.homeDetails && cp.homeDetails.zpid) prop = cp.homeDetails;
        } catch (e) {}
      }
      if (!prop) return null;
      var rf = prop.resoFacts || {};
      var addr = prop.address || {};
      var zpid = String(prop.zpid || '');
      var street = addr.streetAddress || prop.streetAddress || '';
      var city = addr.city || prop.city || '';
      var state = addr.state || prop.state || '';
      var zip = addr.zipcode || prop.zipcode || '';
      var beds = (prop.bedrooms != null) ? prop.bedrooms : (prop.beds != null ? prop.beds : null);
      var bathsR = (prop.bathrooms != null) ? prop.bathrooms : (prop.baths != null ? prop.baths : null);
      var bathF = (bathsR != null) ? Math.floor(bathsR) : null;
      var bathH = (bathsR != null && bathsR !== bathF) ? 1 : null;
      var lat = prop.latitude || (prop.latLong && prop.latLong.latitude) || null;
      var lng = prop.longitude || (prop.latLong && prop.latLong.longitude) || null;
      var sqft = prop.livingArea || prop.area || null;
      var yr = prop.yearBuilt || rf.yearBuilt || null;
      var hood = prop.neighborhoodName || prop.neighborhood || rf.subdivision || addr.neighborhood || null;
      var county = prop.county || addr.county || null;
      var vtour = prop.virtualTourUrl || prop.threeDimensionalTourUrl || null;
      var unitNumber = addr.unit || addr.unitNumber || prop.unit || null;
      var flooring = null;
      if (rf.flooring) {
        if (Array.isArray(rf.flooring)) flooring = JSON.stringify(rf.flooring);
        else if (typeof rf.flooring === 'string') flooring = JSON.stringify([rf.flooring]);
      }
      var propType = normalizeType(prop.homeType);
      var ctxParts = [];
      if (prop.walkScore != null) ctxParts.push('Walk score: ' + prop.walkScore);
      if (prop.transitScore != null) ctxParts.push('Transit score: ' + prop.transitScore);
      if (prop.bikeScore != null) ctxParts.push('Bike score: ' + prop.bikeScore);
      var amenityMap = {};
      function addA(v) { if (v && typeof v === 'string') { var t = v.trim(); if (t) amenityMap[t] = true; } }
      for (var i = 0; i < (prop.tags || []).length; i++) addA(prop.tags[i]);
      var featureSources = [].concat(rf.communityFeatures || [], rf.interiorFeatures || [], rf.exteriorFeatures || [], rf.poolFeatures || []);
      for (var i = 0; i < featureSources.length; i++) addA(featureSources[i]);
      var parking = null;
      if (rf.parkingFeatures && rf.parkingFeatures.length) {
        parking = rf.parkingFeatures.join(', ');
      } else if (prop.parkingType) {
        parking = String(prop.parkingType).replace(/_/g, ' ');
      }
      var pets = prop.isPetFriendly != null ? prop.isPetFriendly : (rf.petsAllowed != null ? rf.petsAllowed : null);
      var petTypes = [];
      if (rf.catsAllowed) petTypes.push('cats');
      if (rf.dogsAllowed) petTypes.push('dogs');
      var minLease = null;
      var ltRaw = rf.leaseTerm || rf.leaseTerms || rf.minimumLease || null;
      if (ltRaw) {
        var lt = String(ltRaw).toLowerCase();
        var mmo = lt.match(/(\d+)\s*month/);
        if (mmo) { minLease = parseInt(mmo[1], 10); }
        else if (/month\.to\.month|m2m|mtm/.test(lt)) { minLease = 1; }
        else if (/\byear\b|12[\s-]*month|annual/.test(lt)) { minLease = 12; }
      }
      var petDetails = rf.petPolicy || rf.petDetails || null;
      return basePayload('zillow', zpid, canonicalZillowUrl(url, zpid), {
        title: buildTitle(beds, propType, city, street),
        address: street, city: city, state: state, zip: zip, lat: lat, lng: lng,
        monthly_rent: parseRent(prop.price || prop.unformattedPrice, prop.rentZestimate),
        bedrooms: beds, bathrooms: bathF, half_bathrooms: bathH,
        square_footage: sqft ? parseInt(String(sqft), 10) : null,
        year_built: yr ? parseInt(String(yr), 10) : null,
        floors: safeI(prop.stories || rf.stories),
        garage_spaces: safeI(prop.garageParkingCapacity || prop.garageSpaces),
        total_units: safeI(prop.unitCount),
        property_type: propType,
        description: prop.description || prop.propertyDescription || prop.descriptionText || null,
        neighborhood: hood, county: county,
        location_context: ctxParts.length ? ctxParts.join('; ') : null,
        pets_allowed: pets,
        pet_types_allowed: JSON.stringify(petTypes),
        available_date: parseDate(rf.dateAvailable || rf.availableFrom || prop.dateAvailable),
        minimum_lease_months: minLease,
        smoking_allowed: rf.smokingAllowed != null ? !!rf.smokingAllowed : null,
        security_deposit: safeI(rf.securityDeposit),
        pet_deposit: safeI(rf.petFee || rf.petDepositFee),
        admin_fee: safeI(rf.adminFee),
        parking_fee: safeI(rf.parkingFee),
        application_fee: safeI(rf.applicationFeeAmount || rf.applicationFee),
        hoa_fee: safeI(prop.monthlyHoaFee || prop.hoaFee),
        last_months_rent: safeI(rf.lastMonthRent),
        move_in_special: rf.concessions ? String(rf.concessions).slice(0, 200) : null,
        parking: parking,
        amenities: JSON.stringify(Object.keys(amenityMap)),
        appliances: JSON.stringify(rf.appliances || []),
        utilities_included: JSON.stringify(rf.utilities || rf.utilitiesIncluded || []),
        heating_type: rf.heating && rf.heating.length ? rf.heating.join(', ') : null,
        cooling_type: rf.cooling && rf.cooling.length ? rf.cooling.join(', ') : null,
        laundry_type: rf.laundryFeatures && rf.laundryFeatures.length ? rf.laundryFeatures.join(', ') : null,
        virtual_tour_url: vtour,
        has_basement: !!(rf.basement && rf.basement !== 'None' && rf.basement !== 'false' && rf.basement !== false),
        has_central_air: !!(rf.hasCooling || (rf.cooling && rf.cooling.some(function(c) { return c.toLowerCase().indexOf('central') >= 0; }))),
        original_image_urls: JSON.stringify(collectPhotos(prop)),
        agent_name: (prop.attributionInfo && prop.attributionInfo.agentName) || null,
        broker_name: (prop.attributionInfo && prop.attributionInfo.brokerName) || null,
        unit_number: unitNumber,
        pet_details: petDetails,
        flooring: flooring
      });
    }

    var payload = extractZillow(document, location.href);
    if (!payload) {
      return JSON.stringify({_error: 'Could not find listing data on this Zillow page.'});
    }
    return JSON.stringify(payload);
  } catch (e) {
    return JSON.stringify({_error: 'Extraction error: ' + e.message});
  }
})()
`;

// ── Helper: show a blocking alert ─────────────────────────────────────────────
async function showAlert(title, message) {
  const a = new Alert();
  a.title   = title;
  a.message = message;
  a.addAction('OK');
  await a.present();
}

await waitForListingPage(wv, 3);

let raw = null;
let lastEvalErr = null;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    raw = await wv.evaluateJavaScript(extractionCode);
    if (raw && raw !== 'null' && raw !== 'undefined' && String(raw).trim() !== '') {
      break;
    }
  } catch (evalErr) {
    lastEvalErr = evalErr;
  }

  if (attempt < 2) {
    await new Promise(function(resolve) { setTimeout(resolve, 1500); });
  }
}

if (!raw || raw === 'null' || raw === 'undefined' || String(raw).trim() === '') {
  const detail = lastEvalErr ? '\n\nJavaScript error: ' + lastEvalErr.message : '';
  await showAlert('No Data Returned', 'The Zillow page loaded but did not return any listing data yet.' + detail + '\n\nThis usually means the page is still loading, was redirected, or you are on a search results page instead of a listing detail page.');
  Script.complete();
  return;
}

// Guard: null/empty means the WebView JS returned nothing — Zillow may have
// shown a CAPTCHA, a redirect, or a search results page instead of a listing.
if (!raw || raw === 'null' || raw === 'undefined' || raw.trim() === '') {
  await showAlert('No Data Returned', 'The Zillow page loaded but did not return any listing data.\n\nPossible causes:\n• You are on a search results page, not a listing detail page\n• Zillow showed a CAPTCHA\n• The page redirected\n\nOpen the listing in Safari, scroll down until you see the full address and price, then try again.');
  Script.complete();
  return;
}

let data;
try {
  data = JSON.parse(raw);
} catch (parseErr) {
  await showAlert('Parse Error', 'Could not read extraction result.\n\nRaw output (first 300 chars):\n' + String(raw).slice(0, 300));
  Script.complete();
  return;
}

// Guard: parsed to null
if (!data || typeof data !== 'object') {
  await showAlert('No Data', 'Page returned empty data. Make sure you are on a Zillow listing detail page, then try again.');
  Script.complete();
  return;
}

if (data._error) {
  await showAlert('Extraction Failed', data._error);
  Script.complete();
  return;
}

// Guard: must have a zpid — if missing, we are not on a listing detail page
if (!data.source_listing_id || String(data.source_listing_id).trim() === '') {
  await showAlert('Not a Listing Page', 'Could not find a listing ID on this page.\n\nMake sure you are on a Zillow listing DETAIL page (the one with a specific address, price, and photos) — not a search results page.\n\nURL: ' + sharedUrl.slice(0, 100));
  Script.complete();
  return;
}

// ── 4. POST to edge function ──────────────────────────────────────────────────
const httpReq    = new Request(EDGE_URL);
httpReq.method   = 'POST';
httpReq.headers  = { 'Content-Type': 'application/json', 'x-import-secret': SECRET };
httpReq.body     = JSON.stringify(data);

let resp;
try {
  resp = await httpReq.loadJSON();
} catch (netErr) {
  await showAlert('Network Error', 'Could not reach the server:\n' + netErr.message + '\n\nCheck your internet connection and try again.');
  Script.complete();
  return;
}

// Guard: server returned nothing or non-JSON
if (!resp || typeof resp !== 'object') {
  await showAlert('Server Error', 'Server returned an unexpected response. Try again in a moment.');
  Script.complete();
  return;
}

// ── 5. Show result ────────────────────────────────────────────────────────────
const resultAlert = new Alert();
if (resp && resp.ok) {
  resultAlert.title = '\u2713 Added to Pipeline';
  const addr  = [data.address, data.city, data.state].filter(Boolean).join(', ');
  const rent  = data.monthly_rent ? '$' + Number(data.monthly_rent).toLocaleString() + '/mo' : '';
  const score = resp.score != null ? '  ·  Quality: ' + resp.score + '/100' : '';
  const imgs  = (() => { try { return JSON.parse(data.original_image_urls || '[]').length; } catch(e) { return 0; } })();
  const imgStr = imgs > 0 ? '\n' + imgs + ' photos captured' : '';
  resultAlert.message = (resp.title || 'Listing') + '\n' + addr
    + (rent ? '\n' + rent : '') + score + imgStr
    + '\n\nOpen your admin pipeline to review and publish.';
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
})();
