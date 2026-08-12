// ============================================================
// Choice Properties — receive-pipeline-import Edge Function
// v4.0 — August 2026
//
// v4.0: SAVE-FIRST ARCHITECTURE
//   The property record is saved to the database IMMEDIATELY and
//   the response is returned to the client within ~1 second.
//   Photo downloads/upload happen ASYNCHRONOUSLY in the background
//   after the response is sent.
//
//   This means the user sees "Saved!" in under 2 seconds and can
//   move on to the next property. Photos continue uploading in the
//   background and the pipeline record is updated when they complete.
//
//   FALLBACK: If the client already uploaded photos to ImageKit
//   (browser-side upload path), those URLs are preserved and the
//   server skips the async photo job entirely.
//
//   RETRY: The import-pipeline-photos edge function handles retries
//   for any photos that fail to upload client-side.
//
// POST body: full listing fields from extension
// Returns:   { ok: true, id, title, score, photos, imagekit_photos }
//          | { ok: false, duplicate: true, id, title }
//          | { error: string }
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { permissiveCorsResponse, permissiveJsonOk, permissiveJsonErr } from '../_shared/cors.ts';
import {
  buildPipelineRecord,
  safeStr,
  safeInt,
  normalizeSource,
  qualityScore,
  missingFields,
} from '../_shared/pipeline-record.ts';

type ImageEntry = string | {
  url: string;
  fileId?: string | null;
  width?: number | null;
  height?: number | null;
};

function parseImageEntries(raw: unknown): ImageEntry[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && typeof (entry as any).url === 'string') {
        return {
          url: (entry as any).url,
          fileId: (entry as any).fileId ?? null,
          width: typeof (entry as any).width === 'number' ? (entry as any).width : null,
          height: typeof (entry as any).height === 'number' ? (entry as any).height : null,
        };
      }
      return null;
    }).filter((entry: ImageEntry | null): entry is ImageEntry => entry !== null);
  } catch {
    return [];
  }
}

function imageEntryUrl(entry: ImageEntry): string {
  return typeof entry === 'string' ? entry : entry.url;
}

// ── Async photo uploader (runs after response is sent) ──────────
// This function is fire-and-forget. It runs in the background after
// the HTTP response has been sent to the client.
async function uploadPhotosAsync(
  record: Record<string, unknown>,
  sourceImageEntries: ImageEntry[],
  sourceImageUrls: string[],
  adminClient: ReturnType<typeof createClient>,
  IMAGEKIT_PRIVATE_KEY: string,
): Promise<void> {
  const MAX_PHOTOS_TO_UPLOAD = 40;
  const BATCH_SIZE = 12; // increased from 3 for faster parallel uploads
  const FETCH_TIMEOUT = 15_000;
  const IMAGEKIT_UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';

  let imagekitUploaded = 0;
  let imagekitFailed = 0;
  const imagekitUrls: ImageEntry[] = [];

  // Check if URLs are already ImageKit URLs (browser-side upload path)
  const alreadyImageKit = sourceImageUrls.length > 0 && sourceImageUrls.every((u) => u.includes('ik.imagekit.io'));

  if (alreadyImageKit) {
    // Browser already uploaded — preserve the original entries and metadata.
    imagekitUrls.push(...sourceImageEntries);
    imagekitUploaded = sourceImageEntries.length;
  } else if (IMAGEKIT_PRIVATE_KEY && sourceImageUrls.length > 0) {
    const alreadyIkEntries = sourceImageEntries.filter((entry) => imageEntryUrl(entry).includes('ik.imagekit.io'));
    imagekitUrls.push(...alreadyIkEntries);
    imagekitUploaded = alreadyIkEntries.length;

    const toUpload = sourceImageEntries
      .filter((entry) => !imageEntryUrl(entry).includes('ik.imagekit.io'))
      .slice(0, MAX_PHOTOS_TO_UPLOAD);
    const credentials = btoa(`${IMAGEKIT_PRIVATE_KEY}:`);
    const folderPath = `/pipeline/${record.id}`;

    async function uploadOne(sourceEntry: ImageEntry, index: number): Promise<ImageEntry | null> {
      try {
        const sourceUrl = imageEntryUrl(sourceEntry);
        const fetchHeaders: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        };
        // Add Referer based on source site
        const source = safeStr(record.source);
        if (source === 'zillow') fetchHeaders['Referer'] = 'https://www.zillow.com/';
        else if (source === 'realtor') fetchHeaders['Referer'] = 'https://www.realtor.com/';
        else if (source === 'apartments') fetchHeaders['Referer'] = 'https://www.apartments.com/';
        else if (source === 'redfin') fetchHeaders['Referer'] = 'https://www.redfin.com/';

        const imgRes = await fetch(sourceUrl, {
          headers: fetchHeaders,
          redirect: 'follow',
          signal: AbortSignal.timeout(FETCH_TIMEOUT),
        });
        if (!imgRes.ok) {
          console.warn(`[receive-pipeline-import] Fetch failed (${imgRes.status}) for photo ${index + 1}: ${sourceUrl.slice(0, 80)}`);
          return null;
        }

        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        const buffer = await imgRes.arrayBuffer();

        const extMap: Record<string, string> = {
          'image/jpeg': 'jpg', 'image/jpg': 'jpg',
          'image/png': 'png', 'image/webp': 'webp',
        };
        const mimeBase = contentType.split(';')[0].trim().toLowerCase();
        const ext = extMap[mimeBase] || 'jpg';
        const fileName = `photo_${index + 1}.${ext}`;

        // Upload to ImageKit
        const formData = new FormData();
        formData.append('file', new Blob([buffer], { type: mimeBase }), fileName);
        formData.append('fileName', fileName);
        formData.append('folder', folderPath);

        const ikRes = await fetch(IMAGEKIT_UPLOAD_URL, {
          method: 'POST',
          headers: { Authorization: `Basic ${credentials}` },
          body: formData,
        });

        if (!ikRes.ok) {
          const errText = await ikRes.text().catch(() => `HTTP ${ikRes.status}`);
          console.warn(`[receive-pipeline-import] ImageKit upload failed (photo ${index + 1}): ${errText.slice(0, 200)}`);
          return null;
        }

        const ikData = await ikRes.json();
        return {
          url: ikData.url as string,
          fileId: (ikData.fileId ?? null) as string | null,
          width: typeof ikData.width === 'number' ? ikData.width : null,
          height: typeof ikData.height === 'number' ? ikData.height : null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[receive-pipeline-import] Error uploading photo ${index + 1}: ${msg}`);
        return null;
      }
    }

    // Process in parallel batches
    for (let batchStart = 0; batchStart < toUpload.length; batchStart += BATCH_SIZE) {
      const batch = toUpload.slice(batchStart, batchStart + BATCH_SIZE);
      const results = await Promise.all(
        batch.map((entry, i) => uploadOne(entry, batchStart + i))
      );
      for (const r of results) {
        if (r) { imagekitUploaded++; imagekitUrls.push(r); }
        else imagekitFailed++;
      }
    }

    // Update the pipeline record with ImageKit URLs
    if (imagekitUrls.length > 0) {
      const { error: updateErr } = await adminClient
        .schema('pipeline')
        .from('pipeline_properties')
        .update({
          original_image_urls: JSON.stringify(imagekitUrls),
          photo_import_status: 'ok',
          last_photo_import_at: new Date().toISOString(),
          last_photo_import_error: null,
        })
        .eq('id', record.id);

      if (updateErr) {
        console.warn('[receive-pipeline-import] Failed to update record with ImageKit URLs:', updateErr);
      }

      // Recalculate quality score with ImageKit URLs
      const updatedRecord = { ...record, original_image_urls: JSON.stringify(imagekitUrls) };
      const score = qualityScore(updatedRecord);
      const missing = missingFields(updatedRecord);

      await adminClient
        .schema('pipeline')
        .from('pipeline_properties')
        .update({
          data_quality_score: score,
          missing_fields: missing,
        })
        .eq('id', record.id);
    } else if (imagekitFailed > 0) {
      // All uploads failed — mark for retry
      await adminClient
        .schema('pipeline')
        .from('pipeline_properties')
        .update({
          photo_import_status: 'failed',
          last_photo_import_error: `All ${imagekitFailed} source photo(s) failed to upload to ImageKit`,
          last_photo_import_at: new Date().toISOString(),
        })
        .eq('id', record.id);
    }
  }
}

// ── Handler ────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return permissiveCorsResponse(req);
  if (req.method !== 'POST')   return permissiveJsonErr(405, 'Method not allowed', req);

  // ── Auth: shared secret ──────────────────────────────────────
  const IMPORT_SECRET = Deno.env.get('SHORTCUT_IMPORT_SECRET');
  if (!IMPORT_SECRET) return permissiveJsonErr(500, 'Import secret not configured', req);

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

  // ── v4.0: Photo-update-only mode ─────────────────────────────
  // If _update_photos_only=true, the caller is the extension after it
  // finished background photo uploads. Skip duplicate check and DB insert;
  // only update original_image_urls, photo_import_status, and quality score.
  const updatePhotosOnly = body._update_photos_only === true;

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
    .select(updatePhotosOnly ? '*' : 'id, title')
    .eq('source_listing_id', sourceListingId)
    .eq('source', source)
    .maybeSingle();

  if (existing && !updatePhotosOnly) {
    return permissiveJsonOk({
      ok: false, duplicate: true,
      id: existing.id, title: existing.title,
      message: 'Already in pipeline',
    }, req);
  }

  // ── v4.0: Photo-only update path ─────────────────────────────
  if (updatePhotosOnly) {
    if (!existing) {
      return permissiveJsonErr(404, 'Pipeline record not found for photo update', req);
    }

    const photoEntries = parseImageEntries(body.original_image_urls);
    const photoUrls = photoEntries
      .map(imageEntryUrl)
      .filter((u: string) => typeof u === 'string' && u.startsWith('http'));

    if (photoUrls.length > 0 && photoUrls.every((u: string) => u.includes('ik.imagekit.io'))) {
      // All photos are ImageKit URLs — update record with them
      const updatedRecord = { ...existing, original_image_urls: JSON.stringify(photoEntries) } as Record<string, unknown>;
      const score = qualityScore(updatedRecord);
      const missing = missingFields(updatedRecord);

      const { error: updateErr } = await adminClient
        .schema('pipeline')
        .from('pipeline_properties')
        .update({
          original_image_urls: JSON.stringify(photoEntries),
          photo_import_status: 'ok',
          last_photo_import_at: new Date().toISOString(),
          last_photo_import_error: null,
          data_quality_score: score,
          missing_fields: missing,
        })
        .eq('id', existing.id);

      if (updateErr) {
        return permissiveJsonErr(500, 'Photo update failed: ' + updateErr.message, req);
      }

      return permissiveJsonOk({
        ok: true,
        id: existing.id,
        title: existing.title,
        score,
        photos: photoUrls.length,
        imagekit_photos: photoUrls.length,
        photo_import: 'complete',
        updated: 'photos_only',
      }, req);
    }

    // No ImageKit URLs — mark as failed for retry later
    await adminClient
      .schema('pipeline')
      .from('pipeline_properties')
      .update({
        photo_import_status: 'failed',
        last_photo_import_error: 'Extension background photo uploads failed',
        last_photo_import_at: new Date().toISOString(),
      })
      .eq('id', existing.id);

    return permissiveJsonOk({
      ok: true,
      id: existing.id,
      title: existing.title,
      photos: photoUrls.length,
      imagekit_photos: 0,
      photo_import: 'failed',
    }, req);
  }

  // ── Build record using shared builder ────────────────────────
  const record = buildPipelineRecord(body as unknown as Parameters<typeof buildPipelineRecord>[0]);

  // Diagnostic telemetry: log low-quality imports for analysis
  try {
    if (typeof record.data_quality_score === 'number' && record.data_quality_score < 80) {
      console.info('[receive-pipeline-import] Low quality import:', {
        id: record.id,
        score: record.data_quality_score,
        missing: record.missing_fields,
        source_listing_id: record.source_listing_id,
        original_data_sample: record.original_data ? (String(record.original_data).slice(0, 200)) : null,
      });
    }
  } catch (_) {}

  // ── Extract source image entries and URLs ──────────────────────
  const sourceImageEntries = parseImageEntries(record.original_image_urls);
  const sourceImageUrls = sourceImageEntries
    .map(imageEntryUrl)
    .filter((u: string) => typeof u === 'string' && u.startsWith('http'));

  // ── Check if URLs are already ImageKit URLs (browser-side upload path) ──
  const alreadyImageKit = sourceImageUrls.length > 0 && sourceImageUrls.every((u: string) => u.includes('ik.imagekit.io'));

  // ── Insert ───────────────────────────────────────────────────
  const { error: insertErr } = await adminClient
    .schema('pipeline')
    .from('pipeline_properties')
    .insert(record);

  if (insertErr) {
    console.error('Insert error:', insertErr);
    return permissiveJsonErr(500, 'Database insert failed: ' + insertErr.message, req);
  }

  // ── If photos are already on ImageKit, update quality score immediately ──
  if (alreadyImageKit) {
    const updatedRecord = { ...record, original_image_urls: JSON.stringify(sourceImageEntries) };
    const score = qualityScore(updatedRecord);
    const missing = missingFields(updatedRecord);
    await adminClient
      .schema('pipeline')
      .from('pipeline_properties')
      .update({
        data_quality_score: score,
        missing_fields: missing,
        photo_import_status: 'ok',
        last_photo_import_at: new Date().toISOString(),
      })
      .eq('id', record.id);
  }

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

  // ── Return immediately (v4.0: save-first architecture) ──────
  // Fire off async photo uploads AFTER sending the response.
  // The client doesn't need to wait for photos to finish.
  const IMAGEKIT_PRIVATE_KEY = Deno.env.get('IMAGEKIT_PRIVATE_KEY') || '';

  // Use edge functions' waitUntil or just fire-and-forget
  // Since Deno.serve doesn't have waitUntil, we use a background promise
  const photoPromise = (async () => {
    try {
      await uploadPhotosAsync(
        record as unknown as Record<string, unknown>,
        sourceImageEntries,
        sourceImageUrls,
        adminClient,
        IMAGEKIT_PRIVATE_KEY,
      );
    } catch (err) {
      console.error('[receive-pipeline-import] Background photo upload failed:', err);
    }
  })();

  // Don't await photoPromise — return immediately
  // But keep a reference to prevent the function from exiting before the response
  // is sent. The photo upload continues in the background.
  const response = permissiveJsonOk({
    ok:     true,
    id:     record.id,
    title:  String(record.title),
    score:  record.data_quality_score,
    photos: sourceImageUrls.length,
    imagekit_photos: alreadyImageKit ? sourceImageUrls.length : 0,
    imagekit_failed: 0,
    photo_import: alreadyImageKit ? 'complete' : 'background',
    city:   safeStr(body.city),
    rent:   safeInt(body.monthly_rent),
    folder: folderInfo,
  }, req);

  // Fire and forget the photo upload — don't await
  photoPromise.catch((err) => {
    console.error('[receive-pipeline-import] Background photo upload error:', err);
  });

  return response;
});