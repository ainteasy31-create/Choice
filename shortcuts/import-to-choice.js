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

const VERSION      = '3.5';
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
// The value may be a plain URL string, a Safari web page object, or an ARRAY
// of URL objects/strings (e.g. when "Get URLs from Input" result is passed).
if (args.shortcutParameter) {
  let sp = args.shortcutParameter;

  // Unwrap array — "Get URLs from Input" passes a list; take the first item.
  if (Array.isArray(sp) && sp.length > 0) {
    sp = sp[0];
  }

  let candidate = null;
  if (typeof sp === 'string') {
    candidate = sp.trim();
  } else if (typeof sp === 'object' && sp !== null) {
    // Safari web page object or Shortcuts URL object: try common URL property names
    candidate = sp.url || sp.URL || sp.href || sp.link || sp.pageUrl || null;
    if (!candidate) {
      // Last resort: coerce to string (sometimes gives the URL directly)
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

// Source D: Clipboard (reliable manual fallback — copy URL from Safari address bar)
if (!sharedUrl) {
  const clip = Pasteboard.paste();
  if (clip && clip.trim().startsWith('http')) {
    sharedUrl = clip.trim();
  }
}

if (!sharedUrl) {
  // ── Shortcut misconfiguration detected ───────────────────────────────────
  // The script received no URL from any source.  This almost always means the
  // iOS Shortcut is not configured to pass the webpage URL to Scriptable.
  // Show a diagnostic alert first, then fall back to the manual-paste prompt.
  const fixAlert = new Alert();
  fixAlert.title   = '⚙️ Shortcut Setup Needed';
  fixAlert.message = 'The Shortcut did not pass the page URL to this script.\n\n'
    + 'FIX (takes 60 seconds):\n'
    + '1. Open the Shortcuts app\n'
    + '2. Open the "Import to Choice" shortcut\n'
    + '3. In the "Run Script" action → set Parameter to "Shortcut Input"\n'
    + '4. Tap ⓘ on the shortcut → Share Sheet Types → Safari web pages ✓\n\n'
    + 'Or paste the URL below to import right now:';
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
const extractionCode = `
(function() {
  try {

    // ── Locate __NEXT_DATA__ ────────────────────────────────────────────────
    var el = document.getElementById('__NEXT_DATA__') || document.querySelector('script#__NEXT_DATA__');
    if (!el && window.__NEXT_DATA__) {
      var nd = window.__NEXT_DATA__;
    } else if (!el) {
      return JSON.stringify({_error: 'No listing data found. Make sure you are on a Zillow listing DETAIL page (not a search results page).'});
    }

    var nd;
    try {
      nd = nd || JSON.parse(el.textContent);
    } catch(pe) {
      return JSON.stringify({_error: 'Could not parse page data: ' + pe.message});
    }

    // ── Extract property object from gdpClientCache ─────────────────────────
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
        var cache = (typeof node === 'string') ? JSON.parse(node) : node;
        if (typeof cache !== 'object' || !cache) continue;
        var ckeys = Object.keys(cache);
        for (var ki = 0; ki < ckeys.length && !prop; ki++) {
          var v = cache[ckeys[ki]];
          if (!v || typeof v !== 'object') continue;
          if (v.property && typeof v.property === 'object' && v.property.zpid) { prop = v.property; break; }
          if (v.data && v.data.property && v.data.property.zpid)               { prop = v.data.property; break; }
          if (v.zpid !== undefined && (v.bedrooms !== undefined || v.price !== undefined)) { prop = v; break; }
        }
      } catch(e2) {}
    }

    // Fallback: homeDetails directly on componentProps
    if (!prop) {
      try {
        var cp = nd.props.pageProps.componentProps;
        if (cp && cp.homeDetails && cp.homeDetails.zpid) prop = cp.homeDetails;
      } catch(e3) {}
    }

    if (!prop) {
      return JSON.stringify({_error: 'Could not find listing data in page. Navigate directly to the full Zillow listing detail page (not a search) and try again.'});
    }

    var rf   = prop.resoFacts || {};
    var addr = prop.address   || {};

    // ── Photos — highest resolution first, deduplicated ─────────────────────
    // bestJpeg: pick the largest JPEG URL by pixel width from mixedSources
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
        if (!cur || score > cur.score) {
          byHash[hash] = { url: u, score: score };
        }
      }
      var deduped = [];
      for (var key in byHash) { if (Object.prototype.hasOwnProperty.call(byHash, key)) { deduped.push(byHash[key].url); } }
      return deduped;
    }

    var photos = [], photoSeen = {};
    function addPhoto(u) {
      if (u && typeof u === 'string' && u.indexOf('http') === 0 && !photoSeen[u]) {
        photos.push(u); photoSeen[u] = true;
      }
    }

    // Source 1: responsivePhotosOriginalRatio — original aspect ratio, full-res JPEG
    var s1 = prop.responsivePhotosOriginalRatio || [];
    for (var i = 0; i < s1.length; i++) {
      addPhoto(bestJpeg(s1[i].mixedSources) || s1[i].url || null);
    }
    // Source 2: responsivePhotos — standard Zillow set (fills in any gaps)
    var s2 = prop.responsivePhotos || [];
    for (var i = 0; i < s2.length; i++) {
      addPhoto(bestJpeg(s2[i].mixedSources) || s2[i].url || null);
    }
    // Source 3: hugePhotos / largePhotos (older Zillow format)
    var s3 = prop.hugePhotos || prop.largePhotos || [];
    for (var i = 0; i < s3.length; i++) {
      var p3 = s3[i];
      addPhoto(typeof p3 === 'string' ? p3 : (p3 && (p3.url || p3.href || p3.src)));
    }
    // Source 4: flat photos array
    var s4 = prop.photos || [];
    for (var i = 0; i < s4.length; i++) {
      var p4 = s4[i];
      addPhoto(typeof p4 === 'string' ? p4 : (p4 && (p4.url || p4.href || p4.src)));
    }
    // Source 5: absolute fallbacks
    addPhoto(prop.desktopWebHdpImageLink);
    addPhoto(prop.heroImage);

    photos = dedupZillowPhotos(photos);
    if (photos.length > 50) photos = photos.slice(0, 50);

    // ── Amenities / utilities / features ───────────────────────────────────
    var amenityMap = {};
    function addAmenity(v) {
      if (v && typeof v === 'string') {
        var text = v.trim();
        if (text) amenityMap[text] = true;
      }
    }
    for (var i = 0; i < (prop.tags || []).length; i++) addAmenity(prop.tags[i]);
    for (var i = 0; i < (rf.communityFeatures || []).length; i++) addAmenity(rf.communityFeatures[i]);
    for (var i = 0; i < (rf.interiorFeatures || []).length; i++) addAmenity(rf.interiorFeatures[i]);
    for (var i = 0; i < (rf.exteriorFeatures || []).length; i++) addAmenity(rf.exteriorFeatures[i]);
    for (var i = 0; i < (rf.poolFeatures || []).length; i++) addAmenity(rf.poolFeatures[i]);
    for (var i = 0; i < (rf.accessibilityFeatures || []).length; i++) addAmenity(rf.accessibilityFeatures[i]);
    for (var i = 0; i < (rf.lotFeatures || []).length; i++) addAmenity(rf.lotFeatures[i]);
    var amenities = JSON.stringify(Object.keys(amenityMap));
    var appliances = JSON.stringify(rf.appliances || []);
    var utilities = JSON.stringify(rf.utilities || rf.utilitiesIncluded || []);
    var heating = (rf.heating && rf.heating.length) ? rf.heating.join(', ') : null;
    var cooling = (rf.cooling && rf.cooling.length) ? rf.cooling.join(', ') : null;
    var laundry = (rf.laundryFeatures && rf.laundryFeatures.length) ? rf.laundryFeatures.join(', ') : null;
    var flooring = null;
    if (rf.flooring) {
      if (Array.isArray(rf.flooring)) flooring = JSON.stringify(rf.flooring);
      else if (typeof rf.flooring === 'string') flooring = JSON.stringify([rf.flooring]);
    }
    var petTypes = [];
    if (rf.catsAllowed) petTypes.push('cats');
    if (rf.dogsAllowed) petTypes.push('dogs');
    var petTypesAllowed = JSON.stringify(petTypes);
    var petDetails = rf.petPolicy || rf.petDetails || null;
    var smokingAllowed = (rf.smokingAllowed !== undefined && rf.smokingAllowed !== null) ? !!rf.smokingAllowed : null;
    var parking = null;
    if (rf.parkingFeatures && rf.parkingFeatures.length) {
      parking = rf.parkingFeatures.join(', ');
    } else if (prop.parkingType) {
      parking = String(prop.parkingType).replace(/_/g, ' ');
    }
    var virtualTour = prop.virtualTourUrl || prop.threeDimensionalTourUrl || null;
    var unitNumber = addr.unit || addr.unitNumber || prop.unit || null;
    var hasBasement = !!(rf.basement && rf.basement !== 'None' && rf.basement !== 'No basement' && rf.basement !== 'false' && rf.basement !== false);
    var hasCentralAir = !!(rf.hasCooling || (rf.cooling && rf.cooling.some(function(c) { return String(c).toLowerCase().indexOf('central') >= 0; })));

    if (photos.length > 50) photos = photos.slice(0, 50);

    // ── Basic price / bath ──────────────────────────────────────────────────
    var rawPrice = prop.price || prop.unformattedPrice;
    var rent = null;
    if (typeof rawPrice === 'number' && rawPrice > 0) {
      rent = rawPrice;
    } else if (typeof rawPrice === 'string') {
      var digits = rawPrice.replace(/[^0-9]/g, '');
      rent = digits ? parseInt(digits, 10) : null;
    }
    // Fallback: rentZestimate if no price listed
    if (!rent && prop.rentZestimate) rent = parseInt(String(prop.rentZestimate), 10) || null;

    var bathsRaw  = (prop.bathrooms != null) ? prop.bathrooms : (prop.baths != null ? prop.baths : null);
    var bathF     = (bathsRaw != null) ? Math.floor(bathsRaw) : null;
    var bathH     = (bathsRaw != null && bathsRaw !== bathF) ? 1 : null;

    // ── Core location fields ────────────────────────────────────────────────
    var zpid   = String(prop.zpid || '');
    var street = addr.streetAddress || prop.streetAddress || '';
    var city   = addr.city    || prop.city    || '';
    var state  = addr.state   || prop.state   || '';
    var zip    = addr.zipcode || prop.zipcode || '';
    var beds   = (prop.bedrooms != null) ? prop.bedrooms : (prop.beds != null ? prop.beds : null);
    var sqft   = prop.livingArea || prop.area || null;
    var yr     = prop.yearBuilt || rf.yearBuilt || null;
    var lat    = prop.latitude  || (prop.latLong && prop.latLong.latitude)  || null;
    var lng    = prop.longitude || (prop.latLong && prop.latLong.longitude) || null;
    var hood   = prop.neighborhoodName || prop.neighborhood || rf.subdivision || addr.neighborhood || null;
    var county = prop.county || addr.county || null;
    var vtour  = prop.virtualTourUrl || prop.threeDimensionalTourUrl || null;

    // ── Property type — UPPER_UNDERSCORE (matches Python scraper) ───────────
    var typeMapUp = {
      'SINGLE_FAMILY': 'SINGLE_FAMILY', 'MULTI_FAMILY': 'MULTI_FAMILY',
      'CONDO': 'CONDOS', 'CONDO_TOWNHOME': 'CONDOS', 'TOWNHOUSE': 'TOWNHOMES',
      'APARTMENT': 'APARTMENT', 'MANUFACTURED': 'MOBILE', 'MOBILE': 'MOBILE',
      'LOT': 'LAND', 'LAND': 'LAND', 'FARM': 'FARM'
    };
    var rawType  = (prop.homeType || '').toUpperCase();
    var propType = typeMapUp[rawType] || rawType || null;

    // ── available_date → YYYY-MM-DD ─────────────────────────────────────────
    function parseISODate(v) {
      if (!v) return null;
      var s = String(v).trim();
      // Already ISO date
      var m = s.match(/^(\\d{4}-\\d{2}-\\d{2})/);
      if (m) return m[1];
      // Epoch milliseconds (13 digits)
      if (/^\\d{13}$/.test(s)) {
        try { return new Date(parseInt(s, 10)).toISOString().slice(0, 10); } catch(e) {}
      }
      // Epoch seconds (10 digits)
      if (/^\\d{10}$/.test(s)) {
        try { return new Date(parseInt(s, 10) * 1000).toISOString().slice(0, 10); } catch(e) {}
      }
      // Natural language ("August 1, 2026", "8/1/2026", etc.)
      try {
        var d = new Date(s);
        if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      } catch(e) {}
      return s.slice(0, 40); // store raw as fallback
    }
    var avail = parseISODate(rf.dateAvailable || rf.availableFrom || prop.dateAvailable);

    // ── Fees — all available on the detail page ─────────────────────────────
    function safeIntStr(v) {
      if (v == null || v === '' || v === false) return null;
      var n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
      return (isNaN(n) || n <= 0) ? null : n;
    }
    var deposit       = safeIntStr(rf.securityDeposit);
    var petDeposit    = safeIntStr(rf.petFee || rf.petDepositFee || rf.petDeposit);
    var adminFee      = safeIntStr(rf.adminFee);
    var parkingFeeVal = safeIntStr(rf.parkingFee);
    var appFee        = safeIntStr(rf.applicationFeeAmount || rf.applicationFee);
    var hoaFee        = safeIntStr(prop.monthlyHoaFee || prop.hoaFee);
    var lastMonthRent = safeIntStr(rf.lastMonthRent);
    var moveInSpecial = rf.concessions ? String(rf.concessions).slice(0, 200) : null;

    // ── Physical features ───────────────────────────────────────────────────
    var floors       = safeIntStr(prop.stories || rf.stories);
    var garageSpaces = safeIntStr(prop.garageParkingCapacity || prop.garageSpaces || rf.garageSpaces);
    var totalUnits   = safeIntStr(prop.unitCount || prop.numberOfUnitsTotal);

    // Lot size → always store in sqft
    var lotSqft = null;
    if (prop.lotAreaValue) {
      var lv = parseFloat(String(prop.lotAreaValue));
      var lu = String(prop.lotAreaUnit || '').toLowerCase();
      if (!isNaN(lv) && lv > 0) {
        lotSqft = (lu.indexOf('acre') >= 0) ? Math.round(lv * 43560) : Math.round(lv);
      }
    } else if (prop.lotSize) {
      var ls = parseFloat(String(prop.lotSize));
      if (!isNaN(ls) && ls > 0) lotSqft = Math.round(ls);
    }

    // Minimum lease months
    var minLease = null;
    var ltRaw = rf.leaseTerm || rf.leaseTerms || rf.minimumLease || null;
    if (ltRaw) {
      var lt = String(ltRaw).toLowerCase();
      var mmo = lt.match(/(\\d+)\\s*month/);
      if (mmo) { minLease = parseInt(mmo[1], 10); }
      else if (/month.to.month|m2m|mtm/.test(lt)) { minLease = 1; }
      else if (/\\byear\\b|12[\\s-]*month|annual/.test(lt)) { minLease = 12; }
    }

    var smokingAllowed = (rf.smokingAllowed !== undefined && rf.smokingAllowed !== null)
      ? !!rf.smokingAllowed : null;

    // ── Pets ────────────────────────────────────────────────────────────────
    var pets = (prop.isPetFriendly !== undefined && prop.isPetFriendly !== null)
      ? prop.isPetFriendly
      : (rf.petsAllowed !== undefined ? rf.petsAllowed : null);
    var petTypes = [];
    if (rf.catsAllowed) petTypes.push('cats');
    if (rf.dogsAllowed) petTypes.push('dogs');

    // ── HVAC / laundry / parking ────────────────────────────────────────────
    var heating = (rf.heating && rf.heating.length) ? rf.heating.join(', ') : null;
    var cooling = (rf.cooling && rf.cooling.length) ? rf.cooling.join(', ') : null;
    var laundry = (rf.laundryFeatures && rf.laundryFeatures.length) ? rf.laundryFeatures.join(', ') : null;
    var parking = null;
    if (rf.parkingFeatures && rf.parkingFeatures.length) {
      parking = rf.parkingFeatures.join(', ');
    } else if (prop.parkingType) {
      parking = String(prop.parkingType).replace(/_/g, ' ');
    }

    // ── Amenities — merge all available sources ─────────────────────────────
    var amenityMap = {};
    function addAmenity(v) {
      if (v && typeof v === 'string') { var t = v.trim(); if (t) amenityMap[t] = true; }
    }
    var tagSrc = prop.tags || [];
    for (var i = 0; i < tagSrc.length; i++) addAmenity(tagSrc[i]);

    var featSrc = []
      .concat(rf.communityFeatures  || [])
      .concat(rf.interiorFeatures   || [])
      .concat(rf.exteriorFeatures   || [])
      .concat(rf.lotFeatures        || [])
      .concat(rf.poolFeatures       || [])
      .concat(rf.accessibilityFeatures || []);
    for (var i = 0; i < featSrc.length; i++) addAmenity(featSrc[i]);

    var amenities  = JSON.stringify(Object.keys(amenityMap));
    var appliances = JSON.stringify(rf.appliances || []);
    var utilities  = JSON.stringify(rf.utilities  || rf.utilitiesIncluded || []);

    // ── Basement / central air ──────────────────────────────────────────────
    var basement = !!(rf.basement && rf.basement !== 'None' && rf.basement !== 'No basement'
                   && rf.basement !== 'false' && rf.basement !== false);
    var centralAir = !!(rf.hasCooling || (rf.cooling && rf.cooling.some(function(c) {
      return c.toLowerCase().indexOf('central') >= 0;
    })));

    // ── Walk / transit / bike scores → location_context ─────────────────────
    var ctxParts = [];
    if (prop.walkScore    != null) ctxParts.push('Walk score: '    + prop.walkScore);
    if (prop.transitScore != null) ctxParts.push('Transit score: ' + prop.transitScore);
    if (prop.bikeScore    != null) ctxParts.push('Bike score: '    + prop.bikeScore);
    var locationContext = ctxParts.length ? ctxParts.join('; ') : null;

    // ── Agent / broker ──────────────────────────────────────────────────────
    var ai = prop.attributionInfo || {};
    var agentName  = ai.agentName  || null;
    var brokerName = ai.brokerName || null;

    // ── Title (human-readable, consistent with Python scraper) ──────────────
    function fmtType(t) {
      if (!t) return 'Rental';
      return t.replace(/_/g, ' ').replace(/\\b\\w/g, function(c) { return c.toUpperCase(); });
    }
    var title = city
      ? ((beds ? beds + 'BR ' : '') + fmtType(propType) + ' in ' + city)
      : (street || 'Zillow Rental');

    // ── Return complete payload ─────────────────────────────────────────────
    return JSON.stringify({
      source:              'zillow',
      source_listing_id:   zpid,
      source_url:          window.location.href,
      title:               title,
      address:             street,
      unit_number:         unitNumber,
      city:                city,
      state:               state,
      zip:                 zip,
      lat:                 lat,
      lng:                 lng,
      monthly_rent:        rent,
      bedrooms:            beds,
      bathrooms:           bathF,
      half_bathrooms:      bathH,
      square_footage:      sqft ? parseInt(String(sqft), 10) : null,
      year_built:          yr   ? parseInt(String(yr),   10) : null,
      lot_size_sqft:       lotSqft,
      floors:              floors,
      garage_spaces:       garageSpaces,
      total_units:         totalUnits,
      property_type:       propType,
      description:         prop.description || prop.propertyDescription || prop.descriptionText || null,
      neighborhood:        hood,
      county:              county,
      location_context:    locationContext,
      pets_allowed:        pets,
      pet_types_allowed:   petTypesAllowed,
      pet_details:         petDetails,
      available_date:      avail,
      minimum_lease_months: minLease,
      smoking_allowed:     smokingAllowed,
      security_deposit:    deposit,
      pet_deposit:         petDeposit,
      admin_fee:           adminFee,
      parking_fee:         parkingFeeVal,
      application_fee:     appFee,
      hoa_fee:             hoaFee,
      last_months_rent:    lastMonthRent,
      move_in_special:     moveInSpecial,
      parking:             parking,
      amenities:           amenities,
      appliances:          appliances,
      utilities_included:  utilities,
      flooring:            flooring,
      heating_type:        heating,
      cooling_type:        cooling,
      laundry_type:        laundry,
      virtual_tour_url:    virtualTour,
      has_basement:        hasBasement,
      has_central_air:     hasCentralAir,
      original_image_urls: JSON.stringify(photos),
      agent_name:          ai.agentName || null,
      broker_name:         ai.brokerName || null
    });

  } catch(e) {
    return JSON.stringify({_error: 'Extraction error: ' + e.message + ' (stack: ' + (e.stack || '').slice(0,200) + ')'});
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

let raw;
try {
  raw = await wv.evaluateJavaScript(extractionCode);
} catch (evalErr) {
  await showAlert('Script Error', 'JavaScript extraction failed:\n' + evalErr.message
    + '\n\nMake sure you are on a Zillow DETAIL page (with a full address), not a search results page.');
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
