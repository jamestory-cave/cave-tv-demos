// Guard rails (UX spec section 6). The Builder warns, the TV copes.
// A blocker holds that page back from the bundle; a warning does not.

import { ALLOWS } from './bundle.js';
import { framesOf, hasChapters, chaptersSplit, chapterKey, chapterRuns } from './gallery.js';

export const LIMITS = {
  title: 28, kicker: 30, subtitle: 60, body: 500, fact: 70, factsMax: 6,
  hoursLabel: 20, hoursValue: 40, qrLabel: 50,
  dishName: 40, dishDescription: 120, dishPrice: 12, sectionTitle: 40, sectionNote: 60,
  cardTitle: 40, cardSubtitle: 60, cardBody: 160, cardMeta: 20,
  hotelField: 40, tagline: 60,
  sectionsMax: 8, itemsMax: 8, galleryMax: 60,
  // Stage 2: photo frames, films, finished pages.
  caption: 60, photosMax: 6, filmTitle: 40, filmsMax: 4, description: 160, slidesMax: 10,
  backgroundFilmBytes: 15 * 1024 * 1024,   // a warning; 60 MB stays the hard limit for every film
  // Rhys's requests, 9 Nov 2026 (docs/builder/2026-11-rhys-requests.md).
  hoursTitle: 24, childrenTitle: 40,
  // The better gallery (phase B, GALLERY-CONTRACT.md): caption per frame,
  // chapter name, intro. galleryMax was 12; a course told hole by hole needs
  // about 54 frames (SPEC 5.2), so 60.
  frameCaption: 80, chapter: 24, galleryIntro: 160,
  // A full-screen photo needs 1920 on its long edge and 1080 on its short
  // edge (portrait photos are fine: the TV crops them). Cards need 800.
  imageMinLong: 1920, imageMinShort: 1080, cardImageMinLong: 800,
};

/**
 * The example words a new page starts with (model.js newPage). Left in place they would reach
 * guests (build 7 QA-2: "A short line above the title" did), so each is a warning naming the
 * field, and the Publish screen lists the pages still carrying any (gallery QA-5).
 */
export const EXAMPLE_TEXT = new Set(['New section', 'One line about this section', 'A short line above the title', 'One line that sums it up',
  'Two or three sentences. Short, confident, slightly theatrical.', 'One thing worth knowing', 'Another', 'Sample menu', 'One line about the menu.',
  'One line about this list', 'First card', 'When or how far', 'One line', 'A sentence or two.', 'Something useful to know', 'A dish', 'What is in it']);
const isExample = (v) => typeof v === 'string' && EXAMPLE_TEXT.has(v.trim());

/** Why a photo is too small for its use, or null if it is fine or unknown. */
export function photoProblem(size, use = 'full') {
  if (!size) return null;
  const long = Math.max(size.width, size.height), short = Math.min(size.width, size.height);
  if (use === 'card') return long < LIMITS.cardImageMinLong ? `${size.width} × ${size.height}, needs ${LIMITS.cardImageMinLong} px on its long side` : null;
  if (long < LIMITS.imageMinLong || short < LIMITS.imageMinShort) return `${size.width} × ${size.height}, needs ${LIMITS.imageMinLong} × ${LIMITS.imageMinShort} or larger`;
  return null;
}

// ---- Links: ONE rule set, shared with the hotel server ------------------------
// cave_overrides.py has the same rules, step for step, with the same words,
// and both sides are run against the same cases (selftest-data/link-rules.json),
// so a link the Builder calls fine is never refused by the server (QA-2, QA-3,
// QA-11, QA-12). The allowed characters are spelled out rather than left to
// each language's idea of "white space":
//   - only plain spaces, tabs and line breaks are trimmed from the ends;
//   - a link is printable ASCII only (! to ~): no spaces, no invisible
//     characters, no accented letters (a site gives them %-encoded);
//   - http or https (any case), a host with at least one dot, an optional
//     port, then anything starting /, ? or #.
// A Wi-Fi code (WIFI:…) is allowed where the master's rule applies.
export const LINK_RE = /^(https?):\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(:\d{1,5})?([/?#][!-~]*)?$/i;

/** Trims plain spaces, tabs and line breaks from the ends (never other characters: they make the link wrong). */
export const trimLink = (url) => String(url ?? '').replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '');

const INVISIBLE = (c) => c <= 0x20 || (c >= 0x7f && c <= 0xa0) || c === 0xad || (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029 || c === 0x2060 || c === 0xfeff;
const hex4 = (c) => 'U+' + c.toString(16).toUpperCase().padStart(4, '0');

/**
 * What is wrong with a link, in words, or null when it is fine. https: true for a link that
 * differs by room (Overrides: https only, no Wi-Fi codes); false for the master's rule.
 */
export function linkProblem(url, { https = false } = {}) {
  const s = trimLink(url);
  if (!s) return 'there is no web address';
  if (!https && /^WIFI:/i.test(s)) return null;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x21 && c <= 0x7e) continue;
    if (c === 0x20) return 'it has a space in it';
    if (INVISIBLE(c)) return `it has an invisible character in it (${hex4(c)})`;
    return `it has "${ch}" in it; a web address can only use plain letters, digits and signs such as / ? = &`;
  }
  const sm = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(s);
  if (!sm) return https ? 'it should start https://' : 'it should start https:// (or be a Wi-Fi code)';
  const scheme = sm[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return `it starts "${sm[1]}:" instead of https://`;
  if (https && scheme === 'http') return 'it starts http://; a link that differs by room must start https://';
  const rest = s.slice(sm[0].length);
  const authority = rest.split(/[/?#]/)[0];
  if (authority.includes('@')) return 'it has an "@" before the site\'s address, which phones treat as a sign-in';
  const hp = /^([^:]*)(?::(.*))?$/.exec(authority);
  const host = hp[1];
  if (!host) return 'there is no site address after "://"';
  if (hp[2] !== undefined && !/^\d{1,5}$/.test(hp[2])) return 'the number after ":" in the site\'s address is not a port number';
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(host)) return `"${host.slice(0, 40)}" is not a full site address (it needs a dot, as in example.com)`;
  return null;
}

/** True for a QR code the TV can draw and a phone can open: a Wi-Fi code (WIFI:…) or an http(s) link. The master's rule, and a page version's. */
export function validQR(url) { return linkProblem(url) === null; }

/** True for a link that differs by room (Overrides): the same rule, https only. */
export function validHTTPS(url) { return linkProblem(url, { https: true }) === null; }

/** A link as it is published: trimmed, scheme and host in small letters (the path is kept as typed). */
export function normaliseLink(url) {
  const s = trimLink(url);
  const m = LINK_RE.exec(s);
  return m ? `${m[1].toLowerCase()}://${m[2].toLowerCase()}${m[3] || ''}${m[4] || ''}` : s;
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
  const LABEL = { photos: 'photo frames', films: 'films', backgroundFilm: 'a background film', slides: 'slides', description: 'a description',
    hoursTitle: 'an hours heading', childrenTitle: 'a heading above its pages', gallery: 'gallery settings' };
  for (const key of Object.keys(ALLOWS)) {
    const has = Array.isArray(page[key]) ? page[key].length > 0 : !!page[key];
    if (has && !ALLOWS[key].includes(page.type)) warn(key, `This page carries ${LABEL[key]}, which a ${page.type} page cannot show; they are left out when publishing`);
  }
  if (page.type === 'finished') return validateFinished(page, { block, warn, text, photo, imageKnown, imageSize, filmInfo, ctx, blockers, warnings });
  // Example words still in place (a warning: the page still publishes).
  const example = (field, v, what) => { if (isExample(v)) warn(field, `${what} is still the example text "${v.trim()}"; replace it or clear it`); };
  example('kicker', page.kicker, 'Small caps line');
  example('subtitle', page.subtitle, 'Subtitle');
  example('body', page.body, page.type === 'gallery' ? 'Intro' : 'Text');
  (page.facts || []).forEach((t, i) => example(`facts.${i}`, t, `Fact ${i + 1}`));
  (page.items || []).forEach((it, i) => { example(`items.${i}.title`, it.title, `Card ${i + 1} title`); example(`items.${i}.subtitle`, it.subtitle, `Card ${i + 1} line`); example(`items.${i}.body`, it.body, `Card ${i + 1} text`); example(`items.${i}.meta`, it.meta, `Card ${i + 1} date or distance`); });
  (page.sections || []).forEach((sec, si) => (sec.items || []).forEach((d, di) => { if (!d.hidden) { example(`sections.${si}.items.${di}.name`, d.name, 'A dish name'); example(`sections.${si}.items.${di}.description`, d.description, `Description of ${d.name || 'a dish'}`); } }));
  text('kicker', page.kicker, LIMITS.kicker, 'Small caps line');
  text('subtitle', page.subtitle, LIMITS.subtitle, 'Subtitle');
  // A gallery's intro is drawn from app build 8; its limit is 160 (other pages keep 500). A longer
  // intro written before (older apps never showed it) holds the page back, said plainly with the count.
  if (page.type === 'gallery' && over(page.body, LIMITS.galleryIntro)) block('body', `The intro is ${page.body.length} characters; a gallery's intro can be ${LIMITS.galleryIntro} (the TV shows it under the title). Shorten it under "This gallery" to publish ${page.title ? `"${page.title}"` : 'this page'}`);
  else if (page.type === 'gallery') text('body', page.body, LIMITS.galleryIntro, 'Intro');
  else text('body', page.body, LIMITS.body, 'Text');

  if (ctx.isStrip && page.type !== 'home' && !page.image) block('image', 'This strip has no photo');
  else if (!ctx.isStrip && page.type !== 'home' && !page.image) warn('image', 'No photo: the tile will be plain');
  if (page.image) photo('image', page.image, 'full', 'Photo');

  (page.facts || []).forEach((f, i) => text(`facts.${i}`, f, LIMITS.fact, `Fact ${i + 1}`));
  if ((page.facts || []).length > LIMITS.factsMax) warn('facts', `More than ${LIMITS.factsMax} facts; the page gets long`);

  text('hoursTitle', page.hoursTitle, LIMITS.hoursTitle, 'Hours heading');
  text('childrenTitle', page.childrenTitle, LIMITS.childrenTitle, 'Heading above the pages inside');
  (page.hours || []).forEach((h, i) => {
    text(`hours.${i}.label`, h.label, LIMITS.hoursLabel, `Hours row ${i + 1} label`);
    text(`hours.${i}.value`, h.value, LIMITS.hoursValue, `Hours row ${i + 1}`);
    if (!h.label && !h.value) warn(`hours.${i}.label`, `Hours row ${i + 1} is empty`);
  });

  if (page.qr) {
    text('qr.label', page.qr.label, LIMITS.qrLabel, 'QR line');
    if (!validQR(page.qr.url)) block('qr.url', `The QR web address is not valid: ${linkProblem(page.qr.url)}`);
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

  const frames = page.type === 'gallery' ? galleryFrames(page) : null;
  if (frames && (page.slides || []).length) {
    // Photos and films (gallery slides). Fields stay under `images` so the editor's "Photos and films" part shows them.
    frames.forEach((fr, i) => {
      const f = `images.${i}`;
      const name = fr.film ? `Gallery film ${i + 1}` : `Gallery photo ${i + 1}`;
      if (fr.film) {
        filmChecks(fr, f, name, { block, warn, text: null, imageKnown, imageSize, filmInfo });
        const info = imageKnown(fr.film) ? filmInfo(fr.film) : null;
        if (fr.sound === true) {
          // Plays with sound: Select plays it full screen, so a sound track is expected.
          if (info && info.audio === false) warn(`${f}.sound`, `${name} "${info.name}" is set to play with sound but has no sound track; it will play silently. Choose "Silent loop" if it is a loop`);
        } else {
          if (info && info.audio === true && !info.silent) block(`${f}.sound`, `${name} "${info.name}" has a sound track. A silent loop must have none: choose "Plays with sound", use a silent export, or mark the film as silent in Media`);
          if (info && info.audio === null && !info.silent) block(`${f}.sound`, `The Builder cannot tell whether "${info.name}" has sound. Choose "Plays with sound", or mark it as silent in Media to use it as a silent loop`);
          if (info && info.bytes > LIMITS.backgroundFilmBytes) warn(f, `${name} is ${Math.round(info.bytes / 1048576)} MB. Loops should be under 15 MB so every TV downloads them quickly`);
        }
      } else if (fr.image) {
        if (fr.fit === 'whole') {
          if (!imageKnown(fr.image)) block(f, `${name}: photo missing. It is not in Media any more; choose another`);
          else { const why = frameProblem(imageSize(fr.image), 'whole'); if (why) block(f, `${name} is too small (${why})`); }
        } else photo(f, fr.image, 'full', name);
      } else block(f, `Gallery frame ${i + 1} has no photo or film`);
      text(`${f}.caption`, fr.caption, LIMITS.frameCaption, `Caption on frame ${i + 1}`);
    });
    // Chapter names: one check per chapter, on its first frame, not one per frame (QA-10).
    const chapterSeen = new Set();
    frames.forEach((fr, i) => {
      const k = chapterKey(fr.group);
      if (!k || chapterSeen.has(k)) return;
      chapterSeen.add(k);
      text(`images.${i}.group`, fr.group, LIMITS.chapter, `Chapter name "${String(fr.group).trim().slice(0, 30)}"`);
    });
    if (hasChapters(frames)) {
      const loose = frames.map((fr, i) => (chapterKey(fr.group) ? null : i + 1)).filter(Boolean);
      if (loose.length) warn(`images.${loose[0] - 1}.group`, `${loose.length === 1 ? `Frame ${loose[0]} has` : `Frames ${loose.slice(0, 6).join(', ')}${loose.length > 6 ? '…' : ''} have`} no chapter; on the TV ${loose.length === 1 ? 'it shows' : 'they show'} without a chapter name`);
      if (chaptersSplit(frames)) {
        const seen = new Set(), split = [];
        const first = new Map();
        for (const r of chapterRuns(frames)) { if (!first.has(r.key)) first.set(r.key, r.name); else if (r.key && !split.includes(first.get(r.key))) split.push(first.get(r.key)); seen.add(r.key); }
        warn('images', `The frames of ${split.map((n) => `"${n}"`).join(', ')} are not together; the TV would show ${split.length === 1 ? 'it' : 'each'} as two chapters. Choose the chapter again on one of its frames and the Builder puts them together`);
      }
    }
  } else (page.images || []).forEach((src, i) => photo(`images.${i}`, src, 'full', `Gallery photo ${i + 1}`));
  if (frames && !frames.length) warn('images', 'This gallery has no photos or films yet');
  if (frames && frames.length > LIMITS.galleryMax) block('images', `${frames.length} photos and films; the limit is ${LIMITS.galleryMax} a gallery`);

  (page.items || []).forEach((it, i) => {
    const f = `items.${i}`;
    if (!it.title) block(`${f}.title`, `Card ${i + 1} has no title`);
    text(`${f}.title`, it.title, LIMITS.cardTitle, `Card "${it.title || ''}" title`);
    text(`${f}.subtitle`, it.subtitle, LIMITS.cardSubtitle, `Card "${it.title || ''}" line`);
    text(`${f}.body`, it.body, LIMITS.cardBody, `Card "${it.title || ''}" text`);
    text(`${f}.meta`, it.meta, LIMITS.cardMeta, `Card "${it.title || ''}" date or distance`);
    if (it.image) photo(`${f}.image`, it.image, 'card', `Photo on card "${it.title}"`);
    else warn(`${f}.image`, `Card "${it.title || i + 1}" has no photo`);
    if (it.qr && (it.qr.label || it.qr.url)) {   // both emptied: left out when publishing, nothing to check
      text(`${f}.qr.label`, it.qr.label, LIMITS.qrLabel, `QR line on card "${it.title || i + 1}"`);
      if (!validQR(it.qr.url)) block(`${f}.qr.url`, `The QR web address on card "${it.title || i + 1}" is not valid: ${linkProblem(it.qr.url)}`);
      if (!it.qr.label) warn(`${f}.qr.label`, `The QR code on card "${it.title || i + 1}" has no line saying what it does`);
    }
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
    if (!validQR(page.qr.url)) block('qr.url', `The QR web address is not valid: ${linkProblem(page.qr.url)}`);
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
    case 'gallery': return galleryFrames(page).length > 0;
    case 'list': return (page.items || []).length > 0 || extras || !!page.qr;   // the QR card is a stop on a list with nothing else (StripsModel)
    case 'menu': return (page.sections || []).some((s) => (s.items || []).some((d) => !d.hidden)) || (page.hours || []).length > 0 || !!page.qr || extras;
    case 'info': return !!page.body || (page.facts || []).length > 0 || kids.length > 0 || (page.hours || []).length > 0 || !!page.qr || extras;
    case 'finished': return (page.slides || []).length > 0;
    default: return false;
  }
}

/** A gallery's frames: its slides (photos and films) when it has any, else its photos. */
export const galleryFrames = framesOf;

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
