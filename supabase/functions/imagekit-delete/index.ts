// ============================================================
// Choice Properties — ImageKit Delete Edge Function
// Supabase → Functions → imagekit-delete
//
// Required secrets (same as imagekit-upload):
//   IMAGEKIT_PRIVATE_KEY  →  your ImageKit private key
//
// Phase 3b update (2026-04-22):
//   • Ownership check consults the `property_photos` table
//     via the SECURITY INVOKER RPC `delete_property_photo_by_file_id`.
//   • The DB row is removed inside the RPC before the CDN call so
//     the property_photos table stays consistent even if the CDN
//     delete is retried.
//
// FIX: Removed legacy fallback that referenced the dropped
//   `photo_file_ids` array column on `properties`. That column was
//   removed when `property_photos` was introduced. The fallback
//   was causing false 403s for non-admin landlords whenever the
//   RPC returned false (photo not found vs. permission denied).
//
// Deletion remains best-effort: a CDN failure does NOT block the UI.
// ============================================================

import { corsResponse } from '../_shared/cors.ts';
import { requireAuth }  from '../_shared/auth.ts';
import { jsonResponse } from '../_shared/utils.ts';
import { isDbRateLimited } from '../_shared/rate-limit.ts';

const DELETE_MAX_PER_WINDOW = 100;
const DELETE_WINDOW_MS      = 10 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsResponse(req.headers.get('origin'));

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { user, supabase } = auth;

  if (await isDbRateLimited('user:' + user.id, 'imagekit-delete', DELETE_MAX_PER_WINDOW, DELETE_WINDOW_MS)) {
    return jsonResponse({ success: false, error: 'Too many delete requests. Please wait a few minutes and try again.' }, 429, {}, req);
  }

  try {
    const IMAGEKIT_PRIVATE_KEY = Deno.env.get('IMAGEKIT_PRIVATE_KEY');
    if (!IMAGEKIT_PRIVATE_KEY) {
      return jsonResponse({ success: false, error: 'ImageKit not configured' }, 500, {}, req);
    }

    const { fileId } = await req.json();
    if (!fileId || typeof fileId !== 'string') {
      return jsonResponse({ success: false, error: 'fileId is required' }, 400, {}, req);
    }

    // ── Ownership + DB row removal via RPC ────────────────────
    // The RPC removes the property_photos row and returns true if it
    // belonged to the calling user, false if not found, or raises if forbidden.
    const { data: rpcDeleted, error: rpcErr } = await supabase.rpc(
      'delete_property_photo_by_file_id',
      { p_file_id: fileId }
    );

    if (rpcErr) {
      // RPC raised "Forbidden" — reject.
      console.error('[imagekit-delete] RPC error:', rpcErr);
      return jsonResponse({ success: false, error: 'Forbidden' }, 403, {}, req);
    }

    // rpcDeleted === false means the row wasn't found in property_photos.
    // Admins can still proceed to clean up orphaned CDN files.
    if (rpcDeleted === false) {
      const { data: adminRow } = await supabase
        .from('admin_roles')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!adminRow) {
        // Non-admin, photo not in DB — treat as forbidden to prevent enumeration.
        return jsonResponse({ success: false, error: 'Forbidden' }, 403, {}, req);
      }
      // Admin deleting an orphaned CDN file — allow through.
    }
    // ── End ownership check ───────────────────────────────────

    const credentials = btoa(`${IMAGEKIT_PRIVATE_KEY}:`);
    const ikRes = await fetch(
      `https://api.imagekit.io/v1/files/${encodeURIComponent(fileId)}`,
      { method: 'DELETE', headers: { Authorization: `Basic ${credentials}` } }
    );

    // 204 = success, 404 = already gone — both are acceptable (idempotent).
    if (!ikRes.ok && ikRes.status !== 404) {
      const errText = await ikRes.text().catch(() => `HTTP ${ikRes.status}`);
      console.error('[imagekit-delete] ImageKit error:', errText);
      return jsonResponse({ success: false, error: 'Image delete failed. Please try again.' }, 502, {}, req);
    }

    return jsonResponse({ success: true }, 200, {}, req);
  } catch (err: any) {
    console.error('[imagekit-delete] handler error:', err);
    return jsonResponse({ success: false, error: 'Failed to delete image' }, 500, {}, req);
  }
});
