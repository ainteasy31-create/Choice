// ============================================================
// Choice Properties — Shared Pipeline Record Builder
// ============================================================
// Single source of truth for building pipeline_properties records.
// Used by both receive-pipeline-import and import-from-url edge functions.
// ============================================================

// ── Quality-score weights (shared across all import channels) ────────────
export const CORE_FIELDS = [
  'address', 'city', 'state', 'zip', 'lat', 'lng',
  'bedrooms', 'bathrooms', 'square_footage', 'monthly_rent',
  'property_type', 'description', 'available_date',
];

export const BONUS_FIELDS = [
  'county', 'neighborhood', 'year_built', 'parking',
  'pets_allowed', 'security_deposit', 'amenities', 'appliances',
  'heating_type', 'cooling_type', 'laundry_type',
];

export const TRACKABLE_MISSING = [
  'lat', 'lng', 'county', 'neighborhood', 'year_built', 'square_footage',
  'parking', 'pets_allowed', 'security_deposit', 'amenities', 'appliances',
  'available_date', 'heating_type', 'cooling_type', 'laundry_type',
];

export function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || v === '[]';
}

export function qualityScore(r: Record<string, unknown>): number {
  let sc = 0;
  for (const f of CORE_FIELDS)  if (!isEmpty(r[f])) sc += 6;
  for (const f of BONUS_FIELDS) if (!isEmpty(r[f])) sc += 2;
  try {
    const urls = JSON.parse((r.original_image_urls as string) || '[]');
    sc += Array.isArray(urls) && urls.length >= 5 ? 6 : urls.length >= 1 ? 3 : 0;
  } catch { /* ignore */ }
  return Math.min(sc, 100);
}

export function missingFields(r: Record<string, unknown>): string {
  return JSON.stringify(TRACKABLE_MISSING.filter(f => isEmpty(r[f])));
}

export function genId(): string {
  return 'PP-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

// ── Type coercion helpers ──────────────────────────────────────────────
export function safeInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v));
  return isNaN(n) ? null : n;
}

export function safeFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v));
  return isNaN(n) ? null : n;
}

export function safeStr(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  return s || null;
}

export function safeBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
}

// ── Normalize property_type to UPPER_UNDERSCORE ─────────────────────────
export function normalizePropType(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Already UPPER_UNDERSCORE
  if (/^[A-Z_]+$/.test(s)) return s;
  // Title-case variants from older import versions
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

export function normalizeSource(v: unknown): string {
  const source = safeStr(v)?.toLowerCase() ?? 'zillow';
  if (!['zillow', 'realtor', 'apartments', 'redfin'].includes(source)) {
    throw new Error(`Unsupported source: ${source}`);
  }
  return source;
}

// ── Normalize available_date to YYYY-MM-DD ─────────────────────────────
export function normalizeDate(v: unknown): string | null {
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

// ── Build a full pipeline_properties record from a normalized payload ───
export interface PipelineRecordInput {
  source: string;
  source_listing_id: string;
  source_url?: string | null;
  folder_name?: string | null;
  folder_id?: string | null;
  title?: string | null;
  address?: string | null;
  unit_number?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  county?: string | null;
  neighborhood?: string | null;
  lat?: number | null;
  lng?: number | null;
  location_context?: string | null;
  property_type?: string | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  half_bathrooms?: number | null;
  square_footage?: number | null;
  lot_size_sqft?: number | null;
  year_built?: number | null;
  floors?: number | null;
  garage_spaces?: number | null;
  total_units?: number | null;
  has_basement?: boolean | null;
  has_central_air?: boolean | null;
  virtual_tour_url?: string | null;
  monthly_rent?: number | null;
  security_deposit?: number | null;
  last_months_rent?: number | null;
  application_fee?: number | null;
  pet_deposit?: number | null;
  admin_fee?: number | null;
  move_in_special?: string | null;
  parking_fee?: number | null;
  hoa_fee?: number | null;
  description?: string | null;
  showing_instructions?: string | null;
  available_date?: string | null;
  minimum_lease_months?: number | null;
  lease_terms?: string | null;
  pets_allowed?: boolean | null;
  pet_types_allowed?: string | null;
  pet_weight_limit?: number | null;
  pet_details?: string | null;
  smoking_allowed?: boolean | null;
  parking?: string | null;
  amenities?: string | null;
  appliances?: string | null;
  utilities_included?: string | null;
  flooring?: string | null;
  heating_type?: string | null;
  cooling_type?: string | null;
  laundry_type?: string | null;
  original_image_urls?: string | null;
  local_image_paths?: string | null;
  agent_name?: string | null;
  broker_name?: string | null;
  agent_image_url?: string | null;
  poster_landlord_id?: string | null;
  original_data?: string | null;
  edited_fields?: string | null;
  inferred_features?: string | null;
  published_at?: string | null;
  choice_property_id?: string | null;
  scraped_at?: string | null;
  updated_at?: string | null;
  _import?: string | null;
}

export function buildPipelineRecord(body: PipelineRecordInput): Record<string, unknown> {
  const source = normalizeSource(body.source);
  const propType = normalizePropType(body.property_type);
  const availDate = normalizeDate(body.available_date);
  const now = new Date().toISOString();

  const title = safeStr(body.title) ??
    ((body.bedrooms ? `${body.bedrooms}BR ` : '') +
     (propType ?? 'Rental') +
     (body.city ? ` in ${body.city}` : ''));

  const originalData = JSON.stringify({
    zpid:        body.source_listing_id,
    detailUrl:   body.source_url,
    homeType:    propType,
    _source:     source,
    _import:     body._import ?? 'browser-extension-v2',
    _imported_at: now,
  });

  const record: Record<string, unknown> = {
    // Identity
    id:                   genId(),
    source,
    source_url:           safeStr(body.source_url),
    source_listing_id:    body.source_listing_id,
    status:               'scraped',

    // Address
    title,
    address:              safeStr(body.address),
    unit_number:          safeStr(body.unit_number),
    city:                 safeStr(body.city),
    state:                safeStr(body.state),
    zip:                  safeStr(body.zip),
    county:               safeStr(body.county),
    neighborhood:         safeStr(body.neighborhood),
    lat:                  safeFloat(body.lat),
    lng:                  safeFloat(body.lng),
    location_context:     safeStr(body.location_context),

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
    has_basement:         safeBool(body.has_basement) === true,
    has_central_air:      safeBool(body.has_central_air) === true,
    virtual_tour_url:     safeStr(body.virtual_tour_url),

    // Financials
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
    showing_instructions: safeStr(body.showing_instructions),
    available_date:       availDate,
    minimum_lease_months: safeInt(body.minimum_lease_months),
    lease_terms:          safeStr(body.lease_terms) ?? '[]',

    // Pets & policies
    pets_allowed:         safeBool(body.pets_allowed),
    pet_types_allowed:    safeStr(body.pet_types_allowed) ?? '[]',
    pet_weight_limit:     safeInt(body.pet_weight_limit),
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
    local_image_paths:    safeStr(body.local_image_paths) ?? '[]',

    // Agent / broker
    agent_name:           safeStr(body.agent_name),
    broker_name:          safeStr(body.broker_name),
    agent_image_url:      safeStr(body.agent_image_url),
    poster_landlord_id:   safeStr(body.poster_landlord_id),

    // Pipeline metadata
    original_data:        safeStr(body.original_data) ?? originalData,
    edited_fields:        safeStr(body.edited_fields) ?? '[]',
    inferred_features:    safeStr(body.inferred_features) ?? '[]',
    published_at:         safeStr(body.published_at),
    choice_property_id:   safeStr(body.choice_property_id),
    scraped_at:           safeStr(body.scraped_at) ?? now,
    updated_at:           safeStr(body.updated_at) ?? now,
  };

  record.data_quality_score = qualityScore(record);
  record.missing_fields     = missingFields(record);

  return record;
}