// ServerStore: the Builder talking to the hotel's own server (builder/server/).
// Used only when the page was served by the Cave server, which marks every
// page with <meta name="cave-mode" content="server"> (see config.js). On
// GitHub Pages it is never constructed, so the prototype is unchanged.
//
// One object stands in for both prototype stores, with the same method names,
// so the screens do not care which they have:
//   as GitHubStore   loadPublished, fetchBundle, mediaURL, hasToken, publish, (+ restore)
//   as BrowserStore  loadDraft, saveDraft, prefs, setPref, putMedia, getMedia,
//                    listMedia, deleteMedia, markPublished, clearAll
//
// Differences from the prototype, all on purpose:
//   - One shared draft for the whole team, kept on the server. Every save names
//     the draft revision it started from; if a colleague saved first the server
//     refuses (409) and main.js merges the two with merge.js.
//   - Photos and films go to the server the moment they are added (nothing is
//     kept in this browser), so a colleague sees them at once.
//   - Publish sends the bundle the Builder generated (bundle.js, the one
//     generator); the server checks it, writes the files and version.json last.
//   - Signing in replaces the GitHub passcode; the server, not the browser,
//     knows who is publishing. Restore is for admins.

import { config } from '../../config.js';
import { BrowserStore } from './browser.js';
import { PublishConflict } from './github.js';

export class DraftConflict extends Error {
  constructor(current) { super('Someone else saved the draft first.'); this.current = current; }
}

export class AuthRequired extends Error {}

/** The server could not be reached at all (no reply). */
export class ServerUnreachable extends Error {}

const copy = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

export class ServerStore {
  constructor({ fetchImpl } = {}) {
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.local = new BrowserStore();   // small preferences only (dismissed banner); never the draft or media
    this.user = null;
    this.draftRev = 0;                  // the server draft revision this browser last saw
    this.draftBase = null;              // the document at that revision (the merge base)
    this.records = new Map();           // hash -> upload record this browser knows about
    this.onAuthNeeded = null;           // async () => boolean, set by main.js: sign in again without losing work
    this.onSignedIn = null;             // () => void, set by main.js: send anything that waited for the sign-in
  }

  // ---- low level ----

  async api(method, path, body, { raw = false, retry = true } = {}) {
    const headers = { 'X-Cave-Request': '1', Accept: 'application/json' };
    let payload;
    if (body instanceof Blob) { payload = body; headers['Content-Type'] = body.type || 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    let res;
    try {
      res = await this.fetch(new URL('/api/' + path, location.origin), { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
    } catch (e) {
      // fetch says "Failed to fetch" (or similar) when there is no reply at all.
      throw Object.assign(new ServerUnreachable('The hotel server could not be reached. Check the connection (or the VPN) and try again.'), { cause: e });
    }
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (res.status === 401 && retry && path !== 'signin' && this.onAuthNeeded) {
      if (await this.onAuthNeeded()) return this.api(method, path, body, { raw, retry: false });
    }
    if (!res.ok) {
      const err = new Error(data?.error || `The server replied with an error (${res.status}).`);
      err.status = res.status;
      err.data = data;
      if (res.status === 401) throw Object.assign(new AuthRequired(err.message), { status: 401 });
      throw err;
    }
    return data;
  }

  // ---- signing in ----

  async me() {
    try { const r = await this.api('GET', 'me', undefined, { retry: false }); this.user = r.user; return r.user; }
    catch (e) { if (e.status === 401) return null; throw e; }
  }

  async signIn(name, password) {
    const r = await this.api('POST', 'signin', { name, password }, { retry: false });
    this.user = r.user;
    // Whichever way someone came to sign in again, anything waiting is sent now.
    if (this.onSignedIn) this.onSignedIn();
    return r.user;
  }

  async signOut() { await this.api('POST', 'signout', {}, { retry: false }); this.user = null; }

  async changePassword(current, password) { return this.api('POST', 'password', { current, password }); }

  get isAdmin() { return this.user?.role === 'admin'; }

  // ---- what is published (plain files under /tv/s1/, as the TVs read them) ----

  async fetchJSON(rel, { fresh = false } = {}) {
    // The Builder's header: the server answers version.json with the master, whichever room this computer is in.
    const res = await this.fetch(new URL(rel, config.baseURL), { cache: fresh ? 'no-store' : 'default', credentials: 'same-origin', headers: { 'X-Cave-Request': '1' } });
    if (!res.ok) throw new Error(res.status === 404 && rel === config.versionFile ? 'Nothing has been published on this server yet. An admin can bring in the current content with "cave_server.py import-site".' : `${rel}: HTTP ${res.status}`);
    return res.json();
  }

  async loadPublished() {
    const version = await this.fetchJSON(config.versionFile, { fresh: true });
    const bundle = await this.fetchJSON(version.bundle);
    let history = [];
    let mediaIndex = { assets: {}, media: {}, films: {} };
    try { history = await this.fetchJSON(config.historyFile, { fresh: true }); } catch { /* first publish */ }
    try { mediaIndex = await this.fetchJSON(config.mediaIndexFile, { fresh: true }); } catch { /* no index yet */ }
    // What differs by room in the live publish (overrides.js), for the change list and Reset.
    let overrides = null;
    try { const r = await this.api('GET', 'overrides/published', undefined, { retry: false }); if (r.revision === version.revision) overrides = r.overrides || null; } catch { /* older server */ }
    return { version, bundle, history, mediaIndex, overrides };
  }

  async fetchBundle(path) { return this.fetchJSON(path); }

  mediaURL(path) { return new URL(path, config.baseURL).href; }

  /** In the prototype this says "a passcode is entered"; here it means "signed in". */
  get hasToken() { return !!this.user; }

  async state() { return this.api('GET', 'state'); }

  // ---- the shared draft ----

  /** At start-up: the shared draft becomes this browser's starting point. */
  async loadDraft() {
    const d = await this.fetchDraft();
    this.acceptRemote(d);
    return d.doc ? { doc: d.doc, basedOn: d.basedOn, savedAt: d.savedAt, by: d.by, rev: d.rev } : null;
  }

  /** The shared draft as it is on the server now, without adopting it. */
  async fetchDraft() { return this.api('GET', 'draft'); }

  /** Saves the draft. Throws DraftConflict (with the server's draft) if a colleague saved first. */
  async saveDraft(record) {
    const doc = copy(record.doc);
    try {
      const r = await this.api('PUT', 'draft', { rev: this.draftRev, doc, basedOn: record.basedOn || null });
      this.draftRev = r.rev;
      this.draftBase = doc;
      return r;
    } catch (e) {
      if (e.status === 409 && e.data?.draft) throw new DraftConflict(e.data.draft);
      throw e;
    }
  }

  /** After merging a colleague's draft: their revision is now the one to build on. */
  acceptRemote(draft) {
    this.draftRev = draft.rev;
    this.restored = draft.restored || null;     // the last saved copy restored over the draft, if any
    // A copy, never the object the editor goes on to change: the merge base
    // must stay what the server had, or a later clash would look like "no
    // change here" and drop this browser's edit (QA-1).
    this.draftBase = copy(draft.doc);
  }

  clearDraft() { /* the shared draft is reset by saving the published content over it (Publish → Reset) */ }

  // ---- small preferences stay in this browser ----

  prefs() { return this.local.prefs(); }
  setPref(key, value) { this.local.setPref(key, value); }

  // ---- photos and films: straight to the server ----

  async putMedia(record) {
    const known = this.records.get(record.hash);
    if (!known?.uploaded) {
      if (record.kind === 'film') {
        if (!record.blob) throw new Error(`The film ${record.name} has no file to upload.`);
        await this.api('PUT', `media/${record.hash}-${record.height}.mp4`, record.blob);
      } else {
        for (const [w, blob] of Object.entries(record.blobs || {})) await this.api('PUT', `media/${record.hash}-${w}.jpg`, blob);
        record.sizes = Object.keys(record.blobs || {}).map(Number);
      }
    }
    const meta = { kind: record.kind || 'photo' };
    for (const k of ['name', 'width', 'height', 'bytes', 'sizes', 'poster', 'addedAt', 'seconds', 'mbps', 'codec', 'audio', 'audioCodec', 'silent', 'warnings']) {
      if (record[k] !== undefined) meta[k] = record[k];
    }
    await this.api('PUT', `uploads/${record.hash}`, meta);
    record.uploaded = true;
    this.records.set(record.hash, record);
  }

  async getMedia(hash) { return this.records.get(hash); }

  async listMedia() {
    const r = await this.api('GET', 'uploads');
    const out = [];
    for (const u of r.uploads || []) {
      const rec = { ...u, uploaded: true, published: false };
      // A record this browser uploaded keeps its in-memory files for a fast preview.
      const mine = this.records.get(u.hash);
      if (mine?.blobs) rec.blobs = mine.blobs;
      if (mine?.blob) rec.blob = mine.blob;
      this.records.set(u.hash, rec);
      out.push(rec);
    }
    return out;
  }

  async deleteMedia(hash) {
    await this.api('DELETE', `uploads/${hash}`);
    this.records.delete(hash);
  }

  async markPublished() { /* the server records what each publish used */ }

  async clearAll() { localStorage.removeItem('cave-builder.prefs'); }

  // ---- publishing ----

  /**
   * Same arguments and result as GitHubStore.publish. Photos and films are
   * already on the server, so only the bundle and the words travel.
   */
  async publish(p) {
    const say = p.progress || (() => {});
    say('Publishing…');
    try {
      return await this.api('POST', 'publish', { bundle: p.bundle, basedOnRevision: p.basedOnRevision ?? null, summary: p.summary || [], note: p.note || '', ...(p.overrides ? { overrides: p.overrides } : {}) });
    } catch (e) {
      if (e.status === 409) throw new PublishConflict(e.message);
      if (e instanceof ServerUnreachable) {
        // The reply may have been lost after the server had published. If the
        // next revision is this person's, it went through: say so, not "failed".
        const done = await this.publishedAnyway(p.basedOnRevision);
        if (done && done !== 'unknown') return done;
        if (done === 'unknown') throw new ServerUnreachable('The hotel server stopped answering, so it is not certain whether this was published. Your draft is safe. When the server is back the Builder shows what TVs have: if your changes are still listed under Publish, publish again.');
        throw new ServerUnreachable('The hotel server could not be reached, so nothing was published. Your draft is safe on the server; try again when the connection is back.');
      }
      throw e;
    }
  }

  /** After a lost reply: the publish result if revision basedOn + 1 is this person's, null if not, 'unknown' if the server cannot be asked. */
  async publishedAnyway(basedOn) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const now = await this.loadPublished();
        const entry = (now.history || [])[0];
        if (basedOn !== undefined && basedOn !== null && now.version.revision === basedOn + 1 && entry?.revision === now.version.revision && entry.by === this.user?.name) {
          return { revision: now.version.revision, bundlePath: now.version.bundle, version: now.version, historyEntry: entry, mediaIndex: now.mediaIndex, overrides: now.overrides, recovered: true };
        }
        return null;
      } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    return 'unknown';
  }

  /** Republishes an earlier publish as a new revision (admins only). */
  async restore({ revision, bundle, basedOnRevision, note, summary, progress }) {
    (progress || (() => {}))('Restoring…');
    try {
      // `bundle` is the file the history row on screen names; the server checks it still matches.
      return await this.api('POST', 'restore', { revision, bundle, basedOnRevision: basedOnRevision ?? null, note, summary });
    } catch (e) {
      if (e.status === 409) throw new PublishConflict(e.message);
      throw e;
    }
  }

  // ---- TVs and rooms ----

  async tvs() { return this.api('GET', 'tvs'); }
  async updateTV(id, fields) { return this.api('PUT', `tvs/${id}`, fields); }
  async addTV(fields) { return this.api('POST', 'tvs', fields); }
  async removeTV(id) { return this.api('DELETE', `tvs/${id}`); }
  /** Rooms, room types, room details, TVs by room, TVs not in a room yet, unknown addresses. */
  async rooms() { return this.api('GET', 'rooms'); }
  async addRoom(fields) { return this.api('POST', 'rooms', fields); }
  async updateRoom(id, fields) { return this.api('PUT', `rooms/${id}`, fields); }
  async removeRoom(id) { return this.api('DELETE', `rooms/${id}`); }
  async addRoomType(name) { return this.api('POST', 'room-types', { name }); }
  async updateRoomType(id, fields) { return this.api('PUT', `room-types/${id}`, fields); }
  async removeRoomType(id) { return this.api('DELETE', `room-types/${id}`); }
  async orderRoomTypes(ids) { return this.api('PUT', 'room-types/order', { ids }); }
  async addRoomDetail(label, kind) { return this.api('POST', 'room-details', { label, kind }); }
  async updateRoomDetail(id, fields) { return this.api('PUT', `room-details/${id}`, fields); }
  async removeRoomDetail(id) { return this.api('DELETE', `room-details/${id}`); }
  async orderRoomDetails(ids) { return this.api('PUT', 'room-details/order', { ids }); }
  /** A .csv or .xlsx list of rooms and addresses. check: work out what would happen, change nothing. */
  async importRoomList(file, { overwrite = false, check = false } = {}) {
    const q = new URLSearchParams({ name: file.name || 'list', ...(overwrite ? { overwrite: '1' } : {}), ...(check ? { dry: '1' } : {}) });
    const blob = file.type ? file : new Blob([file], { type: 'application/octet-stream' });
    return this.api('POST', `rooms/import?${q}`, blob);
  }
  async audit(limit = 60) { return this.api('GET', `audit?limit=${limit}`); }

  // ---- saved copies (admins) ----

  async copies() { return this.api('GET', 'copies'); }
  async saveCopy(name, note) { return this.api('POST', 'copies', { name, note }); }
  /** What restoring would change, in plain words; changes nothing. */
  async copyPlan(id) { return this.api('GET', `copies/${encodeURIComponent(id)}/plan`); }
  async restoreCopy(id) { return this.api('POST', `copies/${encodeURIComponent(id)}/restore`, {}); }
  async deleteCopy(id) { return this.api('DELETE', `copies/${encodeURIComponent(id)}`); }
  copyDownloadURL(id) { return new URL(`/api/copies/${encodeURIComponent(id)}/download`, location.origin).href; }
  /** A downloaded copy (.zip). It is only added to the list; restoring is separate. */
  async importCopy(file) {
    const blob = file.type ? file : new Blob([file], { type: 'application/zip' });
    return this.api('POST', `copies/import?${new URLSearchParams({ name: file.name || 'copy.zip' })}`, blob);
  }
}
