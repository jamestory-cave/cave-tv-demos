// Guard rails (UX spec section 6). The Builder warns, the TV copes.
// A blocker holds that page back from the bundle; a warning does not.

import { ALLOWS } from './bundle.js';

export const LIMITS = {
  title: 28, kicker: 30, subtitle: 60, body: 500, fact: 70, factsMax: 6,
  hoursLabel: 20, hoursValue: 40, qrLabel: 50,
  dishName: 40, dishDescription: 120, dishPrice: 12, sectionTitle: 40, sectionNote: 60,
  cardTitle: 40, cardSubtitle: 60, cardBody: 160, cardMeta: 20,
  hotelField: 40, tagline: 60,
  sectionsMax: 8, itemsMax: 8, galleryMax: 12,
  // Stage 2: photo frames, films, finished pages.
  caption: 60, photosMax: 6, filmTitle: 40, filmsMax: 4, description: 160, slidesMax: 10,
  backgroundFilmBytes: 15 * 1024 * 1024,   // a warning; 60 MB stays the hard limit for every film
  // A full-screen photo needs 1920 on its long edge and 1080 on its short
  // edge (portrait photos are fine: the TV crops them). Cards need 800.
  imageMinLong: 1920, imageMinShort: 1080, cardImageMinLong: 800,
};

/** Why a photo is too small for its use, or null if it is fine or unknown. */
export function photoProblem(size, use = 'full') {
  if (!size) return null;
  const long = Math.max(size.width, size.height), short = Math.min(size.width, size.height);
  if (use === 'card') return long < LIMITS.cardImageMinLong ? `${size.width} × ${size.height}, needs ${LIMITS.cardImageMinLong} px on its long side` : null;
  if (long < LIMITS.imageMinLong || short < LIMITS.imageMinShort) return `${size.width} × ${size.height}, needs ${LIMITS.imageMinLong} × ${LIMITS.imageMinShort} or larger`;
  return null;
}

/** True for a QR web address the TV can draw and a phone can open. */
export function validQR(url) {
  if (!url) return false;
  if (/^WIFI:/i.test(url)) return true;
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.');
  } catch { return false; }
}

/** Why a photo will not do for a frame with the given fit, or null. */
export function frameProblem(size, fit) {
  if (!size) return null;
  const long = Math.max(size.width, size.height);
  if (fit === 'whole') return long < LIMITS.cardImageMinLong ? `${size.width} × ${size.height}, needs ${LIMITS.cardImageMinLong} px on its long side` : null;
  return photoProblem(size, 'full');
}

/** Why a finished-page slide will not do, or null (exactly 16:9 within 1%, 1920 x 1080 or larger). */
export function slideSizeProblem(size) {
  if (!size) return null;
  if (size.width < 1920 || size.height < 1080) return `${size.width} × ${size.height}, needs 1920 × 1080 or larger`;
  if (Math.abs(size.width / size.height - 16 / 9) / (16 / 9) > 0.01) return `${size.width} × ${size.height} is not 16:9`;
  return null;
}

const over = (s, limit) => (s || '').length > limit;
const near = (s, limit) => !over(s, limit) && (s || '').length >= Math.ceil(limit * 0.9) && (s || '').length > 0;

/**
 * Checks one page. `ctx.imageSize(src)` gives a photo's {width, height} or
 * null if unknown (an unknown photo counts as fine).
 * `ctx.isStrip` is true for pages shown as a strip (children of home or of
 * a section), which need a photo.
 */
export function validatePage(page, ctx = {}) {
  const blockers = [];
  const warnings = [];
  const block = (field, message) => blockers.push({ field, message });
  const warn = (field, message) => warnings.push({ field, message });
  const text = (field, value, limit, label) => {
    if (over(value, limit)) block(field, `${label} is over its limit (${value.length} of ${limit} characters)`);
    else if (near(value, limit)) warn(field, `${label} is close to its limit (${value.length} of ${limit})`);
  };
  const imageSize = ctx.imageSize || (() => null);
  const imageKnown = ctx.imageKnown || (() => true);
  const filmInfo = ctx.filmInfo || (() => null);   // (src) -> {audio, silent, height, seconds, name} or null when unknown
  const photo = (field, src, use, what) => {
    if (!imageKnown(src)) { block(field, `${what}: photo missing. It is not in Media any more; choose another`); return; }
    const why = photoProblem(imageSize(src), use);
    if (why) block(field, `${what} is too small for ${use === 'card' ? 'a card' : 'full screen'} (${why})`);
  };

  if (!page.title || !page.title.trim()) block('title', 'No title');
  text('title', page.title, LIMITS.title, 'Title');
  // Stage-2 fields on a page type that cannot show them (hand-edited drafts): left out of the bundle, said here.
  const LABEL = { photos: 'photo frames', films: 'films', backgroundFilm: 'a background film', slides: 'slides', description: 'a description' };
  for (const key of Object.keys(ALLOWS)) {
    const has = Array.isArray(page[key]) ? page[key].length > 0 : !!page[key];
    if (has && !ALLOWS[key].includes(page.type)) warn(key, `This page carries ${LABEL[key]}, which a ${page.type} page cannot show; they are left out when publishing`);
  }
  if (page.type === 'finished') return validateFinished(page, { block, warn, text, photo, imageKnown, imageSize, filmInfo, ctx, blockers, warnings });
  text('kicker', page.kicker, LIMITS.kicker, 'Small caps line');
  text('subtitle', page.subtitle, LIMITS.subtitle, 'Subtitle');
  text('body', page.body, LIMITS.body, 'Text');

  if (ctx.isStrip && page.type !== 'home' && !page.image) block('image', 'This strip has no photo');
  else if (!ctx.isStrip && page.type !== 'home' && !page.image) warn('image', 'No photo: the tile will be plain');
  if (page.image) photo('image', page.image, 'full', 'Photo');

  (page.facts || []).forEach((f, i) => text(`facts.${i}`, f, LIMITS.fact, `Fact ${i + 1}`));
  if ((page.facts || []).length > LIMITS.factsMax) warn('facts', `More than ${LIMITS.factsMax} facts; the page gets long`);

  (page.hours || []).forEach((h, i) => {
    text(`hours.${i}.label`, h.label, LIMITS.hoursLabel, `Hours row ${i + 1} label`);
    text(`hours.${i}.value`, h.value, LIMITS.hoursValue, `Hours row ${i + 1}`);
    if (!h.label && !h.value) warn(`hours.${i}.label`, `Hours row ${i + 1} is empty`);
  });

  if (page.qr) {
    text('qr.label', page.qr.label, LIMITS.qrLabel, 'QR line');
    if (!validQR(page.qr.url)) block('qr.url', 'The QR web address is not valid (it should start with https://)');
    if (!page.qr.label) warn('qr.label', 'The QR link has no line saying what it does');
  }

  const dupes = (list, key) => { const seen = new Map(); const out = new Set(); for (const x of list) { const k = (x[key] || '').trim().toLowerCase(); if (!k) continue; if (seen.has(k)) out.add(k); seen.set(k, true); } return out; };
  const secDupes = dupes(page.sections || [], 'title');
  (page.sections || []).forEach((s, si) => {
    text(`sections.${si}.title`, s.title, LIMITS.sectionTitle, `Menu part ${si + 1} name`);
    if (secDupes.has((s.title || '').trim().toLowerCase())) warn(`sections.${si}.title`, `Two menu parts are called "${s.title}"; the TV tells them apart by name, so give each its own`);
    const dishDupes = dupes((s.items || []).filter((d) => !d.hidden), 'name');
    const warnedDupes = new Set();
    if (!s.title) block(`sections.${si}.title`, `Menu part ${si + 1} has no name`);
    text(`sections.${si}.note`, s.note, LIMITS.sectionNote, `Menu part ${si + 1} note`);
    (s.items || []).forEach((d, di) => {
      const f = `sections.${si}.items.${di}`;
      if (!d.name) block(`${f}.name`, `A dish in ${s.title || 'a menu part'} has no name`);
      const key = (d.name || '').trim().toLowerCase();
      if (!d.hidden && dishDupes.has(key) && !warnedDupes.has(key)) { warnedDupes.add(key); warn(`${f}.name`, `Two dishes in ${s.title || 'this part'} are called "${d.name}"; the TV tells them apart by name, so give each its own`); }
      text(`${f}.name`, d.name, LIMITS.dishName, `Dish "${d.name || ''}"`);
      text(`${f}.description`, d.description, LIMITS.dishDescription, `Description of ${d.name || 'a dish'}`);
      if (!d.hidden && !d.price) warn(`${f}.price`, `${d.name || 'A dish'} has no price`);
    });
  });

  (page.images || []).forEach((src, i) => photo(`images.${i}`, src, 'full', `Gallery photo ${i + 1}`));
  if (page.type === 'gallery' && !(page.images || []).length) warn('images', 'This gallery has no photos yet');

  (page.items || []).forEach((it, i) => {
    const f = `items.${i}`;
    if (!it.title) block(`${f}.title`, `Card ${i + 1} has no title`);
    text(`${f}.title`, it.title, LIMITS.cardTitle, `Card "${it.title || ''}" title`);
    text(`${f}.subtitle`, it.subtitle, LIMITS.cardSubtitle, `Card "${it.title || ''}" line`);
    text(`${f}.body`, it.body, LIMITS.cardBody, `Card "${it.title || ''}" text`);
    text(`${f}.meta`, it.meta, LIMITS.cardMeta, `Card "${it.title || ''}" date or distance`);
    if (it.image) photo(`${f}.image`, it.image, 'card', `Photo on card "${it.title}"`);
    else warn(`${f}.image`, `Card "${it.title || i + 1}" has no photo`);
  });

  const allowed = (key) => ALLOWS[key].includes(page.type);

  // Photo frames (stage 2a).
  if (allowed('photos')) (page.photos || []).forEach((ph, i) => {
    const f = `photos.${i}`;
    if (!ph.image) { block(`${f}.image`, `Photo frame ${i + 1} has no photo`); return; }
    if (!imageKnown(ph.image)) { block(`${f}.image`, `Photo frame ${i + 1}: photo missing. It is not in Media any more; choose another`); return; }
    const why = frameProblem(imageSize(ph.image), ph.fit);
    if (why) block(`${f}.image`, `Photo frame ${i + 1} is too small (${why})`);
    else if (ph.fit === 'whole' && imageSize(ph.image) && imageSize(ph.image).width < 1920) warn(`${f}.image`, `Photo frame ${i + 1} is under 1920 px wide and may look soft shown whole`);
    text(`${f}.caption`, ph.caption, LIMITS.caption, `Caption on photo frame ${i + 1}`);
  });
  if (allowed('photos') && (page.photos || []).length > LIMITS.photosMax) block('photos', `${page.photos.length} photo frames; the limit is ${LIMITS.photosMax} a page. Remove some or start a gallery page`);

  // Films (stage 2c).
  if (allowed('films')) (page.films || []).forEach((fl, i) => filmChecks(fl, `films.${i}`, `Film ${i + 1}${fl.title ? ` "${fl.title}"` : ''}`, { block, warn, text, imageKnown, imageSize, filmInfo }));
  if (allowed('films') && (page.films || []).length > LIMITS.filmsMax) block('films', `${page.films.length} films; the limit is ${LIMITS.filmsMax} a page`);
  if (page.backgroundFilm && allowed('backgroundFilm')) {
    const bg = page.backgroundFilm;
    if (!bg.film) block('backgroundFilm', 'Background film: no film chosen');
    else if (!imageKnown(bg.film)) block('backgroundFilm', 'Background film missing. It is not in Media any more; choose another');
    else {
      const info = filmInfo(bg.film);
      if (info && info.audio === true && !info.silent) block('backgroundFilm', `Background film "${info.name}" has a sound track. A background loop must be silent: use a silent export, or mark the film as silent in Media if the sound should be ignored`);
      if (info && info.audio === null && !info.silent) block('backgroundFilm', `The Builder cannot tell whether "${info.name}" has sound. Mark it as silent in Media to use it as a background`);
      if (info && info.seconds > 30) warn('backgroundFilm', `Background film runs ${Math.round(info.seconds)} s; 8 to 20 seconds that ends where it starts loops best`);
      if (info && info.bytes > LIMITS.backgroundFilmBytes) warn('backgroundFilm', `Background film is ${Math.round(info.bytes / 1048576)} MB. Background loops should be under 15 MB so every TV downloads them quickly`);
      if (bg.poster && !imageKnown(bg.poster)) block('backgroundFilm', 'Background film poster missing; choose or capture another');
      if (!bg.poster && !page.image) warn('backgroundFilm', 'Background film has no poster and the page has no photo; the TV shows a plain dark background until the film has downloaded');
    }
  }

  if (page.type === 'hub' && !(page.children || []).some((c) => !c.hidden)) warn('children', 'This section has no pages a guest can open');
  const shown = (page.children || []).filter((c) => !c.hidden);
  if (page.type === 'home' && shown.length > LIMITS.sectionsMax) block('children', `${shown.length} sections showing; the TV fits ${LIMITS.sectionsMax} at most. Hide or delete some`);
  if (page.type !== 'home' && shown.length > LIMITS.itemsMax) block('children', `${shown.length} pages showing inside; the TV fits ${LIMITS.itemsMax} at most. Hide or delete some`);
  const kidDupes = dupes(shown, 'title');
  if (kidDupes.size) warn('children', `Two ${page.type === 'home' ? 'sections' : 'pages'} here have the same name (${[...kidDupes].join(', ')}); guests cannot tell them apart and the TV uses names in its path line`);
  if (page.type !== 'home' && page.type !== 'hub' && !hasStop(page)) warn('body', 'Page has nothing a guest can select; the remote will rest on Back');

  return { blockers, warnings };
}

function filmChecks(fl, f, label, { block, warn, text, imageKnown, imageSize, filmInfo }) {
  if (!fl.film) { block(`${f}.film`, `${label}: no film chosen`); return; }
  if (!imageKnown(fl.film)) { block(`${f}.film`, `${label}: film missing. It is not in Media any more; choose another`); return; }
  const info = filmInfo(fl.film);
  if (!fl.poster) block(`${f}.poster`, `${label} has no poster. Capture a frame or upload one; the TV shows it before the film plays`);
  else if (!imageKnown(fl.poster)) block(`${f}.poster`, `${label}: poster missing. Capture a frame or choose another`);
  else {
    const why = photoProblem(imageSize(fl.poster), 'full');
    if (why) block(`${f}.poster`, `${label}: poster is too small (${why})`);
  }
  if (info && info.height && info.height < 1080) warn(`${f}.film`, `${label} is ${info.width} × ${info.height}; it will look soft on a 4K TV`);
  if (text && 'title' in fl) text(`${f}.title`, fl.title, LIMITS.filmTitle, `${label} title`);
  if (!fl.title && text) warn(`${f}.title`, `${label} has no title; the card on the TV shows only the poster`);
}

function validateFinished(page, { block, warn, text, imageKnown, imageSize, filmInfo, blockers, warnings }) {
  if (!page.description || !page.description.trim()) block('description', 'No description. One plain sentence saying what the artwork says (for search and read-aloud later)');
  text('description', page.description, LIMITS.description, 'Description');
  if (!page.image) block('image', 'No strip photo. Use slide 1, or choose a photo for the strip');
  else if (!imageKnown(page.image)) block('image', 'Strip photo missing. It is not in Media any more; choose another');
  else { const why = photoProblem(imageSize(page.image), 'full'); if (why) block('image', `Strip photo is too small for full screen (${why})`); }
  const slides = page.slides || [];
  if (!slides.length) block('slides', 'No slides yet. A finished page needs at least one piece of artwork or a film');
  if (slides.length > LIMITS.slidesMax) block('slides', `${slides.length} slides; the limit is ${LIMITS.slidesMax}`);
  slides.forEach((sl, i) => {
    const f = `slides.${i}`;
    if (sl.film) { filmChecks(sl, f, `Slide ${i + 1} (film)`, { block, warn, text: null, imageKnown, imageSize, filmInfo }); return; }
    if (!sl.image) { block(`${f}.image`, `Slide ${i + 1} has no artwork`); return; }
    if (!imageKnown(sl.image)) { block(`${f}.image`, `Slide ${i + 1}: artwork missing. It is not in Media any more; upload it again`); return; }
    const size = imageSize(sl.image);
    const why = slideSizeProblem(size);
    if (why) block(`${f}.image`, `Slide ${i + 1}: ${why}. Ask for a new export`);
    else if (size && size.width < 3840) warn(`${f}.image`, `Slide ${i + 1} is ${size.width} × ${size.height}; 3840 × 2160 is sharper on a 4K TV`);
  });
  if (page.qr) {
    text('qr.label', page.qr.label, LIMITS.qrLabel, 'QR line');
    if (!validQR(page.qr.url)) block('qr.url', 'The QR web address is not valid (it should start with https://)');
  }
  warn('slides', 'The Builder checks size, shape and file type. It cannot read the artwork: check the margins and the top band by eye with the safe-area overlay on');
  return { blockers, warnings };
}

/** Mirrors StripsTree.hasStop on the TV, for a page opened in a leaf. */
export function hasStop(page) {
  const kids = (page.children || []).filter((c) => !c.hidden);
  const extras = (page.photos || []).length > 0 || (page.films || []).length > 0;
  switch (page.type) {
    case 'home': case 'hub': return kids.length > 0 || extras;
    case 'contact': return true;
    case 'gallery': return (page.images || []).length > 0;
    case 'list': return (page.items || []).length > 0 || extras;
    case 'menu': return (page.sections || []).some((s) => (s.items || []).some((d) => !d.hidden)) || (page.hours || []).length > 0 || !!page.qr || extras;
    case 'info': return !!page.body || (page.facts || []).length > 0 || kids.length > 0 || (page.hours || []).length > 0 || !!page.qr || extras;
    case 'finished': return (page.slides || []).length > 0;
    default: return false;
  }
}

export function validateHotel(hotel) {
  const blockers = [];
  const warnings = [];
  for (const [k, label] of Object.entries({ name: 'Hotel name', reception: 'Reception', roomService: 'Room service', wifiName: 'Wi-Fi name', checkout: 'Check-out' })) {
    if (!hotel[k]) warnings.push({ field: k, message: `${label} is empty` });
    if (over(hotel[k], LIMITS.hotelField)) blockers.push({ field: k, message: `${label} is over ${LIMITS.hotelField} characters` });
  }
  if (over(hotel.tagline, LIMITS.tagline)) blockers.push({ field: 'tagline', message: 'Tagline is over its limit' });
  return { blockers, warnings };
}

/** Validates every page. Returns Map(pageId -> {blockers, warnings, held}). */
export function validateAll(doc, ctx = {}) {
  const results = new Map();
  const walk = (page, depth, parentHeld) => {
    const isStrip = depth === 1 || depth === 2;
    const r = validatePage(page, { ...ctx, isStrip });
    r.held = r.blockers.length > 0;
    r.heldByParent = parentHeld;
    results.set(page.id, r);
    for (const c of page.children || []) walk(c, depth + 1, parentHeld || r.held);
  };
  walk(doc.home, 0, false);
  results.set('hotel', { ...validateHotel(doc.hotel), held: false });
  return results;
}
