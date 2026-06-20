// ============================================================
// Choice Properties — import-pipeline-photos Edge Function
//
// Called after publishing a pipeline listing to automatically
// transfer source photos (Zillow/Realtor CDN) into ImageKit
// and persist them in property_photos via add_property_photo RPC.
//
// POST body: { pipeline_id: string, property_id: string }
// Returns:   { success: true, transferred: number, skipped: number }
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsResponse } from '../_shared/cors.ts';
import { requireAuth } from '../_shared/auth.ts';
import { jsonResponse } from '../_shared/utils.ts';

const MAX_PHOTOS = 20;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse(req.headers.get('origin'));

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  // Admin-only
  const { supabase: authClient, user } = auth;
  const { data: role } = await authClient
    .from('admin_roles').select('id').eq('user_id', user.id).maybeSingle();
  if (!role) {
    return jsonResponse({ success: false, error: 'Admin access required' }, 403, {}, req);
  }

  let pipeline_id: string, property_id: string;
  try {
    const body = await req.json();
    pipeline_id = body.pipeline_id;
    property_id = body.property_id;
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400, {}, req);
  }

  if (!pipeline_id || !property_id) {
    return jsonResponse({ success: false, error: 'pipeline_id and property_id required' }, 400, {}, req);
  }

  const SUPABASE_URL        = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY         = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const IMAGEKIT_PRIVATE_KEY = Deno.env.get('IMAGEKIT_PRIVATE_KEY');

  if (!IMAGEKIT_PRIVATE_KEY) {
    return jsonResponse({ success: false, error: 'ImageKit not configured' }, 500, {}, req);
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

  // Fetch pipeline record (pipeline schema is private — service role required)
  const { data: pipeline, error: pErr } = await adminClient
    .schema('pipeline')
    .from('pipeline_properties')
    .select('original_image_urls')
    .eq('id', pipeline_id)
    .single();

  if (pErr || !pipeline) {
    return jsonResponse({ success: false, error: 'Pipeline record not found' }, 404, {}, req);
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

  const toProcess = urls.slice(0, MAX_PHOTOS);
  const credentials = btoa(`${IMAGEKIT_PRIVATE_KEY}:`);
  let transferred = 0;
  let skipped = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const url = toProcess[i];
    try {
      // Fetch image server-side (no CORS restriction in Deno)
      const imgRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ChoiceProperties/1.0)',
          'Accept': 'image/*',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!imgRes.ok) { skipped++; continue; }

      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      const buffer = await imgRes.arrayBuffer();

      // Derive extension from content-type
      const extMap: Record<string, string> = {
        'image/jpeg': 'jpg', 'image/jpg': 'jpg',
        'image/png': 'png', 'image/webp': 'webp',
      };
      const mimeBase = contentType.split(';')[0].trim().toLowerCase();
      const ext = extMap[mimeBase] || 'jpg';
      const fileName = `photo_${i + 1}.${ext}`;

      // Upload to ImageKit
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
        console.error(`[import-pipeline-photos] ImageKit upload error (photo ${i+1}):`, errText);
        skipped++;
        continue;
      }

      const ikData = await ikRes.json();
      const ikUrl    = ikData.url as string;
      const fileId   = (ikData.fileId ?? '') as string;

      // Persist to property_photos via RPC
      const { error: rpcErr } = await adminClient.rpc('add_property_photo', {
        p_property_id: property_id,
        p_url:         ikUrl,
        p_file_id:     fileId,
        p_alt_text:    null,
        p_caption:     null,
        p_width:       ikData.width  ?? null,
        p_height:      ikData.height ?? null,
      });

      if (rpcErr) {
        console.error(`[import-pipeline-photos] add_property_photo failed (photo ${i+1}):`, rpcErr);
        skipped++;
        continue;
      }

      transferred++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[import-pipeline-photos] Error processing photo ${i+1}:`, msg);
      skipped++;
    }
  }

  return jsonResponse({ success: true, transferred, skipped }, 200, {}, req);
});
