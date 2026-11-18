// Rooms (Cave server only): every room, its room type, the Apple TV in its
// bedroom and living room, and the room details (extra columns admins add).
// The server recognises a TV by its network address. What each TV shows
// differently by room is set on the Overrides screen (overrides.js).
// Admins change things; editors look. Three views: Rooms, Room types, Room details.

import { el, clear, fmtDate, plural, svgIcon } from '../util.js';
import { toast, modal, textField, uid, confirmModal, promptModal, moveButtons } from '../ui.js';
import { model } from '../model.js';
import { fieldLabel } from '../overrides.js';

/**
 * Where a room (by number) or a room type (by id) has its own content (Overrides), in the draft
 * and on TVs: ['Room Service › QR code (on TVs and in the draft)', …]. Renumbering or deleting
 * warns with this first (QA-5).
 */
function overrideUses(by, key) {
  const k = String(key).toLowerCase();
  const found = new Map();
  const scan = (ov, where) => {
    for (const [pid, rec] of Object.entries(ov || {})) {
      const items = [['page', rec?.page, 'versions'], ...Object.entries(rec?.fields || {}).map(([f, r]) => [f, r, 'values'])];
      for (const [field, r, map] of items) {
        if (!r || r.by !== by || !Object.keys(r[map] || {}).some((x) => x.toLowerCase() === k)) continue;
        const label = `${model.pathLabel(pid) || pid} › ${fieldLabel(model.find(pid)?.page, field)}`;
        found.set(label, [...(found.get(label) || []), where]);
      }
    }
  };
  scan(model.draft?.overrides, 'in the draft');
  scan(model.published?.overrides?.draft, 'on TVs');
  return [...found].map(([label, where]) => `${label} (${[...new Set(where)].reverse().join(' and ')})`);
}
const onTVs = (uses) => uses.some((u) => u.includes('on TVs'));
/** What the server did with a room's own content, said once it is done. */
const sayMoved = (r) => { if (r?.overrides?.length) toast(r.overrides.join(' '), { ms: 12000 }); };

const LIVE_MIN = 10;      // seen in the last 10 minutes: on and working
const PLACES = [['bedroom', 'Bedroom'], ['living', 'Living room']];
const KINDS = [['text', 'Text'], ['link', 'Link'], ['photo', 'Photo'], ['yesno', 'Yes or no']];
const KIND_HELP = { text: 'Any short text, for example a floor or a phone number.', link: 'A web address starting https://. (A QR code that differs by room is set under Overrides.)', photo: 'A photo chosen from Media.', yesno: 'Yes or no, for example "Has a bath".' };

function ago(iso, nowMs) {
  if (!iso) return 'never';
  const s = Math.max(0, (nowMs - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/**
 * Which TV app a TV runs, from the build it sends with its version.json request
 * (X-Cave-App-Build, phase B): "app 8". Apps before build 8 never send it, so a
 * TV that has asked for content without saying is "older app". Never seen: nothing.
 */
export function appBuild(t, minimum = 8) {
  if (!t || !t.last_seen) return null;
  if (!t.app_build) return { text: 'older app', old: true, title: `This TV has not said which app it runs. Apps before build ${minimum} do not say, and show galleries without captions, chapters or the slideshow.` };
  const old = parseInt(String(t.app_build), 10) < minimum;
  return { text: `app ${t.app_build}`, old, title: `TV app build ${t.app_build}${t.app_build_seen ? `, reported ${fmtDate(t.app_build_seen)}` : ''}${old ? `. Builds before ${minimum} show galleries without captions, chapters or the slideshow.` : ''}` };
}
const appTag = (t, minimum) => { const a = appBuild(t, minimum); return a ? el('span.app-build' + (a.old ? '.old' : ''), { title: a.title }, a.text) : null; };

function state(iso, nowMs) {
  if (!iso) return ['grey', 'Never seen'];
  const min = (nowMs - new Date(iso).getTime()) / 60000;
  if (min <= LIVE_MIN) return ['green', 'On'];
  if (min <= 24 * 60) return ['amber', 'Seen today'];
  return ['grey', 'Not seen for a while'];
}

/** A <select> whose value is set after its options exist. */
function select(options, value, props = {}) {
  const s = el('select.in', props, options.map(([v, label, extra]) => el('option', { value: v, ...(extra || {}) }, label)));
  s.value = value ?? '';
  return s;
}

function shortLink(url) {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return u.host + (path.length > 1 ? (path.length > 14 ? '/…' + path.slice(-10) : path) : '');
  } catch { return url; }
}

export function mount(host, app) {
  const main = el('main');
  host.append(el('div.screen', main));
  if (!app.server) {
    main.append(el('h1', 'Rooms'), el('p.muted', 'The room list lives on the hotel\'s own server.'));
    return {};
  }
  const admin = app.server.isAdmin;
  let data = null;
  /** The first app build that draws the better gallery, as the server says. */
  const minBuild = () => data?.olderApps?.minimum || 8;
  let error = '';
  let tab = 'rooms';
  let filter = '';
  let typeFilter = '';        // '' every type, 'none' no type yet, or a type id
  let refocus = null;         // after a TV is placed: the place box to put the cursor back in
  let timer = null;

  async function load() {
    try { data = await app.server.rooms(); error = ''; } catch (e) { error = e.message; }
    render();
    if (refocus) {
      const box = main.querySelector(`input[aria-label="${CSS.escape(refocus)}"]`);
      refocus = null;
      if (box) { box._quiet = true; box.focus(); }
    }
  }

  const now = () => new Date(data?.now || Date.now()).getTime();
  const typeName = (id) => data.types.find((t) => t.id === id)?.name || '';
  const liveDetails = () => data.details.filter((d) => !d.retired);
  const allTVs = () => [...data.rooms.flatMap((r) => PLACES.map(([p]) => r.tvs[p]).filter(Boolean)), ...data.unplaced];

  /** Runs a change; on a refusal shows the server's plain message. Returns true when it went through. */
  async function attempt(fn, done) {
    try { await fn(); if (done) toast(done); await load(); return true; }
    catch (e) { toast(e.message, { error: true }); return false; }
  }

  function render() {
    clear(main);
    main.append(el('div.row.between.wrap', { style: { marginBottom: '6px' } },
      el('div', el('h1', 'Rooms'), el('p.muted', 'Every room, its room type and its Apple TVs. A TV shows green when it has asked for content in the last 10 minutes.')),
      admin ? el('div.row',
        el('button.btn', { type: 'button', onclick: importList }, 'Import a list…'),
        el('button.btn', { type: 'button', onclick: addRoom }, '+ Add a room')) : null));
    const seg = el('div.seg', { role: 'tablist', style: { margin: '8px 0 12px' } });
    for (const [id, label] of [['rooms', 'Rooms'], ['types', 'Room types'], ['details', 'Room details']]) {
      seg.append(el('button' + (tab === id ? '.on' : ''), { type: 'button', role: 'tab', 'aria-selected': tab === id ? 'true' : 'false', onclick: () => { tab = id; render(); } }, label));
    }
    main.append(seg);
    if (error) { main.append(el('div.note.block', error)); return; }
    if (!data) { main.append(el('p.muted', 'Loading…')); return; }
    if (tab === 'types') renderTypes();
    else if (tab === 'details') renderDetails();
    else renderRooms();
  }

  // ---- Rooms --------------------------------------------------------------
  // Admins: every row is editable all the time. Each field saves on its own
  // (drop-downs on change, text on Enter or on leaving the field); one room's
  // saves go to the server one after another, so quick changes are never lost.
  // A value the server refuses stays in its field with the reason under it,
  // and survives the table being redrawn (drafts).

  const drafts = new Map();     // `${roomId}:${field}` -> { value, error }: typed, not yet accepted by the server
  const chains = new Map();     // roomId -> the promise of that room's last save
  let inflight = 0;             // saves on their way to the server
  let closeOpenList = null;     // closes the TV suggestion list that is open, if any
  let drawPills = () => {};

  function renderRooms() {
    const n = now();
    const typeOpts = [['', 'Every room type'], ...data.types.map((t) => [String(t.id), t.name + (t.retired ? ' (retired)' : '')]), ['none', 'No room type yet']];
    const pills = el('div.row.wrap');
    drawPills = () => {
      const tvs = allTVs();
      const on = tvs.filter((t) => state(t.last_seen, n)[0] === 'green').length;
      const noType = data.rooms.filter((r) => !r.type_id).length;
      clear(pills);
      pills.append(el('span.pill', plural(data.rooms.length, 'room')), el('span.pill', plural(tvs.length, 'TV')), el('span.pill.green', `${on} on now`),
        noType ? el('span.pill.amber', `${noType} without a room type`) : '',
        data.unplaced.length ? el('span.pill.amber', `${data.unplaced.length} not in a room yet`) : '');
    };
    drawPills();
    main.append(el('div.row.wrap', { style: { margin: '0 0 10px' } }, pills,
      el('span.spacer'),
      select(typeOpts, typeFilter, { 'aria-label': 'Show room type', style: { maxWidth: '200px' }, onchange: (e) => { typeFilter = e.target.value; renderTable(); } }),
      el('input.in', { type: 'search', placeholder: 'Find a room, name or address', 'aria-label': 'Find', value: filter, style: { maxWidth: '240px' }, oninput: (e) => { filter = e.target.value; renderTable(); } })));
    const tableHost = el('div.table-wrap');
    main.append(tableHost);

    function renderTable() {
      clear(tableHost);
      if (!data.rooms.length) {
        tableHost.append(el('div.empty', admin ? 'No rooms yet. Add one, or import a list of rooms and addresses with "Import a list…".' : 'No rooms yet.'));
        return;
      }
      const q = filter.trim().toLowerCase();
      const rows = data.rooms.filter((r) => {
        if (typeFilter === 'none' ? r.type_id : typeFilter && String(r.type_id) !== typeFilter) return false;
        if (!q) return true;
        const tvBits = PLACES.flatMap(([p]) => (r.tvs[p] ? [r.tvs[p].address, r.tvs[p].device_name, r.tvs[p].mac] : []));
        return [r.number, r.name, typeName(r.type_id), r.notes, ...tvBits].some((v) => (v || '').toLowerCase().includes(q));
      });
      const details = liveDetails();
      const table = el('table.grid-table.rooms' + (admin ? '.live' : ''));
      table.append(el('thead', el('tr', el('th', 'Room'), el('th', 'Name'), el('th', 'Room type'), el('th', 'Bedroom TV'), el('th', 'Living room TV'),
        details.map((d) => el('th', d.label)), el('th.wide-only', 'Notes'), admin ? el('th', el('span.visually-hidden', 'Saved, more')) : null)));
      const tb = el('tbody');
      for (const r of rows) tb.append(admin ? liveRow(r, details, n) : viewRow(r, details, n));
      table.append(tb);
      tableHost.append(table);
      if (!rows.length) tableHost.append(el('p.muted.small', { style: { padding: '10px' } }, 'No room matches.'));
    }
    renderTable();
    renderUnplaced(n);
    renderUnknown(n);
  }

  // -- editors: read only

  function tvCell(room, place, n) {
    const t = room.tvs[place];
    if (!t) return el('span.muted', 'none');
    const [colour, label] = state(t.last_seen, n);
    const title = [t.device_name, t.mac, t.last_seen ? 'Last seen ' + fmtDate(t.last_seen) : 'Never seen', t.notes].filter(Boolean).join(' · ');
    return el('span.tvcell', { title }, el('span.dot.' + colour, { title: label, 'aria-label': label }),
      el('span', t.address ? el('code', t.address) : el('span.muted', 'no address'), el('small', ago(t.last_seen, n), appTag(t, minBuild()))));
  }

  function valueView(d, v) {
    if (!v) return el('span.muted', '–');
    if (d.kind === 'link') return el('a', { href: v, target: '_blank', rel: 'noopener noreferrer', title: v }, shortLink(v));
    if (d.kind === 'yesno') return v === 'yes' ? 'Yes' : 'No';
    if (d.kind === 'photo') {
      const url = app.media.url(v, 800);
      return url ? el('img.room-photo', { src: url, alt: '' }) : 'Photo';
    }
    return el('span.clip', { title: v }, v);
  }

  function viewRow(r, details, n) {
    const t = data.types.find((x) => x.id === r.type_id);
    return el('tr',
      el('td', el('strong', r.number)),
      el('td', r.name || ''),
      el('td', t ? [t.name, t.retired ? el('span.muted', ' (retired)') : null] : el('span.pill.amber', 'Not set')),
      el('td', tvCell(r, 'bedroom', n)),
      el('td', tvCell(r, 'living', n)),
      details.map((d) => el('td', valueView(d, r.values[String(d.id)]))),
      el('td.muted.wide-only', el('span.clip', { title: r.notes || '' }, r.notes || '')));
  }

  // -- admins: always editable

  function setStatus(status, what) {
    clearTimeout(status._t);
    clear(status);
    status.className = 'row-status ' + what;
    if (what === 'saving') status.append('Saving…');
    else if (what === 'saved') { status.append(svgIcon('check', 13), ' Saved'); status._t = setTimeout(() => status.classList.add('fade'), 2500); }
    else if (what === 'error') status.append('Not saved');
  }

  function showError(input, err, message) {
    input.classList.toggle('bad', !!message);
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    err.textContent = message || '';
  }

  /** Applies a change the server accepted to the room on screen. */
  function applyLocal(r, body) {
    for (const k of ['name', 'notes', 'type_id', 'number']) if (k in body) r[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
    for (const [id, v] of Object.entries(body.values || {})) { if (v === '' || v === null) delete r.values[id]; else r.values[id] = String(v).trim(); }
  }

  /** Queues one field's save behind the room's earlier saves. Resolves true when the server accepted it. */
  function queueSave(r, body, key, value, status, input, err) {
    const prev = chains.get(r.id) || Promise.resolve();
    const p = prev.then(async () => {
      inflight++;
      setStatus(status, 'saving');
      try {
        await app.server.updateRoom(r.id, body);
        applyLocal(r, body);
        drafts.delete(key);
        showError(input, err, '');
        setStatus(status, 'saved');
        drawPills();
        return true;
      } catch (e) {
        drafts.set(key, { value, error: e.message });
        showError(input, err, e.message);
        setStatus(status, 'error');
        return false;
      } finally { inflight--; }
    });
    chains.set(r.id, p.catch(() => false));
    return p;
  }

  /** A text field that saves on Enter or on leaving it; Esc puts back what is saved. */
  function textCell(r, key, savedValue, label, max, toBody, status, width) {
    const k = `${r.id}:${key}`;
    const d = drafts.get(k);
    let saved = savedValue || '';
    let sending = null;
    const err = el('div.cell-err', { role: 'alert' });
    const input = el('input.in', { value: d ? d.value : saved, 'aria-label': `${label}, room ${r.number}`, maxlength: max, style: { width }, type: key.startsWith('d') && toBody.link ? 'url' : 'text', spellcheck: 'false' });
    if (d?.error) showError(input, err, d.error);
    const commit = async () => {
      const v = input.value.trim();
      if (v === saved) { drafts.delete(k); showError(input, err, ''); return; }
      if (v === sending) return;
      sending = v;
      if (await queueSave(r, toBody(v), k, input.value, status, input, err)) saved = v;
      sending = null;
    };
    input.addEventListener('input', () => drafts.set(k, { value: input.value, error: drafts.get(k)?.error }));
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { input.value = saved; drafts.delete(k); showError(input, err, ''); }
    });
    return el('div.cell-edit', input, err);
  }

  /** A drop-down that saves as soon as it changes. */
  function selectCell(r, key, options, savedValue, label, toBody, status, width) {
    const k = `${r.id}:${key}`;
    const d = drafts.get(k);
    const err = el('div.cell-err', { role: 'alert' });
    const s = select(options, d ? d.value : (savedValue ?? ''), { 'aria-label': `${label}, room ${r.number}`, style: { width } });
    if (d?.error) showError(s, err, d.error);
    s.addEventListener('change', () => queueSave(r, toBody(s.value), k, s.value, status, s, err));
    return el('div.cell-edit', s, err);
  }

  function detailCell(r, d, status) {
    const id = String(d.id);
    const v = r.values[id] || '';
    const toBody = (x) => ({ values: { [id]: x } });
    if (d.kind === 'yesno') return selectCell(r, 'd' + id, [['', '–'], ['yes', 'Yes'], ['no', 'No']], v, d.label, toBody, status, '74px');
    if (d.kind === 'photo') {
      const photos = app.media.entries().filter((p) => !p.poster).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const opts = [['', 'No photo'], ...photos.map((p) => [p.path, p.name || p.hash])];
      if (v && !photos.some((p) => p.path === v)) opts.push([v, 'The current photo']);
      return selectCell(r, 'd' + id, opts, v, d.label, toBody, status, '150px');
    }
    if (d.kind === 'link') toBody.link = true;
    return textCell(r, 'd' + id, v, d.label, 500, toBody, status, d.kind === 'link' ? '190px' : '130px');
  }

  function liveRow(r, details, n) {
    const status = el('span.row-status', { role: 'status', 'aria-live': 'polite' });
    const typeOpts = [['', 'Not set'], ...data.types.filter((t) => !t.retired || t.id === r.type_id).map((t) => [String(t.id), t.name + (t.retired ? ' (retired)' : '')])];
    return el('tr',
      el('td', el('strong', r.number)),
      el('td', textCell(r, 'name', r.name, 'Room name', 60, (v) => ({ name: v }), status, '130px')),
      el('td', selectCell(r, 'type', typeOpts, r.type_id ? String(r.type_id) : '', 'Room type', (v) => ({ type_id: v ? Number(v) : null }), status, '160px')),
      el('td', tvPicker(r, 'bedroom', n)),
      el('td', tvPicker(r, 'living', n)),
      details.map((d) => el('td', detailCell(r, d, status))),
      el('td.wide-only', textCell(r, 'notes', r.notes, 'Notes', 200, (v) => ({ notes: v }), status, '130px')),
      el('td.row-end', status, el('button.mini.more', { type: 'button', 'aria-label': `More for room ${r.number}`, title: 'Room number, notes, delete', onclick: () => roomDialog(r) }, '⋯')));
  }

  function roomDialog(r) {
    const v = { number: r.number, notes: r.notes || '' };
    const f = (key, label, help, limit) => textField({ id: uid('rm'), label, help, value: v[key], limit, onInput: (x) => { v[key] = x; } });
    const del = el('button.btn.sm.danger', { type: 'button', onclick: async () => {
      const tvs = PLACES.filter(([p]) => r.tvs[p]).length;
      const filled = Object.keys(r.values).length;
      const uses = overrideUses('room', r.number);
      const what = [tvs ? `Its ${plural(tvs, 'TV')} will move to "TVs not in a room yet".` : '', filled ? `Its room details (${filled}) will be lost.` : '',
        uses.length ? `Its own content is removed too, so a room given this number later starts with none: ${uses.join('; ')}.${onTVs(uses) ? ' Because TVs show some of it, the removal goes out as a new publish (it is in the history).' : ''}` : ''].filter(Boolean).join(' ');
      if (!(await confirmModal(`Delete room ${r.number}?`, what || 'It has no TVs and no room details.', { okLabel: 'Delete', danger: true }))) return;
      if (await attempt(async () => sayMoved(await app.server.removeRoom(r.id)), `Room ${r.number} deleted.`)) m.close();
    } }, 'Delete this room');
    const body = el('div',
      f('number', 'Room number', 'For example 101 or 307', 20),
      f('notes', 'Notes (optional)', null, 200),
      el('div.rule'), el('p.small.muted', 'Deleting a room moves its TVs to "TVs not in a room yet" and removes its room details.'), del);
    const m = modal({ title: `Room ${r.number}`, body, actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => {
      const to = v.number.trim();
      const uses = to && to.toLowerCase() !== String(r.number).toLowerCase() ? overrideUses('room', r.number) : [];
      if (uses.length && !(await confirmModal(`Room ${r.number} has its own content`, `It moves with the room to ${to}, so this room's TVs keep showing it and a new room ${r.number} would start with none: ${uses.join('; ')}.${onTVs(uses) ? ' Because TVs show some of it, the move goes out at once as a new publish (it is in the history).' : ''}`, { okLabel: `Renumber to ${to}` }))) return false;
      return attempt(async () => sayMoved(await app.server.updateRoom(r.id, { number: v.number, notes: v.notes })), 'Saved.');
    } }] });
  }

  // -- finding a TV by typing

  const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const isIPv4 = (s) => { const m = IPV4.exec(s); return !!m && m.slice(1).every((x) => Number(x) <= 255); };
  const ipKey = (a) => (a && IPV4.test(a) ? a.split('.').map((x) => x.padStart(3, '0')).join('.') : 'z' + (a || ''));
  const placeWord = (p) => (p === 'living' ? 'living room' : 'bedroom');

  function whereNow(t) {
    return t.room_id ? `now in ${t.room} ${placeWord(t.place)}: will move here` : 'not in a room yet';
  }

  /** The choices for what has been typed in a TV place. */
  function suggestions(q, r, place, current) {
    const out = [];
    const ql = q.toLowerCase();
    const hex = ql.replace(/[^0-9a-f]/g, '');
    const tvs = allTVs().filter((t) => !current || t.id !== current.id);
    const hit = (t) => !q || (t.address || '').includes(ql) || (t.device_name || '').toLowerCase().includes(ql)
      || (!ql.includes('.') && hex.length >= 2 && (t.mac || '').replace(/:/g, '').includes(hex));
    const matches = (q ? tvs.filter(hit) : data.unplaced.filter((t) => !current || t.id !== current.id))
      .sort((a, b) => (a.room_id ? 1 : 0) - (b.room_id ? 1 : 0) || ipKey(a.address).localeCompare(ipKey(b.address)));
    const none = current ? { kind: 'none', label: 'No TV', sub: `take ${current.address || current.device_name || 'this TV'} out of the ${placeWord(place)}` } : null;
    if (none && !q) out.push(none);
    for (const t of matches.slice(0, 8)) out.push({ kind: 'tv', tv: t, label: t.address || 'no address', name: t.device_name || '', sub: whereNow(t), unplaced: !t.room_id });
    if (matches.length > 8) out.push({ kind: 'msg', text: `${matches.length - 8} more: type more to narrow it down.` });
    if (q) {
      const known = new Set(allTVs().map((t) => t.address));
      const asking = (data.unknown || []).filter((u) => u.address.includes(ql) && !known.has(u.address));
      if (isIPv4(q) && !known.has(q) && !asking.some((u) => u.address === q)) out.push({ kind: 'new', address: q, label: `Add ${q} as a new TV here` });
      for (const u of asking.slice(0, 3)) out.push({ kind: 'new', address: u.address, label: `Add ${u.address} as a new TV here`, sub: `asked for content ${ago(u.last_seen, now())}, not in the list` });
      if (!out.some((o) => o.kind === 'tv' || o.kind === 'new')) {
        const looksLikeAddress = /^[\d.]+$/.test(q) && (q.match(/\./g) || []).length >= 3;
        out.push({ kind: 'msg', text: looksLikeAddress
          ? `${q} is not a network address. It needs four numbers from 0 to 255 with dots between, such as 192.168.1.45.`
          : `No TV in the list matches "${q}". To add a new TV, type its full network address, such as 192.168.1.45.` });
      }
      if (none) out.push(none);
    } else if (!matches.length && !none) {
      out.push({ kind: 'msg', text: 'Type part of an address, an Apple TV name or a hardware address.' });
    }
    return out;
  }

  function tvPicker(r, place, n) {
    const t = r.tvs[place];
    const shown = t ? (t.address || t.device_name || t.mac || '') : '';
    const [colour, label] = t ? state(t.last_seen, n) : ['no-tv', 'No TV here'];
    const aria = `${place === 'living' ? 'Living room' : 'Bedroom'} TV, room ${r.number}`;
    const msg = el('div.cell-err', { role: 'alert' });
    const input = el('input.in.tv-search', { value: shown, placeholder: 'Address or name', 'aria-label': aria, role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', autocomplete: 'off', spellcheck: 'false' });
    const sub = t ? el('button.tv-sub', { type: 'button', title: 'Change this TV\'s name, address or notes', onclick: () => tvDialog(t) }, [t.device_name, ago(t.last_seen, n), appBuild(t, minBuild())?.text].filter(Boolean).join(' · ')) : null;
    let list = null;
    let items = [];
    let active = -1;
    let busy = false;

    const position = () => {
      if (!list) return;
      const b = input.getBoundingClientRect();
      list.style.left = `${Math.max(4, Math.min(b.left, window.innerWidth - 344))}px`;
      list.style.top = `${b.bottom + 2}px`;
    };
    const close = () => {
      if (closeOpenList === close) closeOpenList = null;
      if (!list) return;
      list.remove(); list = null;
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    };
    const highlight = (i) => {
      active = i;
      list?.querySelectorAll('.opt').forEach((o) => o.classList.toggle('active', Number(o.dataset.i) === i));
      const node = list?.querySelector(`.opt[data-i="${i}"]`);
      if (node) { input.setAttribute('aria-activedescendant', node.id); node.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
    };
    const draw = () => {
      const q = input.value.trim() === shown ? '' : input.value.trim();
      items = suggestions(q, r, place, t);
      clear(list);
      items.forEach((o, i) => {
        if (o.kind === 'msg') { list.append(el('div.msg', o.text)); return; }
        list.append(el('div.opt.' + o.kind + (o.unplaced ? '.free' : ''), { id: `${list.id}-${i}`, role: 'option', dataset: { i: String(i) }, onclick: () => pick(o) },
          o.kind === 'tv' ? el('code', o.label) : el('b', o.label), o.name ? el('span', o.name) : null, o.sub ? el('small', o.sub) : null));
      });
      const first = q ? items.findIndex((o) => o.kind !== 'msg') : -1;
      highlight(first);
    };
    const open = () => {
      if (closeOpenList && closeOpenList !== close) closeOpenList();   // one list on screen at a time
      closeOpenList = close;
      if (!list) {
        list = el('div.tv-suggest', { role: 'listbox', id: uid('tvs'), 'aria-label': `TVs for the ${placeWord(place)} of room ${r.number}` });
        list.addEventListener('mousedown', (e) => e.preventDefault());   // keep the focus in the box
        document.body.append(list);
        input.setAttribute('aria-controls', list.id);
        input.setAttribute('aria-expanded', 'true');
        window.addEventListener('scroll', position, true);
        window.addEventListener('resize', position);
      }
      draw();
      position();
    };
    async function pick(o) {
      if (o.kind === 'msg' || busy) return;
      close();
      busy = true;
      input.disabled = true;
      msg.textContent = '';
      const typed = input.value;
      try {
        if (o.kind === 'none') await app.server.updateTV(t.id, { room_id: null });
        else if (o.kind === 'tv') await app.server.updateTV(o.tv.id, { room_id: r.id, place, replace: true });
        else await app.server.addTV({ address: o.address, room_id: r.id, place, replace: true });
        const moved = t && o.kind !== 'none' ? ` ${t.address || t.device_name} is now under "TVs not in a room yet".` : '';
        toast(o.kind === 'none' ? `Room ${r.number} ${placeWord(place)}: no TV. It is now under "TVs not in a room yet".` : `Room ${r.number} ${placeWord(place)}: ${o.kind === 'tv' ? o.label : o.address}.${moved}`);
        refocus = aria;
        await load();
      } catch (e) {
        busy = false;
        input.disabled = false;
        input.value = typed;
        msg.textContent = e.message;
        input.focus();
      }
    }
    input.addEventListener('focus', () => {
      if (input._quiet) { input._quiet = false; return; }
      input.select();
      open();
    });
    input.addEventListener('input', () => { msg.textContent = ''; open(); });
    input.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== input && !busy) { close(); input.value = shown; } }, 0); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!list) open();
        const sel = items.map((o, i) => (o.kind === 'msg' ? -1 : i)).filter((i) => i >= 0);
        if (!sel.length) return;
        const at = sel.indexOf(active);
        highlight(e.key === 'ArrowDown' ? sel[(at + 1) % sel.length] : sel[at <= 0 ? sel.length - 1 : at - 1]);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!list) { open(); return; }
        if (active >= 0) pick(items[active]);
      } else if (e.key === 'Escape') {
        if (list || input.value !== shown) { e.preventDefault(); e.stopPropagation(); close(); input.value = shown; msg.textContent = ''; input.select(); }
      }
    });
    return el('div.tv-pick', el('span.dot.' + colour, { title: label, 'aria-label': label }), el('div', input, sub, msg));
  }

  function renderUnplaced(n) {
    main.append(el('h2', { style: { marginTop: '22px' } }, 'TVs not in a room yet'));
    if (!data.unplaced.length) { main.append(el('p.muted.small', 'None. Every TV in the list is in a room.')); return; }
    main.append(el('p.muted.small', { style: { marginBottom: '8px' } }, 'TVs the server knows but that are not in a room\'s bedroom or living room. ' + (admin ? 'Use "Put in a room" once you know where each one is.' : '')));
    const table = el('table.grid-table.tvs');
    table.append(el('thead', el('tr', el('th', ''), el('th', 'TV name'), el('th', 'Network address'), el('th', 'Hardware address'), el('th', 'Last seen'), el('th', 'App'), el('th', 'Notes'), admin ? el('th', '') : null)));
    const tb = el('tbody');
    for (const t of data.unplaced) {
      const [colour, label] = state(t.last_seen, n);
      tb.append(el('tr',
        el('td', el('span.dot.' + colour, { title: label, 'aria-label': label })),
        el('td', t.device_name || el('span.muted', 'no name')),
        el('td', t.address ? el('code', t.address) : el('span.muted', 'none')),
        el('td.muted', t.mac ? el('code', t.mac) : ''),
        el('td', { title: t.last_seen ? fmtDate(t.last_seen) : '' }, ago(t.last_seen, n)),
        el('td', appTag(t, minBuild()) || el('span.muted', '–')),
        el('td.muted', el('span.clip', { title: t.notes || '' }, t.notes || '')),
        admin ? el('td', el('button.btn.sm', { type: 'button', onclick: () => tvDialog(t) }, 'Put in a room')) : null));
    }
    table.append(tb);
    main.append(el('div.table-wrap', table));
  }

  function renderUnknown(n) {
    const unknown = data.unknown || [];
    if (!unknown.length) return;
    main.append(el('h2', { style: { marginTop: '22px' } }, 'Addresses asking for content that are not in the list'),
      el('p.muted.small', { style: { marginBottom: '8px' } }, 'These addresses fetched TV content but no TV in the list has them. Usually a TV whose address changed, or a new TV.'));
    const table = el('table.grid-table');
    table.append(el('thead', el('tr', el('th', 'Network address'), el('th', 'Last seen'), el('th', 'Last asked for'), el('th', 'App'), el('th', 'Device'), admin ? el('th', '') : null)));
    const tb = el('tbody');
    for (const u of unknown) {
      tb.append(el('tr', el('td', el('code', u.address)), el('td', { title: fmtDate(u.last_seen) }, ago(u.last_seen, n)), el('td.muted', u.last_path || ''), el('td', appTag(u, minBuild()) || el('span.muted', '–')), el('td.muted', (u.user_agent || '').slice(0, 60)),
        admin ? el('td', el('button.btn.sm', { type: 'button', onclick: () => addTV({ address: u.address }) }, 'Add as a TV')) : null));
    }
    table.append(tb);
    main.append(el('div.table-wrap', table));
  }

  // ---- dialogs: rooms and TVs ----------------------------------------------

  /** Room and place pickers for a TV. v.room_id: '' for none. */
  function placePickers(v) {
    const rooms = [['', 'Not in a room yet'], ...data.rooms.map((r) => [String(r.id), `Room ${r.number}${r.name ? ' · ' + r.name : ''}`])];
    const id = uid('room');
    const placeRow = el('div.seg', { role: 'radiogroup', 'aria-label': 'Where in the room' });
    const drawPlaces = () => {
      clear(placeRow);
      for (const [p, label] of PLACES) {
        const room = data.rooms.find((r) => String(r.id) === v.room_id);
        const other = room?.tvs[p] && room.tvs[p].id !== v.tv_id ? room.tvs[p] : null;
        placeRow.append(el('button' + (v.place === p ? '.on' : ''), { type: 'button', role: 'radio', 'aria-checked': v.place === p ? 'true' : 'false', disabled: !v.room_id,
          title: other ? `Has a TV now: ${other.device_name || other.address}` : '', onclick: () => { v.place = p; drawPlaces(); } }, label + (other ? ' (taken)' : '')));
      }
    };
    drawPlaces();
    return el('div',
      el('div.field', el('label', { for: id }, el('span', 'Room')),
        select(rooms, v.room_id, { id, onchange: (e) => {
          v.room_id = e.target.value;
          const room = data.rooms.find((r) => String(r.id) === v.room_id);
          if (room && (!v.place || (room.tvs[v.place] && room.tvs[v.place].id !== v.tv_id))) v.place = PLACES.map(([p]) => p).find((p) => !room.tvs[p] || room.tvs[p].id === v.tv_id) || v.place || 'bedroom';
          if (!room) v.place = '';
          drawPlaces();
        } })),
      el('div.field', el('label', el('span', 'Where in the room')), placeRow));
  }

  /** Saves a TV's room and place; if the place is taken, offers to swap the other TV out. */
  async function saveTV(id, body) {
    try {
      if (id) await app.server.updateTV(id, body); else await app.server.addTV(body);
    } catch (e) {
      if (e.status !== 409 || !body.room_id) throw e;
      const ok = await confirmModal('That place has a TV already', `${e.message} Put this one there instead? The other TV moves to "TVs not in a room yet".`, { okLabel: 'Put this one there' });
      if (!ok) return false;
      if (id) await app.server.updateTV(id, { ...body, replace: true }); else await app.server.addTV({ ...body, replace: true });
    }
    return true;
  }

  function tvDialog(t) {
    const v = { tv_id: t.id, device_name: t.device_name || '', address: t.address || '', notes: t.notes || '', room_id: t.room_id ? String(t.room_id) : '', place: t.place || '' };
    const f = (key, label, help, limit) => textField({ id: uid('tv'), label, help, value: v[key], limit, onInput: (x) => { v[key] = x; } });
    const body = el('div',
      t.mac ? el('p.small.muted', 'Hardware address ', el('code', t.mac), t.last_seen ? ` · last seen ${fmtDate(t.last_seen)}` : ' · never seen') : null,
      placePickers(v),
      f('device_name', 'Apple TV name', 'As the TV calls itself, for example Room-209'),
      f('address', 'Network address', 'As the network company lists it for this TV'),
      f('notes', 'Notes (optional)', null, 200));
    const remove = async (close) => {
      if (!(await confirmModal('Remove this TV from the list?', `${t.device_name || t.address || 'This TV'}: it will show again under "not in the list" the next time it asks for content.`, { okLabel: 'Remove', danger: true }))) return false;
      const ok = await attempt(() => app.server.removeTV(t.id), 'TV removed.');
      if (ok) close();
      return false;
    };
    modal({ title: t.room_id ? `TV in room ${t.room}` : 'A TV not in a room yet', body, actions: [
      { label: 'Remove from the list', danger: true, onClick: remove },
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: async () => {
        const place = { room_id: v.room_id ? Number(v.room_id) : null, ...(v.room_id ? { place: v.place || '' } : {}) };
        try {
          if (!(await saveTV(t.id, { device_name: v.device_name, address: v.address, notes: v.notes, ...place }))) return false;
          toast('Saved.'); await load(); return true;
        } catch (e) { toast(e.message, { error: true }); return false; }
      } }] });
  }

  function addTV(prefill = {}) {
    const v = { address: prefill.address || '', device_name: '', notes: '', room_id: '', place: '' };
    const f = (key, label, help, limit) => textField({ id: uid('tv'), label, help, value: v[key], limit, onInput: (x) => { v[key] = x; } });
    const body = el('div', f('address', 'Network address', 'As the network company lists it for this TV'), placePickers(v), f('device_name', 'Apple TV name (optional)'), f('notes', 'Notes (optional)', null, 200));
    modal({ title: 'Add a TV', body, actions: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: async () => {
      try {
        const ok = await saveTV(null, { address: v.address, device_name: v.device_name, notes: v.notes, ...(v.room_id ? { room_id: Number(v.room_id), place: v.place } : {}) });
        if (!ok) return false;
        toast('TV added.'); await load(); return true;
      } catch (e) { toast(e.message, { error: true }); return false; }
    } }] });
  }

  function addRoom() {
    const v = { number: '', name: '', type_id: '', notes: '' };
    const f = (key, label, help, limit) => textField({ id: uid('rm'), label, help, value: '', limit, onInput: (x) => { v[key] = x; } });
    const tid = uid('rt');
    const body = el('div',
      f('number', 'Room number', 'For example 101 or 307', 20),
      f('name', 'Name (optional)', 'For example The Penthouse', 60),
      el('div.field', el('label', { for: tid }, el('span', 'Room type')),
        select([['', 'Not set yet'], ...data.types.filter((t) => !t.retired).map((t) => [String(t.id), t.name])], '', { id: tid, onchange: (e) => { v.type_id = e.target.value; } })),
      f('notes', 'Notes (optional)', null, 200));
    modal({ title: 'Add a room', body, actions: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: async () =>
      attempt(() => app.server.addRoom({ number: v.number, name: v.name, notes: v.notes, type_id: v.type_id ? Number(v.type_id) : null }), `Room ${v.number.trim()} added.`) }] });
  }

  function importList() {
    let file = null;
    let overwrite = false;
    const out = el('div.import-out', { role: 'status', 'aria-live': 'polite' });
    const fid = uid('file');
    const input = el('input', { id: fid, type: 'file', accept: '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', onchange: (e) => { file = e.target.files[0] || null; clear(out); apply.disabled = true; } });
    const show = (r, cls = '') => { clear(out); out.className = 'import-out ' + cls; for (const line of r.lines || []) out.append(el(line.startsWith('  ') ? 'div.sub-line' : 'div', line.trim())); };
    const check = el('button.btn', { type: 'button', onclick: async () => {
      if (!file) { toast('Choose the list first.', { error: true }); return; }
      check.disabled = true;
      try { show(await app.server.importRoomList(file, { overwrite, check: true })); apply.disabled = false; }
      catch (e) { clear(out); out.append(el('div.note.block', e.message)); }
      check.disabled = false;
    } }, 'Check the list');
    const apply = el('button.btn.pri', { type: 'button', disabled: true, onclick: async () => {
      apply.disabled = true;
      try { show(await app.server.importRoomList(file, { overwrite }), 'done'); toast('List imported.'); await load(); }
      catch (e) { clear(out); out.append(el('div.note.block', e.message)); }
    } }, 'Bring it in');
    const body = el('div',
      el('p.small', 'A spreadsheet (.xlsx) or .csv with a row per TV. The first row names the columns, in any wording: room, place (bedroom or living room), IP address, MAC address, TV name, room type. Nothing changes until you press "Bring it in".'),
      el('div.field', el('label', { for: fid }, el('span', 'The list')), input),
      el('label.row.small', { style: { margin: '6px 0 10px' } }, el('input', { type: 'checkbox', onchange: (e) => { overwrite = e.target.checked; clear(out); apply.disabled = true; } }),
        'Replace what was filled in by hand (a TV\'s room and place, names, room types)'),
      el('div.row', check, apply),
      out);
    modal({ title: 'Import a list of rooms and addresses', body, wide: true, actions: [{ label: 'Close' }] });
  }

  // ---- Room types -------------------------------------------------------------

  function renderTypes() {
    main.append(el('p.muted.small', { style: { marginBottom: '10px', maxWidth: '720px' } },
      'Each room has a room type. Later, a page such as Your Room can be different for each room type. A type that rooms use cannot be deleted; retire it instead (it stays on those rooms but cannot be chosen for others).'));
    const table = el('table.grid-table');
    table.append(el('thead', el('tr', admin ? el('th', '') : null, el('th', 'Room type'), el('th', 'Rooms'), el('th', ''), admin ? el('th', '') : null)));
    const tb = el('tbody');
    const ids = data.types.map((t) => t.id);
    data.types.forEach((t, i) => {
      tb.append(el('tr' + (t.retired ? '.off' : ''),
        admin ? el('td', { style: { width: '60px' } }, moveButtons(i, ids.length, (from, to) => { const o = ids.slice(); o.splice(to, 0, o.splice(from, 1)[0]); attempt(() => app.server.orderRoomTypes(o)); })) : null,
        el('td', admin ? el('input.in', { value: t.name, 'aria-label': 'Name of room type', maxlength: 40, style: { maxWidth: '280px' }, onchange: (e) => attempt(() => app.server.updateRoomType(t.id, { name: e.target.value }), 'Renamed.') }) : t.name),
        el('td', t.rooms ? el('button.btn.link', { type: 'button', onclick: () => { tab = 'rooms'; typeFilter = String(t.id); render(); } }, plural(t.rooms, 'room')) : el('span.muted', 'none')),
        el('td', t.retired ? el('span.pill', 'Retired') : ''),
        admin ? el('td', el('div.row',
          el('button.btn.sm', { type: 'button', onclick: () => attempt(() => app.server.updateRoomType(t.id, { retired: !t.retired }), t.retired ? 'Brought back.' : 'Retired.') }, t.retired ? 'Bring back' : 'Retire'),
          el('button.btn.sm.danger', { type: 'button', disabled: t.rooms > 0, title: t.rooms ? 'Rooms use this type: retire it instead' : '', onclick: async () => {
            const uses = overrideUses('type', t.id);
            const more = uses.length ? ` Its own content is removed with it: ${uses.join('; ')}.${onTVs(uses) ? ' Because TVs show some of it, the removal goes out as a new publish (it is in the history).' : ''}` : '';
            if (await confirmModal(`Delete ${t.name}?`, `No room uses it.${more}`, { okLabel: 'Delete', danger: true })) attempt(async () => sayMoved(await app.server.removeRoomType(t.id)), 'Deleted.');
          } }, 'Delete'))) : null));
    });
    table.append(tb);
    main.append(el('div.table-wrap', { style: { maxWidth: '760px' } }, table));
    if (!data.types.length) main.append(el('div.empty', { style: { maxWidth: '760px', marginTop: '8px' } }, 'No room types.'));
    if (admin) {
      main.append(el('div', { style: { marginTop: '10px' } }, el('button.btn', { type: 'button', onclick: async () => {
        const name = await promptModal('Add a room type', 'Name', { placeholder: 'For example Garden Room', okLabel: 'Add', limit: 40 });
        if (name) attempt(() => app.server.addRoomType(name), 'Added.');
      } }, '+ Add a room type')));
    }
  }

  // ---- Room details (the extra columns) -----------------------------------------------

  function renderDetails() {
    main.append(el('p.muted.small', { style: { marginBottom: '10px', maxWidth: '720px' } },
      'Extra columns on the Rooms list, filled in for each room, for example a floor or the butler\'s phone, for the team\'s own records. What a TV shows differently by room (a room\'s own ordering QR code, say) is set under Overrides, not here. A column that rooms have filled in cannot be deleted or change kind; retire it instead (the values are kept and come back with it).'));
    const table = el('table.grid-table');
    table.append(el('thead', el('tr', admin ? el('th', '') : null, el('th', 'Room detail'), el('th', 'Kind'), el('th', 'Filled in'), el('th', ''), admin ? el('th', '') : null)));
    const tb = el('tbody');
    const ids = data.details.map((d) => d.id);
    data.details.forEach((d, i) => {
      const kindLabel = KINDS.find(([k]) => k === d.kind)?.[1] || d.kind;
      tb.append(el('tr' + (d.retired ? '.off' : ''),
        admin ? el('td', { style: { width: '60px' } }, moveButtons(i, ids.length, (from, to) => { const o = ids.slice(); o.splice(to, 0, o.splice(from, 1)[0]); attempt(() => app.server.orderRoomDetails(o)); })) : null,
        el('td', admin ? el('input.in', { value: d.label, 'aria-label': 'Name of room detail', maxlength: 40, style: { maxWidth: '260px' }, onchange: (e) => attempt(() => app.server.updateRoomDetail(d.id, { label: e.target.value }), 'Renamed.') }) : d.label),
        el('td', admin && !d.used
          ? select(KINDS, d.kind, { 'aria-label': 'Kind', style: { maxWidth: '140px' }, title: KIND_HELP[d.kind], onchange: (e) => attempt(() => app.server.updateRoomDetail(d.id, { kind: e.target.value }), 'Changed.') })
          : el('span', { title: KIND_HELP[d.kind] }, kindLabel)),
        el('td', `${d.used} of ${plural(data.rooms.length, 'room')}`),
        el('td', d.retired ? el('span.pill', 'Retired') : ''),
        admin ? el('td', el('div.row',
          el('button.btn.sm', { type: 'button', onclick: () => attempt(() => app.server.updateRoomDetail(d.id, { retired: !d.retired }), d.retired ? 'Brought back.' : 'Retired.') }, d.retired ? 'Bring back' : 'Retire'),
          el('button.btn.sm.danger', { type: 'button', disabled: d.used > 0, title: d.used ? 'Rooms have filled this in: retire it instead' : '', onclick: async () => {
            if (await confirmModal(`Delete ${d.label}?`, 'No room has filled it in.', { okLabel: 'Delete', danger: true })) attempt(() => app.server.removeRoomDetail(d.id), 'Deleted.');
          } }, 'Delete'))) : null));
    });
    table.append(tb);
    main.append(el('div.table-wrap', { style: { maxWidth: '860px' } }, table));
    if (!data.details.length) main.append(el('div.empty', { style: { maxWidth: '860px', marginTop: '8px' } }, 'No room details.'));
    if (admin) main.append(el('div', { style: { marginTop: '10px' } }, el('button.btn', { type: 'button', onclick: addDetail }, '+ Add a room detail')));
  }

  function addDetail() {
    let label = '';
    let kind = 'text';
    const help = el('div.help', KIND_HELP.text);
    const kid = uid('kind');
    const body = el('div',
      textField({ id: uid('dl'), label: 'Name', placeholder: 'For example Wi-Fi network', limit: 40, onInput: (x) => { label = x; } }),
      el('div.field', el('label', { for: kid }, el('span', 'Kind')), select(KINDS, kind, { id: kid, onchange: (e) => { kind = e.target.value; help.textContent = KIND_HELP[kind]; } }), help));
    modal({ title: 'Add a room detail', body, actions: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: async () => attempt(() => app.server.addRoomDetail(label, kind), 'Added. It is now a column on the Rooms list.') }] });
  }

  load();
  timer = setInterval(() => {
    // Never redraw under someone's hands: not while a save is on its way, a list or dialog is open, or a field has the cursor.
    const typing = document.activeElement && main.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (!inflight && !typing && !document.querySelector('.modal, .tv-suggest') && document.visibilityState === 'visible') load();
  }, 30000);
  return { unmount() { clearInterval(timer); if (closeOpenList) closeOpenList(); document.querySelectorAll('.tv-suggest').forEach((n) => n.remove()); } };
}
