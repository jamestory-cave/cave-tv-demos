// Shared interface pieces: fields with counters, modals, toasts, reordering.

import { el, clear, svgIcon } from './util.js';

/**
 * A text field with a character counter. Typing stops at the limit; a paste
 * that goes over is kept, shown red, and blocked from publishing.
 *   textField({label, value, limit, multiline, help, onInput(value), placeholder, id})
 */
export function textField(o) {
  const count = el('span.count');
  const labelRow = el('label', { for: o.id }, el('span', o.label), o.limit ? count : null);
  const input = o.multiline
    ? el('textarea.in', { id: o.id, rows: o.rows || 4, placeholder: o.placeholder || '' })
    : el('input.in', { id: o.id, type: o.type || 'text', placeholder: o.placeholder || '', autocomplete: 'off', spellcheck: o.spellcheck === false ? 'false' : undefined });
  input.value = o.value ?? '';
  let last = input.value;
  const update = () => {
    if (!o.limit) return;
    const n = input.value.length;
    count.textContent = `${n} / ${o.limit}`;
    count.className = 'count' + (n > o.limit ? ' red' : n >= Math.ceil(o.limit * 0.9) ? ' amber' : '');
    input.classList.toggle('over', n > o.limit);
    if (n > o.limit) count.title = 'Over the limit. Trim it before publishing.';
  };
  input.addEventListener('input', () => {
    if (o.limit && input.value.length > o.limit && input.value.length - last.length === 1) {
      // One typed character too many: refuse it. (Pastes are kept and flagged.)
      const pos = input.selectionStart;
      input.value = last;
      try { input.setSelectionRange(pos - 1, pos - 1); } catch { /* ignore */ }
      return;
    }
    last = input.value;
    update();
    o.onInput(input.value);
  });
  if (o.onChange) input.addEventListener('change', () => o.onChange(input.value));
  update();
  const wrap = el('div.field', labelRow, input);
  if (o.help) wrap.append(el('div.help', o.help));
  wrap.input = input;
  return wrap;
}

let counter = 0;
export const uid = (p = 'f') => `${p}-${++counter}`;

// ---- toasts ----
let toastsEl = null;
export function toast(message, { action, onAction, error, ms = 6000 } = {}) {
  if (!toastsEl) { toastsEl = el('div.toasts', { role: 'status', 'aria-live': 'polite' }); document.body.append(toastsEl); }
  const t = el('div.toast' + (error ? '.err' : ''), el('span', message));
  let timer = null;
  const close = () => { clearTimeout(timer); t.remove(); };
  if (action) t.append(el('button', { type: 'button', onclick: () => { close(); onAction && onAction(); } }, action));
  t.append(el('button', { type: 'button', 'aria-label': 'Dismiss', onclick: close }, '×'));
  toastsEl.append(t);
  timer = setTimeout(close, error ? 12000 : ms);
  return close;
}

// ---- modal ----
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const box = el('div.modal' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const back = el('div.modal-back');
  const opener = document.activeElement;
  const close = () => {
    back.remove(); document.removeEventListener('keydown', esc); onClose && onClose();
    if (opener && document.contains(opener) && opener.focus) opener.focus();
  };
  const focusables = () => [...box.querySelectorAll('input, textarea, select, button, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled);
  const esc = (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the dialog.
    const list = focusables();
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', esc);
  box.append(el('h2', title));
  if (body) box.append(body);
  const row = el('div.actions');
  for (const a of actions) {
    row.append(el('button.btn' + (a.primary ? '.pri' : '') + (a.danger ? '.danger' : ''), {
      type: 'button', disabled: a.disabled, onclick: async () => { const r = a.onClick ? await a.onClick(close) : null; if (r !== false && !a.keepOpen) close(); },
    }, a.label));
  }
  if (actions.length) box.append(row);
  back.append(box);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  const first = box.querySelector('input, textarea, button');
  if (first) first.focus();
  return { close, box };
}

export function confirmModal(title, text, { okLabel = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    modal({
      title, body: el('p', text),
      actions: [{ label: 'Cancel', onClick: () => resolve(false) }, { label: okLabel, primary: !danger, danger, onClick: () => resolve(true) }],
      onClose: () => resolve(false),
    });
  });
}

export function promptModal(title, text, { value = '', placeholder = '', okLabel = 'OK', limit = 60 } = {}) {
  return new Promise((resolve) => {
    let v = value;
    const field = textField({ label: text, value, limit, placeholder, id: uid('p'), onInput: (x) => { v = x; } });
    const m = modal({
      title, body: field,
      actions: [{ label: 'Cancel', onClick: () => resolve(null) }, { label: okLabel, primary: true, onClick: () => resolve(v.trim()) }],
      onClose: () => resolve(null),
    });
    field.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); resolve(v.trim()); m.close(); } });
    field.input.focus();
  });
}

// ---- reordering ----
/**
 * Makes the children of `container` (matching `selector`) draggable with the
 * mouse and via pointer events on their `.grip` (touch). Calls onMove(from, to).
 * Move buttons remain the reliable path on touch; this is the nicety.
 */
export function sortable(container, selector, onMove) {
  let dragging = null;
  const items = () => [...container.querySelectorAll(selector)];
  const clearMarks = () => items().forEach((x) => x.classList.remove('drop-before', 'drop-after', 'dragging'));
  const horizontal = () => {
    const a = items();
    return a.length > 1 && Math.abs(a[0].getBoundingClientRect().top - a[1].getBoundingClientRect().top) < 4;
  };
  const targetAt = (x, y) => {
    const over = document.elementFromPoint(x, y);
    return over ? over.closest(selector) : null;
  };
  const sideOf = (target, x, y) => {
    const r = target.getBoundingClientRect();
    return horizontal() ? (x < r.left + r.width / 2 ? 'before' : 'after') : (y < r.top + r.height / 2 ? 'before' : 'after');
  };
  const finish = (target, side) => {
    if (!dragging) return;
    const list = items();
    const from = list.indexOf(dragging);
    let to = target && target !== dragging ? list.indexOf(target) : -1;
    clearMarks();
    dragging = null;
    if (from < 0 || to < 0) return;
    if (side === 'after') to += 1;
    if (to > from) to -= 1;
    if (to !== from) onMove(from, to);
  };

  // Mouse: native HTML5 drag.
  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest(selector);
    if (!item || !container.contains(item)) return;
    dragging = item;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', 'move'); } catch { /* ignore */ }
  });
  container.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const target = e.target.closest(selector);
    items().forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    if (target && target !== dragging) target.classList.add('drop-' + sideOf(target, e.clientX, e.clientY));
  });
  container.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const target = e.target.closest(selector);
    finish(target, target ? sideOf(target, e.clientX, e.clientY) : null);
  });
  container.addEventListener('dragend', () => { clearMarks(); dragging = null; });

  // Touch: pointer events from the grip.
  container.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const grip = e.target.closest('.grip');
    const item = grip && grip.closest(selector);
    if (!item) return;
    e.preventDefault();
    dragging = item;
    item.classList.add('dragging');
    const move = (ev) => {
      ev.preventDefault();
      const target = targetAt(ev.clientX, ev.clientY);
      items().forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      if (target && target !== dragging) target.classList.add('drop-' + sideOf(target, ev.clientX, ev.clientY));
    };
    const up = (ev) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      const target = targetAt(ev.clientX, ev.clientY);
      finish(target, target ? sideOf(target, ev.clientX, ev.clientY) : null);
    };
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  });
}

/** Two small buttons that move an item up/down (or left/right). */
export function moveButtons(index, count, onMove, horizontal = false) {
  return el('div.ops',
    el('button.mini', { type: 'button', 'aria-label': horizontal ? 'Move left' : 'Move up', disabled: index === 0, onclick: () => onMove(index, index - 1) }, svgIcon(horizontal ? 'left' : 'up', 14)),
    el('button.mini', { type: 'button', 'aria-label': horizontal ? 'Move right' : 'Move down', disabled: index >= count - 1, onclick: () => onMove(index, index + 1) }, svgIcon(horizontal ? 'right' : 'down', 14)));
}

export function iconButton(name, label, onClick, cls = 'mini') {
  return el(`button.${cls}`, { type: 'button', 'aria-label': label, title: label, onclick: onClick }, svgIcon(name, 14));
}

export { el, clear, svgIcon };
