// The editor's model: one draft document in today's ContentBundle shape, plus
// two Builder-only marks that never reach the TV: `hidden` on a page or a
// dish, and nothing else. bundle.js strips them when it builds the bundle.
//
// Every change goes through `commit`, which keeps an undo stack and tells the
// screens. Screens never mutate the draft directly.

import { clone, slug, randomId } from './util.js';

export const PAGE_TYPES = {
  hub:     { label: 'Section',       hint: 'Holds pages. Opens as strips, like Eat & Drink.' },
  info:    { label: 'Venue page',    hint: 'Words, facts, opening hours and a QR link. The Firepit, Golf.' },
  menu:    { label: 'Menu page',     hint: 'Dishes with prices, in parts. Breakfast, Room Service.' },
  gallery: { label: 'Photo gallery', hint: 'A set of photos to look through. The Penthouse.' },
  list:    { label: 'Cards',         hint: 'A list of cards with a photo each. Explore Kent, What\'s On.' },
  contact: { label: 'Contact page',  hint: 'Reception, room service, Wi-Fi and check-out from Hotel details.' },
  finished: { label: 'Finished page', hint: 'Artwork or film from the visual team, shown full screen exactly as made. Fire plan, a poster.' },
};

export { ALLOWS } from './bundle.js';

const listeners = new Set();

export const model = {
  published: null,   // { version, bundle, history, mediaIndex }
  draft: null,       // { version, hotel, home }
  basedOn: null,     // { revision, bundle }
  savedAt: null,
  undoStack: [],
  lastCoalesce: null,

  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit(ev) { for (const fn of listeners) fn(ev); },

  /** Starts from a saved draft, or from the published bundle. */
  load(published, savedDraft) {
    this.published = published;
    const rev = published?.version?.revision ?? 0;
    if (savedDraft?.doc) {
      this.draft = savedDraft.doc;
      this.basedOn = savedDraft.basedOn || { revision: rev };
      this.savedAt = savedDraft.savedAt || null;
    } else if (published?.bundle) {
      this.draft = clone(published.bundle);
      this.basedOn = { revision: rev, bundle: published.version?.bundle };
      this.savedAt = null;
    } else {
      this.draft = { version: 1, hotel: emptyHotel(), home: { id: 'home', type: 'home', title: 'Home', children: [] } };
      this.basedOn = { revision: 0 };
    }
    this.undoStack = [];
    this.emit({ type: 'load' });
  },

  /** Throws away the draft and starts again from what is published. */
  reset() {
    this.draft = clone(this.published?.bundle) || this.draft;
    this.basedOn = { revision: this.published?.version?.revision ?? 0, bundle: this.published?.version?.bundle };
    this.undoStack = [];
    this.emit({ type: 'change', label: 'Reset my changes', origin: 'reset' });
  },

  /**
   * Applies a change. `mutate(draft)` edits in place. Options:
   *   origin    which screen made the change (so it can skip its own re-render)
   *   coalesce  a key; repeated commits with the same key share one undo step
   *   undoable  false for changes that should not be undone (default true)
   */
  commit(label, mutate, opts = {}) {
    const coalesce = opts.coalesce || null;
    if (opts.undoable !== false && !(coalesce && coalesce === this.lastCoalesce)) {
      this.undoStack.push({ label, snapshot: clone(this.draft) });
      if (this.undoStack.length > 60) this.undoStack.shift();
    }
    this.lastCoalesce = coalesce;
    mutate(this.draft);
    this.emit({ type: 'change', label, origin: opts.origin || null, pageId: opts.pageId || null });
  },

  get canUndo() { return this.undoStack.length > 0; },
  get undoLabel() { return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : ''; },

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.draft = entry.snapshot;
    this.lastCoalesce = null;
    this.emit({ type: 'change', label: 'Undo ' + entry.label, origin: 'undo' });
    return entry.label;
  },

  // ---- lookups (read only) ------------------------------------------------

  /** Every page in the draft, depth first, with its parent and title path. */
  pages(doc = this.draft) {
    const out = [];
    const walk = (page, parent, path, depth) => {
      const entry = { page, parent, path, depth, index: parent ? parent.children.indexOf(page) : 0 };
      out.push(entry);
      for (const c of page.children || []) walk(c, page, [...path, c.title || '(untitled)'], depth + 1);
    };
    if (doc?.home) walk(doc.home, null, [], 0);
    return out;
  },

  find(id, doc = this.draft) {
    return this.pages(doc).find((e) => e.page.id === id) || null;
  },

  /** 'Eat & Drink › The Firepit' for a page id. */
  pathLabel(id, doc = this.draft) {
    const e = this.find(id, doc);
    if (!e) return '';
    if (!e.path.length) return 'Home';
    return e.path.join(' › ');
  },

  /** The section (child of home) a page belongs to, or null for home. */
  sectionOf(id, doc = this.draft) {
    const e = this.find(id, doc);
    if (!e || !e.path.length) return null;
    const first = e.path[0];
    return (doc.home.children || []).find((s) => s.title === first && (s.id === id || this.find(id, { home: s }))) || null;
  },

  menuPages(doc = this.draft) {
    return this.pages(doc).filter((e) => e.page.type === 'menu');
  },

  newId(title) {
    const ids = new Set(this.pages().map((e) => e.page.id));
    let id;
    do { id = `${slug(title)}-${randomId()}`; } while (ids.has(id));
    return id;
  },

  /** Where each image or film is used: media path or asset name -> [{pageId, use}]. */
  imageUses(doc = this.draft) {
    const uses = new Map();
    const add = (src, pageId, use) => {
      if (!src) return;
      if (!uses.has(src)) uses.set(src, []);
      uses.get(src).push({ pageId, use });
    };
    for (const { page } of this.pages(doc)) {
      add(page.image, page.id, page.id === 'home' ? 'Home background' : 'Strip and background');
      for (const src of page.images || []) add(src, page.id, 'Gallery photo');
      for (const item of page.items || []) add(item.image, page.id, `Card: ${item.title}`);
      (page.photos || []).forEach((ph, i) => add(ph.image, page.id, `Photo frame ${i + 1}`));
      (page.films || []).forEach((f) => { add(f.film, page.id, `Film: ${f.title || 'untitled'}`); add(f.poster, page.id, `Poster for film: ${f.title || 'untitled'}`); });
      if (page.backgroundFilm) { add(page.backgroundFilm.film, page.id, 'Background film'); add(page.backgroundFilm.poster, page.id, 'Background film poster'); }
      (page.slides || []).forEach((sl, i) => { add(sl.image, page.id, `Slide ${i + 1}`); add(sl.film, page.id, `Slide ${i + 1} (film)`); add(sl.poster, page.id, `Slide ${i + 1} poster`); });
    }
    return uses;
  },
};

export function emptyHotel() {
  return { name: '', tagline: '', reception: '', roomService: '', wifiName: '', wifiPassword: '', checkout: '' };
}

/** A fresh page of `type` with example text a member of staff will replace. */
export function newPage(type, title, id) {
  const page = { id, type, title };
  switch (type) {
    case 'hub':
      page.kicker = 'New section';
      page.subtitle = 'One line about this section';
      page.children = [];
      break;
    case 'info':
      page.kicker = 'A short line above the title';
      page.subtitle = 'One line that sums it up';
      page.body = 'Two or three sentences. Short, confident, slightly theatrical.';
      page.facts = ['One thing worth knowing', 'Another'];
      page.hours = [{ label: 'Open', value: '9:00am – 5:00pm' }];
      break;
    case 'menu':
      page.kicker = 'Sample menu';
      page.body = 'One line about the menu.';
      page.sections = [{ title: 'Starters', items: [{ name: 'A dish', description: 'What is in it', price: '£10' }] }];
      break;
    case 'gallery':
      page.kicker = 'Photos';
      page.images = [];
      break;
    case 'list':
      page.kicker = 'Cards';
      page.subtitle = 'One line about this list';
      page.items = [{ title: 'First card', meta: 'When or how far', subtitle: 'One line', body: 'A sentence or two.' }];
      break;
    case 'contact':
      page.kicker = "We're here";
      page.subtitle = 'Reception is staffed 24 hours';
      page.facts = ['Something useful to know'];
      break;
    case 'finished':
      page.description = '';
      page.slides = [];
      break;
  }
  return page;
}

// ---- operations -------------------------------------------------------------
// Each returns nothing; call inside model.commit(label, draft => op(draft, ...)).

export function findIn(doc, id) {
  let hit = null;
  const walk = (page, parent) => {
    if (hit) return;
    if (page.id === id) { hit = { page, parent }; return; }
    for (const c of page.children || []) walk(c, page);
  };
  walk(doc.home, null);
  return hit;
}

export function setField(doc, id, key, value) {
  const hit = findIn(doc, id);
  if (!hit) return;
  if (value === '' || value === null || value === undefined) delete hit.page[key];
  else hit.page[key] = value;
}

export function movePage(doc, parentId, from, to) {
  const hit = findIn(doc, parentId);
  const kids = hit?.page.children;
  if (!kids || from === to || from < 0 || from >= kids.length) return;
  const [p] = kids.splice(from, 1);
  kids.splice(Math.max(0, Math.min(to, kids.length)), 0, p);
}

export function addPage(doc, parentId, page, at) {
  const hit = findIn(doc, parentId);
  if (!hit) return;
  hit.page.children = hit.page.children || [];
  const kids = hit.page.children;
  kids.splice(at === undefined ? kids.length : at, 0, page);
}

/** Removes a page; returns what is needed to put it back. */
export function removePage(doc, id) {
  const hit = findIn(doc, id);
  if (!hit || !hit.parent) return null;
  const kids = hit.parent.children;
  const index = kids.indexOf(hit.page);
  kids.splice(index, 1);
  return { parentId: hit.parent.id, index, page: hit.page };
}

export function moveInList(arr, from, to) {
  if (!arr || from === to || from < 0 || from >= arr.length) return;
  const [v] = arr.splice(from, 1);
  arr.splice(Math.max(0, Math.min(to, arr.length)), 0, v);
}
