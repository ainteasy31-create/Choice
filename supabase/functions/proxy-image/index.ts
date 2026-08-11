/**
 * proxy-image
 *
 * Fetches a property image server-side and re-serves it with
 * Access-Control-Allow-Origin: * so the admin watermark-review canvas
 * can call getImageData() without hitting a CORS SecurityError.
 *
 * Security:
 *  - Only ImageKit and known listing-source CDN URLs are allowed — prevents SSRF.
 *  - Requires a valid Supabase session (admin JWT via ?token= or Authorization header).
 *  - Returns original Content-Type + a 60-second cache hint (images rarely change).
 *
 * Usage:  GET /proxy-image?url=https%3A%2F%2Fphotos.zillowstatic.com%2F...
 *         Authorization: Bearer <supabase-jwt>
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleCors } from '../_shared/cors.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// Only proxy images from known image hosts — no arbitrary URL fetch.
// Source URLs need this path because Zillow/Realtor CDNs commonly reject
// browser hotlinks from the admin domain.
const ALLOWED_HOSTS = new Set([
  'ik.imagekit.io',
  'photos.zillowstatic.com',
  'zillowstatic.com',
  'img.realtor.com',
  'ap.rdcpix.com',
  'images1.apartmentfinder.com',
  'images2.apartmentfinder.com',
  'ssl.cdn-redfin.com',
]);

function isAllowedImageUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

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

  if (!imageUrl || !isAllowedImageUrl(imageUrl)) {
    return new Response('Image host is not allowed', { status: 400 });
  }

  const authed = await verifySession(req);
  if (!authed) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Fetch the image from ImageKit — no CORS restriction server-side.
    const sourceHost = new URL(imageUrl).hostname.toLowerCase();
    const referer = sourceHost.includes('zillow')
      ? 'https://www.zillow.com/'
      : sourceHost.includes('realtor') || sourceHost === 'ap.rdcpix.com'
        ? 'https://www.realtor.com/'
        : sourceHost.includes('apartment')
          ? 'https://www.apartments.com/'
          : sourceHost.includes('redfin')
            ? 'https://www.redfin.com/'
            : undefined;
    const imgRes = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'ChoiceProperties-WatermarkScanner/1.0',
        ...(referer ? { Referer: referer } : {}),
      },
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
