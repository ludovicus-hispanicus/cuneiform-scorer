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
let projectConfig = null;
let manuscriptsMeta = null;

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
    } else if (status === 'unsaved') {
      indicator.classList.add('unsaved');
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

let imagesIndex = {}; // { siglum: [{ fileName, originalName, addedAt }] }
const imageObjectURLs = {}; // Cache: siglum -> { fileName -> objectURL }

let showSigla = localStorage.getItem('show_sigla') === 'true'; // Toggle state
let isDarkMode = localStorage.getItem('dark_mode') === 'true'; // Dark mode state

// Initialize Dark Mode
function initDarkMode() {
  if (isDarkMode) {
    document.body.classList.add('dark-mode');
  }
  updateThemeToggleIcon();
}

// Toggle Dark Mode
function toggleDarkMode() {
  isDarkMode = !isDarkMode;
  localStorage.setItem('dark_mode', isDarkMode);

  document.body.classList.toggle('dark-mode', isDarkMode);
  updateThemeToggleIcon();

  // Update Ace Editor theme if initialized
  if (aceEditor) {
    aceEditor.setTheme(isDarkMode ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
  }
}

// Update toggle button icon
function updateThemeToggleIcon() {
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    if (isDarkMode) {
      // Sun Icon
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
      btn.title = 'Switch to Light Mode';
    } else {
      // Moon Icon
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
      btn.title = 'Switch to Dark Mode';
    }
  }
}

// Setup theme toggle listener
function setupThemeToggle() {
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    btn.addEventListener('click', toggleDarkMode);
  }
}

// Load manuscripts from local folder via FileSystem API
async function loadManuscripts() {
  try {
    setStatus('syncing', 'Loading...');

    // Load project config from folder
    const config = await FileSystem.readProjectConfig(dirHandle);
    if (config) {
      projectConfig = config;
      document.getElementById('project-title').textContent = config.name;
      document.title = `${config.name} - Manuscript Scorer`;
      siglaMappings = config.sigla || {};
    }

    // Load manuscripts.json (eBL metadata) — used by Recon view + Export
    manuscriptsMeta = await FileSystem.readManuscriptsMeta(dirHandle) || { version: 1, manuscripts: [] };
    rebuildTypeMap();

    // Scan for new/removed .txt files vs index.json
    const { newFiles, removedFiles } = await FileSystem.scanForNewManuscripts(dirHandle);
    if (newFiles.length > 0) console.log('Discovered new manuscripts:', newFiles);
    if (removedFiles.length > 0) console.log('Removed manuscripts:', removedFiles);

    // Load manuscript index (now includes any newly discovered files)
    const fileNames = await FileSystem.readManuscriptIndex(dirHandle);
    if (!fileNames || fileNames.length === 0) {
      setEditorContent('No manuscripts yet. Click "+ Add" to create one.');
      setStatus('connected', 'Ready');
      return;
    }

    // Sort manuscripts alphanumerically
    fileNames.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

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

  // Wrap text content in a link to the eBL Fragmentarium for this manuscript.
  // Default left-click is intercepted by the existing manuscriptList handler;
  // modifier-click and middle-click open the eBL page in a new tab.
  const link = document.createElement('a');
  const primaryMuseum = window.EblClient
    ? window.EblClient.extractMuseumNumber(museumNum).primary
    : museumNum.split(/\s*\(\s*\+\s*\)\s*/)[0];
  link.href = `https://www.ebl.lmu.de/library/${encodeURIComponent(primaryMuseum)}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.dataset.eblLink = '1';
  link.title = `Open ${primaryMuseum} in eBL Fragmentarium (Ctrl/Cmd-click)`;
  link.appendChild(siglumSpan);
  link.appendChild(museumSpan);
  li.appendChild(link);

  li.classList.add(...(typeClass(museumNum).trim() ? [typeClass(museumNum).trim()] : []));

  // Update visibility based on toggle state
  updateManuscriptItemDisplay(li);

  // Insert in sorted order
  insertManuscriptSorted(li);
}

// ---- ATF bracket rendering ------------------------------------------------
// Marks every bracket, and flags any that has no partner on its own line.
//
// Each pair is counted INDEPENDENTLY rather than on one shared nesting stack:
// ATF lets brackets interleave — "[DIŠ {mu]l}UDU.IDIM" is correct, the ] closing
// the [ while the { is still open — and a single stack would report that as an
// error. Brackets are expected to balance within a line.
const ATF_PAIRS = [['[', ']'], ['⸢', '⸣'], ['{', '}'], ['<', '>']];
const ATF_OPENERS = new Map(ATF_PAIRS.map(([o, c]) => [o, c]));
const ATF_CLOSERS = new Map(ATF_PAIRS.map(([o, c]) => [c, o]));

// Indices of unmatched brackets in a line.
function unmatchedBrackets(text) {
  const bad = new Set();
  for (const [open, close] of ATF_PAIRS) {
    const stack = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === open) stack.push(i);
      else if (text[i] === close) {
        if (stack.length) stack.pop();
        else bad.add(i);          // closer with nothing open
      }
    }
    for (const i of stack) bad.add(i); // still open at end of line
  }
  return bad;
}

// Escape for HTML and wrap each bracket in its own span.
function renderAtf(text) {
  const bad = unmatchedBrackets(text);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const esc = ch === '&' ? '&amp;' : ch === '<' ? '&lt;'
      : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch;
    if (ATF_OPENERS.has(ch) || ATF_CLOSERS.has(ch)) {
      const cls = bad.has(i) ? 'atf-br atf-br-bad' : 'atf-br';
      const title = bad.has(i) ? ' title="unmatched bracket"' : '';
      out += `<span class="${cls}"${title}>${esc}</span>`;
    } else {
      out += esc;
    }
  }
  return out;
}

// ---- Manuscript type colouring -------------------------------------------
// The eBL manuscript type (Library / Commentary / Excerpt / …) is shown as a
// coloured mark beside each witness, never as coloured text: the siglum itself
// already spells the type out ("…Com1", "…Ex1"), so colour stays redundant and
// identity is never carried by hue alone.
const MANUSCRIPT_TYPE_SLUGS = {
  'Library': 'library',
  'Commentary': 'commentary',
  'Excerpt': 'excerpt',
  'School': 'school',
  'Varia': 'varia',
  'Amulet': 'amulet',
  'Quotation': 'quotation',
  'Parallel': 'parallel',
  'None': 'none',
};

let manuscriptTypes = {}; // museum number -> type slug

function rebuildTypeMap() {
  manuscriptTypes = {};
  for (const m of (manuscriptsMeta && manuscriptsMeta.manuscripts) || []) {
    const key = (m.file || '').replace(/\.txt$/, '');
    if (!key) continue;
    manuscriptTypes[key] = MANUSCRIPT_TYPE_SLUGS[m.type] || 'none';
  }
  renderTypeLegend();
  // grouping depends on the types, so re-sort if the list is already built
  if (typeof manuscriptList !== 'undefined' && manuscriptList &&
      manuscriptList.querySelector('.manuscript-item')) {
    resortManuscriptList();
  }
}

function typeClass(museumNum) {
  const slug = manuscriptTypes[museumNum];
  return slug ? ` type-${slug}` : '';
}

// Legend: every type present in this project, named in text next to its colour.
function renderTypeLegend() {
  const el = document.getElementById('type-legend');
  if (!el) return;
  const present = [];
  for (const [label, slug] of Object.entries(MANUSCRIPT_TYPE_SLUGS)) {
    if (Object.values(manuscriptTypes).includes(slug) && !present.some(p => p[1] === slug)) {
      present.push([label, slug]);
    }
  }
  if (present.length < 2) { el.innerHTML = ''; return; }
  el.innerHTML = present
    .map(([label, slug]) =>
      `<span class="type-legend-item"><span class="type-swatch type-${slug}"></span>${escapeHtml(label)}</span>`)
    .join('');
}

// The sidebar is grouped by manuscript type, in the order the source lists use:
// the running text first, then commentaries, then excerpts, then the rest.
const TYPE_ORDER = ['library', 'commentary', 'excerpt', 'school', 'varia',
                    'amulet', 'quotation', 'parallel', 'none'];
const TYPE_LABEL = {
  library: 'Manuscripts', commentary: 'Commentaries', excerpt: 'Excerpts',
  school: 'School', varia: 'Varia', amulet: 'Amulets',
  quotation: 'Quotations', parallel: 'Parallels', none: 'Unclassified',
};

// The label a manuscript is shown under, honouring the M#/Sig toggle. Used by
// the sidebar, the score, the colophons and the exported score alike, so the
// toggle changes every view at once.
function displaySiglum(museum) {
  return (showSigla && siglaMappings[museum]) ? siglaMappings[museum] : museum;
}

// Get the sort key for a manuscript list item based on current toggle
function getManuscriptSortKey(el) {
  return displaySiglum(el.dataset.museum);
}

// Witnesses are ordered the same way the sidebar is grouped: by type first
// (manuscripts, then commentaries, then excerpts, …), then by the label
// currently on show.
function witnessOrder(a, b) {
  const ra = TYPE_ORDER.indexOf(manuscriptTypes[a.siglum] || 'none');
  const rb = TYPE_ORDER.indexOf(manuscriptTypes[b.siglum] || 'none');
  const da = ra === -1 ? TYPE_ORDER.length : ra;
  const db = rb === -1 ? TYPE_ORDER.length : rb;
  if (da !== db) return da - db;
  return displaySiglum(a.siglum).localeCompare(
    displaySiglum(b.siglum), undefined, { numeric: true, sensitivity: 'base' });
}

function itemTypeSlug(el) {
  return manuscriptTypes[el.dataset.museum] || 'none';
}

function typeRank(el) {
  const i = TYPE_ORDER.indexOf(itemTypeSlug(el));
  return i === -1 ? TYPE_ORDER.length : i;
}

// Insert a manuscript <li> into the sidebar. Grouping means the headers have to
// be rebuilt anyway, so this defers to the full resort rather than trying to
// splice a single row into the right group.
function insertManuscriptSorted(li) {
  manuscriptList.appendChild(li);
  resortManuscriptList();
}

// Re-sort the sidebar: by type group, then by the current label (siglum or
// museum number, per the toggle). Group headers are regenerated each time.
function resortManuscriptList() {
  for (const h of Array.from(manuscriptList.querySelectorAll('.ms-group-header'))) {
    h.remove();
  }
  const items = Array.from(manuscriptList.children)
    .filter(el => el.classList.contains('manuscript-item'));
  items.sort((a, b) => {
    const d = typeRank(a) - typeRank(b);
    if (d !== 0) return d;
    return getManuscriptSortKey(a).localeCompare(
      getManuscriptSortKey(b), undefined, { numeric: true, sensitivity: 'base' });
  });
  // counts per group, for the headings
  const counts = {};
  for (const item of items) {
    const slug = itemTypeSlug(item);
    counts[slug] = (counts[slug] || 0) + 1;
  }

  let lastType = null;
  for (const item of items) {
    const slug = itemTypeSlug(item);
    if (slug !== lastType) {
      const header = document.createElement('li');
      header.className = `ms-group-header type-${slug}`;
      header.append(TYPE_LABEL[slug] || slug);
      const n = document.createElement('span');
      n.className = 'ms-count';
      n.textContent = counts[slug];
      header.appendChild(n);
      manuscriptList.appendChild(header);
      lastType = slug;
    }
    manuscriptList.appendChild(item);
  }

  const total = document.getElementById('ms-total');
  if (total) total.textContent = items.length;
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
    resortManuscriptList();
    renderScore();          // labels and within-section order both depend on it
    if (typeof renderColophons === 'function') renderColophons();
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

    const availableWidth = workArea.getBoundingClientRect().width - resizer.offsetWidth;

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
    const availableWidth = workArea.getBoundingClientRect().width - resizer.offsetWidth;
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
const saveBtn = document.getElementById('save-btn');
const searchAllBtn = document.getElementById('search-all-btn');

// Initialize Ace Editor
let aceEditor = null;
function initAceEditor() {
  aceEditor = ace.edit('editor');
  aceEditor.setTheme(isDarkMode ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
  aceEditor.session.setMode('ace/mode/cuneiform_score');
  aceEditor.setOptions({
    fontSize: '14px',
    fontFamily: '"Consolas", "Monaco", monospace',
    showPrintMargin: false,
    showGutter: false,  // Hide line numbers
    wrap: true,
    tabSize: 2,
    useSoftTabs: true
  });

  // Add padding to the editor to separate text from margins
  aceEditor.renderer.setPadding(15);
  aceEditor.renderer.setScrollMargin(15, 15);

  // Enable search box extension
  ace.require('ace/ext/searchbox');

  // Handle changes
  aceEditor.session.on('change', () => {
    markUnmatchedBrackets(aceEditor);
    if (isPollingUpdate || isLoadingContent) return; // Skip programmatic content changes
    saveCurrentManuscript();
    syncManuscriptToYjs(activeManuscript);
    renderScore();
    updateSourceHeader(activeManuscript);   // bracket count follows the edits
    markUnsaved();
  });

  return aceEditor;
}

// Highlight every bracket that has no partner on its line. The gutter is
// hidden in this editor, so the flag has to live in the text itself.
// Keyed by session: the main editor and the reconstruction editor each keep
// their own marker ids, so clearing one never touches the other's session.
const bracketMarkers = new WeakMap();
function markUnmatchedBrackets(editor) {
  if (!editor) return;
  const session = editor.session;
  for (const id of (bracketMarkers.get(session) || [])) session.removeMarker(id);
  const marks = [];
  bracketMarkers.set(session, marks);
  const Range = ace.require('ace/range').Range;
  const lines = session.getDocument().getAllLines();
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    if (!line || /^\s*(?:[@$]|\/\/|#)/.test(line)) continue; // markers and notes
    for (const col of unmatchedBrackets(line)) {
      marks.push(
        session.addMarker(new Range(row, col, row, col + 1), 'atf-bad-marker', 'text'));
    }
  }
}

// Getter for editor content (compatibility layer)
function getEditorContent() {
  return aceEditor ? aceEditor.getValue() : '';
}

// Setter for editor content
let isLoadingContent = false;
function setEditorContent(content) {
  if (aceEditor) {
    isLoadingContent = true;
    aceEditor.setValue(content, -1); // -1 moves cursor to start
    isLoadingContent = false;
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

  for (const n of Object.keys(scoreLines)) scoreLines[n].sort(witnessOrder);

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
    html += `<div class="score-line-header"><span class="line-label">§ ${lineNum}</span> <span class="reconstructed-text" contenteditable="true" data-line="${lineNum}">${renderAtf(reconstructed)}</span></div>`;

    for (const w of witnesses) {
      const ref = `${displaySiglum(w.siglum)} ${abbreviateSurface(w.surface)} ${w.sourceLine}`;
      html += `<div class="score-witness${typeClass(w.siglum)}">`;
      html += `<span class="witness-siglum">${escapeHtml(ref)}</span>`;
      html += `<span class="witness-text">${renderAtf(w.content)}</span>`;
      html += `</div>`;

      // Render continuation lines if any
      if (w.continuation && w.continuation.length > 0) {
        for (const cont of w.continuation) {
          html += `<div class="score-witness continuation${typeClass(w.siglum)}">`;
          html += `<span class="witness-siglum"></span>`;
          html += `<span class="witness-text">${renderAtf(cont)}</span>`;
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
      markUnsaved();
    });
  });

  // Add event listeners for reconstructed text editing
  scorePanel.querySelectorAll('.reconstructed-text').forEach(el => {
    el.addEventListener('input', (e) => {
      const lineNum = e.target.dataset.line;
      reconstructedLines[lineNum] = e.target.innerText;
      syncReconstructedToYjs(lineNum, e.target.innerText); // Sync to collaborators
      markUnsaved();
    });
    // The composite line is contenteditable, so the bracket spans are only
    // shown while it is NOT being edited: typing inside styled spans makes the
    // browser split and merge them and the caret jumps. Plain text on focus,
    // colour back on blur. The stored value is unaffected either way — the
    // input handler reads innerText, which ignores markup.
    el.addEventListener('focus', (e) => {
      e.target.textContent = reconstructedLines[e.target.dataset.line] || '';
    });
    el.addEventListener('blur', (e) => {
      const text = e.target.innerText;
      reconstructedLines[e.target.dataset.line] = text;
      e.target.innerHTML = renderAtf(text);
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
    colophonsPanel.innerHTML = '<div class="colophons-empty">No colophons found. Use @colophon in sources to mark colophon sections.</div>';
    return;
  }

  let html = '';
  for (const col of colophons) {
    html += `<div class="colophon-entry">`;
    html += `<div class="colophon-header">${escapeHtml(displaySiglum(col.siglum))}</div>`;
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
      if (targetTab === 'images') {
        renderImages();
      }
      updateUploadButtonVisibility();
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

// Manual save — no auto-save to avoid duplicate files on cloud-synced folders (Google Drive)
let hasUnsavedChanges = false;

function markUnsaved() {
  if (!hasUnsavedChanges) {
    hasUnsavedChanges = true;
    setStatus('unsaved', 'Unsaved changes');
  }
}

async function saveAll() {
  if (!dirHandle) return;
  try {
    setStatus('syncing', 'Saving...');
    if (activeManuscript) {
      await saveToFile(activeManuscript);
    }
    await saveScoreToFile();
    await saveScoreDataToFile();
    hasUnsavedChanges = false;
    setStatus('connected', 'Saved');
  } catch (err) {
    console.error('Save error:', err);
    setStatus('error', 'Save failed');
  }
}

// Ctrl+S to save
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveAll();
  }
});

// Warn before leaving with unsaved changes
window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedChanges) {
    e.preventDefault();
    e.returnValue = '';
  }
});

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

// ---- Pull a source's transliteration from eBL -----------------------------
// eBL's fragment ATF is already in this app's format, but it carries no § score
// assignments — those are ours. So a pull never overwrites the file: it matches
// line for line, shows what differs, and rewrites only the transliteration that
// follows the "§N n." prefix, leaving every assignment intact.

// "§12 7'. DIŠ ..." -> {sec:'12', num:"7'", text:'DIŠ ...'}
// "7'. DIŠ ..."     -> {sec:null, num:"7'", text:'DIŠ ...'}
function splitScoreLine(rawLine) {
  // Project files written on Windows are CRLF; a trailing \r is a line
  // terminator to the regex engine, so "$" never reaches it and every line
  // silently fails to parse.
  const line = rawLine.replace(/\r$/, '');
  let m = line.match(/^(\s*)§(\d+)\s+(\S+?)\.\s?(.*)$/);
  if (m) return { indent: m[1], sec: m[2], num: m[3], text: m[4] };
  m = line.match(/^(\s*)(\d+['’]?[ab]?)\.\s?(.*)$/);
  if (m) return { indent: m[1], sec: null, num: m[2], text: m[3] };
  return null;
}

function rebuildScoreLine(parts, text) {
  const prefix = parts.sec ? `§${parts.sec} ` : '';
  return `${parts.indent}${prefix}${parts.num}. ${text}`;
}

// A line is identified by surface + number. The surface is essential: K.2246
// has an obverse 10 and a reverse 10', which collapse onto each other once the
// prime is normalised. Within a single surface a primed and a plain line never
// share a number, so dropping the prime there is safe — and needed, because our
// build normalised the .ebl's inconsistent primes.
const SURFACE_RE = /^@(obverse|reverse|edge|left edge|right edge|top|bottom|colophon)/i;

function refKey(surface, num) {
  return surface + '|' + String(num).replace(/[’']/g, '').toLowerCase();
}

function parseEblAtf(atf) {
  const out = new Map();
  let surface = 'obverse';
  for (const raw of atf.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const sm = line.match(SURFACE_RE);
    if (sm) { surface = sm[1].toLowerCase(); continue; }
    if (/^[$#]/.test(line) || line.startsWith('//')) continue;
    const p = splitScoreLine(line);
    if (p) out.set(refKey(surface, p.num), p.text);
  }
  return out;
}

let pullState = null;

async function pullFromEbl() {
  const btn = document.getElementById('ebl-pull-btn');
  const ms = manuscripts[activeManuscript];
  if (!ms || !window.EblClient) return;

  const primary = EblClient.extractMuseumNumber(ms.siglum).primary;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Pulling…';
  let frag;
  try {
    frag = await EblClient.getFragment(primary);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = original;
    alert(`Could not fetch ${primary} from eBL.\n\n${err && err.message ? err.message : err}`);
    return;
  }
  btn.disabled = false;
  btn.textContent = original;

  if (!frag || !frag.atf) {
    alert(`${primary} has no transliteration in eBL yet.`);
    return;
  }

  const theirs = parseEblAtf(frag.atf);
  // Split on either ending: project files written on Windows are CRLF, and a
  // stray \r would otherwise survive into the rebuilt lines and mix endings.
  const lines = ms.content.split(/\r?\n/);
  const rows = [];
  let surface = 'obverse';
  for (let i = 0; i < lines.length; i++) {
    const sm = lines[i].trim().match(SURFACE_RE);
    if (sm) { surface = sm[1].toLowerCase(); continue; }
    const p = splitScoreLine(lines[i]);
    if (!p) continue;
    const t = theirs.get(refKey(surface, p.num));
    if (t === undefined || t === p.text) continue;
    rows.push({
      row: i, parts: p, mine: p.text, theirs: t,
      // a line whose brackets don't balance here but do at eBL is a
      // transcription slip, so those are pre-selected; everything else is
      // left for the editor to judge.
      fixesBrackets: unmatchedBrackets(p.text).size > 0 &&
                     unmatchedBrackets(t).size === 0,
    });
  }

  pullState = { id: activeManuscript, primary, rows, lines };
  renderPullDialog();
}

function renderPullDialog() {
  const { primary, rows } = pullState;
  document.getElementById('pull-source-name').textContent = `· ${primary}`;
  const box = document.getElementById('pull-diff');
  const summary = document.getElementById('pull-summary');
  const applyBtn = document.getElementById('pull-apply-btn');
  const selectAll = document.getElementById('pull-select-all');

  if (rows.length === 0) {
    summary.textContent = 'This source already matches its eBL transliteration line for line.';
    box.innerHTML = '';
    applyBtn.disabled = true;
    selectAll.disabled = true;
  } else {
    const fixes = rows.filter(r => r.fixesBrackets).length;
    summary.textContent =
      `${rows.length} line${rows.length === 1 ? '' : 's'} differ` +
      (fixes ? ` · ${fixes} would fix an unmatched bracket (pre-selected)` : '') +
      '. Score assignments are kept — only the transliteration is replaced.';
    applyBtn.disabled = false;
    selectAll.disabled = false;
    box.innerHTML = rows.map((r, i) => `
      <div class="pull-row${r.fixesBrackets ? ' pull-row-fix' : ''}">
        <label class="pull-check">
          <input type="checkbox" data-i="${i}"${r.fixesBrackets ? ' checked' : ''}>
        </label>
        <div class="pull-body">
          <div class="pull-ref">${r.parts.sec ? `§${escapeHtml(r.parts.sec)} ` : ''}${escapeHtml(r.parts.num)}.${
            r.fixesBrackets ? ' <span class="pull-badge">fixes bracket</span>' : ''}</div>
          <div class="pull-line pull-mine"><span class="pull-tag">here</span>${renderAtf(r.mine)}</div>
          <div class="pull-line pull-theirs"><span class="pull-tag">eBL</span>${renderAtf(r.theirs)}</div>
        </div>
      </div>`).join('');
  }
  selectAll.checked = rows.length > 0 && rows.every(r => r.fixesBrackets);
  document.getElementById('ebl-pull-dialog').showModal();
}

function applyPull() {
  if (!pullState) return;
  const boxes = document.querySelectorAll('#pull-diff input[type="checkbox"][data-i]');
  const chosen = [];
  boxes.forEach(b => { if (b.checked) chosen.push(pullState.rows[Number(b.dataset.i)]); });
  if (chosen.length === 0) { document.getElementById('ebl-pull-dialog').close(); return; }

  const lines = pullState.lines.slice();   // already 
-free
  for (const r of chosen) lines[r.row] = rebuildScoreLine(r.parts, r.theirs);
  const content = lines.join('\n');

  manuscripts[pullState.id].content = content;
  if (pullState.id === activeManuscript) setEditorContent(content);
  saveCurrentManuscript();
  syncManuscriptToYjs(pullState.id);
  renderScore();
  updateSourceHeader(pullState.id);
  markUnsaved();

  document.getElementById('ebl-pull-dialog').close();
  pullState = null;
}

function setupEblPull() {
  const btn = document.getElementById('ebl-pull-btn');
  if (btn) btn.addEventListener('click', pullFromEbl);
  const cancel = document.getElementById('pull-cancel-btn');
  if (cancel) cancel.addEventListener('click', () => {
    document.getElementById('ebl-pull-dialog').close();
    pullState = null;
  });
  const apply = document.getElementById('pull-apply-btn');
  if (apply) apply.addEventListener('click', applyPull);
  const all = document.getElementById('pull-select-all');
  if (all) all.addEventListener('change', (e) => {
    document.querySelectorAll('#pull-diff input[type="checkbox"][data-i]')
      .forEach(b => { b.checked = e.target.checked; });
  });
}

// Header of the Source Text pane: a link straight to this source's eBL entry,
// and a count of any brackets in it that have no partner on their line. The
// point of pairing them is that an unmatched bracket here is usually a typo
// inherited from eBL, so the link is one click away from checking the original.
function updateSourceHeader(id) {
  const link = document.getElementById('ebl-entry-link');
  const status = document.getElementById('bracket-status');
  const ms = manuscripts[id];

  if (link) {
    if (ms) {
      const primary = window.EblClient
        ? window.EblClient.extractMuseumNumber(ms.siglum).primary
        : ms.siglum.split(/\s*\(\s*\+\s*\)\s*/)[0];
      link.href = `https://www.ebl.lmu.de/library/${encodeURIComponent(primary)}`;
      link.title = `Open ${primary} in the eBL Fragmentarium`;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
  }
  const pull = document.getElementById('ebl-pull-btn');
  if (pull) pull.hidden = !ms;

  if (!status) return;
  if (!ms) { status.hidden = true; return; }

  let bad = 0;
  const lines = ms.content.split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^\s*(?:[@$]|\/\/|#)/.test(line)) continue;
    const n = unmatchedBrackets(line).size;
    if (n) { bad += n; rows.push(i + 1); }
  }
  if (!bad) {
    status.hidden = true;
    return;
  }
  status.hidden = false;
  status.textContent = `${bad} unmatched bracket${bad === 1 ? '' : 's'}`;
  status.title = `Line${rows.length === 1 ? '' : 's'} ${rows.join(', ')} — ` +
    'check the eBL entry to see whether the original has it too';
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

  updateSourceHeader(id);

  // Re-render score
  renderScore();

  // Re-render images if images tab is active
  const activeTab = document.querySelector('.pane-tab.active');
  if (activeTab && activeTab.dataset.tab === 'images') {
    renderImages();
  }
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
      const choice = confirm('Click OK to create a new source, or Cancel to import files');
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
    alert('A source with this name already exists.');
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
  const item = e.target.closest('.manuscript-item');
  if (!item) return;
  // Modifier-click on the eBL link → let the browser open it in a new tab
  if (e.target.closest('a[data-ebl-link]') && (e.ctrlKey || e.metaKey || e.shiftKey)) {
    return;
  }
  // Plain click → suppress link navigation, load manuscript locally
  e.preventDefault();
  loadManuscript(item.dataset.id);
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
      const ref = `${displaySiglum(w.siglum)} ${abbreviateSurface(w.surface)} ${w.sourceLine}`.padEnd(22);
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
saveBtn.addEventListener('click', saveAll);

// ===========================================
// ANNOTATIONS (Bug / Enhancement Tracker)
// ===========================================

let annotations = [];

const annotationsBtn = document.getElementById('annotations-btn');
const annotationsPanel = document.getElementById('annotations-panel');
const closeAnnotationsBtn = document.getElementById('close-annotations-btn');
const addAnnotationBtn = document.getElementById('add-annotation-btn');
const annotationForm = document.getElementById('annotation-form');
const annotationTitle = document.getElementById('annotation-title');
const annotationDesc = document.getElementById('annotation-desc');
const annotationType = document.getElementById('annotation-type');
const annotationLocation = document.getElementById('annotation-location');
const saveAnnotationBtn = document.getElementById('save-annotation-btn');
const cancelAnnotationBtn = document.getElementById('cancel-annotation-btn');
const annotationsList = document.getElementById('annotations-list');
const annotationsFilter = document.getElementById('annotations-filter');

// Toggle panel
annotationsBtn.addEventListener('click', () => {
  annotationsPanel.classList.toggle('hidden');
});

closeAnnotationsBtn.addEventListener('click', () => {
  annotationsPanel.classList.add('hidden');
});

// Show/hide form
addAnnotationBtn.addEventListener('click', () => {
  annotationForm.classList.toggle('hidden');
  if (!annotationForm.classList.contains('hidden')) {
    annotationTitle.focus();
    // Pre-fill location with active manuscript if any
    if (activeManuscript && manuscripts[activeManuscript]) {
      annotationLocation.value = manuscripts[activeManuscript].siglum;
    }
  }
});

cancelAnnotationBtn.addEventListener('click', () => {
  annotationForm.classList.add('hidden');
  annotationTitle.value = '';
  annotationDesc.value = '';
  annotationLocation.value = '';
});

// Save annotation
saveAnnotationBtn.addEventListener('click', async () => {
  const title = annotationTitle.value.trim();
  if (!title) {
    annotationTitle.focus();
    return;
  }

  const annotation = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    type: annotationType.value,
    title,
    description: annotationDesc.value.trim(),
    location: annotationLocation.value.trim(),
    status: 'open',
    created: new Date().toISOString()
  };

  annotations.unshift(annotation);
  await saveAnnotations();
  renderAnnotations();

  // Reset form
  annotationForm.classList.add('hidden');
  annotationTitle.value = '';
  annotationDesc.value = '';
  annotationLocation.value = '';
});

// Filter change
annotationsFilter.addEventListener('change', renderAnnotations);

function renderAnnotations() {
  const filter = annotationsFilter.value;
  let filtered = annotations;

  if (filter === 'open') filtered = annotations.filter(a => a.status === 'open');
  else if (filter === 'resolved') filtered = annotations.filter(a => a.status === 'resolved');
  else if (filter === 'bug') filtered = annotations.filter(a => a.type === 'bug');
  else if (filter === 'enhancement') filtered = annotations.filter(a => a.type === 'enhancement');

  if (filtered.length === 0) {
    annotationsList.innerHTML = '<div class="annotations-empty">No annotations match this filter.</div>';
    return;
  }

  annotationsList.innerHTML = filtered.map(a => `
    <div class="annotation-item ${a.status}" data-id="${a.id}">
      <div class="annotation-item-header">
        <span class="annotation-badge ${a.type}">${a.type === 'bug' ? 'Bug' : 'Enh'}</span>
        <span class="annotation-title-text">${escapeHtml(a.title)}</span>
        <span class="annotation-status-badge ${a.status}">${a.status}</span>
      </div>
      ${a.description ? `<div class="annotation-desc-text">${escapeHtml(a.description)}</div>` : ''}
      ${a.location ? `<div class="annotation-location-text">${escapeHtml(a.location)}</div>` : ''}
      <div class="annotation-actions">
        <span class="annotation-date">${new Date(a.created).toLocaleDateString()}</span>
        <button class="annotation-toggle-btn" data-id="${a.id}">${a.status === 'open' ? 'Resolve' : 'Reopen'}</button>
        <button class="annotation-delete-btn" data-id="${a.id}">Delete</button>
      </div>
    </div>
  `).join('');

  // Bind action buttons
  annotationsList.querySelectorAll('.annotation-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ann = annotations.find(a => a.id === btn.dataset.id);
      if (ann) {
        ann.status = ann.status === 'open' ? 'resolved' : 'open';
        await saveAnnotations();
        renderAnnotations();
      }
    });
  });

  annotationsList.querySelectorAll('.annotation-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this annotation?')) return;
      annotations = annotations.filter(a => a.id !== btn.dataset.id);
      await saveAnnotations();
      renderAnnotations();
    });
  });
}

async function loadAnnotations() {
  if (!dirHandle) return;
  annotations = await FileSystem.readAnnotations(dirHandle) || [];
}

async function saveAnnotations() {
  if (!dirHandle) return;
  try {
    await FileSystem.writeAnnotations(dirHandle, annotations);
  } catch (err) {
    console.error('Failed to save annotations:', err);
  }
}

// ===========================================
// IMAGE MANAGEMENT
// ===========================================

// Initialize pdf.js worker
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

let viewerCurrentIndex = -1; // Currently viewed image index
let viewerEntries = []; // Cached entries for navigation

async function loadImagesIndex() {
  if (!dirHandle) return;
  imagesIndex = await FileSystem.readImagesIndex(dirHandle) || {};
}

async function saveImagesIndex() {
  if (!dirHandle) return;
  try {
    await FileSystem.writeImagesIndex(dirHandle, imagesIndex);
  } catch (err) {
    console.error('Failed to save images index:', err);
  }
}

function generateImageFileName(siglum, extension, pdfInfo) {
  const existing = (imagesIndex[siglum] || []).map(e => e.fileName);
  if (pdfInfo) {
    const safeName = pdfInfo.pdfName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_pdf$/i, '');
    const base = `${siglum}_pdf_${safeName}_p${pdfInfo.page}.png`;
    if (!existing.includes(base)) return base;
    let i = 2;
    while (existing.includes(`${siglum}_pdf_${safeName}_p${pdfInfo.page}_${i}.png`)) i++;
    return `${siglum}_pdf_${safeName}_p${pdfInfo.page}_${i}.png`;
  } else {
    let counter = existing.length + 1;
    let name;
    do {
      name = `${siglum}_${String(counter).padStart(3, '0')}.${extension}`;
      counter++;
    } while (existing.includes(name));
    return name;
  }
}

// Unified upload: accepts images (PNG/JPG) and PDFs
async function uploadFile() {
  if (!activeManuscript || !manuscripts[activeManuscript]) {
    alert('Please select a source first.');
    return;
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,application/pdf';
  input.multiple = true;

  input.onchange = async () => {
    const siglum = manuscripts[activeManuscript].siglum;
    if (!imagesIndex[siglum]) imagesIndex[siglum] = [];

    let hasPdf = false;
    for (const file of input.files) {
      const ext = file.name.split('.').pop().toLowerCase();

      if (ext === 'pdf') {
        // Handle PDF — open picker for first PDF found
        hasPdf = true;
        pdfFileName = file.name;
        const arrayBuffer = await file.arrayBuffer();
        setStatus('syncing', 'Loading PDF...');
        try {
          pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
          pdfCurrentPage = 1;
          openPdfPicker();
          setStatus('connected', 'Ready');
        } catch (err) {
          console.error('Failed to load PDF:', err);
          alert('Failed to load PDF file.');
          setStatus('connected', 'Ready');
        }
        break; // Only handle one PDF at a time
      } else {
        // Direct image upload
        const imgExt = (ext === 'jpg' || ext === 'jpeg') ? 'jpg' : 'png';
        const fileName = generateImageFileName(siglum, imgExt);
        setStatus('saving', `Saving ${fileName}...`);
        await FileSystem.saveImageFile(dirHandle, siglum, fileName, file);
        imagesIndex[siglum].push({
          fileName,
          originalName: file.name,
          addedAt: new Date().toISOString()
        });
      }
    }

    if (!hasPdf) {
      await saveImagesIndex();
      await refreshTimestamp('images/images-index.json');
      renderImages();
      setStatus('connected', 'Images saved');
    }
  };

  input.click();
}

// PDF page picker
let pdfDoc = null;
let pdfCurrentPage = 1;
let pdfFileName = '';

function openPdfPicker() {
  document.getElementById('pdf-picker-modal').classList.remove('hidden');
  renderPdfPage();
  updatePdfControls();
}

function closePdfPicker() {
  document.getElementById('pdf-picker-modal').classList.add('hidden');
  pdfDoc = null;
}

async function renderPdfPage() {
  if (!pdfDoc) return;

  const page = await pdfDoc.getPage(pdfCurrentPage);
  const scale = 1.5;
  const viewport = page.getViewport({ scale });

  const canvas = document.getElementById('pdf-picker-canvas');
  const context = canvas.getContext('2d');
  canvas.height = viewport.height;
  canvas.width = viewport.width;

  await page.render({ canvasContext: context, viewport }).promise;
}

function updatePdfControls() {
  if (!pdfDoc) return;
  const pageInput = document.getElementById('pdf-page-input');
  pageInput.value = pdfCurrentPage;
  pageInput.max = pdfDoc.numPages;
  document.getElementById('pdf-page-total').textContent = pdfDoc.numPages;
  document.getElementById('pdf-prev-page').disabled = pdfCurrentPage <= 1;
  document.getElementById('pdf-next-page').disabled = pdfCurrentPage >= pdfDoc.numPages;
}

function goToPdfPage(num) {
  if (!pdfDoc) return;
  num = Math.max(1, Math.min(num, pdfDoc.numPages));
  if (num !== pdfCurrentPage) {
    pdfCurrentPage = num;
    renderPdfPage();
    updatePdfControls();
  }
}

async function savePdfPageAsImage() {
  if (!pdfDoc || !activeManuscript) return;

  const canvas = document.getElementById('pdf-picker-canvas');
  const siglum = manuscripts[activeManuscript].siglum;

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

  const fileName = generateImageFileName(siglum, 'png', {
    pdfName: pdfFileName,
    page: pdfCurrentPage
  });

  if (!imagesIndex[siglum]) imagesIndex[siglum] = [];

  setStatus('saving', `Saving ${fileName}...`);
  await FileSystem.saveImageFile(dirHandle, siglum, fileName, blob);

  imagesIndex[siglum].push({
    fileName,
    originalName: `${pdfFileName} p.${pdfCurrentPage}`,
    addedAt: new Date().toISOString()
  });

  await saveImagesIndex();
  await refreshTimestamp('images/images-index.json');
  renderImages();
  setStatus('connected', 'Page saved');
  closePdfPicker();
}

// Show/hide upload button based on active tab
function updateUploadButtonVisibility() {
  const activeTab = document.querySelector('.pane-tab.active');
  const uploadBtn = document.getElementById('upload-file-btn');
  if (activeTab && activeTab.dataset.tab === 'images') {
    uploadBtn.classList.remove('hidden');
  } else {
    uploadBtn.classList.add('hidden');
  }
}

// Render thumbnail grid
async function renderImages() {
  const grid = document.getElementById('images-grid');
  if (!grid) return;

  // Close viewer when re-rendering (skip re-render to avoid loop)
  closeViewer(true);

  if (!activeManuscript || !manuscripts[activeManuscript]) {
    grid.innerHTML = '<div class="images-empty">Select a source to view its images.</div>';
    return;
  }

  const siglum = manuscripts[activeManuscript].siglum;
  const entries = imagesIndex[siglum] || [];

  if (entries.length === 0) {
    grid.innerHTML = '<div class="images-empty">No images yet. Click "+ Upload" to add images or PDFs.</div>';
    return;
  }

  // Revoke old object URLs
  if (imageObjectURLs[siglum]) {
    Object.values(imageObjectURLs[siglum]).forEach(url => URL.revokeObjectURL(url));
  }
  imageObjectURLs[siglum] = {};

  grid.innerHTML = '';

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const file = await FileSystem.readImageFile(dirHandle, siglum, entry.fileName);
    if (!file) continue;

    const url = URL.createObjectURL(file);
    imageObjectURLs[siglum][entry.fileName] = url;

    const card = document.createElement('div');
    card.className = 'image-card';

    const img = document.createElement('img');
    img.src = url;
    img.alt = entry.fileName;
    img.loading = 'lazy';
    card.appendChild(img);

    // Show check badge if marked as transliterated
    if (entry.checked) {
      const badge = document.createElement('span');
      badge.className = 'image-check-badge';
      badge.title = 'Transliterated';
      badge.textContent = '\u2713';
      card.appendChild(badge);
    }

    const footer = document.createElement('div');
    footer.className = 'image-card-footer';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'image-name';
    nameSpan.textContent = entry.originalName || entry.fileName;
    nameSpan.title = entry.originalName || entry.fileName;
    footer.appendChild(nameSpan);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'image-delete-btn';
    deleteBtn.textContent = '\u00d7';
    deleteBtn.title = 'Delete image';
    footer.appendChild(deleteBtn);

    card.appendChild(footer);

    // Click thumbnail to open in viewer
    const idx = i;
    img.addEventListener('click', () => openViewer(idx));

    // Delete button
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete ${entry.fileName}?`)) return;
      await FileSystem.deleteImageFile(dirHandle, siglum, entry.fileName);
      imagesIndex[siglum] = imagesIndex[siglum].filter(e2 => e2.fileName !== entry.fileName);
      await saveImagesIndex();
      await refreshTimestamp('images/images-index.json');
      renderImages();
    });

    grid.appendChild(card);
  }
}

// ===========================================
// FABRIC.JS IMAGE VIEWER WITH ANNOTATIONS
// ===========================================

let fabricCanvas = null;
let fabricImage = null;
let currentZoom = 1;
let isPanning = false;
let panStartPoint = null;
let annotationSaveTimeout = null;
let isDrawMode = false;
let isLineMode = false;
let linePoints = []; // Points for the line tool
let linePreview = null; // Temporary preview line during line drawing
let activeTool = 'select'; // 'select', 'draw', 'line'

function initFabricCanvas() {
  if (fabricCanvas) return;
  if (typeof fabric === 'undefined') {
    console.error('Fabric.js not loaded — image annotations unavailable');
    return;
  }

  fabricCanvas = new fabric.Canvas('viewer-canvas', {
    selection: true,
    preserveObjectStacking: true
  });

  // Pan with middle-click or when in select mode + drag on empty area
  fabricCanvas.on('mouse:down', function (opt) {
    if (isLineMode) {
      handleLineClick(opt);
      return;
    }
    if (opt.e.button === 1 || (activeTool === 'select' && !opt.target)) {
      isPanning = true;
      panStartPoint = { x: opt.e.clientX, y: opt.e.clientY };
      fabricCanvas.selection = false;
      fabricCanvas.setCursor('grabbing');
    }
  });

  fabricCanvas.on('mouse:move', function (opt) {
    if (isLineMode && linePoints.length > 0) {
      updateLinePreview(opt);
      return;
    }
    if (isPanning && panStartPoint) {
      const vpt = fabricCanvas.viewportTransform;
      vpt[4] += opt.e.clientX - panStartPoint.x;
      vpt[5] += opt.e.clientY - panStartPoint.y;
      panStartPoint = { x: opt.e.clientX, y: opt.e.clientY };
      fabricCanvas.requestRenderAll();
    }
  });

  fabricCanvas.on('mouse:up', function () {
    if (isPanning) {
      isPanning = false;
      panStartPoint = null;
      fabricCanvas.selection = (activeTool === 'select');
      fabricCanvas.setCursor(activeTool === 'select' ? 'default' : 'crosshair');
    }
  });

  fabricCanvas.on('mouse:dblclick', function () {
    if (isLineMode && linePoints.length >= 2) {
      finishLine();
    }
  });

  // Sync toolbar when selecting an existing annotation
  fabricCanvas.on('selection:created', syncToolbarFromSelection);
  fabricCanvas.on('selection:updated', syncToolbarFromSelection);

  // Zoom with mouse wheel
  fabricCanvas.on('mouse:wheel', function (opt) {
    const delta = opt.e.deltaY;
    let zoom = fabricCanvas.getZoom();
    zoom *= 0.999 ** delta;
    zoom = Math.min(Math.max(zoom, 0.1), 10);
    fabricCanvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
    currentZoom = zoom;
    updateZoomDisplay();
    opt.e.preventDefault();
    opt.e.stopPropagation();
  });

  // Auto-save annotations when a path is drawn
  fabricCanvas.on('path:created', function (opt) {
    // Ensure freehand paths are selectable and have flat ends
    if (opt.path) {
      opt.path.set({
        selectable: true,
        evented: true,
        strokeLineCap: 'butt',
        strokeLineJoin: 'miter'
      });
    }
    debouncedSaveAnnotations();
  });

  // Auto-save when objects are modified
  fabricCanvas.on('object:modified', function () {
    debouncedSaveAnnotations();
  });

  // Pinch-to-zoom for touch screens
  let lastTouchDist = 0;
  let lastTouchCenter = null;
  const upperCanvas = fabricCanvas.upperCanvasEl;

  upperCanvas.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDist = Math.sqrt(dx * dx + dy * dy);
      const rect = upperCanvas.getBoundingClientRect();
      lastTouchCenter = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
      };
    }
  }, { passive: false });

  upperCanvas.addEventListener('touchmove', function (e) {
    if (e.touches.length === 2 && lastTouchDist > 0) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const scale = dist / lastTouchDist;

      let zoom = fabricCanvas.getZoom() * scale;
      zoom = Math.min(Math.max(zoom, 0.1), 10);
      fabricCanvas.zoomToPoint(lastTouchCenter, zoom);
      currentZoom = zoom;
      updateZoomDisplay();

      lastTouchDist = dist;
      const rect = upperCanvas.getBoundingClientRect();
      lastTouchCenter = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
      };
    }
  }, { passive: false });

  upperCanvas.addEventListener('touchend', function () {
    lastTouchDist = 0;
    lastTouchCenter = null;
  });
}

function resizeFabricCanvas() {
  if (!fabricCanvas) return;
  const wrapper = document.getElementById('viewer-canvas-wrapper');
  if (!wrapper) return;
  fabricCanvas.setWidth(wrapper.clientWidth);
  fabricCanvas.setHeight(wrapper.clientHeight);
  fabricCanvas.renderAll();
}

function updateZoomDisplay() {
  document.getElementById('viewer-zoom-level').textContent = Math.round(currentZoom * 100) + '%';
}

function zoomViewer(factor) {
  if (!fabricCanvas) return;
  let zoom = fabricCanvas.getZoom() * factor;
  zoom = Math.min(Math.max(zoom, 0.1), 10);
  const center = fabricCanvas.getCenter();
  fabricCanvas.zoomToPoint({ x: center.left, y: center.top }, zoom);
  currentZoom = zoom;
  updateZoomDisplay();
}

function zoomToFit() {
  if (!fabricCanvas || !fabricImage) return;
  const wrapper = document.getElementById('viewer-canvas-wrapper');
  const ww = wrapper.clientWidth;
  const wh = wrapper.clientHeight;
  const iw = fabricImage.width;
  const ih = fabricImage.height;

  const scale = Math.min(ww / iw, wh / ih) * 0.95;
  fabricCanvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  fabricCanvas.zoomToPoint({ x: ww / 2, y: wh / 2 }, scale);

  // Center the image
  const vpt = fabricCanvas.viewportTransform;
  vpt[4] = (ww - iw * scale) / 2;
  vpt[5] = (wh - ih * scale) / 2;
  fabricCanvas.setViewportTransform(vpt);

  currentZoom = scale;
  updateZoomDisplay();
}

function setActiveTool(tool) {
  // Cancel any in-progress line
  cancelLine();

  activeTool = tool;
  isDrawMode = (tool === 'draw');
  isLineMode = (tool === 'line');

  if (!fabricCanvas) return;

  fabricCanvas.isDrawingMode = isDrawMode;
  fabricCanvas.selection = (tool === 'select');

  if (isDrawMode) {
    applyBrushSettings();
  }

  // Update toolbar buttons
  document.getElementById('viewer-select-btn').classList.toggle('active', tool === 'select');
  document.getElementById('viewer-draw-btn').classList.toggle('active', tool === 'draw');
  document.getElementById('viewer-line-btn').classList.toggle('active', tool === 'line');

  // Set cursor
  if (tool === 'select') {
    fabricCanvas.defaultCursor = 'default';
  } else {
    fabricCanvas.defaultCursor = 'crosshair';
    fabricCanvas.discardActiveObject().renderAll();
  }
}

// Keep old name as alias for compatibility
function setDrawMode(enabled) {
  setActiveTool(enabled ? 'draw' : 'select');
}

function applyBrushSettings() {
  if (!fabricCanvas) return;
  const color = document.getElementById('draw-color').value;
  const thickness = parseInt(document.getElementById('draw-thickness').value, 10);
  const opacity = parseInt(document.getElementById('draw-opacity').value, 10) / 100;

  fabricCanvas.freeDrawingBrush = new fabric.PencilBrush(fabricCanvas);
  fabricCanvas.freeDrawingBrush.color = hexToRgba(color, opacity);
  fabricCanvas.freeDrawingBrush.width = thickness;
  // Flat "Feder" style — not round
  fabricCanvas.freeDrawingBrush.strokeLineCap = 'butt';
  fabricCanvas.freeDrawingBrush.strokeLineJoin = 'miter';
}

// ---- Line tool (click-to-place polyline) ----

function handleLineClick(opt) {
  const pointer = fabricCanvas.getPointer(opt.e);
  linePoints.push({ x: pointer.x, y: pointer.y });

  // Show dot at the placed point
  const dot = new fabric.Circle({
    left: pointer.x - 3,
    top: pointer.y - 3,
    radius: 3,
    fill: document.getElementById('draw-color').value,
    selectable: false,
    evented: false,
    _isLineHelper: true
  });
  fabricCanvas.add(dot);

  if (linePoints.length >= 2) {
    updateLinePreviewPath();
  }
}

function updateLinePreview(opt) {
  if (linePoints.length === 0) return;
  const pointer = fabricCanvas.getPointer(opt.e);

  // Remove old preview
  if (linePreview) fabricCanvas.remove(linePreview);

  const allPts = [...linePoints, { x: pointer.x, y: pointer.y }];
  linePreview = createPolylinePath(allPts, true);
  fabricCanvas.add(linePreview);
  fabricCanvas.renderAll();
}

function updateLinePreviewPath() {
  if (linePreview) fabricCanvas.remove(linePreview);
  if (linePoints.length < 2) return;
  linePreview = createPolylinePath(linePoints, true);
  fabricCanvas.add(linePreview);
  fabricCanvas.renderAll();
}

function createPolylinePath(points, isPreview) {
  const color = document.getElementById('draw-color').value;
  const thickness = parseInt(document.getElementById('draw-thickness').value, 10);
  const opacity = parseInt(document.getElementById('draw-opacity').value, 10) / 100;

  // Build SVG path string: M x0,y0 L x1,y1 L x2,y2 ...
  let pathStr = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    pathStr += ` L ${points[i].x} ${points[i].y}`;
  }

  return new fabric.Path(pathStr, {
    fill: '',
    stroke: hexToRgba(color, isPreview ? opacity * 0.5 : opacity),
    strokeWidth: thickness,
    strokeLineCap: 'butt',
    strokeLineJoin: 'miter',
    selectable: !isPreview,
    evented: !isPreview,
    _isLineHelper: isPreview
  });
}

function finishLine() {
  // Remove preview and helper dots
  cleanupLineHelpers();

  if (linePoints.length >= 2) {
    const path = createPolylinePath(linePoints, false);
    fabricCanvas.add(path);
    fabricCanvas.renderAll();
    debouncedSaveAnnotations();
  }

  linePoints = [];
  linePreview = null;
}

function cancelLine() {
  cleanupLineHelpers();
  linePoints = [];
  linePreview = null;
}

function cleanupLineHelpers() {
  if (!fabricCanvas) return;
  const helpers = fabricCanvas.getObjects().filter(obj => obj._isLineHelper);
  helpers.forEach(obj => fabricCanvas.remove(obj));
  if (linePreview) {
    fabricCanvas.remove(linePreview);
    linePreview = null;
  }
}

// ---- Sync toolbar with selected object ----

function syncToolbarFromSelection() {
  if (activeTool !== 'select') return;
  const obj = fabricCanvas.getActiveObject();
  if (!obj || obj === fabricImage) return;

  // Parse stroke color and opacity from the object
  const stroke = obj.stroke || '';
  const rgbaMatch = stroke.match(/rgba?\((\d+),(\d+),(\d+),?([\d.]*)\)/);
  if (rgbaMatch) {
    const r = parseInt(rgbaMatch[1]).toString(16).padStart(2, '0');
    const g = parseInt(rgbaMatch[2]).toString(16).padStart(2, '0');
    const b = parseInt(rgbaMatch[3]).toString(16).padStart(2, '0');
    document.getElementById('draw-color').value = `#${r}${g}${b}`;
    const alpha = rgbaMatch[4] !== '' ? parseFloat(rgbaMatch[4]) : 1;
    const pct = Math.round(alpha * 100);
    document.getElementById('draw-opacity').value = pct;
    document.getElementById('draw-opacity-val').textContent = pct;
  } else if (stroke.startsWith('#')) {
    document.getElementById('draw-color').value = stroke;
    document.getElementById('draw-opacity').value = 100;
    document.getElementById('draw-opacity-val').textContent = '100';
  }

  if (obj.strokeWidth) {
    const w = Math.round(obj.strokeWidth);
    document.getElementById('draw-thickness').value = w;
    document.getElementById('draw-thickness-val').textContent = w;
  }
}

// Apply toolbar changes to selected object
function applySettingsToSelection() {
  if (!fabricCanvas) return;
  const obj = fabricCanvas.getActiveObject();
  if (!obj || obj === fabricImage) return;

  const color = document.getElementById('draw-color').value;
  const thickness = parseInt(document.getElementById('draw-thickness').value, 10);
  const opacity = parseInt(document.getElementById('draw-opacity').value, 10) / 100;

  obj.set({
    stroke: hexToRgba(color, opacity),
    strokeWidth: thickness
  });
  fabricCanvas.renderAll();
  debouncedSaveAnnotations();
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function updateBrushSettings() {
  if (!fabricCanvas) return;

  // Update brush if in draw mode
  if (fabricCanvas.isDrawingMode && fabricCanvas.freeDrawingBrush) {
    const color = document.getElementById('draw-color').value;
    const thickness = parseInt(document.getElementById('draw-thickness').value, 10);
    const opacity = parseInt(document.getElementById('draw-opacity').value, 10) / 100;
    fabricCanvas.freeDrawingBrush.color = hexToRgba(color, opacity);
    fabricCanvas.freeDrawingBrush.width = thickness;
  }

  // Also apply to selected object if in select mode
  if (activeTool === 'select') {
    applySettingsToSelection();
  }
}

function deleteSelectedAnnotation() {
  if (!fabricCanvas) return;
  const active = fabricCanvas.getActiveObjects();
  if (active.length === 0) return;
  active.forEach(obj => {
    // Don't delete the background image
    if (obj !== fabricImage) fabricCanvas.remove(obj);
  });
  fabricCanvas.discardActiveObject().renderAll();
  debouncedSaveAnnotations();
}

function undoLastAnnotation() {
  if (!fabricCanvas) return;
  const objects = fabricCanvas.getObjects();
  // Find last non-image object
  for (let i = objects.length - 1; i >= 0; i--) {
    if (objects[i] !== fabricImage) {
      fabricCanvas.remove(objects[i]);
      fabricCanvas.renderAll();
      debouncedSaveAnnotations();
      return;
    }
  }
}

// Save/load annotations as JSON
function debouncedSaveAnnotations() {
  if (annotationSaveTimeout) clearTimeout(annotationSaveTimeout);
  annotationSaveTimeout = setTimeout(saveCurrentAnnotations, 500);
}

async function saveCurrentAnnotations() {
  if (!dirHandle || !activeManuscript || viewerCurrentIndex < 0) return;
  const siglum = manuscripts[activeManuscript].siglum;
  const entry = viewerEntries[viewerCurrentIndex];
  if (!entry) return;

  // Collect only annotation objects (not the background image)
  const annotations = fabricCanvas.getObjects().filter(obj => obj !== fabricImage);
  if (annotations.length === 0) {
    // Delete the annotations file if empty (optional: could also write empty array)
    try {
      await FileSystem.writeImageAnnotations(dirHandle, siglum, entry.fileName, []);
    } catch (e) { /* ignore */ }
    return;
  }

  const data = annotations.map(obj => obj.toJSON(['selectable', 'evented']));
  try {
    await FileSystem.writeImageAnnotations(dirHandle, siglum, entry.fileName, data);
  } catch (err) {
    console.error('Failed to save image annotations:', err);
  }
}

async function loadAnnotationsForImage(siglum, fileName) {
  if (!dirHandle) return;
  const data = await FileSystem.readImageAnnotations(dirHandle, siglum, fileName);
  if (!data || !Array.isArray(data) || data.length === 0) return;

  // Load each annotation object
  fabric.util.enlivenObjects(data, function (objects) {
    objects.forEach(obj => {
      fabricCanvas.add(obj);
    });
    fabricCanvas.renderAll();
  });
}

// Open viewer with Fabric.js
async function openViewer(index) {
  if (!activeManuscript || !manuscripts[activeManuscript]) return;
  const siglum = manuscripts[activeManuscript].siglum;
  viewerEntries = imagesIndex[siglum] || [];
  if (index < 0 || index >= viewerEntries.length) return;

  viewerCurrentIndex = index;

  const viewer = document.getElementById('image-viewer');
  const grid = document.getElementById('images-grid');
  grid.style.display = 'none';
  viewer.classList.remove('hidden');

  initFabricCanvas();
  if (!fabricCanvas) return; // Fabric.js not available
  resizeFabricCanvas();
  await showViewerImage();
}

async function showViewerImage() {
  if (viewerCurrentIndex < 0 || viewerCurrentIndex >= viewerEntries.length) return;
  const siglum = manuscripts[activeManuscript].siglum;
  const entry = viewerEntries[viewerCurrentIndex];
  const url = imageObjectURLs[siglum]?.[entry.fileName];
  if (!url) return;

  // Save annotations from previous image before switching
  if (annotationSaveTimeout) {
    clearTimeout(annotationSaveTimeout);
    await saveCurrentAnnotations();
  }

  // Clear canvas
  fabricCanvas.clear();
  fabricCanvas.setViewportTransform([1, 0, 0, 1, 0, 0]);

  // Load image as background object
  fabric.Image.fromURL(url, function (img) {
    fabricImage = img;
    img.selectable = false;
    img.evented = false;
    fabricCanvas.add(img);
    fabricCanvas.sendToBack(img);

    zoomToFit();

    // Load saved annotations
    loadAnnotationsForImage(siglum, entry.fileName);
  }, { crossOrigin: 'anonymous' });

  // Update UI
  document.getElementById('viewer-caption').textContent = entry.originalName || entry.fileName;
  document.getElementById('viewer-counter').textContent = `${viewerCurrentIndex + 1} / ${viewerEntries.length}`;

  // Update check button state
  updateCheckButton();

  // Reset to select mode
  setActiveTool('select');
}

function updateCheckButton() {
  const btn = document.getElementById('viewer-check-btn');
  const entry = viewerEntries[viewerCurrentIndex];
  if (!entry) return;
  const isChecked = !!entry.checked;
  btn.classList.toggle('checked', isChecked);
  btn.title = isChecked ? 'Transliterated — click to unmark' : 'Mark as transliterated';
}

async function toggleCheck() {
  if (viewerCurrentIndex < 0 || !activeManuscript) return;
  const siglum = manuscripts[activeManuscript].siglum;
  const entry = viewerEntries[viewerCurrentIndex];
  if (!entry) return;

  entry.checked = !entry.checked;

  // Also update the main imagesIndex
  const indexEntry = (imagesIndex[siglum] || []).find(e => e.fileName === entry.fileName);
  if (indexEntry) indexEntry.checked = entry.checked;

  // Update UI immediately
  updateCheckButton();

  try {
    await saveImagesIndex();
    await refreshTimestamp('images/images-index.json');
  } catch (err) {
    console.error('Failed to save check state:', err);
  }
}

async function closeViewer(skipRerender) {
  // Save before closing
  if (fabricCanvas && viewerCurrentIndex >= 0) {
    if (annotationSaveTimeout) clearTimeout(annotationSaveTimeout);
    await saveCurrentAnnotations();
  }

  const viewer = document.getElementById('image-viewer');
  const grid = document.getElementById('images-grid');
  viewer.classList.add('hidden');
  grid.style.display = '';
  viewerCurrentIndex = -1;

  // Clean up canvas
  if (fabricCanvas) {
    fabricCanvas.clear();
    fabricImage = null;
  }

  // Re-render thumbnails to show updated annotations
  if (!skipRerender) renderImages();
}

async function viewerPrev() {
  if (viewerCurrentIndex > 0) {
    viewerCurrentIndex--;
    await showViewerImage();
  }
}

async function viewerNext() {
  if (viewerCurrentIndex < viewerEntries.length - 1) {
    viewerCurrentIndex++;
    await showViewerImage();
  }
}

// Keyboard navigation for viewer
document.addEventListener('keydown', (e) => {
  if (viewerCurrentIndex < 0) return; // Viewer not open
  // Don't intercept if a text input is focused
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.key === 'Escape') {
    if (isLineMode && linePoints.length > 0) {
      cancelLine(); // Cancel in-progress line
    } else if (activeTool !== 'select') {
      setActiveTool('select'); // Go back to select mode
    } else {
      closeViewer(); // Close viewer
    }
    e.preventDefault();
  } else if (e.key === 'Enter' && isLineMode && linePoints.length >= 2) {
    finishLine();
    e.preventDefault();
  } else if (e.key === 'ArrowLeft' && activeTool === 'select') {
    viewerPrev();
    e.preventDefault();
  } else if (e.key === 'ArrowRight' && activeTool === 'select') {
    viewerNext();
    e.preventDefault();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelectedAnnotation();
    e.preventDefault();
  }
});

// Resize canvas when window resizes
window.addEventListener('resize', () => {
  if (viewerCurrentIndex >= 0) resizeFabricCanvas();
});

// Event listeners
document.getElementById('upload-file-btn').addEventListener('click', uploadFile);
document.getElementById('viewer-prev').addEventListener('click', viewerPrev);
document.getElementById('viewer-next').addEventListener('click', viewerNext);
document.getElementById('viewer-check-btn').addEventListener('click', toggleCheck);

// Toolbar buttons
document.getElementById('viewer-select-btn').addEventListener('click', () => setActiveTool('select'));
document.getElementById('viewer-draw-btn').addEventListener('click', () => setActiveTool('draw'));
document.getElementById('viewer-line-btn').addEventListener('click', () => setActiveTool('line'));
document.getElementById('viewer-erase-btn').addEventListener('click', deleteSelectedAnnotation);
document.getElementById('viewer-undo-btn').addEventListener('click', undoLastAnnotation);
document.getElementById('viewer-zoom-in').addEventListener('click', () => zoomViewer(1.25));
document.getElementById('viewer-zoom-out').addEventListener('click', () => zoomViewer(0.8));
document.getElementById('viewer-zoom-fit').addEventListener('click', zoomToFit);

// Draw options
document.getElementById('draw-color').addEventListener('input', updateBrushSettings);
document.getElementById('draw-thickness').addEventListener('input', (e) => {
  document.getElementById('draw-thickness-val').textContent = e.target.value;
  updateBrushSettings();
});
document.getElementById('draw-opacity').addEventListener('input', (e) => {
  document.getElementById('draw-opacity-val').textContent = e.target.value;
  updateBrushSettings();
});

// PDF picker listeners
document.getElementById('close-pdf-picker').addEventListener('click', closePdfPicker);
document.getElementById('pdf-cancel').addEventListener('click', closePdfPicker);
document.getElementById('pdf-prev-page').addEventListener('click', () => goToPdfPage(pdfCurrentPage - 1));
document.getElementById('pdf-next-page').addEventListener('click', () => goToPdfPage(pdfCurrentPage + 1));
document.getElementById('pdf-page-input').addEventListener('change', (e) => {
  goToPdfPage(parseInt(e.target.value, 10) || 1);
});
document.getElementById('pdf-page-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') goToPdfPage(parseInt(e.target.value, 10) || 1);
});
document.getElementById('pdf-save-page').addEventListener('click', savePdfPageAsImage);
document.getElementById('pdf-picker-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closePdfPicker();
});

// ===========================================
// FILE POLLING AUTO-SYNC
// ===========================================
// Polls for file changes on disk (useful when sharing folders via OneDrive, Dropbox, etc.)

let filePollingInterval = null;
const FILE_POLL_INTERVAL = 5000; // Check every 5 seconds
let lastKnownTimestamps = {}; // { filename: lastModified }
let isSaving = false; // Flag to skip polling during our own saves
let isPollingUpdate = false; // Flag to suppress saves triggered by polling updates

// Mark saving state so polling doesn't conflict
// After each save, update the baseline timestamp so polling doesn't re-detect our own writes
async function refreshTimestamp(path) {
  const ts = await getFileTimestamp(dirHandle, path);
  if (ts) lastKnownTimestamps[path] = ts;
}

const originalSaveToFile = saveToFile;
saveToFile = async function(id) {
  isSaving = true;
  try {
    await originalSaveToFile(id);
    const ms = manuscripts[id];
    if (ms) await refreshTimestamp(`manuscripts/${ms.siglum}.txt`);
    await refreshTimestamp('manuscripts/index.json');
    notifyOtherTabs('manuscript-saved', { manuscriptId: id });
  } finally {
    isSaving = false;
  }
};

const originalSaveScoreData = saveScoreDataToFile;
saveScoreDataToFile = async function() {
  isSaving = true;
  try {
    await originalSaveScoreData();
    await refreshTimestamp('score-data.json');
    notifyOtherTabs('score-data-saved');
  } finally {
    isSaving = false;
  }
};

const originalSaveAnnotations = saveAnnotations;
saveAnnotations = async function() {
  isSaving = true;
  try {
    await originalSaveAnnotations();
    await refreshTimestamp('annotations.json');
    notifyOtherTabs('annotations-saved');
  } finally {
    isSaving = false;
  }
};

// Get the last modified timestamp for a file
async function getFileTimestamp(dirHandle, path) {
  try {
    let handle = dirHandle;
    const parts = path.split('/');
    // Navigate to subdirectory if needed
    for (let i = 0; i < parts.length - 1; i++) {
      handle = await handle.getDirectoryHandle(parts[i]);
    }
    const fileHandle = await handle.getFileHandle(parts[parts.length - 1]);
    const file = await fileHandle.getFile();
    return file.lastModified;
  } catch (e) {
    return null;
  }
}

// Collect timestamps for all tracked files
async function collectTimestamps() {
  const timestamps = {};

  // Track score-data.json
  const sdTs = await getFileTimestamp(dirHandle, 'score-data.json');
  if (sdTs) timestamps['score-data.json'] = sdTs;

  // Track annotations.json
  const anTs = await getFileTimestamp(dirHandle, 'annotations.json');
  if (anTs) timestamps['annotations.json'] = anTs;

  // Track each manuscript file
  for (const id of Object.keys(manuscripts)) {
    const ms = manuscripts[id];
    const key = `manuscripts/${ms.siglum}.txt`;
    const ts = await getFileTimestamp(dirHandle, key);
    if (ts) timestamps[key] = ts;
  }

  // Track index.json for new manuscripts
  const idxTs = await getFileTimestamp(dirHandle, 'manuscripts/index.json');
  if (idxTs) timestamps['manuscripts/index.json'] = idxTs;

  // Track images index
  const imgTs = await getFileTimestamp(dirHandle, 'images/images-index.json');
  if (imgTs) timestamps['images/images-index.json'] = imgTs;

  return timestamps;
}

// Initialize baseline timestamps
async function initFilePolling() {
  if (!dirHandle) return;
  lastKnownTimestamps = await collectTimestamps();
  filePollingInterval = setInterval(pollForChanges, FILE_POLL_INTERVAL);
  console.log('File polling started');
}

// Stop polling (e.g., on page unload)
function stopFilePolling() {
  if (filePollingInterval) {
    clearInterval(filePollingInterval);
    filePollingInterval = null;
  }
}

// Check for changes and reload as needed
async function pollForChanges() {
  if (!dirHandle || isSaving) return;

  try {
    const currentTimestamps = await collectTimestamps();
    let hasChanges = false;

    // Check score-data.json
    if (currentTimestamps['score-data.json'] !== lastKnownTimestamps['score-data.json']) {
      console.log('score-data.json changed on disk, reloading...');
      const data = await FileSystem.readScoreData(dirHandle);
      if (data) {
        // Clear and reload
        Object.keys(reconstructedLines).forEach(k => delete reconstructedLines[k]);
        Object.keys(translationLines).forEach(k => delete translationLines[k]);
        if (data.reconstructed) Object.assign(reconstructedLines, data.reconstructed);
        if (data.translations) Object.assign(translationLines, data.translations);
        renderScore();
        hasChanges = true;
      }
    }

    // Check annotations.json
    if (currentTimestamps['annotations.json'] !== lastKnownTimestamps['annotations.json']) {
      console.log('annotations.json changed on disk, reloading...');
      const newAnnotations = await FileSystem.readAnnotations(dirHandle);
      if (newAnnotations) {
        annotations = newAnnotations;
        renderAnnotations();
        hasChanges = true;
      }
    }

    // Scan for new .txt files not yet in index.json (e.g. dropped into folder)
    const { newFiles, removedFiles } = await FileSystem.scanForNewManuscripts(dirHandle);

    // Handle new files discovered on disk
    if (newFiles.length > 0) {
      console.log('Discovered new manuscripts:', newFiles);
      for (const fileName of newFiles) {
        const id = `ms-${fileName.toLowerCase()}`;
        if (!manuscripts[id]) {
          const content = await FileSystem.readManuscript(dirHandle, fileName);
          if (content !== null) {
            manuscripts[id] = {
              siglum: fileName,
              displaySiglum: siglaMappings[fileName] || null,
              content
            };
            addManuscriptToList(id, fileName);
            hasChanges = true;
          }
        }
      }
    }

    // Handle files removed from disk
    if (removedFiles.length > 0) {
      console.log('Manuscripts removed from disk:', removedFiles);
      for (const fileName of removedFiles) {
        const id = `ms-${fileName.toLowerCase()}`;
        if (manuscripts[id]) {
          const li = document.querySelector(`[data-id="${id}"]`);
          if (li) li.remove();
          if (activeManuscript === id) {
            delete manuscripts[id];
            activeManuscript = null;
            const firstId = Object.keys(manuscripts)[0];
            if (firstId) {
              loadManuscript(firstId);
            } else {
              setEditorContent('No manuscripts yet. Click "+ Add" to create one.');
            }
          } else {
            delete manuscripts[id];
          }
          delete currentTimestamps[`manuscripts/${fileName}.txt`];
          hasChanges = true;
        }
      }
    }

    // Refresh timestamps if scan modified the index
    if (newFiles.length > 0 || removedFiles.length > 0) {
      const newTs = await getFileTimestamp(dirHandle, 'manuscripts/index.json');
      currentTimestamps['manuscripts/index.json'] = newTs;
      for (const fileName of newFiles) {
        const key = `manuscripts/${fileName}.txt`;
        currentTimestamps[key] = await getFileTimestamp(dirHandle, key);
      }
    }

    // Check images index for changes from other clients
    if (currentTimestamps['images/images-index.json'] !== lastKnownTimestamps['images/images-index.json']) {
      console.log('images-index.json changed on disk, reloading...');
      await loadImagesIndex();
      const activeTab = document.querySelector('.pane-tab.active');
      if (activeTab && activeTab.dataset.tab === 'images') {
        renderImages();
      }
      hasChanges = true;
    }

    // Check manuscript index for new/removed manuscripts
    if (currentTimestamps['manuscripts/index.json'] !== lastKnownTimestamps['manuscripts/index.json']) {
      console.log('index.json changed on disk, checking for new manuscripts...');
      const fileNames = await FileSystem.readManuscriptIndex(dirHandle);
      if (fileNames) {
        // Check for new manuscripts
        for (const fileName of fileNames) {
          const id = `ms-${fileName.toLowerCase()}`;
          if (!manuscripts[id]) {
            const content = await FileSystem.readManuscript(dirHandle, fileName);
            if (content !== null) {
              manuscripts[id] = {
                siglum: fileName,
                displaySiglum: siglaMappings[fileName] || null,
                content
              };
              addManuscriptToList(id, fileName);
              hasChanges = true;
            }
          }
        }
        // Check for removed manuscripts
        const indexSet = new Set(fileNames.map(f => `ms-${f.toLowerCase()}`));
        for (const id of Object.keys(manuscripts)) {
          if (!indexSet.has(id)) {
            const li = document.querySelector(`[data-id="${id}"]`);
            if (li) li.remove();
            if (activeManuscript === id) {
              activeManuscript = null;
              const firstId = Object.keys(manuscripts).find(k => k !== id);
              if (firstId) loadManuscript(firstId);
            }
            delete manuscripts[id];
            hasChanges = true;
          }
        }
      }
    }

    // Check each manuscript for content changes
    for (const id of Object.keys(manuscripts)) {
      const ms = manuscripts[id];
      const key = `manuscripts/${ms.siglum}.txt`;

      if (currentTimestamps[key] !== lastKnownTimestamps[key]) {
        // Skip the actively-edited manuscript
        if (id === activeManuscript && aceEditor && aceEditor.isFocused()) {
          continue;
        }

        console.log(`${ms.siglum}.txt changed on disk, reloading...`);
        const content = await FileSystem.readManuscript(dirHandle, ms.siglum);
        if (content !== null) {
          ms.content = content;
          // Update editor if this is the displayed manuscript
          if (id === activeManuscript) {
            isPollingUpdate = true;
            setEditorContent(content);
            isPollingUpdate = false;
          }
          hasChanges = true;
        }
      }
    }

    // Update baseline timestamps
    lastKnownTimestamps = currentTimestamps;

    if (hasChanges) {
      if (!hasUnsavedChanges) setStatus('connected', 'Synced');
      renderScore();
    }
  } catch (err) {
    console.error('Polling error:', err);
  }
}

// Stop polling when page is hidden, resume when visible
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopFilePolling();
  } else if (dirHandle && !filePollingInterval) {
    // Re-poll immediately when tab becomes visible, then resume interval
    pollForChanges();
    filePollingInterval = setInterval(pollForChanges, FILE_POLL_INTERVAL);
  }
});

// Also use BroadcastChannel for same-browser tab sync
let broadcastChannel = null;
try {
  broadcastChannel = new BroadcastChannel('manuscript-scorer-sync');
  broadcastChannel.onmessage = async (event) => {
    const msg = event.data;
    if (!msg || !dirHandle) return;

    if (msg.type === 'manuscript-saved' && msg.projectId === projectId) {
      const id = msg.manuscriptId;
      // Skip if we're the sender or if user is editing this manuscript
      if (id === activeManuscript && aceEditor && aceEditor.isFocused()) return;

      const ms = manuscripts[id];
      if (ms) {
        const content = await FileSystem.readManuscript(dirHandle, ms.siglum);
        if (content !== null) {
          ms.content = content;
          if (id === activeManuscript) {
            isPollingUpdate = true;
            setEditorContent(content);
            isPollingUpdate = false;
          }
          renderScore();
        }
      }
    } else if (msg.type === 'score-data-saved' && msg.projectId === projectId) {
      const data = await FileSystem.readScoreData(dirHandle);
      if (data) {
        Object.keys(reconstructedLines).forEach(k => delete reconstructedLines[k]);
        Object.keys(translationLines).forEach(k => delete translationLines[k]);
        if (data.reconstructed) Object.assign(reconstructedLines, data.reconstructed);
        if (data.translations) Object.assign(translationLines, data.translations);
        renderScore();
      }
    } else if (msg.type === 'annotations-saved' && msg.projectId === projectId) {
      annotations = await FileSystem.readAnnotations(dirHandle) || [];
      renderAnnotations();
    }
  };
} catch (e) {
  console.log('BroadcastChannel not available');
}

// Notify other tabs after saves
function notifyOtherTabs(type, extra = {}) {
  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage({ type, projectId, ...extra });
    } catch (e) {}
  }
}

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

  // Initialize Dark Mode
  initDarkMode();
  setupThemeToggle();

  // Setup resizable panes
  setupPaneResizer();

  // Setup tabs for score/colophons
  setupTabs();

  // Setup search all manuscripts
  setupSearchAll();

  // Setup siglum toggle
  setupSiglaToggle();
  setupEblPull();

  // Initialize collaboration
  initCollaboration();

  // Load saved score data (reconstructed text and translations)
  await loadScoreData();

  // Load annotations
  await loadAnnotations();
  renderAnnotations();

  // Load images index
  await loadImagesIndex();

  // Load manuscripts from local folder
  await loadManuscripts();

  // Sync loaded manuscripts to Y.js
  for (const id of Object.keys(manuscripts)) {
    syncManuscriptToYjs(id);
  }

  // Start file polling for auto-sync
  await initFilePolling();

  console.log('Manuscript Scorer initialized');
}

init();

// ===========================================
// RECONSTRUCTED VIEW + EXPORT TO eBL
// ===========================================
//
// Opens a full-screen Ace editor containing the eBL ATF artifact compiled
// from the current score + manuscripts.json metadata. Witness edits in this
// view sync back to the underlying manuscript .txt files on close.
// Export sends the artifact to the eBL corpus chapter configured under
// projectConfig.ebl.target.

const reconView = document.getElementById('recon-view');
const reconAceEl = document.getElementById('recon-ace');
const reconStatusEl = document.getElementById('recon-status');
const reconViewBtn = document.getElementById('recon-view-btn');
const reconCloseBtn = document.getElementById('recon-close-btn');
const reconRefreshBtn = document.getElementById('recon-refresh-btn');
const reconExportBtn = document.getElementById('recon-export-btn');
const reconValidateBtn = document.getElementById('recon-validate-btn');
const reconTokenPill = document.getElementById('recon-token-pill');
const reconTokenText = document.getElementById('recon-token-text');
const reconSubtitle = document.getElementById('recon-view-subtitle');

const exportModal = document.getElementById('export-modal');
const exportCloseBtn = document.getElementById('export-close-btn');
const exportCancelBtn = document.getElementById('export-cancel-btn');
const exportGoBtn = document.getElementById('export-go-btn');
const exportTargetEl = document.getElementById('export-target');
const exportTokenStatusEl = document.getElementById('export-token-status');
const exportMsSummaryEl = document.getElementById('export-ms-summary');
const exportWarningsEl = document.getElementById('export-warnings');
const exportProgressEl = document.getElementById('export-progress');
const exportResultEl = document.getElementById('export-result');

let reconAceEditor = null;
let reconLineMap = null;        // [{ row, kind, lineNum, ... }] from EblAtf.buildChapterAtf
let reconOriginalAtf = '';      // The ATF as last compiled (used by diffArtifact)

// Runtime capability flags — detected at startup.
// - desktop mode: bundled validator available via /api/validate-atf
// - dev mode: server.js running with a system Python+lark available
// - browser mode: no backend at all (e.g. GitHub Pages), eBL server is the only validator
let runtimeMode = 'browser';     // 'desktop' | 'dev' | 'browser'
let localValidatorAvailable = false;

async function probeRuntimeCapabilities() {
  try {
    const res = await fetch('/api/health', { method: 'GET' });
    if (!res.ok) throw new Error('no health endpoint');
    const data = await res.json();
    if (data && data.app === 'cuneiform-scorer') {
      runtimeMode = data.mode || 'dev';
      localValidatorAvailable = !!data.validator;
    }
  } catch (_) {
    runtimeMode = 'browser';
    localValidatorAvailable = false;
  }
  applyRuntimeCapabilities();
}

function applyRuntimeCapabilities() {
  // Hide the Validate button when no local validator is reachable. The button
  // is rebuilt fresh whenever Recon view opens; we set display directly so
  // it survives across opens until the next probe.
  const btn = document.getElementById('recon-validate-btn');
  if (btn) {
    btn.style.display = localValidatorAvailable ? '' : 'none';
  }
}

// Kick off the probe in the background; it'll resolve before the user opens
// Recon view in any realistic scenario.
probeRuntimeCapabilities();

// ---- Open / close ----

async function openReconView() {
  if (!window.EblAtf || !window.EblClient) {
    alert('eBL client not loaded. Reload the page.');
    return;
  }
  reconView.classList.remove('hidden');
  await refreshReconArtifact();
  initReconAce();
  updateReconTokenPill();
  document.body.style.overflow = 'hidden';
}

async function closeReconView() {
  // Sync any edits back before hiding
  await syncReconEditsBack();
  reconView.classList.add('hidden');
  document.body.style.overflow = '';
}

// ---- Compile artifact from current score ----

async function refreshReconArtifact() {
  // Build scoreLines via existing buildScore()
  const { scoreLines } = buildScore();
  if (!manuscriptsMeta) {
    manuscriptsMeta = await FileSystem.readManuscriptsMeta(dirHandle) || { version: 1, manuscripts: [] };
  }
  // Reconcile manuscripts.json against current manuscript list so newly
  // added files show up with default rows
  const filesOnDisk = Object.values(manuscripts).map((m) => m.siglum + '.txt');
  manuscriptsMeta = EblClient.reconcileManuscripts(manuscriptsMeta, filesOnDisk);

  const eblSiglumByFile = await EblAtf.buildEblSiglumMap(manuscriptsMeta, EblClient);
  const result = await EblAtf.buildChapterAtf({
    scoreLines,
    reconstructedLines,
    manuscriptsMeta,
    eblSiglumByFile,
  });

  reconOriginalAtf = result.atf;
  reconLineMap = result.lineMap;

  const target = (projectConfig && projectConfig.ebl && projectConfig.ebl.target) || null;
  const modeLabel = localValidatorAvailable
    ? '(local validation available)'
    : '(browser mode — eBL server validates on export)';
  reconSubtitle.textContent = target
    ? `→ ${target.genre}/${target.category}/${target.index}/${target.stage}/${target.name} · ${Object.keys(scoreLines).length} chapter lines · ${manuscriptsMeta.manuscripts.length} manuscripts · ${modeLabel}`
    : `No eBL target configured. Set one in Manage. ${modeLabel}`;

  if (reconAceEditor) {
    reconAceEditor.setValue(reconOriginalAtf, -1);
    reconAceEditor.session.clearAnnotations();
    hideReconStatus();
  }
}

function initReconAce() {
  if (reconAceEditor) {
    reconAceEditor.resize(true);
    return;
  }
  reconAceEditor = ace.edit('recon-ace');
  const dark = document.body.classList.contains('dark-mode');
  reconAceEditor.setTheme(dark ? 'ace/theme/tomorrow_night' : 'ace/theme/chrome');
  reconAceEditor.session.setMode('ace/mode/cuneiform_score');
  reconAceEditor.setOptions({
    fontSize: '14px',
    fontFamily: '"Consolas", "Monaco", monospace',
    showPrintMargin: false,
    showGutter: true,
    wrap: true,
    tabSize: 2,
    useSoftTabs: true,
  });
  reconAceEditor.setValue(reconOriginalAtf, -1);
  markUnmatchedBrackets(reconAceEditor);
  reconAceEditor.session.on('change', () => markUnmatchedBrackets(reconAceEditor));
}

// ---- Sync witness edits back to manuscript files ----

async function syncReconEditsBack() {
  if (!reconAceEditor || !reconLineMap) return;
  const edited = reconAceEditor.getValue();
  if (edited === reconOriginalAtf) return;

  const diff = EblAtf.diffArtifact(reconLineMap, reconOriginalAtf, edited);
  const reconEdits = diff.reconstructionEdits;
  const witnessEdits = diff.witnessEdits;

  // Apply reconstruction edits to in-memory state + score-data.json
  for (const e of reconEdits) {
    reconstructedLines[e.lineNum] = e.newContent;
  }

  // Group witness edits by manuscript and apply to each .txt
  const editsByMs = new Map();
  for (const e of witnessEdits) {
    if (!editsByMs.has(e.msKey)) editsByMs.set(e.msKey, []);
    editsByMs.get(e.msKey).push(e);
  }

  const touchedFiles = [];
  for (const [msKey, edits] of editsByMs) {
    // Find the in-memory manuscript by siglum
    const msEntry = Object.values(manuscripts).find((m) => m.siglum === msKey);
    if (!msEntry) continue;
    let content = msEntry.content;
    for (const e of edits) {
      const res = EblAtf.applyWitnessEditToManuscript(content, e);
      if (res.ok) content = res.content;
    }
    if (content !== msEntry.content) {
      msEntry.content = content;
      await FileSystem.writeManuscript(dirHandle, msKey, content);
      touchedFiles.push(msKey);
    }
  }

  // Persist reconstructed text + redraw the score so the user sees the changes
  if (reconEdits.length || touchedFiles.length) {
    await saveScoreDataToFile();
    renderScore();
    const parts = [];
    if (reconEdits.length) parts.push(`${reconEdits.length} reconstruction edit${reconEdits.length === 1 ? '' : 's'}`);
    if (touchedFiles.length) parts.push(`${touchedFiles.length} manuscript${touchedFiles.length === 1 ? '' : 's'} updated (${touchedFiles.join(', ')})`);
    setStatus('connected', 'Synced: ' + parts.join(', '));
    setTimeout(() => setStatus('connected', 'Ready'), 4000);
  }

  if (diff.unmatched.length) {
    // Drift — user inserted/deleted whole lines. Surface a non-blocking note.
    showReconStatus({
      title: `${diff.unmatched.length} unmatched row${diff.unmatched.length === 1 ? '' : 's'} (structural changes are not synced back)`,
      items: diff.unmatched.map((u) => ({ line: u.row + 1, message: `${u.oldText || '(empty)'} → ${u.newText || '(empty)'}` })),
    });
  }
}

// ---- Token pill in the Recon view header ----

function updateReconTokenPill() {
  const s = EblClient.tokenStatus();
  reconTokenPill.classList.remove('ok', 'warn', 'bad');
  if (!s.hasToken) { reconTokenPill.classList.add('warn'); reconTokenText.textContent = 'No token'; return; }
  if (s.invalid) { reconTokenPill.classList.add('bad'); reconTokenText.textContent = 'Invalid JWT'; return; }
  if (s.expired) { reconTokenPill.classList.add('bad'); reconTokenText.textContent = 'Token expired'; return; }
  if (!s.hasWriteTexts) { reconTokenPill.classList.add('warn'); reconTokenText.textContent = 'No write:texts'; return; }
  reconTokenPill.classList.add('ok'); reconTokenText.textContent = 'write:texts ready';
}

// ---- Status panel below Ace (used for unmatched + import errors) ----

function showReconStatus({ title, items, onItemClick }) {
  const titleHtml = `<div class="recon-status-title">${escapeHtml(title)}</div>`;
  const listHtml = '<ul>' + items.map((it, i) => {
    const lineLabel = it.line != null ? `<span class="err-line">line ${it.line}</span>` : '';
    return `<li data-idx="${i}">${lineLabel}${escapeHtml(it.message)}</li>`;
  }).join('') + '</ul>';
  reconStatusEl.innerHTML = titleHtml + listHtml;
  reconStatusEl.classList.remove('hidden');
  if (onItemClick) {
    reconStatusEl.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => onItemClick(items[Number(li.dataset.idx)]));
    });
  }
}

function hideReconStatus() {
  reconStatusEl.classList.add('hidden');
  reconStatusEl.innerHTML = '';
}

// ---- Export modal ----

function openExportModal() {
  updateReconTokenPill();
  const target = (projectConfig && projectConfig.ebl && projectConfig.ebl.target) || null;
  exportTargetEl.textContent = target
    ? `${target.genre}/${target.category}/${target.index}/${target.stage}/${target.name}`
    : 'Not configured — set in Manage';

  const ts = EblClient.tokenStatus();
  if (!ts.hasToken) exportTokenStatusEl.textContent = 'No token (paste one in Manage)';
  else if (ts.expired) exportTokenStatusEl.textContent = 'Expired (refresh in Manage)';
  else if (!ts.hasWriteTexts) exportTokenStatusEl.textContent = 'Missing write:texts scope';
  else exportTokenStatusEl.textContent = `OK · expires in ${Math.round((ts.expiresInSec || 0) / 60)} min`;

  const msCount = (manuscriptsMeta?.manuscripts || []).length;
  const problems = EblClient.validateManuscripts(manuscriptsMeta || { manuscripts: [] });
  exportMsSummaryEl.textContent = `${msCount} manuscript${msCount === 1 ? '' : 's'}${problems.length ? ` · ${problems.length} with missing metadata` : ''}`;

  const warningSections = [];
  if (problems.length) {
    warningSections.push(
      '<strong>Manuscript metadata warnings (eBL may reject):</strong><ul style="margin-top: 0.4rem; padding-left: 1.2rem;">' +
      problems.map((p) => `<li>${escapeHtml(p.file)}: ${escapeHtml(p.errors.join(', '))}</li>`).join('') +
      '</ul>'
    );
  }
  if (!localValidatorAvailable) {
    warningSections.push(
      '<strong>Browser mode:</strong> the ATF has not been validated locally. Any grammar errors will be reported by eBL during import (line numbers will be annotated in the Recon view).'
    );
  }
  if (warningSections.length) {
    exportWarningsEl.classList.remove('hidden');
    exportWarningsEl.innerHTML = warningSections.join('<hr style="margin: 0.6rem 0; border: 0; border-top: 1px solid #f4c890;">');
  } else {
    exportWarningsEl.classList.add('hidden');
    exportWarningsEl.innerHTML = '';
  }

  exportProgressEl.classList.add('hidden');
  exportResultEl.classList.add('hidden');
  exportResultEl.innerHTML = '';
  exportProgressEl.querySelectorAll('.export-step').forEach((s) => {
    s.classList.remove('running', 'done', 'error');
    s.querySelector('.step-icon').textContent = '·';
  });

  const canExport = target && ts.hasToken && !ts.expired && ts.hasWriteTexts;
  exportGoBtn.disabled = !canExport;
  exportGoBtn.title = canExport ? '' : 'Cannot export — fix token/target first';

  exportModal.classList.remove('hidden');
}

function closeExportModal() {
  exportModal.classList.add('hidden');
}

async function runExport() {
  const target = projectConfig.ebl.target;
  const atfText = reconAceEditor ? reconAceEditor.getValue() : reconOriginalAtf;

  exportGoBtn.disabled = true;
  exportCancelBtn.textContent = 'Close';
  exportProgressEl.classList.remove('hidden');
  exportResultEl.classList.add('hidden');

  const setStep = (step, state) => {
    const el = exportProgressEl.querySelector(`.export-step[data-step="${step}"]`);
    if (!el) return;
    el.classList.remove('running', 'done', 'error');
    el.classList.add(state);
    if (state === 'running') el.querySelector('.step-icon').textContent = '…';
  };

  try {
    // Step 1: POST /manuscripts
    setStep('manuscripts', 'running');
    const eblMss = EblClient.toEblManuscripts(manuscriptsMeta);
    await EblClient.postManuscripts(target, eblMss, []);
    setStep('manuscripts', 'done');

    // Step 2: POST /import — strip visual table-formatting before sending
    setStep('import', 'running');
    const wireAtf = EblAtf.stripFormatting(atfText);
    await EblClient.postImport(target, wireAtf);
    setStep('import', 'done');

    // Success
    const url = `https://www.ebl.lmu.de/corpus/${target.genre}/${target.category}/${target.index}/${target.stage}/${target.name}`;
    exportResultEl.classList.remove('hidden');
    exportResultEl.classList.add('success');
    exportResultEl.classList.remove('failure');
    exportResultEl.innerHTML = `Exported successfully. <a href="${url}" target="_blank" rel="noopener noreferrer">View chapter on eBL →</a>`;
  } catch (err) {
    // Figure out which step failed by looking for which step is currently running
    const running = exportProgressEl.querySelector('.export-step.running');
    if (running) setStep(running.dataset.step, 'error');

    exportResultEl.classList.remove('hidden');
    exportResultEl.classList.remove('success');
    exportResultEl.classList.add('failure');

    if (err instanceof EblClient.EblError) {
      const validationErrors = err.validationErrors;
      const details = validationErrors
        ? validationErrors.map((e) => (e.line != null ? `Line ${e.line}: ${e.message}` : e.message)).join('<br>')
        : escapeHtml(err.rawBody || err.message);
      exportResultEl.innerHTML = `<strong>${escapeHtml(err.message)}</strong><br>${details}`;
      // If the failed step was import and we have validation errors, push them into Ace
      if (running && running.dataset.step === 'import' && validationErrors) {
        applyValidationErrorsToAce(validationErrors);
        // Surface them clickably below Ace too
        showReconStatus({
          title: 'eBL import validation errors',
          items: validationErrors.map((e) => ({
            line: e.line,
            message: e.message,
          })),
          onItemClick: (it) => {
            if (it.line != null) {
              reconAceEditor.gotoLine(it.line, 0, true);
              reconAceEditor.focus();
            }
          },
        });
      }
    } else {
      exportResultEl.textContent = err.message || String(err);
    }
  } finally {
    exportGoBtn.disabled = false;
  }
}

function applyValidationErrorsToAce(validationErrors) {
  if (!reconAceEditor) return;
  const anns = validationErrors
    .filter((e) => e.line != null)
    .map((e) => ({
      row: Math.max(0, e.line - 1),
      column: (e.column || 1) - 1,
      text: e.message,
      type: 'error',
    }));
  reconAceEditor.session.setAnnotations(anns);
}

// ---- Wire buttons ----

if (reconViewBtn) reconViewBtn.addEventListener('click', openReconView);
if (reconCloseBtn) reconCloseBtn.addEventListener('click', closeReconView);
if (reconRefreshBtn) reconRefreshBtn.addEventListener('click', async () => {
  if (reconAceEditor && reconAceEditor.getValue() !== reconOriginalAtf) {
    if (!confirm('You have in-view edits that will be lost. Refresh anyway?')) return;
  }
  await refreshReconArtifact();
});
if (reconValidateBtn) reconValidateBtn.addEventListener('click', validateRecon);
if (reconExportBtn) reconExportBtn.addEventListener('click', openExportModal);

// ---- Local ATF validation via the server.js → Python sidecar ----

const VALIDATE_MAX_ERRORS = 5;

async function validateRecon() {
  if (!reconAceEditor) return;
  const atfText = reconAceEditor.getValue();
  const stripped = (window.EblAtf && EblAtf.stripFormatting)
    ? EblAtf.stripFormatting(atfText)
    : atfText;

  reconValidateBtn.disabled = true;
  const origLabel = reconValidateBtn.textContent;
  reconValidateBtn.textContent = 'Validating…';
  try {
    const res = await fetch('/api/validate-atf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ atf: stripped }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showReconStatus({
        title: `Validator unavailable (HTTP ${res.status})`,
        items: [{ message: body.hint || body.error || res.statusText }],
      });
      reconAceEditor.session.clearAnnotations();
      return;
    }

    const result = await res.json();
    if (result.valid) {
      reconAceEditor.session.clearAnnotations();
      showReconStatus({
        title: `Valid · ${result.parsed_lines} line${result.parsed_lines === 1 ? '' : 's'} parsed by ${result.validation_source}`,
        items: [],
      });
      return;
    }

    // Map artifact-row errors back to Ace rows. Because we stripped formatting
    // before sending to Python, the validator's line numbers correspond to the
    // *stripped* version, not the on-screen buffer. Each row has a 1:1 line
    // mapping (stripFormatting is per-line), so the row indices match.
    const errors = (result.errors || []).slice(0, VALIDATE_MAX_ERRORS);
    const total = result.errors.length;

    reconAceEditor.session.setAnnotations(errors.map((e) => ({
      row: Math.max(0, (e.line || 1) - 1),
      column: Math.max(0, (e.column || 1) - 1),
      text: e.message,
      type: 'error',
    })));

    showReconStatus({
      title: total > VALIDATE_MAX_ERRORS
        ? `${VALIDATE_MAX_ERRORS} of ${total} errors (fix these and Validate again to see the rest)`
        : `${total} error${total === 1 ? '' : 's'}`,
      items: errors.map((e) => ({
        line: e.line,
        message: (e.column != null ? `col ${e.column}: ` : '') + e.message,
      })),
      onItemClick: (it) => {
        if (it.line != null) {
          reconAceEditor.gotoLine(it.line, (errors.find(x => x.line === it.line)?.column || 1) - 1, true);
          reconAceEditor.focus();
        }
      },
    });
  } catch (err) {
    showReconStatus({
      title: 'Validator request failed',
      items: [{ message: err.message }],
    });
  } finally {
    reconValidateBtn.textContent = origLabel;
    reconValidateBtn.disabled = false;
  }
}

if (exportCloseBtn) exportCloseBtn.addEventListener('click', closeExportModal);
if (exportCancelBtn) exportCancelBtn.addEventListener('click', closeExportModal);
if (exportGoBtn) exportGoBtn.addEventListener('click', runExport);
exportModal && exportModal.addEventListener('click', (e) => {
  if (e.target === exportModal) closeExportModal();
});
