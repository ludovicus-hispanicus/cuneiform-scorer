// ===========================================
// eBL ATF artifact compiler / parser
// ===========================================
// Takes the scorer's score state and emits the eBL ATF text that
// POST /texts/.../chapters/.../import expects. Also parses an edited
// artifact back into per-line edit ops so we can sync witness corrections
// to the underlying manuscript files.

(function () {
  // ---- Build ----

  // Build the eBL ATF artifact for a chapter.
  //
  // Inputs:
  //   scoreLines:           { [lineNum]: witness[] } from parseManuscript/buildScore
  //   reconstructedLines:   { [lineNum]: string }
  //   translationLines:     { [lineNum]: string }
  //   noteLines:            { [lineNum]: string }
  //   parallelLines:        { [lineNum]: string[] }
  //   variantLines:         { [lineNum]: [{ text, note, parallels }] }  (readings 1..n)
  //   manuscriptsMeta:      manuscripts.json contents (must include `manuscripts` array)
  //   eblSiglumByFile:      { [filename without .txt | "siglum"]: full eBL siglum string }
  //
  // Output:
  //   { atf: "<text>", lineMap: [<lineEntry>, ...] }
  //
  // Each lineMap entry has { row, kind, lineNum, ...kind-specific fields }.
  // `row` is the 0-based row in the produced ATF buffer. kind ∈
  //   "blank"
  //   "translation"     { row, kind, lineNum, content, prefixed }
  //   "reconstruction"  { row, kind, lineNum, content }
  //   "note"            { row, kind, lineNum, content, prefixed }
  //   "parallel"        { row, kind, lineNum, index, content, prefixed }
  // Every entry below the translation also carries `variantIndex` — which of
  // the line's readings it belongs to (0 is the main one).
  //   "witness"         { row, kind, lineNum, eblSiglum, msKey, sourceLine, content }
  // Indent prefix on every witness row. Stripped before POST.
  const WITNESS_INDENT = '  ';
  const WITNESS_SIGLUM_MIN_WIDTH = 8;
  const WITNESS_LINENUM_MIN_WIDTH = 3;

  // A witness row, "SIGLUM  N.  content", as buildChapterAtf lays it out for
  // reading. The line number is whatever the tablet calls it — digits with
  // letters, primes, "+" and "-" around them: "18'", "3a", "6a'", "6'a",
  // "a+1", "7b-8a" are all labels this corpus actually uses. It only has to
  // hold a digit; eBL judges the rest on the way in.
  const LINE_NO = "[0-9A-Za-z'′’+-]*\\d[0-9A-Za-z'′’+-]*";
  const WITNESS_ROW = new RegExp(`^(\\S+)\\s+(${LINE_NO})\\.\\s+(.*)$`);

  // The app authors one translation per line and eBL's default language is
  // "en", so a plain string becomes an English translation line.
  const TRANSLATION_PREFIX = '#tr.en: ';
  const NOTE_PREFIX = '#note: ';
  const PARALLEL_PREFIX = '// ';

  // Whitespace a browser produces that an ATF parser does not accept.
  //
  // A contenteditable inserts a non-breaking space when you type a space in
  // certain positions, and it looks exactly like a space on screen. eBL then
  // refuses the line with "No terminal matches ' '" pointing at a column that
  // appears to hold an ordinary space. Zero-width characters do the same
  // without even occupying a column.
  const ODD_SPACE = /[   -   　]/g;
  const INVISIBLE = /[​-‍⁠﻿]/g;
  // Every value this cleans is a single ATF row — a reconstruction, a witness
  // line, a translation — so a newline inside one is never meant. A
  // contenteditable makes them easily: Enter, or a paste that brings the
  // score's own line breaks with it. Only spaces and tabs were collapsed here,
  // so a newline survived into the payload, and eBL split the reconstruction
  // on it and refused the piece after the break as a row it could not parse —
  // it was looking for the "//" that starts a parallel line.
  function normaliseAtfText(text) {
    return String(text == null ? '' : text)
      .replace(ODD_SPACE, ' ')
      .replace(INVISIBLE, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Anything a parser will not accept, named with where it sits. Reported
  // before a send, so a refusal does not have to come back from a server.
  function oddCharacters(text) {
    const found = [];
    const s = String(text == null ? '' : text);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const odd = (c < 32 && c !== 10 && c !== 9) || c === 0xa0 || c === 0xfeff
        || (c >= 0x200b && c <= 0x200d) || c === 0x2060
        || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000;
      if (odd) found.push({ at: i, code: 'U+' + c.toString(16).toUpperCase().padStart(4, '0') });
    }
    return found;
  }

  // A translation is a single ATF row — the grammar's note_text stops at a
  // newline — so anything typed across several lines collapses to one.
  function normalizeTranslation(text) {
    return String(text).replace(/\s+/g, ' ').trim();
  }

  // A line's readings as one list. The main reading lives in the three primary
  // maps and the rest in variantLines, so this flattens both into the uniform
  // shape the emitter loops over.
  function readingsFor(n, reconstructedLines, noteLines, parallelLines, variantLines) {
    const readings = [{
      text: (reconstructedLines && reconstructedLines[n]) || '',
      note: noteLines && noteLines[n],
      parallels: (parallelLines && parallelLines[n]) || [],
    }];
    for (const v of ((variantLines && variantLines[n]) || [])) {
      readings.push({
        text: (v && v.text) || '',
        note: v ? v.note : undefined,
        parallels: (v && v.parallels) || [],
      });
    }
    return readings;
  }

  async function buildChapterAtf({ scoreLines, reconstructedLines, translationLines, noteLines, parallelLines, variantLines, manuscriptsMeta, eblSiglumByFile }) {
    const lineNums = Object.keys(scoreLines || {}).map(Number).sort((a, b) => a - b);
    const lines = [];
    const lineMap = [];

    // Build a stable order for witnesses within a §N block.
    const idByKey = new Map();
    for (const m of (manuscriptsMeta?.manuscripts || [])) {
      const key = (m.file || '').replace(/\.txt$/, '');
      if (key) idByKey.set(key, m.id || 9999);
    }

    // The "$" directives in a section that belong to one manuscript, under the
    // reading it was assigned to.
    function directivesFor(entries, siglum, variantIndex) {
      return (entries || []).filter(
        (e) => e.type !== 'line' && e.siglum === siglum
               && (e.variant || 0) === variantIndex
      );
    }

    function witnessSort(a, b) {
      const ia = idByKey.get(a.siglum) ?? 9999;
      const ib = idByKey.get(b.siglum) ?? 9999;
      if (ia !== ib) return ia - ib;
      return String(a.siglum).localeCompare(String(b.siglum));
    }

    // First pass: compute max siglum width + max line-number width across
    // the whole chapter so columns line up.
    let sigWidth = WITNESS_SIGLUM_MIN_WIDTH;
    let lineWidth = WITNESS_LINENUM_MIN_WIDTH;
    for (const n of lineNums) {
      for (const w of (scoreLines[n] || [])) {
        if (w.type !== 'line') continue;
        const sig = (eblSiglumByFile && eblSiglumByFile[w.siglum]) || w.siglum || '';
        if (sig.length > sigWidth) sigWidth = sig.length;
        const src = String(w.sourceLine || '');
        if (src.length > lineWidth) lineWidth = src.length;
      }
    }

    function formatWitness(sig, srcLine, content) {
      return `${WITNESS_INDENT}${sig.padEnd(sigWidth)}  ${String(srcLine).padStart(lineWidth)}.  ${content}`;
    }
    function formatContinuation(content) {
      // Align continuation text to the content column of witness rows.
      const pad = WITNESS_INDENT.length + sigWidth + 2 + lineWidth + 3;
      return `${' '.repeat(pad)}${content}`;
    }

    for (const n of lineNums) {
      // Translation belongs to the chapter line, not to one of its readings,
      // and sits above all of them —
      //   chapter_line: [chapter_translation] line_variant (_NEWLINE line_variant)*
      // so it is emitted before the reconstruction.
      const translation = normalizeTranslation((translationLines && translationLines[n]) || '');
      if (translation) {
        // A hand-written "#tr.de: ..." is passed through as typed; anything
        // else is plain text and gets the default English prefix.
        const prefixed = !/^#tr\b/.test(translation);
        lineMap.push({ row: lines.length, kind: 'translation', lineNum: n, content: translation, prefixed });
        lines.push(prefixed ? TRANSLATION_PREFIX + translation : translation);
      }

      // One block per reading. Variants of a line are separated by a single
      // newline and each repeats the line number — eBL keeps the first
      // variant's number for the whole chapter line and discards the rest.
      const readings = readingsFor(n, reconstructedLines, noteLines, parallelLines, variantLines);
      const allWitnesses = (scoreLines[n] || []).filter((w) => w.type === 'line');

      for (let vi = 0; vi < readings.length; vi++) {
        const reading = readings[vi];

        // Reconstruction line (no indent — it's the §N header for the block)
        const recon = normaliseAtfText(reading.text || '');
        lineMap.push({ row: lines.length, kind: 'reconstruction', lineNum: n, variantIndex: vi, content: recon });
        lines.push(`${n}. ${recon}`);

        // Note, then parallels, then the witnesses — the order the grammar fixes:
        //   reconstruction: text_line [_NEWLINE note_line] (_NEWLINE parallel_line)*
        // Both belong to the reading above them, not to the chapter line.
        const note = normalizeTranslation(reading.note || '');
        if (note) {
          const prefixed = !/^#note:/.test(note);
          lineMap.push({ row: lines.length, kind: 'note', lineNum: n, variantIndex: vi, content: note, prefixed });
          lines.push(prefixed ? NOTE_PREFIX + note : note);
        }

        const parallels = reading.parallels || [];
        for (let i = 0; i < parallels.length; i++) {
          const parallel = normalizeTranslation(parallels[i]);
          if (!parallel) continue;
          const prefixed = !/^\/\//.test(parallel);
          lineMap.push({ row: lines.length, kind: 'parallel', lineNum: n, variantIndex: vi, index: i, content: parallel, prefixed });
          lines.push(prefixed ? PARALLEL_PREFIX + parallel : parallel);
        }

        // Witness lines for THIS reading — ordered by eBL manuscript id. A
        // reading is tied to a variant by the letter on its § marker; readings
        // with no letter belong to the first.
        const witnesses = allWitnesses.filter((w) => (w.variant || 0) === vi);
        const sorted = [...witnesses].sort(witnessSort);
        for (const w of sorted) {
          const eblSiglum = (eblSiglumByFile && eblSiglumByFile[w.siglum]) || w.siglum;
          const content = normaliseAtfText(w.content || '');
          lineMap.push({
            row: lines.length,
            kind: 'witness',
            lineNum: n,
            variantIndex: vi,
            eblSiglum,
            msKey: w.siglum,
            sourceLine: w.sourceLine,
            content,
          });
          lines.push(formatWitness(eblSiglum, w.sourceLine, content));

          if (Array.isArray(w.continuation) && w.continuation.length) {
            for (const cont of w.continuation) {
              lineMap.push({
                row: lines.length,
                kind: 'witness-continuation',
                lineNum: n,
                variantIndex: vi,
                eblSiglum,
                msKey: w.siglum,
                sourceLine: w.sourceLine,
                content: cont,
              });
              lines.push(formatContinuation(cont));
            }
          }

          // Notes on this manuscript line. Same paratext slot as the "$"
          // directives below, so a note here reads as a remark on this
          // witness rather than on the chapter line — the way eBL's own
          // editions use it (EAE 55 §2, where VAT.7830 carries one).
          for (const note of (Array.isArray(w.notes) ? w.notes : [])) {
            const text = normalizeTranslation(note);
            if (!text) continue;
            const prefixed = !/^#note:/.test(text);
            lineMap.push({
              row: lines.length,
              kind: 'witness-note',
              lineNum: n,
              variantIndex: vi,
              eblSiglum,
              msKey: w.siglum,
              sourceLine: w.sourceLine,
              content: text,
              prefixed,
            });
            lines.push(formatContinuation(prefixed ? NOTE_PREFIX + text : text));
          }

          // Rulings assigned to this witness. The chapter grammar allows
          // paratext after a manuscript line —
          //   manuscript_line: ... manuscript_text paratext_line*
          //   paratext_line:   _NEWLINE _WHITE_SPACE? paratext
          //   paratext:        note_line | dollar_line
          // so an indented $-line here is valid and survives the round trip.
          for (const x of directivesFor(scoreLines[n], w.siglum, vi)) {
            const directive = x.content || ((x.rulingType || 'single') + ' ruling');
            lineMap.push({
              row: lines.length,
              kind: 'witness-paratext',
              lineNum: n,
              variantIndex: vi,
              eblSiglum,
              msKey: w.siglum,
              sourceLine: w.sourceLine,
              content: directive,
            });
            lines.push(formatContinuation('$ ' + directive));
          }
        }
      } // end of readings loop — variants are separated by a single newline

      // Blank separator between chapter lines
      lineMap.push({ row: lines.length, kind: 'blank', lineNum: n });
      lines.push('');
    }

    // Trim trailing blank
    while (lines.length && lines[lines.length - 1] === '') {
      lines.pop();
      lineMap.pop();
    }

    return { atf: lines.join('\n'), lineMap };
  }

  // Strip the visual indentation/padding applied by buildChapterAtf so the
  // ATF can be POSTed to eBL. Reconstruction lines (start with a digit + ".")
  // stay as-is; witness rows ("  SIG   N. content") get leading whitespace
  // stripped and inter-column whitespace collapsed to single spaces.
  //
  // A row is recognised by WITNESS_ROW, which reads any label a tablet
  // carries. The pattern here knew only digits and a prime, so every lettered
  // row — "3a.", "6a'.", "7b-8a." — went to eBL still padded out to the
  // column widths it had been laid out with for reading.
  function stripFormatting(atfText) {
    return atfText.split('\n').map((row) => {
      if (!row.trim()) return '';
      const stripped = row.replace(/^\s+/, '');
      // Collapse internal multi-space padding between siglum and line number,
      // and between line number and content, on witness rows.
      const witness = stripped.match(WITNESS_ROW);
      if (witness) return `${witness[1]} ${witness[2]}. ${witness[3]}`;
      return stripped;
    }).join('\n');
  }

  // ---- Diff ----

  // Compare an edited artifact buffer against the original lineMap and return
  // a list of changes that should sync back to project state.
  //
  // The comparison is positional — the user is expected to edit *in place*.
  // If the user inserts/deletes whole lines, the indices drift and that line
  // will be reported as an "unmatched" change. v1 surfaces those for review
  // but does not write structural changes back (avoids reverse-parser pain).
  //
  // Returns:
  //   {
  //     reconstructionEdits: [{ lineNum, variantIndex, oldContent, newContent }],
  //     translationEdits:    [{ lineNum, oldContent, newContent }],
  //     noteEdits:           [{ lineNum, variantIndex, oldContent, newContent }],
  //     parallelEdits:       [{ lineNum, variantIndex, index, oldContent, newContent }],
  //     witnessEdits:        [{ lineNum, msKey, sourceLine, oldContent, newContent }],
  //     unmatched:           [{ row, oldText, newText }]   // line count drift, etc.
  //   }
  // Used by setWitnessVariant below. It lived beside the artifact-diff code
  // and went out with it; the caller survived, referring to a helper that no
  // longer existed, and failed only when a variant was actually moved.
  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Retarget one reading's § marker at a different variant of the same line:
  // "§34 7'." <-> "§34b 7'.". The letter is positional (b = second reading),
  // and an empty letter means the main one.
  //
  // Returns { ok: true, content } or { ok: false, reason }.
  function setWitnessVariant(msContent, { lineNum, sourceLine, letter }) {
    const lines = msContent.split('\n');
    const pattern = new RegExp(
      `^(\\s*§${lineNum})[a-z]?(\\s+${escapeRegex(String(sourceLine))}\\.)`
    );
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(pattern);
      if (m) {
        lines[i] = m[1] + (letter || '') + lines[i].slice(m[0].length - m[2].length);
        return { ok: true, content: lines.join('\n') };
      }
    }
    return { ok: false, reason: `No line matching §${lineNum} ${sourceLine}. found` };
  }

  // Move a manuscript's "$" directives to the reading its lines have moved to.
  //
  // A ruling belongs to the tablet, under the line it follows. When a witness
  // moves to a variant its reading is rewritten but its directives are not,
  // because a directive is written "§18 $ single ruling" — no line number, so
  // nothing matches the pattern that moves a reading. The ruling stayed under
  // §18 while the line it follows had gone to §18b.
  //
  // Only moved once nothing of this manuscript is left in the old reading: a
  // manuscript with lines in both still needs its ruling where its other lines
  // are, and a split that moves half a witness must not take the ruling too.
  function setDirectiveVariant(msContent, { lineNum, fromLetter, letter }) {
    const from = fromLetter || '';
    const lines = msContent.split('\n');

    // A reading of this manuscript still sitting in the reading being left.
    const stillThere = new RegExp('^\\s*§' + lineNum + (from || '') + '(?![a-z])\\s+\\S+\\.');
    for (const line of lines) {
      if (stillThere.test(line)) return { ok: false, reason: 'lines remain in the old reading' };
    }

    const directive = new RegExp(
      '^(\\s*§' + lineNum + ')' + (from ? from : '(?![a-z])')
      + '((?:\\s+[^\\s$]+)?\\s*\\$.*)$'
    );
    let moved = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(directive);
      if (!m) continue;
      lines[i] = m[1] + (letter || '') + m[2];
      moved++;
    }
    if (!moved) return { ok: false, reason: 'no directives to move' };
    return { ok: true, content: lines.join('\n'), moved };
  }

  // ---- Sigla helper ----

  // Resolve the per-manuscript eBL siglum from manuscripts.json + provenance list.
  // Returns { [msKey]: "NinNA1", ... }.
  async function buildEblSiglumMap(manuscriptsMeta, EblClient) {
    const out = {};
    for (const m of (manuscriptsMeta?.manuscripts || [])) {
      const key = (m.file || '').replace(/\.txt$/, '');
      if (!key) continue;
      out[key] = await EblClient.buildSiglumPreview(m);
    }
    return out;
  }

  // ---- One chapter line, in the shape POST /lines wants -------------------
  //
  // eBL's own chapter editor sends plain ATF strings — no reconstructionTokens,
  // no atfTokens — so a whole line with its variants and witnesses is under
  // 2 KB and can be assembled from exactly what buildChapterAtf already holds.
  // The server does the tokenizing.
  //
  // Two fields have no counterpart in the ATF form: the numeric manuscriptId,
  // and omittedWords. The first is passed in; the second cannot be authored
  // here at all, which is why `existing` matters.
  //
  // A POST replaces the WHOLE line object, so anything this app cannot express
  // is carried across from `existing` — the line as eBL currently holds it —
  // rather than silently reset. Without that, saving one line would wipe every
  // "‡" an editor had set in eBL's own UI, along with the section flags. A
  // witness whose omissions could not be carried is reported in `warnings`
  // instead of being quietly zeroed.

  // The grammar's surface_label tokens. Not the same as the app's own
  // abbreviations — eBL writes the edges with dots ("l.e.", not "le").
  const EBL_SURFACE_LABEL = {
    obverse: 'o',
    reverse: 'r',
    bottom: 'b.e.',
    edge: 'e.',
    'left edge': 'l.e.',
    'right edge': 'r.e.',
    top: 't.e.',
  };

  function prefixed(text, prefix, re) {
    const t = normalizeTranslation(text);
    if (!t) return null;
    return re.test(t) ? t : prefix + t;
  }

  // manuscriptId + surface + line number: what identifies one witness row
  // across a round trip. If any of the three was edited here the row is new as
  // far as eBL is concerned, and its omittedWords cannot follow.
  function witnessKey(manuscriptId, labels, number) {
    return [manuscriptId, (labels || []).join(' '), String(number)].join('|');
  }

  function buildChapterLine({
    lineNum,
    scoreLines,
    reconstructedLines,
    translationLines,
    noteLines,
    parallelLines,
    variantLines,
    manuscriptIdByFile,
    existing,
    omittedByKey,
  }) {
    const warnings = [];

    // What eBL holds now, indexed so each witness can find its own omissions.
    // The word count comes along because omittedWords are positions in THAT
    // reconstruction's word list: move the witness to another variant, or
    // insert a word, and the same indices point at different words.
    const carried = new Map();
    for (const v of ((existing && existing.variants) || [])) {
      const words = String(v.reconstruction || '').split('\n')[0].split(/\s+/).filter(Boolean).length;
      for (const m of (v.manuscripts || [])) {
        carried.set(witnessKey(m.manuscriptId, m.labels, m.number),
          { omittedWords: m.omittedWords || [], words });
      }
    }

    const entries = scoreLines[lineNum] || [];
    const readings = readingsFor(lineNum, reconstructedLines, noteLines, parallelLines, variantLines);
    const variants = [];

    for (let vi = 0; vi < readings.length; vi++) {
      const reading = readings[vi];

      // The reconstruction is the whole block as one string: the reading, then
      // its note, then its parallels, newline-separated — the same rows
      // buildChapterAtf emits, just not laid out.
      const rows = [normaliseAtfText(reading.text || '')];
      const note = prefixed(reading.note || '', NOTE_PREFIX, /^#note:/);
      if (note) rows.push(note);
      for (const p of (reading.parallels || [])) {
        const parallel = prefixed(p, PARALLEL_PREFIX, /^\/\//);
        if (parallel) rows.push(parallel);
      }

      // Word positions omittedWords would index into, for the check below.
      const words = String(reading.text || '').split(/\s+/).filter(Boolean).length;

      const manuscripts = [];
      for (const w of entries) {
        if (w.type !== 'line' || (w.variant || 0) !== vi) continue;

        // Both forms, for the same reason the map holds both.
        const manuscriptId = manuscriptIdByFile
          ? (manuscriptIdByFile[w.siglum] != null
             ? manuscriptIdByFile[w.siglum]
             : manuscriptIdByFile[String(w.siglum).replace(/\.txt$/, '')])
          : undefined;
        if (manuscriptId == null) {
          // Sending the line without it would drop the witness from the
          // chapter, so refuse the row and say which one.
          warnings.push(`${w.siglum} is not registered in this eBL chapter — its ${w.sourceLine} was left out.`);
          continue;
        }

        const label = EBL_SURFACE_LABEL[w.surface];
        const labels = label ? [label] : [];
        if (w.surface && !label) {
          warnings.push(`${w.siglum}: "${w.surface}" is not an eBL surface label, so ${w.sourceLine} was sent without one.`);
        }

        // Everything the witness carries, as one ATF string. eBL's own data
        // does the same: a note or a ruling follows its reading on its own row.
        const atfRows = [normaliseAtfText(w.content || '')];
        for (const cont of (w.continuation || [])) atfRows.push(cont);
        for (const n of (w.notes || [])) {
          const witnessNote = prefixed(n, NOTE_PREFIX, /^#note:/);
          if (witnessNote) atfRows.push(witnessNote);
        }
        for (const d of entries) {
          if (d.type === 'line' || d.siglum !== w.siglum || (d.variant || 0) !== vi) continue;
          atfRows.push('$ ' + (d.content || ((d.rulingType || 'single') + ' ruling')));
        }

        const number = String(w.sourceLine == null ? '' : w.sourceLine);
        const key = witnessKey(manuscriptId, labels, number);

        // An alignment made here is the better answer: it was measured against
        // THIS reading, where the carried-over one was measured against whatever
        // eBL held before. Without this the app could show a witness omitting
        // three words and still send eBL an empty list.
        const local = omittedByKey && omittedByKey[w.siglum + '|' + number];
        if (local) {
          manuscripts.push({
            manuscriptId, labels, number,
            atf: atfRows.join('\n'),
            omittedWords: local.slice(),
          });
          continue;
        }

        const was = carried.get(key);
        let omittedWords = [];
        if (was === undefined) {
          if (carried.size) {
            warnings.push(`${w.siglum} ${number}: no matching row in eBL, so any omitted words it had are not carried over.`);
          }
        } else if (!was.omittedWords.length) {
          omittedWords = [];
        } else if (was.words === words) {
          omittedWords = was.omittedWords;
        } else {
          // Same witness, different reconstruction length — the indices no
          // longer name the same words, and a wrong ‡ is worse than none.
          warnings.push(
            `${w.siglum} ${number}: the reading it sits under changed length ` +
            `(${was.words} words to ${words}), so its ${was.omittedWords.length} omitted ` +
            'word(s) were dropped rather than pointed at the wrong ones. Re-mark them in eBL.');
        }

        manuscripts.push({
          manuscriptId,
          labels,
          number,
          atf: atfRows.join('\n'),
          omittedWords,
        });
      }

      variants.push({
        reconstruction: rows.join('\n'),
        // eBL returns intertext as an array but takes "" on write.
        intertext: (existing && existing.variants && existing.variants[vi]
          && typeof existing.variants[vi].intertext === 'string')
          ? existing.variants[vi].intertext : '',
        manuscripts,
      });
    }

    const translation = prefixed(
      normaliseAtfText((translationLines && translationLines[lineNum]) || ''),
      TRANSLATION_PREFIX, /^#tr\b/);

    return {
      line: {
        number: String(lineNum),
        variants,
        // Not authored here — whatever eBL has stays.
        isSecondLineOfParallelism: !!(existing && existing.isSecondLineOfParallelism),
        isBeginningOfSection: !!(existing && existing.isBeginningOfSection),
        translation: translation || '',
        oldLineNumbers: (existing && existing.oldLineNumbers) || [],
      },
      warnings,
    };
  }

  // ---- Export ----
  window.EblAtf = {
    buildChapterAtf,
    buildChapterLine,
    stripFormatting,
    normaliseAtfText,
    oddCharacters,
    setWitnessVariant,
    setDirectiveVariant,
    buildEblSiglumMap,
  };
})();
