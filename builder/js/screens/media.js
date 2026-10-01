// Media: every photo and film, where each is used, upload once. Also the
// picker the editor opens when a page needs a photo.

import { el, clear, plural, fmtDate } from '../util.js';
import { model } from '../model.js';
import { prepareUpload, prepareSlide, shapeOf, fmtBytes, fmtSeconds, mediaPath, SLIDE_SIZE } from '../media.js';
import { photoProblem, slideSizeProblem } from '../validate.js';
import { toast, modal, confirmModal, textField, uid } from '../ui.js';
import { uploadFilmFiles, filmTile, filmLine, posterCapture } from './films.js';
import { codecName } from '../mp4.js';

function usesOf(app, entry) {
  const uses = model.imageUses();
  const keys = [entry.path, mediaPath(entry.hash, SLIDE_SIZE)];   // a slide may reference the 3840 copy
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
  else if (shapeOf(entry) !== 'ok') ph.append(el('span.badge.warn', shapeOf(entry) === 'wide' ? 'Wide: crops on a strip' : 'Tall: crops on a strip'));
  if (entry.source === 'pending') ph.append(el('span.badge.new', 'Not yet published'));
  t.append(ph, el('div.nm', entry.name || entry.hash), el('div.mt', `${entry.width || '?'} × ${entry.height || '?'} · ${uses.length ? plural(uses.length, 'place') : 'not used'}`));
  return t;
}

async function uploadFiles(app, files, after, { slide = false } = {}) {
  let added = 0;
  const films = files.filter((f) => /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm|avi|mkv)$/i.test(f.name));
  const photos = files.filter((f) => !films.includes(f));
  for (const file of photos) {
    try {
      const rec = slide ? await prepareSlide(file) : await prepareUpload(file);
      if (app.media.pending.has(rec.hash) || app.media.index.media[rec.hash]) { toast(`${rec.name} is already in the library (same photo).`); if (after) after(app.media.entries().find((e) => e.hash === rec.hash)); continue; }
      await app.media.add(rec);
      added++;
      if (rec.warnings?.length) toast(`${rec.name}: ${rec.warnings.join(' ')}`, { ms: 9000 });
      if (after) after(rec);
    } catch (e) {
      toast(`${file.name}: ${e.message}`, { error: true });
    }
  }
  if (added) toast(`${plural(added, 'photo')} added. Resized to 1920 and 800 wide; goes to the TV with the next publish.`);
  if (films.length) await uploadFilmFiles(app, films);
  return added + films.length;
}

function dropZone(app, onDone, { slide = false, accept = 'image/jpeg,image/png' } = {}) {
  const input = el('input', { type: 'file', accept, multiple: true, class: 'sr-only', id: uid('up') });
  input.addEventListener('change', async () => { const files = [...input.files]; input.value = ''; await uploadFiles(app, files, null, { slide }); onDone(); });
  const withFilms = /video/.test(accept);
  const zone = el('div.drop',
    el('div', el('strong', slide ? 'Drop artwork here ' : withFilms ? 'Drop photos or films here ' : 'Drop photos here '), el('span.muted', 'or '), el('label.btn.sm', { for: input.id }, 'Choose files'), input),
    el('span.muted.small', slide ? 'JPG or PNG · exactly 16:9 · 3840 × 2160 best, 1920 × 1080 minimum · up to 25 MB' : withFilms ? 'Photos: JPG or PNG, 1920 px wide or larger, up to 25 MB · Films: MP4, H.264 or HEVC, 1920 × 1080 or 3840 × 2160, up to 60 MB' : 'JPG or PNG · 1920 px wide or larger for full screen · up to 25 MB'));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async (e) => { e.preventDefault(); zone.classList.remove('over'); await uploadFiles(app, [...e.dataTransfer.files], null, { slide }); onDone(); });
  return zone;
}

export function mount(host, app) {
  const state = { filter: 'all', selected: null, selectedKind: 'photo', query: '' };
  const rail = el('div.rail');
  const main = el('main');
  const aside = el('aside');
  host.append(el('div.screen', rail, main, aside));

  const entries = () => {
    let list = app.media.entries();
    if (state.filter === 'unused') list = list.filter((e) => !usesOf(app, e).length);
    if (state.filter === 'pending') list = list.filter((e) => e.source === 'pending');
    if (state.filter === 'films') list = [];
    if (state.query) list = list.filter((e) => (e.name || '').toLowerCase().includes(state.query.toLowerCase()));
    return list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  };
  const films = () => {
    let list = app.media.films();
    if (state.filter === 'unused') list = list.filter((f) => !(model.imageUses().get(f.path) || []).length);
    if (state.filter === 'pending') list = list.filter((f) => f.source === 'pending');
    if (state.query) list = list.filter((f) => (f.name || '').toLowerCase().includes(state.query.toLowerCase()));
    return list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  };

  function renderRail() {
    clear(rail);
    const all = app.media.entries();
    const fl = app.media.films();
    rail.append(el('h3', 'Show'));
    for (const [k, label, n] of [['all', 'Everything', all.length + fl.length], ['films', 'Films', fl.length], ['pending', 'Waiting to publish', all.filter((e) => e.source === 'pending').length + fl.filter((f) => f.source === 'pending').length], ['unused', 'Not used anywhere', all.filter((e) => !usesOf(app, e).length).length + fl.filter((f) => !(model.imageUses().get(f.path) || []).length).length]]) {
      rail.append(el('button.fl' + (state.filter === k ? '.on' : ''), { type: 'button', onclick: () => { state.filter = k; renderRail(); renderMain(); } }, label, el('span', String(n))));
    }
    rail.append(el('div.rule'));
    rail.append(el('button.btn.sm', { type: 'button', onclick: () => app.go('guide') }, 'Guide for the visual team'));
    rail.append(el('p.muted.tiny', { style: { marginTop: '14px' } }, 'Photos already on the TV came from the app\'s built-in set. New uploads are kept in this browser until published.'));
  }

  function renderMain() {
    clear(main);
    const search = el('input.in', { type: 'search', placeholder: 'Search by name', 'aria-label': 'Search', value: state.query, style: { width: '220px' } });
    search.addEventListener('input', () => { state.query = search.value; renderGrid(); });
    main.append(el('div.row.between', { style: { marginBottom: '12px' } }, el('div', el('h1', 'Media'), el('p.muted', 'Every photo and film. Upload once, use anywhere. The Builder makes the TV sizes for photos; films are checked and kept as exported.')), search));
    main.append(dropZone(app, () => { renderRail(); renderMain(); }, { accept: 'image/jpeg,image/png,video/mp4,.mp4,.m4v' }));
    main.append(el('div#grid'));
    renderGrid();
  }

  function renderGrid() {
    const grid = main.querySelector('#grid');
    clear(grid);
    const fl = films();
    const list = entries();
    if (!list.length && !fl.length) { grid.append(el('div.empty', 'Nothing matches.')); return; }
    if (fl.length && state.filter !== 'films') grid.append(el('div.lab', 'Films', el('span', `${plural(fl.length, 'film')}`)));
    if (fl.length) {
      const g = el('div.grid');
      for (const f of fl) g.append(filmTile(app, f, f.hash === state.selected, (x) => { state.selected = x.hash; state.selectedKind = 'film'; renderGrid(); renderAside(); }));
      grid.append(g);
    }
    if (list.length) {
      if (fl.length) grid.append(el('div.lab', 'Photos', el('span', `${plural(list.length, 'photo')}`)));
      const g = el('div.grid');
      for (const e of list) g.append(tile(app, e, e.hash === state.selected, (x) => { state.selected = x.hash; state.selectedKind = 'photo'; renderGrid(); renderAside(); }));
      grid.append(g);
    }
  }

  function renderAside() {
    clear(aside);
    if (state.selectedKind === 'film') { renderFilmAside(); return; }
    const e = app.media.entries().find((x) => x.hash === state.selected);
    if (!e) { aside.append(el('p.muted', 'Select a photo or film to see where it is used.')); return; }
    const big = el('div.big-ph');
    const url = app.media.url(e.assetName || e.path, 800);
    if (url) big.style.backgroundImage = `url("${url}")`;
    if (shapeOf(e) !== 'ok') big.style.backgroundSize = 'contain';
    aside.append(el('div.row.between', { style: { marginBottom: '8px' } }, el('h2', { style: { margin: 0 } }, e.name || e.hash), el('span.pill' + (e.source === 'pending' ? '.green' : ''), e.source === 'pending' ? 'Waiting to publish' : 'Published')));
    aside.append(big);
    aside.append(el('p.muted.small', `${e.width} × ${e.height}${e.bytes ? ` · ${fmtBytes(e.bytes)}` : ''}${e.addedAt && e.addedAt !== 'seed' ? ` · added ${fmtDate(e.addedAt)}` : ''}${e.poster ? ' · poster' : ''}${(e.sizes || []).includes(SLIDE_SIZE) ? ' · 4K copy kept for slides' : ''}`));
    if (photoProblem({ width: e.width, height: e.height })) aside.append(el('div.note.warn.small', 'Too small for a strip or full screen (needs 1920 × 1080 or larger); fine on a card.'));
    else if (shapeOf(e) !== 'ok') aside.append(el('div.note.warn.small', `This is a ${shapeOf(e)} image. On a strip or as a page photo it is cropped to 16:9 and only a slice shows. For a logo or artwork, use a photo frame set to "Show the whole image", or a Finished page.`));
    if (!slideSizeProblem({ width: e.width, height: e.height })) aside.append(el('p.muted.tiny', { style: { marginTop: '6px' } }, 'Exactly 16:9 and 1920 × 1080 or larger: usable as a Finished page slide.'));
    const uses = usesOf(app, e);
    aside.append(el('h3', { style: { marginTop: '14px' } }, uses.length ? `Used in ${plural(uses.length, 'place')}` : 'Not used anywhere'));
    for (const u of uses) {
      aside.append(el('div.use', el('button', { type: 'button', onclick: () => app.go('editor', { page: u.pageId }) }, model.pathLabel(u.pageId)), el('span.muted', u.use)));
    }
    if (e.source === 'pending') {
      const inUndo = !uses.length && model.undoStack.some((u) => JSON.stringify(u.snapshot).includes(e.path));
      const why = uses.length ? 'In use: remove it from those pages first' : inUndo ? 'A page that was just deleted still uses it; it could come back with Undo' : '';
      aside.append(el('div.row', { style: { marginTop: '14px' } }, el('button.btn.sm', { type: 'button', onclick: () => renameEntry(e) }, 'Rename'),
        el('button.btn.sm.danger', { type: 'button', disabled: !!why, title: why, onclick: () => removeEntry(e) }, 'Delete')));
      if (why) aside.append(el('p.muted.tiny', { style: { marginTop: '4px' } }, why + '.'));
      aside.append(el('p.muted.tiny', { style: { marginTop: '6px' } }, 'Once published, a photo stays on the TV\'s server for good so old publishes can be restored.'));
    }
  }

  function renderFilmAside() {
    const f = app.media.films().find((x) => x.hash === state.selected);
    if (!f) { aside.append(el('p.muted', 'Select a photo or film to see where it is used.')); return; }
    const big = el('div.big-ph.film');
    const url = f.poster ? app.media.url(f.poster, 800) : null;
    if (url) big.style.backgroundImage = `url("${url}")`;
    big.append(el('span.play'));
    aside.append(el('div.row.between', { style: { marginBottom: '8px' } }, el('h2', { style: { margin: 0 } }, f.name), el('span.pill' + (f.source === 'pending' ? '.green' : ''), f.source === 'pending' ? 'Waiting to publish' : 'Published')));
    aside.append(big);
    aside.append(el('dl.kv',
      el('dt', 'Picture'), el('dd', `${f.width} × ${f.height}${f.height < 1080 ? ' (soft on a 4K TV)' : ''}`),
      el('dt', 'Length'), el('dd', fmtSeconds(f.seconds)),
      el('dt', 'Size'), el('dd', `${fmtBytes(f.bytes)}${f.mbps ? ` · ${f.mbps} Mb/s` : ''}`),
      el('dt', 'Video'), el('dd', codecName(f.codec)),
      el('dt', 'Sound'), el('dd', f.audio === true ? `Yes${f.audioCodec ? ` (${codecName(f.audioCodec)})` : ''}${f.silent ? ' · marked silent' : ''}` : f.audio === false ? 'No sound track' : f.silent ? 'Unknown · marked silent' : 'Unknown'),
      el('dt', 'Poster'), el('dd', f.poster ? app.media.label(f.poster) : 'None yet'),
      el('dt', 'Added'), el('dd', f.addedAt ? fmtDate(f.addedAt) : '—')));
    if (f.warnings?.length) for (const w of f.warnings) aside.append(el('div.note.warn.small', w));
    const silentRow = el('label.check', { style: { marginTop: '8px' } }, el('input', { type: 'checkbox', checked: !!f.silent, onchange: async (e) => { await app.media.setSilent(f.hash, e.target.checked); renderGrid(); renderAside(); model.emit({ type: 'media' }); } }), 'Treat as silent (use as a background loop; any sound is ignored)');
    if (f.audio !== false) aside.append(silentRow);
    aside.append(el('div.row', { style: { marginTop: '10px' } }, el('button.btn.sm', { type: 'button', onclick: () => posterCapture(app, f.path, { onDone: () => { renderGrid(); renderAside(); } }) }, f.poster ? 'Change poster' : 'Capture a poster')));
    const uses = model.imageUses().get(f.path) || [];
    aside.append(el('h3', { style: { marginTop: '14px' } }, uses.length ? `Used in ${plural(uses.length, 'place')}` : 'Not used anywhere'));
    for (const u of uses) aside.append(el('div.use', el('button', { type: 'button', onclick: () => app.go('editor', { page: u.pageId }) }, model.pathLabel(u.pageId)), el('span.muted', u.use)));
    if (f.source === 'pending') {
      const inUndo = !uses.length && model.undoStack.some((u) => JSON.stringify(u.snapshot).includes(f.path));
      const why = uses.length ? 'In use: remove it from those pages first' : inUndo ? 'A page that was just deleted still uses it; it could come back with Undo' : '';
      aside.append(el('div.row', { style: { marginTop: '14px' } }, el('button.btn.sm', { type: 'button', onclick: () => renameFilm(f) }, 'Rename'),
        el('button.btn.sm.danger', { type: 'button', disabled: !!why, title: why, onclick: () => removeFilm(f) }, 'Delete')));
      if (why) aside.append(el('p.muted.tiny', { style: { marginTop: '4px' } }, why + '.'));
      aside.append(el('p.muted.tiny', { style: { marginTop: '6px' } }, `Goes to the TV with the next publish as one ${fmtBytes(f.bytes)} upload. Once published, a film stays for good so old publishes can be restored.`));
    }
  }

  async function renameEntry(e) {
    let v = e.name;
    const f = textField({ label: 'Name', value: e.name, limit: 40, id: uid('n'), onInput: (x) => { v = x; } });
    modal({ title: 'Rename photo', body: f, actions: [{ label: 'Cancel' }, { label: 'Rename', primary: true, onClick: async () => { const rec = await app.browser.getMedia(e.hash); if (rec) { rec.name = v.trim() || rec.name; await app.media.add(rec); } renderGrid(); renderAside(); } }] });
  }

  async function renameFilm(f) {
    let v = f.name;
    const field = textField({ label: 'Name', value: f.name, limit: 40, id: uid('n'), onInput: (x) => { v = x; } });
    modal({ title: 'Rename film', body: field, actions: [{ label: 'Cancel' }, { label: 'Rename', primary: true, onClick: async () => { const rec = await app.browser.getMedia(f.hash); if (rec) { rec.name = v.trim() || rec.name; await app.media.add(rec); } renderGrid(); renderAside(); } }] });
  }

  async function removeEntry(e) {
    const ok = await confirmModal('Delete this photo?', 'It has not been published, so nothing on the TV changes.', { okLabel: 'Delete', danger: true });
    if (!ok) return;
    await app.media.remove(e.hash);
    state.selected = null;
    renderRail(); renderMain(); renderAside();
  }

  async function removeFilm(f) {
    const ok = await confirmModal('Delete this film?', 'It has not been published, so nothing on the TV changes. Its poster stays in Media as a photo.', { okLabel: 'Delete', danger: true });
    if (!ok) return;
    await app.media.remove(f.hash);
    state.selected = null;
    renderRail(); renderMain(); renderAside();
  }

  renderRail(); renderMain(); renderAside();
  return { update() { renderRail(); renderGrid(); renderAside(); } };
}

const USE_TEXT = {
  strip: 'On a strip and as a page background the photo fills the frame and is cropped to 16:9 (and to a thin slice when the strip is closed).',
  frame: 'A photo frame can fill the frame (cropped to 16:9, like a photograph) or show the whole image on a dark ground (for a logo, poster or plan).',
  card: 'Cards show the photo cropped to a small 16:9 tile.',
  slide: 'Slides are shown full screen exactly as made: they must be 16:9 and at least 1920 × 1080.',
  poster: 'The poster is shown full frame before the film plays.',
};

/**
 * The picker: choose from the library or upload. onPick(src, {fit}) gets the
 * value to store: the bundled asset name where one exists (the TV already
 * has that photo), otherwise the media path. `use` says what it is for:
 * strip (default), frame, card, slide or poster; the shape warning and the
 * "whole image" choice depend on it.
 */
export function pickPhoto(app, { onPick, use = 'strip', cardsOK = true }) {
  let selected = null;
  let query = '';
  const grid = el('div.grid', { style: { maxHeight: '44vh', overflow: 'auto', padding: '2px' } });
  const warn = el('div');
  const list = () => {
    let l = app.media.entries();
    if (use === 'slide') l = l.filter((e) => !slideSizeProblem({ width: e.width, height: e.height }));
    if (query) l = l.filter((e) => (e.name || '').toLowerCase().includes(query.toLowerCase()));
    return l.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  };
  const render = () => {
    clear(grid);
    const l = list();
    for (const e of l) grid.append(tile(app, e, e.hash === selected, (x) => { selected = x.hash; render(); refreshActions(); }));
    if (!l.length) grid.append(el('div.empty', use === 'slide' ? 'No photos in Media are exactly 16:9 and 1920 × 1080 or larger. Drop the artwork above.' : 'No photos match.'));
  };
  const refreshActions = () => {
    clear(warn);
    const e = app.media.entries().find((x) => x.hash === selected);
    const shape = e ? shapeOf(e) : 'ok';
    const small = e && photoProblem({ width: e.width, height: e.height });
    okBtn.disabled = !e;
    wholeBtn.style.display = 'none';
    okBtn.textContent = 'Use this photo';
    if (!e) return;
    if (use === 'frame') {
      wholeBtn.style.display = '';
      okBtn.textContent = 'Fill the frame (cropped)';
      wholeBtn.textContent = 'Show the whole image';
    }
    if (shape !== 'ok' && (use === 'strip' || use === 'frame' || use === 'card' || use === 'poster')) {
      warn.append(el('div.note.warn.small', { style: { marginTop: '8px' } }, el('strong', 'This will be cropped heavily. '),
        `It is ${e.width} × ${e.height}, a ${shape} shape, and ${use === 'frame' ? 'filling the frame' : 'this spot'} crops to 16:9, so only a slice shows. `,
        use === 'frame' ? 'Choose "Show the whole image" for logos and artwork.' : 'Use "Show the whole image" in a photo frame for logos and artwork, or a Finished page.'));
      if (use === 'strip' || use === 'card' || use === 'poster') okBtn.textContent = 'Use it anyway';
    } else if (small && use !== 'card') {
      warn.append(el('div.note.warn.small', { style: { marginTop: '8px' } }, `${e.width} × ${e.height} is too small for full screen (needs 1920 × 1080); the page would be held back. Fine on a card.`));
    }
  };
  const search = el('input.in', { type: 'search', placeholder: 'Search by name', 'aria-label': 'Search', style: { maxWidth: '260px' } });
  search.addEventListener('input', () => { query = search.value; render(); });
  const body = el('div', el('p.help', { style: { marginBottom: '8px' } }, USE_TEXT[use] || USE_TEXT.strip),
    dropZone(app, () => { const fresh = app.media.entries().filter((e) => e.source === 'pending').sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''))[0]; if (fresh) selected = fresh.hash; render(); refreshActions(); }, { slide: use === 'slide', accept: 'image/jpeg,image/png' }),
    search, el('div', { style: { height: '10px' } }), grid, warn);
  if (!cardsOK) body.prepend(el('p.help', 'Photos under 1920 px wide are shown but will hold the page back.'));
  const pick = (fit) => {
    const e = app.media.entries().find((x) => x.hash === selected);
    if (!e) return false;
    onPick(e.assetName || e.path, { fit });
    return true;
  };
  const m = modal({ title: use === 'slide' ? 'Choose artwork for a slide' : use === 'poster' ? 'Choose a poster' : 'Choose a photo', body, wide: true,
    actions: [{ label: 'Cancel' }, { label: 'Show the whole image', onClick: () => pick('whole') }, { label: 'Use this photo', primary: true, disabled: true, onClick: () => pick('fill') }] });
  const btns = m.box.querySelectorAll('.actions .btn');
  const wholeBtn = btns[1];
  const okBtn = btns[2];
  wholeBtn.style.display = 'none';
  render();
  refreshActions();
}
