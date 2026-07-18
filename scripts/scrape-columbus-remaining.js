#!/usr/bin/env node
'use strict';
// Processes ONLY the 2 remaining Columbus properties

const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SB_KEY         = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IK_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY;
const LANDLORD_ID    = 'b8d3aea0-f466-49f2-ac07-2b2b40793cc9';
const SITE_URL       = (process.env.SITE_URL || 'https://choice-properties-site.pages.dev').replace(/\/$/, '');

function makeId() { return 'PROP-' + crypto.randomBytes(4).toString('hex').toUpperCase(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function zUrl(id)  { return `https://img.zumpercdn.com/${id}/1280x960`; }
function zSeq(start, count) { return Array.from({ length: count }, (_, i) => start + i).map(zUrl); }

async function downloadBuffer(urlStr) {
  return new Promise((resolve) => {
    const parsed = new URL(urlStr);
    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.zumper.com/' },
      timeout: 25000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(buf.length >= 2000 ? buf : null);
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function buildMultipart(boundary, fields, fileField, fileName, fileBuffer, mimeType) {
  const parts = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  const hdr = `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const ftr = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([Buffer.from(parts.join('')), Buffer.from(hdr), fileBuffer, Buffer.from(ftr)]);
}

async function uploadToImageKit(buffer, fileName, folder) {
  const boundary = '----Boundary' + crypto.randomBytes(6).toString('hex');
  const mimeType = 'image/jpeg';
  const body = buildMultipart(boundary, { fileName, folder, useUniqueFileName: 'false' },
    'file', fileName, buffer, mimeType);
  const authStr = Buffer.from(IK_PRIVATE_KEY + ':').toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'upload.imagekit.io', path: '/api/v1/files/upload', method: 'POST',
      headers: { 'Authorization': `Basic ${authStr}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      timeout: 60000,
    }, (res) => {
      let raw = ''; res.on('data', d => raw += d);
      res.on('end', () => {
        const parsed = JSON.parse(raw);
        if (res.statusCode === 200 || res.statusCode === 201) resolve(parsed);
        else reject(new Error(`IK ${res.statusCode}: ${raw.slice(0, 200)}`));
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
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation', 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000,
    }, (res) => {
      let raw = ''; res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(raw));
        else reject(new Error(`SB ${res.statusCode}: ${raw.slice(0,200)}`));
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
      headers: { 'User-Agent': 'ChoicePropertiesScraper/1.0' }, timeout: 12000,
    }, (res) => {
      let raw = ''; res.on('data', d => raw += d);
      res.on('end', () => {
        try { const a = JSON.parse(raw); resolve(a[0] ? { lat: parseFloat(a[0].lat), lng: parseFloat(a[0].lon) } : { lat: 39.9612, lng: -82.9988 }); }
        catch { resolve({ lat: 39.9612, lng: -82.9988 }); }
      });
      res.on('error', () => resolve({ lat: 39.9612, lng: -82.9988 }));
    });
    req.on('error', () => resolve({ lat: 39.9612, lng: -82.9988 }));
    req.on('timeout', () => { req.destroy(); resolve({ lat: 39.9612, lng: -82.9988 }); });
  });
}

const PROPERTIES = [
  {
    address: '864 Fairwood Ave', city: 'Columbus', state: 'OH', zip: '43205',
    type: 'house', beds: 3, baths: 1.0, sqft: 1176,
    publishedRent: 960,
    amenities: ['A/C', 'Central Heat', 'Private Yard', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    photos: zSeq(876364017, 29),   // 29 sequential photos
    description: `This spacious 3-bedroom, 1-bathroom home at 864 Fairwood Avenue offers 1,176 sq ft of generous living space in Columbus's Driving Park neighborhood. The home features a large living room, a well-equipped kitchen, and three comfortably sized bedrooms. The private yard and quiet residential street provide an ideal living environment. Driving Park is an established Columbus neighborhood convenient to Berliner Sports Park, Schiller Park, and the vibrant amenities of nearby German Village and Merion Village. Pets welcome. Household income must be 3 times the monthly rent.\n\nMonthly rent: $960. Security deposit: $960. Application Fee: $50. Contact Choice Properties.`,
    neighborhood: 'Driving Park',
  },
  {
    address: '2412 Century Dr', city: 'Columbus', state: 'OH', zip: '43211',
    type: 'house', beds: 3, baths: 1.0, sqft: 990,
    publishedRent: 950,
    amenities: ['A/C', 'Central Heat', 'Private Yard', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    photos: zSeq(890801408, 15),   // 15 sequential photos
    description: `This well-maintained 3-bedroom, 1-bathroom home at 2412 Century Drive offers 990 sq ft of comfortable living in Columbus, OH. The home features a bright living room, a functional kitchen, and three comfortably sized bedrooms. A private yard provides great outdoor space for entertaining or letting pets roam. Conveniently located with easy access to I-71, shopping centers, restaurants, and downtown Columbus. Pets welcome. Household income must be 3 times the monthly rent.\n\nMonthly rent: $950. Security deposit: $950. Application Fee: $50. Contact Choice Properties.`,
    neighborhood: 'Northeast Columbus',
  },
];

function propertyUrl(propId, beds, type) {
  const t = type === 'townhouse' ? 'townhouse' : 'house';
  return `${SITE_URL}/rent/oh/columbus/${beds}br-${t}-${propId.toLowerCase()}/`;
}

async function processProp(prop) {
  const propId = makeId();
  console.log(`\n▶  ${prop.address} | pub $${prop.publishedRent}`);
  console.log(`   ID: ${propId} | Photos: ${prop.photos.length}`);

  const coords = await geocode(prop.address, prop.city, prop.state, prop.zip);
  await sleep(1100);
  console.log(`   Coords: ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`);

  const uploadedPhotos = [];
  let displayOrder = 1;
  for (let i = 0; i < prop.photos.length; i++) {
    const buf = await downloadBuffer(prop.photos[i]);
    if (!buf) continue;
    try {
      const fileName = `${propId.toLowerCase()}-photo-${displayOrder}.jpg`;
      const ikRes = await uploadToImageKit(buf, fileName, `/properties/${propId.toLowerCase()}/`);
      uploadedPhotos.push({ url: ikRes.url, fileId: ikRes.fileId, order: displayOrder });
      process.stdout.write(`   ⬆️  ${displayOrder}/${prop.photos.length} (${Math.round(buf.length/1024)}KB)\r`);
      displayOrder++;
    } catch (e) { console.error(`\n   ✗ Upload ${i+1} failed: ${e.message}`); }
  }
  console.log(`\n   Uploaded ${uploadedPhotos.length} photos`);
  if (!uploadedPhotos.length) throw new Error('No photos uploaded');

  const propRow = {
    id: propId, landlord_id: LANDLORD_ID, status: 'active',
    title: `${prop.beds}BR/${prop.baths}BA ${prop.type === 'house' ? 'House' : 'Townhouse'} in Columbus – $${prop.publishedRent}/mo`,
    description: prop.description,
    address: prop.address, city: prop.city, state: prop.state, zip: prop.zip,
    county: 'Franklin', lat: coords.lat, lng: coords.lng,
    property_type: prop.type, bedrooms: prop.beds, bathrooms: prop.baths,
    total_bathrooms: Math.ceil(prop.baths), square_footage: prop.sqft || null,
    monthly_rent: prop.publishedRent, security_deposit: prop.publishedRent, application_fee: 50,
    available_date: new Date().toISOString().split('T')[0],
    amenities: prop.amenities, appliances: prop.appliances,
    pets_allowed: true, pet_types_allowed: ['Dogs', 'Cats'],
    utilities_included: [], lease_terms: ['12 months'], featured: false,
    neighborhood: prop.neighborhood,
  };

  await sbInsert('properties', propRow);
  console.log(`   ✓  Property inserted`);

  for (const p of uploadedPhotos) {
    await sbInsert('property_photos', {
      property_id: propId, url: p.url, file_id: p.fileId,
      display_order: p.order, watermark_status: 'clean', is_hero: p.order === 1,
    });
  }
  console.log(`   ✓  Photos inserted`);

  return { address: prop.address, propId, publishedRent: prop.publishedRent,
           url: propertyUrl(propId, prop.beds, prop.type), photosUploaded: uploadedPhotos.length };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Columbus OH — Remaining 2 Properties');
  console.log('═══════════════════════════════════════════════════');

  const results = [];
  for (const prop of PROPERTIES) {
    try { results.push(await processProp(prop)); }
    catch (e) { console.error(`\n❌ FAILED: ${prop.address} — ${e.message}`); }
    await sleep(300);
  }

  console.log('\n\n═══════════════════════════════════════════════════');
  results.forEach((r, i) => {
    console.log(`${i+1}. ${r.address}`);
    console.log(`   ${r.url}`);
    console.log(`   $${r.publishedRent}/mo | ${r.photosUploaded} photos | ${r.propId}\n`);
  });
  console.log(`✅ Done: ${results.length}/2`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
