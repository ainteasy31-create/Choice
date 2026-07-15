'use strict';
// Delete ImageKit folders for the 4 properties from the first (failed) run
// that uploaded photos but never got a DB row

const https = require('https');
const crypto = require('crypto');

const IK_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY;
const authStr = Buffer.from(IK_PRIVATE_KEY + ':').toString('base64');

const orphanedFolders = [
  'prop-f06e21d4', // Fremont run 1
  'prop-fd83d393', // 7704 E 103rd Ter run 1
  'prop-0006a82b', // Grand Vue run 1
  'prop-2ed4cefb', // 7703 E 110th St run 1
  // There were also some mid-pipeline ones that fully uploaded photos but failed on DB:
  // 11021 Newton, 10404 Sycamore, 8517 E 110th, 7704 Ruskin, 10504 Corrington — but
  // those IDs weren't printed. We'll find and delete by listing the folder.
];

async function deleteFolder(folderPath) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ folderPath: `/properties/${folderPath}/` });
    const req = https.request({
      hostname: 'api.imagekit.io',
      path: '/v1/folder',
      method: 'DELETE',
      headers: {
        'Authorization': `Basic ${authStr}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let raw = ''; res.on('data', d => raw += d);
      res.on('end', () => { console.log(`DELETE ${folderPath}: ${res.statusCode} ${raw.slice(0,80)}`); resolve(); });
    });
    req.on('error', e => { console.log(`DELETE ${folderPath}: ERROR ${e.message}`); resolve(); });
    req.write(body); req.end();
  });
}

async function main() {
  // Also list /properties/ root to find any other orphaned folders
  const listRes = await new Promise((resolve) => {
    const req = https.get({
      hostname: 'api.imagekit.io',
      path: '/v1/files?path=%2Fproperties&type=folder&limit=50',
      headers: { 'Authorization': `Basic ${authStr}` },
    }, res => {
      let raw = ''; res.on('data', d => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
  });
  
  console.log('Folders in /properties:', listRes.body.slice(0, 2000));

  // Good property IDs from the successful run:
  const good = new Set([
    'prop-4dd26855','prop-d64d40de','prop-26122c83','prop-fcb04de9',
    'prop-417beaba','prop-1f494049','prop-047c3d16','prop-619befe1','prop-02407ca5'
  ]);

  for (const folder of orphanedFolders) {
    if (!good.has(folder)) {
      await deleteFolder(folder);
    }
  }
}
main().catch(console.error);
