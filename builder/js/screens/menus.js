// Menus: every menu page as a table of parts and dishes. Click a price, type, done.

import { el, clear, svgIcon, plural } from '../util.js';
import { model, moveInList } from '../model.js';
import { LIMITS } from '../validate.js';
import { toast, textField, uid, sortable, moveButtons, iconButton, confirmModal, promptModal } from '../ui.js';
import { TVPreview } from '../preview/stage.js';

export const TAGS = [['v', 'Vegetarian'], ['vg', 'Vegan'], ['vo', 'Vegetarian option'], ['gf', 'Gluten free'], ['n', 'Contains nuts']];

export function mount(host, app, params) {
  const menus = () => model.menuPages();
  const state = { menu: params.menu && menus().some((m) => m.page.id === params.menu) ? params.menu : menus()[0]?.page.id || null };
  let preview = null;

  const rail = el('div.rail');
  const main = el('main');
  const aside = el('aside');
  host.append(el('div.screen', rail, main, aside));

  const current = () => model.find(state.menu)?.page || null;
  const commit = (label, fn, key) => model.commit(label, (d) => fn(model.find(state.menu, d).page), { origin: 'menus', coalesce: key, pageId: state.menu });

  function renderRail() {
    clear(rail);
    rail.append(el('h3', 'Menus'));
    for (const { page, path } of menus()) {
      const n = (page.sections || []).reduce((a, s) => a + (s.items || []).length, 0);
      rail.append(el('button.ml' + (page.id === state.menu ? '.on' : ''), { type: 'button', onclick: () => { state.menu = page.id; app.params.menu = page.id; history.replaceState(null, '', '#menus/' + page.id); renderAll(); } },
        el('b', page.title), el('span', `${path.slice(0, -1).join(' › ') || 'Home'} · ${plural((page.sections || []).length, 'part')} · ${plural(n, 'dish', 'dishes')}`)));
    }
    rail.append(el('p.muted.tiny', { style: { marginTop: '12px' } }, 'A menu is a page of type "Menu page". Add one from Home, inside the section it belongs to.'));
  }

  function renderMain() {
    clear(main);
    const p = current();
    if (!p) { main.append(el('div.empty', 'No menus yet. Add a Menu page from Home.')); return; }
    main.append(el('div.row.between', el('div', el('h1', p.title), el('p.muted', 'Change it here and the TV page follows. It saves itself.')),
      el('div.row', el('button.btn.sm', { type: 'button', onclick: () => addSection() }, '+ Add part'), el('button.btn.sm', { type: 'button', onclick: () => app.go('editor', { page: p.id }) }, 'Heading, photo and QR link'))));
    const intro = textField({ label: 'Line under the title', value: p.body || '', limit: LIMITS.body, id: uid('mb'), onInput: (v) => commit('Edit text', (pg) => { if (v) pg.body = v; else delete pg.body; }, 'body') });
    intro.style.marginTop = '10px';
    main.append(intro);

    const sections = p.sections || [];
    const secList = el('div');
    sections.forEach((s, si) => {
      const head = el('div.sec-h', { draggable: 'true', dataset: { si } });
      head.append(el('span.grip', { title: 'Drag to reorder' }, svgIcon('grip', 14)));
      const t = el('input.in', { value: s.title || '', placeholder: 'Part name, e.g. Small plates', 'aria-label': 'Part name', style: { maxWidth: '260px' } });
      t.addEventListener('input', () => commit('Edit part name', (pg) => { pg.sections[si].title = t.value; }, `sec.${si}.title`));
      const note = el('input.in', { value: s.note || '', placeholder: 'Note, e.g. cooked over English oak', 'aria-label': 'Part note', style: { maxWidth: '300px' } });
      note.addEventListener('input', () => commit('Edit part note', (pg) => { if (note.value) pg.sections[si].note = note.value; else delete pg.sections[si].note; }, `sec.${si}.note`));
      head.append(t, note, el('span.muted.small', plural((s.items || []).length, 'dish', 'dishes')), el('span.spacer'));
      head.append(moveButtons(si, sections.length, (a, b) => commit('Reorder parts', (pg) => moveInList(pg.sections, a, b))));
      head.append(iconButton('close', 'Remove part', () => removeSection(si)));
      secList.append(head);

      const table = el('table.dishes', { 'aria-label': `${s.title} dishes` });
      (s.items || []).forEach((d, di) => table.append(dishRow(s, si, d, di)));
      sortable(table, 'tr', (a, b) => commit('Reorder dishes', (pg) => moveInList(pg.sections[si].items, a, b)));
      secList.append(table);
      secList.append(el('div', { style: { margin: '6px 0 0 26px' } }, el('button.btn.sm', { type: 'button', onclick: () => { commit('Add dish', (pg) => { pg.sections[si].items.push({ name: '', price: '' }); }); renderMain(); focusLastName(si); } }, '+ Add dish')));
    });
    sortable(secList, '.sec-h', (a, b) => commit('Reorder parts', (pg) => moveInList(pg.sections, a, b)));
    main.append(secList);
    if (!sections.length) main.append(el('div.empty', 'No parts yet. Add one, then add dishes to it.'));
  }

  function focusLastName(si) {
    const rows = main.querySelectorAll('table.dishes')[si]?.querySelectorAll('tr');
    const last = rows && rows[rows.length - 1];
    last?.querySelector('input')?.focus();
  }

  function dishRow(s, si, d, di) {
    const tr = el('tr' + (d.hidden ? '.off' : ''), { draggable: 'true' });
    tr.append(el('td.grip-cell', el('span.grip', { title: 'Drag to reorder' }, svgIcon('grip', 14))));
    const name = el('input.in.dish-name', { value: d.name || '', placeholder: 'Dish', 'aria-label': 'Dish name', maxlength: LIMITS.dishName + 40 });
    name.addEventListener('input', () => commit('Edit dish', (pg) => { pg.sections[si].items[di].name = name.value; }, `dish.${si}.${di}.name`));
    const desc = el('input.in', { value: d.description || '', placeholder: 'Description', 'aria-label': 'Description', style: { marginTop: '4px', fontSize: '12.5px' }, maxlength: LIMITS.dishDescription + 40 });
    desc.addEventListener('input', () => commit('Edit dish', (pg) => { if (desc.value) pg.sections[si].items[di].description = desc.value; else delete pg.sections[si].items[di].description; }, `dish.${si}.${di}.desc`));
    const counter = el('div.tiny.muted', { style: { textAlign: 'right' } });
    const upd = () => { counter.textContent = `${name.value.length}/${LIMITS.dishName} · ${desc.value.length}/${LIMITS.dishDescription}`; counter.style.color = name.value.length > LIMITS.dishName || desc.value.length > LIMITS.dishDescription ? 'var(--red)' : ''; };
    name.addEventListener('input', upd); desc.addEventListener('input', upd); upd();
    tr.append(el('td', name, desc, counter));
    const tags = el('div.tag-row', { role: 'group', 'aria-label': 'Tags' });
    for (const [tag, label] of TAGS) {
      const on = (d.tags || []).includes(tag);
      tags.append(el('button.tag-btn' + (on ? '.on' : ''), { type: 'button', title: label, 'aria-pressed': String(on), onclick: (e) => {
        commit('Edit tags', (pg) => { const it = pg.sections[si].items[di]; const set = new Set(it.tags || []); if (set.has(tag)) set.delete(tag); else set.add(tag); if (set.size) it.tags = TAGS.map(([t]) => t).filter((t) => set.has(t)); else delete it.tags; });
        e.target.classList.toggle('on'); e.target.setAttribute('aria-pressed', e.target.classList.contains('on'));
      } }, tag.toUpperCase()));
    }
    tr.append(el('td.tags-cell', tags));
    const price = el('input.in', { value: d.price || '', placeholder: '£0', 'aria-label': 'Price', maxlength: LIMITS.dishPrice, style: { textAlign: 'right' } });
    price.addEventListener('input', () => commit('Edit price', (pg) => { if (price.value) pg.sections[si].items[di].price = price.value; else delete pg.sections[si].items[di].price; }, `dish.${si}.${di}.price`));
    tr.append(el('td.price-cell', price));
    const ops = el('td.ops-cell');
    ops.append(el('button.eye', { type: 'button', title: d.hidden ? 'Put back on the menu' : 'Take off the menu for now', 'aria-label': d.hidden ? 'Put back on the menu' : 'Take off the menu', onclick: () => { commit(d.hidden ? 'Put dish back' : 'Take dish off', (pg) => { const it = pg.sections[si].items[di]; if (it.hidden) delete it.hidden; else it.hidden = true; }); renderMain(); } }, svgIcon(d.hidden ? 'eyeOff' : 'eye', 15)));
    ops.append(iconButton('close', 'Remove dish', () => removeDish(si, di)));
    tr.append(ops);
    return tr;
  }

  async function addSection() {
    const title = await promptModal('Add a part', 'Part name', { placeholder: 'e.g. From the fire', limit: LIMITS.sectionTitle, okLabel: 'Add' });
    if (!title) return;
    commit(`Add part ${title}`, (pg) => { pg.sections = pg.sections || []; pg.sections.push({ title, items: [] }); });
    renderMain();
  }

  async function removeSection(si) {
    const s = current().sections[si];
    if ((s.items || []).length) {
      const ok = await confirmModal(`Remove ${s.title || 'this part'}?`, `Its ${plural(s.items.length, 'dish', 'dishes')} go with it. You can undo this straight away.`, { okLabel: 'Remove', danger: true });
      if (!ok) return;
    }
    let removed = null;
    commit(`Remove part ${s.title}`, (pg) => { removed = pg.sections.splice(si, 1)[0]; });
    renderMain();
    toast(`Removed ${s.title || 'the part'}.`, { action: 'Undo', onAction: () => { commit(`Restore part ${s.title}`, (pg) => pg.sections.splice(si, 0, removed)); renderMain(); } });
  }

  function removeDish(si, di) {
    const d = current().sections[si].items[di];
    let removed = null;
    commit(`Remove ${d.name || 'dish'}`, (pg) => { removed = pg.sections[si].items.splice(di, 1)[0]; });
    renderMain();
    toast(`Removed ${d.name || 'the dish'}.`, { action: 'Undo', onAction: () => { commit(`Restore ${d.name}`, (pg) => pg.sections[si].items.splice(di, 0, removed)); renderMain(); } });
  }

  function renderAside() {
    clear(aside);
    aside.append(el('div.row.between', { style: { marginBottom: '8px' } }, el('h3', { style: { margin: 0 } }, 'On the TV'), el('span.muted.tiny', 'Draft')));
    const tvHost = el('div');
    aside.append(tvHost);
    preview?.destroy();
    preview = new TVPreview(tvHost, { media: app.media, logoURL: app.logoURL, onSelectField: () => {} });
    refreshPreview(true);
    aside.append(el('div#menu-diff.small.muted', { style: { marginTop: '8px' } }));
    renderDiff();
    aside.append(el('div.rule'));
    aside.append(el('h3', 'Tags guests see'));
    aside.append(el('p.small', TAGS.map(([t, l]) => `${t.toUpperCase()} ${l}`).join(' · ')));
    aside.append(el('p.help', 'Prices are typed as the TV shows them, e.g. £12 or "included".'));
  }

  function refreshPreview(navigate) {
    if (!preview || !state.menu) return;
    preview.setDoc(model.draft, { reveal: [state.menu] });
    if (navigate) preview.showPage(state.menu);
  }

  function renderDiff() {
    const box = aside.querySelector('#menu-diff');
    if (!box) return;
    clear(box);
    const entry = app.changes().entries.find((e) => e.id === state.menu);
    if (!entry) { box.textContent = 'Same as on TVs now.'; return; }
    box.append(el('b', 'Since the last publish: '));
    box.append(entry.lines.slice(0, 6).join(' · ') + (entry.lines.length > 6 ? ` · and ${entry.lines.length - 6} more` : ''));
  }

  function renderAll() { renderRail(); renderMain(); renderAside(); }
  renderAll();

  return {
    update(ev) {
      if (!current()) { state.menu = menus()[0]?.page.id || null; renderAll(); return; }
      renderRail();
      refreshPreview(false);
      renderDiff();
      if (ev.origin !== 'menus' || !/^Edit/.test(ev.label)) renderMain();
    },
    unmount() { preview?.destroy(); },
  };
}
