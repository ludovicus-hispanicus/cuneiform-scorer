// Lemma lookup against a local copy of the eBL dictionary.
//
// Two indexes ship with the app, built by tools/build-lemma-index.mjs:
//   forms.json    form -> [lemma id]
//   glosses.json  lemma id -> guide word
//
// The forms are Oracc-style: lowercase, ASCII index digits, and signs joined by
// HYPHENS. ATF writes a compound with dots and uppercase, so ŠE.GIŠ.I₃ has to
// become še-giš-i3 before the index has anything to say about it. That single
// substitution is what makes most of this work — UDU.IDIM finds bibbu, KI.LAM
// finds mahīru, DU₃.A-BI finds kalāma.
//
// Nothing here guesses. Every candidate is a real index hit, and a word the
// index cannot place is left for the editor to search by hand.
(function () {
  'use strict';

  // Damage, uncertainty and bracket marks. None of them belong in a lookup.
  const DROP = new Set(['[', ']', '(', ')', '<', '>', '°', '⸢', '⸣', '⌈', '⌉',
    '#', '?', '!', '*', String.fromCharCode(92)]);
  const SUBSCRIPT = {
    '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
    '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  };

  let forms = null;
  let glosses = null;
  let verbRoots = { verbs: {}, likely: {} };
  let weakFirst = new Set();
  let pending = null;

  // Loaded once, on first use. ~1.6 MB together.
  //
  // roots.json is the smallest of the three and the only optional one: without
  // it the verb reading simply never fires, and everything else works as before.
  function load(base) {
    if (forms && glosses) return Promise.resolve(true);
    if (pending) return pending;
    const dir = (base || 'data/lemmas').replace(/\/+$/, '');
    pending = Promise.all([
      fetch(dir + '/forms.json').then((r) => r.json()),
      fetch(dir + '/glosses.json').then((r) => r.json()),
      fetch(dir + '/roots.json').then((r) => r.json()).catch(() => null),
    ]).then((all) => {
      forms = all[0];
      glosses = all[1];
      const r = all[2];
      if (r && r.verbs) {
        verbRoots = { verbs: r.verbs || {}, likely: r.likely || {} };
        weakFirst = new Set(r.weak || []);
      }
      pending = null;
      return true;
    }).catch((err) => {
      pending = null;
      throw err;
    });
    return pending;
  }

  // Reading -> sign name, supplied by the sign converter the app already has
  // loaded. Without it the sign rung below simply does not fire.
  let signNameOf = null;
  function setSignLookup(fn) { signNameOf = typeof fn === 'function' ? fn : null; }

  // The other names of the same sign. UD and U₄ are one sign, and an editor
  // may write either, but eBL keys only the spelling it happens to hold — so
  // GU₄.UD is in the dictionary and GU₄.U₄, the same two signs, is not.
  let signReadingsOf = null;
  function setSignReadings(fn) { signReadingsOf = typeof fn === 'function' ? fn : null; }

  // A sign written by name, as a form the dictionary might key: |KI.LAM| is
  // ki-lam. The compound signs written with × or + have no such form, and fall
  // out here rather than being mangled into one.
  function signNameToForm(name) {
    const bare = String(name || '').replace(/[|]/g, '').trim();
    if (!bare || /[×+()]/.test(bare)) return '';
    return deSubscript(bare).toLowerCase().replace(/[.]/g, '-');
  }

  function loaded() { return !!(forms && glosses); }
  function size() {
    return { forms: forms ? Object.keys(forms).length : 0,
             lemmas: glosses ? Object.keys(glosses).length : 0 };
  }

  function stripMarks(raw) {
    let out = '';
    for (const c of String(raw == null ? '' : raw)) if (!DROP.has(c)) out += c;
    return out;
  }

  function deSubscript(s) {
    let out = '';
    for (const c of s) out += (SUBSCRIPT[c] || c);
    return out;
  }

  // A word that cannot carry a lemma: a divider, a break, a bare x, an empty
  // stretch. Asking the dictionary about these only produces noise.
  function skippable(raw) {
    const s = stripMarks(raw).trim();
    if (!s) return true;
    if (/^[:;.]+$/.test(s)) return true;
    if (/^[…]+$/.test(s) || s === '...') return true;
    const meaningful = s.replace(/{[^}]*}/g, '').replace(/[xX.…\- ]/g, '');
    return meaningful.length === 0;
  }

  // The Oracc key for a word, and the pieces a fallback can chip away at.
  function oraccKey(raw, keepDeterminative) {
    let s = stripMarks(raw);
    if (!keepDeterminative) s = s.replace(/{[^}]*}/g, '');
    s = deSubscript(s).toLowerCase();
    // A compound is written with dots in ATF and with hyphens in the index.
    s = s.replace(/[.]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return s;
  }

  // eBL capitalises a proper noun and lowercases everything else, so Ea I is a
  // god and ina I is a preposition. A running text is mostly not names, so
  // within one rung the common words come first — the name is still there,
  // just not standing in front of the word the line probably wants.
  function isProperNoun(id) {
    const c = String(id || '').charAt(0);
    return !!c && c === c.toUpperCase() && c !== c.toLowerCase();
  }

  // ---- The reading layer --------------------------------------------------
  //
  // eBL's index is keyed by the SIGN, not by the reading. So DIŠ answers with
  // everything that sign can be — Ea, ana, ilu, ištēn — and šumma, which is
  // what it almost always is at the head of an omen, sits sixth.
  //
  // A rule here fires on the reading as it is actually written, and where
  // `initial` is set, only on the first word of a line. It does not replace the
  // other candidates; it puts the right one in front of them, and says why.
  //
  // Deliberately short. Each line is a claim about how a sign is read, and a
  // wrong one is worse than none — it would be prefilled everywhere without
  // anybody looking. Add to it only where the convention is not in doubt.
  const READINGS = [
    { form: 'diš', initial: true, ids: ['šumma I'], why: 'DIŠ opening a line' },
  ];

  function readingRule(form, context) {
    for (const r of READINGS) {
      if (r.form !== form) continue;
      if (r.initial && !(context && context.initial)) continue;
      if (!r.ids.every((id) => glosses && Object.prototype.hasOwnProperty.call(glosses, id))) continue;
      return r;
    }
    return null;
  }

  // A month is written {iti} plus a sign, and the sign has more than one
  // accepted reading — {iti}BARA₂ and {iti}BAR₂ are the same month, written by
  // different editors. eBL's index keys only one of them, so the others are
  // spelled out here. Without this, {iti}BARA₂ falls through to the bare sign
  // and comes back parakku, "cult dais", which is the right word for BARA₂ and
  // the wrong word for the month.
  //
  // The determinative itself is ITI = |UD×(U.U.U)| (ABZ 52), UD holding three
  // U signs — thirty days.
  const MONTH_FORMS = {
    bara2: 'bar2', bara: 'bar2', bar2: 'bar2', bar: 'bar',
    gu4: 'gu4', gud: 'gu4',
    sig4: 'sig4', sig: 'sig',
    šu: 'šu', su: 'šu',
    ne: 'ne', izi: 'ne',
    kin: 'kin',
    du6: 'du6', dul: 'du6',
    apin: 'apin',
    gan: 'gan', gan2: 'gan',
    ab: 'ab', ab2: 'ab',
    ziz2: 'ziz2', ziz: 'ziz2',
    še: 'še', sze: 'še',
    'diri-še': 'diri-še', diri: 'diri-še',
  };

  // The determinative a word opens with, and what follows it.
  function splitDeterminative(raw) {
    const s = stripMarks(raw);
    const m = /^{([^}]*)}(.*)$/.exec(s);
    if (!m) return null;
    return { det: deSubscript(m[1]).toLowerCase(), rest: m[2] };
  }

  // The same form written without its diacritics.
  //
  // A text may write sarru for šarru, tupsarru for ṭupšarru, ekallu for ēkallu
  // — the macrons and the under-dots are an editor's convention, not part of
  // the spelling, and they are exactly what a keyboard makes hard. Folding both
  // sides lets either reach the other.
  //
  // Built once, on the first fold-lookup, and only consulted when the form as
  // written finds nothing: an exact match must always win.
  let foldedForms = null;
  function foldedIndex() {
    if (foldedForms) return foldedForms;
    foldedForms = Object.create(null);
    for (const form of Object.keys(forms)) {
      // Every form, including the ones that fold to themselves: a text may
      // write ēkallu where the index keys the plain ekallu, and that lookup
      // has to find its way home too.
      const f = fold(form);
      if (!f) continue;
      if (!foldedForms[f]) foldedForms[f] = [];
      for (const id of forms[form]) {
        if (foldedForms[f].indexOf(id) < 0) foldedForms[f].push(id);
      }
    }
    return foldedForms;
  }

  function hit(key, how, prefer) {
    let ids = forms[key];
    let how2 = how;
    if (!ids || !ids.length) {
      const folded = foldedIndex()[fold(key)];
      if (!folded || !folded.length) return null;
      ids = folded;
      how2 = how === 'as written' ? 'ignoring the diacritics'
        : how + ', ignoring the diacritics';
    }
    const rank = (id) => {
      // A rung can say what it is looking for. Under {iti} that is a month,
      // and eBL lists {iti}ab under the brazier before the month.
      if (prefer && prefer(id)) return -1;
      return isProperNoun(id) ? 1 : 0;
    };
    const ranked = ids.slice().sort((a, b) => rank(a) - rank(b));
    return { key, how: how2, ids: ranked };
  }

  // Does this lemma read like a month name?
  const MONTH_NAMES = new Set(['nisanu', 'nisannu', 'ayyāru', 'ayyaru', 'simānu', 'simanu',
    "du'ūzu", 'duʾūzu', 'abu', 'elūnu', 'ulūlu', 'tašrītu', 'tašritu', 'arahsamna',
    'araḫsamna', 'kislīmu', 'kislimu', 'ṭebētu', 'tebetu', 'šabāṭu', 'šabatu',
    'adaru', 'addaru', 'diri-addari']);
  function looksLikeMonth(id) {
    if (/month/i.test(glosses[id] || '')) return true;
    const name = String(id).replace(/ [IVX]+$/, '').toLowerCase();
    return MONTH_NAMES.has(name);
  }



  // ---- this project's own dictionary --------------------------------------
  //
  // An edition settles readings the general dictionary cannot. In EAE 56 IGI is
  // always amāru, and so is IGI-ir; in another text it is just as certainly the
  // eye. That is not a fact about Akkadian, it is a decision about this corpus,
  // and it belongs to the project rather than to the shipped index.
  //
  // These outrank everything. Not because they are more likely — because they
  // were chosen, and a choice already made should not have to be made again on
  // every line.
  let glossary = Object.create(null);

  // Keyed the way the ladder keys everything else, so a written IGI-IR and an
  // entry typed igi-ir are the same entry.
  function glossaryKey(form) {
    return oraccKey(String(form == null ? '' : form).trim(), true) || '';
  }

  function setGlossary(entries) {
    glossary = Object.create(null);
    if (!entries) return 0;
    let n = 0;
    for (const form of Object.keys(entries)) {
      const held = entries[form];
      const ids = Array.isArray(held) ? held : ((held && held.ids) || []);
      const key = glossaryKey(form);
      if (!key || !ids.length) continue;
      glossary[key] = ids.slice();
      n++;
    }
    return n;
  }

  function glossaryEntries() {
    const out = {};
    for (const key of Object.keys(glossary)) out[key] = glossary[key].slice();
    return out;
  }

  // What this project says a word is, whole. A compound logogram spells two
  // words with one writing — UTU.È is ṣīt šamši, sunrise, and carries both
  // ṣītu and šamšu — so the answer is a list, and all of it belongs on the
  // token. The shipped index cannot express this: it maps a form to every
  // lemma that claims it, which for UTU is five alternatives and for UTU.È is
  // the two halves of one phrase, and nothing distinguishes the two cases.
  function glossaryFor(raw) {
    const ids = glossary[oraccKey(raw, true)] || glossary[oraccKey(raw, false)];
    return ids && ids.length ? ids.slice() : null;
  }

  // Every reading of the word this project has an opinion about. The same keys
  // the ordinary ladder would try, so a project entry on igi is found for
  // IGI-ir too — a phonetic complement does not make it a different word.
  function glossaryProbe(raw) {
    if (!raw) return [];
    const withDet = oraccKey(raw, true);
    const plain = oraccKey(raw, false);
    const keys = [];
    const push = (k, how) => { if (k && !keys.some((x) => x[0] === k)) keys.push([k, how]); };
    push(withDet, 'this project reads it so');
    push(plain, 'this project reads it so');
    const spelled = (plain || '').split('-').map((p) => p.replace(/[0-9]+$/, '')).join('');
    push(spelled, 'this project reads it so');

    const parts = plain ? plain.split('-') : [];
    for (let cut = 1; cut < parts.length; cut++) {
      const head = parts.slice(0, parts.length - cut).join('-');
      push(head, 'this project reads ' + head.toUpperCase().replace(/-/g, '.') + ' so');
      const tail = parts.slice(cut).join('-');
      push(tail, 'this project reads ' + tail.toUpperCase().replace(/-/g, '.') + ' so');
    }

    const out = [];
    for (const [key, how] of keys) {
      const ids = glossary[key];
      if (ids && ids.length) out.push({ key, how, ids: ids.slice(), fromProject: true });
    }
    return out;
  }

  // ---- reading a word as a verb -------------------------------------------
  //
  // Two layers, because either one alone is wrong.
  //
  // The first asks whether the word even begins like a finite verb. Akkadian
  // marks the person on the front — i-, u-, ta-, ni-, li-, uš- — so a word
  // starting with none of them is not a form this can help with, and inventing
  // a root for it invents a relationship that is not there.
  //
  // The second reduces what is left to its consonants and looks for an
  // infinitive built on the same ones. That needs no conjugation table at all:
  // the dictionary already holds parāsu, lapātu and šalālu, and a root is
  // precisely what an infinitive and every form of it have in common. It also
  // answers the verbs a generated table cannot, because eBL records no root
  // for them — amāru and epēšu among them.
  //
  // Logographic writings never reach here. Handed GAR-an, a conjugator reads
  // ga-ra-an and answers qarānu with some confidence, when GAR is šakānu. The
  // gate on the writing is the whole difference between a suggestion and a
  // fabrication.
  const VOWELS = 'aeiouāēīūâêîû';

  // Doubling is written but is not a second radical, and it has to go before
  // the vowels do: strip them first and šalālu becomes šl, not šll.
  function bareSpelling(s) {
    return String(s || '').normalize('NFC').toLowerCase()
      .replace(/[^a-zāēīūâêîûšṣṭḫĝʾ']/g, '')
      .replace(/(.)\1+/g, '$1');
  }
  // The spelling with nothing but its letters — gemination kept, because that
  // is the evidence being read.
  function letters(s) {
    return String(s || '').normalize('NFC').toLowerCase()
      .replace(/[^a-zāēīūâêîûšṣṭḫĝʾ']/g, '');
  }
  function consonantsOf(s) {
    return bareSpelling(s).split('').filter((c) => VOWELS.indexOf(c) < 0).join('');
  }

  // Layer one. Everything Akkadian puts in front of a finite verb, longest
  // first so uš- is not read as u-.
  const VERB_PREFIX = /^(?:tuš|nuš|uš|li|lu|ta|tu|te|ni|nu|i|u|a|e)/;
  function looksLikeVerb(joined) {
    const word = bareSpelling(joined);
    if (word.length < 4) return false;
    const m = VERB_PREFIX.exec(word);
    if (!m) return false;
    // Something has to be left to be a root.
    return consonantsOf(word.slice(m[0].length)).length >= 2;
  }

  // How far a lemma is from the word as written, once a prefix is allowed for.
  // Folded, so a macron in the dictionary does not count against a text that
  // writes none. This is what keeps išdī — the plural of išdu, a noun that
  // merely starts like a verb — from being offered šadû.
  function distance(a, b) {
    const prev = [];
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const t = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1,
          diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = t;
      }
    }
    return prev[b.length];
  }
  function nearness(id, written) {
    const lemma = fold(String(id).replace(/\s+[IVX]+$/, ''));
    const word = fold(bareSpelling(written));
    let best = Infinity;
    // The written form carries a prefix the infinitive does not, so the
    // comparison starts wherever it fits best.
    for (let i = 0; i <= 3 && i < word.length; i++) {
      best = Math.min(best, distance(lemma, word.slice(i)));
    }
    return best / Math.max(1, lemma.length);
  }
  // eBL records the aleph for the verbs it calls verbs ('lk for alāku). For the
  // entries it records no part of speech for, a G infinitive that opens with a
  // vowel is that same thing said differently — epēšu, erēbu, abālu.
  function isWeakFirst(id) {
    if (weakFirst.has(id)) return true;
    return VOWELS.indexOf(String(id).normalize('NFC').toLowerCase()[0]) >= 0;
  }

  // Beyond this the shared consonants are a coincidence. Measured: 0.6 keeps
  // ulappat -> lapātu and irbi -> erbû, and drops išdī -> šadû.
  const ROOT_LIMIT = 0.6;

  // Layer two. A form may hide its root behind the Š marker and the perfect
  // infix, so those two consonants may be skipped — but nothing else may.
  const VERB_ENCLITIC = /(?:ma|šu|ša|ši|šunu|šina|šim|šum|ka|ki|kum|ni|nu|am|nim)$/;
  function verbCandidates(joined, tier) {
    if (!looksLikeVerb(joined)) return [];
    const index = verbRoots[tier] || {};

    // The word as written and, separately, the word with an enclitic taken
    // off. Both are measured against every candidate and the closer reading
    // wins: iṣ-ru-ur-ma is two letters further from ṣarāru than iṣ-ru-ur is,
    // and that difference alone was enough to lose it.
    const stems = [joined];
    const cut = String(joined).replace(VERB_ENCLITIC, '');
    if (cut && cut !== joined && consonantsOf(cut).length >= 2) stems.push(cut);

    const assimilated = new RegExp('^[aeiou](.)' + String.fromCharCode(92) + '1').test(letters(joined));

    const found = [];
    const seenRoot = new Set();
    for (const stem of stems) {
      const c = consonantsOf(stem);
      for (let k = 0; k <= 2 && k < c.length; k++) {
        if (k && 'štn'.indexOf(c[k - 1]) < 0) break;
        for (const n of [3, 2]) {
          const root = c.slice(k, k + n);
          // What follows the root is an ending, not another radical.
          if (root.length !== n || c.length - k > n + 1) continue;
          if (!index[root] || seenRoot.has(root)) continue;
          const ids = index[root]
            .map((id) => {
              let off = Math.min.apply(null, stems.map((st) => nearness(id, st)));
              // A consonant doubled straight after the prefix is an aleph that
              // assimilated into it, so the verb is one whose root begins with
              // that aleph: il-la-ka is alāku, ip-pu-uš is epēšu. Without this
              // the shorter lakû sits closer to the spelling and wins, which is
              // how two of the commonest verbs in Akkadian were being missed.
              // Only where the doubled consonant is the root's own first
              // radical and the root came out defective. A doubling can also
              // be the n of an N stem assimilating — iš-šal-lal is šalālu, not
              // alālu — and there the three radicals are all present and need
              // no aleph to account for them.
              if (assimilated && k === 0 && n === 2 && isWeakFirst(id)) off *= 0.6;
              return { id, off };
            })
            .filter((x) => x.off <= ROOT_LIMIT)
            .sort((a, b) => a.off - b.off);
          // Only a root that actually answered is spent. Marking one seen on
          // the strength of a bucket whose every entry was then rejected is
          // what stopped the second stem from ever being tried.
          if (!ids.length) continue;
          seenRoot.add(root);
          found.push({ root, ids: ids.map((x) => x.id), drop: k, off: ids[0].off });
        }
      }
    }
    // The closest reading first, and among equals the one that assumed least.
    found.sort((a, b) => a.off - b.off || a.drop - b.drop);
    return found;
  }


  // Every way this word might be found, best first. Each rung says how it was
  // reached, so the editor can see whether a candidate came from the word as
  // written or from something trimmed off it.
  function probe(raw, context) {
    const tries = [];
    const out = [];

    // The project's own dictionary before anything else, including the
    // reading layer: a decision recorded for this edition is not a guess to be
    // weighed against others.
    for (const h of glossaryProbe(raw)) out.push(h);

    // The reading layer speaks first when it has anything to say.
    const rule = readingRule(oraccKey(raw, false), context);
    if (rule) out.push({ key: rule.form, how: rule.why, ids: rule.ids.slice() });
    const withDet = oraccKey(raw, true);
    const plain = oraccKey(raw, false);

    // Under {iti} this is a month, and that holds however the word is reached:
    // eBL lists {iti}ab under the brazier first, and the brazier is not what a
    // date is talking about.
    const det = splitDeterminative(raw);
    const monthly = (det && det.det === 'iti') ? looksLikeMonth : null;

    if (withDet) tries.push([withDet, 'as written', monthly]);

    // The month again, by another reading of the sign, for the writings eBL
    // does not key — {iti}BARA₂ against its {iti}bar2.
    if (det && det.det === 'iti') {
      const body = oraccKey(det.rest, false);
      const alias = MONTH_FORMS[body];
      if (alias) tries.push(['{iti}' + alias, 'as a month', looksLikeMonth]);
      // A fuller writing, {iti}gu4-si-sa2 beside {iti}gu4.
      if (body && body !== alias) tries.push(['{iti}' + body, 'as a month', looksLikeMonth]);
    }

    if (plain && plain !== withDet) tries.push([plain, 'without the determinative']);

    // A syllabic spelling, read as the word it spells.
    //
    // The index keys words, not spellings: ša₂-ru-ru is three signs on the
    // tablet and one word, šarūru, in the dictionary. Joining them is what
    // finds it — and the sign-index digits have to go with the hyphens, since
    // ša₂ and ša are the same syllable and only one of them is a word.
    //
    // This is tried before anything is trimmed. Otherwise ša₂-ru-ru loses its
    // last two signs and comes back as ša₂ — a single sign standing for a
    // word it does not spell, which is how it answered mahāru.
    const spelled = joinSyllables((plain || '').split('-'));
    // Only for a word written out in syllables. Joining GU₄.U₄ makes gu, which
    // is a word and not this one: a logogram spells a word per sign, so running
    // its signs together says nothing about what it means.
    const written = String(raw || '').replace(/\{[^}]*\}/g, '');
    const syllabicWriting = written && written === written.toLowerCase();
    if (spelled && spelled !== plain && syllabicWriting) {
      tries.push([spelled, 'read as one word']);
    }

    // The same sign under another of its readings. GANBA and KI.LAM are one
    // sign, |KI.LAM|, and the dictionary keys it as ki-lam — so a text writing
    // GANBA finds nothing until the sign is asked what else it is called.
    if (plain && signNameOf) {
      let name = null;
      try { name = signNameOf(plain); } catch (_) { name = null; }
      const asForm = signNameToForm(name);
      if (asForm && asForm !== plain) {
        tries.push([asForm, 'the same sign, written ' + asForm.toUpperCase().replace(/-/g, '.')]);
      }
    }

    // The same signs under another of their names, one sign at a time. Only
    // one, because two substitutions at once stop being the same word read
    // differently and start being a different word.
    if (signReadingsOf) {
      const signs = plain ? plain.split('-') : [];
      let made = 0;
      for (let i = 0; i < signs.length && made < 6; i++) {
        let siblings = null;
        try { siblings = signReadingsOf(signs[i]); } catch (_) { siblings = null; }
        for (const sib of (siblings || [])) {
          if (sib === signs[i] || made >= 6) continue;
          const alt = signs.slice();
          alt[i] = sib;
          const key = alt.join('-');
          // Only a substitution that lands on an entry counts. A sign can have
          // a hundred readings, and enumerating them all would both swamp the
          // ladder and spend the budget on the first sign before reaching the
          // one that needed it — which is how GU₄.U₄ went on missing GU₄.UD.
          if (!forms[key] || !forms[key].length) continue;
          tries.push([key,
            'the same sign, with ' + signs[i].toUpperCase() + ' written ' + sib.toUpperCase()]);
          made++;
        }
      }
    }

    // The word with its endings taken off, once they are proved to leave a
    // real word behind. Before the trims, because this knows where the seam is
    // and trimming only guesses.
    const chain = sandhiChain(spelled || plain);
    if (chain) {
      tries.push([chain.stem, 'without ' + chain.forms.map((f) => '-' + f).join(' and ')]);
    }

    const trims = [];
    const parts = plain ? plain.split('-') : [];
    // Trimmed a piece at a time, and the smallest trim wins. A phonetic
    // complement trails (IGI-ir is IGI) and a classifier leads (ŠE.GIŠ.I₃ is
    // found under giš-i3), so both ends are tried at each width before either
    // is widened — otherwise ŠE.GIŠ.I₃ reaches bare ŠE, which is a different
    // word entirely, before it ever reaches sesame.
    for (let cut = 1; cut < parts.length; cut++) {
      const head = parts.slice(0, parts.length - cut).join('-');
      if (head) trims.push([head, 'without ' + parts.slice(parts.length - cut).join('-')]);
      const tail = parts.slice(cut).join('-');
      if (tail) trims.push([tail, 'without ' + parts.slice(0, cut).join('-')]);
    }
    // A syllabic spelling joined up: šum-ma as šumma.
    if (parts.length > 1) trims.push([parts.join(''), 'syllables joined']);

    const seen = new Set();
    const run = (list) => {
      for (const [key, how, prefer] of list) {
        if (seen.has(key)) continue;
        seen.add(key);
        const h = hit(key, how, prefer);
        if (h) out.push(h);
      }
    };
    // Everything that reads the word as it stands comes first: a form the
    // dictionary holds is a fact, and nothing inferred should displace one.
    run(tries);

    // Then, for a word written out in syllables, what verb it could be a form
    // of — placed AHEAD of the trims, and this is what layer one is for.
    // Trimming asks what is left of a word when pieces are taken off it, and
    // for a finite verb the answer is worthless: u₂-lap-pat gives up lap-pat
    // and comes back šammu, a plant. Once the shape says this is a verb, a
    // root built on all of its consonants is worth more than a noun that
    // survives losing two thirds of them.
    //
    // A determinative rules it out before anything else is asked: a classifier
    // is attached to a noun, so {d}+en-lil₂ is a name, not a form of alālu.
    const body = String(raw || '').replace(/\{[^}]*\}/g, '');
    const syllabic = body && body === body.toLowerCase() && !splitDeterminative(raw);
    // What eBL calls a verb is asked first, and the entries with no part of
    // speech recorded only when that has nothing: iṣṣūru, a bird, has the shape
    // of an infinitive and must not outrank ṣarāru for iṣ-ru-ur.
    if (syllabic) {
      // Both tiers, certain one first: epēšu and petû are recorded with no
      // part of speech at all, and they are too common to leave out.
      const found = verbCandidates(spelled || plain, 'verbs')
        .concat(verbCandidates(spelled || plain, 'likely'));
      for (const f of found) {
        if (!f.ids.length) continue;
        out.push({
          key: f.root,
          how: 'read as a verb of the root ' + f.root.split('').join('-'),
          ids: f.ids.slice(),
          inferred: true,
        });
      }
    }

    run(trims);
    return out;
  }


  // Syllables joined into the word they spell.
  //
  // A syllabary writes one sound twice at a join: qa-as is /qas/, not /qaas/,
  // because the CV sign and the VC sign share their vowel. Joining without
  // that gives qaassu for qāssu, which is in no dictionary. Doubled CONSONANTS
  // across a join are real — as-su is /assu/ — so only a repeated vowel is
  // collapsed.
  const SHARED = 'aeiouāēīūâêîû';
  function joinSyllables(parts) {
    let out = '';
    for (const raw of parts) {
      const piece = String(raw).replace(/[0-9]+$/, '');
      if (!piece) continue;
      const last = out.slice(-1);
      const first = piece.slice(0, 1);
      if (out && last && first && fold(last) === fold(first) && SHARED.indexOf(first) >= 0) {
        out += piece.slice(1);
      } else {
        out += piece;
      }
    }
    return out;
  }

  // ---- endings written into the word ---------------------------------------
  //
  // A word can carry several endings at once, and Akkadian does not always
  // leave a seam where they join. ṣerressu is ṣerretu and -šu, with the t of
  // the base and the š of the suffix run together into ss; iddinaššumma is a
  // verb, the ventive -am, the dative -šum and the enclitic -ma, four things in
  // one word. The hyphenated reading finds the seams only where a scribe left
  // them, which is why this exists.
  //
  // Peeled from the outside in, which is the order they were added: -ma last of
  // all, then the pronoun or the dative, then the ventive.
  //
  // eBL keeps each of these as its own lemma, so the answer is a list of ids —
  // exactly what a token there holds.
  const BOUND_ENDINGS = [
    ['šunūti', '-šunūti I'], ['šunūši', '-šunūši I'], ['šināti', '-šināti I'],
    ['šināši', '-šināši I'], ['kunūti', '-kunūti I'], ['kunūši', '-kunūši I'],
    ['niāšim', '-niāšim I'], ['kināti', '-kināti I'], ['šunīti', '-šunīti I'],
    ['niāti', '-niāti I'], ['šunu', '-šunu I'], ['šina', '-šina I'],
    ['kunu', '-kunu I'], ['šum', '-šum I'], ['šim', '-šim I'], ['kim', '-kim I'],
    ['šu', '-šu I'], ['ša', '-ša I'], ['ši', '-ši I'],
    ['ka', '-ka I'], ['ki', '-ki I'], ['ya', '-ya I'],
  ];
  // The ventive. Not a pronoun, but written in the same place and just as
  // capable of hiding the end of the word underneath it.
  const VENTIVE = [['nim', '-nim I'], ['am', '-am I']];

  // What a š becomes when the base ends in a dental or a sibilant: ṣerret + šu
  // is written ṣerressu. So the suffix may arrive spelled with s, and the
  // consonant it swallowed has to be put back before the base can be found.
  const SWALLOWED = ['t', 'ṭ', 'd', 's', 'ṣ', 'z'];

  function endingAlternatives(spelling) {
    const out = [spelling];
    if (spelling[0] === 'š') out.push('s' + spelling.slice(1));
    return out;
  }

  // Every base the stem could be, once what assimilated into the ending is
  // given back. A noun is keyed in its dictionary form, so the bound ṣerret
  // has to be offered as ṣerretu as well.
  function baseForms(stem, assimilated) {
    const out = [];
    const add = (w) => { if (w && out.indexOf(w) < 0) out.push(w); };
    add(stem);
    add(stem + 'u');
    add(stem + 'um');
    if (!assimilated) return out;
    // The doubling sits on the join, and a scribe may write it with one sign
    // or two: ṣer-re-su and ṣer-res-su are the same word. So the swallowed
    // consonant is put back both onto the stem and in place of its last sign.
    const short = stem.slice(0, -1);
    for (const c of SWALLOWED) {
      for (const root of [stem + c, short + c]) {
        add(root);
        add(root + 'u');
        add(root + 'um');
      }
    }
    add(short + 'm');        // a ventive -am before a š: iddinam + šum
    add(short);
    return out;
  }

  // Peel the endings off a joined spelling. Returns null unless what is left
  // is a word the dictionary actually knows — without that test any word
  // ending in -ma or -ka would be taken apart, and šumma is not šum plus -ma.
  function sandhiChain(joined) {
    let word = String(joined || '');
    if (word.length < 4) return null;
    const ids = [];
    const forms = [];
    let assimilated = false;

    const peel = (table) => {
      for (const [spelling, id] of table) {
        for (const written of endingAlternatives(spelling)) {
          if (!word.endsWith(written)) continue;
          const rest = word.slice(0, -written.length);
          if (rest.length < 2) continue;
          // A š ending arriving spelled with s has swallowed something, and so
          // has one written across a doubled sign. Either way the base does
          // not end where the spelling says it does.
          if (written[0] !== spelling[0]
              || rest[rest.length - 1] === written[0]) assimilated = true;
          word = rest;
          ids.unshift(id);
          forms.unshift(written);
          return true;
        }
      }
      return false;
    };

    if (word.endsWith('ma') && word.length > 4) {
      word = word.slice(0, -2);
      ids.unshift('-ma I');
      forms.unshift('ma');
    }
    peel(BOUND_ENDINGS);
    peel(VENTIVE);
    if (!ids.length) return null;

    for (const base of baseForms(word, assimilated)) {
      if (forms_has(base)) return { stem: base, ids, forms, assimilated };
    }
    // A finite verb is not in the index as a word — the index keys infinitives —
    // so what is left of one has to be judged by whether it reads as a verb.
    if (looksLikeVerb(word) && verbCandidates(word, 'verbs').length) {
      return { stem: word, ids, forms, assimilated, verb: true };
    }
    return null;
  }

  // A form the shipped index knows, by the spelling or by the folded one.
  function forms_has(key) {
    if (!key) return false;
    if (forms[key] && forms[key].length) return true;
    const folded = foldedIndex()[fold(key)];
    return !!(folded && folded.length);
  }

  // A bound possessive or enclitic written onto the end of a word. eBL keeps
  // these as their own lemmas, and a token carries both — LUGAL-šu is šarru
  // and -šu, two ids on one word.
  //
  // The ids are the BOUND suffix lemmas, hyphen-first. The independent pronouns
  // (šū I, kâši I) are a different thing and some of them do not exist in eBL
  // at all, so a token given one of those is either dropped on export or comes
  // out wrong.
  const SUFFIX_LEMMAS = {
    'šunu': '-šunu I', 'šina': '-šina I',
    'kunu': '-kunu I', 'kina': '-kināti I',
    'šu': '-šu I', 'ša': '-ša I',
    'ka': '-ka I', 'ki': '-ki I',
    'ni': '-ni I', 'ya': '-ya I', 'ia': '-ya I', 'ja': '-ya I',
  };
  const ENCLITIC_LEMMAS = { 'ma': '-ma I' };

  // What is written on the end of this word, if anything.
  //
  // Only a hyphenated tail counts. An unhyphenated ending is a guess about
  // where the word stops, and this does not guess — DUMU could end in -u
  // without any suffix being there at all.
  function suffixOf(raw) {
    const key = oraccKey(raw, false);
    if (!key || key.indexOf('-') < 0) return null;
    // A word the dictionary holds whole is whole: šum-ma is šumma, and the ma
    // at the end of it is not the enclitic. Without this every omen opening
    // was being given a spurious -ma beside its šumma.
    //
    // The spelling exactly, not the folded one. qassu folds onto qaššu, a
    // different word, and that coincidence is not enough to decide that qāssu
    // has no ending on it.
    const whole = joinSyllables(key.split('-'));
    const exact = (k) => !!(k && forms[k] && forms[k].length);
    if (exact(key) || exact(whole)) return null;
    const parts = key.split('-');
    const last = parts[parts.length - 1];
    // A logogram plus its phonetic complement is not a suffix: the complement
    // spells out the end of the word the logogram already writes.
    const body = parts.slice(0, -1).join('-');
    if (!body) return null;

    // A plural suffix is spelled across two syllables — DUMU-šu-nu is -šunu,
    // not -nu — so the joined tail is tried before the last piece alone.
    const joined = parts.length > 2 ? parts.slice(-2).join('') : null;

    // Read both ways and keep whichever names more of the word. The hyphens
    // show a seam only where the scribe left one; the chain finds the seams
    // inside a sign, and a verb with a ventive and an enclitic has two of them.
    const run = joinSyllables(key.split('-'));
    const chain = sandhiChain(run);
    const asChain = chain ? {
      id: chain.ids[chain.ids.length - 1],
      form: chain.forms[chain.forms.length - 1],
      kind: 'suffix',
      also: chain.ids.length > 1
        ? { id: chain.ids[chain.ids.length - 2],
            form: chain.forms[chain.forms.length - 2], kind: 'suffix' }
        : null,
      chain: chain.ids.slice(),
      stem: chain.stem,
    } : null;
    const better = (a, b) => {
      if (!a) return b;
      if (!b) return a;
      const size = (x) => (x.chain ? x.chain.length : (x.also ? 2 : 1));
      return size(b) > size(a) ? b : a;
    };

    const enclitic = ENCLITIC_LEMMAS[last];
    if (enclitic) {
      const rest = parts.slice(0, -1);
      const innerJoined = rest.length > 1 ? rest.slice(-2).join('') : null;
      const innerLast = rest.length > 1 ? rest[rest.length - 1] : null;
      const inner = (innerJoined && SUFFIX_LEMMAS[innerJoined])
        ? { id: SUFFIX_LEMMAS[innerJoined], form: rest.slice(-2).join('-'), kind: 'suffix' }
        : (innerLast && SUFFIX_LEMMAS[innerLast])
          ? { id: SUFFIX_LEMMAS[innerLast], form: innerLast, kind: 'suffix' }
          : null;
      return better({ id: enclitic, form: last, kind: 'enclitic', also: inner }, asChain);
    }
    if (joined && SUFFIX_LEMMAS[joined] && parts.length > 2) {
      return better({ id: SUFFIX_LEMMAS[joined], form: parts.slice(-2).join('-'),
                       kind: 'suffix', also: null }, asChain);
    }
    const suffix = SUFFIX_LEMMAS[last];
    if (suffix) return better({ id: suffix, form: last, kind: 'suffix', also: null }, asChain);

    return asChain;
  }

  // Candidates for one word, as a flat list the UI can render.
  function candidates(raw, limit, context) {
    if (!loaded() || skippable(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const h of probe(raw, context)) {
      for (const id of h.ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, guide: glosses[id] || '', via: h.key, how: h.how,
          exact: h.how === 'as written' || !!h.fromProject,
          inferred: !!h.inferred, fromProject: !!h.fromProject });
        if (limit && out.length >= limit) return out;
      }
    }
    return out;
  }

  // Diacritics folded away, so a search can be typed on an ordinary keyboard:
  // "mahir" has to reach mahīru, and "sarru" has to reach šarru.
  function fold(text) {
    const d = String(text == null ? '' : text).normalize('NFD');
    let out = '';
    for (const c of d) {
      const k = c.codePointAt(0);
      if (k >= 0x300 && k <= 0x36f) continue;
      out += c;
    }
    return out.toLowerCase()
      .split('š').join('s').split('ṣ').join('s').split('ṭ').join('t')
      .split('ḫ').join('h').split('ĝ').join('g').split('ʾ').join('');
  }

  // Built once, on the first search: folding 20k entries per keystroke is
  // wasteful, folding them once is not.
  let folded = null;
  function foldIndex() {
    if (folded) return folded;
    folded = Object.keys(glosses).map((id) => ({
      id, guide: glosses[id] || '', fid: fold(id), fguide: fold(glosses[id] || ''),
    }));
    return folded;
  }

  // Free search, for when the ladder finds nothing and the editor knows the
  // word. Matches the lemma id and the guide word, best match first.
  function search(query, limit) {
    if (!loaded()) return [];
    const q = fold(String(query || '').trim());
    if (q.length < 2) return [];
    const cap = limit || 25;
    const starts = [], inside = [], byGuide = [];
    for (const e of foldIndex()) {
      if (e.fid.startsWith(q)) starts.push(e);
      else if (e.fid.indexOf(q) >= 0) inside.push(e);
      else if (e.fguide.indexOf(q) >= 0) byGuide.push(e);
    }
    // Scanned to the end on purpose. Stopping at the first `cap` hits would
    // return whichever entries happen to come first in the index rather than
    // the closest ones, and the sort below would have nothing to work with.
    // Among the prefix matches the shortest is the closest: "summa" typed for
    // šumma I should not be answered with summatu I, "(female) dove", merely
    // because it also begins that way.
    starts.sort((a, b) => a.fid.length - b.fid.length);
    return starts.concat(inside, byGuide).slice(0, cap)
      .map((e) => ({ id: e.id, guide: e.guide }));
  }

  function guideWord(id) { return (glosses && glosses[id]) || ''; }
  function known(id) { return !!(glosses && Object.prototype.hasOwnProperty.call(glosses, id)); }

  window.Lemmatizer = {
    load, loaded, size, candidates, search, guideWord, known, skippable, fold,
    setSignLookup,
    suffixOf,
    oraccKey, probe,
      looksLikeVerb,
    verbCandidates,
    setGlossary,
    glossaryEntries,
    glossaryKey,
    glossaryFor,
    setSignReadings,
};
})();
