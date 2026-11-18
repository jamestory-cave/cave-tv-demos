// Room-specific overrides (docs/builder/2026-11-room-specific-content.md,
// sections 2 to 5). Hotel server only: GitHub mode never shows or publishes them.
//
// The master page tree stays exactly as it is. Next to it, in the shared
// draft (never in the bundle the TVs read), `doc.overrides` says which
// elements and pages differ by room type or by room number:
//
//   doc.overrides = {
//     "<page id>": {
//       "fields": {
//         "<field>": { "by": "type" | "room", "values": { "<key>": <value>, ... } }
//       },
//       "page": { "by": "type" | "room", "versions": { "<key>": { "<page field>": <value>, ... } } }
//     }
//   }
//
//   <field>  title, kicker, subtitle, body, image, qr, or items/<card id>/qr
//            (FIELDS below; more can be added the same way).
//   <key>    the room type's id (as text) when "by" is "type"; the room
//            number when "by" is "room". Type ids never change when a type
//            is renamed; room numbers are what staff see, type and paste.
//   <value>  text for the words, a photo path for image, {url, label?} for
//            a QR code (no label: the master's line is used).
//   versions (stage B) are sparse: only the fields changed in that version.
//            Fields not in it follow the master, so later master edits
//            reach every version that did not change them.
//
// A blank value is never stored: no value means "use the master".
//
// At publish the Builder resolves this against the bundle it generated into
// `entries` (what the server compiles; see resolveForPublish). The server
// lays them over the master per TV: room number first, then room type,
// then the master.

import { clone, canonical } from './util.js';
import { cleanPage } from './bundle.js';
import { LIMITS, photoProblem, validatePage, validHTTPS, normaliseLink, linkProblem } from './validate.js';

// The link rules are shared with the server (validate.js, selftest-data/link-rules.json).
export { validHTTPS };

/** The elements that can be tagged, by field key. `items/*` is a card's own QR code. */
export const FIELDS = {
  title:    { kind: 'text', label: 'Title', limit: LIMITS.title },
  kicker:   { kind: 'text', label: 'Small caps line', limit: LIMITS.kicker },
  subtitle: { kind: 'text', label: 'Subtitle', limit: LIMITS.subtitle },
  body:     { kind: 'text', label: 'Text', limit: LIMITS.body, multiline: true },
  image:    { kind: 'photo', label: 'Photo' },
  qr:       { kind: 'qr', label: 'QR code' },
  card:     { kind: 'qr', label: 'Card QR code' },
};

/** Page fields a page version (stage B) may change. Children and the heading over them always follow the master. */
export const VERSION_KEYS = ['title', 'subtitle', 'kicker', 'image', 'body', 'facts', 'hoursTitle', 'hours', 'qr', 'sections', 'images', 'items',
  'description', 'photos', 'films', 'backgroundFilm', 'slides', 'gallery'];

export const SCOPES = { type: 'Different by room type', room: 'Different by room number' };
export const SCOPE_SHORT = { type: 'by room type', room: 'by room number' };

const CARD = /^items\/([^/]+)\/qr$/;

export const cardField = (cardId) => `items/${cardId}/qr`;

/** The definition of a field key, or null if it cannot be tagged. */
export function fieldDef(field) {
  if (CARD.test(field)) return FIELDS.card;
  return Object.prototype.hasOwnProperty.call(FIELDS, field) && field !== 'card' ? FIELDS[field] : null;
}

/** What a field is called in lists and messages: "QR code", 'QR code on card "Firepit Tasting"'. */
export function fieldLabel(page, field) {
  const m = CARD.exec(field);
  if (m) {
    const card = (page?.items || []).find((it) => it.id === m[1]);
    return card ? `QR code on card "${card.title || 'untitled'}"` : 'QR code on a card no longer on this page';
  }
  if (field === 'page') return 'This page';
  return fieldDef(field)?.label || field;
}

// ---- reading ------------------------------------------------------------------

export const all = (doc) => (doc && doc.overrides && typeof doc.overrides === 'object' ? doc.overrides : {});

/** The record for one tagged element, or null. */
export function getField(doc, pageId, field) {
  const f = all(doc)[pageId]?.fields?.[field];
  return f && (f.by === 'type' || f.by === 'room') ? f : null;
}

/** The page-version record (stage B), or null. */
export function getPage(doc, pageId) {
  const p = all(doc)[pageId]?.page;
  return p && (p.by === 'type' || p.by === 'room') ? p : null;
}

/** 'type', 'room' or null for a field key or 'page'. */
export function tagOf(doc, pageId, field) {
  return (field === 'page' ? getPage(doc, pageId) : getField(doc, pageId, field))?.by || null;
}

/** How many rooms or types have their own value (or version with changes). */
export function filledCount(rec) {
  if (!rec) return 0;
  if (rec.versions) return Object.values(rec.versions).filter((v) => v && Object.keys(v).length).length;
  return Object.keys(rec.values || {}).length;
}

/** Every tagged item, page by page in tree order: [{pageId, field, rec}]. Orphans (pages gone) last, with page null. */
export function listTagged(doc) {
  const out = [];
  const seen = new Set();
  const walk = (page) => {
    const o = all(doc)[page.id];
    if (o) {
      seen.add(page.id);
      if (getPage(doc, page.id)) out.push({ pageId: page.id, field: 'page', rec: o.page, page });
      for (const field of Object.keys(o.fields || {})) if (getField(doc, page.id, field)) out.push({ pageId: page.id, field, rec: o.fields[field], page });
    }
    for (const c of page.children || []) walk(c);
  };
  if (doc?.home) walk(doc.home);
  for (const [pageId, o] of Object.entries(all(doc))) {
    if (seen.has(pageId)) continue;
    if (o?.page) out.push({ pageId, field: 'page', rec: o.page, page: null });
    for (const field of Object.keys(o?.fields || {})) out.push({ pageId, field, rec: o.fields[field], page: null });
  }
  return out;
}

/** The master's value of a tagged element, from a draft page. */
export function masterValue(page, field) {
  if (!page) return undefined;
  const m = CARD.exec(field);
  if (m) return (page.items || []).find((it) => it.id === m[1])?.qr;
  return page[field];
}

// ---- changing (call inside model.commit) ------------------------------------------

function pageRec(doc, pageId) {
  doc.overrides = doc.overrides && typeof doc.overrides === 'object' ? doc.overrides : {};
  doc.overrides[pageId] = doc.overrides[pageId] || {};
  return doc.overrides[pageId];
}

function tidy(doc, pageId) {
  const o = doc.overrides?.[pageId];
  if (!o) return;
  if (o.fields && !Object.keys(o.fields).length) delete o.fields;
  if (!o.fields && !o.page) delete doc.overrides[pageId];
  if (doc.overrides && !Object.keys(doc.overrides).length) delete doc.overrides;
}

/** Tags (by 'type' or 'room') or untags (null) a field or 'page'. Changing the scope starts afresh. */
export function setTag(doc, pageId, field, by) {
  if (field === 'page') {
    const cur = getPage(doc, pageId);
    if (!by) { if (doc.overrides?.[pageId]) delete doc.overrides[pageId].page; tidy(doc, pageId); return; }
    if (cur?.by === by) return;
    pageRec(doc, pageId).page = { by, versions: {} };
    return;
  }
  if (!fieldDef(field)) return;
  const cur = getField(doc, pageId, field);
  if (!by) { if (doc.overrides?.[pageId]?.fields) delete doc.overrides[pageId].fields[field]; tidy(doc, pageId); return; }
  if (cur?.by === by) return;
  const rec = pageRec(doc, pageId);
  rec.fields = rec.fields || {};
  rec.fields[field] = { by, values: {} };
}

/** True when a value means "use the master". */
export function isBlank(field, value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return !value.trim();
  if (fieldDef(field)?.kind === 'qr') return !String(value.url || '').trim();
  return false;
}

/** Sets one room's or type's value; a blank value clears it (back to the master). */
export function setValue(doc, pageId, field, key, value) {
  const rec = getField(doc, pageId, field);
  if (!rec) return;
  rec.values = rec.values || {};
  if (isBlank(field, value)) delete rec.values[key];
  else if (fieldDef(field)?.kind === 'qr') {
    const v = { url: String(value.url).trim() };
    if (value.label !== undefined && value.label !== null && String(value.label) !== '') v.label = String(value.label);
    rec.values[key] = v;
  } else rec.values[key] = value;
}

/** The sparse patch of one page version (stage B), or {} when it follows the master throughout. */
export function versionPatch(doc, pageId, key) {
  return getPage(doc, pageId)?.versions?.[key] || {};
}

/** Replaces one version's patch; an empty patch means "the master". */
export function setVersionPatch(doc, pageId, key, patch) {
  const rec = getPage(doc, pageId);
  if (!rec) return;
  rec.versions = rec.versions || {};
  if (!patch || !Object.keys(patch).length) delete rec.versions[key];
  else rec.versions[key] = patch;
}

/** The page as one version shows it: the master with the version's changed fields laid over it. */
export function effectivePage(master, patch) {
  const out = clone(master);
  for (const [k, v] of Object.entries(patch || {})) {
    if (!VERSION_KEYS.includes(k)) continue;
    if (v === null || v === undefined) delete out[k];
    else out[k] = clone(v);
  }
  return out;
}

/** The fields where `edited` differs from `master`: the sparse patch a version stores. Absent in edited = null. */
export function diffPatch(master, edited) {
  const patch = {};
  for (const k of VERSION_KEYS) {
    const a = master[k], b = edited[k];
    const empty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (empty(a) && empty(b)) continue;
    if (canonical(a ?? null) === canonical(b ?? null)) continue;
    patch[k] = empty(b) ? null : clone(b);
  }
  return patch;
}

/** What untagging would drop, in words ("12 rooms have their own QR code"), or '' when nothing is filled in. */
export function dropSummary(doc, pageId, field) {
  const rec = field === 'page' ? getPage(doc, pageId) : getField(doc, pageId, field);
  const n = filledCount(rec);
  if (!n) return '';
  const what = rec.by === 'type' ? (n === 1 ? 'room type' : 'room types') : (n === 1 ? 'room' : 'rooms');
  const thing = field === 'page' ? 'version of this page' : (CARD.test(field) ? 'QR code on this card' : fieldDef(field).label.toLowerCase().replace('qr', 'QR'));
  return `${n} ${what} ${n === 1 ? 'has its' : 'have their'} own ${thing}`;
}

// ---- card ids ---------------------------------------------------------------------
// Cards have no ids in the TV's format; overrides on a card's QR code need one
// that survives reordering and renaming. They are Builder-only (bundle.js
// leaves them out) and given deterministically when a draft is loaded, so two
// browsers opening the same shared draft name every card the same way.

function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** Gives every card without an id one. random: for cards made by an edit (else deterministic). Returns doc. */
export function ensureCardIds(doc, { random = null } = {}) {
  const walk = (page) => {
    if (Array.isArray(page.items) && page.items.length) {
      const used = new Set(page.items.map((it) => it && it.id).filter(Boolean));
      page.items.forEach((it, i) => {
        if (!it || typeof it !== 'object' || (typeof it.id === 'string' && it.id)) return;
        let id = random ? `card-${random()}` : `card-${fnv(`${page.id}|${i}|${it.title || ''}`)}`;
        let n = 2;
        while (used.has(id)) id = `${id.replace(/-\d+$/, '')}-${n++}`;
        used.add(id);
        it.id = id;
      });
    }
    for (const c of page.children || []) walk(c);
  };
  if (doc?.home) walk(doc.home);
  return doc;
}

// ---- seeing what a room gets (Preview as) -----------------------------------------

/** The value a field takes for a room, or undefined (master). who = {typeId, room}. */
function pick(rec, who, scope) {
  const key = scope === 'type' ? (who.typeId === null || who.typeId === undefined ? null : String(who.typeId)) : who.room;
  if (key === null || key === undefined || rec.by !== scope) return undefined;
  const values = rec.values || rec.versions || {};
  if (key in values) return values[key];
  const low = String(key).toLowerCase();
  const hit = Object.keys(values).find((k) => k.toLowerCase() === low);
  return hit === undefined ? undefined : values[hit];
}

function applyField(page, field, value) {
  const def = fieldDef(field);
  if (!def) return;
  const m = CARD.exec(field);
  if (m) {
    const card = (page.items || []).find((it) => it.id === m[1]);
    if (card) card.qr = { label: value.label ?? card.qr?.label ?? '', url: normaliseLink(value.url) };
    return;
  }
  if (def.kind === 'qr') page.qr = { label: value.label ?? page.qr?.label ?? '', url: normaliseLink(value.url) };
  else page[field] = value;
}

/**
 * The draft as one TV would see it: type versions and values first, then
 * room ones, so a room's own value always wins over its type's.
 * who = {typeId, room}; null or {} gives the master. The result has no `overrides`.
 */
const qrOf = (it) => (it && it.qr && (it.qr.url || it.qr.label) ? { label: it.qr.label || '', url: it.qr.url || '' } : null);

/** Card ids whose QR a room's own version sets differently from the master (there the room's version wins). */
export function roomSetCards(masterPage, versionItems) {
  const byId = new Map((masterPage?.items || []).map((it) => [it.id, it]));
  const out = new Set();
  for (const it of versionItems || []) if (it && it.id && byId.has(it.id) && canonical(qrOf(it)) !== canonical(qrOf(byId.get(it.id)))) out.add(it.id);
  return out;
}

export function effectiveDoc(doc, who) {
  const out = clone(doc);
  const ov = all(doc);
  delete out.overrides;
  if (!who || (who.typeId == null && !who.room)) return out;
  const index = new Map();
  const walk = (page, parent) => { index.set(page.id, { page, parent }); for (const c of page.children || []) walk(c, page); };
  walk(out.home, null);
  const masterIndex = new Map();
  const walkM = (page) => { masterIndex.set(page.id, page); for (const c of page.children || []) walkM(c); };
  if (doc?.home) walkM(doc.home);
  for (const scope of ['type', 'room']) {
    for (const [pageId, o] of Object.entries(ov)) {
      const hit = index.get(pageId);
      if (!hit) continue;
      if (o.page && o.page.by === scope) {
        const patch = pick(o.page, who, scope);
        if (patch && Object.keys(patch).length) {
          const eff = effectivePage(hit.page, patch);
          for (const k of VERSION_KEYS) { if (k in eff) hit.page[k] = eff[k]; else delete hit.page[k]; }
          // A room's own version carries every card, but means only what it changed: the type's card QR codes
          // stay on their cards unless this version removed the card or set its QR itself (QA-9; as the server).
          if (scope === 'room' && Array.isArray(patch.items)) {
            const setHere = roomSetCards(masterIndex.get(pageId), patch.items);
            for (const [field, rec] of Object.entries(o.fields || {})) {
              const m = CARD.exec(field);
              if (!m || rec.by !== 'type' || setHere.has(m[1])) continue;
              const v = pick(rec, who, 'type');
              if (!isBlank(field, v)) applyField(hit.page, field, v);
            }
          }
        }
      }
      for (const [field, rec] of Object.entries(o.fields || {})) {
        if (rec.by !== scope) continue;
        const v = pick(rec, who, scope);
        if (!isBlank(field, v)) applyField(hit.page, field, v);
      }
    }
  }
  return out;
}

// ---- checks -----------------------------------------------------------------------

/**
 * Why one override value cannot go live, or null.
 * ctx: imageSize, imageKnown (as validateAll), page (the master draft page).
 */
export function valueProblem(field, value, ctx = {}) {
  const def = fieldDef(field);
  if (!def || isBlank(field, value)) return null;
  if (def.kind === 'text') {
    if (typeof value !== 'string') return 'not text';
    if (value.length > def.limit) return `${def.label} is over its limit (${value.length} of ${def.limit} characters)`;
    return null;
  }
  if (def.kind === 'photo') {
    if (typeof value !== 'string') return 'not a photo';
    if (ctx.imageKnown && !ctx.imageKnown(value)) return 'the photo is no longer in Media; choose another';
    const why = photoProblem(ctx.imageSize ? ctx.imageSize(value) : null, 'full');
    return why ? `the photo is too small for full screen (${why})` : null;
  }
  if (def.kind === 'qr') {
    const why = linkProblem(value.url, { https: true });
    if (why) return `"${String(value.url).slice(0, 60)}" is not a web address the TV can use: ${why}`;
    if (value.label && value.label.length > LIMITS.qrLabel) return `the QR line is over its limit (${value.label.length} of ${LIMITS.qrLabel} characters)`;
    return null;
  }
  return null;
}

/** "room 214", "Penthouse Suite". names = {typeName(id), roomLabel(number)}. */
export function keyLabel(by, key, names = {}) {
  if (by === 'type') return names.typeName ? names.typeName(key) : `room type ${key}`;
  return names.roomLabel ? names.roomLabel(key) : `room ${key}`;
}

// ---- publishing ------------------------------------------------------------------------

function bundleIndex(bundle) {
  const map = new Map();
  const walk = (page) => { map.set(page.id, page); for (const c of page.children || []) walk(c); };
  if (bundle?.home) walk(bundle.home);
  return map;
}

function draftIndex(doc) {
  const map = new Map();
  const walk = (page, depth) => { map.set(page.id, { page, depth }); for (const c of page.children || []) walk(c, depth + 1); };
  if (doc?.home) walk(doc.home, 0);
  return map;
}

/**
 * Bundle-shaped value of one element override. A QR with no line of its own is sent without
 * one: the server then keeps the line the card or page has in that room's result (a version
 * may have changed it), exactly as Preview as does.
 */
function bundleValue(field, value) {
  const def = fieldDef(field);
  if (def.kind !== 'qr') return value;
  return value.label !== undefined && value.label !== null ? { label: String(value.label), url: normaliseLink(value.url) } : { url: normaliseLink(value.url) };
}

/**
 * Resolves the draft's overrides against the bundle that is going live.
 *   doc        the draft (with overrides)
 *   bundle     what buildBundle made of it
 *   frozen     pages held back (their published copy is in the bundle)
 *   published  the live publish's overrides record {entries, draft} (or null)
 *   ctx        imageSize, imageKnown, filmInfo (as validateAll); names (labels); rooms ([{number, type_id}])
 * Returns {
 *   entries   what the server compiles: [{page, field, by, path, values, card?, cards?}]
 *             A card's QR names its card (`card`); a version that changes the cards lists
 *             their ids in order (`cards: {key: [ids]}`), so the server finds a card by id
 *             exactly as Preview as does, wherever a version has moved it (QA-1).
 *   cards     {page id: [card ids]} of the master as published
 *   unused    [{pageId, field, key, by, who, message}] card values that a version leaves nowhere to go
 *   live      the editing form of what goes live (blocked and held-back parts as they were)
 *   blocked   [{pageId, field, key, by, message}] values held back
 *   held      page ids whose overrides wait with the page
 * }
 * A blocked value keeps what TVs have now for that room if it was published
 * before; otherwise that room uses the master until it is fixed.
 */
export function resolveForPublish(doc, { bundle, frozen = new Set(), published = null, ctx = {} } = {}) {
  const entries = [];
  const blocked = [];
  const held = [];
  const unused = [];
  const cards = {};
  const live = clone(all(doc));
  const pubEntries = Array.isArray(published?.entries) ? published.entries : [];
  const pubDraft = published?.draft && typeof published.draft === 'object' ? published.draft : {};
  const B = bundleIndex(bundle);
  const D = draftIndex(doc);
  const prevValue = (pageId, field, by, key) => {
    const e = pubEntries.find((x) => x.page === pageId && x.field === field && x.by === by);
    return e && Object.prototype.hasOwnProperty.call(e.values || {}, key) ? e.values[key] : undefined;
  };
  const prevDraftValue = (pageId, field, by, key) => {
    const rec = field === 'page' ? pubDraft[pageId]?.page : pubDraft[pageId]?.fields?.[field];
    if (!rec || rec.by !== by) return undefined;
    return (field === 'page' ? rec.versions : rec.values)?.[key];
  };
  const pageIds = new Set([...Object.keys(all(doc)), ...pubEntries.map((e) => e.page)]);
  for (const pageId of pageIds) {
    const bPage = B.get(pageId);
    if (!bPage) { delete live[pageId]; continue; }               // not on TVs: nothing to lay over it
    if (frozen.has(pageId)) {
      // Held back with its page: what TVs have now for this page stays, unchanged.
      held.push(pageId);
      for (const e of pubEntries) if (e.page === pageId) entries.push(clone(e));
      if (published?.cards?.[pageId]) cards[pageId] = clone(published.cards[pageId]);
      if (pubDraft[pageId]) live[pageId] = clone(pubDraft[pageId]); else delete live[pageId];
      continue;
    }
    const o = all(doc)[pageId];
    const d = D.get(pageId);
    if (!o || !d) continue;
    const master = d.page;
    if ((master.items || []).length) cards[pageId] = master.items.map((it) => it.id);
    // Page versions (stage B).
    const pRec = getPage(doc, pageId);
    const versionCards = {};                         // key -> card ids of a version that changes the cards
    const versionSet = {};                           // key -> card ids whose QR a room's version sets itself
    if (pRec) {
      const cleanMaster = cleanPage({ ...master, hidden: false, children: [] }) || {};
      const values = {};
      for (const [key, patch] of Object.entries(pRec.versions || {})) {
        if (!patch || !Object.keys(patch).length) continue;
        const eff = effectivePage(master, patch);
        const r = validatePage({ ...eff, children: master.children || [] }, { ...ctx, isStrip: d.depth === 1 || d.depth === 2 });
        if (r.blockers.length) {
          blocked.push({ pageId, field: 'page', key, by: pRec.by, message: r.blockers.map((b) => b.message).join('; ') });
          const prev = prevValue(pageId, 'page', pRec.by, key);
          if (prev !== undefined) values[key] = prev;
          const pd = prevDraftValue(pageId, 'page', pRec.by, key);
          if (pd !== undefined) live[pageId].page.versions[key] = clone(pd); else delete live[pageId].page.versions[key];
          continue;
        }
        const cleanEff = cleanPage({ ...eff, hidden: false, children: [] }) || {};
        const diff = {};
        for (const k of VERSION_KEYS) {
          if (canonical(cleanEff[k] ?? null) !== canonical(cleanMaster[k] ?? null)) diff[k] = k in cleanEff ? cleanEff[k] : null;
        }
        if (Object.keys(diff).length) values[key] = diff;
        if ('items' in diff) {
          versionCards[key] = (eff.items || []).map((it) => it.id);
          if (pRec.by === 'room') versionSet[key] = roomSetCards(master, eff.items);
        }
      }
      if (Object.keys(values).length) {
        const e = { page: pageId, field: 'page', by: pRec.by, path: [], values };
        const vc = Object.fromEntries(Object.entries(versionCards).filter(([k]) => k in values));
        if (Object.keys(vc).length) e.cards = vc;
        entries.push(e);
      }
    }
    /** The card ids a TV of this kind sees on this page: the master's, or its version's. */
    const cardsFor = (who) => {
      if (!pRec) return cards[pageId] || [];
      const key = pRec.by === 'type' ? (who.typeId == null ? null : String(who.typeId)) : who.room;
      const vkey = key == null ? undefined : Object.keys(versionCards).find((k) => k.toLowerCase() === String(key).toLowerCase());
      return vkey !== undefined ? versionCards[vkey] : (cards[pageId] || []);
    };
    const roomsOf = (typeId) => (ctx.rooms || []).filter((r) => String(r.type_id) === String(typeId));
    const typeOfRoom = (n) => (ctx.rooms || []).find((r) => String(r.number).toLowerCase() === String(n).toLowerCase())?.type_id ?? null;
    // Elements.
    for (const [field, rec] of Object.entries(o.fields || {})) {
      if (!getField(doc, pageId, field)) continue;
      let path = [field];
      const m = CARD.exec(field);
      if (m) {
        const i = (master.items || []).findIndex((it) => it.id === m[1]);
        const inAVersion = Object.values(versionCards).some((ids) => ids.includes(m[1]));
        if (i < 0 && !inAVersion) { delete live[pageId].fields[field]; continue; }   // the card is gone everywhere
        path = ['items', Math.max(0, i), 'qr'];                                         // the server goes by the card's id
      }
      const values = {};
      for (const [key, value] of Object.entries(rec.values || {})) {
        if (isBlank(field, value)) continue;
        const why = valueProblem(field, value, ctx);
        if (why) {
          blocked.push({ pageId, field, key, by: rec.by, message: why });
          const prev = prevValue(pageId, field, rec.by, key);
          if (prev !== undefined) values[key] = prev;
          const pd = prevDraftValue(pageId, field, rec.by, key);
          if (pd !== undefined) live[pageId].fields[field].values[key] = clone(pd); else delete live[pageId].fields[field].values[key];
          continue;
        }
        values[key] = bundleValue(field, value);
        // A card value where that room's (or type's) version of the page has no such card: said, not silently lost.
        if (m) {
          const cases = rec.by === 'room' ? [{ typeId: typeOfRoom(key), room: key }]
            : pRec?.by === 'room' ? [{ typeId: key }, ...roomsOf(key).map((r) => ({ typeId: key, room: r.number }))] : [{ typeId: key }];
          for (const who of cases) {
            const name = who.room ? keyLabel('room', who.room, ctx.names) : keyLabel('type', key, ctx.names);
            if (!cardsFor(who).includes(m[1])) {
              unused.push({ pageId, field, key, by: rec.by, who: name, message: `${name} has a version of this page without this card, so this value is not shown there` });
              continue;
            }
            // A type's value meets a room's own version that sets this card's QR itself: the room's wins (QA-9).
            const vk = rec.by === 'type' && pRec?.by === 'room' && who.room ? Object.keys(versionSet).find((k) => k.toLowerCase() === String(who.room).toLowerCase()) : undefined;
            if (vk !== undefined && versionSet[vk].has(m[1])) {
              unused.push({ pageId, field, key, by: rec.by, who: name, message: `${name}'s own version of this page sets this card's QR code itself, so the room type's value is not shown there` });
            }
          }
        }
      }
      if (Object.keys(values).length) entries.push({ page: pageId, field, by: rec.by, path, values, ...(m ? { card: m[1] } : {}) });
    }
  }
  return { entries, live, blocked, held, cards, unused };
}

/**
 * The editing form of the live overrides, for a draft rebuilt from the
 * published bundle (Reset): card ids are matched through the published
 * entries' positions, since the bundle itself carries no card ids.
 */
export function publishedForDraft(published, doc) {
  const draftForm = clone(published?.draft || {});
  const entries = Array.isArray(published?.entries) ? published.entries : [];
  const D = draftIndex(doc);
  for (const [pageId, o] of Object.entries(draftForm)) {
    for (const field of Object.keys(o?.fields || {})) {
      const m = CARD.exec(field);
      if (!m) continue;
      const e = entries.find((x) => x.page === pageId && x.field === field);
      const page = D.get(pageId)?.page;
      const card = e && page ? (page.items || [])[e.path[1]] : null;
      const rec = o.fields[field];
      delete o.fields[field];
      if (card?.id) o.fields[cardField(card.id)] = rec;
    }
  }
  return draftForm;
}

// ---- what changed ------------------------------------------------------------------------

const roomsWord = (by, n) => (by === 'type' ? (n === 1 ? 'room type' : 'room types') : (n === 1 ? 'room' : 'rooms'));
const listKeys = (by, keys, names) => {
  const labels = keys.map((k) => keyLabel(by, k, names));
  return labels.length <= 3 ? labels.join(', ') : `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more`;
};

/**
 * Plain-English lines per page for what changed in the overrides since the
 * last publish: [{pageId, lines}].
 */
export function describeOverrideChanges(before, after, doc, names = {}) {
  const out = [];
  const pageOf = (id) => draftIndex(doc).get(id)?.page || null;
  const ids = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const VERSION_LABELS = { title: 'title', kicker: 'small caps line', subtitle: 'subtitle', image: 'photo', body: 'text', facts: 'facts', hoursTitle: 'hours heading', hours: 'hours', qr: 'QR code',
    sections: 'menu', images: 'photos', items: 'cards', description: 'description', photos: 'photo frames', films: 'films', backgroundFilm: 'background film', slides: 'slides', gallery: 'gallery settings' };
  for (const pageId of ids) {
    const lines = [];
    const a = (before || {})[pageId] || {}, b = (after || {})[pageId] || {};
    const page = pageOf(pageId);
    const one = (field, ra, rb) => {
      const label = fieldLabel(page, field);
      const map = field === 'page' ? 'versions' : 'values';
      if (!ra && !rb) return;
      if (!ra && rb) { lines.push(`${label}: now ${SCOPE_SHORT[rb.by]}${filledCount(rb) ? ` (${filledCount(rb)} ${roomsWord(rb.by, filledCount(rb))} set)` : ''}`); return; }
      if (ra && !rb) { lines.push(`${label}: the same on every TV again`); return; }
      if (ra.by !== rb.by) { lines.push(`${label}: now ${SCOPE_SHORT[rb.by]} instead of ${SCOPE_SHORT[ra.by]}`); return; }
      const va = ra[map] || {}, vb = rb[map] || {};
      const keys = [...new Set([...Object.keys(va), ...Object.keys(vb)])].filter((k) => canonical(va[k] ?? null) !== canonical(vb[k] ?? null));
      if (!keys.length) return;
      if (field === 'page') {
        for (const k of keys) {
          const name = keyLabel(rb.by, k, names);
          if (!vb[k]) lines.push(`${name} version: back to the master`);
          else {
            const changed = [...new Set([...Object.keys(va[k] || {}), ...Object.keys(vb[k] || {})])].filter((f) => canonical((va[k] || {})[f] ?? null) !== canonical((vb[k] || {})[f] ?? null));
            lines.push(`${name} version: ${changed.map((f) => VERSION_LABELS[f] || f).join(', ')} changed`);
          }
        }
        return;
      }
      lines.push(`${label}: ${keys.length} ${roomsWord(rb.by, keys.length)} changed (${listKeys(rb.by, keys, names)})`);
    };
    one('page', a.page, b.page);
    for (const field of new Set([...Object.keys(a.fields || {}), ...Object.keys(b.fields || {})])) one(field, (a.fields || {})[field], (b.fields || {})[field]);
    if (lines.length) out.push({ pageId, lines });
  }
  return out;
}

// ---- merging two people's overrides ---------------------------------------------------------

/**
 * Three-way merge of the overrides (base -> theirs, base -> mine), entry by
 * entry: different rooms, fields and pages are all kept. Where both changed
 * the same room's value (or the same field of one version), theirs is kept
 * and the message says so in plain words, as for the rest of the draft.
 * labelOf(pageId) names the page; names labels rooms and types.
 */
export function mergeOverrides(base, theirs, mine, { who = 'the newer publish', labelOf = (id) => id, names = {}, pageOf = () => null } = {}) {
  const conflicts = [];
  let applied = 0;
  const same = (x, y) => canonical(x ?? null) === canonical(y ?? null);
  const whose = `${who}'s`;
  const out = clone(theirs || {});
  const show = (v) => (v === undefined || v === null ? 'nothing' : typeof v === 'string' ? `"${v.length > 50 ? v.slice(0, 47) + '…' : v}"` : v.url ? `"${v.url.length > 50 ? v.url.slice(0, 47) + '…' : v.url}"` : 'their version');
  const ids = new Set([...Object.keys(base || {}), ...Object.keys(theirs || {}), ...Object.keys(mine || {})]);
  for (const pageId of ids) {
    const b = (base || {})[pageId] || {}, t = (theirs || {})[pageId] || {}, m = (mine || {})[pageId] || {};
    const where = (field) => `${labelOf(pageId)} › ${fieldLabel(pageOf(pageId), field)}`;
    const merged = clone(t);
    const one = (field, rb, rt, rm, mapKey) => {
      if (same(rm, rb)) return rt;                                  // I did not touch it
      if (same(rt, rb) || same(rt, rm)) { applied++; return clone(rm); }
      if (!rt || !rm || rt.by !== rm.by) {
        const say = (r) => (r ? SCOPE_SHORT[r.by] : 'the same on every TV');
        conflicts.push(`${where(field)}: kept ${whose} choice (${say(rt)}) instead of yours (${say(rm)})`);
        return rt;
      }
      // Same scope on both sides: merge room by room.
      const res = { ...clone(rt), [mapKey]: {} };
      const vb = (rb && rb.by === rt.by ? rb[mapKey] : {}) || {}, vt = rt[mapKey] || {}, vm = rm[mapKey] || {};
      for (const k of new Set([...Object.keys(vb), ...Object.keys(vt), ...Object.keys(vm)])) {
        const x = vb[k], y = vt[k], z = vm[k];
        let v;
        if (same(z, x)) v = y;
        else if (same(y, x) || same(y, z)) { v = z; applied++; }
        else if (mapKey === 'versions' && (y || z) && typeof (y || {}) === 'object' && typeof (z || {}) === 'object') {
          // Two people edited one version: field by field, theirs where both changed the same field.
          v = clone(y || {});
          for (const f of new Set([...Object.keys(x || {}), ...Object.keys(y || {}), ...Object.keys(z || {})])) {
            const fx = (x || {})[f], fy = (y || {})[f], fz = (z || {})[f];
            if (same(fz, fx)) continue;
            if (same(fy, fx) || same(fy, fz)) { if (fz === undefined) delete v[f]; else v[f] = clone(fz); applied++; }
            else conflicts.push(`${where(field)} › ${keyLabel(rt.by, k, names)} version: kept ${whose} ${f} instead of yours`);
          }
          if (!Object.keys(v).length) v = undefined;
        } else {
          conflicts.push(`${where(field)} › ${keyLabel(rt.by, k, names)}: kept ${whose} ${show(y)} instead of yours (${show(z)})`);
          v = y;
        }
        if (v !== undefined) res[mapKey][k] = clone(v);
      }
      return res;
    };
    const page = one('page', b.page, t.page, m.page, 'versions');
    if (page) merged.page = page; else delete merged.page;
    const fields = {};
    for (const field of new Set([...Object.keys(b.fields || {}), ...Object.keys(t.fields || {}), ...Object.keys(m.fields || {})])) {
      const r = one(field, (b.fields || {})[field], (t.fields || {})[field], (m.fields || {})[field], 'values');
      if (r) fields[field] = r;
    }
    if (Object.keys(fields).length) merged.fields = fields; else delete merged.fields;
    if (merged.page || merged.fields) out[pageId] = merged; else delete out[pageId];
  }
  return { overrides: out, conflicts, applied };
}
