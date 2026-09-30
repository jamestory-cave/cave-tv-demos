// Cave Builder: boot, top bar, screens, autosave.

import { config } from '../config.js';
import { el, clear, debounce, fmtTime, plural } from './util.js';
import { model } from './model.js';
import { BrowserStore } from './stores/browser.js';
import { GitHubStore } from './stores/github.js';
import { MediaRegistry } from './media.js';
import { describeChanges } from './changes.js';
import { validateAll } from './validate.js';
import { toast, modal, el as _el } from './ui.js';
import * as home from './screens/home.js';
import * as editor from './screens/editor.js';
import * as menus from './screens/menus.js';
import * as mediaScreen from './screens/media.js';
import * as hotel from './screens/hotel.js';
import * as publish from './screens/publish.js';
import * as settings from './screens/settings.js';
import { feedbackModal } from './screens/feedback.js';

const SCREENS = { home, editor, menus, media: mediaScreen, hotel, publish, settings };
const NAV = [['home', 'Home'], ['menus', 'Menus'], ['media', 'Media'], ['hotel', 'Hotel details'], ['publish', 'Publish'], ['settings', 'Settings']];

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
  validation() { return validateAll(model.draft, { imageSize: (src) => this.media.size(src) }); },

  publisherName() { return this.browser.prefs().by || ''; },
};

const save = debounce(() => {
  app.browser.saveDraft({ doc: model.draft, basedOn: model.basedOn, savedAt: new Date().toISOString() });
  model.savedAt = new Date().toISOString();
  renderSavedState();
}, 400);

function renderSavedState() {
  const s = document.getElementById('saved-state');
  if (!s) return;
  s.textContent = model.savedAt ? `Saved ${fmtTime(new Date(model.savedAt))}` : 'Nothing changed yet';
}

function topBar() {
  const bar = el('header.appbar', { role: 'banner' });
  bar.append(el('div.brand', 'Cave Builder', el('small', config.hotelName)));
  const nav = el('nav.nav', { 'aria-label': 'Screens' });
  for (const [key, label] of NAV) {
    nav.append(el('button', { type: 'button', class: (app.screen === key || (key === 'home' && app.screen === 'editor')) ? 'on' : '', onclick: () => app.go(key) }, label));
  }
  bar.append(nav, el('span.spacer'));
  const n = app.changes().entries.length;
  bar.append(el('span#saved-state.muted.small'));
  bar.append(el('span.pill' + (n ? '.acc' : ''), n ? `${plural(n, 'change')} not yet published` : 'Nothing to publish'));
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
    model.basedOn = { revision: published.version.revision, bundle: published.version.bundle };
    toast(`The published content has changed since you started (now revision ${published.version.revision}). Your draft is kept; the change list is now against the new publish.`, { ms: 12000 });
  }

  model.on((ev) => {
    if (ev.type === 'change') {
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

// Anything unexpected is shown on the page, so a tester can report it.
function showError(message) {
  let box = document.getElementById('fatal');
  if (!box) { box = el('div#fatal.note.block', { style: { position: 'fixed', left: '16px', right: '16px', bottom: '70px', zIndex: '200' } }); document.body.append(box); }
  clear(box).append(el('strong', 'Something went wrong. '), String(message), ' ', el('button.btn.sm', { type: 'button', onclick: () => box.remove() }, 'Dismiss'));
}
window.addEventListener('error', (e) => showError(e.message + (e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '')));
window.addEventListener('unhandledrejection', (e) => showError(e.reason?.message || e.reason));

export { model, toast, modal, _el as el };
boot();
