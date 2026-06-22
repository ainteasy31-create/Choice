// ============================================================
// Choice Properties — import-from-url Edge Function
// v1.0 — June 2026
//
// Fetches a Zillow listing URL server-side, extracts __NEXT_DATA__,
// parses listing fields, and inserts into pipeline.pipeline_properties.
// Auth: admin Bearer JWT (same session token used by the admin portal).
//
// POST body: { url: string, dry_run?: boolean }
// Returns:   { ok: true, id, title, score, photos, fields }
//          | { ok: false, duplicate: true, id, title }
//          | { ok: false, blocked: true }   — Zillow blocked the request
//          | { error: string }
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsResponse, jsonOk, jsonErr } from '../_shared/cors.ts';

// ── Quality-score weights (mirrors receive-pipeline-import exactly) ────────────
const CORE_FIELDS = [
  'address','city','state','zip','lat','lng',
  'bedrooms','bathrooms','square_footage','monthly_rent',
  'property_type','description','available_date',
];
const BONUS_FIELDS = [
  'county','neighborhood','year_built','parking',
  'pets_allowed','security_deposit','amenities','appliances',
  'heating_type','cooling_type','laundry_type',
];
const TRACKABLE_MISSING = [
  'lat','lng','county','neighborhood','year_built','square_footage',
  'parking','pets_allowed','security_deposit','amenities','appliances',
  'available_date','heating_type','cooling_type','laundry_type',
];

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || v === '[]';
}
function qualityScore(r: Record<string,unknown>): number {
  let sc = 0;
  for (const f of CORE_FIELDS)  if (!isEmpty(r[f])) sc += 6;
  for (const f of BONUS_FIELDS) if (!isEmpty(r[f])) sc += 2;
  try {
    const urls = JSON.parse((r.original_image_urls as string) || '[]');
    sc += Array.isArray(urls) && urls.length >= 5 ? 6 : urls.length >= 1 ? 3 : 0;
  } catch { /* ignore */ }
  return Math.min(sc, 100);
}
function missingFields(r: Record<string,unknown>): string {
  return JSON.stringify(TRACKABLE_MISSING.filter(f => isEmpty(r[f])));
}
function genId(): string {
  return 'PP-' + crypto.randomUUID().replace(/-/g,'').slice(0,8).toUpperCase();
}

// ── Type helpers ───────────────────────────────────────────────────────────────
function safeInt(v: unknown): number | null {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[^0-9.-]/g,'');
  const n = parseInt(s, 10);
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
  if (v === 'true'  || v === '1' || v === 1)  return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return null;
}
function normalizePropType(v: unknown): string | null {
  if (!v) return null;
  const MAP: Record<string,string> = {
    'SINGLE_FAMILY':'SINGLE_FAMILY','MULTI_FAMILY':'MULTI_FAMILY',
    'CONDO':'CONDOS','CONDO_TOWNHOME':'CONDOS','TOWNHOUSE':'TOWNHOMES',
    'APARTMENT':'APARTMENT','MANUFACTURED':'MOBILE','MOBILE':'MOBILE',
    'LOT':'LAND','LAND':'LAND','FARM':'FARM',
  };
  const up = String(v).trim().toUpperCase();
  return MAP[up] ?? up.replace(/[\s-]+/g,'_') || null;
}
function normalizeDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  if (/^\d{13}$/.test(s)) { try { return new Date(parseInt(s)).toISOString().slice(0,10); } catch{} }
  if (/^\d{10}$/.test(s)) { try { return new Date(parseInt(s)*1000).toISOString().slice(0,10); } catch{} }
  try { const d = new Date(s); if(!isNaN(d.getTime())) return d.toISOString().slice(0,10); } catch{}
  return s.slice(0,40);
}

// ── Zillow __NEXT_DATA__ extraction ───────────────────────────────────────────
function extractFromNextData(html: string): Record<string,unknown> | { _error: string } {
  // Extract __NEXT_DATA__ script tag via regex
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([^<]{10,})<\/script>/i);
  if (!match) {
    // Check if this looks like a CAPTCHA or bot-check page
    if (html.includes('captcha') || html.includes('robot') || html.includes('challenge')) {
      return { _error: 'blocked', _blocked: true };
    }
    return { _error: 'No __NEXT_DATA__ found — this URL may not be a Zillow listing detail page' };
  }

  let nd: Record<string,unknown>;
  try { nd = JSON.parse(match[1]); } catch(e) {
    return { _error: 'Could not parse __NEXT_DATA__: ' + (e as Error).message };
  }

  // Traverse known cache paths to find the property object
  const cachePaths = [
    ['props','pageProps','componentProps','gdpClientCache'],
    ['props','pageProps','initialData','gdpClientCache'],
    ['props','pageProps','gdpClientCache'],
  ];

  let prop: Record<string,unknown> | null = null;
  for (const path of cachePaths) {
    if (prop) break;
    try {
      // deno-lint-ignore no-explicit-any
      let node: any = nd;
      for (const key of path) { node = node?.[key]; }
      if (!node) continue;
      const cache = typeof node === 'string' ? JSON.parse(node) : node;
      if (typeof cache !== 'object' || !cache) continue;
      for (const v of Object.values(cache as Record<string,unknown>)) {
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
  const rf   = (prop.resoFacts   || {}) as Record<string,any>;
  // deno-lint-ignore no-explicit-any
  const addr = (prop.address     || {}) as Record<string,any>;
  // deno-lint-ignore no-explicit-any
  const ai   = (prop.attributionInfo || {}) as Record<string,any>;

  // Photos: best JPEG from mixedSources, deduplicated
  function bestJpeg(ms: Record<string,unknown> | null | undefined): string | null {
    // deno-lint-ignore no-explicit-any
    const jpegs: any[] = (ms as any)?.jpeg || [];
    let best: string | null = null, bestW = 0;
    for (const j of jpegs) { if ((j.width||0) > bestW) { bestW = j.width; best = j.url||null; } }
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
  for (const p of (prop.responsivePhotosOriginalRatio as any[])||[]) addPhoto(bestJpeg(p.mixedSources)||p.url);
  // deno-lint-ignore no-explicit-any
  for (const p of (prop.responsivePhotos as any[])||[]) addPhoto(bestJpeg(p.mixedSources)||p.url);
  // deno-lint-ignore no-explicit-any
  for (const p of (prop.hugePhotos||prop.largePhotos||[]) as any[]) addPhoto(typeof p==='string'?p:(p?.url||p?.href||p?.src));
  // deno-lint-ignore no-explicit-any
  for (const p of (prop.photos||[]) as any[]) addPhoto(typeof p==='string'?p:(p?.url||p?.href||p?.src));
  addPhoto(prop.desktopWebHdpImageLink);
  addPhoto(prop.heroImage);
  const photosCapped = photos.slice(0, 50);

  // Price
  let rent: number | null = null;
  const rawPrice = prop.price || prop.unformattedPrice;
  if (typeof rawPrice === 'number' && rawPrice > 0) { rent = rawPrice; }
  else if (typeof rawPrice === 'string') { const d = rawPrice.replace(/[^0-9]/g,''); rent = d ? parseInt(d,10) : null; }
  if (!rent && prop.rentZestimate) rent = parseInt(String(prop.rentZestimate),10)||null;

  // Bathrooms
  const bathsRaw = prop.bathrooms ?? prop.baths ?? null;
  const bathF = bathsRaw != null ? Math.floor(Number(bathsRaw)) : null;
  const bathH = bathsRaw != null && Number(bathsRaw) !== bathF ? 1 : null;

  // Lot size → sqft
  let lotSqft: number | null = null;
  if (prop.lotAreaValue) {
    const lv = parseFloat(String(prop.lotAreaValue));
    const lu = String(prop.lotAreaUnit||'').toLowerCase();
    if (!isNaN(lv) && lv > 0) lotSqft = lu.includes('acre') ? Math.round(lv*43560) : Math.round(lv);
  } else if (prop.lotSize) {
    const ls = parseFloat(String(prop.lotSize));
    if (!isNaN(ls) && ls > 0) lotSqft = Math.round(ls);
  }

  // Min lease months
  let minLease: number | null = null;
  const ltRaw = rf.leaseTerm||rf.leaseTerms||rf.minimumLease||null;
  if (ltRaw) {
    const lt = String(ltRaw).toLowerCase();
    const mmo = lt.match(/(\d+)\s*month/);
    if (mmo) minLease = parseInt(mmo[1],10);
    else if (/month.to.month|m2m|mtm/.test(lt)) minLease = 1;
    else if (/\byear\b|12[\s-]*month|annual/.test(lt)) minLease = 12;
  }

  // Amenities
  const amenityMap: Record<string,boolean> = {};
  // deno-lint-ignore no-explicit-any
  for (const t of (prop.tags||[]) as any[]) { const s=String(t).trim(); if(s) amenityMap[s]=true; }
  for (const arr of [
    rf.communityFeatures, rf.interiorFeatures, rf.exteriorFeatures,
    rf.lotFeatures, rf.poolFeatures, rf.accessibilityFeatures,
  ]) {
    // deno-lint-ignore no-explicit-any
    for (const t of (arr||[]) as any[]) { const s=String(t).trim(); if(s) amenityMap[s]=true; }
  }

  // Walk/transit/bike → location_context
  const ctxParts: string[] = [];
  if (prop.walkScore    != null) ctxParts.push('Walk score: '    + prop.walkScore);
  if (prop.transitScore != null) ctxParts.push('Transit score: ' + prop.transitScore);
  if (prop.bikeScore    != null) ctxParts.push('Bike score: '    + prop.bikeScore);

  // Parking
  let parking: string | null = null;
  if (rf.parkingFeatures?.length) parking = (rf.parkingFeatures as string[]).join(', ');
  else if (prop.parkingType) parking = String(prop.parkingType).replace(/_/g,' ');

  // Central air + basement
  const centralAir = !!(rf.hasCooling || (rf.cooling as string[]|undefined)?.some((c:string) => c.toLowerCase().includes('central')));
  const basement   = !!(rf.basement && rf.basement !== 'None' && rf.basement !== 'No basement' && rf.basement !== 'false' && rf.basement !== false);

  // Pet types
  const petTypes: string[] = [];
  if (rf.catsAllowed) petTypes.push('cats');
  if (rf.dogsAllowed) petTypes.push('dogs');

  // Title
  const beds    = prop.bedrooms ?? prop.beds ?? null;
  const propType = normalizePropType(prop.homeType);
  function fmtType(t: string|null) {
    if (!t) return 'Rental';
    return t.replace(/_/g,' ').replace(/\b\w/g,(c:string)=>c.toUpperCase());
  }
  const city = addr.city || prop.city || '';
  const title = city
    ? ((beds ? beds + 'BR ' : '') + fmtType(propType) + ' in ' + city)
    : (addr.streetAddress || prop.streetAddress || 'Zillow Rental');

  return {
    source:              'zillow',
    source_listing_id:   String(prop.zpid||''),
    source_url:          null, // caller provides the URL
    title,
    address:             addr.streetAddress || prop.streetAddress || null,
    city,
    state:               addr.state    || prop.state    || null,
    zip:                 addr.zipcode  || prop.zipcode  || null,
    lat:                 prop.latitude  || (prop.latLong as Record<string,unknown>|null)?.latitude  || null,
    lng:                 prop.longitude || (prop.latLong as Record<string,unknown>|null)?.longitude || null,
    monthly_rent:        rent,
    bedrooms:            beds != null ? Number(beds) : null,
    bathrooms:           bathF,
    half_bathrooms:      bathH,
    square_footage:      prop.livingArea || prop.area || null,
    lot_size_sqft:       lotSqft,
    year_built:          prop.yearBuilt || rf.yearBuilt || null,
    floors:              prop.stories   || rf.stories   || null,
    garage_spaces:       prop.garageParkingCapacity || prop.garageSpaces || rf.garageSpaces || null,
    total_units:         prop.unitCount || prop.numberOfUnitsTotal || null,
    property_type:       propType,
    description:         prop.description || null,
    neighborhood:        prop.neighborhoodName || prop.neighborhood || rf.subdivision || addr.neighborhood || null,
    county:              prop.county || addr.county || null,
    location_context:    ctxParts.length ? ctxParts.join('; ') : null,
    available_date:      normalizeDate(rf.dateAvailable || rf.availableFrom || prop.dateAvailable),
    minimum_lease_months: minLease,
    pets_allowed:        prop.isPetFriendly ?? (rf.petsAllowed !== undefined ? rf.petsAllowed : null),
    pet_types_allowed:   JSON.stringify(petTypes),
    smoking_allowed:     rf.smokingAllowed != null ? !!rf.smokingAllowed : null,
    security_deposit:    safeInt(rf.securityDeposit),
    pet_deposit:         safeInt(rf.petFee || rf.petDepositFee || rf.petDeposit),
    admin_fee:           safeInt(rf.adminFee),
    parking_fee:         safeInt(rf.parkingFee),
    application_fee:     safeInt(rf.applicationFeeAmount || rf.applicationFee),
    hoa_fee:             safeInt(prop.monthlyHoaFee || prop.hoaFee),
    last_months_rent:    safeInt(rf.lastMonthRent),
    move_in_special:     rf.concessions ? String(rf.concessions).slice(0,200) : null,
    parking,
    amenities:           JSON.stringify(Object.keys(amenityMap)),
    appliances:          JSON.stringify(rf.appliances || []),
    utilities_included:  JSON.stringify(rf.utilities || rf.utilitiesIncluded || []),
    heating_type:        (rf.heating as string[]|undefined)?.join(', ') || null,
    cooling_type:        (rf.cooling as string[]|undefined)?.join(', ') || null,
    laundry_type:        (rf.laundryFeatures as string[]|undefined)?.join(', ') || null,
    has_basement:        basement,
    has_central_air:     centralAir,
    virtual_tour_url:    prop.virtualTourUrl || prop.threeDimensionalTourUrl || null,
    original_image_urls: JSON.stringify(photosCapped),
    agent_name:          ai.agentName  || null,
    broker_name:         ai.brokerName || null,
  };
}

// ── Realistic browser headers to reduce Zillow bot detection ──────────────────
const BROWSER_HEADERS: Record<string,string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

// ── Handler ────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse(req.headers.get('origin'));
  if (req.method !== 'POST')   return jsonErr(405, 'Method not allowed', req);

  // ── Auth: require logged-in admin ────────────────────────────────────────────
  const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON_KEY      = Deno.env.get('SUPABASE_ANON_KEY')!;

  const authHeader = req.headers.get('authorization') || '';
  const userToken  = authHeader.replace(/^Bearer\s+/i, '');
  if (!userToken) return jsonErr(401, 'Missing authorization header', req);

  const userClient  = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: 'Bearer ' + userToken } },
  });
  const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

  // Verify user is authenticated
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return jsonErr(401, 'Invalid session', req);

  // Verify admin role
  const { data: roleRow } = await adminClient
    .from('admin_roles')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!roleRow) return jsonErr(403, 'Admin access required', req);

  // ── Parse body ───────────────────────────────────────────────────────────────
  let body: { url?: string; dry_run?: boolean };
  try { body = await req.json(); } catch { return jsonErr(400, 'Invalid JSON body', req); }

  const rawUrl = (body.url || '').trim();
  if (!rawUrl) return jsonErr(400, 'url is required', req);
  if (!rawUrl.startsWith('http')) return jsonErr(400, 'url must be a full https:// URL', req);
  if (!rawUrl.includes('zillow.com')) return jsonErr(400, 'Only Zillow URLs are supported', req);
  const dryRun = !!body.dry_run;

  // ── Fetch Zillow page ────────────────────────────────────────────────────────
  let html: string;
  try {
    const res = await fetch(rawUrl, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
    });
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        return jsonOk({ ok: false, blocked: true, message: 'Zillow blocked the server-side request (status ' + res.status + '). Use the iOS Scriptable importer instead — it runs from your phone\'s residential IP which Zillow allows.' }, req);
      }
      return jsonErr(502, 'Zillow returned HTTP ' + res.status, req);
    }
    html = await res.text();
  } catch(e) {
    return jsonErr(502, 'Failed to fetch Zillow page: ' + (e as Error).message, req);
  }

  // ── Extract listing data ─────────────────────────────────────────────────────
  const extracted = extractFromNextData(html);

  if ('_error' in extracted) {
    if ((extracted as Record<string,unknown>)._blocked) {
      return jsonOk({ ok: false, blocked: true, message: 'Zillow served a CAPTCHA or bot-check page. Use the iOS Scriptable importer instead — it runs from your phone\'s residential IP which Zillow allows.' }, req);
    }
    return jsonOk({ ok: false, error: extracted._error as string }, req);
  }

  const sourceListingId = safeStr(extracted.source_listing_id);
  if (!sourceListingId) {
    return jsonOk({ ok: false, error: 'Could not extract a listing ID (zpid) from this page. Make sure you are on a single listing detail page.' }, req);
  }

  // ── Dry run: return extracted data without inserting ─────────────────────────
  if (dryRun) {
    return jsonOk({ ok: true, dry_run: true, extracted, source_listing_id: sourceListingId }, req);
  }

  // ── Duplicate check ──────────────────────────────────────────────────────────
  const { data: existing } = await adminClient
    .schema('pipeline')
    .from('pipeline_properties')
    .select('id, title')
    .eq('source_listing_id', sourceListingId)
    .eq('source', 'zillow')
    .maybeSingle();
  if (existing) {
    return jsonOk({ ok: false, duplicate: true, id: existing.id, title: existing.title, message: 'Already in pipeline' }, req);
  }

  // ── Build record ─────────────────────────────────────────────────────────────
  const now = new Date().toISOString();
  const propType = normalizePropType(extracted.property_type);

  const originalData = JSON.stringify({
    zpid:         sourceListingId,
    detailUrl:    rawUrl,
    homeType:     propType,
    _source:      'zillow',
    _import:      'admin-url-import-v1',
    _imported_at: now,
    _imported_by: user.id,
  });

  const record: Record<string,unknown> = {
    id:                   genId(),
    source:               'zillow',
    source_url:           rawUrl,
    source_listing_id:    sourceListingId,
    status:               'scraped',
    title:                safeStr(extracted.title) ?? (sourceListingId),
    address:              safeStr(extracted.address),
    unit_number:          null,
    city:                 safeStr(extracted.city),
    state:                safeStr(extracted.state),
    zip:                  safeStr(extracted.zip),
    county:               safeStr(extracted.county),
    neighborhood:         safeStr(extracted.neighborhood),
    lat:                  safeFloat(extracted.lat),
    lng:                  safeFloat(extracted.lng),
    location_context:     safeStr(extracted.location_context),
    property_type:        propType,
    bedrooms:             safeInt(extracted.bedrooms),
    bathrooms:            safeInt(extracted.bathrooms),
    half_bathrooms:       safeInt(extracted.half_bathrooms),
    total_bathrooms:      safeFloat(extracted.bathrooms),
    square_footage:       safeInt(extracted.square_footage),
    lot_size_sqft:        safeInt(extracted.lot_size_sqft),
    year_built:           safeInt(extracted.year_built),
    floors:               safeInt(extracted.floors),
    garage_spaces:        safeInt(extracted.garage_spaces),
    total_units:          safeInt(extracted.total_units),
    has_basement:         extracted.has_basement === true,
    has_central_air:      extracted.has_central_air === true,
    virtual_tour_url:     safeStr(extracted.virtual_tour_url),
    monthly_rent:         safeInt(extracted.monthly_rent),
    security_deposit:     safeInt(extracted.security_deposit),
    last_months_rent:     safeInt(extracted.last_months_rent),
    application_fee:      safeInt(extracted.application_fee),
    pet_deposit:          safeInt(extracted.pet_deposit),
    admin_fee:            safeInt(extracted.admin_fee),
    move_in_special:      safeStr(extracted.move_in_special),
    parking_fee:          safeInt(extracted.parking_fee),
    hoa_fee:              safeInt(extracted.hoa_fee),
    tax_value:            null,
    description:          safeStr(extracted.description),
    showing_instructions: null,
    available_date:       safeStr(extracted.available_date),
    minimum_lease_months: safeInt(extracted.minimum_lease_months),
    lease_terms:          '[]',
    pets_allowed:         safeBool(extracted.pets_allowed),
    pet_types_allowed:    safeStr(extracted.pet_types_allowed) ?? '[]',
    pet_weight_limit:     null,
    pet_details:          null,
    smoking_allowed:      safeBool(extracted.smoking_allowed),
    parking:              safeStr(extracted.parking),
    amenities:            safeStr(extracted.amenities) ?? '[]',
    appliances:           safeStr(extracted.appliances) ?? '[]',
    utilities_included:   safeStr(extracted.utilities_included) ?? '[]',
    flooring:             '[]',
    heating_type:         safeStr(extracted.heating_type),
    cooling_type:         safeStr(extracted.cooling_type),
    laundry_type:         safeStr(extracted.laundry_type),
    original_image_urls:  safeStr(extracted.original_image_urls) ?? '[]',
    local_image_paths:    '[]',
    agent_name:           safeStr(extracted.agent_name),
    broker_name:          safeStr(extracted.broker_name),
    agent_image_url:      null,
    poster_landlord_id:   null,
    original_data:        originalData,
    edited_fields:        '[]',
    inferred_features:    '[]',
    published_at:         null,
    choice_property_id:   null,
    scraped_at:           now,
    updated_at:           now,
  };

  record.data_quality_score = qualityScore(record);
  record.missing_fields     = missingFields(record);

  // ── Insert ───────────────────────────────────────────────────────────────────
  const { error: insertErr } = await adminClient
    .schema('pipeline')
    .from('pipeline_properties')
    .insert(record);

  if (insertErr) {
    console.error('Insert error:', insertErr);
    return jsonErr(500, 'Database insert failed: ' + insertErr.message, req);
  }

  let photoCount = 0;
  try { const u = JSON.parse((record.original_image_urls as string)||'[]'); photoCount = Array.isArray(u)?u.length:0; } catch{}

  // Count populated fields for summary
  const populatedFields = [...CORE_FIELDS, ...BONUS_FIELDS].filter(f => !isEmpty(record[f]));

  return jsonOk({
    ok:              true,
    id:              record.id,
    title:           String(record.title),
    score:           record.data_quality_score,
    photos:          photoCount,
    city:            safeStr(extracted.city),
    rent:            safeInt(extracted.monthly_rent),
    populated_fields: populatedFields,
    missing_fields:  TRACKABLE_MISSING.filter(f => isEmpty(record[f])),
  }, req);
});
