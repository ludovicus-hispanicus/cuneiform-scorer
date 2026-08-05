// ===========================================
// eBL sign index builder  (dev-time tool)
// ===========================================
// Pulls eBL's sign list and writes the static table the app loads in the
// browser. Run it when the table needs refreshing:
//
//   node tools/build-sign-index.js
//
// Why a build step and not a runtime fetch: eBL has no bulk endpoint for sign
// records — /signs/all returns names only, and each record costs its own
// request. ~2,500 of those is fine once on a developer's machine and absurd on
// every page load, so the result is committed as data/sign-index.json.
//
// What the table is for
// ---------------------
// The corpus dump (/fragments/all-signs) gives ABZ codes, not readings, so a
// scribe's choice of sign is visible but the syllable they meant is not. Two
// different signs can write the same syllable — ŠU (ABZ354) and ŠU₂ (ABZ545)
// both carry the value "šu", separated only by a subIndex. eBL stores value and
// subIndex as separate fields, so dropping the subIndex and grouping by the
// bare value yields exactly the homophone classes we want.
//
// On cutoffs: the raw classes are far too loose to match on. "šu" with no limit
// draws in 22 signs, because some sign somewhere carries a value šu₁₂; "u" draws
// 24. Restricting to low subIndices restores the intent — "šu" at subIndex ≤ 3
// is ŠU, ŠU₂ and a handful more, and mean class size drops from 4.26 to 3.05.
// So each class member keeps the lowest subIndex it writes the value with, and
// the consumer picks the threshold rather than this file deciding for it.

'use strict';

const fs = require('fs');
const path = require('path');

const API = 'https://www.ebl.lmu.de/api';
const OUT = path.join(__dirname, '..', 'data', 'sign-index.json');
const CACHE = path.join(__dirname, '.sign-cache.json');

// Optional: a dump of /fragments/all-signs. With it, each sign records the form
// eBL actually writes it as — see chooseTokens.
const CORPUS = process.argv[2];

// eBL is a small academic service; 8 in flight is brisk without being rude.
const CONCURRENCY = 8;
const RETRIES = 3;

async function getJson(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt > RETRIES) throw err;
    // Linear backoff: the failures we see are transient, not rate limits.
    await new Promise((r) => setTimeout(r, 500 * attempt));
    return getJson(url, attempt + 1);
  }
}

// Run `worker` over `items` with a bounded number in flight. Results keep the
// input order; a permanent failure lands as null rather than sinking the run.
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await worker(items[i], i);
      } catch (err) {
        out[i] = null;
        process.stderr.write(`\n  ! ${items[i]}: ${err.message}\n`);
      }
    }
  });
  await Promise.all(runners);
  return out;
}

function abzOf(record) {
  const hit = (record.lists || []).find((l) => l.name === 'ABZ');
  return hit ? `ABZ${hit.number}` : null;
}

async function fetchRecords(names) {
  // A previous run's records are reused so an interrupted pull can resume.
  let cache = {};
  if (fs.existsSync(CACHE)) {
    cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    process.stdout.write(`  resuming: ${Object.keys(cache).length} records cached\n`);
  }

  const missing = names.filter((n) => !(n in cache));
  process.stdout.write(`  fetching ${missing.length} sign records...\n`);

  let done = 0;
  await pool(missing, CONCURRENCY, async (name) => {
    const rec = await getJson(`${API}/signs/${encodeURIComponent(name)}`);
    cache[name] = rec;
    if (++done % 100 === 0) {
      process.stdout.write(`\r  ${done}/${missing.length}`);
      fs.writeFileSync(CACHE, JSON.stringify(cache));   // checkpoint
    }
    return rec;
  });
  process.stdout.write(`\r  ${done}/${missing.length}\n`);

  fs.writeFileSync(CACHE, JSON.stringify(cache));
  return cache;
}

// A missing subIndex is not subIndex 1 and not a gap in the data: it is the
// unnumbered reading, written with subscript x. RU can be read "šuₓ" while ŠU
// is plain "šu". eBL's own atf.py settles the rendering —
//
//   to_sub_index(None) -> "ₓ"      to_sub_index(1) -> ""      to_sub_index(n) -> "₂"...
//
// so keying an unnumbered value as bare "šu" put RU in competition with ŠU for
// a reading it never spells. With the right key there is no contest.
const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';
const NO_SUBINDEX = 99;   // sorts unnumbered readings last within a class

function toSubIndex(subIndex) {
  if (subIndex == null) return 'ₓ';
  if (subIndex === 1) return '';
  return String(subIndex).split('').map((d) => SUBSCRIPT_DIGITS[Number(d)]).join('');
}

// The same thing typed on a keyboard: "šux", "šu2". Both forms are registered
// so a lookup works whether the caller pasted eBL's subscripts or typed ASCII.
function toAsciiSubIndex(subIndex) {
  if (subIndex == null) return 'x';
  if (subIndex === 1) return '';
  return String(subIndex);
}

// Prefer the plain name a sign is normally cited by: no compound brackets, no
// @-qualifier, and best of all one that simply spells the value (ŠU for "šu").
function nameRank(name, value) {
  const plain = name.replace(/[₀-₉]/g, (d) => '₀₁₂₃₄₅₆₇₈₉'.indexOf(d)).toLowerCase();
  return (
    (plain.replace(/\d+$/, '') === value ? 0 : 4) +
    (name.includes('|') || name.includes('.') ? 2 : 0) +
    (name.includes('@') || name.includes('×') || name.includes('&') ? 1 : 0)
  );
}

// A sign appears in `signs` either as its ABZ code or as its bare name, and
// which one is not predictable from the record: ABZ325 and NUN&NUN are the same
// sign and eBL writes both, 1,185 times and 5,312 times respectively. 36 signs
// are written both ways. So rather than infer a rule, count what eBL does and
// take the majority form — for NUN&NUN and LAGAB×HAL that is the name, for the
// other 548 numbered signs it is the code.
function chooseTokens(signs, corpusPath) {
  const counts = new Map();
  for (const row of JSON.parse(fs.readFileSync(corpusPath, 'utf8'))) {
    for (const token of (row.signs || '').split(/\s+/)) {
      if (token) counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  // Three forms compete, not two: the code, the name as eBL names it, and the
  // name with its enclosing pipes removed. Which one eBL writes varies by sign
  // — |EN×GAN₂@t| keeps its pipes 1,407 times while NUN&NUN drops them 5,312.
  // Comparing only the stripped form silently un-piped every sign that needs
  // them, so all three are counted and the most attested wins.
  let namePreferred = 0;
  for (const [name, entry] of Object.entries(signs)) {
    const candidates = [name, name.replace(/^\|(.*)\|$/, '$1')];
    if (entry.abz) candidates.unshift(entry.abz);

    let best = null;
    let bestCount = 0;
    for (const candidate of candidates) {
      const count = counts.get(candidate) || 0;
      if (count > bestCount) { best = candidate; bestCount = count; }
    }

    entry.token = best || entry.abz || null;
    if (entry.token && entry.token !== entry.abz) namePreferred++;
    if (!entry.token) delete entry.token;
  }
  return namePreferred;
}

function build(records) {
  const signs = {};          // sign name -> { abz, values: [[value, subIndex|null]] }
  const homophones = {};     // bare value -> [[sign name, subIndex]]  (homophone classes)
  const readings = {};       // "šu" / "šu₂" -> sign name   (numbered readings only)
  const alternatives = {};   // "di₂" -> [DIN, TÍ]          (only where contested)
  const unnumbered = {};     // "šuₓ" -> [sign name, ...]   (see below)
  const abz = {};            // "ABZ69" -> { names, values }  (corpus token -> sign)

  const canonicalClaims = {};  // "šu", "šu₂", "šuₓ"  — as eBL writes them
  const aliasClaims = {};      // "šu2", "šux"        — as they get typed

  for (const [name, rec] of Object.entries(records)) {
    if (!rec || rec.error) continue;
    const code = abzOf(rec);
    const values = (rec.values || []).map((v) => [v.value, v.subIndex ?? null]);
    signs[name] = { abz: code, values };

    // Several names can share one ABZ number — ABZ69 is BAD, IDIM and TIL, all
    // genuinely the same sign. The corpus gives us the number, so the entry has
    // to carry every name and the union of their readings.
    if (code) {
      const slot = (abz[code] = abz[code] || { names: [], values: [] });
      slot.names.push(name);
      slot.values.push(...values);
    }

    for (const [value, subIndex] of values) {
      (homophones[value] = homophones[value] || []).push([name, subIndex ?? NO_SUBINDEX]);

      // How the value is written in a transliteration: "šu", "šu₂", "šuₓ".
      const key = value + toSubIndex(subIndex);
      (canonicalClaims[key] = canonicalClaims[key] || []).push({ name, subIndex, value });

      const ascii = value + toAsciiSubIndex(subIndex);
      if (ascii !== key) {
        (aliasClaims[ascii] = aliasClaims[ascii] || []).push({ name, subIndex, value });
      }
    }
  }

  // An unnumbered reading does not name a sign. "šeₓ" is nine different signs
  // and one third of all ₓ readings are shared like that, because ₓ is exactly
  // the absence of a disambiguating number — ATF resolves it with an explicit
  // (SIGN) qualifier instead. Numbered readings are contested 0.9% of the time,
  // so those keep a single answer and these keep all of them.
  let contested = 0;
  let shadowed = 0;

  // `canonical` gates the contested tally: an alias mirrors a reading already
  // counted, so counting both would report every aliased clash twice.
  function record(key, claims, canonical) {
    const numbered = claims.filter((c) => c.subIndex != null);
    if (!numbered.length) {
      unnumbered[key] = [...new Set(claims.map((c) => c.name))].sort(
        (a, b) => nameRank(a, '') - nameRank(b, '') || a.length - b.length || a.localeCompare(b)
      );
      return;
    }
    numbered.sort(
      (a, b) =>
        nameRank(a.name, a.value) - nameRank(b.name, b.value) ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name)
    );
    readings[key] = numbered[0].name;

    // Where several signs claim the reading, the runners-up are kept rather
    // than thrown away. A matcher does not have to commit here: it can accept
    // any claimant at this position and let the surrounding signs settle which
    // one the scribe wrote — the same treatment `unnumbered` gets.
    const names = [...new Set(numbered.map((c) => c.name))];
    if (names.length > 1) {
      alternatives[key] = names;
      if (canonical) contested++;
    }
  }

  for (const [key, claims] of Object.entries(canonicalClaims)) record(key, claims, true);

  // A typed alias must never shadow a reading that exists in its own right:
  // "agarinx" is a real value, not the ASCII spelling of "agarinₓ", and "par4"
  // is a real value, not "par₄".
  for (const [key, claims] of Object.entries(aliasClaims)) {
    if (key in canonicalClaims) {
      shadowed++;
      continue;
    }
    record(key, claims, false);
  }

  // One entry per sign, carrying the lowest subIndex it writes the value with,
  // ordered so a consumer can slice off the tail by subIndex.
  for (const v of Object.keys(homophones)) {
    const lowest = new Map();
    for (const [name, subIndex] of homophones[v]) {
      if (!lowest.has(name) || subIndex < lowest.get(name)) lowest.set(name, subIndex);
    }
    homophones[v] = [...lowest.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([name, si]) => [name, si === NO_SUBINDEX ? null : si]);
  }

  for (const code of Object.keys(abz)) {
    const seen = new Map();
    for (const [value, subIndex] of abz[code].values) {
      const k = `${value} ${subIndex}`;
      if (!seen.has(k)) seen.set(k, [value, subIndex]);
    }
    abz[code].values = [...seen.values()];
    abz[code].names.sort((a, b) => nameRank(a, '') - nameRank(b, '') || a.length - b.length);
  }

  return { signs, homophones, readings, alternatives, unnumbered, abz, contested, shadowed };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  process.stdout.write('eBL sign index\n');
  const names = await getJson(`${API}/signs/all`);
  process.stdout.write(`  /signs/all -> ${names.length} sign names\n`);

  const records = await fetchRecords(names);
  const { signs, homophones, readings, alternatives, unnumbered, abz, contested, shadowed } =
    build(records);

  let namePreferred = null;
  if (CORPUS) {
    namePreferred = chooseTokens(signs, CORPUS);
  }

  const withAbz = Object.values(signs).filter((s) => s.abz).length;
  const classes = Object.entries(homophones).filter(([, l]) => l.length > 1);

  const payload = {
    version: 1,
    source: API,
    retrieved: new Date().toISOString().slice(0, 10),
    counts: {
      signs: Object.keys(signs).length,
      signsWithAbz: withAbz,
      values: Object.keys(homophones).length,
      homophoneClasses: classes.length,
      abzCodes: Object.keys(abz).length,
      readings: Object.keys(readings).length,
      readingsContested: contested,
      unnumbered: Object.keys(unnumbered).length,
    },
    signs,
    homophones,
    readings,
    alternatives,
    unnumbered,
    abz,
  };

  fs.writeFileSync(OUT, JSON.stringify(payload));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);

  process.stdout.write(
    `\n  signs           ${payload.counts.signs}\n` +
    `  with ABZ code   ${withAbz}\n` +
    `  distinct values ${payload.counts.values}\n` +
    `  homophone sets  ${classes.length} (values written by >1 sign)\n` +
    `  readings        ${Object.keys(readings).length} numbered (${contested} claimed by >1 sign)\n` +
    `  unnumbered      ${Object.keys(unnumbered).length} ₓ-readings, kept as candidate lists\n` +
    `  alias clashes   ${shadowed} ASCII aliases dropped for colliding with a real value\n` +
    (namePreferred == null
      ? '  emitted form    not set — pass all-signs.json to record what eBL writes\n'
      : `  emitted form    ${namePreferred} signs eBL writes by name, the rest by ABZ code\n`) +
    `  wrote           ${path.relative(process.cwd(), OUT)}  (${kb} KB)\n`
  );

  // How much the class sizes tighten as the subIndex threshold drops. This is
  // the number to look at when choosing how loose a match to allow.
  process.stdout.write('\n  ambiguity by subIndex cutoff:\n');
  for (const cut of [2, 3, 4, Infinity]) {
    const sizes = Object.values(homophones)
      .map((list) => list.filter(([, si]) => si != null && si <= cut).length)
      .filter((n) => n > 1);
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const label = cut === Infinity ? 'none' : `<= ${cut}`;
    process.stdout.write(
      `    ${label.padEnd(6)} ambiguous values ${String(sizes.length).padStart(5)}   mean class ${mean.toFixed(2)}\n`
    );
  }
}

main().catch((err) => {
  process.stderr.write(`\nfailed: ${err.stack || err.message}\n`);
  process.exit(1);
});
