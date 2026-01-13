// ===========================================
// GOOGLE DRIVE API MODULE
// ===========================================

// Configuration
const GDRIVE_SCOPES = 'https://www.googleapis.com/auth/drive';  // Full Drive access for folder browsing
const GDRIVE_DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
const APP_FOLDER_NAME = 'Manuscript Scorer';

// State
// Hardcoded Client ID - replace with your actual Client ID from Google Cloud Console
const DEFAULT_CLIENT_ID = '827505523626-319kbfpsfjmk8g7bdfb0v00rnffifprl.apps.googleusercontent.com';  // Paste your Client ID here, e.g., '123456789-abc.apps.googleusercontent.com'
let gdriveClientId = localStorage.getItem('gdrive_client_id') || DEFAULT_CLIENT_ID;
let gdriveAccessToken = localStorage.getItem('gdrive_access_token') || '';
let gdriveReady = false;
let gdriveTokenClient = null;
let pickerApiLoaded = false;
let appFolderId = null;
let currentProjectFolderId = null;

// UI Elements (set after DOM loads)
let gdriveBtn = null;
let gdriveIndicator = null;
let gdriveText = null;
let gdriveSetupModal = null;

// ===========================================
// INITIALIZATION
// ===========================================

// Initialize Google Drive integration
async function initGoogleDrive() {
  // Get UI elements
  gdriveBtn = document.getElementById('gdrive-btn');
  gdriveIndicator = document.getElementById('gdrive-indicator');
  gdriveText = document.getElementById('gdrive-text');
  gdriveSetupModal = document.getElementById('gdrive-setup-modal');

  // Setup button click handler
  if (gdriveBtn) {
    gdriveBtn.addEventListener('click', handleGdriveButtonClick);
  }

  // Setup modal handlers
  setupGdriveModal();

  // Wait for Google API to load
  if (typeof gapi === 'undefined') {
    console.log('Waiting for Google API to load...');
    await waitForGapi();
  }

  // Load the Google API client
  await loadGapiClient();

  // If we have a stored token, try to use it
  if (gdriveAccessToken && gdriveClientId) {
    console.log('Found stored token, validating...');
    try {
      gapi.client.setToken({ access_token: gdriveAccessToken });
      // Test the token with a simple request
      await gapi.client.drive.files.list({ pageSize: 1 });
      gdriveReady = true;
      console.log('Token valid, connected to Google Drive');
      updateGdriveStatus('connected', 'Connected');
      updateGdriveButton(true);
    } catch (err) {
      console.log('Stored token expired, will need to re-authenticate:', err.message);
      localStorage.removeItem('gdrive_access_token');
      gdriveAccessToken = '';
      updateGdriveStatus('', 'Not connected');
    }
  } else {
    console.log('No stored token or client ID found', { hasToken: !!gdriveAccessToken, hasClientId: !!gdriveClientId });
  }
}

// Wait for gapi to be available
function waitForGapi() {
  return new Promise((resolve) => {
    const check = () => {
      if (typeof gapi !== 'undefined') {
        resolve();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

// Load the Google API client library
async function loadGapiClient() {
  return new Promise((resolve, reject) => {
    gapi.load('client:picker', async () => {
      try {
        await gapi.client.init({
          discoveryDocs: [GDRIVE_DISCOVERY_DOC]
        });
        pickerApiLoaded = true;
        console.log('Google API client and Picker initialized');
        resolve();
      } catch (err) {
        console.error('Error initializing Google API client:', err);
        reject(err);
      }
    });
  });
}

// ===========================================
// AUTHENTICATION
// ===========================================

// Handle Google Drive button click
function handleGdriveButtonClick() {
  if (gdriveReady) {
    // Already connected - offer to disconnect
    if (confirm('Disconnect from Google Drive?')) {
      disconnectGoogleDrive();
    }
  } else if (!gdriveClientId) {
    // No client ID - show setup modal
    showGdriveSetupModal();
  } else {
    // Have client ID but not connected - start OAuth
    startGoogleAuth();
  }
}

// Show the setup modal
function showGdriveSetupModal() {
  if (gdriveSetupModal) {
    gdriveSetupModal.classList.remove('hidden');
    const input = document.getElementById('client-id-input');
    if (input) {
      input.value = gdriveClientId;
      input.focus();
    }
  }
}

// Setup modal event handlers
function setupGdriveModal() {
  const closeBtn = document.getElementById('close-gdrive-setup');
  const saveBtn = document.getElementById('save-client-id-btn');
  const input = document.getElementById('client-id-input');

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      gdriveSetupModal.classList.add('hidden');
    });
  }

  if (gdriveSetupModal) {
    gdriveSetupModal.addEventListener('click', (e) => {
      if (e.target === gdriveSetupModal) {
        gdriveSetupModal.classList.add('hidden');
      }
    });
  }

  if (saveBtn && input) {
    saveBtn.addEventListener('click', () => {
      const clientId = input.value.trim();
      if (clientId) {
        gdriveClientId = clientId;
        localStorage.setItem('gdrive_client_id', clientId);
        gdriveSetupModal.classList.add('hidden');
        startGoogleAuth();
      } else {
        alert('Please enter a valid Client ID');
      }
    });
  }

  if (input) {
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        saveBtn.click();
      }
    });
  }
}

// Start Google OAuth flow
function startGoogleAuth() {
  if (!gdriveClientId) {
    showGdriveSetupModal();
    return;
  }

  // Wait for Google Identity Services to load
  if (typeof google === 'undefined' || !google.accounts) {
    console.error('Google Identity Services not loaded');
    alert('Google authentication is not available. Please refresh the page.');
    return;
  }

  // Initialize token client
  gdriveTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: gdriveClientId,
    scope: GDRIVE_SCOPES,
    callback: handleAuthResponse
  });

  // Request access token
  updateGdriveStatus('syncing', 'Connecting...');
  gdriveTokenClient.requestAccessToken({ prompt: 'consent' });
}

// Handle OAuth response
function handleAuthResponse(response) {
  if (response.error) {
    console.error('Auth error:', response.error);
    updateGdriveStatus('error', 'Auth failed');
    return;
  }

  if (response.access_token) {
    gdriveAccessToken = response.access_token;
    localStorage.setItem('gdrive_access_token', gdriveAccessToken);
    gapi.client.setToken({ access_token: gdriveAccessToken });
    gdriveReady = true;
    updateGdriveButton(true);

    // Use exported setStatus so it can be intercepted by page scripts
    if (window.GDrive && window.GDrive.setStatus) {
      window.GDrive.setStatus('connected', 'Connected');
    } else {
      updateGdriveStatus('connected', 'Connected');
    }

    // Trigger reload of manuscripts from Drive
    if (typeof loadManuscriptsFromDrive === 'function') {
      loadManuscriptsFromDrive();
    }
  }
}

// Disconnect from Google Drive
function disconnectGoogleDrive() {
  gdriveAccessToken = '';
  gdriveReady = false;
  appFolderId = null;
  currentProjectFolderId = null;
  localStorage.removeItem('gdrive_access_token');

  if (gdriveTokenClient && google.accounts.oauth2.revoke) {
    google.accounts.oauth2.revoke(gdriveAccessToken);
  }

  updateGdriveStatus('', 'Not connected');
  updateGdriveButton(false);
}

// ===========================================
// UI UPDATES
// ===========================================

// Update the status indicator
function updateGdriveStatus(status, text) {
  if (gdriveIndicator) {
    gdriveIndicator.className = 'gdrive-indicator';
    if (status) {
      gdriveIndicator.classList.add(status);
    }
  }
  if (gdriveText) {
    gdriveText.textContent = text;
  }
}

// Update the button state
function updateGdriveButton(connected) {
  if (gdriveBtn) {
    if (connected) {
      gdriveBtn.textContent = 'Google Drive';
      gdriveBtn.classList.add('connected');
    } else {
      gdriveBtn.textContent = 'Connect Google Drive';
      gdriveBtn.classList.remove('connected');
    }
  }
}

// ===========================================
// FOLDER OPERATIONS
// ===========================================

// Get or create the app root folder
async function getOrCreateAppFolder() {
  if (appFolderId) return appFolderId;

  try {
    // Search for existing folder
    const response = await gapi.client.drive.files.list({
      q: `name='${APP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive'
    });

    if (response.result.files && response.result.files.length > 0) {
      appFolderId = response.result.files[0].id;
      return appFolderId;
    }

    // Create new folder
    const createResponse = await gapi.client.drive.files.create({
      resource: {
        name: APP_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder'
      },
      fields: 'id'
    });

    appFolderId = createResponse.result.id;
    return appFolderId;
  } catch (err) {
    console.error('Error getting/creating app folder:', err);
    throw err;
  }
}

// Get or create a project folder
async function getOrCreateProjectFolder(projectName) {
  const parentId = await getOrCreateAppFolder();

  try {
    // Search for existing project folder
    const response = await gapi.client.drive.files.list({
      q: `name='${projectName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive'
    });

    if (response.result.files && response.result.files.length > 0) {
      return response.result.files[0].id;
    }

    // Create new project folder
    const createResponse = await gapi.client.drive.files.create({
      resource: {
        name: projectName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      },
      fields: 'id'
    });

    return createResponse.result.id;
  } catch (err) {
    console.error('Error getting/creating project folder:', err);
    throw err;
  }
}

// ===========================================
// FILE OPERATIONS
// ===========================================

// List all projects in the app folder
async function listDriveProjects() {
  if (!gdriveReady) return [];

  try {
    const parentId = await getOrCreateAppFolder();
    const response = await gapi.client.drive.files.list({
      q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name, createdTime, modifiedTime)',
      orderBy: 'modifiedTime desc',
      spaces: 'drive'
    });

    return response.result.files || [];
  } catch (err) {
    console.error('Error listing projects:', err);
    return [];
  }
}

// List shared "Manuscript Scorer" folders (from other users)
async function listSharedAppFolders() {
  if (!gdriveReady) return [];

  try {
    // Search for shared folders named "Manuscript Scorer" that we don't own
    const response = await gapi.client.drive.files.list({
      q: `name='${APP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false and sharedWithMe=true`,
      fields: 'files(id, name, owners, createdTime, modifiedTime)',
      spaces: 'drive'
    });

    return response.result.files || [];
  } catch (err) {
    console.error('Error listing shared folders:', err);
    return [];
  }
}

// List projects inside a shared app folder
async function listSharedProjects(sharedFolderId) {
  if (!gdriveReady) return [];

  try {
    const response = await gapi.client.drive.files.list({
      q: `'${sharedFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name, createdTime, modifiedTime)',
      orderBy: 'modifiedTime desc',
      spaces: 'drive'
    });

    return response.result.files || [];
  } catch (err) {
    console.error('Error listing shared projects:', err);
    return [];
  }
}

// List manuscripts in a project folder
async function listDriveManuscripts(projectFolderId) {
  if (!gdriveReady) return [];

  try {
    const response = await gapi.client.drive.files.list({
      q: `'${projectFolderId}' in parents and name contains '.txt' and trashed=false`,
      fields: 'files(id, name, modifiedTime)',
      spaces: 'drive'
    });

    return response.result.files || [];
  } catch (err) {
    console.error('Error listing manuscripts:', err);
    return [];
  }
}

// Read a file from Drive
async function readDriveFile(fileId) {
  if (!gdriveReady) return null;

  try {
    const response = await gapi.client.drive.files.get({
      fileId: fileId,
      alt: 'media'
    });

    return response.body;
  } catch (err) {
    console.error('Error reading file:', err);
    return null;
  }
}

// Create or update a file in Drive
async function saveDriveFile(folderId, filename, content) {
  if (!gdriveReady) return null;

  try {
    // Check if file exists
    const searchResponse = await gapi.client.drive.files.list({
      q: `name='${filename}' and '${folderId}' in parents and trashed=false`,
      fields: 'files(id)',
      spaces: 'drive'
    });

    const existingFile = searchResponse.result.files && searchResponse.result.files[0];

    if (existingFile) {
      // Update existing file
      const response = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${existingFile.id}?uploadType=media`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${gdriveAccessToken}`,
            'Content-Type': 'text/plain; charset=utf-8'
          },
          body: content
        }
      );
      const result = await response.json();
      return result.id;
    } else {
      // Create new file using multipart upload
      const metadata = {
        name: filename,
        parents: [folderId],
        mimeType: 'text/plain'
      };

      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', new Blob([content], { type: 'text/plain; charset=utf-8' }));

      const response = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${gdriveAccessToken}`
          },
          body: form
        }
      );

      const result = await response.json();
      return result.id;
    }
  } catch (err) {
    console.error('Error saving file:', err);
    throw err;
  }
}

// Delete a file from Drive
async function deleteDriveFile(fileId) {
  if (!gdriveReady) return false;

  try {
    await gapi.client.drive.files.delete({
      fileId: fileId
    });
    return true;
  } catch (err) {
    console.error('Error deleting file:', err);
    return false;
  }
}

// Create a new project in Drive
async function createDriveProject(projectName) {
  if (!gdriveReady) return null;

  try {
    const folderId = await getOrCreateProjectFolder(projectName);

    // Create project.json with metadata
    const metadata = {
      name: projectName,
      created: new Date().toISOString()
    };

    await saveDriveFile(folderId, 'project.json', JSON.stringify(metadata, null, 2));

    return folderId;
  } catch (err) {
    console.error('Error creating project:', err);
    throw err;
  }
}

// Get project metadata
async function getDriveProjectConfig(projectFolderId) {
  if (!gdriveReady) return null;

  try {
    // Find project.json
    const response = await gapi.client.drive.files.list({
      q: `name='project.json' and '${projectFolderId}' in parents and trashed=false`,
      fields: 'files(id)',
      spaces: 'drive'
    });

    if (response.result.files && response.result.files.length > 0) {
      const content = await readDriveFile(response.result.files[0].id);
      return JSON.parse(content);
    }

    return null;
  } catch (err) {
    console.error('Error getting project config:', err);
    return null;
  }
}

// ===========================================
// FOLDER PICKER
// ===========================================

// Show Google Drive folder picker
function showFolderPicker() {
  return new Promise((resolve, reject) => {
    if (!pickerApiLoaded) {
      reject(new Error('Picker API not loaded'));
      return;
    }

    if (!gdriveAccessToken) {
      reject(new Error('Not authenticated'));
      return;
    }

    // Single view showing all folders (owned and shared)
    const view = new google.picker.DocsView()
      .setSelectFolderEnabled(true)
      .setIncludeFolders(true)
      .setMimeTypes('application/vnd.google-apps.folder');

    const picker = new google.picker.PickerBuilder()
      .setAppId(gdriveClientId.split('-')[0])  // Extract app ID from client ID
      .setOAuthToken(gdriveAccessToken)
      .addView(view)
      .setTitle('Select folder for project')
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          const folder = data.docs[0];
          resolve({
            id: folder.id,
            name: folder.name
          });
        } else if (data.action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();

    picker.setVisible(true);
  });
}

// Create a project in a specific folder (chosen by user)
async function createProjectInFolder(folderId, projectName) {
  if (!gdriveReady) return null;

  try {
    // Create project subfolder inside chosen folder
    const createResponse = await gapi.client.drive.files.create({
      resource: {
        name: projectName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [folderId]
      },
      fields: 'id'
    });

    const projectFolderId = createResponse.result.id;

    // Create project.json with metadata
    const metadata = {
      name: projectName,
      created: new Date().toISOString()
    };

    await saveDriveFile(projectFolderId, 'project.json', JSON.stringify(metadata, null, 2));

    return projectFolderId;
  } catch (err) {
    console.error('Error creating project in folder:', err);
    throw err;
  }
}

// List all folders (for browsing)
async function listFolders(parentId = 'root') {
  if (!gdriveReady) return [];

  try {
    const response = await gapi.client.drive.files.list({
      q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'name',
      spaces: 'drive'
    });

    return response.result.files || [];
  } catch (err) {
    console.error('Error listing folders:', err);
    return [];
  }
}

// ===========================================
// EXPORTS (for use in app.js)
// ===========================================

window.GDrive = {
  init: initGoogleDrive,
  isReady: () => gdriveReady,
  getClientId: () => gdriveClientId,
  setStatus: updateGdriveStatus,

  // Projects
  listProjects: listDriveProjects,
  createProject: createDriveProject,
  getProjectConfig: getDriveProjectConfig,
  getOrCreateProjectFolder: getOrCreateProjectFolder,

  // Shared projects
  listSharedAppFolders: listSharedAppFolders,
  listSharedProjects: listSharedProjects,

  // Folder picker
  showFolderPicker: showFolderPicker,
  createProjectInFolder: createProjectInFolder,
  listFolders: listFolders,

  // Files
  listManuscripts: listDriveManuscripts,
  readFile: readDriveFile,
  saveFile: saveDriveFile,
  deleteFile: deleteDriveFile
};
