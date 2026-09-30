// Page editor: parts on the left, live TV preview in the middle, the selected
// part's fields on the right. Every keystroke updates the preview.

import { el, clear, svgIcon, plural } from '../util.js';
import { model, addPage, newPage, movePage, moveInList, PAGE_TYPES } from '../model.js';
import { LIMITS, validQR } from '../validate.js';
import { toast, textField, uid, sortable, moveButtons, iconButton, confirmModal, modal } from '../ui.js';
import { TVPreview } from '../preview/stage.js';
import { pickPhoto } from './media.js';
import { remotePad } from './remote.js';

/** Sets a text field, dropping it when empty so the bundle stays clean. */
const put = (obj, key, v) => { if (v === '' || v == null) delete obj[key]; else obj[key] = v; };

const PART_DEFS = {
  heading:  { label: 'Heading', hint: 'Small caps line, title, subtitle' },
  photo:    { label: 'Photo', hint: 'Strip and background' },
  text:     { label: 'Text', hint: 'A short paragraph' },
  facts:    { label: 'Facts', hint: 'Up to six points' },
  hours:    { label: 'Hours & details', hint: 'Rows of label and value' },
  qr:       { label: 'QR link', hint: 'A web address and one line' },
  children: { label: 'Pages under it', hint: 'Tiles that open further pages' },
  menu:     { label: 'Menu', hint: 'Parts, dishes, prices' },
  images:   { label: 'Photos', hint: 'The gallery' },
  items:    { label: 'Cards', hint: 'Title, line, text, photo' },
  hotel:    { label: 'Contact card', hint: 'From Hotel details' },
};

function partsFor(page) {
  switch (page.type) {
    case 'home': return ['heading', 'photo', 'children'];
    case 'hub': return ['heading', 'photo', 'text', 'children'];
    case 'info': return ['heading', 'photo', 'text', 'facts', 'children', 'hours', 'qr'];
    case 'menu': return ['heading', 'photo', 'text', 'menu', 'hours', 'qr'];
    case 'gallery': return ['heading', 'photo', 'images'];
    case 'list': return ['heading', 'photo', 'text', 'items'];
    case 'contact': return ['heading', 'photo', 'hotel', 'facts', 'text', 'qr'];
    default: return ['heading', 'photo'];
  }
}

function partForField(field) {
  const head = field.split('.')[0];
  return { title: 'heading', kicker: 'heading', subtitle: 'heading', image: 'photo', body: 'text', facts: 'facts', hours: 'hours', qr: 'qr', children: 'children', sections: 'menu', images: 'images', items: 'items' }[head] || 'heading';
}

function partSummary(page, part, app) {
  switch (part) {
    case 'heading': return page.title || 'No title';
    case 'photo': return app.media.label(page.image);
    case 'text': return page.body ? page.body.slice(0, 40) + (page.body.length > 40 ? '…' : '') : 'Not used';
    case 'facts': return (page.facts || []).length ? plural(page.facts.length, 'point') : 'Not used';
    case 'hours': return (page.hours || []).length ? plural(page.hours.length, 'row') : 'Not used';
    case 'qr': return page.qr ? page.qr.label || page.qr.url : 'Not used';
    case 'children': return (page.children || []).length ? page.children.map((c) => c.title).join(' · ') : 'None yet';
    case 'menu': { const n = (page.sections || []).reduce((a, s) => a + (s.items || []).length, 0); return `${plural((page.sections || []).length, 'part')} · ${plural(n, 'dish', 'dishes')}`; }
    case 'images': return (page.images || []).length ? plural(page.images.length, 'photo') : 'None yet';
    case 'items': return (page.items || []).length ? plural(page.items.length, 'card') : 'None yet';
    case 'hotel': return 'Reception, room service, Wi-Fi, check-out';
    default: return '';
  }
}

export function mount(host, app, params) {
  const pageId = params.page;
  const found = model.find(pageId);
  if (!found) { host.append(el('div.empty', 'That page no longer exists. ', el('button.btn.link', { type: 'button', onclick: () => app.go('home') }, 'Back to Home'))); return {}; }

  const compact = () => window.innerWidth <= 1200;
  const state = { part: 'heading', field: null, mode: 'edit', safe: false, view: 'draft', focusField: null, showRemote: compact() || matchMedia('(pointer: coarse)').matches };
  let preview = null;
  const page = () => model.find(pageId)?.page;
  const commit = (label, fn, key) => {
    model.commit(label, (d) => fn(model.find(pageId, d).page, d), { origin: 'editor', coalesce: key, pageId });
    // Typing while "On TVs now" is showing: flip back to the draft so the change is seen.
    if (state.view === 'published') { state.view = 'draft'; renderCentre(); }
  };

  const sub = el('div.sub');
  const rail = el('div.rail');
  const centre = el('div.centre');
  const side = el('div.side');
  host.append(sub, el('div.editor', rail, centre, side));

  // ---- sub bar ----
  function renderSub() {
    clear(sub);
    const p = page();
    const e = model.find(pageId);
    const crumb = el('span.crumb', el('button', { type: 'button', onclick: () => app.go('home', { page: pageId }) }, 'Home'));
    e.path.forEach((t, i) => { crumb.append(' › '); crumb.append(i === e.path.length - 1 ? el('b', t) : t); });
    sub.append(crumb, el('span.pill', PAGE_TYPES[p.type]?.label || p.type));
    if (p.hidden) sub.append(el('span.pill.dark', 'Hidden from guests'));
    sub.append(el('span.spacer'));
    sub.append(el('button.btn.sm', { type: 'button', disabled: !model.canUndo, title: model.canUndo ? `Undo ${model.undoLabel}` : 'Nothing to undo', onclick: () => { const l = model.undo(); if (l) toast(`Undid: ${l}`, { ms: 2500 }); } }, '← Undo'));
    sub.append(el('button.btn.sm', { type: 'button', onclick: () => app.go('home', { page: pageId }) }, 'Done'));
  }

  // ---- rail ----
  function renderRail() {
    clear(rail);
    const p = page();
    const v = app.validation().get(pageId) || { blockers: [], warnings: [] };
    rail.append(el('h3', 'Parts of this page'));
    for (const part of partsFor(p)) {
      const flags = [...v.blockers.map((b) => ({ ...b, k: 'block' })), ...v.warnings.map((w) => ({ ...w, k: 'warn' }))].filter((x) => partForField(x.field) === part);
      const b = el('button.part' + (part === state.part ? '.sel' : ''), { type: 'button', onclick: () => selectPart(part) },
        el('div.w', el('div.n', PART_DEFS[part].label), el('div.s', partSummary(p, part, app))));
      if (flags.length) b.append(el('span.flag.' + (flags.some((f) => f.k === 'block') ? 'block' : 'warn'), { title: flags.map((f) => f.message).join('\n') }));
      rail.append(b);
    }
    rail.append(el('p.muted.tiny', { style: { marginTop: '14px' } }, 'Staff choose the words and photos. The TV decides fonts, colours and where each part sits.'));
  }

  // ---- centre ----
  function renderCentre() {
    clear(centre);
    const modeSeg = el('div.seg', { role: 'group', 'aria-label': 'Preview mode' });
    for (const [v, label] of [['edit', 'Edit'], ['remote', 'Try the remote']]) {
      modeSeg.append(el('button', { type: 'button', class: state.mode === v ? 'on' : '', 'aria-pressed': String(state.mode === v), onclick: () => setMode(v) }, label));
    }
    const safe = el('label.check', el('input', { type: 'checkbox', checked: state.safe, onchange: (e) => { state.safe = e.target.checked; preview.setSafeArea(state.safe); } }), 'Safe area');
    const viewSeg = el('div.seg', { role: 'group', 'aria-label': 'Draft or published' });
    for (const [v, label] of [['draft', 'Draft'], ['published', 'On TVs now']]) {
      viewSeg.append(el('button', { type: 'button', class: state.view === v ? 'on' : '', 'aria-pressed': String(state.view === v), onclick: () => { state.view = v; renderCentre(); } }, label));
    }
    const remoteToggle = el('label.check', el('input', { type: 'checkbox', checked: state.showRemote, onchange: (e) => { state.showRemote = e.target.checked; wrap.classList.toggle('show-remote', state.showRemote); } }), 'On-screen remote');
    centre.append(el('div.row.between', { style: { marginBottom: '10px' } }, el('div.row', modeSeg, safe, state.mode === 'remote' ? remoteToggle : null), viewSeg));
    const tvHost = el('div.tv-host');
    const wrap = el('div.remote-wrap' + (state.showRemote && state.mode === 'remote' ? '.show-remote' : ''), tvHost);
    centre.append(wrap);
    preview?.destroy();
    preview = new TVPreview(tvHost, {
      media: app.media, logoURL: app.logoURL,
      onSelectField: (pid, field) => {
        if (pid === 'hotel') { toast('Reception, room service, Wi-Fi and check-out are set in Hotel details.', { action: 'Open', onAction: () => app.go('hotel') }); return; }
        if (pid !== pageId) { app.go('editor', { page: pid }); return; }
        state.focusField = field;
        selectPart(partForField(field), field);
      },
      onNavigate: (pid) => { if (pid !== pageId && state.mode === 'edit' && model.find(pid)) app.go('editor', { page: pid }); },
    });
    preview.setSafeArea(state.safe);
    refreshPreview(true);
    preview.setMode(state.mode);
    wrap.append(remotePad((k) => preview.key(k), { wide: compact() }));
    preview.fit();
    const scaleCap = el('span.muted.tiny');
    const showScale = () => { scaleCap.textContent = `1920 × 1080, shown at ${Math.round((preview.viewport.clientWidth || 800) / 1920 * 100)}%`; };
    preview.onFit = showScale;
    showScale();
    centre.append(el('div.tvcap', el('span.muted.small', state.mode === 'edit' ? 'Click anything on the TV to edit it. Click a strip to open it.' : 'Arrow keys move, Enter selects, Esc is Menu. Click the TV first if the keys do nothing.'), scaleCap));
    if (state.view === 'published' && !model.find(pageId, model.published?.bundle)) {
      centre.append(el('div.note.small', { style: { marginTop: '8px' } }, 'Not on TVs yet. This page is new; it goes to the TV when you publish.'));
    }
  }

  function refreshPreview(navigate = false) {
    const doc = state.view === 'published' ? model.published?.bundle : model.draft;
    if (!doc) return;
    preview.setDoc(doc, { reveal: [pageId] });
    if (navigate) preview.showPage(pageId);
    if (state.field) preview.setSelectedField(`${pageId}|${state.field}`);
  }

  function setMode(m) {
    state.mode = m;
    renderCentre();
    if (m === 'remote') preview.stage.focus();
  }

  // ---- side ----
  function selectPart(part, field = null) {
    state.part = part;
    state.field = field;
    renderRail();
    renderSide();
    preview.setSelectedField(field ? `${pageId}|${field}` : null);
    if (field) {
      const target = side.querySelector(`[data-field="${CSS.escape(field)}"]`);
      if (target) { target.focus(); target.scrollIntoView({ block: 'nearest' }); }
    }
  }

  const tf = (o) => {
    const f = textField({ id: uid('e'), ...o });
    f.input.dataset.field = o.field;
    f.input.addEventListener('focus', () => { state.field = o.field; preview.setSelectedField(`${pageId}|${o.field}`); });
    return f;
  };

  function renderSide() {
    clear(side);
    const p = page();
    side.append(el('div.row.between', { style: { marginBottom: '10px' } }, el('h2', { style: { margin: 0 } }, PART_DEFS[state.part].label), el('span.muted.small', PART_DEFS[state.part].hint)));
    const body = el('div');
    side.append(body);
    switch (state.part) {
      case 'heading': renderHeading(body, p); break;
      case 'photo': renderPhoto(body, p); break;
      case 'text': renderText(body, p); break;
      case 'facts': renderFacts(body, p); break;
      case 'hours': renderHours(body, p); break;
      case 'qr': renderQR(body, p); break;
      case 'children': renderChildren(body, p); break;
      case 'menu': renderMenuPart(body, p); break;
      case 'images': renderImages(body, p); break;
      case 'items': renderItems(body, p); break;
      case 'hotel': renderHotelPart(body); break;
    }
    side.append(el('div.rule'));
    side.append(el('h3', 'Checks on this page'));
    side.append(el('div#checks', checks(p)));
    side.append(el('div.rule'));
    side.append(el('h3', 'This page'));
    const ops = el('div.row.wrap');
    if (p.id !== 'home') {
      ops.append(el('button.btn.sm', { type: 'button', onclick: () => commit(p.hidden ? `Show ${p.title}` : `Hide ${p.title}`, (pg) => { if (pg.hidden) delete pg.hidden; else pg.hidden = true; }) }, p.hidden ? 'Show to guests' : 'Hide from guests'));
    }
    ops.append(el('button.btn.sm', { type: 'button', onclick: () => app.go('home', { page: pageId }) }, 'Open in Home'));
    side.append(ops);
  }

  function checks(p) {
    const v = app.validation().get(p.id) || { blockers: [], warnings: [] };
    const box = el('div');
    for (const b of v.blockers) box.append(el('div.note.block.small', el('strong', 'Held back. '), b.message + '.'));
    for (const w of v.warnings) box.append(el('div.note.warn.small', el('strong', 'Warning. '), w.message + '.'));
    if (!v.blockers.length) box.append(el('p.small.muted', { style: { marginTop: '6px' } }, v.warnings.length ? 'Warnings do not stop publishing.' : 'No problems. This page can be published.'));
    return box;
  }

  // ---- part panels ----
  function renderHeading(box, p) {
    box.append(tf({ label: 'Small caps line', field: 'kicker', value: p.kicker || '', limit: LIMITS.kicker, help: 'Shown in gold above the title, e.g. "AA 2 Rosettes".', onInput: (v) => commit('Edit small caps line', (pg) => put(pg, 'kicker', v), 'kicker') }));
    box.append(tf({ label: 'Title', field: 'title', value: p.title || '', limit: LIMITS.title, onInput: (v) => commit('Edit title', (pg) => { pg.title = v; }, 'title') }));
    if (p.type !== 'gallery') box.append(tf({ label: 'Subtitle', field: 'subtitle', value: p.subtitle || '', limit: LIMITS.subtitle, help: 'One line under the title.', onInput: (v) => commit('Edit subtitle', (pg) => put(pg, 'subtitle', v), 'subtitle') }));
  }

  function renderPhoto(box, p) {
    const thumb = el('div.thumb');
    const url = app.media.url(p.image, 800);
    if (url) thumb.style.backgroundImage = `url("${url}")`;
    const missing = p.image && !app.media.known(p.image);
    box.append(el('div.photo-pick', thumb, el('div', el('div.small', { style: missing ? { color: 'var(--red)', fontWeight: '600' } : {} }, missing ? 'Photo missing: it is no longer in Media. Choose another.' : app.media.label(p.image)), el('div.row', { style: { marginTop: '6px' } },
      el('button.btn.sm', { type: 'button', onclick: () => pickPhoto(app, { onPick: (src) => commit('Change photo', (pg) => { pg.image = src; }) }) }, 'Choose photo'),
      p.image && p.id !== 'home' ? el('button.btn.sm', { type: 'button', onclick: () => commit('Remove photo', (pg) => { delete pg.image; }) }, 'Remove') : null))));
    box.append(el('p.help', 'One photo does both jobs: the strip on the way in and the background of the page. Landscape, 1920 px wide or more.'));
  }

  function renderText(box, p) {
    box.append(tf({ label: 'Paragraph', field: 'body', value: p.body || '', limit: LIMITS.body, multiline: true, rows: 7, help: 'Two or three sentences read best from the bed.', onInput: (v) => commit('Edit text', (pg) => put(pg, 'body', v), 'body') }));
  }

  function listEditor(box, { items, render, onMove, onAdd, onRemove, addLabel, max, selector = '.list-row' }) {
    const list = el('div', { role: 'list' });
    items.forEach((item, i) => {
      const row = el('div.list-row', { draggable: 'true', role: 'listitem' });
      row.append(el('span.grip', { title: 'Drag to reorder' }, svgIcon('grip', 14)));
      row.append(el('div.fields', render(item, i)));
      const ops = moveButtons(i, items.length, onMove);
      ops.append(iconButton('close', 'Remove', () => onRemove(i)));
      row.append(ops);
      list.append(row);
    });
    sortable(list, selector, onMove);
    box.append(list);
    if (!items.length) box.append(el('p.muted.small', 'Nothing here yet.'));
    box.append(el('div', { style: { marginTop: '8px' } }, el('button.btn.sm', { type: 'button', disabled: max && items.length >= max, onclick: onAdd }, '+ ' + addLabel)));
  }

  function renderFacts(box, p) {
    listEditor(box, {
      items: p.facts || [],
      render: (t, i) => tf({ label: `Fact ${i + 1}`, field: `facts.${i}`, value: t, limit: LIMITS.fact, onInput: (v) => commit('Edit fact', (pg) => { pg.facts[i] = v; }, `facts.${i}`) }),
      onMove: (a, b) => commit('Reorder facts', (pg) => moveInList(pg.facts, a, b)),
      onAdd: () => { commit('Add fact', (pg) => { pg.facts = pg.facts || []; pg.facts.push(''); }); renderSide(); },
      onRemove: (i) => removeWithUndo('fact', (pg) => pg.facts.splice(i, 1)[0], (pg, v) => pg.facts.splice(i, 0, v)),
      addLabel: 'Add fact', max: LIMITS.factsMax + 4,
    });
  }

  function renderHours(box, p) {
    listEditor(box, {
      items: p.hours || [],
      render: (h, i) => [
        tf({ label: 'Label', field: `hours.${i}.label`, value: h.label || '', limit: LIMITS.hoursLabel, placeholder: 'Dinner', onInput: (v) => commit('Edit hours', (pg) => { pg.hours[i].label = v; }, `hours.${i}.label`) }),
        tf({ label: 'Value', field: `hours.${i}.value`, value: h.value || '', limit: LIMITS.hoursValue, placeholder: 'Wed – Sat, 6:00 – 9:30pm', onInput: (v) => commit('Edit hours', (pg) => { pg.hours[i].value = v; }, `hours.${i}.value`) })],
      onMove: (a, b) => commit('Reorder hours', (pg) => moveInList(pg.hours, a, b)),
      onAdd: () => { commit('Add hours row', (pg) => { pg.hours = pg.hours || []; pg.hours.push({ label: '', value: '' }); }); renderSide(); },
      onRemove: (i) => removeWithUndo('hours row', (pg) => pg.hours.splice(i, 1)[0], (pg, v) => pg.hours.splice(i, 0, v)),
      addLabel: 'Add row',
    });
    box.append(el('p.help', 'Shown under the heading "Opening hours" in the side column.'));
  }

  function renderQR(box, p) {
    if (!p.qr) {
      box.append(el('p.small.muted', 'No QR link on this page.'));
      box.append(el('button.btn.sm', { type: 'button', onclick: () => { commit('Add QR link', (pg) => { pg.qr = { label: '', url: 'https://www.cavehotels.com/' }; }); renderSide(); } }, '+ Add QR link'));
      return;
    }
    box.append(tf({ label: 'What it does', field: 'qr.label', value: p.qr.label || '', limit: LIMITS.qrLabel, placeholder: 'Book a table at the Firepit', onInput: (v) => commit('Edit QR line', (pg) => { pg.qr.label = v; }, 'qr.label') }));
    const url = tf({ label: 'Web address', field: 'qr.url', value: p.qr.url || '', type: 'url', spellcheck: false, placeholder: 'https://www.cavehotels.com/…', onInput: (v) => { commit('Edit QR address', (pg) => { pg.qr.url = v; }, 'qr.url'); check(v); } });
    const status = el('div.help');
    const check = (v) => { status.textContent = validQR(v) ? 'Looks right. The TV draws it as a QR code guests scan with their phone.' : 'Not a valid web address yet. It should start with https://'; status.style.color = validQR(v) ? '' : 'var(--red)'; };
    check(p.qr.url);
    box.append(url, status);
    box.append(el('button.btn.sm.danger', { type: 'button', style: { marginTop: '8px' }, onclick: () => removeWithUndo('QR link', (pg) => { const q = pg.qr; delete pg.qr; return q; }, (pg, v) => { pg.qr = v; }) }, 'Remove QR link'));
  }

  function renderChildren(box, p) {
    const kids = p.children || [];
    listEditor(box, {
      items: kids,
      render: (c) => el('div.row.between', el('span', el('b', c.title), c.hidden ? el('span.pill.dark', { style: { marginLeft: '6px' } }, 'Hidden') : null),
        el('button.btn.sm', { type: 'button', onclick: () => app.go('editor', { page: c.id }) }, 'Open')),
      onMove: (a, b) => model.commit('Reorder pages', (d) => movePage(d, pageId, a, b), { origin: 'editor' }),
      onAdd: () => addChild(p),
      onRemove: async (i) => {
        const c = kids[i];
        const ok = await confirmModal(`Delete ${c.title}?`, 'It will be removed from the TV when you next publish. You can undo this straight away.', { okLabel: 'Delete', danger: true });
        if (!ok) return;
        let removed = null;
        commit(`Delete ${c.title}`, (pg) => { removed = pg.children.splice(i, 1)[0]; });
        toast(`Deleted ${c.title}.`, { action: 'Undo', onAction: () => model.commit(`Restore ${c.title}`, (d) => addPage(d, pageId, removed, i), { origin: 'editor', undoable: false }) });
      },
      addLabel: 'Add a page under this one', max: LIMITS.itemsMax + 4,
    });
    box.append(el('p.help', p.type === 'hub' || p.type === 'home' ? 'These are the strips guests see inside this section.' : 'Shown as tiles at the bottom of the page. Guests are never more than four presses from home, so keep it to one level.'));
  }

  function addChild(p) {
    let title = '';
    let type = 'info';
    const types = ['info', 'menu', 'gallery', 'list'];
    const buttons = types.map((t) => el('button', { type: 'button', class: t === type ? 'on' : '', dataset: { t }, onclick: () => { type = t; buttons.forEach((b) => b.classList.toggle('on', b.dataset.t === t)); } }, el('b', PAGE_TYPES[t].label), el('span', PAGE_TYPES[t].hint)));
    const field = textField({ label: 'Title', value: '', limit: LIMITS.title, id: uid('t'), onInput: (v) => { title = v; } });
    modal({ title: `Add a page under ${p.title}`, body: el('div', el('div.tpl', ...buttons), field),
      actions: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: () => {
        const t = title.trim(); if (!t) { field.input.focus(); return false; }
        const np = newPage(type, t, model.newId(t));
        model.commit(`Add ${t}`, (d) => addPage(d, pageId, np), { origin: 'editor' });
        toast(`Added ${t}.`, { action: 'Open it', onAction: () => app.go('editor', { page: np.id }) });
        renderSide();
        return true;
      } }] });
  }

  function renderMenuPart(box, p) {
    const n = (p.sections || []).reduce((a, s) => a + (s.items || []).length, 0);
    box.append(el('p.small', `${plural((p.sections || []).length, 'part')}, ${plural(n, 'dish', 'dishes')}.`));
    box.append(el('p.help', 'Dishes, descriptions, prices and tags are edited on the Menus screen, where the whole menu is laid out as a table.'));
    box.append(el('button.btn.pri.sm', { type: 'button', style: { marginTop: '8px' }, onclick: () => app.go('menus', { menu: pageId }) }, 'Edit dishes in Menus'));
  }

  function renderImages(box, p) {
    const imgs = p.images || [];
    listEditor(box, {
      items: imgs,
      render: (src, i) => {
        const th = el('div.thumb');
        const url = app.media.url(src, 800);
        if (url) th.style.backgroundImage = `url("${url}")`;
        return el('div.photo-pick', th, el('div', el('div.small', `${i + 1}. ${app.media.label(src)}`), el('button.btn.sm', { type: 'button', style: { marginTop: '4px' }, onclick: () => pickPhoto(app, { onPick: (s) => commit('Change gallery photo', (pg) => { pg.images[i] = s; }) }) }, 'Swap')));
      },
      onMove: (a, b) => commit('Reorder photos', (pg) => moveInList(pg.images, a, b)),
      onAdd: () => pickPhoto(app, { onPick: (s) => { commit('Add gallery photo', (pg) => { pg.images = pg.images || []; pg.images.push(s); }); renderSide(); } }),
      onRemove: (i) => removeWithUndo('photo', (pg) => pg.images.splice(i, 1)[0], (pg, v) => pg.images.splice(i, 0, v)),
      addLabel: 'Add photo', max: LIMITS.galleryMax,
    });
    box.append(el('p.help', 'The first photo shows when the page opens. Guests move along the thumbnails with the remote.'));
  }

  function renderItems(box, p) {
    const items = p.items || [];
    listEditor(box, {
      items,
      render: (it, i) => {
        const th = el('div.thumb');
        const url = app.media.url(it.image, 800);
        if (url) th.style.backgroundImage = `url("${url}")`;
        return [
          tf({ label: `Card ${i + 1} title`, field: `items.${i}.title`, value: it.title || '', limit: LIMITS.cardTitle, onInput: (v) => commit('Edit card', (pg) => { pg.items[i].title = v; }, `items.${i}.title`) }),
          tf({ label: 'Date or distance', field: `items.${i}.meta`, value: it.meta || '', limit: LIMITS.cardMeta, placeholder: 'Sat 4 Oct · 15 min drive', onInput: (v) => commit('Edit card', (pg) => { if (v) pg.items[i].meta = v; else delete pg.items[i].meta; }, `items.${i}.meta`) }),
          tf({ label: 'One line', field: `items.${i}.subtitle`, value: it.subtitle || '', limit: LIMITS.cardSubtitle, onInput: (v) => commit('Edit card', (pg) => { if (v) pg.items[i].subtitle = v; else delete pg.items[i].subtitle; }, `items.${i}.subtitle`) }),
          tf({ label: 'Text', field: `items.${i}.body`, value: it.body || '', limit: LIMITS.cardBody, multiline: true, rows: 3, onInput: (v) => commit('Edit card', (pg) => { if (v) pg.items[i].body = v; else delete pg.items[i].body; }, `items.${i}.body`) }),
          el('div.photo-pick', { dataset: { field: `items.${i}.image` }, tabindex: '-1' }, th, el('div', el('div.small', app.media.label(it.image)),
            el('button.btn.sm', { type: 'button', style: { marginTop: '4px' }, onclick: () => pickPhoto(app, { onPick: (s) => commit('Change card photo', (pg) => { pg.items[i].image = s; }) }) }, it.image ? 'Swap photo' : 'Choose photo'))),
        ];
      },
      onMove: (a, b) => commit('Reorder cards', (pg) => moveInList(pg.items, a, b)),
      onAdd: () => { commit('Add card', (pg) => { pg.items = pg.items || []; pg.items.push({ title: 'New card' }); }); renderSide(); },
      onRemove: (i) => removeWithUndo('card', (pg) => pg.items.splice(i, 1)[0], (pg, v) => pg.items.splice(i, 0, v)),
      addLabel: 'Add card',
    });
  }

  function renderHotelPart(box) {
    const h = model.draft.hotel;
    box.append(el('dl.kv', el('dt', 'Reception'), el('dd', h.reception || '—'), el('dt', 'Room service'), el('dd', h.roomService || '—'), el('dt', 'Wi-Fi'), el('dd', h.wifiName || '—'), el('dt', 'Check-out'), el('dd', h.checkout || '—')));
    box.append(el('p.help', 'These come from Hotel details, so they are the same on every page that shows them.'));
    box.append(el('button.btn.sm', { type: 'button', onclick: () => app.go('hotel') }, 'Edit Hotel details'));
  }

  function removeWithUndo(what, take, putBack) {
    let removed = null;
    commit(`Remove ${what}`, (pg) => { removed = take(pg); });
    renderSide();
    toast(`Removed the ${what}.`, { action: 'Undo', onAction: () => { model.commit(`Restore ${what}`, (d) => putBack(model.find(pageId, d).page, removed), { origin: 'editor', undoable: false }); renderSide(); } });
  }

  renderSub();
  renderRail();
  renderCentre();
  renderSide();

  // A link can open the editor in remote mode and press keys, e.g.
  // ?remote=down,down,enter — handy for sharing and for screenshots.
  const remoteParam = new URLSearchParams(location.search).get('remote');
  if (remoteParam !== null) {
    state.showRemote = true;
    setMode('remote');
    let delay = 600;
    for (const k of remoteParam.split(',').filter(Boolean)) { setTimeout(() => preview.key(k), delay); delay += 500; }
  }

  return {
    update(ev) {
      if (!model.find(pageId)) { app.go('home'); return; }
      renderSub();
      renderRail();
      refreshPreview(false);
      // Our own typing: keep the side panel (and its focus) as it is.
      // Anything else (undo, list changes) rebuilds it.
      if (ev.origin !== 'editor' || !ev.label.startsWith('Edit')) renderSide();
      else { const c = side.querySelector('#checks'); if (c) { clear(c); c.append(checks(page())); } }
    },
    unmount() { preview?.destroy(); },
  };
}
