// Page renderers for the preview, one per page type, following the TV's
// views (InfoView, MenuView, GalleryView, ListView, ContactView, HubView).
// Every editable piece carries data-f="<pageId>|<field>" so edit mode can
// select it; every focusable piece carries data-stop for remote mode.

import { el } from '../util.js';
import { qrSVG } from './qr.js';

const visible = (kids) => (kids || []).filter((c) => !c.hidden);

function f(node, pageId, field, label) {
  node.dataset.f = `${pageId}|${field}`;
  node.dataset.label = label;
  return node;
}

function stop(node, key, extra = {}) {
  node.dataset.stop = key;
  Object.assign(node.dataset, extra);
  return node;
}

function header(page, ctx) {
  const kicker = page.kicker ?? ctx.layout.fallbackKicker;
  const h = el('div.tv-header');
  if (kicker) h.append(f(el('div.tv-kicker', kicker.toUpperCase()), page.id, 'kicker', 'Small caps line'));
  h.append(f(el('div.tv-title', page.title || ' '), page.id, 'title', 'Title'));
  if (page.subtitle) h.append(f(el('div.tv-subtitle', page.subtitle), page.id, 'subtitle', 'Subtitle'));
  return h;
}

/** The heading over the hours card: the page's own, or "Opening hours" as before. */
export const hoursHeading = (page) => ((page.hoursTitle || '').trim() || 'Opening hours').toUpperCase();

function hoursBlock(page, entry) {
  const b = stop(el('div.tv-card.tv-hours'), 'hours', entry ? { entry: '1' } : {});
  b.append(f(el('div.tv-kicker', hoursHeading(page)), page.id, 'hoursTitle', 'Hours heading'));
  (page.hours || []).forEach((h, i) => {
    b.append(el('div.tv-hrow',
      f(el('div.l', h.label || ' '), page.id, `hours.${i}.label`, 'Hours label'),
      f(el('div.v', h.value || ' '), page.id, `hours.${i}.value`, 'Hours')));
  });
  return f(b, page.id, 'hours', 'Opening hours');
}

function qrBlock(page, entry) {
  return qrCard(page.qr, page.id, 'qr', stop(el('div.tv-card.tv-qr'), 'qr', entry ? { entry: '1' } : {}));
}

/** The QR card (QRBlock on the TV): "ON YOUR PHONE", the code and its line. `field` is 'qr' or 'items.3.qr'. */
function qrCard(qr, pageId, field, b = el('div.tv-card.tv-qr')) {
  b.append(el('div.tv-kicker', 'ON YOUR PHONE'));
  const row = el('div.tv-qr-row');
  row.append(f(el('div.tv-qr-img', qrSVG(qr.url || ' ', 180)), pageId, `${field}.url`, 'QR web address'));
  row.append(f(el('div.tv-qr-label', qr.label || ' '), pageId, `${field}.label`, 'QR line'));
  b.append(row);
  return f(b, pageId, field, 'QR link');
}

/** True for a QR the TV keeps: it drops a QR whose address is empty (Content.swift `optionalQR`). */
const hasAddress = (qr) => !!qr && !!String(qr.url || '').trim();

/**
 * The QR a list page shows while card `i` is focused: the card's own QR, else
 * the page's, else none. `i` < 0 means no card is focused (the page's QR).
 */
export function listQRFor(page, i) {
  const it = (page.items || [])[i];
  if (it && hasAddress(it.qr)) return { qr: it.qr, slot: `card-${i}` };
  if (hasAddress(page.qr)) return { qr: page.qr, slot: 'page' };
  return null;
}

function tile(child, ctx, entry, w = 380, h = 214) {
  const t = stop(el('div.tv-tile', { style: { width: w + 'px', height: h + 'px' } }), `child-${child.id}`, { child: child.id, ...(entry ? { entry: '1' } : {}) });
  const url = ctx.media.url(child.image, 800);
  if (url) t.style.backgroundImage = `url("${url}")`;
  const inner = el('div.tv-tile-in');
  if (child.kicker) inner.append(el('div.k', child.kicker));
  inner.append(el('div.t', child.title));
  t.append(inner);
  t.dataset.f = `${child.id}|title`;
  t.dataset.label = `Page: ${child.title}`;
  return t;
}

/** Photo frames (stage 2a): 16:9 frames in the main column, fill or whole, each a focus stop. */
function frames(page, ctx, entry) {
  const photos = page.photos || [];
  if (!photos.length) return null;
  const list = el('div.tv-frames');
  photos.forEach((ph, i) => {
    const frame = stop(el('div.tv-frame' + (ph.fit === 'whole' ? '.whole' : '')), `frame-${i}`, entry && i === 0 ? { entry: '1' } : {});
    const img = el('div.img');
    const url = ctx.media.url(ph.image, 1920);
    if (url) img.style.backgroundImage = `url("${url}")`;
    frame.append(img);
    if (ph.caption) frame.append(el('div.tv-caption-line', ph.caption));
    list.append(f(frame, page.id, `photos.${i}`, `Photo frame ${i + 1}`));
  });
  return f(list, page.id, 'photos', 'Photo frames');
}

function playGlyph() {
  const g = el('div.tv-play');
  g.append(el('span'));
  return g;
}

/** Film cards (stage 2c): a 16:9 poster with a play glyph and the title; Select plays. */
function filmCards(page, ctx, entry) {
  const films = page.films || [];
  if (!films.length) return null;
  const row = el('div.tv-films');
  films.forEach((fl, i) => {
    const card = stop(el('div.tv-film'), `film-${i}`, { film: fl.title || 'Untitled film', ...(entry && i === 0 ? { entry: '1' } : {}) });
    const poster = el('div.poster');
    const url = ctx.media.url(fl.poster, 800);
    if (url) poster.style.backgroundImage = `url("${url}")`;
    poster.append(playGlyph());
    if (fl.seconds) poster.append(el('div.len', fmtLen(fl.seconds)));
    card.append(poster);
    card.append(el('div.t', fl.title || ' '));
    row.append(f(card, page.id, `films.${i}`, `Film ${i + 1}`));
  });
  return f(row, page.id, 'films', 'Films');
}

const fmtLen = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Child-page tiles after a page's own content (every page type shows them). */
function childTiles(page, ctx, entry, w = 380, h = 214) {
  const kids = ctx.layout.showsChildren ? visible(page.children) : [];
  if (!kids.length) return null;
  const row = el('div.tv-tiles');
  kids.forEach((c, i) => row.append(tile(c, ctx, entry && i === 0, w, h)));
  return withChildrenHeading(page, f(row, page.id, 'children', 'Pages under this one'));
}

/** The page's heading above its child tiles (`childrenTitle`), drawn as a kicker like the TV's. */
function withChildrenHeading(page, row) {
  const t = (page.childrenTitle || '').trim();
  if (!t) return row;
  const box = el('div.tv-kids');
  box.append(f(el('div.tv-kicker.tv-kids-h', t.toUpperCase()), page.id, 'childrenTitle', 'Heading above the pages inside'), row);
  return box;
}

function factList(page, entry) {
  const list = stop(el('div.tv-facts.tv-text-stop'), 'facts', entry ? { entry: '1' } : {});
  (page.facts || []).forEach((t, i) => list.append(f(el('div.tv-fact', t), page.id, `facts.${i}`, `Fact ${i + 1}`)));
  return f(list, page.id, 'facts', 'Facts');
}

// ---- info ----------------------------------------------------------------
function renderInfo(page, ctx) {
  const root = el('div.tv-page-in');
  root.append(header(page, ctx));
  const kids = ctx.layout.showsChildren ? visible(page.children) : [];
  let first = page.body ? 'body' : (page.facts || []).length ? 'facts' : (page.photos || []).length ? 'photos' : (page.films || []).length ? 'films' : kids.length ? 'tiles' : (page.hours || []).length ? 'hours' : page.qr ? 'qr' : null;

  const reading = el('div.tv-reading');
  if (page.body) reading.append(f(stop(el('div.tv-body.tv-text-stop', page.body), 'body', first === 'body' ? { entry: '1' } : {}), page.id, 'body', 'Text'));
  if ((page.facts || []).length) reading.append(factList(page, first === 'facts'));
  const fr = frames(page, ctx, first === 'photos'); if (fr) reading.append(fr);
  const fc = filmCards(page, ctx, first === 'films'); if (fc) reading.append(fc);
  if (kids.length) {
    const row = el('div.tv-tiles');
    kids.forEach((c, i) => row.append(tile(c, ctx, first === 'tiles' && i === 0)));
    reading.append(withChildrenHeading(page, f(row, page.id, 'children', 'Pages under this one')));
  }
  const aside = el('div.tv-aside');
  if ((page.hours || []).length) aside.append(hoursBlock(page, first === 'hours'));
  if (page.qr) aside.append(qrBlock(page, first === 'qr'));

  const cols = el('div.tv-columns' + (ctx.layout.contentWidth < 1000 ? '.stack' : ''), reading);
  if (aside.childNodes.length) cols.append(aside);
  root.append(cols);
  return root;
}

// ---- menu ----------------------------------------------------------------
function renderMenu(page, ctx) {
  const root = el('div.tv-page-in');
  root.append(header(page, ctx));
  const menu = el('div.tv-menu');
  if (page.body) menu.append(f(el('div.tv-body.dim', page.body), page.id, 'body', 'Text'));
  const sections = page.sections || [];
  let entryGiven = false;
  sections.forEach((s, si) => {
    const sec = el('div.tv-msec');
    const h = el('div.tv-msec-h', f(el('div.t', s.title || ' '), page.id, `sections.${si}.title`, 'Menu part'));
    if (s.note) h.append(f(el('div.n', s.note), page.id, `sections.${si}.note`, 'Part note'));
    sec.append(h, el('div.tv-rule'));
    (s.items || []).forEach((d, di) => {
      if (d.hidden) return;
      const row = stop(el('div.tv-row'), `row-${si}-${di}`, !entryGiven ? { entry: '1' } : {});
      entryGiven = true;
      const w = el('div.w');
      const nm = el('div.nm', f(el('span', d.name || ' '), page.id, `sections.${si}.items.${di}.name`, 'Dish'));
      (d.tags || []).forEach((t) => nm.append(el('span.tv-tag', t.toUpperCase())));
      w.append(nm);
      if (d.description) w.append(f(el('div.d', d.description), page.id, `sections.${si}.items.${di}.description`, 'Description'));
      row.append(w);
      if (d.price) row.append(f(el('div.p', d.price), page.id, `sections.${si}.items.${di}.price`, 'Price'));
      sec.append(row);
    });
    menu.append(sec);
  });
  const hasRows = entryGiven;
  const fc = filmCards(page, ctx, !hasRows); if (fc) menu.append(fc);
  const hasFilms = !!(page.films || []).length;
  if ((page.hours || []).length) menu.append(hoursBlock(page, !hasRows && !hasFilms));
  if (page.qr) menu.append(qrBlock(page, !hasRows && !hasFilms && !(page.hours || []).length));
  root.append(f(menu, page.id, 'sections', 'Menu'));
  const ct = childTiles(page, ctx, !hasRows && !hasFilms && !(page.hours || []).length && !page.qr); if (ct) root.append(ct);
  return root;
}

// ---- list ----------------------------------------------------------------
function renderList(page, ctx) {
  const root = el('div.tv-page-in');
  root.append(header(page, ctx));
  const list = el('div.tv-list');
  if (page.body) list.append(f(el('div.tv-body.dim', page.body), page.id, 'body', 'Text'));
  const fr = frames(page, ctx, true); if (fr) list.append(fr);
  const fc = filmCards(page, ctx, !fr); if (fc) list.append(fc);
  (page.items || []).forEach((it, i) => {
    const card = stop(el('div.tv-lcard'), `card-${i}`, { card: String(i), ...(i === 0 && !fr && !fc ? { entry: '1' } : {}) });
    const img = f(el('div.img'), page.id, `items.${i}.image`, 'Card photo');
    const url = ctx.media.url(it.image, 800);
    if (url) img.style.backgroundImage = `url("${url}")`;
    const w = el('div.w');
    if (it.meta || it.qr) {
      // A card with its own QR is marked (as on the TV); the code itself is in the column on the right.
      const row = el('div.tv-mrow');
      if (it.meta) row.append(f(el('div.m', it.meta), page.id, `items.${i}.meta`, 'Date or distance'));
      if (it.qr) row.append(f(el('span.tv-qrmark', { title: 'Has its own QR code' }), page.id, `items.${i}.qr`, 'Card QR code'));
      w.append(row);
    }
    w.append(f(el('div.t', it.title || ' '), page.id, `items.${i}.title`, 'Card title'));
    if (it.subtitle) w.append(f(el('div.s', it.subtitle), page.id, `items.${i}.subtitle`, 'Card line'));
    if (it.body) w.append(f(el('div.b', it.body), page.id, `items.${i}.body`, 'Card text'));
    card.append(img, w);
    list.append(f(card, page.id, `items.${i}`, `Card ${i + 1}`));
  });
  // QR codes (Rhys, 9 Nov 2026), as ListView on the TV: one QR card, large
  // enough to scan from the bed, pinned bottom-right of the page area (the
  // stage lifts it out of the scroller so it stays put while the list
  // scrolls); the cards' column narrows to make room. It shows the focused
  // card's own QR, else the page's. Every possible card is drawn; the stage
  // shows one (showListQR). On a list with nothing else to select, the
  // page's QR card is the stop, as on the TV.
  const items = page.items || [];
  const pageQR = hasAddress(page.qr);
  if (pageQR || items.some((it) => hasAddress(it.qr))) {
    const pin = el('div.tv-lqr');
    const kidsShowing = ctx.layout.showsChildren && visible(page.children).length > 0;
    const onlyQR = !items.length && !fr && !fc && !kidsShowing;
    if (pageQR) {
      const card = el('div.tv-card.tv-qr', { dataset: { qrslot: 'page' } });
      pin.append(qrCard(page.qr, page.id, 'qr', onlyQR ? stop(card, 'qr', { entry: '1' }) : card));
    }
    items.forEach((it, i) => { if (hasAddress(it.qr)) pin.append(qrCard(it.qr, page.id, `items.${i}.qr`, el('div.tv-card.tv-qr', { dataset: { qrslot: `card-${i}` } }))); });
    const firstCard = items.length && !fr && !fc ? 0 : -1;
    const on = listQRFor(page, ctx.listCard ?? firstCard)?.slot;
    pin.querySelectorAll('[data-qrslot]').forEach((n) => n.classList.toggle('on', n.dataset.qrslot === on));
    root.classList.add('has-lqr');
    root.append(list, pin);
  } else root.append(list);
  const ct = childTiles(page, ctx, !fr && !fc && !items.length); if (ct) root.append(ct);
  return root;
}

// ---- contact -------------------------------------------------------------
function renderContact(page, ctx) {
  const root = el('div.tv-page-in');
  root.append(header(page, ctx));
  const wrap = el('div.tv-contact');
  const left = el('div.l');
  const h = ctx.hotel;
  const card = (key, label, value, hint, entry) => {
    const c = stop(el('div.tv-info-card'), key, entry ? { entry: '1' } : {});
    c.append(el('div.k', label), el('div.v', value || ' '));
    if (hint) c.append(el('div.h', hint));
    return f(c, 'hotel', key, label);
  };
  if (h) {
    left.append(card('reception', 'RECEPTION', h.reception, null, true));
    left.append(card('roomService', 'ROOM SERVICE', h.roomService));
    left.append(card('wifiName', 'WI-FI', h.wifiName, h.wifiPassword ? `Password: ${h.wifiPassword}` : null));
    left.append(card('checkout', 'CHECK-OUT', h.checkout));
  }
  if (page.facts) left.append(factList(page, !h));
  const fr = frames(page, ctx, !h && !page.facts); if (fr) left.append(fr);
  const fc = filmCards(page, ctx, !h && !page.facts && !fr); if (fc) left.append(fc);
  const ct = childTiles(page, ctx, !h && !page.facts && !fr && !fc); if (ct) left.append(ct);
  const right = el('div.r');
  if (page.qr) right.append(qrBlock(page, !h && !page.facts));
  if (page.body) right.append(f(el('div.tv-address', page.body), page.id, 'body', 'Address'));
  wrap.append(left, right);
  root.append(wrap);
  return root;
}

// ---- hub (a section with no strips of its own, opened as a leaf) --------
function renderHub(page, ctx) {
  const root = el('div.tv-page-in');
  root.append(header(page, ctx));
  if (page.body) root.append(f(el('div.tv-body.dim', { style: { marginTop: '30px' } }, page.body), page.id, 'body', 'Text'));
  const extras = el('div.tv-reading', { style: { marginTop: '40px', maxWidth: '1100px' } });
  const fr = frames(page, ctx, true); if (fr) extras.append(fr);
  const fc = filmCards(page, ctx, !fr); if (fc) extras.append(fc);
  if (extras.childNodes.length) root.append(extras);
  if (ctx.layout.showsChildren) {
    const grid = el('div.tv-hub-grid');
    visible(page.children).forEach((c, i) => grid.append(tile(c, ctx, i === 0 && !fr && !fc, 420, 236)));
    const box = withChildrenHeading(page, f(grid, page.id, 'children', 'Pages under this one'));
    if (box !== grid) { box.classList.add('tv-kids-hub'); }
    root.append(box);
  }
  return root;
}

// ---- gallery (fills the leaf, ignores the chrome inset) -----------------
// Frames are the page's `slides` when it has any (photos and silent film
// loops; Rhys, 9 Nov 2026), else its `images`. A film frame shows its poster
// with a "loops silently" label: the preview never plays video.
function renderGallery(page, ctx) {
  const root = el('div.tv-gallery');
  const frames = (page.slides || []).length ? page.slides : (page.images || []).map((image) => ({ image }));
  const images = frames.map((fr) => fr.image || fr.poster || null);
  const index = Math.min(ctx.galleryIndex || 0, Math.max(0, images.length - 1));
  images.forEach((src, i) => {
    const p = el('div.tv-gphoto' + (i === index ? '.on' : ''));
    const url = ctx.media.url(src, 1920);
    if (url) p.style.backgroundImage = `url("${url}")`;
    p.dataset.photo = String(i);
    if (frames[i].film) p.append(el('div.tv-gfilm', el('span.dot'), 'Film · loops silently'));
    root.append(p);
  });
  root.append(el('div.tv-gscrim'), el('div.tv-gtop'));
  const cap = el('div.tv-gcap');
  const capIn = el('div.tv-cap-in');
  const kicker = page.kicker ?? ctx.layout.fallbackKicker;
  if (kicker) capIn.append(f(el('div.tv-kicker', kicker.toUpperCase()), page.id, 'kicker', 'Small caps line'));
  capIn.append(f(el('div.tv-title', page.title || ' '), page.id, 'title', 'Title'));
  if (images.length) capIn.append(el('div.tv-gcount', { dataset: { count: '1' } }, `${index + 1} of ${images.length}`));
  cap.append(capIn);
  const thumbs = el('div.tv-thumbs');
  images.forEach((src, i) => {
    const t = stop(el('div.tv-thumb' + (i === index ? '.on' : '') + (frames[i].film ? '.film' : '')), `photo-${i}`, { photo: String(i), ...(i === 0 ? { entry: '1' } : {}) });
    const url = ctx.media.url(src, 800);
    if (url) t.style.backgroundImage = `url("${url}")`;
    if (frames[i].film) t.append(el('span.tv-film-mark'));
    thumbs.append(f(t, page.id, `images.${i}`, frames[i].film ? `Film ${i + 1}` : `Photo ${i + 1}`));
  });
  cap.append(f(thumbs, page.id, 'images', 'Photos'));
  const ct = childTiles(page, ctx, !images.length, 300, 168);
  if (ct) {
    const row = ct.classList.contains('tv-tiles') ? ct : ct.querySelector('.tv-tiles');
    row.classList.add('tv-gtiles');
    if (ct !== row) ct.classList.add('tv-kids-g');
    cap.append(ct);
  }
  root.append(cap);
  return root;
}

// ---- finished page (stage 2b): the whole screen, exactly as made ---------
function renderFinished(page, ctx) {
  const root = el('div.tv-finished');
  const slides = page.slides || [];
  const index = Math.min(ctx.slideIndex || 0, Math.max(0, slides.length - 1));
  slides.forEach((sl, i) => {
    const s = stop(el('div.tv-slide' + (i === index ? '.on' : '') + (sl.film ? '.film' : '')), `slide-${i}`, { slide: String(i), ...(sl.film ? { film: page.title || 'Film' } : {}), ...(i === 0 ? { entry: '1' } : {}) });
    const url = ctx.media.url(sl.film ? sl.poster : sl.image, 1920);
    if (url) s.style.backgroundImage = `url("${url}")`;
    if (sl.film) s.append(playGlyph());
    root.append(f(s, page.id, `slides.${i}`, `Slide ${i + 1}`));
  });
  if (!slides.length) root.append(el('div.tv-empty', 'No slides yet. Add artwork or a film on the right.'));
  const corner = el('div.tv-fin-corner');
  if (page.qr) {
    const card = el('div.tv-fin-qr');
    card.append(f(el('div.img', qrSVG(page.qr.url || ' ', 240)), page.id, 'qr.url', 'QR web address'));
    if (page.qr.label) card.append(f(el('div.l', page.qr.label), page.id, 'qr.label', 'QR line'));
    corner.append(f(card, page.id, 'qr', 'QR link'));
  }
  if (slides.length > 1) corner.append(el('div.tv-fin-count', { dataset: { count: '1' } }, `${index + 1} of ${slides.length}`));
  root.append(corner);
  return root;
}

/** Returns {node, full} for the leaf. */
export function renderPage(page, ctx) {
  switch (page.type) {
    case 'finished': return { node: renderFinished(page, ctx), full: true };
    case 'gallery': return { node: renderGallery(page, ctx), full: true };
    case 'menu': return { node: renderMenu(page, ctx), full: false };
    case 'list': return { node: renderList(page, ctx), full: false };
    case 'contact': return { node: renderContact(page, ctx), full: false };
    case 'home': case 'hub': return { node: renderHub(page, ctx), full: false };
    default: return { node: renderInfo(page, ctx), full: false };
  }
}
