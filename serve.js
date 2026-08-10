const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.webp': 'image/webp',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain',
  '.xml':  'application/xml',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  if (urlPath === '/') urlPath = '/index.html';

  let filePath = path.join(ROOT, urlPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      const notFound = path.join(ROOT, '404.html');
      if (fs.existsSync(notFound)) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end(fs.readFileSync(notFound));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    const headers = { 'Content-Type': contentType };

    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Choice Properties dev server running at http://0.0.0.0:${PORT}`);
});
