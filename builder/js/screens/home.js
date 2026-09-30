// Home: the tree drawn as strips. Reorder, hide, add, rename, delete, open.

import { el, clear, svgIcon, plural, fmtDate } from '../util.js';
import { model, newPage, movePage, addPage, removePage, PAGE_TYPES } from '../model.js';
import { pageStatus } from '../changes.js';
import { LIMITS } from '../validate.js';
import { toast, modal, confirmModal, promptModal, sortable, textField, uid } from '../ui.js';
import { TVPreview } from '../preview/stage.js';

const STATUS = { live: 'Live', changed: 'Changed', new: 'New', hidden: 'Hidden' };

export function mount(host, app, params) {
  const state = { selected: params.page || (model.draft.home.children?.[0]?.id ?? 'home'), view: 'draft' };
  let preview = null;
  let validation = app.validation();

  const main = el('main');
  const aside = el('aside');
  host.append(el('div.screen', main, aside));

  const sectionOfSelected = () => {
    const e = model.find(state.selected);
    if (!e || !e.path.length) return null;
    return model.draft.home.children.find((s) => s.title === e.path[0] && (s.id === state.selected || model.find(state.selected, { home: s })));
  };

  function stripCard(page, parentId, index, count, isSection) {
    const status = pageStatus(model.published?.bundle, page);
    const v = validation.get(page.id);
    const blocked = v?.held;
    const card = el('div.strip-card' + (page.id === state.selected ? '.sel' : '') + (page.hidden ? '.hid' : '') + (status === 'new' ? '.new' : status === 'changed' ? '.chg' : '') + (blocked ? '.blocked' : ''),
      { draggable: 'true', role: 'button', tabindex: '0', dataset: { id: page.id }, 'aria-label': `${page.title}, ${STATUS[status]}${blocked ? ', held back' : ''}` });
    const url = app.media.url(page.image, 800);
    if (url) card.style.backgroundImage = `url("${url}")`;
    const eye = el('button.eye', { type: 'button', 'aria-label': page.hidden ? 'Show to guests' : 'Hide from guests', title: page.hidden ? 'Show to guests' : 'Hide from guests',
      onclick: (e) => { e.stopPropagation(); toggleHidden(page.id); } }, svgIcon(page.hidden ? 'eyeOff' : 'eye', 15));
    card.append(el('div.top', el('span.grip', { title: 'Drag to reorder' }, svgIcon('grip', 14)), eye));
    card.append(el('div.t', el('span', page.title || 'Untitled')));
    card.append(el('div.st', blocked ? 'Held back' : STATUS[status]));
    card.addEventListener('click', () => select(page.id));
    card.addEventListener('dblclick', () => app.go('editor', { page: page.id }));
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return; // the eye button handles its own keys
      if (e.key === 'Enter') app.go('editor', { page: page.id });
      if (e.key === ' ') { e.preventDefault(); select(page.id); }
      if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); move(parentId, index, index - 1); }
      if (e.key === 'ArrowRight' && index < count - 1) { e.preventDefault(); move(parentId, index, index + 1); }
    });
    void isSection;
    return card;
  }

  function stripsRow(parent, label, isSection) {
    const kids = parent.children || [];
    const max = isSection ? LIMITS.sectionsMax : LIMITS.itemsMax;
    const row = el('div.strips', { role: 'list', 'aria-label': label });
    kids.forEach((p, i) => row.append(stripCard(p, parent.id, i, kids.length, isSection)));
    row.append(el('button.strip-card.add', { type: 'button', onclick: () => addModal(parent.id) }, isSection ? '+ Add section' : '+ Add page'));
    sortable(row, '.strip-card:not(.add)', (from, to) => move(parent.id, from, to));
    return [el('div.lab', label, el('span', `${plural(kids.filter((k) => !k.hidden).length, 'showing', 'showing')} · ${max} at most`)), row];
  }

  function refocus(id) {
    const card = main.querySelector(`.strip-card[data-id="${CSS.escape(id)}"]`);
    if (card) card.focus({ preventScroll: true });
  }

  function renderMain() {
    const hadFocus = main.contains(document.activeElement) ? document.activeElement.closest('.strip-card')?.dataset.id : null;
    clear(main);
    main.append(el('div.row.between', el('div', el('h1', 'Home'), el('p.muted', 'The TV\'s home screen, in the order guests see it. Drag a strip to move it (or use the arrow keys). Click a strip to see it; double-click to edit it.'))));
    main.append(...stripsRow(model.draft.home, 'Home', true));
    const section = sectionOfSelected();
    if (section) {
      main.append(...stripsRow(section, `Inside ${section.title}`, false));
      const e = model.find(state.selected);
      if (e && e.depth >= 2) {
        const parent = e.depth === 2 ? e.page : e.parent;
        if (parent && parent.id !== section.id) {
          main.append(...stripsRow(parent, `Under ${parent.title}`, false));
        }
      }
    }
    main.append(el('p.muted.small', { style: { marginTop: '18px' } }, 'A section with one page opens straight to that page, as Contact & Help does today. Hidden pages stay in the Builder but are left out of the TV.'));
    if (hadFocus) refocus(hadFocus);
  }

  function renderAside() {
    clear(aside);
    aside.append(el('div.row.between', { style: { marginBottom: '8px' } }, el('h3', { style: { margin: 0 } }, 'What guests see'),
      segmented(['draft', 'Draft'], ['published', 'On TVs now'], state.view, (v) => { state.view = v; renderPreview(); })));
    const tvHost = el('div');
    aside.append(tvHost);
    preview = new TVPreview(tvHost, { media: app.media, logoURL: app.logoURL, onNavigate: (id) => { if (model.find(id)) { state.selected = id; renderMain(); renderSummary(); } } });
    renderPreview();
    aside.append(el('div.tvcap', el('span#pub-when.muted.small'), el('span.muted.tiny', 'Click a strip in the preview to open it')));
    aside.append(el('div.rule'));
    aside.append(el('div#summary'));
    renderSummary();
  }

  function renderPreview() {
    if (!preview) return;
    const doc = state.view === 'published' ? model.published?.bundle : model.draft;
    if (!doc) { preview.setDoc({ hotel: {}, home: { id: 'home', children: [] } }); return; }
    preview.setDoc(doc, { reveal: state.view === 'draft' ? [state.selected] : [] });
    preview.showPage(state.selected, { asStrip: true });
    const when = aside.querySelector('#pub-when');
    if (when) when.textContent = model.published ? `Published ${fmtDate(model.published.version.publishedAt)} · revision ${model.published.version.revision}` : 'Nothing published yet';
  }

  function renderSummary() {
    const box = aside.querySelector('#summary');
    if (!box) return;
    clear(box);
    const e = model.find(state.selected);
    if (!e) return;
    const page = e.page;
    const v = validation.get(page.id) || { blockers: [], warnings: [] };
    const status = pageStatus(model.published?.bundle, page);
    box.append(el('div.row.between', el('h2', { style: { margin: 0 } }, page.title || 'Untitled'), el('span.pill' + (status === 'hidden' ? '.dark' : status === 'new' ? '.green' : status === 'changed' ? '.acc' : ''), STATUS[status])));
    const kids = (page.children || []);
    box.append(el('dl.kv',
      el('dt', 'Page type'), el('dd', PAGE_TYPES[page.type]?.label || page.type),
      el('dt', 'Where'), el('dd', model.pathLabel(page.id)),
      el('dt', 'Pages under it'), el('dd', kids.length ? kids.map((c) => c.title).join(' · ') : 'None'),
      el('dt', 'Photo'), el('dd', app.media.label(page.image))));
    if (v.blockers.length) box.append(el('div.note.block', el('strong', 'Held back. '), v.blockers.map((b) => b.message).join('. ') + '.'));
    else if (v.warnings.length) box.append(el('div.note.warn', el('strong', 'Worth a look. '), v.warnings.map((b) => b.message).join('. ') + '.'));
    const ops = el('div.row.wrap', { style: { marginTop: '10px' } });
    ops.append(el('button.btn.pri', { type: 'button', onclick: () => app.go('editor', { page: page.id }) }, 'Edit page'));
    if (page.id !== 'home') {
      ops.append(el('button.btn', { type: 'button', onclick: () => toggleHidden(page.id) }, page.hidden ? 'Show to guests' : 'Hide from guests'));
      ops.append(el('button.btn', { type: 'button', onclick: () => rename(page.id) }, 'Rename'));
      if (e.depth <= 2) ops.append(el('button.btn', { type: 'button', onclick: () => addModal(page.id) }, 'Add page under it'));
      ops.append(el('button.btn.danger', { type: 'button', onclick: () => remove(page.id) }, 'Delete'));
    }
    box.append(ops);
  }

  function segmented(a, b, current, onPick) {
    const seg = el('div.seg', { role: 'group' });
    for (const [v, label] of [a, b]) seg.append(el('button', { type: 'button', class: v === current ? 'on' : '', 'aria-pressed': v === current ? 'true' : 'false', onclick: () => { seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.textContent === label)); onPick(v); } }, label));
    return seg;
  }

  // ---- actions ----
  function select(id) { state.selected = id; renderMain(); renderPreview(); renderSummary(); refocus(id); }

  function move(parentId, from, to) {
    const id = model.find(parentId)?.page.children?.[from]?.id;
    model.commit('Reorder strips', (d) => movePage(d, parentId, from, to), { origin: 'home' });
    if (id) refocus(id);
  }

  function toggleHidden(id) {
    const page = model.find(id)?.page;
    if (!page) return;
    model.commit(page.hidden ? `Show ${page.title}` : `Hide ${page.title}`, (d) => {
      const p = model.find(id, d).page;
      if (p.hidden) delete p.hidden; else p.hidden = true;
    }, { origin: 'home' });
    const eye = main.querySelector(`.strip-card[data-id="${CSS.escape(id)}"] .eye`);
    if (eye) eye.focus({ preventScroll: true }); else refocus(id);
  }

  async function rename(id) {
    const page = model.find(id)?.page;
    const title = await promptModal('Rename', 'Title', { value: page.title, limit: LIMITS.title, okLabel: 'Rename' });
    if (title === null || title === page.title) return;
    model.commit(`Rename ${page.title}`, (d) => { model.find(id, d).page.title = title; }, { origin: 'home' });
  }

  async function remove(id) {
    const e = model.find(id);
    if (!e) return;
    const count = model.pages({ home: e.page }).length - 1;
    const ok = await confirmModal(`Delete ${e.page.title}?`, count ? `This page and the ${plural(count, 'page')} under it will be removed from the TV when you next publish. You can undo this straight away.` : 'It will be removed from the TV when you next publish. You can undo this straight away.', { okLabel: 'Delete', danger: true });
    if (!ok) return;
    let restore = null;
    model.commit(`Delete ${e.page.title}`, (d) => { restore = removePage(d, id); }, { origin: 'home' });
    state.selected = restore?.parentId === 'home' ? (model.draft.home.children[0]?.id || 'home') : restore.parentId;
    select(state.selected);
    toast(`Deleted ${e.page.title}.`, { action: 'Undo', onAction: () => {
      model.commit(`Restore ${restore.page.title}`, (d) => addPage(d, restore.parentId, restore.page, restore.index), { origin: 'home', undoable: false });
      select(restore.page.id);
    } });
  }

  function addModal(parentId) {
    const parent = model.find(parentId)?.page;
    if (!parent) return;
    const isHome = parentId === 'home';
    let type = isHome ? 'hub' : 'info';
    let title = '';
    const tpl = el('div.tpl');
    const types = isHome ? ['hub', 'info', 'menu', 'gallery', 'list', 'contact', 'finished'] : ['info', 'menu', 'gallery', 'list', 'finished'];
    const buttons = types.map((t) => el('button', { type: 'button', class: t === type ? 'on' : '', onclick: () => { type = t; buttons.forEach((b) => b.classList.toggle('on', b.dataset.t === t)); }, dataset: { t } }, el('b', PAGE_TYPES[t].label), el('span', PAGE_TYPES[t].hint)));
    tpl.append(...buttons);
    const siblings = (parent.children || []).map((c) => (c.title || '').trim().toLowerCase());
    const dupe = el('div.help', { style: { color: 'var(--amber)' } });
    const field = textField({ label: 'Title', value: '', limit: LIMITS.title, id: uid('t'), placeholder: isHome ? 'e.g. Weddings' : 'e.g. Sunday Roast', onInput: (v) => {
      title = v;
      dupe.textContent = siblings.includes(v.trim().toLowerCase()) ? `There is already ${isHome ? 'a section' : 'a page here'} called "${v.trim()}". Guests could not tell them apart; give it its own name.` : '';
    } });
    const showing = (parent.children || []).filter((c) => !c.hidden).length;
    const max = isHome ? LIMITS.sectionsMax : LIMITS.itemsMax;
    if (showing >= max) { toast(`The TV fits ${max} ${isHome ? 'sections' : 'pages in a section'} at most. Hide or delete one first.`, { error: true }); return; }
    const m = modal({
      title: isHome ? 'Add a section to Home' : `Add a page inside ${parent.title}`,
      body: el('div', el('p.muted.small', 'Choose what kind of page. Every kind comes with example text to replace.'), tpl, field, dupe),
      actions: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: () => {
        const t = title.trim();
        if (!t) { field.input.focus(); return false; }
        const page = newPage(type, t, model.newId(t));
        model.commit(`Add ${t}`, (d) => addPage(d, parentId, page), { origin: 'home' });
        select(page.id);
        setTimeout(() => refocus(page.id), 0);
        toast(type === 'finished' ? `Added ${t}. Upload its artwork, give it a description and a strip photo, then publish.` : `Added ${t}. It needs a photo before it can be published.`, { action: 'Edit page', onAction: () => app.go('editor', { page: page.id }) });
        return true;
      } }],
    });
    field.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.box.querySelector('.btn.pri').click(); } });
  }

  renderMain();
  renderAside();

  return {
    update() {
      validation = app.validation();
      if (!model.find(state.selected)) state.selected = model.draft.home.children[0]?.id || 'home';
      renderMain();
      renderPreview();
      renderSummary();
    },
    unmount() { preview?.destroy(); },
  };
}
