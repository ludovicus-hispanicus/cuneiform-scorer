// Build the lemma index this app ships with, from a local copy of the eBL
// dictionary (as downloaded by BEn-app from https://www.ebl.lmu.de/api).
//
// Two files come out, both small enough to load in the browser:
//   forms.json    form -> [lemma id]      every attested spelling, syllabic and logographic
//   glosses.json  lemma id -> guide word  what to show beside a candidate
//
// The full entries are 63 MB across 20k files and hold far more than a lemma
// picker needs, so only the guide word is carried over.
//
//   node tools/build-lemma-index.mjs <dictionary-dir> [out-dir]
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
const OUT = process.argv[3] || path.join(process.cwd(), 'data', 'lemmas');
if (!SRC || !fs.existsSync(SRC)) {
  console.error('usage: node tools/build-lemma-index.mjs <dictionary-dir> [out-dir]');
  process.exit(1);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const forms = {};
let syllabic = 0, logographic = 0;

// Syllabic spellings, then logograms. A form can carry both.
for (const [file, kind] of [['words_index.json', 's'], ['logogram_index.json', 'l']]) {
  const p = path.join(SRC, file);
  if (!fs.existsSync(p)) { console.warn('missing, skipped: ' + file); continue; }
  const src = readJson(p);
  for (const [form, ids] of Object.entries(src)) {
    if (!Array.isArray(ids) || !ids.length) continue;
    const seen = forms[form] || (forms[form] = []);
    for (const id of ids) if (!seen.includes(id)) seen.push(id);
    if (kind === 's') syllabic++; else logographic++;
  }
}

// Roots, so a finite verb can be read back to its infinitive.
//
// eBL records the root itself for a verb — amāru is 'mr, tehû is th' — which is
// worth far more than deriving one from the spelling: the aleph marks a radical
// that is never written, and that is exactly where a guessed root goes wrong.
//
// Two tiers, because eBL's part of speech is not always filled in. `verbs` is
// what eBL calls a verb. `likely` is an entry with no part of speech at all
// whose lemma has the shape of an infinitive — epēšu, petû and danānu are all
// recorded with an empty pos, and they are three of the commonest verbs there
// are. The tiers stay apart so the lemmatizer can prefer the certain one:
// iṣṣūru, a bird, is the same shape as an infinitive and must never outrank
// ṣarāru when a text writes iṣ-ru-ur.
const VOWELS = 'aeiouāēīūâêîû';
const INFINITIVE = new RegExp('^[^' + VOWELS + ']*[aeiu][^' + VOWELS + ']{1,2}'
  + '(?:[āēīū][^' + VOWELS + ']u|[ûâî])$');
const rootsOut = { verbs: {}, likely: {}, weak: [] };
// Verbs whose first radical is an aleph — alāku is 'lk, epēšu would be 'pš.
// The aleph is never written; what a text shows instead is the consonant after
// the prefix doubled, il-la-ka and ip-pu-uš. Recording which lemmas these are
// is what lets that doubling be read as the evidence it is.
const weakFirst = new Set();
// The aleph is a radical the writing never shows, so it cannot be matched
// against a spelling and comes out of the key.
// A doubled radical is real — ṣarāru is ṣ-r-r, not ṣ-r — so nothing is
// collapsed here. Gemination in a SPELLING is a different thing, and the
// lemmatizer collapses that at its own end.
const rootKey = (r) => String(r).normalize('NFC').toLowerCase()
  .replace(/['ʾʿ’]/g, '');
const addRoot = (tier, key, id) => {
  if (!key || key.length < 2) return;
  const bucket = rootsOut[tier][key] || (rootsOut[tier][key] = []);
  if (!bucket.includes(id)) bucket.push(id);
};
function collectRoot(id, d) {
  const isVerb = Array.isArray(d.pos) && d.pos.includes('V');
  if (isVerb) {
    for (const r of (Array.isArray(d.roots) ? d.roots : [])) {
      if (/^['ʾʿ’]/.test(String(r))) weakFirst.add(id);
      addRoot('verbs', rootKey(r), id);
    }
    return;
  }
  if (Array.isArray(d.pos) && d.pos.length) return;   // called something else: not ours
  const word = String(id).replace(/\s+[IVX]+$/, '').normalize('NFC').toLowerCase();
  if (!INFINITIVE.test(word)) return;
  const key = rootKey(word).split('').filter((c) => VOWELS.indexOf(c) < 0).join('');
  addRoot('likely', key, id);
}

// Guide words, read from the per-entry files.
const wordsDir = path.join(SRC, 'words');
const glosses = {};
let entries = 0, missing = 0;
if (fs.existsSync(wordsDir)) {
  for (const name of fs.readdirSync(wordsDir)) {
    // (the roots index is filled in the same pass, below)
    if (!name.endsWith('.json')) continue;
    let d;
    try { d = readJson(path.join(wordsDir, name)); } catch (_) { missing++; continue; }
    const id = d._id;
    if (!id) { missing++; continue; }
    // Every entry gets a row, guide word or not. A few dozen eBL lemmas carry
    // an empty guideWord — Adaru I among them — and skipping those made this
    // file an incomplete answer to "is this a real lemma?", which is the
    // question the exporter asks before sending anything to eBL.
    glosses[id] = String(d.guideWord || '').trim();
    entries++;
    collectRoot(id, d);
  }
}

// A handful of ids are named by a form but have no entry file of their own.
// Their guide words are fetched from eBL when --fetch-missing is passed; a
// run without it still gets them as known lemmas, just without a gloss.
//
// (Adaru I is one: eBL knows it as "(12th Babylonian month)", the month behind
// {iti}ŠE, but the local download has no file for it.)
// They are still real lemmas — eBL's index points at them — so they get a row
// with an empty guide word. Otherwise the exporter, which asks this file
// whether a lemma exists before sending it, would refuse to send them.
let orphaned = 0;
for (const ids of Object.values(forms)) {
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(glosses, id)) { glosses[id] = ''; orphaned++; }
  }
}

const blanks = Object.keys(glosses).filter((id) => !glosses[id]);
if (process.argv.includes('--fetch-missing') && blanks.length) {
  const API = 'https://www.ebl.lmu.de/api/words/';
  let got = 0;
  for (const id of blanks) {
    try {
      const res = await fetch(API + encodeURIComponent(id));
      if (!res.ok) continue;
      const d = await res.json();
      const guide = String(d.guideWord || '').trim();
      if (guide) { glosses[id] = guide; got++; }
    } catch (_) { /* offline, or eBL does not know it */ }
  }
  console.log('fetched ' + got + ' of ' + blanks.length + ' missing guide words from eBL');
}

fs.mkdirSync(OUT, { recursive: true });
const write = (name, data) => {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
  return (fs.statSync(p).size / 1048576).toFixed(2) + ' MB';
};

console.log('forms.json    ' + Object.keys(forms).length + ' forms ('
  + syllabic + ' syllabic, ' + logographic + ' logographic)   ' + write('forms.json', forms));
console.log('glosses.json  ' + Object.keys(glosses).length + ' lemmas ('
  + Object.values(glosses).filter(Boolean).length + ' with a guide word) from '
  + entries + ' entries' + (missing ? ' (' + missing + ' unreadable)' : '') + '   '
  + write('glosses.json', glosses));

rootsOut.weak = [...weakFirst];
console.log('roots.json    ' + Object.keys(rootsOut.verbs).length + ' roots eBL calls a verb, '
  + Object.keys(rootsOut.likely).length + ' more with no part of speech recorded, '
  + rootsOut.weak.length + ' with a weak first radical   '
  + write('roots.json', rootsOut));

console.log('  ' + orphaned + ' named by a form but with no entry file of their own');

// A lemma id that no form points at can never be reached from a word.
const reachable = new Set(Object.values(forms).flat());
const orphans = Object.keys(glosses).filter((id) => !reachable.has(id)).length;
console.log('lemma ids reachable from some form: ' + reachable.size
  + ',  with a guide word: ' + [...reachable].filter((id) => glosses[id]).length
  + ',  entries no form reaches: ' + orphans);
