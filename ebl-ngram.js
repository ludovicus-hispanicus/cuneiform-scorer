// ===========================================
// n-gram matcher for cuneiform sign streams
// ===========================================
// Ranks fragments by how much sign material they share with the sources of a
// project. The algorithm follows eBL's own ngram-matcher
// (ebl_ngrams/document_model.py) so scores stay comparable with theirs:
// preprocess into a token stream, take the set of n-grams, drop any containing
// an unknown sign, and score by the overlap coefficient |A∩B| / min(|A|,|B|).
// The min() denominator is theirs and is deliberate — a scrap wholly contained
// in a long composition scores 1.0 instead of being punished for being small.
//
// Three departures, each one something this app can do and a generic tool
// cannot:
//
//   1. Trigrams by default, not n=(1,2,3). Measured on EAE 56: with eBL's
//      default, unigrams and bigrams of ubiquitous signs (DIŠ, ina, {mul})
//      swamp the ranking — 25 tiny scraps tie at 1.000 and the pieces already
//      known to be missing land at ranks 26, 45, 63 and 108. Trigrams alone put
//      the same four at 1, 4, 7 and 16.
//
//   2. Two channels. A colophon match means the same scribe or library, which
//      is a *join* signal; a text match means the same composition, which is a
//      *parallel* signal. eBL sees one undifferentiated sign stream per
//      fragment and has to merge them. The scorer knows which lines are
//      colophon, so it keeps the two scores apart — merging them buries
//      whichever is smaller.
//
//   3. Matched n-grams come back with the score, so a hit can be localised
//      instead of being just a number.
//
// Pure: no DOM, no network, no storage. Runs in the browser and under Node, so
// the same code that ships can be validated headlessly.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EblNgram = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const UNKNOWN_SIGN = 'X';
  const LINE_SEP = '#';
  const DEFAULT_N_VALUES = [3];

  // Tokens are sign codes ("ABZ480", "|GIŠ%GIŠ|") and never contain a space,
  // so a space is a safe joiner for the n-gram key.
  const NGRAM_SEP = ' ';

  // Turn eBL's `signs` string into a flat token stream. Lines that preserve
  // nothing — only unknown signs — are dropped rather than contributing a run
  // of X, and the surviving lines are separated by an explicit token so an
  // n-gram cannot silently span a line break.
  function preprocess(signs) {
    const lines = String(signs || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !isBlank(line));
    return lines.join(` ${LINE_SEP} `).split(/\s+/).filter(Boolean);
  }

  function isBlank(line) {
    for (const token of line.split(/\s+/)) {
      if (token && token !== UNKNOWN_SIGN && token !== LINE_SEP) return false;
    }
    return true;
  }

  // The set of n-grams over a token stream. An n-gram containing an unknown
  // sign is discarded: a break should not be able to match another break.
  function ngramSet(tokens, nValues = DEFAULT_N_VALUES) {
    const out = new Set();
    for (const n of nValues) {
      if (n <= 0) throw new Error('n values must be greater than zero');
      for (let i = 0; i + n <= tokens.length; i++) {
        let usable = true;
        for (let k = 0; k < n; k++) {
          if (tokens[i + k] === UNKNOWN_SIGN) { usable = false; break; }
        }
        if (!usable) continue;
        out.add(tokens.slice(i, i + n).join(NGRAM_SEP));
      }
    }
    return out;
  }

  // eBL's ATF numbers its text lines "1.", "5'.", "6a.", "6'a." and emits one
  // line of `signs` for each. Surfaces, rulings, notes and translations produce
  // none, so walking the ATF gives the index of every sign line.
  const ATF_TEXT_LINE = /^\s*\d+['’]?[a-z]?\.\s/;
  const ATF_COLOPHON = /^\s*@colophon\b/i;

  // Split a fragment's sign stream into composition and colophon, using eBL's
  // own @colophon marker rather than any local annotation.
  //
  // The two belong to different questions: shared composition means another
  // witness, shared colophon means the same scribe or library — which is a join
  // signal, and the one this app is really after. Scored together, whichever is
  // smaller vanishes. A project's own sources are the only fragments whose ATF
  // has to be fetched for this: candidates are scored on their whole stream,
  // since the question asked of them is "does this share our colophon", not
  // "which of your lines are colophon".
  //
  // Returns { text, colophon, aligned }. `aligned` is false when the ATF's text
  // lines and the sign lines disagree in number — the split cannot be trusted
  // then, and the caller should treat the whole stream as text.
  function splitColophon(atf, signs) {
    const signLines = String(signs || '').split('\n');
    const text = [];
    const colophon = [];
    let index = 0;
    let inColophon = false;

    for (const line of String(atf || '').split('\n')) {
      if (ATF_COLOPHON.test(line)) { inColophon = true; continue; }
      if (!ATF_TEXT_LINE.test(line)) continue;
      const signLine = signLines[index++];
      if (signLine === undefined) break;
      (inColophon ? colophon : text).push(signLine);
    }

    const aligned = index === signLines.length;
    return aligned
      ? { text, colophon, aligned }
      : { text: signLines, colophon: [], aligned };
  }

  // A profile is what a query is scored against: the union of the n-grams of
  // every source given. Text and colophon are profiled separately by the
  // caller, which is what keeps the two channels apart.
  function buildProfile(signsList, { nValues = DEFAULT_N_VALUES } = {}) {
    const set = new Set();
    for (const signs of signsList) {
      for (const gram of ngramSet(preprocess(signs), nValues)) set.add(gram);
    }
    return { set, size: set.size, nValues };
  }

  // Score one document against a profile. `matched` is capped because a strong
  // hit can share hundreds of n-grams and the caller only ever shows a few.
  function score(profile, signs, { maxMatched = 12 } = {}) {
    const tokens = preprocess(signs);
    const docSet = ngramSet(tokens, profile.nValues);
    const matched = [];
    let shared = 0;
    for (const gram of docSet) {
      if (!profile.set.has(gram)) continue;
      shared++;
      if (matched.length < maxMatched) matched.push(gram);
    }
    const denominator = Math.min(profile.size, docSet.size);
    return {
      overlap: denominator ? shared / denominator : 0,
      shared,
      docSize: docSet.size,
      matched,
    };
  }

  // Rank a corpus against one or two profiles.
  //
  // `entries` is anything iterable of { id, signs } — the corpus dump has that
  // shape already. `exclude` keeps a project's own sources out of its results.
  //
  // minDocNgrams exists because a document with a handful of n-grams scores 1.0
  // on noise, but it is a real trade: the same filter hides genuinely small
  // pieces (K.14796, 8 broken lines, disappears at 20). Whatever it removes is
  // counted and returned rather than silently dropped.
  function rank(profiles, entries, options = {}) {
    const {
      exclude = new Set(),
      minDocNgrams = 20,
      limit = 100,
      maxMatched = 12,
      weighting = 'plain',
    } = options;

    const channels = Object.entries(profiles).filter(([, p]) => p && p.size);
    if (!channels.length) throw new Error('rank() needs at least one non-empty profile');

    const candidates = [];
    const dropped = { excluded: 0, tooSmall: 0, noOverlap: 0 };

    // Document frequency of each query n-gram, per channel. Counting it here
    // costs nothing: the intersection that answers "does this fragment share
    // it" is the same test that answers "how many fragments share it".
    const documentFrequency = new Map(channels.map(([name]) => [name, new Map()]));

    for (const entry of entries) {
      if (exclude.has(entry.id)) { dropped.excluded++; continue; }

      const tokens = preprocess(entry.signs);
      const perChannel = {};
      let anyOverlap = false;
      let tooSmall = false;

      for (const [channel, profile] of channels) {
        const docSet = ngramSet(tokens, profile.nValues);
        // A document below the floor is judged on noise, not evidence.
        if (docSet.size < minDocNgrams) { tooSmall = true; break; }

        const shared = [];
        for (const gram of docSet) if (profile.set.has(gram)) shared.push(gram);

        const frequencies = documentFrequency.get(channel);
        for (const gram of shared) frequencies.set(gram, (frequencies.get(gram) || 0) + 1);

        perChannel[channel] = { shared, docSize: docSet.size };
        if (shared.length) anyOverlap = true;
      }

      if (tooSmall) { dropped.tooSmall++; continue; }
      if (!anyOverlap) { dropped.noOverlap++; continue; }

      candidates.push({ id: entry.id, perChannel });
    }

    // eBL weights a shared n-gram by how rare it is across the corpus:
    //   idf = log(N / (df + 1)) + 1
    // Under plain overlap a formulaic opening counts as much as a distinctive
    // phrase, which for a corpus of omens beginning "DIŠ {mul}" flatters the
    // wrong fragments.
    const idf = new Map();
    if (weighting === 'tfidf') {
      const total = candidates.length + 1;
      for (const [channel, frequencies] of documentFrequency) {
        const table = new Map();
        for (const [gram, df] of frequencies) table.set(gram, Math.log(total / (df + 1)) + 1);
        idf.set(channel, table);
      }
    }

    const results = [];
    for (const candidate of candidates) {
      const scores = {};
      let best = 0;

      for (const [channel, profile] of channels) {
        const hit = candidate.perChannel[channel];
        if (!hit) continue;

        const denominator = Math.min(profile.size, hit.docSize);
        let overlap;
        if (weighting === 'tfidf') {
          // Deliberately not eBL's formula. Theirs is an unnormalised sum of
          // idf over the intersection, which ranks by absolute quantity of rare
          // shared material and so favours large fragments: measured on EAE 56
          // it moved K.21881 — a fragment wholly contained in the composition —
          // from rank 1 to 228, and ND.4405.53 from 16 to 1115. Keeping the
          // min() denominator preserves the property that a small fragment
          // fully accounted for still scores high, while the weighted numerator
          // still favours distinctive sequences over formulaic ones.
          const table = idf.get(channel);
          let weighted = 0;
          for (const gram of hit.shared) weighted += table.get(gram) || 0;
          overlap = denominator ? weighted / denominator : 0;
        } else {
          overlap = denominator ? hit.shared.length / denominator : 0;
        }

        scores[channel] = {
          overlap,
          shared: hit.shared.length,
          docSize: hit.docSize,
          matched: hit.shared.slice(0, maxMatched),
        };
        if (overlap > best) best = overlap;
      }

      results.push({ id: candidate.id, best, scores });
    }

    // A weighted sum has no natural ceiling, so it is scaled to the strongest
    // match in this run. Presentation only — the ranking is untouched.
    if (weighting === 'tfidf') {
      for (const [channel] of channels) {
        let max = 0;
        for (const row of results) {
          const s = row.scores[channel];
          if (s && s.overlap > max) max = s.overlap;
        }
        if (!max) continue;
        for (const row of results) {
          const s = row.scores[channel];
          if (s) s.overlap /= max;
        }
      }
      for (const row of results) {
        row.best = Math.max(...Object.values(row.scores).map((s) => s.overlap), 0);
      }
    }

    results.sort((a, b) => b.best - a.best || b.scores[channels[0][0]].shared - a.scores[channels[0][0]].shared);

    return {
      results: limit ? results.slice(0, limit) : results,
      total: results.length,
      dropped,
      // Surfaced so a caller can say what the ranking did not consider.
      settings: { minDocNgrams, nValues: channels[0][1].nValues, limit, weighting },
    };
  }

  return {
    UNKNOWN_SIGN,
    LINE_SEP,
    DEFAULT_N_VALUES,
    preprocess,
    ngramSet,
    splitColophon,
    buildProfile,
    score,
    rank,
  };
});
