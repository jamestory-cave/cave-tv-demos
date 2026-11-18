// Overrides: everything that differs by room type or by room number, in one
// place (docs/builder/2026-11-room-specific-content.md, section 3). Hotel
// server only. Also the small pieces the editor uses: the tag control next to
// a field, and "Preview as".
//
// One line per room type (or per room, from the Rooms database). A blank line
// uses the master. QR codes: an https link with a live preview of the code;
// photos: a picker from Media; words: a box with the master's limit. "Paste a
// list" takes two columns (room, value) for many rooms at once and says
// plainly what it matched and what it did not.

import { el, clear, plural } from '../util.js';
import { model } from '../model.js';
import { toast, modal, confirmModal } from '../ui.js';
import { qrSVG } from '../preview/qr.js';
import { pickPhoto } from './media.js';
import {
  SCOPES, SCOPE_SHORT, fieldDef, fieldLabel, getField, getPage, setTag, setValue, setVersionPatch, tagOf, filledCount,
  dropSummary, listTagged, masterValue, valueProblem, validHTTPS, isBlank, keyLabel, versionPatch,
} from '../overrides.js';

// ---- shared pieces ------------------------------------------------------------------

let lastTagToast = null;

/** Undo the last change, from a button (an iPad has no keyboard for Cmd-Z; QA-6). */
function undoNow() {
  const l = model.undo();
  if (l) toast(`Undid: ${l}`, { ms: 2500 });
}

const scopeUnit = (by, n) => (by === 'type' ? (n === 1 ? 'room type' : 'room types') : (n === 1 ? 'room' : 'rooms'));

/** How many rooms or types there are to fill in for a scope. */
function totalFor(app, by) {
  return by === 'type' ? app.rooms.types.filter((t) => !t.retired).length : app.rooms.rooms.length;
}

/** How many of today's room types (not retired) or rooms have a value; values for ones no longer in the list do not count (QA-5). */
export function setCount(app, rec) {
  if (!rec) return 0;
  const map = rec.versions || rec.values || {};
  const keys = Object.keys(map).filter((k) => (rec.versions ? Object.keys(map[k] || {}).length : true));
  if (rec.by === 'type') return keys.filter((k) => app.rooms.types.some((t) => !t.retired && String(t.id) === k)).length;
  return keys.filter((k) => app.rooms.rooms.some((r) => String(r.number).toLowerCase() === k.toLowerCase())).length;
}

/**
 * "3 of 7 room types set", counting only what will go live (QA-13): with the item's page and field,
 * values that are held back are left out of the count and said ("· 2 held back").
 */
export function filledText(app, rec, pageId = null, field = null) {
  const total = totalFor(app, rec.by);
  if (pageId === null || !app.liveOverrides) return `${setCount(app, rec)} of ${total} ${scopeUnit(rec.by, total)} set`;
  const { overrides, blocked } = app.liveOverrides();
  const liveDoc = { overrides };
  const live = (field === 'page' ? getPage(liveDoc, pageId) : getField(liveDoc, pageId, field)) || { by: rec.by, values: {} };
  const held = blocked.filter((b) => b.pageId === pageId && b.field === field).length;
  return `${live.by === rec.by ? setCount(app, live) : 0} of ${total} ${scopeUnit(rec.by, total)} set${held ? ` · ${held} held back` : ''}`;
}

/**
 * The tag next to a field in the editor: Same on every TV / Different by room
 * type / Different by room number. Changing it away from a scope that holds
 * values asks first and says how much would be dropped.
 */
export function tagControl(app, pageId, field, { label, link = true } = {}) {
  const by = tagOf(model.draft, pageId, field);
  const page = model.find(pageId)?.page;
  const name = label || fieldLabel(page, field);
  const sel = el('select.in.tag-select', { 'aria-label': `${name}: same on every TV, or different by room`, dataset: { tagFor: field } },
    el('option', { value: '', selected: !by }, 'Same on every TV'),
    el('option', { value: 'type', selected: by === 'type' }, SCOPES.type),
    el('option', { value: 'room', selected: by === 'room' }, SCOPES.room));
  sel.addEventListener('change', async () => {
    const to = sel.value || null;
    if (to === by) return;
    const drop = dropSummary(model.draft, pageId, field);
    if (drop) {
      const ok = await confirmModal(to ? `Change ${name} to ${SCOPES[to].toLowerCase()}?` : `Make ${name} the same on every TV?`,
        `${drop}. ${to ? 'Changing how it varies starts again with nothing filled in, so those' : 'Those'} will be dropped. Undo brings them back.`, { okLabel: to ? 'Change it' : 'Make it the same', danger: true });
      if (!ok) { sel.value = by || ''; return; }
    }
    model.commit(to ? `${SCOPES[to]}: ${name}` : `Same on every TV: ${name}`, (d) => setTag(d, pageId, field, to), { pageId });
    if (to && link) {
      // One notice at a time: tagging several fields in a row replaces it rather than stacking them (QA-8).
      if (lastTagToast) lastTagToast();
      lastTagToast = toast(field === 'page'
        ? `This page now has a version ${SCOPE_SHORT[to]}. Each starts as the master; open one to change it.`
        : `${name} now varies ${SCOPE_SHORT[to]}. What you see in the editor is the master, used wherever nothing else is filled in.`,
      { action: field === 'page' ? 'See the versions' : 'Fill it in', onAction: () => app.go('overrides', { page: pageId, field }), ms: 8000 });
    }
  });
  const box = el('div.tagctl' + (by ? '.on' : ''), sel);
  if (by) {
    const rec = field === 'page' ? getPage(model.draft, pageId) : getField(model.draft, pageId, field);
    box.append(el('span.pill.acc', `Varies ${SCOPE_SHORT[by]}`), el('span.small.muted', { dataset: { filled: `${pageId}|${field}` } }, filledText(app, rec, pageId, field)),
      ...(link ? [el('button.btn.link.sm', { type: 'button', onclick: () => app.go('overrides', { page: pageId, field }) }, field === 'page' ? 'Versions' : 'Fill in')] : []));
  }
  return box;
}

/** Who a "Preview as" value stands for: {typeId, room} or null for the master. */
export function whoFor(app, value) {
  if (!value) return null;
  const [kind, ...rest] = value.split(':');
  const key = rest.join(':');
  if (kind === 'type') return { typeId: key };
  if (kind === 'room') {
    const r = app.rooms.rooms.find((x) => String(x.number).toLowerCase() === key.toLowerCase());
    return { typeId: r?.type_id ?? null, room: key };
  }
  return null;
}

/** The "Preview as" drop-down above the TV preview. onChange(value) with '' for the master. */
export function previewAsControl(app, value, onChange) {
  const sel = el('select.in.preview-as', { 'aria-label': 'Preview as', onchange: () => onChange(sel.value) },
    el('option', { value: '' }, 'Master (every TV without its own)'));
  const types = app.rooms.types.filter((t) => !t.retired || app.rooms.rooms.some((r) => r.type_id === t.id));
  if (types.length) {
    const g = el('optgroup', { label: 'Room types' });
    for (const t of types) g.append(el('option', { value: `type:${t.id}` }, t.name));
    sel.append(g);
  }
  if (app.rooms.rooms.length) {
    const g = el('optgroup', { label: 'Rooms' });
    const typeName = app.names().typeName;
    for (const r of app.rooms.rooms) g.append(el('option', { value: `room:${r.number}` }, `Room ${r.number}${r.name ? ` (${r.name})` : ''}${r.type_id ? ` · ${typeName(r.type_id)}` : ''}`));
    sel.append(g);
  }
  sel.value = value || '';
  if (sel.value !== (value || '')) sel.value = '';
  return el('label.preview-as-wrap', el('span.small.muted', 'Preview as'), sel);
}

// ---- the screen ----------------------------------------------------------------------

export function mount(host, app, params) {
  const state = { page: params.page || null, field: params.field || null, filter: '' };
  const nav = el('nav.ovr-list', { 'aria-label': 'Things that differ by room' });
  const main = el('main');
  host.append(el('div.screen.ovr', nav, main));

  const items = () => listTagged(model.draft);
  const selected = () => items().find((t) => t.pageId === state.page && t.field === state.field) || null;

  function select(pageId, field) {
    state.page = pageId; state.field = field; state.filter = '';
    const hash = `#overrides/${encodeURIComponent(pageId)}/${encodeURIComponent(field)}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    renderNav(); renderMain();
    main.scrollTop = 0;
  }

  function renderNav() {
    clear(nav);
    nav.append(el('h3', 'Different by room'));
    const list = items();
    if (!list.length) { nav.append(el('p.small.muted', 'Nothing yet.')); return; }
    let lastPage = null;
    for (const t of list) {
      if (t.pageId !== lastPage) {
        lastPage = t.pageId;
        nav.append(el('div.ovr-page', t.page ? model.pathLabel(t.pageId) : 'No longer in the content'));
      }
      const on = t.pageId === state.page && t.field === state.field;
      nav.append(el('button.part' + (on ? '.sel' : ''), { type: 'button', 'aria-current': on ? 'true' : undefined, onclick: () => select(t.pageId, t.field) },
        el('div.w', el('div.n', fieldLabel(t.page, t.field)), el('div.s', `${SCOPE_SHORT[t.rec.by]} · ${filledText(app, t.rec, t.pageId, t.field)}`))));
    }
  }

  function renderMain() {
    clear(main);
    const list = items();
    if (!state.page && list.length) { state.page = list[0].pageId; state.field = list[0].field; }
    main.append(el('div.row.between', { style: { alignItems: 'flex-start', gap: '12px' } }, el('h1', { style: { margin: 0 } }, 'Overrides'),
      el('button.btn.sm.ovr-undo', { type: 'button', disabled: !model.canUndo, title: model.canUndo ? `Undo ${model.undoLabel}` : 'Nothing to undo', onclick: undoNow }, '← Undo')));
    main.append(el('div', el('p.muted', 'Words, photos and QR codes that differ by room type or by room number. Each TV gets its room\'s own value, else its room type\'s, else the master. A blank line uses the master.')));
    const t = selected();
    if (!t) {
      main.append(el('div.empty', { style: { marginTop: '16px' } },
        list.length ? 'Choose something on the left.' : 'Nothing differs by room yet. In the editor, choose "Different by room type" or "Different by room number" under a title, the text, the photo or a QR code; or under This page for a whole page.'));
      return;
    }
    if (!t.page) {
      main.append(el('div.note.warn', el('strong', 'This page is no longer in the content. '), 'Its room-specific content is kept in case the page comes back (Undo). ',
        el('button.btn.sm', { type: 'button', onclick: () => { model.commit('Remove room-specific content of a page no longer there', (d) => setTag(d, t.pageId, t.field, null)); state.page = null; } }, 'Remove it')));
      return;
    }
    if (t.field === 'page') renderVersions(t); else renderField(t);
  }

  // -- one element: a line per room type or room --
  function renderField(t) {
    const def = fieldDef(t.field);
    const rec = getField(model.draft, t.pageId, t.field);
    const master = masterValue(t.page, t.field);
    const names = app.names();
    main.append(el('div.row.between.wrap', { style: { margin: '14px 0 8px', gap: '10px' } },
      el('h2', { style: { margin: 0 } }, `${fieldLabel(t.page, t.field)} on ${t.page.title || 'untitled'}`),
      el('div.row', tagControl(app, t.pageId, t.field, { link: false }), el('button.btn.sm', { type: 'button', onclick: () => app.go('editor', { page: t.pageId }) }, 'Open the page'))));
    main.append(el('div.note.small', el('strong', 'Master, used where a line is blank: '), masterText(def, master), ' ',
      el('button.btn.link.sm', { type: 'button', onclick: () => app.go('editor', { page: t.pageId }) }, 'Edit the master')));
    const tools = el('div.row.wrap', { style: { margin: '10px 0', gap: '8px' } });
    if (def.kind !== 'photo') tools.append(el('button.btn.sm', { type: 'button', onclick: () => pasteModal(t, def) }, 'Paste a list…'));
    if (rec.by === 'room') {
      const search = el('input.in', { type: 'search', placeholder: 'Find a room or type', 'aria-label': 'Find a room', value: state.filter, style: { width: '220px' },
        oninput: () => { state.filter = search.value; renderRows(); } });
      tools.append(search);
    }
    tools.append(el('span.small.muted', { id: 'ovr-count' }, filledText(app, rec, t.pageId, t.field)));
    main.append(tools);
    const table = el('table.ovr-table');
    main.append(table);

    function rows() {
      const values = rec.values || {};
      const out = [];
      if (rec.by === 'type') {
        for (const ty of app.rooms.types) if (!ty.retired || String(ty.id) in values) out.push({ key: String(ty.id), label: ty.name, sub: `${plural(ty.rooms || 0, 'room')}${ty.retired ? ' · retired' : ''}` });
      } else {
        for (const r of app.rooms.rooms) out.push({ key: r.number, label: `Room ${r.number}`, sub: [r.name, r.type_id ? names.typeName(r.type_id) : 'No room type'].filter(Boolean).join(' · ') });
      }
      const known = new Set(out.map((x) => x.key.toLowerCase()));
      for (const k of Object.keys(values)) if (!known.has(k.toLowerCase())) out.push({ key: k, label: keyLabel(rec.by, k, names).replace(/^room /, 'Room '), sub: 'No longer in the Rooms list', orphan: true });
      return out;
    }

    function renderRows() {
      clear(table);
      table.append(el('thead', el('tr', el('th', rec.by === 'type' ? 'Room type' : 'Room'), el('th', def.kind === 'qr' ? 'Web address and line' : def.label), el('th', ''))));
      const body = el('tbody');
      const f = state.filter.trim().toLowerCase();
      const all = rows();
      if (!all.length) body.append(el('tr', el('td', { colspan: 3 }, el('p.small.muted', rec.by === 'type' ? 'There are no room types yet. An admin adds them on the Rooms screen.' : 'There are no rooms yet. An admin adds them on the Rooms screen.'))));
      for (const row of all) {
        if (f && !`${row.label} ${row.sub}`.toLowerCase().includes(f)) continue;
        body.append(valueRow(t, def, rec, row, master));
      }
      table.append(body);
    }
    renderRows();
  }

  function masterText(def, master) {
    if (def.kind === 'qr') return master?.url ? `${master.url}${master.label ? ` ("${master.label}")` : ''}` : 'no QR code';
    if (def.kind === 'photo') return master ? app.media.label(master) : 'no photo';
    return master ? `"${master.length > 120 ? master.slice(0, 117) + '…' : master}"` : 'nothing';
  }

  function valueRow(t, def, rec, row, master) {
    const value = (rec.values || {})[row.key];
    const tr = el('tr' + (isBlank(t.field, value) ? '' : '.set') + (row.orphan ? '.orphan' : ''), { dataset: { key: row.key } });
    tr.append(el('td.who', el('b', row.label), el('div.small.muted', row.sub)));
    const cell = el('td.val');
    const status = el('div.small.ovr-status');
    const commitValue = (v, label = `Edit ${fieldLabel(t.page, t.field)} for ${row.label}`) => {
      model.commit(label, (d) => setValue(d, t.pageId, t.field, row.key, v), { origin: 'overrides', coalesce: `ovr|${t.pageId}|${t.field}|${row.key}`, pageId: t.pageId });
      const now = (getField(model.draft, t.pageId, t.field)?.values || {})[row.key];
      tr.classList.toggle('set', !isBlank(t.field, now));
      const c = document.getElementById('ovr-count');
      if (c) c.textContent = filledText(app, getField(model.draft, t.pageId, t.field), t.pageId, t.field);
      main.querySelectorAll('[data-filled]').forEach((n) => { if (n.dataset.filled === `${t.pageId}|${t.field}`) n.textContent = filledText(app, getField(model.draft, t.pageId, t.field), t.pageId, t.field); });
      renderNav();
    };
    const showProblem = (v) => {
      const why = valueProblem(t.field, v, app.validationCtx());
      status.textContent = why ? `Will not go live: ${why}.` : '';
      status.classList.toggle('red', !!why);
    };
    if (def.kind === 'text') {
      const input = def.multiline
        ? el('textarea.in', { rows: 3, placeholder: master || '(blank: uses the master)', 'aria-label': `${def.label} for ${row.label}` })
        : el('input.in', { type: 'text', placeholder: master || '(blank: uses the master)', 'aria-label': `${def.label} for ${row.label}` });
      input.value = value || '';
      const count = el('span.count');
      const upd = () => { const n = input.value.length; count.textContent = `${n} / ${def.limit}`; count.className = 'count' + (n > def.limit ? ' red' : n >= Math.ceil(def.limit * 0.9) ? ' amber' : ''); input.classList.toggle('over', n > def.limit); };
      input.addEventListener('input', () => { upd(); commitValue(input.value); showProblem(input.value); });
      upd(); showProblem(value);
      cell.append(input, el('div.row.between', status, count));
    } else if (def.kind === 'photo') {
      // A blank line shows the master's photo, faded: that is what those TVs get.
      const th = el('div.thumb' + (value ? '' : '.faded'));
      const url = app.media.url(value || master, 800);
      if (url) th.style.backgroundImage = `url("${url}")`;
      cell.append(el('div.photo-pick', th, el('div',
        el('div.small', value ? app.media.label(value) : 'Blank: uses the master'),
        el('button.btn.sm', { type: 'button', style: { marginTop: '4px' }, onclick: () => pickPhoto(app, { use: 'strip', onPick: (src) => { commitValue(src, `Choose photo for ${row.label}`); renderMain(); } }) }, value ? 'Swap photo' : 'Choose photo'))), status);
      showProblem(value);
    } else {
      const url = el('input.in', { type: 'url', spellcheck: 'false', placeholder: 'https://… (blank: uses the master)', 'aria-label': `Web address for ${row.label}` });
      url.value = value?.url || '';
      const lab = el('input.in', { type: 'text', placeholder: master?.label || 'Line under the code (optional)', 'aria-label': `QR line for ${row.label}` });
      lab.value = value?.label || '';
      const code = el('div.ovr-qr', { 'aria-hidden': 'true' });
      const draw = () => { clear(code); if (validHTTPS(url.value.trim())) code.append(qrSVG(url.value.trim(), 64)); else code.append(el('span.small.muted', url.value.trim() ? '?' : '')); };
      const send = () => {
        const v = url.value.trim() ? { url: url.value, label: lab.value || undefined } : null;
        commitValue(v);
        draw();
        showProblem(v);
      };
      url.addEventListener('input', send);
      lab.addEventListener('input', () => { if (url.value.trim()) send(); });
      draw(); showProblem(value);
      cell.append(el('div.ovr-qrrow', code, el('div.grow', url, lab, status)));
    }
    tr.append(cell);
    tr.append(el('td.ops', el('button.btn.sm', { type: 'button', disabled: isBlank(t.field, value), title: 'Back to the master for this line', onclick: () => {
      commitValue(null, `Clear ${fieldLabel(t.page, t.field)} for ${row.label}`);
      tr.replaceWith(valueRow(t, def, getField(model.draft, t.pageId, t.field), row, master));
      toast(`${row.label} uses the master again.`, { action: 'Undo', onAction: undoNow, ms: 6000 });
    } }, 'Clear')));
    return tr;
  }

  // -- paste a two-column list --
  function pasteModal(t, def) {
    const rec = getField(model.draft, t.pageId, t.field);
    const area = el('textarea.in', { rows: 10, placeholder: rec.by === 'type' ? 'Cave Room\thttps://…\nPenthouse Suite\thttps://…' : '101\thttps://order.example/101\n102\thttps://order.example/102', 'aria-label': 'The list to paste', spellcheck: 'false' });
    const report = el('div.small', { style: { marginTop: '10px' } });
    let plan = null;
    const check = () => { plan = parseList(app, t, def, rec, area.value); clear(report).append(...reportNodes(plan)); };
    area.addEventListener('input', () => { plan = null; clear(report); });
    const body = el('div',
      el('p.small', `Two columns: ${rec.by === 'type' ? 'the room type\'s name' : 'the room number ("308" or "Room 308")'}, then the ${def.kind === 'qr' ? 'web address' : def.label.toLowerCase()}. Copy them straight from a spreadsheet, or type them with a comma or spaces between. Any further columns are ignored. Nothing changes until "Bring them in".`),
      area, report);
    modal({ title: `Paste a list: ${fieldLabel(t.page, t.field)} on ${t.page.title}`, body, wide: true, actions: [
      { label: 'Cancel' },
      { label: 'Check the list', keepOpen: true, onClick: () => check() },
      { label: 'Bring them in', primary: true, onClick: () => {
        if (!plan) check();
        if (!plan.matched.length) { toast('Nothing in the list matched, so nothing changed.', { error: true }); return false; }
        model.commit(`Paste a list into ${fieldLabel(t.page, t.field)} (${plural(plan.matched.length, rec.by === 'type' ? 'room type' : 'room')})`, (d) => {
          for (const m of plan.matched) setValue(d, t.pageId, t.field, m.key, m.value);
        }, { pageId: t.pageId });
        toast(`${plural(plan.matched.length, rec.by === 'type' ? 'room type' : 'room')} filled in${plan.unmatched.length ? `; ${plural(plan.unmatched.length, 'line')} not matched (listed in the check)` : ''}.`, { ms: 10000, action: 'Undo', onAction: undoNow });
        renderMain(); renderNav();
        return true;
      } },
    ] });
    setTimeout(() => area.focus(), 0);
  }

  function reportNodes(plan) {
    const out = [];
    const unit = plan.by === 'type' ? ['room type', 'room types'] : ['room', 'rooms'];
    if (plan.matched.length) out.push(el('p', el('strong', `Matched ${plural(plan.matched.length, unit[0], unit[1])}: `), plan.matched.map((m) => m.label).join(', ') + '.'));
    if (plan.same) out.push(el('p.muted', `${plural(plan.same, 'line')} already had that value.`));
    if (plan.extra.length) out.push(el('p.muted', `${plan.extra.length === 1 ? 'Line' : 'Lines'} ${plan.extra.join(', ')}: only the first two columns were used; the rest was ignored.`));
    if (plan.unmatched.length) {
      out.push(el('p', { style: { marginTop: '6px' } }, el('strong', `Not matched (${plan.unmatched.length}): `)));
      const ul = el('ul');
      for (const u of plan.unmatched) ul.append(el('li', `Line ${u.line}${u.text ? ` "${u.text.length > 60 ? u.text.slice(0, 57) + '…' : u.text}"` : ''}: ${u.why}`));
      out.push(ul);
    }
    if (!plan.matched.length && !plan.unmatched.length) out.push(el('p.muted', 'The list is empty.'));
    return out;
  }

  // -- page versions (stage B) --
  function renderVersions(t) {
    const rec = getPage(model.draft, t.pageId);
    const names = app.names();
    main.append(el('div.row.between.wrap', { style: { margin: '14px 0 8px', gap: '10px' } },
      el('h2', { style: { margin: 0 } }, `Versions of ${t.page.title || 'this page'}`),
      el('div.row', tagControl(app, t.pageId, 'page', { link: false }), el('button.btn.sm', { type: 'button', onclick: () => app.go('editor', { page: t.pageId }) }, 'Edit the master'))));
    main.append(el('div.note.small', 'Each version starts as the master. Only the fields you change in a version stay different; everything else keeps following the master, so later edits to the master reach every version. The pages inside this one are the same in every version (they follow the master).'));
    const table = el('table.ovr-table');
    table.append(el('thead', el('tr', el('th', rec.by === 'type' ? 'Room type' : 'Room'), el('th', 'This version'), el('th', ''))));
    const body = el('tbody');
    const versions = rec.versions || {};
    const keys = rec.by === 'type'
      ? app.rooms.types.filter((ty) => !ty.retired || String(ty.id) in versions).map((ty) => ({ key: String(ty.id), label: ty.name, sub: plural(ty.rooms || 0, 'room') }))
      : app.rooms.rooms.map((r) => ({ key: r.number, label: `Room ${r.number}`, sub: [r.name, r.type_id ? names.typeName(r.type_id) : ''].filter(Boolean).join(' · ') }));
    const known = new Set(keys.map((k) => k.key.toLowerCase()));
    for (const k of Object.keys(versions)) if (!known.has(k.toLowerCase())) keys.push({ key: k, label: keyLabel(rec.by, k, names), sub: 'No longer in the Rooms list' });
    const LABELS = { title: 'title', kicker: 'small caps line', subtitle: 'subtitle', image: 'photo', body: 'text', facts: 'facts', hoursTitle: 'hours heading', hours: 'hours', qr: 'QR code', sections: 'menu', images: 'photos', items: 'cards', description: 'description', photos: 'photo frames', films: 'films', backgroundFilm: 'background film', slides: 'slides' };
    for (const k of keys) {
      const patch = versionPatch(model.draft, t.pageId, k.key);
      const changed = Object.keys(patch);
      body.append(el('tr' + (changed.length ? '.set' : ''), { dataset: { key: k.key } },
        el('td.who', el('b', k.label), el('div.small.muted', k.sub)),
        el('td', changed.length ? `Changed: ${changed.map((f) => LABELS[f] || f).join(', ')}` : el('span.muted', 'The same as the master')),
        el('td.ops', el('div.row', el('button.btn.sm.pri', { type: 'button', onclick: () => app.go('editor', { page: t.pageId, version: k.key }) }, 'Edit'),
          el('button.btn.sm', { type: 'button', disabled: !changed.length, onclick: async () => {
            const ok = await confirmModal(`${k.label}: back to the master?`, `The ${changed.map((f) => LABELS[f] || f).join(', ')} changed in this version will follow the master again. Undo brings them back.`, { okLabel: 'Back to master' });
            if (!ok) return;
            model.commit(`${k.label} version back to the master`, (d) => setVersionPatch(d, t.pageId, k.key, {}), { pageId: t.pageId });
            renderMain(); renderNav();
          } }, 'Back to master')))));
    }
    if (!keys.length) body.append(el('tr', el('td', { colspan: 3 }, el('p.small.muted', 'There are no ' + (rec.by === 'type' ? 'room types' : 'rooms') + ' yet. An admin adds them on the Rooms screen.'))));
    table.append(body);
    main.append(table);
  }

  renderNav();
  renderMain();
  app.loadRooms().then(() => { renderNav(); renderMain(); });

  return {
    update(ev) {
      // Typing here: the lines keep their focus; the list on the left already updated.
      const u = main.querySelector('.ovr-undo');
      if (u) { u.disabled = !model.canUndo; u.title = model.canUndo ? `Undo ${model.undoLabel}` : 'Nothing to undo'; }
      if (ev.origin === 'overrides') return;
      renderNav(); renderMain();
    },
  };
}

/**
 * Reads a pasted two-column list (QA-4). Returns {by, matched: [{key, label, value}],
 * unmatched: [{line, text, why}], same, extra: [line numbers whose extra columns were ignored]}.
 *  - Columns are split by tabs, else by commas, else by runs of spaces.
 *  - The first column is the room ("308", "room 308", "Room-308", "Rm 308") or, for a list
 *    by room type, the room type's name (never its number).
 *  - The second column is the value; any further columns are ignored, and the report says so.
 *    Words keep their commas and spaces when there is no tab (everything after the room is the text).
 */
export function parseList(app, t, def, rec, text) {
  const out = { by: rec.by, matched: [], unmatched: [], same: 0, extra: [] };
  const names = app.names();
  const seen = new Map();
  const unq = (v) => String(v ?? '').trim().replace(/^"(.*)"$/, '$1').trim();
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    // A heading line ("Room, Link") is skipped quietly.
    if (i === 0 && /^(room|rm|room number|room no\.?|number|type|room type)\s*([\t,]|\s{2,}|$)/i.test(line) && !/\d/.test(line.split(/[\t,]|\s{2,}/)[0])) return;
    let who = '', rest = '';
    if (rec.by === 'type') {
      // Type names have spaces in them: the longest name the line starts with, then a separator.
      const ty = [...app.rooms.types].sort((a, b) => b.name.length - a.name.length)
        .find((x) => line.toLowerCase().startsWith(x.name.toLowerCase()) && /^([\t,\s]|$)/.test(line.slice(x.name.length)));
      if (ty) { who = ty.name; rest = line.slice(ty.name.length); }
      else { who = unq(line.split(/[\t,]|\s{2,}/)[0]); rest = line.slice(line.indexOf(who) + who.length); }
    } else {
      const body = line.replace(/^(?:room|rm)\b[\s\-#:.]*/i, '');
      const m = /^([^\t,\s]+)(.*)$/s.exec(body);
      who = unq(m ? m[1] : body);
      rest = m ? m[2] : '';
    }
    // The value: the second column. Further columns are ignored (and said).
    let value;
    if (rest.includes('\t')) {
      const cols = rest.replace(/^[\s,]*\t/, '').replace(/^\s+/, '').split('\t');
      value = unq(cols[0]);
      if (cols.slice(1).some((c) => c.trim())) out.extra.push(i + 1);
    } else if (def.kind === 'qr') {
      const cols = rest.replace(/^[\s,]+/, '').split(/\s*,\s*|\s+/);
      value = unq(cols[0]);
      if (cols.slice(1).some((c) => c.trim())) out.extra.push(i + 1);
    } else {
      value = unq(rest.replace(/^\s*,?\s*/, ''));
    }
    let key = null, label = null;
    if (rec.by === 'type') {
      const ty = app.rooms.types.find((x) => x.name.toLowerCase() === who.toLowerCase());
      if (ty) { key = String(ty.id); label = ty.name; }
    } else {
      const room = app.rooms.rooms.find((x) => String(x.number).toLowerCase() === who.toLowerCase());
      if (room) { key = room.number; label = room.number; }
    }
    if (!key) { out.unmatched.push({ line: i + 1, text: line, why: rec.by === 'type' ? `there is no room type called "${who}" (a list by room type uses the type's name)` : `there is no room ${who} in the Rooms list` }); return; }
    if (!value) { out.unmatched.push({ line: i + 1, text: line, why: `no ${def.kind === 'qr' ? 'web address' : 'value'} after ${rec.by === 'type' ? 'the room type' : 'the room number'}` }); return; }
    const v = def.kind === 'qr' ? { url: value, label: rec.values?.[key]?.label } : value;
    const why = valueProblem(t.field, v, {});
    if (why) { out.unmatched.push({ line: i + 1, text: line, why }); return; }
    if (seen.has(key)) { out.unmatched.push({ line: i + 1, text: line, why: `${keyLabel(rec.by, key, names)} is already on line ${seen.get(key)}; the first one is used` }); return; }
    seen.set(key, i + 1);
    const cur = rec.values?.[key];
    if (def.kind === 'qr' ? cur?.url === value : cur === value) { out.same++; return; }
    out.matched.push({ key, label, value: v });
  });
  return out;
}
