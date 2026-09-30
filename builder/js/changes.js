// What changed since the last publish, in the hotel's words.
// Compares the published bundle with the draft page by page (by id) and
// produces entries like:
//   { id, path: 'Eat & Drink › Firepit Menu', kind: 'changed', lines: ['Smoked bone marrow: £12 → £14'] }

import { deepEqual } from './util.js';
import { cleanPage } from './bundle.js';

const FIELD_LABELS = { title: 'Title', kicker: 'Small caps line', subtitle: 'Subtitle', body: 'Text', image: 'Photo' };
const q = (s) => (s === undefined || s === null || s === '' ? 'nothing' : `"${s}"`);
const short = (s, n = 40) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
const arrow = (a, b) => `${short(a) ?? 'nothing'} → ${short(b) ?? 'nothing'}`;

function indexPages(home) {
  const map = new Map();
  const walk = (page, path, parentId) => {
    map.set(page.id, { page, path, parentId });
    for (const c of page.children || []) walk(c, [...path, c.title || '(untitled)'], page.id);
  };
  walk(home, [], null);
  return map;
}

function byName(list, key) {
  const m = new Map();
  for (const x of list || []) if (!m.has(x[key])) m.set(x[key], x);
  return m;
}

function diffMenu(a, b, lines) {
  const as = byName(a.sections, 'title');
  const bs = byName(b.sections, 'title');
  for (const [title, sb] of bs) {
    const sa = as.get(title);
    if (!sa) { lines.push(`New part: ${title} (${(sb.items || []).length} dishes)`); continue; }
    if ((sa.note || '') !== (sb.note || '')) lines.push(`${title} note: ${arrow(sa.note, sb.note)}`);
    const ai = byName(sa.items, 'name');
    const bi = byName(sb.items, 'name');
    for (const [name, db] of bi) {
      const da = ai.get(name);
      if (!da) { lines.push(`${name}: added${db.price ? ' at ' + db.price : ''}`); continue; }
      if ((da.price || '') !== (db.price || '')) lines.push(`${name}: ${arrow(da.price, db.price)}`);
      if ((da.description || '') !== (db.description || '')) lines.push(`${name}: description changed`);
      if (!deepEqual(da.tags || [], db.tags || [])) lines.push(`${name}: tags now ${(db.tags || []).map((t) => t.toUpperCase()).join(', ') || 'none'}`);
    }
    for (const name of ai.keys()) if (!bi.has(name)) lines.push(`${name}: taken off`);
  }
  for (const title of as.keys()) if (!bs.has(title)) lines.push(`Part removed: ${title}`);
  const order = (s) => (s.sections || []).map((x) => x.title).join('|');
  if (order(a) !== order(b) && as.size === bs.size && [...as.keys()].every((k) => bs.has(k))) lines.push('Parts reordered');
}

function diffList(a, b, lines) {
  const ai = byName(a.items, 'title');
  const bi = byName(b.items, 'title');
  for (const [title, ib] of bi) {
    const ia = ai.get(title);
    if (!ia) { lines.push(`New card: ${title}`); continue; }
    const changed = ['meta', 'subtitle', 'body', 'image'].filter((k) => (ia[k] || '') !== (ib[k] || ''));
    if (changed.length) lines.push(`${title}: ${changed.map((k) => ({ meta: 'date or distance', subtitle: 'line', body: 'text', image: 'photo' })[k]).join(', ')} changed`);
  }
  for (const title of ai.keys()) if (!bi.has(title)) lines.push(`Card removed: ${title}`);
  const order = (s) => (s.items || []).map((x) => x.title).join('|');
  if (order(a) !== order(b) && ai.size === bi.size && [...ai.keys()].every((k) => bi.has(k))) lines.push('Cards reordered');
}

function diffPage(a, b) {
  const lines = [];
  for (const [k, label] of Object.entries(FIELD_LABELS)) {
    if ((a[k] || '') !== (b[k] || '')) {
      if (k === 'image') lines.push(a.image ? 'Photo changed' : 'Photo added');
      else if (k === 'body') lines.push(`Text changed (${(b.body || '').length} characters)`);
      else lines.push(`${label}: ${q(short(a[k]))} → ${q(short(b[k]))}`);
    }
  }
  if (!deepEqual(a.facts || [], b.facts || [])) lines.push(`Facts: now ${(b.facts || []).length} points`);
  const ha = (a.hours || []).map((h) => `${h.label}: ${h.value}`);
  const hb = (b.hours || []).map((h) => `${h.label}: ${h.value}`);
  if (!deepEqual(ha, hb)) {
    const am = byName(a.hours, 'label');
    for (const h of b.hours || []) {
      const old = am.get(h.label);
      if (!old) lines.push(`New row: ${h.label} ${h.value}`);
      else if (old.value !== h.value) lines.push(`${h.label}: ${arrow(old.value, h.value)}`);
    }
    for (const h of a.hours || []) if (!(b.hours || []).some((x) => x.label === h.label)) lines.push(`Row removed: ${h.label}`);
  }
  if (!deepEqual(a.qr || null, b.qr || null)) lines.push(b.qr ? (a.qr ? 'QR link changed' : 'QR link added') : 'QR link removed');
  if (!deepEqual(a.images || [], b.images || [])) lines.push(`Gallery: now ${(b.images || []).length} photos`);
  if (a.sections || b.sections) diffMenu(a, b, lines);
  if (a.items || b.items) diffList(a, b, lines);
  const ka = (a.children || []).map((c) => c.id);
  const kb = (b.children || []).map((c) => c.id);
  const sameSet = ka.length === kb.length && ka.every((id) => kb.includes(id));
  if (sameSet && ka.join() !== kb.join()) {
    lines.push(`Order is now: ${(b.children || []).map((c) => c.title || '(untitled)').join(', ')}`);
  }
  return lines;
}

/**
 * @param publishedBundle  the bundle on TVs now (may be null)
 * @param draft            the draft document (with hidden marks)
 * @returns {entries: [...], summary: [string]}
 */
export function describeChanges(publishedBundle, draft) {
  const entries = [];
  const pub = indexPages(publishedBundle?.home || { id: 'home', type: 'home', title: '' });
  const cur = indexPages(draft.home);

  for (const [id, { page, path }] of cur) {
    const label = path.length ? path.join(' › ') : 'Home';
    const was = pub.get(id);
    if (page.hidden) {
      if (was) entries.push({ id, path: label, kind: 'hidden', lines: ['Hidden from guests'] });
      continue;
    }
    const cleaned = cleanPage(page) || page;
    if (!was) {
      const type = { hub: 'section', info: 'venue page', menu: 'menu page', gallery: 'photo gallery', list: 'cards page', contact: 'contact page' }[page.type] || 'page';
      entries.push({ id, path: label, kind: 'new', lines: [`New ${type}`] });
      continue;
    }
    const lines = diffPage(was.page, cleaned);
    if (was.parentId !== cur.get(id).parentId) {
      // Renames show as title changes; a move between sections shows here.
      const parentNow = path.slice(0, -1).join(' › ') || 'Home';
      const parentWas = was.path.slice(0, -1).join(' › ') || 'Home';
      lines.push(`Moved from ${parentWas} to ${parentNow}`);
    }
    if (lines.length) entries.push({ id, path: label, kind: 'changed', lines });
  }
  for (const [id, { page, path }] of pub) {
    if (!cur.has(id)) entries.push({ id, path: path.join(' › ') || page.title, kind: 'removed', lines: ['Deleted'] });
  }

  const hotelLines = [];
  const labels = { name: 'Hotel name', tagline: 'Tagline', reception: 'Reception', roomService: 'Room service', wifiName: 'Wi-Fi name', wifiPassword: 'Wi-Fi password', checkout: 'Check-out' };
  for (const [k, label] of Object.entries(labels)) {
    const a = publishedBundle?.hotel?.[k] ?? '';
    const b = draft.hotel?.[k] ?? '';
    if (a !== b) hotelLines.push(`${label}: ${arrow(a, b)}`);
  }
  if (hotelLines.length) entries.push({ id: 'hotel', path: 'Hotel details', kind: 'changed', lines: hotelLines });

  const summary = entries.flatMap((e) => e.lines.map((l) => `${e.path}: ${l}`));
  return { entries, summary };
}

/** Status of one page for the strip cards: live, changed, new, hidden. */
export function pageStatus(publishedBundle, page) {
  if (page.hidden) return 'hidden';
  const pub = publishedBundle ? indexPages(publishedBundle.home).get(page.id) : null;
  if (!pub) return 'new';
  const cleaned = cleanPage(page) || page;
  return diffPage(pub.page, cleaned).length ? 'changed' : 'live';
}
