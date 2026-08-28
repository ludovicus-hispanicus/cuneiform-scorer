// Find references to things this branch deleted.
//
//   node tools/check-orphans.js
//
// Three regressions in one session came from the same mistake: a block was
// removed and something inside it was still used from outside. `node --check`
// passes, tools/smoke-load.js passes, and the failure waits until a user
// reaches the one code path that calls it.
//
//   - setWitnessVariant   went with the artifact-diff block
//   - escapeRegex         went with it too, and broke deleting a variant
//   - .ebl-status-pill    went with the Reconstructed View styles, and the
//                         header pill rendered invisibly for a day
//
// Detecting undefined identifiers in general needs a real JS lexer. This does
// not: it asks git what this branch removed, then greps for anything still
// referring to it. Precise, and exactly the class of mistake that keeps landing.

const fs = require('fs');
const { execSync } = require('child_process');

const JS = ['app.js', 'compositor.js', 'ebl-atf.js', 'ebl-atf-signs.js', 'ebl-client.js',
            'ebl-corpus.js', 'ebl-fetch.js', 'ebl-ngram.js', 'file-system.js'];
const CSS = ['styles.css', 'index.css'];
const REFS = JS.concat(CSS, ['scorer.html', 'index.html', 'manage.html']);

function head(file) {
  try { return execSync('git show HEAD:' + file, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch (_) { return null; }        // new file, nothing to compare against
}
function now(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

function jsNames(src) {
  const out = new Set();
  if (!src) return out;
  for (const m of src.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) out.add(m[1]);
  return out;
}

function cssNames(src) {
  const out = new Set();
  if (!src) return out;
  for (const m of src.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) out.add(m[1]);
  return out;
}

// Every place a name could still be referred to.
const corpus = REFS.map((f) => ({ file: f, src: now(f) })).filter((x) => x.src);

function referencedIn(name, skipFiles) {
  const rx = new RegExp('(^|[^\\w$.-])' + name.replace(/[-]/g, '\\-') + '($|[^\\w$-])');
  const hits = [];
  for (const { file, src } of corpus) {
    if (skipFiles && skipFiles.indexOf(file) >= 0) continue;
    for (const [i, line] of src.split('\n').entries()) {
      if (rx.test(line)) { hits.push(file + ':' + (i + 1)); break; }
    }
  }
  return hits;
}

let found = 0;

for (const file of JS) {
  const before = jsNames(head(file));
  const after = jsNames(now(file));
  for (const name of before) {
    if (after.has(name)) continue;
    // Gone from this file. Still referred to anywhere?
    const hits = referencedIn(name);
    if (!hits.length) continue;
    console.log('  ORPHAN  ' + name + '  (was defined in ' + file + ')');
    console.log('          still referenced at ' + hits.join(', '));
    found++;
  }
}

for (const file of CSS) {
  const before = cssNames(head(file));
  const after = new Set();
  for (const f of CSS) for (const n of cssNames(now(f))) after.add(n);
  for (const name of before) {
    if (after.has(name)) continue;
    // A class no stylesheet defines any more. Is any markup still wearing it?
    const hits = referencedIn(name, CSS);
    if (!hits.length) continue;
    console.log('  UNSTYLED  .' + name + '  (was styled in ' + file + ')');
    console.log('            still used at ' + hits.join(', '));
    found++;
  }
}

console.log(found
  ? '\n' + found + ' thing(s) referenced but no longer defined'
  : 'nothing references anything this branch removed');
process.exit(found ? 1 : 0);
