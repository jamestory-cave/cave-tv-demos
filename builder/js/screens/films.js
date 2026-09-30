// Films: upload with checks, the film picker, and poster capture. Shared by
// the page editor (Film part, background film, film slides) and Media.

import { el, clear, plural } from '../util.js';
import { model } from '../model.js';
import { prepareFilm, captureFrame, fmtBytes, fmtSeconds, FILM } from '../media.js';
import { codecName } from '../mp4.js';
import { toast, modal, uid } from '../ui.js';
import { pickPhoto } from './media.js';

/** One line describing a film record: 1920 × 1080 · 42 s · 31 MB · 5.9 Mb/s · with sound */
export function filmLine(f) {
  if (!f) return '';
  const parts = [`${f.width} × ${f.height}`, fmtSeconds(f.seconds), fmtBytes(f.bytes)];
  if (f.mbps) parts.push(`${f.mbps} Mb/s`);
  parts.push(f.audio === true ? (f.silent ? 'sound (marked silent)' : 'with sound') : f.audio === false ? 'no sound' : f.silent ? 'marked silent' : 'sound unknown');
  return parts.join(' · ');
}

/** Uploads MP4 files into Media with the checks. Returns the records added. */
export async function uploadFilmFiles(app, files, { onEach } = {}) {
  const added = [];
  for (const file of files) {
    const wait = toast(`Checking ${file.name}…`, { ms: 60000 });
    try {
      const rec = await prepareFilm(file);
      wait();
      if (app.media.pending.has(rec.hash) || app.media.index.films[rec.hash]) { toast(`${rec.name} is already in Media (same film).`); const existing = app.media.film(`media/${rec.hash}-${rec.height}.mp4`); if (existing && onEach) onEach(existing); continue; }
      await app.media.add(rec);
      added.push(rec);
      const w = rec.warnings.length ? ` Worth knowing: ${rec.warnings.join(' ')}` : '';
      toast(`${rec.name} added: ${filmLine(rec)}.${w} It goes to the TV with the next publish.`, { ms: rec.warnings.length ? 14000 : 8000 });
      if (onEach) onEach(app.media.film(`media/${rec.hash}-${rec.height}.mp4`));
    } catch (e) {
      wait();
      toast(`${file.name}: ${e.message}`, { error: true });
    }
  }
  return added;
}

export function filmDropZone(app, onDone, { compact = false } = {}) {
  const input = el('input', { type: 'file', accept: 'video/mp4,.mp4,.m4v', multiple: !compact, class: 'sr-only', id: uid('fup') });
  input.addEventListener('change', async () => { const files = [...input.files]; input.value = ''; const recs = await uploadFilmFiles(app, files); onDone(recs); });
  const zone = el('div.drop' + (compact ? '.compact' : ''),
    el('div', el('strong', compact ? 'Drop a film here ' : 'Drop films here '), el('span.muted', 'or '), el('label.btn.sm', { for: input.id }, 'Choose a file'), input),
    el('span.muted.small', 'MP4 · H.264 · AAC · 1920 × 1080 · up to 60 MB and 3 minutes'));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async (e) => { e.preventDefault(); zone.classList.remove('over'); const recs = await uploadFilmFiles(app, [...e.dataTransfer.files]); onDone(recs); });
  return zone;
}

export function filmTile(app, f, selected, onClick) {
  const t = el('button.tile-m' + (selected ? '.sel' : ''), { type: 'button', onclick: () => onClick(f) });
  const ph = el('div.ph.film');
  const url = f.poster ? app.media.url(f.poster, 800) : null;
  if (url) ph.style.backgroundImage = `url("${url}")`;
  ph.append(el('span.play'));
  if (!f.poster) ph.append(el('span.badge.warn', 'No poster'));
  if (f.source === 'pending') ph.append(el('span.badge.new', 'Not yet published'));
  const uses = (model.imageUses().get(f.path) || []).length;
  t.append(ph, el('div.nm', f.name), el('div.mt', `${fmtSeconds(f.seconds)} · ${fmtBytes(f.bytes)} · ${f.audio === false || f.silent ? 'silent' : 'sound'} · ${uses ? plural(uses, 'place') : 'not used'}`));
  return t;
}

/**
 * The film picker: choose from Media or upload. onPick(filmPath, record).
 * silentOnly: for a background loop, only films without sound (or marked silent) can be chosen.
 */
export function pickFilm(app, { onPick, silentOnly = false }) {
  let selected = null;
  const grid = el('div.grid', { style: { maxHeight: '46vh', overflow: 'auto', padding: '2px' } });
  const note = el('div.help');
  const render = () => {
    clear(grid);
    const list = app.media.films().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    for (const f of list) {
      const ok = !silentOnly || f.audio === false || f.silent;
      const tile = filmTile(app, f, f.hash === selected, (x) => { selected = x.hash; render(); okBtn.disabled = false; });
      if (!ok) { tile.classList.add('dim'); tile.title = 'Has a sound track: mark it as silent in Media, or export a silent version'; }
      grid.append(tile);
    }
    if (!list.length) grid.append(el('div.empty', 'No films yet. Drop an MP4 above.'));
    const f = list.find((x) => x.hash === selected);
    note.textContent = f ? filmLine(f) + (f.warnings?.length ? ' · ' + f.warnings.join(' ') : '') + (silentOnly && f.bytes > FILM.backgroundWarnBytes ? ` · ${Math.round(f.bytes / 1048576)} MB: background loops should be under 15 MB so every TV downloads them quickly.` : '') : '';
  };
  const body = el('div', filmDropZone(app, (recs) => { if (recs[0]) selected = recs[0].hash; render(); if (selected) okBtn.disabled = false; }),
    silentOnly ? el('p.help', { style: { marginBottom: '8px' } }, 'A background film loops behind the page without sound. Only films with no sound track (or marked as silent in Media) can be chosen.') : null,
    grid, note);
  const m = modal({ title: 'Choose a film', body, wide: true, actions: [{ label: 'Cancel' }, { label: 'Use this film', primary: true, disabled: true, onClick: () => {
    const f = app.media.films().find((x) => x.hash === selected);
    if (!f) return false;
    if (silentOnly && !(f.audio === false || f.silent)) { toast('That film has a sound track. Mark it as silent in Media first, or export a silent version.', { error: true }); return false; }
    onPick(f.path, f);
    return true;
  } }] });
  const okBtn = m.box.querySelector('.actions .btn.pri');
  render();
}

/**
 * Poster capture: scrub to a frame and capture it as a 1920 x 1080 JPG, or
 * upload a poster instead. onDone(posterPath).
 */
export function posterCapture(app, filmSrc, { onDone, title, previous = null }) {
  const f = app.media.film(filmSrc);
  const url = app.media.filmURL(filmSrc);
  if (!f || !url) { toast('That film is not in Media any more.', { error: true }); return; }
  const video = el('video', { muted: true, playsinline: true, preload: 'auto', crossorigin: 'anonymous', style: { width: '100%', aspectRatio: '16 / 9', background: '#000', borderRadius: '6px', display: 'block' } });
  video.muted = true;
  video.src = url;
  const range = el('input', { type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Scrub through the film', style: { width: '100%', marginTop: '10px' } });
  const time = el('span.small.muted', '0.0 s');
  const status = el('div.help');
  let seeking = false;
  const seekTo = (frac) => {
    if (!Number.isFinite(video.duration)) return;
    const t = Math.min(video.duration - 0.05, Math.max(0, frac * video.duration));
    seeking = true;
    video.currentTime = t;
    time.textContent = `${t.toFixed(1)} s of ${video.duration.toFixed(1)} s`;
  };
  range.addEventListener('input', () => seekTo(Number(range.value) / 1000));
  video.addEventListener('seeked', () => { seeking = false; });
  video.addEventListener('loadedmetadata', () => { seekTo(0.1); range.value = '100'; });
  const steps = el('div.row', { style: { marginTop: '6px', gap: '6px' } },
    el('button.btn.sm', { type: 'button', onclick: () => { range.value = String(Math.max(0, Number(range.value) - 10)); seekTo(Number(range.value) / 1000); } }, '‹ 1%'),
    el('button.btn.sm', { type: 'button', onclick: () => { range.value = String(Math.min(1000, Number(range.value) + 10)); seekTo(Number(range.value) / 1000); } }, '1% ›'),
    time);
  const body = el('div', video, range, steps, status,
    el('p.help', { style: { marginTop: '8px' } }, 'The poster is what guests see before they press play, and what the TV shows if the film has not downloaded yet. Pick a frame that reads well as a still: sharp, not mid-motion, no black.'));
  const m = modal({ title: `Poster for ${f.name}`, body, wide: true, actions: [
    { label: 'Cancel' },
    { label: 'Upload a poster instead', onClick: () => { m.close(); pickPhoto(app, { use: 'poster', onPick: (src) => onDone(src) }); return false; } },
    { label: 'Capture this frame', primary: true, onClick: async () => {
      if (seeking) { await new Promise((r) => video.addEventListener('seeked', r, { once: true })); }
      if (video.readyState < 2) { status.textContent = 'The frame has not decoded yet; try again in a moment.'; return false; }
      try {
        const rec = await captureFrame(video, { name: `Poster: ${title || f.name}`.slice(0, 40) });
        if (!app.media.pending.has(rec.hash) && !app.media.index.media[rec.hash]) await app.media.add(rec);
        const path = `media/${rec.hash}-1920.jpg`;
        // Remember the poster on the film too, so Media can show it.
        const pend = app.media.pending.get(f.hash);
        const old = previous || f.poster || null;
        if (pend) { pend.poster = path; await app.browser.putMedia(pend); } else if (app.media.index.films[f.hash]) app.media.index.films[f.hash].poster = path;
        onDone(path);
        // The capture it replaces, if nothing else uses it, never needs to go to the TV.
        let dropped = false;
        if (old && old !== path) dropped = await app.media.dropUnusedCapture(old, model.imageUses());
        toast(dropped ? 'Poster captured at 1920 × 1080. The previous capture was not used anywhere and has been removed from Media.' : 'Poster captured at 1920 × 1080.');
        model.emit({ type: 'media' });
        return true;
      } catch (e) { status.textContent = `Could not capture: ${e.message}`; return false; }
    } },
  ] });
  m.box.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const d = e.key === 'ArrowLeft' ? -5 : 5; range.value = String(Math.max(0, Math.min(1000, Number(range.value) + d))); seekTo(Number(range.value) / 1000); e.preventDefault(); } });
}

/** A small read-only description of a film for the side panels. */
export function filmInfoBox(app, src) {
  const f = app.media.film(src);
  if (!f) return el('div.small', { style: { color: 'var(--red)', fontWeight: '600' } }, 'Film missing: it is no longer in Media. Choose another.');
  const box = el('div.small.muted', filmLine(f));
  if (f.codec) box.append(el('span', ` · ${codecName(f.codec)}`));
  if (f.warnings?.length) box.append(el('div.help', { style: { color: 'var(--amber)' } }, f.warnings.join(' ')));
  return box;
}

