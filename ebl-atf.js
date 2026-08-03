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
  //   manuscriptsMeta:      manuscripts.json contents (must include `manuscripts` array)
  //   eblSiglumByFile:      { [filename without .txt | "siglum"]: full eBL siglum string }
  //
  // Output:
  //   { atf: "<text>", lineMap: [<lineEntry>, ...] }
  //
  // Each lineMap entry has { row, kind, lineNum, ...kind-specific fields }.
  // `row` is the 0-based row in the produced ATF buffer. kind ∈
  //   "blank"
  //   "reconstruction"  { row, kind, lineNum, content }
  //   "witness"         { row, kind, lineNum, eblSiglum, msKey, sourceLine, content }
  // Indent prefix on every witness row. Stripped before POST.
  const WITNESS_INDENT = '  ';
  const WITNESS_SIGLUM_MIN_WIDTH = 8;
  const WITNESS_LINENUM_MIN_WIDTH = 3;

  async function buildChapterAtf({ scoreLines, reconstructedLines, manuscriptsMeta, eblSiglumByFile }) {
    const lineNums = Object.keys(scoreLines || {}).map(Number).sort((a, b) => a - b);
    const lines = [];
    const lineMap = [];

    // Build a stable order for witnesses within a §N block.
    const idByKey = new Map();
    for (const m of (manuscriptsMeta?.manuscripts || [])) {
      const key = (m.file || '').replace(/\.txt$/, '');
      if (key) idByKey.set(key, m.id || 9999);
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
      // Reconstruction line (no indent — it's the §N header for the block)
      const recon = (reconstructedLines && reconstructedLines[n]) || '';
      lineMap.push({ row: lines.length, kind: 'reconstruction', lineNum: n, content: recon });
      lines.push(`${n}. ${recon}`);

      // Witness lines — ordered by eBL manuscript id
      const witnesses = (scoreLines[n] || []).filter((w) => w.type === 'line');
      const sorted = [...witnesses].sort(witnessSort);
      for (const w of sorted) {
        const eblSiglum = (eblSiglumByFile && eblSiglumByFile[w.siglum]) || w.siglum;
        const content = w.content || '';
        lineMap.push({
          row: lines.length,
          kind: 'witness',
          lineNum: n,
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
              eblSiglum,
              msKey: w.siglum,
              sourceLine: w.sourceLine,
              content: cont,
            });
            lines.push(formatContinuation(cont));
          }
        }
      }

      // Blank separator between blocks
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
  //     reconstructionEdits: [{ lineNum, oldContent, newContent }],
  //     witnessEdits:        [{ lineNum, msKey, sourceLine, oldContent, newContent }],
  //     unmatched:           [{ row, oldText, newText }]   // line count drift, etc.
  //   }
  function diffArtifact(originalLineMap, originalAtf, editedAtf) {
    const oldRows = originalAtf.split('\n');
    const newRows = editedAtf.split('\n');

    const reconstructionEdits = [];
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
            oldContent: entry.content,
            newContent: parsed.content,
          });
        } else {
          unmatched.push({ row: r, oldText: old, newText: nw });
        }
      } else if (entry.kind === 'witness') {
        const parsed = parseWitnessRow(nw);
        if (parsed && parsed.eblSiglum === entry.eblSiglum && String(parsed.sourceLine) === String(entry.sourceLine)) {
          witnessEdits.push({
            lineNum: entry.lineNum,
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

    return { reconstructionEdits, witnessEdits, unmatched };
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
    parseWitnessRow,
    applyWitnessEditToManuscript,
    buildEblSiglumMap,
  };
})();
