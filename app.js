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

// ---- Positional alignment ----------------------------------------------
// Which composite position each witness word answers to:
//   lineAlignments[lineNum][siglum|sourceLine][witnessWordIndex] = position
// Richer than eBL can hold: eBL takes only omittedWords, which is this map
// projected onto "absent or not". The pairings themselves, and the
// substitutions they reveal, live here and nowhere else.
const lineAlignments = {};

// Lemmas chosen for the reading, as lemmaChoices[section][variant][position]
// = [lemma id]. Only the reading is lemmatized here; a witness word takes the
// lemma of whatever reading word it is aligned to, which is what the alignment
// already knows and what eBL does with it anyway.
const lemmaChoices = {};

// Per section: the fingerprint of what was sent to eBL, and when.
const exportedSections = {};
// Per section: the fingerprint of what a human editor signed off on, and when.
// A separate ledger from the export marks — a section can be on eBL without
// anyone having read it through, and read through without having been sent.
const revisedSections = {};

// What a send to eBL left broken, waiting for a hand.
//
// A failed or half-failed export is not a state the score can show on its own:
// fixing it usually means opening eBL and doing something there, and only the
// editor knows when that has happened. So each mishap becomes a report — an
// error when nothing went through, a warning when parts did — and the section
// wears the sign until the editor ticks the report done by hand.
const exportIssues = [];
let positionMode = false;

// Sections shown as positions or as lemmas on their own, without turning the
// whole project over to it. Working on one omen is the common case;
// rebuilding ninety of them to do it is not.
const positionSections = new Set();
const lemmaSections = new Set();
function positionsOn(lineNum) {
  return positionMode || positionSections.has(lineNum);
}
function lemmasOn(lineNum) {
  return lemmaMode || lemmaSections.has(lineNum);
}
let lemmaMode = false;
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
  manuscriptPeriods = {};
  for (const m of (manuscriptsMeta && manuscriptsMeta.manuscripts) || []) {
    const key = (m.file || '').replace(/\.txt$/, '');
    if (!key) continue;
    manuscriptTypes[key] = MANUSCRIPT_TYPE_SLUGS[m.type] || 'none';
    // eBL's own abbreviation — Neo-Assyrian is NA, Late Babylonian LB — so the
    // sidebar and the siglum eBL builds agree on what the letters mean. A
    // modifier keeps its initial in front: Early Neo-Assyrian is ENA.
    const abbr = EblClient.abbrevOf(EblClient.PERIODS, m.period || '');
    const mod = m.periodModifier && m.periodModifier !== 'None'
      ? m.periodModifier.slice(0, 1) : '';
    manuscriptPeriods[key] = abbr ? mod + abbr : '';
  }
  renderTypeLegend();
  refreshManuscriptBadges();
  // grouping depends on the types, so re-sort if the list is already built
  if (typeof manuscriptList !== 'undefined' && manuscriptList &&
      manuscriptList.querySelector('.manuscript-item')) {
    resortManuscriptList();
  }
}

// ---- what each source is carrying, in the sidebar --------------------------
//
// A file in the folder is not yet a witness. It becomes one when its lines are
// assigned to sections, and until then it has nothing to give the chapter and
// no reason to be registered with eBL.
//
// Both numbers come from the same file in one pass, so they cannot disagree:
// lines placed over lines the tablet has.
let manuscriptPeriods = {};   // museum number -> period, abbreviated as eBL does

function manuscriptUse() {
  const use = {};
  for (const id of Object.keys(manuscripts || {})) {
    const ms = manuscripts[id];
    if (!ms) continue;
    const key = String(ms.siglum || '').replace(/\.txt$/, '');
    if (!key) continue;
    const sections = new Set();
    let total = 0;
    let used = 0;
    for (const raw of String(ms.content || '').split(/\r?\n/)) {
      const parsed = splitScoreLine(raw);
      if (!parsed) continue;         // a heading, a $ directive, a blank
      total++;
      if (parsed.sec == null) continue;
      used++;
      sections.add(parsed.sec);
    }
    use[key] = { total, used, sections: sections.size };
  }
  return use;
}

function refreshManuscriptBadges() {
  if (typeof manuscriptList === 'undefined' || !manuscriptList) return;
  const rows = manuscriptList.querySelectorAll('.manuscript-item');
  if (!rows.length) return;
  const use = manuscriptUse();

  for (const li of rows) {
    const key = li.dataset.museum || '';
    const held = use[key] || { total: 0, used: 0, sections: 0 };
    const carrying = held.used > 0;
    const said = held.total
      ? held.used + ' of ' + held.total + ' lines placed'
        + (held.sections ? ', in ' + held.sections + ' section'
          + (held.sections === 1 ? '' : 's') : '')
      : 'no numbered lines in this file';

    let dot = li.querySelector('.ms-use-dot');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'ms-use-dot';
      li.appendChild(dot);
    }
    dot.classList.toggle('is-used', carrying);
    dot.title = said;

    const period = manuscriptPeriods[key] || '';
    let meta = li.querySelector('.ms-meta');
    if (!meta) {
      meta = document.createElement('span');
      meta.className = 'ms-meta';
      const del = li.querySelector('.delete-manuscript-btn');
      li.insertBefore(meta, del || null);
    }
    // used/total, so an unplaced tablet reads 0/12 at a glance.
    meta.textContent = [period, held.total ? held.used + '/' + held.total : '']
      .filter(Boolean).join('  ·  ');
    meta.title = said;
    meta.classList.toggle('is-idle', !carrying);
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
// Re-render without the page jumping.
//
// renderScore() throws the score away and builds it again, so whatever was on
// screen is gone and the pane snaps back to the top. Toggling Positions on a
// long chapter is the case that makes this unbearable: the omen being worked on
// disappears and has to be found again.
//
// The § nearest the top of the pane is remembered, along with how far into it
// the view had got, and put back where it was afterwards.
function keepScoreInView(run) {
  const pane = document.getElementById('score');
  if (!pane) { run(); return; }

  const top = pane.getBoundingClientRect().top;
  let anchor = null;
  let offset = 0;
  for (const el of pane.querySelectorAll('.score-line[data-line]')) {
    const box = el.getBoundingClientRect();
    if (box.bottom > top) {
      anchor = el.dataset.line;
      offset = box.top - top;
      break;
    }
  }

  run();

  if (anchor == null) return;
  const again = pane.querySelector(`.score-line[data-line="${anchor}"]`);
  if (!again) return;
  // Measured after the new layout, so the same § sits where it sat before.
  pane.scrollTop += again.getBoundingClientRect().top - top - offset;
}

// Say a section is already on eBL, or take that back.
//
// The fingerprint can only speak for sends made from here, so a chapter that
// was imported some other way starts out looking as though none of it had ever
// gone. Marking it by hand fixes the starting point; from then on it behaves
// like any other mark and clears itself when the section changes.
//
// Shift-click carries the mark down from the last one set, so a run of omens
// takes two clicks rather than one each.
let lastMarkedSection = null;

async function toggleSentMark(lineNum, extend) {
  const from = (extend && lastMarkedSection != null)
    ? Math.min(lastMarkedSection, lineNum) : lineNum;
  const to = (extend && lastMarkedSection != null)
    ? Math.max(lastMarkedSection, lineNum) : lineNum;

  const clearing = sentState(lineNum) !== 'never';
  const { scoreLines } = buildScore();
  const known = new Set(Object.keys(scoreLines).map(Number));
  let touched = 0;
  for (let n = from; n <= to; n++) {
    if (!known.has(n)) continue;
    if (clearing) { delete exportedSections[n]; touched++; }
    else { markSent(n, ['said to be on eBL already']); touched++; }
  }
  lastMarkedSection = lineNum;
  if (!touched) return;
  await saveScoreDataToFile();
  keepScoreInView(renderScore);
  setStatus('connected', (clearing ? 'Cleared ' : 'Marked ') + touched + ' section(s)'
    + (from === to ? '' : ' (§' + from + '–§' + to + ')'));
  setTimeout(() => setStatus('connected', 'Ready'), 4000);
}

document.addEventListener('click', (e) => {
  const mark = e.target && e.target.closest ? e.target.closest('.line-sent') : null;
  if (!mark) return;
  const lineNum = parseInt(mark.dataset.line, 10);
  if (!Number.isFinite(lineNum)) return;
  e.preventDefault();
  toggleSentMark(lineNum, e.shiftKey);
});

// The revision mark, worked the same way: click to say an editor has read the
// section through, click again to unsay it, shift-click to carry the mark down
// from the last one set. Its own anchor, so revising and marking-as-sent can
// interleave without stealing each other's runs.
let lastRevisedSection = null;

async function toggleRevisedMark(lineNum, extend) {
  const from = (extend && lastRevisedSection != null)
    ? Math.min(lastRevisedSection, lineNum) : lineNum;
  const to = (extend && lastRevisedSection != null)
    ? Math.max(lastRevisedSection, lineNum) : lineNum;

  const clearing = revisedState(lineNum) !== 'never';
  const { scoreLines } = buildScore();
  const known = new Set(Object.keys(scoreLines).map(Number));
  let touched = 0;
  for (let n = from; n <= to; n++) {
    if (!known.has(n)) continue;
    if (clearing) { delete revisedSections[n]; touched++; }
    else { markRevised(n); touched++; }
  }
  lastRevisedSection = lineNum;
  if (!touched) return;
  await saveScoreDataToFile();
  keepScoreInView(renderScore);
  setStatus('connected', (clearing ? 'Cleared the revision mark on ' : 'Marked as revised: ')
    + touched + ' section(s)' + (from === to ? '' : ' (§' + from + '–§' + to + ')'));
  setTimeout(() => setStatus('connected', 'Ready'), 4000);
}

document.addEventListener('click', (e) => {
  const mark = e.target && e.target.closest ? e.target.closest('.line-revised') : null;
  if (!mark) return;
  const lineNum = parseInt(mark.dataset.line, 10);
  if (!Number.isFinite(lineNum)) return;
  e.preventDefault();
  toggleRevisedMark(lineNum, e.shiftKey);
});

// Keyboard: Alt+P for positions, Alt+L for lemmas.
//
// Alt rather than Ctrl, which the browser has already spoken for, and both are
// ignored while something is being typed into — the readings are editable, and
// a shortcut that fires mid-word would be worse than no shortcut.
//
// With the cursor in a line, the toggle applies to that § alone; otherwise it
// turns the whole project over, which is what the header buttons do.
function typingSomewhere() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

// The last § the user actually put a cursor or a click into. Clicking a
// witness line focuses nothing — it is not editable — so without this the
// shortcut has only the scroll position to go on, and answers with whatever
// happens to be nearest the top edge.
let lastTouchedSection = null;
document.addEventListener('click', (e) => {
  const line = e.target && e.target.closest ? e.target.closest('.score-line[data-line]') : null;
  if (!line) return;
  const n = parseInt(line.dataset.line, 10);
  if (Number.isFinite(n)) lastTouchedSection = n;
}, true);

// How much of a line is actually on screen.
function visibleHeightOf(el, top, bottom) {
  const box = el.getBoundingClientRect();
  return Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top));
}

// Which § a shortcut means.
//
// In order: whatever has focus, then the last one clicked (if it is still on
// screen), then the one taking up most of the pane. The old answer — the first
// line whose bottom had not yet passed the top edge — is the omen ABOVE the one
// being read as soon as the previous one is half scrolled off, which is why
// clicking §4 and pressing the key opened §3.
function sectionUnderCursor() {
  const el = document.activeElement;
  const focused = el && el.closest ? el.closest('.score-line[data-line]') : null;
  if (focused) return parseInt(focused.dataset.line, 10);

  const pane = document.getElementById('score');
  if (!pane) return lastTouchedSection;
  const box = pane.getBoundingClientRect();

  if (lastTouchedSection != null) {
    const row = pane.querySelector(`.score-line[data-line="${lastTouchedSection}"]`);
    if (row && visibleHeightOf(row, box.top, box.bottom) > 0) return lastTouchedSection;
  }

  let best = null;
  let bestSeen = 0;
  for (const row of pane.querySelectorAll('.score-line[data-line]')) {
    const seen = visibleHeightOf(row, box.top, box.bottom);
    if (seen > bestSeen) { bestSeen = seen; best = parseInt(row.dataset.line, 10); }
  }
  return best;
}

document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const key = (e.key || '').toLowerCase();
  if (key !== 'p' && key !== 'l') return;
  if (typingSomewhere()) return;
  const scoreTab = document.querySelector('.pane-tab[data-tab="score"]');
  if (scoreTab && !scoreTab.classList.contains('active')) return;
  e.preventDefault();
  const mode = key === 'p' ? 'positions' : 'lemmas';
  if (e.shiftKey) {
    // Alt+Shift+P / Alt+Shift+L: the whole project, as the header buttons do.
    const btn = document.getElementById(mode === 'positions' ? 'position-mode-btn' : 'lemma-mode-btn');
    if (btn) btn.click();
    return;
  }
  const sec = sectionUnderCursor();
  if (sec != null) toggleSection(mode, sec, null);
});

const lemmaModeBtn = document.getElementById('lemma-mode-btn');
if (lemmaModeBtn) lemmaModeBtn.addEventListener('click', async () => {
  lemmaMode = !lemmaMode;
  lemmaModeBtn.classList.toggle('is-on', lemmaMode);
  // The two modes both take the reading over, so only one at a time.
  if (lemmaMode && positionMode) {
    positionMode = false;
    const pb = document.getElementById('position-mode-btn');
    if (pb) pb.classList.remove('is-on');
  }
  if (lemmaMode) {
    lemmaModeBtn.disabled = true;
    try {
      await Lemmatizer.load();
      // The sign table too, though not at the cost of the mode: it is what
      // lets GU₄.U₄ find the entry eBL keyed as GU₄.UD, and KI.LAM find GANBA.
      try { await ensureAtfConverter(); } catch (_) { /* readings stay literal */ }
      // Everything the dictionary can place, filled in at once and marked as
      // its suggestion. Reading through and confirming is quicker than
      // choosing from nothing, and the colours say which is which.
      const done = prefillLemmas();
      if (done.filled) await saveScoreDataToFile();
      // Suggestions made before the dictionary learned something stay wrong
      // until they are re-asked: prefill will not overwrite them.
      const stale = refreshSuggestions(null, false).length;
      if (stale) {
        setTimeout(() => offerRefreshSuggestions(null), 400);
      }
      const c = lemmaCount();
      setStatus('connected', done.filled
        ? done.filled + ' suggested, ' + c.hand + ' confirmed'
          + (done.blank ? ', ' + done.blank + ' the dictionary could not place' : '')
        : c.total + ' lemmas, ' + c.hand + ' confirmed');
      setTimeout(() => setStatus('connected', 'Ready'), 6000);
    } catch (err) {
      lemmaMode = false;
      lemmaModeBtn.classList.remove('is-on');
      showComposeReport('Lemmas', [noteBlock('The dictionary did not load: '
        + (err && err.message || err), 'bad')]);
    }
    lemmaModeBtn.disabled = false;
  }
  keepScoreInView(renderScore);
});

const positionModeBtn = document.getElementById('position-mode-btn');
if (positionModeBtn) positionModeBtn.addEventListener('click', async () => {
  positionMode = !positionMode;
  positionModeBtn.classList.toggle('is-on', positionMode);
  if (positionMode && lemmaMode) {
    lemmaMode = false;
    if (lemmaModeBtn) lemmaModeBtn.classList.remove('is-on');
  }
  // Sign codes are what makes {iti}BAR₂ and {iti}BARA₂ one word rather than
  // two. Fetch the table on the way in so the first render already judges
  // properly instead of flagging spelling as difference.
  if (positionMode && !parallelsState.converter) {
    positionModeBtn.disabled = true;
    try { await ensureAtfConverter(); } catch (_) { /* fall back to text comparison */ }
    positionModeBtn.disabled = false;
  }
  keepScoreInView(renderScore);
});

// ---- Position mode -------------------------------------------------------
//
// The score, shown as the alignment it already is. Each word of a reading gets
// a position; each witness word gets a box you type that position into. The
// colour is the position, so a witness word takes the colour of whatever it is
// answering to and a mistake is visible without reading a single number.
//
// From the pairings everything else follows, and none of it is stored:
//   a position no witness word points at, witness intact   -> omitted
//   a position no witness word points at, witness broken    -> missing, no claim
//   a witness word pointing nowhere                         -> extra
//   a pairing whose two words differ                        -> variant material

// Words as eBL counts them: dividers occupy the line but are not Words, so
// they take no position and never shift the numbering omittedWords uses.
const DIVIDER = /^[:;]$/;
// The reading, numbered the way eBL numbers it.
//
// eBL's alignment index counts EVERY token of the reconstruction, dividers
// included. In EAE 55 §38 the witness aligns to 7, which is I₃.GAL₂ — token 7,
// but only word 6, because the ":" at 5 takes a number of its own. Numbering
// words alone puts every position after a divider one short, and those numbers
// are what goes to eBL.
function positionWords(text) {
  const out = [];
  let pos = 0;
  for (const tok of String(text || '').trim().split(/\s+/).filter(Boolean)) {
    out.push({ text: tok, pos: pos++, divider: DIVIDER.test(tok) });
  }
  return out;
}

// A hue per position, walked by a large step so neighbours never look alike.
// Lightness differs by theme so the text stays readable on either ground.
function positionColor(pos) {
  const hue = (pos * 137.508) % 360;
  const dark = document.body.classList.contains('dark-mode');
  return {
    fg: `hsl(${hue}, ${dark ? '70%, 72%' : '65%, 32%'})`,
    bg: `hsl(${hue}, ${dark ? '55%, 22%' : '75%, 92%'})`,
  };
}

// Repaint one word to the colour of the position it now answers to. In place,
// because the alternative is re-rendering the panel out from under the caret.
function paintPositionWord(input) {
  const word = input.closest ? input.closest('.pos-word') : null;
  if (!word) return;
  const raw = input.value.trim();
  if (raw === '') { word.style.color = ''; word.style.background = ''; return; }
  const c = positionColor(parseInt(raw, 10));
  word.style.color = c.fg;
  word.style.background = c.bg;
}

// A run of positions as a range. "lost 0,1,2,3,4,5,6,7" says nothing the eye
// can take in; "lost 0–7" does.
function positionRun(list) {
  const ns = [...new Set(list)].sort((a, b) => a - b);
  const out = [];
  let i = 0;
  while (i < ns.length) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    out.push(j - i >= 2 ? ns[i] + '–' + ns[j] : ns.slice(i, j + 1).join(','));
    i = j + 1;
  }
  return out.join(',');
}

// Recount one witness after one of its boxes changed.
//
// The tally belongs to the omen, and on a witness spread over several lines
// it is written under the last of them — so a box edited on the first line
// has to reach across to it.
function refreshPositionTally(input) {
  const line = input.closest ? input.closest('.score-line') : null;
  if (!line) return;

  const lineNum = input.dataset.line;
  const key = input.dataset.key;
  const vi = Number(input.dataset.variant || 0);
  const siglum = String(key).split('|')[0];
  const { scoreLines } = buildScore();
  const rows = omenRowsOf(lineNum, vi, siglum, scoreLines);
  const reading = variantsFor(lineNum)[vi];
  if (!rows.length || !reading) return;

  const group = lineNum + '|' + vi + '|' + siglum;
  let out = null;
  line.querySelectorAll('.pos-tally').forEach((el) => {
    if (el.dataset.group === group && !el.classList.contains('is-continues')) out = el;
  });
  if (!out) return;

  const tally = alignmentTally(lineNum, rows, positionWords(reading.text));
  // Worded exactly as the full render words it, or the label changes meaning
  // the moment a box is edited.
  const bits = [];
  if (tally.omitted.length) bits.push('omits ' + positionRun(tally.omitted));
  if (tally.illegible.length) bits.push('lost ' + positionRun(tally.illegible));
  if (tally.differing.length) bits.push('reads otherwise at ' + positionRun(tally.differing));
  if (tally.duplicated.length) bits.push('two words at ' + tally.duplicated.join(','));
  if (tally.extra) bits.push(tally.extra + ' unplaced');
  out.textContent = bits.length ? bits.join(' · ') : '✓';
}

// A witness line split the way the compositor splits it. Commentary
// protocols and column separators are shown but never numbered: they are
// not words, and numbering them shifts every real word after them out of
// step with the alignment the compositor wrote.
function witnessWords(content) {
  if (!window.Compositor || !Compositor.classify) {
    return String(content || '').trim().split(/\s+/).filter(Boolean)
      .map((text, index) => ({ text, role: 'text', index }));
  }
  const convert = positionConverter();
  let idx = 0;
  return Compositor.classify(content).map((t) => {
    // Only text is numbered. A marker and a gloss are on the tablet but are
    // not the text; and a word with no sign content at all — "[...]", a bare
    // x — is a placeholder for what was lost, which can answer to no position
    // and must not consume one.
    // Numbered to match eBL's alignable tokens: a marker, a gloss, a break and
    // a divider are none of them alignable, so none of them takes an index.
    let role = t.role;
    if (role === 'text' && Compositor.isDivider(t.text)) role = 'divider';
    else if (role === 'text' && convert && !Compositor.isLegible(t.text, convert)) role = 'break';
    return { text: t.text, role, index: role === 'text' ? idx++ : null };
  });
}

// The sign converter, once it exists. Position mode fetches it when it is
// switched on; until then the tally falls back to comparing transliterations,
// which is stricter than it should be but never wrong in the other direction.
function positionConverter() {
  const c = (typeof parallelsState === 'object' && parallelsState) ? parallelsState.converter : null;
  if (!c) return null;
  return (text) => { try { return c.convertLine(text).codes; } catch (_) { return []; } };
}

function alignmentFor(lineNum, siglum) {
  if (!lineAlignments[lineNum]) lineAlignments[lineNum] = {};
  if (!lineAlignments[lineNum][siglum]) lineAlignments[lineNum][siglum] = {};
  return lineAlignments[lineNum][siglum];
}

// One witness row in position mode: every word with the box that says where it
// belongs. The key is the witness's own line number, so two lines of the same
// manuscript under one section do not share an alignment.
function renderPositionWitness(lineNum, vi, w) {
  const key = w.siglum + '|' + w.sourceLine;
  const map = alignmentFor(lineNum, key);
  let html = '';
  witnessWords(w.content).forEach((tok) => {
    const word = tok.text;
    const i = tok.index;
    if (i == null) {
      const cls = tok.role === 'commentary' ? 'is-commentary'
        : tok.role === 'break' ? 'is-break' : 'is-meta';
      const why = tok.role === 'commentary' ? 'Commentary, not the text'
        : tok.role === 'break' ? 'Lost to damage — answers to no position'
        : 'Not part of the text';
      html += `<span class="pos-word ${cls}" title="${why}">` +
        `<span class="pos-word-text">${escapeHtml(word)}</span></span>`;
      return;
    }
    const at = map[i];
    const style = at == null ? '' : (() => {
      const c = positionColor(at);
      return ` style="color:${c.fg};background:${c.bg}"`;
    })();
    html += `<span class="pos-word"${style}>` +
      `<span class="pos-word-text">${renderAtf(word)}</span>` +
      `<input class="pos-input" type="text" inputmode="numeric" ` +
      `data-line="${lineNum}" data-key="${escapeHtml(key)}" data-index="${i}" ` +
      `data-variant="${vi}" ` +
      `value="${at == null ? '' : at}" title="Position in the reading above; blank = answers to nothing">` +
      `</span>`;
  });
  return html;
}

// A witness's lines under one reading, in the order the tablet has them.
//
// A tablet that needs three lines for one omen is still one witness. Judged a
// line at a time, K.6121 o 42' reported "lost 7–35" — but the omen it opens
// only finishes on o 46', and the line is not missing those words, it has not
// reached them yet. So the tally, and every count the position card shows,
// counts omens rather than the lines they happen to run over.
function sourceLineOrder(a, b) {
  const n = (x) => parseInt(String(x).replace(/[^0-9]/g, ''), 10);
  const na = n(a.sourceLine), nb = n(b.sourceLine);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a.sourceLine).localeCompare(String(b.sourceLine), undefined, { numeric: true });
}

// The witnesses of one reading, each with all the lines it gives to it:
// [{ siglum, rows }], in the order the score has them.
function omensOf(lineNum, vi, scoreLines) {
  const all = ((scoreLines || buildScore().scoreLines)[lineNum] || [])
    .filter((x) => x.type === 'line' && (x.variant || 0) === vi);
  const by = new Map();
  for (const w of all) {
    if (!by.has(w.siglum)) by.set(w.siglum, []);
    by.get(w.siglum).push(w);
  }
  return [...by.entries()].map(([siglum, rows]) =>
    ({ siglum, rows: rows.slice().sort(sourceLineOrder) }));
}

function omenRowsOf(lineNum, vi, siglum, scoreLines) {
  const hit = omensOf(lineNum, vi, scoreLines).find((o) => o.siglum === siglum);
  return hit ? hit.rows : [];
}

// What the pairings add up to for one witness — one row, or every row of the
// omen when the tablet spreads it over several lines.
//
// This judges the same way the compositor does, and for the same reasons:
//   - words are compared as signs, so {iti}BAR₂ and {iti}BARA₂ are one word
//     and IGI against IGI-ir is a complement, not a difference;
//   - a witness only omits a position inside the stretch it actually
//     preserves — a tablet broken to "[...]" claims nothing at all;
//   - dividers, protocol markers and commentary are not words and take no
//     position, so they are never counted as unplaced.
function alignmentTally(lineNum, rows, readingWords) {
  // One stream over the whole omen. Each token carries the position its own
  // line's alignment gives it, so lines joined here keep their own numbering
  // and a break at the end of one line no longer swallows everything the next
  // line goes on to say.
  const list = Array.isArray(rows) ? rows : [rows];
  const stream = [];
  for (const row of list) {
    const map = alignmentFor(lineNum, row.siglum + '|' + row.sourceLine);
    for (const tok of witnessWords(row.content)) {
      stream.push({
        text: tok.text,
        role: tok.role,
        index: tok.index,
        at: tok.index == null || map[tok.index] == null ? null : Number(map[tok.index]),
      });
    }
  }
  const words = stream.filter((t) => t.index != null);
  const convert = positionConverter();
  const C = window.Compositor;

  const legible = (text) => (convert && C ? C.isLegible(text, convert) : true);
  const divider = (text) => (C ? C.isDivider(text) : /^[:;]$/.test(text));

  const taken = new Map();
  const duplicated = [];
  let extra = 0;
  for (const tok of words) {
    const at = tok.at;
    // A divider answers to no position, so leaving it unpaired is not a gap
    // in the alignment and must not be reported as one.
    if (at == null) { if (!divider(tok.text) && legible(tok.text)) extra++; continue; }
    if (taken.has(at) && duplicated.indexOf(at) < 0) duplicated.push(at);
    taken.set(at, tok.text);
  }

  // Which reading positions the tablet cannot answer for.
  //
  // A word missing between two placed words is only an omission if the tablet
  // runs straight from the one to the other. Where traces stand in between — an
  // x, a bracketed loss — the word is not absent, it is unreadable, and saying
  // "omitted" asserts something about the scribe that the tablet does not
  // support. eBL stores that assertion in omittedWords, so it matters.
  //
  // The ends count too. A line opening "[..." says the start is broken away, so
  // every position before its first word is lost rather than merely unspoken —
  // silence at the edge is only uninformative when nothing marks it.
  const lost = new Set();
  {
    let first = null;
    let last = null;
    let brokenBefore = false;
    let broken = false;
    for (const tok of stream) {
      if (tok.role === 'break') {
        broken = true;
        if (first === null) brokenBefore = true;
        continue;
      }
      if (tok.index == null) continue;
      const at = tok.at;
      if (at == null) continue;
      if (last != null && broken) {
        for (let p = Math.min(last, at) + 1; p < Math.max(last, at); p++) lost.add(p);
      }
      if (first === null) first = at;
      last = at;
      broken = false;
    }
    if (brokenBefore && first != null) {
      for (const rw of readingWords) {
        if (rw.pos != null && rw.pos < first) lost.add(rw.pos);
      }
    }
    // `broken` still set means a break stood after the last placed word.
    if (broken && last != null) {
      for (const rw of readingWords) {
        if (rw.pos != null && rw.pos > last) lost.add(rw.pos);
      }
    }
  }

  // The stretch this witness speaks to. Outside it, silence is damage.
  const held = [...taken.keys()];
  const lo = held.length ? Math.min.apply(null, held) : null;
  const hi = held.length ? Math.max.apply(null, held) : null;

  const omitted = [], differing = [], illegible = [];
  for (const rw of readingWords) {
    if (rw.pos == null) continue;
    // An x, an (x), a [...] in the reading itself is a placeholder for what
    // could not be read, not a word. It keeps its number — eBL counts these as
    // reconstruction tokens, so dropping them would shift every index after it
    // out of step with eBL — but no witness can be said to omit it, lose it, or
    // read it otherwise. There is nothing there to have an opinion about.
    if (!legible(rw.text)) continue;
    if (!taken.has(rw.pos)) {
      if (rw.divider) continue;
      // A break accounts for this position wherever it falls, inside the
      // stretch the witness covers or beyond either end of it.
      if (lost.has(rw.pos)) { illegible.push(rw.pos); continue; }
      // An omission is a claim about the scribe, so it is only made where the
      // witness is demonstrably present on both sides of the gap.
      if (lo != null && rw.pos > lo && rw.pos < hi) omitted.push(rw.pos);
      continue;
    }
    const verdict = convert && C
      ? C.compareWords(rw.text, taken.get(rw.pos), convert)
      : (taken.get(rw.pos).replace(/[#?!*\[\]⸢⸣]/g, '') === rw.text.replace(/[#?!*\[\]⸢⸣]/g, '')
          ? 'same' : 'different');
    if (verdict === 'different') differing.push(rw.pos);
  }
  return { omitted, differing, illegible, duplicated, extra, paired: taken.size };
}

// ---- Seeing one position across the witnesses -----------------------------
//
// The colour already says which column a word belongs to; the relief says it
// louder, and only for the word under the mouse. Hovering a witness word
// lifts the reading word it answers to, and hovering a reading word lifts
// every witness word answering to it.
//
// Clicking a reading word holds that light and counts it: how many witness
// lines have a word at this position, and how many have one twice — 5/2 —
// with the lines named. That is the number an editor weighs when deciding
// whether a word belongs in the reconstruction or is one witness's variant.

let reliefLit = [];
function clearRelief() {
  for (const el of reliefLit) { if (el.isConnected) el.classList.remove('is-relief'); }
  reliefLit = [];
}
function lightRelief(els) {
  clearRelief();
  for (const el of els) { el.classList.add('is-relief'); reliefLit.push(el); }
}

// The reading word a witness word answers to, from the box it carries.
function reliefFromWitness(wordEl) {
  const input = wordEl.querySelector('.pos-input');
  if (!input || input.value.trim() === '') return [];
  const at = String(parseInt(input.value, 10));
  const line = wordEl.closest('.score-line');
  if (!line) return [];
  const vi = input.dataset.variant || '0';
  const recon = line.querySelector(`.reconstructed-text.is-positions[data-variant="${vi}"]`);
  const card = recon ? recon.querySelector(`.pos-word[data-pos="${at}"]`) : null;
  return card ? [card] : [];
}

// Every witness word answering to a reading word. Read from the boxes, not
// from the stored alignment, so a number just typed lights up before it is
// even committed.
function reliefFromCard(card) {
  const recon = card.closest('.reconstructed-text.is-positions');
  const line = card.closest('.score-line');
  if (!recon || !line) return [];
  const vi = recon.dataset.variant || '0';
  const at = card.dataset.pos;
  const out = [];
  line.querySelectorAll('.witness-text.is-positions .pos-input').forEach((inp) => {
    if ((inp.dataset.variant || '0') !== vi) return;
    if (String(parseInt(inp.value, 10)) !== at) return;
    const word = inp.closest('.pos-word');
    if (word) out.push(word);
  });
  return out;
}

document.addEventListener('mouseover', (e) => {
  if (!e.target || !e.target.closest) return;
  const witnessWord = e.target.closest('.witness-text.is-positions .pos-word');
  if (witnessWord) { lightRelief(reliefFromWitness(witnessWord)); return; }
  const card = e.target.closest('.reconstructed-text.is-positions .pos-word[data-pos]');
  if (card) { lightRelief(reliefFromCard(card)); return; }
  if (reliefLit.length) clearRelief();
});

// What the witnesses say about one position, omen by omen. `used` is every
// witness with a word there (a differing word included — it attests the
// slot); the rest sort the silence: an omission is a claim, a break is not.
//
// Counted per omen, not per line. A tablet giving one omen five lines is one
// witness with one opinion about a word, and counting its lines instead made
// the denominator the number of rows on screen — "5 of 17" where the honest
// answer is "5 of 6".
function positionUsage(lineNum, vi, pos) {
  const { scoreLines } = buildScore();
  const omens = omensOf(lineNum, vi, scoreLines);
  const reading = variantsFor(lineNum)[vi];
  const words = reading ? positionWords(reading.text || '') : [];
  const u = { omens: omens.length, used: [], twice: [], otherwise: [],
    omits: [], lost: [], silent: [] };
  for (const om of omens) {
    // How many words this witness puts here, over all the lines it gives the
    // omen — a commentary quoting the lemma and then quoting it again is the
    // case worth seeing.
    let n = 0;
    for (const row of om.rows) {
      const map = (lineAlignments[lineNum] || {})[row.siglum + '|' + row.sourceLine] || {};
      for (const k of Object.keys(map)) if (Number(map[k]) === pos) n++;
    }
    const label = displaySiglum(om.siglum);
    const tally = alignmentTally(lineNum, om.rows, words);
    if (n) {
      u.used.push(label + (n > 1 ? ' ×' + n : ''));
      if (n > 1) u.twice.push(label);
      if (tally.differing.indexOf(pos) >= 0) u.otherwise.push(label);
    } else if (tally.omitted.indexOf(pos) >= 0) u.omits.push(label);
    else if (tally.illegible.indexOf(pos) >= 0) u.lost.push(label);
    else u.silent.push(label);
  }
  return u;
}

let usagePop = null;
let usagePopKey = '';
function closeUsagePop() {
  if (usagePop) { usagePop.remove(); usagePop = null; }
  usagePopKey = '';
  document.querySelectorAll('.pos-word.is-held').forEach((el) => el.classList.remove('is-held'));
}

// The reading's card for one position, wherever the question was asked from.
function cardForPosition(anchor, vi, pos) {
  const line = anchor.closest('.score-line');
  if (!line) return null;
  const recon = line.querySelector(`.reconstructed-text.is-positions[data-variant="${vi}"]`);
  return recon ? recon.querySelector(`.pos-word[data-pos="${pos}"]`) : null;
}

function showUsagePop(anchor, lineNum, vi, pos) {
  closeUsagePop();
  const u = positionUsage(lineNum, vi, pos);
  const card = cardForPosition(anchor, vi, pos);
  const wordEl = card && card.querySelector('.pos-word-text');
  const word = wordEl ? wordEl.textContent : '';

  const row = (name, list) => (list.length
    ? `<div class="pop-row"><span class="pop-k">${name}</span>`
      + `<span class="pop-v">${escapeHtml(list.join(', '))}</span></div>`
    : '');
  const pop = document.createElement('div');
  pop.className = 'pos-usage-pop';
  // Attested out of witnesses, because that is the ratio the decision turns
  // on. Quoting twice is a different fact and is reported as one, rather than
  // as a second number that reads like a denominator — "5/0" said nothing.
  pop.innerHTML =
    `<div class="pop-head"><b>${escapeHtml(word)}</b><span class="pop-pos">position ${pos}</span></div>`
    + `<div class="pop-big">${u.used.length}/${u.omens}</div>`
    + `<div class="pop-say">${u.used.length} of ${u.omens} witness${u.omens === 1 ? '' : 'es'}`
    + ` ${u.used.length === 1 ? 'has' : 'have'} a word here`
    + (u.twice.length ? ` — ${u.twice.length} of them twice` : '') + `</div>`
    + row('have it', u.used)
    + row('read otherwise', u.otherwise)
    + row('omit it', u.omits)
    + row('lost', u.lost)
    + row('no claim', u.silent);
  document.body.appendChild(pop);

  // Under whatever was clicked, kept on screen. Fixed, so it survives
  // nothing — any scroll closes it rather than letting it drift off its word.
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + 'px';
  pop.style.top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8) + 'px';

  usagePop = pop;
  usagePopKey = lineNum + '|' + vi + '|' + pos;
  if (card) {
    card.classList.add('is-held');
    for (const el of reliefFromCard(card)) el.classList.add('is-held');
  }
  window.addEventListener('scroll', closeUsagePop, { capture: true, once: true });
}

document.addEventListener('click', (e) => {
  if (!e.target || !e.target.closest) return;
  if (usagePop && usagePop.contains(e.target)) return;
  // The box is for typing a position, not for asking about one.
  if (e.target.closest('.pos-input')) return;

  const card = e.target.closest('.reconstructed-text.is-positions .pos-word[data-pos]');
  // A witness word answers for the same position, so asking there asks the
  // same question — the word in hand is usually the one being weighed.
  const witnessWord = card ? null : e.target.closest('.witness-text.is-positions .pos-word');

  let anchor = null, lineNum = null, vi = 0, pos = null;
  if (card) {
    const recon = card.closest('.reconstructed-text.is-positions');
    anchor = card;
    lineNum = parseInt(recon.dataset.line, 10);
    vi = Number(recon.dataset.variant || 0);
    pos = parseInt(card.dataset.pos, 10);
  } else if (witnessWord) {
    const input = witnessWord.querySelector('.pos-input');
    if (!input || input.value.trim() === '') return;   // answers to nothing
    anchor = witnessWord;
    lineNum = parseInt(input.dataset.line, 10);
    vi = Number(input.dataset.variant || 0);
    pos = parseInt(input.value, 10);
  }
  if (anchor == null || !Number.isFinite(pos)) { if (usagePop) closeUsagePop(); return; }

  const key = lineNum + '|' + vi + '|' + pos;
  if (usagePopKey === key) { closeUsagePop(); return; }   // asked again: put it away
  showUsagePop(anchor, lineNum, vi, pos);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && usagePop) closeUsagePop();
});

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
      lastEntry = null;   // a "//" just after a surface change belongs to nothing
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

    // A note on the witness above: "#note: ...". eBL's manuscript_line takes
    // paratext after the reading —
    //   manuscript_line: ... manuscript_text paratext_line*
    //   paratext:        note_line | dollar_line
    // — so the note belongs to that one reading, not to the chapter line, and
    // more than one is allowed. Attaches the way "//" does: to the entry above.
    // Without this branch the line fell through to the unknown-line case below,
    // which dropped it AND broke the adjacency chain for whatever followed.
    const noteMatch = trimmed.match(/^#note:s*(.*)$/);
    if (noteMatch) {
      if (lastEntry && lastEntry.type !== 'ruling' && lastEntry.type !== 'comment') {
        if (!lastEntry.notes) lastEntry.notes = [];
        lastEntry.notes.push(noteMatch[1].trim());
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
        continuation: [],
        notes: []
      };
      entries.push(entry);
      lastEntry = entry;
      continue;
    }

    // Also support old format: §[target] [source]. with non-numeric source
    const oldMatch = trimmed.match(/^§(\d+)([a-z]?)\s+([^.]+)\.\s*(.*)$/);
    if (!oldMatch && trimmed) {
      // A line the parser does not know — most often a transliteration line
      // with no § assignment yet. Whatever hangs under it ("//" parallels,
      // continuations) belongs to it, not to the last assigned entry above,
      // so the adjacency chain is broken here. Blank lines stay neutral.
      lastEntry = null;
      continue;
    }
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
        continuation: [],
        notes: []
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

  // A ruling sits under the line it follows, so it belongs to the reading its
  // manuscript's lines belong to. Where a witness was moved to a variant before
  // its directives followed, the marker was left behind in the old reading —
  // §18 kept AO.6450's ruling while AO.6450 itself had gone to §18b. Read it
  // where the lines are rather than where the file happens to say.
  //
  // Only when the manuscript has readings in exactly one reading of the
  // section: with lines in two, which one the ruling follows is a real
  // question and not one to answer by guessing.
  for (const n of Object.keys(scoreLines)) {
    const here = scoreLines[n];
    const readingsBy = new Map();
    for (const e of here) {
      if (e.type !== 'line') continue;
      if (!readingsBy.has(e.siglum)) readingsBy.set(e.siglum, new Set());
      readingsBy.get(e.siglum).add(e.variant || 0);
    }
    for (const e of here) {
      if (e.type === 'line') continue;
      const seen = readingsBy.get(e.siglum);
      if (!seen || seen.size !== 1) continue;
      const only = [...seen][0];
      if ((e.variant || 0) !== only) e.variant = only;
    }
  }

  for (const n of Object.keys(scoreLines)) scoreLines[n].sort(scoreEntryOrder);

  return { scoreLines, rulings, comments };
}

// Render the score panel
function renderScore() {
  const { scoreLines } = buildScore();
  const sortedLineNumbers = Object.keys(scoreLines).map(Number).sort((a, b) => a - b);
  // The sidebar counts follow the score, so they are refreshed with it rather
  // than being computed again from the files.
  refreshManuscriptBadges();

  if (sortedLineNumbers.length === 0) {
    scorePanel.innerHTML = '<div class="score-empty">No scored lines yet. Use §[line] [source]. to add lines.</div>';
    return;
  }

  let html = '';
  for (const lineNum of sortedLineNumbers) {
    const witnesses = scoreLines[lineNum];

    const translation = translationLines[lineNum] || '';

    // A section being worked on measures its witnesses against the reading, so
    // the reading has to stay in sight while they are read. Marked here so the
    // stylesheet can keep it there.
    const working = (positionsOn(lineNum) || lemmasOn(lineNum)) ? ' is-working' : '';
    html += `<div class="score-line${working}" data-line="${lineNum}">`;
    // Translation line — it belongs to the chapter line, so it stays above
    // every reading rather than under one of them.
    html += `<div class="translation-line"><span class="translation-text" contenteditable="true" data-line="${lineNum}">${escapeHtml(translation)}</span></div>`;

    // One block per reading: the reading itself, its note and parallels, then
    // the witnesses that attest it (those whose § marker carries its letter).
    const readings = variantsFor(lineNum);
    for (let vi = 0; vi < readings.length; vi++) {
      const reading = readings[vi];
      const letter = variantLetterOf(vi);

      // The state of the send is worn by the line itself: blue for never sent,
      // green for sent and unchanged, amber for sent and edited since. Only the
      // first reading carries it — a variant is part of the same chapter line
      // and goes with it.
      const sentClass = vi ? '' : ' sent-' + sentState(lineNum);
      html += `<div class="score-line-header${vi ? ' is-variant' : ''}${sentClass}">`;
      html += `<span class="line-label">§ ${lineNum}${letter}</span> `;

      if (lemmasOn(lineNum)) {
        // Same ruler as Positions, read the same way, but each word shows the
        // lemma it carries and how sure that is. Clicking one opens a dropdown
        // in place — there is no dialog, so a whole line can be worked through
        // without the reading ever leaving the screen.
        const daggersHere = daggerPositions(lineNum, vi, reading);
      html += `<span class="reconstructed-text is-lemmas">` + positionWords(reading.text).map((t) => {
          if (t.divider) return `<span class="lem-word is-divider">${escapeHtml(t.text)}</span>`;
          const state = lemmaState(lineNum, vi, t.pos, t.text);
          const ids = lemmasAt(lineNum, vi, t.pos);
          const dag = daggersHere.has(t.pos)
            ? `<span class="pos-dagger" title="${escapeHtml(daggersHere.get(t.pos).join('; '))}">‡</span>`
            : '';
          const label = ids.length ? ids.join(' + ') : (state === 'skip' ? '' : 'no lemma');
          return `<span class="lem-word is-${state}"`
            + ` data-line="${lineNum}" data-variant="${vi}" data-pos="${t.pos}"`
            + ` tabindex="${state === 'skip' ? -1 : 0}"`
            + ` title="${escapeHtml(lemmaTitle(state, ids))}">`
            + `<span class="lem-word-text">${dag}${renderAtf(t.text)}</span>`
            + `<span class="lem-id">${escapeHtml(label)}</span></span>`;
        }).join('') + `</span>`;
      } else if (positionsOn(lineNum)) {
        // Not editable here: in this mode the reading is the ruler the
        // witnesses are measured against, and it should not move under them.
        const rw = positionWords(reading.text);
        const marksHere = daggerPositions(lineNum, vi, reading);
        html += `<span class="reconstructed-text is-positions" data-line="${lineNum}" data-variant="${vi}">` + rw.map((t) => {
          if (t.divider) return `<span class="pos-word is-divider">${escapeHtml(t.text)}`
            + `<span class="pos-num">${t.pos}</span></span>`;
          // Numbered, because eBL numbers it, but shown as the placeholder it is.
          if (window.Compositor && !Compositor.isLegible(t.text, positionConverter() || (() => []))) {
            return `<span class="pos-word is-placeholder">${escapeHtml(t.text)}`
              + `<span class="pos-num">${t.pos}</span></span>`;
          }
          const c = positionColor(t.pos);
          const dag = marksHere.has(t.pos)
            ? `<span class="pos-dagger" title="${escapeHtml(marksHere.get(t.pos).join('; '))}">‡</span>`
            : '';
          return `<span class="pos-word" data-pos="${t.pos}" style="color:${c.fg};background:${c.bg}"`
            + ` title="Click: which witnesses have a word at position ${t.pos}">` + dag +
            `<span class="pos-word-text">${renderAtf(t.text)}</span>` +
            `<span class="pos-num">${t.pos}</span></span>`;
        }).join('') + `</span>`;
      } else {
        html += `<span class="reconstructed-text" contenteditable="true" data-line="${lineNum}" data-variant="${vi}">${renderAtf(reading.text)}</span>`;
        // The ‡ eBL will print, alongside the reading rather than inside it —
        // the reading is contenteditable and a marker put in there would be
        // typed over, and would end up in the text that goes to eBL.

      }
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
      // The per-omen toggles live with the other things you do to a line —
      // send it, add to it — rather than beside its number. The group wraps,
      // so a narrow pane stacks them instead of pushing the reading out.
      if (vi === 0) {
        html += `<span class="line-tools">`;
        const posOn = positionSections.has(lineNum);
        const lemOn = lemmaSections.has(lineNum);
        const sent = sentState(lineNum);
        html += `<button type="button" class="line-sent is-${sent}" data-line="${lineNum}"`
          + ` title="${escapeHtml(sentTitle(lineNum))}">`
          + (sent === 'never' ? '·' : '✓') + `</button>`;
        // The human counterpart of the send mark: a pencil for "an editor has
        // read this through", worked and worn exactly the same way.
        const revised = revisedState(lineNum);
        html += `<button type="button" class="line-revised is-${revised}" data-line="${lineNum}"`
          + ` title="${escapeHtml(revisedTitle(lineNum))}">`
          + (revised === 'never' ? '·' : '✎') + `</button>`;
        // And what the last send left broken, if anything: ✖ when nothing went
        // through, ⚠ when parts did. Clicking opens the report that says what
        // to repair on eBL by hand; the sign clears when that report is ticked.
        const issue = issueState(lineNum);
        if (issue) {
          const openHere = openIssuesFor(lineNum).length;
          html += `<button type="button" class="line-issue is-${issue}" data-line="${lineNum}"`
            + ` title="${issue === 'error'
              ? 'A send of this section failed — nothing went through.'
              : 'A send of this section went only partly through.'}`
            + ` ${openHere} open report${openHere === 1 ? '' : 's'} — click to see what to fix on eBL by hand.">`
            + (issue === 'error' ? '✖' : '⚠') + `</button>`;
        }
        // The four actions wrap as a block of their own, so they break 2 and 2
        // rather than dragging the mark into the arithmetic.
        html += `<span class="line-actions">`;
        html += `<button type="button" class="line-mode-btn${posOn ? ' is-on' : ''}"`
          + ` data-line="${lineNum}" data-mode="positions"`
          + ` title="${posOn ? 'Stop showing' : 'Show'} § ${lineNum} as numbered positions (Alt+P)">#</button>`;
        html += `<button type="button" class="line-mode-btn${lemOn ? ' is-on' : ''}"`
          + ` data-line="${lineNum}" data-mode="lemmas"`
          + ` title="${lemOn ? 'Stop showing' : 'Show'} the lemmas of § ${lineNum} (Alt+L).`
          + ` Shift-click to fill in the suggestions from § ${lineNum} to the end.">L</button>`;
        html += `<button class="omen-export" data-line="${lineNum}" ` +
                `title="Validate §${lineNum} and send it to eBL">⇗</button>`;
      } else {
        // A variant row has only its own "+", but it still gets the group so
        // the button sits in the same column as the ones above it.
        html += `<span class="line-tools"><span class="line-actions">`;
      }
      html += `<span class="recon-add-wrap">`;
      html += `<button class="recon-add" data-line="${lineNum}" data-variant="${vi}" title="Add a note, a parallel or a variant">+</button>`;
      html += `<span class="recon-add-menu hidden">`;
      html += `<button class="recon-add-item" data-kind="note" data-line="${lineNum}" data-variant="${vi}"${reading.note != null ? ' disabled' : ''}>Note<em>#note:</em></button>`;
      html += `<button class="recon-add-item" data-kind="parallel" data-line="${lineNum}" data-variant="${vi}">Parallel<em>//</em></button>`;
      html += `<button class="recon-add-item" data-kind="compose" data-line="${lineNum}" data-variant="${vi}">Compose from witnesses<em>↻</em></button>`;
      html += `<button class="recon-add-item" data-kind="compose-from" data-line="${lineNum}" data-variant="${vi}">Compose from…<em>⌥</em></button>`;
      html += `<button class="recon-add-item" data-kind="report" data-line="${lineNum}" data-variant="${vi}">Report on this reading<em>≡</em></button>`;
      html += `<button class="recon-add-item" data-kind="variant" data-line="${lineNum}" data-variant="${vi}">Variant<em>§${lineNum}${variantLetterOf(readings.length)}</em></button>`;
      if (vi > 0) {
        html += `<button class="recon-add-item danger" data-kind="drop-variant" data-line="${lineNum}" data-variant="${vi}">Delete this variant<em>✕</em></button>`;
      }
      html += `</span></span>`;
      html += `</span>`;   // line-actions
      html += `</span>`;   // line-tools
      html += `</div>`;
      // After the header, not inside it. The header is a flex row, so a strip
      // put in there becomes a column beside the reading and squeezes it —
      // which is the opposite of standing the lemma under its word.
      if (!lemmasOn(lineNum) && !positionsOn(lineNum)) {
        html += lemmaStrip(lineNum, vi, reading);
      }

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

      // A witness's lines belong together — reading, continuations, its
      // rulings and parallels — so a dotted rule is drawn where the siglum
      // changes, never before the first block or after the last.
      let lastSiglum = null;
      // Which row closes each witness's omen here. The positions tally speaks
      // for the omen, so it is written under that row and nowhere else.
      const lastRowOf = new Map();
      for (const x of witnesses) {
        if (x.type === 'line' && (x.variant || 0) === vi) lastRowOf.set(x.siglum, x);
      }
      for (const w of witnesses.filter((x) => (x.variant || 0) === vi)) {
        if (lastSiglum !== null && w.siglum !== lastSiglum) {
          html += '<div class="witness-rule"></div>';
        }
        lastSiglum = w.siglum;
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
        html += `<span class="witness-siglum">${escapeHtml(ref)}`
          + witnessMoveControl(lineNum, vi, w, readings.length) + `</span>`;
        if (lemmasOn(lineNum)) {
          // A witness word takes its lemma from the reading word it aligns to,
          // so there is nothing to choose here and nothing to show but the text.
          html += `<span class="witness-text">${renderAtf(w.content)}</span>`;
        } else if (positionsOn(lineNum)) {
          html += `<span class="witness-text is-positions">${renderPositionWitness(lineNum, vi, w)}</span>`;
          // The verdict is the omen's, so it is written once, under the last
          // line of it. On the lines above it would be a claim about words
          // the tablet has simply not reached yet.
          const group = `${lineNum}|${vi}|${w.siglum}`;
          if (lastRowOf.get(w.siglum) === w) {
            const tally = alignmentTally(lineNum, omenRowsOf(lineNum, vi, w.siglum, scoreLines),
              positionWords(reading.text));
            const bits = [];
            if (tally.omitted.length) bits.push(`omits ${positionRun(tally.omitted)}`);
            if (tally.illegible.length) bits.push(`lost ${positionRun(tally.illegible)}`);
            if (tally.differing.length) bits.push(`reads otherwise at ${positionRun(tally.differing)}`);
            if (tally.duplicated.length) bits.push(`two words at ${tally.duplicated.join(',')}`);
            if (tally.extra) bits.push(`${tally.extra} unplaced`);
            html += `<span class="pos-tally" data-group="${escapeHtml(group)}">`
              + `${bits.length ? escapeHtml(bits.join(" · ")) : "✓"}</span>`;
          } else {
            html += `<span class="pos-tally is-continues" data-group="${escapeHtml(group)}"`
              + ` title="The omen goes on below — its verdict is under its last line">⋯</span>`;
          }
        } else {
          html += `<span class="witness-text">${renderAtf(w.content)}</span>`;
        }
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

        // Notes typed under this witness in its manuscript file. Shown with
        // the reading, not with the composite: they are remarks on what this
        // one tablet has.
        if (w.notes && w.notes.length > 0) {
          for (const note of w.notes) {
            html += `<div class="score-witness witness-note${typeClass(w.siglum)}">`;
            html += `<span class="witness-siglum"></span>`;
            html += `<span class="witness-text"><span class="witness-note-prefix">#note:</span> ${escapeHtml(note)}</span>`;
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
      if (!e.target.isConnected) return;   // a detached row speaks for a stale score
      const lineNum = e.target.dataset.line;
      translationLines[lineNum] = e.target.innerText;
      refreshSentMark(lineNum);
      markUnsaved();
    });
  });

  // Add event listeners for reconstructed text editing
  scorePanel.querySelectorAll('.reconstructed-text').forEach(el => {
    el.addEventListener('input', (e) => {
      if (!e.target.isConnected) return;   // same reason as blur, below
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
      // Re-rendering the score detaches this element, and the browser then
      // fires blur on the orphan. Writing its text back at that point undoes
      // whatever caused the re-render: composing a reading wrote the new text,
      // the score repainted, and this handler put the old text straight back
      // over it. A detached node speaks for a version of the score that no
      // longer exists, so it does not get to write.
      if (!e.target.isConnected) return;
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

  // Typing a position. The colour and the tally are repainted in place rather
  // than by re-rendering the score: a re-render replaces every input in the
  // panel, so the element Tab was moving to stops existing mid-keystroke and
  // the tab order is lost the moment a number is entered.
  scorePanel.querySelectorAll('.pos-input').forEach((el) => {
    const commit = () => {
      const map = alignmentFor(el.dataset.line, el.dataset.key);
      const raw = el.value.trim();
      if (raw === '') {
        delete map[el.dataset.index];
      } else {
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 0) { el.value = ''; delete map[el.dataset.index]; }
        else { map[el.dataset.index] = n; el.value = String(n); }
      }
      paintPositionWord(el);
      refreshPositionTally(el);
      refreshSentMark(el.dataset.line);
      markUnsaved();
      saveScoreDataToFile();
    };
    el.addEventListener('change', commit);
    // Enter commits and steps to the next box, so a row can be typed straight
    // through. Shift+Enter steps back.
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      commit();
      const boxes = [...scorePanel.querySelectorAll('.pos-input')];
      const next = boxes[boxes.indexOf(el) + (e.shiftKey ? -1 : 1)];
      if (next) { next.focus(); next.select(); }
      else el.blur();
    });
    el.addEventListener('focus', () => el.select());
  });

  // Send this omen to eBL: validate the section on its own, then post it.
  scorePanel.querySelectorAll('.omen-export').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportOmen(parseInt(btn.dataset.line, 10));
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
      if (btn.dataset.kind === 'report') {
        analyseReading(parseInt(lineNum, 10), vi);
      }
      else if (btn.dataset.kind === 'compose-from') {
        const n = parseInt(lineNum, 10);
        askScope(n, vi).then((scope) => { if (scope) composeOmen(n, vi, scope); });
      }
      else if (btn.dataset.kind === 'compose') {
        const n = parseInt(lineNum, 10);
        const had = (readReading(lineNum, vi) || '').trim();
        if (!had) { composeOmen(n, vi); return; }
        askOverlay('Replace §' + lineNum + variantLetterOf(vi) + '?', [
          noteBlock('A reading composed from the witnesses will take its place. This is'
            + ' what is there now:', 'warn'),
          readingBlock('§' + lineNum + variantLetterOf(vi), had, null),
        ], 'Compose', true).then((yes) => { if (yes) composeOmen(n, vi); });
      }
      else if (btn.dataset.kind === 'variant') openVariantDialog(lineNum, vi);
      else if (btn.dataset.kind === 'drop-variant') dropVariant(lineNum, vi);
      else addReconExtra(lineNum, vi, btn.dataset.kind);
    });
  });

  // Note and parallel rows. The "#note:" / "//" prefix is a chip owned by the
  // row rather than text to retype, so it cannot be mistyped or lost.
  scorePanel.querySelectorAll('.recon-extra-text').forEach(el => {
    el.addEventListener('input', (e) => {
      if (!e.target.isConnected) return;
      writeReconExtra(e.target, e.target.innerText);
      markUnsaved();
    });
    // Clearing a row and leaving it is how you delete it. Which makes the
    // detached case dangerous: a re-render orphans this row, the browser
    // fires blur on it, innerText reads empty, and the note is deleted by a
    // node that no longer belongs to the page.
    el.addEventListener('blur', (e) => {
      if (!e.target.isConnected) return;
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
// A word of a reading, clicked in Lemmas mode. Delegated, because the score
// is rebuilt whenever anything changes.
document.addEventListener('click', (e) => {
  const el = e.target && e.target.closest ? e.target.closest('.lem-word') : null;
  if (!el || el.classList.contains('is-divider')) return;
  if (!lemmasOn(parseInt(el.dataset.line, 10))) return;
  const lineNum = parseInt(el.dataset.line, 10);
  const vi = parseInt(el.dataset.variant, 10);
  const pos = parseInt(el.dataset.pos, 10);
  if (!Number.isFinite(lineNum) || !Number.isFinite(pos)) return;
  openLemmaDropdown(el);
});

// Enter opens the same picker, so the keyboard reaches it too.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const el = document.activeElement;
  if (!el || !el.classList || !el.classList.contains('lem-word')) return;
  if (!lemmasOn(parseInt(el.dataset.line, 10))) return;
  e.preventDefault();
  openLemmaDropdown(el);
});

// The per-omen toggles. Positions needs the sign converter and Lemmas needs
// the dictionary, same as their project-wide counterparts, so each waits for
// what it needs before turning on.
async function toggleSection(mode, lineNum, btn) {
  const set = mode === 'lemmas' ? lemmaSections : positionSections;
  if (set.has(lineNum)) {
    set.delete(lineNum);
    keepScoreInView(renderScore);
    return;
  }
  // The two take the reading over in different ways, so a section shows one or
  // the other, never both at once.
  (mode === 'lemmas' ? positionSections : lemmaSections).delete(lineNum);
  if (btn) btn.disabled = true;
  try {
    if (mode === 'lemmas') {
      await Lemmatizer.load();
      try { await ensureAtfConverter(); } catch (_) { /* readings stay literal */ }
    } else await ensureAtfConverter();
  } catch (err) {
    if (btn) btn.disabled = false;
    if (mode === 'lemmas') {
      showComposeReport('Lemmas', [noteBlock('The dictionary did not load: '
        + (err && err.message || err), 'bad')]);
      return;
    }
    // Positions still works without it, by comparing the text instead.
  }
  if (mode === 'lemmas') {
    const done = prefillLemmas(lineNum);
    if (done.filled) await saveScoreDataToFile();
    if (done.filled || done.blank) {
      setStatus('connected', '§' + lineNum + ' — ' + done.filled + ' suggested'
        + (done.blank ? ', ' + done.blank + ' the dictionary could not place' : ''));
      setTimeout(() => setStatus('connected', 'Ready'), 5000);
    }
  }
  if (btn) btn.disabled = false;
  set.add(lineNum);
  keepScoreInView(renderScore);
}

document.addEventListener('click', async (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.line-mode-btn') : null;
  if (!btn) return;
  const lineNum = parseInt(btn.dataset.line, 10);
  if (!Number.isFinite(lineNum)) return;

  // Shift on the lemma button fills in from this section to the end, which
  // is how you say "the rest of the chapter" without opening every omen.
  if (e.shiftKey && btn.dataset.mode === 'lemmas') {
    btn.disabled = true;
    try {
      await Lemmatizer.load();
      // Two different things, and a section usually needs the second.
      //
      // Prefill only fills what is empty — that is what makes it safe to run
      // again — so on a chapter that has been prefilled once it reports "0
      // suggested" and changes nothing, while every word filled under an older
      // version of the dictionary keeps its old answer. Re-asking the
      // dictionary about its own guesses is a separate step, and this gesture
      // does both.
      const done = prefillLemmas({ from: lineNum });
      if (done.filled) await saveScoreDataToFile();
      keepScoreInView(renderScore);
      const stale = refreshSuggestions(lineNum, false).length;
      if (stale) {
        await offerRefreshSuggestions(lineNum);
      } else {
        setStatus('connected', '§' + lineNum + ' onward — ' + done.filled + ' filled in'
          + (done.blank ? ', ' + done.blank + ' the dictionary could not place' : '')
          + ', nothing else to re-ask');
        setTimeout(() => setStatus('connected', 'Ready'), 6000);
      }
    } catch (err) {
      showComposeReport('Lemmas', [noteBlock('The dictionary did not load: '
        + (err && err.message || err), 'bad')]);
    }
    btn.disabled = false;
    return;
  }
  toggleSection(btn.dataset.mode, lineNum, btn);
});

// Enter opens the same picker, so the keyboard reaches it too.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const el = document.activeElement;
  if (!el || !el.classList || !el.classList.contains('lem-word')) return;
  if (!lemmasOn(parseInt(el.dataset.line, 10))) return;
  e.preventDefault();
  openLemmaDropdown(el);
});

// The per-omen positions button. Needs the sign converter, same as the
// project-wide one, because a position is only useful once witness words can be
// matched to it.
document.addEventListener('click', async (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.line-pos-btn') : null;
  if (!btn) return;
  const lineNum = parseInt(btn.dataset.line, 10);
  if (!Number.isFinite(lineNum)) return;
  if (positionSections.has(lineNum)) positionSections.delete(lineNum);
  else {
    if (!parallelsState.converter) {
      btn.disabled = true;
      try { await ensureAtfConverter(); } catch (_) { /* fall back to text comparison */ }
      btn.disabled = false;
    }
    positionSections.add(lineNum);
  }
  keepScoreInView(renderScore);
});

// The project's own dictionary, from the toolbar or from Alt+Shift+D. It needs
// the general dictionary loaded, because every entry is checked against it
// before it can be recorded.
async function showGlossaryManager() {
  try { await Lemmatizer.load(); } catch (err) {
    showComposeReport('Dictionary', [noteBlock('The dictionary did not load: '
      + (err && err.message || err), 'bad')]);
    return;
  }
  openGlossaryManager();
}

document.addEventListener('keydown', (e) => {
  if (!e.altKey || !e.shiftKey) return;
  if (String(e.key).toLowerCase() !== 'd') return;
  e.preventDefault();
  showGlossaryManager();
});

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
  // Whatever this changes, the section no longer matches what was sent.
  if (typeof refreshSentMark === 'function') refreshSentMark(lineNum);
  // A contenteditable hands back a non-breaking space where the user typed an
  // ordinary one, and it is indistinguishable on screen. eBL's parser refuses
  // the line for it, pointing at a column that looks like a plain space — so it
  // is cleaned here, at the one place a reading is written.
  // The ‡ is eBL's, derived from the alignment. It is shown on its own row
  // and never belongs in the reading — but if one ever finds its way into the
  // editable span, it stops here rather than in an export.
  text = String(text == null ? '' : text).replace(/‡/g, '');
  if (window.EblAtf && EblAtf.normaliseAtfText) text = EblAtf.normaliseAtfText(text);
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
    const from = new Set();
    for (const w of group) {
      const res = EblAtf.setWitnessVariant(content, {
        lineNum, sourceLine: w.sourceLine, letter,
      });
      if (res.ok) {
        content = res.content;
        from.add(variantLetterOf(w.variant || 0));
      }
    }
    // A ruling belongs under the line it follows, so it goes where the lines
    // went. Only once none of this manuscript's lines are left behind — a
    // witness with readings in both still needs its ruling with the others.
    for (const fromLetter of from) {
      if (fromLetter === letter) continue;
      const res = EblAtf.setDirectiveVariant(content, { lineNum, fromLetter, letter });
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

// Move one witness between the readings of its section.
//
// A variant is made from the witnesses that attest it, and that judgement gets
// revised: a tablet put in §11b turns out to belong with the main reading, or a
// witness left behind belongs with the variant after all. Until now the only
// way back was deleting the whole variant, which threw away the reading and
// every other witness with it.
//
// The move is a rewrite of the § marker in the manuscript file — the file stays
// the single source of truth for what attests what — so it survives a reload
// and shows up in the .txt where an editor can see it.
// The whole witness moves, not the line that was dragged.
//
// A manuscript often contributes several lines to one section — K.398 has three
// under §12 — and they are one witness to one reading. Moving them one at a
// time is both tedious and a way to leave a manuscript half in one variant and
// half in another by accident.
//
// Lines of the same manuscript that sit in a DIFFERENT variant are left where
// they are: that is a split someone made on purpose, and this should not undo
// it silently.
function witnessLinesToMove(lineNum, w) {
  const { scoreLines } = buildScore();
  const from = w.variant || 0;
  return (scoreLines[lineNum] || []).filter((x) =>
    x.type === 'line' && x.siglum === w.siglum && (x.variant || 0) === from);
}

async function moveWitnessTo(lineNum, w, targetVi) {
  const readings = variantsFor(lineNum);
  if (targetVi < 0 || targetVi >= readings.length) return;
  if ((w.variant || 0) === targetVi) return;

  const group = witnessLinesToMove(lineNum, w);
  if (!group.length) return;

  const touched = await assignWitnessesToVariant(group, lineNum, targetVi);
  if (!touched.length) {
    showComposeReport('§' + lineNum + ' — not moved', [
      noteBlock('The § marker for ' + displaySiglum(w.siglum)
        + ' could not be rewritten in the manuscript file. Nothing was changed.', 'bad'),
    ]);
    return;
  }
  keepScoreInView(renderScore);
  const what = group.length === 1
    ? displaySiglum(w.siglum) + ' ' + w.sourceLine
    : displaySiglum(w.siglum) + ' (' + group.length + ' lines: '
      + group.map((x) => x.sourceLine).join(', ') + ')';
  setStatus('connected', what + ' → §' + lineNum + variantLetterOf(targetVi));
  setTimeout(() => setStatus('connected', 'Ready'), 5000);
}

// The handle on a witness row. Only where there is somewhere to move it to.
//
// A drag rather than a menu: the first version opened a <select>, and a native
// select fires blur as its own dropdown opens, so the control removed itself
// the moment it was clicked. Dragging a row onto a reading says the same thing
// and says it the way the score already reads — spatially.
function witnessMoveControl(lineNum, vi, w, readingCount) {
  if (readingCount < 2) return '';
  return `<span class="witness-move" draggable="true" data-line="${lineNum}"`
    + ` data-key="${escapeHtml(w.siglum + '|' + w.sourceLine)}" data-variant="${vi}"`
    + ` title="Drag onto a reading of § ${lineNum} to move this witness there —`
    + ` every line this manuscript has under this reading goes with it.`
    + ` Ctrl-drag the row does the same.">⇅</span>`;
}

// What is in flight. dataTransfer cannot be read during dragover in most
// browsers, and the drop targets have to know whether to light up.
let draggingWitness = null;

function witnessDragPayload(el) {
  const lineNum = parseInt(el.dataset.line, 10);
  const key = el.dataset.key;
  if (!Number.isFinite(lineNum) || !key) return null;
  return { lineNum, key, from: parseInt(el.dataset.variant, 10) || 0 };
}

document.addEventListener('dragstart', (e) => {
  const handle = e.target && e.target.closest ? e.target.closest('.witness-move') : null;
  const row = e.target && e.target.closest ? e.target.closest('.score-witness') : null;
  // From the handle always; from the row only with Ctrl held, so an ordinary
  // drag across a witness still selects its text.
  const el = handle || ((e.ctrlKey || e.metaKey) && row ? row.querySelector('.witness-move') : null);
  if (!el) return;
  const payload = witnessDragPayload(el);
  if (!payload) return;
  draggingWitness = payload;
  try {
    e.dataTransfer.setData('text/plain', JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
  } catch (_) { /* some browsers refuse; the module variable carries it */ }
  document.body.classList.add('is-moving-witness');
  if (row) row.classList.add('is-being-moved');
});

document.addEventListener('dragend', () => {
  draggingWitness = null;
  document.body.classList.remove('is-moving-witness');
  for (const el of document.querySelectorAll('.is-being-moved, .is-drop-target')) {
    el.classList.remove('is-being-moved', 'is-drop-target');
  }
});

// A reading of the same section is a place to drop; anything else is not.
function dropTargetFor(node) {
  if (!draggingWitness || !node || !node.closest) return null;
  const header = node.closest('.score-line-header');
  if (!header) return null;
  const line = header.closest('.score-line[data-line]');
  if (!line || parseInt(line.dataset.line, 10) !== draggingWitness.lineNum) return null;
  const headers = [...line.querySelectorAll('.score-line-header')];
  const vi = headers.indexOf(header);
  if (vi < 0 || vi === draggingWitness.from) return null;
  return { header, vi };
}

document.addEventListener('dragover', (e) => {
  const target = dropTargetFor(e.target);
  if (!target) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!target.header.classList.contains('is-drop-target')) {
    for (const el of document.querySelectorAll('.is-drop-target')) el.classList.remove('is-drop-target');
    target.header.classList.add('is-drop-target');
  }
});

document.addEventListener('drop', (e) => {
  const target = dropTargetFor(e.target);
  if (!target) return;
  e.preventDefault();
  const job = draggingWitness;
  draggingWitness = null;
  document.body.classList.remove('is-moving-witness');
  target.header.classList.remove('is-drop-target');
  if (!job) return;

  const { scoreLines } = buildScore();
  const w = (scoreLines[job.lineNum] || []).find(
    (x) => x.type === 'line' && (x.siglum + '|' + x.sourceLine) === job.key);
  if (!w) return;
  moveWitnessTo(job.lineNum, w, target.vi);
});

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
  // Returning here without a word is why this could look like a dead button.
  // If the menu offered the delete, the variant is supposed to exist; when it
  // does not, the state and the score have parted company and that is worth
  // saying out loud.
  if (!Array.isArray(list) || vi < 1 || vi > list.length) {
    const have = Array.isArray(list) ? list.length : 0;
    if (typeof showComposeReport === 'function') {
      showComposeReport('§' + lineNum + variantLetterOf(vi) + ' could not be deleted', [
        noteBlock('The score offers this variant but the project data has ' + have
          + ' variant(s) on §' + lineNum + '. Reload the project to bring the two'
          + ' back into step — nothing was changed.', 'bad'),
      ]);
    }
    return;
  }
  const reading = list[vi - 1];
  const preview = (reading && reading.text ? reading.text : '(empty)').slice(0, 60);
  if (!confirm(`Delete variant §${lineNum}${variantLetterOf(vi)}?\n\n${preview}\n\nIts witnesses go back to the main reading.`)) return;

  const { scoreLines } = buildScore();
  const attached = (scoreLines[lineNum] || [])
    .filter((w) => w.type === 'line' && (w.variant || 0) === vi);
  // Its witnesses go back to the main reading first. If that write fails the
  // variant must stay: dropping it would leave them pointing at a reading
  // that no longer exists, and the failure would look like nothing happening.
  try {
    await assignWitnessesToVariant(attached, lineNum, 0);
  } catch (err) {
    if (typeof showComposeReport === 'function') {
      showComposeReport('§' + lineNum + variantLetterOf(vi) + ' was not deleted', [
        noteBlock('Its witnesses could not be moved back to the main reading, so'
          + ' nothing was changed.', 'bad'),
        noteBlock(String(err && err.message || err)),
      ]);
    }
    return;
  }

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
  options: { n: 3, weighting: 'tfidf', minDocNgrams: 20, source: 'all', range: '' },
};

let signIndexPromise = null;

// ana/a-na and ina/i-na are the same words under different writings — one
// sign as a logogram, two written syllabically — and a search for either
// should find both. Only these two: they are ubiquitous prepositions, and a
// blanket rule would equate readings that genuinely differ. Boundaries are
// word boundaries — the preposition is always a word of its own, and inside
// a hyphenated word "i-na" is just the signs I and NA, not the preposition.
function prepositionVariants(text) {
  const B = '([\\s{}]|^)';
  const A = '(?=[\\s{}]|$)';
  const toLogogram = String(text)
    .replace(new RegExp(B + 'a-na' + A, 'gi'), '$1ana')
    .replace(new RegExp(B + 'i-na' + A, 'gi'), '$1ina');
  const toSyllabic = String(text)
    .replace(new RegExp(B + 'ana' + A, 'gi'), '$1a-na')
    .replace(new RegExp(B + 'ina' + A, 'gi'), '$1i-na');
  const out = [];
  if (toLogogram !== text) out.push(toLogogram);
  if (toSyllabic !== text) out.push(toSyllabic);
  return out;
}

// The composite text as one searchable document: "§N reading" per line,
// variant readings with their letters. Regenerated per search — it is the
// live state of the score, not a file.
function compositeSearchDoc() {
  const nums = new Set(Object.keys(reconstructedLines).map(Number));
  for (const key of Object.keys(variantLines || {})) nums.add(Number(key));
  const sorted = [...nums].filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  const lines = [];
  for (const n of sorted) {
    variantsFor(n).forEach((reading, vi) => {
      if (reading.text && reading.text.trim()) {
        lines.push('§' + n + (vi ? variantLetterOf(vi) : '') + ' ' + reading.text);
      }
    });
  }
  return lines.join('\n');
}

// The query range, in either coordinate system:
//   "35-60", "§35–§60", "40"      -> a chapter-line range
//   "o 59", "r 12'", "obv 3"      -> one tablet line (surface + number)
//   "59'"                          -> one primed tablet line, any surface
// Empty -> null (all lines). Anything else -> { error } — never a silent
// "all": a range the parser cannot read must refuse, not pretend.
function parseSecRange(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const sec = raw.match(/^§?\s*(\d+)\s*(?:[-–—]\s*§?\s*(\d+))?$/);
  if (sec) {
    const from = parseInt(sec[1], 10);
    const to = sec[2] ? parseInt(sec[2], 10) : from;
    return { kind: 'sec', from: Math.min(from, to), to: Math.max(from, to) };
  }

  const SURFACES = {
    o: 'o', obv: 'o', obverse: 'o', r: 'r', rev: 'r', reverse: 'r',
    t: 't', top: 't', b: 'b', bottom: 'b', e: 'e', edge: 'e', col: 'col',
  };
  const tab = raw.match(/^([a-z.]+)?\s*(\d+['’]?[a-z]?)$/i);
  if (tab) {
    const surface = tab[1] ? SURFACES[tab[1].toLowerCase().replace(/\.$/, '')] : '';
    if (tab[1] && !surface) return { error: raw };
    // A primed number can only be a tablet line; an unprimed one without a
    // surface was already taken as a § above.
    if (surface || /['’]/.test(tab[2])) {
      return { kind: 'tablet', surface: surface || '', num: tab[2].replace('’', "'") };
    }
  }
  return { error: raw };
}

// A composite reading minus the editor's apparatus: "(var.: ...)" notes,
// optional complements "(-ir)", and ellipses "(…)". They are commentary on
// the text, not signs of it, and converting them splices phantom signs into
// the query stream.
function stripEditorialApparatus(text) {
  return String(text || '')
    .replace(/\(\s*var\.[^)]*\)/gi, ' ')
    .replace(/\(\s*(?:…|\.\.\.)\s*\)/g, ' ')
    .replace(/\(-[^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The composite document as sign lines for the sweep, refs "§N" / "§Nb".
function compositeToSignLines(converter, doc, range) {
  const signs = [];
  const refs = [];
  const texts = [];
  for (const line of String(doc).split('\n')) {
    const m = line.match(/^(§\d+[a-z]?)\s+(.*)$/);
    if (!m) continue;
    if (range) {
      const sec = parseInt(m[1].slice(1), 10);
      if (sec < range.from || sec > range.to) continue;
    }
    const converted = converter.convertLine(stripEditorialApparatus(m[2]));
    if (converted.codes.length) {
      signs.push(converted.codes.join(' '));
      refs.push(m[1]);
      texts.push(m[2]);
    }
  }
  return { signs: signs.join('\n'), refs, texts };
}

// What of the parallels workspace is remembered across reloads: the sweep's
// results (they are minutes of ranking and a corpus pass), which lines views
// stand open, and which tablets are open in tabs. Checked marks live in the
// project folder already; this is the browser-side working state, per
// project.
const parallelsOpenLines = new Set();   // "channel|museum"

function saveParallelsResults() {
  if (!window.EblCorpus || !projectId) return;
  EblCorpus.stash('parallels-results:' + projectId,
    parallelsState.results || undefined).catch(() => {});
}

function saveParallelsUi() {
  if (!window.EblCorpus || !projectId) return;
  EblCorpus.stash('parallels-ui:' + projectId, {
    options: { ...parallelsState.options },
    openLines: [...parallelsOpenLines],
    openTablets: [...openTablets.keys()],
  }).catch(() => {});
}

let parallelsRestoreTried = false;
async function restoreParallelsState() {
  if (parallelsRestoreTried || !window.EblCorpus || !projectId) return false;
  parallelsRestoreTried = true;
  try {
    const ui = await EblCorpus.unstash('parallels-ui:' + projectId);
    if (ui) {
      if (ui.options) Object.assign(parallelsState.options, ui.options);
      for (const key of ui.openLines || []) parallelsOpenLines.add(key);
      // Tabs come back quietly: fetched from the cache, not activated, so a
      // reload does not steal the user away from the score.
      for (const museum of ui.openTablets || []) {
        EblCorpus.getAtf(museum)
          .then((frag) => { openTablets.set(museum, frag); renderTabletTabs(); })
          .catch(() => {});
      }
    }
    const results = await EblCorpus.unstash('parallels-results:' + projectId);
    if (results) {
      parallelsState.results = results;
      // The KWIC needs the converter; warm it so restored views highlight.
      ensureAtfConverter().catch(() => {});
      return true;
    }
  } catch (err) {
    console.error('Could not restore the parallels state:', err);
  }
  return false;
}

// The ATF->signs converter, shared between the parallels sweep and the sign
// search; whichever needs it first builds it, the other reuses it.
let atfConverterPromise = null;
function ensureAtfConverter() {
  if (parallelsState.converter) return Promise.resolve(parallelsState.converter);
  if (!atfConverterPromise) {
    atfConverterPromise = loadSignIndex().then((index) => {
      parallelsState.signIndex = index;
      parallelsState.converter = EblAtfSigns.create(index);
      // The lemma lookup borrows it rather than loading the index again:
      // a reading it cannot place may be another name for a sign the
      // dictionary does know.
      if (window.Lemmatizer) {
        Lemmatizer.setSignLookup((reading) => {
          const hit = parallelsState.converter.lookup(reading);
          return hit && hit.name;
        });
        // And the other readings of that same sign, so a word written with U₄
        // can still find the entry eBL keyed under UD.
        Lemmatizer.setSignReadings(siblingReadings(index));
      }
      return parallelsState.converter;
    });
  }
  return atfConverterPromise;
}

// reading -> the other readings of the same sign, built once from the table
// already in memory. UD and U₄ are one sign; so are ŠU₂ and ŠÚ.
function siblingReadings(index) {
  let bySign = null;
  const readings = (index && index.readings) || {};
  return (reading) => {
    if (!bySign) {
      bySign = Object.create(null);
      for (const r of Object.keys(readings)) {
        const sign = readings[r];
        if (!sign) continue;
        (bySign[sign] || (bySign[sign] = [])).push(r);
      }
    }
    const sign = readings[String(reading || '').toLowerCase()];
    return sign ? bySign[sign] : null;
  };
}

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
function sourceToSignLines(content, converter, range) {
  const text = [];
  const colophon = [];
  const textRefs = [];
  const colophonRefs = [];
  const textBodies = [];
  const colophonBodies = [];
  const SURFACE_ABBR = {
    'obverse': 'o', 'reverse': 'r', 'edge': 'e', 'left edge': 'l.e.',
    'right edge': 'r.e.', 'top': 't', 'bottom': 'b',
  };
  let surface = '';
  let inColophon = false;

  for (const raw of String(content || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    if (/^@colophon/i.test(line)) { inColophon = true; continue; }
    const at = line.match(/^@(obverse|reverse|edge|left edge|right edge|top|bottom)/i);
    if (at) { surface = SURFACE_ABBR[at[1].toLowerCase()] || ''; continue; }
    if (/^@/.test(line)) continue;              // another surface
    if (/^(\/\/|#|\$)/.test(line)) continue;    // parallel, note, directive

    // "§12 7. text" in the score, or a plain "7. text" inside a colophon.
    const scored = line.match(/^§(\d+)([a-z]?)\s+(.*)$/);
    const body = scored ? scored[3] : line;
    const num = body.match(/^(\d+['’]?[a-z]?)\.\s/);
    if (!num) continue;
    // The range restricts the text channel only; colophon lines carry no §
    // and answer a different question.
    if (range && !inColophon && !range.error) {
      if (range.kind === 'sec') {
        if (!scored) continue;
        const sec = parseInt(scored[1], 10);
        if (sec < range.from || sec > range.to) continue;
      } else if (range.kind === 'tablet') {
        if (range.surface && surface !== range.surface) continue;
        const lineNum = num[1].replace('’', "'").replace(/[a-z]$/, '');
        const wanted = range.num.replace(/[a-z]$/, '');
        if (lineNum !== wanted && num[1].replace('’', "'") !== range.num) continue;
      }
    }

    const converted = converter.convertLine(body);
    if (converted.codes.length) {
      // Named the way the tablet is cited, with the § it serves.
      const ref = (surface ? surface + ' ' : '') + num[1]
        + (scored ? ' (§' + scored[1] + scored[2] + ')' : '');
      const bodyText = body.slice(num[0].length);
      if (inColophon) {
        colophon.push(converted.codes.join(' '));
        colophonRefs.push(ref);
        colophonBodies.push(bodyText);
      } else {
        text.push(converted.codes.join(' '));
        textRefs.push(ref);
        textBodies.push(bodyText);
      }
    }
  }

  return {
    text: text.join('\n'), colophon: colophon.join('\n'),
    textRefs, colophonRefs, textBodies, colophonBodies,
  };
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
    if (!parallelsState.converter) await ensureAtfConverter();

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
    const secRange = parseSecRange(parallelsState.options.range);
    if (secRange && secRange.error) {
      parallelsState.message = `Could not read the line range "${secRange.error}" — ` +
        'use chapter lines ("35-60") or a tablet line ("o 59", "r 12\u2019").';
      return;
    }
    const chosen = parallelsState.options.source === 'composite'
      ? 'composite'
      : (manuscripts[parallelsState.options.source]
        ? parallelsState.options.source : 'all');
    const queried = [];
    const querySources = { text: [], colophon: [] };

    for (const [id, ms] of Object.entries(manuscripts)) {
      // A source is excluded from its own results under the museum number it
      // is filed as; the siglum is that number in this app's convention.
      exclude.add(ms.siglum);
      if (chosen !== 'all' && id !== chosen) continue;
      const split = sourceToSignLines(ms.content, parallelsState.converter, secRange);
      if (split.text) {
        textLines.push(split.text);
        queried.push(ms.siglum);
        querySources.text.push({ siglum: ms.siglum, signs: split.text, refs: split.textRefs, texts: split.textBodies });
      }
      if (split.colophon) {
        colophonLines.push(split.colophon);
        withColophon++;
        querySources.colophon.push({ siglum: ms.siglum, signs: split.colophon, refs: split.colophonRefs, texts: split.colophonBodies });
      }
      // The profile also learns the other spelling of ana/ina for every line,
      // so a candidate writing "a-na" where this project writes "ana" still
      // shares the run. Profile only: the sources themselves stay as written.
      for (const variant of prepositionVariants(ms.content)) {
        const vSplit = sourceToSignLines(variant, parallelsState.converter, secRange);
        if (vSplit.text && vSplit.text !== split.text) textLines.push(vSplit.text);
        if (vSplit.colophon && vSplit.colophon !== split.colophon) colophonLines.push(vSplit.colophon);
      }
    }

    if (chosen === 'composite' && secRange && secRange.kind === 'tablet') {
      parallelsState.message = 'A tablet-line range ("o 59") needs a source — ' +
        'the composite text has only chapter lines. Use "§35-60" instead.';
      return;
    }
    if (chosen === 'composite') {
      const doc = compositeSearchDoc();
      const comp = compositeToSignLines(parallelsState.converter, doc, secRange);
      if (comp.signs) {
        textLines.push(comp.signs);
        queried.push('the composite text');
        querySources.text.push({
          siglum: 'Composite text', signs: comp.signs, refs: comp.refs, texts: comp.texts,
        });
        // The same ana/ina spelling variants the sources get.
        for (const variant of prepositionVariants(doc)) {
          const v = compositeToSignLines(parallelsState.converter, variant, secRange);
          if (v.signs && v.signs !== comp.signs) textLines.push(v.signs);
        }
      }
    }

    if (!textLines.length) {
      parallelsState.message = secRange
        ? 'No lines match that range — nothing to search with. Check the ' +
          'range against the source (primes and surface matter: "o 59" is ' +
          'not "o 59\u2019").'
        : (chosen === 'all'
          ? 'No sources with score assignments to search with yet.'
          : (chosen === 'composite'
            ? 'The composite text has no readings yet — nothing to search with.'
            : 'That source has no score-assigned lines to search with.'));
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
      profiles,
      querySources,
      joinedTo,
      excludedJoins,
      elapsed: Date.now() - started,
      scanned: entries.length,
      sources: textLines.length,
      queried,
      range: secRange,
      withColophon,
    };
    parallelsState.message = '';
    saveParallelsResults();
    saveParallelsUi();
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
    parallelsOpenLines.clear();
    saveParallelsResults();
    saveParallelsUi();
    parallelsState.message = `Corpus refreshed — ${loaded.count.toLocaleString()} fragments.`;
  } catch (err) {
    parallelsState.message = `Refresh failed: ${err.message}`;
  } finally {
    parallelsState.running = false;
    renderParallels();
  }
}

// Pull a candidate in as a source, reusing the same path as "+ Add > from eBL".
// One line of transliteration with the shared stretch highlighted and,
// optionally, the context clipped around it. The line's own words are
// converted to codes right here rather than reconciled against eBL's stream:
// eBL writes X for every break and our words skip them, so reconciliation
// failed on exactly the damaged lines this exists for. Highlighting instead
// trusts our converter's reading of the line, which the sign tests measure.
function kwicHtml(text, gramSet, nValues, { clip = true } = {}) {
  const conv = parallelsState.converter;
  if (!conv || !text) return null;
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  const codes = [];
  const owner = [];
  for (let wi = 0; wi < words.length; wi++) {
    let converted;
    try { converted = conv.convertLine(words[wi]).codes; } catch (_) { converted = []; }
    for (const code of converted) { codes.push(code); owner.push(wi); }
  }
  if (!codes.length) return null;

  const marked = new Array(codes.length).fill(false);
  for (const n of nValues) {
    for (let i = 0; i + n <= codes.length; i++) {
      if (gramSet.has(codes.slice(i, i + n).join(' '))) {
        for (let k = 0; k < n; k++) marked[i + k] = true;
      }
    }
  }
  if (!marked.includes(true)) return null;

  const wordHit = new Array(words.length).fill(false);
  for (let k = 0; k < codes.length; k++) if (marked[k]) wordHit[owner[k]] = true;

  const render = (from, to) => words.slice(from, to + 1).map((w, off) =>
    wordHit[from + off]
      ? `<span class="parallels-kwic-hit">${escapeHtml(w)}</span>`
      : escapeHtml(w)).join(' ');

  if (!clip) return render(0, words.length - 1);

  // Clip to a window around the hits, so long lines stay one glance wide.
  let pos = 0;
  const spans = words.map((w) => { const s = pos; pos += w.length + 1; return { s, e: s + w.length }; });
  const len = pos - 1;
  const first = wordHit.indexOf(true);
  const last = wordHit.lastIndexOf(true);
  let winS = Math.max(0, spans[first].s - 25);
  let winE = Math.min(len, spans[last].e + 25);
  if (winE - winS > 130) winE = Math.min(len, spans[first].e + 70);

  const parts = [];
  words.forEach((w, i) => {
    if (spans[i].e < winS || spans[i].s > winE) return;
    parts.push(wordHit[i]
      ? `<span class="parallels-kwic-hit">${escapeHtml(w)}</span>`
      : escapeHtml(w));
  });
  return (winS > 0 ? '… ' : '') + parts.join(' ') + (winE < len ? ' …' : '');
}

// Which lines carry the shared material, for one candidate. The pairing is
// computed here rather than during the sweep: for 37,000 fragments it would
// be waste, for the handful actually inspected it is instant. The candidate's
// ATF is fetched once (and cached by EblCorpus) so its lines can be named as
// the tablet names them; offline, the sign-line index is shown instead.
async function showParallelLines(museum, channel, cell) {
  const results = parallelsState.results;
  if (!results || !results.profiles || !results.profiles[channel]) return;
  const entry = (parallelsState.corpus || []).find((e) => e.id === museum);
  if (!entry) { cell.textContent = 'The corpus has no sign record for this fragment.'; return; }

  const profile = results.profiles[channel];
  const nValues = profile.nValues;

  // The candidate's lines that share anything with the query...
  const candLines = EblNgram.locateInLines(entry.signs, profile.set, nValues);
  if (!candLines.length) {
    cell.textContent = 'Every shared sequence spans a line break — nothing to pin to one line.';
    return;
  }

  // ...and, against exactly those grams, the query's lines.
  const sharedSet = new Set();
  for (const c of candLines) for (const g of c.grams) sharedSet.add(g);
  const pairs = new Map();   // "q|c" -> one line pair with its common grams
  for (const src of (results.querySources[channel] || [])) {
    const qSignLines = src.signs.split('\n');
    const qLines = EblNgram.locateInLines(src.signs, sharedSet, nValues);
    for (const q of qLines) {
      const qGrams = new Set(q.grams);
      for (const c of candLines) {
        const common = c.grams.filter((g) => qGrams.has(g));
        if (!common.length) continue;
        // Each (source, query line, candidate line) is visited exactly once.
        pairs.set(src.siglum + '|' + q.line + '|' + c.line, {
          siglum: src.siglum,
          qRef: src.refs[q.line] || ('line ' + (q.line + 1)),
          qText: (src.texts || [])[q.line] || '',
          qCodes: qSignLines[q.line] || '',
          cLine: c.line,
          grams: common,
          n: common.length,
        });
      }
    }
  }

  const PAIR_LIMIT = 30;
  const allPairs = [...pairs.values()].sort((a, b) => b.n - a.n);
  const ranked = allPairs.slice(0, PAIR_LIMIT);
  if (!ranked.length) { cell.textContent = 'No line pairs to show.'; return; }

  // Account for the whole Shared figure, so the list never looks short of it:
  // runs that span a line break cannot be pinned to one line, and one run
  // repeated on several lines appears in several pairs.
  const row = (results.results || []).find((r) => r.id === museum);
  const sharedTotal = row && row.scores[channel] ? row.scores[channel].shared : null;
  const spanning = sharedTotal != null ? sharedTotal - sharedSet.size : null;
  const bits = [];
  if (sharedTotal != null) {
    bits.push(`${sharedTotal} shared run${sharedTotal === 1 ? '' : 's'}: ` +
      `${sharedSet.size} sit inside single lines and are paired below`);
    if (spanning > 0) bits.push(`${spanning} span a line break and cannot be pinned to one line`);
  }
  if (allPairs.length > ranked.length) {
    bits.push(`strongest ${ranked.length} of ${allPairs.length} pairs shown`);
  }
  bits.push('a run on several lines appears in each of their pairs');
  const summary = `<div class="parallels-lines-summary">${escapeHtml(bits.join(' · '))}</div>`;

  // Name and quote the candidate's lines from its ATF, if it can be fetched.
  cell.textContent = 'Fetching the transliteration from eBL…';
  let candRefs = null;
  let candTexts = null;
  try {
    const frag = await EblCorpus.getAtf(museum);
    const SURFACE_ABBR = {
      'obverse': 'o', 'reverse': 'r', 'edge': 'e', 'left edge': 'l.e.',
      'right edge': 'r.e.', 'top': 't', 'bottom': 'b', 'colophon': 'col',
    };
    let surface = '';
    const refs = [];
    const texts = [];
    for (const raw of String(frag.atf || '').split('\n')) {
      const line = raw.trim();
      const at = line.match(/^@(obverse|reverse|edge|left edge|right edge|top|bottom|colophon)/i);
      if (at) { surface = SURFACE_ABBR[at[1].toLowerCase()] || ''; continue; }
      const num = line.match(/^(\d+['’]?[a-z]?)\.\s*(.*)$/);
      if (!num) continue;
      refs.push((surface ? surface + ' ' : '') + num[1]);
      texts.push(num[2]);
    }
    // One sign line per ATF text line is eBL's own rule; if the counts
    // disagree the mapping cannot be trusted, so fall back to indices.
    const signLineCount = String(entry.signs || '').split('\n').length;
    if (refs.length === signLineCount) { candRefs = refs; candTexts = texts; }
  } catch (_) { /* offline or 404: indices will do */ }

  let html = summary + '<table class="parallels-lines-table">';
  html += '<thead><tr><th></th><th>this project</th><th></th><th></th>' +
          `<th>${escapeHtml(museum)}</th><th title="Shared sign runs on this pair of lines">runs</th></tr></thead><tbody>`;
  for (const p of ranked) {
    const gramSet = new Set(p.grams);
    const cRef = candRefs ? candRefs[p.cLine] : ('sign line ' + (p.cLine + 1));
    const cText = candTexts ? candTexts[p.cLine] : '';
    const qKwic = kwicHtml(p.qText, gramSet, nValues)
      || escapeHtml(String(p.qText || '').slice(0, 80));
    const cKwic = kwicHtml(cText, gramSet, nValues)
      || escapeHtml(String(cText || '').slice(0, 80));
    const qSec = (p.qRef.match(/\(§(\d+[a-z]?)\)/) || [])[1]
      || (p.qRef.match(/^§(\d+[a-z]?)$/) || [])[1] || '';
    html += '<tr>' +
      `<td class="parallels-lines-q"><a href="#" class="pl-goto-q" data-siglum="${escapeHtml(p.siglum)}" ` +
      `data-sec="${escapeHtml(qSec)}" title="Open ${escapeHtml(p.siglum)} at this line">` +
      `${escapeHtml(p.siglum)} ${escapeHtml(p.qRef)}</a></td>` +
      `<td class="parallels-lines-text">${qKwic}</td>` +
      '<td class="parallels-lines-arrow">&harr;</td>' +
      `<td class="parallels-lines-c"><a href="#" class="pl-goto-c" data-line="${p.cLine}" ` +
      `title="Open ${escapeHtml(museum)} at this line, in a tab beside Images">${escapeHtml(cRef || '')}</a></td>` +
      `<td class="parallels-lines-text">${cKwic}</td>` +
      `<td class="parallels-lines-n">${p.n}</td>` +
      '</tr>';
  }
  html += '</tbody></table>';
  if (!candRefs) {
    html += '<div class="parallels-lines-note">Line numbers are positions in the sign record — ' +
            'the transliteration could not be fetched to name them.</div>';
  }
  cell.innerHTML = html;

  // The query side jumps the editor to that line; the candidate side opens
  // the fragment read-only, scrolled to the paired line.
  cell.querySelectorAll('.pl-goto-q').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      // The composite has no source file — its lines live in the score.
      if (a.dataset.siglum === 'Composite text') revealScoreEntry(a.dataset.sec);
      else revealSourceAnchor(a.dataset.siglum, a.dataset.sec);
    });
  });
  cell.querySelectorAll('.pl-goto-c').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openTabletView(museum, parseInt(a.dataset.line, 10));
    });
  });
}

// ---- Read-only tablet tabs -----------------------------------------------
// Any eBL fragment opened as its own tab beside Images, without becoming a
// source: for reading a candidate in full before deciding anything about it.
const openTablets = new Map();   // museum -> { atf }
let activeTablet = null;

async function openTabletView(museum, focusLine) {
  if (!openTablets.has(museum)) {
    setStatus('syncing', `Fetching ${museum}…`);
    try {
      const frag = await EblCorpus.getAtf(museum);
      // The whole record: the KWIC needs .signs, the About block the rest.
      openTablets.set(museum, frag);
      setStatus('connected', `Fetched ${museum}`);
    } catch (err) {
      setStatus('error', `Could not fetch ${museum}`);
      alert(err.message);
      return;
    }
  }
  activeTablet = museum;
  renderTabletTabs();
  renderTabletView(focusLine);
  saveParallelsUi();
}

function closeTabletView(museum) {
  openTablets.delete(museum);
  saveParallelsUi();
  if (activeTablet === museum) {
    activeTablet = openTablets.size ? [...openTablets.keys()].pop() : null;
  }
  renderTabletTabs();
  if (activeTablet) {
    renderTabletView();
  } else {
    // Nothing left to show: back to the score.
    const scoreTab = document.querySelector('.pane-tab[data-tab="score"]');
    if (scoreTab) scoreTab.click();
  }
}

function renderTabletTabs() {
  // Their own row under the fixed tabs. A tablet opened from Parallels is
  // transient, and putting it in the row above shifts Score, Colophons and
  // the rest sideways every time one opens or closes.
  const bar = document.getElementById('tablet-tabs');
  if (!bar) return;
  bar.innerHTML = '';
  bar.classList.toggle('hidden', openTablets.size === 0);
  for (const museum of openTablets.keys()) {
    const btn = document.createElement('button');
    btn.className = 'pane-tab pane-tab-tablet' + (museum === activeTablet ? ' active' : '');
    btn.dataset.tab = 'tablet';
    btn.dataset.museum = museum;
    btn.innerHTML = `${escapeHtml(museum)}<span class="tablet-tab-close" title="Close">&times;</span>`;
    btn.addEventListener('click', (e) => {
      if (e.target.closest('.tablet-tab-close')) { closeTabletView(museum); return; }
      activeTablet = museum;
      renderTabletTabs();
      renderTabletView();
    });
    bar.appendChild(btn);
  }
  if (activeTablet) {
    // Activate our tab and content by hand — the static handler only knows
    // the tabs that existed at startup.
    document.querySelectorAll('.pane-tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.museum === activeTablet));
    document.querySelectorAll('.tab-content').forEach((c) =>
      c.classList.toggle('active', c.dataset.tab === 'tablet'));
  }
}

// "LAOS 15, 143-172" out of an eBL reference: series short title and number
// when the document has them, author and year when not.
function citeReference(ref) {
  const doc = ref.document || {};
  const series = doc['container-title-short']
    ? (doc['container-title-short'] + (doc['collection-number'] ? ' ' + doc['collection-number'] : ''))
    : null;
  const year = doc.issued && doc.issued['date-parts'] && doc.issued['date-parts'][0]
    ? doc.issued['date-parts'][0][0] : null;
  const authors = (doc.author || []).map((a) => a.family).filter(Boolean).join(' & ');
  const head = series || (authors ? (authors + (year ? ', ' + year : '')) : (doc['citation-label'] || ref.id));
  return head + (ref.pages ? ', ' + ref.pages : '');
}

function tabletMetaHtml(record) {
  const rows = [];
  const add = (label, value) => { if (value) rows.push([label, value]); };

  const museumName = String(record.museum || '').replace(/_/g, ' ').toLowerCase()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  add('Museum', museumName + (record.collection ? ` (${record.collection} Collection)` : ''));
  if (record.accession && (record.accession.prefix || record.accession.number)) {
    add('Accession', [record.accession.prefix, record.accession.number, record.accession.suffix]
      .filter(Boolean).join('.'));
  }
  const dims = ['length', 'width', 'thickness']
    .map((k) => record[k] && record[k].value).filter(Boolean);
  if (dims.length) add('Size', dims.join(' × ') + ' cm');
  const arch = record.archaeology || {};
  add('Provenance', arch.site);
  if (arch.findspot) {
    const f = arch.findspot;
    add('Findspot', [f.site, f.sector, f.area, f.building].filter(Boolean).join(' > ')
      + (f.notes ? ' — ' + f.notes : ''));
  }
  if (record.script && record.script.period) {
    add('Script', record.script.period
      + (record.script.periodModifier && record.script.periodModifier !== 'None'
        ? ' (' + record.script.periodModifier + ')' : ''));
  }
  const genres = (record.genres || []).map((g) => (g.category || []).join(' > ')).filter(Boolean);
  if (genres.length) add('Genre', genres.join('; '));
  if (record.joins && record.joins.length) {
    const pieces = [];
    for (const group of record.joins) {
      for (const piece of group) {
        const mn = piece.museumNumber || {};
        const num = [mn.prefix, mn.number, mn.suffix].filter(Boolean).join('.');
        if (num && num !== record.museumNumber) pieces.push(num);
      }
    }
    if (pieces.length) add('Joins', pieces.join(' + '));
  }
  add('Notes', record.notes);

  // Editions only — the copies, discussions and archaeology are on the eBL
  // page a click away; what a reader here wants is where the text is edited.
  const editions = (record.references || []).filter((r) => r.type === 'EDITION');
  if (editions.length) add('Edition', editions.map(citeReference).join(' · '));

  if (!rows.length) return '';
  let html = '<details class="tablet-meta"><summary>About this fragment</summary><table>';
  for (const [label, value] of rows) {
    html += `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
  }
  return html + '</table></details>';
}

function renderTabletView(focusLine) {
  const panel = document.getElementById('tablet-view');
  if (!panel || !activeTablet) return;
  const record = openTablets.get(activeTablet);
  if (!record) return;

  // Everything this project shares with the tablet, as a per-line gram map —
  // the whole view becomes a KWIC. Needs a sweep to have run; without one
  // there is no profile to match against, and the text shows plain.
  const profiles = parallelsState.results && parallelsState.results.profiles;
  let hitsByLine = null;
  let gramSet = null;
  let nValues = [3];
  if (profiles && window.EblNgram && record.signs) {
    gramSet = new Set();
    for (const key of Object.keys(profiles)) {
      nValues = profiles[key].nValues;
      for (const g of profiles[key].set) gramSet.add(g);
    }
    hitsByLine = new Map();
    for (const found of EblNgram.locateInLines(record.signs, gramSet, nValues)) {
      hitsByLine.set(found.line, new Set(found.grams));
    }
  }

  let html = `<div class="tablet-view-header">` +
    `<strong>${escapeHtml(activeTablet)}</strong>` +
    `<a href="https://www.ebl.lmu.de/fragmentarium/${encodeURIComponent(activeTablet)}" ` +
    `target="_blank" rel="noopener noreferrer">open in eBL &#8599;</a>` +
    (hitsByLine
      ? `<span class="tablet-view-note">${hitsByLine.size} line${hitsByLine.size === 1 ? '' : 's'} share material with this project (highlighted)</span>`
      : `<span class="tablet-view-note">run the parallels search to highlight shared lines</span>`) +
    `</div>` +
    tabletMetaHtml(record) +
    `<pre class="tablet-view-text">`;

  // Sign-line indices count the numbered text lines, so both the focus and
  // the KWIC map land on the right lines.
  let textLineIndex = -1;
  for (const raw of String(record.atf || '').split('\n')) {
    const isText = /^\s*\d+['’]?[a-z]?\.\s/.test(raw);
    if (isText) textLineIndex++;
    const cls = (isText && textLineIndex === focusLine) ? ' class="tablet-line-hit"' : '';
    let body = escapeHtml(raw);
    if (isText && hitsByLine && hitsByLine.has(textLineIndex)) {
      const marked = kwicHtml(raw, hitsByLine.get(textLineIndex), nValues, { clip: false });
      if (marked) body = marked;
    }
    html += `<span${cls}>${body}</span>\n`;
  }
  html += '</pre>';
  panel.innerHTML = html;

  if (focusLine != null) {
    const hit = panel.querySelector('.tablet-line-hit');
    if (hit) hit.scrollIntoView({ block: 'center' });
  }
}

// ---- Paradigms -----------------------------------------------------------
// Template twins of one chapter line, across the whole corpus: lines that
// agree with it for PARADIGM_K signs on both sides of a short middle that
// differs. The distinct middles, decoded and ranked by how many contexts
// attest them, are the paradigm of that slot — planets in a planet slot,
// verbs in a verb slot.
const PARADIGM_K = 3;
const PARADIGM_MAX_MIDDLE = 6;

let signNameByCode = null;
function signName(code) {
  if (!signNameByCode) {
    signNameByCode = {};
    const table = (parallelsState.signIndex && parallelsState.signIndex.signs) || {};
    for (const [name, sign] of Object.entries(table)) {
      if (sign.abz && !signNameByCode[sign.abz]) signNameByCode[sign.abz] = name;
      if (sign.token && !signNameByCode[sign.token]) signNameByCode[sign.token] = name;
    }
  }
  return signNameByCode[code] || code;
}

// The reading of §sec this project would query with: the composite line if
// one is written, else the first witness's.
function paradigmQueryText(sec) {
  const recon = reconstructedLines[parseInt(sec, 10)];
  if (recon && String(recon).trim()) return stripEditorialApparatus(recon);
  const rx = new RegExp('^§' + sec + '[a-z]?\\s+(?:\\d+[\'\u2019]?[a-z]?\\.\\s*)?(.*)$');
  for (const ms of Object.values(manuscripts)) {
    for (const raw of String(ms.content || '').split('\n')) {
      const m = raw.trim().match(rx);
      if (m && m[1].trim()) return m[1].trim();
    }
  }
  return '';
}

// Query damage is a wildcard — OUR break can stand for anything — but the
// candidate's damage confirms nothing, so an X there never matches.
function eqSign(q, t) {
  return q === 'X' ? true : (q === t && t !== 'X');
}

// Align the whole query against T starting at anchor j0: alternating matched
// runs and variant slots, at most maxV slots, each side of a slot at most
// maxSpan signs and free of damage. Every query position outside a slot must
// match — the omen defines the frame. Greedy with a two-sign resync, minimal
// slot first. Returns the slots, or null.
const PARADIGM_MIN_FRAME = 0.6;   // matched share of the query line

function alignOmen(Q, T, j0, maxV, maxSpan, owners) {
  let i = 0;
  let j = j0;
  const slots = [];
  let spent = 0;
  // a slot costs the number of query WORDS it touches — that is how a
  // philologist counts variants; an insertion (no query span) costs one
  const costOf = (qFrom, qLen) => {
    if (!owners || !qLen) return 1;
    return new Set(owners.slice(qFrom, qFrom + qLen)).size || 1;
  };
  for (;;) {
    while (i < Q.length && j < T.length && eqSign(Q[i], T[j])) { i++; j++; }
    if (i === Q.length) {
      // The frame must dominate: a "match" whose slots swallow most of the
      // line is two different omens pinned together at a coincidental sign.
      const inSlots = slots.reduce((n, sl) => n + sl.qLen, 0);
      if (Q.length - inSlots < Math.ceil(Q.length * PARADIGM_MIN_FRAME)) return null;
      return slots;
    }
    if (spent >= maxV) return null;

    let best = null;
    for (let a = 0; a <= maxSpan; a++) {
      for (let b = 0; b <= maxSpan; b++) {
        if (a === 0 && b === 0) continue;
        if (i + a > Q.length || j + b > T.length) continue;
        const qSpan = Q.slice(i, i + a);
        const tSpan = T.slice(j, j + b);
        if (qSpan.includes('X') || tSpan.includes('X')) continue;
        // resync: the next signs after the slot must match again. A slot in
        // the FINAL position is allowed only when the candidate line ends
        // there too — the line end anchors it; otherwise the filler's extent
        // would be unknowable.
        const left = Q.length - (i + a);
        if (left === 0) {
          if (j + b !== T.length) continue;
        } else {
          // One matched sign re-anchors: omen variants often sit either side
          // of a single shared sign, and demanding two merged them into one
          // mega-slot spanning words that match.
          if (j + b >= T.length || !eqSign(Q[i + a], T[j + b])) continue;
        }
        const cost = a + b + Math.abs(a - b) * 0.25;
        if (!best || cost < best.cost) best = { a, b, cost };
      }
    }
    if (!best) return null;
    spent += costOf(i, best.a);
    if (spent > maxV) return null;
    slots.push({ qFrom: i, qLen: best.a, cFrom: j, cLen: best.b, cost: costOf(i, best.a) });
    i += best.a;
    j += best.b;
  }
}

// Whole-omen twins across the corpus: lines containing a stretch that aligns
// with the full query under the variant budget. A cheap trigram screen keeps
// the aligner off the 99% of lines that share nothing.
function findOmenTwins(queryTokens, corpusEntries, maxV, maxSpan, owners) {
  const qTrigrams = new Set();
  for (let i = 0; i + 3 <= queryTokens.length; i++) {
    const tri = queryTokens.slice(i, i + 3);
    if (!tri.includes('X')) qTrigrams.add(tri.join(' '));
  }
  const minShared = Math.max(2, Math.floor((queryTokens.length - maxV * maxSpan) / 3));

  // the first sound sign anchors the alignment
  let a0 = 0;
  while (a0 < queryTokens.length && queryTokens[a0] === 'X') a0++;
  const anchor = queryTokens[a0];
  const Q = queryTokens.slice(a0);
  const ownersQ = owners ? owners.slice(a0) : null;
  if (!anchor || Q.length < 4) return [];

  const matches = [];
  for (const entry of corpusEntries) {
    const parts = String(entry.signs || '').split('\n');
    for (let li = 0; li < parts.length; li++) {
      const T = parts[li].trim().split(/\s+/).filter(Boolean);
      if (T.length < Q.length - maxV * maxSpan) continue;

      let shared = 0;
      for (let i = 0; i + 3 <= T.length; i++) {
        if (qTrigrams.has(T.slice(i, i + 3).join(' '))) shared++;
      }
      if (shared < minShared) continue;

      let best = null;
      for (let j0 = 0; j0 < T.length; j0++) {
        if (!eqSign(anchor, T[j0])) continue;
        const slots = alignOmen(Q, T, j0, maxV, maxSpan, ownersQ);
        if (slots && (!best || slots.length < best.slots.length)) {
          best = { slots, anchor: j0 };
          if (slots.length === 0) break;
        }
      }
      if (best) {
        matches.push({ id: entry.id, line: li, tokens: T, slots: best.slots, shared });
        if (matches.length >= 200) return matches;
      }
    }
  }
  return matches;
}

// Which § a project source's tablet line serves: "r 5" of K.6121 -> "84".
// Matched against the source's own file, surface and number both.
function secForTabletLine(content, surface, num) {
  const SURFACE_ABBR = {
    'obverse': 'o', 'reverse': 'r', 'edge': 'e', 'left edge': 'l.e.',
    'right edge': 'r.e.', 'top': 't', 'bottom': 'b', 'colophon': 'col',
  };
  let current = '';
  for (const raw of String(content || '').split('\n')) {
    const line = raw.trim();
    const at = line.match(/^@(obverse|reverse|edge|left edge|right edge|top|bottom|colophon)/i);
    if (at) { current = SURFACE_ABBR[at[1].toLowerCase()] || ''; continue; }
    const m = line.match(/^§(\d+[a-z]?)\s+(\d+['\u2019]?[a-z]?)\.\s/);
    if (!m) continue;
    if ((surface || '') !== current) continue;
    if (m[2] === num || m[2].replace('\u2019', "'") === num.replace('\u2019', "'")) return m[1];
  }
  return null;
}

// The Paradigms tab: bar + results. The stored html brings the last run
// back on every visit.
function renderParadigmsTab() {
  const panel = document.getElementById('paradigms-tab');
  if (!panel) return;
  panel.innerHTML =
    `<div class="parallels-paradigms-bar">` +
    `<label title="Find lines in the whole corpus that agree with this chapter line except in one slot — the swap check. The differing fillers are the slot's paradigm.">` +
    `§ <input type="text" id="paradigms-sec" class="parallels-range-input" ` +
    `value="${escapeHtml(parallelsState.paradigmsSec || '')}" placeholder="35"></label> ` +
    `<label title="How many WORDS of the line may differ. A contiguous multi-word swap shows as one chip but costs one per word. The rest must match sign for sign.">` +
    `variant words \u2264 <select id="paradigms-var">` +
    [1, 2, 3, 4].map((v) => `<option value="${v}"${(parallelsState.paradigmsMaxVar || 2) === v ? ' selected' : ''}>${v}</option>`).join('') +
    `</select></label> ` +
    `<label title="Hide this project's witnesses and their recorded joins — corpus discoveries only.">` +
    `<input type="checkbox" id="paradigms-exclude"${parallelsState.paradigmsExcludeMine ? ' checked' : ''}> ` +
    `exclude project texts</label> ` +
    `<button id="paradigms-run" class="parallels-run">Find twins</button>` +
    `<span class="parallels-corpus-state">the whole line must match, except the budgeted slots</span></div>` +
    `<div id="paradigms-results">${parallelsState.paradigmsHtml || ''}</div>`;
  const btn = document.getElementById('paradigms-run');
  btn.addEventListener('click', () => {
    parallelsState.paradigmsMaxVar = Number(document.getElementById('paradigms-var').value);
    parallelsState.paradigmsExcludeMine = document.getElementById('paradigms-exclude').checked;
    runParadigms(document.getElementById('paradigms-sec').value);
  });
  document.getElementById('paradigms-sec').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); btn.click(); }
  });
  bindParadigmLinks(panel);
  bindParadigmQueryDrag(panel);
}

// The query block is position:sticky; dragging its header changes the
// offset it pins at, so the guide line can ride at any height while the
// candidate blocks scroll underneath. The offset is kept for the session.
function bindParadigmQueryDrag(container) {
  const block = container.querySelector('.pg-query');
  if (!block) return;
  block.style.top = (parallelsState.paradigmsTop || 0) + 'px';
  const head = block.querySelector('.pg-head');
  if (!head) return;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('a')) return;
    e.preventDefault();
    const pane = block.closest('.score') || block.parentElement;
    const startY = e.clientY;
    const startTop = parseFloat(block.style.top) || 0;
    const move = (ev) => {
      const max = Math.max(0, pane.clientHeight - block.offsetHeight - 8);
      const top = Math.min(max, Math.max(0, startTop + ev.clientY - startY));
      block.style.top = top + 'px';
      parallelsState.paradigmsTop = top;
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      block.classList.remove('pg-dragging');
    };
    block.classList.add('pg-dragging');
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}

function bindParadigmLinks(root) {
  root.querySelectorAll('.paradigm-open').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openTabletView(a.dataset.museum, parseInt(a.dataset.line, 10));
    });
  });
  root.querySelectorAll('.pg-goto-sec').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      revealScoreEntry(a.dataset.sec);
    });
  });
}

// One line as an interlinear block: the words on top, each word's signs
// beneath it, cell by cell — so two blocks align by eye and a substitution
// is seen, not inferred. wordSigns[i] is the sign chunk under words[i];
// highlight marks the substituted word range.
function interlinearHtml(words, wordSigns, highlight) {
  let html = '<div class="pg-row">';
  for (let i = 0; i < words.length; i++) {
    const hit = highlight && highlight.has && highlight.has(i);
    html += `<span class="pg-cell${hit ? ' pg-cell-hit' : ''}">` +
      `<span class="pg-word">${escapeHtml(words[i])}</span>` +
      `<span class="pg-signs">${escapeHtml(wordSigns[i] || '')}</span></span>`;
  }
  return html + '</div>';
}

// Words + per-word sign chunks for a line of ATF, via the converter. When
// the eBL sign line is given and reconciles in length, its codes are used
// (they are the corpus's ground truth); otherwise our own conversion is.
function interlinearData(text, eblSignLine) {
  const conv = parallelsState.converter;
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const counts = [];
  const ours = [];
  for (const word of words) {
    let codes;
    try { codes = conv.convertLine(word).codes; } catch (_) { codes = []; }
    counts.push(codes.length);
    ours.push(codes);
  }
  let source = ours;
  if (eblSignLine) {
    const ebl = String(eblSignLine).trim().split(/\s+/).filter(Boolean);
    if (ebl.length === counts.reduce((a, b) => a + b, 0)) {
      source = [];
      let at = 0;
      for (const c of counts) { source.push(ebl.slice(at, at + c)); at += c; }
    }
  }
  return {
    words,
    counts,
    wordSigns: source.map((codes) => codes.map(signName).join('.')),
  };
}

// Map a token range of the sign line onto word indices.
function tokenRangeToWords(counts, at, len) {
  if (!len) return null;
  let pos = 0;
  let from = -1;
  let to = -1;
  for (let w = 0; w < counts.length; w++) {
    const end = pos + counts[w];
    if (from < 0 && at < end) from = w;
    if (at + len - 1 < end) { to = w; break; }
    pos = end;
  }
  return from >= 0 ? { from, to: to < 0 ? counts.length - 1 : to } : null;
}

async function runParadigms(secInput) {
  const sec = String(secInput || '').trim().replace(/^§/, '');
  const container = document.getElementById('paradigms-results');
  if (!container || !/^\d+[a-z]?$/.test(sec)) return;

  container.innerHTML = '<div class="parallels-message">Working&hellip;</div>';
  try {
    await ensureAtfConverter();
    const entries = await ensureParallelsCorpus(() => {});
    const text = paradigmQueryText(sec);
    if (!text) {
      container.innerHTML = `<div class="parallels-message">§${escapeHtml(sec)} has no reading to query with.</div>`;
      return;
    }
    const queryTokens = parallelsState.converter.convertLine(text).codes;
    // token -> word ownership, so the budget can count variant WORDS
    let owners = null;
    {
      const d = interlinearData(text, null);
      if (d.counts.reduce((a, b) => a + b, 0) === queryTokens.length) {
        owners = [];
        d.counts.forEach((c, wi) => { for (let k = 0; k < c; k++) owners.push(wi); });
      }
    }
    if (queryTokens.length < 2 * PARADIGM_K + 1) {
      container.innerHTML = '<div class="parallels-message">The line is too short for twin contexts.</div>';
      return;
    }

    const projectSigla = new Set(Object.values(manuscripts).map((m) => m.siglum));
    // A candidate eBL records as joined to a project source is half in the
    // project already: the join is named, not passed off as an independent
    // witness. Stored "// joins:" headers make this free for most projects.
    let joinedTo = {};
    try { joinedTo = await loadJoinMap(Object.values(manuscripts), () => {}); } catch (_) { /* offline */ }

    const maxV = parallelsState.paradigmsMaxVar || 2;
    const matches = findOmenTwins(queryTokens, entries, maxV, PARADIGM_MAX_MIDDLE, owners);
    // Slot signs join with SPACES: a slot can span word boundaries, and the
    // dot is the convention for signs inside one word \u2014 "BAD.ME\u0160.IG.ME\u0160"
    // reads as a single impossible compound where "BAD ME\u0160 IG ME\u0160" reads as
    // what it is, a run of four signs. (The interlinear rows keep the dot:
    // there the signs really do belong to the one word above them.)
    const decode = (codes) => codes.length ? codes.map(signName).join(' ') : '\u2205';

    for (const match of matches) {
      match.mine = projectSigla.has(match.id) || !!joinedTo[match.id];
    }
    const excludeMine = !!parallelsState.paradigmsExcludeMine;
    const hiddenMine = excludeMine ? matches.filter((m) => m.mine).length : 0;
    const kept = excludeMine ? matches.filter((m) => !m.mine) : matches;

    if (!kept.length) {
      container.innerHTML = `<div class="parallels-message">No line in the corpus matches the whole of ` +
        `§${escapeHtml(sec)} with at most ${maxV} variant slot${maxV === 1 ? '' : 's'}` +
        `${hiddenMine ? ` — apart from ${hiddenMine} project line${hiddenMine === 1 ? '' : 's'} excluded by the option` : ''}. ` +
        'A looser budget may find more.</div>';
      parallelsState.paradigmsHtml = container.innerHTML;
      return;
    }

    // this project's witnesses (joins included) first, then the corpus;
    // within each, fewest slots first
    kept.sort((a, b) => (b.mine - a.mine) || (a.slots.length - b.slots.length) || (b.shared - a.shared));
    const mineCount = kept.filter((m) => m.mine).length;
    const candidates = kept.slice(0, 24);

    const q = interlinearData(text, null);
    let html = `<div class="pg-block pg-query"><div class="pg-head">§ ${escapeHtml(sec)} — this project` +
      '<span class="pg-drag-hint" title="Drag to move the pinned line up or down">&#8597; drag</span></div>' +
      interlinearHtml(q.words, q.wordSigns, null) + '</div>';
    html += `<div class="parallels-section-blurb">${kept.length > candidates.length ? candidates.length + ' of ' : ''}` +
      `${kept.length} corpus line${kept.length === 1 ? '' : 's'} match the whole line with at most ` +
      `${maxV} variant word${maxV === 1 ? '' : 's'} (a slot \u2264 ${PARADIGM_MAX_MIDDLE} signs a side). ` +
      `Substituted words highlighted; \u2205 = omitted; sign names, not readings.` +
      `${hiddenMine ? ` \u00b7 ${hiddenMine} project line${hiddenMine === 1 ? '' : 's'} hidden by the exclude option.` : ''}</div>`;

    container.innerHTML = html +
      '<div class="parallels-message">Fetching the transliterations\u2026</div>';

    const mineBlocks = [];
    const corpusBlocks = [];
    for (const cand of candidates) {
      const blocks = cand.mine ? mineBlocks : corpusBlocks;
      let block = '';
      let ref = 'sign line ' + (cand.line + 1);
      let lineText = null;
      let signLine = null;
      try {
        const frag = await EblCorpus.getAtf(cand.id);
        const SURF = { obverse: 'o', reverse: 'r', edge: 'e', 'left edge': 'l.e.',
          'right edge': 'r.e.', top: 't', bottom: 'b', colophon: 'col' };
        const texts = [];
        let surface = '';
        for (const raw of String(frag.atf || '').split('\n')) {
          const line = raw.trim();
          const at = line.match(/^@(obverse|reverse|edge|left edge|right edge|top|bottom|colophon)/i);
          if (at) { surface = SURF[at[1].toLowerCase()] || ''; continue; }
          const m = line.match(/^(\d+['\u2019]?[a-z]?)\.\s*(.*)$/);
          if (m) texts.push({ ref: (surface ? surface + ' ' : '') + m[1], text: m[2] });
        }
        signLine = String(frag.signs || '').split('\n')[cand.line] || '';
        if (texts.length === String(frag.signs || '').split('\n').length && texts[cand.line]) {
          ref = texts[cand.line].ref;
          lineText = texts[cand.line].text;
        }
      } catch (_) { /* offline: sign row only */ }

      // an in-project twin names its § — the score is one click away
      let secLink = '';
      if (projectSigla.has(cand.id) && ref && !ref.startsWith('sign line')) {
        const parts = ref.match(/^(?:(o|r|t|b|e|l\.e\.|r\.e\.|col)\s+)?(.+)$/);
        const ms = Object.values(manuscripts).find((m) => m.siglum === cand.id);
        const sec = ms && parts ? secForTabletLine(ms.content, parts[1] || '', parts[2]) : null;
        if (sec) {
          secLink = ` <a href="#" class="pg-goto-sec" data-sec="${escapeHtml(sec)}" ` +
            `title="Show § ${escapeHtml(sec)} in the score">§ ${escapeHtml(sec)}</a>`;
        }
      }

      const chips = cand.slots.length
        ? cand.slots.map((sl) => {
            const replaced = queryTokens.slice(sl.qFrom, sl.qFrom + sl.qLen);
            const filler = cand.tokens.slice(sl.cFrom, sl.cFrom + sl.cLen);
            return `<span class="pg-chip" title="${escapeHtml(replaced.join(' ') || 'nothing')} \u2192 ${escapeHtml(filler.join(' ') || 'nothing')}">` +
              `[${escapeHtml(decode(replaced))}] \u2192 [${escapeHtml(decode(filler))}]</span>`;
          }).join(' ')
        : '<span class="pg-chip pg-chip-same">identical</span>';

      block += `<div class="pg-block${cand.mine ? ' pg-mine' : ''}"><div class="pg-head">` +
        `<a href="#" class="paradigm-open" data-museum="${escapeHtml(cand.id)}" data-line="${cand.line}">` +
        `${escapeHtml(cand.id)}</a> ${escapeHtml(ref)}${secLink}` +
        `${projectSigla.has(cand.id)
          ? ' <span class="parallels-have">(in project)</span>'
          : (joinedTo[cand.id]
            ? ` <span class="parallels-have parallels-join-owner">(+) joins ${escapeHtml(joinedTo[cand.id].join(' + '))}</span>`
            : '')} ${chips}</div>`;

      if (lineText) {
        const d = interlinearData(lineText, signLine);
        const hitWords = new Set();
        for (const sl of cand.slots) {
          const range = tokenRangeToWords(d.counts, sl.cFrom, sl.cLen);
          if (range) for (let w = range.from; w <= range.to; w++) hitWords.add(w);
        }
        block += interlinearHtml(d.words, d.wordSigns, hitWords);
      } else {
        block += `<div class="pg-row"><span class="pg-cell"><span class="pg-signs">` +
          `${escapeHtml(String(signLine || '').split(/\s+/).map(signName).join(' '))}</span></span></div>`;
      }
      block += '</div>';
      blocks.push(block);
    }

    const fold = (title, arr) => arr.length
      ? `<details class="pg-group" open><summary class="pg-group-head">${title}</summary>${arr.join('')}</details>`
      : '';
    container.innerHTML = html +
      fold(`In this project, joins included — ${mineCount}`, mineBlocks) +
      fold(`Elsewhere in the corpus — ${kept.length - mineCount}`, corpusBlocks);
    parallelsState.paradigmsHtml = container.innerHTML;
    parallelsState.paradigmsSec = sec;
    bindParadigmLinks(container);
    bindParadigmQueryDrag(container);
  } catch (err) {
    console.error('Paradigms failed:', err);
    container.innerHTML = `<div class="parallels-message">Could not run: ${escapeHtml(err.message)}</div>`;
  }
}

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
  html += '<th title="Shared trigrams on this channel">Shared</th><th></th><th></th>';
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
    html += `<td><button class="parallels-lines-btn" data-museum="${escapeHtml(row.id)}" ` +
            `data-channel="${channel}" title="Which lines share the material">lines</button></td>`;
    html += '<td>' +
      `<span class="parallels-checked-by">${escapeHtml(checkedLabel(check))}</span>` +
      `<button class="parallels-view" data-museum="${escapeHtml(row.id)}" title="Read the whole fragment in a tab beside Images">view</button>` +
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
  if (!parallelsState.results && await restoreParallelsState()) {
    // restored: fall through and render with the recovered results
  }
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
    html += `<label title="Pool every source into one query, ask with a single tablet, or ask with the reconstructed composite text alone.">` +
            `Search with <select id="parallels-source"${disabled}>` +
            `<option value="all"${opts.source === 'all' ? ' selected' : ''}>All sources</option>` +
            `<option value="composite"${opts.source === 'composite' ? ' selected' : ''}>Composite text</option>` +
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
  html += `<label title="Restrict the query: chapter lines (35-60, §40) or one tablet line of the chosen source (o 59, r 12\u2019). Empty = all lines. The colophon channel is not affected.">` +
          `Lines § <input type="text" id="parallels-range" class="parallels-range-input"${disabled} ` +
          `value="${escapeHtml(opts.range || '')}" placeholder="all"></label>`;
  html += '</div>';

  if (message) html += `<div class="parallels-message">${escapeHtml(message)}</div>`;

  if (results) {
    const { dropped, settings, total } = results;
    html += '<div class="parallels-summary">';
    html += `Ranked ${results.scanned.toLocaleString()} fragments against ` +
            (results.queried && results.queried.length === 1
              ? `${escapeHtml(results.queried[0])} alone`
              : `${results.sources} source${results.sources === 1 ? '' : 's'}`);
    if (results.range && results.range.kind === 'sec') {
      html += ` (lines §${results.range.from}${results.range.to !== results.range.from ? '–§' + results.range.to : ''})`;
    } else if (results.range && results.range.kind === 'tablet') {
      html += ` (tablet line ${escapeHtml((results.range.surface ? results.range.surface + ' ' : '') + results.range.num)})`;
    }

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
      parallelsOpenLines.clear();
      saveParallelsResults();
      saveParallelsUi();
      parallelsState.message = 'Settings changed — run the search again.';
      renderParallels();
    });
  };
  onOption('parallels-source', (v) => { parallelsState.options.source = v; });
  onOption('parallels-n', (v) => { parallelsState.options.n = Number(v); });
  onOption('parallels-weighting', (v) => { parallelsState.options.weighting = v; });
  onOption('parallels-floor', (v) => { parallelsState.options.minDocNgrams = Number(v); });
  const rangeEl = document.getElementById('parallels-range');
  if (rangeEl) rangeEl.addEventListener('change', () => {
    parallelsState.options.range = rangeEl.value.trim();
    parallelsState.results = null;
    parallelsOpenLines.clear();
    saveParallelsResults();
    saveParallelsUi();
    parallelsState.message = 'Settings changed — run the search again.';
    renderParallels();
  });
  panel.querySelectorAll('.parallels-add').forEach((btn) => {
    btn.addEventListener('click', () => addParallelAsSource(btn.dataset.museum));
  });
  panel.querySelectorAll('.parallels-check-box').forEach((box) => {
    box.addEventListener('change', () => toggleParallelCheck(box.dataset.museum, box.checked));
  });
  panel.querySelectorAll('.parallels-view').forEach((btn) => {
    btn.addEventListener('click', () => openTabletView(btn.dataset.museum));
  });
  const expandLinesRow = (btn) => {
    const tr = btn.closest('tr');
    if (tr.nextElementSibling && tr.nextElementSibling.classList.contains('parallels-lines-row')) return;
    const detail = document.createElement('tr');
    detail.className = 'parallels-lines-row';
    const cell = document.createElement('td');
    cell.colSpan = tr.children.length;
    detail.appendChild(cell);
    tr.after(detail);
    showParallelLines(btn.dataset.museum, btn.dataset.channel, cell);
  };
  panel.querySelectorAll('.parallels-lines-btn').forEach((btn) => {
    const key = btn.dataset.channel + '|' + btn.dataset.museum;
    btn.addEventListener('click', () => {
      const tr = btn.closest('tr');
      const open = tr.nextElementSibling;
      if (open && open.classList.contains('parallels-lines-row')) {
        open.remove();                       // second click folds it back up
        parallelsOpenLines.delete(key);
        saveParallelsUi();
        return;
      }
      expandLinesRow(btn);
      parallelsOpenLines.add(key);
      saveParallelsUi();
    });
    // A view left open stays open across re-renders and reloads alike.
    if (parallelsOpenLines.has(key)) expandLinesRow(btn);
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
      document.querySelectorAll('.pane-tab')
        .forEach(t => t.classList.toggle('active', t.dataset.tab === targetTab));

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
      if (targetTab === 'paradigms') {
        renderParadigmsTab();
      }
      if (targetTab === 'stats') {
        // Measured once and kept: switching away and back should not spend
        // the time again. "Measure again" is there for after an edit.
        renderStatsTab(false);
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
// textContent -> innerHTML escapes & < > but NOT quotes, which is fine in text
// and wrong in an attribute: a value containing a quote closes the attribute
// early and the rest of it becomes garbage markup. That is how the split
// button's data-keys="[\"K.2246|1\"]" arrived as "[" and the button died.
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

// ---- eBL token pill in the main header ---------------------------------
// The same reading as the pill inside Recon view, but visible without opening
// it: a token that has silently expired is the difference between an export
// and a wasted click. It only reports — the token itself is pasted in
// Settings, which is where it stays.
//
// A token is short-lived (eBL issues 24h ones), so this is re-read whenever
// the window regains focus rather than only at load.
const eblTokenPill = document.getElementById('ebl-token-pill');
const eblTokenPillText = document.getElementById('ebl-token-pill-text');

function updateEblTokenPill() {
  if (!eblTokenPill || !window.EblClient) return;
  const s = EblClient.tokenStatus();
  let cls = 'bad';
  let text = 'Not connected';
  let title = 'No eBL token — paste one in Settings';
  if (s.hasToken && !s.invalid && !s.expired) {
    if (s.hasWriteTexts) {
      cls = 'ok';
      text = 'eBL connected';
      title = 'Token valid, write:texts granted';
    } else {
      cls = 'warn';
      text = 'No write:texts';
      title = 'Token valid but cannot write to the corpus';
    }
    // An hour out from expiry, say so — long enough to finish and re-paste.
    if (s.expiresInSec != null && s.expiresInSec < 3600) {
      cls = 'warn';
      const mins = Math.max(1, Math.round(s.expiresInSec / 60));
      text = `Token expires in ${mins} min`;
      title = 'Refresh the token in Settings before exporting';
    }
  } else if (s.hasToken && s.expired) {
    text = 'Token expired';
    title = 'Paste a fresh token in Settings';
  } else if (s.hasToken && s.invalid) {
    text = 'Invalid token';
    title = 'The stored value is not a readable JWT';
  }
  eblTokenPill.classList.remove('ok', 'warn', 'bad');
  eblTokenPill.classList.add(cls);
  eblTokenPillText.textContent = text;
  eblTokenPill.title = title;
}

updateEblTokenPill();
// Settings opens in its own window, so returning here is the moment a newly
// pasted token becomes visible.
window.addEventListener('focus', updateEblTokenPill);

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
  const hasAlignments = Object.keys(lineAlignments).length > 0;
  const hasLemmas = Object.keys(lemmaChoices).length > 0;
  const hasExports = Object.keys(exportedSections).length > 0;
  const hasRevisions = Object.keys(revisedSections).length > 0;
  const hasIssues = exportIssues.length > 0;
  const hasGlossary = Object.keys(projectGlossary).length > 0;
  if (!hasReconstructed && !hasTranslations && !hasNotes && !hasParallels
      && !hasVariants && !hasAlignments && !hasLemmas && !hasExports
      && !hasRevisions && !hasIssues && !hasGlossary) return;

  try {
    const data = {
      reconstructed: reconstructedLines,
      translations: translationLines,
      notes: noteLines,
      parallels: parallelLines,
      variants: variantLines,
      alignments: lineAlignments,
      lemmas: lemmaChoices,
      glossary: projectGlossary,
      exported: exportedSections,
      revised: revisedSections,
      issues: exportIssues,
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
      if (data.alignments) Object.assign(lineAlignments, data.alignments);
      if (data.lemmas) Object.assign(lemmaChoices, data.lemmas);
      if (data.exported) Object.assign(exportedSections, data.exported);
      if (data.revised) Object.assign(revisedSections, data.revised);
      if (Array.isArray(data.issues)) exportIssues.push(...data.issues);
      if (data.glossary) {
        projectGlossary = data.glossary;
        applyProjectGlossary();
      }
      migrateSentMarks();
      updateReportsBadge();
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
  const signsCheckbox = document.getElementById('search-signs');
  const scopeSelect = document.getElementById('search-scope');
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
  scopeSelect.addEventListener('change', () => performSearch());
  signsCheckbox.addEventListener('change', () => {
    // Sign matching subsumes both: apparatus is stripped by the conversion
    // itself, and a code sequence is not a regex.
    regexCheckbox.disabled = signsCheckbox.checked;
    stripCheckbox.disabled = signsCheckbox.checked;
    performSearch();
  });

  // Update button states when search input changes
  function updateReplaceButtons() {
    const hasQuery = searchInput.value.length > 0;
    const hasResults = currentResults.length > 0;
    // Replace is off while the apparatus is ignored. A match found in the
    // stripped text spans the brackets that were dropped inside it, so writing
    // over it would leave an unbalanced brace or bracket in the source.
    const canReplace = hasQuery && hasResults && !stripping() && !signsCheckbox.checked;
    replaceBtn.disabled = !canReplace || selectedResultIndex < 0;
    replaceAllBtn.disabled = !canReplace;
    // A disabled button that will not say why is worse than no button.
    const why = !hasQuery ? 'Type something to search for first.'
      : !hasResults ? 'Nothing matches, so there is nothing to replace.'
      : stripping() ? 'Replace is off while the apparatus is ignored: a match found in'
          + ' the stripped text spans brackets that were dropped inside it, and writing'
          + ' over it would leave them unbalanced.'
      : signsCheckbox.checked ? 'Replace is off while matching by signs: a run of sign'
          + ' codes does not say which spelling to write back.'
      : '';
    replaceAllBtn.title = why || 'Replace every match';
    replaceBtn.title = why || (selectedResultIndex < 0
      ? 'Pick a result from the list first' : 'Replace the selected match');
  }

  searchInput.addEventListener('input', updateReplaceButtons);

  // One regex for all three paths below, so the preview, Replace and Replace
  // All can never disagree about what the pattern means. The "m" is the point:
  // without it "^" anchors to the start of the whole file, which is why an
  // anchored Replace All used to list matches and then change nothing.
  // Occurrences of a sign-code run, as character spans over the original
  // text. Per line, since a sign run should not silently cross a line break.
  // Words are converted one by one and their code counts consumed off the
  // stream, so a hit maps back to the exact words whose signs carry it.
  function findSignSpans(content, needle) {
    const conv = parallelsState.converter;
    const spans = [];
    let lineStart = 0;
    for (const rawLine of String(content || '').split('\n')) {
      const words = [];
      const wordRe = /\S+/g;
      let w;
      while ((w = wordRe.exec(rawLine)) !== null) words.push({ t: w[0], s: w.index });

      const codes = [];
      const owner = [];               // owner[k] = index of the word code k came from
      for (let wi = 0; wi < words.length; wi++) {
        let converted;
        try { converted = conv.convertLine(words[wi].t).codes; } catch (_) { converted = []; }
        for (const code of converted) { codes.push(code); owner.push(wi); }
      }

      let lastKey = '';
      for (let i = 0; i + needle.length <= codes.length; i++) {
        let ok = true;
        for (let k = 0; k < needle.length; k++) {
          if (codes[i + k] !== needle[k]) { ok = false; break; }
        }
        if (!ok) continue;
        const wa = words[owner[i]];
        const wb = words[owner[i + needle.length - 1]];
        const key = wa.s + '|' + wb.s;
        if (key === lastKey) continue;   // several hits inside one word span
        lastKey = key;
        spans.push({ start: lineStart + wa.s, end: lineStart + wb.s + wb.t.length, m: null });
      }
      lineStart += rawLine.length + 1;
    }
    return spans;
  }

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
    let text = content.slice(from, to);
    let a = match.start - from;
    let b = match.end - from;
    // The row already names the line ("o 23a") and its § (the chip), so the
    // excerpt drops that prefix — except when the match itself starts inside
    // it, where cutting would hide part of what was found.
    const pfx = text.match(/^\s*(?:\u00a7\d+[a-z]?\s+)?(?:\d+['\u2019]?[a-z]?\.\s+)?/)[0].length;
    if (pfx > 0 && a >= pfx) {
      text = text.slice(pfx);
      a -= pfx;
      b -= pfx;
    }
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
  // Where an offset in the composite search document lands.
  //
  // The document is built for searching, one "§N reading" per line, and does
  // not exist anywhere else — so a hit in it has to be carried back to the
  // reading it came from before anything can be written.
  //
  // Returns null for a match that starts inside the "§N " marker or runs past
  // the end of its line: neither can be written back without damaging a line
  // number or spilling one reading into the next.
  function compositeSpot(doc, starts, match) {
    const li = lineIndexOf(starts, match.start);
    const lineStart = starts[li];
    const lineEnd = starts[li + 1] !== undefined ? starts[li + 1] - 1 : doc.length;
    if (match.end > lineEnd) return null;
    const head = /^§(\d+)([a-z]?)\s/.exec(doc.slice(lineStart, lineEnd));
    if (!head) return null;
    const from = lineStart + head[0].length;
    if (match.start < from) return null;
    return {
      lineNum: parseInt(head[1], 10),
      vi: variantIndexOf(head[2]),
      start: match.start - from,
      end: match.end - from,
    };
  }

  // Replace inside the composite. The readings live in the score, not in a
  // file, so this writes through writeReading and saves the score data rather
  // than a manuscript.
  function replaceInComposite(matches, replacement, doc) {
    const starts = lineStartsOf(doc);
    const byReading = new Map();
    let skipped = 0;
    for (const mt of matches) {
      const spot = compositeSpot(doc, starts, mt);
      if (!spot) { skipped++; continue; }
      const key = spot.lineNum + '|' + spot.vi;
      if (!byReading.has(key)) byReading.set(key, { lineNum: spot.lineNum, vi: spot.vi, hits: [] });
      byReading.get(key).hits.push({ spot, m: mt.m });
    }

    let replaced = 0;
    for (const entry of byReading.values()) {
      const reading = variantsFor(entry.lineNum)[entry.vi];
      if (!reading) { skipped += entry.hits.length; continue; }
      const before = reading.text || '';
      let text = before;
      // Back to front, so the offsets ahead of each splice stay valid.
      entry.hits.sort((a, b) => a.spot.start - b.spot.start);
      for (let i = entry.hits.length - 1; i >= 0; i--) {
        const h = entry.hits[i];
        text = text.slice(0, h.spot.start)
          + expandReplacement(replacement, h.m, h.spot.start, before)
          + text.slice(h.spot.end);
        replaced++;
      }
      if (text !== before) writeReading(entry.lineNum, entry.vi, text);
    }
    return { replaced, skipped };
  }

  replaceBtn.addEventListener('click', () => {
    if (selectedResultIndex < 0 || currentResults.length === 0) return;

    let flatIndex = 0;
    for (const group of currentResults) {
      for (const match of group.matches) {
        if (flatIndex === selectedResultIndex) {
          if (group.id === '__composite__') {
            const done = replaceInComposite([match], replaceInput.value, group.content
              || compositeSearchDoc());
            if (done.replaced) { saveScoreDataToFile(); renderScore(); }
            performSearch(selectedResultIndex);
            return;
          }
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

    // Save undo state for all affected manuscripts. The composite is not one
    // of them: its readings live in the score, and the undo stack holds
    // manuscript files.
    const affectedIds = currentResults.map((g) => g.id)
      .filter((id) => id !== '__composite__');
    saveUndoState(affectedIds, `Replace all: "${query}" → "${replacement}"`);

    let totalReplaced = 0;

    let compositeSkipped = 0;
    for (const group of currentResults) {
      if (group.id === '__composite__') {
        const done = replaceInComposite(group.matches, replacement,
          group.content || compositeSearchDoc());
        totalReplaced += done.replaced;
        compositeSkipped += done.skipped;
        if (done.replaced) saveScoreDataToFile();
        continue;
      }
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

    showComposeReport('Replace', [
      '<div class="report-outcome ' + (totalReplaced ? 'is-changed' : 'is-kept') + '">'
        + '<strong>' + escapeHtml(totalReplaced
            ? totalReplaced + ' occurrence' + (totalReplaced === 1 ? '' : 's') + ' replaced'
            : 'Nothing was replaced') + '</strong>'
        + '<span>' + escapeHtml('"' + query + '" → "' + replacement + '"') + '</span>'
        + '</div>',
      compositeSkipped ? noteBlock(compositeSkipped + ' match(es) in the composite were'
        + ' left alone: they start inside a § marker or run past the end of a reading,'
        + ' and writing those back would damage a line number.', 'warn') : '',
    ], 'replace');
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

    const signMode = signsCheckbox.checked;
    let regex = null;
    let signNeedle = null;
    let signNeedles = null;
    let signNote = '';

    if (signMode) {
      if (!window.EblAtfSigns) {
        resultsContainer.innerHTML = '<div class="search-empty">The sign modules are not loaded.</div>';
        return;
      }
      // The sign table is fetched on first use; search again once it is here.
      if (!parallelsState.converter) {
        resultsContainer.innerHTML = '<div class="search-empty">Loading the sign table&hellip;</div>';
        ensureAtfConverter().then(() => performSearch(preserveIndex))
          .catch((err) => {
            resultsContainer.innerHTML =
              `<div class="search-empty">Could not load the sign table: ${escapeHtml(err.message)}</div>`;
          });
        return;
      }
      const converted = parallelsState.converter.convertLine(query);
      signNeedle = converted.codes;
      // The other spelling of ana/ina is a needle of its own.
      signNeedles = [signNeedle];
      for (const variant of prepositionVariants(query)) {
        const codes = parallelsState.converter.convertLine(variant).codes;
        const key = codes.join(' ');
        if (codes.length && !signNeedles.some((nd) => nd.join(' ') === key)) {
          signNeedles.push(codes);
        }
      }
      if (!signNeedle.length) {
        currentResults = [];
        selectedResultIndex = -1;
        updateReplaceButtons();
        resultsContainer.innerHTML =
          '<div class="search-empty">Nothing in the query resolves to a sign.</div>';
        return;
      }
      const names = (converted.tokens || []).map((t) => t.name || (t.codes && t.codes[0]) || '?');
      signNote = names.length ? names.join(' ') : signNeedle.join(' ');
      if (signNeedles.length > 1) signNote += ' (ana/ina matched in both spellings)';
      if (converted.unresolved && converted.unresolved.length) {
        signNote += ` &middot; unresolved: ${converted.unresolved.join(', ')}`;
      }
    } else {
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
    // The composite scope searches one virtual document; hits land in the
    // score rather than in a source file.
    const compositeScope = scopeSelect.value === 'composite';
    const searchTargets = compositeScope
      ? [['__composite__', { siglum: 'Composite text', content: compositeSearchDoc() }]]
      : Object.entries(manuscripts);
    for (const [id, ms] of searchTargets) {
      const content = ms.content;
      const starts = lineStartsOf(content);
      const lineLabels = tabletLineLabels(content);
      // Searched with the apparatus removed, but every offset is mapped back,
      // so what is listed, highlighted and replaced is the text as it stands.
      const stripped = (!signMode && strip) ? EblAtfSigns.stripApparatus(content) : null;
      const subject = stripped ? stripped.text : content;
      const matches = [];

      let spans;
      if (signMode) {
        spans = [];
        const seen = new Set();
        for (const nd of signNeedles) {
          for (const sp of findSignSpans(content, nd)) {
            const key = sp.start + '|' + sp.end;
            if (!seen.has(key)) { seen.add(key); spans.push(sp); }
          }
        }
        spans.sort((a, b) => a.start - b.start);
      } else {
        spans = [];
        regex.lastIndex = 0;
        let m;
        while ((m = regex.exec(subject)) !== null) {
          // A zero-length match never advances lastIndex on its own.
          if (m[0].length === 0) { regex.lastIndex++; continue; }
          // The end is taken from the last matched character rather than the
          // one after it, so apparatus sitting just past the match is not
          // swallowed by a replacement.
          spans.push({
            m,
            start: stripped ? stripped.map[m.index] : m.index,
            end: stripped
              ? stripped.map[m.index + m[0].length - 1] + 1
              : m.index + m[0].length,
          });
        }
      }

      for (const span of spans) {
        const match = {
          m: span.m,
          start: span.start,
          end: span.end,
          lineIndex: lineIndexOf(starts, span.start),
          endLineIndex: lineIndexOf(starts, span.end - 1),
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
          // Kept because the composite document is built for the search and
          // exists nowhere else. A replace has to map its offsets back against
          // the very text they were found in, not a document rebuilt later.
          content,
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
      resultsContainer.innerHTML = signMode
        ? `<div class="search-empty">No matches found &mdash; searched by sign as: ${signNote}</div>`
        : '<div class="search-empty">No matches found</div>';
      return;
    }

    const stripNote = signMode
      ? ` &middot; matched by sign: ${signNote} &mdash; untick Signs to replace`
      : (strip ? ' &middot; apparatus ignored &mdash; untick to replace' : '');
    let html = `<div class="search-count">${totalMatches} match${totalMatches !== 1 ? 'es' : ''} in ${results.length} manuscript${results.length !== 1 ? 's' : ''}${stripNote}</div>`;

    let flatIndex = 0;
    for (const group of results) {
      html += `<div class="search-result-group">`;
      html += `<div class="search-result-header" data-id="${group.id}">${escapeHtml(group.siglum)} (${group.matches.length})</div>`;

      for (const match of group.matches) {
        if (group.id === '__composite__') {
          const secLabel = match.sec ? `§${match.sec}` : `line ${match.lineNum}`;
          html += `<div class="search-result-item" data-id="${group.id}" data-line="${match.lineNum}" data-index="${flatIndex}">`;
          html += `<a class="search-result-line" href="#" data-nav="score" data-sec="${match.sec || ''}" ` +
                  `title="Show ${secLabel} in the score">${secLabel}</a>`;
          html += '<span class="search-result-sec search-result-sec-none"></span>';
          html += `<span class="search-result-text">` + match.highlighted + `</span>`;
          html += '</div>';
          flatIndex++;
          continue;
        }
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
        html += `<span class="search-result-text">` + match.highlighted + `</span>`;
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
      el.addEventListener('click', () => {
        if (el.dataset.id === '__composite__') {
          modal.classList.add('hidden');
          const tab = document.querySelector('.pane-tab[data-tab="score"]');
          if (tab && !tab.classList.contains('active')) tab.click();
          return;
        }
        openSourceAt(el.dataset.id, 0);
      });
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

// exportBtn opens the two-item menu; see the export wiring further down.
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
        // Cleared like the rest, or a reload leaves stale alignments behind.
        Object.keys(lineAlignments).forEach(k => delete lineAlignments[k]);
        Object.keys(lemmaChoices).forEach(k => delete lemmaChoices[k]);
        Object.keys(exportedSections).forEach(k => delete exportedSections[k]);
        Object.keys(revisedSections).forEach(k => delete revisedSections[k]);
        exportIssues.length = 0;
        if (data.reconstructed) Object.assign(reconstructedLines, data.reconstructed);
        if (data.translations) Object.assign(translationLines, data.translations);
        if (data.notes) Object.assign(noteLines, data.notes);
        if (data.parallels) Object.assign(parallelLines, data.parallels);
        if (data.variants) Object.assign(variantLines, data.variants);
      if (data.alignments) Object.assign(lineAlignments, data.alignments);
      if (data.lemmas) Object.assign(lemmaChoices, data.lemmas);
      if (data.exported) Object.assign(exportedSections, data.exported);
      if (data.revised) Object.assign(revisedSections, data.revised);
      if (Array.isArray(data.issues)) exportIssues.push(...data.issues);
      if (data.glossary) {
        projectGlossary = data.glossary;
        applyProjectGlossary();
      }
      migrateSentMarks();
      updateReportsBadge();
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
        // Cleared like the rest, or a reload leaves stale alignments behind.
        Object.keys(lineAlignments).forEach(k => delete lineAlignments[k]);
        Object.keys(lemmaChoices).forEach(k => delete lemmaChoices[k]);
        Object.keys(exportedSections).forEach(k => delete exportedSections[k]);
        Object.keys(revisedSections).forEach(k => delete revisedSections[k]);
        exportIssues.length = 0;
        if (data.reconstructed) Object.assign(reconstructedLines, data.reconstructed);
        if (data.translations) Object.assign(translationLines, data.translations);
        if (data.notes) Object.assign(noteLines, data.notes);
        if (data.parallels) Object.assign(parallelLines, data.parallels);
        if (data.variants) Object.assign(variantLines, data.variants);
      if (data.alignments) Object.assign(lineAlignments, data.alignments);
      if (data.lemmas) Object.assign(lemmaChoices, data.lemmas);
      if (data.exported) Object.assign(exportedSections, data.exported);
      if (data.revised) Object.assign(revisedSections, data.revised);
      if (Array.isArray(data.issues)) exportIssues.push(...data.issues);
      if (data.glossary) {
        projectGlossary = data.glossary;
        applyProjectGlossary();
      }
      migrateSentMarks();
      updateReportsBadge();
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

  const glossaryBtn = document.getElementById('glossary-btn');
  if (glossaryBtn) glossaryBtn.addEventListener('click', showGlossaryManager);

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
// EXPORT TO eBL
// ===========================================
//
// Compiles the eBL ATF artifact from the current score + manuscripts.json,
// shows it read-only, and sends it to the corpus chapter configured under
// projectConfig.ebl.target — either the whole chapter, or one section at a
// time through POST /lines.

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
(() => {
  const btn = document.getElementById('ebl-lines-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const target = (projectConfig && projectConfig.ebl && projectConfig.ebl.target) || null;
    if (!target) return;
    btn.disabled = true;
    try {
      // Read it fresh: the dialog may have been open a while, and the whole
      // point is to see the order as it stands now.
      await loadExportPreflight(target);
      renderExportPreflight();
      renderExportEffect();
      showComposeReport('What eBL holds', chapterListingBlocks(), 'ebl-lines');
    } finally {
      btn.disabled = false;
    }
  });
})();
const exportEffectEl = document.getElementById('export-effect');
const exportOptAlignmentEl = document.getElementById('export-opt-alignment');
const exportOptLemmasEl = document.getElementById('export-opt-lemmas');
const exportOptManuscriptsEl = document.getElementById('export-opt-manuscripts');
const exportOptSaveAtfEl = document.getElementById('export-opt-save-atf');

// What the target chapter holds right now, from the preflight GET. null until
// it resolves; { error } when the chapter could not be read.
let exportPreflight = null;

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
  // Without a local validator, "Validate only" cannot actually check
  // anything — eBL is then the only judge. Say that on the mode rather than
  // leaving it looking like a check that passed.
  const hint = document.getElementById('export-validate-hint');
  if (hint) {
    hint.textContent = localValidatorAvailable
      ? 'Check the ATF against the eBL grammar. Nothing is sent to eBL.'
      : 'No local validator here, so nothing can be checked — eBL validates on send.';
  }
}

// Kick off the probe in the background; it'll resolve before the user opens
// Recon view in any realistic scenario.
probeRuntimeCapabilities();

// ---- The export artifact -------------------------------------------------
//
// The chapter ATF, compiled from the score on demand.
//
// This used to be a full-screen Ace editor whose text could be hand-edited,
// with the edits diffed back into the score and the manuscript .txt files. That
// round trip is gone. The score is the only place text is written now, and this
// is a read-only rendering of it — one direction, so the two cannot disagree.

let exportArtifactAtf = '';   // the ATF as last compiled, ready to send

// The whole chapter, or one section when lineNum is given. Building a section
// on its own is what the omen icons and "Update one line" validate and send,
// and it means an ATF error in §37 cannot block a fix to §1.
async function buildExportArtifact(lineNum) {
  const { scoreLines } = buildScore();
  if (!manuscriptsMeta) {
    manuscriptsMeta = await FileSystem.readManuscriptsMeta(dirHandle) || { version: 1, manuscripts: [] };
  }
  // Newly added files show up with default rows rather than vanishing.
  // index.json holds sigla with the extension in some projects and without it in
  // others, so a siglum may already end in .txt — appending regardless produced
  // "K.2246.txt.txt" and an entry matching no file.
  const withTxt = (s) => (/\.txt$/.test(s) ? s : s + '.txt');
  const filesOnDisk = Object.values(manuscripts).map((m) => withTxt(m.siglum));
  manuscriptsMeta = EblClient.reconcileManuscripts(manuscriptsMeta, filesOnDisk);

  const only = (map) => (lineNum == null
    ? (map || {})
    : (map && map[lineNum] !== undefined ? { [lineNum]: map[lineNum] } : {}));

  const result = await EblAtf.buildChapterAtf({
    scoreLines: only(scoreLines),
    reconstructedLines: only(reconstructedLines),
    translationLines: only(translationLines),
    noteLines: only(noteLines),
    parallelLines: only(parallelLines),
    variantLines: only(variantLines),
    manuscriptsMeta,
    eblSiglumByFile: await EblAtf.buildEblSiglumMap(manuscriptsMeta, EblClient),
  });
  return EblAtf.stripFormatting(result.atf);
}

// Paint the preview pane, marking any rows the validator rejected. Line
// numbers come back 1-based and address the stripped text, which is exactly
// what is shown here, so they index straight in.
function renderExportPreview(atf, errors) {
  const pre = document.getElementById('export-preview');
  const count = document.getElementById('export-preview-count');
  if (!pre) return;
  const rows = String(atf || '').split('\n');
  const bad = new Set((errors || []).map((e) => e.line).filter((n) => n != null));
  pre.innerHTML = rows.map((row, i) => {
    const html = escapeHtml(row) || '&nbsp;';
    return bad.has(i + 1) ? `<span class="preview-error">${html}</span>` : html;
  }).join('\n');
  if (count) {
    const n = countArtifactLines();
    count.textContent = `· ${n} chapter line${n === 1 ? '' : 's'}, ${rows.length} rows`;
  }
}

// ---- Export modal ----

// How many chapter lines would be sent. Counted from the live editor buffer
// rather than the last compiled lineMap, so hand-edits in the Recon view are
// reflected. Reconstruction rows are the unindented "N. ..." ones; witness
// rows carry a siglum first.
function countArtifactLines() {
  if (!exportArtifactAtf) return 0;
  return exportArtifactAtf
    .split('\n')
    .filter((row) => /^\d+['’]?\.\s/.test(row))
    .length;
}

// The section typed into the line picker, or null. Kept separate from the
// mode so an empty box is a refusal rather than a guess at §1.
function selectedExportLine() {
  const el = document.getElementById('export-line-num');
  const n = el ? parseInt(el.value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// The sections a range covers, in order. Either end may be typed first, and a
// range of one is just a single line.
function selectedExportRange() {
  const a = selectedExportLine();
  const el = document.getElementById('export-line-to');
  const b = el ? parseInt(el.value, 10) : NaN;
  if (a == null) return null;
  if (!Number.isFinite(b) || b < 1) return [a];
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  // Only sections this project actually has: a range is a convenience, not an
  // instruction to invent the gaps in it.
  const have = new Set(Object.keys(buildScore().scoreLines).map(Number));
  const out = [];
  for (let n = from; n <= to; n++) if (have.has(n)) out.push(n);
  return out;
}

// The artifact for the sections being sent, and nothing else. Built so an ATF
// error somewhere else in the chapter cannot block an update — the rows this
// sends are the only rows it should have to answer for.
//
// Takes one section or a list of them; a range validates exactly what it sends.
async function buildSingleLineAtf(which) {
  const wanted = Array.isArray(which) ? which : [which];
  const keep = new Set(wanted.map(Number));
  const { scoreLines } = buildScore();
  const only = (map) => {
    const out = {};
    for (const n of keep) if (map && map[n] !== undefined) out[n] = map[n];
    return out;
  };
  const meta = manuscriptsMeta || { version: 1, manuscripts: [] };
  const result = await EblAtf.buildChapterAtf({
    scoreLines: only(scoreLines),
    reconstructedLines: only(reconstructedLines),
    translationLines: only(translationLines),
    noteLines: only(noteLines),
    parallelLines: only(parallelLines),
    variantLines: only(variantLines),
    manuscriptsMeta: meta,
    eblSiglumByFile: await EblAtf.buildEblSiglumMap(meta, EblClient),
  });
  return EblAtf.stripFormatting(result.atf);
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
      // Which sections eBL already holds. A section it has is replaced where
      // it stands; one it lacks can only be appended, because POST /lines has
      // no insert. Knowing which is which before the send is the difference
      // between an ordered chapter and a surprise at the bottom of it.
      has: new Set(numbers.map((n) => String(n))),
      // Enough of each line to recognise it, in the order eBL holds them —
      // which is the only place the order is visible at all.
      lines: (chapter.lines || []).map((l) => ({
        number: String(l.number),
        text: ((l.variants || [])[0] && ((l.variants[0].reconstructionTokens || [])
          .map((t) => t.value).join(' '))) || '',
      })),
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
  } else if (mode === 'alignment') {
    html = 'Sends which witness word answers to which word of the reading, for every'
      + ' section aligned here. Other sections are sent back unchanged.';
  } else if (mode === 'line') {
    const n = selectedExportLine();
    html = n == null
      ? 'Type the section to update.'
      : (sectionsNotOnEbl([n]) || []).length
          ? `<strong>§${n}</strong> is not on eBL yet.` + appendNote([n]).replace(/^<br>/, ' ')
          : `Replaces <strong>§${n}</strong> in place. Every other line is untouched, `
            + 'and their lemmatization and alignment survive.';
  } else if (mode === 'range') {
    const nums = selectedExportRange();
    html = !nums || !nums.length
      ? 'Type the first and last section to update.'
      : `Replaces <strong>${nums.length}</strong> line${nums.length === 1 ? '' : 's'} `
        + `(§${nums[0]}–§${nums[nums.length - 1]}) in one request. Lines outside the range `
        + 'are untouched, and their lemmatization and alignment survive.'
        + '<br>A line eBL already holds is rewritten where it stands — this never moves '
        + 'anything, so a line already out of position stays there.'
        + appendNote(nums);
  } else if (mode === 'trim') {
    const plan = trimPlan(selectedTrimFrom());
    if (!exportPreflight || exportPreflight.error || !exportPreflight.lines) {
      html = 'The chapter could not be read, so there is nothing to trim.';
    } else if (!plan) {
      html = `Type the position to cut from — 1 to ${exportPreflight.lines.length}. `
        + 'Press “list them” above to see what sits where.';
    } else {
      const names = plan.going.slice(0, 14).map((g) => '§' + g.number).join(', ');
      html = `Removes <strong>${plan.going.length}</strong> line`
        + `${plan.going.length === 1 ? '' : 's'} from position <strong>${plan.from}</strong> `
        + `to the end (${names}${plan.going.length > 14 ? ', …' : ''}). `
        + `<strong>${plan.keeping}</strong> line${plan.keeping === 1 ? '' : 's'} above are `
        + 'untouched and keep their lemmas and alignment. '
        + 'Their lemmatization and alignment on eBL go with the removed lines — send those '
        + 'sections again afterwards to put them back.';
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
    : mode === 'alignment' ? 'Check the alignment'
    : mode === 'line' ? 'Update this line'
    : mode === 'range' ? 'Update these lines'
    : mode === 'trim' ? 'Remove them'
    : 'Replace all lines';
}

// What eBL holds, read back from its API once the write is done.
//
// eBL serves the chapter page from a cache, so what the browser shows there
// can lag a send by a long way — a trim that had already taken effect still
// read as 60 lines on the site while the API said 42, which looks exactly
// like an export that did nothing. The API is the authority, so the result
// says what it actually returned rather than leaving the two to be
// reconciled by eye.
//
// Never fatal: the write has happened either way, and a failed read-back is
// only a missing sentence.
async function readBackNote(target) {
  try {
    await loadExportPreflight(target);
    renderExportPreflight();
    renderExportEffect();
  } catch (_) {
    return '';
  }
  if (!exportPreflight || exportPreflight.error) return '';
  const { lineCount, first, last } = exportPreflight;
  return '<div class="export-readback">eBL now holds <strong>' + lineCount + '</strong> line'
    + (lineCount === 1 ? '' : 's')
    + (first && last ? ` (§${first}–§${last})` : '')
    + ' — read back from its API just now. The chapter page on eBL is cached, so'
    + ' reload it there before believing an older number.</div>';
}

// File what a dialog export did, the way the omen icon files what it did.
//
// Sends from the Export dialog kept no record at all: no ✓ on the section, no
// entry on the reports page. An overnight run that stalled on the lemmas left
// nothing behind to say the lines had gone.
//
// Called after the send, so it describes what actually happened; the sections
// themselves are marked the moment their lines land, which is earlier.
function fileExportReport(label, nums, res, afterBlocks) {
  const warnings = (res && res.warnings) || [];
  const added = ((res && res.results) || []).filter((r) => r.inserted);
  const notes = warnings.slice(0, 40);
  const kind = warnings.length ? 'notice' : 'ok';
  const blocks = [
    outcomeBanner('sent', label, ((res && res.results) || []).length
      + ' line(s) written' + (added.length ? ', ' + added.length + ' new to the chapter' : '')),
    ...(notes.length ? [rawBlock(notes.join(String.fromCharCode(10)))] : []),
    ...(afterBlocks || []),
  ];
  for (const n of (nums || [])) supersedeExportIssues('send', n);
  addExportIssue({
    sec: (nums && nums.length === 1) ? nums[0] : null,
    part: 'send',
    kind,
    title: label + ' sent' + (warnings.length
      ? ' — ' + warnings.length + ' thing(s) to check on eBL' : ''),
    notes,
    report: blocks.join(''),
    done: !warnings.length,
    how: 'sent clean',
  });
  updateReportsBadge();
  saveScoreDataToFile();
}

// The tail a trim would remove: everything from `from` (1-based position)
// down to the last line eBL holds.
//
// Only ever a tail. Deleting from the middle would leave every position after
// the hole meaning something different from what the listing showed, and the
// indices in the payload are positions — so a gap is how you delete the wrong
// lines. A tail cannot renumber anything that is left.
function trimPlan(from) {
  if (!exportPreflight || exportPreflight.error || !exportPreflight.lines) return null;
  const lines = exportPreflight.lines;
  const at = parseInt(from, 10);
  if (!Number.isFinite(at) || at < 1 || at > lines.length) return null;
  const going = lines.slice(at - 1).map((l, i) => ({
    position: at + i, number: l.number, text: l.text,
  }));
  return {
    from: at,
    total: lines.length,
    going,
    // 0-based, which is what eBL's `deleted` counts in.
    indices: going.map((g) => g.position - 1),
    keeping: at - 1,
  };
}

function selectedTrimFrom() {
  const el = document.getElementById('export-trim-from');
  const n = el ? parseInt(el.value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// What eBL actually holds, in the order it holds it.
//
// The chapter's order is invisible from here otherwise: the export dialog can
// say "58 lines (§1–52)" while six of them sit in the wrong place, and nothing
// distinguishes a chapter in sequence from one with a tail of appended
// strays. Read-only — it writes nothing and is meant to be looked at before
// deciding whether a range send is enough or the chapter needs rebuilding.
//
// Three things are worth seeing, and they are different faults:
//   duplicate     the same § twice, which is what an append makes when the
//                 section was already there under a number that did not match
//   out of order  a § lower than the one above it
//   not here      a line this project has no section for
function chapterListingBlocks() {
  if (!exportPreflight || exportPreflight.error || !exportPreflight.lines) {
    return [noteBlock('The chapter could not be read.', 'bad')];
  }
  const lines = exportPreflight.lines;
  if (!lines.length) return [noteBlock('The chapter is empty.')];

  const mine = new Set(Object.keys(buildScore().scoreLines).map(String));
  const seen = new Map();
  for (const l of lines) seen.set(l.number, (seen.get(l.number) || 0) + 1);

  let highest = -Infinity;
  let breaks = 0, dupes = 0, orphans = 0;
  const rows = lines.map((l, i) => {
    const n = parseInt(l.number, 10);
    const flags = [];
    if (seen.get(l.number) > 1) { flags.push('duplicate'); }
    if (Number.isFinite(n) && n < highest) { flags.push('out of order'); breaks++; }
    if (!mine.has(l.number)) { flags.push('not in this project'); orphans++; }
    if (Number.isFinite(n) && n > highest) highest = n;
    return { i, number: l.number, text: l.text, flags };
  });
  for (const [, n] of seen) if (n > 1) dupes += n - 1;

  const head = '<div class="report-counts">'
    + `<span class="report-count"><b>${lines.length}</b> lines on eBL</span>`
    + `<span class="report-count${breaks ? ' is-done' : ''}"><b>${breaks}</b> out of order</span>`
    + `<span class="report-count"><b>${dupes}</b> duplicate</span>`
    + `<span class="report-count"><b>${orphans}</b> not in this project</span>`
    + '</div>';

  // Where the chapter would have to be cut to put it right.
  //
  // Not where the order breaks — that is where the strays were dumped, and
  // deleting from there achieves nothing: a section numbered below what
  // remains is simply appended to the end again. What matters is the lowest
  // misplaced §. Every line from that number onward has to go and be sent
  // again in order, because only then is each one above everything left.
  const misplaced = rows.filter((r) => r.flags.indexOf('out of order') >= 0)
    .map((r) => parseInt(r.number, 10)).filter((n) => Number.isFinite(n));
  const lowest = misplaced.length ? Math.min.apply(null, misplaced) : null;
  const cut = lowest == null ? -1
    : rows.findIndex((r) => Number.isFinite(parseInt(r.number, 10))
        && parseInt(r.number, 10) >= lowest);
  const note = lowest == null
    ? noteBlock('Every line is in ascending order.', 'good')
    : noteBlock('§' + lowest + ' is the lowest section out of place. To put the chapter'
        + ' in order, everything from position ' + (cut + 1) + ' (§' + rows[cut].number
        + ') to the end — ' + (rows.length - cut) + ' lines — has to be removed and sent'
        + ' again in ascending order. Trimming only the strays at the bottom would not'
        + ' work: a section numbered below what remains is appended to the end again.'
        + ' The lines above position ' + (cut + 1) + ' keep their lemmas and alignment.',
        'warn');

  const body = '<table class="report-table"><thead><tr>'
    + '<th>#</th><th>§</th><th>reading</th><th></th></tr></thead><tbody>'
    + rows.map((r) => '<tr class="' + (r.flags.length ? 'is-divergent' : '') + '">'
        + `<td class="report-nums">${r.i + 1}</td>`
        + `<td class="report-nums">${escapeHtml(r.number)}</td>`
        + `<td>${escapeHtml(String(r.text).slice(0, 70))}</td>`
        + `<td class="report-thin">${escapeHtml(r.flags.join(', '))}</td>`
        + '</tr>').join('')
    + '</tbody></table>';

  return [head, note, body,
    noteBlock('Nothing was sent or changed — this only reads the chapter.')];
}

// Of these sections, the ones eBL does not hold yet.
function sectionsNotOnEbl(nums) {
  if (!exportPreflight || exportPreflight.error || !exportPreflight.has) return null;
  return (nums || []).filter((n) => !exportPreflight.has.has(String(n)));
}

// What appending would actually do to the order.
//
// eBL has no insert: a section it does not hold is added at the end. That is
// only a problem when the section belongs somewhere else. A section numbered
// above everything eBL holds belongs at the end, so appending it — and its
// neighbours after it, since a range is sent in ascending order — puts the
// chapter in exactly the right order and disturbs nothing below.
//
// So the two cases are worth telling apart. Warning about both alike said
// "§53–§60 will be out of order" when the end was precisely where they go.
function appendPlan(nums) {
  const missing = sectionsNotOnEbl(nums);
  if (!missing) return null;
  const held = [...exportPreflight.has]
    .map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
  const highest = held.length ? Math.max.apply(null, held) : 0;
  return {
    missing,
    highest,
    // Above everything eBL holds: the end is where they belong.
    afterEnd: missing.filter((n) => n > highest),
    // Below it: the end is not where they belong.
    outOfOrder: missing.filter((n) => n <= highest),
  };
}

// The sentence describing an append, or '' when there is nothing to append.
function appendNote(nums) {
  const plan = appendPlan(nums);
  if (!plan || !plan.missing.length) return '';
  const list = (ns) => '§' + ns.slice(0, 12).join(', §') + (ns.length > 12 ? ', …' : '');
  if (!plan.outOfOrder.length) {
    return `<br><strong>${plan.afterEnd.length}</strong> of them `
      + (plan.afterEnd.length === 1 ? 'is' : 'are') + ' not on eBL yet ('
      + list(plan.afterEnd) + `). They are numbered above everything eBL holds `
      + `(highest is §${plan.highest}), so appending them puts them in the right `
      + 'place — nothing below is disturbed.';
  }
  return `<br><strong>${plan.outOfOrder.length}</strong> of them `
    + (plan.outOfOrder.length === 1 ? 'is' : 'are') + ' not on eBL yet ('
    + list(plan.outOfOrder) + `) and would land at the <strong>end</strong> of the `
    + `chapter rather than in place, because eBL appends new lines and cannot insert. `
    + '“Replace all lines” is what writes the whole chapter in order.'
    + (plan.afterEnd.length
        ? ` (The other ${plan.afterEnd.length} sit above §${plan.highest} and append correctly.)`
        : '');
}

// Only the steps a mode actually runs are shown.
function stepsForMode(mode) {
  if (mode === 'validate') return ['validate'];
  // A trim writes no ATF, so there is nothing to validate; it backs the
  // chapter up and deletes, and stops there.
  if (mode === 'trim') return ['backup', 'delete'];
  const steps = ['validate'];
  if (exportOptManuscriptsEl && exportOptManuscriptsEl.checked) steps.push('manuscripts');
  if (mode === 'alignment') return [];   // it reports for itself
  if (mode === 'line' || mode === 'range') {
    steps.push('line');
    // eBL rebuilds a line's tokens from the ATF it is sent, so the alignment
    // and the lemmas it held for that line are gone the moment the line lands.
    // Sending them again is not an extra: it is what keeps the line whole.
    if (exportOptAlignmentEl && exportOptAlignmentEl.checked) steps.push('align');
    if (exportOptLemmasEl && exportOptLemmasEl.checked) steps.push('lemmas');
    return steps;
  }
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

async function openExportModal() {
  // Compiled fresh every time the dialog opens: there is no editable copy
  // to drift from the score any more, so this is always current.
  try {
    exportArtifactAtf = await buildExportArtifact();
  } catch (err) {
    alert('Could not compile the chapter ATF: ' + (err.message || err));
    return;
  }
  renderExportPreview(exportArtifactAtf, null);

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
  const linePicker = document.getElementById('export-line-picker');
  if (linePicker) linePicker.classList.add('hidden');
  const trimPicker = document.getElementById('export-trim-picker');
  if (trimPicker) trimPicker.classList.add('hidden');

  // Validate-only writes nothing, so it needs neither a token nor write scope.
  const canExport = !!exportArtifactAtf;
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
    const ok = mode === 'validate' ? !!exportArtifactAtf : !!canWrite;
    exportGoBtn.disabled = !ok;
    exportGoBtn.title = ok ? '' : 'Cannot write to eBL — fix token/target first';
    const picker = document.getElementById('export-line-picker');
    if (picker) picker.classList.toggle('hidden', mode !== 'line' && mode !== 'range');
    // Only a line send needs them: the other modes either carry no ATF or
    // rewrite the whole chapter anyway.
    for (const opt of document.querySelectorAll('.export-opt-lines')) {
      opt.classList.toggle('hidden', mode !== 'line' && mode !== 'range');
    }
    const toBox = document.getElementById('export-range-to');
    if (toBox) toBox.classList.toggle('hidden', mode !== 'range');
    const trimPicker = document.getElementById('export-trim-picker');
    if (trimPicker) trimPicker.classList.toggle('hidden', mode !== 'trim');
    const trimNote = document.getElementById('export-trim-note');
    if (trimNote) {
      trimNote.textContent = (exportPreflight && !exportPreflight.error && exportPreflight.lineCount)
        ? 'to the end (' + exportPreflight.lineCount + ' lines on eBL)' : '';
    }
    renderExportEffect();
    syncExportSteps();
  });
});

// Typing a section re-renders the effect line so it names the § being replaced.
const exportLineNumEl = document.getElementById('export-line-num');
if (exportLineNumEl) exportLineNumEl.addEventListener('input', renderExportEffect);
const exportLineToEl = document.getElementById('export-line-to');
if (exportLineToEl) exportLineToEl.addEventListener('input', renderExportEffect);
const exportTrimFromEl = document.getElementById('export-trim-from');
if (exportTrimFromEl) exportTrimFromEl.addEventListener('input', renderExportEffect);
exportOptManuscriptsEl && exportOptManuscriptsEl.addEventListener('change', syncExportSteps);
exportOptAlignmentEl && exportOptAlignmentEl.addEventListener('change', syncExportSteps);
exportOptLemmasEl && exportOptLemmasEl.addEventListener('change', syncExportSteps);

function closeExportModal() {
  exportModal.classList.add('hidden');
}

// Thrown when the exporter stops before writing anything. Distinct from an
// EblError so the catch below can say "nothing was sent" truthfully.
// An async click handler that rejects fails in silence: the button appears to
// do nothing and the reason sits in a console nobody has open. Anything that
// gets this far is a bug, so it says so rather than being swallowed.
window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason || {};
  console.error('Unhandled rejection:', err);
  if (typeof showComposeReport !== 'function') return;
  showComposeReport('Something failed', [
    noteBlock(String(err.message || err), 'bad'),
    noteBlock('This should not happen. Nothing was necessarily saved — check the'
      + ' score before carrying on.', 'warn'),
  ]);
});

// ---- Scope: which witnesses are being asked --------------------------------
//
// A composition is always a composition *of something*. By default that is
// every witness of the section, but an edition often wants less: the Nineveh
// copies on their own, the Late Babylonian ones, or a single manuscript
// followed as the base text.
//
// This is recension work. Composing the Nineveh witnesses separately and the
// Babylonian ones separately, then comparing the two readings, is a different
// question from composing them all together and calling the majority the text —
// and the second answer can hide the first entirely.
//
// A scope is { kind, value }:
//   all         every witness of the section
//   provenance  those from one site
//   period      those of one period
//   type        library copies, commentaries, excerpts…
//   witness     one manuscript, followed as the base text

// A commentary is not a copy of the text. It quotes the text to talk about
// it, so its wording answers to the discussion rather than to the tradition,
// and letting it vote makes the composition an average of two different kinds
// of document. IM.74460 agrees with 43% of EAE 56 across 24 lines and is
// flagged divergent in thirteen sections — not because it is a poor witness
// but because it is not that kind of witness at all.
//
// Two things say so and either is enough: the tablet's type in
// manuscripts.json, and the !cm protocol on a line. The second is handled
// per-line by Compositor.classify; this is the whole-tablet answer.
function isCommentaryWitness(siglum) {
  return manuscriptTypes[siglum] === 'commentary';
}

// Mark which of these rows are commentaries, so everything downstream can
// show them without counting them.
function markCommentaries(perWitness) {
  for (const key of Object.keys(perWitness || {})) {
    if (isCommentaryWitness(key.split('|')[0])) perWitness[key].commentary = true;
  }
  return perWitness;
}

function witnessMeta(siglum) {
  const key = String(siglum || '') + '.txt';
  const list = (manuscriptsMeta && manuscriptsMeta.manuscripts) || [];
  return list.find((m) => m.file === key) || null;
}

function scopeLabel(scope) {
  if (!scope || scope.kind === 'all') return 'every witness';
  if (scope.kind === 'witness') return scope.value;
  return scope.value;
}

function inScope(w, scope) {
  if (!scope || scope.kind === 'all') return true;
  if (scope.kind === 'witness') return w.siglum === scope.value;
  const meta = witnessMeta(w.siglum);
  if (!meta) return false;
  return String(meta[scope.kind] || '') === scope.value;
}

// What can be asked for in this section, with how many witnesses each would
// take. Options that would select nothing are not offered.
function scopeOptions(lineNum, vi) {
  const { scoreLines } = buildScore();
  const rows = (scoreLines[lineNum] || [])
    .filter((w) => w.type === 'line' && (w.variant || 0) === vi);
  const groups = { provenance: new Map(), period: new Map(), type: new Map() };
  const witnesses = new Map();
  for (const w of rows) {
    witnesses.set(w.siglum, (witnesses.get(w.siglum) || 0) + 1);
    const meta = witnessMeta(w.siglum);
    if (!meta) continue;
    for (const kind of ['provenance', 'period', 'type']) {
      const v = meta[kind];
      if (!v) continue;
      groups[kind].set(v, (groups[kind].get(v) || 0) + 1);
    }
  }
  return { total: rows.length, groups, witnesses };
}

// The picker. Resolves to a scope, or null if the editor backed out.
function askScope(lineNum, vi) {
  const opts = scopeOptions(lineNum, vi);
  const label = '§' + lineNum + variantLetterOf(vi);
  const rows = [];
  const add = (kind, value, count, note) => {
    rows.push('<label class="scope-option">'
      + `<input type="radio" name="scope-pick" data-kind="${escapeHtml(kind)}" `
      + `data-value="${escapeHtml(value)}"${kind === 'all' ? ' checked' : ''}>`
      + `<span class="scope-name">${escapeHtml(value)}</span>`
      + `<span class="scope-count">${count} witness${count === 1 ? '' : 'es'}</span>`
      + (note ? `<span class="scope-note">${escapeHtml(note)}</span>` : '')
      + '</label>');
  };

  add('all', 'Every witness', opts.total, '');
  for (const kind of ['provenance', 'period', 'type']) {
    const entries = [...opts.groups[kind].entries()]
      // A group that is everyone is not a choice, and one that is nobody cannot be made.
      .filter(([, n]) => n > 0 && n < opts.total)
      .sort((a, b) => b[1] - a[1]);
    if (!entries.length) continue;
    rows.push(`<div class="scope-group">By ${kind}</div>`);
    for (const [value, n] of entries) {
      add(kind, value, n, n < 2 ? 'only one — it will be followed as the base text' : '');
    }
  }
  if (opts.witnesses.size > 1) {
    rows.push('<div class="scope-group">Follow one manuscript</div>');
    for (const [siglum, n] of opts.witnesses) add('witness', siglum, n, 'its own text becomes the reading');
  }

  const p = askOverlay('Compose ' + label + ' from…', [
    noteBlock('Composing a site or a period on its own is how a recension becomes'
      + ' visible. Weighed all together, the majority can bury it.'),
    '<div class="scope-list">' + rows.join('') + '</div>',
  ], 'Compose', true);

  // Recorded as it is chosen. The overlay is hidden before the promise settles,
  // so reading the DOM afterwards is asking a question of a closed dialog.
  let picked = { kind: 'all' };
  document.querySelectorAll('input[name="scope-pick"]').forEach((el) => {
    el.addEventListener('change', () => {
      picked = { kind: el.dataset.kind, value: el.dataset.value };
    });
  });

  return p.then((yes) => (yes ? picked : null));
}

// ---- Statistics ----------------------------------------------------------
//
// Every section measured against its own witnesses at once, so the edition can
// be read as a whole rather than one omen at a time. The question it answers is
// which sections the witnesses agree about and which they do not — the second
// kind is where the editorial work is, and it is not otherwise visible until
// you happen to open the section.
//
// Nothing here writes. It is a reading of the project as it stands.

const statsTabEl = document.getElementById('stats-tab');
let statsRun = null;   // the last measurement, so switching tabs does not recompute

function statsPlaceholder(message) {
  return `<div class="stats-empty">${escapeHtml(message)}</div>`;
}

async function renderStatsTab(force) {
  if (!statsTabEl) return;
  if (statsRun && !force) { paintStats(statsRun); return; }
  if (!window.Compositor) { statsTabEl.innerHTML = statsPlaceholder('compositor.js did not load.'); return; }

  statsTabEl.innerHTML = statsPlaceholder('Measuring every section…');
  let convert;
  try {
    const conv = await ensureAtfConverter();
    convert = (t) => conv.convertLine(t).codes;
  } catch (err) {
    statsTabEl.innerHTML = statsPlaceholder('The sign table could not be loaded: ' + (err.message || err));
    return;
  }

  const { scoreLines } = buildScore();
  const lineNums = Object.keys(scoreLines).map(Number).sort((a, b) => a - b);
  const sections = [];

  for (const n of lineNums) {
    const rows = (scoreLines[n] || []).filter((w) => w.type === 'line');
    if (!rows.length) continue;
    const kept = rows.filter((w) => inScope(w, statsScope));
    if (!kept.length) continue;
    const all = kept.map((w) => ({ key: w.siglum + '|' + w.sourceLine, atf: w.content }));
    const readings = variantsFor(n);
    const written = (readings[0] && readings[0].text || '').trim();

    // Measured against the reading as written when there is one — that is the
    // edition being reported on. Otherwise against what the witnesses alone
    // would give, so a section with no reading yet still gets a number.
    let perWitness = {}, basis = 'written', text = written;
    if (written) {
      perWitness = Compositor.alignToReading(written, all, convert).perWitness;
    } else if (all.length >= 2) {
      const c = Compositor.composeSection(all, convert);
      if (c) { perWitness = c.perWitness; text = c.text; basis = 'composed'; }
    }

    // Weighted by how much each witness preserves. An unweighted mean lets a
    // four-word scrap that happens to agree count as much as a complete copy,
    // which flatters exactly the sections with least evidence behind them.
    markCommentaries(perWitness);
    // Counted by tablet, not by line: a long omen runs over several lines of
    // one manuscript and they are still one witness.
    const anyKey = Object.keys(perWitness)[0];
    const positions = anyKey ? (perWitness[anyKey].positions || 0) : 0;
    const tablets = tabletsOf(perWitness, positions);
    // A commentary is measured and shown, but it does not score the section:
    // counting it makes a section look inconsistent when what it really has is
    // a commentary in it.
    const commentaries = tablets.filter((t) => t.commentary).map((t) => t.siglum);
    const measures = tablets.filter((t) => t.agreement != null && !t.commentary);
    const scores = measures.map((t) => t.agreement);
    const weight = measures.reduce((a, t) => a + (t.judged || 0), 0);
    const mean = weight
      ? measures.reduce((a, t) => a + t.agreement * (t.judged || 0), 0) / weight
      : null;
    const flat = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const coverage = positions && measures.length
      ? measures.reduce((a, t) => a + (t.coverage || 0), 0) / measures.length : null;
    const worst = scores.length ? Math.min.apply(null, scores) : null;
    const divergent = measures.filter((t) => t.wantsVariant).map((t) => t.siglum);
    const omitting = tablets.filter((t) => t.omitted.length).map((t) => t.siglum);

    sections.push({
      n, text, basis, perWitness,
      variants: readings.length,
      tablets,
      witnesses: tablets.length,
      witnessLines: kept.length,
      measured: scores.length,
      mean, flat, worst, weight, coverage, positions, divergent, omitting, commentaries,
      // A section with one witness cannot be inconsistent; say so rather than
      // scoring it 100% and letting it top the table on no evidence.
      thin: scores.length < 2,
    });
  }

  statsRun = { sections, at: new Date() };
  paintStats(statsRun);
}

// The same measurements read the other way: not which sections are agreed
// about, but which witnesses agree. A tablet that disagrees everywhere is
// either a different recension or transliterated against a different
// convention, and both are worth knowing before composing anything.
function witnessSummary(sections) {
  const by = new Map();
  for (const s of sections) {
    for (const key of Object.keys(s.perWitness || {})) {
      const siglum = key.split('|')[0];
      const v = s.perWitness[key];
      if (!by.has(siglum)) by.set(siglum,
        { siglum, commentary: isCommentaryWitness(siglum), lines: 0, scored: [], weight: 0,
          sum: 0, words: 0, of: 0, omits: 0, differs: 0, flagged: [] });
      const w = by.get(siglum);
      w.lines++;
      if (v.agreement != null) {
        w.scored.push(v.agreement);
        // Each line counts for what survives of it, not equally.
        w.weight += v.judged || 0;
        w.sum += v.agreement * (v.judged || 0);
      }
      w.words += v.judged || 0;
      w.of += v.positions || 0;
      w.omits += v.omitted.length;
      w.differs += v.differing.length;
      // A section is named once however many of this tablet's lines it spans.
      if (v.wantsVariant && w.flagged.indexOf(s.n) < 0) w.flagged.push(s.n);
    }
  }
  const out = [...by.values()];
  for (const w of out) {
    w.mean = w.weight ? w.sum / w.weight : null;
    w.coverage = w.of ? w.words / w.of : null;
  }
  return out.sort((a, b) => (a.mean == null ? 2 : a.mean) - (b.mean == null ? 2 : b.mean));
}

function witnessTable(sections) {
  const rows = witnessSummary(sections);
  if (!rows.length) return '<p class="report-empty">No witness could be measured.</p>';
  let html = '<table class="report-table stats-table"><thead><tr>'
    + '<th>Witness</th><th>Lines</th>'
    + '<th title="Weighted by how much of each line survives">Agreement</th>'
    + '<th title="Words preserved, against words in the readings">Covers</th>'
    + '<th>Words omitted</th><th>Words differing</th><th>Flagged in</th></tr></thead><tbody>';
  for (const w of rows) {
    html += `<tr class="${w.commentary ? 'is-commentary-row' : (w.flagged.length ? 'is-divergent' : '')}">`
      + `<td class="report-siglum">`
      + `<a class="source-link" href="#" data-siglum="${escapeHtml(w.siglum)}" `
      + `title="Open this tablet in the Source Text pane">${escapeHtml(w.siglum)}</a>`
      + `${w.commentary ? '<span class="report-lineno">commentary</span>' : ''}</td>`
      + `<td class="report-nums">${w.lines}</td>`
      + `<td>${agreementBar(w.mean)}</td>`
      + `<td class="report-nums"><span class="cover"><span class="cover-num">${w.words}/${w.of}</span>`
      + `<span class="cover-pct">${w.coverage == null ? '—' : Math.round(w.coverage * 100) + '%'}</span></span></td>`
      + `<td class="report-nums">${w.omits || '<span class="report-dash">—</span>'}</td>`
      + `<td class="report-nums">${w.differs || '<span class="report-dash">—</span>'}</td>`
      + `<td class="report-verdict">${w.commentary
        ? '<span class="report-thin">not counted</span>'
        : (w.flagged.length ? escapeHtml('§' + w.flagged.join(', §')) : '')}</td>`
      + '</tr>';
  }
  return html + '</tbody></table>';
}

// Every site, period and type the project's manuscripts.json knows about.
// One tablet, once — however many of its lines a section covers.
//
// A long omen runs over several lines of a manuscript, and each of those lines
// is aligned to the reading separately because that is what a line is. But they
// are one witness: counting AO.6450 six times in a section makes twenty-six
// "witnesses" out of nine tablets, weights that tablet six-fold in the score,
// and prints its name six times in the divergent column.
//
// Merging is not a matter of averaging the lines. Each line covers a different
// stretch of the reading, so the tablet's coverage is the union of what its
// lines reach, and a position is only omitted by the tablet when none of its
// lines has it.
function tabletsOf(perWitness, positions) {
  const by = new Map();
  for (const key of Object.keys(perWitness || {})) {
    const siglum = key.split('|')[0];
    const v = perWitness[key];
    if (!by.has(siglum)) {
      by.set(siglum, {
        siglum, lines: 0, commentary: false,
        covered: new Set(), differing: new Set(), claimedOmitted: new Set(),
        agree: 0, judged: 0,
      });
    }
    const t = by.get(siglum);
    t.lines++;
    if (v.commentary) t.commentary = true;
    for (const p of Object.values(v.alignment || {})) t.covered.add(p);
    for (const p of (v.differing || [])) t.differing.add(p);
    for (const p of (v.omitted || [])) t.claimedOmitted.add(p);
    if (v.agreement != null && v.judged) {
      t.judged += v.judged;
      t.agree += v.agreement * v.judged;
    }
  }

  const out = [];
  for (const t of by.values()) {
    // A line may report a position omitted that another line of the same tablet
    // supplies. The tablet omits it only if none of them has it.
    const omitted = [...t.claimedOmitted].filter((p) => !t.covered.has(p)).sort((a, b) => a - b);
    out.push({
      siglum: t.siglum,
      lines: t.lines,
      commentary: t.commentary,
      judged: t.judged,
      positions,
      agreement: t.judged ? t.agree / t.judged : null,
      coverage: positions ? Math.min(1, t.covered.size / positions) : null,
      differing: [...t.differing].sort((a, b) => a - b),
      omitted,
      thinEvidence: t.judged > 0 && t.judged < 5,
      // The same rule the compositor uses, not a copy of its numbers. This
      // read 'judged >= 5 && agree/judged < 0.75' and drifted out of step the
      // moment the compositor learned to weigh how much a witness preserves.
      wantsVariant: window.Compositor && Compositor.wantsOwnVariant
        ? Compositor.wantsOwnVariant(t.judged, t.agree, (t.differing || []).length,
            t.positions ? t.judged / t.positions : null)
        : (t.judged >= 5 && (t.agree / t.judged) < 0.75),
    });
  }
  return out;
}

function statsScopeOptions() {
  const list = (manuscriptsMeta && manuscriptsMeta.manuscripts) || [];
  const sel = (kind, value) => (statsScope.kind === kind && statsScope.value === value ? ' selected' : '');
  let html = `<option value="all|"${statsScope.kind === 'all' ? ' selected' : ''}>Every witness</option>`;
  for (const kind of ['provenance', 'period', 'type']) {
    const values = [...new Set(list.map((m) => m[kind]).filter(Boolean))].sort();
    if (values.length < 2) continue;
    html += `<optgroup label="By ${kind}">`;
    for (const v of values) html += `<option value="${escapeHtml(kind + '|' + v)}"${sel(kind, v)}>${escapeHtml(v)}</option>`;
    html += '</optgroup>';
  }
  const sigla = list.map((m) => (m.file || '').replace(/\.txt$/, '')).filter(Boolean).sort();
  if (sigla.length > 1) {
    html += '<optgroup label="One manuscript">';
    for (const s of sigla) html += `<option value="${escapeHtml('witness|' + s)}"${sel('witness', s)}>${escapeHtml(s)}</option>`;
    html += '</optgroup>';
  }
  return html;
}

function statsSortValue(s, mode) {
  if (mode === 'section') return s.n;
  if (mode === 'witnesses') return -s.witnesses;
  return s.mean == null ? 2 : s.mean;   // least consistent first
}

let statsSort = 'consistency';
// Measuring one site, period or manuscript on its own: the same question the
// scope picker asks of a single section, asked of the whole edition.
let statsScope = { kind: 'all' };
let statsView = 'sections';

function paintStats(run) {
  const sections = run.sections;
  if (!sections.length) { statsTabEl.innerHTML = statsPlaceholder('No sections to measure yet.'); return; }

  const solid = sections.filter((s) => !s.thin && s.mean != null);
  const totalWeight = solid.reduce((a, s) => a + (s.weight || 0), 0);
  const overall = totalWeight
    ? solid.reduce((a, s) => a + s.mean * (s.weight || 0), 0) / totalWeight : null;
  const flagged = sections.filter((s) => s.divergent.length);

  const sorted = sections.slice().sort((a, b) => statsSortValue(a, statsSort) - statsSortValue(b, statsSort));

  let html = '<div class="stats-head">'
    + '<div class="report-counts">'
    + `<span class="report-count"><b>${sections.length}</b> sections</span>`
    + `<span class="report-count"><b>${solid.length}</b> with two or more tablets</span>`
    + (overall != null ? '<span class="report-count is-done" title="Each witness counted in'
        + ' proportion to how much of its line survives"><b>' + Math.round(overall * 100)
        + '%</b> agreement, weighted by evidence</span>' : '')
    + (flagged.length ? `<span class="report-count is-bad"><b>${flagged.length}</b> with a divergent witness</span>` : '')
    + '</div>'
    + '<div class="stats-controls">'
    + '<label>Scope <select id="stats-scope">' + statsScopeOptions() + '</select></label>'
    + '<span class="stats-views">'
      + `<button type="button" class="stats-view${statsView === 'sections' ? ' is-on' : ''}" data-view="sections">By section</button>`
      + `<button type="button" class="stats-view${statsView === 'witnesses' ? ' is-on' : ''}" data-view="witnesses">By witness</button>`
    + '</span>'
    + '<label>Sort <select id="stats-sort">'
    + `<option value="consistency"${statsSort === 'consistency' ? ' selected' : ''}>Least consistent first</option>`
    + `<option value="section"${statsSort === 'section' ? ' selected' : ''}>By section</option>`
    + `<option value="witnesses"${statsSort === 'witnesses' ? ' selected' : ''}>Most witnesses first</option>`
    + '</select></label>'
    + '<button type="button" id="stats-refresh">Measure again</button>'
    + '<button type="button" id="stats-save">Save a copy</button>'
    + `<span class="stats-stamp">measured ${escapeHtml(run.at.toLocaleTimeString())}</span>`
    + '</div></div>';

  if (statsView === 'witnesses') {
    const body = html + witnessTable(sections);
    statsTabEl.innerHTML = body;
    wireStatsControls(run, body);
    wireSourceLinks(statsTabEl);
    return;
  }

  html += '<table class="report-table stats-table"><thead><tr>'
    + '<th class="stats-fold"></th><th>§</th><th>Reading</th><th>Witnesses</th><th>Agreement</th>'
    + '<th title="Mean share of the reading each witness preserves">Covers</th>'
    + '<th title="Commentaries are shown but not scored">Comm.</th>'
    + '<th>Omitting</th><th>Divergent</th></tr></thead><tbody>';
  for (const s of sorted) {
    const tone = s.thin ? '' : s.mean == null ? '' : s.mean >= 0.9 ? '' : s.mean >= 0.75 ? ' class="is-mid"' : ' class="is-divergent"';
    html += `<tr${tone} data-section="${s.n}">`
      + `<td class="stats-fold" data-fold="${s.n}" title="Show every witness of this section">▸</td>`
      + `<td class="report-siglum">§${s.n}${s.variants > 1 ? `<span class="report-lineno">+${s.variants - 1}</span>` : ''}</td>`
      + `<td class="stats-text">${renderAtf((s.text || '').slice(0, 70))}${(s.text || '').length > 70 ? '…' : ''}`
      + (s.basis === 'composed' ? '<span class="stats-basis">no reading yet — composed</span>' : '')
      + '</td>'
      + `<td class="report-nums">${s.witnesses}`
      + `${s.witnessLines > s.witnesses ? `<span class="report-dash"> in ${s.witnessLines} lines</span>` : ''}`
      + `${s.measured < s.witnesses ? `<span class="report-dash"> · ${s.measured} legible</span>` : ''}</td>`
      + `<td>${s.thin ? '<span class="agree-none">too few</span>' : agreementBar(s.mean)}</td>`
      + `<td class="report-nums">${s.coverage == null ? '<span class="report-dash">—</span>'
        : Math.round(s.coverage * 100) + '%'}</td>`
      + `<td class="report-nums">${(s.commentaries || []).length
        || '<span class="report-dash">—</span>'}</td>`
      + `<td class="report-nums">${s.omitting.length || '<span class="report-dash">—</span>'}</td>`
      + `<td class="report-verdict">${s.divergent.length ? escapeHtml(s.divergent.join(', ')) : ''}</td>`
      + '</tr>';
    // The same per-witness table the reports show, folded away until asked
    // for — the summary is for scanning, this is for looking.
    html += `<tr class="stats-detail hidden" data-detail="${s.n}"><td colspan="9">`
      + positionStrip(s.text || '')
      + witnessRows(s.perWitness)
      + '</td></tr>';
  }
  html += '</tbody></table>';
  statsTabEl.innerHTML = html;
  wireStatsControls(run, html);
  wireSourceLinks(statsTabEl);
  // The row opens the section — the whole row shows a hand, so the whole row
  // had better do the obvious thing. Unfolding is the caret's job, and only
  // the caret's, which is why it is a cell of its own.
  statsTabEl.querySelectorAll('tbody tr[data-section]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      const fold = e.target.closest ? e.target.closest('.stats-fold') : null;
      if (fold) {
        const detail = statsTabEl.querySelector(`tr[data-detail="${tr.dataset.section}"]`);
        if (!detail) return;
        const open = detail.classList.toggle('hidden') === false;
        tr.classList.toggle('is-open', open);
        fold.textContent = open ? '▾' : '▸';
        return;
      }
      goToSection(tr.dataset.section);
    });
  });
}

// Controls shared by both views: which view, how sorted, measure again, save.
function wireStatsControls(run, html) {
  statsTabEl.querySelectorAll('.stats-view').forEach((b) => {
    b.addEventListener('click', () => { statsView = b.dataset.view; paintStats(run); });
  });
  const scopeEl = document.getElementById('stats-scope');
  if (scopeEl) scopeEl.addEventListener('change', () => {
    const parts = String(scopeEl.value).split('|');
    statsScope = parts[0] === 'all' ? { kind: 'all' } : { kind: parts[0], value: parts.slice(1).join('|') };
    renderStatsTab(true);   // a different scope is a different measurement
  });
  const sortEl = document.getElementById('stats-sort');
  if (sortEl) sortEl.addEventListener('change', () => { statsSort = sortEl.value; paintStats(run); });
  const refreshEl = document.getElementById('stats-refresh');
  if (refreshEl) refreshEl.addEventListener('click', () => renderStatsTab(true));
  const saveEl = document.getElementById('stats-save');
  if (saveEl) saveEl.addEventListener('click', () => {
    lastComposeReport = {
      title: statsView === 'witnesses' ? 'The witnesses of this edition' : 'Consistency of the edition',
      html,
      name: 'statistics-' + statsView,
    };
    saveComposeReport();
  });
}

// Open a witness in the Source Text pane, and put the line in question on
// screen. A siglum in a table is a reference to a tablet; being able to read
// the tablet is the point of naming it.
// Every siglum printed in a table is a link to its tablet. Called after any
// innerHTML that may contain them — the statistics tables and the reports.
function wireSourceLinks(root) {
  if (!root) return;
  root.querySelectorAll('.source-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();   // a stats row also opens its section
      // The Source pane is always on screen, so there is no tab to switch to
      // and no reason to take the reader out of the table they were reading.
      hideComposeReport();
      openSource(a.dataset.siglum, a.dataset.src || '');
    });
  });
}

function openSource(siglum, sourceLine) {
  // Manuscripts are keyed by "ms-<filename>" and the entries carry no id of
  // their own, so the key is the id — taking it off the object gives undefined.
  const id = Object.keys(manuscripts).find((k) => manuscripts[k].siglum === siglum);
  if (!id) return false;
  const ms = manuscripts[id];
  loadManuscript(id);
  if (sourceLine && aceEditor) {
    // Find the reading's own line in the file rather than counting rows: a
    // manuscript's line numbers are its own and need not match the file's.
    // Matched by hand rather than by regex — a siglum or line number carrying a
    // regex character would otherwise have to be escaped, and quietly is not.
    const rows = String(ms.content || '').split('\n');
    const want = String(sourceLine) + '.';
    const at = rows.findIndex((row) => {
      const t = row.trim();
      if (t.charAt(0) !== '§') return false;
      const sp = t.indexOf(' ');
      return sp > 0 && t.slice(sp + 1).trim().indexOf(want) === 0;
    });
    if (at >= 0) {
      aceEditor.gotoLine(at + 1, 0, true);
      aceEditor.focus();
    }
  }
  return true;
}

// Switch to the score and put the section on screen.
function goToSection(n) {
  const tab = document.querySelector('.pane-tab[data-tab="score"]');
  if (tab) tab.click();
  const el = scorePanel.querySelector(`.score-line[data-line="${n}"]`);
  if (el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('score-line-found');
    setTimeout(() => el.classList.remove('score-line-found'), 1500);
  }
}

// ---- Overlays: asking, and reporting ------------------------------------
//
// Composing replaces an editor's work, so it asks first; and what it found is
// comparative — who agrees, who omits, who has gone their own way — which wants
// a table and a colour rather than a paragraph in an alert box.

const composeReportEl = document.getElementById('compose-report');
const composeReportBody = document.getElementById('compose-report-body');
const composeReportTitle = document.getElementById('compose-report-title');
const composeReportClose = document.getElementById('compose-report-close');
const composeReportFoot = document.getElementById('compose-report-foot');

// The report as it stands, so it can be saved or reopened without recomputing.
let lastComposeReport = null;

function hideComposeReport() {
  if (composeReportEl) composeReportEl.classList.add('hidden');
  // The report is closed over a score it may have just changed. Repainting
  // costs nothing and guarantees the page matches the state behind it.
  if (typeof renderScore === 'function' && typeof scorePanel !== 'undefined' && scorePanel) {
    try { renderScore(); } catch (_) { /* the report closing must not fail */ }
  }
  if (composeReportResolve) { const r = composeReportResolve; composeReportResolve = null; r(false); }
}
let composeReportResolve = null;

if (composeReportClose) composeReportClose.addEventListener('click', hideComposeReport);
if (composeReportEl) composeReportEl.addEventListener('click', (e) => {
  if (e.target === composeReportEl) hideComposeReport();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && composeReportEl && !composeReportEl.classList.contains('hidden')) {
    hideComposeReport();
  }
});

// A confirm that can show the thing it is asking about. Resolves false on
// Escape, the ✕, or a click outside — the same as saying no.
// `onReady` runs once the body is on the page, for an overlay that needs its
// own listeners — the lemma picker's search box, for instance. The body is
// left in the DOM after the answer, so a caller can still read what was
// ticked.
function askOverlay(title, blocks, confirmLabel, danger, onReady) {
  if (!composeReportEl) return Promise.resolve(false);
  composeReportTitle.textContent = title;
  composeReportBody.innerHTML = blocks.join('');
  composeReportFoot.innerHTML =
    '<button type="button" id="ask-no">Cancel</button>' +
    `<button type="button" id="ask-yes" class="btn-primary${danger ? ' is-danger' : ''}">` +
    `${escapeHtml(confirmLabel)}</button>`;
  composeReportFoot.classList.remove('hidden');
  composeReportEl.classList.remove('hidden');
  return new Promise((resolve) => {
    composeReportResolve = resolve;
    const done = (answer) => {
      composeReportResolve = null;
      composeReportEl.classList.add('hidden');
      composeReportFoot.classList.add('hidden');
      resolve(answer);
    };
    document.getElementById('ask-yes').addEventListener('click', () => done(true));
    document.getElementById('ask-no').addEventListener('click', () => done(false));
    document.getElementById('ask-yes').focus();
    if (typeof onReady === 'function') {
      try { onReady(); } catch (err) { console.warn('overlay setup failed', err); }
    }
  });
}

function showComposeReport(title, blocks, saveName) {
  if (!composeReportEl) return;
  composeReportTitle.textContent = title;
  composeReportBody.innerHTML = blocks.join('');
  lastComposeReport = { title, html: blocks.join(''), name: saveName || 'compose-report' };
  composeReportFoot.innerHTML = '<button type="button" id="report-copy">Copy</button>'
    + '<button type="button" id="report-save">Save a copy</button>'
    + '<button type="button" id="report-ok" class="btn-primary">Close</button>';
  composeReportFoot.classList.remove('hidden');
  composeReportEl.classList.remove('hidden');
  wireSourceLinks(composeReportBody);
  document.getElementById('report-ok').addEventListener('click', hideComposeReport);
  document.getElementById('report-save').addEventListener('click', saveComposeReport);
  document.getElementById('report-copy').addEventListener('click', copyComposeReport);
}

// The report as plain text, on the clipboard. An overlay you cannot get the
// words out of is no use when the words are an error message someone else
// needs to read.
async function copyComposeReport() {
  const btn = document.getElementById('report-copy');
  const title = (composeReportTitle && composeReportTitle.textContent) || '';
  const body = (composeReportBody && composeReportBody.innerText) || '';
  const NL2 = String.fromCharCode(10);
  const text = title + NL2 + '-'.repeat(Math.max(3, title.length)) + NL2 + NL2 + body;
  try {
    await navigator.clipboard.writeText(text);
    if (btn) btn.textContent = 'Copied';
  } catch (_) {
    // No clipboard permission, or an insecure origin. Select it instead so
    // Ctrl+C still works.
    const range = document.createRange();
    range.selectNodeContents(composeReportBody);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (btn) btn.textContent = 'Selected — press Ctrl+C';
  }
  if (btn) setTimeout(() => { btn.textContent = 'Copy'; }, 3000);
}

// Keep a copy. Into the project folder when there is one, so the report sits
// beside the edition it describes; otherwise as a download.
async function saveComposeReport() {
  if (!lastComposeReport) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const doc = '<!doctype html><meta charset="utf-8">'
    + `<title>${escapeHtml(lastComposeReport.title)}</title>`
    + '<style>' + composeReportStyles() + '</style>'
    + `<h1>${escapeHtml(lastComposeReport.title)}</h1>`
    + `<p class="report-stamp">${escapeHtml(new Date().toLocaleString())}</p>`
    + lastComposeReport.html;
  const name = lastComposeReport.name + '-' + stamp + '.html';
  const btn = document.getElementById('report-save');
  try {
    if (dirHandle) {
      const written = await FileSystem.writeProjectFile(dirHandle, name, doc);
      if (btn) btn.textContent = 'Saved as ' + written;
      return;
    }
  } catch (_) { /* fall through to the download */ }
  const url = URL.createObjectURL(new Blob([doc], { type: 'text/html;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
  if (btn) btn.textContent = 'Downloaded';
}

// The report's own styles, inlined so a saved copy still reads correctly with
// nothing else beside it.
function composeReportStyles() {
  const wanted = ['.report-', '.agree', '.pos-strip'];
  let out = 'body{font:14px/1.6 system-ui,sans-serif;margin:2rem auto;max-width:52rem;color:#333}'
    + 'h1{font-size:1.2rem}.report-stamp{color:#666;font-size:.8rem;margin-top:-.5rem}';
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (_) { continue; }   // cross-origin
    for (const rule of rules || []) {
      if (rule.selectorText && wanted.some((w) => rule.selectorText.indexOf(w) >= 0)
          && rule.selectorText.indexOf('dark-mode') < 0) {
        out += rule.cssText;
      }
    }
  }
  return out;
}

// ---- Report pieces ------------------------------------------------------

// How much of the reading a witness actually speaks to. Agreement without
// this is half a fact: four surviving words that all match agree 100% with a
// twelve-word reading.
function coverageCell(v) {
  if (v.positions == null || !v.positions) return '<span class="report-dash">—</span>';
  const pct = Math.round((v.coverage || 0) * 100);
  return `<span class="cover"><span class="cover-num">${v.judged}/${v.positions}</span>`
    + `<span class="cover-pct${v.thinEvidence ? ' is-thin' : ''}">${pct}%</span></span>`;
}

function agreementBar(share) {
  if (share == null) return '<span class="agree-none">no overlap</span>';
  const pct = Math.round(share * 100);
  const tone = share >= 0.9 ? 'high' : share >= 0.75 ? 'mid' : 'low';
  return '<span class="agree"><span class="agree-track">'
    + `<span class="agree-fill is-${tone}" style="width:${pct}%"></span></span>`
    + `<span class="agree-pct">${pct}%</span></span>`;
}

function readingBlock(label, text, before) {
  let html = `<div class="report-reading"><span class="report-label">${escapeHtml(label)}</span>`
    + `<span class="report-text">${renderAtf(text)}</span></div>`;
  if (before && before.trim() && before.trim() !== String(text).trim()) {
    html += '<details class="report-before"><summary>It replaced</summary>'
      + `<div class="report-text is-old">${renderAtf(before)}</div></details>`;
  }
  return html;
}

// The reading with a number under every word, so "omits 5, 6, 7" can be read
// off rather than counted out on the screen.
function positionStrip(text) {
  const words = positionWords(text);
  let html = '<div class="pos-strip">';
  for (const t of words) {
    if (t.divider) {
      html += `<span class="pos-strip-word is-divider">${escapeHtml(t.text)}`
        + `<span class="pos-strip-num">${t.pos}</span></span>`;
      continue;
    }
    const c = positionColor(t.pos);
    html += `<span class="pos-strip-word" style="color:${c.fg};background:${c.bg}">`
      + `<span>${renderAtf(t.text)}</span><span class="pos-strip-num">${t.pos}</span></span>`;
  }
  return html + '</div>';
}

// Every witness of the section, not only the ones filed under this reading —
// the others voted on its shared material and their agreement is the evidence
// for it. `mine` says which belong here.
function witnessRows(perWitness, mine) {
  const keys = Object.keys(perWitness || {});
  if (!keys.length) return '<p class="report-empty">No witness could be measured against this reading.</p>';
  const owned = mine ? new Set(mine) : null;
  let html = '<table class="report-table"><thead><tr>'
    + '<th>Witness</th><th></th><th>Agreement</th><th title="How much of the reading this'
    + ' witness preserves">Covers</th><th>Omits</th><th>Differs at</th><th></th>'
    + '</tr></thead><tbody>';
  for (const k of keys) {
    const v = perWitness[k];
    const parts = k.split('|');
    const isMine = !owned || owned.has(k);
    html += `<tr class="${v.wantsVariant && !v.commentary ? 'is-divergent ' : ''}`
      + `${v.commentary ? 'is-commentary-row ' : ''}${isMine ? '' : 'is-other'}">`
      + `<td class="report-siglum"><a class="source-link" href="#" data-siglum="${escapeHtml(parts[0])}" `
      + `data-src="${escapeHtml(parts[1] || '')}" title="Open this tablet in the Source Text pane">`
      + `${escapeHtml(parts[0])}</a><span class="report-lineno">${escapeHtml(parts[1] || '')}</span></td>`
      + `<td class="report-owner">${v.commentary ? 'commentary'
        : (isMine ? '' : 'other reading')}</td>`
      + `<td>${agreementBar(v.agreement)}</td>`
      + `<td class="report-nums">${coverageCell(v)}</td>`
      + `<td class="report-nums">${v.omitted.length ? escapeHtml(v.omitted.join(', ')) : '<span class="report-dash">—</span>'}</td>`
      + `<td class="report-nums">${v.differing.length ? escapeHtml(v.differing.join(', ')) : '<span class="report-dash">—</span>'}</td>`
      + `<td class="report-verdict">${v.commentary ? '<span class="report-thin">not counted — a commentary</span>'
        : v.wantsVariant ? 'wants its own variant'
        : v.thinEvidence ? '<span class="report-thin">too little preserved to judge</span>' : ''}</td>`
      + '</tr>';
  }
  return html + '</tbody></table>';
}

// Where the reading as written parts company with the best-attested form.
// This is the report an editor wants after choosing against the majority: not
// a correction, a record of what the choice costs in attestation.
function divergenceBlock(current, majority) {
  const a = positionWords(current).filter((t) => t.pos != null);
  const b = positionWords(majority).filter((t) => t.pos != null);
  const rows = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const mine = a[i] ? a[i].text : null;
    const most = b[i] ? b[i].text : null;
    if (mine === most) continue;
    rows.push(`<tr><td class="report-nums">${i}</td>`
      + `<td class="report-text">${mine == null ? '<span class="report-dash">—</span>' : renderAtf(mine)}</td>`
      + `<td class="report-text">${most == null ? '<span class="report-dash">—</span>' : renderAtf(most)}</td></tr>`);
  }
  if (!rows.length) {
    return noteBlock('The reading as written is the best-attested form at every position.', 'good');
  }
  return '<h4 class="report-heading">Where this reading departs from the best attested</h4>'
    + '<table class="report-table report-diverge"><thead><tr><th>Position</th>'
    + '<th>As written</th><th>Best attested</th></tr></thead><tbody>'
    + rows.join('') + '</tbody></table>';
}

// What just happened to the score, in one line, at the top of every report.
// Every outcome wears the same footer, so "not composed" and "composed" were
// telling each other apart only by a word in the title — and the difference
// between them is whether the omen changed.
function outcomeBanner(kind, label, detail) {
  const words = {
    changed: [label + ' was replaced', 'is-changed'],
    added:   [label + ' was written', 'is-changed'],
    kept:    [label + ' was NOT changed', 'is-kept'],
    none:    ['Nothing was composed', 'is-kept'],
    sent:    [label + ' was sent to eBL', 'is-changed'],
    notsent: [label + ' was NOT sent', 'is-kept'],
  }[kind] || ['', 'is-kept'];
  return `<div class="report-outcome ${words[1]}">`
    + `<strong>${escapeHtml(words[0])}</strong>`
    + (detail ? `<span>${escapeHtml(detail)}</span>` : '')
    + '</div>';
}

// An error exactly as it came back. Not shortened: the useful part of a server
// refusal is usually the end of it.
function rawBlock(text) {
  return `<pre class="report-raw">${escapeHtml(String(text == null ? '' : text))}</pre>`;
}

// A reported line and column, shown against the row it names with a caret
// under it. A bare "line 4, col 2" is unreadable when the row is a witness
// line eighty characters wide.
function pointAt(text, line, column) {
  const rows = String(text == null ? '' : text).split(String.fromCharCode(10));
  const row = rows[(line || 1) - 1];
  if (row == null) return '';
  const col = Math.max(1, Math.min(column || 1, row.length + 1));
  return row + String.fromCharCode(10) + ' '.repeat(col - 1) + '^';
}

// How a failed write is described.
//
// A refusal is eBL's answer, and says something about what was sent. A request
// that never arrived is not an answer at all — "Failed to fetch" is the
// browser reporting that it could not complete the call, and eBL never saw it.
// Shown as a refusal, it sent editors looking for a fault in the line when the
// fault was in the connection.
//
// It also cannot be said that nothing changed. A reply can be lost after eBL
// has acted, so the write may have landed. That matters most for a section eBL
// does not hold yet: those go as new lines and eBL appends them, so sending
// again after a lost reply is how a chapter ends up with the omen twice.
function failureReport(label, err) {
  const detail = (err instanceof EblClient.EblError && err.validationErrors)
    ? err.validationErrors.map((e) => (e.line != null ? 'Line ' + e.line + ': ' : '') + e.message)
        .join(String.fromCharCode(10))
    : ((err && (err.rawBody || err.message)) || String(err));

  if (!(err && err.transport)) {
    return {
      transport: false,
      detail,
      title: label + ' was refused — nothing went through',
      blocks: [
        outcomeBanner('notsent', label, 'eBL refused it. Nothing was changed.'),
        noteBlock('What eBL said, in full:', 'bad'),
        rawBlock(detail),
      ],
    };
  }
  return {
    transport: true,
    detail,
    title: label + ' — the request never reached eBL',
    blocks: [
      outcomeBanner('none', label, 'The request never reached eBL.'),
      noteBlock('This is not a refusal: eBL did not answer, so it has said nothing'
        + ' about the line. The usual causes are a dropped connection, a machine that'
        + ' went offline, or a token the browser would not send.', 'bad'),
      noteBlock('Whether it was written cannot be told from here — a reply can be lost'
        + ' after eBL has acted. Open the chapter and look before sending again: a'
        + ' section eBL does not hold yet is appended, so a second send would add it'
        + ' twice.', 'warn'),
      rawBlock(detail),
    ],
  };
}

// An error message with the word it is about.
//
// "Invalid brackets." names a whole line and leaves the editor counting
// characters to find the one at fault. The app already knows which brackets
// have no partner, so a bracket complaint says which word carries it — the
// usual cause being a half-bracket pasted in from a witness, where the other
// half belonged to a word the reading does not have.
function describeProblem(atf, e) {
  const message = String((e && e.message) || '');
  if (e == null || e.line == null) return message;
  const row = String(atf || '').split(String.fromCharCode(10))[e.line - 1];
  if (row == null) return message;
  if (!/bracket/i.test(message)) return message;

  const bad = unmatchedBrackets(row);
  if (!bad.size) return message;
  // The word each unmatched bracket sits in, named once.
  const named = [];
  const seen = new Set();
  const word = /\S+/g;
  let m;
  while ((m = word.exec(row)) !== null) {
    for (const i of bad) {
      if (i < m.index || i >= m.index + m[0].length) continue;
      const what = row[i];
      const key = what + m[0];
      if (seen.has(key)) continue;
      seen.add(key);
      named.push(what + ' in ' + m[0]);
    }
  }
  return named.length
    ? message + ' Unmatched ' + named.join(', ') + '.'
    : message;
}

function noteBlock(text, tone) {
  return `<p class="report-note${tone ? ' is-' + tone : ''}">${escapeHtml(text)}</p>`;
}

// ---- Sending the alignment ------------------------------------------------
//
// Positions mode records which word of a witness answers to which word of the
// reading. That is exactly what eBL stores per token, and what its hover
// follows — but POST /lines cannot carry it, because that sends plain ATF and
// eBL re-parses, keeping an alignment only where a token happens to pair with
// an unchanged one. Exporting one edited line of EAE 56 took its aligned tokens
// from 58 to 18 for that reason.
//
// POST /alignment takes the WHOLE chapter, nested line -> variant -> manuscript.
// So every line has to be in the payload: the ones aligned here from what this
// project knows, and the rest exactly as eBL already holds them.
//
// A word aligned to a word it differs from is a variant — the witness reads
// something else there. eBL keeps that on the token itself, so a difference does
// not have to become a whole separate reading.

// One token, in the shape eBL's own editor sends. The variant is flattened:
// `variant` is its value, with `type` and `language` beside it, empty when none.
function alignmentToken(value, alignment, variant, type, language) {
  return {
    value,
    alignment: alignment == null ? null : alignment,
    variant: variant || '',
    type: variant ? (type || 'Word') : '',
    language: variant ? (language || 'AKKADIAN') : '',
  };
}

// A manuscript line as eBL already holds it, unchanged.
function carriedAlignment(m) {
  const alignment = (m.atfTokens || []).map((t) => (t.alignable
    ? alignmentToken(t.value, t.alignment, (t.variant && t.variant.value) || '',
        t.type, t.language)
    : { value: t.value }));
  // Carried, but not carried blindly: a line already holding a word as both
  // omitted and aligned would go straight back in that state, and eBL cannot
  // save it. Sending the alignment is the moment that can be repaired.
  const claimed = new Set(alignment.map((t) => t.alignment).filter((a) => a != null));
  return {
    alignment,
    omittedWords: (m.omittedWords || []).filter((o) => !claimed.has(o)),
  };
}

// A manuscript line from this project's own alignment.
//
// eBL's token list and ours are not the same list — theirs includes everything
// on the line, ours only the words that can answer to a position. The two are
// paired, and each of eBL's alignable tokens takes the position its partner
// holds here.
//
// Equal lengths pair in order: both are tokenizations of the same line, so slot
// N is slot N even where the transliteration differs — a witness reading GANBA
// where this project reads GAN₂.BA is still the same slot, and that difference
// is what a token variant records.
//
// Unequal lengths mean the two disagree about where a word ends — a bracket
// falling inside a sign name splits one of ours in two ([{iti} BARA₂] against
// {iti}BAR]A₂). Those are matched by their signs instead, and whatever fails to
// pair is simply left unaligned. Nothing here discards the whole line: one
// disagreement used to cost every alignment on it.
function localAlignment(m, w, positions, omitted, convert) {
  const ours = witnessWords(w.content).filter((t) => t.index != null);
  const theirs = (m.atfTokens || []).filter((t) => t.alignable);
  if (!ours.length || !theirs.length) return null;

  const C = window.Compositor;
  const mine = new Array(theirs.length).fill(null);
  if (theirs.length === ours.length) {
    for (let i = 0; i < theirs.length; i++) mine[i] = ours[i];
  } else if (C && convert) {
    const asToken = (text) => C.tokenize(String(text == null ? '' : text), convert)[0]
      || { text: String(text), key: '', blank: true };
    const pairs = C.align(theirs.map((t) => asToken(t.value)), ours.map((t) => asToken(t.text)));
    for (const pair of pairs) {
      if (pair[0] != null && pair[1] != null) mine[pair[0]] = ours[pair[1]];
    }
  } else {
    return null;
  }

  const map = alignmentFor(w.__lineNum, w.siglum + '|' + w.sourceLine);

  // Worked out first, then emitted, because a word of the reading can only be
  // claimed once and that cannot be known while still walking left to right.
  let next = 0;
  const plan = (m.atfTokens || []).map((t) => {
    if (!t.alignable) return { t, at: null, partner: null, same: false };
    const partner = mine[next++];
    const at = partner ? map[partner.index] : null;
    if (at == null) return { t, at: null, partner: null, same: false };
    const reading = positions[at];
    // Paired but not equal: the witness reads something else here, and that is
    // what a token variant is for.
    const same = reading != null && C
      && C.compareWords(reading, partner.text, convert) !== 'different';
    return { t, at, partner, same };
  });

  // A commentary quotes the same word twice — ṣal-mat stands in the lemma and
  // again in the explanation — and both halves match the one word the reading
  // has. Within ONE manuscript line eBL allows only one of them: its editor
  // hides a word already assigned on that line from the picker, and the send
  // fails — tested on IM.74460 o 4, whose quotation and paraphrase both reach
  // for ina SAG KIN. A different line of the same witness starts fresh (o 5a
  // may claim what o 4 claimed), and that needs nothing here, because every
  // manuscript line is aligned on its own.
  //
  // So within the line, the better claim keeps the word and the repeat goes
  // out unaligned: the quotation that agrees with the reading is the one that
  // is really pointing at it.
  const best = new Map();
  plan.forEach((p, i) => {
    if (p.at == null) return;
    const held = best.get(p.at);
    if (held == null) { best.set(p.at, i); return; }
    if (p.same && !plan[held].same) best.set(p.at, i);
  });
  let doubled = 0;
  plan.forEach((p, i) => {
    if (p.at == null || best.get(p.at) === i) return;
    doubled++;
    p.at = null;
    p.partner = null;
  });

  const claimed = new Set();
  const alignment = plan.map((p) => {
    if (!p.t.alignable) return { value: p.t.value };
    if (p.at == null) return alignmentToken(p.t.value, null, '', p.t.type, p.t.language);
    claimed.add(p.at);
    return alignmentToken(p.t.value, p.at, p.same ? '' : clean(p.partner.text),
      p.t.type, p.t.language);
  });

  // A word cannot be both absent from a witness and pointed at by one of its
  // tokens. eBL stores the two side by side and refuses to save a line that
  // claims both, which leaves the line uneditable in its own editor.
  return { alignment, omittedWords: omitted.filter((o) => !claimed.has(o)), doubled };
}

function clean(text) {
  return String(text || '').replace(/[#?!*[\]⸢⸣]/g, '');
}

// Build the whole-chapter alignment payload, and count what it changes.
//
// Returns { payload, summary } — the summary is what the editor is shown before
// anything is sent, because this replaces every line's alignment at once.
async function buildAlignmentPayload(chapter) {
  const conv = await ensureAtfConverter();
  const convert = (t) => { try { return conv.convertLine(t).codes; } catch (_) { return []; } };
  const { scoreLines } = buildScore();
  if (!manuscriptsMeta) {
    manuscriptsMeta = await FileSystem.readManuscriptsMeta(dirHandle) || { version: 1, manuscripts: [] };
  }
  // Newly added sources need a row here, or their alignment has no id to go to.
  manuscriptsMeta = EblClient.reconcileManuscripts(manuscriptsMeta,
    Object.values(manuscripts).map((m) => (/\.txt$/.test(m.siglum) ? m.siglum : m.siglum + '.txt')));

  // eBL numbers its manuscripts; the score knows them by file.
  const idByMuseum = {};
  for (const m of (chapter.manuscripts || [])) idByMuseum[m.museumNumber] = m.id;
  const fileById = {};
  for (const m of ((manuscriptsMeta && manuscriptsMeta.manuscripts) || [])) {
    const id = idByMuseum[m.museumNumber];
    if (id != null) fileById[id] = m.file || '';
  }
  // Compared without the extension: the score knows a witness by its file name,
  // manuscripts.json sometimes by the bare siglum, and the two must still meet.
  const bare = (x) => String(x || '').replace(/\.txt$/, '');

  const summary = { lines: 0, fromHere: [], tokens: 0, aligned: 0, variants: 0,
    omitted: 0, unmatched: [], doubled: [] };

  const payload = (chapter.lines || []).map((L) => {
    const sec = parseInt(L.number, 10);
    const local = lineAlignments[sec];
    const readings = variantsFor(sec);
    const rows = (scoreLines[sec] || []).filter((w) => w.type === 'line');
    let touched = false;

    const out = L.variants.map((v, vi) => v.manuscripts.map((m) => {
      const file = fileById[m.manuscriptId];
      const reading = readings[vi];
      // Only this project's own alignment replaces what eBL holds; everything
      // else goes back exactly as it came.
      const w = (file && local && reading)
        ? rows.find((x) => bare(x.siglum) === bare(file)
            && String(x.sourceLine) === String(m.number) && (x.variant || 0) === vi)
        : null;
      const map = w ? (local[w.siglum + '|' + w.sourceLine] || null) : null;
      if (!w || !map || !Object.keys(map).length) {
        // Worth saying out loud when this project holds an alignment for the
        // witness and it still goes back unchanged. The usual cause is that
        // eBL has moved the witness to another variant: the positions here
        // index this project's reading, so writing them against a different
        // reconstruction would point every word at the wrong word.
        if (file && local) {
          const elsewhere = rows.find((x) => bare(x.siglum) === bare(file)
            && String(x.sourceLine) === String(m.number) && (x.variant || 0) !== vi);
          const held = elsewhere && local[elsewhere.siglum + '|' + elsewhere.sourceLine];
          if (held && Object.keys(held).length) {
            summary.unmatched.push('§' + L.number + ' ' + eblSiglumOf(chapter, m.manuscriptId)
              + ' ' + m.number + ': eBL has it under reading ' + (vi + 1)
              + ', this project under reading ' + ((elsewhere.variant || 0) + 1));
          }
        }
        const kept = carriedAlignment(m);
        summary.tokens += kept.alignment.length;
        summary.aligned += kept.alignment.filter((t) => t.alignment != null).length;
        summary.omitted += kept.omittedWords.length;
        return kept;
      }
      w.__lineNum = sec;
      const words = positionWords(reading.text || '');

      // An alignment index means a position in eBL's reconstruction, not in
      // ours. Where the two readings have the same number of tokens the indices
      // carry over, but whether a witness word is a VARIANT has to be judged
      // against the word eBL actually holds there — otherwise K.3547's KIMIN
      // goes out as a variant of GANBA when eBL's own position 12 is KIMIN.
      const theirWords = (v.reconstructionTokens || []).map((t) => t.value);
      if (theirWords.length !== words.length) {
        summary.unmatched.push('§' + L.number + ' — the reading here has ' + words.length
          + ' tokens, eBL has ' + theirWords.length + '; send the line first');
        const kept = carriedAlignment(m);
        summary.tokens += kept.alignment.length;
        summary.aligned += kept.alignment.filter((t) => t.alignment != null).length;
        summary.omitted += kept.omittedWords.length;
        return kept;
      }
      const byPos = {};
      theirWords.forEach((t, i) => { byPos[i] = t; });
      const tally = alignmentTally(sec, w, words);
      const built = localAlignment(m, w, byPos, tally.omitted, convert);
      if (!built) {
        // Our line and eBL's are not the same line. Leave theirs alone and say
        // why — a bare reference tells an editor nothing about what to do.
        const oursWords = witnessWords(w.content).filter((t) => t.index != null).length;
        const theirWordsCount = (m.atfTokens || []).filter((t) => t.alignable).length;
        const why = !theirWordsCount
          ? 'eBL holds no alignable word on that line — it is all traces and breaks there'
          : !oursWords
            ? 'this line has no word that can take a position — a gloss, or all breaks'
            : 'this line and the one eBL holds could not be matched word for word ('
              + oursWords + ' here, ' + theirWordsCount + ' on eBL)';
        summary.unmatched.push('§' + L.number + ' ' + w.siglum + ' ' + w.sourceLine
          + ' — ' + why);
        const kept = carriedAlignment(m);
        summary.tokens += kept.alignment.length;
        summary.aligned += kept.alignment.filter((t) => t.alignment != null).length;
        summary.omitted += kept.omittedWords.length;
        return kept;
      }
      touched = true;
      if (built.doubled) {
        summary.doubled.push('§' + L.number + ' ' + w.siglum + ' ' + w.sourceLine
          + ' — ' + built.doubled + ' repeated quotation'
          + (built.doubled === 1 ? '' : 's') + ' left unaligned');
      }
      summary.tokens += built.alignment.length;
      summary.aligned += built.alignment.filter((t) => t.alignment != null).length;
      summary.variants += built.alignment.filter((t) => t.variant).length;
      summary.omitted += built.omittedWords.length;
      // Only the two fields eBL's schema knows. `doubled` is this app's own
      // counter, and eBL refuses any unknown field — sent once, it failed the
      // validation of the whole chapter, one "Unknown field." per manuscript.
      return { alignment: built.alignment, omittedWords: built.omittedWords };
    }));

    if (touched) { summary.fromHere.push(L.number); }
    summary.lines++;
    return out;
  });

  return { payload, summary };
}

// What this project's alignment says about one section, for the send preview.
//
// Worth showing next to the ATF, because sending a line and sending its
// alignment are two different requests. POST /lines carries plain ATF, eBL
// rebuilds the tokens from it, and most of what it held for that line goes —
// so this is a picture of what has to be sent again afterwards.
async function alignmentPreview(lineNum) {
  const local = lineAlignments[lineNum] || null;
  const readings = variantsFor(lineNum);
  const { scoreLines } = buildScore();
  const rows = (scoreLines[lineNum] || []).filter((w) => w.type === 'line');
  if (!rows.length) return { blocks: [], placed: 0 };

  // Named the way the ATF above names them. The abbreviations are cached by
  // the time the artifact has been built, so this costs nothing here.
  let sigla = {};
  try { sigla = await EblAtf.buildEblSiglumMap(manuscriptsMeta, EblClient) || {}; }
  catch (_) { sigla = {}; }
  const named = (w) => sigla[String(w.siglum || '').replace(/\.txt$/, '')] || w.siglum;

  // Grouped by the witnesses, not by the readings. A witness sitting on a
  // reading that does not exist yet still goes out in the ATF, so it has to be
  // accounted for here rather than quietly left out.
  const groups = new Map();
  for (const w of rows) {
    const vi = w.variant || 0;
    if (!groups.has(vi)) groups.set(vi, []);
    groups.get(vi).push(w);
  }
  const order = [...groups.keys()].sort((a, b) => a - b);
  const width = Math.max.apply(null, rows.map((w) => String(named(w)).length).concat([6]));

  const out = [];
  const legend = [];
  let placedTotal = 0;
  let markedTotal = 0;

  for (const vi of order) {
    const reading = readings[vi] || null;
    const text = (reading && reading.text) || '';
    const words = positionWords(text);
    // Where eBL will show a ‡: a word some witness either reads differently
    // or has not got at all. Worth knowing before sending, because it is the
    // one thing in the published line that is not in the reading itself.
    const marks = new Map();
    const mark = (pos, why) => {
      if (!marks.has(pos)) marks.set(pos, []);
      marks.get(pos).push(why);
    };
    if (order.length > 1) {
      out.push('Reading ' + (vi + 1) + (text ? ': ' + text : ': (no reading here yet)'));
    }
    for (const w of groups.get(vi)) {
      const map = (local && local[w.siglum + '|' + w.sourceLine]) || null;
      const tokens = witnessWords(w.content).filter((t) => t.index != null);
      const placed = tokens.filter((t) => map && map[t.index] != null);
      placedTotal += placed.length;
      const tally = (map && text) ? alignmentTally(lineNum, w, words)
        : { omitted: [], differing: [] };
      const byPos = {};
      for (const t of placed) byPos[map[t.index]] = t.text;
      for (const pos of tally.omitted) mark(pos, named(w) + ' omits it');
      for (const pos of (tally.differing || [])) {
        mark(pos, named(w) + ' reads ' + (byPos[pos] || '?'));
      }
      const head = String(named(w)).padEnd(width) + '  ' + String(w.sourceLine).padStart(4) + '.  ';
      out.push(head + (placed.length
        ? placed.length + ' of ' + tokens.length + ' words placed'
          + (tally.omitted.length ? ',  omits ' + tally.omitted.join(', ') : '')
        : (!text ? 'no reading to place against'
          : tokens.length ? 'nothing placed' : 'nothing to place')));
      if (placed.length) {
        out.push(' '.repeat(head.length)
          + placed.map((t) => t.text + '→' + map[t.index]).join('   '));
      }
    }
    out.push('');
    const numbered = words.filter((t) => t.pos != null);
    if (numbered.length) {
      const block = [(order.length > 1 ? 'Reading ' + (vi + 1) + ':  ' : '')
        + numbered.map((t) => t.pos + ':' + t.text
            + (marks.has(t.pos) ? '‡' : '')).join('   ')];
      for (const pos of [...marks.keys()].sort((a, b) => a - b)) {
        block.push('   ‡ ' + pos + ' ' + ((words.find((t) => t.pos === pos) || {}).text || '')
          + ' — ' + marks.get(pos).join('; '));
        markedTotal++;
      }
      legend.push(block.join(String.fromCharCode(10)));
    }
  }

  return {
    placed: placedTotal,
    blocks: [
      '<details class="export-preview-wrap"' + (placedTotal ? ' open' : '') + '>'
        + '<summary>Alignment held here — ' + (placedTotal
          ? placedTotal + ' word' + (placedTotal === 1 ? '' : 's') + ' placed'
            + (markedTotal ? ', ' + markedTotal + ' will carry ‡' : '')
          : 'nothing placed yet') + '</summary>'
        + '<pre class="export-preview">' + escapeHtml(out.join(String.fromCharCode(10)).trim()
          + String.fromCharCode(10) + String.fromCharCode(10)
          + (markedTotal
              ? 'positions in the reading — ‡ is where eBL will show a mark:'
              : 'positions in the reading:') + String.fromCharCode(10)
          + legend.join(String.fromCharCode(10) + String.fromCharCode(10)))
        + '</pre></details>',
      placedTotal
        ? noteBlock('This goes as a second request, straight after the line. eBL rebuilds'
            + ' the tokens from the ATF above and clears most of what it held, so the'
            + ' alignment is put back at once — and because eBL replaces a whole chapter’s'
            + ' alignment in one go, every other line is sent back exactly as it stands'
            + ' on eBL now.', 'warn')
        : noteBlock('No positions are held for this section. Compose it, or number the words'
            + ' in Positions mode, and the alignment can be sent after the line.'),
    ],
  };
}

// ---- What has been sent, and whether it still matches -------------------
//
// A mark per section saying it is on eBL and unchanged since. It is not kept
// by hooking every edit — there are too many ways to change a line, and one
// missed hook leaves a section claiming to be sent when it is not. Instead the
// content is fingerprinted at the moment it goes, and the mark holds only
// while the fingerprint still matches. Editing anything the export would carry
// clears it by itself, including an edit made in another session.

// Everything about a section that sending it would put on eBL.
//
// Three definitions have existed, and old records were written under the older
// ones. `version` reproduces them exactly so a stored fingerprint can still be
// recognised — including a mistake: versions 1 and 2 joined with control
// characters that got into the string literals by accident, and every
// fingerprint of that era was computed with them.
//
//   1  readings, witnesses, translation
//   2  and the alignment, and every lemma
//   3  and the alignment, but only the lemmas a person confirmed
//
// Version 3 exists because version 2 was unusable: prefill writes a machine
// lemma onto every word of every section, so the moment the dictionary ran,
// all ninety marks turned amber at once. A suggestion nobody has confirmed is
// not sent to eBL either, so it has no business deciding whether a section
// still matches what was sent.
const SENT_FINGERPRINT_VERSION = 3;

function sectionContent(lineNum, version) {
  const v = version || SENT_FINGERPRINT_VERSION;
  const RS = v < 3 ? String.fromCharCode(31) : '';
  const parts = [];

  for (const r of variantsFor(lineNum)) {
    parts.push('R', r.text || '', r.note || '', (r.parallels || []).join(RS));
  }
  const { scoreLines } = buildScore();
  for (const w of (scoreLines[lineNum] || [])) {
    if (w.type !== 'line') continue;
    parts.push('W', w.siglum, String(w.sourceLine), w.content || '',
      String(w.variant || 0), (w.continuation || []).join(RS));
  }
  parts.push('T', translationLines[lineNum] || '');

  if (v >= 2) {
    // Sending a section carries its alignment, so moving a word's position
    // changes what eBL would receive. Serialised in a fixed order: object key
    // order is not something to rely on when the answer must not change on
    // its own.
    const align = lineAlignments[lineNum] || {};
    for (const key of Object.keys(align).sort()) {
      const map = align[key] || {};
      parts.push('A', key);
      for (const i of Object.keys(map).sort((a, b) => Number(a) - Number(b))) {
        parts.push(i + ':' + map[i]);
      }
    }

    const lemmas = lemmaChoices[lineNum] || {};
    for (const vi of Object.keys(lemmas).sort((a, b) => Number(a) - Number(b))) {
      const slot = lemmas[vi] || {};
      const rows = [];
      for (const pos of Object.keys(slot).sort((a, b) => Number(a) - Number(b))) {
        const held = slot[pos];
        const ids = Array.isArray(held) ? held : ((held && held.ids) || []);
        // Version 3 counts only what a person confirmed. An array with no
        // marker is an old record, which was always a person's choice.
        const by = Array.isArray(held) ? 'hand' : ((held && held.by) || 'hand');
        if (v >= 3 && by !== 'hand') continue;
        rows.push(pos + ':' + ids.join('+'));
      }
      // The marker only if something survives the filter. Pushing it first put
      // an empty "L 0" into every section the moment prefill ran, which changed
      // every fingerprint and turned every mark amber — for lemmas that are not
      // even sent.
      if (rows.length) parts.push('L', vi, ...rows);
    }
  }

  return parts.join(v < 3 ? String.fromCharCode(30) : '|');
}

// FNV-1a. Short, stable, and enough to notice a change — this is not guarding
// against anyone forging a match, only against a section quietly drifting away
// from what was sent.
function fingerprint(text) {
  let h = 0x811c9dc5;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

// never    nothing has been sent from here
// sent     sent, and the section still reads as it did
// changed  sent, then edited
function sentState(lineNum) {
  const rec = exportedSections[lineNum];
  if (!rec || !rec.fingerprint) return 'never';
  return rec.fingerprint === fingerprint(sectionContent(lineNum)) ? 'sent' : 'changed';
}

// never    no editor has signed this section off
// revised  read through, and the section still reads as it did
// changed  read through, then edited — it wants reading again
function revisedState(lineNum) {
  const rec = revisedSections[lineNum];
  if (!rec || !rec.fingerprint) return 'never';
  return rec.fingerprint === fingerprint(sectionContent(lineNum)) ? 'revised' : 'changed';
}

// Repaint one line's mark without rebuilding the score.
//
// Editing a reading deliberately does not re-render — the caret would be
// destroyed on every keystroke — so the class the header was given at render
// time cannot update on its own. That is why a section edited after being sent
// stayed green: the fingerprint had changed, but nothing had asked it.
//
// Debounced, because it runs on every keystroke and the fingerprint rebuilds
// the score to see what the section holds.
const sentMarkTimers = {};
function refreshSentMark(lineNum) {
  clearTimeout(sentMarkTimers[lineNum]);
  sentMarkTimers[lineNum] = setTimeout(() => {
    const line = document.querySelector(`.score-line[data-line="${lineNum}"]`);
    if (!line) return;
    const state = sentState(lineNum);
    const header = line.querySelector('.score-line-header');
    if (header && !header.classList.contains('is-variant')) {
      header.classList.remove('sent-never', 'sent-sent', 'sent-changed');
      header.classList.add('sent-' + state);
    }
    const mark = line.querySelector('.line-sent');
    if (mark) {
      mark.classList.remove('is-never', 'is-sent', 'is-changed');
      mark.classList.add('is-' + state);
      mark.textContent = state === 'never' ? '·' : '✓';
      mark.title = sentTitle(lineNum);
    }
    const rmark = line.querySelector('.line-revised');
    if (rmark) {
      const rstate = revisedState(lineNum);
      rmark.classList.remove('is-never', 'is-revised', 'is-changed');
      rmark.classList.add('is-' + rstate);
      rmark.textContent = rstate === 'never' ? '·' : '✎';
      rmark.title = revisedTitle(lineNum);
    }
  }, 250);
}

// Bring marks written under an older fingerprint up to date.
//
// Whenever the fingerprint learns to watch something new, every record written
// before it mismatches — and "all ninety turned amber" is indistinguishable
// from ninety real edits. So a record is re-affirmed only when it still matches
// under the definition it was written with: that says the section was current
// when it was last looked at and has not changed since. One that was already
// amber stays amber. Either way it is stamped, so this runs once.
function migrateSentMarks() {
  let restored = 0, kept = 0;
  // The revision marks live under the same fingerprint, so they come forward
  // by the same rule.
  for (const ledger of [exportedSections, revisedSections])
  for (const key of Object.keys(ledger)) {
    const rec = ledger[key];
    if (!rec) continue;
    const was = rec.v || 1;
    if (was >= SENT_FINGERPRINT_VERSION) continue;
    const lineNum = Number(key);
    if (!Number.isFinite(lineNum)) { rec.v = SENT_FINGERPRINT_VERSION; continue; }
    if (rec.fingerprint === fingerprint(sectionContent(lineNum, was))) {
      rec.fingerprint = fingerprint(sectionContent(lineNum));
      restored++;
    } else {
      kept++;   // it had already been edited; leave it saying so
    }
    rec.v = SENT_FINGERPRINT_VERSION;
  }
  if (restored || kept) {
    console.log('sent marks brought forward: ' + restored + ' still current, '
      + kept + ' already edited');
  }
  return { restored, kept };
}

function markSent(lineNum, parts) {
  exportedSections[lineNum] = {
    fingerprint: fingerprint(sectionContent(lineNum)),
    at: new Date().toISOString(),
    parts: parts || ['line'],
    // Which definition of the fingerprint this was written under. Without
    // it, changing what the fingerprint covers turns every mark amber and
    // there is no way to tell that from real edits.
    v: SENT_FINGERPRINT_VERSION,
  };
}

function sentTitle(lineNum) {
  const rec = exportedSections[lineNum];
  const state = sentState(lineNum);
  if (state === 'never') {
    return 'Not sent to eBL from here yet. Click to say it is already there;'
      + ' shift-click to carry the mark down from the last one.';
  }
  const when = rec && rec.at ? new Date(rec.at).toLocaleString() : 'earlier';
  const what = (rec && rec.parts && rec.parts.length) ? rec.parts.join(', ') : 'line';
  return state === 'sent'
    ? 'Sent to eBL (' + what + ') on ' + when + ', and unchanged since'
    : 'Sent to eBL (' + what + ') on ' + when + ', and edited since — send it again';
}

function markRevised(lineNum) {
  revisedSections[lineNum] = {
    fingerprint: fingerprint(sectionContent(lineNum)),
    at: new Date().toISOString(),
    v: SENT_FINGERPRINT_VERSION,
  };
}

function revisedTitle(lineNum) {
  const rec = revisedSections[lineNum];
  const state = revisedState(lineNum);
  if (state === 'never') {
    return 'Not yet revised by an editor. Click when this section has been read'
      + ' through; shift-click to carry the mark down from the last one.';
  }
  const when = rec && rec.at ? new Date(rec.at).toLocaleString() : 'earlier';
  return state === 'revised'
    ? 'Revised by an editor on ' + when + ', and unchanged since'
    : 'Revised on ' + when + ', and edited since — it wants reading again';
}

// ---- Export reports -------------------------------------------------------
//
// Every send to eBL files a report, however it went:
//   error     nothing went through
//   warning   the line went, a part behind it did not
//   notice    everything went, but something is worth checking on eBL —
//             a repeated quotation left unaligned, a witness kept under
//             another reading
//   ok        everything went, nothing to look at (filed already done, a log)
//
// The reports live in score-data.json and are shown by reports.html, a page
// of their own, so the log can stand open beside the scorer. An error or
// warning also puts a sign on its section here, which clears when the report
// is ticked done on that page — a manual tick, because only the editor knows
// the repair on eBL actually happened — or when a later send supersedes it.

function openIssuesFor(sec) {
  return exportIssues.filter((r) => !r.done && r.sec != null
    && parseInt(r.sec, 10) === parseInt(sec, 10));
}

// The sign a section wears: the worst of its open reports, or nothing.
// Notices carry no sign — they are the badge's and the page's business.
function issueState(sec) {
  const open = openIssuesFor(sec).filter((r) => r.kind === 'error' || r.kind === 'warning');
  if (!open.length) return null;
  return open.some((r) => r.kind === 'error') ? 'error' : 'warning';
}

function addExportIssue(o) {
  const rec = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    sec: o.sec == null ? null : parseInt(o.sec, 10),
    kind: o.kind,                  // error | warning | notice | ok
    part: o.part || 'other',       // send | alignment | other
    title: o.title,
    // Things to check on eBL later, one line each — they stand on the report
    // even when everything was accepted.
    notes: (o.notes || []).slice(0, 60),
    detail: String(o.detail || '').slice(0, 4000),
    // The full report exactly as the overlay showed it, reopenable from the
    // reports page. Bounded, because score-data.json is read whole.
    report: String(o.report || '').slice(0, 120000),
    at: new Date().toISOString(),
    done: !!o.done,
    doneAt: o.done ? new Date().toISOString() : null,
    how: o.done ? (o.how || 'nothing to do') : null,
  };
  exportIssues.unshift(rec);
  return rec;
}

// A newer send of the same thing states the current truth, so the reports the
// older one left open are closed rather than piling up. Hand-written reports
// (part 'other') are never touched — only their author knows what they mean.
function supersedeExportIssues(part, sec) {
  for (const r of exportIssues) {
    if (r.done || r.part !== part) continue;
    if (String(r.sec) !== String(sec == null ? null : parseInt(sec, 10))) continue;
    r.done = true;
    r.doneAt = new Date().toISOString();
    r.how = 'superseded by a later send';
  }
}

function updateReportsBadge() {
  const badge = document.getElementById('reports-badge');
  if (!badge) return;
  const open = exportIssues.filter((r) => !r.done);
  badge.textContent = open.length ? String(open.length) : '';
  badge.classList.toggle('hidden', !open.length);
  badge.classList.toggle('is-error', open.some((r) => r.kind === 'error'));
}

// The reports have a page of their own, so the log can stand open beside the
// scorer. One named window: a second click brings it forward, not a twin.
function openReportsPage(sec) {
  const q = [];
  if (projectId) q.push('project=' + encodeURIComponent(projectId));
  if (sec != null) q.push('sec=' + encodeURIComponent(sec));
  const w = window.open('reports.html' + (q.length ? '?' + q.join('&') : ''), 'scorer-reports');
  if (w && w.focus) w.focus();
}

(() => {
  const btn = document.getElementById('reports-btn');
  if (btn) btn.addEventListener('click', () => openReportsPage(null));
})();

// The ⚠ / ✖ a section wears opens the page on that section's reports.
document.addEventListener('click', (e) => {
  const mark = e.target && e.target.closest ? e.target.closest('.line-issue') : null;
  if (!mark) return;
  const lineNum = parseInt(mark.dataset.line, 10);
  if (!Number.isFinite(lineNum)) return;
  e.preventDefault();
  openReportsPage(lineNum);
});

// ---- Lemmas ---------------------------------------------------------------

function lemmaSlot(lineNum, vi) {
  const line = lemmaChoices[lineNum] || (lemmaChoices[lineNum] = {});
  return line[vi] || (line[vi] = {});
}

// What a word carries, and who put it there.
//
//   hand  a person chose it
//   auto  the dictionary filled it in and nobody has looked yet
//
// The difference is the whole point of prefilling: a chapter can be lemmatized
// in one pass and then read through, and the reader has to be able to see at a
// glance which words are still only a guess. Older projects stored a bare array
// with no such distinction; those count as hand, because at the time the only
// way a lemma got there was someone choosing it.
function lemmaEntryAt(lineNum, vi, pos) {
  const held = ((lemmaChoices[lineNum] || {})[vi] || {})[pos];
  if (!held) return null;
  if (Array.isArray(held)) return held.length ? { ids: held.slice(), by: 'hand' } : null;
  const ids = Array.isArray(held.ids) ? held.ids : [];
  return ids.length ? { ids: ids.slice(), by: held.by === 'auto' ? 'auto' : 'hand' } : null;
}

function lemmasAt(lineNum, vi, pos) {
  const e = lemmaEntryAt(lineNum, vi, pos);
  return e ? e.ids : [];
}

function setLemmasAt(lineNum, vi, pos, ids, by) {
  if (typeof refreshSentMark === 'function') refreshSentMark(lineNum);
  const slot = lemmaSlot(lineNum, vi);
  if (!ids || !ids.length) delete slot[pos];
  else slot[pos] = { ids: ids.slice(), by: by === 'auto' ? 'auto' : 'hand' };
}

// How a word stands: confirmed, still only suggested, or nothing at all.
function lemmaState(lineNum, vi, pos, text) {
  const e = lemmaEntryAt(lineNum, vi, pos);
  if (e) return e.by;
  if (window.Lemmatizer && Lemmatizer.loaded() && Lemmatizer.skippable(text)) return 'skip';
  return 'none';
}

// How many words of one section carry a lemma.
function lemmasHeldFor(lineNum) {
  const line = lemmaChoices[lineNum] || {};
  let n = 0;
  for (const variant of Object.values(line)) n += Object.keys(variant || {}).length;
  return n;
}

// Counts for the whole project, by who put each lemma there.
function lemmaCount() {
  let hand = 0, auto = 0;
  for (const line of Object.values(lemmaChoices)) {
    for (const variant of Object.values(line || {})) {
      for (const held of Object.values(variant || {})) {
        const by = Array.isArray(held) ? 'hand' : (held && held.by === 'auto' ? 'auto' : 'hand');
        if (by === 'auto') auto++; else hand++;
      }
    }
  }
  return { hand, auto, total: hand + auto };
}

// Does this word open its line?
//
// Not only the first position. A reading beginning "[...] DIŠ" or "[DIŠ" has
// its DIŠ standing where the omen starts, whatever the break before it counts
// as — so anything before it that carries no signs does not push it out of
// first place. That is what makes it šumma rather than ana.
function opensTheLine(words, pos) {
  for (const t of words) {
    if (t.pos == null || t.pos >= pos) continue;
    if (t.divider) continue;
    if (window.Lemmatizer && Lemmatizer.skippable(t.text)) continue;
    return false;   // a real word stands before it
  }
  return true;
}

// What the dictionary would put on a word, base plus whatever is written onto
// the end of it. Returns [] when it has nothing to say.
// Every bound ending written onto a word, innermost first — the order eBL
// keeps them in on the token.
function endingIdsOf(word) {
  const ending = Lemmatizer.suffixOf(word);
  if (!ending) return [];
  if (ending.chain && ending.chain.length) return ending.chain.slice();
  const ids = [];
  if (ending.also) ids.push(ending.also.id);
  ids.push(ending.id);
  return ids;
}

function suggestLemmasFor(word, context) {
  if (!window.Lemmatizer || !Lemmatizer.loaded()) return [];
  if (Lemmatizer.skippable(word)) return [];
  const ids = [];
  // A reading this project has settled is taken whole. It may name more than
  // one lemma — UTU.È is ṣītu and šamšu, one writing for two words — and only
  // taking the first would quietly drop half the phrase.
  const settled = Lemmatizer.glossaryFor(word);
  if (settled) {
    ids.push(...settled);
  } else {
    const best = Lemmatizer.candidates(word, 1, context);
    if (best.length) ids.push(best[0].id);
  }
  // A word can carry more than two endings — a verb, its ventive and an
  // enclitic are three — so take the whole chain where there is one.
  for (const id of endingIdsOf(word)) if (ids.indexOf(id) < 0) ids.push(id);
  return ids;
}

// Re-run the dictionary over its own earlier guesses.
//
// prefillLemmas never overwrites what is already there — that is what keeps it
// safe to run again. But it means a lemma filled in before the dictionary
// learned something stays wrong for ever: every line-initial DIŠ prefilled
// before the reading layer existed still says ana, and no amount of prefilling
// will change it.
//
// This walks the suggestions and only the suggestions. A lemma somebody chose
// is never touched, whatever the dictionary now thinks.
function refreshSuggestions(from, apply) {
  const { scoreLines } = buildScore();
  const sections = Object.keys(scoreLines).map(Number)
    .filter((n) => Number.isFinite(n) && (from == null || n >= from))
    .sort((a, b) => a - b);

  const changes = [];
  for (const lineNum of sections) {
    variantsFor(lineNum).forEach((reading, vi) => {
      const words = positionWords(reading.text || '');
      for (const t of words) {
        if (t.pos == null || t.divider) continue;
        const held = lemmaEntryAt(lineNum, vi, t.pos);
        if (!held || held.by !== 'auto') continue;      // only the machine's own
        const now = suggestLemmasFor(t.text, { initial: opensTheLine(words, t.pos) });
        if (!now.length) continue;
        if (now.join('+') === held.ids.join('+')) continue;
        changes.push({ lineNum, vi, pos: t.pos, word: t.text,
                       was: held.ids.slice(), now });
      }
    });
  }
  if (apply) {
    for (const c of changes) setLemmasAt(c.lineNum, c.vi, c.pos, c.now, 'auto');
  }
  return changes;
}

// Offer it, showing what would change before anything does.
async function offerRefreshSuggestions(from) {
  try { await Lemmatizer.load(); } catch (_) { return; }
  const changes = refreshSuggestions(from, false);
  if (!changes.length) {
    setStatus('connected', 'Every suggestion already matches the dictionary');
    setTimeout(() => setStatus('connected', 'Ready'), 4000);
    return;
  }
  const lines = changes.slice(0, 40).map((c) => '§' + c.lineNum
    + (c.vi ? variantLetterOf(c.vi) : '') + '  word ' + c.pos + '  ' + c.word
    + '   ' + (c.was.join('+') || 'none') + '  →  ' + c.now.join('+'));

  const ok = await askOverlay('Refresh the suggestions?', [
    '<div class="report-outcome is-kept">'
      + '<strong>' + escapeHtml(changes.length + ' suggestion'
          + (changes.length === 1 ? '' : 's') + ' would change') + '</strong>'
      + '<span>' + escapeHtml('Nothing chosen by hand is touched.') + '</span>'
      + '</div>',
    rawBlock(lines.join(String.fromCharCode(10))
      + (changes.length > 40 ? String.fromCharCode(10) + '…and '
         + (changes.length - 40) + ' more' : '')),
    noteBlock('These were filled in by an earlier version of the dictionary. Only'
      + ' lemmas still marked as suggestions are affected.'),
  ], 'Refresh ' + changes.length, false);
  if (!ok) return;

  refreshSuggestions(from, true);
  await saveScoreDataToFile();
  keepScoreInView(renderScore);
  setStatus('connected', changes.length + ' suggestion(s) refreshed');
  setTimeout(() => setStatus('connected', 'Ready'), 5000);
}

// ---- this project's own dictionary -----------------------------------------
//
// The general dictionary knows what IGI can mean. It cannot know that in EAE 56
// it is always amāru, because that is a decision about this edition and not a
// fact about Akkadian. Recorded here, it is made once instead of on every line,
// and it outranks everything the shipped index would otherwise offer.
//
// It lives in score-data.json beside the lemmas themselves, and it can be
// carried to the next project: the readings an editor settles for one text are
// usually the same ones they will settle for the next.
let projectGlossary = {};


function applyProjectGlossary() {
  try { Lemmatizer.setGlossary(projectGlossary); } catch (_) { /* not loaded yet */ }
}

// Teach the project a reading. The word is keyed the way the lemmatizer keys
// everything, so IGI, igi and {d}IGI all land on one entry.
async function teachProjectLemma(word, ids) {
  const key = Lemmatizer.glossaryKey(word);
  if (!key || !ids || !ids.length) return null;
  projectGlossary[key] = ids.slice();
  applyProjectGlossary();
  await saveScoreDataToFile();
  return key;
}

async function forgetProjectLemma(key) {
  if (!(key in projectGlossary)) return false;
  delete projectGlossary[key];
  applyProjectGlossary();
  await saveScoreDataToFile();
  return true;
}

// How many words in the score an entry actually answers. A project entry
// reaches every line at once, and that is worth being able to see.
function glossaryReach(key) {
  let n = 0;
  const { scoreLines } = buildScore();
  const sections = Object.keys(scoreLines).map(Number).filter(Number.isFinite);
  for (const lineNum of sections) {
    variantsFor(lineNum).forEach((reading) => {
      for (const t of positionWords(reading.text || '')) {
        if (t.pos == null || t.divider) continue;
        const probe = Lemmatizer.glossaryKey(t.text) || '';
        if (probe === key || probe.split('-')[0] === key) n++;
      }
    });
  }
  return n;
}

function glossaryRows() {
  return Object.keys(projectGlossary).sort().map((key) => ({
    key,
    ids: projectGlossary[key],
    reach: glossaryReach(key),
  }));
}

// The dictionary as a file, so it can start the next project already knowing
// what this one decided.
function exportProjectGlossary() {
  const payload = {
    kind: 'cuneiform-scorer project dictionary',
    project: projectId || '',
    savedAt: new Date().toISOString(),
    entries: projectGlossary,
  };
  const name = (projectId || 'project') + '-dictionary.json';
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}

// Merged, not replaced: a dictionary brought from another project adds what it
// knows without discarding what this one has already settled. Where both have
// an opinion the one already here wins, since it was made about this text.
async function importProjectGlossary(text) {
  let data = null;
  try { data = JSON.parse(text); } catch (_) { return { error: 'That file is not JSON.' }; }
  const entries = (data && (data.entries || data)) || {};
  if (typeof entries !== 'object') return { error: 'No dictionary entries in that file.' };
  let added = 0, kept = 0, skipped = 0;
  for (const form of Object.keys(entries)) {
    const held = entries[form];
    const ids = (Array.isArray(held) ? held : (held && held.ids) || [])
      .filter((id) => Lemmatizer.known(id));
    const key = Lemmatizer.glossaryKey(form);
    if (!key || !ids.length) { skipped++; continue; }
    if (projectGlossary[key]) { kept++; continue; }
    projectGlossary[key] = ids;
    added++;
  }
  if (added) {
    applyProjectGlossary();
    await saveScoreDataToFile();
  }
  return { added, kept, skipped };
}

// The manager. Deliberately here rather than in Settings: Settings is another
// page and does not hold this project's folder, and this edits the same file
// the score itself is saved in.
function openGlossaryManager() {
  const rows = glossaryRows();
  const APOS = String.fromCharCode(8217);
  const body = rows.length
    ? '<table class="gloss-table"><thead><tr><th>Written</th><th>Read as</th>'
      + '<th>Words</th><th></th></tr></thead><tbody>'
      + rows.map((r) => '<tr><td class="gloss-form">'
          + escapeHtml(r.key.toUpperCase().replace(/-/g, '.')) + '</td>'
          + '<td>' + escapeHtml(r.ids.join(' + ')) + '</td>'
          + '<td class="gloss-reach">' + r.reach + '</td>'
          + '<td><button type="button" class="gloss-drop" data-key="'
          + escapeHtml(r.key) + '">Remove</button></td></tr>').join('')
      + '</tbody></table>'
    : noteBlock('This project has settled no readings of its own yet. Choose a lemma'
        + ' on any word and use the mark beside it to record that reading for the'
        + ' whole project.');

  showComposeReport('This project' + APOS + 's dictionary', [
    outcomeBanner(rows.length ? 'kept' : 'skipped',
      rows.length + ' reading' + (rows.length === 1 ? '' : 's'),
      'recorded for this edition, ahead of the general dictionary'),
    body,
    '<div class="gloss-add">'
      + '<input id="gloss-word" placeholder="written form, e.g. IGI" spellcheck="false">'
      + '<input id="gloss-ids" placeholder="lemma, e.g. amaru I" spellcheck="false">'
      + '<button type="button" id="gloss-save" class="btn-primary">Record</button></div>',
    noteBlock('A reading recorded for IGI also answers IGI-ir and IGI-MEŠ: a'
      + ' phonetic complement or a plural marker does not make it another word.'),
    '<div class="gloss-file">'
      + '<button type="button" id="gloss-export">Export for another project</button>'
      + '<button type="button" id="gloss-import">Import a dictionary</button>'
      + '<input type="file" id="gloss-file" accept="application/json,.json" hidden></div>',
  ], 'project-dictionary');

  const bodyEl = document.getElementById('compose-report-body');
  if (!bodyEl) return;

  for (const btn of bodyEl.querySelectorAll('.gloss-drop')) {
    btn.addEventListener('click', async () => {
      await forgetProjectLemma(btn.dataset.key);
      keepScoreInView(renderScore);
      openGlossaryManager();
    });
  }

  const save = document.getElementById('gloss-save');
  if (save) save.addEventListener('click', async () => {
    const word = ((document.getElementById('gloss-word') || {}).value || '').trim();
    const typed = ((document.getElementById('gloss-ids') || {}).value || '').trim();
    const ids = [];
    for (const piece of typed.split('+').map((s) => s.trim()).filter(Boolean)) {
      if (Lemmatizer.known(piece)) { ids.push(piece); continue; }
      const found = Lemmatizer.search(piece, 1);
      if (found.length) ids.push(found[0].id);
    }
    if (!word || !ids.length) {
      setStatus('error', 'A written form, and a lemma the dictionary knows');
      setTimeout(() => setStatus('connected', 'Ready'), 4000);
      return;
    }
    await teachProjectLemma(word, ids);
    keepScoreInView(renderScore);
    openGlossaryManager();
  });

  const out = document.getElementById('gloss-export');
  if (out) out.addEventListener('click', () => {
    const name = exportProjectGlossary();
    setStatus('connected', 'Saved ' + name);
    setTimeout(() => setStatus('connected', 'Ready'), 4000);
  });

  const pick = document.getElementById('gloss-import');
  const file = document.getElementById('gloss-file');
  if (pick && file) {
    pick.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const done = await importProjectGlossary(await f.text());
      if (done.error) {
        setStatus('error', done.error);
        setTimeout(() => setStatus('connected', 'Ready'), 5000);
        return;
      }
      keepScoreInView(renderScore);
      setStatus('connected', done.added + ' added, ' + done.kept + ' already settled here');
      setTimeout(() => setStatus('connected', 'Ready'), 5000);
      openGlossaryManager();
    });
  }
}

// Fill in every word the dictionary can place, leaving anything already there
// alone. Nothing here overwrites a decision — a word someone has chosen keeps
// what they chose, and a word the dictionary cannot place stays empty rather
// than being given a wrong answer to tidy the display.
// `only` is one section; `{ from }` is that section and everything after it.
function prefillLemmas(only) {
  const all = Object.keys(buildScore().scoreLines).map(Number)
    .filter(Number.isFinite).sort((a, b) => a - b);
  const sections = (only && typeof only === 'object' && only.from != null)
    ? all.filter((n) => n >= only.from)
    : (only != null ? [only] : all);
  let filled = 0, blank = 0;
  for (const lineNum of sections) {
    const readings = variantsFor(lineNum);
    readings.forEach((reading, vi) => {
      const words = positionWords(reading.text || '');
      for (const t of words) {
        if (t.pos == null || t.divider) continue;
        if (lemmaEntryAt(lineNum, vi, t.pos)) continue;
        if (Lemmatizer.skippable(t.text)) continue;
        // Where a word sits can settle what it is: the DIŠ that opens an
        // omen is šumma, the same sign elsewhere is not.
        const ids = suggestLemmasFor(t.text, { initial: opensTheLine(words, t.pos) });
        if (ids.length) { setLemmasAt(lineNum, vi, t.pos, ids, 'auto'); filled++; }
        else blank++;
      }
    });
  }
  return { filled, blank };
}

// The whole chapter's lemmatization, in the shape POST …/lemmatization wants.
//
// One token for every reconstruction token and every manuscript token, in eBL's
// own order — the same indexing the alignment uses, dividers included. A token
// with no lemma is sent as a bare value, which is how eBL sends them too.
//
// A witness word takes the lemma of the reading word it is aligned to. That is
// not a guess: the alignment says those two words are the same word of the text,
// so if the reading word is dubbu, so is the witness's spelling of it. Words
// eBL holds no alignment for keep whatever lemma they already carry.
// `opts.includeSuggested` decides whether the dictionary's own guesses go.
//
// This matters more than it looks. POST …/lemmatization replaces the WHOLE
// chapter, and prefill fills every section — so sending the lemmas of one
// omen sends the machine's guesses for all ninety with it. A section nobody
// has opened arrives on eBL fully lemmatized by a dictionary lookup.
//
// So the default is to send only what a person confirmed. A suggestion left
// out is not lost: eBL keeps whatever it already had for that word.
async function buildLemmatizationPayload(chapter, opts) {
  const includeSuggested = !!(opts && opts.includeSuggested);
  const summary = { lines: 0, fromHere: [], tokens: 0, lemmatized: 0,
                    inherited: 0, kept: 0, unknown: [], broken: 0,
                    mismatched: [], mismatchedSections: [], losing: [],
                    suggested: 0, withheld: 0 };

  // eBL types [...] as a Word, but refuses to lemmatize one: a token made of
  // broken-away and unknown signs has no word in it to name. Sending one is a
  // 422 that names the token and rejects the whole chapter.
  //
  // The witnesses are where this bites. A witness word takes the lemma of the
  // reading word it is aligned to, and a break aligned to a real word would
  // inherit that word's lemma without anyone choosing it.
  const isBreak = (value) => (window.Lemmatizer
    ? Lemmatizer.skippable(value)
    : !String(value == null ? '' : value).replace(/[\[\]().x…\s⸢⸣]/g, ''));

  const payload = (chapter.lines || []).map((L) => {
    const sec = parseInt(L.number, 10);
    const mine = lemmaChoices[sec] || null;
    let touched = false;

    // Sending a line replaces the whole chapter line, variants and all, with
    // what this project holds. Where eBL has readings this project does not,
    // that is not a correction — it is a deletion, and it has to be said out
    // loud before anyone agrees to send twenty of them.
    const readingsHere = variantsFor(sec).filter((r) => (r.text || '').trim()).length;
    const readingsThere = (L.variants || []).length;
    if (readingsThere > readingsHere && mine && Object.keys(mine).length) {
      summary.losing.push('§' + L.number + ' — eBL has ' + readingsThere
        + ' readings, this project has ' + readingsHere
        + '; sending the line drops the extra ' + (readingsThere - readingsHere));
    }

    const variants = (L.variants || []).map((v, vi) => {
      // A lemma is stored against a position in THIS project's reading, and
      // sent against eBL's reconstruction token at the same index. Those are
      // only the same word while the two readings have the same tokens — and
      // when they do not, a lemma lands on whatever eBL happens to hold there.
      // That is how ana I ended up on a [...]: not a wrong lemma, a lemma on
      // the wrong word.
      const readingHere = variantsFor(sec)[vi];
      const oursCount = readingHere ? positionWords(readingHere.text || '')
        .filter((t) => t.pos != null).length : 0;
      const theirsCount = (v.reconstructionTokens || []).length;
      const aligned = !mine || !readingHere || oursCount === theirsCount;
      if (!aligned && mine && mine[vi] && Object.keys(mine[vi]).length) {
        summary.mismatched.push('§' + L.number + (vi ? ' reading ' + (vi + 1) : '')
          + ' — the reading here has ' + oursCount + ' tokens, eBL has ' + theirsCount
          + '; send the line first');
        if (summary.mismatchedSections.indexOf(sec) < 0) summary.mismatchedSections.push(sec);
      }

      // The reading. Positions count every reconstruction token, so the index
      // here is the index the editor sees in Positions mode.
      const byPos = {};
      const reconstruction = (v.reconstructionTokens || []).map((t, i) => {
        if (isBreak(t.value)) { summary.broken++; return { value: t.value }; }
        const chosenHere = aligned ? lemmaEntryAt(sec, vi, i) : null;
        if (chosenHere && chosenHere.by === 'auto') summary.suggested++;
        // A suggestion nobody has looked at is not an edition.
        const entry = (chosenHere && chosenHere.by === 'auto' && !includeSuggested)
          ? null : chosenHere;
        if (chosenHere && !entry) summary.withheld++;
        const ids = entry ? entry.ids : null;
        summary.tokens++;
        if (ids && ids.length) {
          touched = true;
          summary.lemmatized++;
          byPos[i] = ids;
          for (const id of ids) {
            if (window.Lemmatizer && Lemmatizer.loaded() && !Lemmatizer.known(id)) {
              summary.unknown.push('§' + L.number + ' word ' + i + ': ' + id);
            }
          }
          return { value: t.value, uniqueLemma: ids.slice() };
        }
        // Nothing chosen here, so whatever eBL holds stays.
        const held = (t.uniqueLemma || []);
        if (held.length) { summary.kept++; return { value: t.value, uniqueLemma: held.slice() }; }
        return { value: t.value };
      });

      const manuscripts = (v.manuscripts || []).map((m) => (m.atfTokens || []).map((t) => {
        summary.tokens++;
        if (isBreak(t.value)) { summary.broken++; return { value: t.value }; }
        const at = t.alignment;
        const inherited = (at != null && byPos[at]) ? byPos[at] : null;
        if (inherited) { summary.inherited++; return { value: t.value, uniqueLemma: inherited.slice() }; }
        const held = (t.uniqueLemma || []);
        if (held.length) { summary.kept++; return { value: t.value, uniqueLemma: held.slice() }; }
        return { value: t.value };
      }));

      return { reconstruction, manuscripts };
    });

    if (touched) summary.fromHere.push(L.number);
    summary.lines++;
    return variants;
  });

  return { payload, summary };
}

// Anything eBL will refuse, or that would leave its reader broken.
//
// A lemma id eBL cannot resolve is the dangerous one: its chapter view
// dereferences the dictionary lookup without a guard, so an unknown id does not
// fail the save — it breaks the page afterwards. Every id is checked against
// the shipped dictionary first.
function lemmatizationProblems(chapter, payload) {
  const out = [];
  (chapter.lines || []).forEach((L, li) => {
    (L.variants || []).forEach((v, vi) => {
      const built = (payload[li] || [])[vi];
      if (!built) return;
      const n = (v.reconstructionTokens || []).length;
      // A lemma on a break is a 422 that rejects the whole chapter, so it is
      // worth naming here even though the builder no longer emits one.
      const breaks = (value) => (window.Lemmatizer ? Lemmatizer.skippable(value) : false);
      built.reconstruction.forEach((t, i) => {
        if (t.uniqueLemma && t.uniqueLemma.length && breaks(t.value)) {
          out.push('§' + L.number + ' word ' + i + ': ' + t.value
            + ' is a break and cannot carry a lemma');
        }
      });
      built.manuscripts.forEach((tokens, mi) => tokens.forEach((t) => {
        if (t.uniqueLemma && t.uniqueLemma.length && breaks(t.value)) {
          out.push('§' + L.number + ' '
            + eblSiglumOf(chapter, ((v.manuscripts || [])[mi] || {}).manuscriptId)
            + ': ' + t.value + ' is a break and cannot carry a lemma');
        }
      }));
      if (built.reconstruction.length !== n) {
        out.push('§' + L.number + ': ' + built.reconstruction.length
          + ' reading tokens sent, eBL has ' + n);
      }
      (v.manuscripts || []).forEach((m, mi) => {
        const got = (built.manuscripts[mi] || []).length;
        const want = (m.atfTokens || []).length;
        if (got !== want) {
          out.push('§' + L.number + ' ' + eblSiglumOf(chapter, m.manuscriptId)
            + ': ' + got + ' tokens sent, eBL has ' + want);
        }
      });
    });
  });
  return out;
}

function lemmaTitle(state, ids) {
  if (state === 'skip') return 'Nothing to lemmatize here';
  if (state === 'none') return 'No lemma. Click to choose one.';
  const what = ids.join(' + ');
  return state === 'auto'
    ? what + ' — suggested by the dictionary, not yet confirmed. Click to confirm or change.'
    : what + ' — confirmed. Click to change.';
}

// Which words of a reading eBL will mark with a ‡, worked out the way eBL
// works it out: a word some witness either reads differently or has not got.
//
// Shown in the score itself, not only in the send preview — it is a fact about
// the edition, and the point of it is to see the published line before it is
// published.
// Judged per omen, like everything else the reader is shown: a witness that
// needs three lines for the omen omits a word only if none of the three has
// it, and it speaks once, not once per line.
function daggerPositions(lineNum, vi, reading) {
  const marks = new Map();
  const words = positionWords(reading.text || '');
  const { scoreLines } = buildScore();
  for (const om of omensOf(lineNum, vi, scoreLines)) {
    const byPos = {};
    let aligned = false;
    for (const w of om.rows) {
      const map = (lineAlignments[lineNum] || {})[w.siglum + '|' + w.sourceLine];
      if (!map || !Object.keys(map).length) continue;
      aligned = true;
      for (const t of witnessWords(w.content)) {
        if (t.index != null && map[t.index] != null) byPos[map[t.index]] = t.text;
      }
    }
    if (!aligned) continue;
    const tally = alignmentTally(lineNum, om.rows, words);
    const note = (pos, why) => {
      if (!marks.has(pos)) marks.set(pos, []);
      marks.get(pos).push(why);
    };
    for (const pos of tally.omitted) note(pos, displaySiglum(om.siglum) + ' omits it');
    for (const pos of (tally.differing || [])) {
      note(pos, displaySiglum(om.siglum) + ' reads ' + (byPos[pos] || '?'));
    }
  }
  return marks;
}

// The lemmas of a reading, each under the word it belongs to.
//
// Shown whether or not Lemmas mode is on, because a lemma is part of the
// edition and not a mode of working on it. The word is repeated above its
// lemma rather than the lemmas being listed on their own: a bare row of ids
// reads as a column of unrelated words, and the only thing that makes it
// legible is seeing which word each one answers to.
//
// It sits outside the reading rather than inside it — the reading is
// contenteditable in the ordinary view, and anything put in there is typed
// into.
function lemmaStrip(lineNum, vi, reading) {
  const words = positionWords(reading.text || '');
  const cells = [];
  let any = false;
  for (const t of words) {
    if (t.pos == null || t.divider) continue;
    const state = lemmaState(lineNum, vi, t.pos, t.text);
    if (state === 'skip') continue;
    const ids = lemmasAt(lineNum, vi, t.pos);
    if (ids.length) any = true;
    cells.push(`<span class="lem-pair is-${state}">`
      + `<span class="lem-pair-word">${renderAtf(t.text)}</span>`
      + `<span class="lem-pair-id">${escapeHtml(ids.length ? ids.join(' + ') : '·')}</span>`
      + '</span>');
  }
  if (!any) return '';
  return `<div class="lemma-strip" data-line="${lineNum}" data-variant="${vi}">`
    + cells.join('') + '</div>';
}

// Open the lemma picker on one word, in place.
//
// A list of our own rather than a <datalist>: a datalist decides for itself how
// many rows to show and cannot be scrolled to a chosen height, and its
// behaviour differs between browsers. Ten rows is enough to see the field
// without burying the line being read, and the rest is a scroll away.
//
// The list is anchored to the word, so the eye does not have to travel to find
// out what it is choosing for.
const LEMMA_ROWS_SHOWN = 10;

async function openLemmaDropdown(el) {
  if (!el || el.querySelector('input')) return;
  const lineNum = parseInt(el.dataset.line, 10);
  const vi = parseInt(el.dataset.variant, 10) || 0;
  const pos = parseInt(el.dataset.pos, 10);
  if (!Number.isFinite(lineNum) || !Number.isFinite(pos)) return;

  try { await Lemmatizer.load(); } catch (_) { return; }

  const reading = variantsFor(lineNum)[vi];
  if (!reading) return;
  const words = positionWords(reading.text || '');
  const word = (words.find((t) => t.pos === pos) || {}).text || '';
  const held = lemmasAt(lineNum, vi, pos);

  // What the dictionary reads as an ending written onto the word. Offered, not
  // imposed: MU-NI is not a base plus -ni, and while every save welded the
  // inferred ending back on there was no way to say so. Each one is a box the
  // editor can clear.
  //
  // A box starts ticked when the token already carries that ending, and for a
  // token with nothing on it yet. Once something has been chosen, an ending
  // that is not there was taken off on purpose and stays off.
  const endingIds = endingIdsOf(word);
  const endingOn = {};
  for (const id of endingIds) endingOn[id] = !held.length || held.indexOf(id) >= 0;
  // A word may be more than one lemma. UTU.È is one writing for ṣīt šamši, and
  // both halves belong on the token, so the box holds them joined by a + and
  // gives them back the same way.
  const base = held.filter((id) => endingIds.indexOf(id) < 0).join(' + ');
  const settled = Lemmatizer.glossaryFor(word);
  const suggestions = Lemmatizer.candidates(word, 60, { initial: opensTheLine(words, pos) })
    .filter((c) => !(settled && settled.indexOf(c.id) >= 0))
    .map((c) => ({ id: c.id, guide: c.guide, how: c.exact ? '' : c.how }));
  if (settled) {
    suggestions.unshift({
      id: settled.join(' + '),
      guide: settled.map((id) => Lemmatizer.guideWord(id) || '').filter(Boolean).join(' + '),
      how: 'this project reads it so',
    });
  }

  const idHtml = el.querySelector('.lem-id');
  const previous = idHtml ? idHtml.outerHTML : '';
  if (idHtml) {
    const parts = endingIds.map((id) => '<label class="lem-part">'
      + '<input type="checkbox" class="lem-part-box" data-id="' + escapeHtml(id) + '"'
      + (endingOn[id] ? ' checked' : '') + '>'
      + escapeHtml(id) + '</label>').join('');
    idHtml.outerHTML = '<span class="lem-edit">'
      + '<input class="lem-input" value="' + escapeHtml(base) + '"'
      + ' placeholder="lemma" autocomplete="off" spellcheck="false">'
      + '<button type="button" class="lem-add" title="Add another lemma to this word'
      + ' (a compound writes two words with one sign)">+</button>'
      + (parts ? '<span class="lem-parts">' + parts + '</span>' : '')
      + '<span class="lem-list" role="listbox"></span></span>';
  }
  const input = el.querySelector('.lem-input');
  const list = el.querySelector('.lem-list');
  if (!input || !list) return;

  let rows = suggestions;
  let active = -1;
  const PIN = String.fromCharCode(167);   // §, the mark the score already uses

  // One word can be several lemmas — UTU.È writes ṣīt šamši with two signs and
  // carries both — and the box holds them joined by a +. Everything below works
  // on the one under the caret, so each is completed on its own. Searching the
  // whole box meant that the moment a + was in it nothing matched at all, and
  // the second lemma had to be typed blind.
  const segmentAt = () => {
    const v = input.value;
    const c = input.selectionStart == null ? v.length : input.selectionStart;
    return v.slice(0, c).split('+').length - 1;
  };
  const segmentText = (i) => (input.value.split('+')[i] || '').trim();
  const putSegment = (i, text) => {
    const parts = input.value.split('+').map((x) => x.trim());
    while (parts.length <= i) parts.push('');
    parts[i] = text;
    input.value = parts.join(' + ');
    const upto = parts.slice(0, i + 1).join(' + ').length;
    try { input.setSelectionRange(upto, upto); } catch (_) { /* not focused yet */ }
  };
  // A lemma already standing in another slot is not a candidate for this one.
  const takenElsewhere = (i) => new Set(input.value.split('+')
    .map((x) => x.trim()).filter((x, n) => x && n !== i));

  const refresh = () => {
    const i = segmentAt();
    const q = segmentText(i);
    const taken = takenElsewhere(i);
    const found = q
      ? Lemmatizer.search(q, 60).map((r) => ({ id: r.id, guide: r.guide, how: '' }))
      : suggestions;
    rows = found.filter((r) => !taken.has(r.id));
    // Nothing typed in this slot, nothing selected: Enter on an empty box has
    // to clear the word rather than put the first suggestion back.
    active = q && rows.length ? 0 : -1;
    paint();
  };

  // Fill the slot under the caret, then save. Choosing one lemma is the common
  // case and still takes one click.
  const pick = (id, teach) => { putSegment(segmentAt(), id); commit(null, teach); };

  const paint = () => {
    list.innerHTML = rows.length
      ? rows.map((r, i) => '<span class="lem-option' + (i === active ? ' is-active' : '')
          + '" data-i="' + i + '" role="option">'
          + '<span class="lem-option-id">' + escapeHtml(r.id) + '</span>'
          + '<span class="lem-option-guide">' + escapeHtml(r.guide || '') + '</span>'
          + (r.how ? '<span class="lem-option-how">' + escapeHtml(r.how) + '</span>' : '')
          // Choosing settles this word; the mark settles the whole project.
          + '<span class="lem-pin" data-pin="' + i + '" title="Read '
          + escapeHtml(word) + ' this way everywhere in this project">' + PIN + '</span>'
          + '</span>').join('')
      : '<span class="lem-option is-empty">nothing matches that</span>';
    const on = list.querySelector('.is-active');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };

  const commit = (id, teach) => {
    // Only a lemma the dictionary knows may be stored. An id eBL cannot resolve
    // does not fail the save — it breaks the chapter page afterwards.
    const chosen = [];
    const typed = String(id == null ? input.value : id).trim();
    // Several lemmas on one word are written with a +, the way the project
    // dictionary records them.
    for (const piece of typed.split('+').map((x) => x.trim()).filter(Boolean)) {
      if (Lemmatizer.known(piece)) { chosen.push(piece); continue; }
      const found = Lemmatizer.search(piece, 1);
      if (found.length) chosen.push(found[0].id);
    }
    if (typed && !chosen.length) { close(false); return; }
    const ids = chosen.slice();
    // Only the endings still ticked.
    for (const box of el.querySelectorAll('.lem-part-box')) {
      const id = box.dataset.id;
      if (box.checked && id && ids.indexOf(id) < 0) ids.push(id);
    }
    setLemmasAt(lineNum, vi, pos, chosen.length ? ids : [], 'hand');
    // Recorded for the project, the reading answers this word everywhere it is
    // written, on lines not yet looked at as well as this one.
    if (teach && chosen.length) {
      teachProjectLemma(word, chosen).then(() => {
        setStatus('connected', word + ' ' + String.fromCharCode(8594) + ' '
          + chosen.join(' + ') + ', for the whole project');
        setTimeout(() => setStatus('connected', 'Ready'), 4000);
      });
    } else {
      saveScoreDataToFile();
    }
    close(false);
  };

  let closed = false;
  function close(restore) {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', onOutside, true);
    if (restore && previous) {
      const edit = el.querySelector('.lem-edit');
      if (edit) edit.outerHTML = previous;
    } else {
      renderScore();
    }
  }

  const onOutside = (e) => { if (!el.contains(e.target)) close(true); };
  document.addEventListener('mousedown', onOutside, true);

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 120);
  });
  // Moving the caret between slots changes which lemma is being completed.
  input.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'
      || e.key === 'Home' || e.key === 'End') refresh();
  });
  input.addEventListener('click', refresh);

  // The next word to tag, as coordinates rather than as an element: committing
  // rebuilds the score, so anything held by reference is gone by the time it
  // would be used.
  const neighbour = (dir) => {
    const all = [...document.querySelectorAll('.lem-word')].filter((x) =>
      !x.classList.contains('is-divider') && !x.classList.contains('is-skip'));
    const at = all.indexOf(el);
    const to = at < 0 ? null : all[at + dir];
    return to ? { line: to.dataset.line, variant: to.dataset.variant, pos: to.dataset.pos } : null;
  };

  const openAt = (where) => {
    if (!where) return;
    const next = [...document.querySelectorAll('.lem-word')].find((x) =>
      x.dataset.line === where.line && x.dataset.variant === where.variant
      && x.dataset.pos === where.pos);
    if (next) openLemmaDropdown(next);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, rows.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // Ctrl-Enter records the reading for the project, the same as the §
      // beside the row: the hands are already on the keyboard by then.
      if (active >= 0 && rows[active]) pick(rows[active].id, e.ctrlKey || e.metaKey);
      else commit(null, e.ctrlKey || e.metaKey);
    } else if (e.key === 'Tab') {
      // Tab takes what is in the box and moves to the next word, which is the
      // whole of the work: read the suggestion, accept it or change it, move
      // on. Accepting counts as confirming — that is what going through them
      // one by one means, and it is the difference between a dictionary lookup
      // and an edition.
      e.preventDefault();
      const where = neighbour(e.shiftKey ? -1 : 1);
      if (active >= 0 && rows[active]) pick(rows[active].id);
      else commit(null);
      // After the re-render, not before it.
      setTimeout(() => openAt(where), 0);
    } else if (e.key === 'Escape') { e.preventDefault(); close(true); }
  });

  list.addEventListener('mousedown', (e) => {
    const pin = e.target.closest ? e.target.closest('.lem-pin') : null;
    if (pin) {
      e.preventDefault();
      const r = rows[Number(pin.dataset.pin)];
      if (r) pick(r.id, true);
      return;
    }
    const row = e.target.closest ? e.target.closest('.lem-option') : null;
    if (!row || row.classList.contains('is-empty')) return;
    e.preventDefault();   // keep the input focused through the click
    const r = rows[Number(row.dataset.i)];
    if (r) pick(r.id);
  });

  // Add a slot. A compound logogram is one writing for two words, and after the
  // + the word's own candidates are offered again for the second — minus the
  // one already taken, which is what makes ṣītu I + šamšu I two clicks.
  const addBtn = el.querySelector('.lem-add');
  if (addBtn) addBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    input.value = v ? v + ' + ' : '';
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) { /* ignore */ }
    refresh();
  });

  // Ticking a box leaves the keyboard on the box, where Enter would toggle it
  // again instead of saving. Hand the input back so the row can be finished
  // the way every other row is finished.
  for (const box of el.querySelectorAll('.lem-part-box')) {
    box.addEventListener('change', () => input.focus());
  }

  paint();
  input.focus();
  input.select();
}

// Send the chapter's lemmas.
async function exportLemmatization() {
  const target = (projectConfig && projectConfig.ebl && projectConfig.ebl.target) || null;
  if (!target) {
    showComposeReport('Lemmas', [noteBlock('No eBL chapter is configured. Set one in Settings.', 'bad')]);
    return;
  }
  const ts = EblClient.tokenStatus();
  if (!ts.hasToken || ts.invalid || ts.expired || !ts.hasWriteTexts) {
    showComposeReport('Lemmas', [noteBlock('This needs an eBL token with write:texts.', 'bad')]);
    return;
  }

  if (!await askAboutUncurated(null, 'the lemmas')) return;

  setStatus('connected', 'Reading the chapter...');
  let chapter, built;
  try {
    await Lemmatizer.load();
    chapter = await EblClient.getChapter(target);
    built = await buildLemmatizationPayload(chapter);
  } catch (err) {
    setStatus('connected', 'Ready');
    showComposeReport('Lemmas', [noteBlock(String(err && err.message || err), 'bad')]);
    return;
  }
  setStatus('connected', 'Ready');

  // Reassigned when the blocking lines are sent and the chapter re-read.
  let s = built.summary;
  if (!s.fromHere.length) {
    showComposeReport('Lemmas — nothing to send', [
      outcomeBanner('none', 'The chapter', 'No word has been given a lemma here yet.'),
      noteBlock('Turn on Lemmas and click a word of a reading to choose one.'),
    ]);
    return;
  }

  // Sections whose reading no longer matches eBL's carry lemmas that cannot
  // be placed. Sending their lines is what makes them placeable, so the offer
  // is made here rather than left as an instruction in a report.
  if (s.mismatchedSections.length) {
    const go = await askOverlay('Send those lines first?', [
      outcomeBanner('notsent', 'Lemmas', s.mismatchedSections.length + ' section(s) hold'
        + ' lemmas that cannot be sent yet.'),
      noteBlock('This project and eBL do not agree on how many words these readings'
        + ' have, so a lemma would land on the wrong word. Sending each line replaces'
        + ' the reading on eBL with the one here, after which the lemmas fit.', 'warn'),
      rawBlock(s.mismatched.slice(0, 30).join(String.fromCharCode(10))),
      noteBlock('Each is its own request; one refusal does not stop the rest.'),
      s.losing.length ? noteBlock(s.losing.length + ' of these would DELETE readings'
        + ' eBL holds and this project does not. A line export replaces the whole'
        + ' chapter line, variants and all.', 'bad') : '',
      s.losing.length ? rawBlock(s.losing.slice(0, 20).join(String.fromCharCode(10))) : '',
      noteBlock('Checking the ATF first takes roughly a second and a half per'
        + ' section — about ' + Math.max(1, Math.round(s.mismatchedSections.length * 1.5))
        + ' seconds here — before anything is sent.'),
    ], 'Send ' + s.mismatchedSections.length + ' line(s), then the lemmas', true);
    if (go) {
      const run = await sendLinesFor(target, s.mismatchedSections, 'Lemmas');
      setStatus('connected', 'Reading the chapter again…');
      try {
        chapter = await EblClient.getChapter(target);
        built = await buildLemmatizationPayload(chapter);
        s = built.summary;
      } catch (err) {
        setStatus('connected', 'Ready');
        showComposeReport('Lemmas', [
          outcomeBanner('changed', 'The lines', run.sent.length + ' line(s) went, but the'
            + ' chapter could not be read back.'),
          rawBlock(String(err && err.message || err)),
        ], 'lemma-lines');
        return;
      }
      setStatus('connected', 'Ready');
      if (run.unchecked) {
        const anyway = await askOverlay('The ATF could not be checked', [
          outcomeBanner('changed', 'The lines', run.sent.length + ' line(s) were sent'
            + ' without being checked here first.'),
          noteBlock('The local validator did not answer: ' + run.unchecked
            + '. eBL checks each line itself and refuses a bad one on its own, so'
            + ' nothing is broken by this — but this app did not verify them.', 'warn'),
          noteBlock('Carry on to the lemmas?'),
        ], 'Carry on', false);
        if (!anyway) return;
      }
      if (run.refused.length) {
        const carryOn = await askOverlay('Some lines were refused', [
          outcomeBanner(run.sent.length ? 'changed' : 'notsent', 'The lines',
            run.sent.length + ' sent, ' + run.refused.length + ' refused.'),
          rawBlock(run.refused.slice(0, 20).join(String.fromCharCode(10))),
          noteBlock('The refused sections keep their old reading on eBL, so their lemmas'
            + ' still cannot be sent. Carry on with the rest?'),
        ], 'Carry on', false);
        if (!carryOn) return;
      }
    }
  }

  const problems = lemmatizationProblems(chapter, built.payload)
    .concat(s.unknown.map((u) => u + '  (not in the dictionary)'));
  if (problems.length) {
    showComposeReport('Lemmas — not sent', [
      outcomeBanner('notsent', 'The chapter', problems.length + ' problem'
        + (problems.length === 1 ? '' : 's') + '. Nothing was sent.'),
      noteBlock('A lemma eBL cannot resolve does not fail the save — it breaks the'
        + ' chapter page afterwards, so it is refused here.', 'bad'),
      rawBlock(problems.slice(0, 30).join(String.fromCharCode(10))),
    ], 'lemma-problems');
    return;
  }

  const ok = await askOverlay('Send the lemmas?', [
    s.suggested ? noteBlock(s.suggested + ' of these came from the dictionary and'
      + ' nobody has confirmed them. They are NOT being sent — eBL keeps whatever it'
      + ' already holds for those words. Run this again from the omen export if you'
      + ' want them.', 'warn') : '',
    '<div class="report-counts">'
      + '<span class="report-count is-done"><b>' + s.lemmatized + '</b> words lemmatized here</span>'
      + '<span class="report-count"><b>' + s.inherited + '</b> witness words inheriting</span>'
      + '<span class="report-count"><b>' + s.kept + '</b> kept as eBL has them</span>'
      + '</div>',
    noteBlock('A witness word takes the lemma of the reading word it is aligned to.'
      + ' Align a section first and its witnesses come with it.'),
    noteBlock('This replaces the lemmas of every line at once, so the lines not'
      + ' lemmatized here go back exactly as they stand on eBL.', 'warn'),
    noteBlock('From here: §' + s.fromHere.join(', §')),
  ], 'Send', true);
  if (!ok) return;

  setStatus('connected', 'Sending the lemmas...');
  try {
    await EblClient.postLemmatization(target, built.payload);
  } catch (err) {
    setStatus('connected', 'Ready');
    const detail = (err instanceof EblClient.EblError && err.validationErrors)
      ? err.validationErrors.map((e) => (e.line != null ? 'Line ' + e.line + ': ' : '') + e.message)
          .join(String.fromCharCode(10))
      : (err.rawBody || err.message || String(err));
    showComposeReport('Lemmas were not sent', [
      outcomeBanner('notsent', 'The chapter', 'eBL refused the payload.'),
      rawBlock(String(detail).slice(0, 1200)),
    ], 'lemma-error');
    return;
  }

  setStatus('connected', 'Lemmas sent');
  setTimeout(() => setStatus('connected', 'Ready'), 5000);
  showComposeReport('Lemmas sent', [
    outcomeBanner('sent', 'The chapter', s.lemmatized + ' word'
      + (s.lemmatized === 1 ? '' : 's') + ' lemmatized, ' + s.inherited
      + ' carried to the witnesses.'),
    noteBlock('Reload eBL to see them — the chapter page is cached.'),
  ], 'lemmas');
}

// What this section's lemmas say, for the send preview.
//
// Every word is listed with the lemma it carries and who put it there, because
// a prefilled chapter goes out with the dictionary's guesses in it unless
// somebody has looked. Reading this list before pressing Send is the moment
// where "I never chose Adaru" is supposed to become visible.
async function lemmaPreview(lineNum) {
  const readings = variantsFor(lineNum);
  const { scoreLines } = buildScore();
  if (!(scoreLines[lineNum] || []).length) return { blocks: [], held: 0 };

  try { await Lemmatizer.load(); } catch (_) { /* ids still list, just without glosses */ }

  const rows = [];
  let held = 0, hand = 0, auto = 0, blank = 0;

  readings.forEach((reading, vi) => {
    const words = positionWords(reading.text || '').filter((t) => t.pos != null && !t.divider);
    if (!words.length) return;
    if (readings.length > 1) rows.push('Reading ' + (vi + 1));
    for (const t of words) {
      const state = lemmaState(lineNum, vi, t.pos, t.text);
      if (state === 'skip') continue;
      const ids = lemmasAt(lineNum, vi, t.pos);
      if (ids.length) {
        held++;
        if (state === 'hand') hand++; else auto++;
      } else {
        blank++;
      }
      const gloss = ids.map((id) => {
        const g = window.Lemmatizer && Lemmatizer.loaded() ? Lemmatizer.guideWord(id) : '';
        return id + (g ? ' (' + g + ')' : '');
      }).join(' + ');
      rows.push('  ' + String(t.pos).padStart(3) + '  ' + t.text.padEnd(18)
        + (ids.length ? gloss : '—').padEnd(46)
        + (state === 'hand' ? 'confirmed' : state === 'auto' ? 'suggested' : ''));
    }
    rows.push('');
  });

  if (!held && !blank) return { blocks: [], held: 0 };

  return {
    held,
    blocks: [
      '<details class="export-preview-wrap"' + (auto ? ' open' : '') + '>'
        + '<summary>Lemmas held here — ' + held + ' word' + (held === 1 ? '' : 's')
        + (auto ? ', ' + auto + ' still only suggested' : '')
        + (blank ? ', ' + blank + ' with none' : '') + '</summary>'
        + '<pre class="export-preview">' + escapeHtml(rows.join(String.fromCharCode(10)).trim())
        + '</pre></details>',
      auto
        ? noteBlock(auto + ' of these came from the dictionary and nobody has confirmed'
            + ' them. They will be sent exactly as they stand — check the list above if'
            + ' that is not what you want.', 'warn')
        : noteBlock('Every lemma here was chosen by hand.'),
    ],
  };
}

// Which sections still carry lemmas nobody has looked at.
//
// Prefill fills every word of every section, so "has lemmas" says nothing about
// whether anyone agreed with them. This is the difference between an edition
// and a dictionary lookup, and it is the thing to be asked about before either
// goes to eBL.
function uncuratedSections(only) {
  const out = [];
  const sections = only != null ? [only]
    : Object.keys(lemmaChoices).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  for (const lineNum of sections) {
    const line = lemmaChoices[lineNum] || {};
    let auto = 0, hand = 0;
    for (const vi of Object.keys(line)) {
      const slot = line[vi] || {};
      for (const pos of Object.keys(slot)) {
        const held = slot[pos];
        const by = Array.isArray(held) ? 'hand' : ((held && held.by) || 'hand');
        if (by === 'auto') auto++; else hand++;
      }
    }
    if (auto) out.push({ lineNum, auto, hand });
  }
  return out;
}

// Mark every suggestion in these sections as confirmed.
function curateSections(list) {
  let n = 0;
  for (const { lineNum } of list) {
    const line = lemmaChoices[lineNum] || {};
    for (const vi of Object.keys(line)) {
      const slot = line[vi] || {};
      for (const pos of Object.keys(slot)) {
        const held = slot[pos];
        if (Array.isArray(held) || !held || held.by !== 'auto') continue;
        held.by = 'hand';
        n++;
      }
    }
  }
  return n;
}

// Ask before sending: these sections hold lemmas the dictionary chose and
// nobody has confirmed. Taking them marks them as yours, and they go with the
// rest. Declining leaves them behind — eBL keeps whatever it already had.
//
// Returns true to carry on, false to stop.
async function askAboutUncurated(only, what) {
  const list = uncuratedSections(only);
  if (!list.length) return true;

  const words = list.reduce((a, s) => a + s.auto, 0);
  const lines = list.slice(0, 40).map((s) => '§' + s.lineNum + '   '
    + s.auto + ' suggested' + (s.hand ? ',  ' + s.hand + ' confirmed' : ''));

  const take = await askOverlay('Lemmas nobody has confirmed', [
    outcomeBanner('kept', list.length + ' section' + (list.length === 1 ? '' : 's'),
      words + ' word' + (words === 1 ? '' : 's') + ' the dictionary chose on its own.'),
    rawBlock(lines.join(String.fromCharCode(10))
      + (list.length > 40 ? String.fromCharCode(10) + '…and ' + (list.length - 40) + ' more' : '')),
    noteBlock('Sending ' + what + ' replaces the lemmas of the WHOLE chapter, so this'
      + ' asks about every section, not only the one being sent.', 'warn'),
    noteBlock('Take them: they are marked as yours and go with the rest.'
      + ' Leave them: they stay here and eBL keeps whatever it already holds.'),
  ], 'Take all ' + words, false);

  if (take) {
    const n = curateSections(list);
    await saveScoreDataToFile();
    keepScoreInView(renderScore);
    setStatus('connected', n + ' suggestion(s) marked as yours');
    setTimeout(() => setStatus('connected', 'Ready'), 4000);
  }
  return true;
}

// The third part of sending one section: put its lemmas back.
//
// Like alignment, eBL has no per-line endpoint — POST …/lemmatization replaces
// the whole chapter's — so every line is rebuilt and sent together, with every
// line but this one going back exactly as eBL holds it.
//
// It runs after the alignment, and not by accident: a witness word takes the
// lemma of the reading word it is aligned to, so the alignment has to be on eBL
// before the chapter is read for the lemma payload, or the witnesses inherit
// nothing.
//
// Never throws. The line and the alignment are already committed by the time
// this runs.
async function sendLemmasFor(target, label, includeSuggested) {
  setStatus('connected', label + ' — sending the lemmas…');
  try {
    await Lemmatizer.load();
    const chapter = await EblClient.getChapter(target);
    const built = await buildLemmatizationPayload(chapter, { includeSuggested });

    const problems = lemmatizationProblems(chapter, built.payload)
      .concat(built.summary.unknown.map((u) => u + '  (not in the dictionary)'));
    if (problems.length) return { problems };

    await EblClient.postLemmatization(target, built.payload);
    return { sent: true, summary: built.summary };
  } catch (err) {
    const detail = (err instanceof EblClient.EblError && err.validationErrors)
      ? err.validationErrors.map((e) => (e.line != null ? 'Line ' + e.line + ': ' : '') + e.message)
          .join(String.fromCharCode(10))
      : (err.rawBody || err.message || String(err));
    return { failed: String(detail) };
  }
}

// How that went, as blocks for the report the line export already shows.
function lemmaOutcome(r) {
  if (!r) return [];
  if (r.skipped) return [noteBlock(r.skipped)];
  if (r.failed) {
    return [
      '<h4 class="report-heading">The lemmas did not go</h4>',
      noteBlock('The line and its alignment are on eBL. The lemmas were refused —'
        + ' try Export › Send the lemmas again.', 'bad'),
      rawBlock(String(r.failed).slice(0, 1200)),
    ];
  }
  if (r.problems) {
    return [
      '<h4 class="report-heading">The lemmas were held back</h4>',
      noteBlock(r.problems.length + ' problem' + (r.problems.length === 1 ? '' : 's')
        + '. A lemma eBL cannot resolve does not fail the save — it breaks the'
        + ' chapter page afterwards, so nothing was sent.', 'bad'),
      rawBlock(r.problems.slice(0, 20).join(String.fromCharCode(10))),
    ];
  }
  const s = r.summary || { lemmatized: 0, inherited: 0, kept: 0 };
  const out = [
    '<h4 class="report-heading">Lemmas</h4>',
    '<div class="report-counts">'
      + '<span class="report-count is-done"><b>' + s.lemmatized + '</b> words lemmatized</span>'
      + '<span class="report-count"><b>' + s.inherited + '</b> carried to the witnesses</span>'
      + '<span class="report-count"><b>' + s.kept + '</b> kept as eBL has them</span>'
      + '</div>',
  ];
  if (s.withheld) {
    out.push(noteBlock(s.withheld + ' suggested lemma(s) across the chapter were NOT'
      + ' sent — the dictionary proposed them and nobody has confirmed them. Tick'
      + ' the box under “Its lemmas” to include them.'));
  }
  if (s.mismatched && s.mismatched.length) {
    out.push(noteBlock(s.mismatched.length + ' section(s) hold lemmas that were not'
      + ' sent: this project and eBL do not agree on how many words the reading has,'
      + ' so a lemma would land on the wrong word. Send those lines first.', 'warn'));
    out.push(rawBlock(s.mismatched.slice(0, 12).join(String.fromCharCode(10))));
  }
  return out;
}

// The second half of sending one section: put its alignment back.
//
// eBL has no per-line alignment endpoint — POST …/alignment replaces the whole
// chapter's — so this rebuilds every line and sends them together. Every line
// but this one goes back exactly as eBL holds it, so the effect is confined to
// the section just sent (and to repairing any line eBL is holding in a state
// its own editor cannot save).
//
// The chapter is read again first, and that is not optional: the line was just
// replaced, so eBL has re-tokenized it, and an alignment built against the
// chapter as it looked beforehand would index tokens that no longer exist.
//
// Never throws. The line is already committed by the time this runs, and a
// failure here has to be reportable next to a success there.
async function sendAlignmentFor(target, label) {
  setStatus('connected', label + ' — sending the alignment…');
  try {
    const chapter = await EblClient.getChapter(target);
    const before = countAlignedTokens(chapter);
    const built = await buildAlignmentPayload(chapter);

    const problems = alignmentProblems(chapter, built.payload);
    if (problems.length) return { problems, before };

    await EblClient.postAlignment(target, built.payload);

    let after = null;
    try { after = countAlignedTokens(await EblClient.getChapter(target)); } catch (_) { /* not fatal */ }
    return { sent: true, before, after, summary: built.summary };
  } catch (err) {
    const detail = (err instanceof EblClient.EblError && err.validationErrors)
      ? err.validationErrors.map((e) => (e.line != null ? 'Line ' + e.line + ': ' : '') + e.message)
          .join(String.fromCharCode(10))
      : (err.rawBody || err.message || String(err));
    return { failed: String(detail) };
  }
}

// How that went, as blocks for the report the line export already shows.
function alignmentOutcome(r) {
  if (!r) return [];
  if (r.skipped) return [noteBlock(r.skipped)];
  if (r.failed) {
    return [
      '<h4 class="report-heading">The line went, the alignment did not</h4>',
      noteBlock('The line is on eBL. The alignment was refused, so the words on that'
        + ' line are not paired to the reading yet — try Export › Alignment again.', 'bad'),
      rawBlock(String(r.failed).slice(0, 1200)),
    ];
  }
  if (r.problems) {
    return [
      '<h4 class="report-heading">The line went, the alignment was held back</h4>',
      noteBlock(r.problems.length + ' line' + (r.problems.length === 1 ? '' : 's')
        + ' eBL would refuse, so nothing was sent rather than leaving a line its own'
        + ' editor cannot save.', 'bad'),
      rawBlock(r.problems.slice(0, 20).join(String.fromCharCode(10))),
    ];
  }
  const s = r.summary || { aligned: 0, variants: 0, unmatched: [] };
  const out = [
    '<h4 class="report-heading">Alignment</h4>',
    '<div class="report-counts">'
      + '<span class="report-count"><b>' + r.before + '</b> aligned before</span>'
      + '<span class="report-count is-done"><b>' + (r.after == null ? '?' : r.after)
      + '</b> aligned now</span>'
      + (s.variants ? '<span class="report-count"><b>' + s.variants + '</b> token variants</span>' : '')
      + '</div>',
  ];
  if (s.unmatched && s.unmatched.length) {
    out.push(noteBlock(s.unmatched.length + ' witness(es) hold positions here that could not be'
      + ' sent, because eBL keeps them under a different reading of their line.', 'warn'));
    out.push(rawBlock(s.unmatched.slice(0, 10).join(String.fromCharCode(10))));
  }
  if (s.doubled && s.doubled.length) {
    out.push(noteBlock('A commentary quoted the same word twice on one line, and eBL'
      + ' lets only one token of a line claim a word. The quotation that agrees with'
      + ' the reading kept it; the repeat went out unaligned.'));
    out.push(rawBlock(s.doubled.slice(0, 10).join(String.fromCharCode(10))));
  }
  return out;
}

// Would sending this list renumber anything eBL already holds? The comparison
// itself lives in the client, because Settings asks the same question before it
// registers a manuscript.
async function manuscriptIdChanges(target, sending) {
  let held = [];
  try {
    const chapter = await EblClient.getChapter(target);
    held = chapter.manuscripts || [];
  } catch (_) {
    return [];   // a chapter that cannot be read has nothing to disagree with
  }
  if (!held.length) return [];
  return EblClient.compareManuscripts(held, sending).moved.map((m) =>
    m.museumNumber + ' — eBL has it as manuscript ' + m.from
    + ', this would send it as ' + m.to);
}

// Everything eBL will refuse, found before it is sent.
//
// The rules are not documented anywhere this app can read, so they are the ones
// its own stored data obeys: an index names a reconstruction word that exists,
// no two tokens of a line claim the same word, and a word is never both omitted
// and aligned. A line breaking the last one cannot be saved in eBL's own
// editor afterwards — the error names the manuscript and leaves the editor
// stuck — so it is worth refusing here.
function alignmentProblems(chapter, payload) {
  const out = [];
  (chapter.lines || []).forEach((L, li) => {
    (L.variants || []).forEach((v, vi) => {
      const toks = v.reconstructionTokens || [];
      const n = toks.length;
      (v.manuscripts || []).forEach((m, mi) => {
        const built = ((payload[li] || [])[vi] || [])[mi];
        if (!built) return;
        const at = '§' + L.number + ' ' + eblSiglumOf(chapter, m.manuscriptId)
          + ' ' + (m.number == null ? '' : m.number) + ': ';
        const claimed = new Map();
        for (const t of (built.alignment || [])) {
          const a = t.alignment;
          if (a == null) continue;
          if (!(typeof a === 'number' && a >= 0 && a < n)) {
            out.push(at + 'points at word ' + a + ', but the reading has '
              + n + ' word' + (n === 1 ? '' : 's'));
            continue;
          }
          claimed.set(a, (claimed.get(a) || 0) + 1);
        }
        // Within one manuscript line, one token per word: eBL's editor hides
        // a word already assigned on that line, and the send fails. Another
        // line of the same witness may claim the word again — that is fine.
        for (const [a, count] of claimed) {
          if (count > 1) out.push(at + 'word ' + a + ' (' + (toks[a] || {}).value
            + ') is claimed by ' + count + ' tokens of one line');
        }
        for (const o of (built.omittedWords || [])) {
          if (!(typeof o === 'number' && o >= 0 && o < n)) {
            out.push(at + 'omits word ' + o + ', which the reading does not have');
          } else if (claimed.has(o)) {
            out.push(at + 'word ' + o + ' (' + (toks[o] || {}).value
              + ') is both omitted and aligned');
          }
        }
      });
    });
  });
  return out;
}

function eblSiglumOf(chapter, id) {
  const m = (chapter.manuscripts || []).find((x) => x.id === id);
  if (!m) return 'ms' + id;
  const part = (x) => (x && typeof x === 'object' ? (x.abbreviation || '') : (x || ''));
  return (part(m.provenance) + part(m.period) + part(m.type)
    + (m.siglumDisambiguator || '')) || ('ms' + id);
}

// Show what it would do, then send it if asked.
async function exportAlignment() {
  const target = (projectConfig && projectConfig.ebl && projectConfig.ebl.target) || null;
  if (!target) {
    showComposeReport('Alignment', [noteBlock('No eBL chapter is configured. Set one in Settings.', 'bad')]);
    return;
  }
  const ts = EblClient.tokenStatus();
  if (!ts.hasToken || ts.invalid || ts.expired || !ts.hasWriteTexts) {
    showComposeReport('Alignment', [noteBlock('This needs an eBL token with write:texts.', 'bad')]);
    return;
  }

  setStatus('connected', 'Reading the chapter…');
  let chapter, built;
  try {
    chapter = await EblClient.getChapter(target);
    built = await buildAlignmentPayload(chapter);
  } catch (err) {
    setStatus('connected', 'Ready');
    showComposeReport('Alignment', [noteBlock(String(err && err.message || err), 'bad')]);
    return;
  }
  setStatus('connected', 'Ready');

  const before = countAlignedTokens(chapter);
  const s = built.summary;
  if (!s.fromHere.length) {
    showComposeReport('Alignment — nothing to send', [
      outcomeBanner('none', 'The chapter', 'No section has been aligned in Positions mode yet.'),
      noteBlock('Align a section first: turn on Positions and give the witness words their'
        + ' numbers, or compose a reading, which fills them in.'),
    ]);
    return;
  }

  const problems = alignmentProblems(chapter, built.payload);
  if (problems.length) {
    showComposeReport('Alignment — not sent', [
      outcomeBanner('notsent', 'The chapter', problems.length + ' line'
        + (problems.length === 1 ? '' : 's') + ' eBL would refuse. Nothing was sent.'),
      noteBlock('Each of these would leave the line unsaveable in eBL’s own editor.', 'bad'),
      rawBlock(problems.slice(0, 40).join(String.fromCharCode(10))),
      problems.length > 40 ? noteBlock('…and ' + (problems.length - 40) + ' more.') : '',
    ], 'alignment-problems');
    return;
  }

  const ok = await askOverlay('Send the alignment?', [
    '<div class="report-counts">'
      + `<span class="report-count is-done"><b>${s.fromHere.length}</b> section(s) from here</span>`
      + `<span class="report-count"><b>${s.lines - s.fromHere.length}</b> sent back unchanged</span>`
      + `<span class="report-count"><b>${s.aligned}</b> aligned tokens</span>`
      + (s.variants ? `<span class="report-count is-done"><b>${s.variants}</b> token variants</span>` : '')
      + `<span class="report-count"><b>${s.omitted}</b> omitted words</span>`
      + '</div>',
    noteBlock('eBL holds ' + before + ' aligned tokens now; this payload carries ' + s.aligned
      + '. It replaces the alignment of every line at once, so the sections not aligned here'
      + ' are being sent back exactly as they came.', 'warn'),
    noteBlock('Aligned from here: §' + s.fromHere.join(', §')),
    s.unmatched.length ? '<h4 class="report-heading">' + s.unmatched.length
      + ' witness(es) aligned here but left unchanged</h4>' : '',
    s.unmatched.length ? rawBlock(s.unmatched.slice(0, 20).join(String.fromCharCode(10))) : '',
    s.unmatched.length ? noteBlock('These hold positions in this project, but eBL keeps them'
      + ' under a different reading of the line. Their positions count words in this'
      + ' project’s reading, so sending them would point each word at the wrong one.'
      + ' Split the line here the way eBL has it, or move the witness, and they will go.', 'warn') : '',
    s.unmatched.length
      ? noteBlock(s.unmatched.length + ' witness line(s) left as eBL has them: '
          + s.unmatched.slice(0, 6).join('; ')
          + (s.unmatched.length > 6 ? '; …' : ''), 'warn')
      : '',
  ], 'Send', true);
  if (!ok) return;

  setStatus('connected', 'Sending the alignment…');
  try {
    await EblClient.postAlignment(target, built.payload);
  } catch (err) {
    setStatus('connected', 'Ready');
    const fail = failureReport('The chapter alignment', err);
    const blocks = fail.blocks;
    supersedeExportIssues('alignment', null);
    addExportIssue({
      sec: null, part: 'alignment', kind: 'error',
      title: fail.title,
      detail: fail.detail, report: blocks.join(''),
    });
    updateReportsBadge();
    await saveScoreDataToFile();
    showComposeReport(fail.transport ? 'Alignment — no answer' : 'Alignment was not sent',
      blocks, 'alignment-error');
    return;
  }

  // Read it back: the only way to know what eBL kept.
  let after = null;
  try { after = countAlignedTokens(await EblClient.getChapter(target)); } catch (_) { /* not fatal */ }
  setStatus('connected', 'Alignment sent');
  setTimeout(() => setStatus('connected', 'Ready'), 5000);

  const blocks = [
    outcomeBanner('changed', 'The chapter', 'Read back from eBL after sending.'),
    '<div class="report-counts">'
      + `<span class="report-count"><b>${before}</b> aligned before</span>`
      + `<span class="report-count is-done"><b>${after == null ? '?' : after}</b> aligned now</span>`
      + `<span class="report-count"><b>${s.variants}</b> token variants sent</span>`
      + '</div>',
    noteBlock(after != null && after < s.aligned
      ? 'eBL kept fewer than were sent. Some tokens it did not consider alignable, or the'
        + ' reading changed under them.'
      : 'Sent from §' + s.fromHere.join(', §') + '.'),
  ];

  // Filed even when clean: the reports page is the log of every send. What
  // went but wants a look on eBL afterwards — a repeated quotation left
  // unaligned, a witness kept under another reading — rides on it as notes.
  const checkLater = [...(s.doubled || []), ...(s.unmatched || [])];
  supersedeExportIssues('alignment', null);
  addExportIssue({
    sec: null, part: 'alignment',
    kind: checkLater.length ? 'notice' : 'ok',
    title: 'Chapter alignment sent'
      + (checkLater.length ? ' — ' + checkLater.length + ' thing(s) to check on eBL' : ''),
    notes: checkLater,
    report: blocks.join(''),
    done: !checkLater.length,
    how: 'sent clean',
  });
  updateReportsBadge();
  await saveScoreDataToFile();
  keepScoreInView(renderScore);

  showComposeReport('Alignment sent', blocks, 'alignment');
}

function countAlignedTokens(chapter) {
  let n = 0;
  for (const L of (chapter.lines || [])) {
    for (const v of L.variants) for (const m of v.manuscripts) {
      for (const t of (m.atfTokens || [])) if (t.alignment != null) n++;
    }
  }
  return n;
}

// ---- Compose a reading from its witnesses --------------------------------
//
// Never automatic. Composing replaces text an editor may have weighed for a
// long time, so it runs only when asked — from the "+" menu on one reading, or
// from "Compose all" for the project — and both ask first.
//
// What it writes: the reading itself, and the alignment behind it, so Positions
// mode opens already filled in rather than blank.

async function composeReading(lineNum, vi, scope) {
  if (!window.Compositor) return { error: 'compositor.js did not load' };
  let convert;
  try {
    const conv = await ensureAtfConverter();
    convert = (t) => conv.convertLine(t).codes;
  } catch (err) {
    return { error: 'the sign table could not be loaded: ' + (err.message || err) };
  }

  const { scoreLines } = buildScore();
  const rows = (scoreLines[lineNum] || []).filter((w) => w.type === 'line');
  const asW = (w) => ({ key: w.siglum + '|' + w.sourceLine, atf: w.content });
  const group = rows.filter((w) => (w.variant || 0) === vi).map(asW);

  // A witness that needs two lines for one omen is still one witness.
  //
  // Voting per line made AO.6450's o 31 and o 32 two manuscripts that happen
  // to agree about nothing, and the compositor duly wove the second halves
  // into the middle of the first: §35 came out with BURU₁₄ um-šum dan-nu
  // sitting where BAD₄ ends, because a majority of "witnesses" had a word
  // there. Long omens are exactly the ones this ruins.
  //
  // So the vote is per manuscript, its lines joined in the order the tablet
  // has them. The alignment stays per line — each line still answers for its
  // own words — which is why the two are worked out separately below.
  const lineOrder = (a, b) => {
    const n = (x) => parseInt(String(x).replace(/[^0-9]/g, ''), 10);
    const na = n(a.sourceLine), nb = n(b.sourceLine);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a.sourceLine).localeCompare(String(b.sourceLine), undefined, { numeric: true });
  };
  const asWitness = (list) => {
    const byMs = new Map();
    for (const w of list) {
      if (!byMs.has(w.siglum)) byMs.set(w.siglum, []);
      byMs.get(w.siglum).push(w);
    }
    const out = [];
    for (const [siglum, lines] of byMs) {
      lines.sort(lineOrder);
      out.push({ key: siglum, atf: lines.map((w) => w.content).join(' ') });
    }
    return out;
  };
  if (!group.length) return { skipped: 'no witnesses' };

  // The main reading is the section's text, so EVERY witness of the section
  // attests its shared material — including the ones filed under a variant,
  // which deviate only where they deviate. Counting only the main reading's
  // own witnesses dropped "ina KUR DU₃.A-BI" from §1 the moment K.2246 moved
  // to §1b, though both tablets plainly have it.
  //
  // A variant is composed from its own witnesses alone: it exists precisely
  // to say something else, so the majority must not talk it out of that.
  // Scope narrows who is asked, not who is shown. A Nineveh composition is
  // still measured against every witness afterwards, because the point of
  // making one is to see how the others stand to it.
  const eligible = vi === 0 ? rows : rows.filter((w) => (w.variant || 0) === vi);
  const scoped = eligible.filter((w) => inScope(w, scope));
  // Commentaries do not vote — unless they are what was asked for. Choosing
  // "Commentary" by type, or one commentary by name, is a deliberate request
  // to compose from them, and refusing would be answering a different question.
  const askedForCommentary = !!scope && ((scope.kind === 'type' && scope.value === 'Commentary')
    || (scope.kind === 'witness' && isCommentaryWitness(scope.value)));
  const speaking = askedForCommentary
    ? scoped : scoped.filter((w) => !isCommentaryWitness(w.siglum));
  const setAside = scoped.length - speaking.length;
  const voters = asWitness(speaking);
  const inGroup = new Set(group.map((w) => w.key));
  if (!voters.length) {
    return { skipped: setAside
      ? 'the only witnesses here are commentaries, which do not compose the text'
      : 'no witness matches that selection' };
  }

  // One witness is not a composition. Asked for anyway — "follow K.2246" —
  // its own line becomes the reading, which is a decision the editor has just
  // made rather than a majority anyone counted.
  if (voters.length === 1 && scope && scope.kind !== 'all') {
    const text = readingFromWitness(voters[0].atf);
    if (!text) return { skipped: 'that witness preserves nothing legible here' };
    writeReading(lineNum, vi, text);
    const a = Compositor.alignToReading(text, rows.map(asW), convert);
    if (!lineAlignments[lineNum]) lineAlignments[lineNum] = {};
    for (const key of Object.keys(a.perWitness)) {
      if (inGroup.has(key)) lineAlignments[lineNum][key] = a.perWitness[key].alignment;
    }
    return {
      text, followed: voters[0].key.split('|')[0],
      perWitness: markCommentaries(a.perWitness),
      mine: Object.keys(a.perWitness).filter((k) => inGroup.has(k)),
      voters: 1, scope,
    };
  }

  // One voter is a transcription, not a composition: there is nothing to
  // weigh. But a lone witness can still be aligned to a reading someone
  // already wrote, which is the ordinary case for a variant.
  const existing = (readReading(lineNum, vi) || '').trim();
  if (voters.length < 2) {
    if (!existing) return { skipped: 'one witness and no reading to align it to' };
    const a = Compositor.alignToReading(existing, group, convert);
    if (!lineAlignments[lineNum]) lineAlignments[lineNum] = {};
    for (const key of Object.keys(a.perWitness)) {
      lineAlignments[lineNum][key] = a.perWitness[key].alignment;
    }
    return { alignedOnly: true, text: existing, perWitness: markCommentaries(a.perWitness) };
  }

  const r = Compositor.composeSection(voters, convert);
  if (!r || !r.text.trim()) return { skipped: 'nothing legible' };

  writeReading(lineNum, vi, r.text);
  // Measured line by line, always. The vote was taken per manuscript, so what
  // comes back from composeSection is keyed by siglum and cannot say which of
  // a tablet's two lines a word sits on. The alignment has to.
  const measured = Compositor.alignToReading(r.text, rows.map(asW), convert).perWitness;
  if (!lineAlignments[lineNum]) lineAlignments[lineNum] = {};
  // Only this reading's own witnesses get an alignment against it. A
  // variant's witness voted here but answers to its own reading.
  for (const key of Object.keys(measured)) {
    if (inGroup.has(key)) lineAlignments[lineNum][key] = measured[key].alignment;
  }
  // Every witness comes back, not only this reading's own: the others voted
  // on its shared material, and their agreement is the evidence for it.
  return {
    text: r.text,
    perWitness: markCommentaries(measured),
    mine: Object.keys(measured).filter((k) => inGroup.has(k)),
    voters: voters.length,
    setAside,
    scope,
  };
}

// Report on a reading without touching it.
//
// The case this exists for: an editor has chosen a reading the witnesses do not
// most attest — a lectio difficilior, a form the majority corrupted, a spelling
// the house style prefers. That is a decision, not a mistake, and it should be
// possible to see exactly what it costs in attestation without the app
// offering to overwrite it.
//
// Nothing here writes. Not the reading, not the alignments.
async function analyseReading(lineNum, vi) {
  const label = '§' + lineNum + variantLetterOf(vi);
  if (!window.Compositor) {
    showComposeReport(label, [noteBlock('compositor.js did not load.', 'bad')]);
    return;
  }
  const current = (readReading(lineNum, vi) || '').trim();
  if (!current) {
    showComposeReport(label, [noteBlock('There is no reading here yet to report on.', 'warn')]);
    return;
  }

  let convert;
  setStatus('connected', label + ' — measuring…');
  try {
    const conv = await ensureAtfConverter();
    convert = (t) => conv.convertLine(t).codes;
  } catch (err) {
    setStatus('connected', 'Ready');
    showComposeReport(label, [noteBlock('The sign table could not be loaded: ' + (err.message || err), 'bad')]);
    return;
  }

  const { scoreLines } = buildScore();
  const rows = (scoreLines[lineNum] || []).filter((w) => w.type === 'line');
  const asW = (w) => ({ key: w.siglum + '|' + w.sourceLine, atf: w.content });
  const all = rows.map(asW);
  const mine = rows.filter((w) => (w.variant || 0) === vi).map((w) => w.siglum + '|' + w.sourceLine);
  setStatus('connected', 'Ready');

  if (!all.length) {
    showComposeReport(label, [noteBlock('This section has no witnesses.', 'warn')]);
    return;
  }

  // How every witness of the section stands against the reading as written.
  const measured = Compositor.alignToReading(current, all, convert);
  markCommentaries(measured.perWitness);
  // And what the witnesses on their own would have produced, for the comparison.
  const majority = all.length >= 2 ? Compositor.composeSection(all, convert) : null;

  const blocks = [
    readingBlock(label, current, null),
    positionStrip(current),
    noteBlock('Measured against ' + all.length + ' witness'
      + (all.length === 1 ? '' : 'es') + ' of the section. Nothing was changed.'),
  ];
  if (majority && majority.text.trim()) {
    blocks.push(divergenceBlock(current, majority.text));
  } else {
    blocks.push(noteBlock('Too little evidence to say what the best-attested form would be.', 'warn'));
  }
  blocks.push('<h4 class="report-heading">Every witness against this reading</h4>');
  blocks.push(witnessRows(measured.perWitness, mine));
  const ownSet = new Set(mine);
  const flagged = Object.keys(measured.perWitness).filter((k) =>
    ownSet.has(k) && measured.perWitness[k].differing.length
    && !measured.perWitness[k].thinEvidence && !measured.perWitness[k].commentary);
  if (flagged.length) {
    blocks.push(await splitBlock(lineNum, vi, flagged, r.perWitness, r.text));
  }

  showComposeReport(label + ' — report', blocks, 'report-' + lineNum + variantLetterOf(vi));
  wireSplitOffer();
}

// A reading made out of one witness's line: its own text, with the marks that
// record how much is known stripped off, and its commentary left behind.
function readingFromWitness(atf) {
  const convert = positionConverter();
  const C = window.Compositor;
  let parts = C ? C.classify(atf).filter((t) => t.role === 'text').map((t) => t.text)
               : String(atf || '').trim().split(/\s+/);
  // A break is a statement that something is lost. It belongs on the tablet,
  // never in a reading: carried across it becomes a word of the reading, takes
  // a position, and shifts every witness numbered against it.
  if (convert && C) parts = parts.filter((t) => C.isLegible(t, convert) || C.isDivider(t));
  return parts.join(' ').replace(/[#?!*\[\]⸢⸣]/g, '').replace(/\s+/g, ' ').trim();
}

// Split the witnesses that went their own way into variants of their own.
//
// The compositor can say a witness disagrees with the reading too often to be a
// copy of it; only an editor can say that makes it a separate reading. So this
// is offered by the report and never taken automatically — and once taken, the
// main reading is composed again without them, because their votes were part of
// what produced it.
async function splitVariants(lineNum, vi, keys) {
  // The same plan the offer showed, not a second grouping that might disagree
  // with it. What was previewed is what gets written.
  const reading = variantsFor(lineNum)[vi];
  const plan = await planSplit(lineNum, vi, keys, reading ? reading.text : '');
  if (!plan.length) return { made: [] };

  const { scoreLines } = buildScore();
  const byKey = new Map();
  for (const w of (scoreLines[lineNum] || [])) {
    if (w.type === 'line' && (w.variant || 0) === vi) byKey.set(w.siglum + '|' + w.sourceLine, w);
  }

  const made = [];
  for (const group of plan) {
    const rows = group.keys.map((k) => byKey.get(k)).filter(Boolean);
    if (!group.text || !rows.length) continue;
    await createVariant(lineNum, group.text, rows);
    made.push({ text: group.text, witnesses: group.witnesses.slice() });
  }
  return { made };
}

// Split, then compose the main reading again from what is left, and report both.
async function splitAndRecompose(lineNum, vi, keys) {
  hideComposeReport();
  setStatus('connected', '§' + lineNum + ' — splitting…');
  const { made } = await splitVariants(lineNum, vi, keys);
  if (!made.length) {
    setStatus('connected', 'Ready');
    showComposeReport('§' + lineNum + ' — nothing split',
      [noteBlock('Those witnesses could not be moved. They may already sit under another reading.', 'warn')]);
    return;
  }
  // Their votes helped make the reading that flagged them, so it has to be
  // weighed again without them.
  const r = await composeReading(lineNum, vi);
  await saveScoreDataToFile();
  markUnsaved();
  renderScore();
  setStatus('connected', made.length + ' variant' + (made.length === 1 ? '' : 's') + ' created');
  setTimeout(() => setStatus('connected', 'Ready'), 4000);

  const label = '§' + lineNum + variantLetterOf(vi);
  const blocks = [];
  if (r && r.text) {
    blocks.push(noteBlock('Recomposed without them:'));
    blocks.push(readingBlock(label, r.text, null));
    blocks.push(positionStrip(r.text));
  }
  blocks.push('<h4 class="report-heading">' + made.length + ' new variant'
    + (made.length === 1 ? '' : 's') + '</h4>');
  for (let i = 0; i < made.length; i++) {
    blocks.push(readingBlock('§' + lineNum + variantLetterOf(vi + 1 + i), made[i].text, null));
    blocks.push(noteBlock('from ' + made[i].witnesses.join(', ')));
  }
  if (r && r.perWitness) blocks.push(witnessRows(r.perWitness, r.mine));
  showComposeReport(label + ' — split', blocks, 'split-' + lineNum + variantLetterOf(vi));
}

// What the offer in the current report would split, held here rather than
// serialised into an attribute. Nothing to escape, nothing to parse back.
let pendingSplit = null;

// What a split would produce, without producing it.
//
// The same grouping splitVariants uses — witnesses saying the same thing land
// in one variant, not one each — so the offer shows the lines that would be
// written rather than describing them. An editor deciding whether these are
// separate readings needs to see the readings.
async function planSplit(lineNum, vi, keys, readingText) {
  const { scoreLines } = buildScore();
  const byKey = new Map();
  for (const w of (scoreLines[lineNum] || [])) {
    if (w.type === 'line' && (w.variant || 0) === vi) byKey.set(w.siglum + '|' + w.sourceLine, w);
  }
  const chosen = keys.map((k) => byKey.get(k)).filter(Boolean);
  if (!chosen.length) return [];

  let signsOf = (t) => t;
  try {
    const conv = await ensureAtfConverter();
    signsOf = (t) => { try { return conv.convertLine(t).codes.join(' '); } catch (_) { return t; } };
  } catch (_) { /* group by text instead */ }

  const groups = new Map();
  for (const w of chosen) {
    const text = readingFromWitness(w.content);
    if (!text) continue;
    const k = signsOf(text);
    if (!groups.has(k)) groups.set(k, { text, witnesses: [], keys: [], signs: k });
    groups.get(k).witnesses.push(w.siglum + ' ' + w.sourceLine);
    groups.get(k).keys.push(w.siglum + '|' + w.sourceLine);
  }

  // A broken witness is not a reading of its own.
  //
  // Grouping by the whole line means a tablet that preserves half of it can
  // never join one that preserves all of it, however completely the halves
  // agree — so Rm-II.116, broken at the start, was being offered as a variant
  // whose text began in the middle of the omen. A reconstruction that starts
  // mid-sentence is not something to write.
  //
  // So a group whose signs run inside another's is folded into it, and one that
  // runs inside the reading itself is dropped: it contradicts nothing, and
  // belongs where it already is.
  const within = (small, big) => small.length > 0 && big.indexOf(small) >= 0
    && small.length < big.length;
  const all = [...groups.values()];
  const readingSigns = signsOf(readingText || '');

  const kept = [];
  for (const g of all) {
    if (readingSigns && within(g.signs, readingSigns)) continue;   // agrees with the reading
    const host = all.find((o) => o !== g && within(g.signs, o.signs));
    if (host) {
      host.witnesses.push(...g.witnesses);
      host.keys.push(...g.keys);
      continue;
    }
    kept.push(g);
  }
  return kept;
}

// Why each of these witnesses is being offered: the word it reads, against the
// word this reading has there. A bare list of position numbers says a witness
// differs; it does not say what about, which is the thing being decided.
function splitReasons(lineNum, vi, perWitness, readingText, keys) {
  const words = positionWords(readingText || '');
  const at = {};
  for (const t of words) if (t.pos != null) at[t.pos] = t.text;

  const { scoreLines } = buildScore();
  const byKey = new Map();
  for (const w of (scoreLines[lineNum] || [])) {
    if (w.type === 'line' && (w.variant || 0) === vi) byKey.set(w.siglum + '|' + w.sourceLine, w);
  }

  const out = [];
  for (const k of keys) {
    const v = perWitness[k];
    if (!v || !v.differing || !v.differing.length) continue;
    // alignment maps the witness's own word index to a position; turn it round.
    const theirs = {};
    const row = byKey.get(k);
    if (row) {
      const toks = witnessWords(row.content).filter((t) => t.index != null);
      for (const [idx, pos] of Object.entries(v.alignment || {})) {
        const t = toks[Number(idx)];
        if (t) theirs[pos] = t.text;
      }
    }
    const bits = v.differing.slice(0, 4).map((p) => (theirs[p]
      ? theirs[p] + ' where the reading has ' + (at[p] == null ? '?' : at[p])
      : 'differs at ' + p));
    out.push(k.replace('|', ' ') + ' — ' + bits.join(';  ')
      + (v.differing.length > 4 ? ';  and ' + (v.differing.length - 4) + ' more' : ''));
  }
  return out;
}

// The offer, as a block in the report.
//
// Each proposed reading is its own choice. Three witnesses reading three
// different things produce three variants, and wanting only one of them is the
// ordinary case — the other two may be damage, or the same reading spelled
// differently, or simply not worth a line of their own yet.
async function splitBlock(lineNum, vi, flagged, perWitness, readingText) {
  const plan = await planSplit(lineNum, vi, flagged, readingText);
  pendingSplit = { lineNum, vi, keys: flagged.slice(), plan };
  const reasons = splitReasons(lineNum, vi, perWitness || {}, readingText, flagged);

  let html = '<div class="report-offer">'
    + `<p>${flagged.length} witness${flagged.length === 1 ? '' : 'es'} `
    + `read${flagged.length === 1 ? 's' : ''} differently from this reading somewhere.</p>`
    + '<p>A word that differs has nowhere to go in eBL except a variant of its'
    + ' own — omittedWords can only say a word is absent, never that it is'
    + ' another word. Whether these are separate readings is yours to say.</p>';

  if (reasons.length) {
    html += '<h4 class="report-heading">Why</h4>'
      + '<pre class="report-raw">' + escapeHtml(reasons.join(String.fromCharCode(10))) + '</pre>';
  }

  if (plan.length) {
    html += '<h4 class="report-heading">' + (plan.length === 1
      ? 'What would be written' : 'Which of these to write') + '</h4>';
    for (let i = 0; i < plan.length; i++) {
      html += '<label class="split-preview">'
        + '<input type="checkbox" class="split-pick" data-group="' + i + '" checked>'
        + '<span class="split-preview-label">§' + lineNum + variantLetterOf(vi + 1 + i) + '</span>'
        + '<span class="split-preview-body">'
        + '<span class="split-preview-text">' + renderAtf(plan[i].text) + '</span>'
        + '<span class="split-preview-from">from '
        + escapeHtml(plan[i].witnesses.join(', ')) + '</span>'
        + '</span></label>';
    }
    html += '<p class="report-note">The letters are given in order to whatever is'
      + ' written, so leaving one out closes the gap rather than skipping a letter.'
      + ' The reading above is composed again from whatever is left.</p>';
  }

  html += '<button type="button" id="split-variants"></button></div>';
  return html;
}

// Wired after the report is painted, since the buttons are built with it.
function wireSplitOffer() {
  const btn = document.getElementById('split-variants');
  if (!btn || !pendingSplit) return;
  const job = pendingSplit;
  const boxes = [...document.querySelectorAll('.split-pick')];

  // Which witnesses the ticked readings account for. A group carries its own
  // witnesses, so unticking one leaves them with the main reading rather than
  // stranding them in a variant nobody asked for.
  const chosenKeys = () => {
    if (!boxes.length) return job.keys;
    const keys = [];
    for (const box of boxes) {
      if (!box.checked) continue;
      const g = job.plan[Number(box.dataset.group)];
      if (g) keys.push(...g.keys);
    }
    return keys;
  };

  const label = () => {
    const n = boxes.length ? boxes.filter((b) => b.checked).length : job.plan.length;
    btn.disabled = n === 0;
    btn.textContent = n === 0 ? 'Nothing selected'
      : n === 1 ? 'Split into its own variant'
      : 'Split into ' + n + ' variants';
  };

  for (const box of boxes) box.addEventListener('change', label);
  label();

  btn.addEventListener('click', () => {
    const keys = chosenKeys();
    if (!keys.length) return;
    splitAndRecompose(job.lineNum, job.vi, keys);
  });
}


// The report describes a change to the score. This checks the score actually
// shows it, because a report that disagrees with the page is worse than no
// report: it tells you the work was done when it was not. Returns null when
// all is well, or what the score shows instead.
// A reading can be written correctly and then undone a moment later, by a
// stray event, a file reload, or another window holding the same project. The
// synchronous check below cannot see that — it runs before the revert. So the
// reading is watched for a second afterwards, and if it changes underneath us
// the report says what it became and what put it there.
function watchReadingSettles(lineNum, vi, text, label) {
  const want = String(text || '').trim();
  let checks = 0;
  const timer = setInterval(() => {
    checks++;
    const now = String(readReading(lineNum, vi) || '').trim();
    if (now !== want) {
      clearInterval(timer);
      console.error('[compose] ' + label + ' was reverted after being written.',
        { wrote: want, became: now });
      const body = document.getElementById('compose-report-body');
      if (body) {
        body.innerHTML = noteBlock(label + ' was composed and written, but something'
          + ' changed it back ' + (checks * 200) + 'ms later. That is a bug outside the'
          + ' compositor — most often a second window holding the same project, or the'
          + ' file being reloaded from disk over the top.', 'bad')
          + readingBlock('composed', want, null)
          + readingBlock('became', now || '(empty)', null)
          + body.innerHTML;
      }
      return;
    }
    if (checks >= 5) clearInterval(timer);
  }, 200);
}

function readingShownMismatch(lineNum, vi, text) {
  if (positionsOn(lineNum) || lemmasOn(lineNum)) return null;   // chips, not one string
  const el = scorePanel.querySelector(
    `.reconstructed-text[data-line="${lineNum}"][data-variant="${vi}"]`);
  if (!el) return 'the score has no §' + lineNum + variantLetterOf(vi) + ' to show it in';
  const shown = String(el.textContent || '').replace(/\s+/g, ' ').trim();
  const want = String(text || '').replace(/\s+/g, ' ').trim();
  return shown === want ? null : (shown ? 'the score still shows: ' + shown : 'the score shows nothing there');
}

// One reading, with its report. The caller has already agreed to overwrite.
async function composeOmen(lineNum, vi, scope) {
  const label = '§' + lineNum + variantLetterOf(vi);
  const before = readReading(lineNum, vi);
  setStatus('connected', label + ' — composing…');
  const r = await composeReading(lineNum, vi, scope);

  if (r.error) {
    setStatus('connected', 'Ready');
    showComposeReport(label + ' — not composed', [
      outcomeBanner('none', label, r.error),
    ]);
    return;
  }
  if (r.skipped) {
    setStatus('connected', 'Ready');
    showComposeReport(label + ' — not composed', [
      outcomeBanner('none', label, r.skipped + '.'),
      noteBlock('The score is exactly as it was.'), 
    ]);
    return;
  }
  if (r.alignedOnly) {
    await saveScoreDataToFile();
    markUnsaved();
    renderScore();
    setStatus('connected', label + ' aligned');
    setTimeout(() => setStatus('connected', 'Ready'), 4000);
    showComposeReport(label + ' — aligned', [
      outcomeBanner('kept', label, 'It has one witness, so only its alignment was filled in.'),
      noteBlock('One witness, so the reading was left exactly as you wrote it and only the alignment was filled in.'),
      readingBlock(label, r.text, null),
      positionStrip(r.text),
      witnessRows(r.perWitness),
    ], 'aligned-' + lineNum + variantLetterOf(vi));
    return;
  }

  await saveScoreDataToFile();
  markUnsaved();
  renderScore();

  setStatus('connected', label + ' composed');
  setTimeout(() => setStatus('connected', 'Ready'), 4000);
  const mismatch = readingShownMismatch(lineNum, vi, r.text);
  const changed = String(before || '').trim() !== String(r.text || '').trim();
  const blocks = [
    outcomeBanner(String(before || '').trim() ? (changed ? 'changed' : 'kept') : 'added', label,
      changed ? '' : 'The composed reading is word for word what was already there.'),
    readingBlock(label, r.text, before),
    positionStrip(r.text),
  ];
  if (mismatch) {
    blocks.unshift(noteBlock('The reading was composed and written, but ' + mismatch
      + '. Something is reverting it — please report this.', 'bad'));
  }
  if (r.followed) {
    blocks.push(noteBlock('Follows ' + r.followed + '. Its own line is the reading — nothing'
      + ' was weighed, so the table below says how the rest stand to that choice.', 'warn'));
  } else if (r.setAside) {
    blocks.push(noteBlock(r.setAside + ' commentar' + (r.setAside === 1 ? 'y was' : 'ies were')
      + ' set aside: a commentary quotes the text to discuss it, so its wording'
      + ' answers to the discussion. They are measured against the result below'
      + ' but had no vote in it.'));
  }
  if (r.scope && r.scope.kind !== 'all') {
    blocks.push(noteBlock('Composed from ' + scopeLabel(r.scope) + ' alone — ' + r.voters
      + ' witness' + (r.voters === 1 ? '' : 'es') + ' weighed. Everyone else is measured'
      + ' against the result but had no vote in it.', 'warn'));
  }
  const owned = (r.mine || Object.keys(r.perWitness)).length;
  if (r.voters && r.voters > owned) {
    blocks.push(noteBlock('Weighed ' + r.voters + ' witnesses of the section; ' + owned
      + ' of them belong to this reading. The rest are shown too — they voted on'
      + ' the material this reading shares with them.'));
  }
  blocks.push(witnessRows(r.perWitness, r.mine));
  // Only this reading's own witnesses can be split off it; one already filed
  // under another variant is somebody else's problem.
  // A witness needs its own variant when it READS something else, not when
  // it disagrees often enough. K.2246 agrees with 86% of §1 and still has
  // GANBA GAL₂-ši where the reading has KIMIN ina-pu-uš — two words out of
  // fourteen, and exactly why eBL files it as a variant of its own. Since a
  // differing word has no home but a variant, any difference is grounds to
  // offer one; the agreement figure stays in the table as the measure of how
  // far apart they are.
  const own = new Set(r.mine || Object.keys(r.perWitness));
  const flagged = Object.keys(r.perWitness).filter((k) =>
    own.has(k) && r.perWitness[k].differing.length && !r.perWitness[k].thinEvidence
    && !r.perWitness[k].commentary);   // a commentary is not a reading of the text
  if (flagged.length) {
    blocks.push(await splitBlock(lineNum, vi, flagged, r.perWitness, r.text));
  }
  showComposeReport(label + ' — composed', blocks, 'compose-' + lineNum + variantLetterOf(vi));
  watchReadingSettles(lineNum, vi, r.text, label);
  wireSplitOffer();
}

// Every reading in the project. Counts what it would overwrite before asking,
// because "regenerate" over a hand-made edition is not a small thing.
async function composeAll() {
  const { scoreLines } = buildScore();
  const lineNums = Object.keys(scoreLines).map(Number).sort((a, b) => a - b);

  const jobs = [];
  for (const n of lineNums) {
    const readings = variantsFor(n);
    for (let vi = 0; vi < readings.length; vi++) {
      const rows = (scoreLines[n] || []).filter((w) => w.type === 'line');
      const group = rows.filter((w) => (w.variant || 0) === vi);
      if (!group.length) continue;
      const voters = vi === 0 ? rows.length : group.length;
      const hadText = !!(readings[vi].text || '').trim();
      // Too few to compose is still enough to align, as long as there is a
      // reading to align against — which is how variants get their positions.
      if (voters < 2 && !hadText) continue;
      jobs.push({ n, vi, hadText, alignOnly: voters < 2 });
    }
  }
  if (!jobs.length) {
    showComposeReport('Nothing to compose', [
      outcomeBanner('none', 'The project', 'No reading here has two or more witnesses.'),
    ]);
    return;
  }

  const alignOnly = jobs.filter((j) => j.alignOnly).length;
  const composable = jobs.length - alignOnly;
  const written = jobs.filter((j) => j.hadText && !j.alignOnly).length;
  const ok = await askOverlay('Compose the whole project?', [
    '<div class="report-counts">'
      + '<span class="report-count is-done"><b>' + composable + '</b> to compose</span>'
      + (written ? '<span class="report-count is-bad"><b>' + written + '</b> will be replaced</span>' : '')
      + ((composable - written) ? '<span class="report-count"><b>' + (composable - written) + '</b> empty</span>' : '')
      + (alignOnly ? '<span class="report-count"><b>' + alignOnly + '</b> aligned only</span>' : '')
      + '</div>',
    noteBlock(written
      ? written + ' reading(s) already have text. Composing replaces it — there is no undo,'
        + ' though the report can be saved before you decide.'
      : 'No existing reading will be lost: every one of these is empty.',
      written ? 'warn' : 'good'),
    alignOnly ? noteBlock(alignOnly + ' reading(s) have a single witness. Those keep their text'
      + ' and only get their alignment.') : '',
    noteBlock('Alignments are written too, so Positions mode opens filled in.'),
  ], 'Compose ' + composable, !!written);
  if (!ok) return;

  const btn = document.getElementById('compose-all-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Composing…'; }

  let done = 0, aligned = 0, skipped = 0, failed = 0;
  const flagged = [];
  try {
    for (const job of jobs) {
      setStatus('connected', 'Composing §' + job.n + variantLetterOf(job.vi)
        + ' (' + (done + skipped + failed + 1) + ' of ' + jobs.length + ')…');
      const r = await composeReading(job.n, job.vi);
      if (r.error) { failed++; continue; }
      if (r.skipped) { skipped++; continue; }
      if (r.alignedOnly) { aligned++; continue; }
      done++;
      for (const k of Object.keys(r.perWitness)) {
        if (r.perWitness[k].wantsVariant) {
          flagged.push('§' + job.n + variantLetterOf(job.vi) + '  ' + k.replace('|', ' ')
            + '  ' + Math.round(r.perWitness[k].agreement * 100) + '%');
        }
      }
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Compose all'; }
  }

  await saveScoreDataToFile();
  markUnsaved();
  renderScore();
  setStatus('connected', done + ' reading' + (done === 1 ? '' : 's') + ' composed');
  setTimeout(() => setStatus('connected', 'Ready'), 5000);

  const blocks = ['<div class="report-counts">'
    + '<span class="report-count is-done"><b>' + done + '</b> composed</span>'
    + (aligned ? '<span class="report-count"><b>' + aligned + '</b> aligned only</span>' : '')
    + (skipped ? '<span class="report-count"><b>' + skipped + '</b> nothing legible</span>' : '')
    + (failed ? '<span class="report-count is-bad"><b>' + failed + '</b> failed</span>' : '')
    + '</div>'];
  if (aligned) {
    blocks.push(noteBlock('Readings with a single witness keep the text you wrote; only their'
      + ' alignment was filled in.'));
  }
  if (flagged.length) {
    blocks.push('<h4 class="report-heading">' + flagged.length
      + ' witness' + (flagged.length === 1 ? '' : 'es')
      + ' diverge enough to want their own variant</h4>');
    blocks.push('<ul class="report-flagged">'
      + flagged.map((f) => '<li>' + escapeHtml(f) + '</li>').join('')
      + '</ul>');
  } else {
    blocks.push(noteBlock('No witness diverged far enough to want a variant of its own.'));
  }
  showComposeReport('Composed the project', blocks);
}

const composeAllBtn = document.getElementById('compose-all-btn');
if (composeAllBtn) composeAllBtn.addEventListener('click', composeAll);

// ---- Send one omen, from the score --------------------------------------
//
// The icon on a § header. Validates that section on its own against the eBL
// grammar, then posts it — replacing the line if eBL already has it, adding it
// if not. Nothing else in the chapter is touched either way.
//
// A rejected POST changes nothing on eBL, so the only irreversible step is a
// successful one, which is why the confirm names what it is about to do.
async function exportOmen(lineNum) {
  if (!Number.isFinite(lineNum)) return;
  const label = '§' + lineNum;
  const target = (projectConfig && projectConfig.ebl && projectConfig.ebl.target) || null;
  if (!target) {
    showComposeReport(label + ' — not sent', [
      outcomeBanner('notsent', label, 'No eBL chapter is configured for this project.'),
      noteBlock('Set one in Settings, under eBL.'),
    ]);
    return;
  }
  const ts = EblClient.tokenStatus();
  if (!ts.hasToken || ts.invalid || ts.expired || !ts.hasWriteTexts) {
    showComposeReport(label + ' — not sent', [
      outcomeBanner('notsent', label, 'This needs an eBL token with write:texts.'),
      noteBlock('Token: ' + (!ts.hasToken ? 'none stored'
        : ts.invalid ? 'not a readable JWT'
        : ts.expired ? 'expired'
        : 'valid, but without write:texts') + '. Paste a current one in Settings.', 'bad'),
    ]);
    return;
  }

  try {
    setStatus('connected', label + ' — validating…');
    const atf = await buildExportArtifact(lineNum);
    if (!atf.trim()) {
      setStatus('connected', 'Ready');
      showComposeReport(label + ' — not sent', [
        outcomeBanner('notsent', label, 'There is nothing here to send yet.'),
      ]);
      return;
    }

    // Named here rather than by a server. A stray non-breaking space is
    // invisible on screen and eBL reports it as "No terminal matches ' '" at a
    // column that looks like an ordinary space — which is nearly impossible to
    // read. This runs whether or not a local validator is available.
    const odd = EblAtf.oddCharacters(atf);
    if (odd.length) {
      setStatus('connected', 'Ready');
      const where = odd.slice(0, 8).map((o) => {
        const before = atf.slice(0, o.at);
        const row = before.split(String.fromCharCode(10)).length;
        const col = o.at - (before.lastIndexOf(String.fromCharCode(10)) + 1) + 1;
        return 'Line ' + row + ', col ' + col + ': ' + o.code
          + String.fromCharCode(10) + String.fromCharCode(10) + pointAt(atf, row, col);
      }).join(String.fromCharCode(10) + String.fromCharCode(10));
      showComposeReport(label + ' — not sent', [
        outcomeBanner('notsent', label, odd.length + ' character(s) an ATF parser'
          + ' cannot accept. Nothing was sent.'),
        noteBlock('These look like ordinary spaces on screen. A contenteditable puts a'
          + ' non-breaking space in where you typed a plain one. Retype the marked'
          + ' position, or compose the reading again, and it will be cleaned.', 'bad'),
        rawBlock(where),
      ], 'export-' + lineNum);
      return;
    }

    // Asked in full, so a check that could not run is not mistaken for a clean
    // one. A validator that is present but fails on the day — killed mid-parse,
    // answering an error — used to come back as an empty problem list, and the
    // section went to eBL as though it had passed.
    const check = await validateAtfDetailed(atf);
    const problems = check.problems;
    if (problems.length) {
      setStatus('connected', 'Ready');
      showComposeReport(label + ' — not sent', [
        outcomeBanner('notsent', label, problems.length + ' ATF error'
          + (problems.length === 1 ? '' : 's') + ' — nothing was sent.'),
        rawBlock(problems.map((e) => {
          const where = 'Line ' + (e.line == null ? '?' : e.line)
            + (e.column == null ? '' : ', col ' + e.column) + ': '
            + describeProblem(atf, e);
          const at = e.line == null ? '' : pointAt(atf, e.line, e.column);
          return at ? where + String.fromCharCode(10) + String.fromCharCode(10) + at : where;
        }).join(String.fromCharCode(10) + String.fromCharCode(10))),
      ], 'export-' + lineNum);
      return;
    }
    setStatus('connected', 'Ready');

    const align = await alignmentPreview(lineNum);
    // Asked before the send is described, because taking the suggestions
    // changes what the description would say.
    if (!await askAboutUncurated(null, 'lemmas')) return;
    const lemmas = await lemmaPreview(lineNum);
    const heldLemmas = lemmas.held;
    const ok = await askOverlay('Send ' + label + ' to eBL?', [
      noteBlock(target.genre + '/' + target.category + '/' + target.index + '/'
        + target.stage + '/' + target.name),
      '<details class="export-preview-wrap" open><summary>What will be sent</summary>'
        + '<pre class="export-preview">' + escapeHtml(atf) + '</pre></details>',
      noteBlock('Sent one after the other: the line, then its alignment, then its'
        + ' lemmas — eBL takes each as its own request. The line is replaced if eBL'
        + ' has it, added if not; no other line is touched.'),
      ...align.blocks,
      ...lemmas.blocks,
      // Three requests, and each one is a decision. A reading may be worth
      // sending while its alignment is still half done, or its lemmas still
      // only the dictionary's guesses.
      '<fieldset class="send-parts"><legend>What to send</legend>'
        + '<label><input type="checkbox" checked disabled> The line</label>'
        + '<label><input type="checkbox" id="send-alignment"'
          + (align.placed ? ' checked' : ' disabled') + '> Its alignment'
          + (align.placed ? ' (' + align.placed + ' words placed)' : ' — nothing to send')
          + '</label>'
        + '<label><input type="checkbox" id="send-lemmas"'
          + (heldLemmas ? ' checked' : ' disabled') + '> Its lemmas'
          + (heldLemmas ? ' (' + heldLemmas + ' words)' : ' — nothing to send')
          + '</label>'
        + '<label class="send-sub"><input type="checkbox" id="send-suggested">'
          + ' … including the ones the dictionary suggested and nobody confirmed'
          + '</label>'
        + '</fieldset>',
      heldLemmas
        ? noteBlock('The lemmas go last, after the alignment — a witness word takes the'
            + ' lemma of whatever it is aligned to.')
        : noteBlock('No word of this section carries a lemma yet. Turn on Lemmas to'
            + ' fill them in.'),
      check.checked ? '' : noteBlock('The ATF was not checked here — '
        + (check.why || 'the validator did not answer')
        + '. eBL will be the first to read it, and refuses the whole line if it'
        + ' disagrees.', 'warn'),
    ], 'Send ' + label, true);
    if (!ok) return;

    // Read back before anything is sent: the overlay body stays in the DOM.
    const wantAlignment = !!(document.getElementById('send-alignment') || {}).checked;
    const wantLemmas = !!(document.getElementById('send-lemmas') || {}).checked;
    // Whole-chapter request: this decides for every section, not only this one.
    const withSuggested = !!(document.getElementById('send-suggested') || {}).checked;

    setStatus('connected', label + ' — sending the line…');
    const res = await exportSingleLine(target, lineNum);
    const what = res.inserted ? 'added to' : 'updated on';

    // The line is on eBL now, so that is written down now.
    //
    // The record used to be kept until the alignment and the lemmas had also
    // been tried, which meant a follow-up that hung took the record of a
    // successful line with it: the section stayed unmarked and no report was
    // filed, though the line had landed. What is true is recorded when it
    // becomes true.
    markSent(lineNum, ['line']);
    await saveScoreDataToFile();
    keepScoreInView(renderScore);

    // Step two. The line is already committed, so from here nothing may throw
    // out of the whole export — a failed alignment is reported beside a
    // succeeded line, never as though the line had failed too.
    const realign = !wantAlignment
      ? { skipped: align.placed
          ? 'The alignment was left out of this send.'
          : 'No positions are held for this section, so there was no alignment'
            + ' to follow the line with.' }
      : await sendAlignmentFor(target, label);

    // Step three, after the alignment is on eBL: a witness word takes the
    // lemma of whatever it is aligned to, so the order matters.
    const lemmaWork = !wantLemmas
      ? { skipped: heldLemmas
          ? 'The lemmas were left out of this send.'
          : 'No word of this section carries a lemma yet, so there was nothing'
            + ' to follow the alignment with.' }
      : await sendLemmasFor(target, label, withSuggested);

    // The line is on eBL. What else went with it is recorded too, so the mark
    // can say what was sent, not merely that something was.
    const went = ['line'];
    if (realign && realign.sent) went.push('alignment');
    if (lemmaWork && lemmaWork.sent) went.push('lemmas');
    markSent(lineNum, went);

    const url = 'https://www.ebl.lmu.de/corpus/' + target.genre + '/' + target.category
      + '/' + target.index + '/' + target.stage + '/' + target.name;
    const blocks = [
      outcomeBanner('sent', label,
        res.inserted ? 'Added to the chapter (now ' + (res.chapterLines + 1) + ' lines).'
                     : 'Replaced line ' + (res.index + 1) + ' of ' + res.chapterLines + '.'),
    ];
    if (res.warnings.length) {
      blocks.push('<h4 class="report-heading">' + res.warnings.length + ' warning'
        + (res.warnings.length === 1 ? '' : 's') + '</h4>');
      blocks.push(rawBlock(res.warnings.join(String.fromCharCode(10) + String.fromCharCode(10))));
    }
    blocks.push(...alignmentOutcome(realign));
    blocks.push(...lemmaOutcome(lemmaWork));
    blocks.push(noteBlock('Reload eBL to see it — the chapter page is cached.'));
    blocks.push('<p class="report-note"><a href="' + url + '" target="_blank" rel="noopener noreferrer">'
      + 'View the chapter on eBL →</a></p>');

    // Every send files a report on the reports page, clean ones included —
    // that page is the log. What failed makes it a warning; what went but
    // wants a later look on eBL — a repeated quotation left unaligned, a
    // witness kept under another reading — rides on it as notes.
    const failedParts = [];
    const failDetail = [];
    for (const [part, r2] of [['alignment', realign], ['lemmas', lemmaWork]]) {
      if (!r2 || r2.skipped || r2.sent) continue;
      failedParts.push(part);
      failDetail.push(part + ': ' + (r2.failed ? String(r2.failed)
        : (r2.problems || []).slice(0, 20).join(String.fromCharCode(10))));
    }
    const checkLater = [
      ...((realign && realign.summary && realign.summary.doubled) || []),
      ...((realign && realign.summary && realign.summary.unmatched) || []),
      ...((lemmaWork && lemmaWork.summary && lemmaWork.summary.mismatched) || []),
    ];
    supersedeExportIssues('send', lineNum);
    addExportIssue({
      sec: lineNum, part: 'send',
      kind: failedParts.length ? 'warning' : (checkLater.length ? 'notice' : 'ok'),
      title: failedParts.length
        ? label + ' — the line went, the ' + failedParts.join(' and ') + ' did not'
        : checkLater.length
          ? label + ' sent — ' + checkLater.length + ' thing(s) to check on eBL'
          : label + ' sent (' + went.join(', ') + ')',
      notes: checkLater,
      detail: failDetail.join(String.fromCharCode(10) + String.fromCharCode(10)),
      report: blocks.join(''),
      done: !failedParts.length && !checkLater.length,
      how: 'sent clean',
    });
    updateReportsBadge();
    await saveScoreDataToFile();
    // Repaint, or the mark stays as it was until something else redraws.
    keepScoreInView(renderScore);

    setStatus('connected', label + ' ' + what + ' eBL');
    setTimeout(() => setStatus('connected', 'Ready'), 5000);

    showComposeReport(label + ' — sent', blocks, 'export-' + lineNum);
  } catch (err) {
    setStatus('connected', 'Ready');
    const fail = failureReport(label, err);
    const blocks = fail.blocks.concat([noteBlock('Press Copy below to send this on.')]);
    // Nothing came back: the section wears an error until a later send
    // supersedes it or the editor repairs it on eBL and ticks the report done.
    supersedeExportIssues('send', lineNum);
    addExportIssue({
      sec: lineNum, part: 'send', kind: 'error',
      title: fail.title,
      detail: fail.detail, report: blocks.join(''),
    });
    updateReportsBadge();
    await saveScoreDataToFile();
    keepScoreInView(renderScore);
    showComposeReport(label + (fail.transport ? ' — no answer' : ' — not sent'),
      blocks, 'export-error-' + lineNum);
  }
}

// ---- Replace one chapter line ------------------------------------------
// POST /lines swaps a single line and leaves the rest of the chapter alone,
// so lemmatization and alignment on every other line survive — and because
// `edited` pairs old and new by index, eBL can carry them across on this line
// too. That is the whole reason to prefer this over deleteAllLines + import.
//
// The chapter is read immediately before the write, for two reasons: `index`
// is a position in eBL's line list as it stands right now, and the stored line
// supplies everything this app cannot author — omittedWords above all. A stale
// read would write the line into the wrong slot.
// Everything a line export needs that comes from the chapter rather than from
// here. Read once, because it is the same answer for every section in a range
// and the chapter is several megabytes.
async function lineExportContext(target) {
  const chapter = await EblClient.getChapter(target);
  const lines = chapter.lines || [];

  if (!manuscriptsMeta) {
    manuscriptsMeta = await FileSystem.readManuscriptsMeta(dirHandle) || { version: 1, manuscripts: [] };
  }
  // eBL's numeric manuscript id, matched on museum number — the local id in
  // manuscripts.json is ours and need not agree with the chapter's.
  const idByMuseumNumber = {};
  for (const m of (chapter.manuscripts || [])) idByMuseumNumber[m.museumNumber] = m.id;
  // Keyed both with and without the extension. A score entry's siglum is the
  // file name ("K.2246.txt"), while manuscripts.json is often read stripped —
  // and a lookup that misses drops the witness from the export in silence.
  const manuscriptIdByFile = {};
  for (const m of (manuscriptsMeta.manuscripts || [])) {
    const file = m.file || '';
    const id = idByMuseumNumber[m.museumNumber];
    if (!file || id == null) continue;
    manuscriptIdByFile[file] = id;
    manuscriptIdByFile[file.replace(/\.txt$/, '')] = id;
  }
  return { chapter, lines, manuscriptIdByFile };
}

// One section, built against the chapter as it stands.
function buildLineForExport(lineNum, ctx, scoreLines) {
  const index = ctx.lines.findIndex((l) => String(l.number) === String(lineNum));

  // What this project's own alignment says each witness leaves out. Measured
  // against the reading being sent, so it is the answer eBL should get —
  // whatever eBL happened to hold before.
  const omittedByKey = {};
  const readings = variantsFor(lineNum);
  for (let vi = 0; vi < readings.length; vi++) {
    const words = positionWords(readings[vi].text || '');
    for (const w of (scoreLines[lineNum] || [])) {
      if (w.type !== 'line' || (w.variant || 0) !== vi) continue;
      const key = w.siglum + '|' + w.sourceLine;
      const map = (lineAlignments[lineNum] || {})[key];
      if (!map || !Object.keys(map).length) continue;   // never aligned: say nothing
      omittedByKey[key] = alignmentTally(lineNum, w, words).omitted;
    }
  }

  const built = EblAtf.buildChapterLine({
    lineNum,
    scoreLines,
    reconstructedLines,
    translationLines,
    noteLines,
    parallelLines,
    variantLines,
    manuscriptIdByFile: ctx.manuscriptIdByFile,
    omittedByKey,
    existing: index < 0 ? null : ctx.lines[index],
  });
  return { built, index };
}

// Send a run of sections in one request.
//
// One POST rather than one per line: eBL takes a list of edits, and sending
// them together means the chapter is read once and cannot shift underneath the
// run. Every other line keeps its lemmatization and alignment, exactly as a
// single-line update does.
async function exportLineRange(target, nums) {
  const ctx = await lineExportContext(target);
  const { scoreLines } = buildScore();

  const edited = [];
  const newLines = [];
  const results = [];
  const warnings = [];

  for (const lineNum of nums) {
    const { built, index } = buildLineForExport(lineNum, ctx, scoreLines);
    for (const w of (built.warnings || [])) warnings.push('§' + lineNum + ': ' + w);
    if (index < 0) {
      // Not on eBL yet. eBL appends new lines to the end, so a section that
      // belongs in the middle would sit out of order — say so rather than let
      // it be discovered later.
      const higher = ctx.lines.filter((l) => parseInt(l.number, 10) > lineNum).length;
      if (higher) {
        warnings.push('§' + lineNum + ': eBL appends new lines to the end, so it now sits after '
          + higher + ' higher-numbered line(s). Reorder it in eBL if that matters.');
      }
      newLines.push(built.line);
      results.push({ lineNum, inserted: true, index: null });
    } else {
      edited.push({ index, line: built.line });
      results.push({ lineNum, inserted: false, index });
    }
  }

  if (!edited.length && !newLines.length) {
    return { results: [], warnings, chapterLines: ctx.lines.length };
  }
  const payload = {};
  if (edited.length) payload.edited = edited;
  if (newLines.length) payload.newLines = newLines;
  await EblClient.postLines(target, payload);
  return { results, warnings, chapterLines: ctx.lines.length };
}

// One section. The range is the general case and this is the same path with a
// single number, so the two cannot drift apart.
async function exportSingleLine(target, lineNum) {
  const res = await exportLineRange(target, [lineNum]);
  const one = res.results[0] || { inserted: false, index: -1 };
  return {
    inserted: one.inserted,
    index: one.index,
    warnings: res.warnings,
    chapterLines: res.chapterLines,
  };
}

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
// Validate, and be able to say "I could not check" as distinct from "clean".
//
// Every path out of here used to answer with an empty problem list — no
// validator, a 500, a timeout, a broken pipe — and a caller cannot tell that
// apart from ATF that passed. That is how thirty-four unchecked lines went to
// eBL looking as though they had been checked.
async function validateAtfDetailed(wireAtf) {
  if (!localValidatorAvailable) {
    return { checked: false, problems: [], why: 'there is no local validator here' };
  }
  try {
    const res = await fetch('/api/validate-atf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ atf: wireAtf }),
    });
    if (!res.ok) {
      return { checked: false, problems: [], why: 'the validator answered ' + res.status };
    }
    const result = await res.json();
    if (result.available === false) {
      return { checked: false, problems: [],
        why: result.init_error || 'the validator is not available' };
    }
    return { checked: true, problems: result.valid ? [] : (result.errors || []) };
  } catch (err) {
    return { checked: false, problems: [], why: String(err && err.message || err) };
  }
}

// The older shape, for callers that only want the problems. A failure to check
// still reads as no problems here — those callers say so themselves, from
// localValidatorAvailable — but nothing new should use this.
async function validateAtfForExport(wireAtf) {
  return (await validateAtfDetailed(wireAtf)).problems;
}

async function runExport() {
  const target = projectConfig.ebl.target;
  const atfText = exportArtifactAtf;

  exportGoBtn.disabled = true;
  exportCancelBtn.textContent = 'Close';
  exportProgressEl.classList.remove('hidden');
  exportResultEl.classList.add('hidden');

  // A step that is working says so, and for how long.
  //
  // Some of these are minutes of honest work — validating sixty sections is
  // hundreds of lines through an Earley parser, and the alignment and lemma
  // steps each read the whole chapter and write it back. With only a "…" to go
  // on there is no way to tell a long step from a dead one, which is the
  // question anyone watching actually has.
  const setStep = (step, state, note) => {
    const el = exportProgressEl.querySelector(`.export-step[data-step="${step}"]`);
    if (!el) return;
    // Marking a running step running again only adds to what it says — the
    // clock keeps counting from when the work actually began.
    const wasRunning = el.classList.contains('running');
    el.classList.remove('running', 'done', 'error');
    el.classList.add(state);
    let out = el.querySelector('.step-time');
    if (!out) {
      out = document.createElement('span');
      out.className = 'step-time';
      el.appendChild(out);
    }
    clearInterval(stepTimers[step]);
    if (state !== 'running') {
      // Freeze whatever it took, so a finished run still shows where the time
      // went rather than resetting to nothing.
      const held = stepStarted[step];
      out.textContent = held ? ' ' + elapsedSince(held) : '';
      return;
    }
    el.querySelector('.step-icon').textContent = '…';
    const t0 = (wasRunning && stepStarted[step]) ? stepStarted[step] : Date.now();
    stepStarted[step] = t0;
    const tick = () => {
      out.textContent = ' ' + elapsedSince(t0) + (note ? ' · ' + note : '');
    };
    tick();
    stepTimers[step] = setInterval(tick, 1000);
  };

  const mode = selectedExportMode();
  const lineNum = mode === 'line' ? selectedExportLine() : null;
  const rangeNums = mode === 'range' ? selectedExportRange() : null;
  const wireAtf = EblAtf.stripFormatting(atfText);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // Declared out here so the catch can tell whether the chapter was already
  // emptied when the failure hit, and point at the backup if so.
  let backupName = null;
  let deleted = 0;
  // Set when the ATF could not be checked, and carried into whatever the
  // export reports, so no result ever implies a check that did not happen.
  let uncheckedNote = '';
  // The text the validator was given, so a rejection can point into it.
  let checkedAtf = '';
  // Per step: the interval painting its clock, and when it started.
  const stepTimers = {};
  const stepStarted = {};
  const elapsedSince = (t0) => {
    const sec = Math.round((Date.now() - t0) / 1000);
    return sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's';
  };

  try {
    // Always validate first. On a replace this is the difference between a
    // clean swap and a chapter emptied for an import that then fails.
    // The alignment carries no ATF, so there is nothing here to validate.
    // The alignment carries no ATF and is not built from the artifact, so none
    // of what follows applies to it: it reads the chapter, asks, and reports
    // for itself.
    if (mode === 'alignment') {
      await exportAlignment();
      return;
    }

    // Lemmas carry no ATF either, and answer for the whole chapter.
    if (mode === 'lemmas') {
      await exportLemmatization();
      return;
    }

    // A trim removes lines and writes none, so it validates nothing and asks
    // for itself. Irreversible on eBL, so it says exactly what goes and backs
    // the chapter up first.
    if (mode === 'trim') {
      const plan = trimPlan(selectedTrimFrom());
      if (!plan) {
        throw new ExportAborted('Type a position between 1 and '
          + ((exportPreflight && exportPreflight.lines || []).length || 0) + '.', []);
      }
      const ok = await askOverlay('Remove ' + plan.going.length + ' line'
        + (plan.going.length === 1 ? '' : 's') + ' from eBL?', [
        outcomeBanner('notsent', 'The chapter', 'Nothing is removed until you confirm.'),
        noteBlock('These go, from position ' + plan.from + ' to the end:'),
        rawBlock(plan.going.map((g) => String(g.position).padStart(4) + '  §'
          + g.number + '  ' + String(g.text).slice(0, 60)).join(String.fromCharCode(10))),
        noteBlock(plan.keeping + ' line(s) above are untouched and keep their lemmas'
          + ' and alignment.'),
        noteBlock('The lemmas and alignment eBL holds for the removed lines go with them.'
          + ' This project can send them again, but anything aligned only on eBL is gone.', 'warn'),
        noteBlock('The chapter is backed up to the project folder first.'),
      ], 'Remove ' + plan.going.length + ' line(s)', true);
      // Cancelling is not a failure; nothing was attempted.
      if (!ok) { exportProgressEl.classList.add('hidden'); return; }

      setStep('backup', 'running');
      const chapter = await EblClient.getChapter(target);
      if (dirHandle) {
        backupName = await FileSystem.writeProjectFile(
          dirHandle, `ebl-chapter-backup-${stamp}.json`, JSON.stringify(chapter, null, 2));
      }
      setStep('backup', 'done');

      setStep('delete', 'running');
      await EblClient.postLines(target, { deleted: plan.indices });
      deleted = plan.indices.length;
      setStep('delete', 'done');

      // Read it back rather than assuming: the count is the one fact worth
      // having, and it comes from eBL.
      await loadExportPreflight(target);
      renderExportPreflight();
      renderExportEffect();

      const left = (exportPreflight && !exportPreflight.error) ? exportPreflight.lineCount : null;
      const blocks = [
        outcomeBanner('changed', 'The chapter', deleted + ' line(s) removed; '
          + (left == null ? '?' : left) + ' remain.'),
        rawBlock(plan.going.map((g) => '§' + g.number).join(', ')),
        noteBlock('Send those sections again to put them back — in ascending order, so'
          + ' each is above everything left and lands in place.'),
      ];
      addExportIssue({
        sec: null, part: 'send', kind: 'notice',
        title: deleted + ' line(s) removed from the end of the chapter',
        notes: plan.going.map((g) => '§' + g.number + ' removed — send it again'),
        report: blocks.join(''),
      });
      updateReportsBadge();
      await saveScoreDataToFile();

      exportResultEl.classList.remove('hidden');
      exportResultEl.classList.remove('failure');
      exportResultEl.classList.add('success');
      exportResultEl.innerHTML = `Removed <strong>${deleted}</strong> line(s); `
        + `${left == null ? '?' : left} remain.`
        + (backupName ? ` Backup saved as <code>${escapeHtml(backupName)}</code>.` : '')
        + ' Send those sections again, in ascending order, to put them back in place.'
        + '<div class="export-readback">eBL now holds <strong>' + (left == null ? '?' : left)
        + '</strong> line(s)'
        + (exportPreflight && exportPreflight.first && exportPreflight.last
            ? ` (§${exportPreflight.first}–§${exportPreflight.last})` : '')
        + ' — read back from its API just now. The chapter page on eBL is cached, so'
        + ' reload it there before believing an older number.</div>';
      return;
    }

    // Line mode answers only for the row it sends, so it validates that row
    // alone — an error in §37 is no reason to block a fix to §1. It also
    // flushes in-view edits first, so what the artifact shows is what goes.
    if (mode === 'line') {
      if (lineNum == null) {
        setStep('validate', 'error');
        throw new ExportAborted('Type the section to update.', []);
      }
    }
    if (mode === 'range') {
      if (!rangeNums || !rangeNums.length) {
        setStep('validate', 'error');
        throw new ExportAborted(
          'Type the first and last section. Nothing in that range is in this project.', []);
      }
    }

    setStep('validate', 'running');
    // What is actually checked in line and range mode is only those sections,
    // so the error line numbers address that text and not the whole chapter.
    // Reporting them against the full artifact pointed the caret and the
    // highlighted rows at whatever happened to sit at that line number.
    checkedAtf = mode === 'line' ? await buildSingleLineAtf(lineNum)
      : mode === 'range' ? await buildSingleLineAtf(rangeNums)
      : wireAtf;
    const rowCount = checkedAtf.split(String.fromCharCode(10)).filter((r) => r.trim()).length;
    setStep('validate', 'running', rowCount + ' rows');
    const check = await validateAtfDetailed(checkedAtf);
    const problems = check.problems;
    if (problems && problems.length) {
      setStep('validate', 'error');
      throw new ExportAborted(
        `${problems.length} ATF error${problems.length === 1 ? '' : 's'} — nothing was sent.`,
        problems
      );
    }
    // A check that did not run is not a clean bill of health. It used to be
    // indistinguishable from one: a validator killed mid-parse came back as a
    // server error, the error came back as an empty problem list, and the
    // export went out looking as though it had passed. A range of any size
    // was the usual way to hit it.
    if (!check.checked) {
      setStep('validate', 'error');
      uncheckedNote = '<div class="export-unchecked"><strong>The ATF was not checked here.</strong> '
        + escapeHtml(check.why || 'the validator did not answer')
        + '. eBL checks it on the way in and refuses the whole request if it disagrees.</div>';
    } else {
      setStep('validate', 'done');
    }

    if (exportOptSaveAtfEl && exportOptSaveAtfEl.checked && dirHandle) {
      await FileSystem.writeProjectFile(dirHandle, `export-${stamp}.atf`, wireAtf);
    }

    if (mode === 'validate') {
      exportResultEl.classList.remove('hidden');
      exportResultEl.classList.add('success');
      exportResultEl.classList.remove('failure');
      exportResultEl.innerHTML = check.checked
        ? `Valid. ${countArtifactLines()} chapter lines ready to send. Nothing was written to eBL.`
        : uncheckedNote + 'The ATF was not checked. Nothing was written to eBL.';
      return;
    }

    if (exportOptManuscriptsEl && exportOptManuscriptsEl.checked) {
      setStep('manuscripts', 'running');
      // Whatever the chapter holds and this project does not is sent back
      // unchanged. A blank colophon here means nothing to say, not make it
      // empty, and POST /manuscripts replaces the whole list.
      let held = [];
      try { held = (await EblClient.getChapter(target)).manuscripts || []; } catch (_) { held = []; }
      const eblMss = EblClient.preserveFromChapter(
        EblClient.toEblManuscripts(manuscriptsMeta), held);
      const moved = await manuscriptIdChanges(target, eblMss);
      if (moved.length) {
        setStep('manuscripts', 'error');
        throw new ExportAborted(
          moved.length + ' manuscript' + (moved.length === 1 ? '' : 's')
          + ' would change id — nothing was sent.', moved);
      }
      await EblClient.postManuscripts(target, eblMss, []);
      setStep('manuscripts', 'done');
    }

    // A rejected POST changes nothing on eBL, so unlike replace mode there is
    // no window in which the chapter sits emptied. No backup step for that
    // reason — but the line eBL held is echoed into the result so a bad swap
    // can be undone by hand.
    // A line export replaces what eBL held for that line, alignment and lemmas
    // included, because eBL rebuilds the tokens from the ATF it is sent. Both
    // endpoints rewrite the whole chapter, so one call each covers every line
    // just sent — and the lemmas go after the alignment, since a witness word
    // takes the lemma of whatever it is aligned to.
    const followUp = async (label) => {
      const out = [];
      if (exportOptAlignmentEl && exportOptAlignmentEl.checked) {
        setStep('align', 'running');
        const r = await sendAlignmentFor(target, label);
        setStep('align', r && r.sent ? 'done' : 'error');
        out.push(...alignmentOutcome(r));
      }
      if (exportOptLemmasEl && exportOptLemmasEl.checked) {
        setStep('lemmas', 'running');
        const r = await sendLemmasFor(target, label, false);
        setStep('lemmas', r && r.sent ? 'done' : 'error');
        out.push(...lemmaOutcome(r));
      }
      return out;
    };

    if (mode === 'range') {
      setStep('line', 'running');
      const res = await exportLineRange(target, rangeNums);
      setStep('line', 'done');

      // The lines are on eBL. Written down before the follow-ups, which are
      // whole-chapter writes and the slowest part of any send — one of them
      // stalling must not cost the record of what already succeeded.
      for (const n of rangeNums) markSent(n, ['line']);
      await saveScoreDataToFile();
      keepScoreInView(renderScore);

      const url = `https://www.ebl.lmu.de/corpus/${target.genre}/${target.category}/${target.index}/${target.stage}/${target.name}`;
      const added = res.results.filter((r) => r.inserted).length;
      let html = `Sent ${res.results.length} line${res.results.length === 1 ? '' : 's'}`
        + ` (§${rangeNums[0]}–§${rangeNums[rangeNums.length - 1]})`
        + (added ? `, ${added} of them new to the chapter` : '')
        + '. Lines outside the range were left as they were. ';
      if (res.warnings.length) {
        html += `<br><br><strong>${res.warnings.length} warning`
          + `${res.warnings.length === 1 ? '' : 's'}:</strong><br>`
          + res.warnings.slice(0, 20).map((w) => escapeHtml(w)).join('<br>');
      }
      const after = await followUp('§' + rangeNums[0] + '–§' + rangeNums[rangeNums.length - 1]);

      exportResultEl.classList.remove('hidden');
      exportResultEl.classList.remove('failure');
      exportResultEl.classList.add('success');
      const back = await readBackNote(target);
      exportResultEl.innerHTML = uncheckedNote + html
        + ` <a href="${url}" target="_blank" rel="noopener noreferrer">View chapter on eBL →</a>`
        + after.join('') + back;
      fileExportReport('§' + rangeNums[0] + '–§' + rangeNums[rangeNums.length - 1],
        rangeNums, res, after.concat([back]));
      return;
    }

    if (mode === 'line') {
      setStep('line', 'running');
      const res = await exportSingleLine(target, lineNum);
      setStep('line', 'done');

      markSent(lineNum, ['line']);
      await saveScoreDataToFile();
      keepScoreInView(renderScore);

      const url = `https://www.ebl.lmu.de/corpus/${target.genre}/${target.category}/${target.index}/${target.stage}/${target.name}`;
      let html = res.inserted
        ? `Added §${lineNum} to the chapter (now ${res.chapterLines + 1} lines). `
        : `Replaced §${lineNum} (line ${res.index + 1} of ${res.chapterLines}). `;
      html += 'Every other line was left as it was. ';
      if (res.warnings.length) {
        html += `<br><br><strong>${res.warnings.length} warning` +
          `${res.warnings.length === 1 ? '' : 's'}:</strong><br>` +
          res.warnings.map((w) => escapeHtml(w)).join('<br>');
      }
      const after = await followUp('§' + lineNum);

      exportResultEl.classList.remove('hidden');
      exportResultEl.classList.remove('failure');
      exportResultEl.classList.add('success');
      const back = await readBackNote(target);
      exportResultEl.innerHTML = uncheckedNote + html +
        ` <a href="${url}" target="_blank" rel="noopener noreferrer">View chapter on eBL →</a>`
        + after.join('') + back;
      fileExportReport('§' + lineNum, [lineNum], res, after.concat([back]));
      return;
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
    const back = await readBackNote(target);
    exportResultEl.innerHTML = `${uncheckedNote}${summary}${backupNote} <a href="${url}" target="_blank" rel="noopener noreferrer">View chapter on eBL →</a>` + back;
    // A whole-chapter write left no trace on the reports page either.
    addExportIssue({
      sec: null, part: 'send', kind: 'ok',
      title: mode === 'replace' ? 'The chapter was replaced' : 'Lines were imported',
      report: [outcomeBanner('changed', 'The chapter', summary),
        backupName ? noteBlock('Backup saved as ' + backupName) : '',
        noteBlock('Send the alignment and then the lemmas to put them back.')].join(''),
      done: true, how: 'sent clean',
    });
    updateReportsBadge();
    await saveScoreDataToFile();
  } catch (err) {
    // Figure out which step failed by looking for which step is currently running
    const running = exportProgressEl.querySelector('.export-step.running');
    if (running) setStep(running.dataset.step, 'error');

    exportResultEl.classList.remove('hidden');
    exportResultEl.classList.remove('success');
    exportResultEl.classList.add('failure');

    if (err instanceof ExportAborted) {
      const shown = err.problems.slice(0, VALIDATE_MAX_ERRORS);
      const source = checkedAtf || exportArtifactAtf;
      exportResultEl.innerHTML =
        `<strong>${escapeHtml(err.message)}</strong>` +
        shown.map((e) => {
          const where = (e.line != null ? `Line ${e.line}` : '')
            + (e.column != null ? `, col ${e.column}` : '');
          const at = e.line == null ? '' : pointAt(source, e.line, e.column);
          return `<div class="export-problem"><b>${escapeHtml(where)}</b> — `
            + escapeHtml(describeProblem(source, e))
            + (at ? `<pre>${escapeHtml(at)}</pre>` : '') + '</div>';
        }).join('');
      // Mark the offending rows in the preview and open it, so the error
      // has somewhere to point — against the text that was checked, which in
      // line and range mode is only the sections being sent.
      renderExportPreview(source, err.problems);
      const wrap = document.getElementById('export-preview-wrap');
      if (wrap) wrap.open = true;
    } else if (err instanceof EblClient.EblError) {
      const validationErrors = err.validationErrors;
      const details = validationErrors
        ? validationErrors.map((e) => (e.line != null ? `Line ${e.line}: ${e.message}` : e.message)).join('<br>')
        : escapeHtml(err.rawBody || err.message);
      // A request that never arrived is not a refusal, and after one it is not
      // known whether the write landed.
      const fail = failureReport('The chapter', err);
      exportResultEl.innerHTML = err.transport
        ? `<div class="export-unchecked"><strong>The request never reached eBL.</strong>`
          + ` ${escapeHtml(err.message)}<br>eBL has not answered, so whether anything`
          + ` was written cannot be told from here — look at the chapter before`
          + ` sending again.</div>`
        : `<strong>${escapeHtml(err.message)}</strong><br>${details}`;
      // Also in the overlay, where it can be copied out whole.
      showComposeReport(err.transport ? 'No answer from eBL' : 'eBL refused it',
        fail.blocks, 'export-error');
      // And on the reports page, which is where a failed run is looked for
      // afterwards — especially one that was left running unattended.
      //
      // Which sections wear the failure depends on where it fell. A line step
      // that failed means none of them went, and each should say so in the
      // score; a follow-up that failed means the lines are on eBL and only the
      // chapter-wide part is outstanding.
      const failedStep = running ? running.dataset.step : null;
      const perSection = (failedStep === 'line' || failedStep === 'validate'
        || failedStep === 'manuscripts')
        ? (mode === 'range' ? (rangeNums || []) : (lineNum != null ? [lineNum] : []))
        : [];
      if (perSection.length && perSection.length <= 60) {
        for (const n of perSection) {
          supersedeExportIssues('send', n);
          addExportIssue({
            sec: n, part: 'send', kind: 'error',
            title: '§' + n + ' — ' + fail.title,
            detail: fail.detail, report: fail.blocks.join(''),
          });
        }
      } else {
        addExportIssue({
          sec: (mode === 'line' && lineNum != null) ? lineNum : null,
          part: 'send', kind: 'error', title: fail.title,
          detail: fail.detail, report: fail.blocks.join(''),
        });
      }
      updateReportsBadge();
      saveScoreDataToFile();
      keepScoreInView(renderScore);
      // eBL's own line numbers address the ATF we sent, which is what the
      // preview shows.
      if (validationErrors) {
        renderExportPreview(exportArtifactAtf, validationErrors);
        const wrap = document.getElementById('export-preview-wrap');
        if (wrap) wrap.open = true;
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
    for (const k of Object.keys(stepTimers)) clearInterval(stepTimers[k]);
    exportGoBtn.disabled = false;
  }
}

// ---- Wire buttons ----

// The Export button is a two-item menu: the synoptic score as a text file,
// or the chapter to eBL. Closes on any click outside it.
const exportMenuEl = document.getElementById('export-menu');
const exportTxtItem = document.getElementById('export-txt-item');
const exportEblItem = document.getElementById('export-ebl-item');

function closeExportMenu() {
  if (!exportMenuEl) return;
  exportMenuEl.classList.add('hidden');
  exportBtn.setAttribute('aria-expanded', 'false');
}

exportBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = exportMenuEl.classList.toggle('hidden');
  exportBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
});
document.addEventListener('click', closeExportMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeExportMenu(); });
if (exportTxtItem) exportTxtItem.addEventListener('click', () => { closeExportMenu(); exportScore(); });
if (exportEblItem) exportEblItem.addEventListener('click', () => { closeExportMenu(); openExportModal(); });

// ---- Local ATF validation via the server.js → Python sidecar ----

const VALIDATE_MAX_ERRORS = 5;

if (exportCloseBtn) exportCloseBtn.addEventListener('click', closeExportModal);
if (exportCancelBtn) exportCancelBtn.addEventListener('click', closeExportModal);
if (exportGoBtn) exportGoBtn.addEventListener('click', runExport);
exportModal && exportModal.addEventListener('click', (e) => {
  if (e.target === exportModal) closeExportModal();
});
