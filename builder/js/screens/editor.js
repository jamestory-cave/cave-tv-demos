// Page editor: parts on the left, live TV preview in the middle, the selected
// part's fields on the right. Every keystroke updates the preview.

import { el, clear, svgIcon, plural, clone } from '../util.js';
import { model, addPage, newPage, movePage, moveInList, PAGE_TYPES, pageChoices } from '../model.js';
import { LIMITS, validQR, galleryFrames, validatePage, linkProblem } from '../validate.js';
import { toast, textField, uid, sortable, moveButtons, iconButton, confirmModal, modal, promptModal } from '../ui.js';
import { TVPreview } from '../preview/stage.js';
import { pickPhoto } from './media.js';
import { pickFilm, posterCapture, filmInfoBox } from './films.js';
import { prepareSlide } from '../media.js';
import { remotePad } from './remote.js';
import { moveModal } from './move.js';
import { frameStill } from '../bundle.js';
import { tagControl, previewAsControl, whoFor } from './overrides.js';
import { getPage, versionPatch, setVersionPatch, effectivePage, diffPatch, effectiveDoc, keyLabel, cardField } from '../overrides.js';
import { framesOf, setFrames, setOptions, galleryOptions, orderByChapter, chapterRuns, chapterNames, matchChapter, chapterKey, cleanChapter, hasChapters, frameCount, parseCaptions, SECONDS_CHOICES, STYLES, GALLERY_PRESETS } from '../gallery.js';

/** Remembered per browser: the TV preview takes most of the window. */
const BIG_KEY = 'cave.builder.largePreview';
const readBig = () => { try { return localStorage.getItem(BIG_KEY) === '1'; } catch { return false; } };
const writeBig = (on) => { try { if (on) localStorage.setItem(BIG_KEY, '1'); else localStorage.removeItem(BIG_KEY); } catch { /* private mode: not remembered */ } };

// Gallery frames are written back with gallery.js setFrames: `slides` when any
// frame needs more than a photo (film, caption, chapter, show whole, sound),
// with `images` carrying every frame's still so an older TV app still shows
// photos; frames that are plain photos are plain `images`, as before.
const framesCopy = (pg) => framesOf(pg).map((fr) => ({ ...fr }));

/** Sets a text field, dropping it when empty so the bundle stays clean. */
const put = (obj, key, v) => { if (v === '' || v == null) delete obj[key]; else obj[key] = v; };

/** How a page field is named in a version's "changed" notes. */
const VERSION_FIELD_LABELS = { title: 'The title', kicker: 'The small caps line', subtitle: 'The subtitle', image: 'The photo', body: 'The text', facts: 'The facts', hoursTitle: 'The hours heading',
  hours: 'The hours', qr: 'The QR link', sections: 'The menu', images: 'The photos', items: 'The cards', description: 'The description', photos: 'The photo frames', films: 'The films', backgroundFilm: 'The background film', slides: 'The slides',
  gallery: 'The gallery settings' };

const PART_DEFS = {
  heading:  { label: 'Heading', hint: 'Small caps line, title, subtitle' },
  photo:    { label: 'Photo', hint: 'Strip and background' },
  text:     { label: 'Text', hint: 'A short paragraph' },
  facts:    { label: 'Facts', hint: 'Up to six points' },
  hours:    { label: 'Hours & details', hint: 'Rows of label and value' },
  qr:       { label: 'QR link', hint: 'A web address and one line' },
  children: { label: 'Pages under it', hint: 'Tiles that open further pages' },
  menu:     { label: 'Menu', hint: 'Parts, dishes, prices' },
  images:   { label: 'Photos and films', hint: 'Captions, chapters, fit, films' },
  gallery:  { label: 'This gallery', hint: 'Style, plays by itself, intro' },
  items:    { label: 'Cards', hint: 'Title, line, text, photo' },
  hotel:    { label: 'Contact card', hint: 'From Hotel details' },
  photos:   { label: 'Photo frames', hint: 'Up to six photos in the page, fill or whole' },
  films:    { label: 'Films', hint: 'Up to four, each with a poster' },
  bg:       { label: 'Background film', hint: 'A silent loop behind the page' },
  slides:   { label: 'Slides', hint: 'Artwork or film, full screen' },
};

function partsFor(page) {
  switch (page.type) {
    case 'home': return ['heading', 'photo', 'children'];
    case 'hub': return ['heading', 'photo', 'text', 'photos', 'films', 'children', 'bg'];
    case 'info': return ['heading', 'photo', 'text', 'facts', 'photos', 'films', 'children', 'hours', 'qr', 'bg'];
    case 'menu': return ['heading', 'photo', 'text', 'menu', 'films', 'hours', 'qr', 'children', 'bg'];
    case 'gallery': return ['heading', 'photo', 'gallery', 'images', 'qr', 'children'];
    case 'list': return ['heading', 'photo', 'text', 'photos', 'films', 'items', 'qr', 'children', 'bg'];
    case 'contact': return ['heading', 'photo', 'hotel', 'facts', 'text', 'photos', 'films', 'qr', 'children', 'bg'];
    case 'finished': return ['heading', 'photo', 'slides', 'qr'];
    default: return ['heading', 'photo'];
  }
}

function partForField(field, type) {
  const head = field.split('.')[0];
  if (type === 'gallery' && (head === 'body' || head === 'gallery')) return 'gallery';
  if (type === 'gallery' && head === 'slides') return 'images';
  return { title: 'heading', kicker: 'heading', subtitle: 'heading', description: 'heading', image: 'photo', body: 'text', facts: 'facts', hours: 'hours', hoursTitle: 'hours', qr: 'qr', children: 'children', childrenTitle: 'children', sections: 'menu', images: 'images', items: 'items',
    photos: 'photos', films: 'films', backgroundFilm: 'bg', slides: 'slides', gallery: 'gallery' }[head] || 'heading';
}

function partSummary(page, part, app) {
  switch (part) {
    case 'heading': return page.title || 'No title';
    case 'photo': return app.media.label(page.image);
    case 'text': return page.body ? page.body.slice(0, 40) + (page.body.length > 40 ? '…' : '') : 'Not used';
    case 'facts': return (page.facts || []).length ? plural(page.facts.length, 'point') : 'Not used';
    case 'hours': return (page.hours || []).length ? `${(page.hoursTitle || '').trim() || 'Opening hours'} · ${plural(page.hours.length, 'row')}` : 'No hours card';
    case 'qr': return page.qr ? page.qr.label || page.qr.url : 'Not used';
    case 'children': return (page.children || []).length ? page.children.map((c) => c.title).join(' · ') : 'None yet';
    case 'menu': { const n = (page.sections || []).reduce((a, s) => a + (s.items || []).length, 0); return `${plural((page.sections || []).length, 'part')} · ${plural(n, 'dish', 'dishes')}`; }
    case 'images': {
      const fr = galleryFrames(page); const n = fr.filter((x) => x.film).length;
      if (!fr.length) return 'None yet';
      const ch = chapterNames(fr).length;
      return `${plural(fr.length - n, 'photo')}${n ? `, ${plural(n, 'film')}` : ''}${ch ? ` in ${plural(ch, 'chapter')}` : ''}`;
    }
    case 'gallery': { const o = galleryOptions(page); return `${STYLES[o.style]}${o.style === 'slideshow' ? `, ${o.seconds} s` : o.autoplay ? `, plays by itself, ${o.seconds} s` : ''}${page.body ? ' · intro' : ''}`; }
    case 'items': return (page.items || []).length ? plural(page.items.length, 'card') : 'None yet';
    case 'hotel': return 'Reception, room service, Wi-Fi, check-out';
    case 'photos': return (page.photos || []).length ? plural(page.photos.length, 'frame') : 'Not used';
    case 'films': return (page.films || []).length ? page.films.map((f) => f.title || 'untitled').join(' · ') : 'Not used';
    case 'bg': return page.backgroundFilm?.film ? app.media.label(page.backgroundFilm.film) : 'Not used';
    case 'slides': return (page.slides || []).length ? `${plural(page.slides.length, 'slide')}${page.slides.some((s) => s.film) ? ', with film' : ''}` : 'None yet';
    default: return '';
  }
}

export function mount(host, app, params) {
  const pageId = params.page;
  const found = model.find(pageId);
  if (!found) { host.append(el('div.empty', 'That page no longer exists. ', el('button.btn.link', { type: 'button', onclick: () => app.go('home') }, 'Back to Home'))); return {}; }

  // Hotel server: tags for room-specific content, and editing one version of a
  // page (stage B): `params.version` is the room type id or room number.
  const SERVER = !!app.server;
  const versionKey = SERVER && params.version !== undefined && params.version !== null ? String(params.version) : null;
  if (versionKey !== null && !getPage(model.draft, pageId)) {
    host.append(el('div.empty', 'This page is the same on every TV now, so it has no versions to edit. ',
      el('button.btn.link', { type: 'button', onclick: () => app.go('editor', { page: pageId }) }, 'Open the page'), ' · ',
      el('button.btn.link', { type: 'button', onclick: () => app.go('overrides') }, 'Overrides')));
    return {};
  }
  const vrec = () => getPage(model.draft, pageId);
  const versionName = () => keyLabel(vrec()?.by, versionKey, app.names()).replace(/^room /, 'Room ');
  /** Who the version is for, for the preview: a type, or a room with its type. */
  const versionWho = () => {
    if (versionKey === null) return null;
    if (vrec()?.by === 'type') return { typeId: versionKey };
    return whoFor(app, `room:${versionKey}`);
  };
  const patchNow = () => (versionKey === null ? {} : versionPatch(model.draft, pageId, versionKey));

  const compact = () => window.innerWidth <= 1200;
  const state = { part: 'heading', field: null, frame: 0, mode: 'edit', safe: false, view: 'draft', focusField: null, showRemote: compact() || matchMedia('(pointer: coarse)').matches, big: readBig() };
  let preview = null;
  /** The page being edited: the master, or in a version the master with that version's changed fields over it. */
  const page = () => {
    const m = model.find(pageId)?.page;
    if (!m || versionKey === null) return m;
    const eff = effectivePage({ ...m, children: [] }, patchNow());
    eff.children = m.children;
    return eff;
  };
  /**
   * Runs an edit on the page. In a version the edit lands on a copy of the
   * effective page, and only the fields that now differ from the master are
   * kept in the version (a field set back to the master's value follows the
   * master again).
   */
  const lens = (fn) => (d) => {
    const m = model.find(pageId, d).page;
    if (versionKey === null) return fn(m, d);
    const eff = effectivePage({ ...m, children: [] }, versionPatch(d, pageId, versionKey));
    const r = fn(eff, d);
    setVersionPatch(d, pageId, versionKey, diffPatch(m, eff));
    return r;
  };
  const commit = (label, fn, key) => {
    model.commit(label, lens(fn), { origin: 'editor', coalesce: key, pageId });
    // Typing while "On TVs now" is showing: flip back to the draft so the change is seen.
    if (state.view === 'published') { state.view = 'draft'; renderCentre(); }
  };

  const sub = el('div.sub');
  const rail = el('div.rail');
  const centre = el('div.centre');
  const side = el('div.side');
  const editorEl = el('div.editor' + (state.big ? '.big' : ''), rail, centre, side);
  const banner = versionKey !== null ? el('div.version-banner', { role: 'note' }) : null;
  host.append(sub, ...(banner ? [banner] : []), editorEl);

  function renderBanner() {
    if (!banner) return;
    clear(banner);
    const n = Object.keys(patchNow()).length;
    banner.append(el('span', el('strong', `Editing ${model.find(pageId).page.title || 'this page'}: ${versionName()} version. `),
      n ? `${plural(n, 'field')} here ${n === 1 ? 'differs' : 'differ'} from the master (marked Changed); everything else follows the master. ` : 'Nothing is changed yet: this version is the master. ',
      'Pages inside it follow the master.'),
      el('span.spacer'),
      el('button.btn.sm', { type: 'button', onclick: () => app.go('overrides', { page: pageId, field: 'page' }) }, 'All versions'),
      el('button.btn.sm', { type: 'button', onclick: () => app.go('editor', { page: pageId }) }, 'Edit the master'));
  }

  function setBig(on) {
    state.big = on;
    writeBig(on);
    editorEl.classList.toggle('big', on);
    renderSub();
    renderSide();
    preview?.fit();
  }

  // ---- sub bar ----
  function renderSub() {
    clear(sub);
    const p = page();
    const e = model.find(pageId);
    const crumb = el('span.crumb', el('button', { type: 'button', onclick: () => app.go('home', { page: pageId }) }, 'Home'));
    e.path.forEach((t, i) => { crumb.append(' › '); crumb.append(i === e.path.length - 1 ? el('b', t) : t); });
    sub.append(crumb, el('span.pill', PAGE_TYPES[p.type]?.label || p.type));
    if (p.hidden) sub.append(el('span.pill.dark', 'Hidden from guests'));
    sub.append(el('span.spacer'));
    sub.append(el('button.btn.sm' + (state.big ? '.on' : ''), { type: 'button', 'aria-pressed': String(state.big), title: state.big ? 'Back to the usual layout' : 'Make the TV preview fill most of the window', onclick: () => setBig(!state.big) }, state.big ? 'Smaller preview' : 'Large preview'));
    sub.append(el('button.btn.sm', { type: 'button', disabled: !model.canUndo, title: model.canUndo ? `Undo ${model.undoLabel}` : 'Nothing to undo', onclick: () => { const l = model.undo(); if (l) toast(`Undid: ${l}`, { ms: 2500 }); } }, '← Undo'));
    sub.append(el('button.btn.sm', { type: 'button', onclick: () => app.go('home', { page: pageId }) }, 'Done'));
  }

  // ---- rail ----
  function renderRail() {
    clear(rail);
    const p = page();
    const v = pageChecks();
    rail.append(el('h3', versionKey !== null ? `Parts of the ${versionName()} version` : 'Parts of this page'));
    const changedParts = new Set(Object.keys(patchNow()).map((k) => partForField(k, p.type)));
    for (const part of parts(p)) {
      const flags = [...v.blockers.map((b) => ({ ...b, k: 'block' })), ...v.warnings.map((w) => ({ ...w, k: 'warn' }))].filter((x) => partForField(x.field, p.type) === part);
      const b = el('button.part' + (part === state.part ? '.sel' : '') + (changedParts.has(part) ? '.changed' : ''), { type: 'button', onclick: () => selectPart(part) },
        el('div.w', el('div.n', PART_DEFS[part].label, changedParts.has(part) ? el('span.pill.amber', { style: { marginLeft: '6px' } }, 'Changed') : null), el('div.s', partSummary(p, part, app))));
      if (flags.length) b.append(el('span.flag.' + (flags.some((f) => f.k === 'block') ? 'block' : 'warn'), { title: flags.map((f) => f.message).join('\n') }));
      rail.append(b);
    }
    rail.append(el('p.muted.tiny', { style: { marginTop: '14px' } }, 'Staff choose the words and photos. The TV decides fonts, colours and where each part sits.'));
  }

  /** Parts shown: in a version, not the pages inside (they follow the master). */
  const parts = (p) => partsFor(p).filter((x) => versionKey === null || x !== 'children');

  /** Checks for the page as edited (a version is checked as the TV would show it). */
  function pageChecks() {
    if (versionKey === null) return app.validation().get(pageId) || { blockers: [], warnings: [] };
    const depth = model.find(pageId)?.depth ?? 0;
    return validatePage(page(), { ...app.validationCtx(), isStrip: depth === 1 || depth === 2 });
  }

  // ---- centre ----
  function renderCentre() {
    clear(centre);
    const modeSeg = el('div.seg', { role: 'group', 'aria-label': 'Preview mode' });
    for (const [v, label] of [['edit', 'Edit'], ['remote', 'Try the remote']]) {
      modeSeg.append(el('button', { type: 'button', class: state.mode === v ? 'on' : '', 'aria-pressed': String(state.mode === v), onclick: () => setMode(v) }, label));
    }
    const safe = el('label.check', el('input', { type: 'checkbox', checked: state.safe, onchange: (e) => { state.safe = e.target.checked; preview.setSafeArea(state.safe); } }), 'Safe area');
    const viewSeg = el('div.seg', { role: 'group', 'aria-label': 'Draft or published' });
    for (const [v, label] of [['draft', 'Draft'], ['published', 'On TVs now']]) {
      viewSeg.append(el('button', { type: 'button', class: state.view === v ? 'on' : '', 'aria-pressed': String(state.view === v), onclick: () => { state.view = v; renderCentre(); } }, label));
    }
    const remoteToggle = el('label.check', el('input', { type: 'checkbox', checked: state.showRemote, onchange: (e) => { state.showRemote = e.target.checked; wrap.classList.toggle('show-remote', state.showRemote); } }), 'On-screen remote');
    centre.append(el('div.row.between.wrap', { style: { marginBottom: '10px', gap: '8px' } }, el('div.row', modeSeg, safe, state.mode === 'remote' ? remoteToggle : null), viewSeg));
    // Hotel server: see what one room type or room will get (room number, else room type, else master).
    if (SERVER && versionKey === null && state.view === 'draft') {
      const asNote = el('span.small.muted');
      const sayAs = () => { asNote.textContent = app.previewAs ? 'Showing what that TV will get. Edits here change the master.' : ''; };
      centre.append(el('div.row.wrap', { style: { marginBottom: '8px', gap: '10px' } }, previewAsControl(app, app.previewAs || '', (v) => { app.previewAs = v; sayAs(); refreshPreview(false); }), asNote));
      centre.append(el('div.small.held-note', { style: { color: 'var(--amber)', marginBottom: '6px' }, role: 'status' }));
      sayAs();
    }
    const tvHost = el('div.tv-host');
    const wrap = el('div.remote-wrap' + (state.showRemote && state.mode === 'remote' ? '.show-remote' : ''), tvHost);
    centre.append(wrap);
    preview?.destroy();
    preview = new TVPreview(tvHost, {
      media: app.media, logoURL: app.logoURL,
      onSelectField: (pid, field) => {
        if (pid === 'hotel') { toast('Reception, room service, Wi-Fi and check-out are set in Hotel details.', { action: 'Open', onAction: () => app.go('hotel') }); return; }
        if (pid !== pageId) { app.go('editor', { page: pid }); return; }
        state.focusField = field;
        selectPart(partForField(field, page().type), field);
      },
      onNavigate: (pid) => { if (pid !== pageId && state.mode === 'edit' && model.find(pid)) app.go('editor', { page: pid }); },
    });
    preview.setSafeArea(state.safe);
    if (window.cave) window.cave.preview = preview;   // for the developer harness and QA scripts
    refreshPreview(true);
    preview.setMode(state.mode);
    wrap.append(remotePad((k) => preview.key(k), { wide: compact() }));
    preview.fit();
    const scaleCap = el('span.muted.tiny');
    const showScale = () => { scaleCap.textContent = `1920 × 1080, shown at ${Math.round((preview.viewport.clientWidth || 800) / 1920 * 100)}%`; };
    preview.onFit = showScale;
    showScale();
    centre.append(el('div.tvcap', el('span.muted.small', state.mode === 'edit' ? 'Click anything on the TV to edit it. Click a strip to open it.' : 'Arrow keys move, Enter selects, Esc is Menu, Space is Play/Pause. Click the TV first if the keys do nothing.'), scaleCap));
    if (state.view === 'published' && !model.find(pageId, model.published?.bundle)) {
      centre.append(el('div.note.small', { style: { marginTop: '8px' } }, 'Not on TVs yet. This page is new; it goes to the TV when you publish.'));
    }
  }

  function refreshPreview(navigate = false) {
    // In a version, or with "Preview as" chosen, the preview shows that TV's content.
    const who = versionKey !== null ? versionWho() : (SERVER && app.previewAs ? whoFor(app, app.previewAs) : null);
    // Preview as shows what that TV will get: a value held back is drawn as the TV will have it (QA-7).
    // A version being edited is drawn as typed, so the edit is seen.
    let doc = state.view === 'published' ? model.published?.bundle : model.draft;
    if (state.view !== 'published' && who) {
      if (versionKey !== null) doc = effectiveDoc(model.draft, who);
      else {
        const { overrides, blocked } = app.liveOverrides();
        doc = effectiveDoc({ ...model.draft, overrides }, who);
        const mine = blocked.filter((b) => (b.by === 'type' ? String(b.key) === String(who.typeId) : who.room && String(b.key).toLowerCase() === String(who.room).toLowerCase()));
        const note = centre.querySelector('.held-note');
        if (note) note.textContent = mine.length ? `${plural(mine.length, 'value')} for this TV ${mine.length === 1 ? 'is' : 'are'} held back (${mine.map((b) => `${model.pathLabel(b.pageId)}: ${b.message}`).join('; ')}). The preview shows what the TV will get until ${mine.length === 1 ? 'it is' : 'they are'} fixed.` : '';
      }
    }
    if (!doc) return;
    const slide = preview.slideIndex;
    preview.setDoc(doc, { reveal: [pageId] });
    if (navigate) preview.showPage(pageId);
    else if (slide) preview.showSlide(slide);
    if (state.field) preview.setSelectedField(`${pageId}|${state.field}`);
  }

  function setMode(m) {
    state.mode = m;
    renderCentre();
    if (m === 'remote') preview.stage.focus();
  }

  // ---- side ----
  function selectPart(part, field = null) {
    state.part = part;
    state.field = field;
    const fm = /^images\.(\d+)/.exec(field || '');
    if (fm) state.frame = Number(fm[1]);
    renderRail();
    renderSide();
    preview.setSelectedField(field ? `${pageId}|${field}` : null);
    const slideMatch = /^slides\.(\d+)/.exec(field || '');
    if (slideMatch) preview.showSlide(Number(slideMatch[1]));
    // Scroll the TV's page area so the part being edited is in view (QA2-1).
    const PART_ANCHOR = { gallery: null, heading: 'title', photo: null, text: 'body', facts: 'facts', hours: 'hours', qr: 'qr', children: 'children', menu: 'sections', images: 'images', items: 'items', hotel: 'reception', photos: 'photos', films: 'films', bg: 'backgroundFilm', slides: null };
    const anchor = field || PART_ANCHOR[part];
    if (anchor) preview.revealField(`${part === 'hotel' ? 'hotel' : pageId}|${anchor}`);
    if (field) {
      const target = side.querySelector(`[data-field="${CSS.escape(field)}"]`) || (fm ? side.querySelector(`[data-field="images.${fm[1]}.caption"]`) : null);
      if (target) { target.focus(); target.scrollIntoView({ block: 'nearest' }); }
    }
  }

  /** The tag control under a field that can differ by room (hotel server, master only). */
  const tag = (field, label) => (SERVER && versionKey === null ? tagControl(app, pageId, field, label ? { label } : {}) : '');

  const tf = (o) => {
    const f = textField({ id: uid('e'), ...o });
    f.input.dataset.field = o.field;
    f.input.addEventListener('focus', () => { state.field = o.field; preview.setSelectedField(`${pageId}|${o.field}`); preview.revealField(`${pageId}|${o.field}`); });
    return f;
  };

  function renderSide() {
    clear(side);
    const p = page();
    if (state.big) {
      // The parts list is folded away: choose a part here, or click the TV.
      const pick = el('select.in', { 'aria-label': 'Part of this page', onchange: (e) => selectPart(e.target.value) });
      for (const part of parts(p)) pick.append(el('option', { value: part, selected: part === state.part }, `${PART_DEFS[part].label} · ${partSummary(p, part, app)}`));
      side.append(el('label.small.muted', { style: { display: 'block', marginBottom: '4px' } }, 'Part of this page'), pick, el('div', { style: { height: '12px' } }));
    }
    side.append(el('div.row.between', { style: { marginBottom: '10px' } }, el('h2', { style: { margin: 0 } }, PART_DEFS[state.part].label), el('span.muted.small', PART_DEFS[state.part].hint)));
    // In a version: each field of this part that differs from the master, with Back to master.
    if (versionKey !== null) {
      const changed = Object.keys(patchNow()).filter((k) => partForField(k, p.type) === state.part);
      for (const k of changed) {
        side.append(el('div.note.warn.small.vchanged', { style: { marginBottom: '8px' } }, el('strong', `${VERSION_FIELD_LABELS[k] || k} is changed in this version. `),
          el('button.btn.sm', { type: 'button', onclick: () => { model.commit(`${VERSION_FIELD_LABELS[k] || k}: back to the master`, (d) => { const pt = { ...versionPatch(d, pageId, versionKey) }; delete pt[k]; setVersionPatch(d, pageId, versionKey, pt); }, { pageId }); renderSide(); } }, 'Back to master')));
      }
    }
    const body = el('div');
    side.append(body);
    switch (state.part) {
      case 'heading': renderHeading(body, p); break;
      case 'photo': renderPhoto(body, p); break;
      case 'text': renderText(body, p); break;
      case 'facts': renderFacts(body, p); break;
      case 'hours': renderHours(body, p); break;
      case 'qr': renderQR(body, p); break;
      case 'children': renderChildren(body, p); break;
      case 'menu': renderMenuPart(body, p); break;
      case 'images': renderImages(body, p); break;
      case 'gallery': renderGallerySettings(body, p); break;
      case 'items': renderItems(body, p); break;
      case 'hotel': renderHotelPart(body); break;
      case 'photos': renderPhotos(body, p); break;
      case 'films': renderFilms(body, p); break;
      case 'bg': renderBackground(body, p); break;
      case 'slides': renderSlides(body, p); break;
    }
    // Fields that differ from the master in this version are marked.
    if (versionKey !== null) {
      const changed = new Set(Object.keys(patchNow()));
      body.querySelectorAll('[data-field]').forEach((n) => {
        if (changed.has(n.dataset.field.split('.')[0])) (n.closest('.field') || n).classList.add('changed');
      });
    }
    side.append(el('div.rule'));
    side.append(el('h3', versionKey !== null ? 'Checks on this version' : 'Checks on this page'));
    side.append(el('div#checks', checks(p)));
    side.append(el('div.rule'));
    side.append(el('h3', 'This page'));
    if (versionKey !== null) {
      side.append(el('p.small.muted', 'Hiding, moving and the pages inside are the same in every version: change them on the master.'));
      side.append(el('div.row.wrap', el('button.btn.sm', { type: 'button', onclick: () => app.go('editor', { page: pageId }) }, 'Edit the master'), el('button.btn.sm', { type: 'button', onclick: () => app.go('overrides', { page: pageId, field: 'page' }) }, 'All versions')));
      return;
    }
    if (SERVER && p.id !== 'home') {
      side.append(el('div.field', el('label.small', 'This whole page'), tagControl(app, pageId, 'page', { label: 'This page' }),
        el('div.help', 'A version per room type or room, each starting as this page. Only what you change in a version differs; the pages inside it stay the same everywhere.')));
    }
    const ops = el('div.row.wrap');
    if (p.id !== 'home') {
      ops.append(el('button.btn.sm', { type: 'button', onclick: () => commit(p.hidden ? `Show ${p.title}` : `Hide ${p.title}`, (pg) => { if (pg.hidden) delete pg.hidden; else pg.hidden = true; }) }, p.hidden ? 'Show to guests' : 'Hide from guests'));
      ops.append(el('button.btn.sm', { type: 'button', onclick: () => moveModal(app, pageId, { onMoved: () => { renderSub(); renderCentre(); renderSide(); } }) }, 'Move to…'));
    }
    ops.append(el('button.btn.sm', { type: 'button', onclick: () => app.go('home', { page: pageId }) }, 'Open in Home'));
    side.append(ops);
  }

  function checks(p) {
    const v = pageChecks();
    void p;
    const box = el('div');
    for (const b of v.blockers) box.append(el('div.note.block.small', el('strong', 'Held back. '), b.message + '.'));
    for (const w of v.warnings) box.append(el('div.note.warn.small', el('strong', 'Warning. '), w.message + '.'));
    if (!v.blockers.length) box.append(el('p.small.muted', { style: { marginTop: '6px' } }, v.warnings.length ? 'Warnings do not stop publishing.' : 'No problems. This page can be published.'));
    return box;
  }

  // ---- part panels ----
  function renderHeading(box, p) {
    if (p.type === 'finished') {
      box.append(tf({ label: 'Title, for its strip and the path line', field: 'title', value: p.title || '', limit: LIMITS.title, onInput: (v) => commit('Edit title', (pg) => { pg.title = v; }, 'title') }), tag('title'));
      box.append(tf({ label: 'What does it say?', field: 'description', value: p.description || '', limit: LIMITS.description, multiline: true, rows: 3, placeholder: 'Fire plan for all three levels with the assembly point at the front of the hotel.', help: 'Not shown on the TV. The words in artwork are pixels; this plain sentence gives search and read-aloud something to use later.', onInput: (v) => commit('Edit description', (pg) => put(pg, 'description', v), 'description') }));
      box.append(el('div.note.small', { style: { marginTop: '4px' } }, 'Words and prices in this artwork can only be changed by uploading a new version. Anything that changes often belongs on a page built from parts.'));
      return;
    }
    box.append(tf({ label: 'Small caps line', field: 'kicker', value: p.kicker || '', limit: LIMITS.kicker, help: 'Shown in gold above the title, e.g. "AA 2 Rosettes".', onInput: (v) => commit('Edit small caps line', (pg) => put(pg, 'kicker', v), 'kicker') }), tag('kicker'));
    box.append(tf({ label: 'Title', field: 'title', value: p.title || '', limit: LIMITS.title, onInput: (v) => commit('Edit title', (pg) => { pg.title = v; }, 'title') }), tag('title'));
    if (p.type !== 'gallery') box.append(tf({ label: 'Subtitle', field: 'subtitle', value: p.subtitle || '', limit: LIMITS.subtitle, help: 'One line under the title.', onInput: (v) => commit('Edit subtitle', (pg) => put(pg, 'subtitle', v), 'subtitle') }), tag('subtitle'));
  }

  function renderPhoto(box, p) {
    const thumb = el('div.thumb');
    const url = app.media.url(p.image, 800);
    if (url) thumb.style.backgroundImage = `url("${url}")`;
    const missing = p.image && !app.media.known(p.image);
    const firstSlide = (p.slides || []).find((s) => s.image || s.poster);
    box.append(el('div.photo-pick', thumb, el('div', el('div.small', { style: missing ? { color: 'var(--red)', fontWeight: '600' } : {} }, missing ? 'Photo missing: it is no longer in Media. Choose another.' : app.media.label(p.image)), el('div.row.wrap', { style: { marginTop: '6px' } },
      el('button.btn.sm', { type: 'button', onclick: () => pickPhoto(app, { use: 'strip', onPick: (src) => commit('Change photo', (pg) => { pg.image = src; }) }) }, 'Choose photo'),
      p.type === 'finished' && firstSlide ? el('button.btn.sm', { type: 'button', onclick: () => commit('Use slide 1 as the strip photo', (pg) => { pg.image = (firstSlide.image || firstSlide.poster).replace(/-3840\.jpg$/, '-1920.jpg'); }) }, 'Use slide 1') : null,
      p.image && p.id !== 'home' ? el('button.btn.sm', { type: 'button', onclick: () => commit('Remove photo', (pg) => { delete pg.image; }) }, 'Remove') : null))));
    box.append(el('p.help', p.type === 'finished'
      ? 'The strip on the way in. Slide 1 cropped to the strip is the usual choice; if the artwork is mostly lettering, a photograph looks better cut into a thin strip.'
      : 'One photo does both jobs: the strip on the way in and the background of the page. Landscape, 1920 px wide or more. Logos and artwork belong in a photo frame set to "Show the whole image", or a Finished page.'));
    if (p.id !== 'home') { const t = tag('image'); if (t) box.append(t); }
  }

  // ---- stage 2 parts ----
  function renderPhotos(box, p) {
    const photos = p.photos || [];
    listEditor(box, {
      items: photos,
      render: (ph, i) => {
        const th = el('div.thumb' + (ph.fit === 'whole' ? '.whole' : ''));
        const url = app.media.url(ph.image, 800);
        if (url) th.style.backgroundImage = `url("${url}")`;
        const fitRow = el('div.fit', { role: 'radiogroup', 'aria-label': `Photo frame ${i + 1} fit` });
        for (const [v, label, help] of [['fill', 'Fill the frame', 'Scaled to fill and cropped to 16:9, like the header photo. Right for photographs.'], ['whole', 'Show the whole image', 'The entire image on a dark ground, never cropped. Right for logos, posters and plans.']]) {
          const on = (ph.fit || 'fill') === v;
          fitRow.append(el('label.fit-opt' + (on ? '.on' : ''), el('input', { type: 'radio', name: `fit-${i}`, checked: on, onchange: () => commit('Change photo fit', (pg) => { pg.photos[i].fit = v; }) }), el('span', el('b', label), el('small', help))));
        }
        return [
          el('div.photo-pick', { dataset: { field: `photos.${i}.image` }, tabindex: '-1' }, th, el('div', el('div.small', app.media.label(ph.image)),
            el('button.btn.sm', { type: 'button', style: { marginTop: '4px' }, onclick: () => pickPhoto(app, { use: 'frame', onPick: (src, o) => commit('Change frame photo', (pg) => { pg.photos[i].image = src; if (o?.fit) pg.photos[i].fit = o.fit; }) }) }, ph.image ? 'Swap photo' : 'Choose photo'))),
          fitRow,
          tf({ label: 'Caption (optional)', field: `photos.${i}.caption`, value: ph.caption || '', limit: LIMITS.caption, onInput: (v) => commit('Edit caption', (pg) => put(pg.photos[i], 'caption', v), `photos.${i}.caption`) }),
        ];
      },
      onMove: (a, b) => commit('Reorder photo frames', (pg) => moveInList(pg.photos, a, b)),
      onAdd: () => pickPhoto(app, { use: 'frame', onPick: (src, o) => { commit('Add photo frame', (pg) => { pg.photos = pg.photos || []; pg.photos.push({ image: src, fit: o?.fit || 'fill' }); }); renderSide(); } }),
      onRemove: (i) => removeWithUndo('photo frame', (pg) => pg.photos.splice(i, 1)[0], (pg, v) => { pg.photos = pg.photos || []; pg.photos.splice(i, 0, v); }),
      addLabel: 'Add photo frame', max: LIMITS.photosMax,
    });
    box.append(el('p.help', `Shown in the main column after the facts, each a stop for the remote. Up to ${LIMITS.photosMax}; for more, use a Photo gallery page.`));
  }

  function filmRow(fl, i, field, label) {
    const th = el('div.thumb.film');
    const url = fl.poster ? app.media.url(fl.poster, 800) : null;
    if (url) th.style.backgroundImage = `url("${url}")`;
    th.append(el('span.play'));
    const missingPoster = fl.film && !fl.poster;
    return el('div', { dataset: { field: `${field}.film` }, tabindex: '-1' },
      el('div.photo-pick', th, el('div', el('div.small', el('b', app.media.label(fl.film))),
        el('div.row.wrap', { style: { marginTop: '6px' } },
          el('button.btn.sm', { type: 'button', onclick: () => pickFilm(app, { onPick: (src, rec) => commit(`Change ${label}`, (pg) => { const t = getAt(pg, field); t.film = src; t.seconds = rec.seconds; if (rec.poster) t.poster = rec.poster; else delete t.poster; }) }) }, 'Swap film'),
          el('button.btn.sm' + (missingPoster ? '.pri' : ''), { type: 'button', dataset: { field: `${field}.poster` }, onclick: () => posterCapture(app, fl.film, { title: fl.title, previous: fl.poster || null, onDone: (src) => commit('Set poster', (pg) => { getAt(pg, field).poster = src; }) }) }, fl.poster ? 'Change poster' : 'Capture a poster'),
          fl.poster ? el('button.btn.sm', { type: 'button', onclick: () => pickPhoto(app, { use: 'poster', onPick: (src) => commit('Set poster', (pg) => { getAt(pg, field).poster = src; }) }) }, 'Poster from Media') : null))),
      el('div', { style: { marginTop: '6px' } }, filmInfoBox(app, fl.film)),
      missingPoster ? el('div.help', { style: { color: 'var(--red)' } }, 'No poster yet. The TV shows the poster before the film plays; capture a frame or choose a photo.') : null);
  }

  const getAt = (pg, field) => field.split('.').reduce((o, k) => (o == null ? o : o[/^\d+$/.test(k) ? Number(k) : k]), pg);

  function renderFilms(box, p) {
    const films = p.films || [];
    listEditor(box, {
      items: films,
      render: (fl, i) => [
        filmRow(fl, i, `films.${i}`, 'film'),
        tf({ label: 'Title', field: `films.${i}.title`, value: fl.title || '', limit: LIMITS.filmTitle, placeholder: 'Your lighting scenes', onInput: (v) => commit('Edit film title', (pg) => put(pg.films[i], 'title', v), `films.${i}.title`) }),
      ],
      onMove: (a, b) => commit('Reorder films', (pg) => moveInList(pg.films, a, b)),
      onAdd: () => pickFilm(app, { onPick: (src, rec) => { commit('Add film', (pg) => { pg.films = pg.films || []; pg.films.push({ film: src, poster: rec.poster || undefined, title: rec.name.slice(0, LIMITS.filmTitle), seconds: rec.seconds }); }); renderSide(); if (!rec.poster) posterCapture(app, src, { title: rec.name, onDone: (ps) => commit('Set poster', (pg) => { const f = pg.films.find((x) => x.film === src); if (f) f.poster = ps; }) }); } }),
      onRemove: (i) => removeWithUndo('film', (pg) => pg.films.splice(i, 1)[0], (pg, v) => { pg.films = pg.films || []; pg.films.splice(i, 0, v); }),
      addLabel: 'Add film', max: LIMITS.filmsMax,
    });
    box.append(el('p.help', `A 16:9 poster card with a play glyph and the title, in the main column. Select opens the TV's player full screen with sound; Menu returns to the card. Up to ${LIMITS.filmsMax} a page.`));
  }

  function renderBackground(box, p) {
    const bg = p.backgroundFilm;
    if (!bg) {
      box.append(el('p.small.muted', 'No background film. The page shows its photo behind the words.'));
      box.append(el('button.btn.sm', { type: 'button', onclick: () => pickFilm(app, { silentOnly: true, onPick: (src, rec) => { commit('Add background film', (pg) => { pg.backgroundFilm = { film: src, poster: rec.poster || undefined }; }); renderSide(); } }) }, '+ Choose a silent film'));
      box.append(el('p.help', { style: { marginTop: '10px' } }, 'A short silent loop (8 to 20 seconds that ends where it starts) drawn in place of the page photo while the page is open. The TV falls back to the poster, or the page photo, until the film has downloaded or when the guest has Reduce Motion on. The preview shows the poster with a "loops silently" label; it never plays video.'));
      box.append(el('p.help', 'On the TV the text disappears after 6 seconds so the film shows through; Select on text hides it at once; any press brings it back.'));
      return;
    }
    box.append(filmRow(bg, 0, 'backgroundFilm', 'background film'));
    box.append(el('div.row.wrap', { style: { marginTop: '10px' } },
      el('button.btn.sm', { type: 'button', onclick: () => pickFilm(app, { silentOnly: true, onPick: (src, rec) => commit('Change background film', (pg) => { pg.backgroundFilm = { film: src, poster: rec.poster || undefined }; }) }) }, 'Choose another'),
      el('button.btn.sm.danger', { type: 'button', onclick: () => removeWithUndo('background film', (pg) => { const b = pg.backgroundFilm; delete pg.backgroundFilm; return b; }, (pg, v) => { pg.backgroundFilm = v; }) }, 'Remove')));
    box.append(el('p.help', { style: { marginTop: '10px' } }, 'Loops silently behind the page. Films with a sound track are held back unless marked as silent in Media.'));
    box.append(el('p.help', 'On the TV the text disappears after 6 seconds so the film shows through; Select on text hides it at once; any press brings it back.'));
  }

  function renderSlides(box, p) {
    const slides = p.slides || [];
    box.append(el('div.note.small', { style: { marginBottom: '10px' } }, el('strong', 'Artwork rules. '),
      'Exactly 16:9. 3840 × 2160 is best; 1920 × 1080 is the minimum. JPG or PNG up to 25 MB. On a 1920-wide canvas keep words and logos 96 px in from the sides and 64 px from the top and bottom, and out of the top 200 px where the path line and Back sit. With a QR link, keep the bottom-right 340 × 430 px clear for the QR card. Smallest body text 30 px; nothing under 24. About 60 words at most. ',
      el('button.btn.link.sm', { type: 'button', onclick: () => app.go('guide') }, 'Full guide and template')));
    listEditor(box, {
      items: slides,
      render: (sl, i) => {
        const th = el('div.thumb' + (sl.film ? '.film' : ''));
        const url = app.media.url(sl.film ? sl.poster : sl.image, 800);
        if (url) th.style.backgroundImage = `url("${url}")`;
        if (sl.film) th.append(el('span.play'));
        th.style.backgroundSize = 'contain';
        th.style.backgroundColor = '#111';
        const size = app.media.size(sl.image);
        const info = sl.film ? filmInfoBox(app, sl.film) : el('div.small.muted', size ? `${size.width} × ${size.height}${size.width >= 3840 ? '' : ' · 3840 × 2160 is sharper'}` : app.media.known(sl.image) ? 'Size unknown' : '');
        const row = el('div', { dataset: { field: `slides.${i}.image` }, tabindex: '-1', onclick: () => preview.showSlide(i) });
        row.append(el('div.photo-pick', th, el('div', el('div.small', el('b', `Slide ${i + 1}: `), app.media.label(sl.film || sl.image)), sl.film ? null : info,
          el('div.row.wrap', { style: { marginTop: '6px' } },
            sl.film
              ? el('button.btn.sm', { type: 'button', onclick: () => posterCapture(app, sl.film, { title: p.title, previous: sl.poster || null, onDone: (src) => commit('Set poster', (pg) => { pg.slides[i].poster = src; }) }) }, sl.poster ? 'Change poster' : 'Capture a poster')
              : el('button.btn.sm', { type: 'button', onclick: () => pickPhoto(app, { use: 'slide', onPick: (src) => commit('Replace slide', (pg) => { pg.slides[i].image = app.media.slidePath(src); }) }) }, 'Replace'),
            el('button.btn.sm', { type: 'button', onclick: () => preview.showSlide(i) }, 'Show in preview')))));
        if (sl.film) row.append(el('div', { style: { marginTop: '6px' } }, info));
        return row;
      },
      onMove: (a, b) => commit('Reorder slides', (pg) => moveInList(pg.slides, a, b)),
      onAdd: () => addSlide(p),
      onRemove: (i) => removeWithUndo('slide', (pg) => pg.slides.splice(i, 1)[0], (pg, v) => { pg.slides = pg.slides || []; pg.slides.splice(i, 0, v); }),
      addLabel: 'Add slide', max: LIMITS.slidesMax,
    });
    box.append(el('div.row.wrap', { style: { marginTop: '6px' } }, el('button.btn.sm', { type: 'button', disabled: slides.length >= LIMITS.slidesMax, onclick: () => addFilmSlide(p) }, '+ Add a film slide')));
    box.append(el('p.help', { style: { marginTop: '10px' } }, 'The Builder checks size, shape and file type. It cannot read the artwork: switch on "Safe area" above the TV and check the margins and the top band by eye. Left and Right move between slides on the TV; nothing else on a finished page can be selected.'));
  }

  function addSlide(p) {
    const input = el('input', { type: 'file', accept: 'image/jpeg,image/png', multiple: true, class: 'sr-only', id: uid('sl') });
    let picked = false;
    input.addEventListener('change', async () => {
      const files = [...input.files]; input.value = '';
      let n = 0;
      for (const file of files) {
        try {
          const rec = await prepareSlide(file);
          if (!app.media.pending.has(rec.hash) && !app.media.index.media[rec.hash]) await app.media.add(rec);
          const src = app.media.slidePath(`media/${rec.hash}-1920.jpg`);   // -3840 when the upload was 4K
          const strip = `media/${rec.hash}-1920.jpg`;
          const hadImage = !!page().image;
          commit('Add slide', (pg) => { pg.slides = pg.slides || []; if (pg.slides.length < LIMITS.slidesMax) pg.slides.push({ image: src }); if (!pg.image) pg.image = strip; });
          if (!hadImage) stripToast();
          n++;
          if (rec.warnings?.length) toast(`${rec.name}: ${rec.warnings.join(' ')}`, { ms: 9000 });
        } catch (e) { toast(`${file.name}: ${e.message}`, { error: true, ms: 15000 }); }
      }
      if (n) { toast(`${plural(n, 'slide')} added. Check the margins with the safe-area overlay.`); picked = true; m.close(); renderSide(); preview.showSlide((page().slides || []).length - 1); }
    });
    const zone = el('div.drop', el('div', el('strong', 'Drop artwork here '), el('span.muted', 'or '), el('label.btn.sm', { for: input.id }, 'Choose files'), input),
      el('span.muted.small', 'JPG or PNG · exactly 16:9 · 3840 × 2160 best, 1920 × 1080 minimum · up to 25 MB'));
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); const dt = new DataTransfer(); for (const f of e.dataTransfer.files) dt.items.add(f); input.files = dt.files; input.dispatchEvent(new Event('change')); });
    const body = el('div', zone,
      el('ul.small', { style: { paddingLeft: '18px', margin: '0 0 10px', lineHeight: '1.6' } },
        el('li', 'Exactly 16:9. 3840 × 2160 preferred; 1920 × 1080 minimum. JPG for photographs, PNG for lettering.'),
        el('li', 'Keep words and logos inside the safe margins: 96 px from the sides, 64 px from the top and bottom, on a 1920 canvas (double at 3840).'),
        el('li', 'Keep the top 200 px (400 at 3840) free of words: the TV darkens that band and draws the path line and Back there. Pictures may run through it.'),
        el('li', 'Smallest body text 30 px on a 1920 canvas; nothing under 24. Guests read from the bed.'),
        el('li', 'No more than about 60 words. More than that is a page built from parts.'),
        el('li', 'If the page has a QR link, keep the bottom-right 340 × 430 px (680 × 860 at 3840) clear: the TV draws the QR card there.')),
      el('p.help', 'The Builder checks size, shape and file type and refuses anything else. It cannot read the artwork, so margins and text size are checked by eye with the safe-area overlay.'),
      el('div.row', { style: { marginTop: '10px' } }, el('button.btn.sm', { type: 'button', onclick: () => { m.close(); pickPhoto(app, { use: 'slide', onPick: (src) => { const hadImage = !!page().image; commit('Add slide', (pg) => { pg.slides = pg.slides || []; pg.slides.push({ image: app.media.slidePath(src) }); if (!pg.image) pg.image = src; }); if (!hadImage) stripToast(); renderSide(); } }); } }, 'Choose from Media instead')));
    const m = modal({ title: `Add a slide to ${p.title}`, body, wide: false, actions: [{ label: 'Cancel' }] });
    void picked;
  }

  /** Said once, when the first slide quietly becomes the strip photo. */
  function stripToast() {
    toast('Slide 1 is now the strip photo as well. If the artwork is mostly lettering, choose a photograph under Photo instead.', { ms: 9000 });
  }

  function addFilmSlide(p) {
    pickFilm(app, { onPick: (src, rec) => {
      const hadImage = !!page().image;
      commit('Add film slide', (pg) => { pg.slides = pg.slides || []; pg.slides.push({ film: src, poster: rec.poster || undefined }); if (!pg.image && rec.poster) pg.image = rec.poster; });
      if (!hadImage && rec.poster) stripToast();
      renderSide();
      if (!rec.poster) posterCapture(app, src, { title: p.title, onDone: (ps) => { const had = !!page().image; commit('Set poster', (pg) => { const sl = pg.slides.find((x) => x.film === src); if (sl) sl.poster = ps; if (!pg.image) pg.image = ps; }); if (!had) stripToast(); } });
    } });
  }

  function renderText(box, p) {
    box.append(tf({ label: 'Paragraph', field: 'body', value: p.body || '', limit: LIMITS.body, multiline: true, rows: 7, help: 'Two or three sentences read best from the bed.', onInput: (v) => commit('Edit text', (pg) => put(pg, 'body', v), 'body') }), tag('body'));
  }

  function listEditor(box, { items, render, onMove, onAdd, onRemove, addLabel, max, selector = '.list-row', empty = 'Nothing here yet.' }) {
    const list = el('div', { role: 'list' });
    items.forEach((item, i) => {
      const row = el('div.list-row', { draggable: 'true', role: 'listitem' });
      row.append(el('span.grip', { title: 'Drag to reorder' }, svgIcon('grip', 14)));
      row.append(el('div.fields', render(item, i)));
      const ops = moveButtons(i, items.length, onMove);
      ops.append(iconButton('close', 'Remove', () => onRemove(i)));
      row.append(ops);
      list.append(row);
    });
    sortable(list, selector, onMove);
    box.append(list);
    if (!items.length && empty) box.append(el('p.muted.small', empty));
    box.append(el('div', { style: { marginTop: '8px' } }, el('button.btn.sm', { type: 'button', disabled: max && items.length >= max, onclick: onAdd }, '+ ' + addLabel)));
  }

  function renderFacts(box, p) {
    listEditor(box, {
      items: p.facts || [],
      render: (t, i) => tf({ label: `Fact ${i + 1}`, field: `facts.${i}`, value: t, limit: LIMITS.fact, onInput: (v) => commit('Edit fact', (pg) => { pg.facts[i] = v; }, `facts.${i}`) }),
      onMove: (a, b) => commit('Reorder facts', (pg) => moveInList(pg.facts, a, b)),
      onAdd: () => { commit('Add fact', (pg) => { pg.facts = pg.facts || []; pg.facts.push(''); }); renderSide(); },
      onRemove: (i) => removeWithUndo('fact', (pg) => pg.facts.splice(i, 1)[0], (pg, v) => pg.facts.splice(i, 0, v)),
      addLabel: 'Add fact', max: LIMITS.factsMax + 4,
    });
  }

  function renderHours(box, p) {
    const rows = p.hours || [];
    if (!rows.length) {
      box.append(el('div.note.small', { style: { marginBottom: '10px' } }, el('strong', 'No hours card. '), 'Nothing about hours shows on this page. Add a row to show a card of times in the side column.'));
    } else {
      box.append(tf({ label: 'Heading', field: 'hoursTitle', value: p.hoursTitle || '', limit: LIMITS.hoursTitle, placeholder: 'Opening hours', help: 'Shown in capitals above the rows. Leave empty for "Opening hours".', onInput: (v) => commit('Edit hours heading', (pg) => put(pg, 'hoursTitle', v), 'hoursTitle') }));
    }
    listEditor(box, {
      items: p.hours || [],
      render: (h, i) => [
        tf({ label: 'Label', field: `hours.${i}.label`, value: h.label || '', limit: LIMITS.hoursLabel, placeholder: 'Dinner', onInput: (v) => commit('Edit hours', (pg) => { pg.hours[i].label = v; }, `hours.${i}.label`) }),
        tf({ label: 'Value', field: `hours.${i}.value`, value: h.value || '', limit: LIMITS.hoursValue, placeholder: 'Wed – Sat, 6:00 – 9:30pm', onInput: (v) => commit('Edit hours', (pg) => { pg.hours[i].value = v; }, `hours.${i}.value`) })],
      onMove: (a, b) => commit('Reorder hours', (pg) => moveInList(pg.hours, a, b)),
      onAdd: () => { commit('Add hours row', (pg) => { pg.hours = pg.hours || []; pg.hours.push({ label: '', value: '' }); }); renderSide(); },
      onRemove: (i) => removeWithUndo('hours row', (pg) => pg.hours.splice(i, 1)[0], (pg, v) => pg.hours.splice(i, 0, v)),
      addLabel: 'Add row', empty: null,
    });
    if (rows.length) {
      box.append(el('button.btn.sm.danger', { type: 'button', style: { marginTop: '12px' }, onclick: () => removeWithUndo('hours card', (pg) => { const v = { hours: pg.hours, hoursTitle: pg.hoursTitle }; delete pg.hours; delete pg.hoursTitle; return v; }, (pg, v) => { pg.hours = v.hours; if (v.hoursTitle) pg.hoursTitle = v.hoursTitle; }) }, 'Remove the hours card'));
      box.append(el('p.help', 'Removes every row and the heading at once. Undo puts them back.'));
    }
  }

  function renderQR(box, p) {
    if (!p.qr) {
      box.append(el('p.small.muted', 'No QR link on this page.'));
      if (p.type === 'list') box.append(el('p.help', 'For a QR code on one card only, add it to that card under Cards.'));
      box.append(el('button.btn.sm', { type: 'button', onclick: () => { commit('Add QR link', (pg) => { pg.qr = { label: '', url: 'https://www.cavehotels.com/' }; }); renderSide(); } }, '+ Add QR link'));
      const t = tag('qr');
      if (t) box.append(el('p.help', { style: { marginTop: '10px' } }, 'A QR code can also be given only to some rooms (for example a room\'s own ordering link): choose how it differs, then fill in the rooms.'), t);
      return;
    }
    box.append(tf({ label: 'What it does', field: 'qr.label', value: p.qr.label || '', limit: LIMITS.qrLabel, placeholder: 'Book a table at the Firepit', onInput: (v) => commit('Edit QR line', (pg) => { pg.qr.label = v; }, 'qr.label') }));
    const url = tf({ label: 'Web address', field: 'qr.url', value: p.qr.url || '', type: 'url', spellcheck: false, placeholder: 'https://www.cavehotels.com/…', onInput: (v) => { commit('Edit QR address', (pg) => { pg.qr.url = v; }, 'qr.url'); check(v); } });
    const status = el('div.help');
    const check = (v) => { status.textContent = validQR(v) ? 'Looks right. The TV draws it as a QR code guests scan with their phone.' : `Not a valid web address yet: ${linkProblem(v)}.`; status.style.color = validQR(v) ? '' : 'var(--red)'; };
    check(p.qr.url);
    box.append(url, status);
    if (p.type === 'list') box.append(el('p.help', 'On a page of cards the TV shows one QR code beside the cards: the selected card\'s own QR code if it has one, otherwise this one.'));
    box.append(el('button.btn.sm.danger', { type: 'button', style: { marginTop: '8px' }, onclick: () => removeWithUndo('QR link', (pg) => { const q = pg.qr; delete pg.qr; return q; }, (pg, v) => { pg.qr = v; }) }, 'Remove QR link'));
    const t = tag('qr');
    if (t) box.append(el('div', { style: { marginTop: '10px' } }, t));
  }

  function renderChildren(box, p) {
    const kids = p.children || [];
    if (p.type !== 'home') {
      box.append(tf({ label: 'Heading above these pages', field: 'childrenTitle', value: p.childrenTitle || '', limit: LIMITS.childrenTitle, placeholder: 'e.g. The full experience',
        help: p.type === 'hub' ? 'Optional. Shown in capitals above the tiles when this section opens as a page. Strips have no heading.' : 'Optional. Shown in capitals above the tiles.',
        onInput: (v) => commit('Edit heading above pages', (pg) => put(pg, 'childrenTitle', v), 'childrenTitle') }));
    }
    listEditor(box, {
      items: kids,
      render: (c) => el('div.row.between', el('span', el('b', c.title), c.hidden ? el('span.pill.dark', { style: { marginLeft: '6px' } }, 'Hidden') : null),
        el('button.btn.sm', { type: 'button', onclick: () => app.go('editor', { page: c.id }) }, 'Open')),
      onMove: (a, b) => model.commit('Reorder pages', (d) => movePage(d, pageId, a, b), { origin: 'editor' }),
      onAdd: () => addChild(p),
      onRemove: async (i) => {
        const c = kids[i];
        const ok = await confirmModal(`Delete ${c.title}?`, 'It will be removed from the TV when you next publish. You can undo this straight away.', { okLabel: 'Delete', danger: true });
        if (!ok) return;
        let removed = null;
        commit(`Delete ${c.title}`, (pg) => { removed = pg.children.splice(i, 1)[0]; });
        toast(`Deleted ${c.title}.`, { action: 'Undo', onAction: () => model.commit(`Restore ${c.title}`, (d) => addPage(d, pageId, removed, i), { origin: 'editor', undoable: false }) });
      },
      addLabel: 'Add a page under this one', max: LIMITS.itemsMax + 4,
    });
    box.append(el('p.help', p.type === 'hub' || p.type === 'home' ? 'These are the strips guests see inside this section.' : 'Shown as tiles after this page\'s own content (every page type does this). Guests are never more than four presses from home, so keep it to one level. A page here without a photo gets a plain dark tile.'));
  }

  function addChild(p) {
    let title = '';
    let type = 'info';
    const types = ['info', 'menu', 'gallery', 'list', 'finished'];
    const buttons = pageChoices(types).map((c) => el('button', { type: 'button', class: c.key === type ? 'on' : '', dataset: { t: c.key }, onclick: () => { type = c.key; buttons.forEach((b) => b.classList.toggle('on', b.dataset.t === c.key)); } }, el('b', c.label), el('span', c.hint)));
    const field = textField({ label: 'Title', value: '', limit: LIMITS.title, id: uid('t'), onInput: (v) => { title = v; } });
    modal({ title: `Add a page under ${p.title}`, body: el('div', el('div.tpl', ...buttons), field),
      actions: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: () => {
        const t = title.trim(); if (!t) { field.input.focus(); return false; }
        const np = newPage(type, t, model.newId(t));
        model.commit(`Add ${t}`, (d) => addPage(d, pageId, np), { origin: 'editor' });
        toast(`Added ${t}.`, { action: 'Open it', onAction: () => app.go('editor', { page: np.id }) });
        renderSide();
        return true;
      } }] });
  }

  function renderMenuPart(box, p) {
    const n = (p.sections || []).reduce((a, s) => a + (s.items || []).length, 0);
    if (versionKey !== null) {
      box.append(el('p.small', `${plural((p.sections || []).length, 'part')}, ${plural(n, 'dish', 'dishes')}.`));
      box.append(el('p.help', 'Every version shows the master\'s menu. Dishes are edited on the Menus screen, for every TV.'));
      return;
    }
    box.append(el('p.small', `${plural((p.sections || []).length, 'part')}, ${plural(n, 'dish', 'dishes')}.`));
    box.append(el('p.help', 'Dishes, descriptions, prices and tags are edited on the Menus screen, where the whole menu is laid out as a table.'));
    box.append(el('button.btn.pri.sm', { type: 'button', style: { marginTop: '8px' }, onclick: () => app.go('menus', { menu: pageId }) }, 'Edit dishes in Menus'));
  }

  // ---- the gallery (phase B: GALLERY-CONTRACT.md, SPEC 5.2) ----
  /** One change to a gallery's frames: fn(frames, page) edits a copy; it is written back with setFrames. */
  const editFrames = (label, fn, key) => commit(label, (pg) => { const fr = framesCopy(pg); fn(fr, pg); setFrames(pg, fr); }, key);

  /** "This gallery": style, plays by itself, seconds per frame, the intro. */
  function renderGallerySettings(box, p) {
    const o = galleryOptions(p);
    const seg = (label, choices, current, onPick, aria) => {
      const g = el('div.seg', { role: 'group', 'aria-label': aria || label });
      for (const [v, text] of choices) g.append(el('button', { type: 'button', class: v === current ? 'on' : '', 'aria-pressed': String(v === current), dataset: { v: String(v) }, onclick: () => onPick(v) }, text));
      return el('div.field', el('label', el('span', label)), g);
    };
    box.append(seg('Style', [['thumbnails', 'Thumbnails'], ['slideshow', 'Slideshow']], o.style, (v) => { commit(`Gallery style: ${STYLES[v]}`, (pg) => setOptions(pg, { style: v })); renderSide(); }, 'Gallery style'));
    box.append(el('p.help', { style: { marginTop: '-4px', marginBottom: '10px' } }, o.style === 'slideshow'
      ? 'No thumbnails: the frames turn by themselves from the moment the page opens. Left and Right step through them and hold the slideshow for 30 seconds; Select opens the frame full screen.'
      : 'A row of thumbnails along the bottom (and the chapter names above it, when frames have chapters). Select opens a frame full screen; Play/Pause starts a slideshow.'));
    if (o.style === 'thumbnails') {
      const on = el('input', { type: 'checkbox', checked: o.autoplay, 'data-field': 'gallery.autoplay', onchange: (e) => { commit(e.target.checked ? 'Plays by itself' : 'Does not play by itself', (pg) => setOptions(pg, { autoplay: e.target.checked })); renderSide(); } });
      box.append(el('div.field', el('label.check', on, el('span', el('b', 'Plays by itself'), ' after 20 seconds with no press'))));
    }
    if (o.style === 'slideshow' || o.autoplay) {
      const choices = SECONDS_CHOICES.map((n) => [n, `${n} s`]);
      if (!SECONDS_CHOICES.includes(o.seconds)) choices.push([o.seconds, `${o.seconds} s`]);
      box.append(seg('Seconds per frame', choices, o.seconds, (v) => { commit(`Seconds per frame: ${v}`, (pg) => setOptions(pg, { seconds: v })); renderSide(); }));
      box.append(el('p.help', { style: { marginTop: '-4px', marginBottom: '12px' } }, 'A silent film plays through before the next frame. 8 seconds suits most photos.'));
    }
    box.append(tf({ label: 'Intro', field: 'body', value: p.body || '', limit: LIMITS.galleryIntro, multiline: true, rows: 3, placeholder: 'Six thousand five hundred yards of Kent parkland. Hole by hole.',
      help: 'Optional. One or two short sentences under the title. Not shown full screen.', onInput: (v) => commit('Edit intro', (pg) => put(pg, 'body', v), 'body') }));
    box.append(el('p.help', 'The QR code is under "QR link": it sits bottom-right, above the thumbnails, and is hidden full screen.'));
  }

  /** Photos and films: grouped by chapter, a frame's caption, chapter, fit and (for a film) sound. */
  function renderImages(box, p) {
    const frames = galleryFrames(p);
    const sel = Math.max(0, Math.min(state.frame || 0, frames.length - 1));
    state.frame = sel;
    const runs = chapterRuns(frames);
    const named = chapterNames(frames);
    const full = frames.length >= LIMITS.galleryMax;
    box.append(el('div.small.muted', { style: { marginBottom: '8px' } }, frames.length
      ? `${plural(frames.length, 'frame')}${named.length ? ` in ${plural(named.length, 'chapter')}` : ''} · ${frames.filter((x) => (x.caption || '').trim()).length} with a caption`
      : 'No frames yet.'));
    box.append(el('div.row.wrap', { style: { gap: '6px', marginBottom: '10px' } },
      el('button.btn.sm.pri', { type: 'button', disabled: full, onclick: () => addGalleryPhotos(p) }, '+ Add photos'),
      el('button.btn.sm', { type: 'button', disabled: full, onclick: () => addGalleryFilm(p) }, '+ Add a film'),
      el('button.btn.sm', { type: 'button', disabled: !frames.length, onclick: () => pasteCaptions(p) }, 'Paste captions…')));
    const list = el('div.gframes');
    runs.forEach((r, ri) => {
      const g = el('div.gchapter', { dataset: { chapter: r.name } });
      const head = el('div.gchapter-h', el('span.n', r.name || (hasChapters(frames) ? 'No chapter' : 'All frames')), el('span.muted.small', plural(r.count, 'frame')));
      if (r.key) {
        head.append(el('span.spacer'),
          el('button.mini', { type: 'button', 'aria-label': `Move ${r.name} earlier`, title: 'Move this chapter earlier', disabled: ri === 0, onclick: () => moveChapter(ri, -1) }, svgIcon('up', 14)),
          el('button.mini', { type: 'button', 'aria-label': `Move ${r.name} later`, title: 'Move this chapter later', disabled: ri === runs.length - 1, onclick: () => moveChapter(ri, 1) }, svgIcon('down', 14)),
          el('button.btn.link.sm', { type: 'button', onclick: () => renameChapter(r) }, 'Rename'));
      }
      g.append(head);
      const grid = el('div.gframe-grid');
      for (let i = r.start; i < r.start + r.count; i++) {
        const fr = frames[i];
        const th = el('div.th' + (fr.fit === 'whole' ? '.whole' : ''));
        const url = app.media.url(frameStill(fr), 800);
        if (url) th.style.backgroundImage = `url("${url}")`;
        if (fr.film) th.append(el('span.gmark', fr.sound === true ? 'Film · sound' : 'Film · loop'));
        else if (fr.fit === 'whole') th.append(el('span.gmark', 'Whole'));
        th.append(el('span.gnum', String(i + 1)));
        const tile = el('button.gframe' + (i === sel ? '.sel' : ''), { type: 'button', draggable: 'true', dataset: { i: String(i) }, 'aria-label': `Frame ${i + 1}${fr.caption ? `: ${fr.caption}` : ''}`, 'aria-pressed': String(i === sel),
          onclick: () => { state.frame = i; state.field = `images.${i}`; renderSide(); preview.setSelectedField(`${pageId}|images.${i}`); } },
          th, el('span.gcap' + (fr.caption ? '' : '.muted'), fr.caption || 'No caption'));
        grid.append(tile);
      }
      sortable(grid, '.gframe', (a, b) => editFrames('Reorder frames', (list) => { const [x] = list.splice(r.start + a, 1); list.splice(r.start + b, 0, x); state.frame = r.start + b; }));
      g.append(grid);
      // The selected frame's settings open under its chapter, so they are next to it even in a long gallery.
      if (sel >= r.start && sel < r.start + r.count) g.append(frameProps(p, frames, sel));
      list.append(g);
    });
    box.append(list);
    box.append(el('p.help', { style: { marginTop: '12px' } }, `Up to ${LIMITS.galleryMax}. Frames are kept together by chapter; drag a frame within its chapter, or give it another chapter to move it there. A photo can fill the TV or show whole; a film is a silent loop (plays in place) or plays with sound (a play mark; Select plays it).`));
  }

  /** The selected frame's settings. */
  function frameProps(p, frames, i) {
    const fr = frames[i];
    const f = `images.${i}`;
    const box = el('div.gprops', { dataset: { field: f }, tabindex: '-1' });
    const c = frameCount(frames, i);
    box.append(el('h3', { style: { margin: '14px 0 8px' } }, `Frame ${i + 1}`, el('span.muted', { style: { fontWeight: 400 } }, c.chapter ? ` · ${c.chapter}, ${c.text}` : ` of ${frames.length}`)));
    const big = el('div.gbig' + (fr.fit === 'whole' ? '.whole' : ''));
    const url = app.media.url(frameStill(fr), 800);
    if (url) big.style.backgroundImage = `url("${url}")`;
    if (fr.film) big.append(el('span.play'));
    box.append(big);
    const capField = tf({ label: 'Caption', field: `${f}.caption`, value: fr.caption || '', limit: LIMITS.frameCaption, placeholder: fr.film ? 'From the air: the whole hole in one flight' : 'Par 4, 389 yards. Dogleg left past the old oak',
      help: 'One line under the title, and bottom-left full screen.',
      onInput: (v) => { editFrames('Edit caption', (list) => { if (list[i]) list[i].caption = v; }, `${f}.caption`); const t = side.querySelector(`.gframe[data-i="${i}"] .gcap`); if (t) { t.textContent = v || 'No caption'; t.classList.toggle('muted', !v); } } });
    box.append(capField);
    // Chapter: picked from the names already used, or a new one; set when the box is left (Enter or Tab).
    const dl = el('datalist', { id: uid('ch') });
    for (const n of chapterNames(frames)) dl.append(el('option', { value: n }));
    const chCount = el('span.count');
    const chIn = el('input.in', { type: 'text', value: fr.group || '', maxlength: String(LIMITS.chapter), list: dl.id, placeholder: hasChapters(frames) ? 'Choose or type' : 'e.g. Hole 1', autocomplete: 'off', 'data-field': `${f}.group`, id: uid('chi') });
    const count = () => { const n = chIn.value.length; chCount.textContent = `${n} / ${LIMITS.chapter}`; chCount.className = 'count' + (n > LIMITS.chapter ? ' red' : n >= Math.ceil(LIMITS.chapter * 0.9) ? ' amber' : ''); };
    chIn.addEventListener('input', count);
    chIn.addEventListener('change', () => setChapter(i, chIn.value));
    chIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); chIn.blur(); } });
    count();
    box.append(el('div.field', el('label', { for: chIn.id }, el('span', 'Chapter'), chCount), chIn, dl,
      el('div.help', hasChapters(frames) ? 'Pick a chapter already used, or type a new one. Frames are kept together by chapter, in the order the chapters first appear.' : 'Optional. Name a chapter ("Hole 1") and a row of chapter names appears above the thumbnails.')));
    // Fit.
    const fitRow = el('div.fit', { role: 'radiogroup', 'aria-label': `Frame ${i + 1} fit` });
    for (const [v, label, help] of [['fill', 'Fill', 'Fills the TV, cropped to 16:9. Right for photographs.'], ['whole', 'Show whole', 'The whole image on the dark ground, never cropped. Plans, scorecards, posters.']]) {
      const on = (fr.fit === 'whole' ? 'whole' : 'fill') === v;
      fitRow.append(el('label.fit-opt' + (on ? '.on' : ''), el('input', { type: 'radio', name: `gfit-${i}`, checked: on, 'data-field': v === 'whole' ? `${f}.fit` : undefined, onchange: () => { editFrames(v === 'whole' ? 'Show the whole image' : 'Fill the frame', (list) => { list[i].fit = v === 'whole' ? 'whole' : undefined; }); renderSide(); } }), el('span', el('b', label), el('small', help))));
    }
    box.append(el('div.field', el('label', el('span', 'Fit')), fitRow));
    if (fr.film) {
      const info = app.media.film(fr.film);
      const soundRow = el('div.fit', { role: 'radiogroup', 'aria-label': `Frame ${i + 1}: how the film plays` });
      for (const [v, label, help] of [[false, 'Silent loop', 'Plays in place, silently, like a moving photo. Must have no sound track (or be marked silent in Media).'], [true, 'Plays with sound', 'Shows its poster with a play mark; Select plays it full screen with sound; Menu comes back to this frame.']]) {
        const on = (fr.sound === true) === v;
        soundRow.append(el('label.fit-opt' + (on ? '.on' : ''), el('input', { type: 'radio', name: `gsound-${i}`, checked: on, 'data-field': v ? `${f}.sound` : undefined, onchange: () => { editFrames(v ? 'Film plays with sound' : 'Film is a silent loop', (list) => { list[i].sound = v || undefined; }); renderSide(); } }), el('span', el('b', label), el('small', help))));
      }
      box.append(el('div.field', el('label', el('span', 'This film')), soundRow));
      if (info) box.append(el('div', { style: { margin: '-4px 0 8px' } }, filmInfoBox(app, fr.film)));
      const missingPoster = !fr.poster;
      box.append(el('div.row.wrap', { style: { gap: '6px' } },
        el('button.btn.sm' + (missingPoster ? '.pri' : ''), { type: 'button', 'data-field': `${f}.poster`, onclick: () => posterCapture(app, fr.film, { title: fr.caption || p.title, previous: fr.poster || null, onDone: (ps) => editFrames('Set poster', (list) => { list[i].poster = ps; }) }) }, fr.poster ? 'Change poster' : 'Capture a poster'),
        el('button.btn.sm', { type: 'button', onclick: () => pickFilm(app, { onPick: (src, rec) => { editFrames('Change gallery film', (list) => { list[i] = { ...list[i], film: src, poster: rec.poster || undefined, sound: soundFor(rec, list[i].sound) }; }); renderSide(); } }) }, 'Swap film')));
      if (missingPoster) box.append(el('div.help', { style: { color: 'var(--red)' } }, 'No poster yet. The TV shows it until the film has loaded; capture a frame.'));
    } else {
      box.append(el('div.row.wrap', { style: { gap: '6px' } }, el('button.btn.sm', { type: 'button', onclick: () => pickPhoto(app, { use: 'gallery', onPick: (src) => { editFrames('Change gallery photo', (list) => { list[i] = { ...list[i], image: src }; }); renderSide(); } }) }, 'Swap photo')));
    }
    const r = chapterRuns(frames).find((x) => i >= x.start && i < x.start + x.count);
    box.append(el('div.row.wrap', { style: { gap: '6px', marginTop: '10px' } },
      el('button.btn.sm', { type: 'button', disabled: i <= r.start, onclick: () => { editFrames('Move frame earlier', (list) => { const [x] = list.splice(i, 1); list.splice(i - 1, 0, x); }); state.frame = i - 1; renderSide(); } }, '← Earlier'),
      el('button.btn.sm', { type: 'button', disabled: i >= r.start + r.count - 1, onclick: () => { editFrames('Move frame later', (list) => { const [x] = list.splice(i, 1); list.splice(i + 1, 0, x); }); state.frame = i + 1; renderSide(); } }, 'Later →'),
      el('span.spacer'),
      el('button.btn.sm.danger', { type: 'button', onclick: () => removeWithUndo(fr.film ? 'film' : 'photo', (pg) => { const l = framesCopy(pg); const [v] = l.splice(i, 1); setFrames(pg, l); return v; }, (pg, v) => { const l = framesCopy(pg); l.splice(i, 0, v); setFrames(pg, l); }) }, 'Remove')));
    return box;
  }

  /** A film with a sound track that is not marked silent can only play with sound; one with no sound track starts as a silent loop. */
  const soundFor = (rec, current) => {
    if (rec && rec.audio === true && !rec.silent) return true;
    if (rec && rec.audio === false) return current === true ? true : undefined;
    return current;
  };

  /** Puts frame i in a chapter (an existing one's spelling when it is the same chapter), keeping chapters together. */
  function setChapter(i, typed) {
    const frames = galleryFrames(page());
    const name = matchChapter(frames, typed);
    if (chapterKey(frames[i]?.group) === chapterKey(name) && cleanChapter(frames[i]?.group) === name) return;
    let at = i;
    editFrames(name ? `Chapter: ${name}` : 'No chapter', (list) => {
      const fr = list[i];
      fr.group = name || undefined;
      // Into its chapter: after that chapter's last frame (a new chapter stays where it is).
      const others = list.filter((x, k) => k !== i);
      const last = name ? others.map((x) => chapterKey(x.group)).lastIndexOf(chapterKey(name)) : -1;
      if (last >= 0) { others.splice(last + 1, 0, fr); list.splice(0, list.length, ...others); }
      const ordered = orderByChapter(list);
      list.splice(0, list.length, ...ordered);
      at = list.indexOf(fr);
    });
    state.frame = at;
    renderSide();
    preview.setSelectedField(`${pageId}|images.${at}`);
  }

  function moveChapter(ri, dir) {
    editFrames('Reorder chapters', (list) => {
      const runs = chapterRuns(list);
      const parts = runs.map((r) => list.slice(r.start, r.start + r.count));
      const [x] = parts.splice(ri, 1);
      parts.splice(ri + dir, 0, x);
      list.splice(0, list.length, ...parts.flat());
    });
    renderSide();
  }

  async function renameChapter(r) {
    const v = await promptModal(`Rename ${r.name}`, 'Chapter name', { value: r.name, limit: LIMITS.chapter, okLabel: 'Rename' });
    if (v === null) return;
    const frames = galleryFrames(page());
    const others = frames.filter((x, k) => k < r.start || k >= r.start + r.count);
    const name = matchChapter(others, v);
    editFrames(name ? `Rename chapter ${r.name} to ${name}` : `Take away chapter ${r.name}`, (list) => {
      for (let k = r.start; k < r.start + r.count; k++) list[k].group = name || undefined;
      const ordered = orderByChapter(list);
      list.splice(0, list.length, ...ordered);
    });
    renderSide();
  }

  /** Several photos at once, in name order, into the selected frame's chapter (after its last frame). */
  function addGalleryPhotos(p) {
    const frames = galleryFrames(p);
    const room = LIMITS.galleryMax - frames.length;
    const chapter = frames.length ? cleanChapter(frames[Math.min(state.frame || 0, frames.length - 1)].group) : '';
    pickPhoto(app, { use: 'gallery', max: room, onPickMany: (srcs) => {
      let first = 0;
      editFrames(srcs.length > 1 ? `Add ${srcs.length} gallery photos` : 'Add gallery photo', (list) => {
        const add = srcs.slice(0, LIMITS.galleryMax - list.length).map((image) => ({ image, ...(chapter ? { group: chapter } : {}) }));
        const last = chapter ? list.map((x) => chapterKey(x.group)).lastIndexOf(chapterKey(chapter)) : list.length - 1;
        first = last + 1;
        list.splice(first, 0, ...add);
      });
      state.frame = first;
      renderSide();
      toast(`${plural(srcs.length, 'photo')} added${chapter ? ` to ${chapter}` : ''}.`, { ms: 4000 });
    } });
  }

  function addGalleryFilm(p) {
    const frames = galleryFrames(p);
    const chapter = frames.length ? cleanChapter(frames[Math.min(state.frame || 0, frames.length - 1)].group) : '';
    pickFilm(app, { onPick: (src, rec) => {
      let at = 0;
      const sound = soundFor(rec, undefined);
      editFrames('Add gallery film', (list) => {
        const fr = { film: src, ...(rec.poster ? { poster: rec.poster } : {}), ...(chapter ? { group: chapter } : {}), ...(sound ? { sound: true } : {}) };
        const last = chapter ? list.map((x) => chapterKey(x.group)).lastIndexOf(chapterKey(chapter)) : list.length - 1;
        at = last + 1;
        list.splice(at, 0, fr);
      });
      state.frame = at;
      renderSide();
      toast(sound ? 'Film added. It has a sound track, so it plays with sound: a play mark, and Select plays it full screen.' : 'Film added as a silent loop. Choose "Plays with sound" on the frame if guests should press play.', { ms: 8000 });
      if (!rec.poster) posterCapture(app, src, { title: p.title, onDone: (ps) => editFrames('Set poster', (list) => { const hit = list.find((x) => x.film === src && !x.poster); if (hit) hit.poster = ps; }) });
    } });
  }

  /** Paste captions: one line per frame, in order; "chapter<tab>caption" sets the chapter too. Nothing changes until "Use these captions". */
  function pasteCaptions(p) {
    const frames = galleryFrames(p);
    let fromSelected = false;
    const area = el('textarea.in', { rows: 10, placeholder: 'Par 4, 412 yards. A generous opening drive over the brook\nFrom the air: the whole hole in one flight\nPar 3, 176 yards. All carry', 'aria-label': 'Captions, one per line', spellcheck: 'true' });
    const report = el('div.small', { role: 'status', style: { marginTop: '8px' } });
    const startBox = el('label.check', el('input', { type: 'checkbox', onchange: (e) => { fromSelected = e.target.checked; check(); } }), `Start at the selected frame (${(state.frame || 0) + 1}) instead of frame 1`);
    let plan = null;
    const check = () => {
      clear(report);
      const lines = parseCaptions(area.value);
      const start = fromSelected ? state.frame || 0 : 0;
      const room = frames.length - start;
      const use = lines.slice(0, room);
      const long = use.map((l, k) => (l.caption.length > LIMITS.frameCaption ? k : -1)).filter((k) => k >= 0);
      const longCh = use.map((l, k) => (l.chapter && l.chapter.length > LIMITS.chapter ? k : -1)).filter((k) => k >= 0);
      plan = { start, use };
      if (!lines.length) { report.append(el('span.muted', 'Paste one caption per line, in the order the frames are in. An empty line leaves that frame with no caption.')); okBtn.disabled = true; return; }
      okBtn.disabled = !use.length;
      const bits = [el('div', el('strong', `${plural(use.length, 'line')} for frames ${start + 1} to ${start + use.length}`), ` (of ${frames.length}).`)];
      if (lines.length > room) bits.push(el('div', { style: { color: 'var(--amber)' } }, `${plural(lines.length - room, 'line')} more than there are frames; ${lines.length - room === 1 ? 'it is' : 'they are'} left out.`));
      if (use.length < room) bits.push(el('div.muted', `Frames ${start + use.length + 1} to ${frames.length} keep their captions.`));
      const blanks = use.filter((l) => !l.caption).length;
      if (blanks) bits.push(el('div.muted', `${plural(blanks, 'empty line')}: ${blanks === 1 ? 'that frame has' : 'those frames have'} no caption.`));
      if (use.some((l) => l.chapter !== null)) bits.push(el('div', 'Lines with a tab set the chapter too (chapter, then caption); chapters are put together afterwards.'));
      for (const k of long) bits.push(el('div', { style: { color: 'var(--red)' } }, `Line ${k + 1} is ${use[k].caption.length} characters; a caption can be ${LIMITS.frameCaption}. It is kept and shown red so you can shorten it; the page is held back until then.`));
      for (const k of longCh) bits.push(el('div', { style: { color: 'var(--red)' } }, `Line ${k + 1}: the chapter "${use[k].chapter}" is over ${LIMITS.chapter} characters.`));
      report.append(...bits);
    };
    area.addEventListener('input', check);
    const m = modal({ title: `Paste captions for ${p.title}`, wide: true,
      body: el('div', el('p.help', { style: { marginBottom: '8px' } }, 'One caption per line, in the order of the frames (as listed, chapter by chapter). From a spreadsheet: one column of captions, or two columns (chapter, caption).'), area, startBox, report),
      actions: [{ label: 'Cancel' }, { label: 'Use these captions', primary: true, disabled: true, onClick: () => {
        if (!plan || !plan.use.length) return false;
        const { start, use } = plan;
        editFrames(`Paste ${plural(use.length, 'caption')}`, (list) => {
          use.forEach((l, k) => { const fr = list[start + k]; if (!fr) return; fr.caption = l.caption || undefined; if (l.chapter !== null) fr.group = l.chapter ? matchChapter(list, l.chapter) : undefined; });
          const ordered = orderByChapter(list);
          list.splice(0, list.length, ...ordered);
        });
        renderSide();
        toast(`${plural(use.length, 'caption')} pasted. Undo puts the old ones back.`, { action: 'Undo', onAction: () => model.undo() });
        return true;
      } }] });
    const okBtn = m.box.querySelector('.actions .btn.pri');
    check();
    area.focus();
  }

  function renderItems(box, p) {
    const items = p.items || [];
    listEditor(box, {
      items,
      render: (it, i) => {
        const th = el('div.thumb');
        const url = app.media.url(it.image, 800);
        if (url) th.style.backgroundImage = `url("${url}")`;
        return [
          tf({ label: `Card ${i + 1} title`, field: `items.${i}.title`, value: it.title || '', limit: LIMITS.cardTitle, onInput: (v) => commit('Edit card', (pg) => { pg.items[i].title = v; }, `items.${i}.title`) }),
          tf({ label: 'Date or distance', field: `items.${i}.meta`, value: it.meta || '', limit: LIMITS.cardMeta, placeholder: 'Sat 4 Oct · 15 min drive', onInput: (v) => commit('Edit card', (pg) => { if (v) pg.items[i].meta = v; else delete pg.items[i].meta; }, `items.${i}.meta`) }),
          tf({ label: 'One line', field: `items.${i}.subtitle`, value: it.subtitle || '', limit: LIMITS.cardSubtitle, onInput: (v) => commit('Edit card', (pg) => { if (v) pg.items[i].subtitle = v; else delete pg.items[i].subtitle; }, `items.${i}.subtitle`) }),
          tf({ label: 'Text', field: `items.${i}.body`, value: it.body || '', limit: LIMITS.cardBody, multiline: true, rows: 3, onInput: (v) => commit('Edit card', (pg) => { if (v) pg.items[i].body = v; else delete pg.items[i].body; }, `items.${i}.body`) }),
          el('div.photo-pick', { dataset: { field: `items.${i}.image` }, tabindex: '-1' }, th, el('div', el('div.small', app.media.label(it.image)),
            el('button.btn.sm', { type: 'button', style: { marginTop: '4px' }, onclick: () => pickPhoto(app, { onPick: (s) => commit('Change card photo', (pg) => { pg.items[i].image = s; }) }) }, it.image ? 'Swap photo' : 'Choose photo'))),
          cardQR(it, i),
        ];
      },
      onMove: (a, b) => commit('Reorder cards', (pg) => moveInList(pg.items, a, b)),
      onAdd: () => { commit('Add card', (pg) => { pg.items = pg.items || []; pg.items.push({ title: 'New card' }); }); renderSide(); },
      onRemove: (i) => removeWithUndo('card', (pg) => pg.items.splice(i, 1)[0], (pg, v) => pg.items.splice(i, 0, v)),
      addLabel: 'Add card',
    });
  }

  /** A card's own QR code (ListItem.qr): same checks as the page's QR link. */
  function cardQR(it, i) {
    const box = el('div.card-qr', { style: { marginTop: '10px' } });
    const cardTag = it.id ? tag(cardField(it.id), `QR code on card "${it.title || i + 1}"`) : null;
    if (!it.qr) {
      box.append(el('button.btn.sm', { type: 'button', onclick: () => { commit('Add QR code to card', (pg) => { pg.items[i].qr = { label: '', url: 'https://www.cavehotels.com/' }; }); renderSide(); setTimeout(() => side.querySelector(`[data-field="items.${i}.qr.url"]`)?.focus(), 0); } }, '+ Add a QR code to this card'));
      if (cardTag) box.append(el('div', { style: { marginTop: '6px' } }, cardTag));
      return box;
    }
    box.append(el('div.small', el('b', 'QR code for this card')));
    box.append(tf({ label: 'What it does', field: `items.${i}.qr.label`, value: it.qr.label || '', limit: LIMITS.qrLabel, placeholder: 'Tickets and times', onInput: (v) => commit('Edit card QR line', (pg) => { pg.items[i].qr.label = v; }, `items.${i}.qr.label`) }));
    const status = el('div.help');
    const check = (v) => { status.textContent = validQR(v) ? 'Looks right. Shown beside the cards while this card is selected.' : `Not a valid web address yet: ${linkProblem(v)}.`; status.style.color = validQR(v) ? '' : 'var(--red)'; };
    box.append(tf({ label: 'Web address', field: `items.${i}.qr.url`, value: it.qr.url || '', type: 'url', spellcheck: false, placeholder: 'https://www.cavehotels.com/…', onInput: (v) => { commit('Edit card QR address', (pg) => { pg.items[i].qr.url = v; }, `items.${i}.qr.url`); check(v); } }), status);
    check(it.qr.url);
    box.append(el('button.btn.sm.danger', { type: 'button', style: { marginTop: '6px' }, onclick: () => removeWithUndo('QR code from the card', (pg) => { const q = pg.items[i].qr; delete pg.items[i].qr; return q; }, (pg, v) => { pg.items[i].qr = v; }) }, 'Remove QR code'));
    if (cardTag) box.append(el('div', { style: { marginTop: '6px' } }, cardTag));
    return box;
  }

  function renderHotelPart(box) {
    const h = model.draft.hotel;
    box.append(el('dl.kv', el('dt', 'Reception'), el('dd', h.reception || '—'), el('dt', 'Room service'), el('dd', h.roomService || '—'), el('dt', 'Wi-Fi'), el('dd', h.wifiName || '—'), el('dt', 'Check-out'), el('dd', h.checkout || '—')));
    box.append(el('p.help', 'These come from Hotel details, so they are the same on every page that shows them.'));
    box.append(el('button.btn.sm', { type: 'button', onclick: () => app.go('hotel') }, 'Edit Hotel details'));
  }

  function removeWithUndo(what, take, putBack) {
    let removed = null;
    commit(`Remove ${what}`, (pg) => { removed = take(pg); });
    renderSide();
    toast(`Removed the ${what}.`, { action: 'Undo', onAction: () => { model.commit(`Restore ${what}`, lens((pg) => putBack(pg, removed)), { origin: 'editor', undoable: false }); renderSide(); } });
  }

  renderSub();
  renderBanner();
  renderRail();
  renderCentre();
  renderSide();
  // Room names for "Preview as" and the tags may have changed on the Rooms screen.
  if (SERVER) app.loadRooms().then(() => { renderBanner(); renderCentre(); if (!side.contains(document.activeElement)) renderSide(); });

  // A link can open the editor in remote mode and press keys, e.g.
  // ?remote=down,down,enter — handy for sharing and for screenshots.
  const remoteParam = new URLSearchParams(location.search).get('remote');
  if (remoteParam !== null) {
    state.showRemote = true;
    setMode('remote');
    let delay = 600;
    for (const k of remoteParam.split(',').filter(Boolean)) { setTimeout(() => preview.key(k), delay); delay += 500; }
  }

  return {
    update(ev) {
      if (!model.find(pageId)) { app.go('home'); return; }
      if (versionKey !== null && !vrec()) { app.go('editor', { page: pageId }); return; }
      if (ev.type === 'media') { renderRail(); renderSide(); return; }
      renderSub();
      renderBanner();
      renderRail();
      refreshPreview(false);
      // Our own typing: keep the side panel (and its focus) as it is.
      // Anything else (undo, list changes) rebuilds it.
      if (ev.origin !== 'editor' || !ev.label.startsWith('Edit')) renderSide();
      else {
        const c = side.querySelector('#checks'); if (c) { clear(c); c.append(checks(page())); }
        // A version: keep the Changed marks in step with typing.
        if (versionKey !== null) {
          const changed = new Set(Object.keys(patchNow()));
          side.querySelectorAll('[data-field]').forEach((n) => (n.closest('.field') || n).classList.toggle('changed', changed.has(n.dataset.field.split('.')[0])));
        }
      }
    },
    unmount() { preview?.destroy(); },
  };
}
