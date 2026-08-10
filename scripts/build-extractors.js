#!/usr/bin/env node
/**
 * Choice Properties — Build Script for Canonical Extractor
 * =========================================================
 * Generates runtime variants from src/extractors/shared-extractors.js:
 *   1. chrome-extension/shared-extractors.js  (browser IIFE)
 *   2. .pages-orion/live-shared-extractors.js (browser IIFE, same content)
 *   3. supabase/functions/_shared/zillow-extract.ts (Deno/TypeScript)
 *
 * Usage: node scripts/build-extractors.js
 * Run after editing src/extractors/shared-extractors.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'extractors', 'shared-extractors.js');

// ── Read canonical source ─────────────────────────────────────────────
if (!fs.existsSync(SRC)) {
  console.error('ERROR: Canonical extractor not found at', SRC);
  process.exit(1);
}
const canonical = fs.readFileSync(SRC, 'utf8');

// ── 1. Browser variant (chrome-extension + .pages-orion) ──────────────
// The canonical file IS already a browser IIFE. We just copy it.
const browserHeader = `// ============================================================
// Choice Properties — Multi-site Listing Extractor Registry
// GENERATED FILE — DO NOT EDIT DIRECTLY.
// Edit src/extractors/shared-extractors.js and run:
//   node scripts/build-extractors.js
// ============================================================
`;

const browserContent = browserHeader + canonical;

// Write to chrome-extension
const chromeTarget = path.join(ROOT, 'chrome-extension', 'shared-extractors.js');
fs.writeFileSync(chromeTarget, browserContent, 'utf8');
console.log('✓ Generated chrome-extension/shared-extractors.js');

// Write to .pages-orion
const orionTarget = path.join(ROOT, '.pages-orion', 'live-shared-extractors.js');
fs.writeFileSync(orionTarget, browserContent, 'utf8');
console.log('✓ Generated .pages-orion/live-shared-extractors.js');

// ── 2. Deno/TypeScript variant (for Edge Functions) ───────────────────
// Convert the IIFE to a Deno module that exports the extractor functions.
// We extract the core logic by wrapping it in a module pattern.

const denoContent = `// ============================================================
// Choice Properties — Zillow Extractor (Deno/TypeScript)
// GENERATED FILE — DO NOT EDIT DIRECTLY.
// Edit src/extractors/shared-extractors.js and run:
//   node scripts/build-extractors.js
// ============================================================

// This module provides the Zillow extraction logic for the
// import-from-url Edge Function. It parses __NEXT_DATA__ JSON
// from a Zillow listing page and returns a normalized payload.

export interface ZillowExtracted {
  source: string;
  source_listing_id: string;
  source_url: string | null;
  title: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  monthly_rent: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  half_bathrooms: number | null;
  square_footage: number | null;
  lot_size_sqft: number | null;
  year_built: number | null;
  floors: number | null;
  garage_spaces: number | null;
  total_units: number | null;
  property_type: string | null;
  description: string | null;
  neighborhood: string | null;
  county: string | null;
  location_context: string | null;
  pets_allowed: boolean | null;
  pet_types_allowed: string | null;
  available_date: string | null;
  minimum_lease_months: number | null;
  smoking_allowed: boolean | null;
  security_deposit: number | null;
  pet_deposit: number | null;
  admin_fee: number | null;
  parking_fee: number | null;
  application_fee: number | null;
  hoa_fee: number | null;
  last_months_rent: number | null;
  move_in_special: string | null;
  parking: string | null;
  amenities: string | null;
  appliances: string | null;
  utilities_included: string | null;
  heating_type: string | null;
  cooling_type: string | null;
  laundry_type: string | null;
  virtual_tour_url: string | null;
  has_basement: boolean | null;
  has_central_air: boolean | null;
  original_image_urls: string;
  agent_name: string | null;
  broker_name: string | null;
}

// ── Type coercion helpers ──────────────────────────────────────────────
function safeInt(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = parseInt(String(v).replace(/[^0-9.-]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function safeFloat(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

function safeStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function safeBool(v: unknown): boolean | null {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return null;
}

function normalizePropType(v: unknown): string | null {
  if (!v) return null;
  const MAP: Record<string, string> = {
    'SINGLE_FAMILY': 'SINGLE_FAMILY', 'MULTI_FAMILY': 'MULTI_FAMILY',
    'CONDO': 'CONDOS', 'CONDO_TOWNHOME': 'CONDOS', 'TOWNHOUSE': 'TOWNHOMES',
    'APARTMENT': 'APARTMENT', 'MANUFACTURED': 'MOBILE', 'MOBILE': 'MOBILE',
    'LOT': 'LAND', 'LAND': 'LAND', 'FARM': 'FARM',
  };
  const up = String(v).trim().toUpperCase();
  return (MAP[up] ?? up.replace(/[\\s-]+/g, '_')) || null;
}

function normalizeDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\\d{4}-\\d{2}-\\d{2})/);
  if (m) return m[1];
  if (/^\\d{13}$/.test(s)) { try { return new Date(parseInt(s)).toISOString().slice(0, 10); } catch { /* ignore */ } }
  if (/^\\d{10}$/.test(s)) { try { return new Date(parseInt(s) * 1000).toISOString().slice(0, 10); } catch { /* ignore */ } }
  try { const d = new Date(s); if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10); } catch { /* ignore */ }
  return s.slice(0, 40);
}

// ── Zillow __NEXT_DATA__ extraction ───────────────────────────────────
export function extractFromNextData(html: string): Record<string, unknown> | { _error: string; _blocked?: boolean } {
  // Extract __NEXT_DATA__ script tag via regex
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([^<]{10,})<\\/script>/i);
  if (!match) {
    // Check if this looks like a CAPTCHA or bot-check page
    if (html.includes('captcha') || html.includes('robot') || html.includes('challenge')) {
      return { _error: 'blocked', _blocked: true };
    }
    return { _error: 'No __NEXT_DATA__ found — this URL may not be a Zillow listing detail page' };
  }

  let nd: Record<string, unknown>;
  try { nd = JSON.parse(match[1]); } catch (e) {
    return { _error: 'Could not parse __NEXT_DATA__: ' + (e as Error).message };
  }

  // Traverse known cache paths to find the property object
  const cachePaths = [
    ['props', 'pageProps', 'componentProps', 'gdpClientCache'],
    ['props', 'pageProps', 'initialData', 'gdpClientCache'],
    ['props', 'pageProps', 'gdpClientCache'],
  ];

  // deno-lint-ignore no-explicit-any
  let prop: any = null;
  for (const path of cachePaths) {
    if (prop) break;
    try {
      // deno-lint-ignore no-explicit-any
      let node: any = nd;
      for (const key of path) { node = node?.[key]; }
      if (!node) continue;
      const cache = typeof node === 'string' ? JSON.parse(node) : node;
      if (typeof cache !== 'object' || !cache) continue;
      for (const v of Object.values(cache as Record<string, unknown>)) {
        // deno-lint-ignore no-explicit-any
        const vv = v as any;
        if (vv?.property?.zpid) { prop = vv.property; break; }
        if (vv?.data?.property?.zpid) { prop = vv.data.property; break; }
        if (vv?.zpid !== undefined && (vv?.bedrooms !== undefined || vv?.price !== undefined)) { prop = vv; break; }
      }
    } catch { /* try next path */ }
  }

  // Fallback: homeDetails directly on componentProps
  if (!prop) {
    try {
      // deno-lint-ignore no-explicit-any
      const cp = (nd as any)?.props?.pageProps?.componentProps;
      if (cp?.homeDetails?.zpid) prop = cp.homeDetails;
    } catch { /* ignore */ }
  }

  if (!prop) {
    return { _error: 'Could not find listing data in __NEXT_DATA__ — make sure you are on a single listing detail page, not search results' };
  }

  // deno-lint-ignore no-explicit-any
  const rf   = (prop.resoFacts   || {}) as Record<string, any>;
  // deno-lint-ignore no-explicit-any
  const addr = (prop.address     || {}) as Record<string, any>;
  // deno-lint-ignore no-explicit-any
  const ai   = (prop.attributionInfo || {}) as Record<string, any>;

  // Photos: best JPEG from mixedSources, deduplicated
  function bestJpeg(ms: Record<string, unknown> | null | undefined): string | null {
    // deno-lint-ignore no-explicit-any
    const jpegs: any[] = (ms as any)?.jpeg || [];
    let best: string | null = null, bestW = 0;
    for (const j of jpegs) { if ((j.width || 0) > bestW) { bestW = j.width; best = j.url || null; } }
    return best;
  }
  const photoSeen = new Set<string>();
  const photos: string[] = [];
  function addPhoto(u: unknown) {
    if (u && typeof u === 'string' && u.startsWith('http') && !photoSeen.has(u)) {
      photos.push(u); photoSeen.add(u);
    }
  }
  // deno-lint-ignore no-explicit-any
  for (const p of (prop.responsivePhotosOriginalRatio as any[]) || []) addPhoto(bestJpeg(p.mixedSources) || p.url);
  // deno-lint-ignore no-explicit-any
  for (const p of (prop.responsivePhotos as any[]) || []) addPhoto(bestJpeg(p.mixedSources) || p.url);
  // deno-lint-ignore no-explicit-any
  for (const p of (prop.hugePhotos || prop.largePhotos || []) as any[]) addPhoto(typeof p === 'string' ? p : (p?.url || p?.href || p?.src));
  // deno-lint-ignore no-explicit-any
  for (const p of (prop.photos || []) as any[]) addPhoto(typeof p === 'string' ? p : (p?.url || p?.href || p?.src));
  addPhoto(prop.desktopWebHdpImageLink);
  addPhoto(prop.heroImage);
  const photosCapped = photos.slice(0, 50);

  // Price
  let rent: number | null = null;
  const rawPrice = prop.price || prop.unformattedPrice;
  if (typeof rawPrice === 'number' && rawPrice > 0) { rent = rawPrice; }
  else if (typeof rawPrice === 'string') { const d = rawPrice.replace(/[^0-9]/g, ''); rent = d ? parseInt(d, 10) : null; }
  if (!rent && prop.rentZestimate) rent = parseInt(String(prop.rentZestimate), 10) || null;

  // Bathrooms
  const bathsRaw = prop.bathrooms ?? prop.baths ?? null;
  const bathF = bathsRaw != null ? Math.floor(Number(bathsRaw)) : null;
  const bathH = bathsRaw != null && Number(bathsRaw) !== bathF ? 1 : null;

  // Lot size → sqft
  let lotSqft: number | null = null;
  if (prop.lotAreaValue) {
    const lv = parseFloat(String(prop.lotAreaValue));
    const lu = String(prop.lotAreaUnit || '').toLowerCase();
    if (!isNaN(lv) && lv > 0) lotSqft = lu.includes('acre') ? Math.round(lv * 43560) : Math.round(lv);
  } else if (prop.lotSize) {
    const ls = parseFloat(String(prop.lotSize));
    if (!isNaN(ls) && ls > 0) lotSqft = Math.round(ls);
  }

  // Min lease months
  let minLease: number | null = null;
  const ltRaw = rf.leaseTerm || rf.leaseTerms || rf.minimumLease || null;
  if (ltRaw) {
    const lt = String(ltRaw).toLowerCase();
    const mmo = lt.match(/(\\d+)\\s*month/);
    if (mmo) minLease = parseInt(mmo[1], 10);
    else if (/month.to.month|m2m|mtm/.test(lt)) minLease = 1;
    else if (/\\byear\\b|12[\\s-]*month|annual/.test(lt)) minLease = 12;
  }

  // Amenities
  const amenityMap: Record<string, boolean> = {};
  // deno-lint-ignore no-explicit-any
  for (const t of (prop.tags || []) as any[]) { const s = String(t).trim(); if (s) amenityMap[s] = true; }
  for (const arr of [
    rf.communityFeatures, rf.interiorFeatures, rf.exteriorFeatures,
    rf.lotFeatures, rf.poolFeatures, rf.accessibilityFeatures,
  ]) {
    // deno-lint-ignore no-explicit-any
    for (const t of (arr || []) as any[]) { const s = String(t).trim(); if (s) amenityMap[s] = true; }
  }

  // Walk/transit/bike → location_context
  const ctxParts: string[] = [];
  if (prop.walkScore != null) ctxParts.push('Walk score: ' + prop.walkScore);
  if (prop.transitScore != null) ctxParts.push('Transit score: ' + prop.transitScore);
  if (prop.bikeScore != null) ctxParts.push('Bike score: ' + prop.bikeScore);

  // Parking
  let parking: string | null = null;
  if (rf.parkingFeatures?.length) parking = (rf.parkingFeatures as string[]).join(', ');
  else if (prop.parkingType) parking = String(prop.parkingType).replace(/_/g, ' ');

  // Central air + basement
  const centralAir = !!(rf.hasCooling || (rf.cooling as string[] | undefined)?.some((c: string) => c.toLowerCase().includes('central')));
  const basement = !!(rf.basement && rf.basement !== 'None' && rf.basement !== 'No basement' && rf.basement !== 'false' && rf.basement !== false);

  // Pet types
  const petTypes: string[] = [];
  if (rf.catsAllowed) petTypes.push('cats');
  if (rf.dogsAllowed) petTypes.push('dogs');

  // Title
  const beds = prop.bedrooms ?? prop.beds ?? null;
  const propType = normalizePropType(prop.homeType);
  function fmtType(t: string | null) {
    if (!t) return 'Rental';
    return t.replace(/_/g, ' ').replace(/\\b\\w/g, (c: string) => c.toUpperCase());
  }
  const city = addr.city || prop.city || '';
  const title = city
    ? ((beds ? beds + 'BR ' : '') + fmtType(propType) + ' in ' + city)
    : (addr.streetAddress || prop.streetAddress || 'Zillow Rental');

  return {
    source: 'zillow',
    source_listing_id: String(prop.zpid || ''),
    source_url: null, // caller provides the URL
    title,
    address: addr.streetAddress || prop.streetAddress || null,
    city,
    state: addr.state || prop.state || null,
    zip: addr.zipcode || prop.zipcode || null,
    lat: prop.latitude || (prop.latLong as Record<string, unknown> | null)?.latitude || null,
    lng: prop.longitude || (prop.latLong as Record<string, unknown> | null)?.longitude || null,
    monthly_rent: rent,
    bedrooms: beds != null ? Number(beds) : null,
    bathrooms: bathF,
    half_bathrooms: bathH,
    square_footage: prop.livingArea || prop.area || null,
    lot_size_sqft: lotSqft,
    year_built: prop.yearBuilt || rf.yearBuilt || null,
    floors: prop.stories || rf.stories || null,
    garage_spaces: prop.garageParkingCapacity || prop.garageSpaces || rf.garageSpaces || null,
    total_units: prop.unitCount || prop.numberOfUnitsTotal || null,
    property_type: propType,
    description: prop.description || null,
    neighborhood: prop.neighborhoodName || prop.neighborhood || rf.subdivision || addr.neighborhood || null,
    county: prop.county || addr.county || null,
    location_context: ctxParts.length ? ctxParts.join('; ') : null,
    available_date: normalizeDate(rf.dateAvailable || rf.availableFrom || prop.dateAvailable),
    minimum_lease_months: minLease,
    pets_allowed: prop.isPetFriendly ?? (rf.petsAllowed !== undefined ? rf.petsAllowed : null),
    pet_types_allowed: JSON.stringify(petTypes),
    smoking_allowed: rf.smokingAllowed != null ? !!rf.smokingAllowed : null,
    security_deposit: safeInt(rf.securityDeposit),
    pet_deposit: safeInt(rf.petFee || rf.petDepositFee || rf.petDeposit),
    admin_fee: safeInt(rf.adminFee),
    parking_fee: safeInt(rf.parkingFee),
    application_fee: safeInt(rf.applicationFeeAmount || rf.applicationFee),
    hoa_fee: safeInt(prop.monthlyHoaFee || prop.hoaFee),
    last_months_rent: safeInt(rf.lastMonthRent),
    move_in_special: rf.concessions ? String(rf.concessions).slice(0, 200) : null,
    parking,
    amenities: JSON.stringify(Object.keys(amenityMap)),
    appliances: JSON.stringify(rf.appliances || []),
    utilities_included: JSON.stringify(rf.utilities || rf.utilitiesIncluded || []),
    heating_type: (rf.heating as string[] | undefined)?.join(', ') || null,
    cooling_type: (rf.cooling as string[] | undefined)?.join(', ') || null,
    laundry_type: (rf.laundryFeatures as string[] | undefined)?.join(', ') || null,
    has_basement: basement,
    has_central_air: centralAir,
    virtual_tour_url: prop.virtualTourUrl || prop.threeDimensionalTourUrl || null,
    original_image_urls: JSON.stringify(photosCapped),
    agent_name: ai.agentName || null,
    broker_name: ai.brokerName || null,
  };
}
`;

const denoTarget = path.join(ROOT, 'supabase', 'functions', '_shared', 'zillow-extract.ts');
fs.writeFileSync(denoTarget, denoContent, 'utf8');
console.log('✓ Generated supabase/functions/_shared/zillow-extract.ts');

console.log('\n✅ All extractor variants generated successfully.');
console.log('   Edit src/extractors/shared-extractors.js to update all variants.');