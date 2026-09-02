// Bring witness line numbers into the order eBL accepts.
//
//   node tools/fix-line-numbers.js <projectDir>            (dry run, the default)
//   node tools/fix-line-numbers.js <projectDir> --write
//
// eBL's own grammar (ebl-grammar/ebl_atf_text_line.lark) reads a line number as
//
//   single_line_number: [LETTER "+"] INT [ANY_PRIME] [LETTER]
//
// so the prime comes BEFORE the letter: "6'a" is a line number, "6a'" is not.
// A manuscript line carrying the wrong order is refused by eBL with "Invalid
// manuscript line" and the ATF quoted, which points at the content when the
// content is fine.
//
// This rewrites only that: the prime and the letter swap places. Anything else
// it cannot read is reported and left alone — a malformed range like "51a-b"
// is a decision about what the line is, not a transposition.
//
// The alignment is keyed by "siglum|sourceLine", so renaming a line without
// moving its key would orphan every position held against it. score-data.json
// is rewritten in the same pass, or not at all.
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const write = process.argv.includes('--write');
if (!dir) {
  console.error('usage: node tools/fix-line-numbers.js <projectDir> [--write]');
  process.exit(2);
}

// Built from regex literals, not strings: a backslash in a string literal is
// an escape the regex never sees.
const SINGLE = /(?:[A-Za-z]\+)?\d+['′’]?[A-Za-z]?/.source;
const EBL_OK = new RegExp(`^(?:${SINGLE})(?:-(?:${SINGLE}))?$`);
const SWAPPED = /^((?:[A-Za-z]\+)?\d+)([A-Za-z])(['′’])$/;

// "§12 6a'. content" — the label sits between the § marker and the full stop.
const ROW = /^(\s*§\d+[a-z]?\s+)(\S+)(\.\s)/;

const msDir = path.join(dir, 'manuscripts');
if (!fs.existsSync(msDir)) {
  console.error('no manuscripts/ under ' + dir);
  process.exit(2);
}

const renames = [];      // { file, siglum, from, to, line }
const unfixable = [];    // { file, label, line }

for (const name of fs.readdirSync(msDir).filter((f) => f.endsWith('.txt'))) {
  const full = path.join(msDir, name);
  const text = fs.readFileSync(full, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rows = text.split(/\r?\n/);
  let touched = false;

  rows.forEach((row, i) => {
    const m = row.match(ROW);
    if (!m) return;
    const label = m[2];
    if (EBL_OK.test(label)) return;
    const swap = label.match(SWAPPED);
    if (!swap) {
      unfixable.push({ file: name, label, line: i + 1 });
      return;
    }
    const fixed = swap[1] + swap[3] + swap[2];
    rows[i] = m[1] + fixed + m[3] + row.slice(m[0].length);
    renames.push({ file: name, siglum: name.replace(/\.txt$/, ''),
                   from: label, to: fixed, line: i + 1 });
    touched = true;
  });

  if (touched && write) fs.writeFileSync(full, rows.join(eol), 'utf8');
}

// The alignment follows the line it belongs to.
const sdPath = path.join(dir, 'score-data.json');
const keyMoves = [];
if (fs.existsSync(sdPath) && renames.length) {
  const data = JSON.parse(fs.readFileSync(sdPath, 'utf8'));
  const align = data.alignments || {};
  for (const sec of Object.keys(align)) {
    for (const key of Object.keys(align[sec])) {
      const bar = key.lastIndexOf('|');
      if (bar < 0) continue;
      const siglum = key.slice(0, bar);
      const label = key.slice(bar + 1);
      const hit = renames.find((r) =>
        r.from === label && (r.siglum === siglum || r.siglum === siglum.replace(/\.txt$/, '')));
      if (!hit) continue;
      const next = siglum + '|' + hit.to;
      keyMoves.push({ sec, from: key, to: next });
      if (write) {
        align[sec][next] = align[sec][key];
        delete align[sec][key];
      }
    }
  }
  if (write && keyMoves.length) {
    fs.writeFileSync(sdPath, JSON.stringify(data, null, 2), 'utf8');
  }
}

console.log((write ? 'REWROTE' : 'WOULD REWRITE') + ' ' + renames.length
  + ' line number(s) in ' + path.basename(dir));
const byFile = {};
for (const r of renames) (byFile[r.file] = byFile[r.file] || []).push(r);
for (const f of Object.keys(byFile).sort()) {
  console.log('  ' + f);
  for (const r of byFile[f]) console.log('      line ' + r.line + ':  ' + r.from + '  ->  ' + r.to);
}
if (keyMoves.length) {
  console.log((write ? '  moved ' : '  would move ') + keyMoves.length
    + ' alignment key(s) with them');
} else if (renames.length) {
  console.log('  no alignment keys pointed at those lines');
}
if (unfixable.length) {
  console.log('\nLEFT ALONE — eBL will not take these either, but the fix is a');
  console.log('decision about what the line is, not a transposition:');
  for (const u of unfixable) {
    console.log('  ' + u.file + ' line ' + u.line + ':  ' + u.label);
  }
}
if (!write) console.log('\n(dry run — pass --write to apply)');
