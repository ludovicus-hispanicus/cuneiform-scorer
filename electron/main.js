// Electron main process for Manuscript Scorer desktop build.
//
// Spawns the existing server.js as a child (with ELECTRON_RUN_AS_NODE=1 so
// electron.exe acts as a plain Node runtime), waits for it to bind on a free
// port, then opens a BrowserWindow loaded from that local URL.
//
// In production builds, the PyInstaller-bundled validator binary lives next
// to the bundled app resources; we pass its path to server.js via the
// VALIDATE_ATF_BIN env var.

const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const isDev = !app.isPackaged;
const APP_ROOT = isDev ? path.join(__dirname, '..') : process.resourcesPath;
const SERVER_SCRIPT = path.join(APP_ROOT, 'server.js');

// Pick the validator binary location.
// Dev: leave unset → server.js will spawn system Python.
// Packaged: look next to resources/extraResources/.
function resolveValidatorBinary() {
  const exeName = process.platform === 'win32' ? 'validate_atf.exe' : 'validate_atf';
  const candidates = [
    process.env.VALIDATE_ATF_BIN,
    // Packaged: extraResources copies dist-validator/validator/ → resources/validator/
    path.join(process.resourcesPath || '', 'validator', exeName),
    // Dev: PyInstaller's `--distpath dist-validator` output
    path.join(APP_ROOT, 'dist-validator', 'validator', exeName),
    // Dev: PyInstaller's default output (when --distpath omitted)
    path.join(APP_ROOT, 'dist', 'validator', exeName),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let serverProcess = null;
let mainWindow = null;

function spawnServer(port) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(port),
  };
  const validatorBin = resolveValidatorBinary();
  if (validatorBin) {
    env.VALIDATE_ATF_BIN = validatorBin;
    console.log('[main] Using bundled validator:', validatorBin);
  } else if (isDev) {
    console.log('[main] No bundled validator — server.js will spawn system Python');
  }

  // process.execPath is electron.exe; with ELECTRON_RUN_AS_NODE=1 it behaves as node
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server!] ${d}`));
  child.on('exit', (code, signal) => {
    console.log(`[main] server exited (code=${code} signal=${signal})`);
    if (!app.isQuitting) app.quit();
  });
  return child;
}

// Wait for the server to be reachable. Resolves once a TCP connect to `port` succeeds.
function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const sock = net.connect(port, '127.0.0.1');
      let settled = false;
      sock.once('connect', () => { if (!settled) { settled = true; sock.destroy(); resolve(); } });
      sock.once('error', () => {
        if (settled) return;
        settled = true;
        sock.destroy();
        if (Date.now() > deadline) reject(new Error('Server did not start within timeout'));
        else setTimeout(tryConnect, 200);
      });
    };
    tryConnect();
  });
}

async function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Manuscript Scorer',
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open external links (eBL Fragmentarium etc.) in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    const port = await findFreePort();
    serverProcess = spawnServer(port);
    await waitForServer(port);
    await createMainWindow(port);
  } catch (err) {
    console.error('[main] startup failed:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // Quit on all platforms — this is a single-window app
  app.isQuitting = true;
  if (serverProcess) {
    try { serverProcess.kill(); } catch (_) {}
  }
  app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverProcess) {
    try { serverProcess.kill(); } catch (_) {}
  }
});
