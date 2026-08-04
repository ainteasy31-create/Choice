// ============================================================
// Import to Choice Properties — Project Configuration v2.0
// ============================================================
// ALL project credentials and endpoints live here.
// This file is committed to the repository and travels with
// the project everywhere (GitHub, forks, imports, etc.).
//
// ⚠️  ROTATION: When you rotate a credential, update its value
//     here, reload the extension in chrome://extensions, then
//     update the matching secret on the server side (Supabase
//     Edge Function env, Replit Secrets, etc.).
//
// ⚠️  SERVICE ROLE KEY: Never paste the Supabase service_role
//     key here. It bypasses all Row Level Security and must
//     only live in server-side environments (Replit Secrets,
//     Supabase Edge Function env vars, etc.).
// ============================================================

const CP_CONFIG = {

  // ── Supabase ──────────────────────────────────────────────
  // Project URL (also used in manifest.json host_permissions)
  SUPABASE_URL: 'https://tlfmwetmhthpyrytrcfo.supabase.co',

  // Anon / public key — safe to commit (protected by RLS).
  // Found in: Supabase Dashboard → Project Settings → API → Project API keys → anon public
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsZm13ZXRtaHRocHlyeXRyY2ZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxODMwMjQsImV4cCI6MjA5MDc1OTAyNH0.sqjt9_oMKDoorA8Tzed1hlkH5zEQGZvFskAG3Qr9CFw',

  // Edge Function endpoint — receives listing imports from the extension.
  // Found in: Supabase Dashboard → Edge Functions → receive-pipeline-import
  EDGE_URL: 'https://tlfmwetmhthpyrytrcfo.supabase.co/functions/v1/receive-pipeline-import',

  // Shared import secret — sent as x-import-secret header to authenticate
  // extension requests to the Edge Function.
  // Set this same value in: Supabase Dashboard → Edge Functions → receive-pipeline-import → Secrets → IMPORT_SECRET
  IMPORT_SECRET: 'cp_import_7Kx3m9P2w5',

  // ── ImageKit ──────────────────────────────────────────────
  // URL endpoint — base URL for all ImageKit-hosted images.
  // Found in: ImageKit Dashboard → URL-endpoints
  IMAGEKIT_URL_ENDPOINT: 'https://ik.imagekit.io/21rg7lvzo',

  // Public key — used for client-side upload authentication (safe to commit).
  // Found in: ImageKit Dashboard → Developer Options → API Keys → Public key
  IMAGEKIT_PUBLIC_KEY: 'public_gKSXcziLMFJO387FJXBa7kTvVA0=',

  // ⚠️  ImageKit private key lives in scraper/.env (IMAGEKIT_PRIVATE_KEY) and
  //     is used server-side only (scraper scripts + Edge Functions).
  //     Never put it here — the extension only needs the public key.

  // ── Pipeline admin panel ──────────────────────────────────
  // Hosted on Cloudflare Pages. Used in pipeline.py and manual_publish.py.
  SITE_BASE_URL: 'https://choice-properties-site.pages.dev',

};

// Make available in both browser (content script) and service worker contexts.
if (typeof globalThis !== 'undefined') {
  globalThis.CP_CONFIG = CP_CONFIG;
}
