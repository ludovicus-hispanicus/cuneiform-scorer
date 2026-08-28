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

  async function authedRequest(method, path, body) {
    const jwt = getToken();
    if (!jwt) throw new EblError('No eBL token configured', 0, '');

    const res = await fetch(`${getApiUrl()}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
    });

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
      siglumDisambiguator: String(id),
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

      const healed = { ...prev, file, id, siglumDisambiguator: prev.siglumDisambiguator || String(id) };
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

      if (!m.provenance) {
        errs.push('provenance required');
      } else if (m.provenance === 'Standard Text') {
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
    validateManuscripts,

    EblError,
  };
})();
