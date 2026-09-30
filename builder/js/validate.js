// Guard rails (UX spec section 6). The Builder warns, the TV copes.
// A blocker holds that page back from the bundle; a warning does not.

export const LIMITS = {
  title: 28, kicker: 30, subtitle: 60, body: 500, fact: 70, factsMax: 6,
  hoursLabel: 20, hoursValue: 40, qrLabel: 50,
  dishName: 40, dishDescription: 120, dishPrice: 12, sectionTitle: 40, sectionNote: 60,
  cardTitle: 40, cardSubtitle: 60, cardBody: 160, cardMeta: 20,
  hotelField: 40, tagline: 60,
  sectionsMax: 8, itemsMax: 8, galleryMax: 12,
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

  if (!page.title || !page.title.trim()) block('title', 'No title');
  text('title', page.title, LIMITS.title, 'Title');
  text('kicker', page.kicker, LIMITS.kicker, 'Small caps line');
  text('subtitle', page.subtitle, LIMITS.subtitle, 'Subtitle');
  text('body', page.body, LIMITS.body, 'Text');

  if (ctx.isStrip && page.type !== 'home' && !page.image) block('image', 'This strip has no photo');
  if (page.image) {
    const why = photoProblem(imageSize(page.image));
    if (why) block('image', `Photo is too small for full screen (${why})`);
  }

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

  (page.sections || []).forEach((s, si) => {
    text(`sections.${si}.title`, s.title, LIMITS.sectionTitle, `Menu part ${si + 1} name`);
    if (!s.title) block(`sections.${si}.title`, `Menu part ${si + 1} has no name`);
    text(`sections.${si}.note`, s.note, LIMITS.sectionNote, `Menu part ${si + 1} note`);
    (s.items || []).forEach((d, di) => {
      const f = `sections.${si}.items.${di}`;
      if (!d.name) block(`${f}.name`, `A dish in ${s.title || 'a menu part'} has no name`);
      text(`${f}.name`, d.name, LIMITS.dishName, `Dish "${d.name || ''}"`);
      text(`${f}.description`, d.description, LIMITS.dishDescription, `Description of ${d.name || 'a dish'}`);
      if (!d.hidden && !d.price) warn(`${f}.price`, `${d.name || 'A dish'} has no price`);
    });
  });

  (page.images || []).forEach((src, i) => {
    const why = photoProblem(imageSize(src));
    if (why) block(`images.${i}`, `Gallery photo ${i + 1} is too small for full screen (${why})`);
  });
  if (page.type === 'gallery' && !(page.images || []).length) warn('images', 'This gallery has no photos yet');

  (page.items || []).forEach((it, i) => {
    const f = `items.${i}`;
    if (!it.title) block(`${f}.title`, `Card ${i + 1} has no title`);
    text(`${f}.title`, it.title, LIMITS.cardTitle, `Card "${it.title || ''}" title`);
    text(`${f}.subtitle`, it.subtitle, LIMITS.cardSubtitle, `Card "${it.title || ''}" line`);
    text(`${f}.body`, it.body, LIMITS.cardBody, `Card "${it.title || ''}" text`);
    text(`${f}.meta`, it.meta, LIMITS.cardMeta, `Card "${it.title || ''}" date or distance`);
    if (it.image) {
      const why = photoProblem(imageSize(it.image), 'card');
      if (why) block(`${f}.image`, `Photo on card "${it.title}" is too small (${why})`);
    } else warn(`${f}.image`, `Card "${it.title || i + 1}" has no photo`);
  });

  if (page.type === 'hub' && !(page.children || []).some((c) => !c.hidden)) warn('children', 'This section has no pages a guest can open');
  if (page.type === 'home' && (page.children || []).filter((c) => !c.hidden).length > LIMITS.sectionsMax) warn('children', `More than ${LIMITS.sectionsMax} sections; the strips get thin`);
  if (page.type !== 'home' && (page.children || []).filter((c) => !c.hidden).length > LIMITS.itemsMax) warn('children', `More than ${LIMITS.itemsMax} pages inside; the strips get thin`);
  if (page.type !== 'home' && page.type !== 'hub' && !hasStop(page)) warn('body', 'Page has nothing a guest can select; the remote will rest on Back');

  return { blockers, warnings };
}

/** Mirrors StripsTree.hasStop on the TV, for a page opened in a leaf. */
export function hasStop(page) {
  const kids = (page.children || []).filter((c) => !c.hidden);
  switch (page.type) {
    case 'home': case 'hub': return kids.length > 0;
    case 'contact': return true;
    case 'gallery': return (page.images || []).length > 0;
    case 'list': return (page.items || []).length > 0;
    case 'menu': return (page.sections || []).some((s) => (s.items || []).some((d) => !d.hidden)) || (page.hours || []).length > 0 || !!page.qr;
    case 'info': return !!page.body || (page.facts || []).length > 0 || kids.length > 0 || (page.hours || []).length > 0 || !!page.qr;
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
