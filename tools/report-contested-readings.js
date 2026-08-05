// Export the readings that eBL's sign list assigns to more than one sign.
//
//   node tools/report-contested-readings.js [all-signs.json]
//
// The premise is eBL's own: different signs should not carry identical
// readings. A *numbered* reading that several signs claim is therefore a data
// error worth reporting — "dubba" sits on both DUB and DIB, where Borger's
// MesZL has DUB = dubba and DIB should be dubbaₓ; "eger₆" sits on both MURGU₂
// and SIG₄, where Borger has egir₆ = MURGU (// SIG₄) and egir₅ = MURGU₂ (//
// LUM).
//
// Unnumbered ₓ readings are excluded on purpose. There, sharing is the meaning
// rather than a mistake — ₓ *is* the absence of a disambiguating number, so
// "šeₓ" naming nine signs is correct and reporting it would bury the real
// cases. The count of what was left out is printed rather than passed over.
//
// Reads tools/.sign-cache.json, the raw records kept by build-sign-index.js,
// because the built table narrows each sign to its ABZ number and MesZL is what
// the discussion is conducted in.
//
// Pass the corpus dump to add attestation counts — which of the competing signs
// is actually written, which is usually what settles it.

'use strict';

const fs = require('fs');
const path = require('path');

const CACHE = path.join(__dirname, '.sign-cache.json');
const INDEX = path.join(__dirname, '..', 'data', 'sign-index.json');
const OUT = path.join(__dirname, '..', 'data', 'contested-readings.csv');
const CORPUS = process.argv[2];

const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';

function toSubIndex(subIndex) {
  if (subIndex == null) return 'ₓ';
  if (subIndex === 1) return '';
  return String(subIndex).split('').map((d) => SUBSCRIPT_DIGITS[Number(d)]).join('');
}

function listNumber(record, name) {
  const hit = (record.lists || []).find((l) => l.name === name);
  return hit ? hit.number : '';
}

// The sign search the eBL team uses, so a row can be opened and checked.
function eblUrl(reading, value, subIndex) {
  const params = new URLSearchParams({
    isComposite: 'false',
    isIncludeHomophones: 'false',
    sign: reading,
    subIndex: String(subIndex),
    value,
  });
  return `https://www.ebl.lmu.de/tools/signs?${params.toString()}`;
}

function csvField(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function main() {
  if (!fs.existsSync(CACHE)) {
    process.stderr.write(`missing ${path.relative(process.cwd(), CACHE)} — run tools/build-sign-index.js first\n`);
    process.exit(1);
  }
  const records = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));

  // How often each ABZ code is actually written, if the corpus was supplied.
  const attested = new Map();
  if (CORPUS) {
    for (const row of JSON.parse(fs.readFileSync(CORPUS, 'utf8'))) {
      for (const token of (row.signs || '').split(/\s+/)) {
        if (token) attested.set(token, (attested.get(token) || 0) + 1);
      }
    }
  }

  // Collect every claim on every reading.
  const claims = new Map();
  for (const [name, record] of Object.entries(records)) {
    if (!record || !record.values) continue;
    for (const v of record.values) {
      const subIndex = v.subIndex ?? null;
      const reading = v.value + toSubIndex(subIndex);
      if (!claims.has(reading)) claims.set(reading, { value: v.value, subIndex, signs: [] });
      claims.get(reading).signs.push(name);
    }
  }

  const rows = [];
  let unnumberedSkipped = 0;

  for (const [reading, claim] of [...claims.entries()].sort()) {
    const signs = [...new Set(claim.signs)];
    if (signs.length < 2) continue;
    if (claim.subIndex == null) { unnumberedSkipped++; continue; }

    const picked = index.readings[reading];
    for (const name of signs.sort()) {
      const record = records[name];
      const abz = listNumber(record, 'ABZ');
      const code = abz ? `ABZ${abz}` : '';
      rows.push({
        reading,
        value: claim.value,
        sub_index: claim.subIndex,
        competing_signs: signs.length,
        sign_name: name,
        abz: code,
        mzl: listNumber(record, 'MZL'),
        other_lists: (record.lists || [])
          .filter((l) => l.name !== 'ABZ' && l.name !== 'MZL')
          .map((l) => `${l.name} ${l.number}`)
          .join('; '),
        sign_other_values: (record.values || [])
          .map((v) => v.value + toSubIndex(v.subIndex ?? null))
          .filter((r) => r !== reading)
          .join(' '),
        corpus_occurrences: CORPUS ? (attested.get(code) || 0) : '',
        resolved_to_by_scorer: picked === name ? 'yes' : '',
        ebl_url: eblUrl(reading, claim.value, claim.subIndex),
      });
    }
  }

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvField(row[h])).join(','));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // A BOM so Excel reads the subscripts and š/ṣ/ṭ as UTF-8 rather than as
  // whatever the system codepage happens to be.
  fs.writeFileSync(OUT, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');

  const readings = new Set(rows.map((r) => r.reading));
  process.stdout.write(
    `contested numbered readings  ${readings.size}\n` +
    `rows (one per competing sign) ${rows.length}\n` +
    `unnumbered ₓ readings skipped ${unnumberedSkipped}  (sharing is correct there)\n` +
    `attestation counts            ${CORPUS ? 'included' : 'omitted — pass all-signs.json to add them'}\n` +
    `wrote                         ${path.relative(process.cwd(), OUT)}\n`
  );
}

main();
