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

function hoursBlock(page, entry) {
  const b = stop(el('div.tv-card.tv-hours'), 'hours', entry ? { entry: '1' } : {});
  b.append(el('div.tv-kicker', 'OPENING HOURS'));
  (page.hours || []).forEach((h, i) => {
    b.append(el('div.tv-hrow',
      f(el('div.l', h.label || ' '), page.id, `hours.${i}.label`, 'Hours label'),
      f(el('div.v', h.value || ' '), page.id, `hours.${i}.value`, 'Hours')));
  });
  return f(b, page.id, 'hours', 'Opening hours');
}

function qrBlock(page, entry) {
  const b = stop(el('div.tv-card.tv-qr'), 'qr', entry ? { entry: '1' } : {});
  b.append(el('div.tv-kicker', 'ON YOUR PHONE'));
  const row = el('div.tv-qr-row');
  row.append(f(el('div.tv-qr-img', qrSVG(page.qr.url || ' ', 180)), page.id, 'qr.url', 'QR web address'));
  row.append(f(el('div.tv-qr-label', page.qr.label || ' '), page.id, 'qr.label', 'QR line'));
  b.append(row);
  return f(b, page.id, 'qr', 'QR link');
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
  let first = page.body ? 'body' : (page.facts || []).length ? 'facts' : kids.length ? 'tiles' : (page.hours || []).length ? 'hours' : page.qr ? 'qr' : null;

  const reading = el('div.tv-reading');
  if (page.body) reading.append(f(stop(el('div.tv-body.tv-text-stop', page.body), 'body', first === 'body' ? { entry: '1' } : {}), page.id, 'body', 'Text'));
  if ((page.facts || []).length) reading.append(factList(page, first === 'facts'));
  if (kids.length) {
    const row = el('div.tv-tiles');
    kids.forEach((c, i) => row.append(tile(c, ctx, first === 'tiles' && i === 0)));
    reading.append(f(row, page.id, 'children', 'Pages under this one'));
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
  if ((page.hours || []).length) menu.append(hoursBlock(page, !hasRows));
  if (page.qr) menu.append(qrBlock(page, !hasRows && !(page.hours || []).length));
  root.append(f(menu, page.id, 'sections', 'Menu'));
  return root;
}

// ---- list ----------------------------------------------------------------
function renderList(page, ctx) {
  const root = el('div.tv-page-in');
  root.append(header(page, ctx));
  const list = el('div.tv-list');
  if (page.body) list.append(f(el('div.tv-body.dim', page.body), page.id, 'body', 'Text'));
  (page.items || []).forEach((it, i) => {
    const card = stop(el('div.tv-lcard'), `card-${i}`, i === 0 ? { entry: '1' } : {});
    const img = f(el('div.img'), page.id, `items.${i}.image`, 'Card photo');
    const url = ctx.media.url(it.image, 800);
    if (url) img.style.backgroundImage = `url("${url}")`;
    const w = el('div.w');
    if (it.meta) w.append(f(el('div.m', it.meta), page.id, `items.${i}.meta`, 'Date or distance'));
    w.append(f(el('div.t', it.title || ' '), page.id, `items.${i}.title`, 'Card title'));
    if (it.subtitle) w.append(f(el('div.s', it.subtitle), page.id, `items.${i}.subtitle`, 'Card line'));
    if (it.body) w.append(f(el('div.b', it.body), page.id, `items.${i}.body`, 'Card text'));
    card.append(img, w);
    list.append(f(card, page.id, `items.${i}`, `Card ${i + 1}`));
  });
  root.append(list);
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
  if (ctx.layout.showsChildren) {
    const grid = el('div.tv-hub-grid');
    visible(page.children).forEach((c, i) => grid.append(tile(c, ctx, i === 0, 420, 236)));
    root.append(f(grid, page.id, 'children', 'Pages under this one'));
  }
  return root;
}

// ---- gallery (fills the leaf, ignores the chrome inset) -----------------
function renderGallery(page, ctx) {
  const root = el('div.tv-gallery');
  const images = page.images || [];
  const index = Math.min(ctx.galleryIndex || 0, Math.max(0, images.length - 1));
  images.forEach((src, i) => {
    const p = el('div.tv-gphoto' + (i === index ? '.on' : ''));
    const url = ctx.media.url(src, 1920);
    if (url) p.style.backgroundImage = `url("${url}")`;
    p.dataset.photo = String(i);
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
    const t = stop(el('div.tv-thumb' + (i === index ? '.on' : '')), `photo-${i}`, { photo: String(i), ...(i === 0 ? { entry: '1' } : {}) });
    const url = ctx.media.url(src, 800);
    if (url) t.style.backgroundImage = `url("${url}")`;
    thumbs.append(f(t, page.id, `images.${i}`, `Photo ${i + 1}`));
  });
  cap.append(f(thumbs, page.id, 'images', 'Photos'));
  root.append(cap);
  return root;
}

/** Returns {node, full} for the leaf. */
export function renderPage(page, ctx) {
  switch (page.type) {
    case 'gallery': return { node: renderGallery(page, ctx), full: true };
    case 'menu': return { node: renderMenu(page, ctx), full: false };
    case 'list': return { node: renderList(page, ctx), full: false };
    case 'contact': return { node: renderContact(page, ctx), full: false };
    case 'home': case 'hub': return { node: renderHub(page, ctx), full: false };
    default: return { node: renderInfo(page, ctx), full: false };
  }
}
