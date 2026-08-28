// Load every browser module under a stubbed DOM.
//
// This cannot prove the app works. What it does prove is that every
// identifier the module bodies touch is actually declared — the class of
// bug `node --check` sails straight past, and which reaches the browser as
// a bare "X is not defined" at first render.
//
//   node tools/smoke-load.js        (from the project root)
//
const fs = require('fs');
const vm = require('vm');

const anything = () => new Proxy(function () {}, {
  get(t, k) {
    if (k === Symbol.toPrimitive || k === 'toString') return () => '';
    if (k === Symbol.iterator) return function* () {};
    if (k === 'length') return 0;
    if (k === 'then') return undefined;          // never look like a promise
    if (k === 'classList') return anything();
    if (k === 'dataset') return anything();
    if (k === 'style') return anything();
    return anything();
  },
  set() { return true; },
  apply() { return anything(); },
  construct() { return anything(); },
  has() { return true; },
});

const el = () => {
  const o = anything();
  return o;
};

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Date, Math, JSON, Map, Set, WeakMap, Array, Object, String, Number,
  RegExp, Error, Intl, TextDecoder, TextEncoder, URL, Proxy, Symbol, Boolean,
  requestAnimationFrame: (f) => 0,
  fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  indexedDB: anything(),
  navigator: { userAgent: 'node', clipboard: anything() },
  location: { href: '', search: '', hash: '' },
  alert: () => {}, confirm: () => false, prompt: () => null,
  ace: anything(),
  fabric: anything(),
  Y: undefined,
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
  getSelection: () => ({ isCollapsed: true, rangeCount: 0, toString: () => '' }),
  open: () => null, scrollTo: () => {}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  Blob: function () {}, URLSearchParams,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.document = new Proxy({}, {
  get(t, k) {
    if (k === 'body') return anything();
    if (k === 'documentElement') return anything();
    if (k === 'getElementById') return () => el();
    if (k === 'querySelector') return () => el();
    if (k === 'querySelectorAll') return () => [];
    if (k === 'createElement') return () => el();
    if (k === 'addEventListener') return () => {};
    if (k === 'createTextNode') return () => el();
    return anything();
  },
});

vm.createContext(sandbox);
const files = ['ebl-atf-signs.js', 'compositor.js', 'ebl-client.js', 'ebl-atf.js',
               'file-system.js', 'ebl-fetch.js', 'ebl-corpus.js', 'ebl-ngram.js', 'app.js'];
let ok = true;
for (const f of files) {
  try {
    vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: f });
    console.log('  loaded  ' + f);
  } catch (err) {
    ok = false;
    const first = String(err.stack || err).split('\n').slice(0, 3).join('\n     ');
    console.log('  FAILED  ' + f + '\n     ' + first);
    if (err instanceof ReferenceError) break;
  }
}
// Control characters in the source.
//
// A stray U+001E once sat inside a string literal for two days: the code ran,
// the tests passed, and the only symptom was that a patch anchor quietly
// stopped matching. They are invisible in every editor and in every diff, so
// nothing finds them by looking.
let dirty = 0;
for (const name of files.concat(['lemmatizer.js', 'server.js'])) {
  if (!fs.existsSync(name)) continue;
  const text = fs.readFileSync(name, 'utf8');
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 32 || code === 10 || code === 13 || code === 9) continue;
    const line = text.slice(0, i).split(String.fromCharCode(10)).length;
    console.error('  ' + name + ':' + line + '  U+'
      + code.toString(16).toUpperCase().padStart(4, '0') + '  in  '
      + JSON.stringify(text.slice(Math.max(0, i - 40), i + 20)));
    dirty++;
  }
}
if (dirty) {
  console.error(dirty + ' control character(s) in the source');
} else {
  console.log('no control characters in the source');
}

console.log(ok ? '\nall modules load with every identifier defined' : '\nsomething is undefined');
// Both checks decide the exit code. Setting process.exitCode above and then
// calling process.exit() here would throw the first one away.
process.exit(ok && !dirty ? 0 : 1);
