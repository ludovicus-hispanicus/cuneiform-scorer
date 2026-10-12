const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const Y = require('yjs');
const { setupWSConnection } = require('y-websocket/bin/utils');

// Validator binary resolution
// - In bundled Electron desktop builds, VALIDATE_ATF_BIN points at the PyInstaller exe
// - In dev (`npm start` with a system Python), we spawn `python validate_atf.py`
// The PyInstaller build carries its own lark, so it works whether or not the
// system Python has one. It lives in the repo, so dev should use it too —
// without this, `npm start` falls through to a system Python, and if that has
// no lark the validator answers "valid" to everything it is given.
const BUNDLED_VALIDATOR = path.join(__dirname, 'dist', 'validator',
  process.platform === 'win32' ? 'validate_atf.exe' : 'validate_atf');
const VALIDATE_ATF_BIN = process.env.VALIDATE_ATF_BIN
  || (fs.existsSync(BUNDLED_VALIDATOR) ? BUNDLED_VALIDATOR : null);
const VALIDATE_SCRIPT = path.join(__dirname, 'validate_atf.py');
const PYTHON_EXE = process.env.PYTHON_EXE || (process.platform === 'win32' ? 'python' : 'python3');

// Which validator to run, decided once at startup.
//
// A Python that has lark runs validate_atf.py, so it is always the current
// rules. The bundled binary carries its own lark and its own frozen copy of
// that script — which is why it is only trusted while it is at least as new
// as the source. A binary older than the script predates whatever the script
// has learned since, and a validator running stale rules is worse than none:
// it rejects ATF that is actually valid, and the editor has no way to tell.
// A project-local virtualenv is tried before whatever `python` means on PATH,
// so `pip install lark` into .venv is enough to turn the validator on and
// nothing has to be installed system-wide. Both layouts are checked: Scripts/
// on a stock Windows Python, bin/ under MSYS2.
function pythonCandidates() {
  const venv = path.join(__dirname, '.venv');
  return [
    path.join(venv, 'Scripts', 'python.exe'),
    path.join(venv, 'bin', 'python.exe'),
    path.join(venv, 'bin', 'python'),
  ].filter((p) => fs.existsSync(p)).concat([PYTHON_EXE]);
}

function resolveValidator() {
  for (const exe of pythonCandidates()) {
    try {
      const probe = require('child_process').spawnSync(exe, ['-c', 'import lark'], { timeout: 5000 });
      if (probe.status === 0) return { cmd: exe, args: [VALIDATE_SCRIPT], kind: 'python', mode: 'dev' };
    } catch (_) { /* not this one */ }
  }

  if (VALIDATE_ATF_BIN && fs.existsSync(VALIDATE_ATF_BIN)) {
    let stale = false;
    try {
      stale = fs.existsSync(VALIDATE_SCRIPT)
        && fs.statSync(VALIDATE_ATF_BIN).mtimeMs < fs.statSync(VALIDATE_SCRIPT).mtimeMs;
    } catch (_) { /* if we cannot tell, trust it */ }
    if (stale) {
      return { cmd: null, args: [], kind: 'stale-binary', mode: 'dev',
        why: 'The bundled validator is older than validate_atf.py. Rebuild it with'
          + ' `npm run build:validator`, or `pip install lark` so the script runs directly.' };
    }
    return { cmd: VALIDATE_ATF_BIN, args: [], kind: 'binary', mode: 'desktop' };
  }

  return { cmd: null, args: [], kind: 'none', mode: 'dev',
    why: 'No validator: install Python + `pip install lark`, or build the bundled binary.' };
}
const VALIDATOR = resolveValidator();

// How the validator's work is budgeted and shared out.
//
// A row costs the Earley parser about a quarter of a second, so these are
// measured from that: enough workers to keep a chapter-sized range inside a
// coffee-length wait, but never so many for a single omen that starting them
// costs more than the parsing.
const VALIDATE_MS_PER_ROW = 1500;                 // generous: measured ~250ms
const VALIDATE_MAX_MS = 15 * 60 * 1000;
const VALIDATE_MIN_ROWS_PER_WORKER = 24;
const VALIDATE_MAX_WORKERS = Math.max(1,
  Math.min(8, (require('os').cpus() || { length: 4 }).length - 1));

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

  // ===========================================
  // HEALTH PROBE — used by the frontend to detect "desktop mode" (validator
  // available) vs "browser/dev mode" (no validator).
  // ===========================================
  if (req.method === 'GET' && req.url === '/api/health') {
    const validatorAvailable = !!VALIDATOR.cmd;
    const mode = VALIDATOR.mode;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      validator: validatorAvailable,
      validatorSource: VALIDATOR.kind,
      validatorWhy: VALIDATOR.why || null,
      mode,
      app: 'cuneiform-scorer',
      inPlaceWrites: true,
    }));
    return;
  }

  // ===========================================
  // WHO IS SENDING — the computer and the Windows user this copy runs on.
  // Projects are shared through the Drive, so a report filed into one can come
  // from either editor's machine; without this nobody could tell whose send
  // eBL refused.
  // ===========================================
  if (req.method === 'GET' && req.url === '/api/whoami') {
    const os = require('os');
    let user = '';
    try { user = os.userInfo().username || ''; } catch (_) { user = ''; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user, host: os.hostname() || '' }));
    return;
  }

  // ===========================================
  // eBL ATF VALIDATOR — spawns Python or the bundled PyInstaller binary
  // ===========================================
  //
  // eBL's grammar is parsed with Earley, which costs roughly a quarter of a
  // second for every line, whatever the line says. That is fine for one omen
  // and ruinous for a range: a whole chapter is some 700 rows, near three
  // minutes of honest work, and it used to be killed at a flat thirty seconds
  // — so any range past about a dozen sections came back as a 500, which the
  // editor read as "no problems" and sent unchecked.
  //
  // Every line is judged on its own, with no state carried between them, so
  // the work shards cleanly: the rows are dealt out to several validators at
  // once and the answers stitched back together, with each shard's line
  // numbers shifted to where they belong in the whole.
  if (req.method === 'POST' && req.url === '/api/validate-atf') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
      const atf = (payload && typeof payload.atf === 'string') ? payload.atf : '';

      // Decided at startup. With no usable validator, say so plainly rather
      // than answering "valid" — the editor shows that the ATF went
      // unchecked instead of being told it passed.
      if (!VALIDATOR.cmd) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          valid: true, errors: [], warnings: [], parsed_lines: 0,
          validation_source: VALIDATOR.kind, available: false, init_error: VALIDATOR.why,
        }));
        return;
      }

      // One validator over one slice of the rows. Resolves with the parsed
      // JSON, or rejects with a reason worth showing the editor.
      const runShard = (text, rows) => new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(VALIDATOR.cmd, VALIDATOR.args, {
            // PyInstaller binaries set PYTHONIOENCODING themselves, but be
            // explicit for the dev python path.
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          });
        } catch (err) {
          reject(new Error('Failed to spawn validator: ' + err.message));
          return;
        }

        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });

        // Budgeted by the work in hand rather than by a flat number: start-up
        // plus a generous allowance per row, so a long parse is waited for and
        // a hung one is still cut off.
        let killed = false;
        const budget = Math.min(VALIDATE_MAX_MS, 30000 + rows * VALIDATE_MS_PER_ROW);
        const timer = setTimeout(() => {
          killed = true;
          try { child.kill('SIGKILL'); } catch (_) {}
        }, budget);

        child.on('error', (err) => {
          clearTimeout(timer);
          reject(new Error('Validator process error: ' + err.message));
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          if (killed) {
            reject(new Error('The validator ran longer than '
              + Math.round(budget / 1000) + 's on ' + rows + ' row(s) and was stopped.'));
            return;
          }
          if (code !== 0 && !stdout) {
            reject(new Error('Validator exited with code ' + code
              + (stderr ? ': ' + stderr.slice(0, 500) : '')));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch (err) {
            reject(new Error('Validator wrote something that is not JSON: '
              + stdout.slice(0, 300)));
          }
        });

        child.stdin.setDefaultEncoding('utf8');
        child.stdin.write(text);
        child.stdin.end();
      });

      // Deal the rows out. Small inputs stay in one process: starting a
      // validator costs about half a second, so sharding an omen would be
      // slower than parsing it.
      const lines = atf.split('\n');
      const workers = Math.max(1, Math.min(
        VALIDATE_MAX_WORKERS,
        Math.floor(lines.length / VALIDATE_MIN_ROWS_PER_WORKER) || 1
      ));
      const per = Math.ceil(lines.length / workers);
      const shards = [];
      for (let at = 0; at < lines.length; at += per) {
        shards.push({ offset: at, rows: lines.slice(at, at + per) });
      }

      try {
        const parts = await Promise.all(
          shards.map((s) => runShard(s.rows.join('\n'), s.rows.length)));
        // Stitched back in order, so the errors still read in the order the
        // rows do, and every line number addresses the ATF that was sent.
        const merged = {
          valid: true, errors: [], warnings: [], parsed_lines: 0,
          validation_source: parts[0] ? parts[0].validation_source : 'local_lark',
          available: true, init_error: null,
        };
        parts.forEach((part, i) => {
          const offset = shards[i].offset;
          for (const e of (part.errors || [])) {
            merged.errors.push({ ...e, line: e.line == null ? null : e.line + offset });
          }
          for (const w of (part.warnings || [])) merged.warnings.push(w);
          merged.parsed_lines += part.parsed_lines || 0;
          if (part.available === false) merged.available = false;
          if (part.init_error && !merged.init_error) merged.init_error = part.init_error;
        });
        merged.valid = merged.errors.length === 0;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(merged));
      } catch (err) {
        // A check that could not be run is not a clean bill of health, and the
        // editor is told which it got.
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          valid: false, errors: [], warnings: [], parsed_lines: 0,
          validation_source: VALIDATOR.kind, available: false,
          init_error: err.message || String(err),
        }));
      }
    });
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

  // Create a new project (or initialize existing folder)
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
        const configPath = path.join(projectDir, 'project.json');
        const msDir = path.join(projectDir, 'manuscripts');

        // Check if folder exists but has no project.json (initialize existing folder)
        if (fs.existsSync(projectDir) && !fs.existsSync(configPath)) {
          // Initialize existing folder as project
          // Look for .txt files in root or manuscripts subfolder
          let txtFiles = [];

          // Check root folder for .txt files
          const rootFiles = fs.readdirSync(projectDir);
          txtFiles = rootFiles.filter(f => f.endsWith('.txt') && f !== 'score.txt');

          // If manuscripts folder exists, use that instead
          if (fs.existsSync(msDir)) {
            txtFiles = fs.readdirSync(msDir).filter(f => f.endsWith('.txt'));
          } else {
            // Create manuscripts folder and move .txt files there
            fs.mkdirSync(msDir);
            for (const file of txtFiles) {
              const src = path.join(projectDir, file);
              const dest = path.join(msDir, file);
              fs.renameSync(src, dest);
            }
          }

          // Create project.json
          fs.writeFileSync(
            configPath,
            JSON.stringify({ name, created: new Date().toISOString() }, null, 2)
          );

          // Create index.json from found .txt files
          const sigla = txtFiles.map(f => f.replace('.txt', ''));
          fs.writeFileSync(
            path.join(msDir, 'index.json'),
            JSON.stringify(sigla, null, 2)
          );

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, folder, initialized: true, manuscripts: sigla.length }));
          console.log(`Initialized existing folder as project: ${folder} (${sigla.length} manuscripts found)`);
          return;
        }

        // Check if project already fully exists
        if (fs.existsSync(configPath)) {
          res.writeHead(400);
          res.end('Project already exists');
          return;
        }

        // Create new project structure
        if (!fs.existsSync(projectDir)) {
          fs.mkdirSync(projectDir);
        }
        if (!fs.existsSync(msDir)) {
          fs.mkdirSync(msDir);
        }

        // Create project config
        fs.writeFileSync(
          configPath,
          JSON.stringify({ name, created: new Date().toISOString() }, null, 2)
        );

        // Create default manuscript index
        fs.writeFileSync(
          path.join(msDir, 'index.json'),
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

  // Import folder (from File System Access API)
  if (req.method === 'POST' && req.url === '/api/projects/import-folder') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { name, folder, files } = JSON.parse(body);

        // Validate folder name
        if (!/^[a-zA-Z0-9_-]+$/.test(folder)) {
          res.writeHead(400);
          res.end('Invalid folder name');
          return;
        }

        const projectDir = path.join(PROJECTS_DIR, folder);
        const configPath = path.join(projectDir, 'project.json');
        const msDir = path.join(projectDir, 'manuscripts');

        // Create project directory structure
        if (!fs.existsSync(projectDir)) {
          fs.mkdirSync(projectDir, { recursive: true });
        }
        if (!fs.existsSync(msDir)) {
          fs.mkdirSync(msDir, { recursive: true });
        }

        // Write manuscript files
        const sigla = [];
        for (const file of files) {
          const filename = file.name.endsWith('.txt') ? file.name : file.name + '.txt';
          const filepath = path.join(msDir, filename);
          fs.writeFileSync(filepath, file.content, 'utf8');
          sigla.push(filename.replace('.txt', ''));
        }

        // Create or update project.json
        const config = fs.existsSync(configPath)
          ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
          : { created: new Date().toISOString() };
        config.name = name;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        // Create index.json
        fs.writeFileSync(path.join(msDir, 'index.json'), JSON.stringify(sigla, null, 2));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, folder, manuscripts: sigla.length }));
        console.log(`Imported folder as project: ${folder} (${sigla.length} manuscripts)`);
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

  // ===========================================
  // IN-PLACE WRITES — the page's own file API cannot modify a file, only
  // replace it: createWritable() writes a temporary file and swaps it over the
  // original on close. On a synced folder that swap is a delete and a create,
  // and when the file belongs to another account Drive may refuse the create
  // (409), strand the save in lost_and_found and pull its own copy back. Node
  // writes into the existing file, which every sync client reads as a plain
  // modification. The page has no way to learn a picked folder's path, so a
  // project is bound to its path once, and only bound folders are written to.
  // ===========================================
  const PROJECT_PATHS_FILE = path.join(__dirname, 'project-paths.json');
  const readProjectPaths = () => {
    try { return JSON.parse(fs.readFileSync(PROJECT_PATHS_FILE, 'utf8')) || {}; }
    catch (_) { return {}; }
  };
  // Only the page served from here may write. A browser sends Origin on a
  // cross-site POST, so any other origin is a foreign page asking.
  const sameOrigin = () => {
    const o = req.headers.origin;
    if (!o) return true;
    try {
      const u = new URL(o);
      return (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
        && String(u.port || (u.protocol === 'https:' ? 443 : 80)) === String(PORT);
    } catch (_) { return false; }
  };
  const readJsonBody = (cb) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { cb(null, JSON.parse(body || '{}')); } catch (e) { cb(e); }
    });
  };
  const reply = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const projectIdIn = (folder) => {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(folder, 'project.json'), 'utf8'));
      return cfg && cfg.id != null ? String(cfg.id) : null;
    } catch (_) { return null; }
  };

  if (req.method === 'POST' && req.url === '/api/projects/bind') {
    if (!sameOrigin()) { reply(403, { error: 'foreign origin' }); return; }
    readJsonBody((err, b) => {
      if (err) { reply(400, { error: 'bad JSON' }); return; }
      const id = String(b.id || '');
      const folder = String(b.path || '').trim();
      if (!id || !folder) { reply(400, { error: 'id and path are required' }); return; }
      if (!path.isAbsolute(folder) || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        reply(400, { error: 'not a folder on this computer: ' + folder }); return;
      }
      // The folder must be the project it claims to be: its project.json
      // carries the id the page is working under.
      const found = projectIdIn(folder);
      if (found !== id) {
        reply(409, { error: found
          ? 'that folder is project ' + found + ', not ' + id
          : 'no project.json in that folder' });
        return;
      }
      const all = readProjectPaths();
      all[id] = path.resolve(folder);
      fs.writeFileSync(PROJECT_PATHS_FILE, JSON.stringify(all, null, 2));
      reply(200, { ok: true, path: all[id] });
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/project-path')) {
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    const folder = readProjectPaths()[id];
    if (!folder) { reply(404, { error: 'not bound' }); return; }
    // A binding is only as good as the folder still being that project.
    if (projectIdIn(folder) !== id) { reply(404, { error: 'folder no longer holds this project' }); return; }
    reply(200, { path: folder });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/projects/write') {
    if (!sameOrigin()) { reply(403, { error: 'foreign origin' }); return; }
    readJsonBody((err, b) => {
      if (err) { reply(400, { error: 'bad JSON' }); return; }
      const id = String(b.id || '');
      const rel = String(b.relPath || '').replace(/\\/g, '/');
      const content = typeof b.content === 'string' ? b.content : null;
      if (!id || !rel || content == null) { reply(400, { error: 'id, relPath and content are required' }); return; }
      const folder = readProjectPaths()[id];
      if (!folder) { reply(404, { error: 'project not bound' }); return; }
      if (projectIdIn(folder) !== id) { reply(409, { error: 'folder no longer holds this project' }); return; }
      // Inside the project and nowhere else.
      if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split('/').some((p) => p === '..' || p === '')) {
        reply(400, { error: 'relPath must be a plain path inside the project' }); return;
      }
      const target = path.resolve(folder, rel);
      if (!target.startsWith(path.resolve(folder) + path.sep)) { reply(400, { error: 'outside the project' }); return; }
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // writeFileSync opens the existing file and truncates it: the same
        // file, modified — never a new one swapped in.
        fs.writeFileSync(target, content, 'utf8');
        reply(200, { ok: true, bytes: Buffer.byteLength(content, 'utf8') });
      } catch (e) {
        reply(500, { error: e.message });
      }
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
      // no-cache: the browser revalidates on every load, so edits to the
      // app's files show up on a plain refresh instead of only on Ctrl+F5.
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
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
