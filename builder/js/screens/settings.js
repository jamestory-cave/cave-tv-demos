// Settings: the publishing passcode (a GitHub fine-grained token, kept in
// this browser only) and the name written into the publish history.

import { config } from '../../config.js';
import { el, clear } from '../util.js';
import { toast, textField, uid, confirmModal } from '../ui.js';

export function mount(host, app) {
  const main = el('main');
  host.append(el('div.screen', main));

  function render() {
    clear(main);
    main.append(el('h1', 'Settings'), el('p.muted', { style: { marginBottom: '16px' } }, 'Everything here is kept in this browser only.'));

    // ---- name ----
    const nameBox = el('div.panel', { style: { maxWidth: '640px', marginBottom: '16px' } });
    nameBox.append(el('h2', 'Your name'));
    let by = app.publisherName();
    nameBox.append(textField({ id: uid('by'), label: 'Shown in the publish history', value: by, limit: 40, placeholder: 'e.g. James', onInput: (v) => { by = v; } }));
    nameBox.append(el('button.btn.sm', { type: 'button', onclick: () => { app.browser.setPref('by', by.trim()); toast('Name saved.'); } }, 'Save name'));
    main.append(nameBox);

    // ---- passcode ----
    const box = el('div.panel', { style: { maxWidth: '640px', marginBottom: '16px' } });
    box.append(el('h2', 'Publishing passcode'));
    if (app.github.hasToken) {
      box.append(el('p.small', { style: { marginBottom: '8px' } }, 'A passcode is saved in this browser: ', el('code', app.github.tokenHint), '. Publishing is on.'));
      const status = el('span.small.muted');
      box.append(el('div.row',
        el('button.btn.sm', { type: 'button', onclick: async () => { status.textContent = 'Checking…'; const r = await app.github.validateToken(); status.textContent = r.ok ? `Works: can publish to ${r.repo}.` : r.reason; } }, 'Check it still works'),
        el('button.btn.sm.danger', { type: 'button', onclick: async () => { if (await confirmModal('Forget the passcode?', 'Publishing from this browser stops until a passcode is entered again.', { okLabel: 'Forget', danger: true })) { app.github.forgetToken(); toast('Passcode forgotten.'); render(); } } }, 'Forget'),
        status));
    } else {
      let token = '';
      const f = textField({ id: uid('tk'), label: 'Paste the passcode', value: '', type: 'password', spellcheck: false, placeholder: 'Paste the whole passcode', onInput: (v) => { token = v; } });
      f.input.setAttribute('autocomplete', 'off');
      box.append(f);
      const status = el('div.small.muted', { style: { marginTop: '6px' } });
      box.append(el('button.btn.pri.sm', { type: 'button', onclick: async () => {
        status.textContent = 'Checking with GitHub…';
        const r = await app.github.validateToken(token.trim());
        if (!r.ok) { status.textContent = r.reason; status.style.color = 'var(--red)'; return; }
        app.github.setToken(token.trim());
        toast('Passcode saved. Publishing is on in this browser.');
        render();
      } }, 'Save and check'), status);
    }
    box.append(el('div.rule'));
    box.append(el('h3', 'How to make one (James)'));
    const ol = el('ol.small', { style: { paddingLeft: '18px', lineHeight: '1.6' } });
    for (const step of [
      'Sign in to GitHub as the account that owns the ' + config.owner + '/' + config.repo + ' repository.',
      'Go to Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.',
      `Name it "Cave Builder publishing". Under Repository access choose "Only select repositories" and pick ${config.repo}.`,
      'Under Repository permissions set Contents to "Read and write". Leave everything else at "No access".',
      'Set an expiry (a year is fine), generate it, and copy it. GitHub shows it once.',
      'Paste it above. It stays in this browser; give it to anyone who should be able to publish, and forget it here to stop them.',
    ]) ol.append(el('li', step));
    box.append(ol);
    box.append(el('p.muted.tiny', 'The passcode is never written into the repository or the Builder\'s code, and it is only ever sent to api.github.com.'));
    main.append(box);

    // ---- where things go ----
    const where = el('div.panel', { style: { maxWidth: '640px' } });
    where.append(el('h2', 'This browser'));
    const details = el('details', { style: { marginBottom: '10px' } }, el('summary.small', { style: { cursor: 'pointer' } }, 'Technical details'),
      el('dl.kv', el('dt', 'TVs read from'), el('dd', el('code', config.baseURL)), el('dt', 'Published to'), el('dd', el('code', `${config.owner}/${config.repo}`), ` (branch ${config.branch}, folder ${config.contentPath})`), el('dt', 'This Builder'), el('dd', el('code', location.href.split('#')[0]))));
    where.append(details);
    where.append(el('button.btn.sm.danger', { type: 'button', onclick: async () => { if (await confirmModal('Clear everything in this browser?', 'Draft, uploaded photos, name and passcode are all removed. What is published is untouched.', { okLabel: 'Clear', danger: true })) { await app.browser.clearAll(); app.github.forgetToken(); localStorage.clear(); location.reload(); } } }, 'Clear everything kept in this browser'));
    main.append(where);
  }

  render();
  return {};
}
