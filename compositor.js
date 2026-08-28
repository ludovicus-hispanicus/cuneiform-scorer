// ===========================================
// Compose a reading from its witnesses
// ===========================================
// Aligns the witnesses of one section word by word, takes the best-attested
// form in each column as the reading, and reads each witness's empty columns
// off as omitted positions.
//
// Comparison is at sign level, so BARA₂/BAR₂ and UDU.IDIM/UDU.TIL are the same
// word and only real differences survive. Three rules earn their keep, and each
// was arrived at by watching the aligner get EAE 56 §1 wrong without it:
//
//   - A phonetic complement is not a different word. IGI is ABZ449 and IGI-ir
//     is ABZ449 ABZ232; call that a mismatch and one of them gets shunted into
//     a neighbouring column. Exactly one extra sign, though — allow two and ŠE
//     starts matching ŠE.GIŠ.I₃, which drags a whole tail out of place.
//   - A column needs two witnesses to enter the reading, unless it is the only
//     evidence there is. One witness against several that are present and
//     silent is a variant, not the text.
//   - Damage is not omission. A witness omits only a column it is demonstrably
//     present on both sides of; anywhere else its absence says nothing.
//
// Nothing here runs on its own. Composing overwrites an editor's work, so it
// happens when asked and not before.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.Compositor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAMAGE = /[\[\]⸢⸣#?!*]|\.\.\./;
  const DIVIDER = /^[:;]$/;

  // Not text. Commentary protocols (!qt !cm !bs !zz), column separators (& &2),
  // language shifts (%n %sux) and the continuation marker say how to read the
  // line, not what it says. Left in the stream they take a position each and
  // shift every real word after them — which is how a witness beginning "!qt"
  // ended up with all its alignments off by one.
  const METADATA = /^(?:![a-z]{2}|&\d*|%\w+|\(\$___\$\))$/;
  function isMetadata(text) { return METADATA.test(String(text).trim()); }

  // Split a witness line into the roles its markers declare.
  //
  //   meta       the marker itself — shown, never numbered
  //   commentary everything under !cm, which glosses the text rather than
  //              being it, and so must not be aligned against the reading
  //   text       everything else, including what follows !qt and !bs
  //
  // Without this a commentary's gloss competes for positions with the omen it
  // is glossing, and IM.74460's "SAG₃.ME.GAR" lands on top of "DU₃.A.BI".
  const PROTOCOL = /^!(qt|cm|bs|zz)$/;
  function classify(atf) {
    let commentary = false;
    return String(atf || '').trim().split(/\s+/).filter(Boolean).map((text) => {
      const p = text.match(PROTOCOL);
      if (p) { commentary = p[1] === 'cm'; return { text, role: 'meta' }; }
      if (isMetadata(text)) return { text, role: 'meta' };
      return { text, role: commentary ? 'commentary' : 'text' };
    });
  }

  const MATCH = 2, MISMATCH = -1, GAP = -2;
  const MIN_ATTESTATION = 2;
  const DIVERGENCE = 0.75;   // below this share of agreement, a witness wants its own variant
  // Three preserved words that happen to disagree are a curiosity, not grounds
  // for splitting off a reading. Below this the verdict is withheld and the
  // thinness reported instead.
  const MIN_EVIDENCE = 5;
  // How many words a witness must actually disagree on before it can claim a
  // reading of its own, and how that rises as less of the line survives.
  //
  // A share of agreement alone cannot tell a different text from a broken one.
  // A fragment preserving six words disagrees 33% on two of them — and two
  // mismatches in six is exactly what damage produces: {m]u[l} does not match
  // {mul}UDU.IDIM because half of it is gone, not because the scribe wrote
  // something else. Measured over this chapter, half the witnesses the
  // compositor offered to split preserved under 60% of their line.
  //
  // So a witness that preserves most of its line may claim a variant on two
  // disagreements; one preserving less must show more.
  const MIN_DIVERGENT = 2;
  const WELL_PRESERVED = 0.6;

  function tokenize(atf, convert) {
    return classify(atf)
      .filter((t) => t.role === 'text')
      .map((t) => {
      const text = t.text;
      let codes = [];
      try { codes = convert(text) || []; } catch (_) { codes = []; }
      const real = codes.filter((c) => c !== 'X' && c !== 'N');
      // A divider holds its place in the line but is not a Word: eBL types it
      // separately, and the positions omittedWords indexes skip it.
      return {
        text,
        key: codes.join(' '),
        divider: DIVIDER.test(text),
        damaged: DAMAGE.test(text),
        blank: real.length === 0,
      };
    });
  }

  function score(x, y) {
    if (x.blank || y.blank) return 0;
    if (x.key === y.key) return MATCH;
    const xs = x.key.split(' '), ys = y.key.split(' ');
    const shorter = xs.length <= ys.length ? x : y;
    const short = xs.length <= ys.length ? xs : ys;
    const long = xs.length <= ys.length ? ys : xs;
    if (!short.length) return MISMATCH;
    const prefix = long.slice(0, short.length).join(' ') === short.join(' ');
    if (!prefix) return MISMATCH;
    // One extra sign is a phonetic complement: IGI against IGI-ir.
    if (long.length - short.length === 1) return MATCH - 0.5;
    // More than one, but the short side is broken: a word damaged down to its
    // opening signs is very probably that word. {m]u[l} preserves only the
    // determinative of {mul}UDU.IDIM, and scoring it a mismatch made the
    // aligner slide the whole witness along by a slot — which is how a fragment
    // that agrees everywhere came back "differing at 4".
    if (shorter.damaged) return MATCH - 0.5;
    return MISMATCH;
  }

  // Needleman-Wunsch over word tokens.
  function align(a, b) {
    const n = a.length, m = b.length;
    const F = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) F[i][0] = i * GAP;
    for (let j = 1; j <= m; j++) F[0][j] = j * GAP;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        F[i][j] = Math.max(
          F[i - 1][j - 1] + score(a[i - 1], b[j - 1]),
          F[i - 1][j] + GAP,
          F[i][j - 1] + GAP);
      }
    }
    const pairs = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && F[i][j] === F[i - 1][j - 1] + score(a[i - 1], b[j - 1])) {
        pairs.unshift([i - 1, j - 1]); i--; j--;
      } else if (i > 0 && F[i][j] === F[i - 1][j] + GAP) {
        pairs.unshift([i - 1, null]); i--;
      } else {
        pairs.unshift([null, j - 1]); j--;
      }
    }
    return pairs;
  }

  function majority(col, keys) {
    const tally = new Map();
    for (const k of keys) {
      const t = col[k];
      if (!t || t.blank) continue;
      if (!tally.has(t.key)) tally.set(t.key, []);
      tally.get(t.key).push(k);
    }
    const ranked = [...tally.entries()].sort((a, b) => b[1].length - a[1].length);
    return ranked.length ? { key: ranked[0][0], holders: ranked[0][1], ranked } : null;
  }

  // The witness's own word index at column i: its position among that witness's
  // non-empty columns, which is how the words of its .txt line are numbered.
  function wordIndexAt(columns, key, upTo) {
    let n = -1;
    for (let i = 0; i <= upTo; i++) if (columns[i][key] && !columns[i][key].blank) n++;
    return n;
  }

  // Does this witness disagree enough, and on enough surviving evidence, to be
  // a reading of its own rather than a damaged copy of this one?
  function wantsOwnVariant(judged, agree, differing, coverage) {
    if (judged < MIN_EVIDENCE) return false;
    if ((agree / judged) >= DIVERGENCE) return false;
    const needed = (coverage != null && coverage < WELL_PRESERVED)
      ? MIN_DIVERGENT + 1 : MIN_DIVERGENT;
    return differing >= needed;
  }

  // witnesses: [{ key, atf }], key identifying the row uniquely.
  // convert:   (text) -> array of sign codes.
  function composeSection(witnesses, convert) {
    const seqs = (witnesses || [])
      .map((w) => ({ key: w.key, words: tokenize(w.atf, convert) }))
      .filter((s) => s.words.some((t) => !t.blank));
    if (!seqs.length) return null;
    seqs.sort((a, b) =>
      b.words.filter((t) => !t.blank).length - a.words.filter((t) => !t.blank).length);

    let columns = seqs[0].words.map((t) => ({ [seqs[0].key]: t }));
    const seen = [seqs[0].key];
    for (const s of seqs.slice(1)) {
      const profile = columns.map((col) => {
        const m = majority(col, seen);
        return m ? { key: m.key, blank: false } : { key: '', blank: true };
      });
      const next = [];
      for (const pair of align(profile, s.words)) {
        const ci = pair[0], wi = pair[1];
        if (ci != null) {
          if (wi != null) columns[ci][s.key] = s.words[wi];
          next.push(columns[ci]);
        } else {
          next.push({ [s.key]: s.words[wi] });
        }
      }
      columns = next;
      seen.push(s.key);
    }

    const keys = seqs.map((s) => s.key);
    const span = {};
    for (const k of keys) {
      // A divider does not show a witness is present: a commentary whose
      // quotation stops early still has one, and letting it anchor the span
      // made every position after the break look omitted rather than lost.
      const has = columns.map((c) => c[k] && !c[k].blank && !c[k].divider);
      span[k] = { first: has.indexOf(true), last: has.lastIndexOf(true) };
    }

    // Which columns earn a place in the reading.
    const decided = columns.map((col, i) => {
      const m = majority(col, keys);
      if (!m) return { keep: false, m: null, divider: false };
      const attest = keys.filter((k) => col[k] && !col[k].blank);
      const silent = keys.filter((k) =>
        span[k].first >= 0 && i > span[k].first && i < span[k].last && attest.indexOf(k) < 0);
      // Punctuation is the editor's, not the witnesses'. Two tablets happening
      // to divide a clause in the same place is thin ground for putting a
      // divider in the reading, so the compositor never proposes one.
      const divider = attest.every((k) => col[k].divider);
      return {
        keep: !divider && (m.holders.length >= MIN_ATTESTATION || silent.length === 0),
        m,
        divider,
      };
    });

    const text = [];
    const posOfCol = new Map();
    let pos = 0;
    columns.forEach((col, i) => {
      const d = decided[i];
      if (!d.keep) return;
      const pick = d.m.holders.find((k) => !col[k].damaged) || d.m.holders[0];
      text.push(col[pick].text.replace(/[#?!*\[\]⸢⸣]/g, ''));
      if (!d.divider) posOfCol.set(i, pos++);
    });

    // Per witness: where it agrees, what it leaves out, what it puts instead.
    const perWitness = {};
    for (const k of keys) {
      const omitted = [], differing = [], extra = [], alignment = {};
      let agree = 0, judged = 0;
      // Columns this witness cannot answer for, because a break of its own
      // stands between the words either side. Damage is not omission: a gap
      // bridged by "..." says the tablet is broken there, not that the scribe
      // left the words out. Reported as `lost` rather than counted against it.
      const lost = new Set();
      {
        let last = null;
        let broken = false;
        columns.forEach((col, i) => {
          const t = col[k];
          if (t && t.blank) { broken = true; return; }
          if (!t || t.divider) return;
          if (last != null && broken) { for (let c = last + 1; c < i; c++) lost.add(c); }
          last = i;
          broken = false;
        });
      }
      columns.forEach((col, i) => {
        const t = col[k];
        const d = decided[i];
        // A divider is not a word: it claims no position and its absence is
        // not an omission, on either side of the comparison.
        const here = t && !t.blank && !t.divider;
        if (!d.keep) { if (here) extra.push(t.text); return; }
        const p = posOfCol.get(i);
        if (here) {
          if (p != null) alignment[wordIndexAt(columns, k, i)] = p;
          judged++;
          if (score(t, { key: d.m.key, blank: false }) >= MATCH - 0.5) agree++;
          else if (p != null) differing.push(p);
        } else if (p != null) {
          const inside = i > span[k].first && i < span[k].last;
          if (inside && !(t && t.blank) && !lost.has(i)) omitted.push(p);
        }
      });
      // Agreement is over what this witness preserves, and only that. A
      // fragment with four surviving words that all match agrees 100% with a
      // twelve-word reading — true, and nearly worthless on its own. Coverage
      // is the other half of the fact, and `judged` is the weight to give it
      // when these are averaged: without it a scrap counts as much as a
      // complete copy.
      perWitness[k] = {
        omitted, differing, extra, alignment,
        judged, positions: pos,
        coverage: pos ? judged / pos : null,
        agreement: judged ? agree / judged : null,
        wantsVariant: wantsOwnVariant(judged, agree, differing.length,
          pos ? judged / pos : null),
        thinEvidence: judged > 0 && judged < MIN_EVIDENCE,
      };
    }

    return { text: text.join(' '), columns, decided, posOfCol, perWitness };
  }

  // Align witnesses to a reading that already exists, without touching it.
  //
  // composeSection needs two witnesses before it will call anything "best
  // attested". A variant often has one — and one witness against a reading an
  // editor already wrote is still perfectly alignable. This is that case: the
  // reading is the ruler, the witnesses are measured against it, and nothing
  // is composed.
  function alignToReading(readingText, witnesses, convert) {
    const reading = tokenize(readingText, convert);
    // Position numbering skips dividers, exactly as composeSection does, so the
    // numbers here and there mean the same thing.
    const posOf = [];
    let pos = 0;
    for (const t of reading) posOf.push(t.divider ? null : pos++);

    const perWitness = {};
    for (const w of (witnesses || [])) {
      const words = tokenize(w.atf, convert);
      const alignment = {};
      const omitted = [], differing = [];
      let wordIndex = -1, agree = 0, judged = 0;
      const seen = new Set();
      for (const pair of align(reading, words)) {
        const ri = pair[0], wi = pair[1];
        // Numbered the way composeSection numbers, and the way the score
        // renders: a word with no sign content — "[...]", a bare x — is a
        // placeholder for lost text, not a word, and answers to no position.
        if (wi != null && !words[wi].blank) wordIndex++;
        if (ri == null || wi == null) continue;
        const p = posOf[ri];
        if (p == null) continue;
        // A divider answers to a divider or to nothing; it never claims a word
        // position, on either side.
        if (words[wi].blank || words[wi].divider) continue;
        alignment[wordIndex] = p;
        seen.add(p);
        judged++;
        if (score(reading[ri], words[wi]) >= MATCH - 0.5) agree++;
        else differing.push(p);
      }
      // Only claim an omission inside what this witness actually preserves.
      const held = Object.values(alignment);
      const lo = Math.min.apply(null, held.length ? held : [Infinity]);
      const hi = Math.max.apply(null, held.length ? held : [-Infinity]);
      for (const p of posOf) {
        if (p == null || seen.has(p)) continue;
        if (p > lo && p < hi) omitted.push(p);
      }
      perWitness[w.key] = {
        alignment, omitted, differing, extra: [],
        judged, positions: pos,
        coverage: pos ? judged / pos : null,
        agreement: judged ? agree / judged : null,
        wantsVariant: wantsOwnVariant(judged, agree, differing.length,
          pos ? judged / pos : null),
        thinEvidence: judged > 0 && judged < MIN_EVIDENCE,
      };
    }
    return { perWitness };
  }

  // How two words relate, for anything that needs the same verdict the aligner
  // uses. Comparing the transliterations instead reports {iti}BAR₂ against
  // {iti}BARA₂ as a difference when they are the same two signs.
  //
  //   same        identical sign streams
  //   complement  one extra sign, e.g. IGI against IGI-ir — not a difference
  //   different   genuinely another word
  //   unknown     one side carries no sign information (a break, an x)
  function compareWords(a, b, convert) {
    const ta = tokenize(a, convert)[0];
    const tb = tokenize(b, convert)[0];
    if (!ta || !tb || ta.blank || tb.blank) return 'unknown';
    const s = score(ta, tb);
    if (s === MATCH) return 'same';
    if (s === MATCH - 0.5) return 'complement';
    return 'different';
  }

  // Does this word carry any sign information at all? A break or a bare x
  // cannot attest anything, and cannot deny anything either.
  function isLegible(text, convert) {
    const t = tokenize(text, convert)[0];
    return !!t && !t.blank;
  }

  function isDivider(text) { return DIVIDER.test(String(text).trim()); }

  return {
    composeSection, alignToReading, tokenize, align,
    wantsOwnVariant,
    isMetadata, classify, compareWords, isLegible, isDivider,
  };
});
