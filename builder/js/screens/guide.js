// Guide for the visual team: artwork and film rules, the Adobe Media Encoder
// recipe, what the Builder checks and what it cannot, and a safe-area
// template PNG drawn in the browser (3840 x 2160, transparent) to download.

import { el, clear } from '../util.js';
import { FILM } from '../media.js';

const SAFE = { side: 96, topBottom: 64, band: 200, minBody: 30, minAny: 24 }; // on a 1920 x 1080 canvas

/** Draws the safe-area template at 3840 x 2160 (every guide doubled) on a transparent canvas. */
export function drawTemplate(canvas, { opaque = false } = {}) {
  const W = 3840, H = 2160, k = 2;
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, W, H);
  if (opaque) { c.fillStyle = '#080808'; c.fillRect(0, 0, W, H); }
  const blue = 'rgba(43,89,195,0.95)';
  // Top band.
  c.fillStyle = 'rgba(79,134,255,0.16)';
  c.fillRect(0, 0, W, SAFE.band * k);
  c.strokeStyle = blue; c.lineWidth = 6; c.setLineDash([36, 24]);
  c.beginPath(); c.moveTo(0, SAFE.band * k); c.lineTo(W, SAFE.band * k); c.stroke();
  // Safe margin.
  c.strokeRect(SAFE.side * k, SAFE.topBottom * k, W - 2 * SAFE.side * k, H - 2 * SAFE.topBottom * k);
  c.setLineDash([]);
  // Labels.
  const label = (text, x, y, align = 'left') => {
    c.font = '600 44px Inter, Helvetica, Arial, sans-serif';
    const w = c.measureText(text).width + 40;
    c.fillStyle = blue;
    c.fillRect(align === 'right' ? x - w : x, y - 56, w, 68);
    c.fillStyle = '#fff'; c.textAlign = align; c.textBaseline = 'alphabetic';
    c.fillText(text, align === 'right' ? x - 20 : x + 20, y - 8);
  };
  label(`Top band ${SAFE.band} px (${SAFE.band * k} here): the TV darkens this and draws the path line and Back. Pictures may run through it; words may not.`, SAFE.side * k, SAFE.band * k - 12);
  label(`Keep words and logos inside this line: ${SAFE.side} px from the sides, ${SAFE.topBottom} px from top and bottom (${SAFE.side * k} / ${SAFE.topBottom * k} here)`, SAFE.side * k, H - SAFE.topBottom * k + 66);
  label('Cave TV safe-area template · 3840 × 2160 · delete this layer before export', W - SAFE.side * k, H - SAFE.topBottom * k + 66, 'right');
  // Type-size samples.
  c.fillStyle = 'rgba(255,255,255,0.92)'; c.textAlign = 'left';
  c.font = `500 ${SAFE.minBody * k}px Inter, Helvetica, Arial, sans-serif`;
  c.fillText(`Body text: ${SAFE.minBody} px on a 1920 canvas (${SAFE.minBody * k} px here) is the smallest a guest can read from the bed.`, SAFE.side * k + 40, H - SAFE.topBottom * k - 150);
  c.font = `500 ${SAFE.minAny * k}px Inter, Helvetica, Arial, sans-serif`;
  c.fillText(`Nothing smaller than ${SAFE.minAny} px (${SAFE.minAny * k} px here), even captions and footnotes.`, SAFE.side * k + 40, H - SAFE.topBottom * k - 80);
  // Path line and Back mock, so the designer sees what sits in the band.
  c.font = '400 48px Inter, Helvetica, Arial, sans-serif'; c.fillStyle = 'rgba(183,153,109,0.85)';
  c.fillText('CAVE   ›   Contact & Help   ›   Fire plan', 180, 168);
  c.fillText('‹  Back', 180, 300);
  // Corner where the QR card and slide counter sit.
  c.strokeStyle = 'rgba(183,153,109,0.7)'; c.lineWidth = 4; c.setLineDash([20, 16]);
  c.strokeRect(W - SAFE.side * k - 520, H - SAFE.topBottom * k - 640, 520, 640);
  c.setLineDash([]);
  c.font = '500 36px Inter, Helvetica, Arial, sans-serif'; c.fillStyle = 'rgba(183,153,109,0.85)'; c.textAlign = 'right';
  c.fillText('QR card and slide counter sit here (bottom right)', W - SAFE.side * k - 20, H - SAFE.topBottom * k - 660);
}

export function mount(host, app) {
  const main = el('main', { style: { maxWidth: '900px' } });
  host.append(el('div.screen', main));
  clear(main);
  main.append(el('h1', 'Guide for the visual team'), el('p.muted', { style: { marginBottom: '16px' } }, 'What the TV needs from artwork and film, how to export it from Adobe, and what the Builder checks for you.'));

  // ---- artwork ----
  const art = el('div.panel.guide', { style: { marginBottom: '16px' } });
  art.append(el('h2', 'Finished pages: artwork'));
  art.append(el('ul',
    el('li', el('b', 'Size and shape. '), 'Exactly 16:9. 3840 × 2160 is the standard (the TV is 4K); 1920 × 1080 is the minimum and is accepted with a warning. Anything else is refused.'),
    el('li', el('b', 'File. '), 'PNG for artwork with lettering, JPG for photographs. Up to 25 MB. The Builder makes the TV copies itself.'),
    el('li', el('b', 'Safe margins. '), `On a 1920 × 1080 canvas keep words, logos and faces ${SAFE.side} px in from the sides and ${SAFE.topBottom} px in from the top and bottom. At 3840 × 2160 that is ${SAFE.side * 2} and ${SAFE.topBottom * 2}. TVs may crop outside this.`),
    el('li', el('b', 'Top band. '), `Keep the top ${SAFE.band} px (${SAFE.band * 2} at 3840) free of words. The TV darkens that band and draws the path line and Back over it. Pictures may run through it.`),
    el('li', el('b', 'Type. '), `Text a guest must read: ${SAFE.minBody} px or larger on a 1920 canvas (${SAFE.minBody * 2} at 3840). Nothing under ${SAFE.minAny} px. Guests read from the bed, three metres away.`),
    el('li', el('b', 'Words. '), 'About 60 at most. More than that belongs on a page built from parts, where the TV sets the type.'),
    el('li', el('b', 'Bottom right. '), 'If the page has a QR link the TV draws a 260 px card there, and a "1 of 3" counter when there is more than one slide. Leave that corner quiet.'),
    el('li', el('b', 'Slides. '), 'A finished page holds 1 to 10 slides. Left and Right move between them on the remote; nothing else on the page can be selected. A slide can be a film.')));
  const tpl = el('div.row.wrap', { style: { marginTop: '10px' } });
  const canvas = document.createElement('canvas');
  const dl = el('a.btn.pri.sm', { href: '#', download: 'cave-tv-safe-area-3840x2160.png' }, 'Download the safe-area template (PNG, 3840 × 2160)');
  dl.addEventListener('click', (e) => {
    e.preventDefault();
    drawTemplate(canvas);
    canvas.toBlob((b) => { const u = URL.createObjectURL(b); const a = el('a', { href: u, download: dl.download }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000); }, 'image/png');
  });
  tpl.append(dl, el('span.small.muted', 'Transparent PNG with the guides drawn. In Photoshop or Illustrator: place it as the top layer of a 3840 × 2160 document, design under it, delete the layer before exporting.'));
  art.append(tpl);
  const previewC = document.createElement('canvas');
  drawTemplate(previewC, { opaque: true });
  previewC.style.width = '100%'; previewC.style.marginTop = '10px'; previewC.style.borderRadius = '6px';
  art.append(previewC);
  main.append(art);

  // ---- film ----
  const film = el('div.panel.guide', { style: { marginBottom: '16px' } });
  film.append(el('h2', 'Films'));
  film.append(el('ul',
    el('li', el('b', 'Container and codecs. '), 'MP4 with H.264 video and AAC stereo audio. Nothing else plays on the TV: not .mov, ProRes, HEVC (H.265), WebM or AV1.'),
    el('li', el('b', 'Picture. '), '1920 × 1080, 25 or 30 frames a second, progressive. 1280 × 720 is accepted with a warning and looks soft. 4K films are refused: the file limit makes them impractical.'),
    el('li', el('b', 'Size and length. '), `Up to ${FILM.maxBytes / 1048576} MB and 3 minutes. 30 to 90 seconds is the sweet spot. At ${FILM.targetMbps} Mb/s a 60-second film is about 45 MB.`),
    el('li', el('b', 'Poster. '), 'Every film needs a still, shown before it plays and whenever the film has not downloaded yet. The Builder captures one from any frame, or you can upload a 1920 × 1080 JPG.'),
    el('li', el('b', 'Background loops. '), 'A silent film that loops behind a page: 8 to 20 seconds, ending where it starts, exported with no audio track (or marked as silent in Media). Aim for under 15 MB so every TV downloads it quickly (the Builder warns above that); 60 MB is the hard limit for any film.'),
    el('li', el('b', 'Fast start. '), 'Tick "Use fast start" / "web optimised" so the index is at the front of the file and the TV can start before the whole file has arrived.')));
  film.append(el('h3', { style: { marginTop: '14px' } }, 'Adobe Media Encoder recipe'));
  film.append(el('ol', { style: { paddingLeft: '20px', lineHeight: '1.6' } },
    el('li', 'Format: ', el('b', 'H.264'), '. Preset: start from "Match Source – High bitrate", then set the values below and save it as a preset called "Cave TV".'),
    el('li', 'Video: 1920 × 1080, frame rate "same as source" (25 or 30), field order Progressive, aspect Square Pixels, profile High, level 4.1 or 4.2.'),
    el('li', 'Bitrate: ', el('b', 'VBR, 1 pass'), ', target ', el('b', `${FILM.targetMbps} Mb/s`), ', maximum 8 Mb/s. Leave "Render at maximum depth" and "Maximum render quality" off unless the source is very fine grain.'),
    el('li', 'Audio: ', el('b', 'AAC'), ', stereo, 48 kHz, ', el('b', '192 kb/s'), '. For a background loop untick "Export audio" entirely.'),
    el('li', 'Multiplexer: MP4, ', el('b', 'Use fast start'), ' on.'),
    el('li', 'Check the estimated file size in the export panel: under 60 MB. If it is over, shorten the film or lower the target bitrate to 4 or 5 Mb/s.')));
  film.append(el('p.small.muted', { style: { marginTop: '8px' } }, 'Premiere Pro and After Effects export through the same Media Encoder settings. From Final Cut Pro use "Export File", format Computer, video codec H.264 Better Quality, and check the size.'));
  main.append(film);

  // ---- what the builder checks ----
  const chk = el('div.panel.guide', { style: { marginBottom: '16px' } });
  chk.append(el('h2', 'What the Builder checks, and what it cannot'));
  chk.append(el('div.two',
    el('div', el('h3', 'Checked on upload'), el('ul',
      el('li', 'Artwork: file type, size in pixels, shape (16:9 within 1%), file size.'),
      el('li', 'Film: MP4 container, H.264 video, AAC audio, picture size, length, file size, bitrate, whether there is a sound track, index at the front (fast start), and that this browser can decode the first moments.'),
      el('li', 'Before publishing: every finished page has at least one slide, a title, a description and a strip photo; every film has a poster; a background film is silent; nothing over the page limits.'))),
    el('div', el('h3', 'Checked by eye'), el('ul',
      el('li', 'Whether words sit inside the safe margins and out of the top band: switch on "Safe area" above the TV preview.'),
      el('li', 'Whether text is large enough: compare with the samples on the template, or look at the preview from across the room.'),
      el('li', 'Spelling, prices and dates in the artwork. The Builder cannot read them.'),
      el('li', 'How a film looks and sounds on the TV: the preview shows the poster only and never plays video. Check the real thing on the Penthouse TV after publishing.')))));
  main.append(chk);

  main.append(el('p.muted.small', 'Rules from docs/builder/PROTOTYPE.md (stage 2) and the UX spec, section 6. If a rule gets in the way, say so through the Feedback button.'));
  return {};
}
