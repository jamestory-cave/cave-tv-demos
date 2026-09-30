// Photos: upload once, resized in the browser to 1920 and 800 wide, named by
// the content hash of the original file. The registry joins what is
// published (media/index.json) with what is waiting in this browser.

import { sha256Hex } from './util.js';

export const SIZES = [1920, 800];
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MIN_UPLOAD_WIDTH = 800;

/** media/<hash12>-<w>.jpg -> {hash, width} or null */
export function parseMediaPath(src) {
  const m = /^media\/([0-9a-f]{12})-(\d+)\.jpg$/.exec(src || '');
  return m ? { hash: m[1], width: Number(m[2]) } : null;
}

export const mediaPath = (hash, w = 1920) => `media/${hash}-${w}.jpg`;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file is not a photo the browser can read. Use a JPG or PNG.')); };
    img.src = url;
  });
}

function toJPEG(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the resized photo'))), 'image/jpeg', quality));
}

/**
 * Reads a photo file and makes the TV sizes.
 * Returns {hash, name, width, height, bytes, blobs: {1920: Blob, 800: Blob}}
 */
export async function prepareUpload(file, { name } = {}) {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('This photo is over 25 MB. Export a smaller JPG.');
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Use a JPG or PNG photo.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = (await sha256Hex(bytes)).slice(0, 12);
  const img = await loadImage(file);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (width < MIN_UPLOAD_WIDTH) throw new Error(`This photo is only ${width} px wide. The TV needs at least 1920 px for full screen, 800 px for a card.`);
  const blobs = {};
  for (const w of SIZES) {
    const scale = Math.min(1, w / width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    blobs[w] = await toJPEG(canvas, w === 1920 ? 0.86 : 0.84);
  }
  const clean = (name || file.name || 'Photo').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 40);
  return { hash, name: clean || 'Photo', width, height, bytes: file.size, blobs, addedAt: new Date().toISOString(), published: false };
}

/**
 * The media registry: everything the Builder knows about photos.
 * `entries()` -> [{hash, name, width, height, source: 'published'|'pending', assetName?, path}]
 */
export class MediaRegistry {
  constructor({ browserStore, githubStore }) {
    this.browser = browserStore;
    this.github = githubStore;
    this.index = { assets: {}, media: {} };
    this.pending = new Map();      // hash -> record with blobs
    this.objectURLs = new Map();   // `${hash}-${w}` -> object URL
    this.warmed = new Map();       // url -> Image, so a photo is fetched once and kept decoded
  }

  /** Starts fetching a photo now, as the TV's PhotoCache does before it is needed. */
  warm(url) {
    if (!url || this.warmed.has(url)) return;
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    this.warmed.set(url, img);
  }

  async load(mediaIndex) {
    this.index = mediaIndex || { assets: {}, media: {} };
    this.index.assets = this.index.assets || {};
    this.index.media = this.index.media || {};
    const local = await this.browser.listMedia();
    this.pending.clear();
    for (const rec of local) {
      if (this.index.media[rec.hash]) {
        // Already published (perhaps from another session): drop the local copy.
        await this.browser.deleteMedia(rec.hash);
        continue;
      }
      this.pending.set(rec.hash, rec);
    }
  }

  async add(record) {
    this.pending.set(record.hash, record);
    await this.browser.putMedia(record);
  }

  async remove(hash) {
    this.pending.delete(hash);
    await this.browser.deleteMedia(hash);
    for (const w of SIZES) {
      const key = `${hash}-${w}`;
      if (this.objectURLs.has(key)) { URL.revokeObjectURL(this.objectURLs.get(key)); this.objectURLs.delete(key); }
    }
  }

  async markPublished(hashes, mediaIndex) {
    if (mediaIndex) this.index = mediaIndex;
    for (const h of hashes) {
      const rec = this.pending.get(h);
      if (!rec) continue;
      this.index.media[h] = this.index.media[h] || { name: rec.name, width: rec.width, height: rec.height, sizes: SIZES.slice() };
      // The local copy stays until the next load: Pages takes a minute to
      // serve the new files, and the preview keeps working meanwhile.
      rec.published = true;
    }
    await this.browser.markPublished(hashes);
  }

  pendingRecords() { return [...this.pending.values()].filter((r) => !r.published); }

  /** Bundled asset name -> media path, from the seed's mapping. */
  assetPath(name) { return this.index.assets[name] || null; }

  entries() {
    const out = [];
    const assetByPath = new Map(Object.entries(this.index.assets).map(([n, p]) => [p, n]));
    for (const [hash, meta] of Object.entries(this.index.media)) {
      const path = mediaPath(hash);
      out.push({ hash, path, source: 'published', assetName: assetByPath.get(path) || null, ...meta });
    }
    for (const rec of this.pending.values()) {
      if (this.index.media[rec.hash]) continue;
      out.push({ hash: rec.hash, path: mediaPath(rec.hash), source: 'pending', name: rec.name, width: rec.width, height: rec.height, bytes: rec.bytes, addedAt: rec.addedAt });
    }
    return out;
  }

  meta(src) {
    if (!src) return null;
    const p = parseMediaPath(src);
    if (p) return this.pending.get(p.hash) || this.index.media[p.hash] || null;
    const path = this.assetPath(src);
    if (path) return this.index.media[parseMediaPath(path).hash] || null;
    return null;
  }

  /** {width, height} of a photo if the Builder knows it, else null. */
  size(src) {
    const m = this.meta(src);
    return m && m.width ? { width: m.width, height: m.height } : null;
  }

  /** Display name for a page's image value. */
  label(src) {
    if (!src) return 'No photo';
    const m = this.meta(src);
    if (m) return m.name;
    if (/^https?:/.test(src)) return src;
    return src;
  }

  /**
   * URL for the preview. Bundled asset names resolve through the seed's
   * mapping; media paths resolve locally first, then to the CDN.
   */
  url(src, w = 1920) {
    if (!src) return null;
    if (/^https?:\/\//.test(src)) return src;
    let p = parseMediaPath(src);
    if (!p) {
      const path = this.assetPath(src);
      if (!path) return null;
      p = parseMediaPath(path);
    }
    const rec = this.pending.get(p.hash);
    let url;
    if (rec?.blobs?.[w]) {
      const key = `${p.hash}-${w}`;
      if (!this.objectURLs.has(key)) this.objectURLs.set(key, URL.createObjectURL(rec.blobs[w]));
      url = this.objectURLs.get(key);
    } else url = this.github.mediaURL(mediaPath(p.hash, w));
    this.warm(url);
    return url;
  }
}
