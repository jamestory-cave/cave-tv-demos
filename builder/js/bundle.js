// Draft document -> ContentBundle JSON exactly as Content.swift decodes it.
// Keys come out in the order Content.swift declares them, empty values are
// left out, hidden pages and dishes are dropped, held-back pages are dropped.
// Stage-2 fields (PROTOTYPE.md: description, photos, films, backgroundFilm,
// slides) are emitted only when set, so a stage-1 bundle is byte-for-byte
// what it was.
// Rhys's requests (docs/builder/2026-11-rhys-requests.md), same rules:
// hoursTitle, childrenTitle, ListItem.qr, and slides on gallery pages (with
// `images` kept filled with the frames' stills so an older app still shows
// a photo gallery).
// The better gallery (phase B, GALLERY-CONTRACT.md), same rules: on gallery
// pages `gallery` {style, seconds, autoplay} (left out when it is the
// default), `body` (the intro), `qr`, and on each slide caption, group, fit
// ('whole' only) and sound (true only, film frames only). See gallery.js.

import { framesOf, frameNeedsSlide, frameStill as still, galleryOptions, isDefaultOptions, cleanChapter, chapterKey } from './gallery.js';

const PAGE_KEYS = ['id', 'type', 'title', 'subtitle', 'kicker', 'image', 'body', 'facts', 'hoursTitle', 'hours', 'qr', 'childrenTitle', 'children', 'sections', 'images', 'items',
  'description', 'photos', 'films', 'backgroundFilm', 'slides', 'gallery'];
const HOTEL_KEYS = ['name', 'tagline', 'reception', 'roomService', 'wifiName', 'wifiPassword', 'checkout'];

/** Which page types may carry each stage-2 field (PROTOTYPE.md 2a–2c). Anything else is left out of the bundle. */
export const ALLOWS = {
  photos: ['info', 'hub', 'list', 'contact'],
  films: ['info', 'hub', 'list', 'contact', 'menu'],
  backgroundFilm: ['info', 'hub', 'list', 'contact', 'menu'],
  slides: ['finished', 'gallery'],
  description: ['finished'],
  hoursTitle: ['info', 'menu'],
  childrenTitle: ['info', 'hub', 'menu', 'gallery', 'list', 'contact'],
  gallery: ['gallery'],
};
const allows = (key, type) => ALLOWS[key].includes(type);

const present = (v) => !(v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0));
const str = (v) => (present(v) ? String(v) : undefined);
/** A heading: left out when empty or only spaces. */
const heading = (v) => (present(v) && String(v).trim() ? String(v) : undefined);

function cleanHours(rows) {
  return (rows || []).filter((h) => present(h.label) || present(h.value)).map((h) => ({ label: h.label || '', value: h.value || '' }));
}

function cleanQR(qr) {
  if (!qr || (!present(qr.label) && !present(qr.url))) return undefined;
  return { label: qr.label || '', url: qr.url || '' };
}

function cleanSections(sections) {
  return (sections || []).map((s) => {
    const out = { title: s.title || '' };
    if (present(s.note)) out.note = s.note;
    out.items = (s.items || []).filter((d) => !d.hidden).map((d) => {
      const item = { name: d.name || '' };
      if (present(d.description)) item.description = d.description;
      if (present(d.price)) item.price = d.price;
      if (present(d.tags)) item.tags = [...d.tags];
      return item;
    });
    return out;
  });
}

function cleanItems(items) {
  return (items || []).map((it) => {
    const out = { title: it.title || '' };
    if (present(it.subtitle)) out.subtitle = it.subtitle;
    if (present(it.body)) out.body = it.body;
    if (present(it.image)) out.image = it.image;
    if (present(it.meta)) out.meta = it.meta;
    const qr = cleanQR(it.qr);
    if (qr) out.qr = qr;
    return out;
  });
}

function cleanPhotos(photos) {
  return (photos || []).filter((p) => present(p.image)).map((p) => {
    const out = { image: p.image, fit: p.fit === 'whole' ? 'whole' : 'fill' };
    if (present(p.caption)) out.caption = p.caption;
    return out;
  });
}

function cleanFilms(films) {
  return (films || []).filter((f) => present(f.film)).map((f) => {
    const out = { film: f.film };
    if (present(f.poster)) out.poster = f.poster;
    if (present(f.title)) out.title = f.title;
    if (Number.isFinite(f.seconds) && f.seconds > 0) out.seconds = Math.round(f.seconds);
    return out;
  });
}

function cleanBackgroundFilm(bg) {
  if (!bg || !present(bg.film)) return undefined;
  const out = { film: bg.film };
  if (present(bg.poster)) out.poster = bg.poster;
  return out;
}

// Slides reference the file the editor chose: media/<hash>-3840.jpg when the
// upload was 4K (PROTOTYPE.md 2b), else -1920.jpg. The path is kept as is.
// Finished pages ignore the gallery's slide fields, so they are never written there.
function cleanSlides(slides, gallery = false) {
  return (slides || []).map((s) => {
    let out;
    if (present(s.film)) { out = { film: s.film }; if (present(s.poster)) out.poster = s.poster; }
    else if (present(s.image)) out = { image: s.image };
    else return null;
    if (!gallery) return out;
    if (present(s.caption) && String(s.caption).trim()) out.caption = String(s.caption).trim();
    if (present(s.group) && cleanChapter(s.group)) out.group = cleanChapter(s.group);
    if (s.fit === 'whole') out.fit = 'whole';
    if (out.film && s.sound === true) out.sound = true;
    return out;
  }).filter(Boolean);
}

/** The heading over a page's child tiles, where the page type draws one. */
const childrenHeading = (page) => (allows('childrenTitle', page.type) ? heading(page.childrenTitle) : undefined);

/** What a gallery frame shows before anything plays: the photo, or a film's poster. */
export const frameStill = still;

/** One page in bundle shape, or null if it must be left out. */
export function cleanPage(page, held = null) {
  if (page.hidden) return null;
  if (held && held.get(page.id)?.held) return null;
  const raw = {
    id: page.id,
    type: page.type,
    title: page.title || '',
    subtitle: str(page.subtitle),
    kicker: str(page.kicker),
    image: str(page.image),
    body: str(page.body),
    facts: (page.facts || []).filter(present).length ? (page.facts || []).filter(present) : undefined,
    hours: cleanHours(page.hours),
    qr: cleanQR(page.qr),
    children: (page.children || []).map((c) => cleanPage(c, held)).filter(Boolean),
    sections: page.type === 'menu' || present(page.sections) ? cleanSections(page.sections) : undefined,
    images: (page.images || []).filter(present),
    items: page.type === 'list' || present(page.items) ? cleanItems(page.items) : undefined,
    description: allows('description', page.type) ? str(page.description) : undefined,
    photos: allows('photos', page.type) ? cleanPhotos(page.photos) : undefined,
    films: allows('films', page.type) ? cleanFilms(page.films) : undefined,
    backgroundFilm: allows('backgroundFilm', page.type) ? cleanBackgroundFilm(page.backgroundFilm) : undefined,
    slides: allows('slides', page.type) ? cleanSlides(page.type === 'gallery' ? framesOf(page) : page.slides, page.type === 'gallery') : undefined,
    gallery: allows('gallery', page.type) && !isDefaultOptions(galleryOptions(page)) ? galleryOptions(page) : undefined,
  };
  const hours = raw.hours;
  // A heading with nothing under it is left out.
  raw.hoursTitle = allows('hoursTitle', page.type) && hours.length ? heading(page.hoursTitle) : undefined;
  raw.childrenTitle = raw.children.length ? childrenHeading(page) : undefined;
  // A gallery with frames: `images` always carries their stills, so an app
  // that does not know `slides` still shows every frame as a photo. Frames
  // that are all photos are published as plain `images`, as before.
  // A frame with a caption, chapter, show whole or sound needs `slides` too.
  if (page.type === 'gallery' && raw.slides && raw.slides.length) {
    // One spelling per chapter (the first used), as the TV compares chapter names exactly.
    const spelt = new Map();
    for (const sl of raw.slides) if (sl.group) { const k = chapterKey(sl.group); if (!spelt.has(k)) spelt.set(k, sl.group); sl.group = spelt.get(k); }
    if (raw.slides.some(frameNeedsSlide)) raw.images = raw.slides.map(frameStill).filter(Boolean);
    else { raw.images = raw.slides.map((s) => s.image); raw.slides = undefined; }
  }
  const out = {};
  for (const k of PAGE_KEYS) if (present(raw[k])) out[k] = raw[k];
  return out;
}

function indexById(home) {
  const map = new Map();
  const walk = (page) => { map.set(page.id, page); for (const c of page.children || []) walk(c); };
  if (home) walk(home);
  return map;
}

/** Ids of a page and everything under it. */
export function subtreeIds(page) {
  const ids = [];
  const walk = (p) => { ids.push(p.id); for (const c of p.children || []) walk(c); };
  walk(page);
  return ids;
}

/**
 * Builds the bundle.
 *   held       Map from validateAll: a page with blockers is "held back"
 *   published  the bundle on TVs now (its pages are the live copies)
 * A held page that is already on TVs keeps its published copy, children and
 * all: the draft for it does not go live, but nothing is taken off the TV.
 * Only a new page with blockers is left out. Returns
 *   { bundle, heldBack: [{id, blockers, kept}], frozen: Set of ids whose draft is not going live }
 */
export function buildBundle(doc, { revision, held, published } = {}) {
  const hotel = {};
  for (const k of HOTEL_KEYS) hotel[k] = doc.hotel?.[k] ?? '';
  const live = indexById(published?.home);
  const frozen = new Set();
  const heldBack = [];

  const build = (page) => {
    if (page.hidden) return null;
    const r = held?.get(page.id);
    if (r?.held && page.id !== 'home') {
      const kept = live.get(page.id);
      for (const id of subtreeIds(page)) frozen.add(id);
      heldBack.push({ id: page.id, blockers: r.blockers, kept: !!kept });
      // The published copy is already in bundle shape; deep-copied so the
      // published bundle in memory is never touched.
      return kept ? JSON.parse(JSON.stringify(kept)) : null;
    }
    const flat = cleanPage({ ...page, children: [] }) || { id: page.id, type: page.type, title: page.title || '' };
    const kids = (page.children || []).map(build).filter(Boolean);
    if (kids.length) {
      flat.children = kids;
      const t = childrenHeading(page);   // no tiles, no heading over them
      if (t) flat.childrenTitle = t;
    }
    const out = {};
    for (const k of PAGE_KEYS) if (k in flat) out[k] = flat[k];
    return out;
  };
  const home = build({ ...doc.home, hidden: false });
  const bundle = { version: revision ?? doc.version ?? 1, hotel, home };
  return { bundle, heldBack, frozen };
}

/** Every media/ path a bundle refers to (photos and films), deduplicated. */
export function mediaPathsIn(bundle) {
  return [...new Set(JSON.stringify(bundle).match(/media\/[0-9a-f]{12}-\d+\.(?:jpg|mp4)/g) || [])];
}

/** Pretty JSON, 2-space, trailing newline, as seed.py writes it. */
export function bundleText(bundle) {
  return JSON.stringify(bundle, null, 2) + '\n';
}
