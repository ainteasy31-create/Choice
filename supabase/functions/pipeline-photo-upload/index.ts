// ============================================================
// Choice Properties — pipeline-photo-upload Edge Function
// v2.0 — August 2026
//
// Accepts an image from the Orion/Chrome extension and uploads
// it to ImageKit. Uses the shared import secret for auth.
//
// v2.0: SUPPORTS BOTH BINARY FORM-DATA AND BASE64 JSON
//   - FormData (multipart/form-data): { file: Blob, fileName, folder }
//     This is the preferred path — 33% smaller payload than base64.
//   - JSON: { fileData: string (base64), fileName, folder }
//     Backward-compatible with older extension versions.
//
// POST body (FormData): file (binary), fileName, folder?
// POST body (JSON):     { fileData: string (base64), fileName, folder? }
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

  // ── Parse body (FormData or JSON) ───────────────────────────
  let fileName = '';
  let folder: string | undefined;
  let binaryData: Uint8Array | null = null;
  let mime = 'application/octet-stream';

  const contentType = req.headers.get('content-type') || '';

  try {
    if (contentType.includes('multipart/form-data')) {
      // ── Binary FormData path (v2.0) ────────────────────────
      const formData = await req.formData();
      const file = formData.get('file');
      if (!(file instanceof Blob)) {
        return permissiveJsonErr(400, 'file (Blob) is required in FormData', req);
      }
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      if (fileBytes.length === 0) {
        return permissiveJsonErr(400, 'Empty file', req);
      }
      binaryData = fileBytes;
      mime = file.type || 'application/octet-stream';
      const formFileName = formData.get('fileName');
      fileName = formFileName ? String(formFileName) : 'photo.jpg';
      const folderVal = formData.get('folder');
      if (folderVal) folder = String(folderVal);
    } else {
      // ── JSON base64 path (backward compatible) ─────────────
      const body = await req.json();
      const { fileData, fileName: fn, folder: f } = body as {
        fileData?: string;
        fileName?: string;
        folder?: string;
      };
      if (!fileData || !fn) {
        return permissiveJsonErr(400, 'fileData and fileName required', req);
      }
      fileName = fn;
      folder = f;

      // Strip data URI prefix if present
      const base64Raw = fileData.includes(',') ? fileData.split(',')[1] : fileData;
      binaryData = Uint8Array.from(atob(base64Raw), c => c.charCodeAt(0));
      mime = 'application/octet-stream';
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return permissiveJsonErr(400, 'Invalid body: ' + msg, req);
  }

  if (!binaryData || binaryData.length === 0) {
    return permissiveJsonErr(400, 'No image data provided', req);
  }

  // ── Validate ────────────────────────────────────────────────
  const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return permissiveJsonErr(400, `File type .${ext} not allowed`, req);
  }

  const MAX_BYTES = 20 * 1024 * 1024;
  if (binaryData.length > MAX_BYTES) {
    return permissiveJsonErr(413, 'File too large', req);
  }

  // ── Upload to ImageKit ─────────────────────────────────────
  const IMAGEKIT_PRIVATE_KEY = Deno.env.get('IMAGEKIT_PRIVATE_KEY');
  if (!IMAGEKIT_PRIVATE_KEY) {
    return permissiveJsonErr(500, 'ImageKit not configured', req);
  }

  try {
    const MIME_BY_EXT: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg',
      png: 'image/png', webp: 'image/webp',
    };
    if (mime === 'application/octet-stream') {
      mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    }
    const safeFileName = fileName.replace(/[\/\\?%*:|"<>]/g, '_');

    const credentials = btoa(`${IMAGEKIT_PRIVATE_KEY}:`);
    const formData = new FormData();
    const blobPart = binaryData.buffer.slice(binaryData.byteOffset, binaryData.byteOffset + binaryData.byteLength) as ArrayBuffer;
    formData.append('file', new Blob([blobPart], { type: mime }), safeFileName);
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