// Hotel details: entered once, shown on the Contact page and wherever the TV needs them.

import { el } from '../util.js';
import { model } from '../model.js';
import { LIMITS } from '../validate.js';
import { textField, uid } from '../ui.js';
import { TVPreview } from '../preview/stage.js';

const FIELDS = [
  ['name', 'Hotel name', 'Shown on the home strip.', LIMITS.hotelField],
  ['tagline', 'Tagline', 'Under the logo on the home screen.', LIMITS.tagline],
  ['reception', 'Reception', 'e.g. Dial 0', LIMITS.hotelField],
  ['roomService', 'Room service', 'e.g. Dial 1', LIMITS.hotelField],
  ['wifiName', 'Wi-Fi network name', 'As guests see it in their Wi-Fi settings.', LIMITS.hotelField],
  ['wifiPassword', 'Wi-Fi password', 'Leave empty if the network is open. Anything typed here is shown to guests and stored in a public place.', LIMITS.hotelField],
  ['checkout', 'Check-out', 'e.g. 11:00am', LIMITS.hotelField],
];

export function mount(host, app) {
  const main = el('main');
  const aside = el('aside');
  host.append(el('div.screen', main, aside));
  let preview = null;

  main.append(el('h1', 'Hotel details'), el('p.muted', { style: { marginBottom: '16px' } }, 'Entered once. The Contact & Help page and the check-out row read from here, so a number cannot be right on one page and wrong on another.'));
  const form = el('div.form-2');
  for (const [key, label, help, limit] of FIELDS) {
    form.append(textField({ id: uid('h'), label, help, limit, value: model.draft.hotel[key] || '', onInput: (v) => model.commit(`Edit ${label.toLowerCase()}`, (d) => { d.hotel[key] = v; }, { origin: 'hotel', coalesce: 'hotel.' + key }) }));
  }
  main.append(form);

  aside.append(el('h3', 'Contact & Help on the TV'));
  const tvHost = el('div');
  aside.append(tvHost);
  const contact = model.pages().find((e) => e.page.type === 'contact');
  const refresh = () => {
    if (!preview) return;
    preview.setDoc(model.draft, { reveal: contact ? [contact.page.id] : [] });
  };
  preview = new TVPreview(tvHost, { media: app.media, logoURL: app.logoURL });
  refresh();
  if (contact) preview.showPage(contact.page.id);
  else aside.append(el('p.muted.small', { style: { marginTop: '8px' } }, 'There is no Contact page yet. Add one from Home to show these details.'));

  return { update() { refresh(); }, unmount() { preview?.destroy(); } };
}
