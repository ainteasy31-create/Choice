/**
 * proxy-image
 *
 * Fetches a property image server-side and re-serves it with
 * Access-Control-Allow-Origin: * so the admin watermark-review canvas
 * can call getImageData() without hitting a CORS SecurityError.
 *
 * Security:
 *  - Only ImageKit CDN URLs (ik.imagekit.io) are allowed — prevents SSRF.
 *  - Requires a valid Supabase session (admin JWT via ?token= or Authorization header).
 *  - Returns original Content-Type + a 60-second cache hint (images rarely change).
 *
 * Usage:  GET /proxy-image?url=https%3A%2F%2Fik.imagekit.io%2F...
 *         Authorization: Bearer <supabase-jwt>
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCors } from '../_shared/cors.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// Only proxy images from the ImageKit CDN — no arbitrary URL fetch.
const ALLOWED_HOST_RE = /^https:\/\/ik\.imagekit\.io\//i;

async function verifySession(req: Request): Promise<boolean> {
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim()
    || new URL(req.url).searchParams.get('token') || '';
  if (!token) return false;
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return false;
  // Must be an admin
  const { data: role } = await supabase
    .from('admin_roles').select('id').eq('user_id', user.id).maybeSingle();
  return !!role;
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const imageUrl = url.searchParams.get('url') || '';

  if (!imageUrl || !ALLOWED_HOST_RE.test(imageUrl)) {
    return new Response('Only ImageKit CDN URLs are allowed', { status: 400 });
  }

  const authed = await verifySession(req);
  if (!authed) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Fetch the image from ImageKit — no CORS restriction server-side.
    const imgRes = await fetch(imageUrl, {
      headers: { 'User-Agent': 'ChoiceProperties-WatermarkScanner/1.0' },
      redirect: 'follow',
    });

    if (!imgRes.ok) {
      return new Response(`Upstream fetch failed: ${imgRes.status}`, { status: 502 });
    }

    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const body = await imgRes.arrayBuffer();

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.byteLength),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60',
        'X-Proxied-By': 'choice-proxy-image',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('proxy-image error:', msg);
    return new Response('Proxy error: ' + msg, { status: 502 });
  }
});
