// Renumber a project's § coordinate system.
//
// The § numbers of a project are shared by every source, the score data and
// the annotations, so inserting a line in one manuscript moves everything
// after it. This does the whole migration in one pass, to a COPY of the
// project by default, and reports every line it changed.
//
//   node tools/renumber-project.mjs --project "<dir>" --out "<dir>" \
//        --shift-after 51 --by 3 \
//        --assign "K.2246:57=52" --assign "K.2246:58=53" --assign "K.2246:59=54" \
//        --ruling-after "K.2246:58"
//
// Add --apply to write into --project itself instead of --out.
//
// What is rewritten:
//   *.txt        line-initial "§N " prefixes — text lines and "§N $ ..."
//                directives alike
//   score-data.json   reconstructed / translations / notes / parallels /
//                variants, all keyed by §
//   annotations.json  the "sec" anchor of each note
//
// What is deliberately NOT touched:
//   "$ (§N)" markers — those are eBL's own paragraph numbers carried in from
//   a fetch, a different coordinate system that must not be shifted.
//   Unassigned transliteration lines stay unassigned: a source contributes
//   where it overlaps, and lines that belong to no chapter line are the
//   reason a project has more than one version.

import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : fallback;
};
const all = (name) => args.reduce((acc, a, i) =>
  (a === '--' + name ? [...acc, args[i + 1]] : acc), []);

const PROJECT = opt('project');
const APPLY = args.includes('--apply');
const OUT = APPLY ? PROJECT : opt('out');
const SHIFT_AFTER = Number(opt('shift-after', '0'));
const BY = Number(opt('by', '0'));

if (!PROJECT || !OUT) {
  console.error('need --project and --out (or --apply)');
  process.exit(1);
}

// "K.2246:57=52" -> assignments.get('K.2246').set('57', '52')
const assignments = new Map();
for (const spec of all('assign')) {
  const m = String(spec).match(/^(.+?):(.+?)=(.+)$/);
  if (!m) throw new Error('bad --assign: ' + spec);
  if (!assignments.has(m[1])) assignments.set(m[1], new Map());
  assignments.get(m[1]).set(m[2], m[3]);
}
// "K.2246:58" — the unassigned ruling right after that line takes its §
const rulingAfter = new Map();
for (const spec of all('ruling-after')) {
  const m = String(spec).match(/^(.+?):(.+)$/);
  if (!m) throw new Error('bad --ruling-after: ' + spec);
  rulingAfter.set(m[1], m[2]);
}

const shift = (n) => (n > SHIFT_AFTER ? n + BY : n);
const report = [];

// ---- manuscripts -----------------------------------------------------------
const msDir = path.join(PROJECT, 'manuscripts');
const outMsDir = path.join(OUT, 'manuscripts');
await mkdir(outMsDir, { recursive: true });

const files = (await readdir(msDir)).filter((f) => f.endsWith('.txt'));
let totalShifted = 0;
let totalAssigned = 0;

for (const file of files) {
  const siglum = file.replace(/\.txt$/, '');
  const text = await readFile(path.join(msDir, file), 'utf8');
  const lines = text.split('\n');
  const assign = assignments.get(siglum) || new Map();
  const rulingLine = rulingAfter.get(siglum);
  let shifted = 0;
  let assigned = 0;
  let armRuling = false;

  const out = lines.map((line) => {
    // an already-assigned line: shift its §
    const pre = line.match(/^§(\d+)([a-z]?)(\s.*)$/);
    if (pre) {
      const from = Number(pre[1]);
      const to = shift(from);
      armRuling = false;
      if (to !== from) {
        shifted++;
        report.push(`${siglum}: §${from}${pre[2]} -> §${to}${pre[2]}   ${pre[3].trim().slice(0, 48)}`);
        return `§${to}${pre[2]}${pre[3]}`;
      }
      return line;
    }

    // an unassigned transliteration line that is being given a §
    const num = line.match(/^(\d+['’]?[a-z]?)\.\s(.*)$/);
    if (num) {
      const sec = assign.get(num[1]);
      armRuling = rulingLine === num[1];
      if (sec) {
        assigned++;
        report.push(`${siglum}: line ${num[1]} -> §${sec} (new)   ${num[2].slice(0, 44)}`);
        return `§${sec} ${line}`;
      }
      return line;
    }

    // the unassigned ruling directly after a named line takes that line's §
    if (armRuling && /^\$\s/.test(line) && !/^\$\s*\(§/.test(line)) {
      armRuling = false;
      const sec = assign.get(rulingLine);
      if (sec) {
        report.push(`${siglum}: ruling after ${rulingLine} -> §${sec} ${line.trim()}`);
        return `§${sec} ${line}`;
      }
    }
    return line;
  });

  await writeFile(path.join(outMsDir, file), out.join('\n'));
  totalShifted += shifted;
  totalAssigned += assigned;
  if (shifted || assigned) {
    console.log(`${siglum.padEnd(22)} ${String(shifted).padStart(4)} shifted` +
      (assigned ? `, ${assigned} newly assigned` : ''));
  }
}

// non-.txt files in manuscripts/ (index.json, desktop.ini) ride along
for (const f of (await readdir(msDir)).filter((f) => !f.endsWith('.txt'))) {
  await copyFile(path.join(msDir, f), path.join(outMsDir, f)).catch(() => {});
}

// ---- score data ------------------------------------------------------------
const remapKeys = (obj) => {
  if (!obj) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[/^\d+$/.test(k) ? String(shift(Number(k))) : k] = v;
  }
  return out;
};

let scoreMoved = 0;
try {
  const raw = await readFile(path.join(PROJECT, 'score-data.json'), 'utf8');
  const data = JSON.parse(raw);
  for (const key of ['reconstructed', 'translations', 'notes', 'parallels', 'variants']) {
    if (!data[key]) continue;
    const before = Object.keys(data[key]).filter((k) => /^\d+$/.test(k) && Number(k) > SHIFT_AFTER).length;
    data[key] = remapKeys(data[key]);
    scoreMoved += before;
  }
  await writeFile(path.join(OUT, 'score-data.json'), JSON.stringify(data, null, 2));
  console.log(`\nscore-data.json        ${scoreMoved} entries moved`);
} catch (err) {
  console.log('\nscore-data.json        skipped (' + err.message + ')');
}

// ---- annotations -----------------------------------------------------------
let notesMoved = 0;
try {
  const raw = await readFile(path.join(PROJECT, 'annotations.json'), 'utf8');
  const notes = JSON.parse(raw);
  for (const note of notes) {
    const m = String(note.sec || '').match(/^(\d+)([a-z]?)$/);
    if (!m) continue;
    const to = shift(Number(m[1]));
    if (to !== Number(m[1])) {
      report.push(`annotation "${note.title}": §${m[1]}${m[2]} -> §${to}${m[2]}`);
      note.sec = String(to) + m[2];
      notesMoved++;
    }
  }
  await writeFile(path.join(OUT, 'annotations.json'), JSON.stringify(notes, null, 2));
  console.log(`annotations.json       ${notesMoved} anchors moved`);
} catch (err) {
  console.log('annotations.json       skipped (' + err.message + ')');
}

// everything else in the project root travels unchanged
for (const f of await readdir(PROJECT)) {
  if (['manuscripts', 'score-data.json', 'annotations.json'].includes(f)) continue;
  await copyFile(path.join(PROJECT, f), path.join(OUT, f)).catch(() => {});
}

await writeFile(path.join(OUT, 'RENUMBERING-REPORT.txt'),
  `Renumbering of ${PROJECT}\n` +
  `${new Date().toISOString()}\n\n` +
  `Rule: §N -> §N+${BY} for every N > ${SHIFT_AFTER}\n` +
  [...assignments].flatMap(([sig, m]) =>
    [...m].map(([line, sec]) => `New: ${sig} line ${line} -> §${sec}`)).join('\n') +
  `\n\n${totalShifted} § prefixes shifted, ${totalAssigned} lines newly assigned, ` +
  `${scoreMoved} score entries moved, ${notesMoved} annotation anchors moved\n\n` +
  report.join('\n') + '\n');

console.log(`\n${totalShifted} § prefixes shifted, ${totalAssigned} newly assigned`);
console.log(`report: ${path.join(OUT, 'RENUMBERING-REPORT.txt')}`);
