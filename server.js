const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const MANUSCRIPTS_DIR = path.join(__dirname, 'manuscripts');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Save manuscript: PUT /manuscripts/A.txt
  if (req.method === 'PUT' && req.url.startsWith('/manuscripts/')) {
    const filename = path.basename(req.url);
    const filepath = path.join(MANUSCRIPTS_DIR, filename);

    // Security: only allow .txt files in manuscripts folder
    if (!filename.endsWith('.txt')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Only .txt files allowed' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      fs.writeFile(filepath, body, 'utf8', (err) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          console.log(`Saved: ${filename}`);
        }
      });
    });
    return;
  }

  // Save score: PUT /score.txt
  if (req.method === 'PUT' && req.url === '/score.txt') {
    const filepath = path.join(__dirname, 'score.txt');

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      fs.writeFile(filepath, body, 'utf8', (err) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          console.log('Saved: score.txt');
        }
      });
    });
    return;
  }

  // Serve static files: GET
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not found');
      } else {
        res.writeHead(500);
        res.end('Server error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('Manuscripts will be saved to ./manuscripts/');
});
