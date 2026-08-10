// ============================================================
// Choice Properties — pipeline-photo-upload Edge Function
// v1.0 — August 2026
//
// Accepts a base64-encoded image from the Orion/Chrome extension
// and uploads it to ImageKit. Uses the shared import secret for
// auth (no user session needed — the extension has none).
//
// This is the browser-side photo upload path: the extension
// downloads images in the browser (where Zillow/Realtor allow
// access) and uploads them here to ImageKit.
//
// POST body: { fileData: string (base64), fileName: string, folder?: string }
// Returns:   { url: string, fileId: string }
// ============================================================

import {
  permissiveCorsResponse,
  permissiveJsonOk,
  permissiveJsonErr,
} from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return permissiveCorsResponse(req);

  // ── Auth: shared import secret ──────────────────────────────
  const IMPORT_SECRET = Deno.env.get('SHORTCUT_IMPORT_SECRET');
  if (!IMPORT_SECRET) return permissiveJsonErr(500, 'Import secret not configured', req);

  const incoming = req.headers.get('x-import-secret') || '';
  if (!incoming || incoming !== IMPORT_SECRET) {
    return permissiveJsonErr(401, 'Invalid import secret', req);
  }

  // ── Parse body ──────────────────────────────────────────────
  let body: { fileData?: string; fileName?: string; folder?: string };
  try {
    body = await req.json();
  } catch {
    return permissiveJsonErr(400, 'Invalid JSON body', req);
  }

  const { fileData, fileName, folder } = body;
  if (!fileData || !fileName) {
    return permissiveJsonErr(400, 'fileData and fileName required', req);
  }

  // ── Validate ────────────────────────────────────────────────
  const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return permissiveJsonErr(400, `File type .${ext} not allowed`, req);
  }

  const MAX_BASE64_BYTES = 20 * 1024 * 1024;
  if (fileData.length > MAX_BASE64_BYTES) {
    return permissiveJsonErr(413, 'File too large', req);
  }

  // ── Upload to ImageKit ─────────────────────────────────────
  const IMAGEKIT_PRIVATE_KEY = Deno.env.get('IMAGEKIT_PRIVATE_KEY');
  if (!IMAGEKIT_PRIVATE_KEY) {
    return permissiveJsonErr(500, 'ImageKit not configured', req);
  }

  try {
    // Strip data URI prefix if present
    const base64Raw = fileData.includes(',') ? fileData.split(',')[1] : fileData;
    const binaryData = Uint8Array.from(atob(base64Raw), c => c.charCodeAt(0));

    const MIME_BY_EXT: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg',
      png: 'image/png', webp: 'image/webp',
    };
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    const safeFileName = fileName.replace(/[\/\\?%*:|"<>]/g, '_');

    const credentials = btoa(`${IMAGEKIT_PRIVATE_KEY}:`);
    const formData = new FormData();
    formData.append('file', new Blob([binaryData], { type: mime }), safeFileName);
    formData.append('fileName', safeFileName);
    if (folder) formData.append('folder', folder);

    const ikRes = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}` },
      body: formData,
    });

    if (!ikRes.ok) {
      const errText = await ikRes.text().catch(() => `HTTP ${ikRes.status}`);
      console.error('[pipeline-photo-upload] ImageKit error:', errText.slice(0, 200));
      return permissiveJsonErr(502, 'Image upload failed', req);
    }

    const ikData = await ikRes.json();
    return permissiveJsonOk({
      url: ikData.url,
      fileId: ikData.fileId ?? '',
      width: ikData.width ?? null,
      height: ikData.height ?? null,
    }, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-photo-upload] Exception:', msg);
    return permissiveJsonErr(500, 'Upload failed', req);
  }
});