#!/usr/bin/env node
// ============================================================
// Generate PNG icons for the Chrome extension.
// Run once from the chrome-extension/ directory:
//   node generate-icons.js
//
// Produces icons/icon16.png, icon32.png, icon48.png, icon128.png
// Uses only Node.js built-ins (zlib, fs, path) — no npm required.
// ============================================================

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 ─────────────────────────────────────────────────────────────────────
const crcTable = (function () {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len     = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crcVal  = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcVal]);
}

// ── Draw icon pixel ──────────────────────────────────────────────────────────
// Draws a rounded-square background (indigo #6366f1) with a white
// download-arrow icon centred inside it.

function drawIcon(size) {
  // rgba pixel grid
  const pixels = new Uint8Array(size * size * 4); // R G B A

  const bg  = [99, 102, 241, 255];   // #6366f1
  const fg  = [255, 255, 255, 255];  // white

  const radius = Math.round(size * 0.22); // corner radius ~22 % of size

  function setPixel(x, y, rgba) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    pixels[i]   = rgba[0];
    pixels[i+1] = rgba[1];
    pixels[i+2] = rgba[2];
    pixels[i+3] = rgba[3];
  }

  // ── Background: rounded square via signed-distance field ──────────────────
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x - size / 2 + 0.5;
      const cy = y - size / 2 + 0.5;
      const half = size / 2 - 0.5;
      const r = radius;
      const qx = Math.abs(cx) - half + r;
      const qy = Math.abs(cy) - half + r;
      const dist = Math.sqrt(Math.max(qx,0)**2 + Math.max(qy,0)**2) + Math.min(Math.max(qx,qy),0) - r;
      if (dist <= 0.5) setPixel(x, y, bg);
    }
  }

  // ── Icon: download arrow (↓ with base line) ────────────────────────────────
  // Scaled relative to size. For tiny sizes keep it thick enough to read.
  const pad   = Math.round(size * 0.22);          // padding from edge
  const inner = size - pad * 2;
  const cx    = Math.floor(size / 2);

  const stemW  = Math.max(2, Math.round(inner * 0.18));
  const stemH  = Math.round(inner * 0.44);
  const stemT  = pad + Math.round(inner * 0.06);  // top of stem

  // Vertical stem
  for (let y = stemT; y < stemT + stemH; y++) {
    for (let dx = -Math.floor(stemW/2); dx <= Math.floor(stemW/2); dx++) {
      setPixel(cx + dx, y, fg);
    }
  }

  // Chevron/arrowhead (^-shaped, pointing down)
  const arrowW = Math.round(inner * 0.78);
  const arrowH = Math.round(inner * 0.36);
  const arrowT = stemT + stemH - Math.round(stemW / 2);
  const halfAW = Math.floor(arrowW / 2);
  const thick  = Math.max(2, Math.round(inner * 0.18));

  for (let t = 0; t < thick; t++) {
    for (let i = 0; i <= halfAW; i++) {
      const frac = i / halfAW;
      const y    = arrowT + Math.round(frac * arrowH) + t;
      setPixel(cx - i, y, fg);  // left arm
      setPixel(cx + i, y, fg);  // right arm
    }
  }

  // Horizontal baseline
  const lineY = pad + inner - 1;
  const lineH = Math.max(2, Math.round(inner * 0.14));
  for (let dy = 0; dy < lineH; dy++) {
    for (let x = pad; x < size - pad; x++) {
      setPixel(x, lineY - dy, fg);
    }
  }

  return pixels;
}

// ── Encode pixels to PNG ──────────────────────────────────────────────────────
function encodePNG(size, pixels) {
  const PNG_SIG = Buffer.from([137,80,78,71,13,10,26,10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8,  8);  // bit depth
  ihdr.writeUInt8(6,  9);  // color type: RGBA
  // compression=0, filter=0, interlace=0 (already 0)

  // Raw rows: filter byte (0) + RGBA per pixel
  const rowLen = 1 + size * 4;
  const raw    = Buffer.alloc(size * rowLen);
  for (let y = 0; y < size; y++) {
    const rowBase = y * rowLen;
    raw[rowBase] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = rowBase + 1 + x * 4;
      raw[dst]   = pixels[src];
      raw[dst+1] = pixels[src+1];
      raw[dst+2] = pixels[src+2];
      raw[dst+3] = pixels[src+3];
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Main ──────────────────────────────────────────────────────────────────────
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const pixels = drawIcon(size);
  const png    = encodePNG(size, pixels);
  const file   = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`✓ icons/icon${size}.png  (${png.length} bytes)`);
}

console.log('\nDone. Load the chrome-extension/ folder in Chrome to use the extension.');
