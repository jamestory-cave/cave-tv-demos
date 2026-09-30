// Media: every photo, where it is used, upload once. Also the picker the
// editor opens when a page needs a photo.

import { el, clear, plural, fmtDate } from '../util.js';
import { model } from '../model.js';
import { prepareUpload } from '../media.js';
import { photoProblem } from '../validate.js';
import { toast, modal, confirmModal, textField, uid } from '../ui.js';

function usesOf(app, entry) {
  const uses = model.imageUses();
  const keys = [entry.path];
  if (entry.assetName) keys.push(entry.assetName);
  const out = [];
  for (const k of keys) for (const u of uses.get(k) || []) out.push(u);
  return out;
}

function tile(app, entry, selected, onClick) {
  const uses = usesOf(app, entry);
  const t = el('button.tile-m' + (selected ? '.sel' : ''), { type: 'button', onclick: () => onClick(entry) });
  const ph = el('div.ph');
  const url = app.media.url(entry.assetName || entry.path, 800);
  if (url) ph.style.backgroundImage = `url("${url}")`;
  if (photoProblem(entry.width ? { width: entry.width, height: entry.height } : null)) ph.append(el('span.badge.warn', 'Cards only'));
  if (entry.source === 'pending') ph.append(el('span.badge.new', 'Not yet published'));
  t.append(ph, el('div.nm', entry.name || entry.hash), el('div.mt', `${entry.width || '?'} × ${entry.height || '?'} · ${uses.length ? plural(uses.length, 'place') : 'not used'}`));
  return t;
}

async function uploadFiles(app, files, after) {
  let added = 0;
  for (const file of files) {
    try {
      const rec = await prepareUpload(file);
      if (app.media.meta(rec.hash) || app.media.index.media[rec.hash]) { toast(`${rec.name} is already in the library.`); continue; }
      await app.media.add(rec);
      added++;
      if (after) after(rec);
    } catch (e) {
      toast(`${file.name}: ${e.message}`, { error: true });
    }
  }
  if (added) toast(`${plural(added, 'photo')} added. Resized to 1920 and 800 wide; goes to the TV with the next publish.`);
  return added;
}

function dropZone(app, onDone) {
  const input = el('input', { type: 'file', accept: 'image/jpeg,image/png', multiple: true, class: 'sr-only', id: uid('up') });
  input.addEventListener('change', async () => { await uploadFiles(app, [...input.files], null); input.value = ''; onDone(); });
  const zone = el('div.drop',
    el('div', el('strong', 'Drop photos here '), el('span.muted', 'or '), el('label.btn.sm', { for: input.id }, 'Choose files'), input),
    el('span.muted.small', 'JPG or PNG · 1920 px wide or larger for full screen · up to 25 MB'));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async (e) => { e.preventDefault(); zone.classList.remove('over'); await uploadFiles(app, [...e.dataTransfer.files], null); onDone(); });
  return zone;
}

export function mount(host, app) {
  const state = { filter: 'all', selected: null, query: '' };
  const rail = el('div.rail');
  const main = el('main');
  const aside = el('aside');
  host.append(el('div.screen', rail, main, aside));

  const entries = () => {
    let list = app.media.entries();
    if (state.filter === 'unused') list = list.filter((e) => !usesOf(app, e).length);
    if (state.filter === 'pending') list = list.filter((e) => e.source === 'pending');
    if (state.query) list = list.filter((e) => (e.name || '').toLowerCase().includes(state.query.toLowerCase()));
    return list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  };

  function renderRail() {
    clear(rail);
    const all = app.media.entries();
    rail.append(el('h3', 'Show'));
    for (const [k, label, n] of [['all', 'Everything', all.length], ['pending', 'Waiting to publish', all.filter((e) => e.source === 'pending').length], ['unused', 'Not used anywhere', all.filter((e) => !usesOf(app, e).length).length]]) {
      rail.append(el('button.fl' + (state.filter === k ? '.on' : ''), { type: 'button', onclick: () => { state.filter = k; renderRail(); renderMain(); } }, label, el('span', String(n))));
    }
    rail.append(el('p.muted.tiny', { style: { marginTop: '14px' } }, 'Photos already on the TV came from the app\'s built-in set. New uploads are kept in this browser until published.'));
  }

  function renderMain() {
    clear(main);
    const search = el('input.in', { type: 'search', placeholder: 'Search by name', 'aria-label': 'Search', value: state.query, style: { width: '220px' } });
    search.addEventListener('input', () => { state.query = search.value; renderGrid(); });
    main.append(el('div.row.between', { style: { marginBottom: '12px' } }, el('div', el('h1', 'Media'), el('p.muted', 'Every photo. Upload once, use anywhere. The Builder makes the TV sizes itself.')), search));
    main.append(dropZone(app, () => { renderRail(); renderMain(); }));
    main.append(el('div#grid'));
    renderGrid();
  }

  function renderGrid() {
    const grid = main.querySelector('#grid');
    clear(grid);
    const list = entries();
    if (!list.length) { grid.append(el('div.empty', 'No photos match.')); return; }
    const g = el('div.grid');
    for (const e of list) g.append(tile(app, e, e.hash === state.selected, (x) => { state.selected = x.hash; renderGrid(); renderAside(); }));
    grid.append(g);
  }

  function renderAside() {
    clear(aside);
    const e = app.media.entries().find((x) => x.hash === state.selected);
    if (!e) { aside.append(el('p.muted', 'Select a photo to see where it is used.')); return; }
    const big = el('div.big-ph');
    const url = app.media.url(e.assetName || e.path, 800);
    if (url) big.style.backgroundImage = `url("${url}")`;
    aside.append(el('div.row.between', { style: { marginBottom: '8px' } }, el('h2', { style: { margin: 0 } }, e.name || e.hash), el('span.pill' + (e.source === 'pending' ? '.green' : ''), e.source === 'pending' ? 'Waiting to publish' : 'Published')));
    aside.append(big);
    aside.append(el('p.muted.small', `${e.width} × ${e.height}${e.bytes ? ` · ${(e.bytes / 1048576).toFixed(1)} MB` : ''}${e.addedAt && e.addedAt !== 'seed' ? ` · added ${fmtDate(e.addedAt)}` : ''}`));
    if (photoProblem({ width: e.width, height: e.height })) aside.append(el('div.note.warn.small', 'Too small for a strip or full screen (needs 1920 × 1080 or larger); fine on a card.'));
    const uses = usesOf(app, e);
    aside.append(el('h3', { style: { marginTop: '14px' } }, uses.length ? `Used in ${plural(uses.length, 'place')}` : 'Not used anywhere'));
    for (const u of uses) {
      aside.append(el('div.use', el('button', { type: 'button', onclick: () => app.go('editor', { page: u.pageId }) }, model.pathLabel(u.pageId)), el('span.muted', u.use)));
    }
    if (e.source === 'pending') {
      aside.append(el('div.row', { style: { marginTop: '14px' } }, el('button.btn.sm', { type: 'button', onclick: () => renameEntry(e) }, 'Rename'),
        el('button.btn.sm.danger', { type: 'button', disabled: uses.length > 0, title: uses.length ? 'In use: remove it from those pages first' : '', onclick: () => removeEntry(e) }, 'Delete')));
      aside.append(el('p.muted.tiny', { style: { marginTop: '6px' } }, 'Once published, a photo stays on the TV\'s server for good so old publishes can be restored.'));
    }
  }

  async function renameEntry(e) {
    let v = e.name;
    const f = textField({ label: 'Name', value: e.name, limit: 40, id: uid('n'), onInput: (x) => { v = x; } });
    modal({ title: 'Rename photo', body: f, actions: [{ label: 'Cancel' }, { label: 'Rename', primary: true, onClick: async () => { const rec = await app.browser.getMedia(e.hash); if (rec) { rec.name = v.trim() || rec.name; await app.media.add(rec); } renderGrid(); renderAside(); } }] });
  }

  async function removeEntry(e) {
    const ok = await confirmModal('Delete this photo?', 'It has not been published, so nothing on the TV changes.', { okLabel: 'Delete', danger: true });
    if (!ok) return;
    await app.media.remove(e.hash);
    state.selected = null;
    renderRail(); renderMain(); renderAside();
  }

  renderRail(); renderMain(); renderAside();
  return { update() { renderRail(); renderGrid(); renderAside(); } };
}

/**
 * The picker: choose from the library or upload. onPick(src) gets the value
 * to store: the bundled asset name where one exists (the TV already has that
 * photo), otherwise the media path.
 */
export function pickPhoto(app, { onPick, cardsOK = true }) {
  let selected = null;
  let query = '';
  const grid = el('div.grid', { style: { maxHeight: '48vh', overflow: 'auto', padding: '2px' } });
  const render = () => {
    clear(grid);
    let list = app.media.entries();
    if (query) list = list.filter((e) => (e.name || '').toLowerCase().includes(query.toLowerCase()));
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    for (const e of list) grid.append(tile(app, e, e.hash === selected, (x) => { selected = x.hash; render(); ok.disabled = false; }));
    if (!list.length) grid.append(el('div.empty', 'No photos match.'));
  };
  const search = el('input.in', { type: 'search', placeholder: 'Search by name', 'aria-label': 'Search', style: { maxWidth: '260px' } });
  search.addEventListener('input', () => { query = search.value; render(); });
  const body = el('div', dropZone(app, () => render()), search, el('div', { style: { height: '10px' } }), grid);
  if (!cardsOK) body.prepend(el('p.help', 'Photos under 1920 px wide are shown but will hold the page back.'));
  const ok = { label: 'Use this photo', primary: true, disabled: true, onClick: () => {
    const e = app.media.entries().find((x) => x.hash === selected);
    if (!e) return false;
    onPick(e.assetName || e.path);
    return true;
  } };
  const m = modal({ title: 'Choose a photo', body, wide: true, actions: [{ label: 'Cancel' }, ok] });
  // Enable the button when a tile is chosen (the modal builds buttons once).
  const okBtn = m.box.querySelector('.actions .btn.pri');
  Object.defineProperty(ok, 'disabled', { set: (v) => { okBtn.disabled = v; }, get: () => okBtn.disabled });
  render();
}
