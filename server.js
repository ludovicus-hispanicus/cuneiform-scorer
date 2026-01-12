const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const Y = require('yjs');
const { setupWSConnection } = require('y-websocket/bin/utils');

const PORT = process.env.PORT || 3000;
const PROJECTS_DIR = path.join(__dirname, 'projects');
const MANUSCRIPTS_DIR = path.join(__dirname, 'manuscripts'); // Legacy support

// Ensure projects directory exists
if (!fs.existsSync(PROJECTS_DIR)) {
  fs.mkdirSync(PROJECTS_DIR);
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

// Store for Y.js documents (in-memory, persisted to files)
const docs = new Map();

// Get or create a Y.js document for a room
function getYDoc(docName) {
  if (!docs.has(docName)) {
    const doc = new Y.Doc();
    docs.set(docName, doc);
  }
  return docs.get(docName);
}

const server = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // GitHub token proxy (to avoid exposing token in client)
  if (req.method === 'POST' && req.url === '/api/github/contents') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { token, owner, repo, path: filePath, content, message, sha } = JSON.parse(body);

        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github.v3+json'
          },
          body: JSON.stringify({
            message: message || 'Update from Manuscript Scorer',
            content: Buffer.from(content).toString('base64'),
            sha: sha || undefined
          })
        });

        const data = await response.json();
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Get file from GitHub
  if (req.method === 'POST' && req.url === '/api/github/get') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { token, owner, repo, path: filePath } = JSON.parse(body);

        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        });

        const data = await response.json();
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ===========================================
  // PROJECTS API
  // ===========================================

  // List all projects
  if (req.method === 'GET' && req.url === '/api/projects') {
    try {
      const projects = [];
      const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });

      for (const folder of folders) {
        if (folder.isDirectory()) {
          const configPath = path.join(PROJECTS_DIR, folder.name, 'project.json');
          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const msDir = path.join(PROJECTS_DIR, folder.name, 'manuscripts');
            let manuscriptCount = 0;
            if (fs.existsSync(msDir)) {
              manuscriptCount = fs.readdirSync(msDir).filter(f => f.endsWith('.txt')).length;
            }
            projects.push({
              ...config,
              folder: folder.name,
              manuscriptCount
            });
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(projects));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Create a new project
  if (req.method === 'POST' && req.url === '/api/projects') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { name, folder } = JSON.parse(body);

        // Validate folder name
        if (!/^[a-zA-Z0-9_-]+$/.test(folder)) {
          res.writeHead(400);
          res.end('Invalid folder name');
          return;
        }

        const projectDir = path.join(PROJECTS_DIR, folder);
        if (fs.existsSync(projectDir)) {
          res.writeHead(400);
          res.end('Project already exists');
          return;
        }

        // Create project structure
        fs.mkdirSync(projectDir);
        fs.mkdirSync(path.join(projectDir, 'manuscripts'));

        // Create project config
        fs.writeFileSync(
          path.join(projectDir, 'project.json'),
          JSON.stringify({ name, created: new Date().toISOString() }, null, 2)
        );

        // Create default manuscript index
        fs.writeFileSync(
          path.join(projectDir, 'manuscripts', 'index.json'),
          '[]'
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, folder }));
        console.log(`Created project: ${folder}`);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Get project config
  if (req.method === 'GET' && req.url.match(/^\/api\/projects\/[^/]+$/)) {
    const folder = req.url.split('/').pop();
    const configPath = path.join(PROJECTS_DIR, folder, 'project.json');

    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...config, folder }));
    } else {
      res.writeHead(404);
      res.end('Project not found');
    }
    return;
  }

  // Get project files list
  if (req.method === 'GET' && req.url.match(/^\/api\/projects\/[^/]+\/files$/)) {
    const folder = req.url.split('/')[3];
    const msDir = path.join(PROJECTS_DIR, folder, 'manuscripts');
    const indexPath = path.join(msDir, 'index.json');

    try {
      // Get all .txt files
      const files = fs.existsSync(msDir)
        ? fs.readdirSync(msDir).filter(f => f.endsWith('.txt'))
        : [];

      // Get indexed files
      let indexed = [];
      if (fs.existsSync(indexPath)) {
        indexed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files, indexed }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Regenerate project index from all .txt files
  if (req.method === 'POST' && req.url.match(/^\/api\/projects\/[^/]+\/regenerate-index$/)) {
    const folder = req.url.split('/')[3];
    const msDir = path.join(PROJECTS_DIR, folder, 'manuscripts');
    const indexPath = path.join(msDir, 'index.json');

    try {
      // Get all .txt files and extract sigla (filename without .txt)
      const files = fs.existsSync(msDir)
        ? fs.readdirSync(msDir).filter(f => f.endsWith('.txt'))
        : [];

      const sigla = files.map(f => f.replace('.txt', ''));

      // Write new index
      fs.writeFileSync(indexPath, JSON.stringify(sigla, null, 2));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: sigla.length, sigla }));
      console.log(`Regenerated index for ${folder}: ${sigla.length} manuscripts`);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Update sigla mappings
  if (req.method === 'PUT' && req.url.match(/^\/api\/projects\/[^/]+\/sigla$/)) {
    const folder = req.url.split('/')[3];
    const configPath = path.join(PROJECTS_DIR, folder, 'project.json');

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const sigla = JSON.parse(body);

        // Read existing config
        let config = {};
        if (fs.existsSync(configPath)) {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }

        // Update sigla mappings
        config.sigla = sigla;

        // Write back
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        console.log(`Updated sigla mappings for ${folder}`);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Import manuscript file
  if (req.method === 'POST' && req.url.match(/^\/api\/projects\/[^/]+\/import$/)) {
    const folder = req.url.split('/')[3];
    const msDir = path.join(PROJECTS_DIR, folder, 'manuscripts');

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { filename, content } = JSON.parse(body);

        // Validate filename
        if (!filename.endsWith('.txt')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Only .txt files allowed' }));
          return;
        }

        // Ensure manuscripts directory exists
        if (!fs.existsSync(msDir)) {
          fs.mkdirSync(msDir, { recursive: true });
        }

        // Write file
        const filepath = path.join(msDir, filename);
        fs.writeFileSync(filepath, content, 'utf8');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, filename }));
        console.log(`Imported: ${folder}/${filename}`);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Delete project
  if (req.method === 'DELETE' && req.url.match(/^\/api\/projects\/[^/]+$/)) {
    const folder = req.url.split('/').pop();
    const projectDir = path.join(PROJECTS_DIR, folder);

    try {
      if (!fs.existsSync(projectDir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
      }

      // Recursively delete directory
      fs.rmSync(projectDir, { recursive: true, force: true });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      console.log(`Deleted project: ${folder}`);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Save file to project: PUT /projects/{folder}/manuscripts/{file}.txt
  if (req.method === 'PUT' && req.url.match(/^\/projects\/[^/]+\/manuscripts\/[^/]+\.txt$/)) {
    const parts = req.url.split('/');
    const folder = parts[2];
    const filename = parts[4];
    const filepath = path.join(PROJECTS_DIR, folder, 'manuscripts', filename);

    // Security check
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
          console.log(`Saved: ${folder}/${filename}`);
        }
      });
    });
    return;
  }

  // Save score to project: PUT /projects/{folder}/score.txt
  if (req.method === 'PUT' && req.url.match(/^\/projects\/[^/]+\/score\.txt$/)) {
    const folder = req.url.split('/')[2];
    const filepath = path.join(PROJECTS_DIR, folder, 'score.txt');

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
          console.log(`Saved: ${folder}/score.txt`);
        }
      });
    });
    return;
  }

  // Save manuscript index: PUT /projects/{folder}/manuscripts/index.json
  if (req.method === 'PUT' && req.url.match(/^\/projects\/[^/]+\/manuscripts\/index\.json$/)) {
    const folder = req.url.split('/')[2];
    const filepath = path.join(PROJECTS_DIR, folder, 'manuscripts', 'index.json');

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
        }
      });
    });
    return;
  }

  // ===========================================
  // GITHUB API
  // ===========================================

  // List repo contents
  if (req.method === 'POST' && req.url === '/api/github/list') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { token, owner, repo, path: dirPath } = JSON.parse(body);

        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${dirPath || ''}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        });

        const data = await response.json();
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
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

  // Serve static files: GET only
  if (req.method !== 'GET') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  let filePath = req.url === '/' ? '/index.html' : req.url;

  // Remove query string
  filePath = filePath.split('?')[0];

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

// WebSocket server for Y.js real-time sync
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomName = url.searchParams.get('room') || 'default';

  console.log(`New WebSocket connection to room: ${roomName}`);

  setupWSConnection(ws, req, {
    docName: roomName,
    gc: true
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`WebSocket sync available at ws://localhost:${PORT}`);
  console.log('Manuscripts will be saved to ./manuscripts/');
});
