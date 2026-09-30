// Cave Builder: boot, top bar, screens, autosave.

import { config } from '../config.js';
import { el, clear, debounce, fmtTime, plural, randomId } from './util.js';
import { model } from './model.js';
import { BrowserStore } from './stores/browser.js';
import { GitHubStore } from './stores/github.js';
import { MediaRegistry } from './media.js';
import { describeChanges } from './changes.js';
import { buildBundle } from './bundle.js';
import { threeWayMerge } from './merge.js';
import { validateAll } from './validate.js';
import { toast, modal, el as _el } from './ui.js';
import * as home from './screens/home.js';
import * as editor from './screens/editor.js';
import * as menus from './screens/menus.js';
import * as mediaScreen from './screens/media.js';
import * as hotel from './screens/hotel.js';
import * as publish from './screens/publish.js';
import * as settings from './screens/settings.js';
import * as guide from './screens/guide.js';
import { feedbackModal } from './screens/feedback.js';
import { mediaPathsIn } from './bundle.js';
import { FILM } from './media.js';

const SCREENS = { home, editor, menus, media: mediaScreen, hotel, publish, settings, guide };
const NAV = [['home', 'Home'], ['menus', 'Menus'], ['media', 'Media'], ['hotel', 'Hotel details'], ['publish', 'Publish'], ['settings', 'Settings']];
const NAV_ALIAS = { editor: 'home', guide: 'media' };

export const app = {
  browser: new BrowserStore(),
  github: new GitHubStore(),
  media: null,
  screen: 'home',
  params: {},
  current: null,
  loadError: null,
  logoURL: new URL('../assets/cave-logo.png', import.meta.url).href,

  go(screen, params = {}) {
    this.screen = SCREENS[screen] ? screen : 'home';
    this.params = params;
    const hash = '#' + this.screen + (params.page ? '/' + params.page : '') + (params.menu ? '/' + params.menu : '');
    if (location.hash !== hash) history.pushState(null, '', hash);
    this.renderScreen();
  },

  changes() { return describeChanges(model.published?.bundle, model.draft); },
  validation() { return validateAll(model.draft, { imageSize: (src) => this.media.size(src), imageKnown: (src) => this.media.known(src), filmInfo: (src) => this.media.film(src) }); },

  /** Pending photos and films the bundle actually uses, so nothing unused goes to the repository. */
  mediaFor(bundle) {
    const used = new Set(mediaPathsIn(bundle));
    const pending = this.media.pendingRecords().filter((m) => [...used].some((u) => u.includes(m.hash)));
    return { photos: pending.filter((m) => m.kind !== 'film'), films: pending.filter((m) => m.kind === 'film') };
  },

  /**
   * Everything the Publish screen needs: the bundle that would go live, which
   * pages are held back (and whether their published copy stays), the change
   * entries marked `held` when they are not going live, and the summary that
   * goes into history.json (held changes left out).
   */
  plan() {
    const validation = this.validation();
    const { bundle, heldBack, frozen } = buildBundle(model.draft, { held: validation, published: model.published?.bundle });
    const { entries } = this.changes();
    // A page deleted from under a held-back page is still in the bundle (the
    // published copy keeps it), so its removal is held too.
    const keptHeld = new Set(heldBack.filter((h) => h.kept).map((h) => h.id));
    const publishedParents = new Map();
    const walk = (page, parentId) => { publishedParents.set(page.id, parentId); for (const c of page.children || []) walk(c, page.id); };
    if (model.published?.bundle?.home) walk(model.published.bundle.home, null);
    const underHeld = (id) => { for (let p = publishedParents.get(id); p; p = publishedParents.get(p)) if (keptHeld.has(p)) return true; return false; };
    for (const e of entries) e.held = frozen.has(e.id) || (e.kind === 'removed' && underHeld(e.id));
    // "Order is now" lists what will actually be in the bundle.
    const bundlePages = new Map();
    const walkB = (page) => { bundlePages.set(page.id, page); for (const c of page.children || []) walkB(c); };
    walkB(bundle.home);
    for (const e of entries) {
      const bp = bundlePages.get(e.id);
      if (!bp) continue;
      e.lines = e.lines.map((l) => (l.startsWith('Order is now:') ? `Order is now: ${(bp.children || []).map((c) => c.title || '(untitled)').join(', ')}` : l));
    }
    const live = entries.filter((e) => !e.held);
    const summary = live.flatMap((e) => e.lines.map((l) => `${e.path}: ${l}`));
    const stop = [];
    if (!(bundle.home.children || []).length) stop.push('Nothing would show on the TV: every section is hidden or held back. Show or fix at least one section.');
    for (const b of validation.get('home')?.blockers || []) stop.push(`Home: ${b.message}`);
    for (const b of validation.get('hotel')?.blockers || []) stop.push(`Hotel details: ${b.message}`);
    const media = this.mediaFor(bundle);
    const filmBytes = media.films.reduce((a, f) => a + (f.bytes || 0), 0);
    const warnings = [];
    if (filmBytes > FILM.publishWarnBytes) warnings.push(`This publish uploads ${Math.round(filmBytes / 1048576)} MB of film. GitHub Pages allows about 1 GB for the whole site, so keep an eye on the total; publish in smaller batches if it fails.`);
    return { validation, bundle, heldBack, frozen, entries, live, summary, stop, media, filmBytes, warnings, canPublish: live.length > 0 && !stop.length };
  },

  publisherName() { return this.browser.prefs().by || ''; },
};

// Each tab signs its saves, so a tab can tell its own save from another's.
const TAB_ID = randomId(8);
let saveBlocked = false;   // another tab saved over this tab's draft: stop overwriting it
let touched = false;       // this tab has made edits since it loaded

const save = debounce(() => {
  if (saveBlocked) return;
  app.browser.saveDraft({ doc: model.draft, basedOn: model.basedOn, savedAt: new Date().toISOString(), tab: TAB_ID });
  model.savedAt = new Date().toISOString();
  renderSavedState();
}, 400);

// Keystrokes in the last moments before a reload or a tab switch must not be lost.
window.addEventListener('pagehide', () => save.flush());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save.flush(); });

function renderSavedState() {
  const s = document.getElementById('saved-state');
  if (!s) return;
  s.textContent = saveBlocked ? 'Not saving: changed in another tab' : model.savedAt ? `Saved ${fmtTime(new Date(model.savedAt))}` : 'Nothing changed yet';
}

/** Another tab of the Builder saved the draft. Adopt it, or warn and stop saving. */
function otherTabSaved(record) {
  if (!record || record.tab === TAB_ID) return;
  if (!touched) {
    model.load(model.published, record);
    renderScreen();
    toast('Updated with the changes made in another tab.', { ms: 5000 });
    return;
  }
  if (saveBlocked) return;
  saveBlocked = true;
  save.cancel();
  renderSavedState();
  let bar = document.getElementById('tab-warning');
  if (bar) return;
  bar = el('div#tab-warning.note.block', { style: { position: 'fixed', left: '16px', right: '16px', top: '62px', zIndex: '150' } },
    el('strong', 'This draft was changed in another tab. '), 'To keep both sets of changes safe, this tab has stopped saving. ',
    el('button.btn.sm', { type: 'button', onclick: () => location.reload() }, 'Reload to see the other tab\'s changes'), ' ',
    el('button.btn.sm', { type: 'button', onclick: () => { saveBlocked = false; bar.remove(); save(); } }, 'Keep mine and overwrite the other tab'));
  document.body.append(bar);
}
window.addEventListener('storage', (e) => {
  if (e.key !== 'cave-builder.draft' || !e.newValue) return;
  try { otherTabSaved(JSON.parse(e.newValue)); } catch { /* ignore */ }
});

function topBar() {
  const bar = el('header.appbar', { role: 'banner' });
  bar.append(el('div.brand', 'Cave Builder', el('small', config.hotelName)));
  const nav = el('nav.nav', { 'aria-label': 'Screens' });
  for (const [key, label] of NAV) {
    nav.append(el('button', { type: 'button', class: (app.screen === key || NAV_ALIAS[app.screen] === key) ? 'on' : '', onclick: () => app.go(key) }, label));
  }
  bar.append(nav, el('span.spacer'));
  const n = app.changes().entries.length;
  bar.append(el('span#saved-state.muted.small'));
  bar.append(el('span.pill' + (n ? '.acc' : ''), { id: 'change-count' }, n ? `${plural(n, 'change')} not yet published` : 'Nothing to publish'));
  bar.append(el('button.btn.pri', { type: 'button', onclick: () => app.go('publish') }, 'Review & publish'));
  return bar;
}

function tryBanner() {
  if (app.browser.prefs().bannerDismissed) return null;
  const b = el('div.banner', { role: 'note' },
    el('span', el('strong', 'Try mode. '), 'Your changes are kept in this browser only and affect nobody else. Nothing reaches a TV until someone presses Publish with the publishing passcode.'),
    el('button.btn.sm', { type: 'button', onclick: () => { app.browser.setPref('bannerDismissed', true); b.remove(); } }, 'Got it'));
  return b;
}

function renderShell() {
  const root = document.getElementById('app');
  clear(root);
  root.append(topBar());
  const banner = tryBanner();
  if (banner) root.append(banner);
  if (app.loadError) {
    root.append(el('div.note.block', { style: { margin: '12px 16px' } }, el('strong', 'Could not load the published content. '), app.loadError,
      ' ', el('button.btn.sm', { type: 'button', onclick: () => location.reload() }, 'Try again')));
  }
  root.append(el('div#screen'));
  root.append(el('button.btn.fab', { type: 'button', onclick: () => feedbackModal(app) }, 'Feedback'));
  renderSavedState();
}

function renderScreen() {
  if (app.current?.unmount) app.current.unmount();
  const host = document.getElementById('screen');
  clear(host);
  app.current = SCREENS[app.screen].mount(host, app, app.params);
  // Refresh the nav highlight and counter.
  const old = document.querySelector('.appbar');
  if (old) old.replaceWith(topBar());
  renderSavedState();
  window.scrollTo(0, 0);
}
app.renderScreen = renderScreen;

function fromHash() {
  const [screen, a, b] = location.hash.replace(/^#/, '').split('/');
  const params = {};
  if (screen === 'editor' && a) params.page = decodeURIComponent(a);
  if (screen === 'menus' && a) params.menu = decodeURIComponent(a);
  void b;
  app.screen = SCREENS[screen] ? screen : 'home';
  app.params = params;
}

async function boot() {
  const root = document.getElementById('app');
  root.append(el('p.muted', { style: { padding: '40px' } }, 'Loading the published content…'));
  let published = null;
  try {
    published = await app.github.loadPublished();
  } catch (e) {
    app.loadError = e.message + (config.isLocal ? ' (Run builder/tools/seed.py and serve docs/design/site.)' : '');
  }
  app.media = new MediaRegistry({ browserStore: app.browser, githubStore: app.github });
  await app.media.load(published?.mediaIndex);
  const saved = app.browser.loadDraft();
  model.load(published, saved);
  if (saved && published && saved.basedOn?.revision !== published.version.revision) {
    await rebaseDraft(saved, published);
  }

  model.on((ev) => {
    if (ev.type === 'media' && app.current?.update) { app.current.update(ev); return; }
    if (ev.type === 'change') {
      touched = true;
      save();
      if (app.current?.update) app.current.update(ev);
      const bar = document.querySelector('.appbar');
      if (bar) bar.replaceWith(topBar());
    }
  });

  fromHash();
  window.addEventListener('popstate', () => { fromHash(); renderScreen(); });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.value !== undefined && document.activeElement === t) return; // let the field undo its own typing first
      e.preventDefault();
      const label = model.undo();
      if (label) toast(`Undid: ${label}`, { ms: 2500 });
    }
  });
  // The preview's fonts, fetched now rather than on first paint.
  if (document.fonts?.load) { document.fonts.load('500 72px Cinzel'); document.fonts.load('400 30px Inter'); }
  renderShell();
  renderScreen();
}

/**
 * Someone published while this draft was open. Replay this browser's own
 * changes onto the newer publish; where both changed the same thing, the
 * newer publish wins and the user is told exactly what was kept.
 */
async function rebaseDraft(saved, published) {
  const rev = published.version.revision;
  let base = null;
  if (saved.basedOn?.bundle) { try { base = await app.github.fetchBundle(saved.basedOn.bundle); } catch { base = null; } }
  if (!base) {
    model.basedOn = { revision: rev, bundle: published.version.bundle };
    toast(`Someone published while you were away (now publish ${rev}) and the version you started from could not be fetched. Check the Publish list carefully: anything marked there would replace their work.`, { error: true, ms: 20000 });
    return;
  }
  const { doc, conflicts, applied } = threeWayMerge(base, published.bundle, saved.doc);
  model.draft = doc;
  model.basedOn = { revision: rev, bundle: published.version.bundle };
  model.undoStack = [];
  save();
  const body = el('div');
  body.append(el('p', `Someone else published while you were away (now publish ${rev}). ${applied ? `Your ${plural(applied, 'change')} ${applied === 1 ? 'has' : 'have'} been carried over onto it.` : 'Nothing of yours needed carrying over.'}`));
  if (conflicts.length) {
    body.append(el('p', { style: { marginTop: '8px' } }, el('strong', 'Kept from the newer publish (your version was dropped):')));
    const ul = el('ul.small');
    for (const c of conflicts) ul.append(el('li', c));
    body.append(ul);
  }
  modal({ title: 'Published content changed', body, actions: [{ label: 'OK', primary: true }] });
}

// Anything unexpected is shown on the page, so a tester can report it.
function showError(message) {
  let box = document.getElementById('fatal');
  if (!box) { box = el('div#fatal.note.block', { style: { position: 'fixed', left: '16px', right: '16px', bottom: '70px', zIndex: '200' } }); document.body.append(box); }
  clear(box).append(el('strong', 'Something went wrong. '), String(message), ' ', el('button.btn.sm', { type: 'button', onclick: () => box.remove() }, 'Dismiss'));
}
window.addEventListener('error', (e) => showError(e.message + (e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '')));
window.addEventListener('unhandledrejection', (e) => showError(e.reason?.message || e.reason));

export { model, toast, modal, _el as el };
// For the developer harness and QA scripts (nothing secret lives here that is not already in this browser).
window.cave = { app, model };
boot();
