// Three-way merge: replays the changes this browser made (base -> draft) on
// top of a newer publish (base -> theirs). Where both sides changed the same
// thing differently, the newer publish wins and the loss is listed, so a
// colleague's publish is never undone silently.
//
//   base    the bundle the draft started from (published at basedOn.revision)
//   theirs  the bundle published since
//   draft   this browser's draft (may carry `hidden` marks)
//
// Returns { doc, conflicts: [string], applied: number }.

import { clone, canonical } from './util.js';

const FIELDS = ['title', 'kicker', 'subtitle', 'image', 'body', 'facts', 'hours', 'qr', 'sections', 'images', 'items', 'hidden', 'type',
  'description', 'photos', 'films', 'backgroundFilm', 'slides', 'hoursTitle', 'childrenTitle'];
const LABELS = { title: 'title', kicker: 'small caps line', subtitle: 'subtitle', image: 'photo', body: 'text', facts: 'facts', hours: 'hours', qr: 'QR link', sections: 'menu', images: 'photos', items: 'cards', hidden: 'hidden', type: 'page type',
  description: 'description', photos: 'photo frames', films: 'films', backgroundFilm: 'background film', slides: 'slides',
  hoursTitle: 'hours heading', childrenTitle: 'heading above the pages inside' };
const HOTEL = ['name', 'tagline', 'reception', 'roomService', 'wifiName', 'wifiPassword', 'checkout'];

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

export function threeWayMerge(base, theirs, draft) {
  const doc = clone(theirs);
  doc.hotel = doc.hotel || {};
  const conflicts = [];
  let applied = 0;
  const B = index(base?.home), T = index(theirs?.home), D = index(draft?.home), M = index(doc.home);

  // Hotel fields.
  for (const k of HOTEL) {
    const b = base?.hotel?.[k] ?? '', t = theirs?.hotel?.[k] ?? '', d = draft?.hotel?.[k] ?? '';
    if (d === b) continue;
    if (t === b || t === d) { doc.hotel[k] = d; applied++; }
    else conflicts.push(`Hotel details, ${k}: kept the newer publish ("${t}") instead of yours ("${d}")`);
  }

  // Fields of pages that exist on both sides.
  for (const [id, dEntry] of D) {
    const bEntry = B.get(id), mEntry = M.get(id);
    if (!bEntry) continue;                              // new in the draft: handled below
    if (!mEntry) {                                      // deleted by the newer publish
      const changed = FIELDS.some((f) => !same(dEntry.page[f], bEntry.page[f]));
      if (changed) conflicts.push(`${label(dEntry)}: was removed by the newer publish, so your changes to it were dropped`);
      continue;
    }
    for (const f of FIELDS) {
      const b = bEntry.page[f], t = mEntry.page[f], d = dEntry.page[f];
      if (same(d, b)) continue;
      if (same(t, b) || same(t, d)) {
        if (d === undefined) delete mEntry.page[f]; else mEntry.page[f] = clone(d);
        applied++;
      } else conflicts.push(`${label(dEntry)}: kept the newer publish's ${LABELS[f]} instead of yours`);
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
      applied++;
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
    if (theirsChanged) { conflicts.push(`${label(tEntry)}: you deleted it but the newer publish changed it, so it was kept`); continue; }
    const m = M.get(id);
    const parent = M.get(m.parentId)?.page;
    if (parent) { parent.children = (parent.children || []).filter((c) => c.id !== id); applied++; }
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
    if (!parent) { conflicts.push(`${label(dEntry)}: could not be added because its section was removed by the newer publish`); continue; }
    const dParent = D.get(dEntry.parentId).page;
    const at = Math.min((dParent.children || []).findIndex((c) => c.id === id), (parent.children || []).length);
    parent.children = parent.children || [];
    parent.children.splice(at < 0 ? parent.children.length : at, 0, withoutExisting(clone(dEntry.page)));
    applied++;
    refreshM();
  }
  applyMoves(true);

  // Reorders: apply the draft's order to the children that still exist,
  // unless the newer publish also reordered them.
  for (const [id, dEntry] of D) {
    const bEntry = B.get(id), mEntry = M.get(id), tEntry = T.get(id);
    if (!bEntry || !mEntry || !tEntry) continue;
    const order = (p) => (p.children || []).map((c) => c.id);
    const b = order(bEntry.page), d = order(dEntry.page), t = order(tEntry.page), m = order(mEntry.page);
    const common = (x, y) => x.filter((i) => y.includes(i));
    if (common(d, b).join() === common(b, d).join()) continue;           // draft did not reorder
    if (common(t, b).join() !== common(b, t).join()) { conflicts.push(`${label(dEntry)}: kept the newer publish's order of pages instead of yours`); continue; }
    const rank = new Map(d.map((x, i) => [x, i]));
    const kids = mEntry.page.children || [];
    const known = kids.filter((c) => rank.has(c.id)).sort((a, c) => rank.get(a.id) - rank.get(c.id));
    const unknown = kids.filter((c) => !rank.has(c.id));
    mEntry.page.children = [...known, ...unknown];
    if (m.join() !== mEntry.page.children.map((c) => c.id).join()) applied++;
  }

  return { doc, conflicts, applied };
}
