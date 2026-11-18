// The better gallery (phase B, 18 Nov 2026; docs/builder/2026-11-templates/
// GALLERY-CONTRACT.md is binding, SPEC.md section 5 is the behaviour).
//
// One place for what a gallery's frames are and how they are kept, so the
// editor, the bundle, the checks, the change list, the merge and the preview
// all agree:
//
//   page.slides   the frames, when any frame needs more than a photo: a film,
//                 a caption, a chapter (`group`), "show whole" (`fit`) or
//                 "plays with sound" (`sound`). Each is {image} or
//                 {film, poster}, plus caption?, group?, fit: 'whole'?, sound: true?
//   page.images   every frame's still (photo or poster), always, so an app
//                 before build 8 still shows a photo gallery
//   page.gallery  {style, seconds, autoplay}; left out when it is the default
//   page.body     the intro (160), page.qr the QR card (existing QRLink)
//
// A gallery of plain photos with none of the new settings is published as
// plain `images`, exactly as before.

export const GALLERY_DEFAULTS = Object.freeze({ style: 'thumbnails', seconds: 8, autoplay: false });
/** What the Builder offers for "seconds per frame"; the TV clamps anything to 4–20. */
export const SECONDS_CHOICES = [5, 8, 12];
export const SECONDS_MIN = 4, SECONDS_MAX = 20;
/** Thumbnails style with "plays by itself": frames start turning after this long with no press. */
export const IDLE_BEFORE_AUTOPLAY_MS = 20000;
/** Slideshow style: Left / Right step and hold the slideshow this long. */
export const HOLD_MS = 30000;
/** The full-screen viewer: caption, counter and path line fade after this long with no press. */
export const VIEWER_FADE_MS = 4000;
/** The "Slideshow" mark in the viewer shows this long. */
export const MARK_MS = 2000;

export const STYLES = { thumbnails: 'Thumbnails', slideshow: 'Slideshow' };

/**
 * Every word the preview shows about the gallery turning by itself, in one
 * place, so they can be set to the TV's exact words (the TV is the reference).
 */
// As the TV words them (tvos-dev, 18 Nov 2026): turning shows no words, only the dots and the
// filling bar; held or paused says "Paused"; the viewer's mark reads SLIDESHOW (drawn in capitals)
// and turning it off shows no words. `loop` is the preview's own label (it never plays video).
export const GALLERY_WORDS = {
  turnsEvery: () => '',
  pausedFor: () => 'Paused',
  paused: 'Paused',
  slideshowOn: 'Slideshow',
  slideshowOff: '',
  loop: 'Film · loops silently',
  soundInLeaf: () => ' · Film with sound',
  soundInViewer: ' · Select to play with sound',
};

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

/** A gallery's settings, read as the TV reads them: unknown style is Thumbnails, seconds clamped 4–20 (8 when missing), autoplay off unless true. */
export function galleryOptions(page) {
  const g = page?.gallery && typeof page.gallery === 'object' ? page.gallery : {};
  const style = g.style === 'slideshow' ? 'slideshow' : 'thumbnails';
  // Only a number counts, as the TV decodes it: null, '', true or '12' read as 8 (not 4).
  const n = g.seconds;
  const seconds = typeof n === 'number' && Number.isFinite(n) ? Math.min(SECONDS_MAX, Math.max(SECONDS_MIN, Math.round(n))) : GALLERY_DEFAULTS.seconds;
  return { style, seconds, autoplay: g.autoplay === true };
}

export const isDefaultOptions = (o) => o.style === GALLERY_DEFAULTS.style && o.seconds === GALLERY_DEFAULTS.seconds && o.autoplay === GALLERY_DEFAULTS.autoplay;

/** A chapter name as stored: spaces trimmed and runs of spaces made one. */
export const cleanChapter = (name) => String(name ?? '').replace(/\s+/g, ' ').trim();
/** Two chapter names are the same chapter when they match without regard to case or spacing ("Hole 7" and "hole  7"). */
export const chapterKey = (name) => cleanChapter(name).toLowerCase();

/** True when a frame needs `slides` (anything beyond a plain photo). */
export function frameNeedsSlide(fr) {
  if (!fr) return false;
  return !!fr.film || !blank(fr.caption) || !blank(fr.group) || fr.fit === 'whole' || (!!fr.film && fr.sound === true);
}

/** What a frame shows before anything plays: the photo, or a film's poster. */
export const frameStill = (s) => (s && (s.image || s.poster)) || null;

/** A gallery's frames: its slides when it has any, else its photos. */
export function framesOf(page) {
  if ((page?.slides || []).length) return page.slides;
  return (page?.images || []).map((image) => ({ image }));
}

/** One frame tidied for the draft: the keys in contract order, blanks and defaults left out. */
export function tidyFrame(fr) {
  const out = {};
  if (fr.film) { out.film = fr.film; if (fr.poster) out.poster = fr.poster; } else if (fr.image) out.image = fr.image;
  if (!blank(fr.caption)) out.caption = fr.caption;
  if (!blank(fr.group)) out.group = cleanChapter(fr.group);
  if (fr.fit === 'whole') out.fit = 'whole';
  if (fr.film && fr.sound === true) out.sound = true;
  return out;
}

/**
 * Writes a gallery's frames back to a draft page: `slides` when any frame
 * needs them, with `images` carrying every frame's still (so an older TV app
 * still shows photos); plain `images` when every frame is a plain photo.
 */
export function setFrames(page, frames) {
  const tidy = frames.map(tidyFrame).filter((fr) => fr.image || fr.film);
  if (tidy.some(frameNeedsSlide)) {
    page.slides = tidy;
    page.images = tidy.map(frameStill).filter(Boolean);
  } else {
    delete page.slides;
    page.images = tidy.map((fr) => fr.image).filter(Boolean);
  }
}

/** Sets the gallery's settings on a draft page; the default is left out. */
export function setOptions(page, options) {
  const o = galleryOptions({ gallery: { ...galleryOptions(page), ...options } });
  if (isDefaultOptions(o)) delete page.gallery;
  else page.gallery = o;
}

/**
 * Frames with a chapter gathered together, each chapter where it first
 * appears, frames in their order within it. Frames with no chapter stay
 * exactly where they are (QA-3: taking a chapter away must not move anything
 * else). The Builder keeps a gallery in this order so every chapter is one
 * run of frames, which is how the TV forms chapters.
 */
export function orderByChapter(frames) {
  const groups = new Map();
  for (const fr of frames) {
    const k = chapterKey(fr.group);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(fr);
  }
  const out = [];
  const placed = new Set();
  for (const fr of frames) {
    const k = chapterKey(fr.group);
    if (!k) out.push(fr);
    else if (!placed.has(k)) { placed.add(k); out.push(...groups.get(k)); }
  }
  return out;
}

/** True when some chapter is split into more than one run (the TV would show it as two chapters). */
export function chaptersSplit(frames) {
  const seen = new Set();
  let last = null;
  for (const fr of frames) {
    const k = chapterKey(fr.group);
    if (k !== last) { if (k && seen.has(k)) return true; seen.add(k); last = k; }
  }
  return false;
}

/** Chapter names in use, in order, each spelt as first used. */
export function chapterNames(frames) {
  const out = new Map();
  for (const fr of frames) { const k = chapterKey(fr.group); if (k && !out.has(k)) out.set(k, cleanChapter(fr.group)); }
  return [...out.values()];
}

/** The name to store for a chapter typed by someone: an existing chapter's spelling when it is the same chapter. */
export function matchChapter(frames, typed) {
  const k = chapterKey(typed);
  if (!k) return '';
  return chapterNames(frames).find((n) => chapterKey(n) === k) || cleanChapter(typed);
}

/** The runs of frames as the TV forms chapters: [{name, key, start, count}] (name '' for frames with no chapter). */
export function chapterRuns(frames) {
  const runs = [];
  frames.forEach((fr, i) => {
    const k = chapterKey(fr.group);
    const last = runs[runs.length - 1];
    if (last && last.key === k) last.count++;
    else runs.push({ name: cleanChapter(fr.group), key: k, start: i, count: 1 });
  });
  return runs;
}

/** True when the gallery shows chapters: at least one frame has one. */
export const hasChapters = (frames) => frames.some((fr) => !!chapterKey(fr.group));

/** The counter for frame i: "Hole 7 · 2 of 3" inside a chapter, else "5 of 12". */
export function frameCount(frames, i) {
  const fr = frames[i];
  if (!fr) return { chapter: '', text: '' };
  if (hasChapters(frames) && chapterKey(fr.group)) {
    const run = chapterRuns(frames).find((r) => i >= r.start && i < r.start + r.count);
    return { chapter: run.name, text: `${i - run.start + 1} of ${run.count}` };
  }
  return { chapter: '', text: `${i + 1} of ${frames.length}` };
}

/**
 * Which of the new gallery fields a page in a bundle uses, in words, for the
 * "older app" warning on Publish ([] when none): captions, chapters, show
 * whole, films with sound, the slideshow or plays-by-itself, the intro, the QR code.
 */
export function newGalleryFeatures(page) {
  if (!page || page.type !== 'gallery') return [];
  const out = [];
  const slides = page.slides || [];
  if (slides.some((s) => !blank(s.caption))) out.push('captions');
  if (slides.some((s) => !blank(s.group))) out.push('chapters');
  if (slides.some((s) => s.fit === 'whole')) out.push('show whole');
  if (slides.some((s) => s.film && s.sound === true)) out.push('films with sound');
  if (page.gallery && typeof page.gallery === 'object') {
    const o = galleryOptions(page);
    if (o.style === 'slideshow') out.push('the slideshow');
    else if (o.autoplay) out.push('plays by itself');
  }
  if (!blank(page.body)) out.push('the intro');
  if (page.qr) out.push('the QR code');
  return out;
}

/**
 * Splits pasted captions into lines: one per frame, in order. A line with a
 * tab is "chapter<tab>caption". Trailing empty lines are dropped; an empty
 * line in the middle holds its frame's place and clears its caption.
 * Returns [{caption, chapter|null}].
 */
export function parseCaptions(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.map((l) => {
    const tab = l.indexOf('\t');
    if (tab < 0) return { caption: l.trim(), chapter: null };
    return { caption: l.slice(tab + 1).replace(/\t/g, ' ').trim(), chapter: cleanChapter(l.slice(0, tab)) };
  });
}

/** Built-in starting points for a new gallery page (SPEC 5.5). Copied into the page; nothing links back. */
export const GALLERY_PRESETS = {
  'hole-by-hole': {
    label: 'Hole by hole',
    hint: 'Thumbnails with chapters (Hole 1, Hole 2…), captions, plays by itself after 20 seconds, room for an intro and a QR code. The Course.',
    // The intro starts empty (the editor shows an example as a hint) and the QR code starts with its
    // line but no address, which holds the new page back until one is given or the QR removed (QA-5).
    apply(page) {
      delete page.kicker;
      page.qr = { label: 'Book a tee time', url: '' };
      page.gallery = { style: 'thumbnails', seconds: 8, autoplay: true };
    },
  },
  photo: {
    label: 'Photo gallery',
    hint: 'Thumbnails with captions, plays by itself after 20 seconds, room for an intro and a QR code. No chapters. Our Rooms & Suites.',
    apply(page) {
      page.qr = { label: 'Find out more', url: '' };
      page.gallery = { style: 'thumbnails', seconds: 8, autoplay: true };
    },
  },
};

/**
 * After a merge: `images` (every frame's still) says which frames there are
 * and in what order, `slides` what each frame carries (film, caption,
 * chapter, fit, sound). Two people's edits merge each list on its own, so
 * this puts them back together: each still in `images` takes the first
 * unused frame in `slides` with that still (else it is a plain photo), a film
 * frame with no poster yet keeps its place at the end, and chapters are put
 * back together. Changes the page in place.
 */
export function reconcileFrames(page) {
  if (page?.type !== 'gallery') return page;
  if (!(page.slides || []).length) { delete page.slides; return page; }
  const slides = page.slides;
  const used = new Set();
  const frames = [];
  for (const src of page.images || []) {
    const k = slides.findIndex((s, i) => !used.has(i) && frameStill(s) === src);
    if (k >= 0) { used.add(k); frames.push(slides[k]); } else frames.push({ image: src });
  }
  slides.forEach((s, i) => { if (!used.has(i) && !frameStill(s) && s.film) frames.push(s); });
  setFrames(page, orderByChapter(frames));
  return page;
}

/**
 * The Publish screen's warning (hotel server only) when a gallery in this
 * publish uses the new fields and some TVs last reported an app older than
 * build 8 (or never said, which apps before 8 do not): those TVs show a
 * plain photo gallery until their app is updated. Never blocks. Returns the
 * sentence, or '' when there is nothing to say.
 *   bundle     the bundle going live
 *   overrides  the resolved room content ({entries}), for page versions
 *   older      {minimum, tvs: [{room, location, address, name, app_build, unknown}]} from the server
 */
export function olderAppWarning(bundle, overrides, older) {
  const tvs = older?.tvs || [];
  if (!tvs.length || !bundle?.home) return '';
  const pages = new Map();
  const walk = (p) => { pages.set(p.id, p); (p.children || []).forEach(walk); };
  walk(bundle.home);
  const using = new Map();   // title -> Set of features
  const note = (page, feats) => { if (!feats.length) return; const t = page.title || page.id; if (!using.has(t)) using.set(t, new Set()); feats.forEach((f) => using.get(t).add(f)); };
  for (const p of pages.values()) note(p, newGalleryFeatures(p));
  for (const e of overrides?.entries || []) {
    const p = pages.get(e.page);
    if (!p || p.type !== 'gallery' || e.field !== 'page') continue;
    for (const patch of Object.values(e.values || {})) note(p, newGalleryFeatures({ ...p, ...Object.fromEntries(Object.entries(patch || {}).filter(([, v]) => v !== null)) }));
  }
  if (!using.size) return '';
  const where = (t) => [t.room ? `room ${t.room}` : (t.name || t.address || 'a TV not in a room'), t.room ? t.location : ''].filter(Boolean).join(' ');
  const which = (t) => (t.unknown ? 'app not reported' : `app ${t.app_build}`);
  const named = tvs.slice(0, 6).map((t) => `${where(t)} (${which(t)})`).join(', ') + (tvs.length > 6 ? ` and ${tvs.length - 6} more` : '');
  const pageBits = [...using].map(([t, f]) => `${t} (${[...f].join(', ')})`);
  const pagesText = pageBits.length > 1 ? `${pageBits.slice(0, -1).join(', ')} and ${pageBits[pageBits.length - 1]}` : pageBits[0];
  const min = older.minimum || 8;
  return `${pagesText} ${using.size === 1 ? 'uses' : 'use'} the new gallery features. ${tvs.length === 1 ? '1 TV' : `${tvs.length} TVs`} last reported an app older than build ${min}: ${named}. ${tvs.length === 1 ? 'It shows' : 'They show'} a plain photo gallery until ${tvs.length === 1 ? 'its' : 'their'} app is updated; everything else is the same. This does not stop publishing.`;
}
