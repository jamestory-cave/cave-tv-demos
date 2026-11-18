// The TV preview: Strips navigation drawn from the editor's model, with the
// TV app's geometry (StripsGeometry) and roles (StripRole). Two modes:
//   edit    click a strip to open it, click any text to select its field
//   remote  arrow keys, Enter, Esc drive it like the Siri Remote
//
// Background film (mirrors the TV, 1 Oct 2026): on a page with a background
// film the text layer and scrim fade to 10% after 6 s without input so the
// film shows; any press brings the text back (a move also acts; Select and
// Menu only restore). Select on a text block, facts or hours hides the text
// at once.
//
// The better gallery (phase B, SPEC 5.3): in "Try the remote" the gallery
// walks as the TV does: thumbnails, the chapter row, the full-screen viewer
// (Left / Right, Down for the strip, Select for the caption or to play a film
// with sound, Play/Pause for the slideshow, Menu back to the leaf on the same
// frame, the words fading after 4 s), the slideshow style (one stop, Left /
// Right hold it for 30 s) and "plays by itself" after 20 s untouched. Timers
// run only in remote mode; edit mode stays still.
//
// Known differences from the TV: no slow photo zoom, no staggered entrance
// timing beyond a simple fade, fonts are the same files but the browser's
// text layout is not SwiftUI's, and QR codes may pick a different mask.
// The preview never plays video: a silent loop is its poster for its turn.

import { el, clear } from '../util.js';
import { renderPage, listQRFor, renderGalleryViewer } from './pages.js';
import { framesOf, galleryOptions, IDLE_BEFORE_AUTOPLAY_MS, HOLD_MS, VIEWER_FADE_MS, MARK_MS, GALLERY_WORDS as W8 } from '../gallery.js';

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
        || (page.photos || []).length > 0 || (page.films || []).length > 0
        || (page.type === 'gallery' && (page.slides || []).length > 0)
        || (page.type === 'list' && !!page.qr?.url);   // a list with only a QR code: its card is a stop (StripsModel)
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
    this.faded = false;
    this.idleTimer = null;
    this.fadeAfterMs = 6000;
    // The gallery's clocks (SPEC 5.2, 5.3). Tests may shorten them.
    this.gal = { pageId: null, running: false, paused: false, held: false };
    this.galTimers = {};
    this.viewer = null;            // the full-screen viewer: {strip, captionHidden, slideshow, mark}
    this.viewerFaded = false;
    this.timing = { idleBeforeAutoplay: IDLE_BEFORE_AUTOPLAY_MS, hold: HOLD_MS, viewerFade: VIEWER_FADE_MS, mark: MARK_MS, secondsScale: 1 };
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
    this.safe = el('div.tv-safe', el('div.tv-safe-band', el('span', 'Top band: no words here (path line and Back)')), el('div.tv-safe-margin', el('span', 'Keep words and logos inside this line')),
      el('div.tv-safe-qr', el('span', 'QR card: keep this 340 × 430 px clear')));
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
      // Space is Play/Pause, as on the demo page (SPEC 6.4).
      const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Enter: 'enter', ' ': 'playpause', Escape: 'back', Backspace: 'back' };
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

  destroy() { this.resize.disconnect(); window.removeEventListener('resize', this.onWindowResize); clearTimeout(this.idleTimer); this.stopGalleryClocks(); clearTimeout(this.viewerFadeTimer); clearTimeout(this.markTimer); }

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
    // A list page's QR column follows the card being edited, as it follows focus on the TV.
    // In remote mode focus decides instead.
    const editing = this.mode === 'edit';
    const card = /\|items\.(\d+)/.exec(key);
    if (editing && card) this.showListQR(Number(card[1]));
    else if (editing && /\|qr(\.|$)/.test(key)) this.showListQR(-1);
    // A gallery frame being edited is the one on show.
    const frame = /\|images\.(\d+)/.exec(key);
    if (editing && frame && this.pageEl?.querySelector(`.tv-gphoto[data-photo="${frame[1]}"]`)) {
      this.showPhoto(Number(frame[1]));
      this.pageEl.querySelector(`.tv-thumb[data-photo="${frame[1]}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
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

    // A different page on show: the gallery's state starts again (frame 1, no viewer, clocks stopped).
    const galPage = n.level === 2 && this.pageOnShow?.type === 'gallery' ? this.pageOnShow : null;
    if ((galPage?.id || null) !== this.gal.pageId) this.resetGallery(galPage);
    if (this.mode !== 'remote' && this.viewer) this.viewer = null;

    // Chrome. A finished page takes the whole screen: slivers hidden, path line and Back kept. So does the gallery's viewer.
    const viewer = !!(galPage && this.viewer);
    const fin = n.level === 2 && (this.pageOnShow?.type === 'finished' || viewer);
    this.stage.classList.toggle('viewer', viewer);
    if (!viewer) this.stage.classList.remove('viewer-faded');
    this.stage.classList.toggle('finished', fin);
    this.stage.classList.toggle('has-qr', fin && !!this.pageOnShow?.qr);
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
    // Any change of what is on show brings the text back and restarts the idle clock.
    this.setFaded(false);
    this.armIdle();
    this.syncGalleryClocks();
  }

  // ---- background film: the text fades so the film shows (as on the TV) ------

  /** True when the page on show has a background film and the text may fade. */
  canFade() {
    const page = this.pageOnShow;
    return this.mode === 'remote' && this.nav.level === 2 && !this.playing && !!page?.backgroundFilm?.film && page.type !== 'finished';
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.canFade()) return;
    this.idleTimer = setTimeout(() => { this.idleTimer = null; if (this.canFade()) this.setFaded(true); }, this.fadeAfterMs);
  }

  setFaded(on) {
    this.faded = !!on;
    this.stage.classList.toggle('text-faded', this.faded);
    const lab = this.leafLayer.querySelector('.tv-bgfilm');
    if (lab) lab.lastChild.textContent = this.faded ? 'Background film · text faded · any press brings it back' : 'Background film · loops silently';
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
    if (this.listCardPage !== page.id) { this.listCardPage = page.id; this.listCard = undefined; }
    const ctx = { hotel: this.doc.hotel, layout, media: this.media, galleryIndex: this.galleryIndex, slideIndex: this.slideIndex, listCard: this.listCard, galleryState: this.galleryStateText(page) };
    const { node, full } = page.type === 'gallery' && this.viewer ? { node: renderGalleryViewer(page, { ...ctx, viewer: this.viewer }), full: true } : renderPage(page, ctx);
    this.pageEl = el('div.tv-page' + (full ? '.tv-full' : ''), node);
    this.leafLayer.append(this.pageEl);
    if (page.type === 'gallery') { this.pageEl.querySelector('.tv-gallery')?.classList.toggle('running', this.gal.running); requestAnimationFrame(() => this.scrollStrips(this.galleryIndex)); }
    // A list's QR card is pinned bottom-right of the page area and stays put while the list scrolls.
    const pin = this.pageEl.querySelector('.tv-lqr');
    if (pin) { pin.classList.add('tv-lqr-pin'); this.leafLayer.append(pin); }
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
    if (this.viewer) { this.closeViewer(); return; }
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

  stops() { return this.pageEl ? [...this.pageEl.querySelectorAll('[data-stop]'), ...this.leafLayer.querySelectorAll('.tv-lqr-pin [data-stop]')] : []; }

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
        if (s.dataset.card !== undefined) this.showListQR(Number(s.dataset.card));
        this.scrollTo(s);
      }
    }
    if (n.level === 1) {
      const strip = this.stripEls.get(`item:${this.items(this.section)[n.i]?.id}`);
      if (strip) strip.classList.toggle('is-focused', n.focus === 'strip');
    }
  }

  /** Shows frame i of the gallery on show: every per-frame element (photo, caption, counter, thumbnail, dot) by data-photo, the chapter it is in, the rows scrolled to it. */
  showPhoto(i) {
    this.galleryIndex = i;
    const root = this.pageEl;
    if (!root) return;
    root.querySelectorAll('[data-photo]').forEach((p) => p.classList.toggle('on', Number(p.dataset.photo) === i));
    root.querySelectorAll('.tv-chip').forEach((c) => c.classList.toggle('cur', i >= Number(c.dataset.chapter) && i <= Number(c.dataset.runEnd)));
    root.querySelectorAll('.tv-vstrip .tv-thumb').forEach((t) => t.classList.toggle('is-focused', Number(t.dataset.photo) === i));
    const count = root.querySelector('[data-count]');
    if (count) count.textContent = `${i + 1} of ${root.querySelectorAll('.tv-gphoto').length}`;
    this.scrollStrips(i);
  }

  /** Keeps the current thumbnail and chapter in view (the rows slide, as on the TV). */
  scrollStrips(i) {
    const root = this.pageEl;
    if (!root) return;
    const slide = (inner, item, lead) => {
      if (!inner || !item) return;
      const box = inner.parentNode;
      const cs = getComputedStyle(box);
      const visible = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const x = Math.max(0, Math.min(item.offsetLeft - lead, inner.scrollWidth - visible));
      inner.style.transform = x > 0 ? `translateX(${-x}px)` : '';
    };
    slide(root.querySelector('.tv-thumbs .tv-strip-in'), root.querySelector(`.tv-thumbs .tv-thumb[data-photo="${i}"]`), 2 * 252);
    slide(root.querySelector('.tv-vstrip .tv-strip-in'), root.querySelector(`.tv-vstrip .tv-thumb[data-photo="${i}"]`), 4 * 252);
    slide(root.querySelector('.tv-gchips .tv-strip-in'), root.querySelector('.tv-chip.is-focused') || root.querySelector('.tv-chip.cur'), 160);
  }

  /** On a list page, shows the QR for card `i` (its own, else the page's); -1 for the page's. */
  showListQR(i) {
    const page = this.pageOnShow;
    if (!this.pageEl || page?.type !== 'list') return;
    this.listCard = i;
    const on = listQRFor(page, i)?.slot;
    this.leafLayer.querySelectorAll('[data-qrslot]').forEach((n) => n.classList.toggle('on', n.dataset.qrslot === on));
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
    this.armIdle();
    clear(this.player).append(el('div.t', 'Playing: ' + this.playing), el('div.s', 'The TV opens its own player here, full screen with sound. Menu (Esc) stops it and returns to the page.'));
    this.player.classList.add('on');
  }

  stopPlaying() {
    this.playing = null;
    this.player.classList.remove('on');
    this.applyFocus();
    this.armIdle();
    if (this.viewer) this.wakeViewer();
    this.syncGalleryClocks();
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
    if (!page || page.classList.contains('tv-full') || !page.contains(s)) return;
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
    if (this.playing) { if (k === 'back' || k === 'enter' || k === 'playpause') this.stopPlaying(); return; }
    // The viewer's words have faded: Select and Menu only bring them back; a move also moves.
    // The viewer, as the TV: Select on a film with sound plays it even while the words are faded;
    // otherwise, faded, Select only brings the words back. The first Menu stops a running slideshow
    // and brings the words back; the next Menu leaves. Play/Pause toggles at once (and wakes).
    if (this.viewer && n.focus !== 'back') {
      const vp = this.galleryPage();
      const fr = vp ? framesOf(vp)[this.galleryIndex] : null;
      if (k === 'enter' && this.viewerFaded && fr?.film && fr.sound === true) { this.wakeViewer(); this.playFrame(vp, framesOf(vp), this.galleryIndex); return; }
      if ((k === 'enter' && this.viewerFaded) || (k === 'back' && (this.viewerFaded || this.viewer.slideshow))) {
        if (this.viewer.slideshow) { this.viewer.slideshow = false; clearTimeout(this.galTimers.turn); delete this.galTimers.turn; this.hideMark(); }
        this.wakeViewer();
        return;
      }
    }
    if (this.faded) {
      // Any press brings the text back. A move also acts; Select and Menu only restore.
      this.setFaded(false);
      this.armIdle();
      if (k === 'enter' || k === 'back') return;
    } else if (k === 'enter' && this.canFade() && n.focus === 'page' && ['body', 'facts', 'hours'].includes(n.stop)) {
      // Select on a text block, facts or hours hides the text at once so the film shows.
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      this.setFaded(true);
      return;
    } else {
      this.armIdle();
    }
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
    // Level 2: the gallery walks as the TV does (SPEC 5.3).
    if (this.pageOnShow?.type === 'gallery' && this.galleryKey(k)) return;
    // Back or a stop inside the page.
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
      if ((k === 'enter' || k === 'playpause') && cur.dataset.film) this.play(cur.dataset.film);
      return;
    }
    if (k === 'playpause') { if (cur.dataset.film) this.play(cur.dataset.film); return; }
    if (k === 'enter') {
      if (cur.dataset.child) this.openChild(cur.dataset.child);
      else if (cur.dataset.film) this.play(cur.dataset.film);
      return;
    }
    const next = this.neighbour(cur, stops, k);
    if (next) { n.stop = next.dataset.stop; this.applyFocus(); return; }
    if (k === 'up' || k === 'left') { n.focus = 'back'; this.applyFocus(); }
  }

  // ---- the gallery (SPEC 5.3) ---------------------------------------------

  /** A new page on show: frame 1, no viewer, clocks stopped; they start again in syncGalleryClocks. */
  resetGallery(page) {
    this.stopGalleryClocks();
    clearTimeout(this.viewerFadeTimer);
    clearTimeout(this.markTimer);
    this.viewer = null;
    this.viewerFaded = false;
    this.gal = { pageId: page?.id || null, running: false, paused: false, held: false };
  }

  stopGalleryClocks() {
    for (const t of Object.values(this.galTimers || {})) clearTimeout(t);
    this.galTimers = {};
  }

  galleryPage() { return this.nav.level === 2 && this.pageOnShow?.type === 'gallery' ? this.pageOnShow : null; }

  /** What the slideshow style says under its dots. */
  galleryStateText(page) {
    if (page.type !== 'gallery') return '';
    const o = galleryOptions(page);
    if (this.mode !== 'remote') return W8.turnsEvery(o.seconds);
    if (this.gal.paused) return W8.paused;
    if (this.gal.held) return W8.pausedFor(Math.round(this.timing.hold / 1000));
    return W8.turnsEvery(o.seconds);
  }

  /**
   * Starts the clocks the page needs, once: Thumbnails with "plays by itself"
   * waits 20 s for a press; the Slideshow style turns at once; the viewer
   * turns while its slideshow is on. Remote mode only.
   */
  syncGalleryClocks() {
    const page = this.galleryPage();
    if (!page || this.mode !== 'remote' || this.playing) { this.stopGalleryClocks(); return; }
    const o = galleryOptions(page);
    const t = this.galTimers;
    if (this.viewer) {
      clearTimeout(t.idle); delete t.idle;
      if (this.viewer.slideshow && !t.turn) this.scheduleTurn(o);
      if (!this.viewer.slideshow && t.turn) { clearTimeout(t.turn); delete t.turn; }
      return;
    }
    if (o.style === 'slideshow') {
      if (!this.gal.paused && !this.gal.held && !t.turn) { this.gal.running = true; this.markRunning(); this.scheduleTurn(o); }
    } else if (o.autoplay && !this.gal.running && !t.idle) {
      t.idle = setTimeout(() => { delete t.idle; this.gal.running = true; this.scheduleTurn(o); }, this.timing.idleBeforeAutoplay);
    }
  }

  scheduleTurn(o) {
    clearTimeout(this.galTimers.turn);
    this.galTimers.turn = setTimeout(() => { delete this.galTimers.turn; this.turn(); }, o.seconds * 1000 * this.timing.secondsScale);
  }

  /** The next frame by itself (wrapping to the first at the end), the focus following it on the thumbnails. */
  turn() {
    const page = this.galleryPage();
    if (!page || this.mode !== 'remote') return;
    const count = framesOf(page).length;
    if (!count) return;
    const next = (this.galleryIndex + 1) % count;
    if (!this.viewer && this.nav.focus === 'page' && /^photo-\d+$/.test(this.nav.stop || '')) { this.nav.stop = `photo-${next}`; this.applyFocus(); }
    this.showPhoto(next);
    this.markRunning();
    if (this.viewer ? this.viewer.slideshow : this.gal.running) this.scheduleTurn(galleryOptions(page));
  }

  /** Restarts the slideshow style's bar for this frame. */
  markRunning() {
    const g = this.pageEl?.querySelector('.tv-gallery');
    if (!g) return;
    g.classList.remove('running');
    void g.offsetWidth;
    g.classList.toggle('running', this.gal.running);
    const nx = g.querySelector('.tv-gnext');
    const page = this.galleryPage();
    if (nx && page) nx.textContent = this.galleryStateText(page);
  }

  /** A press in the leaf: Thumbnails stop turning and wait 20 s again. */
  galleryTouched() {
    const page = this.galleryPage();
    if (!page || this.viewer) return;
    const o = galleryOptions(page);
    if (o.style !== 'thumbnails') return;
    this.gal.running = false;
    clearTimeout(this.galTimers.turn); delete this.galTimers.turn;
    clearTimeout(this.galTimers.idle); delete this.galTimers.idle;
    this.syncGalleryClocks();
  }

  /** Slideshow style: Left / Right step and hold the slideshow for 30 s. */
  holdSlideshow() {
    const page = this.galleryPage();
    const t = this.galTimers;
    clearTimeout(t.turn); delete t.turn;
    clearTimeout(t.hold);
    this.gal.running = false;
    this.gal.held = true;
    this.markRunning();
    t.hold = setTimeout(() => { delete t.hold; this.gal.held = false; if (page) this.syncGalleryClocks(); }, this.timing.hold);
  }

  focusThumb(i) {
    this.nav.focus = 'page';
    this.nav.stop = `photo-${i}`;
    this.applyFocus();
    this.scrollStrips(i);
  }

  focusBack() { this.nav.focus = 'back'; this.applyFocus(); if (this.viewer) this.wakeViewer(); }

  /** The first tile of the pages inside, if there are any. */
  firstTile() { return this.pageEl?.querySelector('.tv-gtiles [data-stop]') || null; }

  openViewer(i, { slideshow = false } = {}) {
    this.stopGalleryClocks();
    this.gal.running = false;
    this.galleryIndex = i;
    this.viewer = { strip: false, captionHidden: false, slideshow, mark: slideshow ? W8.slideshowOn : '' };
    this.nav.focus = 'page';
    this.render(0);
    this.wakeViewer();
    if (slideshow) this.showMark(W8.slideshowOn);
  }

  closeViewer() {
    const page = this.galleryPage();
    clearTimeout(this.viewerFadeTimer);
    clearTimeout(this.markTimer);
    this.viewer = null;
    this.viewerFaded = false;
    this.stopGalleryClocks();
    this.gal.running = false;
    this.nav.focus = 'page';
    this.nav.stop = page && galleryOptions(page).style === 'slideshow' ? 'gframe' : `photo-${this.galleryIndex}`;
    this.render(0);
  }

  /** The viewer's words come back, and fade again after 4 s with no press (not while the strip is open). */
  wakeViewer() {
    this.viewerFaded = false;
    this.stage.classList.remove('viewer-faded');
    clearTimeout(this.viewerFadeTimer);
    // The words stay up while Back has focus, and while the strip is open.
    if (!this.viewer || this.viewer.strip || this.mode !== 'remote' || this.nav.focus === 'back') return;
    this.viewerFadeTimer = setTimeout(() => { if (this.viewer && !this.viewer.strip) { this.viewerFaded = true; this.stage.classList.add('viewer-faded'); } }, this.timing.viewerFade);
  }

  hideMark() {
    clearTimeout(this.markTimer);
    if (this.viewer) this.viewer.mark = '';
    this.pageEl?.querySelector('.tv-vmark')?.remove();
  }

  showMark(text) {
    if (!this.viewer) return;
    if (!text) { this.hideMark(); return; }   // turning the slideshow off shows no words
    this.viewer.mark = text;
    this.pageEl?.querySelector('.tv-vmark')?.remove();
    this.pageEl?.querySelector('.tv-gviewer')?.append(el('div.tv-vmark', text));
    clearTimeout(this.markTimer);
    this.markTimer = setTimeout(() => { if (this.viewer) this.viewer.mark = ''; this.pageEl?.querySelector('.tv-vmark')?.remove(); }, this.timing.mark);
  }

  /** Redraws the viewer after a change of its parts (strip, caption). */
  redrawViewer() { this.render(0); }

  playFrame(page, frames, i) {
    const fr = frames[i];
    this.stopGalleryClocks();
    this.play(fr.caption || `${page.title || 'Gallery'}: film ${i + 1}`);
  }

  /** The gallery's remote (SPEC 5.3). Returns true when the press was handled. */
  galleryKey(k) {
    const page = this.pageOnShow;
    const frames = framesOf(page);
    const count = frames.length;
    const n = this.nav;
    const o = galleryOptions(page);
    const idx = Math.min(this.galleryIndex, Math.max(0, count - 1));
    if (this.viewer) return this.viewerKey(k, page, frames, idx);
    this.galleryTouched();
    if (n.focus === 'back') return false;
    const s = n.stop || '';
    const tile = this.firstTile();
    if (s.startsWith('child-') && k === 'up') {
      if (o.style === 'slideshow' && count) { n.stop = 'gframe'; this.applyFocus(); return true; }
      if (count) { this.focusThumb(idx); return true; }
      return false;
    }
    if (o.style === 'slideshow') {
      if (s !== 'gframe') return false;
      if (k === 'left') { if (idx > 0) { this.showPhoto(idx - 1); this.holdSlideshow(); } else this.focusBack(); return true; }
      if (k === 'right') { if (idx < count - 1) { this.showPhoto(idx + 1); this.holdSlideshow(); } return true; }
      if (k === 'up') { this.focusBack(); return true; }
      if (k === 'down') { if (tile) { n.stop = tile.dataset.stop; this.applyFocus(); } return true; }
      if (k === 'enter') { this.openViewer(idx); return true; }
      if (k === 'playpause') {
        this.gal.paused = !this.gal.paused;
        clearTimeout(this.galTimers.hold); delete this.galTimers.hold; this.gal.held = false;
        if (this.gal.paused) { clearTimeout(this.galTimers.turn); delete this.galTimers.turn; this.gal.running = false; this.markRunning(); }
        else this.syncGalleryClocks();
        return true;
      }
      return true;
    }
    const m = /^photo-(\d+)$/.exec(s);
    if (m) {
      const i = Number(m[1]);
      if (k === 'left') { if (i > 0) this.focusThumb(i - 1); else this.focusBack(); return true; }
      if (k === 'right') { if (i < count - 1) this.focusThumb(i + 1); return true; }
      if (k === 'up') {
        const chips = [...this.pageEl.querySelectorAll('.tv-chip')];
        if (!chips.length) { this.focusBack(); return true; }
        const chip = chips.find((c) => i >= Number(c.dataset.chapter) && i <= Number(c.dataset.runEnd)) || [...chips].reverse().find((c) => Number(c.dataset.chapter) <= i) || chips[0];
        n.stop = chip.dataset.stop; this.applyFocus(); this.scrollStrips(i);
        return true;
      }
      if (k === 'down') { if (tile) { n.stop = tile.dataset.stop; this.applyFocus(); } return true; }
      if (k === 'enter') { if (frames[i]?.film && frames[i].sound === true) this.playFrame(page, frames, i); else this.openViewer(i); return true; }
      if (k === 'playpause') { this.openViewer(i, { slideshow: true }); return true; }
      return true;
    }
    if (/^chap-\d+$/.test(s)) {
      const chips = [...this.pageEl.querySelectorAll('.tv-chip')];
      const at = chips.findIndex((c) => c.dataset.stop === s);
      const go = (c) => { n.stop = c.dataset.stop; this.showPhoto(Number(c.dataset.chapter)); this.applyFocus(); this.scrollStrips(this.galleryIndex); };
      if (k === 'left') { if (at > 0) go(chips[at - 1]); else this.focusBack(); return true; }
      if (k === 'right') { if (at < chips.length - 1) go(chips[at + 1]); return true; }
      if (k === 'up') { this.focusBack(); return true; }
      if (k === 'down' || k === 'enter') { this.focusThumb(Number(chips[at].dataset.chapter)); return true; }
      if (k === 'playpause') { this.openViewer(idx, { slideshow: true }); return true; }
      return true;
    }
    return false;
  }

  /** The full-screen viewer's remote (SPEC 5.3 "The full-screen viewer"). */
  viewerKey(k, page, frames, idx) {
    const v = this.viewer;
    const n = this.nav;
    const count = frames.length;
    this.wakeViewer();
    if (k !== 'playpause' && v.slideshow) { v.slideshow = false; clearTimeout(this.galTimers.turn); delete this.galTimers.turn; }
    if (n.focus === 'back') {
      if (k === 'right' || k === 'down') { n.focus = 'page'; this.applyFocus(); }
      else if (k === 'enter' || k === 'left') this.closeViewer();
      return true;
    }
    if (k === 'playpause') {
      v.slideshow = !v.slideshow;
      this.showMark(v.slideshow ? W8.slideshowOn : W8.slideshowOff);
      this.syncGalleryClocks();
      return true;
    }
    if (v.strip) {
      if (k === 'left') { if (idx > 0) this.showPhoto(idx - 1); }
      else if (k === 'right') { if (idx < count - 1) this.showPhoto(idx + 1); }
      else if (k === 'up' || k === 'enter') { v.strip = false; this.redrawViewer(); this.wakeViewer(); }
      return true;
    }
    if (k === 'left') { if (idx > 0) this.showPhoto(idx - 1); else this.focusBack(); return true; }
    if (k === 'right') { if (idx < count - 1) this.showPhoto(idx + 1); return true; }
    if (k === 'down') { v.strip = true; this.redrawViewer(); return true; }
    if (k === 'up') { this.focusBack(); return true; }
    if (k === 'enter') {
      if (frames[idx]?.film && frames[idx].sound === true) { this.playFrame(page, frames, idx); return true; }
      v.captionHidden = !v.captionHidden;
      this.pageEl?.querySelector('.tv-gviewer')?.classList.toggle('nocap', v.captionHidden);
      return true;
    }
    return true;
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
