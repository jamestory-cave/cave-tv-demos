// The TV preview: Strips navigation drawn from the editor's model, with the
// TV app's geometry (StripsGeometry) and roles (StripRole). Two modes:
//   edit    click a strip to open it, click any text to select its field
//   remote  arrow keys, Enter, Esc drive it like the Siri Remote
//
// Known differences from the TV: no slow photo zoom, no staggered entrance
// timing beyond a simple fade, fonts are the same files but the browser's
// text layout is not SwiftUI's, and QR codes may pick a different mask.

import { el, clear } from '../util.js';
import { renderPage } from './pages.js';

export const W = 1920, H = 1080;
const SLIVER = 48, GAP = 16, MIN_CLOSED = 120, MAX_CLOSED = 300, MIN_OPEN = 420, CHROME = 190;
const FOCUS_MS = 220, LEVEL_MS = 420;

// ---- tree helpers (StripsTree) --------------------------------------------
export function hasOwnContent(page) {
  switch (page.type) {
    case 'home': case 'hub': return false;
    case 'contact': case 'finished': return true;
    default:
      return !!page.body || (page.facts || []).length > 0 || (page.hours || []).length > 0
        || (page.items || []).length > 0 || (page.sections || []).length > 0 || (page.images || []).length > 0
        || (page.photos || []).length > 0 || (page.films || []).length > 0;
  }
}

function accordion(total, count, preferredOpen) {
  if (count <= 1) return { open: total, closed: 0 };
  const others = count - 1;
  let closed = (total - preferredOpen) / others;
  closed = Math.min(Math.max(closed, MIN_CLOSED), MAX_CLOSED);
  let open = total - closed * others;
  if (open < MIN_OPEN) { open = Math.min(MIN_OPEN, total / 2); closed = (total - open) / others; }
  return { open, closed };
}

export function geometry(sectionCount, itemCount) {
  const home = accordion(W, sectionCount, W * 900 / 1920);
  const hostX = sectionCount > 1 ? (sectionCount - 1) * SLIVER + GAP : 0;
  const hostWidth = W - hostX;
  const inside = accordion(hostWidth, itemCount, hostWidth * 956 / 1616);
  const leafX = hostX + (itemCount > 1 ? (itemCount - 1) * SLIVER + GAP : 0);
  const leafWidth = W - leafX;
  const captionWidth = (open) => Math.max(240, Math.min(720, open - 180));
  return {
    home, hostX, hostWidth, inside, leafX, leafWidth, captionWidth,
    sectionSpan(k, nav) {
      if (nav.level === 0) {
        const before = k * home.closed + (k > nav.s ? home.open - home.closed : 0);
        return { x: before, width: k === nav.s ? home.open : home.closed };
      }
      if (k === nav.s) return { x: hostX, width: hostWidth };
      const slot = k < nav.s ? k : k - 1;
      return { x: slot * SLIVER, width: SLIVER };
    },
    itemSpan(k, selected, level) {
      if (level <= 1) {
        const before = k * inside.closed + (k > selected ? inside.open - inside.closed : 0);
        return { x: hostX + before, width: k === selected ? inside.open : inside.closed };
      }
      if (k === selected) return { x: leafX, width: leafWidth };
      const slot = k < selected ? k : k - 1;
      return { x: hostX + slot * SLIVER, width: SLIVER };
    },
  };
}

export class TVPreview {
  /**
   * @param host      element the preview is drawn into
   * @param opts.media       MediaRegistry (url(src, w))
   * @param opts.logoURL     the Cave logo
   * @param opts.onSelectField (pageId, field) in edit mode
   * @param opts.onNavigate  (pageId) when the preview moves to another page
   */
  constructor(host, opts) {
    this.host = host;
    this.media = opts.media;
    this.logoURL = opts.logoURL;
    this.onSelectField = opts.onSelectField || (() => {});
    this.onNavigate = opts.onNavigate || (() => {});
    this.mode = 'edit';
    this.doc = null;
    this.reveal = new Set();
    this.nav = { level: 0, s: 0, i: 0, trail: [], focus: 'strip', stop: null };
    this.galleryIndex = 0;
    this.slideIndex = 0;
    this.playing = null;
    this.selectedField = null;
    this.stripEls = new Map();
    this.build();
  }

  build() {
    const box = el('div.tv-box');
    this.viewport = el('div.tv-viewport');
    this.stage = el('div.tv-stage.edit', { tabindex: '0', 'aria-label': 'TV preview' });
    this.sectionsLayer = el('div.tv-layer.tv-sections');
    this.itemsLayer = el('div.tv-layer.tv-items');
    this.leafLayer = el('div.tv-leaf');
    this.path = el('div.tv-path', el('img', { src: this.logoURL, alt: 'Cave' }));
    this.tagline = el('div.tv-tagline');
    this.back = el('div.tv-back', el('span.tv-chev', '‹'), el('span', 'Back'));
    this.back.addEventListener('click', () => this.goBack());
    this.safe = el('div.tv-safe', el('div.tv-safe-band', el('span', 'Top band: no words here (path line and Back)')), el('div.tv-safe-margin', el('span', 'Keep words and logos inside this line')));
    this.hoverLabel = el('div.tv-hover-label');
    this.player = el('div.tv-playing');
    this.stage.append(this.sectionsLayer, this.itemsLayer, this.leafLayer, el('div.tv-scrim-top'), this.path,
      el('div.tv-slot', this.tagline, this.back), this.safe, this.hoverLabel, this.player);
    this.viewport.append(this.stage);
    box.append(this.viewport);
    clear(this.host).append(box);

    this.stage.addEventListener('click', (e) => this.onClick(e));
    this.stage.addEventListener('mouseover', (e) => this.onHover(e));
    this.stage.addEventListener('mouseleave', () => this.hoverLabel.classList.remove('on'));
    this.stage.addEventListener('keydown', (e) => {
      if (this.mode !== 'remote') return;
      const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Enter: 'enter', ' ': 'enter', Escape: 'back', Backspace: 'back' };
      const k = map[e.key];
      if (!k) return;
      e.preventDefault();
      this.key(k);
    });
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(this.viewport);
    this.onWindowResize = () => this.fit();
    window.addEventListener('resize', this.onWindowResize);
    this.fit();
  }

  destroy() { this.resize.disconnect(); window.removeEventListener('resize', this.onWindowResize); }

  fit() {
    const s = this.viewport.clientWidth / W;
    this.stage.style.transform = `scale(${s})`;
    if (this.onFit) this.onFit(s);
  }

  // ---- content -------------------------------------------------------------

  /** @param reveal ids of hidden pages to show anyway (the one being edited) */
  setDoc(doc, { reveal = [] } = {}) {
    this.doc = doc;
    this.reveal = new Set(reveal);
    this.clampNav();
    this.render(0);
  }

  visible(kids) { return (kids || []).filter((c) => !c.hidden || this.reveal.has(c.id)); }
  get sections() { return this.doc ? this.visible(this.doc.home.children) : []; }
  items(section) {
    if (!section) return [];
    const kids = this.visible(section.children);
    if (!kids.length) return [section];
    return hasOwnContent(section) ? [section, ...kids] : kids;
  }
  get section() { return this.sections[this.nav.s] || null; }
  get leafPage() {
    const inside = this.items(this.section);
    return this.nav.level === 2 ? inside[this.nav.i] || null : null;
  }
  get pageOnShow() {
    const leaf = this.leafPage;
    if (!leaf) return null;
    let page = leaf;
    for (const id of this.nav.trail) {
      const next = this.visible(page.children).find((c) => c.id === id);
      if (!next) break;
      page = next;
    }
    return page;
  }

  clampNav() {
    const n = this.nav;
    if (!this.sections.length) { Object.assign(n, { level: 0, s: 0, i: 0, trail: [] }); return; }
    n.s = Math.max(0, Math.min(n.s, this.sections.length - 1));
    const inside = this.items(this.section);
    n.i = Math.max(0, Math.min(n.i, inside.length - 1));
    if (n.level === 1 && inside.length <= 1) n.level = 2;
    // Trail pages must still exist.
    let page = inside[n.i];
    const ok = [];
    for (const id of n.trail) {
      const next = page && this.visible(page.children).find((c) => c.id === id);
      if (!next) break;
      ok.push(id); page = next;
    }
    n.trail = ok;
  }

  /**
   * Moves the preview so that `pageId` is on show. With `asStrip`, a section
   * is shown focused on the home screen and a page inside a section as the
   * open strip, the way a guest first meets them.
   */
  showPage(pageId, { asStrip = false } = {}) {
    if (!this.doc) return;
    const n = this.nav;
    if (pageId === 'home') { Object.assign(n, { level: 0, trail: [], focus: 'strip', stop: null }); this.render(LEVEL_MS); return; }
    const secs = this.sections;
    for (let s = 0; s < secs.length; s++) {
      const inside = this.items(secs[s]);
      if (secs[s].id === pageId && asStrip) {
        Object.assign(n, { level: 0, s, i: 0, trail: [], focus: 'strip', stop: null });
        this.render(LEVEL_MS);
        return;
      }
      if (asStrip && inside.length > 1) {
        const i = inside.findIndex((p, k) => p.id === pageId && !(k === 0 && p.id === secs[s].id));
        if (i >= 0) { Object.assign(n, { level: 1, s, i, trail: [], focus: 'strip', stop: null }); this.render(LEVEL_MS); return; }
      }
      if (secs[s].id === pageId) {
        // A section: its strips if it has any, else itself as the leaf.
        const own = inside.length > 1 && inside[0].id === pageId;
        Object.assign(n, { level: own ? 2 : (inside.length > 1 ? 1 : 2), s, i: 0, trail: [], focus: 'strip', stop: null });
        this.galleryIndex = 0;
        this.render(LEVEL_MS);
        return;
      }
      for (let i = 0; i < inside.length; i++) {
        if (inside[i].id === secs[s].id) continue;
        const trail = this.trailTo(pageId, inside[i]);
        if (trail) {
          Object.assign(n, { level: 2, s, i, trail: trail.slice(1), focus: 'strip', stop: null });
          this.galleryIndex = 0;
          this.render(LEVEL_MS);
          return;
        }
      }
    }
  }

  trailTo(target, page) {
    if (page.id === target) return [page.id];
    for (const c of this.visible(page.children)) {
      const rest = this.trailTo(target, c);
      if (rest) return [page.id, ...rest];
    }
    return null;
  }

  // ---- modes ---------------------------------------------------------------

  setMode(mode) {
    this.mode = mode;
    this.stage.classList.toggle('edit', mode === 'edit');
    this.stage.classList.toggle('remote', mode === 'remote');
    if (mode === 'remote') {
      if (this.nav.level === 2) this.focusEntry();
      this.stage.focus({ preventScroll: true });
    } else {
      this.nav.focus = 'strip'; this.nav.stop = null;
    }
    this.render(0);
    this.fit();
  }

  setSafeArea(on) { this.stage.classList.toggle('show-safe', !!on); }

  setSelectedField(key) {
    this.selectedField = key;
    this.stage.querySelectorAll('[data-f].is-selected').forEach((n) => n.classList.remove('is-selected'));
    if (!key) return;
    const target = [...this.stage.querySelectorAll('[data-f]')].find((n) => n.dataset.f === key)
      || [...this.stage.querySelectorAll('[data-f]')].find((n) => key.startsWith(n.dataset.f + '.') || n.dataset.f === key.split('.').slice(0, -1).join('.'));
    if (target) target.classList.add('is-selected');
  }

  // ---- rendering -----------------------------------------------------------

  render(ms) {
    if (!this.doc) return;
    this.stage.style.setProperty('--dur', ms + 'ms');
    const secs = this.sections;
    const n = this.nav;
    const inside = n.level > 0 ? this.items(this.section) : [];
    const g = geometry(secs.length, inside.length);

    // Sections.
    this.syncStrips(this.sectionsLayer, 'sec', secs, (k) => g.sectionSpan(k, n), (k) => {
      if (n.level === 0) return k === n.s ? ['is-current', 'is-focused'] : ['is-closed'];
      return k === n.s ? ['is-host'] : ['is-sliver'];
    }, () => null, g.captionWidth(g.home.open));

    // Items.
    this.syncStrips(this.itemsLayer, 'item', inside, (k) => g.itemSpan(k, n.i, n.level), (k) => {
      if (n.level >= 2) return k === n.i ? ['is-leaf'] : ['is-sliver'];
      return k === n.i ? (n.focus === 'strip' ? ['is-current', 'is-focused'] : ['is-current']) : ['is-closed'];
    }, (page) => page.kicker ?? this.section?.title ?? '', g.captionWidth(g.inside.open));

    // Chrome. A finished page takes the whole screen: slivers hidden, path line and Back kept.
    const fin = n.level === 2 && this.pageOnShow?.type === 'finished';
    this.stage.classList.toggle('finished', fin);
    this.stage.classList.toggle('deep', n.level > 0);
    this.back.classList.toggle('is-focused', n.level > 0 && n.focus === 'back');
    this.tagline.textContent = this.doc.hotel?.tagline || '';
    this.renderPath();

    // Leaf. The page area's scroll position survives a re-render (typing a caption must not jump to the top).
    const keepScroll = this.pageEl ? this.pageEl.scrollTop : 0;
    clear(this.leafLayer);
    this.pageEl = null;
    if (n.level === 2 && this.leafPage) {
      this.leafLayer.style.left = (fin ? 0 : g.leafX) + 'px';
      this.leafLayer.style.width = (fin ? W : g.leafWidth) + 'px';
      this.leafLayer.style.display = '';
      this.renderLeaf(fin ? { ...g, leafX: 0, leafWidth: W } : g);
      if (keepScroll && this.pageEl && !this.pageEl.classList.contains('tv-full')) this.pageEl.scrollTop = keepScroll;
    } else {
      this.leafLayer.style.display = 'none';
    }
    if (!secs.length) {
      this.sectionsLayer.append(el('div.tv-empty', 'No sections to show. Add one on Home.'));
    }
    if (this.selectedField) this.setSelectedField(this.selectedField);
  }

  syncStrips(layer, kind, pages, span, roles, label, captionWidth) {
    const keep = new Set();
    pages.forEach((page, k) => {
      const key = `${kind}:${page.id}`;
      keep.add(key);
      let strip = this.stripEls.get(key);
      if (!strip) {
        strip = this.makeStrip(kind, page);
        this.stripEls.set(key, strip);
        layer.append(strip);
        strip.classList.add('is-enter');
        requestAnimationFrame(() => strip.classList.remove('is-enter'));
      } else if (strip.parentNode !== layer) layer.append(strip);
      const s = span(k);
      strip.style.left = s.x + 'px';
      strip.style.width = s.width + 'px';
      strip.style.zIndex = String(k + 1);
      strip.className = 'tv-strip tv-clickable ' + roles(k).join(' ');
      strip.dataset.kind = kind;
      strip.dataset.index = String(k);
      strip.querySelector('.tv-vname').textContent = page.title || '';
      strip.querySelector('.tv-hname').textContent = page.title || '';
      strip.querySelector('.tv-caption').style.width = captionWidth + 'px';
      const lab = label(page);
      const labEl = strip.querySelector('.tv-label');
      labEl.textContent = lab ? lab.toUpperCase() : '';
      labEl.style.display = lab ? '' : 'none';
      const isLeaf = roles(k).includes('is-leaf');
      const bg = isLeaf && page.backgroundFilm?.poster ? page.backgroundFilm.poster : page.image;
      const url = this.media.url(bg, 1920);
      const photo = strip.querySelector('.tv-photo');
      const want = url ? `url("${url}")` : '';
      if (photo.style.backgroundImage !== want) photo.style.backgroundImage = want;
      strip.dataset.f = `${page.id}|image`;
      strip.dataset.label = `Photo: ${page.title}`;
    });
    for (const [key, strip] of this.stripEls) {
      if (key.startsWith(kind + ':') && !keep.has(key)) { strip.remove(); this.stripEls.delete(key); }
    }
  }

  makeStrip(kind, page) {
    const s = el('div.tv-strip', { dataset: { kind, id: page.id } });
    s.append(el('div.tv-photo'), el('div.tv-scrim'), el('div.tv-grad'), el('div.tv-ring'), el('div.tv-vname'),
      el('div.tv-caption', el('div.tv-label'), el('div.tv-hname')));
    return s;
  }

  renderPath() {
    const n = this.nav;
    const steps = [];
    if (n.level > 0 && this.section) {
      steps.push(this.section.title);
      const leaf = this.leafPage;
      if (leaf) {
        if (leaf.id !== this.section.id) steps.push(leaf.title);
        let page = leaf;
        for (const id of n.trail) {
          page = this.visible(page.children).find((c) => c.id === id);
          if (!page) break;
          steps.push(page.title);
        }
      }
    }
    this.path.querySelectorAll('.tv-seg').forEach((x) => x.remove());
    steps.forEach((t, k) => this.path.append(el('span.tv-seg' + (k === steps.length - 1 ? '.cur' : ''), el('span.tv-chev', '›'), el('span', t))));
  }

  renderLeaf(g) {
    const n = this.nav;
    const page = this.pageOnShow;
    if (!page) return;
    if (n.trail.length && page.type !== 'finished') {
      const bd = el('div.tv-backdrop');
      const url = this.media.url(page.backgroundFilm?.poster || page.image, 1920);
      if (url) bd.style.backgroundImage = `url("${url}")`;
      this.leafLayer.append(bd);
    }
    if (page.backgroundFilm?.film) {
      const lab = el('div.tv-bgfilm', el('span.dot'), 'Background film · loops silently');
      lab.dataset.f = `${page.id}|backgroundFilm`;
      lab.dataset.label = 'Background film';
      this.leafLayer.append(lab);
    }
    const layout = {
      width: g.leafWidth, contentWidth: g.leafWidth - 144,
      showsChildren: !(n.trail.length === 0 && page.id === this.section?.id),
      fallbackKicker: this.section?.title || null,
    };
    const { node, full } = renderPage(page, { hotel: this.doc.hotel, layout, media: this.media, galleryIndex: this.galleryIndex, slideIndex: this.slideIndex });
    this.pageEl = el('div.tv-page' + (full ? '.tv-full' : ''), node);
    this.leafLayer.append(this.pageEl);
    if (this.mode === 'remote') this.applyFocus();
  }

  // ---- edit mode -----------------------------------------------------------

  onClick(e) {
    if (this.mode !== 'edit') return;
    const strip = e.target.closest('.tv-strip');
    const field = e.target.closest('[data-f]');
    const stopEl = e.target.closest('[data-stop]');
    if (stopEl?.dataset.child) {
      this.openChild(stopEl.dataset.child);
      return;
    }
    if (e.target.closest('.tv-fin-count')) {
      // The counter steps through the slides in edit mode.
      this.showSlide((this.slideIndex + 1) % this.pageEl.querySelectorAll('.tv-slide').length);
      return;
    }
    if (field && field !== strip) {
      const [pageId, f] = field.dataset.f.split('|');
      this.onSelectField(pageId, f);
      return;
    }
    if (strip) {
      const k = Number(strip.dataset.index);
      if (strip.dataset.kind === 'sec') {
        if (this.nav.level === 0) { if (k === this.nav.s) this.openSection(k); else { this.nav.s = k; this.render(FOCUS_MS); } }
        else if (k !== this.nav.s) { this.nav.level = 0; this.nav.s = k; this.nav.trail = []; this.render(LEVEL_MS); this.announce(); }
        else this.goBack();
      } else {
        if (this.nav.level === 1) { if (k === this.nav.i) this.openItem(k); else { this.nav.i = k; this.render(FOCUS_MS); } }
        else if (k !== this.nav.i) { this.nav.i = k; this.nav.trail = []; this.render(LEVEL_MS); this.announce(); }
        else if (strip.dataset.f) { const [pageId, f] = strip.dataset.f.split('|'); this.onSelectField(pageId, f); }
      }
    }
  }

  onHover(e) {
    if (this.mode !== 'edit') return;
    const field = e.target.closest('[data-f]');
    if (!field) { this.hoverLabel.classList.remove('on'); return; }
    const r = field.getBoundingClientRect();
    const s = this.stage.getBoundingClientRect();
    const scale = s.width / W;
    this.hoverLabel.textContent = field.dataset.label || '';
    this.hoverLabel.style.left = Math.max(0, (r.left - s.left) / scale) + 'px';
    this.hoverLabel.style.top = Math.max(0, (r.top - s.top) / scale - 40) + 'px';
    this.hoverLabel.classList.add('on');
  }

  announce() {
    const page = this.pageOnShow || (this.nav.level === 1 ? this.section : null) || this.doc.home;
    if (page) this.onNavigate(page.id);
  }

  // ---- navigation (mirrors StripsView) --------------------------------------

  openSection(k) {
    const inside = this.items(this.sections[k]);
    const direct = inside.length <= 1;
    Object.assign(this.nav, { level: direct ? 2 : 1, s: k, i: 0, trail: [], focus: 'strip', stop: null });
    this.galleryIndex = 0; this.slideIndex = 0;
    this.render(LEVEL_MS);
    if (direct && this.mode === 'remote') this.focusEntry();
    this.announce();
  }

  openItem(k) {
    Object.assign(this.nav, { i: k, level: 2, trail: [], focus: 'strip', stop: null });
    this.galleryIndex = 0; this.slideIndex = 0;
    this.render(LEVEL_MS);
    if (this.mode === 'remote') this.focusEntry();
    this.announce();
  }

  openChild(id) {
    const page = this.pageOnShow;
    if (!page || !this.visible(page.children).some((c) => c.id === id)) return;
    this.nav.trail.push(id);
    this.nav.stop = null;
    this.galleryIndex = 0; this.slideIndex = 0;
    this.render(LEVEL_MS);
    if (this.mode === 'remote') this.focusEntry();
    this.announce();
  }

  goBack() {
    const n = this.nav;
    if (this.playing) { this.stopPlaying(); return; }
    if (n.level === 0) return;
    this.slideIndex = 0;
    if (n.level === 2 && n.trail.length) {
      const left = n.trail.pop();
      n.stop = null;
      this.render(LEVEL_MS);
      if (this.mode === 'remote') this.focusEntry(`child-${left}`);
      this.announce();
      return;
    }
    if (n.level === 2 && this.items(this.section).length > 1) {
      n.level = 1; n.focus = 'strip'; n.stop = null;
      this.render(LEVEL_MS);
      this.announce();
      return;
    }
    n.level = 0; n.focus = 'strip'; n.stop = null; n.trail = [];
    this.render(LEVEL_MS);
    this.announce();
  }

  // ---- remote mode ----------------------------------------------------------

  stops() { return this.pageEl ? [...this.pageEl.querySelectorAll('[data-stop]')] : []; }

  focusEntry(preferred) {
    const stops = this.stops();
    if (!stops.length) { this.nav.focus = 'back'; this.nav.stop = null; this.applyFocus(); return; }
    let target = preferred ? stops.find((s) => s.dataset.stop === preferred) : null;
    if (!target) target = stops.find((s) => s.dataset.entry) || stops[0];
    this.nav.focus = 'page';
    this.nav.stop = target.dataset.stop;
    this.applyFocus();
  }

  applyFocus() {
    const n = this.nav;
    this.back.classList.toggle('is-focused', n.level > 0 && n.focus === 'back');
    for (const s of this.stops()) {
      const on = n.focus === 'page' && s.dataset.stop === n.stop;
      s.classList.toggle('is-focused', on);
      if (on) {
        if (s.dataset.photo !== undefined) this.showPhoto(Number(s.dataset.photo));
        this.scrollTo(s);
      }
    }
    if (n.level === 1) {
      const strip = this.stripEls.get(`item:${this.items(this.section)[n.i]?.id}`);
      if (strip) strip.classList.toggle('is-focused', n.focus === 'strip');
    }
  }

  showPhoto(i) {
    this.galleryIndex = i;
    this.pageEl.querySelectorAll('.tv-gphoto').forEach((p) => p.classList.toggle('on', Number(p.dataset.photo) === i));
    this.pageEl.querySelectorAll('.tv-thumb').forEach((t) => t.classList.toggle('on', Number(t.dataset.photo) === i));
    const count = this.pageEl.querySelector('[data-count]');
    if (count) count.textContent = `${i + 1} of ${this.pageEl.querySelectorAll('.tv-gphoto').length}`;
  }

  showSlide(i) {
    const slides = this.pageEl ? [...this.pageEl.querySelectorAll('.tv-slide')] : [];
    if (!slides.length) return;
    this.slideIndex = Math.max(0, Math.min(i, slides.length - 1));
    slides.forEach((s) => s.classList.toggle('on', Number(s.dataset.slide) === this.slideIndex));
    const count = this.pageEl.querySelector('[data-count]');
    if (count) count.textContent = `${this.slideIndex + 1} of ${slides.length}`;
    if (this.mode === 'remote') { this.nav.focus = 'page'; this.nav.stop = `slide-${this.slideIndex}`; this.applyFocus(); }
  }

  /** The preview never plays video: Select on a film shows a placeholder the TV's player would replace. */
  play(title) {
    this.playing = title || 'Film';
    clear(this.player).append(el('div.t', 'Playing: ' + this.playing), el('div.s', 'The TV opens its own player here, full screen with sound. Menu (Esc) stops it and returns to the page.'));
    this.player.classList.add('on');
  }

  stopPlaying() {
    this.playing = null;
    this.player.classList.remove('on');
    this.applyFocus();
  }

  /** Position of a node inside the page area, in TV pixels, independent of nesting and the stage scale. */
  pageOffset(node) {
    const page = this.pageEl;
    const scale = this.stage.getBoundingClientRect().width / W || 1;
    const r = node.getBoundingClientRect(), pr = page.getBoundingClientRect();
    return { top: (r.top - pr.top) / scale + page.scrollTop, height: r.height / scale };
  }

  scrollTo(s) {
    const page = this.pageEl;
    if (!page || page.classList.contains('tv-full')) return;
    const { top: t, height } = this.pageOffset(s);
    const top = t - 30;
    const bottom = t + height + 30;
    if (top < page.scrollTop) page.scrollTop = Math.max(0, top);
    else if (bottom > page.scrollTop + page.clientHeight) page.scrollTop = bottom - page.clientHeight;
  }

  /**
   * Scrolls the page area so the field `key` ("pageId|field") is in view, as
   * the TV would scroll to it. Heading fields keep the heading at the top;
   * a field inside a list (photos.2.caption) reveals its row.
   */
  revealField(key) {
    const page = this.pageEl;
    if (!page || page.classList.contains('tv-full')) return;
    const [pageId, field] = key.split('|');
    if (['title', 'kicker', 'subtitle', 'description'].includes(field)) { page.scrollTop = 0; return; }
    const all = [...page.querySelectorAll('[data-f]')];
    const exact = all.find((n) => n.dataset.f === key);
    const parts = field.split('.');
    const target = exact || all.find((n) => n.dataset.f === `${pageId}|${parts.slice(0, 2).join('.')}`) || all.find((n) => n.dataset.f === `${pageId}|${parts[0]}`);
    if (!target) return;
    const { top, height } = this.pageOffset(target);
    if (height + 60 >= page.clientHeight || top - 40 < page.scrollTop || top + height + 40 > page.scrollTop + page.clientHeight) {
      page.scrollTop = Math.max(0, top - 40);
    }
  }

  key(k) {
    const n = this.nav;
    if (this.playing) { if (k === 'back' || k === 'enter') this.stopPlaying(); return; }
    if (k === 'back') { this.goBack(); return; }
    if (n.level === 0) {
      if (k === 'left' && n.s > 0) { n.s--; this.render(FOCUS_MS); }
      else if (k === 'right' && n.s < this.sections.length - 1) { n.s++; this.render(FOCUS_MS); }
      else if (k === 'enter') this.openSection(n.s);
      return;
    }
    if (n.level === 1) {
      const count = this.items(this.section).length;
      if (n.focus === 'strip') {
        if (k === 'left') { if (n.i > 0) { n.i--; this.render(FOCUS_MS); } else this.goBack(); }
        else if (k === 'right') { if (n.i < count - 1) { n.i++; this.render(FOCUS_MS); } }
        else if (k === 'up') { n.focus = 'back'; this.render(FOCUS_MS); }
        else if (k === 'enter') this.openItem(n.i);
      } else {
        if (k === 'down') { n.focus = 'strip'; this.render(FOCUS_MS); }
        else if (k === 'left' || k === 'enter') this.goBack();
      }
      return;
    }
    // Level 2: Back or a stop inside the page.
    if (n.focus === 'back') {
      if (k === 'down') this.focusEntry(n.stop || undefined);
      else if (k === 'left' || k === 'enter') this.goBack();
      return;
    }
    const stops = this.stops();
    const cur = stops.find((s) => s.dataset.stop === n.stop);
    if (!cur) { this.focusEntry(); return; }
    if (this.pageOnShow?.type === 'finished') {
      // Left and Right move between slides, no wrap; Left on the first slide (or Up) reaches Back.
      const count = stops.filter((s) => s.dataset.slide !== undefined).length;
      if (k === 'right') { if (this.slideIndex < count - 1) this.showSlide(this.slideIndex + 1); return; }
      if (k === 'left') { if (this.slideIndex > 0) this.showSlide(this.slideIndex - 1); else { n.focus = 'back'; this.applyFocus(); } return; }
      if (k === 'up') { n.focus = 'back'; this.applyFocus(); return; }
      if (k === 'enter' && cur.dataset.film) this.play(cur.dataset.film);
      return;
    }
    if (k === 'enter') {
      if (cur.dataset.child) this.openChild(cur.dataset.child);
      else if (cur.dataset.film) this.play(cur.dataset.film);
      return;
    }
    const next = this.neighbour(cur, stops, k);
    if (next) { n.stop = next.dataset.stop; this.applyFocus(); return; }
    if (k === 'up' || k === 'left') { n.focus = 'back'; this.applyFocus(); }
  }

  /** The nearest stop in a direction, the way tvOS's focus engine would pick it. */
  neighbour(cur, stops, dir) {
    const a = cur.getBoundingClientRect();
    const ax = (a.left + a.right) / 2, ay = (a.top + a.bottom) / 2;
    let best = null, bestScore = Infinity;
    for (const s of stops) {
      if (s === cur) continue;
      const b = s.getBoundingClientRect();
      const bx = (b.left + b.right) / 2, by = (b.top + b.bottom) / 2;
      let primary, secondary;
      switch (dir) {
        case 'down': primary = b.top - a.bottom; secondary = Math.abs(bx - ax); if (by <= ay) continue; break;
        case 'up': primary = a.top - b.bottom; secondary = Math.abs(bx - ax); if (by >= ay) continue; break;
        case 'right': primary = b.left - a.right; secondary = Math.abs(by - ay); if (bx <= ax) continue; break;
        case 'left': primary = a.left - b.right; secondary = Math.abs(by - ay); if (bx >= ax) continue; break;
        default: continue;
      }
      // Overlap on the cross axis is strongly preferred, as on tvOS.
      const overlap = dir === 'down' || dir === 'up'
        ? Math.min(a.right, b.right) - Math.max(a.left, b.left)
        : Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const score = Math.max(primary, 0) + (overlap > 0 ? 0 : secondary * 2 + 1000);
      if (score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  }
}
