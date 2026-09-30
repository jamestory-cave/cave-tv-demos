// BrowserStore: the draft and any photos uploaded but not yet published,
// kept in this browser only (localStorage for the small JSON, IndexedDB for
// the photo files). This is Try mode's whole back end.

const DRAFT_KEY = 'cave-builder.draft';
const PREFS_KEY = 'cave-builder.prefs';
const DB_NAME = 'cave-builder';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'hash' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('media', mode);
    const store = t.objectStore('media');
    const result = fn(store);
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export class BrowserStore {
  constructor() { this.dbPromise = null; }

  db() { return this.dbPromise || (this.dbPromise = openDB()); }

  // ---- draft ----
  loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  saveDraft(record) {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(record));
  }

  clearDraft() { localStorage.removeItem(DRAFT_KEY); }

  // ---- small preferences (publisher name, dismissed banner...) ----
  prefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
  }

  setPref(key, value) {
    const p = this.prefs();
    if (value === undefined || value === null) delete p[key]; else p[key] = value;
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  }

  // ---- media ----
  // Photo records: {kind: 'photo', hash, name, width, height, bytes, blobs: {1920: Blob, 800: Blob}, poster?, addedAt, published}
  // Film records:  {kind: 'film', hash, name, width, height, seconds, bytes, mbps, codec, audio, audioCodec, silent, poster, warnings, blob: File, addedAt, published}
  // Both live in the same IndexedDB store, keyed by hash; a 60 MB film is one record.
  async putMedia(record) {
    const db = await this.db();
    await tx(db, 'readwrite', (s) => s.put(record));
  }

  async getMedia(hash) {
    const db = await this.db();
    return tx(db, 'readonly', (s) => s.get(hash));
  }

  async listMedia() {
    const db = await this.db();
    const all = await tx(db, 'readonly', (s) => s.getAll());
    return all || [];
  }

  async deleteMedia(hash) {
    const db = await this.db();
    await tx(db, 'readwrite', (s) => s.delete(hash));
  }

  async markPublished(hashes) {
    const db = await this.db();
    for (const h of hashes) {
      const rec = await tx(db, 'readonly', (s) => s.get(h));
      if (rec) { rec.published = true; await tx(db, 'readwrite', (s) => s.put(rec)); }
    }
  }

  async clearAll() {
    this.clearDraft();
    const db = await this.db();
    await tx(db, 'readwrite', (s) => s.clear());
  }
}
