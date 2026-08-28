// Run the export builders for real, against stubs.
//
//   node tools/check-export.js
//
// `node --check` proves the file parses and tools/check-orphans.js proves
// nothing refers to something deleted. Neither reaches a free variable inside a
// function body, and that is what shipped: extracting exportSingleLine into a
// shared context left `manuscriptIdByFile` unqualified, so every line and range
// export threw "manuscriptIdByFile is not defined" the moment it was pressed —
// after the ATF had validated and the manuscripts had been registered.
//
// Detecting that statically needs scope analysis, which needs a linter this
// project does not carry. Calling the function does it in one line.
//
// The stubs answer only what the builders ask of them. They are not a model of
// eBL; if a builder starts needing more, the failure here is the point.

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app.js');
const lines = fs.readFileSync(APP, 'utf8').split(/\r?\n/);

// One top-level function by name, from its declaration to the line that closes
// it at column zero.
function grab(name) {
  const start = lines.findIndex((l) =>
    l.startsWith('function ' + name + '(') || l.startsWith('async function ' + name + '('));
  if (start < 0) throw new Error('no such function in app.js: ' + name);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end++;
  if (end >= lines.length) throw new Error('unterminated function: ' + name);
  return lines.slice(start, end + 1).join('\n');
}

const WANTED = ['lineExportContext', 'buildLineForExport', 'exportLineRange', 'exportSingleLine'];

let posted = null;
const stub = {
  EblClient: {
    getChapter: async () => ({
      manuscripts: [{ id: 7, museumNumber: 'K.2246' }],
      lines: [{ number: '14' }, { number: '15' }, { number: '16' }],
    }),
    postLines: async (target, payload) => { posted = payload; },
  },
  FileSystem: {
    readManuscriptsMeta: async () => ({
      version: 1,
      manuscripts: [{ file: 'K.2246.txt', museumNumber: 'K.2246', id: 7 }],
    }),
  },
  EblAtf: {
    buildChapterLine: (o) => {
      // The id map is the thing that went missing, so assert it arrived.
      if (!o.manuscriptIdByFile || !Object.keys(o.manuscriptIdByFile).length) {
        throw new Error('buildChapterLine got no manuscriptIdByFile');
      }
      return { line: { number: o.lineNum }, warnings: [] };
    },
  },
  buildScore: () => ({
    scoreLines: {
      14: [{ type: 'line', siglum: 'K.2246', sourceLine: '14', variant: 0 }],
      15: [], 16: [],
    },
  }),
  variantsFor: () => [{ text: 'DIS x y' }],
  positionWords: () => [{ pos: 0, text: 'DIS' }],
  alignmentTally: () => ({ omitted: [] }),
  lineAlignments: {},
  reconstructedLines: {},
  translationLines: {},
  noteLines: {},
  parallelLines: {},
  variantLines: {},
  manuscriptsMeta: null,
  dirHandle: {},
};

const names = Object.keys(stub);
const body = WANTED.map(grab).join('\n') + '\nreturn { exportLineRange, exportSingleLine };';
const api = new Function(...names, body)(...names.map((n) => stub[n]));

(async () => {
  const range = await api.exportLineRange({ genre: 'D' }, [14, 15, 16]);
  if (!posted || (posted.edited || []).length !== 3) {
    throw new Error('a range of three should be one POST of three edits, got '
      + JSON.stringify(posted));
  }
  if (range.results.length !== 3) throw new Error('three sections, three results');

  const one = await api.exportSingleLine({ genre: 'D' }, 14);
  if (one.inserted !== false || one.index !== 0) {
    throw new Error('single line should replace in place: ' + JSON.stringify(one));
  }

  // A section eBL does not hold yet goes as a new line rather than failing.
  posted = null;
  const fresh = await api.exportLineRange({ genre: 'D' }, [99]);
  if (!posted || !(posted.newLines || []).length) {
    throw new Error('an unknown section should be sent as a new line');
  }
  if (!fresh.results[0].inserted) throw new Error('and be reported as inserted');

  console.log('the export builders run: range, single line, and a section eBL lacks');
})().catch((err) => {
  console.error('export check failed: ' + err.message);
  process.exit(1);
});
