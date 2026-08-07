// ============================================================
// Choice Properties — receive-pipeline-import Edge Function
// v2.0 — June 2026
//
// Accepts a parsed Zillow listing payload from the iOS Scriptable
// "Import to Choice" script (v3.0). Authenticates via a shared
// secret (x-import-secret header) — no user login required on phone.
//
// POST body: full listing fields from iOS script v3.0
// Returns:   { ok: true, id, title, score, photos }
//          | { ok: false, duplicate: true, id, title }
//          | { error: string }
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsResponse, jsonOk, jsonErr } from '../_shared/cors.ts';

// ── Quality-score weights — mirrors scraper/zillow_scraper.py exactly ─────────
// CORE: 13 fields × 6 pts = 78 pts max
const CORE_FIELDS = [
  'address', 'city', 'state', 'zip', 'lat', 'lng',
  'bedrooms', 'bathrooms', 'square_footage', 'monthly_rent',
  'property_type', 'description', 'available_date',
];
// BONUS: 11 fields × 2 pts = 22 pts max
// Photos add up to 6 pts. Total cap: 100.
const BONUS_FIELDS = [
  'county', 'neighborhood', 'year_built', 'parking',
  'pets_allowed', 'security_deposit', 'amenities', 'appliances',
  'heating_type', 'cooling_type', 'laundry_type',
];
// Fields shown as "missing" badges on the pipeline card
const TRACKABLE_MISSING = [
  'lat', 'lng', 'county', 'neighborhood', 'year_built', 'square_footage',
  'parking', 'pets_allowed', 'security_deposit', 'amenities', 'appliances',
  'available_date', 'heating_type', 'cooling_type', 'laundry_type',
];

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || v === '[]';
}

function qualityScore(r: Record<string, unknown>): number {
  let sc = 0;
  for (const f of CORE_FIELDS)  if (!isEmpty(r[f])) sc += 6;
  for (const f of BONUS_FIELDS) if (!isEmpty(r[f])) sc += 2;
  try {
    const urls = JSON.parse((r.original_image_urls as string) || '[]');
    sc += Array.isArray(urls) && urls.length >= 5 ? 6 : urls.length >= 1 ? 3 : 0;
  } catch { /* ignore */ }
  return Math.min(sc, 100);
}

function missingFields(r: Record<string, unknown>): string {
  return JSON.stringify(TRACKABLE_MISSING.filter(f => isEmpty(r[f])));
}

function genId(): string {
  return 'PP-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

// ── Type coercion helpers ──────────────────────────────────────────────────────
function safeInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v));
  return isNaN(n) ? null : n;
}

function safeFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

function safeStr(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  return s || null;
}

function safeBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (v === 'true'  || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
}

// ── Normalize property_type to UPPER_UNDERSCORE (matches Python scraper) ───────
function normalizePropType(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Already UPPER_UNDERSCORE
  if (/^[A-Z_]+$/.test(s)) return s;
  // Title-case variants from older iOS script versions
  const MAP: Record<string, string> = {
    'Single Family': 'SINGLE_FAMILY', 'Single-Family': 'SINGLE_FAMILY',
    'Multi Family':  'MULTI_FAMILY',  'Multi-Family':  'MULTI_FAMILY',
    'Condo':         'CONDOS',        'Condos':         'CONDOS',
    'Townhouse':     'TOWNHOMES',     'Townhomes':      'TOWNHOMES',
    'Apartment':     'APARTMENT',
    'Manufactured':  'MOBILE',        'Mobile':         'MOBILE',
    'Land':          'LAND',          'Lot':            'LAND',
    'Farm':          'FARM',
  };
  return MAP[s] ?? s.toUpperCase().replace(/[\s-]+/g, '_');
}

function normalizeSource(v: unknown): string {
  const source = safeStr(v)?.toLowerCase() ?? 'zillow';
  if (!['zillow', 'realtor', 'apartments', 'redfin'].includes(source)) {
    throw new Error(`Unsupported source: ${source}`);
  }
  return source;
}

// ── Normalize available_date to YYYY-MM-DD ─────────────────────────────────────
function normalizeDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Already ISO date
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  // Epoch ms
  if (/^\d{13}$/.test(s)) {
    try { return new Date(parseInt(s)).toISOString().slice(0, 10); } catch { /* ignore */ }
  }
  // Epoch s
  if (/^\d{10}$/.test(s)) {
    try { return new Date(parseInt(s) * 1000).toISOString().slice(0, 10); } catch { /* ignore */ }
  }
  // Natural language
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  } catch { /* ignore */ }
  return s.slice(0, 40); // store raw as last resort
}

// ── Handler ────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse(req.headers.get('origin'));
  if (req.method !== 'POST')   return jsonErr(405, 'Method not allowed', req);

  // ── Auth: shared secret ──────────────────────────────────────────────────────
  const IMPORT_SECRET = Deno.env.get('SHORTCUT_IMPORT_SECRET');
  if (!IMPORT_SECRET) return jsonErr(500, 'Import secret not configured', req);

  const incoming = req.headers.get('x-import-secret');
  if (!incoming || incoming !== IMPORT_SECRET) {
    return jsonErr(401, 'Invalid import secret', req);
  }

  // ── Parse body ───────────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonErr(400, 'Invalid JSON body', req);
  }

  const sourceListingId = safeStr(body.source_listing_id);
  if (!sourceListingId) {
    return jsonErr(400, 'source_listing_id is required', req);
  }

  let source: string;
  try {
    source = normalizeSource(body.source);
  } catch (err) {
    return jsonErr(400, err instanceof Error ? err.message : 'Unsupported source', req);
  }

  // ── Duplicate check ──────────────────────────────────────────────────────────
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const adminClient  = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: existing } = await adminClient
    .schema('pipeline')
    .from('pipeline_properties')
    .select('id, title')
    .eq('source_listing_id', sourceListingId)
    .eq('source', source)
    .maybeSingle();

  if (existing) {
    return jsonOk({
      ok: false, duplicate: true,
      id: existing.id, title: existing.title,
      message: 'Already in pipeline',
    }, req);
  }

  // ── Normalize incoming values ────────────────────────────────────────────────
  const propType     = normalizePropType(body.property_type);
  const availDate    = normalizeDate(body.available_date);

  // location_context: merge walk/transit/bike scores sent by script with any
  // additional context passed explicitly. Script sends them pre-formatted.
  const locationCtx  = safeStr(body.location_context);

  const now = new Date().toISOString();

  const title = safeStr(body.title) ??
    ((body.bedrooms ? `${body.bedrooms}BR ` : '') +
     (propType ?? 'Rental') +
     (body.city ? ` in ${body.city}` : ''));

  const originalData = JSON.stringify({
    zpid:        sourceListingId,
    detailUrl:   body.source_url,
    homeType:    propType,
    _source:     source,
    _import:     body._import ?? 'browser-extension-v2',
    _imported_at: now,
  });

  // ── Build full record ────────────────────────────────────────────────────────
  const record: Record<string, unknown> = {
    // Identity
    id:                   genId(),
    source,
    source_url:           safeStr(body.source_url),
    source_listing_id:    sourceListingId,
    status:               'scraped',

    // Address
    title,
    address:              safeStr(body.address),
    unit_number:          null,
    city:                 safeStr(body.city),
    state:                safeStr(body.state),
    zip:                  safeStr(body.zip),
    county:               safeStr(body.county),
    neighborhood:         safeStr(body.neighborhood),
    lat:                  safeFloat(body.lat),
    lng:                  safeFloat(body.lng),
    location_context:     locationCtx,

    // Property details
    property_type:        propType,
    bedrooms:             safeInt(body.bedrooms),
    bathrooms:            safeInt(body.bathrooms),
    half_bathrooms:       safeInt(body.half_bathrooms),
    total_bathrooms:      safeFloat(body.bathrooms),
    square_footage:       safeInt(body.square_footage),
    lot_size_sqft:        safeInt(body.lot_size_sqft),
    year_built:           safeInt(body.year_built),
    floors:               safeInt(body.floors),
    garage_spaces:        safeInt(body.garage_spaces),
    total_units:          safeInt(body.total_units),
    has_basement:         body.has_basement === true || body.has_basement === 'true',
    has_central_air:      body.has_central_air === true || body.has_central_air === 'true',
    virtual_tour_url:     safeStr(body.virtual_tour_url),

    // Financials — all fee fields now captured
    monthly_rent:         safeInt(body.monthly_rent),
    security_deposit:     safeInt(body.security_deposit),
    last_months_rent:     safeInt(body.last_months_rent),
    application_fee:      safeInt(body.application_fee),
    pet_deposit:          safeInt(body.pet_deposit),
    admin_fee:            safeInt(body.admin_fee),
    move_in_special:      safeStr(body.move_in_special),
    parking_fee:          safeInt(body.parking_fee),
    hoa_fee:              safeInt(body.hoa_fee),
    tax_value:            null,

    // Listing details
    description:          safeStr(body.description),
    showing_instructions: null,
    available_date:       availDate,
    minimum_lease_months: safeInt(body.minimum_lease_months),
    lease_terms:          '[]',

    // Pets & policies
    pets_allowed:         safeBool(body.pets_allowed),
    pet_types_allowed:    safeStr(body.pet_types_allowed) ?? '[]',
    pet_weight_limit:     null,
    pet_details:          safeStr(body.pet_details),
    smoking_allowed:      safeBool(body.smoking_allowed),

    // Amenities & features
    parking:              safeStr(body.parking),
    amenities:            safeStr(body.amenities) ?? '[]',
    appliances:           safeStr(body.appliances) ?? '[]',
    utilities_included:   safeStr(body.utilities_included) ?? '[]',
    flooring:             safeStr(body.flooring) ?? '[]',
    heating_type:         safeStr(body.heating_type),
    cooling_type:         safeStr(body.cooling_type),
    laundry_type:         safeStr(body.laundry_type),

    // Photos
    original_image_urls:  safeStr(body.original_image_urls) ?? '[]',
    local_image_paths:    '[]',

    // Agent / broker
    agent_name:           safeStr(body.agent_name),
    broker_name:          safeStr(body.broker_name),
    agent_image_url:      null,
    poster_landlord_id:   null,

    // Pipeline metadata
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

  // Count photos for the success response
  let photoCount = 0;
  try {
    const urls = JSON.parse((record.original_image_urls as string) || '[]');
    photoCount = Array.isArray(urls) ? urls.length : 0;
  } catch { /* ignore */ }

  return jsonOk({
    ok:     true,
    id:     record.id,
    title:  String(title),
    score:  record.data_quality_score,
    photos: photoCount,
    city:   safeStr(body.city),
    rent:   safeInt(body.monthly_rent),
  }, req);
});
