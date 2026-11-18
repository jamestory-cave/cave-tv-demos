// Cave Builder: boot, top bar, screens, autosave.

import { config } from '../config.js';
import { el, clear, debounce, fmtTime, plural, randomId, canonical, clone } from './util.js';
import { model } from './model.js';
import { BrowserStore } from './stores/browser.js';
import { GitHubStore } from './stores/github.js';
import { ServerStore, DraftConflict } from './stores/server.js';
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
import * as rooms from './screens/rooms.js';
import * as overridesScreen from './screens/overrides.js';
import { resolveForPublish } from './overrides.js';
import { feedbackModal } from './screens/feedback.js';
import { mediaPathsIn } from './bundle.js';
import { olderAppWarning } from './gallery.js';
import { FILM } from './media.js';

// Served by the hotel's Cave server: one ServerStore plays both prototype
// stores (draft and media, and publishing). Otherwise the prototype pair.
const SERVER = config.mode === 'server';
const server = SERVER ? new ServerStore() : null;

// Overrides (room-specific content) and Rooms exist only on the hotel server: only it knows which TV is asking.
const SCREENS = { home, editor, menus, media: mediaScreen, hotel, publish, settings, guide, ...(SERVER ? { rooms, overrides: overridesScreen } : {}) };
const NAV = [['home', 'Home'], ['menus', 'Menus'], ['media', 'Media'], ['hotel', 'Hotel details'], ...(SERVER ? [['overrides', 'Overrides']] : []), ['publish', 'Publish'], ...(SERVER ? [['rooms', 'Rooms']] : []), ['settings', 'Settings']];
const NAV_ALIAS = { editor: 'home', guide: 'media' };

export const app = {
  server,
  browser: server || new BrowserStore(),
  github: server || new GitHubStore(),
  media: null,
  screen: 'home',
  params: {},
  current: null,
  loadError: null,
  logoURL: new URL('../assets/cave-logo.png', import.meta.url).href,

  go(screen, params = {}) {
    this.screen = SCREENS[screen] ? screen : 'home';
    this.params = params;
    const seg = (v) => (v ? '/' + encodeURIComponent(v) : '');
    const hash = '#' + this.screen + seg(params.page) + (params.menu ? '/' + params.menu : '') + seg(params.version || params.field);
    if (location.hash !== hash) history.pushState(null, '', hash);
    this.renderScreen();
  },

  changes() { return describeChanges(model.published?.bundle, model.draft, this.overrideOpts()); },

  // ---- room-specific content (hotel server) ----
  /** Room types and rooms, from the Rooms database: {types, rooms}. Loaded at start and when a screen asks. */
  rooms: { types: [], rooms: [], olderApps: { minimum: 8, tvs: [] } },
  /** "Preview as" in the editor: '' (the master), 'type:<id>' or 'room:<number>'. Kept while the Builder is open. */
  previewAs: '',
  async loadRooms() {
    if (!SERVER) return this.rooms;
    try { const r = await server.rooms(); this.rooms = { types: r.types || [], rooms: r.rooms || [], olderApps: r.olderApps || { minimum: 8, tvs: [] } }; } catch { /* keep what we had */ }
    return this.rooms;
  },
  /** Labels for room types and rooms in messages. */
  names() {
    const types = this.rooms.types;
    return {
      typeName: (id) => types.find((t) => String(t.id) === String(id))?.name || `Room type ${id} (no longer in the list)`,
      roomLabel: (n) => `room ${n}`,
    };
  },
  overrideOpts() {
    if (!SERVER) return {};
    return { overridesBefore: model.published?.overrides?.draft || {}, names: this.names() };
  },
  /** Draft overrides resolved for publishing: what goes live, what is held, what is blocked. */
  resolveOverrides(bundle, frozen, validationCtx) {
    if (!SERVER) return null;
    return resolveForPublish(model.draft, { bundle, frozen, published: model.published?.overrides || null, ctx: { ...validationCtx, names: this.names(), rooms: this.rooms.rooms } });
  },
  /**
   * The overrides as they would go live now (values that cannot go live replaced by what TVs
   * have, or dropped): what "Preview as" draws, so it shows what the TV will get (QA-7).
   * Returns {overrides, blocked}.
   */
  liveOverrides() {
    if (!SERVER || !model.draft.overrides) return { overrides: model.draft.overrides, blocked: [] };
    // Worked out once per change (the Overrides screen asks for every item it lists).
    const key = [sync.seq, model.draft, model.published?.version?.revision, this.rooms, this.media?.index];
    const c = this._liveCache;
    if (c && c.key.every((v, i) => v === key[i])) return c.value;
    const { bundle, frozen } = buildBundle(model.draft, { held: this.validation(), published: model.published?.bundle });
    const r = this.resolveOverrides(bundle, frozen, this.validationCtx());
    const value = { overrides: r.live, blocked: r.blocked };
    this._liveCache = { key, value };
    return value;
  },
  validationCtx() { return { imageSize: (src) => this.media.size(src), imageKnown: (src) => this.media.known(src), filmInfo: (src) => this.media.film(src) }; },
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
    // Hotel server: the room-specific content as it will go live (blocked values held, held pages' kept).
    const overrides = this.resolveOverrides(bundle, frozen, this.validationCtx());
    const { entries } = overrides
      ? describeChanges(model.published?.bundle, model.draft, { ...this.overrideOpts(), overridesAfter: overrides.live })
      : this.changes();
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
    if (!SERVER && filmBytes > FILM.publishWarnBytes) warnings.push(`This publish uploads ${Math.round(filmBytes / 1048576)} MB of film. GitHub Pages allows about 1 GB for the whole site, so keep an eye on the total; publish in smaller batches if it fails.`);
    // Example words still on pages going live (build 7 QA-2, gallery QA-5): said plainly, never blocking.
    {
      const live = new Set(); (function w(p) { live.add(p.id); (p.children || []).forEach(w); })(bundle.home);
      const pagesWithExamples = [...validation].filter(([id, v]) => live.has(id) && v.warnings.some((x) => /still the example text/.test(x.message))).map(([id]) => model.pathLabel(id));
      if (pagesWithExamples.length) warnings.push(`Example text from a new page is still on ${pagesWithExamples.length === 1 ? 'this page' : `${pagesWithExamples.length} pages`}, and guests would read it: ${pagesWithExamples.slice(0, 6).join('; ')}${pagesWithExamples.length > 6 ? ` and ${pagesWithExamples.length - 6} more` : ''}. Open ${pagesWithExamples.length === 1 ? 'it' : 'each'} and replace or clear the words its checks name.`);
    }
    // Hotel server: a gallery using the new fields on TVs whose app is older than build 8 (GALLERY-CONTRACT.md). Never blocks.
    if (SERVER) { const w = olderAppWarning(bundle, overrides, this.rooms.olderApps); if (w) warnings.push(w); }
    // Photos chosen for some rooms go up with the publish too (prototype: never; the server has them already).
    return { validation, bundle, heldBack, frozen, entries, live, summary, stop, media, filmBytes, warnings, overrides, canPublish: live.length > 0 && !stop.length };
  },

  publisherName() { return SERVER ? (server.user?.name || '') : (this.browser.prefs().by || ''); },

  /** How soon TVs follow a publish, in words. */
  tvLag() { return SERVER ? 'within a minute' : 'within a couple of minutes'; },
};

// Each tab signs its saves, so a tab can tell its own save from another's.
const TAB_ID = randomId(8);
let saveBlocked = false;   // another tab saved over this tab's draft: stop overwriting it
let touched = false;       // this tab has made edits since it loaded

const save = debounce(() => {
  if (saveBlocked) return;
  if (SERVER) { serverSave(); return; }
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
  s.style.color = '';
  s.removeAttribute('title');
  if (SERVER) {
    clear(s);
    // Short words in the bar (it must fit an iPad, QA-13); the full sentence on hover and for screen readers.
    if (sync.authLost) {
      s.style.color = 'var(--red)';
      s.title = 'Not saved: your sign-in has run out. Sign in again to save your changes.';
      s.append(el('span.st', 'Not saved'), ' ', el('button.btn.sm', { type: 'button', 'aria-label': s.title, onclick: () => signInAgain() }, 'Sign in'));
      return;
    }
    if (sync.error) {
      s.style.color = 'var(--red)';
      s.title = 'Not saved yet: the server cannot be reached. Retrying…';
      s.append(el('span.st', { 'aria-label': s.title }, 'Offline, retrying…'));
      return;
    }
    // Never "Saved" while an edit has not reached the server.
    if (sync.seq !== sync.savedSeq) { s.textContent = 'Saving…'; return; }
  }
  s.textContent = saveBlocked ? 'Not saving: changed in another tab' : model.savedAt ? `Saved ${fmtTime(new Date(model.savedAt))}` : 'Nothing changed yet';
}

// ---- server mode: one shared draft ------------------------------------------
// Saves go one at a time. Each names the draft revision it started from; if a
// colleague saved first, the server refuses and sends theirs, and the two are
// merged with merge.js (the colleague's version wins where both changed the
// same field, and the person is told). Every few seconds the Builder asks the
// server whether the draft or the publish moved, and takes the newer draft
// when nothing here is waiting to be saved.
// seq counts edits; savedSeq is the last edit the server has. They differ
// while anything is unsent, whatever the reason (typing, offline, signed out).
const sync = { busy: false, again: false, error: false, authLost: false, lastEdit: 0, timer: null, seq: 0, savedSeq: 0 };

async function serverSave() {
  if (sync.busy) { sync.again = true; return; }
  sync.busy = true;
  const seq = sync.seq;
  try {
    const r = await server.saveDraft({ doc: model.draft, basedOn: model.basedOn });
    model.savedAt = r.savedAt;
    sync.savedSeq = Math.max(sync.savedSeq, seq);
    sync.error = false;
    sync.authLost = false;
    if (sync.seq === sync.savedSeq) { backupUnsent.cancel(); try { localStorage.removeItem(UNSENT_KEY); } catch { /* ignore */ } }
  } catch (e) {
    if (e instanceof DraftConflict && restoredSince(e.current)) { await adoptRestored(e.current, { lost: true }); }
    else if (e instanceof DraftConflict) { await mergeColleague(e.current); sync.seq++; sync.again = true; }
    else if (e.status === 401) { sync.again = false; sync.authLost = true; }   // sent again by onSignedIn, whichever way they sign in
    else if (e.status >= 400 && e.status < 500) { sync.error = false; toast(`The draft could not be saved: ${e.message}`, { error: true }); }
    else { sync.error = true; clearTimeout(sync.timer); sync.timer = setTimeout(() => save(), 5000); }
  } finally {
    sync.busy = false;
    renderSavedState();
    if (sync.again) { sync.again = false; serverSave(); }
  }
}

// ---- a local copy of edits the server has not accepted yet (OBS-3) ----------
// Kept in this browser only while something is unsent, so closing the tab,
// a reload or a crash does not lose it; offered back on the next load.
const UNSENT_KEY = 'cave-builder.server-unsent';
const backupUnsent = debounce(() => {
  if (!SERVER) return;
  try {
    if (sync.seq === sync.savedSeq) { localStorage.removeItem(UNSENT_KEY); return; }
    localStorage.setItem(UNSENT_KEY, JSON.stringify({ user: server.user?.name, at: new Date().toISOString(), doc: model.draft, base: server.draftBase, baseRev: server.draftRev }));
  } catch { /* storage full or blocked: the red bar still warns */ }
}, 800);

/** At start-up: edits that never reached the server last time are offered back. */
async function offerUnsent() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(UNSENT_KEY) || 'null'); } catch { saved = null; }
  if (!saved?.doc || saved.user !== server.user?.name) return;
  if (canonical(saved.doc) === canonical(model.draft)) { localStorage.removeItem(UNSENT_KEY); return; }
  const r = server.restored;
  if (r && typeof saved.baseRev === 'number' && r.rev > saved.baseRev) {
    // Made to the draft as it was before a saved copy was restored: putting them back would undo part of the restore.
    localStorage.removeItem(UNSENT_KEY);
    modal({ title: 'Changes not saved last time', body: el('div',
      el('p', `You made changes at ${fmtTime(new Date(saved.at))} that did not reach the server.`),
      el('p', { style: { marginTop: '8px' } }, `Since then ${r.by || 'an admin'} restored the saved copy "${r.name}", so those changes were made to a draft that no longer exists and have not been put back. Make them again if they are still needed.`)),
    actions: [{ label: 'OK', primary: true }] });
    return;
  }
  const when = fmtTime(new Date(saved.at));
  const body = el('div', el('p', `You made changes at ${when} that did not reach the server (the connection dropped, or the page was closed before they were saved). They were kept in this browser.`),
    el('p', { style: { marginTop: '8px' } }, 'Put them back? Anything a colleague has changed since stays; where you both changed the same thing, you will be told.'));
  const choice = await new Promise((resolve) => modal({ title: 'Changes not saved last time', body, onClose: () => resolve(null), actions: [
    { label: 'Throw them away', onClick: () => resolve('drop') },
    { label: 'Put them back', primary: true, onClick: () => resolve('keep') },
  ] }));
  if (choice === 'drop') { localStorage.removeItem(UNSENT_KEY); return; }
  if (choice !== 'keep') return;    // closed: ask again next time
  const { doc, conflicts } = threeWayMerge(saved.base || model.published?.bundle, model.draft, saved.doc, { who: 'the shared draft', names: app.names() });
  model.adopt(doc);
  model.undoStack = [];
  sync.seq++;
  renderScreen();
  save();
  toast(conflicts.length ? `Your changes are back, except: ${conflicts.join('; ')}` : 'Your changes are back and being saved.', { ms: conflicts.length ? 20000 : 6000 });
}

const whose = (by) => (by && by !== server.user?.name ? by : 'a colleague');

// ---- an admin restored a saved copy (Settings → Saved copies) -----------------
// The restore makes the copy's draft the next draft revision and says so in
// `restored`. A browser that started from an earlier revision takes the
// restored draft as it is: merging its own older draft over it would quietly
// bring back what the restore took away. A change being made at that moment
// is not applied, and the person is told.

/** True when the server's draft was replaced by a restore after the revision this browser built on. */
function restoredSince(d) { return !!(d?.restored && d.restored.rev > server.draftRev && d.restored.rev <= d.rev); }

async function adoptRestored(d, { lost = false } = {}) {
  try { await refreshPublished(); } catch { /* the next poll tries again */ }
  server.acceptRemote(d);
  model.adopt(d.doc ? clone(d.doc) : clone(model.published?.bundle));
  model.undoStack = [];
  model.savedAt = d.savedAt;
  sync.savedSeq = sync.seq;           // nothing here is waiting any more: the restored draft is the draft
  save.cancel();
  backupUnsent.cancel();
  try { localStorage.removeItem(UNSENT_KEY); } catch { /* ignore */ }
  renderKeepingFocus();
  renderSavedState();
  const r = d.restored;
  const who = r.by && r.by !== server.user?.name ? r.by : 'An admin';
  const at = r.at ? fmtTime(new Date(r.at)) : '';
  if (lost) {
    modal({ title: 'A saved copy was restored', body: el('div',
      el('p', `${who} restored the saved copy "${r.name}"${at ? ` at ${at}` : ''}. The draft is now the one in that copy.`),
      el('p', { style: { marginTop: '8px' } }, 'The change you were making at that moment was not applied. Make it again if it is still needed.')),
    actions: [{ label: 'OK', primary: true }] });
  } else toast(`${who} restored the saved copy "${r.name}". The draft is now the one in that copy.`, { ms: 8000 });
}

/** A colleague saved the shared draft while this browser had changes waiting. */
async function mergeColleague(current) {
  // Load a newer publish first, so the merge below runs in one go with nothing awaited in between.
  if (current.basedOn?.revision !== undefined && current.basedOn.revision !== model.published?.version?.revision) {
    try { await refreshPublished(); } catch { /* the next poll tries again */ }
  }
  const base = server.draftBase || model.published?.bundle;
  const theirs = current.doc || model.published?.bundle;
  const who = whose(current.by);
  const { doc, conflicts } = threeWayMerge(base, theirs, model.draft, { who, names: app.names() });
  server.acceptRemote(current);
  model.adopt(doc);
  model.undoStack = [];
  renderKeepingFocus();
  const lost = conflicts;
  if (lost.length) {
    const body = el('div', el('p', `${who} changed the draft at the same moment as you. Everything you both changed is kept, except ${lost.length === 1 ? 'one thing' : `${lost.length} things`} you both changed, where ${who}'s version was kept:`));
    const ul = el('ul.small');
    for (const c of lost) ul.append(el('li', c));
    body.append(ul);
    modal({ title: 'Changed by two people at once', body, actions: [{ label: 'OK', primary: true }] });
  } else toast(`Merged with ${who}'s changes.`, { ms: 4000 });
}

/** Someone published (or restored): load what TVs show now. The shared draft already has it. */
async function refreshPublished() {
  const published = await app.github.loadPublished();
  await app.media.load(published.mediaIndex);
  model.published = published;
  model.basedOn = { revision: published.version.revision, bundle: published.version.bundle };
}

let polling = false;
async function poll() {
  // Signed out with an edit waiting: the bar offers "Sign in"; no dialog every five seconds.
  if (!SERVER || polling || sync.authLost || document.visibilityState !== 'visible' || sync.busy || save.pending() || !server.user) return;
  polling = true;
  try {
    const st = await server.state();
    let changed = false;
    if (st.revision !== model.published?.version?.revision) { await refreshPublished(); changed = true; }
    // Never take a colleague's draft over anything here the server has not accepted (OBS-2):
    // the next save meets the conflict and merges instead.
    const quiet = () => !sync.busy && !save.pending() && sync.seq === sync.savedSeq && Date.now() - sync.lastEdit > 3000;
    if (st.draftRev !== server.draftRev && quiet()) {
      const editedAt = sync.lastEdit;
      const d = await server.fetchDraft();
      // Only take the colleague's draft if nothing was typed here while it was
      // on its way; otherwise the next save meets a conflict and merges instead.
      if (restoredSince(d) && sync.lastEdit === editedAt && quiet()) { await adoptRestored(d); return; }
      if (d.doc && sync.lastEdit === editedAt && quiet()) {
        server.acceptRemote(d);
        model.adopt(d.doc);
        model.undoStack = [];
        model.savedAt = d.savedAt;
        changed = true;
        if (d.by && d.by !== server.user?.name) toast(`Updated with ${d.by}'s changes.`, { ms: 3000 });
      }
    }
    if (changed) renderKeepingFocus();
  } catch { /* the server may be restarting; try again next time */ }
  finally { polling = false; }
}

/**
 * Redraws the screen after a colleague's changes arrive without taking the
 * cursor away (QA-5): the field that had focus gets it back, with its
 * selection, if it is still there with the same text; the scroll stays put.
 */
function renderKeepingFocus() {
  const fields = () => [...document.querySelectorAll('#screen input, #screen textarea, #screen select')];
  const a = document.activeElement;
  const i = a ? fields().indexOf(a) : -1;
  const was = i >= 0 ? { i, tag: a.tagName, label: a.getAttribute('aria-label'), ph: a.getAttribute('placeholder'), value: a.value, start: a.selectionStart, end: a.selectionEnd } : null;
  const x = window.scrollX, y = window.scrollY;
  const panes = [...document.querySelectorAll('#screen main, #screen aside, #screen .rail, #screen .centre, #screen .side')].map((n) => n.scrollTop);
  renderScreen();
  window.scrollTo(x, y);
  document.querySelectorAll('#screen main, #screen aside, #screen .rail, #screen .centre, #screen .side').forEach((n, k) => { if (panes[k]) n.scrollTop = panes[k]; });
  if (!was) return;
  const b = fields()[was.i];
  if (b && b.tagName === was.tag && b.getAttribute('aria-label') === was.label && b.getAttribute('placeholder') === was.ph && b.value === was.value) {
    b.focus({ preventScroll: true });
    try { if (was.start !== null) b.setSelectionRange(was.start, was.end); } catch { /* not a text field */ }
  }
}

/** Sign-in form, used at boot and when a session runs out mid-work. */
function signInForm(onDone, { compact = false } = {}) {
  let name = '', password = '';
  const msg = el('p.small', { style: { color: 'var(--red)', minHeight: '18px', marginTop: '6px' }, role: 'alert' });
  const nameIn = el('input.in', { id: 'signin-name', type: 'text', autocomplete: 'username', autocapitalize: 'words', spellcheck: 'false', oninput: (e) => { name = e.target.value; } });
  const pwIn = el('input.in', { id: 'signin-password', type: 'password', autocomplete: 'current-password', oninput: (e) => { password = e.target.value; } });
  const btn = el('button.btn.pri', { type: 'submit' }, 'Sign in');
  const form = el('form#signin', { onsubmit: async (e) => {
    e.preventDefault();
    msg.textContent = '';
    btn.disabled = true;
    try { await server.signIn(name.trim(), password); onDone(); }
    catch (err) { msg.textContent = err.message; pwIn.select(); }
    finally { btn.disabled = false; }
  } },
  el('div.field', el('label', { for: 'signin-name' }, 'Name'), nameIn),
  el('div.field', el('label', { for: 'signin-password' }, 'Password'), pwIn),
  el('div.row', btn), msg);
  if (!compact) setTimeout(() => nameIn.focus(), 0);
  return form;
}

function renderSignIn() {
  const root = document.getElementById('app');
  clear(root);
  root.append(el('div.signin-page', el('div.panel.signin',
    el('h1', 'Cave Builder'), el('p.muted', { style: { margin: '2px 0 16px' } }, config.hotelName),
    signInForm(() => location.reload()),
    el('p.muted.tiny', { style: { marginTop: '10px' } }, 'Ask an admin for a sign-in. Forgotten your password? An admin can set a new one.'))));
}

/** The session ran out while working: sign in again in a dialog, then carry on. */
let signingIn = null;   // one sign-in dialog at a time, however many requests asked for it
function signInAgain() {
  if (signingIn) return signingIn;
  signingIn = new Promise((resolve) => {
    let done = false;
    const m = modal({ title: 'Please sign in again', body: el('div', el('p.small.muted', 'Your sign-in has run out. Your work is kept; sign in to carry on.'), signInForm(() => { done = true; m.close(); }, { compact: true })), onClose: () => { signingIn = null; resolve(done); } });
  });
  return signingIn;
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
    // "Hotel details" gives up its second word on narrow screens (QA-13: every screen button stays on an iPad's bar).
    const words = label === 'Hotel details' ? ['Hotel', el('span.nav-more', ' details')] : label;
    nav.append(el('button', { type: 'button', class: (app.screen === key || NAV_ALIAS[app.screen] === key) ? 'on' : '', onclick: () => app.go(key), 'aria-label': label }, words));
  }
  bar.append(nav, el('span.spacer'));
  const n = app.changes().entries.length;
  bar.append(el('span#saved-state.muted.small'));
  bar.append(el('span.pill' + (n ? '.acc' : ''), { id: 'change-count' }, n ? [plural(n, 'change'), el('span.wide-only', ' not yet published')] : 'Nothing to publish'));
  bar.append(el('button.btn.pri', { type: 'button', onclick: () => app.go('publish') }, 'Review & publish'));
  return bar;
}

function tryBanner() {
  if (SERVER) {
    if (app.browser.prefs().serverBannerDismissed) return null;
    const b = el('div.banner.shared', { role: 'note' },
      el('span', el('strong', 'Shared draft. '), 'Everyone signed in works on the same draft, saved on the hotel server as you type. Nothing reaches a TV until someone presses Publish.'),
      el('button.btn.sm', { type: 'button', onclick: () => { app.browser.setPref('serverBannerDismissed', true); b.remove(); } }, 'Got it'));
    return b;
  }
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
  const [screen, a, b] = location.hash.replace(/^#/, '').split('/');   // segments are URI-encoded (a card's field has slashes)
  const params = {};
  if (screen === 'editor' && a) params.page = decodeURIComponent(a);
  if (screen === 'editor' && a && b) params.version = decodeURIComponent(b);
  if (screen === 'overrides' && a) params.page = decodeURIComponent(a);
  if (screen === 'overrides' && a && b) params.field = decodeURIComponent(b);
  if (screen === 'menus' && a) params.menu = decodeURIComponent(a);
  app.screen = SCREENS[screen] ? screen : 'home';
  app.params = params;
}

async function boot() {
  const root = document.getElementById('app');
  if (SERVER) document.body.classList.add('cave-server');
  root.append(el('p.muted', { style: { padding: '40px' } }, 'Loading the published content…'));
  let published = null;
  if (SERVER) {
    let me = null;
    try { me = await server.me(); } catch (e) { clear(root).append(el('p', { style: { padding: '40px' } }, `The Cave server cannot be reached: ${e.message}`)); return; }
    if (!me) { renderSignIn(); return; }
    server.onAuthNeeded = signInAgain;
    server.onSignedIn = () => { sync.authLost = false; renderSavedState(); if (sync.seq !== sync.savedSeq) serverSave(); };
    // Leaving with an edit not yet on the server: the browser asks first.
    window.addEventListener('beforeunload', (e) => { if (sync.seq !== sync.savedSeq) { backupUnsent.flush(); save.flush(); e.preventDefault(); e.returnValue = ''; } });
    // Back online: send what is waiting straight away rather than at the next retry.
    window.addEventListener('online', () => { if (sync.seq !== sync.savedSeq) serverSave(); });
  }
  try {
    published = await app.github.loadPublished();
  } catch (e) {
    app.loadError = e.message + (config.isLocal && !SERVER ? ' (Run builder/tools/seed.py and serve docs/design/site.)' : '');
  }
  app.media = new MediaRegistry({ browserStore: app.browser, githubStore: app.github });
  await app.media.load(published?.mediaIndex);
  if (SERVER) await app.loadRooms();
  const saved = await app.browser.loadDraft();
  if (SERVER && saved && published) {
    // The draft is shared and already holds whatever was published from it,
    // so it simply follows the latest publish; no replay is needed.
    saved.basedOn = { revision: published.version.revision, bundle: published.version.bundle };
  }
  model.load(published, saved);
  if (!SERVER && saved && published && saved.basedOn?.revision !== published.version.revision) {
    await rebaseDraft(saved, published);
  }

  model.on((ev) => {
    if (ev.type === 'media' && app.current?.update) { app.current.update(ev); return; }
    if (ev.type === 'change') {
      touched = true;
      sync.lastEdit = Date.now();
      sync.seq++;
      save();
      backupUnsent();
      if (app.current?.update) app.current.update(ev);
      const bar = document.querySelector('.appbar');
      if (bar) bar.replaceWith(topBar());
      renderSavedState();
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
  if (SERVER) {
    await offerUnsent();            // once the screen is there to redraw
    setInterval(poll, 5000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
  }
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
  model.adopt(doc);
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
