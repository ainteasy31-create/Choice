// ============================================================
// Choice Properties — Config Generator
// Runs at build time to create config.js from environment vars
// Runs at Cloudflare Pages build time — triggered by GitHub push
// Never edit config.js directly — edit this file instead
// ============================================================

(async function main() {

const fs = require('fs');


// Read from environment variables (set in your hosting platform's dashboard)
const config = {
  SUPABASE_URL:      process.env.SUPABASE_URL      || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',

  // I-029: SITE_URL is used to rewrite sitemap.xml and robots.txt at build time.
  // Set this to your production domain in your hosting platform's env var dashboard.
  // Example: https://choiceproperties.com  (no trailing slash)
  SITE_URL: (process.env.SITE_URL || '').replace(/\/$/, ''),

  // APPLY_FORM_URL: Internal application frontend route.
  // Apply Now buttons on all property listings route here.
  // Keep this as /apply unless the internal route changes.
  APPLY_FORM_URL: (process.env.APPLY_FORM_URL || '/apply').replace(/\/$/, ''),

  IMAGEKIT_URL:        process.env.IMAGEKIT_URL        || '',
  IMAGEKIT_PUBLIC_KEY: process.env.IMAGEKIT_PUBLIC_KEY || '',

  GEOAPIFY_API_KEY: process.env.GEOAPIFY_API_KEY || '',

  COMPANY_NAME:     process.env.COMPANY_NAME     || 'Choice Properties',
  COMPANY_EMAIL:    process.env.COMPANY_EMAIL    || 'support@choiceproperties.com',
  COMPANY_PHONE:    process.env.COMPANY_PHONE    || '707-706-3137',
  COMPANY_TAGLINE:  process.env.COMPANY_TAGLINE  || 'Your trust is our standard.',
  COMPANY_ADDRESS:  process.env.COMPANY_ADDRESS  || '',

  LEASE_DEFAULT_LATE_FEE_FLAT:  Number(process.env.LEASE_DEFAULT_LATE_FEE_FLAT)  || 50,
  LEASE_DEFAULT_LATE_FEE_DAILY: Number(process.env.LEASE_DEFAULT_LATE_FEE_DAILY) || 10,
  LEASE_DEFAULT_EXPIRY_DAYS:    Number(process.env.LEASE_DEFAULT_EXPIRY_DAYS)    || 7,

  FEATURES: {
    CO_APPLICANT:    process.env.FEATURE_CO_APPLICANT    !== 'false',
    VEHICLE_INFO:    process.env.FEATURE_VEHICLE_INFO    !== 'false',
    DOCUMENT_UPLOAD: process.env.FEATURE_DOCUMENT_UPLOAD !== 'false',
    MESSAGING:       process.env.FEATURE_MESSAGING       !== 'false',
    REALTIME_UPDATES:process.env.FEATURE_REALTIME_UPDATES !== 'false',
  },
};

const EXPECTED_SUPABASE_PROJECT_REF = 'tlfmwetmhthpyrytrcfo';

// Validate required values
// I-051: SITE_URL is required — without it, sitemap.xml and robots.txt ship with
// YOUR-DOMAIN.com placeholders, breaking SEO and crawler discovery in production.
const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'IMAGEKIT_URL', 'IMAGEKIT_PUBLIC_KEY', 'SITE_URL'];
const missing  = required.filter(k => !config[k]);
if (missing.length) {
  console.error('❌ Missing required environment variables:', missing.join(', '));
  console.error('   Set these in your hosting platform\'s environment variables dashboard');
  if (missing.includes('SITE_URL')) {
    console.error('   SITE_URL example: https://choiceproperties.com  (no trailing slash)');
    console.error('   Without SITE_URL, sitemap.xml ships with YOUR-DOMAIN.com placeholders.');
  }
  process.exit(1);
}

try {
  const supabaseHost = new URL(config.SUPABASE_URL).hostname;
  if (!supabaseHost.startsWith(EXPECTED_SUPABASE_PROJECT_REF + '.')) {
    console.error('❌ SUPABASE_URL points to the wrong Supabase project:', supabaseHost);
    console.error('   Expected project ref:', EXPECTED_SUPABASE_PROJECT_REF);
    console.error('   Update Cloudflare Pages environment variables before deploying.');
    process.exit(1);
  }
} catch {
  console.error('❌ SUPABASE_URL is not a valid URL.');
  process.exit(1);
}

if (!config.GEOAPIFY_API_KEY) {
  console.warn('⚠  GEOAPIFY_API_KEY is not set — address autocomplete will be disabled');
}

// ── M-09: Validate Supabase credentials with a live HTTP probe ───────────────
// A non-empty URL/key can still be wrong (typo, wrong project).
// GET /rest/v1/ with the anon key returns:
//   200  → URL correct, key valid
//   401  → URL correct, key invalid (still a useful signal)
//   anything else / timeout → URL is wrong
// Build fails fast rather than deploying a broken site.
await (async function validateSupabaseCredentials() {
  const testUrl = config.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/';
  console.log('🔍 Validating Supabase credentials against', testUrl);
  try {
    const https = require('https');
    const url   = require('url');
    const parsed = url.parse(testUrl);
    await new Promise(function(resolve, reject) {
      const req = https.request({
        hostname: parsed.hostname,
        path:     parsed.path,
        method:   'GET',
        headers:  { apikey: config.SUPABASE_ANON_KEY },
        timeout:  8000,
      }, function(res) {
        if (res.statusCode === 200) {
          console.log('✅ Supabase credentials validated (HTTP 200)');
          resolve();
        } else if (res.statusCode === 401) {
          // Read body to distinguish "valid key, schema restricted" from "invalid key"
          let body = '';
          res.on('data', function(chunk) { body += chunk; });
          res.on('end', function() {
            try {
              const parsed = JSON.parse(body);
              // Two valid-project 401 shapes from Supabase:
              //  1. 'Access to schema is forbidden'  — project restricts schema listing to service_role
              //  2. hint includes 'service_role'     — the /rest/v1/ root requires service_role;
              //     the anon key is structurally valid and works for row-level table access
              const schemaRestricted = parsed.message && parsed.message.includes('Access to schema is forbidden');
              const serviceRoleRoot  = parsed.hint    && parsed.hint.includes('service_role');
              if (schemaRestricted || serviceRoleRoot) {
                console.log('✅ Supabase project reachable; anon key is valid for row-level table access');
                resolve();
                return;
              }
            } catch (e) { /* ignore JSON parse errors */ }
            console.error('❌ Supabase credential check failed: URL is reachable but SUPABASE_ANON_KEY is invalid (HTTP 401).');
            console.error('   Double-check the anon key in your hosting platform environment variables.');
            process.exit(1);
          });
        } else {
          console.error('❌ Supabase credential check failed: unexpected HTTP ' + res.statusCode + ' from ' + testUrl);
          console.error('   Check that SUPABASE_URL is correct and the project is not paused.');
          process.exit(1);
        }
      });
      req.on('timeout', function() {
        req.destroy();
        console.error('❌ Supabase credential check timed out. Verify SUPABASE_URL is correct and the project is active.');
        process.exit(1);
      });
      req.on('error', function(err) {
        console.error('❌ Supabase credential check network error:', err.message);
        console.error('   Verify SUPABASE_URL is a valid HTTPS URL.');
        process.exit(1);
      });
      req.end();
    });
  } catch (err) {
    console.error('❌ Supabase credential check threw an unexpected error:', err.message);
    process.exit(1);
  }
})();

// Generate config.js
const output = `// ============================================================
// Choice Properties — Auto-generated config
// Generated by generate-config.js at build time
// DO NOT EDIT THIS FILE — it is overwritten on every deploy
// Edit environment variables in your hosting platform dashboard
// ============================================================

var CONFIG = {
  SUPABASE_URL:      '${config.SUPABASE_URL}',
  SUPABASE_ANON_KEY: '${config.SUPABASE_ANON_KEY}',

  // Internal application frontend route.
  // Keep APPLY_FORM_URL as /apply unless the route changes.
  APPLY_FORM_URL: '${config.APPLY_FORM_URL}',

  IMAGEKIT_URL:        '${config.IMAGEKIT_URL}',
  IMAGEKIT_PUBLIC_KEY: '${config.IMAGEKIT_PUBLIC_KEY}',

  GEOAPIFY_API_KEY: '${config.GEOAPIFY_API_KEY}',

  COMPANY_NAME:     '${config.COMPANY_NAME}',
  COMPANY_EMAIL:    '${config.COMPANY_EMAIL}',
  COMPANY_PHONE:    '${config.COMPANY_PHONE}',
  COMPANY_TAGLINE:  '${config.COMPANY_TAGLINE}',
  COMPANY_ADDRESS:  '${config.COMPANY_ADDRESS}',

  LEASE_DEFAULT_LATE_FEE_FLAT:  ${config.LEASE_DEFAULT_LATE_FEE_FLAT},
  LEASE_DEFAULT_LATE_FEE_DAILY: ${config.LEASE_DEFAULT_LATE_FEE_DAILY},
  LEASE_DEFAULT_EXPIRY_DAYS:    ${config.LEASE_DEFAULT_EXPIRY_DAYS},

  FEATURES: {
    CO_APPLICANT:     ${config.FEATURES.CO_APPLICANT},
    VEHICLE_INFO:     ${config.FEATURES.VEHICLE_INFO},
    DOCUMENT_UPLOAD:  ${config.FEATURES.DOCUMENT_UPLOAD},
    MESSAGING:        ${config.FEATURES.MESSAGING},
    REALTIME_UPDATES: ${config.FEATURES.REALTIME_UPDATES},
  },
};

// Derived helpers
CONFIG.isLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);
CONFIG.baseUrl     = location.origin;

// ImageKit delivery helper
CONFIG.img = function(url, preset) {
  const fallback = url || '/assets/placeholder-property.jpg';
  if (!url) return '/assets/placeholder-property.jpg';
  if (!CONFIG.IMAGEKIT_URL || CONFIG.IMAGEKIT_URL.includes('YOUR_IMAGEKIT_ID')) {
    return fallback;
  }
  const transforms = {
    card:       'tr:w-600,q-80,f-webp',
    card_2x:    'tr:w-1200,q-80,f-webp',
    gallery:    'tr:w-1200,q-90,f-webp',
    gallery_2x: 'tr:w-2400,q-85,f-webp',
    strip:      'tr:w-80,h-60,c-maintain_ratio,q-70,f-webp',
    thumb:      'tr:w-120,h-120,c-maintain_ratio,q-75,f-webp',
    lightbox:   'tr:q-95,f-webp',
    og:         'tr:w-1200,h-630,c-force,fo-center,q-85,f-webp',
    avatar:     'tr:w-80,h-80,c-force,fo-face,q-80,f-webp',
    avatar_lg:  'tr:w-160,h-160,c-force,fo-face,q-85,f-webp',
  };
  const tr = transforms[preset] || transforms.gallery;
  if (url.startsWith(CONFIG.IMAGEKIT_URL)) {
    // Preserve watermark transform if present (ot-Choice = our text overlay).
    // Strip all existing /tr:... segments, then rebuild with size preset first,
    // followed by the watermark as a chained /tr: step so it renders on top.
    const wmMatch = url.match(/\\/tr:([^/]*ot-Choice[^/]*)/);
    const wmTr = wmMatch ? wmMatch[1] : null;
    const clean = url.replace(/\\/tr:[^/]+/g, '');
    const imgPath = clean.slice(CONFIG.IMAGEKIT_URL.length);
    return CONFIG.IMAGEKIT_URL + '/' + tr + (wmTr ? '/tr:' + wmTr : '') + imgPath;
  }
  // External URLs (Zillow CDN, S3, etc.) — serve directly, never proxy through ImageKit
  return url;
};

CONFIG.srcset = function(url, preset1x, preset2x) {
  const u1 = CONFIG.img(url, preset1x);
  const u2 = CONFIG.img(url, preset2x);
  if (!u1) return '';
  if (!u2 || u2 === u1) return u1;
  return u1 + ' 1x, ' + u2 + ' 2x';
};

Object.freeze(CONFIG);
Object.freeze(CONFIG.FEATURES);
`;

fs.writeFileSync('config.js', output);
console.log('✅ config.js generated successfully from environment variables');

if (fs.existsSync('apply')) {
  const applyConfig = {
    SUPABASE_URL: config.SUPABASE_URL,
    SUPABASE_ANON_KEY: config.SUPABASE_ANON_KEY,
    GEOAPIFY_API_KEY: config.GEOAPIFY_API_KEY,
    LISTING_SITE_URL: (config.SITE_URL || process.env.LISTING_SITE_URL || 'https://choice-properties-site.pages.dev').replace(/\/$/, ''),
  };
  const applyOutput = `window.CP_CONFIG = ${JSON.stringify(applyConfig, null, 2)};\n`;
  fs.writeFileSync('apply/config.js', applyOutput);
  console.log('✅ apply/config.js generated successfully (SUPABASE_URL → receive-application Edge Function)');
}

// ── I-029 / I-051: Rewrite sitemap.xml and robots.txt with real domain ──────
// SITE_URL is now required (validated above) so this block always runs.
// Replaces YOUR-DOMAIN.com placeholder with the value of SITE_URL env var.
if (config.SITE_URL) {
  const PLACEHOLDER = 'YOUR-DOMAIN.com';
  const domain = config.SITE_URL.replace(/^https?:\/\//, ''); // strip protocol for bare replacements

  ['sitemap.xml', 'robots.txt'].forEach(function (filename) {
    if (!fs.existsSync(filename)) return;
    const original = fs.readFileSync(filename, 'utf8');
    const rewritten = original
      .split('https://' + PLACEHOLDER).join(config.SITE_URL)
      .split('http://'  + PLACEHOLDER).join(config.SITE_URL)
      .split(PLACEHOLDER).join(domain);
    if (rewritten !== original) {
      fs.writeFileSync(filename, rewritten);
      console.log('✅ ' + filename + ' domain updated to ' + config.SITE_URL);
    }
  });
}

// ── Build-time nav + footer injection ────────────────────────────────────────
// Reads component files once and injects their HTML into every page's slot,
// eliminating the 2 fetch() calls per page that components.js otherwise makes.
let buildNavHtml = '';
let buildFooterHtml = '';
try {
  buildNavHtml    = fs.readFileSync('components/nav.html',    'utf8');
  buildFooterHtml = fs.readFileSync('components/footer.html', 'utf8');
  console.log('✅ Nav + footer components loaded for build-time injection');
} catch (e) {
  console.warn('⚠  Could not read nav/footer components — skipping injection:', e.message);
}

// ── I-052: CSP nonce injection — eliminates 'unsafe-inline' from script-src ─
// Generates a fresh random nonce on every build.
// Injects nonce="<value>" into every inline <script> and <script type="module">
// tag across all HTML files, then rewrites _headers CSP to use 'nonce-<value>'
// instead of 'unsafe-inline'. Since Cloudflare Pages deploys _headers as a
// static file per build, the nonce is consistent within each deployment.
// ── H-07: Automated cache busting — replace ?v=__BUILD_VERSION__ in all HTML ──
// BUILD_VERSION is a timestamp set once per build. Every deploy automatically
// produces unique ?v= strings, so browsers always fetch the latest CSS/JS files
// even when _headers sets Cache-Control: immutable on /css/* and /js/*.
const htmlFiles = (function walk(dir) {
  const results = [];
  fs.readdirSync(dir).forEach(function(name) {
    const full = dir + '/' + name;
    if (fs.statSync(full).isDirectory()) {
      results.push.apply(results, walk(full));
    } else if (name.endsWith('.html')) {
      results.push(full);
    }
  });
  return results;
})('.');

const BUILD_VERSION = Date.now().toString();

// ── I-052 (fixed): CSP nonce + cache-busting in a single pass ───────────────
// Previous attempt failed because HTML nonces were baked into committed files
// while _headers got a fresh nonce each build (mismatch). The fix: generate-config.js
// rewrites BOTH HTML files AND _headers in the same build step, so nonces always match.
//
// What this does per build:
//   1. Generates a fresh random nonce.
//   2. In each HTML file:
//      a. Replaces ?v=__BUILD_VERSION__ cache-bust tokens.
//      b. Converts <link rel="preload" ... onload="this.rel='stylesheet'"> to a plain
//         <link rel="stylesheet"> — the preload trick used inline event handlers which
//         required 'unsafe-inline' in script-src. Plain stylesheets are equally fast on
//         modern CDNs and remove the only remaining script-src inline requirement.
//      c. Adds nonce="VALUE" to every inline <script> tag (no src= attr, not JSON-LD).
//   3. Rewrites _headers: replaces 'unsafe-inline' in script-src with 'nonce-VALUE'.
//
// Since Cloudflare Pages deploys _headers and HTML files from the same build output,
// the nonce is guaranteed consistent within each deployment.

// Stable placeholder for the per-request CSP nonce.
// functions/_middleware.js (Cloudflare Pages middleware) generates a fresh
// random nonce on every request and rewrites this placeholder in the response
// body, then sets the matching Content-Security-Policy header. Per-request
// rotation is stronger than per-build rotation (a leaked build-time nonce
// would be valid for the entire deployment lifetime).
const nonce = '__CSP_NONCE__';

htmlFiles.forEach(function(file) {
  let src = fs.readFileSync(file, 'utf8');
  let modified = false;

  // Step A: cache busting
  const afterCB = src.replace(/\?v=__BUILD_VERSION__/g, '?v=' + BUILD_VERSION);
  if (afterCB !== src) { src = afterCB; modified = true; }

  // Step B: convert CSS preload+onload to plain stylesheet links
  // Handles: <link rel="preload" href="..." as="style" onload="this.rel='stylesheet'">
  // (attribute order may vary)
  const afterPreload = src.replace(
    /<link\b([^>]*)\bonload=["']this\.rel='stylesheet'["']([^>]*)>/gi,
    function(match, before, after) {
      if (!/(\brel=["']preload["']|\bas=["']style["'])/.test(match)) return match;
      const hrefM = match.match(/\bhref=["']([^"']+)["']/);
      return hrefM ? `<link rel="stylesheet" href="${hrefM[1]}">` : match;
    }
  );
  if (afterPreload !== src) { src = afterPreload; modified = true; }

  // Step C: add nonce to inline <script> tags
  // Skip: <script src="..."> (external), <script type="application/ld+json"> (JSON-LD data)
  const afterNonce = src.replace(/<script\b([^>]*)>/gi, function(match, attrs) {
    if (/\bsrc\s*=/.test(attrs)) return match;                                     // external script
    if (/\btype\s*=\s*["']application\/ld\+json["']/.test(attrs)) return match;  // JSON-LD
    const cleanAttrs = attrs.replace(/\s+nonce=["'][^"']*["']/gi, '').trimEnd();    // remove stale nonce
    return `<script${cleanAttrs} nonce="${nonce}">`;
  });
  if (afterNonce !== src) { src = afterNonce; modified = true; }

  // Step C2: inject the client-side error reporter as the first <head> script
  // so it can capture errors from later-loading scripts. Idempotent — only
  // injects if the file isn't already referenced.
  if (!/cp-error-reporter\.js/.test(src)) {
    const reporterTag =
      '\n  <script src="/js/cp-error-reporter.js?v=' + BUILD_VERSION + '"></script>';
    const afterReporter = src.replace(/<head\b([^>]*)>/i, function (m) {
      return m + reporterTag;
    });
    if (afterReporter !== src) { src = afterReporter; modified = true; }
  }

  // Step D: inject nav + footer into their placeholder slots
  if (buildNavHtml) {
    const afterNav = src.replace(
      /<div\s+id="site-nav"\s*><\/div>/g,
      `<div id="site-nav" data-server-injected="1">${buildNavHtml}</div>`
    );
    if (afterNav !== src) { src = afterNav; modified = true; }
  }
  if (buildFooterHtml) {
    const afterFooter = src.replace(
      /<div\s+id="site-footer"\s*><\/div>/g,
      `<div id="site-footer" data-server-injected="1">${buildFooterHtml}</div>`
    );
    if (afterFooter !== src) { src = afterFooter; modified = true; }
  }

  if (modified) fs.writeFileSync(file, src);
});
console.log('✅ HTML files processed: cache-bust, CSS preload fix, nonce + nav/footer injected (BUILD_VERSION: ' + BUILD_VERSION + ')');

// ── Build-time property snapshot for listings.html ───────────────────────────
// Fetches the first page of active listings at build time and embeds them as
// window.__INITIAL_LISTINGS__ so properties render on first paint with no
// loading spinner. The client fetches fresh data on any filter change or
// pagination — this snapshot only speeds up the cold initial page load.
await (async function injectInitialListings() {
  const listingsFile = 'listings.html';
  if (!fs.existsSync(listingsFile)) { console.warn('⚠  listings.html not found — skipping property pre-load'); return; }

  const https = require('https');
  const PER_PAGE = 24;
  const supabaseUrl = config.SUPABASE_URL.replace(/\/$/, '');
  // Project only the columns listings.html actually renders (cards + map markers).
  // Skipping description, search_vector, amenities, lease_terms, etc. cuts the
  // inline JSON snapshot from ~134 KB to ~12 KB so listings.html stays small.
  const cols = [
    'id','title','address','city','state','zip',
    'bedrooms','bathrooms','square_footage','monthly_rent',
    'property_type','parking','pets_allowed','available_date',
    'utilities_included','lat','lng','status'
  ].join(',');
  const apiPath = '/rest/v1/properties'
    + '?select=' + cols
    + ',landlords(verified)'
    + ',property_photos(url,display_order)'
    + '&status=eq.active'
    + '&order=created_at.desc'
    + '&limit=' + PER_PAGE
    + '&offset=0';

  const data = await new Promise(function(resolve) {
    const urlObj = new URL(supabaseUrl + apiPath);
    const req = https.request({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'GET',
      headers: {
        'apikey':        config.SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + config.SUPABASE_ANON_KEY,
        'Prefer':        'count=exact',
      },
      timeout: 12000,
    }, function(res) {
      let body = '';
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', function() {
        // Supabase returns 206 when Prefer: count=exact is used with a range
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          console.warn('⚠  Property pre-load: Supabase returned HTTP ' + res.statusCode + ' — skipping');
          resolve(null); return;
        }
        try {
          const rows = JSON.parse(body);
          if (!Array.isArray(rows)) { console.warn('⚠  Property pre-load: unexpected response shape'); resolve(null); return; }
          // Derive photo_urls from embedded property_photos, then drop the
          // raw embed (listings cards only need photo_urls + verified flag).
          rows.forEach(function(p) {
            var photos = Array.isArray(p.property_photos) ? p.property_photos.slice() : [];
            photos.sort(function(a, b) { return (a.display_order || 0) - (b.display_order || 0); });
            p.photo_urls = photos.map(function(x) { return x.url; }).filter(Boolean);
            delete p.property_photos;
          });
          let total = rows.length;
          const rangeHeader = res.headers['content-range'];
          if (rangeHeader) { const m = rangeHeader.match(/\/(\d+)/); if (m) total = parseInt(m[1], 10); }
          resolve({ rows: rows, total: total, page: 1, per_page: PER_PAGE, total_pages: Math.ceil(total / PER_PAGE) });
        } catch (e) { console.warn('⚠  Property pre-load: JSON parse error:', e.message); resolve(null); }
      });
    });
    req.on('error',   function(e) { console.warn('⚠  Property pre-load network error:', e.message); resolve(null); });
    req.on('timeout', function()  { req.destroy(); console.warn('⚠  Property pre-load timed out'); resolve(null); });
    req.end();
  });

  if (!data) return;

  let html = fs.readFileSync(listingsFile, 'utf8');
  // Remove any existing snapshot injected by a previous build
  html = html.replace(/<script[^>]*>window\.__INITIAL_LISTINGS__[\s\S]*?<\/script>\n?/g, '');
  const snippet = '<script nonce="' + nonce + '">window.__INITIAL_LISTINGS__=' + JSON.stringify(data) + ';window.__INITIAL_LISTINGS_TS__=' + Date.now() + ';</script>\n';
  html = html.replace('</head>', snippet + '</head>');
  fs.writeFileSync(listingsFile, html);
  console.log('✅ Property pre-load: ' + data.rows.length + ' listings embedded in listings.html (total: ' + data.total + ')');
})();

// Note: Content-Security-Policy is no longer set in _headers; it is set
// per-request by functions/_middleware.js so the nonce can rotate on every
// request. No build-time _headers rewrite is needed.
console.log('ℹ  CSP nonce: written to HTML as __CSP_NONCE__; per-request rotation handled by functions/_middleware.js');

})().catch(function(err) {
  console.error('Build script error:', err);
  process.exit(1);
});
