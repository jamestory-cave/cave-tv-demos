// What changed since the last publish, in the hotel's words.
// Compares the published bundle with the draft page by page (by id) and
// produces entries like:
//   { id, path: 'Eat & Drink › Firepit Menu', kind: 'changed', lines: ['Smoked bone marrow: £12 → £14'] }

import { deepEqual } from './util.js';
import { cleanPage } from './bundle.js';
import { describeOverrideChanges } from './overrides.js';
import { galleryOptions, chapterNames, chapterKey, STYLES } from './gallery.js';

const FIELD_LABELS = { title: 'Title', kicker: 'Small caps line', subtitle: 'Subtitle', body: 'Text', image: 'Photo', description: 'Description',
  hoursTitle: 'Hours heading', childrenTitle: 'Heading above the pages inside' };
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
    if (!deepEqual(ia.qr || null, ib.qr || null)) lines.push(`${title}: ${ib.qr ? (ia.qr ? 'QR code changed' : 'QR code added') : 'QR code removed'}`);
  }
  for (const title of ai.keys()) if (!bi.has(title)) lines.push(`Card removed: ${title}`);
  const order = (s) => (s.items || []).map((x) => x.title).join('|');
  if (order(a) !== order(b) && ai.size === bi.size && [...ai.keys()].every((k) => bi.has(k))) lines.push('Cards reordered');
}

function diffStage2(a, b, lines) {
  // Photo frames.
  const pa = a.photos || [], pb = b.photos || [];
  if (!deepEqual(pa, pb)) {
    if (pa.length !== pb.length) lines.push(`Photo frames: now ${pb.length}${pb.length ? ' (' + pb.map((p) => p.fit === 'whole' ? 'whole' : 'fill').join(', ') + ')' : ''}`);
    else pb.forEach((p, i) => {
      const q = pa[i];
      const what = [];
      if (q.image !== p.image) what.push('photo');
      if ((q.fit || 'fill') !== (p.fit || 'fill')) what.push(p.fit === 'whole' ? 'now shows the whole image' : 'now fills the frame');
      if ((q.caption || '') !== (p.caption || '')) what.push(p.caption ? `caption "${short(p.caption, 40)}"` : 'caption removed');
      if (what.length) lines.push(`Photo frame ${i + 1}: ${what.join(', ')}`);
    });
  }
  // Films.
  const fa = a.films || [], fb = b.films || [];
  if (!deepEqual(fa, fb)) {
    const byFilm = new Map(fa.map((f) => [f.film, f]));
    for (const f of fb) {
      const old = byFilm.get(f.film);
      if (!old) { lines.push(`Film added: ${f.title || 'untitled'}${f.seconds ? ` (${f.seconds} s)` : ''}`); continue; }
      const what = [];
      if ((old.title || '') !== (f.title || '')) what.push(`title ${arrow(old.title, f.title)}`);
      if ((old.poster || '') !== (f.poster || '')) what.push('poster changed');
      if (what.length) lines.push(`Film ${f.title || 'untitled'}: ${what.join(', ')}`);
    }
    for (const f of fa) if (!fb.some((x) => x.film === f.film)) lines.push(`Film removed: ${f.title || 'untitled'}`);
    const order = (l) => l.map((x) => x.film).join('|');
    if (order(fa) !== order(fb) && fa.length === fb.length && fa.every((x) => fb.some((y) => y.film === x.film))) lines.push('Films reordered');
  }
  // Background film.
  const ba = a.backgroundFilm || null, bb = b.backgroundFilm || null;
  if (!deepEqual(ba, bb)) lines.push(bb ? (ba ? 'Background film changed' : 'Background film added') : 'Background film removed');
  // Slides (a gallery's photos and films are described in diffGallery).
  const sa = a.slides || [], sb = b.slides || [];
  if (b.type !== 'gallery' && a.type !== 'gallery' && !deepEqual(sa, sb)) {
    if (sa.length !== sb.length) lines.push(`Slides: now ${sb.length}${sb.some((s) => s.film) ? ` (${sb.filter((s) => s.film).length} film)` : ''}`);
    else {
      const changed = sb.map((s, i) => (deepEqual(s, sa[i]) ? null : i + 1)).filter(Boolean);
      const sameSet = sa.every((s) => sb.some((t) => deepEqual(s, t)));
      lines.push(sameSet ? 'Slides reordered' : `Slide${changed.length > 1 ? 's' : ''} ${changed.join(', ')} replaced`);
    }
  }
}

/** A gallery's frames: its slides when it has any, else its photos. */
const framesOf = (p) => ((p.slides || []).length ? p.slides : (p.images || []).map((image) => ({ image })));
const nOf = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const listNames = (names) => (names.length > 4 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '));

/**
 * A gallery in words: the frames (added, removed, reordered), then what
 * changed on frames that are on both sides ("12 captions added", "chapters
 * added: Hole 1, Hole 2…", "2 frames now show the whole image", "a film now
 * plays with sound"), then the settings (style, plays by itself, seconds).
 */
function diffGallery(a, b, lines) {
  const fa = framesOf(a), fb = framesOf(b);
  if (!deepEqual(fa, fb)) {
    const media = (fr) => fr.film || fr.image || '';
    const bare = (l) => l.map(media);
    const films = fb.filter((x) => x.film).length;
    const what = `${fb.length - films} photo${fb.length - films === 1 ? '' : 's'}${films ? `, ${films} film${films === 1 ? '' : 's'}` : ''}`;
    const sameSet = fa.length === fb.length && bare(fa).every((x) => bare(fb).includes(x)) && bare(fb).every((x) => bare(fa).includes(x));
    if (!sameSet) lines.push(`Gallery: now ${what}`);
    else if (bare(fa).join('|') !== bare(fb).join('|')) lines.push('Gallery: photos and films reordered');
    // Frames on both sides, matched by their photo or film.
    const pool = new Map();
    for (const f of fa) { const k = media(f); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(f); }
    const pairs = [];
    for (const f of fb) { const q = pool.get(media(f)); if (q && q.length) pairs.push([q.shift(), f]); }
    const cap = { added: 0, changed: 0, removed: 0 };
    let whole = 0, filled = 0, loud = 0, quiet = 0, posters = 0;
    for (const [x, y] of pairs) {
      const cx = (x.caption || '').trim(), cy = (y.caption || '').trim();
      if (!cx && cy) cap.added++; else if (cx && !cy) cap.removed++; else if (cx !== cy) cap.changed++;
      if ((x.fit === 'whole') !== (y.fit === 'whole')) { if (y.fit === 'whole') whole++; else filled++; }
      if (y.film && (x.sound === true) !== (y.sound === true)) { if (y.sound === true) loud++; else quiet++; }
      if (y.film && (x.poster || '') !== (y.poster || '')) posters++;
    }
    // New frames shown whole or playing with sound are said too (QA-9).
    const paired = new Set(pairs.map(([, y]) => y));
    for (const y of fb) { if (paired.has(y)) continue; if (y.fit === 'whole') whole++; if (y.film && y.sound === true) loud++; }
    // Captions on frames that are new count as added too.
    const newCaptions = fb.filter((f) => (f.caption || '').trim()).length - pairs.filter(([, y]) => (y.caption || '').trim()).length;
    cap.added += Math.max(0, newCaptions);
    if (cap.added) lines.push(`${nOf(cap.added, 'caption')} added`);
    if (cap.changed) lines.push(`${nOf(cap.changed, 'caption')} changed`);
    if (cap.removed) lines.push(`${nOf(cap.removed, 'caption')} removed`);
    const ca = chapterNames(fa), cb = chapterNames(fb);
    const keysA = ca.map(chapterKey), keysB = cb.map(chapterKey);
    const addedCh = cb.filter((n) => !keysA.includes(chapterKey(n))), goneCh = ca.filter((n) => !keysB.includes(chapterKey(n)));
    if (!ca.length && cb.length) lines.push(`Chapters added: ${listNames(cb)}`);
    else if (ca.length && !cb.length) lines.push('Chapters removed');
    else {
      if (addedCh.length) lines.push(`${addedCh.length === 1 ? 'Chapter' : 'Chapters'} added: ${listNames(addedCh)}`);
      if (goneCh.length) lines.push(`${goneCh.length === 1 ? 'Chapter' : 'Chapters'} removed: ${listNames(goneCh)}`);
      const common = (l, keys) => l.filter((n) => keys.includes(chapterKey(n))).map(chapterKey).join('|');
      if (!addedCh.length && !goneCh.length && common(ca, keysB) !== common(cb, keysA)) lines.push('Chapters reordered');
      const moved = pairs.filter(([x, y]) => chapterKey(x.group) && chapterKey(y.group) && chapterKey(x.group) !== chapterKey(y.group)).length;
      if (moved) lines.push(`${nOf(moved, 'frame')} moved to another chapter`);
    }
    if (whole) lines.push(`${nOf(whole, 'frame')} now ${whole === 1 ? 'shows' : 'show'} the whole image`);
    if (filled) lines.push(`${nOf(filled, 'frame')} now ${filled === 1 ? 'fills' : 'fill'} the frame`);
    if (loud) lines.push(`${loud === 1 ? 'A film now plays' : `${loud} films now play`} with sound`);
    if (quiet) lines.push(`${quiet === 1 ? 'A film is' : `${quiet} films are`} now a silent loop`);
    if (posters) lines.push(`${nOf(posters, 'poster')} changed`);
  }
  const oa = galleryOptions(a), ob = galleryOptions(b);
  if (oa.style !== ob.style) lines.push(`Gallery style: ${STYLES[oa.style]} → ${STYLES[ob.style]}`);
  if (ob.style === 'thumbnails' && oa.autoplay !== ob.autoplay) lines.push(ob.autoplay ? 'Plays by itself after 20 seconds untouched' : 'No longer plays by itself');
  if (oa.seconds !== ob.seconds) lines.push(`Seconds per frame: ${oa.seconds} → ${ob.seconds}`);
}

function diffPage(a, b) {
  const lines = [];
  for (const [k, label] of Object.entries(FIELD_LABELS)) {
    if ((a[k] || '') !== (b[k] || '')) {
      if (k === 'image') lines.push(a.image ? 'Photo changed' : 'Photo added');
      else if (k === 'body') lines.push(b.type === 'gallery' ? (b.body ? (a.body ? 'Intro changed' : 'Intro added') : 'Intro removed') : `Text changed (${(b.body || '').length} characters)`);
      else lines.push(`${label}: ${q(short(a[k]))} → ${q(short(b[k]))}`);
    }
  }
  const fa = a.facts || [], fb = b.facts || [];
  if (!deepEqual(fa, fb)) {
    if (fa.length === fb.length) fb.forEach((f, i) => { if (f !== fa[i]) lines.push(`Fact ${i + 1}: ${arrow(fa[i], f)}`); });
    else {
      for (const f of fb) if (!fa.includes(f)) lines.push(`New fact: ${short(f, 60)}`);
      for (const f of fa) if (!fb.includes(f)) lines.push(`Fact removed: ${short(f, 60)}`);
    }
  }
  const ha = (a.hours || []).map((h) => `${h.label}: ${h.value}`);
  const hb = (b.hours || []).map((h) => `${h.label}: ${h.value}`);
  if (ha.length && !hb.length) lines.push('Hours card removed');
  else if (!deepEqual(ha, hb)) {
    const am = byName(a.hours, 'label');
    for (const h of b.hours || []) {
      const old = am.get(h.label);
      if (!old) lines.push(`New row: ${h.label} ${h.value}`);
      else if (old.value !== h.value) lines.push(`${h.label}: ${arrow(old.value, h.value)}`);
    }
    for (const h of a.hours || []) if (!(b.hours || []).some((x) => x.label === h.label)) lines.push(`Row removed: ${h.label}`);
  }
  if (!deepEqual(a.qr || null, b.qr || null)) lines.push(b.qr ? (a.qr ? 'QR link changed' : 'QR link added') : 'QR link removed');
  if (a.type === 'gallery' || b.type === 'gallery') diffGallery(a, b, lines);
  else if (!deepEqual(a.images || [], b.images || [])) lines.push(`Gallery: now ${(b.images || []).length} photos`);
  if (a.sections || b.sections) diffMenu(a, b, lines);
  if (a.items || b.items) diffList(a, b, lines);
  diffStage2(a, b, lines);
  // Reordered if the pages present on both sides are no longer in the same
  // relative order, whatever was added or removed around them.
  const ka = (a.children || []).map((c) => c.id);
  const kb = (b.children || []).map((c) => c.id);
  const commonA = ka.filter((id) => kb.includes(id));
  const commonB = kb.filter((id) => ka.includes(id));
  if (commonA.join() !== commonB.join()) {
    lines.push(`Order is now: ${(b.children || []).map((c) => c.title || '(untitled)').join(', ')}`);
  }
  return lines;
}

/**
 * @param publishedBundle  the bundle on TVs now (may be null)
 * @param draft            the draft document (with hidden marks)
 * @param opts             hotel server only: {overridesBefore, overridesAfter, names} to list
 *                         what changed in the room-specific content (overrides.js)
 * @returns {entries: [...], summary: [string]}
 */
export function describeChanges(publishedBundle, draft, opts = {}) {
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
      const type = { hub: 'section', info: 'venue page', menu: 'menu page', gallery: 'photo gallery', list: 'cards page', contact: 'contact page', finished: 'finished page' }[page.type] || 'page';
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

  // Room-specific content: lines added to the page they belong to.
  const before = opts.overridesBefore || {}, after = 'overridesAfter' in opts ? opts.overridesAfter || {} : draft.overrides || {};
  if (Object.keys(before).length || Object.keys(after).length) {
    for (const { pageId, lines } of describeOverrideChanges(before, after, draft, opts.names)) {
      const at = cur.get(pageId);
      if (!at) continue;
      const e = entries.find((x) => x.id === pageId);
      const tagged = lines.map((l) => `For some rooms: ${l}`);
      if (e) e.lines.push(...tagged);
      else entries.push({ id: pageId, path: at.path.length ? at.path.join(' › ') : 'Home', kind: 'changed', lines: tagged });
    }
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
