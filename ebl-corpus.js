// ===========================================
// Local eBL corpus cache
// ===========================================
// Holds eBL's sign corpus in IndexedDB so a matching run costs no requests.
// GET /fragments/all-signs returns { _id, signs } for every fragment — roughly
// 37,000 records, 6 MB over the wire compressed — in a single public request.
// Downloaded once, a sweep can then be re-run and re-tuned entirely offline.
//
// What it does NOT hold: the dump carries sign codes only. No ATF, no brackets,
// no line numbers, no genre or museum metadata, no join records. So the corpus
// answers "which fragments share material" and nothing else — the question of
// whether a hit *preserves* what we restore needs the ATF, which is why that is
// cached here too, per fragment, for the handful a sweep actually surfaces.
//
// The corpus is a snapshot. Fragments are transliterated and revised
// continuously, so a stale copy silently misses recent work; `retrieved` is
// kept alongside it and refresh() is the answer.

(function () {
  'use strict';

  const DB_NAME = 'ebl-cache';
  const DB_VERSION = 1;
  const STORE_META = 'meta';
  const STORE_BLOBS = 'blobs';
  const STORE_ATF = 'atf';

  const CORPUS_KEY = 'fragments/all-signs';
  const CORPUS_PATH = '/fragments/all-signs';

  function apiUrl() {
    return (window.EblClient && window.EblClient.getApiUrl)
      ? window.EblClient.getApiUrl()
      : 'https://www.ebl.lmu.de/api';
  }

  // ---- IndexedDB plumbing ----

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
        // The corpus is stored as one JSON string rather than 37,000 records:
        // a single put is near-instant where 37,000 would take seconds and
        // leave a half-written cache if interrupted.
        if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
        if (!db.objectStoreNames.contains(STORE_ATF)) db.createObjectStore(STORE_ATF);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbGet(store, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(store, key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDelete(store, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbClear(store) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---- Download ----

  // Streamed so a 6 MB download can report progress. Content-Length is the
  // compressed size while the reader yields decompressed bytes, so the two do
  // not divide into a percentage — the callback reports bytes, and the caller
  // decides how to phrase it.
  async function fetchCorpusText(onProgress) {
    const res = await fetch(`${apiUrl()}${CORPUS_PATH}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`eBL returned ${res.status} for ${CORPUS_PATH}`);
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      return res.text();
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let bytes = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      parts.push(decoder.decode(value, { stream: true }));
      if (onProgress) onProgress({ bytes });
    }
    parts.push(decoder.decode());
    return parts.join('');
  }

  // ---- Public API ----

  async function status() {
    const meta = await idbGet(STORE_META, CORPUS_KEY);
    return meta
      ? { cached: true, retrieved: meta.retrieved, count: meta.count, bytes: meta.bytes }
      : { cached: false };
  }

  // Resolves to { entries, retrieved, count, fromCache }. `entries` is the raw
  // array of { id, signs } that EblNgram.rank consumes.
  async function load({ onProgress, forceRefresh = false } = {}) {
    if (!forceRefresh) {
      const cached = await idbGet(STORE_BLOBS, CORPUS_KEY);
      if (cached) {
        const meta = await idbGet(STORE_META, CORPUS_KEY);
        if (onProgress) onProgress({ phase: 'parsing' });
        return {
          entries: parseCorpus(cached),
          retrieved: meta ? meta.retrieved : null,
          count: meta ? meta.count : null,
          fromCache: true,
        };
      }
    }

    if (onProgress) onProgress({ phase: 'downloading', bytes: 0 });
    const text = await fetchCorpusText((p) => {
      if (onProgress) onProgress({ phase: 'downloading', bytes: p.bytes });
    });

    if (onProgress) onProgress({ phase: 'parsing' });
    const entries = parseCorpus(text);
    const retrieved = new Date().toISOString();

    if (onProgress) onProgress({ phase: 'storing' });
    await idbPut(STORE_BLOBS, CORPUS_KEY, text);
    await idbPut(STORE_META, CORPUS_KEY, {
      retrieved,
      count: entries.length,
      bytes: text.length,
    });

    return { entries, retrieved, count: entries.length, fromCache: false };
  }

  function parseCorpus(text) {
    const raw = JSON.parse(text);
    // eBL's key is `_id`; the matcher wants `id`. Done once here so callers
    // never have to know about the difference.
    return raw.map((r) => ({ id: r._id, signs: r.signs || '' }));
  }

  function refresh(opts) {
    return load({ ...opts, forceRefresh: true });
  }

  // ---- Per-fragment ATF ----

  // The sign stream cannot say whether a matched run is preserved or restored —
  // brackets live in the ATF. Candidates are few, so these are fetched on
  // demand and kept.
  async function getAtf(museumNumber, { forceRefresh = false } = {}) {
    if (!forceRefresh) {
      const hit = await idbGet(STORE_ATF, museumNumber);
      // Records cached before references/metadata were kept are refetched
      // once; the field's presence is the version marker.
      if (hit && hit.references !== undefined) return { ...hit, fromCache: true };
    }
    const res = await fetch(`${apiUrl()}/fragments/${encodeURIComponent(museumNumber)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`eBL returned ${res.status} for fragment ${museumNumber}`);
    }
    const frag = await res.json();
    const record = {
      museumNumber,
      atf: frag.atf || '',
      signs: frag.signs || '',
      description: frag.description || '',
      genres: frag.genres || [],
      script: frag.script || null,
      joins: frag.joins || [],
      museum: frag.museum || '',
      collection: frag.collection || '',
      accession: frag.accession || null,
      length: frag.length || null,
      width: frag.width || null,
      thickness: frag.thickness || null,
      archaeology: frag.archaeology || null,
      notes: (frag.notes && frag.notes.text) || '',
      references: frag.references || [],
      fetched: new Date().toISOString(),
    };
    await idbPut(STORE_ATF, museumNumber, record);
    return { ...record, fromCache: false };
  }

  async function clear() {
    await idbClear(STORE_BLOBS);
    await idbClear(STORE_META);
    await idbClear(STORE_ATF);
  }

  // A generic per-key stash on the same database, for state that should
  // survive a reload — sweep results and the like. Values go through
  // structured clone, so Sets and Maps are fine.
  async function stash(key, value) {
    if (value === undefined) return idbDelete(STORE_META, 'stash:' + key);
    return idbPut(STORE_META, 'stash:' + key, value);
  }

  async function unstash(key) {
    return idbGet(STORE_META, 'stash:' + key);
  }

  window.EblCorpus = {
    status,
    load,
    refresh,
    getAtf,
    clear,
    stash,
    unstash,
  };
})();
