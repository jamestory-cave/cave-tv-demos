// Draft document -> ContentBundle JSON exactly as Content.swift decodes it.
// Keys come out in the order Content.swift declares them, empty values are
// left out, hidden pages and dishes are dropped, held-back pages are dropped.

const PAGE_KEYS = ['id', 'type', 'title', 'subtitle', 'kicker', 'image', 'body', 'facts', 'hours', 'qr', 'children', 'sections', 'images', 'items'];
const HOTEL_KEYS = ['name', 'tagline', 'reception', 'roomService', 'wifiName', 'wifiPassword', 'checkout'];

const present = (v) => !(v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0));
const str = (v) => (present(v) ? String(v) : undefined);

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
    return out;
  });
}

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
  };
  const out = {};
  for (const k of PAGE_KEYS) if (present(raw[k])) out[k] = raw[k];
  return out;
}

/**
 * Builds the bundle. `held` is the Map from validateAll (pages with blockers
 * are left out along with everything under them). Returns {bundle, heldBack}.
 */
export function buildBundle(doc, { revision, held } = {}) {
  const hotel = {};
  for (const k of HOTEL_KEYS) hotel[k] = doc.hotel?.[k] ?? '';
  const home = cleanPage(doc.home, null) || { id: 'home', type: 'home', title: doc.home.title || '' };
  // Held pages are removed after cleaning so the home page itself is never lost.
  const drop = (page) => {
    page.children = (page.children || []).filter((c) => !held?.get(c.id)?.held).map(drop);
    if (!page.children.length) delete page.children;
    return page;
  };
  const bundle = { version: revision ?? doc.version ?? 1, hotel, home: held ? drop(home) : home };
  const heldBack = [];
  if (held) for (const [id, r] of held) if (r.held && id !== 'hotel') heldBack.push({ id, blockers: r.blockers });
  return { bundle, heldBack };
}

/** Pretty JSON, 2-space, trailing newline, as seed.py writes it. */
export function bundleText(bundle) {
  return JSON.stringify(bundle, null, 2) + '\n';
}
