// Data store
const manuscripts = {};
let activeManuscript = null;
const reconstructedLines = {}; // Store editable reconstructed text for each line

// Load manuscripts from txt files
async function loadManuscripts() {
  try {
    // Load manifest
    const manifestRes = await fetch('manuscripts/index.json');
    const sigla = await manifestRes.json();

    // Load each manuscript
    for (const siglum of sigla) {
      const res = await fetch(`manuscripts/${siglum}.txt`);
      if (res.ok) {
        const content = await res.text();
        const id = `ms-${siglum.toLowerCase()}`;
        manuscripts[id] = { siglum, content };

        // Add to sidebar
        addManuscriptToList(id, siglum);
      }
    }

    // Select first manuscript
    const firstId = Object.keys(manuscripts)[0];
    if (firstId) {
      loadManuscript(firstId);
    }
  } catch (err) {
    console.error('Failed to load manuscripts:', err);
    editor.innerText = 'Error loading manuscripts. Make sure to run from a local server.';
  }
}

// Add manuscript to sidebar list
function addManuscriptToList(id, siglum) {
  const li = document.createElement('li');
  li.className = 'manuscript-item';
  li.dataset.id = id;
  li.textContent = siglum;
  manuscriptList.appendChild(li);
}

// DOM elements
const editor = document.getElementById('editor');
const scorePanel = document.getElementById('score');
const manuscriptList = document.getElementById('manuscript-list');
const addManuscriptBtn = document.getElementById('add-manuscript-btn');
const exportBtn = document.getElementById('export-btn');

// Parse a manuscript text and extract scored lines
function parseManuscript(siglum, text) {
  const lines = text.split('\n');
  const entries = [];
  let currentSurface = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for surface markers
    if (/^(obverse|reverse|edge|left edge|right edge|top|bottom)/i.test(trimmed)) {
      currentSurface = trimmed.toLowerCase();
      continue;
    }

    // Check for §[target] [source]. pattern
    const match = trimmed.match(/^§(\d+)\s+([^.]+)\.\s*(.*)$/);
    if (match) {
      const targetLine = parseInt(match[1], 10);
      const sourceLine = match[2].trim();
      const content = match[3].trim();

      entries.push({
        siglum,
        targetLine,
        sourceLine,
        surface: currentSurface,
        content
      });
    }
  }

  return entries;
}

// Build the synoptic score from all manuscripts
function buildScore() {
  const allEntries = [];

  // Parse all manuscripts
  for (const [id, ms] of Object.entries(manuscripts)) {
    const entries = parseManuscript(ms.siglum, ms.content);
    allEntries.push(...entries);
  }

  // Group by target line
  const scoreLines = {};
  for (const entry of allEntries) {
    if (!scoreLines[entry.targetLine]) {
      scoreLines[entry.targetLine] = [];
    }
    scoreLines[entry.targetLine].push(entry);
  }

  return scoreLines;
}

// Render the score panel
function renderScore() {
  const scoreLines = buildScore();
  const sortedLineNumbers = Object.keys(scoreLines).map(Number).sort((a, b) => a - b);

  if (sortedLineNumbers.length === 0) {
    scorePanel.innerHTML = '<div class="score-empty">No scored lines yet. Use §[line]= to add lines.</div>';
    return;
  }

  let html = '';
  for (const lineNum of sortedLineNumbers) {
    const witnesses = scoreLines[lineNum];

    // Get reconstructed text or default to empty
    const reconstructed = reconstructedLines[lineNum] || '';

    html += `<div class="score-line">`;
    html += `<div class="score-line-header"><span class="line-label">§ ${lineNum}</span> <span class="reconstructed-text" contenteditable="true" data-line="${lineNum}">${escapeHtml(reconstructed)}</span></div>`;

    for (const w of witnesses) {
      const ref = `${w.siglum} ${w.surface} ${w.sourceLine}`;
      html += `<div class="score-witness">`;
      html += `<span class="witness-siglum">${ref}</span>`;
      html += `<span class="witness-text">${escapeHtml(w.content)}</span>`;
      html += `</div>`;
    }

    html += `</div>`;
  }

  scorePanel.innerHTML = html;

  // Add event listeners for reconstructed text editing
  scorePanel.querySelectorAll('.reconstructed-text').forEach(el => {
    el.addEventListener('input', (e) => {
      const lineNum = e.target.dataset.line;
      reconstructedLines[lineNum] = e.target.innerText;
      debouncedSave();
    });
  });
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
    manuscripts[activeManuscript].content = editor.innerText;
  }
}

// Save manuscript to file on server
async function saveToFile(id) {
  const ms = manuscripts[id];
  if (!ms) return;

  try {
    const res = await fetch(`manuscripts/${ms.siglum}.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: ms.content
    });

    if (res.ok) {
      console.log(`Saved ${ms.siglum}.txt`);
    } else {
      console.error('Failed to save:', await res.text());
    }
  } catch (err) {
    console.error('Save error:', err);
  }
}

// Debounced auto-save
let saveTimeout = null;
function debouncedSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    if (activeManuscript) {
      saveToFile(activeManuscript);
    }
    saveScoreToFile(); // Also save the score
  }, 1000); // Save 1 second after last edit
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

  // Load content
  editor.innerText = manuscripts[id].content;

  // Re-render score
  renderScore();
}

// Add a new manuscript
function addManuscript() {
  const siglum = prompt('Enter siglum (e.g., C, D, E):');
  if (!siglum) return;

  const id = `ms-${siglum.toLowerCase()}`;
  if (manuscripts[id]) {
    alert('A manuscript with this siglum already exists.');
    return;
  }

  manuscripts[id] = {
    siglum: siglum.toUpperCase(),
    content: `Ms. ${siglum.toUpperCase()}\nobverse\n§1 1. `
  };

  // Add to list
  const li = document.createElement('li');
  li.className = 'manuscript-item';
  li.dataset.id = id;
  li.textContent = siglum.toUpperCase();
  manuscriptList.appendChild(li);

  // Switch to it
  loadManuscript(id);
}

// Event listeners
editor.addEventListener('input', () => {
  saveCurrentManuscript();
  renderScore();
  debouncedSave(); // Auto-save to file after 1s
});

// Handle Enter key to insert proper line break
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();

    // Insert a newline at cursor position
    const sel = window.getSelection();
    const range = sel.getRangeAt(0);
    range.deleteContents();

    const newline = document.createTextNode('\n');
    range.insertNode(newline);

    // Move cursor after the newline
    range.setStartAfter(newline);
    range.setEndAfter(newline);
    sel.removeAllRanges();
    sel.addRange(range);

    // Trigger update
    saveCurrentManuscript();
    renderScore();
  }
});

manuscriptList.addEventListener('click', (e) => {
  if (e.target.classList.contains('manuscript-item')) {
    loadManuscript(e.target.dataset.id);
  }
});

addManuscriptBtn.addEventListener('click', addManuscript);

// Generate score text
function generateScoreText() {
  const scoreLines = buildScore();
  const sortedLineNumbers = Object.keys(scoreLines).map(Number).sort((a, b) => a - b);

  if (sortedLineNumbers.length === 0) {
    return '';
  }

  let text = 'SYNOPTIC SCORE\n';
  text += '==============\n\n';

  for (const lineNum of sortedLineNumbers) {
    const witnesses = scoreLines[lineNum];
    const reconstructed = reconstructedLines[lineNum] || '';

    text += `§ ${lineNum} ${reconstructed}\n`;

    for (const w of witnesses) {
      const ref = `${w.siglum} ${w.surface} ${w.sourceLine}`.padEnd(15);
      text += `  ${ref} ${w.content}\n`;
    }

    text += '\n';
  }

  return text;
}

// Save score to file on server
async function saveScoreToFile() {
  const text = generateScoreText();
  if (!text) return;

  try {
    const res = await fetch('score.txt', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: text
    });

    if (res.ok) {
      console.log('Saved score.txt');
    } else {
      console.error('Failed to save score:', await res.text());
    }
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
loadManuscripts();

console.log('Manuscript Scorer initialized');
