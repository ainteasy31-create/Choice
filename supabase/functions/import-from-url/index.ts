// ============================================================
// Choice Properties — import-from-url Edge Function
// v1.1 — August 2026
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
import { extractFromNextData } from '../_shared/zillow-extract.ts';
import {
  buildPipelineRecord,
  safeStr,
  safeInt,
  safeFloat,
  normalizePropType,
  normalizeDate,
  qualityScore,
  missingFields,
  genId,
  isEmpty,
  CORE_FIELDS,
  BONUS_FIELDS,
  TRACKABLE_MISSING,
} from '../_shared/pipeline-record.ts';

// ── Realistic browser headers to reduce Zillow bot detection ──────────────────
const BROWSER_HEADERS: Record<string, string> = {
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

// ── Handler ────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse(req.headers.get('origin'));
  if (req.method !== 'POST')   return jsonErr(405, 'Method not allowed', req);

  // ── Auth: shared import secret OR logged-in admin ────────────────────────────
  const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON_KEY      = Deno.env.get('SUPABASE_ANON_KEY')!;

  const IMPORT_SECRET = Deno.env.get('SHORTCUT_IMPORT_SECRET') || '';

  // Allow the shared import secret (header only — used by the PWA / import page)
  // OR a logged-in admin JWT (used by the admin portal's "Import URL" button).
  const incomingSecret = req.headers.get('x-import-secret') || '';
  if (incomingSecret && IMPORT_SECRET && incomingSecret === IMPORT_SECRET) {
    // Shared-secret path — no user session needed. Build an admin client directly.
    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

    // Parse body
    let body: { url?: string; dry_run?: boolean };
    try { body = await req.json(); } catch { return jsonErr(400, 'Invalid JSON body', req); }

    const rawUrl = (body.url || '').trim();
    if (!rawUrl) return jsonErr(400, 'url is required', req);
    if (!rawUrl.startsWith('http')) return jsonErr(400, 'url must be a full https:// URL', req);
    if (!rawUrl.includes('zillow.com')) return jsonErr(400, 'Only Zillow URLs are supported', req);
    const dryRun = !!body.dry_run;

    const handled = await handleImport(rawUrl, dryRun, adminClient, null, req);
    return handled;
  }

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

  return await handleImport(rawUrl, dryRun, adminClient, user?.id || null, req);
});

// ── Shared import handler ─────────────────────────────────────────────────────
async function handleImport(
  rawUrl: string,
  dryRun: boolean,
  adminClient: Awaited<ReturnType<typeof createClient>>,
  userId: string | null,
  req: Request,
): Promise<Response> {

  // ── Fetch Zillow page ────────────────────────────────────────────────────────
  let html: string;
  try {
    const res = await fetch(rawUrl, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
    });
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        return jsonOk({ ok: false, blocked: true, message: 'Zillow blocked the server-side request (status ' + res.status + '). Use the Chrome/Orion extension instead — it runs from your browser which Zillow allows.' }, req);
      }
      return jsonErr(502, 'Zillow returned HTTP ' + res.status, req);
    }
    html = await res.text();
  } catch (e) {
    return jsonErr(502, 'Failed to fetch Zillow page: ' + (e as Error).message, req);
  }

  // ── Extract listing data using shared extractor ─────────────────────────────
  const extracted = extractFromNextData(html);

  if ('_error' in extracted) {
    if ((extracted as Record<string, unknown>)._blocked) {
      return jsonOk({ ok: false, blocked: true, message: 'Zillow served a CAPTCHA or bot-check page. Use the Chrome/Orion extension instead — it runs from your browser which Zillow allows.' }, req);
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

  // ── Build record using shared builder ────────────────────────────────────────
  const now = new Date().toISOString();
  const propType = normalizePropType(extracted.property_type);

  const originalData = JSON.stringify({
    zpid:         sourceListingId,
    detailUrl:    rawUrl,
    homeType:     propType,
    _source:      'zillow',
    _import:      'admin-url-import-v1',
    _imported_at: now,
    _imported_by: userId, // null for shared-secret imports
  });

  let folderInfo: Record<string, unknown> | null = null;
  const folderName = safeStr((req.url ? new URL(req.url).searchParams.get('folder') : null));
  
  const record = buildPipelineRecord({
    source: 'zillow',
    source_listing_id: sourceListingId,
    folder_name: folderName,
    source_url: rawUrl,
    title: safeStr(extracted.title) ?? sourceListingId,
    address: safeStr(extracted.address),
    city: safeStr(extracted.city),
    state: safeStr(extracted.state),
    zip: safeStr(extracted.zip),
    county: safeStr(extracted.county),
    neighborhood: safeStr(extracted.neighborhood),
    lat: safeFloat(extracted.lat),
    lng: safeFloat(extracted.lng),
    location_context: safeStr(extracted.location_context),
    property_type: propType,
    bedrooms: safeInt(extracted.bedrooms),
    bathrooms: safeInt(extracted.bathrooms),
    half_bathrooms: safeInt(extracted.half_bathrooms),
    square_footage: safeInt(extracted.square_footage),
    lot_size_sqft: safeInt(extracted.lot_size_sqft),
    year_built: safeInt(extracted.year_built),
    floors: safeInt(extracted.floors),
    garage_spaces: safeInt(extracted.garage_spaces),
    total_units: safeInt(extracted.total_units),
    has_basement: extracted.has_basement === true,
    has_central_air: extracted.has_central_air === true,
    virtual_tour_url: safeStr(extracted.virtual_tour_url),
    monthly_rent: safeInt(extracted.monthly_rent),
    security_deposit: safeInt(extracted.security_deposit),
    last_months_rent: safeInt(extracted.last_months_rent),
    application_fee: safeInt(extracted.application_fee),
    pet_deposit: safeInt(extracted.pet_deposit),
    admin_fee: safeInt(extracted.admin_fee),
    move_in_special: safeStr(extracted.move_in_special),
    parking_fee: safeInt(extracted.parking_fee),
    hoa_fee: safeInt(extracted.hoa_fee),
    description: safeStr(extracted.description),
    available_date: safeStr(extracted.available_date),
    minimum_lease_months: safeInt(extracted.minimum_lease_months),
    pets_allowed: extracted.pets_allowed === true,
    pet_types_allowed: safeStr(extracted.pet_types_allowed) ?? '[]',
    smoking_allowed: extracted.smoking_allowed === true,
    parking: safeStr(extracted.parking),
    amenities: safeStr(extracted.amenities) ?? '[]',
    appliances: safeStr(extracted.appliances) ?? '[]',
    utilities_included: safeStr(extracted.utilities_included) ?? '[]',
    heating_type: safeStr(extracted.heating_type),
    cooling_type: safeStr(extracted.cooling_type),
    laundry_type: safeStr(extracted.laundry_type),
    original_image_urls: safeStr(extracted.original_image_urls) ?? '[]',
    agent_name: safeStr(extracted.agent_name),
    broker_name: safeStr(extracted.broker_name),
    original_data: originalData,
    _import: 'admin-url-import-v1',
  });

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
  try { const u = JSON.parse((record.original_image_urls as string) || '[]'); photoCount = Array.isArray(u) ? u.length : 0; } catch { /* ignore */ }

  // ── Optional folder assignment ─────────────────────────────────
  if (folderName) {
    try {
      const { data: folderData, error: folderErr } = await adminClient.rpc('pipeline_folder_add_property', {
        p_property_id: record.id,
        p_folder_name: folderName,
      });
      if (!folderErr && folderData?.ok) {
        folderInfo = { folder: folderName, serial: folderData.serial };
      }
    } catch (e) {
      console.warn('[import-from-url] Folder assignment failed:', e);
    }
  }

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
    folder:          folderInfo,
  }, req);
}