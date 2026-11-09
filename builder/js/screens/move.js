// "Move to…": puts a page (and everything inside it) under another parent:
// Home, a section, or any page that can hold pages. The page keeps its id,
// so the TV and the change list see a move, not a delete and a new page.
// Used by the page editor ("This page") and by Home.

import { el } from '../util.js';
import { model, moveTargets, reparentPage } from '../model.js';
import { LIMITS } from '../validate.js';
import { toast, modal } from '../ui.js';

/**
 * Opens the chooser for page `id`. `onMoved(newParentId)` runs after the move
 * (and again with the old parent if Undo is pressed on the toast).
 */
export function moveModal(app, id, { onMoved } = {}) {
  const found = model.find(id);
  if (!found || !found.parent) return;
  const page = found.page;
  const inside = model.pages({ home: page }).length - 1;
  const targets = moveTargets(model.draft, id);
  let chosen = null;
  const list = el('div.move-list', { role: 'radiogroup', 'aria-label': 'Move to' });
  const note = el('div.help');
  const okLabel = 'Move here';
  for (const t of targets) {
    const showing = (t.page.children || []).filter((c) => !c.hidden && c.id !== id).length;
    const max = t.id === 'home' ? LIMITS.sectionsMax : LIMITS.itemsMax;
    const full = !page.hidden && showing >= max;
    const where = t.id === 'home' ? 'its own strip on the home screen' : t.depth === 1 ? `a strip inside ${t.title}` : `a tile inside ${t.title}`;
    const opt = el('label.move-opt' + (t.current ? '.current' : ''), { style: { paddingLeft: `${10 + t.depth * 18}px` } },
      el('input', { type: 'radio', name: 'move-to', value: t.id, disabled: t.current, onchange: () => {
        chosen = t.id;
        okBtn.disabled = false;
        note.textContent = `${page.title} becomes ${where}.` + (full ? ` ${t.title} already shows ${showing}; the TV fits ${max}, so hide one there before publishing.` : '');
        note.style.color = full ? 'var(--amber)' : '';
      } }),
      el('span', el('b', t.title), t.current ? el('span.muted.small', ' (here now)') : null));
    list.append(opt);
  }
  const body = el('div',
    el('p.small', inside ? `${page.title} and the ${inside === 1 ? 'page' : `${inside} pages`} inside it move together. Nothing else changes.` : `${page.title} moves with everything on it. Nothing else changes.`),
    list, note);
  const m = modal({
    title: `Move ${page.title} to…`, body,
    actions: [{ label: 'Cancel' }, { label: okLabel, primary: true, disabled: true, onClick: () => {
      if (!chosen) return false;
      // Checked before anything is committed, so a refused move leaves no empty undo step.
      if (!moveTargets(model.draft, id).some((t) => t.id === chosen && !t.current)) { toast('That move is not possible.', { error: true }); return true; }
      const target = model.find(chosen);
      const label = `Move ${page.title}`;
      let back = null;
      model.commit(label, (d) => { back = reparentPage(d, id, chosen); }, { origin: 'move' });
      const step = model.undoStack[model.undoStack.length - 1];   // this move's entry in the history
      const where = chosen === 'home' ? 'Home' : target.page.title;
      toast(`Moved ${page.title} to ${where}.`, { action: 'Undo', onAction: () => {
        // Straight after the move, Undo is the editor's Undo: the move step comes off the history.
        // If something else has been done since, the move is reversed as a step of its own.
        if (model.undoStack[model.undoStack.length - 1] === step) model.undo();
        else if (model.find(id) && model.find(back.fromParentId)) model.commit(`${label} back`, (d) => reparentPage(d, id, back.fromParentId, back.fromIndex), { origin: 'move' });
        else { toast(`${page.title} cannot go back: where it was has changed since.`, { error: true }); return; }
        if (onMoved) onMoved(back.fromParentId);
      } });
      if (onMoved) onMoved(chosen);
      return true;
    } }],
  });
  const okBtn = m.box.querySelector('.actions .btn.pri');
  void app;
}
