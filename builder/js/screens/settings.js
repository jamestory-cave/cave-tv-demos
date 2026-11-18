// Settings: the publishing passcode (a GitHub fine-grained token, kept in
// this browser only) and the name written into the publish history.

import { config } from '../../config.js';
import { el, clear, fmtDate } from '../util.js';
import { toast, textField, uid, confirmModal, modal } from '../ui.js';
import { model } from '../model.js';

export function mount(host, app) {
  const main = el('main');
  host.append(el('div.screen', main));
  if (app.server) { renderServer(main, app); return {}; }

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

    // ---- guide ----
    const g = el('div.panel', { style: { maxWidth: '640px', marginBottom: '16px' } });
    g.append(el('h2', 'Guide for the visual team'), el('p.small.muted', { style: { marginBottom: '8px' } }, 'Artwork and film rules, the Adobe Media Encoder export recipe, and the safe-area template to download.'));
    g.append(el('button.btn.sm', { type: 'button', onclick: () => app.go('guide') }, 'Open the guide'));
    main.append(g);

    // ---- where things go ----
    const where = el('div.panel', { style: { maxWidth: '640px' } });
    where.append(el('h2', 'This browser'));
    const details = el('details', { style: { marginBottom: '10px' } }, el('summary.small', { style: { cursor: 'pointer' } }, 'Technical details'),
      el('dl.kv', el('dt', 'TVs read from'), el('dd', el('code', config.baseURL)), el('dt', 'Published to'), el('dd', el('code', `${config.owner}/${config.repo}`), ` (branch ${config.branch}, folder ${config.contentPath})`), el('dt', 'This Builder'), el('dd', el('code', location.href.split('#')[0]))));
    where.append(details);
    where.append(el('button.btn.sm.danger', { type: 'button', onclick: async () => { if (await confirmModal('Clear everything in this browser?', 'Draft, uploaded photos and films, name and passcode are all removed. What is published is untouched.', { okLabel: 'Clear', danger: true })) { await app.browser.clearAll(); app.github.forgetToken(); localStorage.clear(); location.reload(); } } }, 'Clear everything kept in this browser'));
    main.append(where);
  }

  render();
  return {};
}

// ---- on the Cave server: who is signed in, password, activity ------------------

const ACTIONS = {
  publish: 'Published', restore: 'Restored a publish', 'draft.save': 'Edited the draft', 'media.add': 'Added a photo or film',
  'media.upload': 'Uploaded a file', 'media.update': 'Changed a photo or film', 'media.remove': 'Removed a photo or film', signin: 'Signed in', signout: 'Signed out',
  'tv.add': 'Added a TV', 'tv.update': 'Changed a TV', 'tv.remove': 'Removed a TV', 'import-site': 'Imported the published content',
  'import-dhcp': 'Imported the TV list', 'user.add': 'Added a user', 'user.password': 'Changed a password', 'user.disable': 'Disabled a user', 'user.enable': 'Enabled a user',
  'copy.save': 'Saved a copy', 'copy.restore': 'Restored a saved copy', 'copy.delete': 'Deleted a saved copy', 'copy.download': 'Downloaded a saved copy',
  'copy.import': 'Brought in a saved copy', 'copy.restore-failed': 'A restore did not go through',
  'room.add': 'Added a room', 'room.update': 'Changed a room', 'room.remove': 'Removed a room', 'roomtype.add': 'Added a room type', 'roomtype.update': 'Changed a room type',
  'roomtype.remove': 'Removed a room type', 'roomtype.order': 'Reordered room types', 'roomdetail.add': 'Added a room detail', 'roomdetail.update': 'Changed a room detail',
  'roomdetail.remove': 'Removed a room detail', 'roomdetail.order': 'Reordered room details', 'import-rooms': 'Imported a list of rooms', 'migrate.rooms': 'Upgraded the TV list to rooms',
};

function describe(a) {
  const d = a.detail || {};
  if (a.action === 'publish' || a.action === 'restore') return `${ACTIONS[a.action]}: publish ${d.revision}${d.restoredFrom ? ` (back to ${d.restoredFrom})` : ''}${d.note ? ` · ${d.note}` : ''}`;
  if (a.action === 'media.add' || a.action === 'media.update') return `${ACTIONS[a.action]}: ${d.name || d.hash || ''}`;
  if (a.action === 'tv.update') return `${ACTIONS[a.action]}: ${Object.entries(d.after || {}).map(([k, v]) => `${k} ${v || '(blank)'}`).join(', ')}`;
  if (a.action === 'user.add' || a.action === 'user.password') return `${ACTIONS[a.action]}: ${d.name || ''}`;
  if (a.action.startsWith('copy.')) return `${ACTIONS[a.action] || a.action}: "${d.name || ''}"${a.action === 'copy.restore' && d.revision ? ` (TVs: publish ${d.revision})` : ''}${a.action === 'copy.restore-failed' && d.error ? ` (${d.error})` : ''}`;
  return ACTIONS[a.action] || a.action;
}

function renderServer(main, app) {
  const s = app.server;
  clear(main);
  main.append(el('h1', 'Settings'), el('p.muted', { style: { marginBottom: '16px' } }, 'The Builder is running on the hotel\'s own server. Content, photos and the draft are kept there.'));

  const who = el('div.panel', { style: { maxWidth: '640px', marginBottom: '16px' } });
  who.append(el('h2', 'Signed in'), el('p.small', { style: { marginBottom: '10px' } }, el('strong', s.user?.name || ''), ` · ${s.isAdmin ? 'Admin: can also restore earlier publishes and edit rooms' : 'Editor: can edit and publish'}. Your name goes into the publish history.`));
  who.append(el('button.btn.sm', { type: 'button', onclick: async () => { await s.signOut(); location.reload(); } }, 'Sign out'));
  main.append(who);

  const pw = el('div.panel', { style: { maxWidth: '640px', marginBottom: '16px' } });
  let cur = '', next = '', again = '';
  const status = el('div.small', { style: { marginTop: '6px' }, role: 'status' });
  pw.append(el('h2', 'Change your password'),
    textField({ id: uid('pw'), label: 'Current password', type: 'password', value: '', onInput: (v) => { cur = v; } }),
    textField({ id: uid('pw'), label: 'New password (8 characters or more)', type: 'password', value: '', onInput: (v) => { next = v; } }),
    textField({ id: uid('pw'), label: 'New password again', type: 'password', value: '', onInput: (v) => { again = v; } }),
    el('button.btn.sm', { type: 'button', onclick: async () => {
      status.style.color = 'var(--red)';
      if (next.length < 8) { status.textContent = 'The new password needs 8 characters or more.'; return; }
      if (next !== again) { status.textContent = 'The two new passwords are different.'; return; }
      try { await s.changePassword(cur, next); status.style.color = 'var(--green)'; status.textContent = 'Password changed. Other sign-ins with the old password have ended.'; toast('Password changed.'); }
      catch (e) { status.textContent = e.message; }
    } }, 'Change password'), status);
  for (const i of pw.querySelectorAll('input')) i.setAttribute('autocomplete', 'new-password');
  main.append(pw);

  const g = el('div.panel', { style: { maxWidth: '640px', marginBottom: '16px' } });
  g.append(el('h2', 'Guide for the visual team'), el('p.small.muted', { style: { marginBottom: '8px' } }, 'Artwork and film rules, the Adobe Media Encoder export recipe, and the safe-area template to download.'));
  g.append(el('button.btn.sm', { type: 'button', onclick: () => app.go('guide') }, 'Open the guide'));
  main.append(g);

  const where = el('div.panel', { style: { maxWidth: '640px', marginBottom: '16px' } });
  where.append(el('h2', 'This server'), el('dl.kv',
    el('dt', 'TVs read from'), el('dd', el('code', config.baseURL)),
    el('dt', 'This Builder'), el('dd', el('code', location.href.split('#')[0])),
    el('dt', 'On TVs now'), el('dd', model.published ? `publish ${model.published.version.revision}` : 'nothing yet')));
  main.append(where);

  if (s.isAdmin) main.append(savedCopies(app));

  if (s.isAdmin) {
    const act = el('div.panel', { style: { maxWidth: '900px' } });
    act.append(el('h2', 'Recent activity'), el('p.small.muted', { style: { marginBottom: '8px' } }, 'Every change anyone makes is recorded with who and when. Typing in the draft is grouped by the minute.'));
    const list = el('div.small', 'Loading…');
    act.append(list);
    main.append(act);
    s.audit(60).then((r) => {
      clear(list);
      const rows = r.audit || [];
      if (!rows.length) { list.append(el('p.muted', 'Nothing yet.')); return; }
      const table = el('table.grid-table');
      table.append(el('thead', el('tr', el('th', 'When'), el('th', 'Who'), el('th', 'What'), el('th', 'From'))));
      const tb = el('tbody');
      for (const a of rows) tb.append(el('tr', el('td', fmtDate(a.at)), el('td', a.user || ''), el('td', describe(a)), el('td.muted', a.address || '')));
      table.append(tb);
      list.append(el('div.table-wrap', table));
    }).catch((e) => { clear(list).append(el('p', { style: { color: 'var(--red)' } }, e.message)); });
  }
}

// ---- saved copies (admins): the whole setup under a name -------------------------

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

const BIG_DOWNLOAD = 200 * 1024 * 1024;

function savedCopies(app) {
  const s = app.server;
  const box = el('div#saved-copies.panel', { style: { maxWidth: '900px', marginBottom: '16px' } });
  box.append(el('h2', 'Saved copies'),
    el('p.small', { style: { marginBottom: '6px' } }, 'A saved copy holds the whole setup: the draft, the rooms and TVs, and what TVs show. Restore one to go back to it. The setup as it is at that moment is saved first, so a restore can always be undone.'),
    el('p.small.muted', { style: { marginBottom: '12px' } }, 'People and passwords are never changed by a restore. TVs only move forward: if the copy\'s content differs from what they show, it is published again as a new publish.'));

  // -- save now
  let name = '', note = '';
  const nameField = textField({ id: uid('cn'), label: 'Name', value: '', limit: 60, placeholder: 'e.g. Before room changes', onInput: (v) => { name = v; } });
  const noteField = textField({ id: uid('cnote'), label: 'Note (optional)', value: '', limit: 300, placeholder: 'What is about to change, or why', onInput: (v) => { note = v; } });
  const status = el('div.small', { role: 'status', style: { marginTop: '6px', minHeight: '1.2em' } });
  const saveBtn = el('button.btn.pri.sm', { type: 'button', onclick: async () => {
    status.style.color = 'var(--red)';
    if (!name.trim()) { status.textContent = 'Give the copy a name first.'; nameField.input.focus(); return; }
    saveBtn.disabled = true; status.style.color = ''; status.textContent = 'Saving a copy…';
    try {
      const r = await s.saveCopy(name.trim(), note.trim());
      status.style.color = 'var(--green)'; status.textContent = `Saved "${r.copy.name}".`;
      toast(`Saved a copy: "${r.copy.name}".`);
      nameField.input.value = ''; noteField.input.value = ''; name = ''; note = '';
      load();
    } catch (e) { status.style.color = 'var(--red)'; status.textContent = e.message; }
    finally { saveBtn.disabled = false; }
  } }, 'Save a copy now');
  const form = el('div.copy-form', nameField, noteField, el('div.row', saveBtn,
    el('button.btn.sm', { type: 'button', onclick: () => fileInput.click() }, 'Bring in a copy from a file…')), status);
  const fileInput = el('input', { type: 'file', accept: '.zip,application/zip', style: { display: 'none' }, 'aria-label': 'Choose a saved copy file' });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    status.style.color = ''; status.textContent = `Bringing in ${f.name} (${fmtBytes(f.size)})…`;
    try {
      const r = await s.importCopy(f);
      status.style.color = 'var(--green)'; status.textContent = `Brought in "${r.copy.name}". Nothing has changed yet: restore it from the list when you are ready.`;
      toast(`Brought in "${r.copy.name}".`);
      load();
    } catch (e) { status.style.color = 'var(--red)'; status.textContent = e.message; }
  });
  box.append(form, fileInput);

  // -- the list
  const list = el('div.small', { style: { marginTop: '14px' } }, 'Loading…');
  box.append(list);

  async function load() {
    let r;
    try { r = await s.copies(); } catch (e) { clear(list).append(el('p', { style: { color: 'var(--red)' } }, e.message)); return; }
    clear(list);
    const rows = r.copies || [];
    if (!rows.length) { list.append(el('p.muted', 'No saved copies yet.')); return; }
    const table = el('table.grid-table.copies');
    table.append(el('thead', el('tr', el('th', 'Name'), el('th', 'Saved'), el('th', 'What it holds'), el('th', 'Size'), el('th', { 'aria-label': 'Actions' }, ''))));
    const tb = el('tbody');
    for (const c of rows) {
      const nameCell = el('td', el('strong', c.name));
      if (c.automatic) nameCell.append(' ', el('span.pill', 'Automatic'));
      if (c.broughtIn) nameCell.append(' ', el('span.pill', { title: `Brought in from ${c.broughtIn.file || 'a file'} by ${c.broughtIn.by || '?'} on ${fmtDate(c.broughtIn.at)}` }, 'Brought in'));
      if (c.note) nameCell.append(el('div.muted', c.note));
      const actions = el('td', el('div.copy-actions',
        el('button.btn.sm', { type: 'button', onclick: () => restore(c) }, 'Restore…'),
        el('button.btn.sm', { type: 'button', title: `Download as one file (${fmtBytes(c.downloadBytes)})`, onclick: () => download(c) }, `Download (${fmtBytes(c.downloadBytes)})`),
        c.automatic ? null : el('button.btn.sm.danger', { type: 'button', onclick: () => remove(c) }, 'Delete')));
      tb.append(el('tr', { 'data-copy': c.id }, nameCell, el('td', fmtDate(c.createdAt), el('div.muted', c.by || '')), el('td', c.summary),
        el('td.nowrap', fmtBytes(c.downloadBytes), el('div.muted', { title: 'Space it takes on the server itself: photos and films are shared with what is live, not copied again' }, `${fmtBytes(c.bytes)} here`)), actions));
    }
    table.append(tb);
    list.append(el('div.table-wrap', table));
    list.append(el('p.muted.tiny', { style: { marginTop: '6px' } }, `Automatic copies: the last 20 are kept. Named copies stay until deleted. Copies are kept in the server's data folder, which the nightly backup covers${Number.isFinite(r.freeBytes) ? `; ${fmtBytes(r.freeBytes)} free on the server's disk` : ''}.`));
  }

  async function restore(c) {
    let plan;
    try { plan = await s.copyPlan(c.id); } catch (e) { modal({ title: `Cannot restore "${c.name}"`, body: el('p', e.message), actions: [{ label: 'OK', primary: true }] }); return; }
    const ul = el('ul.small', { style: { paddingLeft: '18px', lineHeight: '1.5' } });
    for (const line of plan.lines) ul.append(el('li', line));
    const msg = el('p.small', { role: 'status', style: { marginTop: '8px' } });
    modal({ title: `Restore "${c.name}"?`, wide: true, body: el('div', el('p', { style: { marginBottom: '8px' } }, `Saved ${fmtDate(c.createdAt)}${c.by ? ` by ${c.by}` : ''}: ${c.summary}.`), ul, msg),
      actions: [{ label: 'Cancel' }, { label: 'Restore this copy', primary: true, keepOpen: true, onClick: async (close) => {
        msg.style.color = ''; msg.textContent = 'Restoring…';
        for (const b of document.querySelectorAll('.modal .actions button')) b.disabled = true;
        try {
          const r = await s.restoreCopy(c.id);
          close();
          const tvs = r.published ? `TVs now show it as publish ${r.published}.` : r.mode === 'carry-on' ? `TVs now show publish ${r.revision}.` : 'What TVs show did not change.';
          modal({ title: 'Restored', body: el('div', el('p', `"${c.name}" is restored. ${tvs}`),
            el('p', { style: { marginTop: '8px' } }, `To undo, restore "${r.automatic?.name || 'Automatic: before restoring'}" from the list.`)),
          actions: [{ label: 'OK', primary: true, onClick: () => location.reload() }], onClose: () => location.reload() });
        } catch (e) {
          msg.style.color = 'var(--red)'; msg.textContent = `${e.message}`;
          for (const b of document.querySelectorAll('.modal .actions button')) b.disabled = false;
        }
        return false;
      } }] });
  }

  async function download(c) {
    if (c.downloadBytes > BIG_DOWNLOAD && !(await confirmModal(`Download "${c.name}"?`, `The file is ${fmtBytes(c.downloadBytes)}, because it holds the photos and films the copy uses, so it works on another server. Make sure there is room for it where it is saved.`, { okLabel: 'Download' }))) return;
    const a = el('a', { href: s.copyDownloadURL(c.id), download: '' });
    document.body.append(a);
    a.click();
    a.remove();
    toast('The download has started. The browser shows its progress.');
  }

  async function remove(c) {
    if (!(await confirmModal(`Delete "${c.name}"?`, 'The saved copy is removed from the server. This cannot be undone; download it first if it might be needed again. Nothing that is live or in the draft changes.', { okLabel: 'Delete', danger: true }))) return;
    try { await s.deleteCopy(c.id); toast(`Deleted "${c.name}".`); load(); }
    catch (e) { toast(e.message, { error: true }); }
  }

  load();
  return box;
}
