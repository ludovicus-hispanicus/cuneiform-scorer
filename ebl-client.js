// ===========================================
// eBL (Electronic Babylonian Library) API CLIENT
// ===========================================
// Talks to https://www.ebl.lmu.de/api directly from the browser.
// Auth: paste a Bearer JWT obtained from a logged-in eBL session.
// Writes require the "write:texts" scope.

(function () {
  const DEFAULT_API_URL = 'https://www.ebl.lmu.de/api';
  const TOKEN_KEY = 'ebl.accessToken';
  const API_URL_KEY = 'ebl.apiUrl';

  // ---- Controlled vocabularies (from ebl-api ebl/common/domain/*) ----
  // [longName, abbreviation]
  const PERIODS = [
    ['None', ''],
    ['Uncertain', 'Unc'],
    ['Uruk IV', 'Uruk4'],
    ['Uruk III-Jemdet Nasr', 'JN'],
    ['ED I-II', 'ED1_2'],
    ['Fara', 'Fara'],
    ['Presargonic', 'PSarg'],
    ['Sargonic', 'Sarg'],
    ['Lagash II', 'Lag2'],
    ['Ur III', 'Ur3'],
    ['Old Assyrian', 'OA'],
    ['Old Babylonian', 'OB'],
    ['Middle Babylonian', 'MB'],
    ['Middle Assyrian', 'MA'],
    ['Hittite', 'Hit'],
    ['Neo-Assyrian', 'NA'],
    ['Neo-Babylonian', 'NB'],
    ['Late Babylonian', 'LB'],
    ['Persian', 'Per'],
    ['Hellenistic', 'Hel'],
    ['Parthian', 'Par'],
    ['Proto-Elamite', 'PElam'],
    ['Old Elamite', 'OElam'],
    ['Middle Elamite', 'MElam'],
    ['Neo-Elamite', 'NElam'],
    ['Luwian', 'Luw'],
    ['Aramaic', 'Aram'],
  ];

  const MANUSCRIPT_TYPES = [
    ['Library', ''],
    ['School', 'Sch'],
    ['Varia', 'Var'],
    ['Amulet', 'Amu'],
    ['Commentary', 'Com'],
    ['Quotation', 'Quo'],
    ['Excerpt', 'Ex'],
    ['Parallel', 'Par'],
    ['None', ''],
  ];

  const PERIOD_MODIFIERS = ['None', 'Early', 'Middle', 'Late'];

  // Fallback provenance list. Replaced at runtime by GET /provenances when reachable.
  const FALLBACK_PROVENANCES = [
    ['Standard Text', 'Std'],
    ['Nineveh', 'Nin'],
    ['Babylon', 'Bab'],
    ['Borsippa', 'Bor'],
    ['Sippar', 'Sip'],
    ['Nippur', 'Nip'],
    ['Uruk', 'Urk'],
    ['Aššur', 'Ašš'],
    ['Kalḫu', 'Kal'],
    ['Ur', 'Ur'],
    ['Larsa', 'Lar'],
    ['Kiš', 'Kiš'],
    ['Dilbat', 'Dil'],
    ['Cutha', 'Cut'],
    ['Susa', 'Sus'],
    ['Uncertain', 'Unc'],
  ];

  // ---- Token storage + decode ----
  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(jwt) {
    if (!jwt) {
      localStorage.removeItem(TOKEN_KEY);
      return;
    }
    // If the user pasted a wrapped OAuth response, pluck the JWT out.
    const m = String(jwt).match(/(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
    localStorage.setItem(TOKEN_KEY, m ? m[1] : String(jwt).trim());
  }

  function getApiUrl() {
    return localStorage.getItem(API_URL_KEY) || DEFAULT_API_URL;
  }

  function setApiUrl(url) {
    if (url && url.trim()) {
      localStorage.setItem(API_URL_KEY, url.trim().replace(/\/$/, ''));
    } else {
      localStorage.removeItem(API_URL_KEY);
    }
  }

  function decodeToken(jwt) {
    if (!jwt) return null;
    try {
      const payload = jwt.split('.')[1];
      const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(
        atob(b64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      return JSON.parse(json);
    } catch (e) {
      return { error: 'Invalid JWT format' };
    }
  }

  function tokenStatus() {
    const jwt = getToken();
    if (!jwt) return { hasToken: false };
    const payload = decodeToken(jwt);
    if (!payload || payload.error) return { hasToken: true, invalid: true };

    const scopesRaw = payload.scope || payload.scopes || '';
    const scopes = Array.isArray(scopesRaw) ? scopesRaw : String(scopesRaw).split(/\s+/).filter(Boolean);
    const permissions = payload.permissions || [];
    const allScopes = [...new Set([...scopes, ...permissions])];

    const nowSec = Math.floor(Date.now() / 1000);
    const expired = payload.exp ? payload.exp < nowSec : false;
    const expiresInSec = payload.exp ? payload.exp - nowSec : null;

    return {
      hasToken: true,
      invalid: false,
      expired,
      expiresInSec,
      exp: payload.exp,
      sub: payload.sub,
      scopes: allScopes,
      hasWriteTexts: allScopes.includes('write:texts'),
      hasReadTexts: allScopes.includes('read:texts'),
    };
  }

  // ---- HTTP helpers ----
  async function publicGet(path) {
    const res = await fetch(`${getApiUrl()}${path}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new EblError(`GET ${path} failed`, res.status, body);
    }
    return res.json();
  }

  // How long to wait for eBL before calling it. Generous, because a
  // whole-chapter write is minutes of honest work, but finite.
  const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

  async function authedRequest(method, path, body) {
    const jwt = getToken();
    if (!jwt) throw new EblError('No eBL token configured', 0, '');

    // A refusal and a request that never arrived are different facts, and only
    // one of them is eBL's. fetch rejects for a dropped connection, a blocked
    // preflight, a machine that is offline — none of which eBL ever saw, and
    // none of which say anything about the ATF. Reported as a refusal, they
    // sent editors hunting for a fault in the line instead of in the network.
    //
    // Worse, a write whose reply is lost is not a write that did not happen:
    // eBL may have taken it. So this is marked `transport`, and what is not
    // known about it is not asserted.
    // Waiting is bounded. A whole-chapter alignment or lemmatization is a big
    // write and legitimately slow, but fetch has no timeout of its own: a
    // request eBL never answers hangs until the tab is closed, which is how an
    // export came to sit on "sending the lemmas…" all night with no way to
    // tell it apart from work still in progress.
    let signal;
    try {
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      }
    } catch (_) { signal = undefined; }

    let res;
    try {
      res = await fetch(`${getApiUrl()}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      // Giving up waiting is not the same as never arriving, and the
      // difference matters: a request that timed out was received, and eBL
      // may well have acted on it.
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      const e = new EblError(
        timedOut
          ? 'eBL did not answer within ' + Math.round(REQUEST_TIMEOUT_MS / 60000)
            + ' minutes. The request was sent; whether it was applied is not known from here.'
          : 'The request never reached eBL: ' + (err && err.message ? err.message : String(err)),
        0, '', null);
      e.transport = true;
      e.timedOut = !!timedOut;
      e.method = method;
      e.path = path;
      throw e;
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }

    if (!res.ok) {
      throw new EblError(
        `${method} ${path} → ${res.status}`,
        res.status,
        text,
        json
      );
    }
    return json;
  }

  class EblError extends Error {
    constructor(message, status, rawBody, parsedBody) {
      super(message);
      this.name = 'EblError';
      this.status = status;
      this.rawBody = rawBody;
      this.body = parsedBody;
      // Set only when the request never completed, so a caller can tell a
      // refusal (which has a status and a body) from silence.
      this.transport = false;
    }

    // eBL returns 422 with { description, errors: [{ lineNumber, description }] }
    // for ATF validation failures. Normalize into [{ line, column, message }].
    get validationErrors() {
      if (!this.body || !Array.isArray(this.body.errors)) return null;
      return this.body.errors.map((e) => ({
        line: e.lineNumber ?? e.line ?? null,
        column: e.column ?? null,
        message: e.description || e.message || '(no message)',
      }));
    }
  }

  // ---- Provenance cache ----
  let _provenanceCache = null;
  async function getProvenances({ forceRefresh = false } = {}) {
    if (_provenanceCache && !forceRefresh) return _provenanceCache;
    try {
      // eBL exposes provenances via /provenances (public).
      const data = await publicGet('/provenances');
      // Endpoint returns an array of { id, long_name|longName, abbreviation }.
      _provenanceCache = data
        .map((p) => [p.long_name || p.longName || p.id, p.abbreviation || ''])
        .filter(([n]) => n);
      if (_provenanceCache.length === 0) _provenanceCache = FALLBACK_PROVENANCES.slice();
    } catch (_) {
      _provenanceCache = FALLBACK_PROVENANCES.slice();
    }
    return _provenanceCache;
  }

  // ---- Vocabulary lookups ----
  function abbrevOf(table, longName) {
    const row = table.find(([n]) => n === longName);
    return row ? row[1] : '';
  }

  async function provenanceAbbrev(longName) {
    const provs = await getProvenances();
    return abbrevOf(provs, longName);
  }

  // Construct the siglum eBL will assign: provenanceAbbr + periodAbbr + typeAbbr + disambiguator
  async function buildSiglumPreview(manuscript) {
    if (!manuscript) return '';
    const provAbbr = await provenanceAbbrev(manuscript.provenance);
    const periodAbbr = abbrevOf(PERIODS, manuscript.period);
    const typeAbbr = abbrevOf(MANUSCRIPT_TYPES, manuscript.type);
    return `${provAbbr}${periodAbbr}${typeAbbr}${manuscript.siglumDisambiguator || ''}`;
  }

  // ---- Corpus endpoints ----
  function chapterPath(coords) {
    const { genre, category, index, stage, name } = coords;
    return `/texts/${encodeURIComponent(genre)}/${encodeURIComponent(category)}/${encodeURIComponent(index)}/chapters/${encodeURIComponent(stage)}/${encodeURIComponent(name)}`;
  }

  async function getChapter(coords) {
    return publicGet(chapterPath(coords));
  }

  async function postManuscripts(coords, manuscripts, uncertainFragments) {
    return authedRequest('POST', `${chapterPath(coords)}/manuscripts`, {
      manuscripts,
      uncertainFragments: uncertainFragments || [],
    });
  }

  // POST /import APPENDS — eBL's own import UI says so ("The imported lines are
  // added to the end of the chapter. Existing lines will not change."), and
  // LinesUpdater builds `lines = (*existing, *imported)`. Emptying the chapter
  // first is what turns this into a replace; see deleteAllLines.
  async function postImport(coords, atfText) {
    return authedRequest('POST', `${chapterPath(coords)}/import`, { atf: atfText });
  }

  // The structured lines endpoint. `deleted` holds 0-based positions in the
  // chapter's current line list.
  async function postLines(coords, { newLines = [], deleted = [], edited = [] } = {}) {
    return authedRequest('POST', `${chapterPath(coords)}/lines`, {
      new: newLines,
      deleted,
      edited,
    });
  }

  // Token alignment: which word of a witness answers to which word of the
  // reconstruction, and what it reads if it reads something else. This is what
  // drives eBL's hover, and POST /lines cannot carry it — that sends plain ATF,
  // so eBL re-parses and keeps alignment only where a token happens to pair.
  //
  // The payload is the WHOLE chapter, nested line -> variant -> manuscript, so
  // it replaces every line's alignment. Anything not being changed has to be
  // sent back as it stands.
  async function postAlignment(coords, alignment) {
    return authedRequest('POST', `${chapterPath(coords)}/alignment`, { alignment });
  }

  // Lemmas for a whole chapter, shaped exactly as eBL's own editor sends them:
  //   { lemmatization: [ perLine [ perVariant
  //       { reconstruction: [token], manuscripts: [ [token] ] } ] ] }
  // where a token is { value } or { value, uniqueLemma: [id] }.
  //
  // Like alignment, this replaces the whole chapter, so every line has to be
  // sent — including the ones carrying no lemma at all.
  async function postLemmatization(coords, lemmatization) {
    return authedRequest('POST', `${chapterPath(coords)}/lemmatization`, { lemmatization });
  }

  // Empty a chapter so a following import replaces rather than appends.
  // Lemmatization and alignment on the removed lines do not survive this: eBL
  // carries those across only when old and new lines are paired inside one
  // update, and after the delete there is nothing left to pair against. eBL
  // does record the deletion in the chapter's changelog.
  async function deleteAllLines(coords, lineCount) {
    if (!lineCount) return 0;
    await postLines(coords, {
      deleted: Array.from({ length: lineCount }, (_, i) => i),
    });
    return lineCount;
  }

  // ---- Fragmentarium ----
  async function getFragment(museumNumber) {
    return publicGet(`/fragments/${encodeURIComponent(museumNumber)}`);
  }

  // Convert a Fragmentarium record into the subset of fields we can populate
  // on a chapter-manuscript entry. `type` is intentionally NOT set — the
  // Library/School/Commentary designation is chapter-context, not fragment-context.
  function fragmentToManuscriptFields(fragment) {
    const out = {};
    if (fragment.museumNumber) {
      const { prefix = '', number = '', suffix = '' } = fragment.museumNumber;
      out.museumNumber = suffix ? `${prefix}.${number}.${suffix}` : `${prefix}.${number}`;
    }
    if (fragment.script && fragment.script.period) out.period = fragment.script.period;
    if (fragment.script && fragment.script.periodModifier) out.periodModifier = fragment.script.periodModifier;
    if (fragment.archaeology && fragment.archaeology.site) out.provenance = fragment.archaeology.site;
    return out;
  }

  // ---- Manuscripts.json helpers ----

  // Extract the primary museum number from a filename. Handles join notation
  // like "K.14874 (+) BM.41031 (+) BM.41691.txt" — returns only the first.
  // The remaining numbers in the join are returned separately so the caller
  // can record them as oldSigla / notes if desired.
  function extractMuseumNumber(filename) {
    const base = filename.replace(/\.txt$/, '');
    // Split on (+), +, or "join" markers (case-insensitive)
    const parts = base.split(/\s*\(\s*\+\s*\)\s*|\s+\+\s+/).map((s) => s.trim()).filter(Boolean);
    return { primary: parts[0] || base, joins: parts.slice(1) };
  }

  // Build a default manuscript metadata entry from a filename. The primary
  // museum number is the first segment before any "(+)" join marker.
  function defaultManuscriptEntry(filename, id) {
    const { primary, joins } = extractMuseumNumber(filename);
    return {
      file: filename,
      id: id,
      // Left empty on purpose. The disambiguator numbers a tablet within its
      // provenance–period–type group, and the group is not known yet — the id
      // counts every manuscript, which made the tenth excerpt NinNAEx37.
      // Settings fills it in the moment the group is chosen.
      siglumDisambiguator: '',
      museumNumber: primary,
      accession: '',
      provenance: '',
      period: '',
      periodModifier: 'None',
      type: '',
      notes: joins.length ? `Joins: ${joins.join(' + ')}` : '',
      colophon: '',
      unplacedLines: '',
      references: [],
      oldSigla: [],
    };
  }

  // Reconcile manuscripts.json against the actual files in manuscripts/ on disk.
  // - Adds default entries for new files
  // - Removes entries whose file is gone
  // - KEEPS the id each manuscript already has, and gives a new file the next
  //   free one (eBL requires unique ids >= 1, not contiguous ones)
  // - Heals stale museumNumber values that still carry join notation
  //   like "K.14874 (+) BM.41031" — replaces them with the primary segment.
  function reconcileManuscripts(existing, filesOnDisk) {
    const byFile = new Map((existing?.manuscripts || []).map((m) => [m.file, m]));
    const sortedFiles = [...filesOnDisk].sort((a, b) => a.localeCompare(b));

    // An id is a manuscript's name on eBL: every line there points at its
    // witness by id. Numbering by position in the sorted file list meant that
    // adding one tablet renamed every tablet after it, and a POST would then
    // hand ten manuscripts' lines to the wrong stones. So an id, once given,
    // is kept, and only a file that has never had one gets the next free
    // number. Removing a manuscript leaves a gap, which eBL permits.
    const idFor = new Map();
    const taken = new Set();
    // Whoever holds an id keeps it. If two files somehow claim the same one,
    // the first in file order keeps it and the other is treated as new.
    for (const file of sortedFiles) {
      const held = Number((byFile.get(file) || {}).id);
      if (!Number.isInteger(held) || held < 1 || taken.has(held)) continue;
      taken.add(held);
      idFor.set(file, held);
    }
    // A new manuscript goes above every id ever handed out here, rather than
    // into a gap a removed one left behind. Reusing a freed id would give the
    // newcomer whatever eBL still had filed under that number.
    let nextFree = taken.size ? Math.max.apply(null, [...taken]) + 1 : 1;
    for (const file of sortedFiles) {
      if (idFor.has(file)) continue;
      taken.add(nextFree);
      idFor.set(file, nextFree);
      nextFree++;
    }

    const reconciled = sortedFiles.map((file) => {
      const prev = byFile.get(file);
      const id = idFor.get(file);
      if (!prev) return defaultManuscriptEntry(file, id);

      const healed = { ...prev, file, id, siglumDisambiguator: prev.siglumDisambiguator || '' };
      // Heal museumNumber: if it contains join notation, re-extract the primary.
      // If it's empty, derive from the filename.
      if (!healed.museumNumber) {
        healed.museumNumber = extractMuseumNumber(file).primary;
      } else if (/[()+]/.test(healed.museumNumber) || /\s\s/.test(healed.museumNumber)) {
        const { primary, joins } = extractMuseumNumber(healed.museumNumber);
        healed.museumNumber = primary;
        if (joins.length && !healed.notes) healed.notes = `Joins: ${joins.join(' + ')}`;
      }
      return healed;
    });
    return { version: 1, manuscripts: reconciled };
  }

  // A manuscript's museum number, however either side chose to write it. This
  // is the one field the chapter and manuscripts.json always agree on, so it is
  // what the two lists are matched by.
  function museumNumberOf(m) {
    const n = m && m.museumNumber;
    if (!n) return '';
    if (typeof n === 'string') return n.trim();
    return [n.prefix, n.number, n.suffix].filter(Boolean).join('.');
  }

  // What sending this list would do to the chapter eBL already holds.
  //
  // An id is how eBL knows which tablet a line belongs to. A list that gives an
  // existing manuscript a different number does not rename it — it hands that
  // manuscript's lines to whichever tablet now carries the number, quietly and
  // across every line of the chapter. So `moved` is not a warning: it is a
  // reason not to send.
  function compareManuscripts(held, sending) {
    const theirs = new Map();
    for (const m of (held || [])) {
      const k = museumNumberOf(m);
      if (k) theirs.set(k, m.id);
    }
    const ours = new Set();
    const moved = [], added = [], matched = [];
    for (const m of (sending || [])) {
      const k = museumNumberOf(m);
      if (k) ours.add(k);
      if (!k || !theirs.has(k)) { added.push({ museumNumber: k || '(no museum number)', id: m.id }); continue; }
      const was = theirs.get(k);
      if (was === m.id) matched.push({ museumNumber: k, id: m.id });
      else moved.push({ museumNumber: k, from: was, to: m.id });
    }
    const dropped = [];
    for (const [k, id] of theirs) if (!ours.has(k)) dropped.push({ museumNumber: k, id });
    return { moved, added, dropped, matched };
  }

  // Take eBL's numbering for every manuscript it already knows.
  //
  // The chapter is the authority here: its lines already point at these ids, and
  // a local file cannot renumber them by wishing. Anything eBL does not have
  // keeps its own id where that is still free, and otherwise takes the next one
  // above everything in use.
  function adoptChapterIds(meta, held) {
    const theirs = new Map();
    for (const m of (held || [])) {
      const k = museumNumberOf(m);
      if (k) theirs.set(k, m.id);
    }
    const rows = (meta && meta.manuscripts) || [];
    const taken = new Set();
    const assigned = new Map();
    for (const m of rows) {
      const id = theirs.get(museumNumberOf(m));
      if (id == null || taken.has(id)) continue;
      taken.add(id);
      assigned.set(m.file, id);
    }
    // Then the ones eBL does not know, keeping their number if it is still free.
    for (const m of rows) {
      if (assigned.has(m.file)) continue;
      const held2 = Number(m.id);
      if (Number.isInteger(held2) && held2 >= 1 && !taken.has(held2)) {
        taken.add(held2);
        assigned.set(m.file, held2);
      }
    }
    let next = taken.size ? Math.max.apply(null, [...taken]) + 1 : 1;
    for (const m of rows) {
      if (assigned.has(m.file)) continue;
      assigned.set(m.file, next);
      taken.add(next);
      next++;
    }
    return {
      version: 1,
      manuscripts: rows.map((m) => ({ ...m, id: assigned.get(m.file) })),
    };
  }

  // Strip local-only fields and return the array eBL's POST /manuscripts expects.
  function toEblManuscripts(meta) {
    return (meta.manuscripts || []).map((m) => ({
      id: m.id,
      siglumDisambiguator: m.siglumDisambiguator,
      oldSigla: m.oldSigla || [],
      museumNumber: m.museumNumber || '',
      accession: m.museumNumber ? '' : (m.accession || ''),
      periodModifier: m.periodModifier || 'None',
      period: m.period || 'None',
      provenance: m.provenance || '',
      type: m.type || (m.provenance === 'Standard Text' ? 'None' : 'Library'),
      notes: m.notes || '',
      colophon: m.colophon || '',
      unplacedLines: m.unplacedLines || '',
      references: m.references || [],
    }));
  }

  // Manuscripts that would carry the same siglum.
  //
  // eBL names a manuscript by what it is, not by its id: provenance, period,
  // type and a disambiguator, so Nineveh + Neo-Assyrian + Library + 2 is
  // NinNALibrary2 and no two may be the same. Only the disambiguator is free to
  // vary, and a tablet added here starts with its id — which collides the
  // moment the ids and the disambiguators have drifted apart.
  //
  // This is the check eBL actually enforces, and the one refusal that says
  // nothing useful when it comes back: "Duplicate sigla" followed by the whole
  // provenance record of one of them.
  function siglumGroupKey(m) {
    return [m.provenance || '', m.periodModifier || 'None', m.period || '', m.type || ''].join('|');
  }

  function duplicateSigla(meta) {
    const groups = new Map();
    for (const m of (meta && meta.manuscripts) || []) {
      const key = siglumGroupKey(m) + '|' + String(m.siglumDisambiguator || '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const out = [];
    for (const [, rows] of groups) {
      if (rows.length < 2) continue;
      out.push({
        provenance: rows[0].provenance || '(no provenance)',
        period: rows[0].period || '(no period)',
        type: rows[0].type || '(no type)',
        disambiguator: String(rows[0].siglumDisambiguator || ''),
        files: rows.map((m) => m.file || String(m.id)),
      });
    }
    return out;
  }

  // Give each clashing manuscript a disambiguator no other in its group is
  // using. The first of a group keeps what it has — it is usually the one eBL
  // already knows under that name — and the rest move up.
  function resolveSiglumClashes(meta) {
    const taken = new Map();   // group -> Set of disambiguators
    const rows = (meta && meta.manuscripts) || [];
    for (const m of rows) {
      const g = siglumGroupKey(m);
      if (!taken.has(g)) taken.set(g, new Set());
    }
    const seen = new Map();
    const out = rows.map((m) => {
      const g = siglumGroupKey(m);
      const used = taken.get(g);
      let d = String(m.siglumDisambiguator || '').trim();
      if (!seen.has(g)) seen.set(g, new Set());
      const here = seen.get(g);
      if (!d || here.has(d)) {
        // The lowest whole number nothing in this group is using.
        let n = 1;
        while (here.has(String(n))) n++;
        d = String(n);
      }
      here.add(d);
      used.add(d);
      return Object.assign({}, m, { siglumDisambiguator: d });
    });
    return { version: 1, manuscripts: out };
  }

  // The lowest number no other manuscript of this one's group is using — what
  // a tablet should be called the moment its provenance, period and type are
  // known. The group counts its own: the tenth excerpt is Ex10, however many
  // library copies came before it.
  function nextFreeDisambiguator(meta, target) {
    const g = siglumGroupKey(target);
    const used = new Set();
    for (const m of (meta && meta.manuscripts) || []) {
      if (m === target || siglumGroupKey(m) !== g) continue;
      const d = String(m.siglumDisambiguator || '').trim();
      if (d) used.add(d);
    }
    let n = 1;
    while (used.has(String(n))) n++;
    return String(n);
  }

  // Number every siglum group on its own, 1, 2, 3… in id order, so the
  // sequence follows the order the tablets were registered in. The
  // disambiguator only tells apart manuscripts that share provenance, period
  // and type — numbering them all in one run is what made the tenth excerpt
  // NinNAEx37. A non-numeric disambiguator was written by hand and is kept;
  // the numbers are laid out around it.
  function renumberSiglaPerGroup(meta) {
    const rows = (meta && meta.manuscripts) || [];
    const groups = new Map();
    for (const m of rows) {
      const g = siglumGroupKey(m);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(m);
    }
    const newDis = new Map();   // row -> disambiguator
    for (const [, list] of groups) {
      list.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
      const kept = new Set();
      for (const m of list) {
        const d = String(m.siglumDisambiguator || '').trim();
        if (d && !/^\d+$/.test(d)) { newDis.set(m, d); kept.add(d); }
      }
      let n = 1;
      for (const m of list) {
        if (newDis.has(m)) continue;
        while (kept.has(String(n))) n++;
        newDis.set(m, String(n));
        n++;
      }
    }
    return {
      version: 1,
      manuscripts: rows.map((m) => Object.assign({}, m, { siglumDisambiguator: newDis.get(m) })),
    };
  }

  // Manuscripts eBL already has under this museum number and id, but whose
  // number in the siglum differs from what would be sent. A rename is safe:
  // the chapter's lines point at the id, not the name — but it is a change
  // worth showing, and a reason to register even when nothing is added.
  function renamedSigla(held, sending) {
    const theirs = new Map();
    for (const m of (held || [])) {
      const k = museumNumberOf(m);
      if (k) theirs.set(k, m);
    }
    const out = [];
    for (const m of (sending || [])) {
      const was = theirs.get(museumNumberOf(m));
      if (!was || was.id !== m.id) continue;
      const a = String(was.siglumDisambiguator || '').trim();
      const b = String(m.siglumDisambiguator || '').trim();
      if (a !== b) {
        out.push({ museumNumber: museumNumberOf(m), from: a || '—', to: b || '—' });
      }
    }
    return out;
  }

  // Keep what the chapter holds and this project does not.
  //
  // POST /manuscripts replaces the whole list, so every field goes as written —
  // and manuscripts.json carries a colophon only if someone has pulled the
  // metadata down first. Registering a new tablet would otherwise send
  // colophon: "" for all the others and erase what eBL has: on EAE 56 that is
  // seven colophons and twenty-four reference lists, gone, for adding one file.
  //
  // An empty field here means "nothing to say", not "make it empty". Changing
  // one is still possible — sync it down, edit it, send it back.
  const KEEP_IF_BLANK = ['colophon', 'notes', 'unplacedLines'];
  function preserveFromChapter(sending, held) {
    const theirs = new Map();
    for (const m of (held || [])) {
      const k = museumNumberOf(m);
      if (k) theirs.set(k, m);
    }
    return (sending || []).map((m) => {
      const was = theirs.get(museumNumberOf(m));
      if (!was) return m;
      const out = Object.assign({}, m);
      for (const field of KEEP_IF_BLANK) {
        if (!String(out[field] || '').trim() && was[field]) out[field] = was[field];
      }
      for (const field of ['references', 'oldSigla']) {
        if ((!out[field] || !out[field].length) && was[field] && was[field].length) {
          out[field] = was[field];
        }
      }
      return out;
    });
  }

  // What sending this list would erase, for the editor to see before it goes.
  function wouldErase(sending, held) {
    const theirs = new Map();
    for (const m of (held || [])) {
      const k = museumNumberOf(m);
      if (k) theirs.set(k, m);
    }
    const out = [];
    for (const m of (sending || [])) {
      const was = theirs.get(museumNumberOf(m));
      if (!was) continue;
      const lost = [];
      for (const field of KEEP_IF_BLANK) {
        if (!String(m[field] || '').trim() && String(was[field] || '').trim()) lost.push(field);
      }
      for (const field of ['references', 'oldSigla']) {
        if ((!m[field] || !m[field].length) && was[field] && was[field].length) lost.push(field);
      }
      if (lost.length) out.push({ museumNumber: museumNumberOf(m), fields: lost });
    }
    return out;
  }

  // Validate manuscripts.json entries against eBL's cross-field rules.
  // Returns [{ file, errors: string[] }] for entries with problems.
  function validateManuscripts(meta) {
    const problems = [];
    const seenIds = new Set();
    for (const m of meta.manuscripts || []) {
      const errs = [];

      if (!m.id || m.id < 1) errs.push('id must be >= 1');
      if (seenIds.has(m.id)) errs.push(`duplicate id ${m.id}`);
      seenIds.add(m.id);

      if (!m.siglumDisambiguator) errs.push('siglumDisambiguator required');

      if (m.museumNumber && m.accession) {
        errs.push('museumNumber and accession are mutually exclusive');
      }
      if (!m.museumNumber && !m.accession) {
        errs.push('either museumNumber or accession is required');
      }

      // Every missing field at once. While the period and type checks sat
      // behind a filled-in provenance, a newly added tablet reported only
      // "provenance required" — and the next send failed on the period, and the
      // one after that on the type. Three refusals for one incomplete row.
      if (!m.provenance) errs.push('provenance required');
      if (m.provenance === 'Standard Text') {
        if (m.period && m.period !== 'None') errs.push('Standard Text requires period = None');
        if (m.type && m.type !== 'None') errs.push('Standard Text requires type = None');
      } else {
        if (!m.period || m.period === 'None') errs.push('period required (or set provenance to Standard Text)');
        if (!m.type || m.type === 'None') errs.push('type required (or set provenance to Standard Text)');
      }

      if (errs.length) problems.push({ file: m.file, errors: errs });
    }
    return problems;
  }

  // ---- Export ----
  window.EblClient = {
    // constants
    DEFAULT_API_URL,
    PERIODS,
    MANUSCRIPT_TYPES,
    PERIOD_MODIFIERS,

    // auth
    getToken,
    setToken,
    getApiUrl,
    setApiUrl,
    decodeToken,
    tokenStatus,

    // vocabularies
    getProvenances,
    abbrevOf,
    provenanceAbbrev,
    buildSiglumPreview,

    // corpus endpoints
    getChapter,
    postManuscripts,
    postImport,
    postLines,
    postAlignment,
    postLemmatization,
    deleteAllLines,

    // fragmentarium
    getFragment,
    fragmentToManuscriptFields,

    // manuscripts.json helpers
    extractMuseumNumber,
    defaultManuscriptEntry,
    reconcileManuscripts,
    toEblManuscripts,
    museumNumberOf,
    compareManuscripts,
    adoptChapterIds,
    preserveFromChapter,
    wouldErase,
    duplicateSigla,
    resolveSiglumClashes,
    nextFreeDisambiguator,
    renumberSiglaPerGroup,
    renamedSigla,
    validateManuscripts,

    EblError,
  };
})();
