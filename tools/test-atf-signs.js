// Score ebl-atf-signs.js against eBL's own output.
//
//   node tools/test-atf-signs.js <fragment-json-dir> [limit]
//
// Every fragment eBL holds is a worked example: `atf` on one side, `signs` on
// the other, computed by eBL's parser. Converting the ATF and diffing against
// `signs` measures the converter exactly, with no judgement call involved.
//
// The directory should hold fragment records as returned by GET /fragments/{n}.

'use strict';

const fs = require('fs');
const path = require('path');
const EblAtfSigns = require('../ebl-atf-signs.js');

const DIR = process.argv[2];
const LIMIT = Number(process.argv[3]) || Infinity;

if (!DIR) {
  process.stderr.write('usage: node tools/test-atf-signs.js <fragment-json-dir> [limit]\n');
  process.exit(2);
}

const index = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'sign-index.json'), 'utf8')
);
const converter = EblAtfSigns.create(index);

const stats = {
  fragments: 0,
  lines: 0,
  linesExact: 0,
  linesLengthMismatch: 0,
  tokens: 0,
  tokensExact: 0,
};
const unresolved = new Map();
const mismatches = new Map();
const lengthExamples = [];

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).slice(0, LIMIT)) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  } catch (err) {
    continue;
  }
  if (!record || !record.atf || !record.signs) continue;

  const expected = record.signs.split('\n');
  const got = converter.convertAtf(record.atf);
  if (got.lines.length !== expected.length) {
    // A line-count disagreement means the two sides cannot be compared at all;
    // report it rather than silently aligning the wrong pairs.
    process.stdout.write(
      `  ! ${file}: ${got.lines.length} lines converted vs ${expected.length} in signs\n`
    );
    continue;
  }

  stats.fragments++;
  for (const reading of got.unresolved) bump(unresolved, reading);

  got.lines.forEach((line, i) => {
    stats.lines++;
    const a = line.split(' ').filter(Boolean);
    const b = expected[i].split(' ').filter(Boolean);
    if (line === expected[i]) {
      stats.linesExact++;
      stats.tokens += b.length;
      stats.tokensExact += b.length;
      return;
    }
    if (a.length !== b.length) {
      stats.linesLengthMismatch++;
      if (lengthExamples.length < 6) {
        lengthExamples.push({ file, n: i, got: a.join(' '), want: b.join(' ') });
      }
      return;
    }
    stats.tokens += b.length;
    for (let k = 0; k < b.length; k++) {
      if (a[k] === b[k]) stats.tokensExact++;
      else bump(mismatches, `${b[k]}  <-got- ${a[k]}`);
    }
  });
}

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : '-');

process.stdout.write(
  `\nfragments compared   ${stats.fragments}\n` +
  `lines                ${stats.lines}\n` +
  `  exact              ${stats.linesExact}  (${pct(stats.linesExact, stats.lines)})\n` +
  `  wrong sign count   ${stats.linesLengthMismatch}  (${pct(stats.linesLengthMismatch, stats.lines)})\n` +
  `tokens (comparable)  ${stats.tokens}\n` +
  `  exact              ${stats.tokensExact}  (${pct(stats.tokensExact, stats.tokens)})\n`
);

function top(map, title, n = 12) {
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  if (!rows.length) return;
  process.stdout.write(`\n${title}\n`);
  for (const [key, count] of rows) {
    process.stdout.write(`  ${String(count).padStart(5)}  ${key}\n`);
  }
}

top(unresolved, 'readings no sign was found for:');
top(mismatches, 'wrong sign (expected <-got- produced):');

if (lengthExamples.length) {
  process.stdout.write('\nlines where the sign count came out wrong:\n');
  for (const ex of lengthExamples) {
    process.stdout.write(`  ${ex.file} line ${ex.n}\n`);
    process.stdout.write(`    want ${ex.want.slice(0, 100)}\n`);
    process.stdout.write(`    got  ${ex.got.slice(0, 100)}\n`);
  }
}
