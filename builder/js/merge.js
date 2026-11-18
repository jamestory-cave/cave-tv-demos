// Three-way merge: replays the changes this browser made (base -> draft) on
// top of a newer version (base -> theirs). Used when someone published while
// the draft was open (prototype), and when a colleague saved the shared
// draft at the same moment (Cave server).
//
//   base    the version both started from
//   theirs  the newer version (a publish, or a colleague's saved draft)
//   draft   this browser's draft (may carry `hidden` marks)
//   opts.who  whose version "theirs" is, for the messages: 'the newer publish' (default) or a name
//   opts.names  {typeName(id), roomLabel(number)} for messages about room-specific overrides
//
// The merge goes all the way down: two people changing different dishes of
// one menu, different photo frames or different cards both keep their
// changes. Only where both changed the very same thing (one dish's price, a
// page title) does "theirs" win, and the message says exactly what was kept
// and what was dropped, so nobody's work vanishes silently.
//
// Lists (menu parts, dishes, cards, photo frames, films, slides, hours,
// facts, gallery photos) have no ids in the TV's format, so their entries are
// matched by content: unchanged entries exactly, then by name (a dish's name,
// a part's or card's title, a frame's photo, an hours row's label), then by
// position.
//
// Returns { doc, conflicts: [string], applied: number }.

import { clone, canonical } from './util.js';
import { mergeOverrides } from './overrides.js';
import { reconcileFrames } from './gallery.js';

const FIELDS = ['title', 'kicker', 'subtitle', 'image', 'body', 'facts', 'hours', 'qr', 'sections', 'images', 'items', 'hidden', 'type',
  'description', 'photos', 'films', 'backgroundFilm', 'slides', 'hoursTitle', 'childrenTitle', 'gallery'];
const LABELS = { title: 'title', kicker: 'small caps line', subtitle: 'subtitle', image: 'photo', body: 'text', facts: 'facts', hours: 'hours', qr: 'QR link', sections: 'menu', images: 'photos', items: 'cards', hidden: 'hidden', type: 'page type',
  description: 'description', photos: 'photo frames', films: 'films', backgroundFilm: 'background film', slides: 'slides',
  // inside list entries
  name: 'name', price: 'price', tags: 'tags', note: 'note', meta: 'when or how far', caption: 'caption', fit: 'fit', film: 'film', poster: 'poster',
  seconds: 'length', label: 'label', value: 'times', url: 'address',
  hoursTitle: 'hours heading', childrenTitle: 'heading above the pages inside',
  // the better gallery
  gallery: 'gallery settings', group: 'chapter', sound: 'film sound', style: 'gallery style', autoplay: 'plays by itself' };
// What one entry of each list is called, when it has no name to show.
const ENTRY = { sections: 'part', items: 'entry', photos: 'photo frame', films: 'film', slides: 'slide', hours: 'hours row', facts: 'fact', images: 'gallery photo', tags: 'tag' };
const HOTEL = ['name', 'tagline', 'reception', 'roomService', 'wifiName', 'wifiPassword', 'checkout'];
const HOTEL_LABELS = { name: 'hotel name', tagline: 'tagline', reception: 'reception', roomService: 'room service', wifiName: 'Wi-Fi name', wifiPassword: 'Wi-Fi password', checkout: 'check-out' };

function index(home) {
  const map = new Map();
  const walk = (page, parent, path) => {
    map.set(page.id, { page, parentId: parent ? parent.id : null, path });
    for (const c of page.children || []) walk(c, page, [...path, c.title || '(untitled)']);
  };
  if (home) walk(home, null, []);
  return map;
}

const same = (a, b) => canonical(a === undefined ? null : a) === canonical(b === undefined ? null : b);
const label = (entry) => (entry.path.length ? entry.path.join(' › ') : 'Home');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** How a value reads in a message: "£14", nothing, hidden/shown, 3 entries. */
function show(v, key) {
  if (key === 'hidden') return v ? 'hidden' : 'shown';
  if (v === undefined || v === null || v === '') return 'nothing';
  if (typeof v === 'string') return `"${v.length > 60 ? v.slice(0, 57) + '…' : v}"`;
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string') && v.join(', ').length <= 60 ? `"${v.join(', ')}"` : `${v.length} ${v.length === 1 ? 'entry' : 'entries'}`;
  if (isObj(v)) return keyOf(v) ? `"${keyOf(v)}"` : 'their version';
  return String(v);
}

/** The name a list entry goes by, for matching and for messages. */
function keyOf(v) {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return null;
  for (const k of ['name', 'title', 'label', 'image', 'film']) if (typeof v[k] === 'string' && v[k]) return v[k];
  return null;
}

/**
 * base index -> other index (or -1): by id where entries carry one, then exact
 * matches, then by name, then by position. Position is only trusted when the
 * list kept its length on that side: once entries were added or removed, a
 * position says nothing about which dish is which, and an edit must never land
 * on a neighbouring dish (OBS-4). An entry left unmatched counts as removed, so
 * the person is told in plain words, naming the right dish.
 */
function align(base, other) {
  const map = base.map(() => -1);
  const used = new Set();
  const idOf = (v) => (isObj(v) && typeof v.id === 'string' && v.id ? v.id : null);
  base.forEach((b, i) => {
    const id = idOf(b);
    if (id === null) return;
    const j = other.findIndex((o, k) => !used.has(k) && idOf(o) === id);
    if (j >= 0) { map[i] = j; used.add(j); }
  });
  base.forEach((b, i) => {
    if (map[i] >= 0) return;
    const j = other.findIndex((o, k) => !used.has(k) && same(o, b));
    if (j >= 0) { map[i] = j; used.add(j); }
  });
  const count = (arr, key, skip) => arr.filter((x, k) => !skip(k) && keyOf(x) === key).length;
  base.forEach((b, i) => {
    if (map[i] >= 0) return;
    const key = keyOf(b);
    if (key === null || count(base, key, (k) => map[k] >= 0) !== 1 || count(other, key, (k) => used.has(k)) !== 1) return;
    const j = other.findIndex((o, k) => !used.has(k) && keyOf(o) === key);
    map[i] = j; used.add(j);
  });
  if (base.length !== other.length) return map;
  base.forEach((b, i) => {
    if (map[i] >= 0 || i >= other.length || used.has(i)) return;
    const o = other[i];
    if (typeof o === typeof b && Array.isArray(o) === Array.isArray(b) && !base.some((x, k) => k !== i && map[k] < 0 && keyOf(x) !== null && keyOf(x) === keyOf(o))) { map[i] = i; used.add(i); }
  });
  return map;
}

class Merger {
  constructor(who) {
    this.who = who;
    this.whose = `${who}'s`;
    this.conflicts = [];
    this.applied = 0;
  }

  clash(where, what, t, m) {
    this.conflicts.push(`${where}: kept ${this.whose} ${what} (${show(t, what)}) instead of yours (${show(m, what)})`);
  }

  /** Three-way merge of one value. `where` names the thing, `key` the field (for labels). */
  value(b, t, m, where, key, list) {
    if (same(m, b)) return clone(t);
    if (same(t, b) || same(t, m)) { this.applied++; return clone(m); }
    if (isObj(t) && isObj(m) && (b === undefined || isObj(b))) return this.object(b || {}, t, m, where);
    if (Array.isArray(t) && Array.isArray(m) && (b === undefined || Array.isArray(b))) return this.list(b || [], t, m, where, key);
    this.clash(where, LABELS[key] || (list ? 'version' : key), t, m);
    return clone(t);
  }

  object(b, t, m, where) {
    const out = {};
    const keys = [...new Set([...Object.keys(t), ...Object.keys(m), ...Object.keys(b)])];
    for (const k of keys) {
      const v = this.value(b[k], t[k], m[k], where, k);
      if (v !== undefined) out[k] = v;
    }
    // Keep theirs' key order, then any new keys.
    const ordered = {};
    for (const k of [...Object.keys(t), ...Object.keys(out)]) if (k in out && !(k in ordered)) ordered[k] = out[k];
    return ordered;
  }

  list(b, t, m, where, field) {
    const tb = align(b, t), mb = align(b, m);
    const name = (v, i) => keyOf(v) && typeof v !== 'string' ? keyOf(v) : `${ENTRY[field] || 'entry'} ${i + 1}`;
    // Entries in theirs' order; each knows the base entry it came from.
    const fromBase = new Map(tb.map((j, i) => [j, i]).filter(([j]) => j >= 0));
    let out = t.map((v, j) => ({ v: clone(v), bi: fromBase.has(j) ? fromBase.get(j) : -1, mi: -1, tj: j }));
    const byBase = new Map(out.filter((e) => e.bi >= 0).map((e) => [e.bi, e]));
    const drop = new Set();
    b.forEach((bv, i) => {
      const ti = tb[i], mi = mb[i];
      const entryWhere = `${where} › ${name(bv, i)}`;
      if (mi < 0) {                                             // removed here
        if (ti < 0) return;
        if (same(t[ti], bv)) { drop.add(byBase.get(i)); this.applied++; }
        else this.conflicts.push(`${entryWhere}: you removed it but ${this.who} changed it, so it was kept`);
        return;
      }
      if (ti < 0) {                                             // removed by theirs
        if (!same(m[mi], bv)) this.conflicts.push(`${entryWhere}: was removed by ${this.who}, so your changes to it were dropped`);
        return;
      }
      const e = byBase.get(i);
      e.mi = mi;
      e.v = typeof bv === 'string' ? this.value(bv, t[ti], m[mi], `${where} › ${ENTRY[field] || 'entry'} ${i + 1}`, 'text', true)
        : this.value(bv, t[ti], m[mi], entryWhere, field, true);
    });
    out = out.filter((e) => !drop.has(e));

    // Entries added here go after the entry they follow in this draft.
    const matchedM = new Set(mb.filter((j) => j >= 0));
    m.forEach((mv, mi) => {
      if (matchedM.has(mi)) return;
      let at = 0;
      for (let p = mi - 1; p >= 0; p--) {
        const k = out.findIndex((e) => e.mi === p);
        if (k >= 0) { at = k + 1; break; }
      }
      out.splice(at, 0, { v: clone(mv), bi: -1, mi, tj: -1 });
      this.applied++;
    });

    // Order: this draft's order of the shared entries, unless theirs reordered them too.
    const common = b.map((_, i) => i).filter((i) => tb[i] >= 0 && mb[i] >= 0 && out.some((e) => e.bi === i));
    const orderIn = (map) => [...common].sort((x, y) => map[x] - map[y]).join();
    const baseOrder = common.join();
    if (orderIn(mb) !== baseOrder) {
      if (orderIn(tb) !== baseOrder) this.conflicts.push(`${where}: kept ${this.whose} order of the ${LABELS[field] || 'entries'} instead of yours`);
      else {
        const slots = out.map((e, k) => (e.bi >= 0 && common.includes(e.bi) ? k : -1)).filter((k) => k >= 0);
        const sorted = slots.map((k) => out[k]).sort((x, y) => mb[x.bi] - mb[y.bi]);
        slots.forEach((k, n) => { out[k] = sorted[n]; });
        this.applied++;
      }
    }
    return out.map((e) => e.v);
  }
}

/**
 * A copy in which every gallery keeps its frames in `slides` (plain photos
 * too), so the three versions are merged frame by frame: one person's caption
 * and another's new photo both survive even when one side had only `images`.
 * reconcileFrames puts each gallery back to its published form afterwards.
 */
function withFrames(doc) {
  if (!doc?.home) return doc;
  const out = clone(doc);
  for (const { page } of index(out.home).values()) {
    if (page.type === 'gallery' && !(page.slides || []).length && (page.images || []).length) page.slides = page.images.map((image) => ({ image }));
  }
  return out;
}

export function threeWayMerge(base, theirs, draft, opts = {}) {
  base = withFrames(base); theirs = withFrames(theirs); draft = withFrames(draft);
  const who = opts.who || 'the newer publish';
  const merger = new Merger(who);
  const conflicts = merger.conflicts;
  const doc = clone(theirs);
  doc.hotel = doc.hotel || {};
  const B = index(base?.home), T = index(theirs?.home), D = index(draft?.home), M = index(doc.home);

  // Hotel fields.
  for (const k of HOTEL) {
    const b = base?.hotel?.[k] ?? '', t = theirs?.hotel?.[k] ?? '', d = draft?.hotel?.[k] ?? '';
    if (d === b) continue;
    if (t === b || t === d) { doc.hotel[k] = d; merger.applied++; }
    else conflicts.push(`Hotel details › ${HOTEL_LABELS[k]}: kept ${merger.whose} ${show(t)} instead of yours (${show(d)})`);
  }

  // Fields of pages that exist on both sides.
  for (const [id, dEntry] of D) {
    const bEntry = B.get(id), mEntry = M.get(id);
    if (!bEntry) continue;                              // new in the draft: handled below
    if (!mEntry) {                                      // deleted by theirs
      const changed = FIELDS.some((f) => !same(dEntry.page[f], bEntry.page[f]));
      if (changed) conflicts.push(`${label(dEntry)}: was removed by ${who}, so your changes to it were dropped`);
      continue;
    }
    for (const f of FIELDS) {
      const b = bEntry.page[f], t = mEntry.page[f], d = dEntry.page[f];
      if (same(d, b)) continue;
      const v = merger.value(b, t, d, label(dEntry), f);
      if (v === undefined) delete mEntry.page[f]; else mEntry.page[f] = v;
    }
  }

  const refreshM = () => { M.clear(); for (const [k, v] of index(doc.home)) M.set(k, v); };

  // Pages the draft moved to another parent ("Move to…"): move them in the
  // merged copy too, unless the newer publish moved them as well. Run once
  // before deletions, so a page moved out of a parent the draft then
  // deleted is not dropped along with it, and once after additions, for a
  // page moved into a page that is new in the draft.
  const done = new Set();
  const applyMoves = (last) => {
    refreshM();
    for (const [id, dEntry] of D) {
      const bEntry = B.get(id), tEntry = T.get(id), mEntry = M.get(id);
      if (done.has(id) || !bEntry || !mEntry || !dEntry.parentId || dEntry.parentId === bEntry.parentId) continue;
      if (tEntry && tEntry.parentId !== bEntry.parentId && tEntry.parentId !== dEntry.parentId) { done.add(id); conflicts.push(`${label(dEntry)}: kept where the newer publish put it instead of where you moved it`); continue; }
      const target = M.get(dEntry.parentId)?.page;
      const from = M.get(mEntry.parentId)?.page;
      if (!target && !last && !B.has(dEntry.parentId)) continue;   // moved into a new page: after additions
      done.add(id);
      if (!target || !from || target.type === 'finished' || index(mEntry.page).has(dEntry.parentId)) { conflicts.push(`${label(dEntry)}: could not be moved because the place you moved it to was changed by the newer publish`); continue; }
      if (from === target) continue;
      from.children = (from.children || []).filter((c) => c.id !== id);
      target.children = target.children || [];
      const dKids = D.get(dEntry.parentId)?.page.children || [];
      const at = Math.min(Math.max(dKids.findIndex((c) => c.id === id), 0), target.children.length);
      target.children.splice(at, 0, mEntry.page);
      merger.applied++;
      refreshM();
    }
  };
  applyMoves(false);

  refreshM();
  // Pages the draft deleted (in base, not in draft).
  for (const [id, bEntry] of B) {
    if (D.has(id) || !M.has(id)) continue;
    const tEntry = T.get(id);
    const theirsChanged = tEntry && FIELDS.some((f) => !same(tEntry.page[f], bEntry.page[f]));
    if (theirsChanged) { conflicts.push(`${label(tEntry)}: you deleted it but ${who} changed it, so it was kept`); continue; }
    const m = M.get(id);
    const parent = M.get(m.parentId)?.page;
    if (parent) { parent.children = (parent.children || []).filter((c) => c.id !== id); merger.applied++; }
  }

  // Pages the draft added (not in base): put them under the same parent.
  // Pages already published that the draft moved inside a new page are
  // taken out of the copy; the second move pass puts them there, so no
  // page is ever in the result twice.
  const withoutExisting = (page) => { if (page.children) page.children = page.children.filter((c) => !B.has(c.id)).map(withoutExisting); return page; };
  refreshM();
  for (const [id, dEntry] of D) {
    if (B.has(id) || M.has(id)) continue;
    const parent = M.get(dEntry.parentId)?.page;
    if (!parent) { conflicts.push(`${label(dEntry)}: could not be added because its section was removed by ${who}`); continue; }
    const dParent = D.get(dEntry.parentId).page;
    const at = Math.min((dParent.children || []).findIndex((c) => c.id === id), (parent.children || []).length);
    parent.children = parent.children || [];
    parent.children.splice(at < 0 ? parent.children.length : at, 0, withoutExisting(clone(dEntry.page)));
    merger.applied++;
    refreshM();
  }
  applyMoves(true);

  // Reorders: apply the draft's order to the children that still exist,
  // unless theirs also reordered them.
  for (const [id, dEntry] of D) {
    const bEntry = B.get(id), mEntry = M.get(id), tEntry = T.get(id);
    if (!bEntry || !mEntry || !tEntry) continue;
    const order = (p) => (p.children || []).map((c) => c.id);
    const b = order(bEntry.page), d = order(dEntry.page), t = order(tEntry.page), m = order(mEntry.page);
    const common = (x, y) => x.filter((i) => y.includes(i));
    if (common(d, b).join() === common(b, d).join()) continue;           // draft did not reorder
    if (common(t, b).join() !== common(b, t).join()) { conflicts.push(`${label(dEntry)}: kept ${merger.whose} order of pages instead of yours`); continue; }
    const rank = new Map(d.map((x, i) => [x, i]));
    const kids = mEntry.page.children || [];
    const known = kids.filter((c) => rank.has(c.id)).sort((a, c) => rank.get(a.id) - rank.get(c.id));
    const unknown = kids.filter((c) => !rank.has(c.id));
    mEntry.page.children = [...known, ...unknown];
    if (m.join() !== mEntry.page.children.map((c) => c.id).join()) merger.applied++;
  }

  // Gallery frames: `images` (which frames, in order) and `slides` (what each
  // carries) merged on their own; put them back together, chapters together.
  for (const { page } of index(doc.home).values()) if (page.type === 'gallery' && (page.slides || []).length) reconcileFrames(page);

  // Room-specific overrides (hotel server): room by room, field by field.
  if (base?.overrides || theirs?.overrides || draft?.overrides) {
    const labelOf = (id) => { const e = D.get(id) || T.get(id) || B.get(id); return e ? label(e) : 'A page no longer in the draft'; };
    const pageOf = (id) => (M.get(id) || D.get(id) || T.get(id))?.page || null;
    const r = mergeOverrides(base?.overrides, theirs?.overrides, draft?.overrides, { who, labelOf, pageOf, names: opts.names || {} });
    if (Object.keys(r.overrides).length) doc.overrides = r.overrides; else delete doc.overrides;
    conflicts.push(...r.conflicts);
    merger.applied += r.applied;
  }

  return { doc, conflicts, applied: merger.applied };
}
