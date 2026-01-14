// ===========================================
// PROJECT CONFIGURATION
// ===========================================

// Get project from sessionStorage (set by index.html)
const projectId = sessionStorage.getItem('currentProjectId');

// Redirect to index if no project specified
if (!projectId) {
  window.location.href = 'index.html';
}

// Directory handle for file operations (loaded in init)
let dirHandle = null;

// ===========================================
// COLLABORATION SETUP (Y.js)
// ===========================================

// Y.js document and provider
let ydoc = null;
let provider = null;
let yManuscripts = null;  // Y.Map for manuscript content
let yReconstructed = null; // Y.Map for reconstructed lines
let awareness = null;

// User info
const userColors = ['#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3', '#00bcd4', '#009688', '#4caf50', '#ff9800', '#ff5722'];
const currentUser = {
  id: Math.random().toString(36).substr(2, 9),
  name: localStorage.getItem('user_name') || `User-${Math.random().toString(36).substr(2, 4)}`,
  color: userColors[Math.floor(Math.random() * userColors.length)]
};

// Initialize collaboration
function initCollaboration() {
  // Check if collaboration is enabled and Y.js is available
  if (!window.COLLAB_ENABLED || typeof Y === 'undefined') {
    console.log('Collaboration disabled (Y.js not available)');
    updateConnectionStatus('offline');
    return;
  }

  // Create Y.js document
  ydoc = new Y.Doc();

  // Shared data structures
  yManuscripts = ydoc.getMap('manuscripts');
  yReconstructed = ydoc.getMap('reconstructed');

  // Get room name from project ID
  const roomName = `manuscript-scorer-${projectId}`;

  // Connect to WebSocket server
  const wsUrl = `ws://${window.location.host}?room=${roomName}`;
  provider = new Y_WEBSOCKET.WebsocketProvider(wsUrl, roomName, ydoc);

  awareness = provider.awareness;

  // Set local user state
  awareness.setLocalStateField('user', currentUser);

  // Connection status
  provider.on('status', ({ status }) => {
    updateConnectionStatus(status);
  });

  // Awareness updates (other users)
  awareness.on('change', () => {
    updateUserAvatars();
  });

  // Listen for remote changes to manuscripts
  yManuscripts.observe((event) => {
    event.changes.keys.forEach((change, key) => {
      if (change.action === 'add' || change.action === 'update') {
        const data = yManuscripts.get(key);
        if (data) {
          const isNew = !manuscripts[key];
          manuscripts[key] = {
            siglum: data.siglum,
            content: data.content
          };
          // Add to sidebar if new
          if (isNew && !document.querySelector(`[data-id="${key}"]`)) {
            addManuscriptToList(key, data.siglum);
          }
          // Update editor if this is the active manuscript
          if (key === activeManuscript && document.activeElement !== editor) {
            editor.innerText = data.content;
          }
          renderScore();
        }
      }
    });
  });

  // Listen for remote changes to reconstructed lines
  yReconstructed.observe(() => {
    yReconstructed.forEach((value, key) => {
      reconstructedLines[key] = value;
    });
    renderScore();
  });

  console.log(`Collaboration initialized for room: ${roomName}`);
}

// Update connection status UI
function updateConnectionStatus(status) {
  const indicator = document.getElementById('connection-indicator');
  const userCount = document.getElementById('user-count');

  if (!indicator || !userCount) return;

  indicator.className = 'connection-indicator ' + status;

  if (status === 'connected' && awareness) {
    const users = Array.from(awareness.getStates().values()).length;
    userCount.textContent = `${users} online`;
  } else if (status === 'connecting') {
    userCount.textContent = 'Connecting...';
  } else {
    userCount.textContent = 'Offline';
  }
}

// Update user avatars
function updateUserAvatars() {
  const container = document.getElementById('user-avatars');
  if (!container || !awareness) return;

  const states = Array.from(awareness.getStates().values());

  container.innerHTML = states
    .filter(state => state.user && state.user.id !== currentUser.id)
    .slice(0, 5)
    .map(state => `
      <div class="user-avatar" style="background: ${state.user.color}" title="${state.user.name}">
        ${state.user.name.charAt(0).toUpperCase()}
      </div>
    `).join('');

  // Update user count
  const userCount = document.getElementById('user-count');
  userCount.textContent = `${states.length} online`;
}

// Sync manuscript to Y.js (call this when content changes)
function syncManuscriptToYjs(id) {
  if (!yManuscripts || !manuscripts[id]) return;

  const ms = manuscripts[id];
  yManuscripts.set(id, {
    siglum: ms.siglum,
    content: ms.content
  });
}

// Sync reconstructed line to Y.js
function syncReconstructedToYjs(lineNum, text) {
  if (!yReconstructed) return;
  yReconstructed.set(String(lineNum), text);
}

// ===========================================
// STATUS INDICATOR
// ===========================================

function setStatus(status, text) {
  const indicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');

  if (indicator) {
    indicator.className = 'gdrive-indicator';
    if (status === 'connected' || status === 'saved') {
      indicator.classList.add('connected');
    } else if (status === 'syncing' || status === 'saving') {
      indicator.classList.add('syncing');
    } else if (status === 'error') {
      indicator.classList.add('error');
    }
  }

  if (statusText && text) {
    statusText.textContent = text;
  }
}

// ===========================================
// ORIGINAL APP CODE (with collaboration hooks)
// ===========================================

// Data store
const manuscripts = {};
let activeManuscript = null;
const reconstructedLines = {}; // Store editable reconstructed text for each line
const translationLines = {}; // Store editable translation for each line
let siglaMappings = {}; // Museum number -> Siglum (from project config)
let showSigla = localStorage.getItem('show_sigla') === 'true'; // Toggle state

// Load manuscripts from local folder via FileSystem API
async function loadManuscripts() {
  try {
    setStatus('syncing', 'Loading...');

    // Load project config from folder
    const config = await FileSystem.readProjectConfig(dirHandle);
    if (config) {
      document.getElementById('project-title').textContent = config.name;
      document.title = `${config.name} - Manuscript Scorer`;
      siglaMappings = config.sigla || {};
    }

    // Load manuscript index
    const fileNames = await FileSystem.readManuscriptIndex(dirHandle);
    if (!fileNames || fileNames.length === 0) {
      setEditorContent('No manuscripts yet. Click "+ Add" to create one.');
      setStatus('connected', 'Ready');
      return;
    }

    // Load each manuscript
    for (const fileName of fileNames) {
      const content = await FileSystem.readManuscript(dirHandle, fileName);
      if (content !== null) {
        const id = `ms-${fileName.toLowerCase()}`;

        manuscripts[id] = {
          siglum: fileName,
          displaySiglum: siglaMappings[fileName] || null,
          content
        };

        addManuscriptToList(id, fileName);
      }
    }

    // Update toggle button state
    updateSiglaToggle();

    // Select first manuscript
    const firstId = Object.keys(manuscripts)[0];
    if (firstId) {
      loadManuscript(firstId);
    } else {
      setEditorContent('No manuscripts yet. Click "+ Add" to create one.');
    }

    setStatus('connected', 'Ready');
  } catch (err) {
    console.error('Failed to load manuscripts:', err);
    setStatus('error', 'Load failed');
    setEditorContent('Failed to load manuscripts. Check folder permissions.');
  }
}

// Add manuscript to sidebar list
function addManuscriptToList(id, museumNum) {
  const li = document.createElement('li');
  li.className = 'manuscript-item';
  li.dataset.id = id;
  li.dataset.museum = museumNum;

  const displaySiglum = siglaMappings[museumNum];

  // Create spans for both display modes
  const siglumSpan = document.createElement('span');
  siglumSpan.className = 'siglum';
  siglumSpan.textContent = displaySiglum || museumNum;

  const museumSpan = document.createElement('span');
  museumSpan.className = 'museum-number';
  museumSpan.textContent = displaySiglum ? museumNum : '';

  li.appendChild(siglumSpan);
  li.appendChild(museumSpan);

  // Update visibility based on toggle state
  updateManuscriptItemDisplay(li);

  manuscriptList.appendChild(li);
}

// Update single manuscript item display based on toggle
function updateManuscriptItemDisplay(li) {
  const museumNum = li.dataset.museum;
  const displaySiglum = siglaMappings[museumNum];
  const siglumSpan = li.querySelector('.siglum');
  const museumSpan = li.querySelector('.museum-number');

  if (showSigla && displaySiglum) {
    // Show siglum as main, museum number as secondary
    siglumSpan.textContent = displaySiglum;
    museumSpan.textContent = museumNum;
  } else {
    // Show museum number only
    siglumSpan.textContent = museumNum;
    museumSpan.textContent = '';
  }
}

// Update all manuscript items display
function updateAllManuscriptDisplays() {
  document.querySelectorAll('.manuscript-item').forEach(updateManuscriptItemDisplay);
}

// Update toggle button state
function updateSiglaToggle() {
  const btn = document.getElementById('toggle-siglum-btn');
  if (!btn) return;

  // Check if any mappings exist
  const hasMappings = Object.keys(siglaMappings).length > 0;
  btn.style.display = hasMappings ? 'block' : 'none';

  if (showSigla) {
    btn.classList.add('active');
    btn.textContent = 'Sig';
    btn.title = 'Showing sigla - click to show museum numbers';
  } else {
    btn.classList.remove('active');
    btn.textContent = 'M#';
    btn.title = 'Showing museum numbers - click to show sigla';
  }
}

// Setup siglum toggle
function setupSiglaToggle() {
  const btn = document.getElementById('toggle-siglum-btn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    showSigla = !showSigla;
    localStorage.setItem('show_sigla', showSigla);
    updateSiglaToggle();
    updateAllManuscriptDisplays();
  });
}

// Setup resizable panes
function setupPaneResizer() {
  const resizer = document.getElementById('pane-resizer');
  const editorPane = document.querySelector('.editor-pane');
  const scorePane = document.querySelector('.score-pane');
  const workArea = document.querySelector('.work-area');

  if (!resizer || !editorPane || !scorePane || !workArea) return;

  let isResizing = false;
  let startX = 0;
  let startEditorWidth = 0;

  // Load saved ratio
  const savedRatio = localStorage.getItem('pane_ratio');
  if (savedRatio) {
    const ratio = parseFloat(savedRatio);
    editorPane.style.flex = `0 0 ${ratio * 100}%`;
    scorePane.style.flex = `1 1 auto`;
  }

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startEditorWidth = editorPane.getBoundingClientRect().width;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    const workAreaRect = workArea.getBoundingClientRect();
    const sidebarWidth = document.querySelector('.manuscript-list').getBoundingClientRect().width;
    const availableWidth = workAreaRect.width - sidebarWidth - resizer.offsetWidth;

    const deltaX = e.clientX - startX;
    let newEditorWidth = startEditorWidth + deltaX;

    // Constrain to min/max
    const minWidth = 200;
    const maxWidth = availableWidth - minWidth;
    newEditorWidth = Math.max(minWidth, Math.min(maxWidth, newEditorWidth));

    const ratio = newEditorWidth / availableWidth;
    editorPane.style.flex = `0 0 ${ratio * 100}%`;
    scorePane.style.flex = `1 1 auto`;
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;

    isResizing = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // Save the ratio
    const workAreaRect = workArea.getBoundingClientRect();
    const sidebarWidth = document.querySelector('.manuscript-list').getBoundingClientRect().width;
    const availableWidth = workAreaRect.width - sidebarWidth - resizer.offsetWidth;
    const ratio = editorPane.getBoundingClientRect().width / availableWidth;
    localStorage.setItem('pane_ratio', ratio.toString());
  });
}

// DOM elements
const editorContainer = document.getElementById('editor');
const scorePanel = document.getElementById('score');
const manuscriptList = document.getElementById('manuscript-list');
const addManuscriptBtn = document.getElementById('add-manuscript-btn');
const exportBtn = document.getElementById('export-btn');
const searchAllBtn = document.getElementById('search-all-btn');

// Initialize Ace Editor
let aceEditor = null;
function initAceEditor() {
  aceEditor = ace.edit('editor');
  aceEditor.setTheme('ace/theme/chrome');
  aceEditor.session.setMode('ace/mode/text');
  aceEditor.setOptions({
    fontSize: '14px',
    fontFamily: '"Consolas", "Monaco", monospace',
    showPrintMargin: false,
    showGutter: false,  // Hide line numbers
    wrap: true,
    tabSize: 2,
    useSoftTabs: true
  });

  // Enable search box extension
  ace.require('ace/ext/searchbox');

  // Handle changes
  aceEditor.session.on('change', () => {
    saveCurrentManuscript();
    syncManuscriptToYjs(activeManuscript);
    renderScore();
    debouncedSave();
  });

  return aceEditor;
}

// Getter for editor content (compatibility layer)
function getEditorContent() {
  return aceEditor ? aceEditor.getValue() : '';
}

// Setter for editor content
function setEditorContent(content) {
  if (aceEditor) {
    aceEditor.setValue(content, -1); // -1 moves cursor to start
  }
}

// Parse a manuscript text and extract scored lines
function parseManuscript(siglum, text) {
  const lines = text.split('\n');
  const entries = [];
  let currentSurface = '';
  let lastEntry = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check for surface markers (with @ prefix)
    if (/^@(obverse|reverse|edge|left edge|right edge|top|bottom|colophon)/i.test(trimmed)) {
      currentSurface = trimmed.substring(1).toLowerCase();
      continue;
    }

    // Check for ruling markers: $ single ruling, $ double ruling, etc.
    if (/^\$\s*(single|double|triple)?\s*ruling/i.test(trimmed)) {
      entries.push({
        siglum,
        type: 'ruling',
        rulingType: trimmed.match(/single|double|triple/i)?.[0]?.toLowerCase() || 'single',
        surface: currentSurface
      });
      continue;
    }

    // Check for tablet feature comments: $ rest of tablet blank, etc.
    if (/^\$\s+/.test(trimmed) && !/ruling/i.test(trimmed)) {
      entries.push({
        siglum,
        type: 'comment',
        content: trimmed.substring(1).trim(),
        surface: currentSurface
      });
      continue;
    }

    // Check for parallel line markers: // F K.3547 r 20'
    if (/^\/\/\s+/.test(trimmed)) {
      const parallelContent = trimmed.substring(2).trim();
      if (lastEntry && lastEntry.type !== 'ruling' && lastEntry.type !== 'comment') {
        if (!lastEntry.parallels) {
          lastEntry.parallels = [];
        }
        lastEntry.parallels.push(parallelContent);
      }
      continue;
    }

    // Check for continuation lines: ($___$) or leading whitespace indicating continuation
    const continuationMatch = trimmed.match(/^\(\$___\$\)\s*(.*)$/);
    if (continuationMatch) {
      if (lastEntry && lastEntry.type !== 'ruling' && lastEntry.type !== 'comment') {
        lastEntry.continuation = lastEntry.continuation || [];
        lastEntry.continuation.push(continuationMatch[1].trim());
      }
      continue;
    }

    // Check for §[target] [source]. pattern - supports primed numbers like 1', 2'
    const match = trimmed.match(/^§(\d+)\s+(\d+'?)\.\s*(.*)$/);
    if (match) {
      const targetLine = parseInt(match[1], 10);
      const sourceLine = match[2].trim();
      const content = match[3].trim();

      const entry = {
        siglum,
        type: 'line',
        targetLine,
        sourceLine,
        surface: currentSurface,
        content,
        parallels: [],
        continuation: []
      };
      entries.push(entry);
      lastEntry = entry;
      continue;
    }

    // Also support old format: §[target] [source]. with non-numeric source
    const oldMatch = trimmed.match(/^§(\d+)\s+([^.]+)\.\s*(.*)$/);
    if (oldMatch) {
      const targetLine = parseInt(oldMatch[1], 10);
      const sourceLine = oldMatch[2].trim();
      const content = oldMatch[3].trim();

      const entry = {
        siglum,
        type: 'line',
        targetLine,
        sourceLine,
        surface: currentSurface,
        content,
        parallels: [],
        continuation: []
      };
      entries.push(entry);
      lastEntry = entry;
    }
  }

  return entries;
}

// Build the synoptic score from all manuscripts
function buildScore() {
  const allEntries = [];

  // Parse all manuscripts
  for (const ms of Object.values(manuscripts)) {
    const entries = parseManuscript(ms.siglum, ms.content);
    allEntries.push(...entries);
  }

  // Group by target line (only for 'line' type entries)
  // Rulings and comments are stored separately
  const scoreLines = {};
  const rulings = [];
  const comments = [];

  for (const entry of allEntries) {
    if (entry.type === 'ruling') {
      rulings.push(entry);
    } else if (entry.type === 'comment') {
      comments.push(entry);
    } else if (entry.type === 'line') {
      if (!scoreLines[entry.targetLine]) {
        scoreLines[entry.targetLine] = [];
      }
      scoreLines[entry.targetLine].push(entry);
    }
  }

  return { scoreLines, rulings, comments };
}

// Render the score panel
function renderScore() {
  const { scoreLines } = buildScore();
  const sortedLineNumbers = Object.keys(scoreLines).map(Number).sort((a, b) => a - b);

  if (sortedLineNumbers.length === 0) {
    scorePanel.innerHTML = '<div class="score-empty">No scored lines yet. Use §[line] [source]. to add lines.</div>';
    return;
  }

  let html = '';
  for (const lineNum of sortedLineNumbers) {
    const witnesses = scoreLines[lineNum];

    // Get translation and reconstructed text or default to empty
    const translation = translationLines[lineNum] || '';
    const reconstructed = reconstructedLines[lineNum] || '';

    html += `<div class="score-line">`;
    // Translation line (above reconstructed)
    html += `<div class="translation-line"><span class="translation-text" contenteditable="true" data-line="${lineNum}">${escapeHtml(translation)}</span></div>`;
    html += `<div class="score-line-header"><span class="line-label">§ ${lineNum}</span> <span class="reconstructed-text" contenteditable="true" data-line="${lineNum}">${escapeHtml(reconstructed)}</span></div>`;

    for (const w of witnesses) {
      const ref = `${w.siglum} ${abbreviateSurface(w.surface)} ${w.sourceLine}`;
      html += `<div class="score-witness">`;
      html += `<span class="witness-siglum">${escapeHtml(ref)}</span>`;
      html += `<span class="witness-text">${escapeHtml(w.content)}</span>`;
      html += `</div>`;

      // Render continuation lines if any
      if (w.continuation && w.continuation.length > 0) {
        for (const cont of w.continuation) {
          html += `<div class="score-witness continuation">`;
          html += `<span class="witness-siglum"></span>`;
          html += `<span class="witness-text">${escapeHtml(cont)}</span>`;
          html += `</div>`;
        }
      }

      // Render parallels if any (expandable)
      if (w.parallels && w.parallels.length > 0) {
        html += `<details class="parallels-section">`;
        html += `<summary class="parallels-header">// ${w.parallels.length} parallel(s)</summary>`;
        for (const parallel of w.parallels) {
          html += `<div class="parallel-line">// ${escapeHtml(parallel)}</div>`;
        }
        html += `</details>`;
      }
    }

    html += `</div>`;
  }

  scorePanel.innerHTML = html;

  // Add event listeners for translation editing
  scorePanel.querySelectorAll('.translation-text').forEach(el => {
    el.addEventListener('input', (e) => {
      const lineNum = e.target.dataset.line;
      translationLines[lineNum] = e.target.innerText;
      debouncedSave();
    });
  });

  // Add event listeners for reconstructed text editing
  scorePanel.querySelectorAll('.reconstructed-text').forEach(el => {
    el.addEventListener('input', (e) => {
      const lineNum = e.target.dataset.line;
      reconstructedLines[lineNum] = e.target.innerText;
      syncReconstructedToYjs(lineNum, e.target.innerText); // Sync to collaborators
      debouncedSave();
    });
  });
}

// Parse colophons from all manuscripts
// Once @colophon is encountered, ALL subsequent lines are part of the colophon
// (including content after @reverse or other surface markers)
function parseColophons() {
  const colophons = [];

  for (const [id, ms] of Object.entries(manuscripts)) {
    const lines = ms.content.split('\n');
    let inColophon = false;
    let colophonLines = [];
    let currentSurface = 'o'; // Default to obverse

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Track current surface (before colophon starts)
      if (/^@obverse/i.test(trimmed)) {
        currentSurface = 'o';
        if (!inColophon) continue;
      }
      if (/^@reverse/i.test(trimmed)) {
        currentSurface = 'r';
        if (!inColophon) continue;
      }
      if (/^@(edge|left edge)/i.test(trimmed)) {
        currentSurface = 'le';
        if (!inColophon) continue;
      }
      if (/^@right edge/i.test(trimmed)) {
        currentSurface = 're';
        if (!inColophon) continue;
      }
      if (/^@(top|bottom)/i.test(trimmed)) {
        currentSurface = trimmed.match(/@(\w+)/i)[1].charAt(0);
        if (!inColophon) continue;
      }

      // Check for @colophon marker - everything after this is colophon
      if (/^@colophon/i.test(trimmed)) {
        inColophon = true;
        colophonLines = [];
        continue;
      }

      // Skip other @ markers within colophon (they just update surface)
      if (inColophon && /^@/i.test(trimmed)) {
        continue;
      }

      // Collect colophon lines (skip empty lines, $ lines, and comments)
      if (inColophon && trimmed && !trimmed.startsWith('$') && !trimmed.startsWith('//')) {
        // Extract line number if present (e.g., "1. text" or "1'. text")
        const lineMatch = trimmed.match(/^(\d+'?)\.\s*(.*)$/);
        if (lineMatch) {
          colophonLines.push({
            num: lineMatch[1],
            text: lineMatch[2],
            surface: currentSurface
          });
        } else if (!trimmed.startsWith('§')) {
          // Plain text line without number
          colophonLines.push({
            num: '',
            text: trimmed,
            surface: currentSurface
          });
        }
      }
    }

    // Handle colophon at end of file
    if (inColophon && colophonLines.length > 0) {
      colophons.push({
        siglum: ms.siglum,
        id: id,
        lines: colophonLines
      });
    }
  }

  return colophons;
}

// Render colophons panel
function renderColophons() {
  const colophonsPanel = document.getElementById('colophons');
  if (!colophonsPanel) return;

  const colophons = parseColophons();

  if (colophons.length === 0) {
    colophonsPanel.innerHTML = '<div class="colophons-empty">No colophons found. Use @colophon in manuscripts to mark colophon sections.</div>';
    return;
  }

  let html = '';
  for (const col of colophons) {
    html += `<div class="colophon-entry">`;
    html += `<div class="colophon-header">${escapeHtml(col.siglum)}</div>`;
    html += `<div class="colophon-lines">`;

    for (const line of col.lines) {
      // Format: "surface linenum" (e.g., "o 1" or "r 2'")
      const ref = line.num ? `${line.surface} ${line.num}` : line.surface;
      html += `<div class="colophon-line">`;
      html += `<span class="colophon-line-num">${escapeHtml(ref)}</span>`;
      html += `<span class="colophon-line-text">${escapeHtml(line.text)}</span>`;
      html += `</div>`;
    }

    html += `</div>`;
    html += `</div>`;
  }

  colophonsPanel.innerHTML = html;
}

// Setup tab switching
function setupTabs() {
  const tabs = document.querySelectorAll('.pane-tab');
  const contents = document.querySelectorAll('.tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;

      // Update active tab
      tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === targetTab));

      // Update visible content
      contents.forEach(c => c.classList.toggle('active', c.dataset.tab === targetTab));

      // Render colophons when switching to that tab
      if (targetTab === 'colophons') {
        renderColophons();
      }
    });
  });
}

// Abbreviate surface names
function abbreviateSurface(surface) {
  const abbrevs = {
    'obverse': 'o',
    'reverse': 'r',
    'left edge': 'le',
    'right edge': 're',
    'top': 't',
    'bottom': 'b',
    'edge': 'e',
    'colophon': 'col'
  };
  return abbrevs[surface] || surface;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Save editor content to current manuscript (in memory)
function saveCurrentManuscript() {
  if (activeManuscript && manuscripts[activeManuscript]) {
    manuscripts[activeManuscript].content = getEditorContent();
  }
}

// Save manuscript to local folder via FileSystem API
async function saveToFile(id) {
  const ms = manuscripts[id];
  if (!ms || !dirHandle) return;

  try {
    setStatus('syncing', 'Saving...');

    await FileSystem.writeManuscript(dirHandle, ms.siglum, ms.content);
    console.log(`Saved ${ms.siglum}.txt`);
    setStatus('connected', 'Saved');
    await updateManuscriptIndex();
  } catch (err) {
    console.error('Save error:', err);
    setStatus('error', 'Save failed');
  }
}

// Update the manuscripts index.json
async function updateManuscriptIndex() {
  if (!dirHandle) return;
  const sigla = Object.values(manuscripts).map(ms => ms.siglum);
  try {
    await FileSystem.writeManuscriptIndex(dirHandle, sigla);
  } catch (err) {
    console.error('Failed to update index:', err);
  }
}

// Debounced auto-save
let saveTimeout = null;
function debouncedSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    if (activeManuscript) {
      await saveToFile(activeManuscript);
    }
    await saveScoreToFile();
    await saveScoreDataToFile();
  }, 1000); // Save 1 second after last edit
}

// Save score data (reconstructed text and translations) to local folder
async function saveScoreDataToFile() {
  if (!dirHandle) return;

  // Only save if there's data
  const hasReconstructed = Object.keys(reconstructedLines).length > 0;
  const hasTranslations = Object.keys(translationLines).length > 0;
  if (!hasReconstructed && !hasTranslations) return;

  try {
    const data = {
      reconstructed: reconstructedLines,
      translations: translationLines,
      savedAt: new Date().toISOString()
    };
    await FileSystem.writeScoreData(dirHandle, data);
    console.log('Saved score-data.json');
  } catch (err) {
    console.error('Score data save error:', err);
  }
}

// Load score data from local folder
async function loadScoreData() {
  if (!dirHandle) return;

  try {
    const data = await FileSystem.readScoreData(dirHandle);
    if (data) {
      // Restore reconstructed lines
      if (data.reconstructed) {
        Object.assign(reconstructedLines, data.reconstructed);
      }
      // Restore translation lines
      if (data.translations) {
        Object.assign(translationLines, data.translations);
      }
      console.log('Loaded score-data.json');
    }
  } catch (err) {
    console.error('Failed to load score data:', err);
  }
}

// Load a manuscript into the editor
function loadManuscript(id) {
  // Save current first
  saveCurrentManuscript();

  // Update active state
  activeManuscript = id;

  // Update UI
  document.querySelectorAll('.manuscript-item').forEach(item => {
    item.classList.toggle('active', item.dataset.id === id);
  });

  // Load content into Ace Editor
  setEditorContent(manuscripts[id].content);

  // Re-render score
  renderScore();
}

// Add a new manuscript
async function addManuscript() {
  // Show choice dialog
  const choice = await showAddManuscriptDialog();
  if (!choice) return;

  if (choice === 'new') {
    await createNewManuscript();
  } else if (choice === 'import') {
    await importManuscripts();
  }
}

// Show dialog to choose between new or import
function showAddManuscriptDialog() {
  return new Promise((resolve) => {
    const dialog = document.getElementById('add-manuscript-dialog');
    if (!dialog) {
      // Fallback to prompt if dialog doesn't exist
      const choice = confirm('Click OK to create a new manuscript, or Cancel to import files');
      resolve(choice ? 'new' : 'import');
      return;
    }

    dialog.showModal();

    const newBtn = document.getElementById('add-new-manuscript-btn');
    const importBtn = document.getElementById('import-manuscripts-btn');
    const cancelBtn = document.getElementById('cancel-add-manuscript-btn');

    const cleanup = () => {
      dialog.close();
      newBtn.removeEventListener('click', onNew);
      importBtn.removeEventListener('click', onImport);
      cancelBtn.removeEventListener('click', onCancel);
    };

    const onNew = () => { cleanup(); resolve('new'); };
    const onImport = () => { cleanup(); resolve('import'); };
    const onCancel = () => { cleanup(); resolve(null); };

    newBtn.addEventListener('click', onNew);
    importBtn.addEventListener('click', onImport);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// Create a new empty manuscript
async function createNewManuscript() {
  const siglum = prompt('Enter filename (e.g., K.3547, BM.12345):');
  if (!siglum) return;

  const id = `ms-${siglum.toLowerCase()}`;
  if (manuscripts[id]) {
    alert('A manuscript with this name already exists.');
    return;
  }

  const initialContent = `${siglum}\n@obverse\n§1 1. `;

  manuscripts[id] = {
    siglum: siglum,
    content: initialContent
  };

  // Add to list
  addManuscriptToList(id, siglum);

  // Save to local folder immediately
  try {
    await FileSystem.writeManuscript(dirHandle, siglum, initialContent);
    await updateManuscriptIndex();
  } catch (err) {
    console.error('Failed to save new manuscript:', err);
  }

  // Switch to it
  loadManuscript(id);
}

// Import manuscripts from local files
async function importManuscripts() {
  // Create a file input element
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.txt';

  input.onchange = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    let importedCount = 0;
    let skippedCount = 0;
    let lastImportedId = null;

    for (const file of files) {
      const siglum = file.name.replace('.txt', '');
      const id = `ms-${siglum.toLowerCase()}`;

      // Skip if already exists
      if (manuscripts[id]) {
        skippedCount++;
        continue;
      }

      // Read file content
      const content = await file.text();

      manuscripts[id] = {
        siglum: siglum,
        content: content
      };

      // Add to list
      addManuscriptToList(id, siglum);

      // Save to local folder
      try {
        await FileSystem.writeManuscript(dirHandle, siglum, content);
        importedCount++;
        lastImportedId = id;
      } catch (err) {
        console.error(`Failed to save ${siglum}:`, err);
      }
    }

    // Update index
    await updateManuscriptIndex();

    // Show summary
    let message = `Imported ${importedCount} manuscript(s).`;
    if (skippedCount > 0) {
      message += ` Skipped ${skippedCount} (already exist).`;
    }
    alert(message);

    // Load the last imported manuscript
    if (lastImportedId) {
      loadManuscript(lastImportedId);
    }
  };

  input.click();
}

// Event listeners (Ace handles its own input events via initAceEditor)

manuscriptList.addEventListener('click', (e) => {
  if (e.target.classList.contains('manuscript-item')) {
    loadManuscript(e.target.dataset.id);
  }
});

addManuscriptBtn.addEventListener('click', addManuscript);

// ===========================================
// SEARCH ALL MANUSCRIPTS
// ===========================================

function setupSearchAll() {
  const modal = document.getElementById('search-modal');
  const closeBtn = document.getElementById('close-search');
  const searchInput = document.getElementById('search-input');
  const replaceInput = document.getElementById('replace-input');
  const replaceBtn = document.getElementById('replace-btn');
  const replaceAllBtn = document.getElementById('replace-all-btn');
  const regexCheckbox = document.getElementById('search-regex');
  const caseCheckbox = document.getElementById('search-case');
  const resultsContainer = document.getElementById('search-results');

  // Track current search results and selected match
  let currentResults = [];
  let selectedResultIndex = -1;

  // Undo stack for replace operations
  let undoStack = [];
  const undoBtn = document.getElementById('undo-replace-btn');

  function saveUndoState(affectedIds, description) {
    const state = {
      description,
      manuscripts: {}
    };
    for (const id of affectedIds) {
      state.manuscripts[id] = manuscripts[id].content;
    }
    undoStack.push(state);
    undoBtn.disabled = false;
  }

  function performUndo() {
    if (undoStack.length === 0) return;

    const state = undoStack.pop();

    // Restore manuscript contents
    for (const [id, content] of Object.entries(state.manuscripts)) {
      if (manuscripts[id]) {
        manuscripts[id].content = content;
        saveToFile(id);
      }
    }

    // Update editor if active manuscript was restored
    if (manuscripts[activeManuscript] && state.manuscripts[activeManuscript]) {
      setEditorContent(manuscripts[activeManuscript].content);
    }

    renderScore();
    performSearch(); // Refresh results

    undoBtn.disabled = undoStack.length === 0;
  }

  undoBtn.addEventListener('click', performUndo);

  // Open modal
  searchAllBtn.addEventListener('click', () => {
    modal.classList.remove('hidden');
    searchInput.focus();
    searchInput.select();
  });

  // Close modal
  closeBtn.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
    }
  });

  // Keyboard shortcut: Ctrl+Shift+F
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      modal.classList.remove('hidden');
      searchInput.focus();
      searchInput.select();
    }
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      modal.classList.add('hidden');
    }
  });

  // Search on input
  let searchTimeout = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => performSearch(), 200);
  });

  regexCheckbox.addEventListener('change', performSearch);
  caseCheckbox.addEventListener('change', performSearch);

  // Update button states when search input changes
  function updateReplaceButtons() {
    const hasQuery = searchInput.value.length > 0;
    const hasResults = currentResults.length > 0;
    replaceBtn.disabled = !hasQuery || !hasResults || selectedResultIndex < 0;
    replaceAllBtn.disabled = !hasQuery || !hasResults;
  }

  searchInput.addEventListener('input', updateReplaceButtons);

  // Replace single match (the selected one)
  replaceBtn.addEventListener('click', () => {
    if (selectedResultIndex < 0 || currentResults.length === 0) return;

    const replacement = replaceInput.value;
    const query = searchInput.value;
    const useRegex = regexCheckbox.checked;
    const caseSensitive = caseCheckbox.checked;

    // Find the selected result
    let flatIndex = 0;
    for (const group of currentResults) {
      for (const match of group.matches) {
        if (flatIndex === selectedResultIndex) {
          // Save undo state before replacing
          saveUndoState([group.id], `Replace in ${group.id}`);

          // Replace in this manuscript
          const ms = manuscripts[group.id];
          const lines = ms.content.split('\n');

          let regex;
          if (useRegex) {
            regex = new RegExp(query, caseSensitive ? '' : 'i');
          } else {
            const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regex = new RegExp(escaped, caseSensitive ? '' : 'i');
          }

          lines[match.lineNum - 1] = lines[match.lineNum - 1].replace(regex, replacement);
          ms.content = lines.join('\n');

          // Update editor if this is the active manuscript
          if (group.id === activeManuscript) {
            setEditorContent(ms.content);
          }

          // Save and re-render
          saveToFile(group.id);
          renderScore();
          performSearch(); // Refresh results
          return;
        }
        flatIndex++;
      }
    }
  });

  // Replace all matches
  replaceAllBtn.addEventListener('click', () => {
    if (currentResults.length === 0) return;

    const replacement = replaceInput.value;
    const query = searchInput.value;
    const useRegex = regexCheckbox.checked;
    const caseSensitive = caseCheckbox.checked;

    let regex;
    if (useRegex) {
      regex = new RegExp(query, caseSensitive ? 'g' : 'gi');
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
    }

    // Save undo state for all affected manuscripts
    const affectedIds = currentResults.map(g => g.id);
    saveUndoState(affectedIds, `Replace all: "${query}" → "${replacement}"`);

    let totalReplaced = 0;

    // Replace in all manuscripts with matches
    for (const group of currentResults) {
      const ms = manuscripts[group.id];
      const before = ms.content;
      ms.content = ms.content.replace(regex, replacement);

      if (ms.content !== before) {
        totalReplaced += group.matches.length;
        saveToFile(group.id);
      }
    }

    // Update editor if active manuscript was modified
    if (manuscripts[activeManuscript]) {
      setEditorContent(manuscripts[activeManuscript].content);
    }

    renderScore();
    performSearch(); // Refresh results

    alert(`Replaced ${totalReplaced} occurrence(s)`);
  });

  function performSearch() {
    const query = searchInput.value;
    if (!query) {
      currentResults = [];
      selectedResultIndex = -1;
      updateReplaceButtons();
      resultsContainer.innerHTML = '<div class="search-empty">Enter a search term above</div>';
      return;
    }

    const useRegex = regexCheckbox.checked;
    const caseSensitive = caseCheckbox.checked;

    let regex;
    try {
      if (useRegex) {
        regex = new RegExp(query, caseSensitive ? 'g' : 'gi');
      } else {
        // Escape special regex chars for literal search
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
      }
    } catch (e) {
      currentResults = [];
      selectedResultIndex = -1;
      updateReplaceButtons();
      resultsContainer.innerHTML = `<div class="search-empty">Invalid regex: ${escapeHtml(e.message)}</div>`;
      return;
    }

    const results = [];
    let totalMatches = 0;

    // Search all manuscripts
    for (const [id, ms] of Object.entries(manuscripts)) {
      const lines = ms.content.split('\n');
      const matches = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        regex.lastIndex = 0; // Reset regex state
        if (regex.test(line)) {
          regex.lastIndex = 0;
          matches.push({
            lineNum: i + 1,
            content: line,
            highlighted: highlightMatches(line, regex)
          });
          totalMatches++;
        }
      }

      if (matches.length > 0) {
        results.push({
          id,
          siglum: ms.siglum,
          matches
        });
      }
    }

    // Store results for replace functionality
    currentResults = results;
    selectedResultIndex = -1;

    // Render results
    if (results.length === 0) {
      updateReplaceButtons();
      resultsContainer.innerHTML = '<div class="search-empty">No matches found</div>';
      return;
    }

    let html = `<div class="search-count">${totalMatches} match${totalMatches !== 1 ? 'es' : ''} in ${results.length} manuscript${results.length !== 1 ? 's' : ''}</div>`;

    let flatIndex = 0;
    for (const group of results) {
      html += `<div class="search-result-group">`;
      html += `<div class="search-result-header" data-id="${group.id}">${escapeHtml(group.siglum)} (${group.matches.length})</div>`;

      for (const match of group.matches) {
        html += `<div class="search-result-item" data-id="${group.id}" data-line="${match.lineNum}" data-index="${flatIndex}">`;
        html += `<span class="search-result-line">${match.lineNum}:</span>`;
        html += match.highlighted;
        html += `</div>`;
        flatIndex++;
      }

      html += `</div>`;
    }

    resultsContainer.innerHTML = html;
    updateReplaceButtons();

    // Add click handlers for results
    resultsContainer.querySelectorAll('.search-result-item').forEach(el => {
      el.addEventListener('click', (e) => {
        // Update selection
        resultsContainer.querySelectorAll('.search-result-item').forEach(item => {
          item.classList.remove('selected');
        });
        el.classList.add('selected');
        selectedResultIndex = parseInt(el.dataset.index);
        updateReplaceButtons();

        // If double-click or Ctrl+click, navigate to the result
        if (e.ctrlKey || e.detail === 2) {
          const id = el.dataset.id;
          const line = parseInt(el.dataset.line) || 1;
          loadManuscript(id);
          aceEditor.gotoLine(line, 0, true);
          aceEditor.focus();
          modal.classList.add('hidden');
        }
      });
    });

    // Header click navigates to manuscript
    resultsContainer.querySelectorAll('.search-result-header').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        loadManuscript(id);
        aceEditor.focus();
        modal.classList.add('hidden');
      });
    });
  }

  function highlightMatches(text, regex) {
    regex.lastIndex = 0;
    return escapeHtml(text).replace(new RegExp(regex.source, regex.flags), match =>
      `<span class="search-match">${match}</span>`
    );
  }
}

// Generate score text
function generateScoreText() {
  const { scoreLines } = buildScore();
  const sortedLineNumbers = Object.keys(scoreLines).map(Number).sort((a, b) => a - b);

  if (sortedLineNumbers.length === 0) {
    return '';
  }

  let text = 'SYNOPTIC SCORE\n';
  text += '==============\n\n';

  for (const lineNum of sortedLineNumbers) {
    const witnesses = scoreLines[lineNum];
    const translation = translationLines[lineNum] || '';
    const reconstructed = reconstructedLines[lineNum] || '';

    // Add translation if present
    if (translation) {
      text += `#tr.en: ${translation}\n`;
    }
    text += `§ ${lineNum} ${reconstructed}\n`;

    for (const w of witnesses) {
      const ref = `${w.siglum} ${abbreviateSurface(w.surface)} ${w.sourceLine}`.padEnd(22);
      text += `  ${ref} ${w.content}\n`;

      // Add continuation lines
      if (w.continuation && w.continuation.length > 0) {
        for (const cont of w.continuation) {
          text += `  ${''.padEnd(22)} ${cont}\n`;
        }
      }

      // Add parallel references
      if (w.parallels && w.parallels.length > 0) {
        for (const parallel of w.parallels) {
          text += `    // ${parallel}\n`;
        }
      }
    }

    text += '\n';
  }

  return text;
}

// Save score to local folder via FileSystem API
async function saveScoreToFile() {
  const text = generateScoreText();
  if (!text || !dirHandle) return;

  try {
    await FileSystem.writeScore(dirHandle, text);
    console.log('Saved score.txt');
  } catch (err) {
    console.error('Score save error:', err);
  }
}

// Export score as download
function exportScore() {
  const text = generateScoreText();
  if (!text) {
    alert('No score to export yet.');
    return;
  }

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'score.txt';
  a.click();
  URL.revokeObjectURL(url);
}

exportBtn.addEventListener('click', exportScore);

// Initial load
async function init() {
  // Get directory handle from IndexedDB
  try {
    const projects = await FileSystem.getSavedProjects();
    const project = projects.find(p => p.id === projectId);

    if (!project) {
      alert('Project not found. Returning to project list.');
      window.location.href = 'index.html';
      return;
    }

    // Check/request permission for the folder
    const granted = await FileSystem.requestPermission(project.handle);
    if (!granted) {
      alert('Permission denied. Please grant access to the folder.');
      window.location.href = 'index.html';
      return;
    }

    dirHandle = project.handle;
  } catch (err) {
    console.error('Failed to load project handle:', err);
    alert('Failed to load project. Returning to project list.');
    window.location.href = 'index.html';
    return;
  }

  // Initialize Ace Editor
  initAceEditor();

  // Setup resizable panes
  setupPaneResizer();

  // Setup tabs for score/colophons
  setupTabs();

  // Setup search all manuscripts
  setupSearchAll();

  // Setup siglum toggle
  setupSiglaToggle();

  // Initialize collaboration
  initCollaboration();

  // Load saved score data (reconstructed text and translations)
  await loadScoreData();

  // Load manuscripts from local folder
  await loadManuscripts();

  // Sync loaded manuscripts to Y.js
  for (const id of Object.keys(manuscripts)) {
    syncManuscriptToYjs(id);
  }

  console.log('Manuscript Scorer initialized');
}

init();
