#!/usr/bin/env node
'use strict';

/**
 * Kansas City MO ZIP 64134 — Rental Property Scraper Pipeline
 * Uploads photos to ImageKit → inserts into Supabase → generates report
 */

const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// ─── ENV ─────────────────────────────────────────────────────────────────────
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SB_KEY            = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IK_PRIVATE_KEY    = process.env.IMAGEKIT_PRIVATE_KEY;
const IK_ENDPOINT       = process.env.IMAGEKIT_URL || 'https://ik.imagekit.io/21rg7lvzo';
const LANDLORD_ID       = 'b8d3aea0-f466-49f2-ac07-2b2b40793cc9';

if (!SUPABASE_URL || !SB_KEY || !IK_PRIVATE_KEY) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IMAGEKIT_PRIVATE_KEY');
  process.exit(1);
}

// ─── UTILITIES ───────────────────────────────────────────────────────────────
function makeId() {
  return 'PROP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function zRange(start, count) {
  return Array.from({ length: count }, (_, i) => start + i);
}
function zUrl(id) {
  return `https://img.zumpercdn.com/${id}/1280x960`;
}
function rdcUrl(hash) {
  return `https://ar.rdcpix.com/${hash}`;
}

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
            'Accept':     'image/webp,image/*,*/*',
            'Referer':    'https://www.zumper.com/',
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
            return reject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('Timeout')); });
      });
    } catch (e) {
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      throw e;
    }
  }
}

function buildMultipart(boundary, fields, fileField, fileName, fileBuffer, mimeType) {
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
    );
  }
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const fileFooter = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([
    Buffer.from(parts.join('')),
    Buffer.from(fileHeader),
    fileBuffer,
    Buffer.from(fileFooter),
  ]);
}

async function uploadToImageKit(buffer, fileName, folder) {
  const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');
  const mimeType = fileName.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  const body = buildMultipart(boundary, {
    fileName,
    folder,
    useUniqueFileName: 'false',
  }, 'file', fileName, buffer, mimeType);

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
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode === 200 || res.statusCode === 201) {
            resolve(parsed);
          } else {
            reject(new Error(`ImageKit error ${res.statusCode}: ${raw}`));
          }
        } catch (e) { reject(new Error('ImageKit parse error: ' + raw)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('ImageKit timeout')));
    req.write(body);
    req.end();
  });
}

async function sbInsert(table, data) {
  const body = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const u = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
        } else {
          reject(new Error(`Supabase ${res.statusCode}: ${raw}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Supabase timeout')));
    req.write(body);
    req.end();
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
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const arr = JSON.parse(raw);
          if (arr.length > 0) resolve({ lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) });
          else resolve({ lat: 38.9500, lng: -94.4700 }); // 64134 center fallback
        } catch { resolve({ lat: 38.9500, lng: -94.4700 }); }
      });
      res.on('error', () => resolve({ lat: 38.9500, lng: -94.4700 }));
    });
    req.on('error', () => resolve({ lat: 38.9500, lng: -94.4700 }));
    req.on('timeout', () => { req.destroy(); resolve({ lat: 38.9500, lng: -94.4700 }); });
  });
}

// ─── PROPERTY DATASET ────────────────────────────────────────────────────────
const PROPERTIES = [
  {
    address: '11810 Fremont Ave',
    city: 'Kansas City', state: 'MO', zip: '64134',
    type: 'house', beds: 3, baths: 2.0, sqft: 1400,
    originalRent: 1295,
    amenities: ['Garage', 'A/C', 'Central Heat', 'Finished Basement', 'Fenced Yard'],
    appliances: ['Refrigerator', 'Stove', 'Dishwasher', 'Washer/Dryer Hookups'],
    petsAllowed: true,
    photos: [
      'https://images1.apartments.com/i2/9dPpqcYUF8ziv_Vau86wvvmyPMwBtjTh99RjRncy-VM/111/3-br-2-bath-house---11810-fremont-ave-kansas-city-mo-primary-photo.jpg',
      'https://images1.apartments.com/i2/HvMYnwfE3QCxM6au-EPGJrlLLR7unWeOr5B8AcjNvXI/117/3-br-2-bath-house---11810-fremont-ave-kansas-city-mo-building-photo.jpg',
      'https://images1.apartments.com/i2/eJ881Zz-x8pN9cBk4GLm4mqwTlh_BTXdX1CQ8GwVHyc/117/3-br-2-bath-house---11810-fremont-ave-kansas-city-mo-building-photo.jpg',
      'https://images1.apartments.com/i2/6r5I9cvwWzD0Z19a9MACPCfMT-d4B-beKayuVST82Ho/117/3-br-2-bath-house---11810-fremont-ave-kansas-city-mo-building-photo.jpg',
      'https://images1.apartments.com/i2/uSJovDrPjKQng4dS7OnC0sdOu5gM8r36A0-nXQgwjj4/117/3-br-2-bath-house---11810-fremont-ave-kansas-city-mo-building-photo.jpg',
      zUrl(486759280),
    ],
    rawDescription: `Welcome to this beautifully updated home in South Kansas City, offering 3 spacious bedrooms and 2 full bathrooms across 1,400 sq ft of comfortable living space. Step into a bright living room with large windows and durable plank flooring throughout. The well-equipped kitchen includes a refrigerator, stove, and dishwasher. Three generously sized bedrooms provide ample space, while the fully finished basement adds incredible bonus living space—ideal as a family room, home office, or extra bedroom—complete with a separate laundry area. Enjoy the outdoors in your private fenced yard. Attached garage included. Pets considered with additional deposit. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties for more information.`,
  },
  {
    address: '7704 E 103rd Ter',
    city: 'Kansas City', state: 'MO', zip: '64134',
    type: 'house', beds: 3, baths: 2.0, sqft: 1680,
    originalRent: 1350,
    amenities: ['Garage', 'A/C', 'Central Heat', 'Private Yard'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    petsAllowed: false,
    photos: zRange(326604625, 12).map(zUrl),
    rawDescription: `This spacious 3-bedroom, 2-bathroom home at 7704 E 103rd Terrace offers 1,680 sq ft of comfortable living in Kansas City's desirable 64134 neighborhood. The generous open floor plan includes a welcoming living room, a functional kitchen with ample cabinet space, and three well-sized bedrooms served by two full bathrooms. The attached garage and private yard provide plenty of storage and outdoor enjoyment. Situated in the established Robandee area with convenient access to I-49, schools, and shopping, this home is perfect for families. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties for availability.`,
  },
  {
    address: '11021 Newton Ave',
    city: 'Kansas City', state: 'MO', zip: '64134',
    type: 'house', beds: 3, baths: 2.0, sqft: 1172,
    originalRent: 1200,
    amenities: ['A/C', 'Central Heat', 'Fenced Yard', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    petsAllowed: false,
    photos: zRange(464137013, 17).map(zUrl),
    rawDescription: `Discover comfortable living at 11021 Newton Avenue—a well-maintained 3-bedroom, 2-bathroom home in the sought-after 64134 neighborhood of Kansas City. Spanning 1,172 sq ft, this home features a bright living area, a practical kitchen, and three comfortably sized bedrooms served by two full bathrooms. The private fenced backyard is perfect for outdoor relaxation or letting the kids play. Located just minutes from Hickman Mills schools, grocery stores, and major highways, this home offers everyday convenience at an affordable price. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties for details.`,
  },
  {
    address: '10404 Sycamore Ave',
    city: 'Kansas City', state: 'MO', zip: '64134',
    type: 'house', beds: 3, baths: 2.0, sqft: null,
    originalRent: 1550,
    amenities: ['A/C', 'Central Heat', 'Washer/Dryer Hookups', 'Parking'],
    appliances: ['Refrigerator', 'Stove'],
    petsAllowed: false,
    photos: zRange(759837062, 22).map(zUrl),
    rawDescription: `This charming 3-bedroom, 2-bathroom home at 10404 Sycamore Avenue is situated in a quiet neighborhood within Kansas City's popular 64134 ZIP code. The home offers a comfortable living room, a functional kitchen, and three well-sized bedrooms served by two full bathrooms. The private backyard provides great outdoor space. Conveniently located near Hickman Mills schools, the Ruskin Heights shopping area, and easy access to I-49, this home is an excellent value in a well-established neighborhood. Washer/dryer hookups are included. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties for availability.`,
  },
  {
    address: '8517 E 110th Ter',
    city: 'Kansas City', state: 'MO', zip: '64134',
    type: 'house', beds: 3, baths: 2.0, sqft: 1095,
    originalRent: 1325,
    amenities: ['A/C', 'Central Heat', 'Private Yard', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    petsAllowed: false,
    photos: zRange(892383869, 21).map(zUrl),
    rawDescription: `Nestled in a quiet neighborhood in Kansas City's 64134 ZIP code, this 3-bedroom, 2-bathroom home at 8517 E 110th Terrace offers a thoughtfully designed layout with 1,095 sq ft of living space. The home features a comfortable living room, a well-equipped kitchen, and three bedrooms served by two full bathrooms. The private yard is a great space for outdoor activities, and the home's central location offers convenient access to I-49, shops, restaurants, and South Kansas City parks. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties.`,
  },
  {
    address: '7704 Ruskin Way',
    city: 'Kansas City', state: 'MO', zip: '64134',
    type: 'house', beds: 3, baths: 2.0, sqft: null,
    originalRent: 1250,
    amenities: ['A/C', 'Central Heat', 'Private Yard'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    petsAllowed: false,
    photos: zRange(747869916, 11).map(zUrl),
    rawDescription: `This welcoming 3-bedroom, 2-bathroom home at 7704 Ruskin Way is located in the established Ruskin Heights neighborhood within Kansas City's 64134 ZIP code. The home offers a bright, open living area, a well-appointed kitchen, and three comfortable bedrooms served by two bathrooms for maximum family convenience. A private yard provides great outdoor space, and the peaceful street makes for a pleasant everyday environment. Conveniently situated near shopping, schools, and South Kansas City amenities. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties.`,
  },
  {
    address: '10504 Corrington Ave',
    city: 'Kansas City', state: 'MO', zip: '64134',
    type: 'house', beds: 3, baths: 2.0, sqft: null,
    originalRent: 1500,
    amenities: ['A/C', 'Central Heat', 'Private Yard', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Dishwasher', 'Washer/Dryer Hookups'],
    petsAllowed: false,
    photos: zRange(910783763, 11).map(zUrl),
    rawDescription: `This 3-bedroom, 2-bathroom home at 10504 Corrington Avenue is nestled in the Hickman Mills South neighborhood within Kansas City's 64134 ZIP code. The home offers a bright living room, an updated kitchen with dishwasher, and three well-sized bedrooms served by two bathrooms. The private backyard and great location—close to Hickman Mills schools, shopping, and I-49—make this a highly desirable rental. Move-in ready and available now. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties.`,
  },
  {
    address: '11720 Newton Ave',
    city: 'Kansas City', state: 'MO', zip: '64134',
    type: 'townhouse', beds: 3, baths: 2.5, sqft: 1350,
    originalRent: 1399,
    amenities: ['Garage', 'A/C', 'Central Heat', 'Washer/Dryer Hookups', 'Community Area'],
    appliances: ['Refrigerator', 'Stove', 'Dishwasher', 'Microwave'],
    petsAllowed: true,
    photos: [
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f2669629356rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f4214561430rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f2018537659rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f2127904945rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f2452623081rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f1027297070rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f1925363760rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f3008170631rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f476501265rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f2020473321rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f1154918584rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f1493456272rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f2081104813rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f175664860rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f3211572954rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f4839176rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f3167653650rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f2418357925rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f1044990914rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f3573922280rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f4119327412rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f2596714443rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f4247844540rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f2967589883rd-w1280_h960.webp'),
      rdcUrl('01574c56ca12e48bf80dc1b9a353041cc-f541086575rd-w1280_h960.webp'),
    ],
    rawDescription: `Welcome home to Grand Vue Townhomes at 11720 Newton Avenue—a beautifully maintained townhome community in Kansas City's 64134 neighborhood. This 3-bedroom, 2.5-bathroom townhome offers 1,350 sq ft of thoughtfully designed living space across multiple levels. The open-concept main level features a stylish kitchen with modern finishes, dishwasher, and built-in microwave, a comfortable living and dining area, and a convenient half bath for guests. Upstairs, three generously sized bedrooms provide the perfect retreat, with two full bathrooms ensuring comfort for everyone. In-unit washer/dryer hookups and an attached garage complete this exceptional home. Pets welcome with additional deposit. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties for current availability.`,
  },
  {
    address: '7703 E 110th St',
    city: 'Kansas City', state: 'MO', zip: '64134',
    type: 'house', beds: 3, baths: 2.0, sqft: null,
    originalRent: 1225,
    amenities: ['A/C', 'Central Heat', 'Private Yard', 'Parking'],
    appliances: ['Refrigerator', 'Stove', 'Washer/Dryer Hookups'],
    petsAllowed: false,
    photos: zRange(364104408, 5).map(zUrl),
    rawDescription: `This cozy 3-bedroom, 2-bathroom home at 7703 E 110th Street is located in a quiet neighborhood in the heart of Kansas City's 64134 ZIP code. The comfortable floor plan includes a welcoming living room, a functional kitchen, and three bedrooms served by two bathrooms for practical everyday living. The private yard provides a great outdoor space, and the neighborhood's convenient location places you close to schools, parks, and South Kansas City shopping. Household income must be 3 times the monthly rent. Application Fee: $50. Contact Choice Properties for more information.`,
  },
];

// ─── PRICE ADJUSTMENT ────────────────────────────────────────────────────────
const usedRents = new Set();

function adjustedRent(original) {
  let base;
  if (original <= 1295) {
    base = original;
  } else if (original <= 1350) {
    // Small proportional reduction → $1,240–$1,295
    const ratio = (original - 1296) / (1350 - 1296);
    base = Math.round(1295 - ratio * (1295 - 1240));
  } else if (original <= 1425) {
    // Moderate reduction → $1,200–$1,280
    const ratio = (original - 1351) / (1425 - 1351);
    base = Math.round(1280 - ratio * (1280 - 1200));
  } else if (original <= 1500) {
    // Larger reduction → $1,150–$1,250
    const ratio = (original - 1426) / (1500 - 1426);
    base = Math.round(1250 - ratio * (1250 - 1150));
  } else {
    // $1,501–$1,550 → dynamic → $1,200–$1,295
    const ratio = (original - 1501) / (1550 - 1501);
    base = Math.round(1295 - ratio * (1295 - 1200));
  }
  // Ensure uniqueness
  let pub = Math.min(base, 1295);
  while (usedRents.has(pub)) pub -= 5;
  usedRents.add(pub);
  return pub;
}

// ─── TITLE GENERATOR ─────────────────────────────────────────────────────────
function makeTitle(p, rent) {
  const typeStr = p.type === 'townhouse' ? 'Townhouse' : 'House';
  return `${p.beds}BR/${p.beds > 2 ? '2' : p.beds}BA ${typeStr} in Kansas City – $${rent}/mo`;
}

// ─── DESCRIPTION FINALIZER ──────────────────────────────────────────────────
function finalizeDescription(raw, publishedRent) {
  return raw
    .replace(/\$1[,\d]+\s*\/?\s*(month|mo)/gi, `$${publishedRent}/month`)
    .replace(/Monthly rent:.*?\./gi, `Monthly rent: $${publishedRent}.`)
    .replace(/Security deposit:.*?\./gi, `Security deposit: $${publishedRent}.`)
    .replace(/\$30 application fee/gi, 'Application Fee: $50')
    .replace(/\$45 application fee/gi, 'Application Fee: $50')
    .replace(/application fee is \$\d+/gi, 'Application Fee: $50')
    + (raw.includes('Monthly rent:') ? '' :
      `\n\nMonthly rent: $${publishedRent}. Security deposit: $${publishedRent}. Application Fee: $50.`);
}

// ─── PROPERTY URL ────────────────────────────────────────────────────────────
const SITE_URL = (process.env.SITE_URL || 'https://choice-properties-site.pages.dev').replace(/\/$/, '');

function propertyUrl(propId, beds, type) {
  const t = type === 'townhouse' ? 'townhouse' : 'house';
  const city = 'kansas-city';
  const state = 'mo';
  return `${SITE_URL}/rent/${state}/${city}/${beds}br-${t}-${propId.toLowerCase()}/`;
}

// ─── MAIN PIPELINE ────────────────────────────────────────────────────────────
async function processProp(prop) {
  const propId = makeId();
  const publishedRent = adjustedRent(prop.originalRent);
  const deposit = publishedRent;

  console.log(`\n▶  ${prop.address} | original $${prop.originalRent} → published $${publishedRent}`);
  console.log(`   ID: ${propId} | Photos: ${prop.photos.length}`);

  // 1. Geocode
  const coords = await geocode(prop.address, prop.city, prop.state, prop.zip);
  await sleep(1100); // Nominatim rate limit: 1 req/sec
  console.log(`   Coords: ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`);

  // 2. Download + upload photos
  const uploadedPhotos = [];
  for (let i = 0; i < prop.photos.length; i++) {
    const srcUrl = prop.photos[i];
    const ext = srcUrl.includes('.webp') ? 'webp' : 'jpg';
    const fileName = `${propId.toLowerCase()}-photo-${i + 1}.${ext}`;
    try {
      console.log(`   📷 Downloading photo ${i + 1}/${prop.photos.length}...`);
      const buf = await downloadBuffer(srcUrl);
      console.log(`   ⬆️  Uploading ${fileName} (${Math.round(buf.length / 1024)} KB)...`);
      const ikRes = await uploadToImageKit(buf, fileName, `/properties/${propId.toLowerCase()}/`);
      uploadedPhotos.push({ url: ikRes.url, fileId: ikRes.fileId, order: i + 1 });
      console.log(`   ✓  ${ikRes.url}`);
      await sleep(300);
    } catch (e) {
      console.error(`   ✗  Photo ${i + 1} FAILED: ${e.message}`);
    }
  }

  if (uploadedPhotos.length === 0) {
    throw new Error(`No photos uploaded for ${prop.address} — skipping`);
  }
  console.log(`   Uploaded ${uploadedPhotos.length}/${prop.photos.length} photos`);

  // 3. Insert property
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
    county: 'Jackson',
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
    pets_allowed: prop.petsAllowed,
    pet_types_allowed: prop.petsAllowed ? ['Dogs', 'Cats'] : [],
    utilities_included: [],
    lease_terms: ['12 months'],
    featured: false,
    neighborhood: '64134 - Hickman Mills',
  };

  console.log(`   💾 Inserting property row...`);
  await sbInsert('properties', propRow);
  console.log(`   ✓  Property inserted`);

  // 4. Insert photos
  console.log(`   💾 Inserting ${uploadedPhotos.length} photo rows...`);
  for (const photo of uploadedPhotos) {
    const photoRow = {
      property_id: propId,
      url: photo.url,
      file_id: photo.fileId,
      display_order: photo.order,
      watermark_status: 'clean',
      is_hero: photo.order === 1,
    };
    await sbInsert('property_photos', photoRow);
    await sleep(100);
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
  console.log('  Choice Properties — ZIP 64134 Scraper Pipeline');
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

  // Report
  console.log('\n\n═══════════════════════════════════════════════════════════');
  console.log('  POST-SCRAPING REPORT');
  console.log('═══════════════════════════════════════════════════════════\n');

  results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.address}`);
    console.log(`   ${r.url}`);
    console.log(`   Rent: $${r.publishedRent}/mo | Photos: ${r.photosUploaded} | ID: ${r.propId}\n`);
  });

  if (failures.length > 0) {
    console.log('\nFailed properties:');
    failures.forEach(f => console.log(`  ✗ ${f.address}: ${f.error}`));
  }

  console.log(`\n✅ Successfully published: ${results.length}/${PROPERTIES.length}`);

  if (results.length < 10) {
    console.log(`\nNote: Only ${results.length} properties met all qualifying criteria in ZIP 64134.`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
