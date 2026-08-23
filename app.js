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
// The rest of the eBL "reconstruction" block. The grammar allows at most one
// note and any number of parallels per reading —
//   reconstruction: text_line [_NEWLINE note_line] (_NEWLINE parallel_line)*
// so a note is a single string and parallels are an ordered list.
const noteLines = {};     // { [lineNum]: string }   — text after "#note: "
const parallelLines = {}; // { [lineNum]: string[] } — text after "// "
// Readings *beyond* the first. The main reading stays in the three maps above
// so older score-data.json files keep loading; this holds variants 1..n, each
// with its own note and parallels like any other reading.
//   { [lineNum]: [{ text, note, parallels }] }
const variantLines = {};
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

  const del = document.createElement('button');
  del.className = 'delete-manuscript-btn';
  del.type = 'button';
  del.dataset.id = id;
  del.title = 'Delete ' + museumNum;
  del.setAttribute('aria-label', 'Delete ' + museumNum);
  del.innerHTML = '&times;';
  li.appendChild(del);

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

// Balance check over a line, optionally ignoring some positions.
function scanBrackets(text, skip) {
  const bad = new Set();
  for (const [open, close] of ATF_PAIRS) {
    const stack = [];
    for (let i = 0; i < text.length; i++) {
      if (skip && skip.has(i)) continue;
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

// Positions of a bracket repeated within one "/" word — the second and later
// occurrences of the same character.
function repeatedAlternativeBrackets(text) {
  const skip = new Set();
  const word = /\S+/g;
  let m;
  while ((m = word.exec(text)) !== null) {
    if (m[0].indexOf('/') === -1) continue;
    const seen = new Set();
    for (let k = 0; k < m[0].length; k++) {
      const ch = m[0][k];
      if (!ATF_OPENERS.has(ch) && !ATF_CLOSERS.has(ch)) continue;
      if (seen.has(ch)) skip.add(m.index + k);
      else seen.add(ch);
    }
  }
  return skip;
}

// Indices of unmatched brackets in a line.
//
// A "/" inside a word offers alternative readings the editor could not decide
// between, and their brackets do not read linearly. Sometimes the break is
// written once per reading and is one bracket seen twice —
// "NI[GIN/NI[GIN₂-ME/MEŠ]" — and sometimes the alternation is only in the final
// signs and every bracket is its own — "m]i?-iq#-[tu₂/tu₄]", "{mul/d}]e₂".
// Which applies cannot be told without expanding the alternatives, so a line is
// accepted if it balances under either reading: literally, or with a bracket
// repeated inside a "/" word counted once. Only a line that fails both is
// reported, and the positions shown are the literal ones.
function unmatchedBrackets(text) {
  const literal = scanBrackets(text, null);
  if (literal.size === 0) return literal;
  const repeats = repeatedAlternativeBrackets(text);
  if (repeats.size === 0) return literal;
  return scanBrackets(text, repeats).size === 0 ? new Set() : literal;
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
// Ordering inside one section: by witness first, then a manuscript's own
// "$" directives after its reading, so a ruling sits under the line it
// follows rather than at the foot of the section.
function scoreEntryOrder(a, b) {
  const byWitness = witnessOrder(a, b);
  if (byWitness !== 0) return byWitness;
  const rank = (e) => (e.type === 'line' ? 0 : 1);
  return rank(a) - rank(b);
}

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
// ---- Line variants -------------------------------------------------------
// A reading is tied to one of a line's variants by a letter on the § marker:
// "§34" (or "§34a") is the main reading, "§34b" the second, "§34c" the third.
// eBL keeps the first variant's line number for the whole chapter line and
// discards the rest, so the letter is ours alone — it never leaves this app.
function variantIndexOf(letter) {
  if (!letter) return 0;
  const i = letter.toLowerCase().charCodeAt(0) - 97; // 'a' -> 0, 'b' -> 1
  return i > 0 ? i : 0;
}

function variantLetterOf(index) {
  return index > 0 ? String.fromCharCode(97 + index) : '';
}

// One uniform list of a line's readings. Index 0 is assembled from the primary
// maps, so everything downstream can loop over readings without caring that
// the first one is stored differently on disk.
function variantsFor(lineNum) {
  const readings = [{
    text: reconstructedLines[lineNum] || '',
    note: noteLines[lineNum],
    parallels: parallelLines[lineNum] || [],
  }];
  for (const v of (variantLines[lineNum] || [])) {
    readings.push({
      text: (v && v.text) || '',
      note: v ? v.note : undefined,
      parallels: (v && v.parallels) || [],
    });
  }
  return readings;
}

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

    // A "$" directive carrying a score assignment:
    //   §18 18. $ single ruling   /   §18 $ single ruling   /   §21 23 $ ...
    // Without this the first form parsed as a witness reading whose text was
    // "$ single ruling", and the other two matched nothing at all and were
    // dropped without a word. The manuscript line number is optional because a
    // ruling sits between lines rather than on one.
    const assignedDollar = trimmed.match(/^§(\d+)([a-z]?)(?:\s+([^\s$]+))?\s*\$\s*(.*)$/);
    if (assignedDollar) {
      const directive = assignedDollar[4].trim();
      const isRuling = /ruling/i.test(directive);
      entries.push({
        siglum,
        type: isRuling ? 'ruling' : 'comment',
        targetLine: parseInt(assignedDollar[1], 10),
        variant: variantIndexOf(assignedDollar[2]),
        sourceLine: (assignedDollar[3] || '').replace(/\.$/, ''),
        rulingType: isRuling
          ? (directive.match(/single|double|triple/i)?.[0]?.toLowerCase() || 'single')
          : undefined,
        content: directive,
        surface: currentSurface
      });
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

    // Check for §[target][variant] [source]. pattern — supports primed numbers
    // like 1', 2' and an optional variant letter: "§34b 7'." puts this reading
    // under the line's second variant instead of its main one.
    const match = trimmed.match(/^§(\d+)([a-z]?)\s+(\d+'?)\.\s*(.*)$/);
    if (match) {
      const targetLine = parseInt(match[1], 10);
      const sourceLine = match[3].trim();
      const content = match[4].trim();

      const entry = {
        siglum,
        type: 'line',
        targetLine,
        variant: variantIndexOf(match[2]),
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
    const oldMatch = trimmed.match(/^§(\d+)([a-z]?)\s+([^.]+)\.\s*(.*)$/);
    if (oldMatch) {
      const targetLine = parseInt(oldMatch[1], 10);
      const sourceLine = oldMatch[3].trim();
      const content = oldMatch[4].trim();

      const entry = {
        siglum,
        type: 'line',
        targetLine,
        variant: variantIndexOf(oldMatch[2]),
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

  // Everything assigned to a § goes into scoreLines, tagged with its type —
  // readings and the "$" directives alike. Keeping the directives in a second
  // bucket meant only whichever view remembered to read it saw them, which is
  // how the score pane and the reconstructed view came to disagree. One
  // channel, so a consumer cannot silently miss them; each decides what to do
  // with a non-'line' entry.
  const scoreLines = {};
  const rulings = [];
  const comments = [];

  for (const entry of allEntries) {
    if (entry.type === 'ruling' || entry.type === 'comment') {
      (entry.type === 'ruling' ? rulings : comments).push(entry);
      if (!entry.targetLine) continue;      // unassigned: not part of the score
    } else if (entry.type !== 'line') {
      continue;
    }
    if (!scoreLines[entry.targetLine]) scoreLines[entry.targetLine] = [];
    scoreLines[entry.targetLine].push(entry);
  }

  for (const n of Object.keys(scoreLines)) scoreLines[n].sort(scoreEntryOrder);

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

    const translation = translationLines[lineNum] || '';

    html += `<div class="score-line" data-line="${lineNum}">`;
    // Translation line — it belongs to the chapter line, so it stays above
    // every reading rather than under one of them.
    html += `<div class="translation-line"><span class="translation-text" contenteditable="true" data-line="${lineNum}">${escapeHtml(translation)}</span></div>`;

    // One block per reading: the reading itself, its note and parallels, then
    // the witnesses that attest it (those whose § marker carries its letter).
    const readings = variantsFor(lineNum);
    for (let vi = 0; vi < readings.length; vi++) {
      const reading = readings[vi];
      const letter = variantLetterOf(vi);

      html += `<div class="score-line-header${vi ? ' is-variant' : ''}">`;
      html += `<span class="line-label">§ ${lineNum}${letter}</span> `;
      html += `<span class="reconstructed-text" contenteditable="true" data-line="${lineNum}" data-variant="${vi}">${renderAtf(reading.text)}</span>`;
      // Notes anchored to this §, open ones only: resolved notes stop tugging
      // at the eye but stay reachable through the panel.
      if (vi === 0) {
        const openNotes = annotations.filter((a) => parseInt(a.sec, 10) === lineNum && a.status === 'open').length;
        if (openNotes) {
          html += `<button type="button" class="score-note-dot" data-line="${lineNum}" ` +
                  `title="${openNotes} open note${openNotes === 1 ? '' : 's'} on § ${lineNum}">${openNotes}</button>`;
        }
      }
      // One affordance, not three. The grammar allows a single note per reading,
      // so that entry disables itself once this reading has one.
      html += `<span class="recon-add-wrap">`;
      html += `<button class="recon-add" data-line="${lineNum}" data-variant="${vi}" title="Add a note, a parallel or a variant">+</button>`;
      html += `<span class="recon-add-menu hidden">`;
      html += `<button class="recon-add-item" data-kind="note" data-line="${lineNum}" data-variant="${vi}"${reading.note != null ? ' disabled' : ''}>Note<em>#note:</em></button>`;
      html += `<button class="recon-add-item" data-kind="parallel" data-line="${lineNum}" data-variant="${vi}">Parallel<em>//</em></button>`;
      html += `<button class="recon-add-item" data-kind="variant" data-line="${lineNum}" data-variant="${vi}">Variant<em>§${lineNum}${variantLetterOf(readings.length)}</em></button>`;
      if (vi > 0) {
        html += `<button class="recon-add-item danger" data-kind="drop-variant" data-line="${lineNum}" data-variant="${vi}">Delete this variant<em>✕</em></button>`;
      }
      html += `</span></span>`;
      html += `</div>`;

      // The rest of the reconstruction block, in the order eBL fixes: note, then
      // parallels. Both hang off the reading above them.
      // != null, not truthiness — a freshly added row is an empty string and
      // still has to render so the caret has somewhere to go.
      if (reading.note != null) {
        html += `<div class="recon-extra recon-note">`;
        html += `<span class="recon-extra-prefix">#note:</span>`;
        html += `<span class="recon-extra-text" contenteditable="true" data-kind="note" data-line="${lineNum}" data-variant="${vi}">${escapeHtml(reading.note)}</span>`;
        html += `</div>`;
      }
      for (let pi = 0; pi < reading.parallels.length; pi++) {
        html += `<div class="recon-extra recon-parallel">`;
        html += `<span class="recon-extra-prefix">//</span>`;
        html += `<span class="recon-extra-text" contenteditable="true" data-kind="parallel" data-line="${lineNum}" data-variant="${vi}" data-index="${pi}">${escapeHtml(reading.parallels[pi])}</span>`;
        html += `</div>`;
      }

      for (const w of witnesses.filter((x) => (x.variant || 0) === vi)) {
        // A "$" directive assigned to this section: a ruling on the tablet,
        // shown against the witness it belongs to rather than as a reading.
        if (w.type !== 'line') {
          const ref = w.sourceLine
            ? displaySiglum(w.siglum) + ' ' + abbreviateSurface(w.surface) + ' ' + w.sourceLine
            : displaySiglum(w.siglum);
          html += `<div class="score-extra${typeClass(w.siglum)}">`;
          html += `<span class="witness-siglum">${escapeHtml(ref)}</span>`;
          html += `<span class="score-extra-text">${escapeHtml(w.content || ((w.rulingType || 'single') + ' ruling'))}</span>`;
          html += `</div>`;
          continue;
        }
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
    } // end of readings loop

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
      const vi = Number(e.target.dataset.variant || 0);
      writeReading(lineNum, vi, e.target.innerText);
      // Collaborators only mirror the main reading for now.
      if (!vi) syncReconstructedToYjs(lineNum, e.target.innerText);
      markUnsaved();
    });
    // The composite line is contenteditable, so the bracket spans are only
    // shown while it is NOT being edited: typing inside styled spans makes the
    // browser split and merge them and the caret jumps. Plain text on focus,
    // colour back on blur. The stored value is unaffected either way — the
    // input handler reads innerText, which ignores markup.
    el.addEventListener('focus', (e) => {
      e.target.textContent = readReading(e.target.dataset.line, Number(e.target.dataset.variant || 0));
    });
    el.addEventListener('blur', (e) => {
      const text = e.target.innerText;
      writeReading(e.target.dataset.line, Number(e.target.dataset.variant || 0), text);
      e.target.innerHTML = renderAtf(text);
    });
    // Same two additions without reaching for the mouse.
    el.addEventListener('keydown', (e) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== 'n' && key !== 'p') return;
      e.preventDefault();
      addReconExtra(e.target.dataset.line, Number(e.target.dataset.variant || 0),
                    key === 'n' ? 'note' : 'parallel');
    });
  });

  // The "+" affordance on each reading
  scorePanel.querySelectorAll('.recon-add').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.parentElement.querySelector('.recon-add-menu');
      const wasHidden = menu.classList.contains('hidden');
      closeReconAddMenus();
      if (wasHidden) menu.classList.remove('hidden');
    });
  });
  scorePanel.querySelectorAll('.recon-add-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeReconAddMenus();
      const lineNum = btn.dataset.line;
      const vi = Number(btn.dataset.variant || 0);
      if (btn.dataset.kind === 'variant') openVariantDialog(lineNum, vi);
      else if (btn.dataset.kind === 'drop-variant') dropVariant(lineNum, vi);
      else addReconExtra(lineNum, vi, btn.dataset.kind);
    });
  });

  // Note and parallel rows. The "#note:" / "//" prefix is a chip owned by the
  // row rather than text to retype, so it cannot be mistyped or lost.
  scorePanel.querySelectorAll('.recon-extra-text').forEach(el => {
    el.addEventListener('input', (e) => {
      writeReconExtra(e.target, e.target.innerText);
      markUnsaved();
    });
    // Clearing a row and leaving it is how you delete it.
    el.addEventListener('blur', (e) => {
      const text = e.target.innerText.trim();
      writeReconExtra(e.target, text);
      if (!text) {
        removeReconExtra(e.target);
        renderScore();
      }
      saveScoreDataToFile();
    });
  });
}

// ---- Note / parallel rows under a reading ----

function closeReconAddMenus() {
  document.querySelectorAll('.recon-add-menu').forEach(m => m.classList.add('hidden'));
}
document.addEventListener('click', closeReconAddMenus);

// Reading 0 lives in the primary maps, readings 1..n in variantLines. These
// four keep that split in one place so callers just say "line 34, reading 1".
function variantSlot(lineNum, vi) {
  if (!vi) return null;
  const list = variantLines[lineNum];
  return Array.isArray(list) ? list[vi - 1] : null;
}

function readReading(lineNum, vi) {
  const slot = variantSlot(lineNum, vi);
  return (slot ? slot.text : reconstructedLines[lineNum]) || '';
}

function writeReading(lineNum, vi, text) {
  const slot = variantSlot(lineNum, vi);
  if (slot) slot.text = text;
  else reconstructedLines[lineNum] = text;
}

// Add a note or a parallel to one reading, then put the caret in it.
function addReconExtra(lineNum, vi, kind) {
  const slot = variantSlot(lineNum, vi);
  if (kind === 'note') {
    if (slot) {
      if (slot.note != null) return;      // the grammar allows only one
      slot.note = '';
    } else {
      if (noteLines[lineNum] != null) return;
      noteLines[lineNum] = '';
    }
  } else {
    if (slot) {
      if (!Array.isArray(slot.parallels)) slot.parallels = [];
      slot.parallels.push('');
    } else {
      if (!Array.isArray(parallelLines[lineNum])) parallelLines[lineNum] = [];
      parallelLines[lineNum].push('');
    }
  }
  markUnsaved();
  renderScore();

  const base = `.recon-extra-text[data-kind="${kind}"][data-line="${lineNum}"][data-variant="${vi}"]`;
  const list = slot ? slot.parallels : parallelLines[lineNum];
  const sel = kind === 'note' ? base : `${base}[data-index="${list.length - 1}"]`;
  const el = scorePanel.querySelector(sel);
  if (el) el.focus();
}

// ---- Add a line variant --------------------------------------------------

// What the user has selected inside a reading, if anything. Used to prefill
// the dialog so a one-word divergence doesn't mean retyping the whole line.
function selectionWithin(el) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString();
  return text.trim() ? text : null;
}

// srcVi is the reading the "+" was pressed on; the new variant is appended
// after every existing one, so its letter is readings.length.
function openVariantDialog(lineNum, srcVi) {
  const dialog = document.getElementById('variant-dialog');
  const textEl = document.getElementById('variant-text');
  const listEl = document.getElementById('variant-witnesses');
  const titleEl = document.getElementById('variant-dialog-title');
  const cancelBtn = document.getElementById('variant-cancel');
  const form = document.getElementById('variant-form');
  if (!dialog) return;

  const readings = variantsFor(lineNum);
  const newVi = readings.length;
  const newLetter = variantLetterOf(newVi);
  titleEl.textContent = `Add variant §${lineNum}${newLetter}`;

  // Start from the reading it branches off, so only the divergence is retyped.
  const sourceEl = scorePanel.querySelector(
    `.reconstructed-text[data-line="${lineNum}"][data-variant="${srcVi}"]`);
  const base = readings[srcVi] ? readings[srcVi].text : '';
  const picked = sourceEl ? selectionWithin(sourceEl) : null;
  textEl.value = base;

  const { scoreLines } = buildScore();
  const witnesses = (scoreLines[lineNum] || []).filter((w) => w.type === 'line');
  listEl.innerHTML = witnesses.length
    ? witnesses.map((w, i) => {
        const ref = `${displaySiglum(w.siglum)} ${abbreviateSurface(w.surface)} ${w.sourceLine}`;
        return `<label class="variant-witness">` +
          `<input type="checkbox" data-idx="${i}">` +
          `<span class="variant-witness-ref">${escapeHtml(ref)}</span>` +
          `<span class="variant-witness-text">${renderAtf(w.content)}</span>` +
          `</label>`;
      }).join('')
    : '<p class="field-hint">No witnesses on this line yet.</p>';

  const cleanup = () => {
    cancelBtn.removeEventListener('click', onCancel);
    form.removeEventListener('submit', onSubmit);
    dialog.removeEventListener('cancel', onCancel);
    dialog.close();
  };
  const onCancel = (e) => { if (e) e.preventDefault(); cleanup(); };
  const onSubmit = (e) => {
    e.preventDefault();
    const text = textEl.value.trim();
    if (!text) return;
    const chosen = [...listEl.querySelectorAll('input:checked')]
      .map((cb) => witnesses[Number(cb.dataset.idx)])
      .filter(Boolean);
    cleanup();
    createVariant(lineNum, text, chosen);
  };

  cancelBtn.addEventListener('click', onCancel);
  form.addEventListener('submit', onSubmit);
  dialog.addEventListener('cancel', onCancel);
  dialog.showModal();

  // Put the caret on the selected span so it is the first thing replaced.
  textEl.focus();
  const at = picked ? base.indexOf(picked) : -1;
  if (at >= 0) textEl.setSelectionRange(at, at + picked.length);
  else textEl.setSelectionRange(base.length, base.length);
}

// Move readings between variants by rewriting their § marker in the .txt —
// the manuscript file stays the single source of truth for what attests what.
// Returns the sigla actually touched.
async function assignWitnessesToVariant(witnesses, lineNum, variantIndex) {
  const letter = variantLetterOf(variantIndex);
  const byMs = new Map();
  for (const w of witnesses) {
    if (!byMs.has(w.siglum)) byMs.set(w.siglum, []);
    byMs.get(w.siglum).push(w);
  }

  const touched = [];
  for (const [msKey, group] of byMs) {
    const msEntry = Object.values(manuscripts).find((m) => m.siglum === msKey);
    if (!msEntry) continue;
    let content = msEntry.content;
    for (const w of group) {
      const res = EblAtf.setWitnessVariant(content, {
        lineNum, sourceLine: w.sourceLine, letter,
      });
      if (res.ok) content = res.content;
    }
    if (content !== msEntry.content) {
      msEntry.content = content;
      await FileSystem.writeManuscript(dirHandle, msKey, content);
      touched.push(msKey);
      if (activeManuscript === msEntry.id && aceEditor) {
        const pos = aceEditor.getCursorPosition();
        aceEditor.setValue(content, -1);
        aceEditor.moveCursorToPosition(pos);
      }
    }
  }
  return touched;
}

async function createVariant(lineNum, text, witnesses) {
  if (!Array.isArray(variantLines[lineNum])) variantLines[lineNum] = [];
  variantLines[lineNum].push({ text, parallels: [] });
  const newVi = variantLines[lineNum].length; // 0 is the main reading

  const moved = await assignWitnessesToVariant(witnesses, lineNum, newVi);
  await saveScoreDataToFile();
  renderScore();

  if (moved.length) {
    setStatus('connected', `Variant §${lineNum}${variantLetterOf(newVi)} — moved ${moved.length} witness${moved.length === 1 ? '' : 'es'} (${moved.join(', ')})`);
    setTimeout(() => setStatus('connected', 'Ready'), 4000);
  }
}

// Drop a variant and return its witnesses to the main reading.
async function dropVariant(lineNum, vi) {
  const list = variantLines[lineNum];
  if (!Array.isArray(list) || vi < 1 || vi > list.length) return;
  const reading = list[vi - 1];
  const preview = (reading && reading.text ? reading.text : '(empty)').slice(0, 60);
  if (!confirm(`Delete variant §${lineNum}${variantLetterOf(vi)}?\n\n${preview}\n\nIts witnesses go back to the main reading.`)) return;

  const { scoreLines } = buildScore();
  const attached = (scoreLines[lineNum] || [])
    .filter((w) => w.type === 'line' && (w.variant || 0) === vi);
  await assignWitnessesToVariant(attached, lineNum, 0);

  list.splice(vi - 1, 1);
  if (!list.length) delete variantLines[lineNum];
  // Letters are positional, so anything after the hole shifts down by one.
  const { scoreLines: after } = buildScore();
  for (let later = vi + 1; later <= list.length + 1; later++) {
    const stragglers = (after[lineNum] || [])
      .filter((w) => w.type === 'line' && (w.variant || 0) === later);
    await assignWitnessesToVariant(stragglers, lineNum, later - 1);
  }

  await saveScoreDataToFile();
  renderScore();
}

function writeReconExtra(el, text) {
  const slot = variantSlot(el.dataset.line, Number(el.dataset.variant || 0));
  if (el.dataset.kind === 'note') {
    if (slot) slot.note = text;
    else noteLines[el.dataset.line] = text;
    return;
  }
  const list = slot ? slot.parallels : parallelLines[el.dataset.line];
  if (Array.isArray(list)) list[Number(el.dataset.index)] = text;
}

function removeReconExtra(el) {
  const lineNum = el.dataset.line;
  const slot = variantSlot(lineNum, Number(el.dataset.variant || 0));
  if (el.dataset.kind === 'note') {
    if (slot) delete slot.note;
    else delete noteLines[lineNum];
    return;
  }
  const list = slot ? slot.parallels : parallelLines[lineNum];
  if (!Array.isArray(list)) return;
  list.splice(Number(el.dataset.index), 1);
  if (!list.length && !slot) delete parallelLines[lineNum];
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

// ===========================================
// PARALLELS
// ===========================================
// Ranks the whole Fragmentarium against this project's sources, to surface
// fragments that transmit the same composition or come from the same scribe.
//
// The corpus is eBL's sign dump, cached locally, so a sweep costs no requests
// and can be re-run freely. Scoring is in ebl-ngram.js; the sources are turned
// into sign codes by ebl-atf-signs.js.
//
// Two scores per hit, because they answer different questions:
//   text      shared composition  -> another witness
//   colophon  shared scribe/library -> a join candidate
// Merged into one number, whichever is smaller disappears.

const parallelsState = {
  corpus: null,        // [{ id, signs }] once loaded
  retrieved: null,
  results: null,
  running: false,
  message: '',
  converter: null,
  // Measured against EAE 56, using eBL's own recorded joins as the answer key.
  //
  // Weighting: rare-sequence weighting beat plain overlap at every n (summed
  // ranks of the five known pieces, 33 -> 21 at n=3), so it is the default.
  //
  // Sign run: longer runs rank the known pieces slightly better but at a steep
  // cost in reach — 26,481 fragments have a trigram in common with this
  // edition, 15,224 have a 4-run, 7,187 a 5-run. Since what is being hunted is
  // broken fragments preserving short stretches, 3 is the safe default and the
  // longer settings are there for when a list comes back too noisy.
  // 'all' pools every source into one query; a manuscript id queries with
  // that source alone. Pooling is the default because the union of the
  // witnesses is what finds *missing* ones; the single-source query is for
  // asking which fragment resembles this one tablet in particular.
  options: { n: 3, weighting: 'tfidf', minDocNgrams: 20, source: 'all' },
};

let signIndexPromise = null;

// The sign table is 800 KB and only this feature needs it, so it is fetched on
// first use rather than at page load.
function loadSignIndex() {
  if (!signIndexPromise) {
    signIndexPromise = fetch('data/sign-index.json')
      .then((res) => {
        if (!res.ok) throw new Error(`sign-index.json returned ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        signIndexPromise = null;
        throw err;
      });
  }
  return signIndexPromise;
}

// Turn one source's text into sign codes, split at its @colophon marker.
//
// The source's own text is converted rather than eBL's `signs` for that
// fragment, for three reasons: it needs no request, it covers sources eBL does
// not have (and reconstructions, which by definition it never will), and the
// colophon boundary is exact because this file is where @colophon is written.
// The cost is that conversion is ~94% line-accurate against eBL's own parser
// rather than authoritative — which trigram overlap absorbs comfortably.
function sourceToSignLines(content, converter) {
  const text = [];
  const colophon = [];
  let inColophon = false;

  for (const raw of String(content || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    if (/^@colophon/i.test(line)) { inColophon = true; continue; }
    if (/^@/.test(line)) continue;              // another surface
    if (/^(\/\/|#|\$)/.test(line)) continue;    // parallel, note, directive

    // "§12 7. text" in the score, or a plain "7. text" inside a colophon.
    const scored = line.match(/^§\d+\s+(.*)$/);
    const body = scored ? scored[1] : line;
    if (!/^\d+['’]?[a-z]?\.\s/.test(body)) continue;

    const converted = converter.convertLine(body);
    if (converted.codes.length) {
      (inColophon ? colophon : text).push(converted.codes.join(' '));
    }
  }

  return { text: text.join('\n'), colophon: colophon.join('\n') };
}

// eBL records which fragments are physically joined, and a hit that is already
// a known join of one of this project's sources means something quite specific:
// not a new witness, but a piece of a tablet the edition already uses whose
// text it does not yet carry. Worth labelling rather than hiding — K.20497 is
// joined to K.5283 and still has 23 lines of its own.
//
// Only the project's own sources are looked up, so this is one request each,
// cached with their ATF. Failure is not fatal: without the map the results are
// simply unlabelled.
async function loadJoinMap(sources, say) {
  const joinedTo = {};
  let checked = 0;

  // A source's own museum number, not its filename. Files are often named for
  // the whole join — "K.14874 (+) BM.41031 (+) BM.41691" — and using that as a
  // label produced rows reading "joins K.14874, K.14874 (+) BM.41031 (+) …".
  const label = (siglum) => EblFetch.primaryOf(siglum);

  function record(partner, siglum) {
    if (!partner) return;
    const owner = label(siglum);
    if (partner === owner) return;
    const list = (joinedTo[partner] = joinedTo[partner] || []);
    if (list.indexOf(owner) === -1) list.push(owner);
  }

  // A source pulled from eBL carries "// joins:" in its own file, so most
  // projects need no requests at all here.
  const needFetch = [];
  for (const source of sources) {
    const stored = EblFetch.readStoredJoins(source.content);
    if (stored) {
      for (const partner of stored) record(partner, source.siglum);
      // A file named for the whole join names its own partners too.
      for (const partner of EblClient.extractMuseumNumber(source.siglum).joins) {
        record(partner, source.siglum);
      }
      checked++;
    } else {
      needFetch.push(source);
    }
  }
  if (checked) say(`Read known joins from ${checked} source file(s)…`);

  // A fragment record carries its ATF and annotations, so each one takes a
  // second or two. Run in a small pool: sequentially this was two minutes for
  // 26 sources, which is most of a first sweep. Six at a time is brisk without
  // making eBL carry a burst.
  const CONCURRENCY = 6;
  const queue = [...needFetch];

  async function worker() {
    for (;;) {
      const source = queue.shift();
      if (!source) return;
      try {
        const fragment = await EblCorpus.getAtf(label(source.siglum));
        for (const group of fragment.joins || []) {
          for (const piece of group) {
            record(formatMuseumNumber(piece.museumNumber), source.siglum);
          }
        }
      } catch (err) {
        // Not in eBL, or offline. That source contributes no joins.
      }
      say(`Checking known joins — ${++checked}/${sources.length}…`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, needFetch.length) }, worker));
  return joinedTo;
}

function formatMuseumNumber(museumNumber) {
  if (!museumNumber) return '';
  const { prefix = '', number = '', suffix = '' } = museumNumber;
  if (!prefix && !number) return '';
  return suffix ? `${prefix}.${number}.${suffix}` : `${prefix}.${number}`;
}

async function ensureParallelsCorpus(onProgress) {
  if (parallelsState.corpus) return parallelsState.corpus;
  const loaded = await EblCorpus.load({ onProgress });
  parallelsState.corpus = loaded.entries;
  parallelsState.retrieved = loaded.retrieved;
  return loaded.entries;
}

async function runParallelSweep() {
  if (parallelsState.running) return;
  if (!window.EblCorpus || !window.EblNgram || !window.EblAtfSigns) {
    parallelsState.message = 'The parallel-search modules are not loaded.';
    renderParallels();
    return;
  }

  parallelsState.running = true;
  parallelsState.results = null;
  const say = (text) => { parallelsState.message = text; renderParallels(); };

  try {
    say('Loading the sign table…');
    if (!parallelsState.converter) {
      parallelsState.converter = EblAtfSigns.create(await loadSignIndex());
    }

    say('Loading the corpus…');
    const entries = await ensureParallelsCorpus((p) => {
      if (p.phase === 'downloading') {
        say(`Downloading the corpus from eBL — ${(p.bytes / 1e6).toFixed(1)} MB so far…`);
      } else if (p.phase === 'parsing') {
        say('Reading the corpus…');
      } else if (p.phase === 'storing') {
        say('Caching the corpus for next time…');
      }
    });

    say('Converting this project’s sources…');
    const textLines = [];
    const colophonLines = [];
    const exclude = new Set();
    let withColophon = 0;

    // Which sources form the query. Every project source stays in `exclude`
    // either way — a single-source search finding a sibling that is already
    // in the project would report the known, not the new.
    // A source deleted since the option was set falls back to the pool
    // rather than querying with nothing.
    const chosen = manuscripts[parallelsState.options.source]
      ? parallelsState.options.source : 'all';
    const queried = [];

    for (const [id, ms] of Object.entries(manuscripts)) {
      // A source is excluded from its own results under the museum number it
      // is filed as; the siglum is that number in this app's convention.
      exclude.add(ms.siglum);
      if (chosen !== 'all' && id !== chosen) continue;
      const split = sourceToSignLines(ms.content, parallelsState.converter);
      if (split.text) { textLines.push(split.text); queried.push(ms.siglum); }
      if (split.colophon) { colophonLines.push(split.colophon); withColophon++; }
    }

    if (!textLines.length) {
      parallelsState.message = chosen === 'all'
        ? 'No sources with score assignments to search with yet.'
        : 'That source has no score-assigned lines to search with.';
      return;
    }

    const joinedTo = await loadJoinMap(Object.values(manuscripts), say);

    say(`Ranking ${entries.length.toLocaleString()} fragments…`);
    // Yield once so the message paints before the sweep blocks the thread.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const { n, weighting, minDocNgrams } = parallelsState.options;
    const nValues = [n];
    const profiles = { text: EblNgram.buildProfile(textLines, { nValues }) };
    if (colophonLines.length) {
      profiles.colophon = EblNgram.buildProfile(colophonLines, { nValues });
    }

    const started = Date.now();
    // Deep enough that each channel has its own candidates to draw on; the
    // panel ranks the two separately rather than showing this order.
    const outcome = EblNgram.rank(profiles, entries, {
      exclude, limit: 400, minDocNgrams, weighting,
    });

    // A fragment eBL already records as joined to one of these sources is not a
    // find — it is bookkeeping — so it is kept out of the ranking. Which ones
    // were removed is still reported: their own transliteration may be missing
    // from the edition even though the join is known.
    const excludedJoins = outcome.results.filter((r) => joinedTo[r.id]).map((r) => r.id);
    outcome.results = outcome.results.filter((r) => !joinedTo[r.id]);

    parallelsState.results = {
      ...outcome,
      joinedTo,
      excludedJoins,
      elapsed: Date.now() - started,
      scanned: entries.length,
      sources: textLines.length,
      queried,
      withColophon,
    };
    parallelsState.message = '';
  } catch (err) {
    console.error('Parallel sweep failed:', err);
    parallelsState.message = `Could not run the search: ${err.message}`;
  } finally {
    parallelsState.running = false;
    renderParallels();
  }
}

async function refreshParallelsCorpus() {
  if (parallelsState.running) return;
  parallelsState.running = true;
  parallelsState.message = 'Re-downloading the corpus from eBL…';
  renderParallels();
  try {
    const loaded = await EblCorpus.refresh({
      onProgress: (p) => {
        if (p.phase !== 'downloading') return;
        parallelsState.message = `Re-downloading — ${(p.bytes / 1e6).toFixed(1)} MB so far…`;
        renderParallels();
      },
    });
    parallelsState.corpus = loaded.entries;
    parallelsState.retrieved = loaded.retrieved;
    parallelsState.results = null;
    parallelsState.message = `Corpus refreshed — ${loaded.count.toLocaleString()} fragments.`;
  } catch (err) {
    parallelsState.message = `Refresh failed: ${err.message}`;
  } finally {
    parallelsState.running = false;
    renderParallels();
  }
}

// Pull a candidate in as a source, reusing the same path as "+ Add > from eBL".
async function addParallelAsSource(museum) {
  const id = 'ms-' + museum.toLowerCase();
  if (manuscripts[id]) { alert(`"${museum}" is already in this project.`); return; }

  setStatus('syncing', 'Fetching from eBL…');
  let res;
  try {
    res = await EblFetch.fetchFragment(museum);
  } catch (err) {
    setStatus('error', 'eBL fetch failed');
    alert(err.message);
    return;
  }

  manuscripts[id] = { siglum: museum, content: res.content };
  addManuscriptToList(id, museum);
  try {
    await FileSystem.writeManuscript(dirHandle, museum, res.content);
    await updateManuscriptIndex();
  } catch (err) {
    console.error('Failed to save fetched manuscript:', err);
  }
  loadManuscript(id);
  markUnsaved();
  setStatus('connected', 'Added ' + res.primary);
  await askSourceMeta(museum, { ...res.fields, genres: res.genres });
  renderParallels();
}

// One ranked table for one channel. `channel` decides both the order and which
// score the "shared" count refers to, so a row means the same thing throughout.
// Candidates someone has already been through, keyed by museum number.
// Read from the project folder every time the tab is drawn, so a colleague's
// marks show up without a reload — the lists run to hundreds of fragments and
// nobody can hold in their head which ones they have already dismissed.
let parallelChecks = {};

async function loadParallelChecks() {
  if (!dirHandle) { parallelChecks = {}; return; }
  try {
    parallelChecks = (await FileSystem.readParallelChecks(dirHandle)) || {};
  } catch (err) {
    console.error('Could not read parallels-checked.json:', err);
    parallelChecks = {};
  }
}

function checkedLabel(check) {
  if (!check) return '';
  return `checked by ${check.by || 'someone'}, ${formatRetrieved(check.at)}`;
}

// The name is what a colleague sees, so ask for it once rather than record
// the generated "User-a1b2" against their work.
function checkerName() {
  if (!/^User-/.test(currentUser.name)) return currentUser.name;
  const given = prompt('Your name, so colleagues can see who checked this:', '');
  if (given && given.trim()) {
    currentUser.name = given.trim();
    localStorage.setItem('user_name', currentUser.name);
  }
  return currentUser.name;
}

async function toggleParallelCheck(museum, on) {
  if (!museum) return;
  if (on) parallelChecks[museum] = { by: checkerName(), at: new Date().toISOString() };
  else delete parallelChecks[museum];

  // A fragment can be listed in both tables; they have to agree, and the
  // row is updated in place so the page does not jump back to the top.
  const label = checkedLabel(parallelChecks[museum]);
  document.querySelectorAll(`#parallels tr[data-museum="${CSS.escape(museum)}"]`).forEach((tr) => {
    tr.classList.toggle('is-checked', on);
    const box = tr.querySelector('.parallels-check-box');
    if (box) {
      box.checked = on;
      box.title = on ? label : 'Mark as checked';
    }
    const by = tr.querySelector('.parallels-checked-by');
    if (by) by.textContent = label;
  });
  updateParallelsProgress();

  try {
    await FileSystem.writeParallelChecks(dirHandle, parallelChecks);
    setStatus('connected', on ? `Marked ${museum} as checked` : `Unmarked ${museum}`);
  } catch (err) {
    console.error('Failed to save parallels-checked.json:', err);
    setStatus('error', 'Could not save the check');
  }
}

function updateParallelsProgress() {
  document.querySelectorAll('#parallels .parallels-section').forEach((section) => {
    const rows = section.querySelectorAll('tbody tr');
    const counter = section.querySelector('.parallels-progress');
    if (!counter || !rows.length) return;
    const done = [...rows].filter((tr) => tr.classList.contains('is-checked')).length;
    counter.textContent = `${done} of ${rows.length} checked`;
  });
}

function renderParallelsTable(rows, channel, title, blurb, limit = 20) {
  const ranked = rows
    .filter((r) => r.scores[channel] && r.scores[channel].shared > 0)
    .sort((a, b) => b.scores[channel].overlap - a.scores[channel].overlap ||
                    b.scores[channel].shared - a.scores[channel].shared)
    .slice(0, limit);

  if (!ranked.length) return '';

  const done = ranked.filter((r) => parallelChecks[r.id]).length;
  let html = `<div class="parallels-section"><h3 class="parallels-section-title">${escapeHtml(title)}` +
             `<span class="parallels-progress">${done} of ${ranked.length} checked</span></h3>`;
  html += `<p class="parallels-section-blurb">${escapeHtml(blurb)}</p>`;
  html += '<table class="parallels-table"><thead><tr>';
  html += '<th class="parallels-check" title="Someone has been through this one">&#10003;</th>';
  html += '<th>#</th><th>Fragment</th>';
  html += '<th title="Shared composition — another witness">Text</th>';
  html += '<th title="Shared scribe or library — a join candidate">Colophon</th>';
  html += '<th title="Shared trigrams on this channel">Shared</th><th></th>';
  html += '</tr></thead><tbody>';

  ranked.forEach((row, i) => {
    const text = row.scores.text;
    const colophon = row.scores.colophon;
    const inProject = !!manuscripts['ms-' + row.id.toLowerCase()];
    const check = parallelChecks[row.id];
    html += `<tr data-museum="${escapeHtml(row.id)}"${check ? ' class="is-checked"' : ''}>`;
    html += `<td class="parallels-check"><input type="checkbox" class="parallels-check-box" ` +
            `data-museum="${escapeHtml(row.id)}"${check ? ' checked' : ''} ` +
            `title="${check ? escapeHtml(checkedLabel(check)) : 'Mark as checked'}"></td>`;
    html += `<td class="parallels-rank">${i + 1}</td>`;
    html += `<td><a href="https://www.ebl.lmu.de/fragmentarium/${encodeURIComponent(row.id)}" ` +
            `target="_blank" rel="noopener noreferrer">${escapeHtml(row.id)}</a>`;
    html += '</td>';
    html += `<td class="parallels-score${channel === 'text' ? ' parallels-score-lead' : ''}">` +
            `${text ? text.overlap.toFixed(3) : '—'}</td>`;
    html += `<td class="parallels-score${channel === 'colophon' ? ' parallels-score-lead' : ''}">` +
            `${colophon ? colophon.overlap.toFixed(3) : '—'}</td>`;
    html += `<td class="parallels-shared">${row.scores[channel].shared}</td>`;
    html += '<td>' +
      `<span class="parallels-checked-by">${escapeHtml(checkedLabel(check))}</span>` +
      (inProject
        ? '<span class="parallels-have">in project</span>'
        : `<button class="parallels-add" data-museum="${escapeHtml(row.id)}">Add as source</button>`) +
      '</td>';
    html += '</tr>';
  });

  return html + '</tbody></table></div>';
}

function formatRetrieved(iso) {
  if (!iso) return 'unknown date';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'unknown date' : date.toLocaleDateString();
}

async function renderParallels() {
  const panel = document.getElementById('parallels');
  if (!panel) return;

  await loadParallelChecks();
  const status = window.EblCorpus ? await EblCorpus.status() : { cached: false };
  const { results, running, message } = parallelsState;

  let html = '<div class="parallels-bar">';
  html += '<div class="parallels-corpus">';
  if (status.cached) {
    html += `<span class="parallels-corpus-state">Corpus: ${Number(status.count).toLocaleString()} ` +
            `fragments, downloaded ${escapeHtml(formatRetrieved(status.retrieved))}</span>`;
    html += '<button id="parallels-refresh" class="parallels-link">Refresh</button>';
  } else {
    html += '<span class="parallels-corpus-state">Corpus not downloaded yet — about 6 MB, once.</span>';
  }
  html += '</div>';
  html += `<button id="parallels-run" class="parallels-run"${running ? ' disabled' : ''}>` +
          `${running ? 'Working…' : 'Find parallels'}</button>`;
  html += '</div>';

  // The knobs eBL's own matcher exposes, with the defaults that were measured
  // rather than assumed. Changing one invalidates the results on screen, so the
  // table is cleared until the sweep is run again.
  const opts = parallelsState.options;
  const disabled = running ? ' disabled' : '';
  html += '<div class="parallels-options">';
  {
    const sorted = Object.entries(manuscripts)
      .map(([id, ms]) => ({ id, siglum: ms.siglum }))
      .sort((a, b) => a.siglum.localeCompare(b.siglum));
    html += `<label title="Pool every source into one query, or ask with a single tablet.">` +
            `Search with <select id="parallels-source"${disabled}>` +
            `<option value="all"${opts.source === 'all' ? ' selected' : ''}>All sources</option>` +
            sorted.map((m) =>
              `<option value="${escapeHtml(m.id)}"${opts.source === m.id ? ' selected' : ''}>` +
              `${escapeHtml(m.siglum)}</option>`).join('') +
            '</select></label>';
  }
  html += `<label title="How many consecutive signs must agree. Longer is stricter: ` +
          `at 3 some 26,000 fragments share something with this edition, at 5 only 7,000.">` +
          `Sign run <select id="parallels-n"${disabled}>` +
          [2, 3, 4, 5].map((n) => `<option value="${n}"${opts.n === n ? ' selected' : ''}>${n}</option>`).join('') +
          '</select></label>';
  html += `<label>Weighting <select id="parallels-weighting"${disabled}>` +
          `<option value="plain"${opts.weighting === 'plain' ? ' selected' : ''}>Plain overlap</option>` +
          `<option value="tfidf"${opts.weighting === 'tfidf' ? ' selected' : ''}>Rare sequences (TF-IDF)</option>` +
          '</select></label>';
  html += `<label>Ignore fragments under <select id="parallels-floor"${disabled}>` +
          [0, 5, 10, 20, 40].map((v) => `<option value="${v}"${opts.minDocNgrams === v ? ' selected' : ''}>` +
            `${v === 0 ? 'no limit' : v}</option>`).join('') +
          '</select> sequences</label>';
  html += '</div>';

  if (message) html += `<div class="parallels-message">${escapeHtml(message)}</div>`;

  if (results) {
    const { dropped, settings, total } = results;
    html += '<div class="parallels-summary">';
    html += `Ranked ${results.scanned.toLocaleString()} fragments against ` +
            (results.queried && results.queried.length === 1
              ? `${escapeHtml(results.queried[0])} alone`
              : `${results.sources} source${results.sources === 1 ? '' : 's'}`);
    html += results.withColophon
      ? ` (${results.withColophon} with a colophon, scored separately)`
      : ' (no colophons found, so only the text channel was scored)';
    html += ` in ${(results.elapsed / 1000).toFixed(1)}s. `;
    // Whatever the ranking did not consider is stated, not left implied.
    html += `${total.toLocaleString()} scored; ${dropped.tooSmall.toLocaleString()} skipped for ` +
            `having fewer than ${settings.minDocNgrams} trigrams, ` +
            `${dropped.noOverlap.toLocaleString()} shared nothing.`;
    html += '</div>';

    if (results.excludedJoins && results.excludedJoins.length) {
      const named = results.excludedJoins
        .map((id) => `${escapeHtml(id)} <span class="parallels-join-owner">(${escapeHtml(
          (results.joinedTo[id] || []).join(', '))})</span>`)
        .join(', ');
      html += `<div class="parallels-note">Left out of the ranking: ${named} — eBL already ` +
              `records ${results.excludedJoins.length === 1 ? 'it' : 'these'} as joined to a ` +
              `source here. Worth checking anyway, since a known join can still have ` +
              `transliterated lines this edition does not carry.</div>`;
    }

    if (!results.results.length) {
      html += '<div class="colophons-empty">Nothing in the corpus shares material with these sources.</div>';
    } else {
      // Ranked once per channel, never merged. A single order sorted on the
      // better of the two scores puts every colophon match above every witness
      // — on EAE 56 that buried BM.41031, the strongest textual hit in the
      // corpus, under ten fragments that share only the scribe.
      html += renderParallelsTable(
        results.results, 'text',
        'Same composition',
        'Another witness to this text. Ranked by shared trigrams of transliteration.'
      );
      if (results.withColophon) {
        html += renderParallelsTable(
          results.results, 'colophon',
          'Same scribe or library',
          'Shares this project’s colophons rather than its text — where a join is likely to hide.'
        );
      }
    }
  } else if (!running && !message) {
    html += '<div class="colophons-empty">Ranks every fragment in eBL against this project’s ' +
            'sources. The corpus downloads once, then searches run offline.</div>';
  }

  panel.innerHTML = html;

  const runBtn = document.getElementById('parallels-run');
  if (runBtn) runBtn.addEventListener('click', runParallelSweep);
  const refreshBtn = document.getElementById('parallels-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshParallelsCorpus);

  // A result table belongs to the settings that produced it, so changing one
  // clears it rather than leaving figures on screen that no longer describe
  // what the controls say.
  const onOption = (id, apply) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      apply(el.value);
      parallelsState.results = null;
      parallelsState.message = 'Settings changed — run the search again.';
      renderParallels();
    });
  };
  onOption('parallels-source', (v) => { parallelsState.options.source = v; });
  onOption('parallels-n', (v) => { parallelsState.options.n = Number(v); });
  onOption('parallels-weighting', (v) => { parallelsState.options.weighting = v; });
  onOption('parallels-floor', (v) => { parallelsState.options.minDocNgrams = Number(v); });
  panel.querySelectorAll('.parallels-add').forEach((btn) => {
    btn.addEventListener('click', () => addParallelAsSource(btn.dataset.museum));
  });
  panel.querySelectorAll('.parallels-check-box').forEach((box) => {
    box.addEventListener('change', () => toggleParallelCheck(box.dataset.museum, box.checked));
  });
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
      if (targetTab === 'parallels') {
        renderParallels();
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

// Project settings open in their own window, so the score stays put. The id
// travels in the URL: session storage is per-tab and a new window does not
// reliably inherit it.
//
// Both pages write the same files, so pending edits are flushed first —
// otherwise Settings could load a stale manuscripts.json and write it back
// over them.
async function openProjectSettings() {
  const btn = document.getElementById('settings-btn');
  if (hasUnsavedChanges) {
    // the label is a gear glyph, so keep it and just show the wait state
    if (btn) { btn.disabled = true; btn.title = 'Saving…'; }
    await saveAll();
    if (btn) {
      btn.disabled = false;
      btn.title = 'Project settings, eBL metadata and export';
    }
    if (hasUnsavedChanges) {
      alert('Could not save the pending changes, so Settings was not opened.\n' +
            'Settings writes the same files and would overwrite them.');
      return;
    }
  }
  const url = projectId
    ? `manage.html?project=${encodeURIComponent(projectId)}`
    : 'manage.html';
  const win = window.open(url, 'scorer-settings');
  if (win) win.focus();
  else window.location.href = url;   // pop-up blocked: fall back to this tab
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
  const hasNotes = Object.keys(noteLines).length > 0;
  const hasParallels = Object.keys(parallelLines).length > 0;
  const hasVariants = Object.keys(variantLines).length > 0;
  if (!hasReconstructed && !hasTranslations && !hasNotes && !hasParallels && !hasVariants) return;

  try {
    const data = {
      reconstructed: reconstructedLines,
      translations: translationLines,
      notes: noteLines,
      parallels: parallelLines,
      variants: variantLines,
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
      // Absent in files written before notes/parallels existed.
      if (data.notes) Object.assign(noteLines, data.notes);
      if (data.parallels) Object.assign(parallelLines, data.parallels);
      if (data.variants) Object.assign(variantLines, data.variants);
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
    // the key drops the prime so it can match ours, but the reference itself
    // must be preserved: 22' and 22 are not the same line number
    if (p) out.set(refKey(surface, p.num), { num: p.num, text: p.text });
  }
  return out;
}

// Order two line references within a surface: 8a' before 8b' before 9'.
function lineSortKey(num) {
  const m = String(num).match(/^(\d+)\s*([ab]?)/);
  return [m ? parseInt(m[1], 10) : 0, m ? m[2] : ''];
}

function lineOrderCmp(a, b) {
  const ka = lineSortKey(a), kb = lineSortKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  return ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
}

// Insert a line eBL has and this file does not, in its proper place: within its
// own surface, before the first line numbered higher. If it is higher than
// everything in that surface it goes at the end of the surface block, after any
// closing ruling — which is where eBL keeps such lines too. A surface this file
// has never seen is created at the end.
function insertEblOnlyLine(lines, add) {
  const bounds = [];            // [surface, firstIdx, endIdx)
  let cur = 'obverse', start = 0;
  for (let i = 0; i <= lines.length; i++) {
    const sm = i < lines.length ? lines[i].trim().match(SURFACE_RE) : null;
    if (sm || i === lines.length) {
      bounds.push([cur, start, i]);
      if (sm) { cur = sm[1].toLowerCase(); start = i + 1; }
    }
  }
  const block = bounds.find(b => b[0] === add.surface);
  const text = `${add.num}. ${add.text}`;

  if (!block) {
    if (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(`@${add.surface}`, text);
    return;
  }

  for (let i = block[1]; i < block[2]; i++) {
    const p = splitScoreLine(lines[i]);
    if (p && lineOrderCmp(p.num, add.num) > 0) {
      lines.splice(i, 0, text);
      return;
    }
  }
  // past the last numbered line of the surface: keep any trailing ruling and
  // blank lines below the new line where they belong
  let end = block[2];
  while (end > block[1] && lines[end - 1].trim() === '') end--;
  lines.splice(end, 0, text);
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
    const hit = theirs.get(refKey(surface, p.num));
    if (hit === undefined || hit.text === p.text) continue;
    const t = hit.text;
    rows.push({
      row: i, parts: p, mine: p.text, theirs: t,
      // a line whose brackets don't balance here but do at eBL is a
      // transcription slip, so those are pre-selected; everything else is
      // left for the editor to judge.
      fixesBrackets: unmatchedBrackets(p.text).size > 0 &&
                     unmatchedBrackets(t).size === 0,
    });
  }

  // Lines that exist on only one side. eBL is the source of truth, but a line
  // it does not have cannot simply be deleted (it may be a join fragment or a
  // colophon eBL files elsewhere), and a line only eBL has cannot be inserted
  // without knowing which § it belongs to. Both are reported, neither is applied.
  const seen = new Set();
  let surf2 = 'obverse';
  for (const line of lines) {
    const sm = line.trim().match(SURFACE_RE);
    if (sm) { surf2 = sm[1].toLowerCase(); continue; }
    const p = splitScoreLine(line);
    if (p) seen.add(refKey(surf2, p.num));
  }
  const onlyHere = [];
  surf2 = 'obverse';
  for (const line of lines) {
    const sm = line.trim().match(SURFACE_RE);
    if (sm) { surf2 = sm[1].toLowerCase(); continue; }
    const p = splitScoreLine(line);
    if (p && !theirs.has(refKey(surf2, p.num))) onlyHere.push(p);
  }
  const additions = [...theirs.keys()]
    .filter(k => !seen.has(k))
    .map(k => {
      const bar = k.indexOf('|');
      const hit = theirs.get(k);
      return { surface: k.slice(0, bar), num: hit.num, text: hit.text };
    })
    .sort((a, b) => a.surface.localeCompare(b.surface) || lineOrderCmp(a.num, b.num));

  pullState = { id: activeManuscript, primary, rows, lines, onlyHere, additions,
                atf: frag.atf };
  renderPullDialog();
}

function renderPullDialog() {
  const { primary, rows, onlyHere, additions } = pullState;
  document.getElementById('pull-source-name').textContent = '· ' + primary;
  const box = document.getElementById('pull-diff');
  const summary = document.getElementById('pull-summary');
  const warn = document.getElementById('pull-warning');
  const applyBtn = document.getElementById('pull-apply-btn');

  const nothingToDo = rows.length === 0 && additions.length === 0;
  const notes = [];
  if (onlyHere.length) {
    notes.push(onlyHere.length + ' line' + (onlyHere.length === 1 ? '' : 's') +
      ' here ' + (onlyHere.length === 1 ? 'has' : 'have') + ' no eBL counterpart (' +
      onlyHere.slice(0, 8).map(p => p.num).join(', ') +
      (onlyHere.length > 8 ? ', …' : '') + ') — these will be removed');
  }

  if (nothingToDo && onlyHere.length === 0) {
    warn.hidden = true;
    summary.innerHTML = 'This source already matches its eBL transliteration line for line.' +
      (notes.length ? '<br><span class="pull-note">' + escapeHtml(notes[0]) + '</span>' : '');
    box.innerHTML = '';
    applyBtn.disabled = true;
    applyBtn.textContent = 'Nothing to pull';
    document.getElementById('ebl-pull-dialog').showModal();
    return;
  }

  const parts = [];
  if (rows.length) {
    parts.push('<strong>' + rows.length + ' line' + (rows.length === 1 ? '' : 's') +
      ' differ' + (rows.length === 1 ? 's' : '') + '.</strong> eBL is the source of truth, ' +
      'so pulling replaces ' + (rows.length === 1 ? 'it' : 'them') +
      ' — any edit made here and not at eBL is lost.');
  }
  if (additions.length) {
    parts.push('<strong>' + additions.length + ' line' + (additions.length === 1 ? '' : 's') +
      ' will be added</strong> from eBL, in place. They arrive without a § ' +
      'assignment, so they join the source but not the score until you map them.');
  }
  if (onlyHere.length) {
    parts.push('<strong>' + onlyHere.length + ' line' +
      (onlyHere.length === 1 ? '' : 's') + ' here ' +
      (onlyHere.length === 1 ? 'has' : 'have') + ' no eBL counterpart and will ' +
      'be removed</strong> — the whole source is replaced by eBL’s version.');
  }
  parts.push('Score assignments are re-attached by line reference wherever the ' +
    'line still exists at eBL.');
  warn.hidden = false;
  warn.innerHTML = parts.join(' ');
  summary.innerHTML = notes.length
    ? '<span class="pull-note">' + escapeHtml(notes.join(' ')) + '</span>' : '';
  applyBtn.disabled = false;

  const changed = rows.map((r) => '' +
    '<div class="pull-row' + (r.fixesBrackets ? ' pull-row-fix' : '') + '">' +
      '<div class="pull-body">' +
        '<div class="pull-ref">' + (r.parts.sec ? '§' + escapeHtml(r.parts.sec) + ' ' : '') +
          escapeHtml(r.parts.num) + '.' +
          (r.fixesBrackets ? ' <span class="pull-badge">fixes bracket</span>' : '') + '</div>' +
        '<div class="pull-line pull-mine"><span class="pull-tag">here</span>' + renderAtf(r.mine) + '</div>' +
        '<div class="pull-line pull-theirs"><span class="pull-tag">eBL</span>' + renderAtf(r.theirs) + '</div>' +
      '</div></div>').join('');

  const added = additions.map((a) => '' +
    '<div class="pull-row pull-row-add">' +
      '<div class="pull-body">' +
        '<div class="pull-ref">' + escapeHtml(a.num) + '. ' +
          '<span class="pull-badge pull-badge-add">new · ' + escapeHtml(a.surface) + '</span></div>' +
        '<div class="pull-line pull-theirs"><span class="pull-tag">eBL</span>' + renderAtf(a.text) + '</div>' +
      '</div></div>').join('');

  box.innerHTML = changed + added;
  applyBtn.textContent = 'Overwrite';
  document.getElementById('ebl-pull-dialog').showModal();
}

function applyPull() {
  if (!pullState) return;
  const { rows, additions, onlyHere, lines: base, atf, primary } = pullState;
  if (rows.length === 0 && additions.length === 0 && onlyHere.length === 0) {
    closePullDialog();
    return;
  }

  // The file is rebuilt from eBL’s ATF rather than patched line by line: eBL
  // is the source of truth, so its version wins whole — text, rulings,
  // surfaces and all. The one thing it cannot supply is the § assignments,
  // so those are carried across by line reference.
  const secByKey = new Map();
  let surface = 'obverse';
  for (const line of base) {
    const sm = line.trim().match(SURFACE_RE);
    if (sm) { surface = sm[1].toLowerCase(); continue; }
    const p = splitScoreLine(line);
    if (p && p.sec) secByKey.set(refKey(surface, p.num), p.sec);
  }

  // Anything above the first surface marker or numbered line is ours — the
  // siglum and the eBL-siglum comment — and is kept.
  const preamble = [];
  for (const line of base) {
    const t = line.trim();
    if (t && (SURFACE_RE.test(t) || /^\$/.test(t) || splitScoreLine(line))) break;
    preamble.push(line);
  }

  const body = [];
  const carried = new Set();
  surface = 'obverse';
  for (const raw of atf.split('\n')) {
    const t = raw.trim();
    const sm = t.match(SURFACE_RE);
    if (sm) { surface = sm[1].toLowerCase(); body.push(t); continue; }
    const p = t ? splitScoreLine(t) : null;
    if (!p) { body.push(t); continue; }
    const key = refKey(surface, p.num);
    const sec = secByKey.get(key);
    if (sec) carried.add(key);
    body.push(sec ? '§' + sec + ' ' + p.num + '. ' + p.text
                  : p.num + '. ' + p.text);
  }
  while (body.length && body[body.length - 1] === '') body.pop();

  const content = preamble.concat(body).join('\n') + '\n';

  manuscripts[pullState.id].content = content;
  if (pullState.id === activeManuscript) setEditorContent(content);
  saveCurrentManuscript();
  syncManuscriptToYjs(pullState.id);
  renderScore();
  updateSourceHeader(pullState.id);
  markUnsaved();

  const lost = [...secByKey.keys()].filter(k => !carried.has(k));
  closePullDialog();
  const differed = rows.length + additions.length + onlyHere.length;
  showPullResult({
    title: 'Pulled from eBL',
    summaryHtml: '<strong>' + escapeHtml(primary) + '</strong> replaced with the ' +
      'eBL version. ' + carried.size + ' of ' + secByKey.size +
      ' score assignment' + (secByKey.size === 1 ? '' : 's') + ' carried over.',
    lost: lost,
    warnHtml: differed
      ? '<strong>The two versions differed.</strong> Check the line assignments: ' +
        'if eBL renumbered a line, its § still matches the old reference and ' +
        'can now sit on the wrong text.'
      : '',
  });
}

// The outcome of a pull, in the app’s own overlay rather than a browser
// alert: it has to carry a warning and possibly a list of line references,
// which a native dialog renders as unformatted text.
// A result overlay shared by the pull and the eBL fetch: a title, a summary,
// an optional list of line references, and an optional warning.
function showPullResult(r) {
  const dialog = document.getElementById('pull-result-dialog');
  if (!dialog) return;
  const titleEl = document.getElementById('pull-result-title');
  const summary = document.getElementById('pull-result-summary');
  const lostEl = document.getElementById('pull-result-lost');
  const warnEl = document.getElementById('pull-result-warning');
  const okBtn = document.getElementById('pull-result-ok');

  titleEl.textContent = r.title || 'Pulled from eBL';
  summary.innerHTML = r.summaryHtml || '';

  const lost = r.lost || [];
  lostEl.hidden = lost.length === 0;
  lostEl.innerHTML = lost.length
    ? '<div class="pull-lost-head">' + lost.length + ' assignment' +
        (lost.length === 1 ? '' : 's') +
        ' could not be carried — ' +
        (lost.length === 1 ? 'that line is' : 'those lines are') +
        ' no longer at eBL under the same number:</div>' +
        '<div class="pull-lost-list">' +
        lost.map(function (k) {
          return '<code>' + escapeHtml(k.replace('|', ' ')) + '</code>';
        }).join(' ') + '</div>'
    : '';

  warnEl.hidden = !r.warnHtml;
  warnEl.innerHTML = r.warnHtml || '';

  const close = function () {
    okBtn.removeEventListener('click', close);
    dialog.removeEventListener('cancel', close);
    dialog.close();
  };
  okBtn.addEventListener('click', close);
  dialog.addEventListener('cancel', close);
  dialog.showModal();
  okBtn.focus();
}

function closePullDialog() {
  document.getElementById('ebl-pull-dialog').close();
  pullState = null;
}

function setupEblPull() {
  const btn = document.getElementById('ebl-pull-btn');
  if (btn) btn.addEventListener('click', pullFromEbl);
  const cancel = document.getElementById('pull-cancel-btn');
  if (cancel) cancel.addEventListener('click', closePullDialog);
  const apply = document.getElementById('pull-apply-btn');
  if (apply) apply.addEventListener('click', applyPull);
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
  } else if (choice === 'ebl') {
    await fetchManuscriptFromEbl();
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
    const eblBtn = document.getElementById('fetch-ebl-manuscript-btn');
    const cancelBtn = document.getElementById('cancel-add-manuscript-btn');

    const cleanup = () => {
      dialog.close();
      newBtn.removeEventListener('click', onNew);
      importBtn.removeEventListener('click', onImport);
      if (eblBtn) eblBtn.removeEventListener('click', onEbl);
      cancelBtn.removeEventListener('click', onCancel);
    };

    const onNew = () => { cleanup(); resolve('new'); };
    const onImport = () => { cleanup(); resolve('import'); };
    const onEbl = () => { cleanup(); resolve('ebl'); };
    const onCancel = () => { cleanup(); resolve(null); };

    newBtn.addEventListener('click', onNew);
    importBtn.addEventListener('click', onImport);
    if (eblBtn) eblBtn.addEventListener('click', onEbl);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// Add a source by downloading its transliteration from eBL. The ATF that comes
// back is already in this app's format (@obverse, "1. DIŠ …"), so it is stored
// as-is; what it cannot carry is the § score assignments, which are this
// project's own and have to be added by hand afterwards.
// Add a source by downloading its transliteration from eBL. The ATF is
// already in this app’s format, so it is stored as-is; what it cannot carry
// is the § score assignments, which are this project’s own.
// Ask what this one source is — type above all, provenance and period with
// it — right when it enters the project, instead of leaving a blank row to
// be filled in Settings later. Prefilled from the eBL record where the
// record knows (period, provenance); the type is always the user's call.
// Writes the same manuscripts.json the Settings page edits.
async function askSourceMeta(siglum, prefill = {}) {
  const dialog = document.getElementById('source-meta-dialog');
  if (!dialog || !window.EblClient) return;

  const fill = (el, names, current) => {
    el.innerHTML = '<option value=""></option>' + names.map((name) =>
      `<option value="${escapeHtml(name)}"${name === current ? ' selected' : ''}>` +
      `${escapeHtml(name)}</option>`).join('');
  };

  let provenances = [];
  try { provenances = await EblClient.getProvenances(); } catch (_) { /* fallback list */ }

  const typeEl = document.getElementById('source-meta-type');
  const provEl = document.getElementById('source-meta-provenance');
  const periodEl = document.getElementById('source-meta-period');
  const modEl = document.getElementById('source-meta-modifier');
  const prefillEl = document.getElementById('source-meta-prefill');

  document.getElementById('source-meta-title').textContent = `Describe ${siglum}`;

  const typeNames = [...new Set(EblClient.MANUSCRIPT_TYPES.map(([name]) => name))];
  const provNames = provenances.map(([name]) => name);
  const periodNames = EblClient.PERIODS.map(([name]) => name).filter((n) => n !== 'None');

  // Provenance prefill only counts when eBL's site name is in the eBL
  // vocabulary; otherwise it is shown as a hint rather than silently dropped.
  const provMatch = prefill.provenance
    ? provNames.find((n) => n.toLowerCase() === String(prefill.provenance).toLowerCase())
    : undefined;

  fill(typeEl, typeNames, prefill.type || '');
  fill(provEl, provNames, provMatch || '');
  fill(periodEl, periodNames, prefill.period || '');
  modEl.innerHTML = EblClient.PERIOD_MODIFIERS.map((name) =>
    `<option value="${escapeHtml(name)}"${name === (prefill.periodModifier || 'None') ? ' selected' : ''}>` +
    `${escapeHtml(name)}</option>`).join('');

  const notes = [];
  if (prefill.period || provMatch) {
    notes.push('Prefilled from the eBL record — check and pick a type.');
  }
  if (prefill.provenance && !provMatch) {
    notes.push(`eBL records the site as "${prefill.provenance}", which is not ` +
      'in the provenance list — left blank.');
  }
  if (prefill.genres && prefill.genres.length) {
    notes.push(`Genre: ${prefill.genres[0]}.`);
  }
  prefillEl.textContent = notes.join(' ');
  prefillEl.hidden = notes.length === 0;

  const saved = await new Promise((resolve) => {
    const form = document.getElementById('source-meta-form');
    const skipBtn = document.getElementById('source-meta-skip');
    const cleanup = (value) => {
      form.removeEventListener('submit', onSubmit);
      skipBtn.removeEventListener('click', onSkip);
      dialog.removeEventListener('cancel', onCancel);
      dialog.close();
      resolve(value);
    };
    const onSubmit = (e) => { e.preventDefault(); cleanup(true); };
    const onSkip = () => cleanup(false);
    const onCancel = (e) => { e.preventDefault(); cleanup(false); };
    form.addEventListener('submit', onSubmit);
    skipBtn.addEventListener('click', onSkip);
    dialog.addEventListener('cancel', onCancel);
    dialog.showModal();
    typeEl.focus();
  });
  if (!saved) return;

  // Upsert the manuscripts.json row this source will get anyway, now with
  // the answers. Settings and export reconcile ids later, so the id only
  // has to be unused.
  if (!manuscriptsMeta) manuscriptsMeta = { version: 1, manuscripts: [] };
  const file = siglum + '.txt';
  let entry = manuscriptsMeta.manuscripts.find((m) => m.file === file);
  if (!entry) {
    entry = EblClient.defaultManuscriptEntry(file, manuscriptsMeta.manuscripts.length + 1);
    manuscriptsMeta.manuscripts.push(entry);
  }
  entry.type = typeEl.value || entry.type || '';
  if (provEl.value) entry.provenance = provEl.value;
  if (periodEl.value) entry.period = periodEl.value;
  if (modEl.value) entry.periodModifier = modEl.value;

  try {
    await FileSystem.writeManuscriptsMeta(dirHandle, manuscriptsMeta);
    rebuildTypeMap();   // sidebar grouping and legend follow the type at once
    setStatus('connected', `${siglum}: ${typeEl.value || 'no type'} saved`);
  } catch (err) {
    console.error('Could not save manuscripts.json:', err);
    setStatus('error', 'Could not save the metadata');
  }
}

async function fetchManuscriptFromEbl() {
  if (!window.EblFetch) { alert('The eBL fetch module is not loaded.'); return; }

  const museum = await EblFetch.askMuseumNumber({
    exists: (m) => !!manuscripts['ms-' + m.toLowerCase()],
  });
  if (!museum) return;

  const id = 'ms-' + museum.toLowerCase();
  setStatus('syncing', 'Fetching from eBL…');
  let res;
  try {
    res = await EblFetch.fetchFragment(museum);
  } catch (err) {
    setStatus('error', 'eBL fetch failed');
    alert(err.message);
    return;
  }

  manuscripts[id] = { siglum: museum, content: res.content };
  addManuscriptToList(id, museum);
  try {
    await FileSystem.writeManuscript(dirHandle, museum, res.content);
    await updateManuscriptIndex();
  } catch (err) {
    console.error('Failed to save fetched manuscript:', err);
  }
  loadManuscript(id);
  markUnsaved();
  setStatus('connected', 'Fetched ' + res.primary);

  await askSourceMeta(museum, { ...res.fields, genres: res.genres });

  showPullResult({
    title: museum + ' added from eBL',
    summaryHtml: '<strong>' + escapeHtml(museum) + '</strong> added with ' +
      res.lineCount + ' line' + (res.lineCount === 1 ? '' : 's') +
      ' from eBL.',
    lost: [],
    warnHtml: '<strong>No score assignments.</strong> eBL carries none, so ' +
      'these lines are in the source but not in the score until you add the ' +
      '§ prefixes.',
  });
}

const CHR_NL = String.fromCharCode(10);

// Remove a source: the file, its place in the index, and its row. The eBL
// metadata is left to reconcileManuscripts, which drops entries whose file is
// gone the next time Settings or the reconstructed view runs — deleting the
// row here as well would only race it.
async function deleteManuscript(id) {
  const ms = manuscripts[id];
  if (!ms) return;
  const label = displaySiglum(ms.siglum);
  const shown = label === ms.siglum ? ms.siglum : label + ' (' + ms.siglum + ')';
  const lines = (ms.content || '').split(/\r?\n/)
    .filter((l) => /^\s*§\d+\s/.test(l)).length;
  const warning = lines
    ? CHR_NL + CHR_NL + 'It has ' + lines + ' line' + (lines === 1 ? '' : 's') +
      ' assigned to the score; those readings will disappear from it.'
    : '';
  if (!confirm('Delete "' + shown + '"?' + warning + CHR_NL + CHR_NL +
               'The file is removed from the project folder.')) return;

  try {
    const ok = await FileSystem.deleteManuscript(dirHandle, ms.siglum);
    if (!ok) throw new Error('the file could not be removed');
    const index = await FileSystem.readManuscriptIndex(dirHandle) || [];
    await FileSystem.writeManuscriptIndex(dirHandle, index.filter((x) => x !== ms.siglum));
  } catch (err) {
    console.error('Delete failed:', err);
    alert('Could not delete "' + ms.siglum + '".' + CHR_NL + CHR_NL +
          (err && err.message ? err.message : err));
    return;
  }

  delete manuscripts[id];
  delete manuscriptTypes[ms.siglum];   // else the legend keeps an empty type
  const row = manuscriptList.querySelector('.manuscript-item[data-id="' + id + '"]');
  if (row) row.remove();

  // If it was the open one, fall back to whatever is left rather than leaving
  // the editor showing a source that no longer exists.
  if (activeManuscript === id) {
    activeManuscript = null;
    const next = manuscriptList.querySelector('.manuscript-item');
    if (next) {
      loadManuscript(next.dataset.id);
    } else {
      setEditorContent('');
      updateSourceHeader(null);
    }
  }

  resortManuscriptList();
  renderTypeLegend();
  renderScore();
  setStatus('connected', 'Deleted ' + ms.siglum);
  markUnsaved();
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

  await askSourceMeta(siglum);
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
  // The delete button sits inside the row, so it has to claim the click
  // before the row treats it as a selection.
  const del = e.target.closest('.delete-manuscript-btn');
  if (del) {
    e.preventDefault();
    e.stopPropagation();
    deleteManuscript(del.dataset.id);
    return;
  }
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
  const stripCheckbox = document.getElementById('search-strip');
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

  regexCheckbox.addEventListener('change', () => performSearch());
  caseCheckbox.addEventListener('change', () => performSearch());
  stripCheckbox.addEventListener('change', () => performSearch());

  // Update button states when search input changes
  function updateReplaceButtons() {
    const hasQuery = searchInput.value.length > 0;
    const hasResults = currentResults.length > 0;
    // Replace is off while the apparatus is ignored. A match found in the
    // stripped text spans the brackets that were dropped inside it, so writing
    // over it would leave an unbalanced brace or bracket in the source.
    const canReplace = hasQuery && hasResults && !stripping();
    replaceBtn.disabled = !canReplace || selectedResultIndex < 0;
    replaceAllBtn.disabled = !canReplace;
  }

  searchInput.addEventListener('input', updateReplaceButtons);

  // One regex for all three paths below, so the preview, Replace and Replace
  // All can never disagree about what the pattern means. The "m" is the point:
  // without it "^" anchors to the start of the whole file, which is why an
  // anchored Replace All used to list matches and then change nothing.
  function stripping() {
    return stripCheckbox.checked && !!window.EblAtfSigns;
  }

  function buildRegex() {
    const query = searchInput.value;
    // A regex is left exactly as typed: stripping it would eat the brackets
    // and quantifiers it is made of. It still runs against the stripped text,
    // which is what ignoring the apparatus means for a pattern.
    if (regexCheckbox.checked) {
      return new RegExp(query, caseCheckbox.checked ? 'gm' : 'gmi');
    }
    // A plain search is stripped the way the text is, so that what the user
    // typed and what they are looking at are compared on equal terms.
    const plain = stripping()
      ? EblAtfSigns.stripApparatus(query).text.trim()
      : query;
    if (!plain) return null;
    return new RegExp(plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      caseCheckbox.checked ? 'gm' : 'gmi');
  }

  // What String.replace would put in place of one match. Replace acts on a
  // single occurrence addressed by offset, so the native expansion of "$1" and
  // its relatives is not available to it and has to be done here.
  function expandReplacement(tpl, m, offset, whole) {
    return tpl.replace(/\$(\$|&|`|'|<[^>]*>|\d{1,2})/g, (token, what) => {
      if (what === '$') return '$';
      if (what === '&') return m[0];
      if (what === '`') return whole.slice(0, offset);
      if (what === "'") return whole.slice(offset + m[0].length);
      if (what[0] === '<') {
        const name = what.slice(1, -1);
        return (m.groups && m.groups[name] !== undefined) ? m.groups[name] : '';
      }
      const n = parseInt(what, 10);
      if (n >= 1 && n < m.length) return m[n] === undefined ? '' : m[n];
      // "$12" against one group means group 1 followed by a literal "2".
      if (what.length === 2) {
        const first = parseInt(what[0], 10);
        if (first >= 1 && first < m.length) {
          return (m[first] === undefined ? '' : m[first]) + what[1];
        }
      }
      return token;
    });
  }

  // Where every line of a string starts, so a match offset can be turned into a
  // line number without walking the text again for each match.
  function lineStartsOf(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
  }

  function lineIndexOf(starts, offset) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // The match shown with the whole of every line it touches, so a hit that
  // spans lines reads as what it is rather than as a fragment.
  function excerptFor(content, starts, match) {
    const from = starts[match.lineIndex];
    const to = starts[match.endLineIndex + 1] !== undefined
      ? starts[match.endLineIndex + 1] - 1
      : content.length;
    const text = content.slice(from, to);
    const a = match.start - from;
    const b = match.end - from;
    const html = escapeHtml(text.slice(0, a))
      + '<span class="search-match">' + escapeHtml(text.slice(a, b)) + '</span>'
      + escapeHtml(text.slice(b));
    return html.replace(/\n/g, '<br>');
  }

  // Both destinations close the dialog: neither is visible behind it.
  function openSourceAt(id, line) {
    modal.classList.add('hidden');
    loadManuscript(id);
    if (aceEditor && line) {
      aceEditor.gotoLine(line, 0, true);
      aceEditor.focus();
    }
  }

  // The score is the synoptic view of every source, so a § can be shown
  // without loading the manuscript the result came from.
  function openScoreEntry(sec) {
    modal.classList.add('hidden');
    const tab = document.querySelector('.pane-tab[data-tab="score"]');
    if (tab && !tab.classList.contains('active')) tab.click();
    const el = document.querySelector(`.score-line[data-line="${sec}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('score-line-found');
    setTimeout(() => el.classList.remove('score-line-found'), 1400);
  }

  function selectResultAt(index) {
    const items = resultsContainer.querySelectorAll('.search-result-item');
    if (items.length === 0) {
      selectedResultIndex = -1;
      updateReplaceButtons();
      return;
    }
    const clamped = Math.max(0, Math.min(index, items.length - 1));
    items.forEach((item) => item.classList.remove('selected'));
    const el = items[clamped];
    el.classList.add('selected');
    el.scrollIntoView({ block: 'nearest' });
    selectedResultIndex = clamped;
    updateReplaceButtons();
  }

  // Replace the selected match. Addressed by offset rather than by line, so a
  // pattern that spans lines is replaced the same as one that does not.
  replaceBtn.addEventListener('click', () => {
    if (selectedResultIndex < 0 || currentResults.length === 0) return;

    let flatIndex = 0;
    for (const group of currentResults) {
      for (const match of group.matches) {
        if (flatIndex === selectedResultIndex) {
          saveUndoState([group.id], `Replace in ${group.id}`);

          const ms = manuscripts[group.id];
          const text = expandReplacement(
            replaceInput.value, match.m, match.start, ms.content);
          ms.content = ms.content.slice(0, match.start) + text
            + ms.content.slice(match.end);

          if (group.id === activeManuscript) setEditorContent(ms.content);

          saveToFile(group.id);
          renderScore();
          // Hold the place in the list. Every offset after this one has moved,
          // so the slot that was selected now holds the next match — which is
          // what a second click on Replace should act on.
          performSearch(selectedResultIndex);
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

    // Save undo state for all affected manuscripts
    const affectedIds = currentResults.map((g) => g.id);
    saveUndoState(affectedIds, `Replace all: "${query}" → "${replacement}"`);

    let totalReplaced = 0;

    for (const group of currentResults) {
      const ms = manuscripts[group.id];
      const before = ms.content;
      // Spliced from the listed matches rather than by re-running the regex,
      // so this and the single Replace act on exactly what the list shows.
      // Back to front, so the offsets ahead of each splice stay valid.
      let text = before;
      for (let i = group.matches.length - 1; i >= 0; i--) {
        const mt = group.matches[i];
        text = text.slice(0, mt.start)
          + expandReplacement(replacement, mt.m, mt.start, before)
          + text.slice(mt.end);
      }
      ms.content = text;

      if (ms.content !== before) {
        totalReplaced += group.matches.length;  // one entry per occurrence now
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

  // preserveIndex holds the selection across a replace. Without it the
  // selection reset to -1 and the Replace button greyed itself out after every
  // single use. It is ignored unless it is a number, because the checkbox
  // listeners call this with an event.
  function performSearch(preserveIndex) {
    const keep = typeof preserveIndex === 'number' ? preserveIndex : 0;
    const query = searchInput.value;
    if (!query) {
      currentResults = [];
      selectedResultIndex = -1;
      updateReplaceButtons();
      resultsContainer.innerHTML = '<div class="search-empty">Enter a search term above</div>';
      return;
    }

    let regex;
    try {
      regex = buildRegex();
      if (!regex) {
        currentResults = [];
        selectedResultIndex = -1;
        updateReplaceButtons();
        resultsContainer.innerHTML =
          '<div class="search-empty">Nothing left to search for once the apparatus is removed</div>';
        return;
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

    // Matched against the whole source rather than line by line: a pattern may
    // span lines, and "^" has to mean here what it means in Replace All.
    // The tablet's own line for each file line: "o 23a" rather than the
    // file's line count, which includes the siglum header, surface markers
    // and blank lines and means nothing on the tablet. Lines that are not
    // transliteration (headers, rulings, markers) get null.
    const tabletLineLabels = (content) => {
      const SURFACE_ABBR = {
        'obverse': 'o', 'reverse': 'r', 'edge': 'e', 'left edge': 'l.e.',
        'right edge': 'r.e.', 'top': 't', 'bottom': 'b', 'colophon': 'col',
      };
      let surface = '';
      return String(content || '').split('\n').map((raw) => {
        const line = raw.trim();
        const at = line.match(/^@(obverse|reverse|edge|left edge|right edge|top|bottom|colophon)/i);
        if (at) { surface = SURFACE_ABBR[at[1].toLowerCase()] || at[1]; return null; }
        const num = line.match(/^(?:\u00a7\d+[a-z]?\s+)?(\d+['\u2019]?[a-z]?)\.\s/);
        if (!num) return null;
        return (surface ? surface + ' ' : '') + num[1];
      });
    };

    const strip = stripping();
    for (const [id, ms] of Object.entries(manuscripts)) {
      const content = ms.content;
      const starts = lineStartsOf(content);
      const lineLabels = tabletLineLabels(content);
      // Searched with the apparatus removed, but every offset is mapped back,
      // so what is listed, highlighted and replaced is the text as it stands.
      const stripped = strip ? EblAtfSigns.stripApparatus(content) : null;
      const subject = stripped ? stripped.text : content;
      const matches = [];

      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(subject)) !== null) {
        // A zero-length match never advances lastIndex on its own.
        if (m[0].length === 0) { regex.lastIndex++; continue; }

        // The end is taken from the last matched character rather than the
        // one after it, so apparatus sitting just past the match is not
        // swallowed by a replacement.
        const start = stripped ? stripped.map[m.index] : m.index;
        const end = stripped
          ? stripped.map[m.index + m[0].length - 1] + 1
          : m.index + m[0].length;

        const match = {
          m,
          start,
          end,
          lineIndex: lineIndexOf(starts, start),
          endLineIndex: lineIndexOf(starts, end - 1),
        };
        match.lineNum = match.lineIndex + 1;
        match.endLineNum = match.endLineIndex + 1;
        match.highlighted = excerptFor(content, starts, match);
        // The § this line is assigned to, so the result can link to the
        // score as well as to the source. Read from the line itself rather
        // than from the parse, which the search does not run.
        const lineEnd = starts[match.lineIndex + 1] !== undefined
          ? starts[match.lineIndex + 1] - 1
          : content.length;
        const sec = content.slice(starts[match.lineIndex], lineEnd).match(/^\s*§(\d+)/);
        match.sec = sec ? sec[1] : null;
        match.lineLabel = lineLabels[match.lineIndex] || null;
        match.endLineLabel = lineLabels[match.endLineIndex] || null;
        matches.push(match);
        totalMatches++;
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

    const stripNote = strip
      ? ' &middot; apparatus ignored &mdash; untick to replace'
      : '';
    let html = `<div class="search-count">${totalMatches} match${totalMatches !== 1 ? 'es' : ''} in ${results.length} manuscript${results.length !== 1 ? 's' : ''}${stripNote}</div>`;

    let flatIndex = 0;
    for (const group of results) {
      html += `<div class="search-result-group">`;
      html += `<div class="search-result-header" data-id="${group.id}">${escapeHtml(group.siglum)} (${group.matches.length})</div>`;

      for (const match of group.matches) {
        // The tablet's line, not the file's. A match on a line with no
        // tablet number (the siglum header, a ruling) falls back to the
        // file line, said as such.
        let label;
        if (match.lineLabel) {
          label = match.endLineIndex > match.lineIndex
            ? `${match.lineLabel}\u2013${match.endLineLabel || "line " + match.endLineNum}`
            : match.lineLabel;
        } else {
          label = match.endLineNum > match.lineNum
            ? `line ${match.lineNum}-${match.endLineNum}`
            : `line ${match.lineNum}`;
        }
        const where = `${escapeHtml(group.siglum)} ${label}`;
        html += `<div class="search-result-item" data-id="${group.id}" data-line="${match.lineNum}" data-index="${flatIndex}">`;
        html += `<a class="search-result-line" href="#" data-nav="source" title="Open ${where}">${label}</a>`;
        html += match.sec
          ? `<a class="search-result-sec" href="#" data-nav="score" data-sec="${match.sec}" title="Show § ${match.sec} in the score">§${match.sec}</a>`
          : `<span class="search-result-sec search-result-sec-none"></span>`;
        html += match.highlighted;
        html += `</div>`;
        flatIndex++;
      }

      html += `</div>`;
    }

    resultsContainer.innerHTML = html;

    // A click on one of the row's links goes there; a click anywhere else
    // in the row selects it, which is what Replace acts on.
    resultsContainer.querySelectorAll('.search-result-item').forEach(el => {
      el.addEventListener('click', (e) => {
        const link = e.target.closest('a[data-nav]');
        if (link) {
          e.preventDefault();
          if (link.dataset.nav === 'score') openScoreEntry(link.dataset.sec);
          else openSourceAt(el.dataset.id, parseInt(el.dataset.line, 10));
          return;
        }
        selectResultAt(parseInt(el.dataset.index, 10));
      });
    });

    // The siglum opens the source itself
    resultsContainer.querySelectorAll('.search-result-header').forEach(el => {
      el.addEventListener('click', () => openSourceAt(el.dataset.id, 0));
    });

    // Something is always current, so Replace is never a dead button.
    selectResultAt(keep);
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
      if (w.type !== 'line') {
        const r = w.sourceLine
          ? displaySiglum(w.siglum) + ' ' + abbreviateSurface(w.surface) + ' ' + w.sourceLine
          : displaySiglum(w.siglum);
        text += '  ' + r.padEnd(22) + ' $ ' +
          (w.content || ((w.rulingType || 'single') + ' ruling')) + String.fromCharCode(10);
        continue;
      }
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
const annotationSource = document.getElementById('annotation-source');
const annotationSec = document.getElementById('annotation-sec');
const saveAnnotationBtn = document.getElementById('save-annotation-btn');
const cancelAnnotationBtn = document.getElementById('cancel-annotation-btn');
const annotationsList = document.getElementById('annotations-list');
const annotationsFilter = document.getElementById('annotations-filter');

// A note being edited in the form, and a transient "notes on §N" narrowing
// applied when a score-line dot is clicked.
let editingAnnotationId = null;
let annotationsSecFilter = null;

// Toggle panel
annotationsBtn.addEventListener('click', () => {
  annotationsPanel.classList.toggle('hidden');
});

closeAnnotationsBtn.addEventListener('click', () => {
  annotationsPanel.classList.add('hidden');
  annotationsSecFilter = null;
});

// What the anchored line says right now, so a note can detect that the text
// under it has changed since it was written. With a source, that source's
// reading of the §; without one, the reconstructed line, falling back to the
// first witness. Notes are references, not tethers — on a mismatch the card
// flags it rather than guessing where the line went.
function annotationSnapshot(siglum, sec) {
  if (!sec) return '';
  const rx = new RegExp('^§' + sec + '[a-z]?\\s+(.*)$');
  const firstLine = (content) => {
    for (const raw of String(content || '').split('\n')) {
      const m = raw.trim().match(rx);
      if (m) return m[1].trim().slice(0, 60);
    }
    return '';
  };
  if (siglum) {
    const ms = Object.values(manuscripts).find((m) => m.siglum === siglum);
    return ms ? firstLine(ms.content) : '';
  }
  const recon = reconstructedLines[parseInt(sec, 10)];
  if (recon) return String(recon).trim().slice(0, 60);
  for (const ms of Object.values(manuscripts)) {
    const hit = firstLine(ms.content);
    if (hit) return hit;
  }
  return '';
}

// Scroll the score to a §, flashing it — the annotations panel stays open,
// unlike the search dialog, because it does not cover the score.
function revealScoreEntry(sec) {
  const tab = document.querySelector('.pane-tab[data-tab="score"]');
  if (tab && !tab.classList.contains('active')) tab.click();
  // "35b" anchors a variant reading; the score line is keyed by the number.
  const el = document.querySelector(`.score-line[data-line="${parseInt(sec, 10)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('score-line-found');
  setTimeout(() => el.classList.remove('score-line-found'), 1400);
}

// Open a source in the editor, at its §sec line when one is given.
function revealSourceAnchor(siglum, sec) {
  const found = Object.entries(manuscripts).find(([, ms]) => ms.siglum === siglum);
  if (!found) { setStatus('error', `"${siglum}" is not in this project`); return; }
  const [id, ms] = found;
  loadManuscript(id);
  if (sec && aceEditor) {
    const rx = new RegExp('^\\s*§' + sec + '[a-z]?\\s');
    const lines = String(ms.content || '').split('\n');
    const at = lines.findIndex((l) => rx.test(l));
    if (at >= 0) aceEditor.gotoLine(at + 1, 0, true);
  }
  if (aceEditor) aceEditor.focus();
}

function populateAnnotationSourceSelect(selected) {
  const sigla = Object.values(manuscripts).map((ms) => ms.siglum)
    .sort((a, b) => a.localeCompare(b));
  annotationSource.innerHTML = '<option value="">— whole project —</option>' +
    sigla.map((s) =>
      `<option value="${escapeHtml(s)}"${s === selected ? ' selected' : ''}>${escapeHtml(s)}</option>`)
      .join('');
}

function resetAnnotationForm() {
  editingAnnotationId = null;
  annotationForm.classList.add('hidden');
  annotationTitle.value = '';
  annotationDesc.value = '';
  annotationSec.value = '';
  saveAnnotationBtn.textContent = 'Save';
}

// Show/hide form
addAnnotationBtn.addEventListener('click', () => {
  const opening = annotationForm.classList.contains('hidden');
  if (!opening) { resetAnnotationForm(); return; }
  editingAnnotationId = null;
  saveAnnotationBtn.textContent = 'Save';
  populateAnnotationSourceSelect(
    activeManuscript && manuscripts[activeManuscript]
      ? manuscripts[activeManuscript].siglum : '');
  annotationForm.classList.remove('hidden');
  annotationTitle.focus();
});

cancelAnnotationBtn.addEventListener('click', resetAnnotationForm);

// Save annotation — a new one, or the one being edited
saveAnnotationBtn.addEventListener('click', async () => {
  const title = annotationTitle.value.trim();
  if (!title) {
    annotationTitle.focus();
    return;
  }

  const siglum = annotationSource.value;
  const sec = annotationSec.value.trim().replace(/^§/, '');

  if (editingAnnotationId) {
    const ann = annotations.find((a) => a.id === editingAnnotationId);
    if (ann) {
      ann.type = annotationType.value;
      ann.title = title;
      ann.description = annotationDesc.value.trim();
      ann.siglum = siglum;
      ann.sec = sec;
      ann.snapshot = annotationSnapshot(siglum, sec);
      delete ann.location;   // superseded by the structured anchor
      ann.modified = new Date().toISOString();
    }
  } else {
    annotations.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      type: annotationType.value,
      title,
      description: annotationDesc.value.trim(),
      siglum,
      sec,
      snapshot: annotationSnapshot(siglum, sec),
      status: 'open',
      created: new Date().toISOString()
    });
  }

  await saveAnnotations();
  renderAnnotations();
  renderScore();          // the § dots follow the notes
  resetAnnotationForm();
});

// Filter change
annotationsFilter.addEventListener('change', renderAnnotations);

const ANNOTATION_BADGE = {
  bug: 'Bug', enhancement: 'Enh', reference: 'Ref', commentary: 'Com',
};

function renderAnnotations() {
  const filter = annotationsFilter.value;
  let filtered = annotations;

  if (filter === 'open') filtered = annotations.filter(a => a.status === 'open');
  else if (filter === 'resolved') filtered = annotations.filter(a => a.status === 'resolved');
  else if (ANNOTATION_BADGE[filter]) filtered = annotations.filter(a => a.type === filter);

  // Narrowed to one score line by its dot. On top of the dropdown filter, so
  // "open notes on §35" is expressible.
  let secBar = '';
  if (annotationsSecFilter != null) {
    filtered = filtered.filter((a) => parseInt(a.sec, 10) === parseInt(annotationsSecFilter, 10));
    secBar = `<div class="annotations-sec-filter">Notes on § ${escapeHtml(String(annotationsSecFilter))}
      <button id="clear-sec-filter" type="button">show all</button></div>`;
  }

  if (filtered.length === 0) {
    annotationsList.innerHTML = secBar +
      '<div class="annotations-empty">No annotations match this filter.</div>';
    bindSecFilterClear();
    return;
  }

  annotationsList.innerHTML = secBar + filtered.map(a => {
    const anchored = a.siglum || a.sec;
    const stale = a.sec && a.snapshot && annotationSnapshot(a.siglum, a.sec) !== a.snapshot;
    const anchor = anchored ? `
      <div class="annotation-anchor">
        ${a.siglum ? `<button type="button" class="annotation-anchor-chip" data-goto="source"
            data-siglum="${escapeHtml(a.siglum)}" data-sec="${escapeHtml(a.sec || '')}"
            title="Open ${escapeHtml(a.siglum)}${a.sec ? ' at §' + escapeHtml(a.sec) : ''}">${escapeHtml(a.siglum)}</button>` : ''}
        ${a.sec ? `<button type="button" class="annotation-anchor-chip" data-goto="score"
            data-sec="${escapeHtml(a.sec)}" title="Show § ${escapeHtml(a.sec)} in the score">§ ${escapeHtml(a.sec)}</button>` : ''}
        ${stale ? `<span class="annotation-stale" title="The line no longer reads what it did when this note was written — it was: ${escapeHtml(a.snapshot)}">text changed</span>` : ''}
      </div>` : '';
    return `
    <div class="annotation-item ${a.status}" data-id="${a.id}">
      <div class="annotation-item-header">
        <span class="annotation-badge ${a.type}">${ANNOTATION_BADGE[a.type] || a.type}</span>
        <span class="annotation-title-text">${escapeHtml(a.title)}</span>
        <span class="annotation-status-badge ${a.status}">${a.status}</span>
      </div>
      ${a.description ? `<div class="annotation-desc-text">${escapeHtml(a.description)}</div>` : ''}
      ${anchor}
      ${a.location ? `<div class="annotation-location-text">${escapeHtml(a.location)}</div>` : ''}
      <div class="annotation-actions">
        <span class="annotation-date">${new Date(a.created).toLocaleDateString()}${a.modified ? ' · edited ' + new Date(a.modified).toLocaleDateString() : ''}</span>
        <button class="annotation-edit-btn" data-id="${a.id}">Edit</button>
        <button class="annotation-toggle-btn" data-id="${a.id}">${a.status === 'open' ? 'Resolve' : 'Reopen'}</button>
        <button class="annotation-delete-btn" data-id="${a.id}">Delete</button>
      </div>
    </div>
  `; }).join('');

  // Anchor chips navigate; the panel stays open.
  annotationsList.querySelectorAll('.annotation-anchor-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.goto === 'score') revealScoreEntry(btn.dataset.sec);
      else revealSourceAnchor(btn.dataset.siglum, btn.dataset.sec);
    });
  });

  // Edit opens the form with the note in it; Save then updates in place.
  annotationsList.querySelectorAll('.annotation-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ann = annotations.find(a => a.id === btn.dataset.id);
      if (!ann) return;
      editingAnnotationId = ann.id;
      annotationType.value = ann.type;
      annotationTitle.value = ann.title;
      annotationDesc.value = ann.description || '';
      populateAnnotationSourceSelect(ann.siglum || '');
      annotationSec.value = ann.sec || '';
      saveAnnotationBtn.textContent = 'Update';
      annotationForm.classList.remove('hidden');
      annotationTitle.focus();
    });
  });

  bindSecFilterClear();

  // Bind action buttons
  annotationsList.querySelectorAll('.annotation-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ann = annotations.find(a => a.id === btn.dataset.id);
      if (ann) {
        ann.status = ann.status === 'open' ? 'resolved' : 'open';
        await saveAnnotations();
        renderAnnotations();
        renderScore();    // the dots count open notes only
      }
    });
  });

  annotationsList.querySelectorAll('.annotation-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this annotation?')) return;
      annotations = annotations.filter(a => a.id !== btn.dataset.id);
      await saveAnnotations();
      renderAnnotations();
      renderScore();      // a dot may just have lost its last note
    });
  });
}

function bindSecFilterClear() {
  const clear = document.getElementById('clear-sec-filter');
  if (clear) clear.addEventListener('click', () => {
    annotationsSecFilter = null;
    renderAnnotations();
  });
}

// A dot on a score line opens the panel narrowed to that line's notes.
scorePanel.addEventListener('click', (e) => {
  const dot = e.target.closest('.score-note-dot');
  if (!dot) return;
  annotationsSecFilter = dot.dataset.line;
  annotationsPanel.classList.remove('hidden');
  renderAnnotations();
});

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
        Object.keys(noteLines).forEach(k => delete noteLines[k]);
        Object.keys(parallelLines).forEach(k => delete parallelLines[k]);
        Object.keys(variantLines).forEach(k => delete variantLines[k]);
        if (data.reconstructed) Object.assign(reconstructedLines, data.reconstructed);
        if (data.translations) Object.assign(translationLines, data.translations);
        if (data.notes) Object.assign(noteLines, data.notes);
        if (data.parallels) Object.assign(parallelLines, data.parallels);
        if (data.variants) Object.assign(variantLines, data.variants);
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
        Object.keys(noteLines).forEach(k => delete noteLines[k]);
        Object.keys(parallelLines).forEach(k => delete parallelLines[k]);
        Object.keys(variantLines).forEach(k => delete variantLines[k]);
        if (data.reconstructed) Object.assign(reconstructedLines, data.reconstructed);
        if (data.translations) Object.assign(translationLines, data.translations);
        if (data.notes) Object.assign(noteLines, data.notes);
        if (data.parallels) Object.assign(parallelLines, data.parallels);
        if (data.variants) Object.assign(variantLines, data.variants);
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

  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', openProjectSettings);

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
const exportPreflightEl = document.getElementById('export-preflight');
const exportEffectEl = document.getElementById('export-effect');
const exportOptManuscriptsEl = document.getElementById('export-opt-manuscripts');
const exportOptSaveAtfEl = document.getElementById('export-opt-save-atf');

// What the target chapter holds right now, from the preflight GET. null until
// it resolves; { error } when the chapter could not be read.
let exportPreflight = null;

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
    translationLines,
    noteLines,
    parallelLines,
    variantLines,
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
  const translationEdits = diff.translationEdits;
  const noteEdits = diff.noteEdits;
  const parallelEdits = diff.parallelEdits;
  const witnessEdits = diff.witnessEdits;

  // Apply reconstruction, translation, note and parallel edits to in-memory
  // state + score-data.json. Emptying a row drops that piece; the next build
  // simply omits it.
  // Reading 0 lives in the primary maps, the rest in variantLines.
  const readingSlot = (lineNum, variantIndex) => {
    if (!variantIndex) return null;
    const list = variantLines[lineNum];
    return Array.isArray(list) ? list[variantIndex - 1] : null;
  };

  for (const e of reconEdits) {
    const slot = readingSlot(e.lineNum, e.variantIndex);
    if (slot) slot.text = e.newContent;
    else reconstructedLines[e.lineNum] = e.newContent;
  }
  for (const e of translationEdits) {
    translationLines[e.lineNum] = e.newContent;
  }
  for (const e of noteEdits) {
    const slot = readingSlot(e.lineNum, e.variantIndex);
    if (slot) slot.note = e.newContent;
    else noteLines[e.lineNum] = e.newContent;
  }
  for (const e of parallelEdits) {
    const slot = readingSlot(e.lineNum, e.variantIndex);
    const list = slot ? slot.parallels : parallelLines[e.lineNum];
    if (Array.isArray(list) && e.index < list.length) list[e.index] = e.newContent;
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
  if (reconEdits.length || translationEdits.length || noteEdits.length
      || parallelEdits.length || touchedFiles.length) {
    await saveScoreDataToFile();
    renderScore();
    const parts = [];
    if (reconEdits.length) parts.push(`${reconEdits.length} reconstruction edit${reconEdits.length === 1 ? '' : 's'}`);
    if (translationEdits.length) parts.push(`${translationEdits.length} translation edit${translationEdits.length === 1 ? '' : 's'}`);
    if (noteEdits.length) parts.push(`${noteEdits.length} note edit${noteEdits.length === 1 ? '' : 's'}`);
    if (parallelEdits.length) parts.push(`${parallelEdits.length} parallel edit${parallelEdits.length === 1 ? '' : 's'}`);
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

// How many chapter lines would be sent. Counted from the live editor buffer
// rather than the last compiled lineMap, so hand-edits in the Recon view are
// reflected. Reconstruction rows are the unindented "N. ..." ones; witness
// rows carry a siglum first.
function countArtifactLines() {
  const atf = reconAceEditor ? reconAceEditor.getValue() : reconOriginalAtf;
  if (!atf) return 0;
  return EblAtf.stripFormatting(atf)
    .split('\n')
    .filter((row) => /^\d+['’]?\.\s/.test(row))
    .length;
}

function selectedExportMode() {
  const checked = document.querySelector('input[name="export-mode"]:checked');
  return checked ? checked.value : 'validate';
}

// Read the target chapter so the dialog can say what is already there. This is
// a public GET — it works without a token, and a chapter that does not exist
// yet is a normal answer, not an error.
async function loadExportPreflight(target) {
  if (!target) {
    exportPreflight = { error: 'No target chapter configured.' };
    return;
  }
  try {
    const chapter = await EblClient.getChapter(target);
    const numbers = (chapter.lines || []).map((l) => l.number);
    exportPreflight = {
      lineCount: numbers.length,
      first: numbers[0] || null,
      last: numbers[numbers.length - 1] || null,
      translated: (chapter.lines || []).filter((l) => (l.translation || []).length).length,
    };
  } catch (err) {
    exportPreflight = {
      error: err && err.status === 404
        ? 'Chapter not found on eBL.'
        : `Could not read the chapter (${err && err.message ? err.message : err}).`,
    };
  }
}

function renderExportPreflight() {
  if (!exportPreflight) {
    exportPreflightEl.textContent = 'checking…';
    return;
  }
  if (exportPreflight.error) {
    exportPreflightEl.textContent = exportPreflight.error;
    return;
  }
  const { lineCount, first, last, translated } = exportPreflight;
  if (!lineCount) {
    exportPreflightEl.textContent = 'Empty — no lines yet.';
    return;
  }
  const range = first && last ? ` (§${first}–${last})` : '';
  const tr = translated ? `, ${translated} translated` : '';
  exportPreflightEl.textContent = `${lineCount} line${lineCount === 1 ? '' : 's'}${range}${tr}`;
}

// Spell out the outcome before the button is pressed. This is the part that
// makes append-vs-replace a decision rather than a guess.
function renderExportEffect() {
  const mode = selectedExportMode();
  const sending = countArtifactLines();
  const existing = exportPreflight && !exportPreflight.error ? exportPreflight.lineCount : null;

  let html = '';
  if (mode === 'validate') {
    html = `Checks ${sending} chapter line${sending === 1 ? '' : 's'}. Nothing is written to eBL.`;
  } else if (mode === 'append') {
    html = existing == null
      ? `Adds ${sending} line${sending === 1 ? '' : 's'} to the end of the chapter.`
      : `Chapter goes from <strong>${existing}</strong> to <strong>${existing + sending}</strong> lines.`;
    if (existing) {
      html += ` The ${existing} existing line${existing === 1 ? '' : 's'} stay${existing === 1 ? 's' : ''} and your §numbers will repeat.`;
    }
  } else {
    html = existing == null
      ? `Deletes every existing line, then writes ${sending}.`
      : `Deletes <strong>${existing}</strong> line${existing === 1 ? '' : 's'}, then writes <strong>${sending}</strong>.`;
    if (exportPreflight && exportPreflight.translated) {
      html += ` ${exportPreflight.translated} eBL translation${exportPreflight.translated === 1 ? '' : 's'} will be replaced by yours.`;
    }
  }
  exportEffectEl.innerHTML = html;
  exportEffectEl.classList.remove('hidden');
  exportEffectEl.classList.toggle('destructive', mode === 'replace');

  exportGoBtn.textContent = mode === 'validate' ? 'Validate'
    : mode === 'append' ? 'Append to chapter'
    : 'Replace all lines';
}

// Only the steps a mode actually runs are shown.
function stepsForMode(mode) {
  if (mode === 'validate') return ['validate'];
  const steps = ['validate'];
  if (exportOptManuscriptsEl && exportOptManuscriptsEl.checked) steps.push('manuscripts');
  if (mode === 'replace') steps.push('backup', 'delete');
  steps.push('import');
  return steps;
}

function syncExportSteps() {
  const active = stepsForMode(selectedExportMode());
  exportProgressEl.querySelectorAll('.export-step').forEach((el) => {
    el.classList.toggle('hidden', !active.includes(el.dataset.step));
  });
}

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

  // Always reopen on Validate. Replace deletes work that is already on eBL, so
  // it has to be chosen deliberately each time rather than inherited from the
  // last export. Reset before the button state is derived from the mode.
  const validateRadio = document.querySelector('input[name="export-mode"][value="validate"]');
  if (validateRadio) validateRadio.checked = true;

  // Validate-only writes nothing, so it needs neither a token nor write scope.
  const canExport = !!reconLineMap;
  exportGoBtn.disabled = !canExport;
  exportGoBtn.title = canExport ? '' : 'Nothing compiled to validate yet';

  exportPreflight = null;
  renderExportPreflight();
  renderExportEffect();
  syncExportSteps();

  exportModal.classList.remove('hidden');

  // Preflight after showing the dialog so it never blocks opening.
  loadExportPreflight(target).then(() => {
    if (exportModal.classList.contains('hidden')) return;
    renderExportPreflight();
    renderExportEffect();
  });
}

// Re-render the consequences whenever the choice changes.
document.querySelectorAll('input[name="export-mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const ts = EblClient.tokenStatus();
    const target = (projectConfig && projectConfig.ebl && projectConfig.ebl.target) || null;
    const mode = selectedExportMode();
    const canWrite = target && ts.hasToken && !ts.expired && ts.hasWriteTexts;
    const ok = mode === 'validate' ? !!reconLineMap : !!canWrite;
    exportGoBtn.disabled = !ok;
    exportGoBtn.title = ok ? '' : 'Cannot write to eBL — fix token/target first';
    renderExportEffect();
    syncExportSteps();
  });
});
exportOptManuscriptsEl && exportOptManuscriptsEl.addEventListener('change', syncExportSteps);

function closeExportModal() {
  exportModal.classList.add('hidden');
}

// Thrown when the exporter stops before writing anything. Distinct from an
// EblError so the catch below can say "nothing was sent" truthfully.
class ExportAborted extends Error {
  constructor(message, problems) {
    super(message);
    this.name = 'ExportAborted';
    this.problems = problems || [];
  }
}

// Run the ATF past the local validator. Returns [] when it is clean and also
// when there is no validator to ask — browser mode cannot check, and refusing
// to export on that basis would block the only mode that works there.
async function validateAtfForExport(wireAtf) {
  if (!localValidatorAvailable) return [];
  try {
    const res = await fetch('/api/validate-atf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ atf: wireAtf }),
    });
    if (!res.ok) return [];
    const result = await res.json();
    return result.valid ? [] : (result.errors || []);
  } catch (_) {
    return [];
  }
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

  const mode = selectedExportMode();
  const wireAtf = EblAtf.stripFormatting(atfText);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // Declared out here so the catch can tell whether the chapter was already
  // emptied when the failure hit, and point at the backup if so.
  let backupName = null;
  let deleted = 0;

  try {
    // Always validate first. On a replace this is the difference between a
    // clean swap and a chapter emptied for an import that then fails.
    setStep('validate', 'running');
    const problems = await validateAtfForExport(wireAtf);
    if (problems && problems.length) {
      setStep('validate', 'error');
      throw new ExportAborted(
        `${problems.length} ATF error${problems.length === 1 ? '' : 's'} — nothing was sent.`,
        problems
      );
    }
    setStep('validate', 'done');

    if (exportOptSaveAtfEl && exportOptSaveAtfEl.checked && dirHandle) {
      await FileSystem.writeProjectFile(dirHandle, `export-${stamp}.atf`, wireAtf);
    }

    if (mode === 'validate') {
      exportResultEl.classList.remove('hidden');
      exportResultEl.classList.add('success');
      exportResultEl.classList.remove('failure');
      exportResultEl.innerHTML = localValidatorAvailable
        ? `Valid. ${countArtifactLines()} chapter lines ready to send. Nothing was written to eBL.`
        : 'No local validator in browser mode, so the ATF was not checked. Nothing was written to eBL.';
      return;
    }

    if (exportOptManuscriptsEl && exportOptManuscriptsEl.checked) {
      setStep('manuscripts', 'running');
      const eblMss = EblClient.toEblManuscripts(manuscriptsMeta);
      await EblClient.postManuscripts(target, eblMss, []);
      setStep('manuscripts', 'done');
    }

    if (mode === 'replace') {
      // Keep a local copy before removing anything. eBL keeps a changelog too,
      // but restoring from it is manual.
      setStep('backup', 'running');
      const chapter = await EblClient.getChapter(target);
      if (dirHandle) {
        backupName = await FileSystem.writeProjectFile(
          dirHandle,
          `ebl-chapter-backup-${stamp}.json`,
          JSON.stringify(chapter, null, 2)
        );
      }
      setStep('backup', 'done');

      setStep('delete', 'running');
      deleted = await EblClient.deleteAllLines(target, (chapter.lines || []).length);
      setStep('delete', 'done');
    }

    setStep('import', 'running');
    await EblClient.postImport(target, wireAtf);
    setStep('import', 'done');

    // Success
    const url = `https://www.ebl.lmu.de/corpus/${target.genre}/${target.category}/${target.index}/${target.stage}/${target.name}`;
    const summary = mode === 'replace'
      ? `Replaced ${deleted} line${deleted === 1 ? '' : 's'} with ${countArtifactLines()}.`
      : `Appended ${countArtifactLines()} line${countArtifactLines() === 1 ? '' : 's'}.`;
    const backupNote = backupName ? ` Backup saved as <code>${escapeHtml(backupName)}</code>.` : '';
    exportResultEl.classList.remove('hidden');
    exportResultEl.classList.add('success');
    exportResultEl.classList.remove('failure');
    exportResultEl.innerHTML = `${summary}${backupNote} <a href="${url}" target="_blank" rel="noopener noreferrer">View chapter on eBL →</a>`;
  } catch (err) {
    // Figure out which step failed by looking for which step is currently running
    const running = exportProgressEl.querySelector('.export-step.running');
    if (running) setStep(running.dataset.step, 'error');

    exportResultEl.classList.remove('hidden');
    exportResultEl.classList.remove('success');
    exportResultEl.classList.add('failure');

    if (err instanceof ExportAborted) {
      const shown = err.problems.slice(0, VALIDATE_MAX_ERRORS);
      exportResultEl.innerHTML =
        `<strong>${escapeHtml(err.message)}</strong><br>` +
        shown.map((e) => escapeHtml(
          (e.line != null ? `Line ${e.line}: ` : '') +
          (e.column != null ? `col ${e.column}: ` : '') + e.message
        )).join('<br>');
      applyValidationErrorsToAce(err.problems);
      showReconStatus({
        title: 'ATF errors — export stopped before sending',
        items: err.problems.map((e) => ({ line: e.line, message: e.message })),
        onItemClick: (it) => {
          if (it.line != null) {
            reconAceEditor.gotoLine(it.line, 0, true);
            reconAceEditor.focus();
          }
        },
      });
    } else if (err instanceof EblClient.EblError) {
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

    // A replace that got past the delete leaves the chapter empty. Say so
    // rather than letting the user discover it on eBL.
    if (deleted && !(err instanceof ExportAborted)) {
      exportResultEl.innerHTML +=
        `<br><br><strong>The chapter is now empty on eBL.</strong> ${deleted} line` +
        `${deleted === 1 ? ' was' : 's were'} deleted before this failed. ` +
        (backupName
          ? `Fix the ATF and export again, or restore from <code>${escapeHtml(backupName)}</code> in the project folder.`
          : 'Fix the ATF and export again.');
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
