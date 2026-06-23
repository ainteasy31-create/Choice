// ============================================================
// Choice Properties — ImageKit Upload Client
// js/imagekit.js
//
// All photo uploads (property photos, avatars) go through
// this module. It calls the Supabase Edge Function which
// holds the ImageKit private key securely server-side.
//
// Usage:
//   import { uploadToImageKit } from '../js/imagekit.js';
//
//   const result = await uploadToImageKit(file, {
//     folder:   '/properties/PROP-ABC123',
//     onProgress: (pct) => console.log(pct + '%'),
//   });
//   // result: { url, fileId }
// ============================================================

// ── I-050: Canvas compression ─────────────────────────────
// Resizes + re-encodes as JPEG before base64 conversion.
// Fixes the Supabase Edge Function 6 MB body cap:
//   base64 adds ~33% overhead, so files > ~4.5 MB would silently
//   return HTTP 413. Compression brings typical phone photos
//   (5–12 MB) down to 300–800 KB — well under the limit and
//   ~80% faster to upload on mobile.
// HEIC/HEIF files cannot be decoded by createImageBitmap() in
// most browsers — they are rejected upstream in handleFiles()
// before reaching this function.
async function compressImage(file, maxPx = 2048, quality = 0.85) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    // I-063: createImageBitmap failed (unsupported format or memory pressure).
    // Guard against sending a raw file that's too large — base64 adds ~33% overhead,
    // so anything over ~4.5 MB will exceed the Supabase 6 MB body limit and return
    // a silent HTTP 413. Cap at 4 MB to stay safely under.
    const MAX_RAW_BYTES = 4 * 1024 * 1024;
    if (file.size > MAX_RAW_BYTES) {
      throw new Error(
        `"${file.name}" could not be compressed and is too large to upload uncompressed ` +
        `(${(file.size / 1024 / 1024).toFixed(1)} MB). ` +
        `Please reduce the photo size or use a different image.`
      );
    }
    return file;
  }
  const scale   = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
  const canvas  = document.createElement('canvas');
  canvas.width  = Math.round(bmp.width  * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.(); // free GPU memory where supported
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('Compression failed')),
      'image/jpeg',
      quality
    );
  });
}

/**
 * Convert a Blob/File to a base64 data URI string.
 */
function fileToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Upload a single file to ImageKit via the Supabase Edge Function.
 * Uses XHR instead of fetch so real HTTP upload progress can be reported.
 *
 * I-050 fixes applied here:
 *   • Canvas compression before base64 (fixes 6 MB edge-function body cap)
 *   • XHR onprogress for real 50→85% upload progress (not fake checkpoints)
 *
 * @param {File}   file
 * @param {object} options
 * @param {string}   options.folder       - ImageKit folder path
 * @param {function} options.onProgress   - callback(percent: 0–100)
 * @param {string}   options.supabaseUrl
 * @param {string}   options.anonKey
 * @param {string}   [options.propertyId] - When provided, the edge function
 *                                          will insert a row into the new
 *                                          property_photos table and return
 *                                          its id as `photoId` (Phase 3b).
 * @param {string}   [options.altText]    - Optional alt-text stored on the row
 * @param {string}   [options.caption]    - Optional caption stored on the row
 * @returns {Promise<{url: string, fileId: string|null, photoId: string|null}>}
 */
export async function uploadToImageKit(file, options = {}) {
  const {
    folder      = '/properties',
    onProgress  = null,
    supabaseUrl = CONFIG.SUPABASE_URL,
    anonKey     = CONFIG.SUPABASE_ANON_KEY,
    userToken:  preToken = null,   // Pre-fetched access token — skips getSession() call
    propertyId  = null,
    altText     = null,
    caption     = null,
  } = options;

  // Resolve the authenticated user's JWT so the Edge Function can verify
  // the caller is a real logged-in user (not just the public anon key).
  // If a pre-fetched token was passed in, use it directly (avoids a second getSession() round-trip).
  let userToken = preToken;
  if (!userToken) {
    const session = await window.CP?.Auth?.getSession?.();
    userToken = session?.access_token ?? null;
    if (!userToken) {
      throw new Error('Session expired — please log in again to upload photos.');
    }
  }

  // Validate file type client-side
  if (!file.type.startsWith('image/')) {
    throw new Error(`${file.name} is not an image file.`);
  }

  // Signal start
  onProgress?.(5);

  // I-050: Compress before encoding — this is the key fix for the 6 MB cap.
  // Typical output: 8 MB phone JPEG → ~600 KB compressed JPEG.
  const compressed = await compressImage(file);
  onProgress?.(20);

  // Convert compressed blob to base64 data URI
  const base64DataUri = await fileToBase64(compressed);
  onProgress?.(35);

  // Build a clean filename (always .jpg after compression)
  const safeName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}.jpg`;
  const payload  = JSON.stringify({ fileData: base64DataUri, fileName: safeName, folder });

  onProgress?.(40);

  // I-050: Use XHR so upload.onprogress fires during the actual HTTP transfer.
  // Progress maps: 40% (pre-send) → 40–85% (upload bytes) → 85–100% (server + parse).
  const data = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const p = 40 + Math.round((e.loaded / e.total) * 45); // 40→85
        onProgress?.(p);
      }
    };

    xhr.onload = () => {
      onProgress?.(95);
      let parsed;
      try { parsed = JSON.parse(xhr.responseText); } catch { parsed = {}; }
      if (parsed.success) {
        resolve(parsed);
      } else {
        reject(new Error(parsed.error || `Upload failed (HTTP ${xhr.status})`));
      }
    };

    xhr.onerror   = () => reject(new Error('Network error — check your connection and try again.'));
    // I-066: Supabase Edge Functions hard-terminate at 60 seconds.
    // Setting timeout > 60 s means it never fires — instead the connection is
    // reset by Supabase, which triggers onerror with "Network error", giving the
    // user a misleading message. 55 s fires cleanly before Supabase cuts the wire.
    xhr.ontimeout = () => reject(new Error('Upload timed out — your connection may be slow. Please try again.'));
    xhr.timeout   = 55_000; // 55 s — must be under the 60 s Supabase Edge Function limit

    xhr.open('POST', `${supabaseUrl}/functions/v1/imagekit-upload`);
    xhr.setRequestHeader('apikey',        anonKey);
    xhr.setRequestHeader('Authorization', `Bearer ${userToken}`);
    xhr.setRequestHeader('Content-Type',  'application/json');
    xhr.send(payload);
  });

  onProgress?.(100);

  // I-028: return url, fileId, and photoId so callers can track the DB row.
  // photoId is the property_photos UUID when propertyId was passed to the edge function.
  return { url: data.url, fileId: data.fileId ?? null, photoId: data.photoId ?? null };
}

/**
 * Upload multiple files with capped concurrency (3 at a time) and aggregate progress.
 *
 * I-016 FIX: worker-pool pattern — up to 3 uploads run simultaneously.
 * Result order is preserved regardless of which worker finished first.
 *
 * I-050 FIX: Per-file errors are caught individually. One failed photo does
 * NOT abort the rest. Failed results are returned as { error, fileName } objects
 * so callers can show a targeted retry UI rather than losing the whole batch.
 *
 * @param {File[]}  files
 * @param {object}  options  - Same as uploadToImageKit, plus:
 * @param {function} options.onFileProgress  - callback(fileIndex, percent)
 * @param {function} options.onTotalProgress - callback(overallPercent 0–100)
 *
 * @returns {Promise<Array<{url,fileId}|{error,fileName}>>} results in input order
 */
export async function uploadMultipleToImageKit(files, options = {}) {
  const { onFileProgress, onTotalProgress, ...baseOptions } = options;
  const CONCURRENCY = 3;

  const results      = new Array(files.length);
  const fileProgress = new Array(files.length).fill(0);

  const updateTotal = () => {
    const overall = Math.round(fileProgress.reduce((a, b) => a + b, 0) / files.length);
    onTotalProgress?.(overall);
  };

  let nextIndex = 0;

  async function worker() {
    while (nextIndex < files.length) {
      const i = nextIndex++;
      // I-050: catch per-file errors — one failure must not abort sibling workers.
      try {
        results[i] = await uploadToImageKit(files[i], {
          ...baseOptions,
          onProgress: (pct) => {
            fileProgress[i] = pct;
            onFileProgress?.(i, pct);
            updateTotal();
          },
        });
      } catch (err) {
        // Mark progress as complete so the total bar doesn't stall
        fileProgress[i] = 100;
        updateTotal();
        results[i] = { error: err.message, fileName: files[i].name };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker)
  );

  return results;
}

/**
 * Delete a single file from ImageKit via the imagekit-delete Edge Function.
 *
 * This is best-effort — callers should fire-and-forget and not surface
 * CDN errors to the user. A failure here does not affect DB state.
 *
 * @param {string} fileId       - ImageKit fileId returned at upload time
 * @param {object} options
 * @param {string} options.supabaseUrl   - CONFIG.SUPABASE_URL
 * @param {string} options.anonKey       - CONFIG.SUPABASE_ANON_KEY
 * @param {string} options.userToken     - JWT from the active session
 *
 * @returns {Promise<boolean>} true if deleted (or already gone), false on error
 */
export async function deleteFromImageKit(fileId, { supabaseUrl, anonKey, userToken }) {
  if (!fileId) return false;
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/imagekit-delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':        anonKey,
        'Authorization': `Bearer ${userToken}`,
      },
      body: JSON.stringify({ fileId }),
    });
    const data = await res.json().catch(() => ({}));
    return data.success === true;
  } catch {
    return false;
  }
}

