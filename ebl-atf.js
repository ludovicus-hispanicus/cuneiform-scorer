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

  // The app authors one translation per line and eBL's default language is
  // "en", so a plain string becomes an English translation line.
  const TRANSLATION_PREFIX = '#tr.en: ';
  const NOTE_PREFIX = '#note: ';
  const PARALLEL_PREFIX = '// ';

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
        const recon = reading.text || '';
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
          const content = w.content || '';
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
  function stripFormatting(atfText) {
    return atfText.split('\n').map((row) => {
      if (!row.trim()) return '';
      const stripped = row.replace(/^\s+/, '');
      // Collapse internal multi-space padding between siglum and line number,
      // and between line number and content, on witness rows.
      const witness = stripped.match(/^([^\s]+)\s+([0-9]+'?)\.\s+(.*)$/);
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
  function diffArtifact(originalLineMap, originalAtf, editedAtf) {
    const oldRows = originalAtf.split('\n');
    const newRows = editedAtf.split('\n');

    const reconstructionEdits = [];
    const translationEdits = [];
    const noteEdits = [];
    const parallelEdits = [];
    const witnessEdits = [];
    const unmatched = [];

    // If row count changed, we can't safely positional-diff structural inserts/deletes.
    // Walk what we can and mark drift.
    const minLen = Math.min(oldRows.length, newRows.length);

    for (let r = 0; r < minLen; r++) {
      const old = oldRows[r];
      const nw = newRows[r];
      if (old === nw) continue;

      const entry = originalLineMap[r];
      if (!entry) {
        unmatched.push({ row: r, oldText: old, newText: nw });
        continue;
      }

      if (entry.kind === 'reconstruction') {
        const parsed = parseReconstructionRow(nw);
        if (parsed && parsed.lineNum === entry.lineNum) {
          reconstructionEdits.push({
            lineNum: entry.lineNum,
            variantIndex: entry.variantIndex || 0,
            oldContent: entry.content,
            newContent: parsed.content,
          });
        } else {
          unmatched.push({ row: r, oldText: old, newText: nw });
        }
      } else if (entry.kind === 'translation') {
        const parsed = parseTranslationRow(nw);
        if (parsed) {
          translationEdits.push({
            lineNum: entry.lineNum,
            oldContent: entry.content,
            // A row this builder prefixed goes back as plain text; one the
            // user wrote as "#tr.de: ..." keeps its prefix so the next build
            // passes it through unchanged.
            newContent: entry.prefixed ? parsed.content : nw.trim(),
          });
        } else {
          unmatched.push({ row: r, oldText: old, newText: nw });
        }
      } else if (entry.kind === 'note') {
        const parsed = parseNoteRow(nw);
        if (parsed) {
          noteEdits.push({
            lineNum: entry.lineNum,
            variantIndex: entry.variantIndex || 0,
            oldContent: entry.content,
            newContent: entry.prefixed ? parsed.content : nw.trim(),
          });
        } else {
          unmatched.push({ row: r, oldText: old, newText: nw });
        }
      } else if (entry.kind === 'parallel') {
        const parsed = parseParallelRow(nw);
        if (parsed) {
          parallelEdits.push({
            lineNum: entry.lineNum,
            variantIndex: entry.variantIndex || 0,
            index: entry.index,
            oldContent: entry.content,
            newContent: entry.prefixed ? parsed.content : nw.trim(),
          });
        } else {
          unmatched.push({ row: r, oldText: old, newText: nw });
        }
      } else if (entry.kind === 'witness') {
        const parsed = parseWitnessRow(nw);
        if (parsed && parsed.eblSiglum === entry.eblSiglum && String(parsed.sourceLine) === String(entry.sourceLine)) {
          witnessEdits.push({
            lineNum: entry.lineNum,
            variantIndex: entry.variantIndex || 0,
            msKey: entry.msKey,
            sourceLine: entry.sourceLine,
            oldContent: entry.content,
            newContent: parsed.content,
          });
        } else {
          unmatched.push({ row: r, oldText: old, newText: nw });
        }
      } else {
        // continuation / blank / etc — treat edits as unmatched for v1
        unmatched.push({ row: r, oldText: old, newText: nw });
      }
    }

    if (oldRows.length !== newRows.length) {
      // Report the tail rows that have no positional counterpart
      const longer = newRows.length > oldRows.length ? newRows : oldRows;
      for (let r = minLen; r < longer.length; r++) {
        unmatched.push({
          row: r,
          oldText: oldRows[r] || '',
          newText: newRows[r] || '',
        });
      }
    }

    return { reconstructionEdits, translationEdits, noteEdits, parallelEdits, witnessEdits, unmatched };
  }

  // ---- Row parsers ----

  // Both row parsers tolerate leading whitespace (the artifact buffer pads
  // witness rows for visual alignment) and any amount of inter-column padding.

  // "12. some reconstruction text"   →  { lineNum: 12, content: "some reconstruction text" }
  function parseReconstructionRow(row) {
    const m = row.match(/^\s*(\d+)\.\s*(.*)$/);
    if (!m) return null;
    return { lineNum: parseInt(m[1], 10), content: m[2] };
  }

  // "#tr.en: If the Yoke is high"  →  { prefix: "#tr.en: ", content: "If the Yoke is high" }
  // The language and the "(extent)" of a multi-line translation are optional,
  // so a hand-written "#tr.de.(2): ..." parses too.
  function parseTranslationRow(row) {
    const m = row.match(/^\s*(#tr(?:\.[a-z]{2})?(?:\.\([^)]*\))?:\s*)(.*)$/);
    if (!m) return null;
    return { prefix: m[1], content: m[2] };
  }

  // "#note: See @bib{Hunger2019@109}"  →  { prefix: "#note: ", content: "See @bib{...}" }
  function parseNoteRow(row) {
    const m = row.match(/^\s*(#note:\s*)(.*)$/);
    if (!m) return null;
    return { prefix: m[1], content: m[2] };
  }

  // "// (MUL.APIN II iv 2)"  →  { prefix: "// ", content: "(MUL.APIN II iv 2)" }
  function parseParallelRow(row) {
    const m = row.match(/^\s*(\/\/\s*)(.*)$/);
    if (!m) return null;
    return { prefix: m[1], content: m[2] };
  }

  // "  NinNA1   5'.  content"  →  { eblSiglum: "NinNA1", sourceLine: "5'", content: "content" }
  function parseWitnessRow(row) {
    const m = row.match(/^\s*([^\s]+)\s+([0-9]+'?)\.\s+(.*)$/);
    if (!m) return null;
    return { eblSiglum: m[1], sourceLine: m[2], content: m[3] };
  }

  // ---- Apply edits ----

  // Apply a witness edit to a manuscript's raw .txt content. Looks for the
  // line `§<lineNum> <sourceLine>. <oldContent>` and replaces only the
  // content portion, preserving the prefix and any leading whitespace.
  //
  // Returns { ok: true, content: <new content> } or { ok: false, reason }.
  function applyWitnessEditToManuscript(msContent, { lineNum, sourceLine, newContent }) {
    const lines = msContent.split('\n');
    // Allow either "§N M. ..." or older "§N M ." variants
    const pattern = new RegExp(`^(\\s*§${lineNum}\\s+${escapeRegex(String(sourceLine))}\\.\\s*)(.*)$`);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(pattern);
      if (m) {
        lines[i] = m[1] + newContent;
        return { ok: true, content: lines.join('\n') };
      }
    }
    return { ok: false, reason: `No line matching §${lineNum} ${sourceLine}. found` };
  }

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

  // ---- Export ----
  window.EblAtf = {
    buildChapterAtf,
    stripFormatting,
    diffArtifact,
    parseReconstructionRow,
    parseTranslationRow,
    parseNoteRow,
    parseParallelRow,
    parseWitnessRow,
    applyWitnessEditToManuscript,
    setWitnessVariant,
    buildEblSiglumMap,
  };
})();
