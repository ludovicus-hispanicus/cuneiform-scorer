// ===========================================
// ATF transliteration -> eBL sign codes
// ===========================================
// Turns a transliterated line into the ABZ token stream that
// /fragments/all-signs uses, so text with no eBL record — a reconstruction, an
// unpublished reading, an edited line — can be matched against the corpus.
//
// eBL computes `signs` server-side from its own parser, so for anything already
// in the Fragmentarium the corpus is authoritative and this is unnecessary.
// What it buys is the other direction: querying *out* from text that exists
// only in this app.
//
// The rules below were read off eBL's own output rather than guessed — every
// fragment in the corpus is a worked example of ATF on one side and sign codes
// on the other, and tools/test-atf-signs.js scores this converter against them.
//
// Needs the table built by tools/build-sign-index.js. Pure: the index is passed
// in, nothing is fetched or read from disk.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EblAtfSigns = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const UNKNOWN = 'X';
  const NUMBER_PLACEHOLDER = 'N';

  // "1.", "5'.", "6a.", "6'a." — the line number eBL prints, not part of the text.
  const LINE_NUMBER = /^\s*\d+['’]?[a-z]?\.\s*/;

  // Editorial apparatus that marks *how much is known*, not what is written:
  // breakage, collation, uncertainty, erasure, supplied and deleted signs.
  // Every one of these is invisible in `signs`, which is why a match can land
  // on a restoration — the sign stream cannot tell the two apart.
  const STRUCTURAL = /[[\]⸢⸣⌈⌉<>«»]/g;
  const FLAGS = /[#?!*°]/g;

  // A break, a continuation marker, an erased passage.
  const OMITTED = /\(\$___\$\)|\.\.\.|\$___\$|[\\]/g;

  // Bilingual apparatus. "%sux", "%sb", "%akk", "%es" mark a shift of language
  // mid-line, and a lone "&" separates the columns of an interlinear text —
  // both are structure, neither is written on the tablet. Only standalone
  // occurrences: "&" is also an operator inside a sign name like |NUN&NUN|.
  const LANGUAGE_SHIFT = /(^|\s)%\w+(?=\s|$)/g;
  const COLUMN_SEPARATOR = /(^|\s)&+(?=\s|$)/g;

  function create(index) {
    if (!index || !index.readings || !index.signs) {
      throw new Error('EblAtfSigns.create needs the table from tools/build-sign-index.js');
    }
    const { readings, signs, unnumbered = {}, alternatives = {} } = index;

    // What eBL writes for this sign. Usually the ABZ code, but for 21 signs it
    // is the bare name — ABZ325 and NUN&NUN are one sign and the corpus prefers
    // the latter five to one. `token` records the majority form, measured when
    // the index was built; `abz` is the fallback for an index built without a
    // corpus to measure against.
    function abzOf(name) {
      const entry = signs[name];
      if (!entry) return null;
      return entry.token || entry.abz || null;
    }

    // Split a compound on its top-level dots. The parentheses in |UD×(U.U.U)|
    // enclose part of a ligature, so the dots inside them join nothing.
    function splitTopLevel(inner) {
      const parts = [];
      let depth = 0;
      let current = '';
      for (const ch of inner) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === '.' && depth === 0) { parts.push(current); current = ''; continue; }
        current += ch;
      }
      parts.push(current);
      return parts.filter(Boolean);
    }

    // A compound is written out as its parts whenever every part can be named,
    // and this beats the compound's own number where it has one. eBL emits
    // "30" — |U.U.U|, ABZ472 — as ABZ411 ABZ411 ABZ411, and SA₅ — |SI.A| — as
    // ABZ112 ABZ579. Taking the compound's own number first, as an earlier
    // version did, was wrong for both.
    //
    // The condition is that *every* part resolves. "15" is |U.5(DIŠ)| and
    // 5(DIŠ) names nothing, so that one keeps its own ABZ470 and stays whole —
    // which is exactly what eBL emits. A ligature has no parts at all:
    // |EN×GAN₂@t| has neither a split nor a number, so eBL emits the sign
    // *name* as the token. The corpus is full of those, and a name is a
    // legitimate result rather than a failure.
    function decompose(name, depth = 0) {
      if (depth > 3) return null;

      const compound = /^\|([^|]+)\|$/.exec(name);
      if (compound) {
        const parts = splitTopLevel(compound[1]);
        if (parts.length >= 2) {
          const out = [];
          let complete = true;
          for (const part of parts) {
            const codes = decompose(part, depth + 1) || decompose(`|${part}|`, depth + 1);
            if (!codes) { complete = false; break; }
            out.push(...codes);
          }
          if (complete) return out;
        }
      }

      const direct = abzOf(name);
      return direct ? [direct] : null;
    }

    // What a sign contributes to the stream: its number, its parts, or its name.
    function codesFor(name) {
      return decompose(name) || [name];
    }

    // Resolve one reading as written in a transliteration.
    // Returns { codes, name, candidates, certainty } or null when unknown.
    //   "unique"      one sign claims the reading
    //   "alternative" several claim it; the rest are kept, not discarded
    //   "unnumbered"  a ₓ reading, which names no single sign at all
    function lookup(reading) {
      // A phonetic gloss "{+en}" is written on the tablet like anything else;
      // only the marker is dropped.
      const key = reading.replace(/^\+/, '').toLowerCase();
      if (!key) return null;

      const name = readings[key];
      if (name) {
        const alts = alternatives[key];
        return {
          codes: codesFor(name),
          name,
          candidates: alts || [name],
          certainty: alts ? 'alternative' : 'unique',
        };
      }

      const list = unnumbered[key];
      if (list && list.length) {
        return {
          codes: codesFor(list[0]),
          name: list[0],
          candidates: list,
          certainty: 'unnumbered',
        };
      }
      return null;
    }

    // Split a cleaned line into the readings it is built from. Determinatives
    // are signs like any other, so their braces are simply separators; "-" and
    // "." both join readings within a word and neither survives into `signs`.
    //
    // A sign written by name — |EN×GAN₂@t| — has to survive whole, because the
    // dots and multiplication signs inside it are part of the name, not joins.
    function readingsOf(line) {
      const parts = [];
      const pushWords = (chunk) => {
        // "+" joins signs the same way "-" does — ŠU+MIN is two signs — and it
        // also opens a phonetic gloss, {+ti₃}. Splitting on it serves both.
        for (const token of chunk.split(/[\s\-.+]+/)) {
          if (token.trim()) parts.push(token.trim());
        }
      };

      // Two things must survive the splitter whole: a sign written by name, and
      // a punctuation mark. ":" and ":." are different signs (P₂ and P₄), so
      // splitting the second on its dot silently turns one into the other.
      const atomic = /\|[^|]+\||:[.:]*/g;
      let last = 0;
      let match;
      while ((match = atomic.exec(line)) !== null) {
        pushWords(line.slice(last, match.index));
        parts.push(match[0]);
        last = match.index + match[0].length;
      }
      pushWords(line.slice(last));
      return parts;
    }

    function clean(line) {
      return String(line)
        .replace(LINE_NUMBER, '')
        .replace(OMITTED, ' ')
        .replace(LANGUAGE_SHIFT, ' ')
        .replace(COLUMN_SEPARATOR, ' ')
        .replace(STRUCTURAL, '')
        .replace(FLAGS, '')
        // Parentheses mark a trace as doubtful — "(x)" — without changing what
        // is written. The sign inside stays.
        .replace(/[()]/g, ' ')
        .replace(/[{}]/g, ' ');
    }

    // Convert one ATF line.
    //
    // Returns { codes, tokens, unresolved }:
    //   codes       the sign stream, directly comparable with a `signs` line
    //   tokens      one entry per reading, carrying its certainty and any
    //               competing signs — a matcher can accept the whole candidate
    //               set at a position rather than committing here
    //   unresolved  readings no sign could be found for
    function convertLine(atfLine) {
      const codes = [];
      const tokens = [];
      const unresolved = [];

      for (const reading of readingsOf(clean(atfLine))) {
        // A wholly unknown sign, and a number whose value is not preserved.
        if (reading === 'x' || reading === 'X') {
          codes.push(UNKNOWN);
          tokens.push({ reading, codes: [UNKNOWN], certainty: 'unknown' });
          continue;
        }
        if (reading === 'n' || reading === 'N') {
          codes.push(NUMBER_PLACEHOLDER);
          tokens.push({ reading, codes: [NUMBER_PLACEHOLDER], certainty: 'unknown' });
          continue;
        }

        // "MAH/MAH₂" is an editor undecided between two readings, and eBL keeps
        // both: the token it emits is the two sign codes joined by a slash,
        // e.g. ABZ57/ABZ298. One token, not two.
        if (reading.includes('/')) {
          const sides = reading.split('/').map((side) => resolve(side));
          if (sides.every(Boolean)) {
            const joined = sides.map((s) => s.codes.join(' ')).join('/');
            codes.push(joined);
            tokens.push({
              reading,
              codes: [joined],
              candidates: sides.flatMap((s) => s.candidates),
              certainty: 'either',
            });
            continue;
          }
        }

        const hit = resolve(reading);
        if (!hit) {
          codes.push(UNKNOWN);
          tokens.push({ reading, codes: [UNKNOWN], certainty: 'unresolved' });
          unresolved.push(reading);
          continue;
        }
        codes.push(...hit.codes);
        tokens.push({ reading, ...hit });
      }

      return { codes, tokens, unresolved };
    }

    // "KAM@v" is KAM written in a variant form. Some qualifiers do name a
    // distinct sign (AB@g is its own entry), so this is only a fallback for
    // when the qualified form is not in the table.
    function stripModifier(reading) {
      return reading.replace(/@[a-z0-9]+/gi, '');
    }

    // Numerals the table names — "30" is |U.U.U| — expand into their signs.
    // The rest keep their digits: eBL emits those verbatim, and they are 1.5%
    // of the corpus, so a number it cannot name is data rather than a failure.
    function resolve(reading) {
      const hit = lookup(reading) || lookup(stripModifier(reading));
      if (hit) return hit;
      if (/^\d+$/.test(reading)) {
        return { codes: [reading], name: reading, candidates: [reading], certainty: 'number' };
      }
      return null;
    }

    // Convert a whole ATF document, emitting one line of codes per text line so
    // the result lines up with a `signs` string.
    function convertAtf(atf) {
      const lines = [];
      const unresolved = [];
      for (const raw of String(atf || '').split('\n')) {
        if (!LINE_NUMBER.test(raw)) continue;
        const line = convertLine(raw);
        lines.push(line.codes.join(' '));
        unresolved.push(...line.unresolved);
      }
      return { signs: lines.join('\n'), lines, unresolved };
    }

    return { convertLine, convertAtf, lookup, decompose, readingsOf, clean };
  }

  return { create, UNKNOWN, NUMBER_PLACEHOLDER };
});
