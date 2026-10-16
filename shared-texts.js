// Shared texts: one transliteration of a tablet, used by several projects.
//
// A tablet file in a project mixes two kinds of thing. The transliteration is
// the tablet's — surfaces, line numbers, signs — and is the same whichever
// chapter quotes it. The "§12 " or "§12b " at the head of a line is the
// project's — which of its sections that line witnesses. When the same tablet
// sits in two projects, the first kind drifts apart unless it is kept in one
// place; the second must stay apart.
//
// So a shared text is a project file with its § markers taken off, kept in a
// folder every project can reach (the server reads and writes it in place —
// the browser's own file API replaces files, which Drive turns into a
// delete-and-create and can strand when the file belongs to another account).
// A project keeps its own full file, markers and all, and a copy of the shared
// text as it last agreed with it (the base). Saving pushes the project's
// transliteration to the shared copy; a change in the shared copy is pulled
// into the project, each line keeping its markers. When both sides changed
// since the base, the two are merged line by line, and only a line both sides
// changed differently is put to the editor.
//
// Lines are matched by identity, not position: a numbered line by its surface
// and number ("reverse|10"), a ruling by the numbered line it follows. That is
// what lets a marker find its line again after lines were added above it.
//
// Pure functions here, plus a thin client for the server; loads in the browser
// (window.SharedTexts) and in Node (require), so the merge can be tested on
// real project files without a browser.
(function (root) {
  'use strict';

  const SECTION_PREFIX = /^(\s*)(§\d+[a-z]?)\s+(.*)$/;
  const SURFACE = /^\s*@(\S+)/;
  const NUMBERED = /^(\S+?)\.(?:\s(.*))?$/;

  const eolOf = (text) => (/\r\n/.test(text) ? '\r\n' : '\n');
  const splitLines = (text) => String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');

  // One line of a project or shared file, with what identifies it.
  //   prefix: "§12b" or ''    body: the line without the prefix and its space
  //   key:    identity used to match the same line in another copy
  function parse(text) {
    const out = [];
    let surface = '';
    let lastNumbered = '^';
    const seen = new Map();
    const dirAfter = new Map();
    for (const raw of splitLines(text)) {
      const m = raw.match(SECTION_PREFIX);
      const prefix = m ? m[2] : '';
      const body = m ? m[1] + m[3] : raw;
      const trimmed = body.trim();
      let kind = 'other';
      let key;
      const s = trimmed.match(SURFACE);
      if (s) {
        kind = 'surface';
        surface = s[1].toLowerCase().replace(/\?$/, '');
        key = 'surface:' + trimmed;
      } else if (trimmed.startsWith('$')) {
        kind = 'directive';
        const n = (dirAfter.get(lastNumbered) || 0) + 1;
        dirAfter.set(lastNumbered, n);
        key = 'dir:' + lastNumbered + '#' + n;
      } else {
        const nm = trimmed.match(NUMBERED);
        if (nm && /\d/.test(nm[1]) && !trimmed.startsWith('//') && !trimmed.startsWith('#')) {
          kind = 'line';
          const num = nm[1].replace(/[’']/g, "'");
          const base = surface + '|' + num;
          const k = (seen.get(base) || 0) + 1;
          seen.set(base, k);
          key = 'line:' + base + (k > 1 ? '#' + k : '');
          lastNumbered = key;
          out.push({ raw, prefix, body, kind, key, num: nm[1], text: nm[2] || '' });
          continue;
        }
        key = 'other:' + trimmed;
        const k = (seen.get(key) || 0) + 1;
        seen.set(key, k);
        if (k > 1) key += '#' + k;
      }
      out.push({ raw, prefix, body, kind, key });
    }
    return out;
  }

  // The project file without its § markers: what the shared copy holds.
  function strip(projectText) {
    return parse(projectText).map((l) => l.body).join('\n');
  }

  // Normalised for comparison: line endings and trailing spaces do not count.
  function normalise(text) {
    return splitLines(text).map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
  }
  const same = (a, b) => normalise(a) === normalise(b);

  // Put a project's § markers back onto a shared text: each line of the shared
  // text takes the marker its counterpart carries in the project. A line the
  // project does not have comes in unassigned, for the editor to place.
  function reattach(projectText, sharedText) {
    const markers = new Map();
    for (const l of parse(projectText)) if (l.prefix) markers.set(l.key, l.prefix);
    const eol = eolOf(projectText);
    const lines = parse(sharedText).map((l) => {
      const p = markers.get(l.key);
      if (!p) return l.body;
      const ind = (l.body.match(/^\s*/) || [''])[0];
      return ind + p + ' ' + l.body.slice(ind.length);
    });
    return lines.join(eol);
  }

  // Three-way merge of transliterations, line by line.
  // Returns { text, conflicts: [{ key, base, mine, theirs }], changed: [{ key, before, after }] }
  // where `changed` lists the lines whose text differs from `mine` in the result
  // (what a project must re-align). A line both sides changed differently goes
  // the way `resolve(conflict)` says — 'mine' or 'theirs' — and theirs when no
  // resolver is given (callers that have not asked yet must not use `text`).
  function merge3(baseText, mineText, theirsText, resolve) {
    const index = (t) => { const m = new Map(); for (const l of parse(t)) m.set(l.key, l); return m; };
    const B = index(baseText), M = index(mineText), T = index(theirsText);
    const body = (map, k) => (map.has(k) ? map.get(k).body.replace(/\s+$/, '') : null);
    const conflicts = [];
    const pick = new Map();   // key -> body or null (deleted)
    const keys = new Set([...B.keys(), ...M.keys(), ...T.keys()]);
    for (const k of keys) {
      const b = body(B, k), m = body(M, k), t = body(T, k);
      if (m === t) { pick.set(k, m); continue; }
      if (m === b) { pick.set(k, t); continue; }   // only theirs changed
      if (t === b) { pick.set(k, m); continue; }   // only mine changed
      const c = { key: k, base: b, mine: m, theirs: t };
      conflicts.push(c);
      pick.set(k, resolve && resolve(c) === 'mine' ? m : t);
    }
    // Order: theirs as the backbone, with lines only mine has added slotted in
    // after the line that precedes them in mine.
    const order = [];
    const placed = new Set();
    const theirsKeys = [...T.keys()];
    const mineKeys = [...M.keys()];
    const afterMine = new Map();
    let prev = '^';
    for (const k of mineKeys) {
      if (!T.has(k) && pick.get(k) != null) {
        if (!afterMine.has(prev)) afterMine.set(prev, []);
        afterMine.get(prev).push(k);
      } else prev = k;
    }
    const emit = (k) => {
      if (placed.has(k)) return;
      placed.add(k);
      if (pick.get(k) != null) order.push(k);
      for (const extra of afterMine.get(k) || []) emit(extra);
    };
    for (const extra of afterMine.get('^') || []) emit(extra);
    for (const k of theirsKeys) emit(k);
    for (const k of mineKeys) emit(k);
    const text = order.map((k) => pick.get(k)).join('\n');
    const changed = [];
    for (const k of keys) {
      const before = body(M, k), after = pick.get(k) == null ? null : pick.get(k);
      if (before !== after) changed.push({ key: k, before, after });
    }
    return { text, conflicts, changed };
  }

  // Line-level differences between two copies, for showing an editor.
  function differences(aText, bText) {
    const r = merge3(aText, aText, bText);
    return r.changed.map((c) => ({ key: c.key, a: c.before, b: c.after }));
  }

  // The lines of a project that carry a § marker and whose text changes, with
  // what an alignment row needs: the sections it witnesses and its line number.
  function witnessChanges(projectText, changed) {
    const byKey = new Map(parse(projectText).filter((l) => l.kind === 'line').map((l) => [l.key, l]));
    const out = [];
    for (const c of changed) {
      const l = byKey.get(c.key);
      if (!l || !l.prefix || c.before == null || c.after == null) continue;
      const strip = (b) => { const m = String(b).trim().match(NUMBERED); return m ? (m[2] || '') : ''; };
      out.push({ section: l.prefix.replace(/^§(\d+).*$/, '$1'), letter: l.prefix.replace(/^§\d+/, ''),
        sourceLine: l.num, before: strip(c.before), after: strip(c.after) });
    }
    return out;
  }

  // ---- the shared folder: two routes, one interface ----
  //
  // With the app's own server (npm start) the folder is a path on this
  // computer and the server reads and writes it in place. The web version has
  // no server, so there the folder is picked once in the browser, remembered
  // like a project folder, and read and written through it. Which route is
  // taken is found out once, by asking the server.
  async function call(method, url, body) {
    const res = await fetch(url, {
      method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(json.error || ('HTTP ' + res.status)); e.status = res.status; throw e; }
    return json;
  }

  let routeP = null;
  function route() {
    if (!routeP) {
      routeP = fetch('/api/shared/config')
        .then((r) => (r.ok ? r.json().then((j) => (j && 'path' in j ? 'server' : 'browser')) : 'browser'))
        .catch(() => 'browser');
    }
    return routeP;
  }

  const validName = (n) => /^[^\\/:*?"<>|\r\n]+$/.test(String(n || '')) && !String(n).includes('..');
  const fsApi = () => (typeof window !== 'undefined' && window.FileSystem) || null;
  async function folderHandle() {
    const F = fsApi();
    return F && F.getSharedFolder ? F.getSharedFolder() : null;
  }
  async function permission(handle) {
    try { return await handle.queryPermission({ mode: 'readwrite' }); } catch (_) { return 'denied'; }
  }
  async function readyHandle() {
    const h = await folderHandle();
    if (!h) { const e = new Error('no shared texts folder chosen in this browser'); e.status = 409; throw e; }
    if ((await permission(h)) !== 'granted') {
      const e = new Error('the browser needs permission again for the shared texts folder'); e.status = 401; e.needsPermission = true; throw e;
    }
    return h;
  }

  const client = {
    route,
    // { path, route, needsPermission }: path is the folder's path (server) or name (browser)
    config: async () => {
      if ((await route()) === 'server') return { ...(await call('GET', '/api/shared/config')), route: 'server' };
      const h = await folderHandle();
      if (!h) return { path: null, route: 'browser' };
      return { path: h.name, route: 'browser', needsPermission: (await permission(h)) !== 'granted' };
    },
    // Server route: the folder's path.
    setFolder: (folder) => call('POST', '/api/shared/config', { path: folder }),
    // Browser route: pick the folder (needs a click). Returns { path }.
    chooseFolder: async () => {
      const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'shared-texts' });
      await fsApi().saveSharedFolder(h);
      return { path: h.name };
    },
    // Browser route: ask again for permission the browser has dropped (needs a click).
    reconnect: async () => {
      const h = await folderHandle();
      if (!h) return false;
      return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
    },
    // kind: 'text' (a tablet, NAME.txt) or 'omen' (a linked omen, omens/NAME.json)
    list: async (kind) => {
      if ((await route()) === 'server') return call('GET', '/api/shared/list' + (kind === 'omen' ? '?kind=omen' : ''));
      const h = await readyHandle();
      const { dir, ext } = await place(h, kind, false);
      const files = [];
      if (dir) {
        for await (const entry of dir.values()) {
          if (entry.kind !== 'file' || !entry.name.endsWith(ext)) continue;
          const f = await entry.getFile();
          files.push({ name: entry.name.slice(0, -ext.length), mtimeMs: f.lastModified, size: f.size });
        }
      }
      return { path: h.name, files };
    },
    read: async (name, kind) => {
      if ((await route()) === 'server') {
        try { return await call('GET', '/api/shared/file?name=' + encodeURIComponent(name) + (kind === 'omen' ? '&kind=omen' : '')); }
        catch (e) { if (e.status === 404) return null; throw e; }
      }
      if (!validName(name)) throw new Error('bad name');
      const h = await readyHandle();
      const { dir, ext } = await place(h, kind, false);
      if (!dir) return null;
      try {
        const f = await (await dir.getFileHandle(name + ext)).getFile();
        return { name, content: await f.text(), mtimeMs: f.lastModified };
      } catch (e) {
        if (e && e.name === 'NotFoundError') return null;
        throw e;
      }
    },
    write: async (name, content, kind) => {
      if ((await route()) === 'server') return call('POST', '/api/shared/file', { name, content, kind: kind === 'omen' ? 'omen' : 'text' });
      if (!validName(name)) throw new Error('bad name');
      const h = await readyHandle();
      const { dir, ext } = await place(h, kind, true);
      const fh = await dir.getFileHandle(name + ext, { create: true });
      const w = await fh.createWritable();
      await w.write(content);
      await w.close();
      return { name, mtimeMs: (await fh.getFile()).lastModified };
    },
  };
  // Browser route: the folder a kind lives in (omens/ is made on first write).
  async function place(h, kind, create) {
    if (kind !== 'omen') return { dir: h, ext: '.txt' };
    try { return { dir: await h.getDirectoryHandle('omens', { create }), ext: '.json' }; }
    catch (e) { if (e && e.name === 'NotFoundError') return { dir: null, ext: '.json' }; throw e; }
  }

  // ---- linked omens ----
  //
  // An omen two chapters share can be linked: its reconstruction, translation
  // and variants live once, as a small JSON record in the shared folder, and
  // each linked project keeps them in step. Section numbers, notes, parallels,
  // which witness lines belong to which variant, alignments and lemmas stay
  // each project's own.
  //   { id, reconstruction, translation, variants: [{ text, note? }] }
  // Merging is by part: a part changed on one side only is taken; a part both
  // sides changed differently is put to the editor.
  const OMEN_PARTS = ['reconstruction', 'translation', 'variants'];
  // An edit box hands back a non-breaking space for a typed one; it is not a
  // difference between two editions, so a record never carries one.
  const plain = (t) => String(t || '').replace(/ /g, ' ');
  const omenText = (t) => normalise(plain(t));
  const variantKey = (vs) => JSON.stringify((vs || []).map((v) => [omenText(v.text), plain(v.note)]));
  const partKey = (rec, part) => (rec == null ? null
    : part === 'variants' ? variantKey(rec.variants) : omenText(rec[part]));
  function omenRecord(id, recon, tr, variants) {
    return {
      id,
      reconstruction: plain(recon),
      translation: plain(tr),
      variants: (variants || []).map((v) => (v.note ? { text: plain(v.text), note: plain(v.note) } : { text: plain(v.text) })),
    };
  }
  function sameOmen(a, b) { return OMEN_PARTS.every((p) => partKey(a, p) === partKey(b, p)); }
  // { merged, conflicts: [{ part, mine, theirs }] } — merged takes theirs for a
  // conflict unless resolve(conflict) says 'mine'.
  function mergeOmen(base, mine, theirs, resolve) {
    const merged = { id: (theirs && theirs.id) || (mine && mine.id) };
    const conflicts = [];
    for (const p of OMEN_PARTS) {
      const b = partKey(base, p), m = partKey(mine, p), t = partKey(theirs, p);
      let take;
      if (m === t || t === b) take = mine;
      else if (m === b) take = theirs;
      else {
        const c = { part: p, mine: mine[p], theirs: theirs[p] };
        conflicts.push(c);
        take = resolve && resolve(c) === 'mine' ? mine : theirs;
      }
      merged[p] = p === 'variants' ? JSON.parse(JSON.stringify(take.variants || [])) : (take[p] || '');
    }
    return { merged, conflicts };
  }

  const api = { parse, strip, reattach, merge3, differences, witnessChanges, normalise, same, client,
    omenRecord, sameOmen, mergeOmen, OMEN_PARTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SharedTexts = api;
})(typeof window !== 'undefined' ? window : null);
