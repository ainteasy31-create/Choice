// ============================================================
// Choice Properties — ImageKit Watermark Edge Function
// Supabase → Functions → imagekit-watermark
//
// Required secrets in Supabase Dashboard → Edge Functions → Secrets:
//   IMAGEKIT_PRIVATE_KEY  →  ImageKit private key
//   IMAGEKIT_URL_ENDPOINT →  e.g. https://ik.imagekit.io/yourID
//
// This function (admin-only):
//   1. Accepts { url, file_id, property_id } — at least url required
//   2. Builds a new ImageKit URL with a "Choice Properties" text overlay
//   3. Updates property_photos: new watermarked URL + watermark_status='applied'
//   4. Returns { success: true, url: watermarkedUrl }
//
// ImageKit URL transformation used:
//   ot-Choice%20Properties,otf-roboto,ots-40,otc-FFFFFF,
//   ota-bottom_right,otp-20,otbg-000000_50
// ============================================================

import { corsResponse } from '../_shared/cors.ts';
import { requireAdmin }  from '../_shared/auth.ts';
import { jsonResponse }  from '../_shared/utils.ts';

// Build a watermarked ImageKit URL from any existing ImageKit URL.
// Inserts the transformation string before the image path segment.
function buildWatermarkedUrl(originalUrl: string, endpoint: string): string {
  // FIX: spaces in ImageKit URL path segments must be percent-encoded.
  // "Choice Properties" → "Choice%20Properties" to produce a valid URL.
  const tr = 'ot-Choice%20Properties,otf-roboto,ots-40,otc-FFFFFF,ota-bottom_right,otp-20,otbg-000000_50';

  // If URL already contains our transformation, return as-is.
  if (originalUrl.includes('ot-Choice')) return originalUrl;

  // Strategy 1: URL starts with our endpoint — insert /tr:... after the base.
  const base = endpoint.replace(/\/$/, '');
  if (originalUrl.startsWith(base + '/')) {
    const pathPart = originalUrl.slice(base.length + 1);
    // Avoid double-inserting if there's already a tr: segment.
    if (!pathPart.startsWith('tr:')) {
      return `${base}/tr:${tr}/${pathPart}`;
    }
    return originalUrl;
  }

  // Strategy 2: Generic ImageKit URL — append as query param (safe fallback).
  const sep = originalUrl.includes('?') ? '&' : '?';
  return `${originalUrl}${sep}tr=${encodeURIComponent(tr)}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse(req.headers.get('origin'));

  // Admin-only: only users in admin_roles can apply watermarks.
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { supabase } = auth;

  try {
    const IMAGEKIT_PRIVATE_KEY  = Deno.env.get('IMAGEKIT_PRIVATE_KEY');
    const IMAGEKIT_URL_ENDPOINT = Deno.env.get('IMAGEKIT_URL_ENDPOINT');

    if (!IMAGEKIT_PRIVATE_KEY || !IMAGEKIT_URL_ENDPOINT) {
      return jsonResponse({ success: false, error: 'ImageKit not configured' }, 500, {}, req);
    }

    const body = await req.json() as {
      url?:         string;
      file_id?:     string | null;
      property_id?: string;
    };

    const { url, file_id, property_id } = body;

    if (!url) {
      return jsonResponse({ success: false, error: 'url is required' }, 400, {}, req);
    }

    // Build watermarked URL via ImageKit URL transformation.
    const endpoint = IMAGEKIT_URL_ENDPOINT.replace(/\/$/, '');
    const watermarkedUrl = buildWatermarkedUrl(url, endpoint);

    // Update the property_photos row:
    //   - Replace the stored URL with the watermarked version
    //   - Mark watermark_status = 'applied'
    // Match by file_id (preferred) or original URL.
    let updateQuery = supabase
      .from('property_photos')
      .update({ url: watermarkedUrl, watermark_status: 'applied' });

    if (file_id) {
      updateQuery = updateQuery.eq('file_id', file_id);
    } else if (property_id) {
      updateQuery = updateQuery.eq('property_id', property_id).eq('url', url);
    } else {
      updateQuery = updateQuery.eq('url', url);
    }

    const { error: dbErr } = await updateQuery;
    if (dbErr) {
      console.error('[imagekit-watermark] DB update failed:', dbErr);
      return jsonResponse({ success: false, error: 'Failed to save watermark status' }, 500, {}, req);
    }

    return jsonResponse({ success: true, url: watermarkedUrl }, 200, {}, req);

  } catch (err: any) {
    console.error('[imagekit-watermark] Exception:', { message: err.message, stack: err.stack });
    return jsonResponse({ success: false, error: 'Watermark failed' }, 500, {}, req);
  }
});
