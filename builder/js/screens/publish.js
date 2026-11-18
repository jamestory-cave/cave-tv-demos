// Publish: what changed in plain English, Publish now, history, restore.

import { el, clear, plural, fmtDate } from '../util.js';
import { model } from '../model.js';
import { PublishConflict, UploadFailed } from '../stores/github.js';
import { ServerUnreachable } from '../stores/server.js';
import { fmtBytes } from '../media.js';
import { toast, modal, confirmModal, promptModal, textField, uid } from '../ui.js';
import { listTagged, fieldLabel, keyLabel, getField, getPage, SCOPE_SHORT } from '../overrides.js';
import { setCount } from './overrides.js';

/** A refusal in one sentence: the server's own "Nothing has been published." and end stops are left off, as this screen says it once (QA-3). */
export const reason = (msg) => String(msg || '').replace(/\s*Nothing (has been|was) published\.?\s*$/i, '').replace(/[.\s]+$/, '');

export function mount(host, app) {
  const main = el('main');
  const aside = el('aside');
  host.append(el('div.screen', main, aside));
  let note = '';
  let busy = false;

  function renderMain() {
    clear(main);
    const plan = app.plan();
    const { entries, live, heldBack, stop, validation } = plan;
    const since = model.published ? `since ${fmtDate(model.published.version.publishedAt)}` : '';
    const goingLive = live.length;
    const heldCount = entries.length - goingLive;
    main.append(el('div.row.between', { style: { marginBottom: '10px' } },
      el('div', el('h1', 'Publish'), el('p.muted', entries.length
        ? `${plural(goingLive, 'change')} ready to go live${heldCount ? `, ${heldCount} held back` : ''} ${since}. Nothing reaches a guest until you publish.`
        : `Nothing has changed ${since}.`)),
      el('button.btn', { type: 'button', disabled: !entries.length, onclick: resetChanges }, app.server ? 'Reset the draft' : 'Reset my changes')));

    for (const m of stop) main.append(el('div.note.block.small', el('strong', 'Cannot publish yet. '), m));
    for (const h of heldBack) {
      const why = h.blockers.map((b) => b.message).join('; ');
      main.append(el('div.note.block.small', el('strong', 'Held back. '),
        h.kept
          ? `${model.pathLabel(h.id)}: ${why}. Your changes to this page (and anything under it) stay back; the version on TVs now stays as it is. `
          : `${model.pathLabel(h.id)}: ${why}. It is new, so it will not be on TVs until it is fixed. `,
        el('button.btn.link.sm', { type: 'button', onclick: () => app.go('editor', { page: h.id }) }, 'Open the page')));
    }
    if (plan.overrides) renderOverrideChecks(plan.overrides);
    const list = el('div', { style: { marginTop: '10px' } });
    for (const e of entries) {
      const row = el('div.chg' + (e.held ? '.held' : e.kind === 'new' ? '.new' : e.kind === 'hidden' ? '.hidden-k' : e.kind === 'removed' ? '.removed' : ''));
      const w = el('div.w', el('b', e.path));
      const lines = el('div.lines');
      for (const l of e.lines) lines.append(el('div', l));
      if (e.held) lines.append(el('div', { style: { color: 'var(--red)' } }, model.find(e.id) && model.published && heldBack.find((h) => h.id === e.id)?.kept === false ? 'Not on TVs until fixed' : 'Held back: the version on TVs now stays'));
      w.append(lines);
      row.append(w);
      if (e.id !== 'hotel' && e.kind !== 'removed' && model.find(e.id)) row.append(el('button.btn.sm', { type: 'button', onclick: () => app.go('editor', { page: e.id }) }, 'View'));
      if (e.id === 'hotel') row.append(el('button.btn.sm', { type: 'button', onclick: () => app.go('hotel') }, 'View'));
      list.append(row);
    }
    if (!entries.length) list.append(el('div.empty', 'No changes to publish. Edit something on Home, Menus or Hotel details and it appears here.'));
    main.append(list);

    for (const w of plan.warnings) main.append(el('div.note.warn.small', { style: { marginTop: '10px' } }, el('strong', 'Worth knowing. '), w));
    if (!app.server && (plan.media.films.length || plan.media.photos.length)) {
      const up = el('div.note.small', { style: { marginTop: '10px' } }, el('strong', 'Uploads with this publish. '));
      const bits = [];
      if (plan.media.photos.length) bits.push(`${plural(plan.media.photos.length, 'photo')} (two sizes each)`);
      if (plan.media.films.length) bits.push(`${plural(plan.media.films.length, 'film')}: ${plan.media.films.map((f) => `${f.name} (${fmtBytes(f.bytes)})`).join(', ')}`);
      up.append(bits.join(' · ') + '. Films go up one at a time with a progress count; a large one can take a minute or two.');
      main.append(up);
    }
    const warnings = [];
    for (const [id, v] of validation) for (const w of v.warnings) warnings.push(`${id === 'hotel' ? 'Hotel details' : model.pathLabel(id)}: ${w.message}`);
    if (warnings.length) main.append(el('p.muted.small', { style: { marginTop: '10px' } }, el('strong', 'Warnings (do not stop publishing): '), warnings.slice(0, 8).join(' · ') + (warnings.length > 8 ? ` · and ${warnings.length - 8} more` : '')));
  }

  /** Room-specific content: blocked values (named by room), held pages, and how many rooms use the master. */
  function renderOverrideChecks(ov) {
    const names = app.names();
    for (const b of ov.blocked) {
      const page = model.find(b.pageId)?.page;
      const was = (model.published?.overrides?.entries || []).find((x) => x.page === b.pageId && x.field === b.field && x.by === b.by && x.values && b.key in x.values);
      main.append(el('div.note.block.small', el('strong', 'Held back for one ' + (b.by === 'type' ? 'room type' : 'room') + '. '),
        `${model.pathLabel(b.pageId)} › ${fieldLabel(page, b.field)}, ${keyLabel(b.by, b.key, names)}: ${b.message}. `,
        was ? 'That ' + (b.by === 'type' ? 'room type keeps' : 'room keeps') + ' what its TVs show now until it is fixed. ' : 'It uses the master until it is fixed. ',
        el('button.btn.link.sm', { type: 'button', onclick: () => app.go('overrides', { page: b.pageId, field: b.field }) }, 'Fix it in Overrides')));
    }
    for (const u of ov.unused || []) {
      const page = model.find(u.pageId)?.page;
      main.append(el('div.note.warn.small', el('strong', 'Not shown. '), `${model.pathLabel(u.pageId)} › ${fieldLabel(page, u.field)}: ${u.message}. `,
        el('button.btn.link.sm', { type: 'button', onclick: () => app.go('overrides', { page: u.pageId, field: u.field }) }, 'Open in Overrides')));
    }
    const tagged = listTagged(model.draft).filter((t) => t.page);
    if (!tagged.length) return;
    // Counted from what goes live: a value held back is not "set" (QA-7).
    const liveDoc = { overrides: ov.live };
    const lines = tagged.map((t) => {
      const total = t.rec.by === 'type' ? app.rooms.types.filter((x) => !x.retired).length : app.rooms.rooms.length;
      const n = setCount(app, (t.field === 'page' ? getPage(liveDoc, t.pageId) : getField(liveDoc, t.pageId, t.field)) || { by: t.rec.by, values: {} });
      const rest = Math.max(0, total - n);
      const unit = t.rec.by === 'type' ? ['room type', 'room types'] : ['room', 'rooms'];
      return `${model.pathLabel(t.pageId)} › ${fieldLabel(t.page, t.field)} (${SCOPE_SHORT[t.rec.by]}): ${n} of ${total} ${unit[1]} set; ${rest} ${rest === 1 ? unit[0] + ' uses' : unit[1] + ' use'} the master`;
    });
    main.append(el('div.note.small', { style: { marginTop: '8px' } }, el('strong', 'Different by room. '), lines.join(' · '), ' ',
      el('button.btn.link.sm', { type: 'button', onclick: () => app.go('overrides') }, 'Open Overrides')));
  }

  function renderAside() {
    clear(aside);
    const plan = app.plan();
    const ready = plan.live;
    const hasToken = app.github.hasToken;
    aside.append(el('h3', ready.length ? `Publish ${plural(ready.length, 'change')}` : 'Publish'));
    const panel = el('div.panel', { style: { marginBottom: '16px' } });
    panel.append(el('p.small', { style: { marginBottom: '8px' } }, el('strong', 'Now. '), el('span.muted', app.server ? 'TVs follow within a minute (they check every 30 seconds).' : 'TVs follow within a couple of minutes (GitHub Pages takes a moment to update).')));
    panel.append(textField({ id: uid('n'), label: 'Note for the team (optional)', value: note, limit: 80, placeholder: 'Scallops price, wellness hours', onInput: (v) => { note = v; } }));
    const by = app.publisherName();
    if (app.server) panel.append(el('p.small.muted', { style: { marginBottom: '8px' } }, `Publishing as ${by}.`));
    else panel.append(el('p.small.muted', { style: { marginBottom: '8px' } }, by ? `Publishing as ${by}. ` : 'You will be asked for your name the first time. ', el('button.btn.link.sm', { type: 'button', onclick: () => app.go('settings') }, 'Change')));
    const btn = el('button.btn.pri', { type: 'button', disabled: !hasToken || !plan.canPublish || busy, style: { padding: '9px 22px' }, onclick: () => doPublish() }, 'Publish now');
    panel.append(el('div.row', btn));
    if (!hasToken) panel.append(el('div.note.warn.small', { style: { marginTop: '10px' } }, el('strong', 'Publishing is off. '), 'Publishing writes to the hotel\'s GitHub repository, which needs the publishing passcode. Enter it once in ', el('button.btn.link.sm', { type: 'button', onclick: () => app.go('settings') }, 'Settings'), '. Everything else works without it.'));
    panel.append(el('div#progress.progress'));
    aside.append(panel);

    aside.append(el('h3', 'History'));
    const history = model.published?.history || [];
    if (!history.length) aside.append(el('p.muted.small', 'Nothing published yet.'));
    history.forEach((h, i) => {
      const live = model.published?.version?.revision === h.revision;
      const row = el('div.hist' + (live ? '.live' : ''));
      const seeded = h.by === 'seed.py';
      const by = seeded ? 'First publish' : (h.by || 'Unknown');
      const label = h.note || (seeded ? ((h.summary || [])[0] || '').replace(/^First publish,?\s*/i, '') || 'from the app\'s built-in content' : (h.summary || [])[0] || 'Publish');
      row.append(el('span', live ? el('strong', 'On TVs now') : el('span', `Publish ${h.revision}`), ` · ${fmtDate(h.publishedAt)}`, el('small', `${by} · ${label}${(h.summary || []).length > 1 ? ` · ${plural(h.summary.length, 'change')}` : ''}`)));
      const ops = el('span.row');
      ops.append(el('button.btn.sm', { type: 'button', onclick: () => showSummary(h) }, 'View'));
      const canRestore = hasToken && (!app.server || app.server.isAdmin);
      if (!live) ops.append(el('button.btn.sm', { type: 'button', disabled: !canRestore || busy, title: canRestore ? '' : app.server ? 'Only an admin can restore' : 'Needs the publishing passcode', onclick: () => restore(h) }, 'Restore'));
      row.append(live ? el('span.pill.acc', 'Live') : ops);
      aside.append(row);
      void i;
    });
    aside.append(el('p.muted.tiny', { style: { marginTop: '8px' } }, 'The last 20 publishes are kept. Restoring changes what TVs show; it is recorded as a new publish, so it can be undone. Your draft is left as it is.'));
  }

  function showSummary(h) {
    const body = el('div');
    body.append(el('p.small.muted', `Publish ${h.revision} · ${fmtDate(h.publishedAt)} · ${h.by === 'seed.py' ? 'First publish' : h.by || 'Unknown'}`));
    const ul = el('ul.small');
    for (const s of h.summary || []) ul.append(el('li', s));
    if (!(h.summary || []).length) ul.append(el('li', 'No summary recorded.'));
    body.append(ul);
    modal({ title: h.note || `Publish ${h.revision}`, body, actions: [{ label: 'Close' }] });
  }

  async function ensureName() {
    let by = app.publisherName();
    if (by) return by;
    by = await promptModal('Your name', 'Shown in the publish history so the team knows who changed what. Kept in this browser.', { placeholder: 'e.g. James', okLabel: 'Save', limit: 40 });
    if (!by) return null;
    app.browser.setPref('by', by);
    return by;
  }

  function progress(msg) { const p = aside.querySelector('#progress'); if (p) p.textContent = msg; }

  async function doPublish() {
    if (busy) return;
    const by = await ensureName();
    if (!by) return;
    const plan = app.plan();
    const { bundle, heldBack, live, summary, stop } = plan;
    if (stop.length) { toast(stop[0], { error: true }); return; }
    if (!live.length) { toast('Nothing is ready to go live.', { error: true }); return; }
    const kept = heldBack.filter((h) => h.kept).map((h) => model.pathLabel(h.id));
    const left = heldBack.filter((h) => !h.kept).map((h) => model.pathLabel(h.id));
    const parts = [`${plural(live.length, 'change')} will go live.`];
    if (kept.length) parts.push(`Held back, staying as they are on TVs now: ${kept.join(', ')}.`);
    if (left.length) parts.push(`New and not going on TVs until fixed: ${left.join(', ')}.`);
    if (plan.overrides?.blocked.length) parts.push(`Held back for some rooms: ${plural(plan.overrides.blocked.length, 'value')} that cannot go live yet (listed on this screen); those rooms keep what their TVs show now, or the master.`);
    if (plan.media.films.length && !app.server) parts.push(`${plural(plan.media.films.length, 'film')} (${fmtBytes(plan.filmBytes)}) will be uploaded first; keep this page open until it finishes.`);
    for (const w of plan.warnings) parts.push(w);
    parts.push(`TVs follow ${app.tvLag()}.`);
    const ok = await confirmModal('Publish to the TV?', parts.join(' '), { okLabel: 'Publish now' });
    if (!ok) return;
    busy = true; renderAside();
    try {
      // Only the pending photos and films this bundle actually uses go to the repository.
      const media = plan.media.photos;
      const films = plan.media.films;
      // Hotel server: the room-specific content goes with it (what goes live, and its editing form).
      const overrides = plan.overrides && (plan.overrides.entries.length || Object.keys(plan.overrides.live).length) ? { entries: plan.overrides.entries, draft: plan.overrides.live } : null;
      const result = await app.github.publish({
        bundle, basedOnRevision: model.basedOn?.revision, summary, by, note: note.trim(), media, films, mediaIndex: app.media.index, progress, ...(overrides ? { overrides } : {}),
      });
      await app.media.markPublished([...media, ...films].map((m) => m.hash), result.mediaIndex);
      model.published = {
        version: result.version, bundle: { ...bundle, version: result.revision },
        history: [result.historyEntry, ...(model.published?.history || [])].slice(0, 20), mediaIndex: result.mediaIndex,
        ...(app.server ? { overrides: result.overrides || null } : {}),
      };
      model.basedOn = { revision: result.revision, bundle: result.bundlePath };
      note = '';
      model.commit('Publish', () => {}, { origin: 'publish', undoable: false });
      toast(`${result.recovered ? 'Published (the connection dropped, but the publish had gone through).' : 'Published.'} The TV picks it up ${app.tvLag()}.${heldBack.length ? ' Held-back pages are still waiting to be fixed.' : ''}`, { ms: 10000 });
    } catch (e) {
      if (e instanceof PublishConflict) toast(e.message, { error: true, action: 'Reload', onAction: () => location.reload() });
      else if (e instanceof UploadFailed) {
        const body = el('div', el('p', `Uploading ${e.what} failed: ${e.reason}`), el('p', { style: { marginTop: '8px' } }, 'Nothing was published and nothing on the TV has changed. Your draft and the uploaded files are kept in this browser.'),
          el('p', { style: { marginTop: '8px' } }, e.isFilm ? 'Try Publish now again. If the same film keeps failing, GitHub is refusing the upload: ask for a shorter export or a lower bitrate (6 Mb/s gives about 45 MB a minute), which also downloads faster on the TV.' : 'Try Publish now again. If it keeps failing, check the connection and the passcode in Settings.'));
        modal({ title: 'Publish stopped', body, actions: [{ label: 'OK', primary: true }] });
      }
      else if (e instanceof ServerUnreachable) toast(e.message, { error: true });
      else toast(`Publishing failed: ${reason(e.message)}. Nothing was published; your draft is kept.`, { error: true, ms: 20000 });
    } finally {
      busy = false; renderMain(); renderAside();
    }
  }

  async function restore(h) {
    if (busy) return;
    const by = await ensureName();
    if (!by) return;
    const ok = await confirmModal(`Restore the publish of ${fmtDate(h.publishedAt)}?`, `TVs will show that content again ${app.tvLag()}${app.server ? ', including anything that differed by room then (filed under today\'s room numbers: a room renumbered since keeps it, a room deleted since does not pass it on)' : ''}. ${app.server ? 'The draft is' : 'Your draft is'} not changed.`, { okLabel: 'Restore' });
    if (!ok) return;
    busy = true; renderAside();
    try {
      progress('Fetching that publish…');
      const old = await app.github.fetchBundle(h.bundle);
      const words = { note: `Restored the publish of ${fmtDate(h.publishedAt)}`, summary: [`Restored revision ${h.revision} (${fmtDate(h.publishedAt)})`] };
      // The Cave server restores from its own copy; the prototype republishes through GitHub.
      const result = app.github.restore
        ? await app.github.restore({ revision: h.revision, bundle: h.bundle, basedOnRevision: model.basedOn?.revision, ...words, progress })
        : await app.github.publish({ bundle: old, basedOnRevision: model.basedOn?.revision, by, ...words, media: [], mediaIndex: app.media.index, progress });
      model.published = { version: result.version, bundle: { ...old, version: result.revision }, history: [result.historyEntry, ...(model.published?.history || [])].slice(0, 20), mediaIndex: result.mediaIndex,
        ...(app.server ? { overrides: result.overrides || null } : {}) };
      model.basedOn = { revision: result.revision, bundle: result.bundlePath };
      model.commit('Restore', () => {}, { origin: 'publish', undoable: false });
      toast(`Restored. TVs show that content again ${app.tvLag()}.`, { ms: 10000 });
    } catch (e) {
      if (e instanceof PublishConflict) toast(e.message, { error: true, action: 'Reload', onAction: () => location.reload() });
      else if (e instanceof ServerUnreachable) toast('The hotel server could not be reached, so nothing was restored. Try again when the connection is back.', { error: true });
      else toast(`Restore failed: ${e.message}`, { error: true });
    } finally {
      busy = false; renderMain(); renderAside();
    }
  }

  async function resetChanges() {
    const ok = app.server
      ? await confirmModal('Reset the draft?', 'Every change in the shared draft since the last publish is thrown away, for everyone, and the Builder goes back to what is on TVs now. Uploaded photos are kept.', { okLabel: 'Reset', danger: true })
      : await confirmModal('Reset my changes?', 'Everything you have changed in this browser since the last publish is thrown away and the Builder goes back to what is on TVs now. Uploaded photos are kept.', { okLabel: 'Reset', danger: true });
    if (!ok) return;
    model.reset();
    toast('Back to the published content.');
  }

  renderMain(); renderAside();
  // Room names for the checks above may have changed on the Rooms screen.
  if (app.server) app.loadRooms().then(() => { if (!busy) renderMain(); });
  return { update() { if (!busy) { renderMain(); renderAside(); } } };
}
