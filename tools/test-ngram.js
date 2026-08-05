// Headless check on ebl-ngram.js against a project with a known answer.
//
//   node tools/test-ngram.js <corpus.json> <project-dir> [atf-cache-dir]
//
// EAE 56 is the fixture: eBL records BM.41031, BM.41619, K.20497 and K.14796 as
// pieces of tablets the edition already uses, each with its own transliteration
// and none of them in the project. A ranking that works has to put them near
// the top without being told they exist.
//
// Given a directory of cached fragment JSON, the colophon channel is exercised
// too. That one has no clean answer set — the check is that it separates: the
// Nabû-zuqup-kēnu tablets should rise on the colophon score and stay low on the
// text score, since they share this edition's scribe but not its composition.

'use strict';

const fs = require('fs');
const path = require('path');
const EblNgram = require('../ebl-ngram.js');

const CORPUS = process.argv[2];
const PROJECT = process.argv[3];
const ATF_DIR = process.argv[4];

if (!CORPUS || !PROJECT) {
  process.stderr.write('usage: node tools/test-ngram.js <corpus.json> <project-dir> [atf-cache-dir]\n');
  process.exit(2);
}

// Pieces eBL already links to this edition's tablets — the fixture's answer.
const EXPECTED = ['K.21881', 'K.20497', 'BM.41031', 'BM.41619', 'K.14796', 'ND.4405.53'];

function main() {
  const t0 = Date.now();
  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
  const byId = new Map(corpus.map((r) => [r._id, r.signs]));
  process.stdout.write(`corpus      ${corpus.length.toLocaleString()} fragments  (${Date.now() - t0} ms to parse)\n`);

  const sources = fs
    .readdirSync(path.join(PROJECT, 'manuscripts'))
    .filter((f) => f.endsWith('.txt'))
    .map((f) => f.replace(/\.txt$/, ''));

  const present = sources.filter((s) => byId.has(s));
  process.stdout.write(`project     ${present.length}/${sources.length} sources found in the corpus\n`);
  if (present.length < sources.length) {
    process.stdout.write(`            missing: ${sources.filter((s) => !byId.has(s)).join(', ')}\n`);
  }

  // Split each source into composition and colophon where an ATF is available.
  const textLines = [];
  const colophonLines = [];
  let withColophon = 0;
  let misaligned = 0;

  for (const id of present) {
    const atf = ATF_DIR ? readAtf(id) : null;
    if (!atf) {
      textLines.push(byId.get(id));
      continue;
    }
    const split = EblNgram.splitColophon(atf, byId.get(id));
    if (!split.aligned) misaligned++;
    if (split.colophon.length) withColophon++;
    textLines.push(split.text.join('\n'));
    if (split.colophon.length) colophonLines.push(split.colophon.join('\n'));
  }

  if (ATF_DIR) {
    process.stdout.write(
      `channels    ${withColophon} sources carry a colophon, ${misaligned} misaligned\n`
    );
  }

  const t1 = Date.now();
  const text = EblNgram.buildProfile(textLines);
  const colophon = colophonLines.length ? EblNgram.buildProfile(colophonLines) : null;
  process.stdout.write(
    `profile     text ${text.size.toLocaleString()} trigrams` +
    (colophon ? `, colophon ${colophon.size.toLocaleString()}` : '') +
    `  (${Date.now() - t1} ms)\n`
  );

  const profiles = colophon ? { text, colophon } : { text };

  const t2 = Date.now();
  const entries = corpus.map((r) => ({ id: r._id, signs: r.signs }));
  const out = EblNgram.rank(profiles, entries, { exclude: new Set(sources), limit: 15 });
  const sweep = Date.now() - t2;

  process.stdout.write(
    `sweep       ${sweep} ms for ${corpus.length.toLocaleString()} fragments ` +
    `(${(corpus.length / (sweep / 1000)).toFixed(0)}/s)\n`
  );
  process.stdout.write(
    `dropped     ${out.dropped.excluded} own sources, ${out.dropped.tooSmall} under ` +
    `${out.settings.minDocNgrams} trigrams, ${out.dropped.noOverlap} with no overlap\n` +
    `scored      ${out.total.toLocaleString()}\n\n`
  );

  const full = EblNgram.rank(profiles, entries, { exclude: new Set(sources), limit: 0 });

  const byChannel = (channel) =>
    full.results
      .filter((r) => r.scores[channel])
      .sort((a, b) => b.scores[channel].overlap - a.scores[channel].overlap ||
                      b.scores[channel].shared - a.scores[channel].shared);

  function table(channel, rows, note) {
    process.stdout.write(`\n${note}\n`);
    process.stdout.write(
      `${'rank'.padStart(4)} ${'text'.padStart(6)} ${'colo'.padStart(6)} ` +
      `${'shared'.padStart(7)} ${'size'.padStart(6)}  id\n`
    );
    rows.forEach((r, i) => {
      const t = r.scores.text;
      const c = r.scores.colophon;
      const tag = EXPECTED.includes(r.id) ? '  <-- expected' : '';
      process.stdout.write(
        `${String(i + 1).padStart(4)} ${t.overlap.toFixed(3).padStart(6)} ` +
        `${(c ? c.overlap.toFixed(3) : '-').padStart(6)} ` +
        `${String(r.scores[channel].shared).padStart(7)} ` +
        `${String(t.docSize).padStart(6)}  ${r.id}${tag}\n`
      );
    });
  }

  table('text', byChannel('text').slice(0, 15), 'ranked by TEXT — another witness of the composition');
  if (colophon) {
    table('colophon', byChannel('colophon').slice(0, 10), 'ranked by COLOPHON — same scribe or library, a join signal');
  }

  process.stdout.write('\nwhere the known-missing pieces landed on the text channel:\n');
  const ordered = byChannel('text');
  for (const id of EXPECTED) {
    const at = ordered.findIndex((r) => r.id === id) + 1;
    process.stdout.write(`  ${id.padEnd(12)} ${at ? `rank ${at}` : 'NOT RANKED (filtered out)'}\n`);
  }

  const ranked = EXPECTED.filter((id) => ordered.some((r) => r.id === id));
  process.stdout.write(`\n${ranked.length}/${EXPECTED.length} recovered\n`);
}

function readAtf(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ATF_DIR, `${id}.json`), 'utf8')).atf || null;
  } catch (err) {
    return null;
  }
}

main();
