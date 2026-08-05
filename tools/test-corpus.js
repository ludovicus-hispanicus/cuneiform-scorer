// Exercise ebl-corpus.js outside a browser.
//
//   node tools/test-corpus.js [--live]
//
// The module is written for the browser: it wants `window`, `indexedDB` and a
// streaming fetch. Node 22 has fetch and TextDecoder, so the download and parse
// are real here; IndexedDB is replaced by the small in-memory stand-in below.
//
// What that does and does not prove: the stand-in follows the same request/
// event shape as the real thing, so it catches wrong store names, a missing
// await, a transaction that never completes — the logic. It cannot catch a
// storage quota refusing 37 MB, or how long a browser takes to structure-clone
// it. Those need a real tab.
//
// Without --live the download is stubbed, so the test runs offline.

'use strict';

const path = require('path');

// ---- minimal IndexedDB stand-in ----------------------------------------

function fakeIndexedDB() {
  const stores = new Map();

  function fire(target, handler, value) {
    // Real requests deliver their result asynchronously; doing it synchronously
    // would hide exactly the ordering bugs this is meant to catch.
    setTimeout(() => {
      target.result = value;
      if (target[handler]) target[handler]({ target });
    }, 0);
  }

  return {
    _stores: stores,
    open() {
      const request = {};
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: (name) => stores.has(name) },
          createObjectStore: (name) => stores.set(name, new Map()),
          transaction(names, mode) {
            const tx = {
              objectStore: (name) => {
                if (!stores.has(name)) throw new Error(`no such object store: ${name}`);
                const store = stores.get(name);
                return {
                  get(key) {
                    const req = {};
                    fire(req, 'onsuccess', store.get(key));
                    return req;
                  },
                  put(value, key) {
                    store.set(key, value);
                    setTimeout(() => tx.oncomplete && tx.oncomplete({}), 0);
                    return {};
                  },
                  clear() {
                    store.clear();
                    setTimeout(() => tx.oncomplete && tx.oncomplete({}), 0);
                    return {};
                  },
                };
              },
            };
            return tx;
          },
        };
        request.result = db;
        if (request.onupgradeneeded) request.onupgradeneeded({ target: request });
        if (request.onsuccess) request.onsuccess({ target: request });
      }, 0);
      return request;
    },
  };
}

// ---- load the module the way a page would ------------------------------

global.window = global;
global.indexedDB = fakeIndexedDB();
require(path.join(__dirname, '..', 'ebl-corpus.js'));

const EblCorpus = global.window.EblCorpus;

// ---- stub the network unless --live ------------------------------------

const LIVE = process.argv.includes('--live');
const SAMPLE = JSON.stringify(
  Array.from({ length: 5000 }, (_, i) => ({
    _id: `K.${i}`,
    // A multi-byte character on purpose: if chunk decoding is wrong, "š" is
    // where it breaks.
    signs: `ABZ480 ABZ1 ABZ52\nABZ129a ABZ537 š${i}`,
  }))
);

if (!LIVE) {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        const bytes = Buffer.from(SAMPLE, 'utf8');
        let offset = 0;
        return {
          async read() {
            if (offset >= bytes.length) return { done: true };
            // Deliberately awkward chunk size, to land mid-character.
            const end = Math.min(offset + 7777, bytes.length);
            const value = new Uint8Array(bytes.subarray(offset, end));
            offset = end;
            return { done: false, value };
          },
        };
      },
    },
  });
}

// ---- run ----------------------------------------------------------------

function check(label, condition, detail) {
  process.stdout.write(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}\n`);
  if (!condition) process.exitCode = 1;
}

async function main() {
  process.stdout.write(`ebl-corpus.js  (${LIVE ? 'live download from eBL' : 'stubbed download'})\n\n`);

  const before = await EblCorpus.status();
  check('status() on an empty cache reports not cached', before.cached === false);

  const phases = [];
  const t0 = Date.now();
  const first = await EblCorpus.load({ onProgress: (p) => phases.push(p.phase) });
  const downloadMs = Date.now() - t0;

  check('load() returns entries', Array.isArray(first.entries), `${first.entries.length.toLocaleString()} fragments`);
  check('_id was mapped to id', first.entries[0] && typeof first.entries[0].id === 'string', first.entries[0] && first.entries[0].id);
  check('signs came through', first.entries[0] && first.entries[0].signs.includes('ABZ480'));
  check('fromCache is false on a cold load', first.fromCache === false);
  check('retrieved was stamped', typeof first.retrieved === 'string', first.retrieved);
  check('progress reported download, parse and store',
    ['downloading', 'parsing', 'storing'].every((p) => phases.includes(p)), phases.join(' -> '));

  // Multi-byte integrity. The stub ends every entry with "š<n>" and splits
  // chunks mid-character on purpose, so a decoding fault shows up everywhere.
  // Live data needs a different probe: a replacement character anywhere means a
  // chunk boundary ate a byte, and the corpus is full of ×, Š and subscripts to
  // get wrong.
  if (LIVE) {
    const replaced = first.entries.filter((e) => e.signs.includes('�')).length;
    check('no replacement characters in the decoded corpus', replaced === 0, `${replaced} entries affected`);
    const multibyte = first.entries.filter((e) => /[^\x00-\x7F]/.test(e.signs));
    check('multi-byte sign names survived', multibyte.length > 0,
      `${multibyte.length.toLocaleString()} entries, e.g. ${
        (multibyte[0].signs.match(/\S*[^\x00-\x7F]\S*/) || [''])[0]}`);
  } else {
    const mangled = first.entries.filter((e) => !/š\d+$/.test(e.signs)).length;
    check('chunked decoding preserved multi-byte characters', mangled === 0, `${mangled} mangled`);
  }

  const after = await EblCorpus.status();
  check('status() now reports cached', after.cached === true, `${after.count} fragments, ${(after.bytes / 1e6).toFixed(1)} MB`);

  const t1 = Date.now();
  const second = await EblCorpus.load();
  check('second load() came from cache', second.fromCache === true, `${Date.now() - t1} ms vs ${downloadMs} ms cold`);
  check('cached load returns the same count', second.entries.length === first.entries.length);
  check('cached load kept the retrieved date', second.retrieved === first.retrieved);

  await EblCorpus.clear();
  const cleared = await EblCorpus.status();
  check('clear() empties the cache', cleared.cached === false);
}

main().catch((err) => {
  process.stderr.write(`\nthrew: ${err.stack || err.message}\n`);
  process.exit(1);
});
