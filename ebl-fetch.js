// Shared "fetch a source from eBL" flow, used by the scorer and by Settings.
//
// Both pages need the same three things — a museum-number form that previews
// the URL, the request itself, and the file body to write — and they had no
// common script, so this exists rather than a second copy that drifts.
//
// The dialog markup is injected from here for the same reason: one definition,
// both pages, no duplicate ids to keep in step.
(function () {
  'use strict';

  const DIALOG_ID = 'ebl-fetch-dialog';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // A join is filed at eBL under its first number, so what is typed and what is
  // requested are not always the same.
  function primaryOf(museum) {
    if (window.EblClient && window.EblClient.extractMuseumNumber) {
      return window.EblClient.extractMuseumNumber(museum).primary;
    }
    return String(museum).split(/\s*\(\s*\+\s*\)\s*/)[0].trim();
  }

  function fragmentUrl(museum) {
    const primary = primaryOf(museum);
    const base = (window.EblClient && window.EblClient.getApiUrl)
      ? window.EblClient.getApiUrl()
      : 'https://www.ebl.lmu.de/api';
    return { primary, url: base + '/fragments/' + encodeURIComponent(primary) };
  }

  function ensureDialog() {
    let dialog = document.getElementById(DIALOG_ID);
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = DIALOG_ID;
    dialog.className = 'dialog ebl-fetch-dialog';
    dialog.innerHTML =
      '<h2>Fetch from eBL</h2>' +
      '<form id="ebl-fetch-form">' +
        '<label class="field-label" for="ebl-fetch-input">Museum number</label>' +
        '<input type="text" id="ebl-fetch-input" class="field-input" autocomplete="off"' +
              ' placeholder="K.2246" spellcheck="false">' +
        '<p class="field-hint">e.g. <code>K.2246</code>, <code>BM.34653</code>,' +
          ' <code>1881,0727.62</code>, <code>Rm-II.548</code></p>' +
        '<div class="url-preview">' +
          '<span class="url-preview-label">Will fetch</span>' +
          '<code id="ebl-fetch-url" class="url-preview-value">&mdash;</code>' +
        '</div>' +
        '<p id="ebl-fetch-note" class="field-hint field-note" hidden></p>' +
        '<div class="dialog-actions">' +
          '<span class="pull-spacer"></span>' +
          '<button type="button" id="ebl-fetch-cancel">Cancel</button>' +
          '<button type="submit" id="ebl-fetch-go" class="pull-apply-btn" disabled>Fetch</button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(dialog);
    return dialog;
  }

  // opts.exists(museum) -> true when the project already has it, so the form can
  // refuse before the request rather than after.
  function askMuseumNumber(opts) {
    const exists = (opts && opts.exists) || (() => false);
    return new Promise((resolve) => {
      const dialog = ensureDialog();
      const input = document.getElementById('ebl-fetch-input');
      const urlEl = document.getElementById('ebl-fetch-url');
      const noteEl = document.getElementById('ebl-fetch-note');
      const goBtn = document.getElementById('ebl-fetch-go');
      const cancelBtn = document.getElementById('ebl-fetch-cancel');
      const form = document.getElementById('ebl-fetch-form');

      const refresh = () => {
        const museum = input.value.trim();
        if (!museum) {
          urlEl.textContent = '—';
          noteEl.hidden = true;
          goBtn.disabled = true;
          return;
        }
        const info = fragmentUrl(museum);
        urlEl.textContent = info.url;
        const notes = [];
        let blocked = false;
        if (info.primary !== museum) {
          notes.push('A join is filed under its first number, so eBL is asked for '
                     + info.primary + '.');
        }
        if (exists(museum)) {
          notes.push('"' + museum + '" is already in this project.');
          blocked = true;
        }
        noteEl.textContent = notes.join(' ');
        noteEl.hidden = notes.length === 0;
        goBtn.disabled = blocked;
      };

      const cleanup = (value) => {
        input.removeEventListener('input', refresh);
        cancelBtn.removeEventListener('click', onCancel);
        form.removeEventListener('submit', onSubmit);
        dialog.removeEventListener('cancel', onCancel);
        dialog.close();
        resolve(value);
      };
      const onCancel = (e) => { if (e) e.preventDefault(); cleanup(null); };
      const onSubmit = (e) => {
        e.preventDefault();
        const museum = input.value.trim();
        if (museum && !goBtn.disabled) cleanup(museum);
      };

      input.value = '';
      refresh();
      input.addEventListener('input', refresh);
      cancelBtn.addEventListener('click', onCancel);
      form.addEventListener('submit', onSubmit);
      dialog.addEventListener('cancel', onCancel);
      dialog.showModal();
      input.focus();
    });
  }

  // Resolves to { primary, atf, content, lineCount }; rejects with an Error
  // whose message is already fit to show.
  async function fetchFragment(museum) {
    if (!window.EblClient || !window.EblClient.getFragment) {
      throw new Error('The eBL client is not loaded.');
    }
    const primary = primaryOf(museum);
    let frag;
    try {
      frag = await window.EblClient.getFragment(primary);
    } catch (err) {
      if (err && err.status === 404) {
        throw new Error('eBL has no fragment "' + primary + '".');
      }
      throw new Error('Could not reach eBL.\n\n' +
                      (err && err.message ? err.message : String(err)));
    }
    if (!frag || !frag.atf || !frag.atf.trim()) {
      throw new Error(primary + ' exists at eBL but has no transliteration yet.');
    }
    const atf = frag.atf.replace(/[\r\n]+$/, '');
    const lineCount = atf.split('\n')
      .filter((l) => /^\s*\d+['’]?[ab]?\./.test(l)).length;
    return {
      primary,
      atf,
      // the siglum line is this app's own convention; eBL's ATF follows it
      content: museum + '\n' + atf + '\n',
      lineCount,
    };
  }

  window.EblFetch = { primaryOf, fragmentUrl, ensureDialog, askMuseumNumber, fetchFragment, esc };
})();
