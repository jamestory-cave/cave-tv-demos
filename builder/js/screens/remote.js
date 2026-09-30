// On-screen Siri Remote for touch screens, after docs/design/demos-round-3/player.html.
// Tap or swipe the pad, tap the centre to select, Menu goes back.

import { el } from '../util.js';

const NS = 'http://www.w3.org/2000/svg';
const S = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...kids);
  return n;
};

/**
 * @param send (key) => void with key in left|right|up|down|enter|back
 * @param wide  true puts Menu and Select beside the pad (short and wide, for
 *              narrow screens where the pad sits under the TV)
 */
export function remotePad(send, { wide = false } = {}) {
  const wedge = 'M75 32 A54 54 0 0 1 116 62 L96 76 A22 22 0 0 0 75 64 Z';
  const g = wide
    ? { vb: '0 0 300 172', rect: [8, 8, 284, 156], menu: [195, 86], select: [250, 86], labelY: 114, hint: [222, 150] }
    : { vb: '0 0 150 250', rect: [8, 8, 134, 234], menu: [48, 172], select: [102, 172], labelY: 200, hint: [75, 228] };
  const svg = S('svg', { viewBox: g.vb, 'aria-label': 'On-screen remote', role: 'group' },
    S('rect', { x: g.rect[0], y: g.rect[1], width: g.rect[2], height: g.rect[3], rx: 26, fill: 'rgba(0,0,0,0.04)', stroke: '#b7996d', 'stroke-opacity': '.8', 'stroke-width': '1.4' }),
    S('g', { id: 'pad' },
      S('circle', { cx: 75, cy: 86, r: 54, fill: '#1a1712', stroke: '#b7996d', 'stroke-opacity': '.9', 'stroke-width': '1.4' }),
      S('circle', { cx: 75, cy: 86, r: 22, fill: 'rgba(255,255,255,0.05)', stroke: '#b7996d', 'stroke-opacity': '.55', 'stroke-width': '1' }),
      ...['up', 'right', 'down', 'left'].map((k, i) => S('path', { class: 'flash', 'data-k': k, d: wedge, fill: '#b7996d', 'fill-opacity': '.35', transform: `rotate(${-45 + i * 90} 75 86)` })),
      S('circle', { class: 'flash', 'data-k': 'enter', cx: 75, cy: 86, r: 22, fill: '#b7996d', 'fill-opacity': '.45' }),
      S('g', { stroke: '#b7996d', 'stroke-opacity': '.8', 'stroke-width': '1.6', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
        S('path', { d: 'M70 46 l5 -5 l5 5' }), S('path', { d: 'M70 126 l5 5 l5 -5' }), S('path', { d: 'M35 81 l-5 5 l5 5' }), S('path', { d: 'M115 81 l5 5 l-5 5' }))),
    S('g', { id: 'menu', 'data-k': 'back' },
      S('circle', { cx: g.menu[0], cy: g.menu[1], r: 17, fill: 'rgba(0,0,0,0.04)', stroke: '#b7996d', 'stroke-opacity': '.8', 'stroke-width': '1.2' }),
      S('circle', { class: 'flash', 'data-k': 'back', cx: g.menu[0], cy: g.menu[1], r: 17, fill: '#b7996d', 'fill-opacity': '.45' }),
      S('path', { d: `M${g.menu[0] + 4} ${g.menu[1] - 8} l-8 8 l8 8`, stroke: '#b7996d', 'stroke-width': '2', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })),
    S('g', { id: 'select', 'data-k': 'enter' },
      S('circle', { cx: g.select[0], cy: g.select[1], r: 17, fill: 'rgba(0,0,0,0.04)', stroke: '#b7996d', 'stroke-opacity': '.8', 'stroke-width': '1.2' }),
      S('circle', { class: 'flash', 'data-k': 'enter', cx: g.select[0], cy: g.select[1], r: 17, fill: '#b7996d', 'fill-opacity': '.45' }),
      S('circle', { cx: g.select[0], cy: g.select[1], r: 5, fill: '#b7996d' })),
    S('text', { x: g.menu[0], y: g.labelY, 'text-anchor': 'middle', 'font-family': 'Inter, sans-serif', 'font-size': '6.5', 'letter-spacing': '1.5', fill: '#7d683f' }, 'MENU'),
    S('text', { x: g.select[0], y: g.labelY, 'text-anchor': 'middle', 'font-family': 'Inter, sans-serif', 'font-size': '6.5', 'letter-spacing': '1.5', fill: '#7d683f' }, 'SELECT'),
    S('text', { x: g.hint[0], y: g.hint[1], 'text-anchor': 'middle', 'font-family': 'Inter, sans-serif', 'font-size': '6', 'letter-spacing': '1', fill: '#7d683f' }, 'SWIPE OR TAP THE PAD'));

  const flash = (k) => svg.querySelectorAll(`.flash[data-k="${k}"]`).forEach((f) => { f.classList.add('on'); setTimeout(() => f.classList.remove('on'), 160); });
  const fire = (k) => { flash(k); send(k); };
  const toSvg = (ev) => { const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); };

  const pad = svg.querySelector('#pad');
  let start = null;
  pad.addEventListener('pointerdown', (ev) => { ev.preventDefault(); pad.setPointerCapture(ev.pointerId); start = toSvg(ev); });
  pad.addEventListener('pointerup', (ev) => {
    if (!start) return;
    ev.preventDefault();
    const end = toSvg(ev);
    const dx = end.x - start.x, dy = end.y - start.y;
    let key;
    if (Math.hypot(dx, dy) > 12) key = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    else {
      const rx = start.x - 75, ry = start.y - 86;
      if (Math.hypot(rx, ry) <= 24) key = 'enter';
      else key = Math.abs(rx) > Math.abs(ry) ? (rx > 0 ? 'right' : 'left') : (ry > 0 ? 'down' : 'up');
    }
    start = null;
    fire(key);
  });
  pad.addEventListener('pointercancel', () => { start = null; });
  for (const id of ['menu', 'select']) {
    const g = svg.querySelector('#' + id);
    g.style.cursor = 'pointer';
    g.addEventListener('pointerdown', (ev) => ev.preventDefault());
    g.addEventListener('pointerup', (ev) => { ev.preventDefault(); fire(g.dataset.k); });
  }
  return el('div.remote-pad', svg);
}
