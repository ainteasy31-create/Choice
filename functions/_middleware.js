// Choice Properties — Cloudflare Pages middleware
// =================================================
// Generates a fresh CSP nonce per HTML request, rewrites the placeholder in
// the response body, and sets the Content-Security-Policy header for that
// response only. Replaces the previously hard-coded nonce that was baked
// into _headers and inline <script>/<style nonce="..."> attributes.
//
// Runs for every request (including static assets). Bails out fast on
// non-HTML responses so it adds zero work to css/js/image fetches.
//
// IMPORTANT: the static CSP rule has been removed from `_headers` so this
// middleware is the single source of truth for Content-Security-Policy.

// The build script (generate-config.js) stamps every inline <script> tag
// with nonce="__CSP_NONCE__" — this middleware replaces that stable
// placeholder with a fresh per-request value. (The legacy committed
// nonce 'VZEkWatH2Jtta2vFy8dRhA' is also rewritten so the source files
// remain readable in development.)
const PLACEHOLDER = '__CSP_NONCE__';
const LEGACY_PLACEHOLDER = 'VZEkWatH2Jtta2vFy8dRhA';

const CSP_TEMPLATE = [
  "default-src 'self'",
  "script-src 'self' 'nonce-__NONCE__' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob: https://ik.imagekit.io https://*.supabase.co https://tile.openstreetmap.org https://*.basemaps.cartocdn.com https://images.unsplash.com",
  "connect-src 'self' https://*.supabase.co https://*.supabase.in wss://*.supabase.co https://script.google.com https://script.googleusercontent.com https://api.ipify.org https://api.my-ip.io https://ipapi.co https://nominatim.openstreetmap.org https://api.geoapify.com https://upload.imagekit.io https://api.imagekit.io",
  "frame-src https://maps.google.com https://www.google.com",
  // H-9: heic2any spawns a libheif Web Worker via a Blob URL, so the
  // worker source must include 'self' and blob:. Without this Cloudflare
  // CSP would block the conversion silently and the upload would 'hang'.
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

function makeNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // URL-safe, no padding — keeps the same character class as the placeholder.
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Paths that exist on disk but must not be served from the CDN.
// Middleware runs BEFORE static asset matching, so this is the only reliable
// way to block them while destination_dir is "." (the repo root).
const BLOCKED_EXACT = new Set([
  '/SETUP.sql',
  '/MIGRATION_SCHEMA.sql',
  '/MISSING_SCHEMA.sql',
  '/GAS-EMAIL-RELAY.gs',
  '/generate-config.js',
  '/ARCHITECTURE.md',
  '/FIXES.md',
  '/SECURITY.md',
  '/MIGRATION_PATTERNS.md',
  '/PROJECT_STATUS.md',
  '/KNOWN_ISSUES.md',
  '/README.md',
]);
const BLOCKED_PREFIXES = [
  '/scripts/',
  '/supabase/',
  '/.agents/',
  '/.local/',
  '/.github/',
  '/.githooks/',
  '/db/',
];

function isBlocked(pathname) {
  if (BLOCKED_EXACT.has(pathname)) return true;
  for (const p of BLOCKED_PREFIXES) if (pathname.startsWith(p)) return true;
  // Any *.sql, *.gs, or top-level *.md file falls through to here too:
  if (/^\/[^/]+\.(sql|gs)$/i.test(pathname)) return true;
  return false;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (isBlocked(url.pathname)) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const response = await context.next();

  // Only rewrite successful HTML responses. Skip 3xx redirects, non-HTML
  // assets, and anything we can't safely re-buffer.
  const ct = response.headers.get('Content-Type') || '';
  if (!ct.toLowerCase().includes('text/html')) return response;
  if (response.status >= 300 && response.status < 400) return response;
  if (response.status === 204 || response.status === 205) return response;

  const nonce = makeNonce();
  const csp = CSP_TEMPLATE.replace('__NONCE__', nonce);

  let html;
  try {
    html = await response.text();
  } catch (_) {
    // Body already consumed or stream error — return original response with CSP.
    const fallbackHeaders = new Headers(response.headers);
    fallbackHeaders.set('Content-Security-Policy', csp);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: fallbackHeaders,
    });
  }

  // Use split/join — cheaper than a global regex over large HTML bodies.
  if (html.includes(PLACEHOLDER)) {
    html = html.split(PLACEHOLDER).join(nonce);
  }
  if (html.includes(LEGACY_PLACEHOLDER)) {
    html = html.split(LEGACY_PLACEHOLDER).join(nonce);
  }

  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', csp);
  // Body length changed — let the runtime recompute it.
  headers.delete('Content-Length');

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
