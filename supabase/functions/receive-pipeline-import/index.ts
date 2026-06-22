// ============================================================
// Choice Properties — receive-pipeline-import Edge Function
//
// Accepts a parsed Zillow listing payload from the iOS Scriptable
// "Import to Choice" script. Authenticates via a shared secret
// (x-import-secret header) so no user login is required on the phone.
//
// POST body: listing fields (see field list below)
// Returns:   { ok: true, id, title }  |  { ok: false, error }
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsResponse, jsonOk, jsonErr } from '../_shared/cors.ts';

// ── Quality-score weights (mirrors scraper/zillow_scraper.py) ────────────────
const CORE_FIELDS = [
  'address', 'city', 'state', 'zip', 'lat', 'lng',
  'bedrooms', 'bathrooms', 'property_type', 'description',
  'available_date', 'monthly_rent',
];
const BONUS_FIELDS = [
  'county', 'neighborhood', 'year_built', 'parking',
  'pets_allowed', 'security_deposit', 'amenities', 'appliances',
  'heating_type', 'cooling_type', 'laundry_type',
];
const TRACKABLE_MISSING = [
  'address', 'city', 'state', 'zip', 'lat', 'lng',
  'monthly_rent', 'bedrooms', 'bathrooms', 'description',
  'property_type', 'available_date', 'security_deposit',
  'heating_type', 'cooling_type', 'laundry_type', 'parking',
];

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || v === '[]';
}

function qualityScore(r: Record<string, unknown>): number {
  let sc = 0;
  for (const f of CORE_FIELDS) if (!isEmpty(r[f])) sc += 6;
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
  return String(v).trim() || null;
}

function safeBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
}

// ── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse(req.headers.get('origin'));

  if (req.method !== 'POST') return jsonErr(405, 'Method not allowed', req);

  // ── Auth: shared secret ────────────────────────────────────────────────────
  const IMPORT_SECRET = Deno.env.get('SHORTCUT_IMPORT_SECRET');
  if (!IMPORT_SECRET) return jsonErr(500, 'Import secret not configured', req);

  const incoming = req.headers.get('x-import-secret');
  if (!incoming || incoming !== IMPORT_SECRET) {
    return jsonErr(401, 'Invalid import secret', req);
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
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

  // ── Duplicate check ────────────────────────────────────────────────────────
  const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: existing } = await adminClient
    .schema('pipeline')
    .from('pipeline_properties')
    .select('id, title')
    .eq('source_listing_id', sourceListingId)
    .eq('source', 'zillow')
    .maybeSingle();

  if (existing) {
    return jsonOk({ ok: false, duplicate: true, id: existing.id, title: existing.title,
      message: 'Already in pipeline' }, req);
  }

  // ── Build record ───────────────────────────────────────────────────────────
  const now = new Date().toISOString();

  const title = safeStr(body.title) ??
    ((body.bedrooms ? `${body.bedrooms}BR ` : '') +
     (body.property_type ?? 'Rental') +
     (body.city ? ` in ${body.city}` : ''));

  const originalData = JSON.stringify({
    zpid: sourceListingId,
    detailUrl: body.source_url,
    homeType: body.property_type,
    _source: 'zillow',
    _import: 'ios-scriptable',
    _imported_at: now,
  });

  const record: Record<string, unknown> = {
    id:                   genId(),
    source:               'zillow',
    source_url:           safeStr(body.source_url),
    source_listing_id:    sourceListingId,
    status:               'scraped',

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
    location_context:     null,

    property_type:        safeStr(body.property_type),
    bedrooms:             safeInt(body.bedrooms),
    bathrooms:            safeInt(body.bathrooms),
    half_bathrooms:       safeInt(body.half_bathrooms),
    total_bathrooms:      safeFloat(body.bathrooms),
    square_footage:       safeInt(body.square_footage),
    lot_size_sqft:        null,
    year_built:           safeInt(body.year_built),
    floors:               null,
    garage_spaces:        null,
    total_units:          null,
    has_basement:         body.has_basement === true || body.has_basement === 'true',
    has_central_air:      body.has_central_air === true || body.has_central_air === 'true',
    virtual_tour_url:     safeStr(body.virtual_tour_url),

    monthly_rent:         safeInt(body.monthly_rent),
    security_deposit:     safeInt(body.security_deposit),
    last_months_rent:     null,
    application_fee:      null,
    pet_deposit:          null,
    admin_fee:            null,
    move_in_special:      null,
    parking_fee:          null,
    hoa_fee:              null,
    tax_value:            null,

    description:          safeStr(body.description),
    showing_instructions: null,
    available_date:       safeStr(body.available_date),
    minimum_lease_months: null,
    lease_terms:          '[]',

    pets_allowed:         safeBool(body.pets_allowed),
    pet_types_allowed:    safeStr(body.pet_types_allowed) ?? '[]',
    pet_weight_limit:     null,
    pet_details:          null,
    smoking_allowed:      null,

    parking:              safeStr(body.parking),
    amenities:            safeStr(body.amenities) ?? '[]',
    appliances:           safeStr(body.appliances) ?? '[]',
    utilities_included:   safeStr(body.utilities_included) ?? '[]',
    flooring:             '[]',
    heating_type:         safeStr(body.heating_type),
    cooling_type:         safeStr(body.cooling_type),
    laundry_type:         safeStr(body.laundry_type),

    original_image_urls:  safeStr(body.original_image_urls) ?? '[]',
    local_image_paths:    '[]',

    agent_name:           safeStr(body.agent_name),
    broker_name:          safeStr(body.broker_name),
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

  // ── Insert ─────────────────────────────────────────────────────────────────
  const { error: insertErr } = await adminClient
    .schema('pipeline')
    .from('pipeline_properties')
    .insert(record);

  if (insertErr) {
    console.error('Insert error:', insertErr);
    return jsonErr(500, 'Database insert failed: ' + insertErr.message, req);
  }

  return jsonOk({
    ok:    true,
    id:    record.id,
    title: String(title),
    score: record.data_quality_score,
    city:  safeStr(body.city),
    rent:  safeInt(body.monthly_rent),
  }, req);
});
