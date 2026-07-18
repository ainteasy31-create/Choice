#!/usr/bin/env node
'use strict';

/**
 * Columbus, OH — Rental Property Scraper Pipeline
 * Uploads photos to ImageKit → inserts into Supabase → generates report
 */

const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// ─── ENV ─────────────────────────────────────────────────────────────────────
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SB_KEY         = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IK_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY;
const LANDLORD_ID    = 'b8d3aea0-f466-49f2-ac07-2b2b40793cc9';
const SITE_URL       = (process.env.SITE_URL || 'https://choice-properties-site.pages.dev').replace(/\/$/, '');

if (!SUPABASE_URL || !SB_KEY || !IK_PRIVATE_KEY) {
  console.error('Missing required env vars');
  process.exit(1);
}

// ─── UTILITIES ───────────────────────────────────────────────────────────────
function makeId() { return 'PROP-' + crypto.randomBytes(4).toString('hex').toUpperCase(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function zUrl(id)  { return `https://img.zumpercdn.com/${id}/1280x960`; }
function zSeq(start, count) { return Array.from({ length: count }, (_, i) => start + i).map(zUrl); }

async function downloadBuffer(urlStr, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const parsed = new URL(urlStr);
        const mod = parsed.protocol === 'https:' ? https : http;
        const req = mod.get({
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
            'Accept': 'image/webp,image/*,*/*',
            'Referer': 'https://www.zumper.com/',
          },
          timeout: 30000,
        }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            const loc = res.headers.location;
            res.resume();
            return downloadBuffer(loc, retries - attempt).then(resolve).catch(reject);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            // Reject very small responses (likely error pages)
            if (buf.length < 2000) return reject(new Error(`Too small: ${buf.length} bytes`));
            resolve(buf);
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Timeout')));
      });
    } catch (e) {
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      return null; // Return null on final failure (allows partial photo sets)
    }
  }
  return null;
}

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
  const mimeType = fileName.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  const body = buildMultipart(boundary, { fileName, folder, useUniqueFileName: 'false' },
    'file', fileName, buffer, mimeType);
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
          else resolve({ lat: 39.9612, lng: -82.9988 }); // Columbus center fallback
        } catch { resolve({ lat: 39.9612, lng: -82.9988 }); }
      });
      res.on('error', () => resolve({ lat: 39.9612, lng: -82.9988 }));
    });
    req.on('error', () => resolve({ lat: 39.9612, lng: -82.9988 }));
    req.on('timeout', () => { req.destroy(); resolve({ lat: 39.9612, lng: -82.9988 }); });
  });
}

// ─── PRICE ADJUSTMENT ────────────────────────────────────────────────────────
const usedRents = new Set();

function adjustedRent(original) {
  // Apply table reduction but hard-cap at $1,000
  let pub;
  if (original <= 1000)      pub = original;
  else if (original <= 1050) pub = original - 50;
  else if (original <= 1100) pub = original - 75;
  else if (original <= 1150) pub = original - 100;
  else                        pub = original - 150;
  pub = Math.min(pub, 1000);
  // Enforce uniqueness with small downward steps
  while (usedRents.has(pub)) pub -= 5;
  usedRents.add(pub);
  return pub;
}

// ─── PROPERTY DATASET ────────────────────────────────────────────────────────
// Photo sources: most are sequential Zumper IDs; non-sequential ones try a range
const PROPERTIES = [
  {
    address: '1567 Briarwood Ave',
    city: 'Columbus', state: 'OH', zip: '43211',
    type: 'townhouse', beds: 2, baths: 1.0, sqft: null,
    originalRent: 1000,
    amenities: ['A/C', 'Central Heat', 'Private Entry', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    photos: zSeq(910172242, 10),
    rawDescription: `Discover comfortable living at 1567 Briarwood Avenue—a well-maintained 2-bedroom, 1-bathroom townhome in Columbus, OH. This home features a practical, open layout with a cozy living area, a functional kitchen, and two comfortable bedrooms served by a full bathroom. The private entry and individual design offer added peace and privacy. Conveniently located in North Columbus with access to I-71, shopping, restaurants, and parks. Pets welcome. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties for more information.`,
    neighborhood: 'North Linden',
  },
  {
    address: '1577 Briarwood Ave',
    city: 'Columbus', state: 'OH', zip: '43211',
    type: 'townhouse', beds: 2, baths: 1.0, sqft: null,
    originalRent: 1000,
    amenities: ['A/C', 'Central Heat', 'Private Entry', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    photos: zSeq(910171951, 10),
    rawDescription: `Welcome to 1577 Briarwood Avenue—a bright and comfortable 2-bedroom, 1-bathroom townhome in Columbus, OH. The open floor plan features a welcoming living area, a practical kitchen, and two well-sized bedrooms with ample closet space. The private entry and quiet neighborhood setting provide a peaceful everyday environment. Close to I-71, Columbus shopping centers, schools, and dining. Pets welcome. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties for availability.`,
    neighborhood: 'North Linden',
  },
  {
    address: '59 N Waverly St',
    city: 'Columbus', state: 'OH', zip: '43213',
    type: 'townhouse', beds: 2, baths: 1.0, sqft: 1000,
    originalRent: 1000,
    amenities: ['A/C', 'Central Heat', 'Private Entry', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Dishwasher', 'Washer/Dryer Hookups'],
    photos: zSeq(900946031, 14),
    rawDescription: `Welcome to this updated 2-bedroom, 1-bathroom townhome at 59 N Waverly Street in Columbus's Broadleigh neighborhood. Spanning 1,000 sq ft, this home features a comfortable living area, a well-appointed kitchen with dishwasher, and two bedrooms served by a full bathroom. The private entry provides a sense of independence and privacy. Located in east Columbus near Hamilton Rd, this home offers easy access to I-270, Columbus shopping centers, and quality dining options. Pets welcome. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties.`,
    neighborhood: 'Broadleigh',
  },
  {
    address: '3409 Bexvie Ave',
    city: 'Columbus', state: 'OH', zip: '43227',
    type: 'townhouse', beds: 2, baths: 1.5, sqft: 880,
    originalRent: 1000,
    amenities: ['A/C', 'Central Heat', 'Community Parking', 'Patio'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    photos: zSeq(911544844, 16),
    rawDescription: `Welcome to Bexvie Village Townhomes at 3409 Bexvie Avenue in Columbus, OH. This 2-bedroom, 2-bathroom townhome offers 880 sq ft of well-designed living space in a friendly community setting. The multi-level floor plan includes a comfortable living and dining area, a practical kitchen, and a convenient half bath on the main floor—with two bedrooms and a full bathroom upstairs. The private entrance and quiet community create an ideal home environment. Conveniently located near I-270, Eastland Mall, and Columbus amenities. Pets welcome. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties.`,
    neighborhood: 'Eastland',
  },
  {
    address: '3105 Clairpoint Ct',
    city: 'Columbus', state: 'OH', zip: '43227',
    type: 'townhouse', beds: 2, baths: 1.0, sqft: 850,
    originalRent: 1100,
    amenities: ['A/C', 'Central Heat', 'Private Entry', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    photos: zSeq(890729235, 10),
    rawDescription: `Welcome to Crestwood Village Townhomes at 3105 Clairpoint Court in Columbus, OH. This comfortable 2-bedroom, 1-bathroom townhome offers 850 sq ft of well-designed living space. The open floor plan features a bright living area, a functional kitchen, and two comfortable bedrooms served by a full bathroom. In-unit storage and a private entrance add to the appeal of this well-maintained home. Located in the southeast Columbus area with easy access to Eastland Mall, restaurants, and I-270. Pets welcome. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties.`,
    neighborhood: 'Eastland',
  },
  {
    address: '2417 Dawnlight Ave',
    city: 'Columbus', state: 'OH', zip: '43211',
    type: 'house', beds: 2, baths: 1.0, sqft: 800,
    originalRent: 1195,
    amenities: ['A/C', 'Central Heat', 'Private Yard', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    photos: zSeq(911000545, 15),
    rawDescription: `This charming 2-bedroom, 1-bathroom home at 2417 Dawnlight Avenue offers 800 sq ft of comfortable living in Columbus, OH. The home features a cozy living room, a well-equipped kitchen, and two bedrooms served by a full bathroom. The private yard provides great outdoor space for relaxing or letting pets roam. Located in a convenient Columbus neighborhood with easy access to I-71, shopping, restaurants, and parks. Pets welcome. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties.`,
    neighborhood: 'North Linden',
  },
  {
    address: '3417 A Ave #3417B',
    city: 'Columbus', state: 'OH', zip: '43207',
    type: 'townhouse', beds: 2, baths: 1.5, sqft: 900,
    originalRent: 1200,
    amenities: ['A/C', 'Central Heat', 'Private Entry', 'Patio', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    // Non-sequential IDs — try full range 890616469..890616490
    photos: Array.from({ length: 22 }, (_, i) => zUrl(890616469 + i)),
    rawDescription: `This 2-bedroom, 2-bathroom townhome at 3417 A Avenue, Unit 3417B offers 900 sq ft of thoughtfully designed living space in south Columbus. The multi-level layout features a convenient half bath on the main floor and a full bath upstairs, delivering practical functionality for everyday life. The comfortable living area, functional kitchen, and two well-sized bedrooms create a welcoming home. Located in the Alum Creek area with easy access to I-270, Eastland Mall, shopping, and dining options. Pets welcome. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties.`,
    neighborhood: 'South Columbus',
  },
  {
    address: '2942 Atwood Ter',
    city: 'Columbus', state: 'OH', zip: '43224',
    type: 'house', beds: 2, baths: 1.0, sqft: 962,
    originalRent: 1200,
    amenities: ['A/C', 'Central Heat', 'Private Yard', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    // Non-sequential clusters — try two ID ranges
    photos: [
      ...Array.from({ length: 30 }, (_, i) => zUrl(895722841 + i)),
      ...Array.from({ length: 26 }, (_, i) => zUrl(910342016 + i)),
    ],
    rawDescription: `This comfortable 2-bedroom, 1-bathroom home at 2942 Atwood Terrace offers 962 sq ft of living space in Columbus's North Linden neighborhood. The practical layout includes a bright living area, a functional kitchen, and two bedrooms served by a full bathroom. The private yard is ideal for outdoor relaxation or pets. Conveniently situated near I-71, with easy access to Columbus's amenities, restaurants, and parks. Pets welcome. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties.`,
    neighborhood: 'North Linden',
  },
  {
    address: '864 Fairwood Ave',
    city: 'Columbus', state: 'OH', zip: '43205',
    type: 'house', beds: 3, baths: 1.0, sqft: 1176,
    originalRent: 1200,
    amenities: ['A/C', 'Central Heat', 'Private Yard', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    photos: zSeq(876364017, 29),
    rawDescription: `This spacious 3-bedroom, 1-bathroom home at 864 Fairwood Avenue offers 1,176 sq ft of generous living space in Columbus's Driving Park neighborhood. The home features a large living room, a well-equipped kitchen, and three comfortably sized bedrooms. The private yard and quiet residential street provide an ideal living environment. Driving Park is an established Columbus neighborhood convenient to Berliner Sports Park, Schiller Park, and the vibrant amenities of nearby German Village and Merion Village. Pets welcome. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties.`,
    neighborhood: 'Driving Park',
  },
  {
    address: '2412 Century Dr',
    city: 'Columbus', state: 'OH', zip: '43211',
    type: 'house', beds: 3, baths: 1.0, sqft: 990,
    originalRent: 1195,
    amenities: ['A/C', 'Central Heat', 'Private Yard', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    photos: zSeq(890801408, 15),
    rawDescription: `This well-maintained 3-bedroom, 1-bathroom home at 2412 Century Drive offers 990 sq ft of comfortable living in Columbus, OH. The home features a bright living room, a functional kitchen, and three comfortably sized bedrooms. A private yard provides great outdoor space for entertaining or letting pets roam. Conveniently located with easy access to I-71, shopping centers, restaurants, and downtown Columbus. Pets welcome. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties.`,
    neighborhood: 'Northeast Columbus',
  },
];

// ─── FINALIZE DESCRIPTION ────────────────────────────────────────────────────
function finalizeDescription(raw, publishedRent) {
  const deposit = publishedRent;
  let out = raw
    .replace(/\$1[,\d]+ ?(\/month|\/mo|per month)?/gi, `$${publishedRent}/month`)
    .replace(/Monthly rent:.*?\./gi, `Monthly rent: $${publishedRent}.`)
    .replace(/Security deposit:.*?\./gi, `Security deposit: $${deposit}.`);
  if (!out.includes('Monthly rent:')) {
    out += `\n\nMonthly rent: $${publishedRent}. Security deposit: $${deposit}. Application Fee: $50.`;
  } else if (!out.includes('Security deposit:')) {
    out += ` Security deposit: $${deposit}.`;
  }
  return out;
}

function makeTitle(prop, rent) {
  const t = prop.type === 'townhouse' ? 'Townhouse' : 'House';
  const bathStr = prop.baths % 1 === 0 ? `${prop.baths}` : `${prop.baths}`;
  return `${prop.beds}BR/${bathStr}BA ${t} in Columbus – $${rent}/mo`;
}

function propertyUrl(propId, beds, type) {
  const t = type === 'townhouse' ? 'townhouse' : 'house';
  return `${SITE_URL}/rent/oh/columbus/${beds}br-${t}-${propId.toLowerCase()}/`;
}

// ─── MAIN PIPELINE ────────────────────────────────────────────────────────────
async function processProp(prop) {
  const propId = makeId();
  const publishedRent = adjustedRent(prop.originalRent);
  const deposit = publishedRent;

  console.log(`\n▶  ${prop.address} | orig $${prop.originalRent} → pub $${publishedRent}`);
  console.log(`   ID: ${propId} | Photos to try: ${prop.photos.length}`);

  // 1. Geocode
  const coords = await geocode(prop.address, prop.city, prop.state, prop.zip);
  await sleep(1100);
  console.log(`   Coords: ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`);

  // 2. Download + upload photos
  const uploadedPhotos = [];
  let displayOrder = 1;

  for (let i = 0; i < prop.photos.length; i++) {
    const srcUrl = prop.photos[i];
    const ext = srcUrl.includes('.webp') ? 'webp' : 'jpg';
    const fileName = `${propId.toLowerCase()}-photo-${displayOrder}.${ext}`;
    const buf = await downloadBuffer(srcUrl);
    if (!buf) {
      // Silent skip for probe-range attempts
      continue;
    }
    try {
      console.log(`   ⬆️  Uploading photo ${displayOrder} (${Math.round(buf.length / 1024)} KB)...`);
      const ikRes = await uploadToImageKit(buf, fileName, `/properties/${propId.toLowerCase()}/`);
      uploadedPhotos.push({ url: ikRes.url, fileId: ikRes.fileId, order: displayOrder });
      console.log(`   ✓  ${ikRes.url}`);
      displayOrder++;
      await sleep(200);
    } catch (e) {
      console.error(`   ✗  Upload failed: ${e.message}`);
    }
  }

  if (uploadedPhotos.length === 0) {
    throw new Error(`No photos uploaded for ${prop.address}`);
  }
  console.log(`   Uploaded ${uploadedPhotos.length} photos`);

  // 3. Insert property row
  const description = finalizeDescription(prop.rawDescription, publishedRent);
  const title = makeTitle(prop, publishedRent);

  const propRow = {
    id: propId,
    landlord_id: LANDLORD_ID,
    status: 'active',
    title,
    description,
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
    monthly_rent: publishedRent,
    security_deposit: deposit,
    application_fee: 50,
    available_date: new Date().toISOString().split('T')[0],
    amenities: prop.amenities,
    appliances: prop.appliances,
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

  // 4. Insert photo rows
  console.log(`   💾 Inserting ${uploadedPhotos.length} photos...`);
  for (const photo of uploadedPhotos) {
    await sbInsert('property_photos', {
      property_id: propId,
      url: photo.url,
      file_id: photo.fileId,
      display_order: photo.order,
      watermark_status: 'clean',
      is_hero: photo.order === 1,
    });
    await sleep(80);
  }
  console.log(`   ✓  Photos inserted`);

  return {
    address: `${prop.address}, ${prop.city}, ${prop.state} ${prop.zip}`,
    propId,
    publishedRent,
    url: propertyUrl(propId, prop.beds, prop.type),
    photosUploaded: uploadedPhotos.length,
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Choice Properties — Columbus OH Scraper Pipeline');
  console.log(`  ${PROPERTIES.length} properties to process`);
  console.log('═══════════════════════════════════════════════════════════');

  const results = [];
  const failures = [];

  for (const prop of PROPERTIES) {
    try {
      const result = await processProp(prop);
      results.push(result);
    } catch (e) {
      console.error(`\n❌ FAILED: ${prop.address} — ${e.message}`);
      failures.push({ address: prop.address, error: e.message });
    }
    await sleep(500);
  }

  console.log('\n\n═══════════════════════════════════════════════════════════');
  console.log('  POST-SCRAPING REPORT — Columbus, OH');
  console.log('═══════════════════════════════════════════════════════════\n');

  results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.address}`);
    console.log(`   ${r.url}`);
    console.log(`   Rent: $${r.publishedRent}/mo | Photos: ${r.photosUploaded} | ID: ${r.propId}\n`);
  });

  if (failures.length > 0) {
    console.log('\nFailed:');
    failures.forEach(f => console.log(`  ✗ ${f.address}: ${f.error}`));
  }

  console.log(`\n✅ Successfully published: ${results.length}/${PROPERTIES.length}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
