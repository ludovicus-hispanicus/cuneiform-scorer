"""Generate a conjugated-form index from BEn-app's Akkadian conjugator.

NOT shipped by default, and the reason is measured rather than assumed.

Run against EAE 56 it answered 15 of 244 words the ordinary ladder handles
weakly — and about half of those answers were wrong, because the conjugator
reads an uppercase logogram as if it were a syllabic spelling:

    GAR-an  -> qarānu I     (GAR is šakānu)
    DU-kam  -> dakāmu I     (DU is alāku)
    DAB-bat -> dabābu II    (DAB is ṣabātu)

The genuine wins are all lowercase syllabic forms — iṭ-hu-u₂ -> ṭehû,
u₂-lap-pat -> lapātu, iš-šal-lal -> šalālu — about eight words, for 3 MB of
index. On a more syllabic text the balance would be different, which is why
this is kept: run it, and gate the lookup to all-lowercase writings.

The output is deterministic, so nothing at runtime needs Python.

The forms index keys words as the dictionary lists them, so a finite verb —
it-tan-mar, iṣ-ru-ur-ma — is not in it: the dictionary holds amāru and ṣarāru,
not every form they take. BEn-app has a rule-based conjugator that generates
those forms from a root and a vowel class, and it is deterministic, so it is
run once here and its answer shipped as data. Nothing at runtime needs Python.

  python tools/build-verb-index.py <ben-app-server-src> [out-dir]
"""
import json
import os
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else None
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join('data', 'lemmas')
if not SRC or not os.path.isdir(SRC):
    print('usage: python tools/build-verb-index.py <ben-app-server-src> [out-dir]')
    raise SystemExit(1)

sys.path.insert(0, SRC)
from services.akkadian_conjugator import AkkadianConjugator   # noqa: E402

words_dir = os.path.join(SRC, 'data', 'dictionary', 'words')
verbs = []
for name in os.listdir(words_dir):
    if not name.endswith('.json'):
        continue
    try:
        with open(os.path.join(words_dir, name), encoding='utf-8') as fh:
            d = json.load(fh)
    except Exception:
        continue
    if 'V' in (d.get('pos') or []) and d.get('roots'):
        verbs.append(d)

print('verb entries with a root: %d' % len(verbs))

conj = AkkadianConjugator()
total = conj.build_reverse_index(verbs)
index = conj._reverse_index

# The morphology itself is not carried: what the picker needs is which lemma to
# offer, and the analysis would treble the size.
#
# Two economies, because the raw table is 4.4 MB and this loads in a browser
# beside a dictionary that is already 1.5 MB:
#
#  - the lemma ids are interned. 1,579 verbs account for 147,000 forms, so the
#    same long string was being written tens of times.
#  - forms the ordinary index already holds are dropped. They would be found by
#    an earlier rung anyway, so carrying them twice buys nothing.
known = set()
forms_path = os.path.join(OUT, 'forms.json')
if os.path.exists(forms_path):
    with open(forms_path, encoding='utf-8') as fh:
        known = set(json.load(fh).keys())

ids_list = []
ids_at = {}
def intern(lemma_id):
    if lemma_id not in ids_at:
        ids_at[lemma_id] = len(ids_list)
        ids_list.append(lemma_id)
    return ids_at[lemma_id]

forms = {}
skipped = 0
for form, analyses in index.items():
    if form in known:
        skipped += 1
        continue
    seen = []
    for a in analyses:
        if not a.lemma_id:
            continue
        n = intern(a.lemma_id)
        if n not in seen:
            seen.append(n)
    if seen:
        forms[form] = seen

os.makedirs(OUT, exist_ok=True)
path = os.path.join(OUT, 'verbs.json')
with open(path, 'w', encoding='utf-8') as fh:
    json.dump({'ids': ids_list, 'forms': forms}, fh, ensure_ascii=False)

size = os.path.getsize(path) / 1048576.0
print('verbs.json   %d forms, %d lemmas, %d already in forms.json   %.2f MB'
      % (len(forms), len(ids_list), skipped, size))
for probe in ('ittanmar', 'iṣrurma', 'ukulti', 'ippuš', 'šaruru'):
    if probe in forms:
        print('   %-10s -> %s' % (probe, ', '.join(ids_list[n] for n in forms[probe][:3])))
