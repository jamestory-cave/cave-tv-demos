// Feedback: gathers the screen name and the tester's comment and copies it,
// ready to paste into WhatsApp or an email. No address is built in.

import { el } from '../util.js';
import { model } from '../model.js';
import { modal, textField, uid, toast } from '../ui.js';

const SCREEN_NAMES = { home: 'Home', editor: 'Page editor', menus: 'Menus', media: 'Media', hotel: 'Hotel details', publish: 'Publish', settings: 'Settings', guide: 'Guide for the visual team' };

export function feedbackModal(app) {
  let comment = '';
  let screen = SCREEN_NAMES[app.screen] || app.screen;
  if (app.screen === 'editor' && app.params.page) screen += `: ${model.pathLabel(app.params.page)}`;
  if (app.screen === 'menus' && app.params.menu) screen += `: ${model.find(app.params.menu)?.page.title || ''}`;
  const field = textField({ id: uid('fb'), label: 'What would you change, or what got in the way?', value: '', multiline: true, rows: 6, limit: 2000, placeholder: 'e.g. I could not find where to change the breakfast hours.', onInput: (v) => { comment = v; } });
  const body = el('div', el('p.small.muted', { style: { marginBottom: '10px' } }, `Screen: ${screen}`), field,
    el('p.help', 'Copy puts the message on your clipboard with the screen name and today\'s date. Paste it into WhatsApp or an email to James.'));
  const text = () => `Cave Builder feedback\nScreen: ${screen}\nDate: ${new Date().toLocaleString('en-GB')}\nBrowser: ${navigator.userAgent.includes('iPad') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : navigator.platform}\n\n${comment.trim()}`;
  modal({
    title: 'Feedback', body,
    actions: [{ label: 'Cancel' }, { label: 'Copy', primary: true, onClick: async () => {
      if (!comment.trim()) { field.input.focus(); return false; }
      try { await navigator.clipboard.writeText(text()); toast('Copied. Paste it into WhatsApp or an email.'); }
      catch { window.prompt('Copy this text:', text()); }
      return true;
    } }],
  });
}
