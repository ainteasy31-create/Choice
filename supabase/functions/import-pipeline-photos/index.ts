// ============================================================
// Choice Properties — import-pipeline-photos Edge Function
//
// Called after publishing a pipeline listing to automatically
// transfer source photos (Zillow/Realtor CDN) into ImageKit
// and persist them in property_photos via add_property_photo RPC.
//
// POST body: { property_id: string, pipeline_id?: string }
// Returns:   { success: true, transferred: number, skipped: number }
//
// FIX: Photos are now processed in parallel batches of 5 (was serial)
// to avoid hitting the 150s Supabase Edge Function timeout when
// importing 10–20 photos from slow CDN sources.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsResponse } from '../_shared/cors.ts';
import { requireAuth } from '../_shared/auth.ts';
import { jsonResponse } from '../_shared/utils.ts';

const MAX_PHOTOS     = 20;
const BATCH_SIZE     = 5;   // process this many photos concurrently
const FETCH_TIMEOUT  = 12_000; // ms per image fetch

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse(req.headers.get('origin'));

  const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const IMPORT_SECRET = Deno.env.get('SHORTCUT_IMPORT_SECRET') ?? '';

  // Server-side bypass: service role key OR shared import secret skips user auth.
  const authHeader    = req.headers.get('authorization') ?? '';
  const callerToken   = authHeader.replace(/^Bearer\s+/i, '').trim();
  const importSecret  = req.headers.get('x-import-secret') ?? '';
  const isServiceRole = callerToken === SERVICE_KEY;
  const isImportSecret = IMPORT_SECRET.length > 0 && importSecret === IMPORT_SECRET;

  if (!isServiceRole && !isImportSecret) {
    const auth = await requireAuth(req);
    if (!auth.ok) return auth.response;

    const { supabase: authClient, user } = auth;
    const { data: role } = await authClient
      .from('admin_roles').select('id').eq('user_id', user.id).maybeSingle();
    if (!role) {
      return jsonResponse({ success: false, error: 'Admin access required' }, 403, {}, req);
    }
  }

  let pipeline_id: string | null, property_id: string;
  try {
    const body = await req.json();
    pipeline_id = body.pipeline_id ?? null;
    property_id = body.property_id;
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400, {}, req);
  }

  if (!property_id) {
    return jsonResponse({ success: false, error: 'property_id is required' }, 400, {}, req);
  }

  const IMAGEKIT_PRIVATE_KEY = Deno.env.get('IMAGEKIT_PRIVATE_KEY');
  if (!IMAGEKIT_PRIVATE_KEY) {
    return jsonResponse({ success: false, error: 'ImageKit not configured' }, 500, {}, req);
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

  // Fetch pipeline record
  const query = adminClient
    .schema('pipeline')
    .from('pipeline_properties')
    .select('id, original_image_urls');

  const { data: pipeline, error: pErr } = pipeline_id
    ? await query.eq('id', pipeline_id).single()
    : await query.eq('choice_property_id', property_id).maybeSingle();

  // Resolve the pipeline row id regardless of which lookup path matched, so
  // photo_import_status can be recorded even when called with only property_id
  // (e.g. the admin "Import source photos" retry button).
  const resolvedPipelineId: string | null = pipeline?.id ?? pipeline_id ?? null;

  if (pErr) {
    return jsonResponse({ success: false, error: 'Pipeline lookup failed: ' + pErr.message }, 500, {}, req);
  }
  if (!pipeline) {
    return jsonResponse({ success: true, transferred: 0, skipped: 0, no_source: true }, 200, {}, req);
  }

  const urls: string[] = (() => {
    try {
      const raw = pipeline.original_image_urls;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  })();

  if (!urls.length) {
    return jsonResponse({ success: true, transferred: 0, skipped: 0 }, 200, {}, req);
  }

  // Dedup guard: refuse to re-import if photos already exist.
  const { count: existingCount } = await adminClient
    .from('property_photos')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', property_id);

  if (existingCount && existingCount > 0) {
    return jsonResponse({
      success: false,
      already_imported: true,
      existing: existingCount,
      error: `Property already has ${existingCount} photo(s). Delete them first to re-import.`,
    }, 409, {}, req);
  }

  const toProcess = urls.slice(0, MAX_PHOTOS);
  const credentials = btoa(`${IMAGEKIT_PRIVATE_KEY}:`);

  // Per-photo transfer: fetch from CDN → upload to ImageKit → save to DB.
  // Returns true on success, false on any failure.
  async function transferPhoto(url: string, index: number): Promise<boolean> {
    try {
      // Orion/Chrome can upload source photos to ImageKit before the listing
      // reaches the pipeline. Those URLs are already durable and must not be
      // fetched again from the browser/CDN path (which is commonly blocked by
      // WebKit and would leave the published property with zero photo rows).
      if (url.includes('ik.imagekit.io')) {
        const { error: rpcErr } = await adminClient.rpc('add_property_photo', {
          p_property_id:   property_id,
          p_url:           url,
          p_file_id:       null,
          p_alt_text:      null,
          p_caption:       null,
          p_width:         null,
          p_height:        null,
          p_display_order: index,
          p_is_hero:       index === 0,
        });
        if (rpcErr) {
          console.error(`[import-pipeline-photos] add_property_photo failed for existing ImageKit URL (photo ${index + 1}):`, rpcErr);
          return false;
        }
        return true;
      }

      // Use browser-like headers to bypass CDN blocks
      const fetchHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      };
      // Add Referer based on URL host
      try {
        const u = new URL(url);
        if (u.hostname.includes('zillow')) fetchHeaders['Referer'] = 'https://www.zillow.com/';
        else if (u.hostname.includes('realtor')) fetchHeaders['Referer'] = 'https://www.realtor.com/';
        else if (u.hostname.includes('apartments')) fetchHeaders['Referer'] = 'https://www.apartments.com/';
        else if (u.hostname.includes('redfin')) fetchHeaders['Referer'] = 'https://www.redfin.com/';
      } catch (_) {}

      const imgRes = await fetch(url, {
        headers: fetchHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!imgRes.ok) return false;

      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      const buffer = await imgRes.arrayBuffer();

      const extMap: Record<string, string> = {
        'image/jpeg': 'jpg', 'image/jpg': 'jpg',
        'image/png': 'png', 'image/webp': 'webp',
      };
      const mimeBase = contentType.split(';')[0].trim().toLowerCase();
      const ext = extMap[mimeBase] || 'jpg';
      const fileName = `photo_${index + 1}.${ext}`;

      const formData = new FormData();
      formData.append('file', new Blob([buffer], { type: mimeBase }), fileName);
      formData.append('fileName', fileName);
      formData.append('folder', `/properties/${property_id}`);

      const ikRes = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}` },
        body: formData,
      });

      if (!ikRes.ok) {
        const errText = await ikRes.text().catch(() => `HTTP ${ikRes.status}`);
        console.error(`[import-pipeline-photos] ImageKit upload error (photo ${index + 1}):`, errText);
        return false;
      }

      const ikData = await ikRes.json();
      const ikUrl   = ikData.url as string;
      const fileId  = (ikData.fileId ?? '') as string;

      // Reject thumbnail-sized images (< 300px in either dimension).
      // Realtor.com mixes full-size and 120×80 thumbnails in the same URL list.
      const imgW = (ikData.width  as number | null) ?? null;
      const imgH = (ikData.height as number | null) ?? null;
      if ((imgW !== null && imgW < 300) || (imgH !== null && imgH < 300)) {
        console.log(`[import-pipeline-photos] Skipping thumbnail ${imgW}×${imgH} at photo ${index + 1}`);
        // Clean up the tiny file from ImageKit immediately
        await fetch(`https://api.imagekit.io/v1/files/${fileId}`, {
          method: 'DELETE',
          headers: { Authorization: `Basic ${credentials}` },
        }).catch(() => {});
        return false;
      }

      const { error: rpcErr } = await adminClient.rpc('add_property_photo', {
        p_property_id:   property_id,
        p_url:           ikUrl,
        p_file_id:       fileId,
        p_alt_text:      null,
        p_caption:       null,
        p_width:         ikData.width  ?? null,
        p_height:        ikData.height ?? null,
        p_display_order: index,
        p_is_hero:       index === 0,
      });

      if (rpcErr) {
        console.error(`[import-pipeline-photos] add_property_photo failed (photo ${index + 1}):`, rpcErr);
        return false;
      }

      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[import-pipeline-photos] Error processing photo ${index + 1}:`, msg);
      return false;
    }
  }

  // Process in parallel batches of BATCH_SIZE to avoid timeout.
  let transferred = 0;
  let skipped = 0;

  for (let batchStart = 0; batchStart < toProcess.length; batchStart += BATCH_SIZE) {
    const batch = toProcess.slice(batchStart, batchStart + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((url, i) => transferPhoto(url, batchStart + i))
    );
    for (const ok of results) {
      if (ok) transferred++; else skipped++;
    }
  }

  // ── Publish gate: auto-activate on success, log + stay hidden on failure ──
  // properties.status starts as 'draft' (hidden from the public site, which
  // only lists status='active'). Never flip status on a partial/total failure
  // — the listing must stay invisible until at least one photo is confirmed
  // on ImageKit, per the platform's "never publish without ImageKit images" rule.
  if (transferred > 0) {
    await adminClient
      .from('properties')
      .update({ status: 'active' })
      .eq('id', property_id)
      .eq('status', 'draft'); // don't clobber a status an admin already changed

    if (resolvedPipelineId) {
      await adminClient
        .schema('pipeline')
        .from('pipeline_properties')
        .update({
          photo_import_status: 'ok',
          last_photo_import_error: null,
          last_photo_import_at: new Date().toISOString(),
        })
        .eq('id', resolvedPipelineId);
    }
  } else if (resolvedPipelineId) {
    const reason = toProcess.length
      ? `All ${toProcess.length} source photo(s) failed to transfer (fetch/upload/thumbnail-reject errors — see function logs).`
      : 'No source photos available to transfer.';
    await adminClient
      .schema('pipeline')
      .from('pipeline_properties')
      .update({
        photo_import_status: 'failed',
        last_photo_import_error: reason,
        last_photo_import_at: new Date().toISOString(),
      })
      .eq('id', resolvedPipelineId);
  }

  return jsonResponse({ success: true, transferred, skipped }, 200, {}, req);
});
