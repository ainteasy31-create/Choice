#!/usr/bin/env node
'use strict';

/**
 * Import Zillow screenshot listings → ImageKit + Supabase
 * Reads local image files, uploads to ImageKit, inserts properties as active.
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ─── ENV ─────────────────────────────────────────────────────────────────────
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SB_KEY         = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IK_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY;
const LANDLORD_ID    = 'b8d3aea0-f466-49f2-ac07-2b2b40793cc9';
const SITE_URL       = (process.env.SITE_URL || 'https://choice-properties-site.pages.dev').replace(/\/$/, '');
const ASSETS_DIR     = path.join(__dirname, '..', 'attached_assets');

if (!SUPABASE_URL || !SB_KEY || !IK_PRIVATE_KEY) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IMAGEKIT_PRIVATE_KEY');
  process.exit(1);
}

// ─── PROPERTY DEFINITIONS (extracted from Zillow screenshots) ────────────────
// Prices set to $1,000–$1,100 range as requested.
const PROPERTIES = [
  {
    address: '2299 Hamilton Ave',
    city: 'Columbus', state: 'OH', zip: '43211',
    type: 'house', beds: 2, baths: 1.0, sqft: 616,
    rent: 1000,
    neighborhood: 'North Linden',
    imageFile: 'IMG_5327_1785576900796.png',
    description: `This charming 2-bedroom, 1-bathroom home at 2299 Hamilton Avenue offers 616 sq ft of comfortable living in Columbus, OH. The home features a welcoming covered front porch with decorative railing, a bright living area, a functional kitchen, and two well-sized bedrooms. The fenced front yard adds privacy and curb appeal. Located in the North Linden neighborhood with easy access to I-71, shopping, restaurants, and parks.\n\nPets welcome. Household income must be 3× the monthly rent. Application Fee: $50.\n\nMonthly rent: $1,000. Security deposit: $1,000. Application Fee: $50.`,
  },
  {
    address: '3091 E 13th Ave',
    city: 'Columbus', state: 'OH', zip: '43219',
    type: 'house', beds: 2, baths: 1.0, sqft: 672,
    rent: 1010,
    neighborhood: 'East Columbus',
    imageFile: 'IMG_5325_1785576900797.png',
    description: `This solid 2-bedroom, 1-bathroom home at 3091 E 13th Avenue offers 672 sq ft of practical living space in Columbus, OH. The home features a private front entry with covered landing, a bright living area, a functional kitchen, and two comfortable bedrooms. The quiet residential street setting provides a peaceful everyday environment. Conveniently located with easy access to I-670 and downtown Columbus amenities.\n\nPets welcome. Household income must be 3× the monthly rent. Application Fee: $50.\n\nMonthly rent: $1,010. Security deposit: $1,010. Application Fee: $50.`,
  },
  {
    address: '2691 Homecroft Dr',
    city: 'Columbus', state: 'OH', zip: '43211',
    type: 'house', beds: 2, baths: 1.0, sqft: 672,
    rent: 1025,
    neighborhood: 'North Linden',
    imageFile: 'IMG_5330_1785576900798.png',
    description: `This cozy 2-bedroom, 1-bathroom home at 2691 Homecroft Drive offers 672 sq ft of comfortable living in Columbus, OH. The well-maintained ranch-style home features a spacious front yard with a long driveway, a bright living area, a functional kitchen, and two comfortable bedrooms. A detached garage provides added storage. Located in the North Linden neighborhood with easy access to I-71 and local Columbus amenities.\n\nPets welcome. Household income must be 3× the monthly rent. Application Fee: $50.\n\nMonthly rent: $1,025. Security deposit: $1,025. Application Fee: $50.`,
  },
  {
    address: '2766 Hiawatha St',
    city: 'Columbus', state: 'OH', zip: '43211',
    type: 'house', beds: 2, baths: 2.0, sqft: 672,
    rent: 1050,
    neighborhood: 'North Linden',
    imageFile: 'IMG_5324_1785576900791.jpeg',
    description: `This updated 2-bedroom, 2-bathroom home at 2766 Hiawatha Street offers 672 sq ft of well-designed living space in Columbus, OH. The home features a fresh exterior, a bright living area, a functional kitchen, and two comfortable bedrooms — each served by its own full bathroom, a rare find at this price point. The private front deck and landscaped surroundings create a welcoming entrance. Located in the North Linden neighborhood with easy access to I-71, shopping, and dining.\n\nPets welcome. Household income must be 3× the monthly rent. Application Fee: $50.\n\nMonthly rent: $1,050. Security deposit: $1,050. Application Fee: $50.`,
  },
  {
    address: '411 S Yale Ave',
    city: 'Columbus', state: 'OH', zip: '43223',
    type: 'house', beds: 2, baths: 1.0, sqft: 784,
    rent: 1060,
    neighborhood: 'Southwest Columbus',
    imageFile: 'IMG_5329_1785576900798.png',
    description: `This charming 2-bedroom, 1-bathroom home at 411 S Yale Avenue offers 784 sq ft of comfortable living in Columbus, OH. The two-story home features a welcoming covered front porch with red-accented trim, a bright living area, a functional kitchen, and two well-sized bedrooms. The fenced yard with mature trees provides great outdoor space. Located in Southwest Columbus with convenient access to Broad Street amenities, I-270, and downtown Columbus.\n\nPets welcome. Household income must be 3× the monthly rent. Application Fee: $50.\n\nMonthly rent: $1,060. Security deposit: $1,060. Application Fee: $50.`,
  },
  {
    address: '117 Sunnyside Ln',
    city: 'Columbus', state: 'OH', zip: '43214',
    type: 'house', beds: 2, baths: 1.0, sqft: 844,
    rent: 1075,
    neighborhood: 'Clintonville',
    imageFile: 'IMG_5328_1785576900797.png',
    description: `This spacious 2-bedroom, 1-bathroom home at 117 Sunnyside Lane offers 844 sq ft of comfortable living in Columbus's desirable Clintonville neighborhood. The home features bright, airy rooms with large windows, a functional open layout, and two comfortable bedrooms. The grassy yard with mature landscaping provides a peaceful outdoor retreat. Located near Clintonville's vibrant dining scene, parks, and easy access to I-71 and Rt-315.\n\nPets welcome. Household income must be 3× the monthly rent. Application Fee: $50.\n\nMonthly rent: $1,075. Security deposit: $1,075. Application Fee: $50.`,
  },
  {
    address: '1347 Gault St',
    city: 'Columbus', state: 'OH', zip: '43205',
    type: 'house', beds: 2, baths: 1.0, sqft: 1150,
    rent: 1100,
    neighborhood: 'Near East Side',
    imageFile: 'IMG_5326_1785576900797.png',
    description: `This spacious 2-bedroom, 1-bathroom home at 1347 Gault Street offers 1,150 sq ft of generous living in Columbus's Near East Side. The classic two-story home features a large covered front porch, a bright living and dining area, a well-appointed kitchen, and two comfortable bedrooms with ample space. The fenced yard with a mature tree provides great outdoor living. Located near Franklin Park, King-Lincoln District, and easy access to I-70 and downtown Columbus.\n\nPets welcome. Household income must be 3× the monthly rent. Application Fee: $50.\n\nMonthly rent: $1,100. Security deposit: $1,100. Application Fee: $50.`,
  },
];

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function makeId() { return 'PROP-' + crypto.randomBytes(4).toString('hex').toUpperCase(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildMultipart(boundary, fields, fileField, fileName, fileBuffer, mimeType) {
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const fileFooter = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([Buffer.from(parts.join('')), Buffer.from(fileHeader), fileBuffer, Buffer.from(fileFooter)]);
}

async function uploadToImageKit(buffer, fileName, folder) {
  const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');
  const ext = path.extname(fileName).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const body = buildMultipart(
    boundary,
    { fileName, folder, useUniqueFileName: 'false' },
    'file', fileName, buffer, mimeType
  );
  const authStr = Buffer.from(IK_PRIVATE_KEY + ':').toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'upload.imagekit.io',
      path: '/api/v1/files/upload',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authStr}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 60000,
    }, (res) => {
      let raw = ''; res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode === 200 || res.statusCode === 201) resolve(parsed);
          else reject(new Error(`ImageKit ${res.statusCode}: ${raw}`));
        } catch (e) { reject(new Error('IK parse error: ' + raw)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('IK timeout')));
    req.write(body); req.end();
  });
}

async function sbInsert(table, data) {
  const body = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const u = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
    const req = https.request({
      hostname: u.hostname, path: u.pathname,
      method: 'POST',
      headers: {
        'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let raw = ''; res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
        } else reject(new Error(`Supabase ${res.statusCode}: ${raw}`));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('SB timeout')));
    req.write(body); req.end();
  });
}

async function geocode(address, city, state, zip) {
  const q = encodeURIComponent(`${address}, ${city}, ${state} ${zip}`);
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'nominatim.openstreetmap.org',
      path: `/search?format=json&q=${q}&countrycodes=us&limit=1`,
      headers: { 'User-Agent': 'ChoicePropertiesScraper/1.0' },
      timeout: 15000,
    }, (res) => {
      let raw = ''; res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const arr = JSON.parse(raw);
          if (arr.length > 0) resolve({ lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) });
          else resolve({ lat: 39.9612, lng: -82.9988 });
        } catch { resolve({ lat: 39.9612, lng: -82.9988 }); }
      });
      res.on('error', () => resolve({ lat: 39.9612, lng: -82.9988 }));
    });
    req.on('error', () => resolve({ lat: 39.9612, lng: -82.9988 }));
    req.on('timeout', () => { req.destroy(); resolve({ lat: 39.9612, lng: -82.9988 }); });
  });
}

function propertyUrl(propId, beds, type) {
  const t = type === 'townhouse' ? 'townhouse' : 'house';
  return `${SITE_URL}/rent/oh/columbus/${beds}br-${t}-${propId.toLowerCase()}/`;
}

// ─── MAIN PIPELINE ────────────────────────────────────────────────────────────
async function processProp(prop) {
  const propId = makeId();
  console.log(`\n▶  ${prop.address} | $${prop.rent}/mo`);
  console.log(`   ID: ${propId}`);

  // 1. Geocode
  const coords = await geocode(prop.address, prop.city, prop.state, prop.zip);
  await sleep(1100); // Nominatim rate limit: 1 req/sec
  console.log(`   Coords: ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`);

  // 2. Upload the screenshot image to ImageKit
  const imgPath = path.join(ASSETS_DIR, prop.imageFile);
  if (!fs.existsSync(imgPath)) throw new Error(`Image file not found: ${imgPath}`);

  const ext = path.extname(prop.imageFile).toLowerCase();
  const imgBuffer = fs.readFileSync(imgPath);
  const ikFileName = `${propId.toLowerCase()}-photo-1${ext}`;
  const ikFolder = `/properties/${propId.toLowerCase()}/`;

  console.log(`   ⬆️  Uploading ${prop.imageFile} (${Math.round(imgBuffer.length / 1024)} KB)...`);
  const ikRes = await uploadToImageKit(imgBuffer, ikFileName, ikFolder);
  console.log(`   ✓  ${ikRes.url}`);

  // 3. Insert property row
  const propRow = {
    id: propId,
    landlord_id: LANDLORD_ID,
    status: 'active',
    title: `${prop.beds}BR/${prop.baths % 1 === 0 ? prop.baths : prop.baths}BA House in Columbus – $${prop.rent}/mo`,
    description: prop.description,
    address: prop.address,
    city: prop.city,
    state: prop.state,
    zip: prop.zip,
    county: 'Franklin',
    lat: coords.lat,
    lng: coords.lng,
    property_type: prop.type,
    bedrooms: prop.beds,
    bathrooms: prop.baths,
    total_bathrooms: Math.ceil(prop.baths),
    square_footage: prop.sqft || null,
    monthly_rent: prop.rent,
    security_deposit: prop.rent,
    application_fee: 50,
    available_date: new Date().toISOString().split('T')[0],
    amenities: ['A/C', 'Central Heat', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    pets_allowed: true,
    pet_types_allowed: ['Dogs', 'Cats'],
    utilities_included: [],
    lease_terms: ['12 months'],
    featured: false,
    neighborhood: prop.neighborhood,
  };

  console.log(`   💾 Inserting property...`);
  await sbInsert('properties', propRow);
  console.log(`   ✓  Property inserted`);

  // 4. Insert photo row
  console.log(`   💾 Inserting photo record...`);
  await sbInsert('property_photos', {
    property_id: propId,
    url: ikRes.url,
    file_id: ikRes.fileId,
    display_order: 1,
    watermark_status: 'pending',
    is_hero: true,
  });
  console.log(`   ✓  Photo inserted`);

  return {
    address: `${prop.address}, ${prop.city}, ${prop.state} ${prop.zip}`,
    propId,
    rent: prop.rent,
    url: propertyUrl(propId, prop.beds, prop.type),
    ikUrl: ikRes.url,
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Choice Properties — Zillow Screenshot Import Pipeline');
  console.log(`  ${PROPERTIES.length} properties | Prices: $1,000–$1,100`);
  console.log('═══════════════════════════════════════════════════════════');

  const results  = [];
  const failures = [];

  for (const prop of PROPERTIES) {
    try {
      const r = await processProp(prop);
      results.push(r);
    } catch (e) {
      console.error(`\n❌ FAILED: ${prop.address} — ${e.message}`);
      failures.push({ address: prop.address, error: e.message });
    }
    await sleep(300);
  }

  console.log('\n\n═══════════════════════════════════════════════════════════');
  console.log('  IMPORT REPORT');
  console.log('═══════════════════════════════════════════════════════════\n');

  results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.address}`);
    console.log(`   Rent: $${r.rent}/mo | ID: ${r.propId}`);
    console.log(`   Photo: ${r.ikUrl}`);
    console.log(`   URL: ${r.url}\n`);
  });

  if (failures.length > 0) {
    console.log('Failed:');
    failures.forEach(f => console.log(`  ✗ ${f.address}: ${f.error}`));
  }

  console.log(`\n✅ Successfully published: ${results.length}/${PROPERTIES.length}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
