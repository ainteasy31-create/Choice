// ============================================================
// CORS helpers — strict origin allowlist
// ============================================================
// Previously every edge function returned `Access-Control-Allow-Origin: *`,
// which let any site on the internet make authenticated CORS requests on
// behalf of a logged-in user (M-2). The allowlist below covers:
//   • the production Pages domain
//   • Cloudflare Pages preview deploys (random hash + branch deploys)
//   • localhost during development
// Any other origin gets the production domain echoed back, which causes the
// browser CORS check to fail safely.
// ============================================================

const PRODUCTION_ORIGIN = 'https://choice-properties-site.pages.dev';

const STATIC_ALLOWED = new Set<string>([
  PRODUCTION_ORIGIN,
  // localhost for the rare case the owner runs a quick file-server preview.
  'http://localhost:8788',
  'http://localhost:8000',
  'http://127.0.0.1:8788',
  'http://127.0.0.1:8000',
]);

// Matches `https://<hash>.choice-properties-site.pages.dev` and
// branch-deploy aliases like `https://feature-foo.choice-properties-site.pages.dev`.
const PREVIEW_ORIGIN_RE =
  /^https:\/\/[a-z0-9-]+\.choice-properties-site\.pages\.dev$/i;

// Chrome extension origins: chrome-extension://<extension-id>
const CHROME_EXTENSION_RE = /^chrome-extension:\/\//;

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (STATIC_ALLOWED.has(origin)) return true;
  if (PREVIEW_ORIGIN_RE.test(origin)) return true;
  if (CHROME_EXTENSION_RE.test(origin)) return true;
  return false;
}

export function resolveAllowOrigin(origin: string | null): string {
  return isAllowedOrigin(origin) ? (origin as string) : PRODUCTION_ORIGIN;
}

export function buildCorsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': resolveAllowOrigin(origin),
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-import-secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

// ── Backwards-compat exports ─────────────────────────────────────────────
// Older functions import `corsHeaders` (a static object) and `cors`. To
// avoid breaking 19 functions in one go, keep these exports — they pin the
// origin to production. New / updated functions should call buildCorsHeaders
// with `req.headers.get('origin')` so preview deploys work too.
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': PRODUCTION_ORIGIN,
  'Vary': 'Origin',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-import-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
export const cors = corsHeaders;

export function corsResponse(origin: string | null = null): Response {
  return new Response(null, { status: 204, headers: buildCorsHeaders(origin) });
}

export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: buildCorsHeaders(req.headers.get('origin')),
    });
  }
  return null;
}

export function jsonOk(data: unknown, req: Request | null = null): Response {
  const headers = req ? buildCorsHeaders(req.headers.get('origin')) : { ...corsHeaders };
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

export function jsonErr(status: number, message: string, req: Request | null = null): Response {
  const headers = req ? buildCorsHeaders(req.headers.get('origin')) : { ...corsHeaders };
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
