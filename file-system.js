// ===========================================
// FILE SYSTEM ACCESS API + INDEXEDDB STORAGE
// ===========================================
// This module handles persistent folder access for GitHub Pages deployment.
// It stores folder handles in IndexedDB so users only need to grant permission once.

const DB_NAME = 'ManuscriptScorerDB';
const DB_VERSION = 1;
const STORE_NAME = 'folderHandles';

// ===========================================
// INDEXEDDB HELPERS
// ===========================================

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

async function saveHandle(id, handle, metadata = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ id, handle, ...metadata, savedAt: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getHandle(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllHandles() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function deleteHandle(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ===========================================
// FILE SYSTEM ACCESS API HELPERS
// ===========================================

// Check if File System Access API is supported
function isFileSystemAccessSupported() {
  return 'showDirectoryPicker' in window;
}

// Request permission for a stored handle
async function requestPermission(handle, mode = 'readwrite') {
  const options = { mode };

  // Check current permission state
  if ((await handle.queryPermission(options)) === 'granted') {
    return true;
  }

  // Request permission (requires user gesture)
  if ((await handle.requestPermission(options)) === 'granted') {
    return true;
  }

  return false;
}

// Verify a handle is still valid and has permission
async function verifyHandle(handle) {
  try {
    // Try to query permission - this will fail if handle is invalid
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    return permission === 'granted' || permission === 'prompt';
  } catch (e) {
    return false;
  }
}

// ===========================================
// PROJECT FILE OPERATIONS
// ===========================================

// Read project.json from a folder handle
async function readProjectConfig(dirHandle) {
  try {
    const configHandle = await dirHandle.getFileHandle('project.json');
    const file = await configHandle.getFile();
    const content = await file.text();
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

// Write project.json to a folder handle
async function writeProjectConfig(dirHandle, config) {
  const configHandle = await dirHandle.getFileHandle('project.json', { create: true });
  const writable = await configHandle.createWritable();
  await writable.write(JSON.stringify(config, null, 2));
  await writable.close();
}

// Read index.json from manuscripts folder
async function readManuscriptIndex(dirHandle) {
  try {
    const msHandle = await dirHandle.getDirectoryHandle('manuscripts');
    const indexHandle = await msHandle.getFileHandle('index.json');
    const file = await indexHandle.getFile();
    const content = await file.text();
    return JSON.parse(content);
  } catch (e) {
    return [];
  }
}

// Write index.json to manuscripts folder
async function writeManuscriptIndex(dirHandle, sigla) {
  const msHandle = await dirHandle.getDirectoryHandle('manuscripts', { create: true });
  const indexHandle = await msHandle.getFileHandle('index.json', { create: true });
  const writable = await indexHandle.createWritable();
  await writable.write(JSON.stringify(sigla, null, 2));
  await writable.close();
}

// Read a manuscript file
async function readManuscript(dirHandle, siglum) {
  try {
    const msHandle = await dirHandle.getDirectoryHandle('manuscripts');
    const fileHandle = await msHandle.getFileHandle(`${siglum}.txt`);
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (e) {
    console.error(`Failed to read manuscript ${siglum}:`, e);
    return null;
  }
}

// Write a manuscript file
async function writeManuscript(dirHandle, siglum, content) {
  const msHandle = await dirHandle.getDirectoryHandle('manuscripts', { create: true });
  const fileHandle = await msHandle.getFileHandle(`${siglum}.txt`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

// Delete a manuscript file
async function deleteManuscript(dirHandle, siglum) {
  try {
    const msHandle = await dirHandle.getDirectoryHandle('manuscripts');
    await msHandle.removeEntry(`${siglum}.txt`);
    return true;
  } catch (e) {
    console.error(`Failed to delete manuscript ${siglum}:`, e);
    return false;
  }
}

// Read score.txt
async function readScore(dirHandle) {
  try {
    const fileHandle = await dirHandle.getFileHandle('score.txt');
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (e) {
    return null;
  }
}

// Write score.txt
async function writeScore(dirHandle, content) {
  const fileHandle = await dirHandle.getFileHandle('score.txt', { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

// Read score-data.json (reconstructed text and translations)
async function readScoreData(dirHandle) {
  try {
    const fileHandle = await dirHandle.getFileHandle('score-data.json');
    const file = await fileHandle.getFile();
    const content = await file.text();
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

// Write score-data.json (reconstructed text and translations)
async function writeScoreData(dirHandle, data) {
  const fileHandle = await dirHandle.getFileHandle('score-data.json', { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(data, null, 2));
  await writable.close();
}

// List all .txt files in a folder (root or manuscripts subfolder)
async function listTxtFiles(dirHandle) {
  const txtFiles = [];
  let hasManuscriptsFolder = false;

  // Check root folder
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'directory' && entry.name === 'manuscripts') {
      hasManuscriptsFolder = true;
    }
    if (entry.kind === 'file' && entry.name.endsWith('.txt') && entry.name !== 'score.txt') {
      txtFiles.push(entry.name.replace('.txt', ''));
    }
  }

  // If manuscripts folder exists, use that instead
  if (hasManuscriptsFolder) {
    txtFiles.length = 0;
    const msHandle = await dirHandle.getDirectoryHandle('manuscripts');
    for await (const entry of msHandle.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.txt')) {
        txtFiles.push(entry.name.replace('.txt', ''));
      }
    }
  }

  return { txtFiles, hasManuscriptsFolder };
}

// Initialize a folder as a project (create structure if needed)
async function initializeProject(dirHandle, projectName) {
  // Check what exists
  let hasProjectJson = false;
  let hasManuscriptsFolder = false;
  const rootTxtFiles = [];

  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file' && entry.name === 'project.json') {
      hasProjectJson = true;
    }
    if (entry.kind === 'directory' && entry.name === 'manuscripts') {
      hasManuscriptsFolder = true;
    }
    if (entry.kind === 'file' && entry.name.endsWith('.txt') && entry.name !== 'score.txt') {
      rootTxtFiles.push(entry.name);
    }
  }

  // Create manuscripts folder if needed
  const msHandle = await dirHandle.getDirectoryHandle('manuscripts', { create: true });

  // If no manuscripts folder existed, copy .txt files from root
  if (!hasManuscriptsFolder && rootTxtFiles.length > 0) {
    for (const fileName of rootTxtFiles) {
      const srcHandle = await dirHandle.getFileHandle(fileName);
      const file = await srcHandle.getFile();
      const content = await file.text();

      const destHandle = await msHandle.getFileHandle(fileName, { create: true });
      const writable = await destHandle.createWritable();
      await writable.write(content);
      await writable.close();
    }
  }

  // Get final list of manuscripts
  const sigla = [];
  for await (const entry of msHandle.values()) {
    if (entry.kind === 'file' && entry.name.endsWith('.txt')) {
      sigla.push(entry.name.replace('.txt', ''));
    }
  }

  // Create/update project.json
  let config = {};
  if (hasProjectJson) {
    config = await readProjectConfig(dirHandle) || {};
  }
  config.name = projectName;
  if (!config.created) {
    config.created = new Date().toISOString();
  }
  await writeProjectConfig(dirHandle, config);

  // Create/update index.json
  await writeManuscriptIndex(dirHandle, sigla);

  return { config, sigla };
}

// ===========================================
// PROJECT MANAGEMENT
// ===========================================

// Save a project folder handle to IndexedDB
async function saveProject(projectId, dirHandle, name) {
  await saveHandle(projectId, dirHandle, { name, type: 'project' });
}

// Get all saved projects
async function getSavedProjects() {
  const handles = await getAllHandles();
  const projects = [];

  for (const item of handles) {
    if (item.type === 'project' && item.handle) {
      // Verify the handle is still valid
      const isValid = await verifyHandle(item.handle);
      if (isValid) {
        projects.push({
          id: item.id,
          name: item.name,
          handle: item.handle,
          savedAt: item.savedAt
        });
      }
    }
  }

  return projects;
}

// Remove a project from IndexedDB
async function removeProject(projectId) {
  await deleteHandle(projectId);
}

// Generate a unique project ID
function generateProjectId() {
  return 'project-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// ===========================================
// EXPORTS (attach to window for use in HTML)
// ===========================================

window.FileSystem = {
  // Feature detection
  isSupported: isFileSystemAccessSupported,

  // Permission management
  requestPermission,
  verifyHandle,

  // Project management
  saveProject,
  getSavedProjects,
  removeProject,
  generateProjectId,

  // File operations
  readProjectConfig,
  writeProjectConfig,
  readManuscriptIndex,
  writeManuscriptIndex,
  readManuscript,
  writeManuscript,
  deleteManuscript,
  readScore,
  writeScore,
  readScoreData,
  writeScoreData,
  listTxtFiles,
  initializeProject,

  // Low-level handle storage
  saveHandle,
  getHandle,
  getAllHandles,
  deleteHandle
};
