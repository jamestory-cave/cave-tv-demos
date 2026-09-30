// Publish: what changed in plain English, Publish now, history, restore.

import { el, clear, plural, fmtDate } from '../util.js';
import { model } from '../model.js';
import { buildBundle } from '../bundle.js';
import { PublishConflict } from '../stores/github.js';
import { toast, modal, confirmModal, promptModal, textField, uid } from '../ui.js';

export function mount(host, app) {
  const main = el('main');
  const aside = el('aside');
  host.append(el('div.screen', main, aside));
  let note = '';
  let busy = false;

  function renderMain() {
    clear(main);
    const { entries } = app.changes();
    const validation = app.validation();
    const { heldBack } = buildBundle(model.draft, { held: validation });
    const since = model.published ? `since ${fmtDate(model.published.version.publishedAt)}` : '';
    main.append(el('div.row.between', { style: { marginBottom: '10px' } },
      el('div', el('h1', 'Publish'), el('p.muted', entries.length ? `${plural(entries.length, 'change')} ${since}. Nothing reaches a guest until you publish.` : `Nothing has changed ${since}.`)),
      el('button.btn', { type: 'button', disabled: !entries.length, onclick: resetChanges }, 'Reset my changes')));

    for (const h of heldBack) {
      main.append(el('div.note.block.small', el('strong', 'Held back. '), `${model.pathLabel(h.id)}: ${h.blockers.map((b) => b.message).join('; ')}. Fix it, or publish without it. `,
        el('button.btn.link.sm', { type: 'button', onclick: () => app.go('editor', { page: h.id }) }, 'Open the page')));
    }
    const list = el('div', { style: { marginTop: '10px' } });
    for (const e of entries) {
      const held = heldBack.some((h) => h.id === e.id);
      const row = el('div.chg' + (held ? '.held' : e.kind === 'new' ? '.new' : e.kind === 'hidden' ? '.hidden-k' : e.kind === 'removed' ? '.removed' : ''));
      const w = el('div.w', el('b', e.path));
      const lines = el('div.lines');
      for (const l of e.lines) lines.append(el('div', l));
      if (held) lines.append(el('div', { style: { color: 'var(--red)' } }, 'Held back until fixed'));
      w.append(lines);
      row.append(w);
      if (e.id !== 'hotel' && e.kind !== 'removed' && model.find(e.id)) row.append(el('button.btn.sm', { type: 'button', onclick: () => app.go('editor', { page: e.id }) }, 'View'));
      if (e.id === 'hotel') row.append(el('button.btn.sm', { type: 'button', onclick: () => app.go('hotel') }, 'View'));
      list.append(row);
    }
    if (!entries.length) list.append(el('div.empty', 'No changes to publish. Edit something on Home, Menus or Hotel details and it appears here.'));
    main.append(list);

    const warnings = [];
    for (const [id, v] of validation) for (const w of v.warnings) warnings.push(`${id === 'hotel' ? 'Hotel details' : model.pathLabel(id)}: ${w.message}`);
    if (warnings.length) main.append(el('p.muted.small', { style: { marginTop: '10px' } }, el('strong', 'Warnings (do not stop publishing): '), warnings.slice(0, 8).join(' · ') + (warnings.length > 8 ? ` · and ${warnings.length - 8} more` : '')));
  }

  function renderAside() {
    clear(aside);
    const { entries, summary } = app.changes();
    const hasToken = app.github.hasToken;
    aside.append(el('h3', entries.length ? `Publish ${plural(entries.length, 'change')}` : 'Publish'));
    const panel = el('div.panel', { style: { marginBottom: '16px' } });
    panel.append(el('p.small', { style: { marginBottom: '8px' } }, el('strong', 'Now. '), el('span.muted', 'TVs follow within a couple of minutes (GitHub Pages takes a moment to update).')));
    panel.append(textField({ id: uid('n'), label: 'Note for the team (optional)', value: note, limit: 80, placeholder: 'Scallops price, wellness hours', onInput: (v) => { note = v; } }));
    const by = app.publisherName();
    panel.append(el('p.small.muted', { style: { marginBottom: '8px' } }, by ? `Publishing as ${by}. ` : 'You will be asked for your name the first time. ', el('button.btn.link.sm', { type: 'button', onclick: () => app.go('settings') }, 'Change')));
    const btn = el('button.btn.pri', { type: 'button', disabled: !hasToken || !entries.length || busy, style: { padding: '9px 22px' }, onclick: () => doPublish(summary) }, 'Publish now');
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
      const label = h.note || (h.summary || [])[0] || (h.revision === 1 ? 'First publish' : 'Publish');
      row.append(el('span', live ? el('strong', 'On TVs now') : el('span', `Revision ${h.revision}`), ` · ${fmtDate(h.publishedAt)}`, el('small', `${h.by || 'Unknown'} · ${label}${(h.summary || []).length > 1 ? ` · ${plural(h.summary.length, 'change')}` : ''}`)));
      const ops = el('span.row');
      ops.append(el('button.btn.sm', { type: 'button', onclick: () => showSummary(h) }, 'View'));
      if (!live) ops.append(el('button.btn.sm', { type: 'button', disabled: !hasToken || busy, title: hasToken ? '' : 'Needs the publishing passcode', onclick: () => restore(h) }, 'Restore'));
      row.append(live ? el('span.pill.acc', 'Live') : ops);
      aside.append(row);
      void i;
    });
    aside.append(el('p.muted.tiny', { style: { marginTop: '8px' } }, 'The last 20 publishes are kept. Restoring changes what TVs show; it is recorded as a new publish, so it can be undone. Your draft is left as it is.'));
  }

  function showSummary(h) {
    const body = el('div');
    body.append(el('p.small.muted', `Revision ${h.revision} · ${fmtDate(h.publishedAt)} · ${h.by || 'Unknown'} · ${h.bundle}`));
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

  async function doPublish(summary) {
    if (busy) return;
    const by = await ensureName();
    if (!by) return;
    const validation = app.validation();
    const { bundle, heldBack } = buildBundle(model.draft, { held: validation });
    if (!(bundle.home.children || []).length) { toast('Nothing to show: every section is hidden or held back.', { error: true }); return; }
    const lines = [...summary];
    for (const h of heldBack) lines.push(`Held back: ${model.pathLabel(h.id)} (${h.blockers.map((b) => b.message).join('; ')})`);
    const ok = await confirmModal('Publish to the TV?', `${plural(summary.length, 'change')} will go live${heldBack.length ? `, with ${plural(heldBack.length, 'page')} held back` : ''}. TVs follow within a couple of minutes.`, { okLabel: 'Publish now' });
    if (!ok) return;
    busy = true; renderAside();
    try {
      const media = app.media.pendingRecords();
      const result = await app.github.publish({
        bundle, basedOnRevision: model.basedOn?.revision, summary: lines, by, note: note.trim(), media, mediaIndex: app.media.index, progress,
      });
      await app.media.markPublished(media.map((m) => m.hash), result.mediaIndex);
      model.published = {
        version: result.version, bundle: { ...bundle, version: result.revision },
        history: [result.historyEntry, ...(model.published?.history || [])].slice(0, 20), mediaIndex: result.mediaIndex,
      };
      model.basedOn = { revision: result.revision, bundle: result.bundlePath };
      note = '';
      model.commit('Publish', () => {}, { origin: 'publish', undoable: false });
      toast(`Published revision ${result.revision}. The TV picks it up within a couple of minutes.`, { ms: 10000 });
    } catch (e) {
      if (e instanceof PublishConflict) toast(e.message, { error: true, action: 'Reload', onAction: () => location.reload() });
      else toast(`Publishing failed: ${e.message}`, { error: true });
    } finally {
      busy = false; renderMain(); renderAside();
    }
  }

  async function restore(h) {
    if (busy) return;
    const by = await ensureName();
    if (!by) return;
    const ok = await confirmModal(`Restore the publish of ${fmtDate(h.publishedAt)}?`, 'TVs will show that content again within a couple of minutes. Your draft is not changed.', { okLabel: 'Restore' });
    if (!ok) return;
    busy = true; renderAside();
    try {
      progress('Fetching that publish…');
      const old = await app.github.fetchBundle(h.bundle);
      const result = await app.github.publish({
        bundle: old, basedOnRevision: model.basedOn?.revision, by, note: `Restored the publish of ${fmtDate(h.publishedAt)}`,
        summary: [`Restored revision ${h.revision} (${fmtDate(h.publishedAt)})`], media: [], mediaIndex: app.media.index, progress,
      });
      model.published = { version: result.version, bundle: { ...old, version: result.revision }, history: [result.historyEntry, ...(model.published?.history || [])].slice(0, 20), mediaIndex: result.mediaIndex };
      model.basedOn = { revision: result.revision, bundle: result.bundlePath };
      model.commit('Restore', () => {}, { origin: 'publish', undoable: false });
      toast(`Restored as revision ${result.revision}.`, { ms: 10000 });
    } catch (e) {
      if (e instanceof PublishConflict) toast(e.message, { error: true, action: 'Reload', onAction: () => location.reload() });
      else toast(`Restore failed: ${e.message}`, { error: true });
    } finally {
      busy = false; renderMain(); renderAside();
    }
  }

  async function resetChanges() {
    const ok = await confirmModal('Reset my changes?', 'Everything you have changed in this browser since the last publish is thrown away and the Builder goes back to what is on TVs now. Uploaded photos are kept.', { okLabel: 'Reset', danger: true });
    if (!ok) return;
    model.reset();
    toast('Back to the published content.');
  }

  renderMain(); renderAside();
  return { update() { if (!busy) { renderMain(); renderAside(); } } };
}
