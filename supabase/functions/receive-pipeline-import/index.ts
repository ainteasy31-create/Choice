// ============================================================
// Choice Properties — receive-pipeline-import Edge Function
// v2.2 — August 2026
//
// Accepts a parsed listing payload from the Chrome/Orion extension.
// Authenticates via a shared secret (x-import-secret header or ?secret= query)
// — no user login required.
//
// Uses permissive CORS for secrets-authenticated endpoints — the secret is
// the real auth, not the Origin, so we echo back any Origin including
// 'null' (WebKit extension content scripts on Orion/iOS).
//
// POST body: full listing fields from extension
// Returns:   { ok: true, id, title, score, photos }
//          | { ok: false, duplicate: true, id, title }
//          | { error: string }
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { permissiveCorsResponse, permissiveJsonOk, permissiveJsonErr } from '../_shared/cors.ts';
import {
  buildPipelineRecord,
  safeStr,
  safeInt,
  safeFloat,
  normalizeSource,
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

// ── Handler ────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return permissiveCorsResponse(req);
  if (req.method !== 'POST')   return permissiveJsonErr(405, 'Method not allowed', req);

  // ── Auth: shared secret ──────────────────────────────────────
  const IMPORT_SECRET = Deno.env.get('SHORTCUT_IMPORT_SECRET');
  if (!IMPORT_SECRET) return permissiveJsonErr(500, 'Import secret not configured', req);

  // Read secret from query parameter (for Orion/iOS compatibility) or header
  const url = new URL(req.url);
  const incoming = url.searchParams.get('secret') || req.headers.get('x-import-secret');
  if (!incoming || incoming !== IMPORT_SECRET) {
    return permissiveJsonErr(401, 'Invalid import secret', req);
  }

  // ── Parse body ───────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return permissiveJsonErr(400, 'Invalid JSON body', req);
  }

  const sourceListingId = safeStr(body.source_listing_id);
  if (!sourceListingId) {
    return permissiveJsonErr(400, 'source_listing_id is required', req);
  }

  let source: string;
  try {
    source = normalizeSource(body.source);
  } catch (err) {
    return permissiveJsonErr(400, err instanceof Error ? err.message : 'Unsupported source', req);
  }

  // ── Duplicate check ──────────────────────────────────────────
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
    return permissiveJsonOk({
      ok: false, duplicate: true,
      id: existing.id, title: existing.title,
      message: 'Already in pipeline',
    }, req);
  }

  // ── Build record using shared builder ────────────────────────
  const record = buildPipelineRecord(body as unknown as Parameters<typeof buildPipelineRecord>[0]);

  // ── Insert ───────────────────────────────────────────────────
  const { error: insertErr } = await adminClient
    .schema('pipeline')
    .from('pipeline_properties')
    .insert(record);

  if (insertErr) {
    console.error('Insert error:', insertErr);
    return permissiveJsonErr(500, 'Database insert failed: ' + insertErr.message, req);
  }

  // Count photos for the success response
  let photoCount = 0;
  try {
    const urls = JSON.parse((record.original_image_urls as string) || '[]');
    photoCount = Array.isArray(urls) ? urls.length : 0;
  } catch { /* ignore */ }

  // ── Optional folder assignment ─────────────────────────────────
  let folderInfo: Record<string, unknown> | null = null;
  const folderName = safeStr(body.folder_name);
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
      console.warn('[receive-pipeline-import] Folder assignment failed:', e);
    }
  }

  return permissiveJsonOk({
    ok:     true,
    id:     record.id,
    title:  String(record.title),
    score:  record.data_quality_score,
    photos: photoCount,
    city:   safeStr(body.city),
    rent:   safeInt(body.monthly_rent),
    folder: folderInfo,
  }, req);
});