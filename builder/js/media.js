// Photos and films. Photos: upload once, resized in the browser to 1920 and
// 800 wide, named by the content hash of the original file. Films: uploaded
// as they are (MP4, H.264, checked in the browser, never transcoded), named
// media/<hash12>-<height>.mp4, with a poster JPG captured or uploaded. The
// registry joins what is published (media/index.json) with what is waiting
// in this browser.

import { sha256Hex } from './util.js';
import { probeMP4, codecName, isH264, isAAC } from './mp4.js';

export const SIZES = [1920, 800];
export const SLIDE_SIZE = 3840;   // finished-page slides keep a native copy when the upload is 4K
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MIN_UPLOAD_WIDTH = 800;

// Film rules (PROTOTYPE.md 2c, set by GitHub's limits).
export const FILM = {
  maxBytes: 60 * 1024 * 1024, maxSeconds: 180, backgroundWarnBytes: 15 * 1024 * 1024, width: 1920, height: 1080, smallWidth: 1280, smallHeight: 720,
  targetMbps: 6, warnMbps: 9, bestMinSeconds: 30, bestMaxSeconds: 90, publishWarnBytes: 400 * 1024 * 1024,
};

/** media/<hash12>-<w>.jpg or media/<hash12>-<h>.mp4 -> {hash, width|height, kind} or null */
export function parseMediaPath(src) {
  const m = /^media\/([0-9a-f]{12})-(\d+)\.(jpg|mp4)$/.exec(src || '');
  if (!m) return null;
  return m[3] === 'mp4' ? { hash: m[1], height: Number(m[2]), kind: 'film' } : { hash: m[1], width: Number(m[2]), kind: 'photo' };
}

export const mediaPath = (hash, w = 1920) => `media/${hash}-${w}.jpg`;
export const filmPath = (hash, h = 1080) => `media/${hash}-${h}.mp4`;
export const isFilmPath = (src) => /\.mp4$/.test(src || '');

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

/** Builds the TV sizes from a decoded image (or a video frame). `sizes` may add 3840 for slides; never upscaled. */
async function makeSizes(source, width, height, quality, sizes = SIZES) {
  const blobs = {};
  for (const w of sizes) {
    if (w > 1920 && width < w) continue;
    const scale = Math.min(1, w / width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    blobs[w] = await toJPEG(canvas, w === 1920 ? quality : Math.min(quality, 0.84));
  }
  return blobs;
}

const cleanName = (name, fallback) => (name || fallback).replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 40) || fallback;

/**
 * Reads a photo file and makes the TV sizes.
 * Options: name; quality (0.86 default; artwork with lettering uses 0.92).
 * Returns {kind: 'photo', hash, name, width, height, bytes, blobs: {1920: Blob, 800: Blob}}
 */
export async function prepareUpload(file, { name, quality = 0.86, sizes = SIZES } = {}) {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('This photo is over 25 MB. Export a smaller JPG.');
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Use a JPG or PNG photo.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = (await sha256Hex(bytes)).slice(0, 12);
  const img = await loadImage(file);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (width < MIN_UPLOAD_WIDTH) throw new Error(`This photo is only ${width} px wide. The TV needs at least 1920 px for full screen, 800 px for a card.`);
  const blobs = await makeSizes(img, width, height, quality, sizes);
  return { kind: 'photo', hash, name: cleanName(name || file.name, 'Photo'), width, height, bytes: file.size, blobs, addedAt: new Date().toISOString(), published: false };
}

/** How far a photo's shape is from 16:9: 'ok', 'wide' (thin strip) or 'tall'. */
export function shapeOf(size) {
  if (!size || !size.width || !size.height) return 'ok';
  const r = size.width / size.height;
  const tv = 16 / 9;
  if (r > tv * 1.25) return 'wide';
  if (r < tv / 1.25) return 'tall';
  return 'ok';
}

/** Finished-page artwork: exactly 16:9 (1% tolerance), 1920 x 1080 or larger. Returns a problem or null. */
export function slideProblem(size) {
  if (!size) return null;
  const { width, height } = size;
  if (width < 1920 || height < 1080) return `${width} × ${height} is too small; it needs 1920 × 1080 or larger (3840 × 2160 is best)`;
  const ratio = width / height;
  if (Math.abs(ratio - 16 / 9) / (16 / 9) > 0.01) return `${width} × ${height} is not 16:9; the TV would have to crop or stretch it`;
  return null;
}

/**
 * Reads a photo for a Finished page: same as prepareUpload, with the artwork
 * rules, a higher JPG quality for lettering, and a native 3840-wide copy when
 * the upload is 4K (PROTOTYPE.md 2b: slides are media/<hash>-3840.jpg when
 * the upload is 4K, else -1920.jpg). Other photos are unchanged.
 */
export async function prepareSlide(file) {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('This artwork is over 25 MB. Export a smaller file.');
  const rec = await prepareUpload(file, { quality: 0.92, sizes: [SLIDE_SIZE, ...SIZES] });
  const why = slideProblem({ width: rec.width, height: rec.height });
  if (why) throw new Error(why + '. Ask for a new export.');
  rec.warnings = [];
  if (rec.width < 3840) rec.warnings.push(`${rec.width} × ${rec.height} accepted; 3840 × 2160 is sharper on a 4K TV`);
  rec.slidePath = slidePathFor(rec.hash, Object.keys(rec.blobs).map(Number));
  return rec;
}

/** The path a slide should reference: the 3840 copy when one exists, else 1920. */
export function slidePathFor(hash, sizes) {
  return mediaPath(hash, (sizes || []).map(Number).includes(SLIDE_SIZE) ? SLIDE_SIZE : 1920);
}

// ---- films ----------------------------------------------------------------

const mb = (b) => (b / 1048576).toFixed(b >= 10485760 ? 0 : 1) + ' MB';
export const fmtBytes = mb;
export const fmtSeconds = (s) => { s = Math.round(s || 0); return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`; };
export const bitrateMbps = (bytes, seconds) => (seconds ? (bytes * 8 / seconds / 1e6) : 0);

function loadVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error('The browser could not read this film in time. It may not be H.264.'))), 20000);
    v.addEventListener('loadedmetadata', () => finish(() => resolve({ video: v, url })));
    v.addEventListener('error', () => finish(() => { URL.revokeObjectURL(url); reject(new Error('The browser cannot play this film. The TV needs an MP4 with H.264 video and AAC audio.')); }));
    v.src = url;
  });
}

/** Tries to play the first moment of a film, muted. Resolves true if a frame was decoded. */
function tryPlayback(video) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; clearTimeout(timer); video.pause(); resolve(ok); };
    const timer = setTimeout(() => done(video.readyState >= 2), 6000);
    video.addEventListener('error', () => done(false), { once: true });
    video.addEventListener('timeupdate', () => { if (video.currentTime > 0) done(true); });
    video.addEventListener('canplay', () => { if (video.readyState >= 3 && video.paused) done(true); }, { once: true });
    video.currentTime = 0;
    video.play().catch(() => done(video.readyState >= 2));
  });
}

/**
 * Reads a film file, checks it against the rules, and returns a record or
 * throws with a plain message. Returns
 *   {kind: 'film', hash, name, width, height, seconds, bytes, mbps, codec, audio: true|false|null, audioCodec,
 *    warnings: [string], blob: File, poster: null, addedAt}
 * `audio` is null when the container says nothing and the browser cannot tell.
 */
export async function prepareFilm(file, { name } = {}) {
  const ext = (file.name || '').toLowerCase().split('.').pop();
  const isMP4Type = /^video\/(mp4|x-m4v)$/.test(file.type) || ['mp4', 'm4v'].includes(ext);
  if (!isMP4Type) {
    const what = { mov: 'a QuickTime .mov', webm: 'a WebM', avi: 'an AVI', mkv: 'an MKV', wmv: 'a Windows Media', mpg: 'an MPEG', mpeg: 'an MPEG', mxf: 'an MXF', prores: 'a ProRes' }[ext] || `a .${ext}`;
    throw new Error(`This is ${what} file. The TV plays MP4 only: export it again as MP4 (H.264 video, AAC audio, 1920 × 1080).`);
  }
  if (file.size > FILM.maxBytes) {
    throw new Error(`This film is ${mb(file.size)}. Files published through GitHub must be 60 MB or less. Export it shorter, or at a lower bitrate (6 Mb/s gives about 45 MB a minute).`);
  }
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const hash = (await sha256Hex(bytes)).slice(0, 12);
  const probe = probeMP4(buffer);
  const warnings = [];
  if (probe.isQuickTime) throw new Error('This is a QuickTime movie inside an .mp4 name. Export it again as MP4 (H.264, AAC).');
  if (!probe.hasMoov) throw new Error('This file does not look like a finished MP4 (no index). If it was still being written, wait for the export to finish.');
  const v = probe.video;
  if (!v) throw new Error('This MP4 has no video track.');
  if (!isH264(v.codec)) {
    throw new Error(`The video is ${codecName(v.codec)}, which the TV cannot play. Export it again as H.264 (in Media Encoder: format H.264, preset "Match Source – High bitrate" or the Cave preset).`);
  }
  if (probe.audio && !isAAC(probe.audio.codec)) warnings.push(`Audio is ${codecName(probe.audio.codec)}, not AAC; the TV may play it silently. Export with AAC audio.`);
  if (probe.moovFirst === false) warnings.push('The film\'s index is at the end of the file, so the TV must download all of it before it can start. Tick "Fast start" (web optimised) when exporting.');

  const { video, url } = await loadVideo(file);
  const width = video.videoWidth || v.width, height = video.videoHeight || v.height;
  const seconds = Number.isFinite(video.duration) ? video.duration : probe.duration || 0;
  const fail = (m) => { URL.revokeObjectURL(url); throw new Error(m); };
  const full = width === FILM.width && height === FILM.height;
  const small = width === FILM.smallWidth && height === FILM.smallHeight;
  if (!full && !small) fail(`This film is ${width} × ${height}. The TV needs 1920 × 1080 (1280 × 720 is accepted with a warning).`);
  if (small) warnings.push('1280 × 720 accepted, but it will look soft on a 4K TV. 1920 × 1080 is the standard.');
  if (seconds > FILM.maxSeconds) fail(`This film runs ${fmtSeconds(seconds)}. The limit is 3 minutes; 30 to 90 seconds is the sweet spot.`);
  if (seconds < 1) fail('This film is under a second long.');
  const mbps = bitrateMbps(file.size, seconds);
  if (mbps > FILM.warnMbps) warnings.push(`${mbps.toFixed(1)} Mb/s is higher than needed; ${FILM.targetMbps} Mb/s looks the same on the TV and downloads faster.`);
  if (seconds > FILM.bestMaxSeconds) warnings.push(`${fmtSeconds(seconds)} is longer than the 30 to 90 seconds guests tend to watch.`);

  // Can the browser actually decode it? A profile the TV cannot play is rare
  // with H.264, but a broken export is not.
  const canType = video.canPlayType('video/mp4; codecs="avc1.640028"');
  const played = await tryPlayback(video);
  if (!played && canType) fail('The browser could not decode this film even though it says it is H.264. The export may be damaged; try exporting it again.');
  if (!canType) warnings.push('This browser cannot say whether it plays H.264; the file structure looks right.');

  // Audio: the container is the authority; the browser is a second opinion.
  let audio = probe.audio ? true : (probe.tracks.length ? false : null);
  if (audio === null) {
    if (typeof video.mozHasAudio === 'boolean') audio = video.mozHasAudio;
    else if (video.audioTracks) audio = video.audioTracks.length > 0;
    else if (typeof video.webkitAudioDecodedByteCount === 'number') audio = video.webkitAudioDecodedByteCount > 0;
  }
  video.removeAttribute('src');
  video.load();
  URL.revokeObjectURL(url);
  return {
    kind: 'film', hash, name: cleanName(name || file.name, 'Film'), width, height, seconds: Math.round(seconds * 10) / 10, bytes: file.size,
    mbps: Math.round(mbps * 10) / 10, codec: v.codec, audio, audioCodec: probe.audio?.codec || null, warnings, blob: file, poster: null,
    addedAt: new Date().toISOString(), published: false,
  };
}

/**
 * Captures one frame of a film as a poster photo record (1920 x 1080 JPG,
 * plus the 800 size), content-hashed like any photo. `video` must be seeked
 * to the wanted frame and have decoded it.
 */
export async function captureFrame(video, { name } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 1920; canvas.height = 1080;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#080808';
  ctx.fillRect(0, 0, 1920, 1080);
  const vw = video.videoWidth || 1920, vh = video.videoHeight || 1080;
  const s = Math.min(1920 / vw, 1080 / vh);
  const w = Math.round(vw * s), h = Math.round(vh * s);
  ctx.drawImage(video, Math.round((1920 - w) / 2), Math.round((1080 - h) / 2), w, h);
  const full = await toJPEG(canvas, 0.88);
  const bytes = new Uint8Array(await full.arrayBuffer());
  const hash = (await sha256Hex(bytes)).slice(0, 12);
  const small = document.createElement('canvas');
  small.width = 800; small.height = 450;
  small.getContext('2d').drawImage(canvas, 0, 0, 800, 450);
  const blobs = { 1920: full, 800: await toJPEG(small, 0.84) };
  return { kind: 'photo', hash, name: (name || 'Poster').slice(0, 40), width: 1920, height: 1080, bytes: full.size, blobs, poster: true, addedAt: new Date().toISOString(), published: false };
}

/**
 * The media registry: everything the Builder knows about photos and films.
 * `entries()` -> photos [{hash, path, name, width, height, source: 'published'|'pending', assetName?}]
 * `films()`   -> films  [{hash, path, name, width, height, seconds, bytes, mbps, audio, silent, poster, source}]
 */
export class MediaRegistry {
  constructor({ browserStore, githubStore }) {
    this.browser = browserStore;
    this.github = githubStore;
    this.index = { assets: {}, media: {}, films: {} };
    this.pending = new Map();      // hash -> record with blobs (photos) or blob (films)
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
    this.index = mediaIndex || { assets: {}, media: {}, films: {} };
    this.index.assets = this.index.assets || {};
    this.index.media = this.index.media || {};
    this.index.films = this.index.films || {};
    const local = await this.browser.listMedia();
    this.pending.clear();
    for (const rec of local) {
      if (this.index.media[rec.hash] || this.index.films[rec.hash]) {
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
    for (const key of [...this.objectURLs.keys()]) {
      if (key.startsWith(hash + '-')) { URL.revokeObjectURL(this.objectURLs.get(key)); this.objectURLs.delete(key); }
    }
  }

  async markPublished(hashes, mediaIndex) {
    if (mediaIndex) this.index = mediaIndex;
    this.index.films = this.index.films || {};
    for (const h of hashes) {
      const rec = this.pending.get(h);
      if (!rec) continue;
      if (rec.kind === 'film') this.index.films[h] = this.index.films[h] || filmMeta(rec);
      else this.index.media[h] = this.index.media[h] || { name: rec.name, width: rec.width, height: rec.height, sizes: Object.keys(rec.blobs || {}).map(Number), poster: rec.poster || undefined };
      // The local copy stays until the next load: Pages takes a minute to
      // serve the new files, and the preview keeps working meanwhile.
      rec.published = true;
    }
    await this.browser.markPublished(hashes);
  }

  pendingRecords() { return [...this.pending.values()].filter((r) => !r.published); }

  /** Bundled asset name -> media path, from the seed's mapping. */
  assetPath(name) { return this.index.assets[name] || null; }

  /** The path a finished-page slide should use for a photo: the 3840 copy when it exists, else 1920. */
  slidePath(src) {
    const p = parseMediaPath(src) || parseMediaPath(this.assetPath(src) || '');
    if (!p || p.kind !== 'photo') return src;
    const rec = this.pending.get(p.hash);
    const sizes = rec ? Object.keys(rec.blobs || {}).map(Number) : (this.index.media[p.hash]?.sizes || []);
    return slidePathFor(p.hash, sizes);
  }

  entries() {
    const out = [];
    const assetByPath = new Map(Object.entries(this.index.assets).map(([n, p]) => [p, n]));
    for (const [hash, meta] of Object.entries(this.index.media)) {
      const path = mediaPath(hash);
      out.push({ hash, path, source: 'published', assetName: assetByPath.get(path) || null, ...meta });
    }
    for (const rec of this.pending.values()) {
      if (rec.kind === 'film' || this.index.media[rec.hash]) continue;
      out.push({ hash: rec.hash, path: mediaPath(rec.hash), source: 'pending', name: rec.name, width: rec.width, height: rec.height, bytes: rec.bytes, addedAt: rec.addedAt, poster: rec.poster || false, sizes: Object.keys(rec.blobs || {}).map(Number) });
    }
    return out;
  }

  films() {
    const out = [];
    for (const [hash, meta] of Object.entries(this.index.films)) {
      out.push({ hash, path: filmPath(hash, meta.height || 1080), source: 'published', ...meta });
    }
    for (const rec of this.pending.values()) {
      if (rec.kind !== 'film' || this.index.films[rec.hash]) continue;
      out.push({ hash: rec.hash, path: filmPath(rec.hash, rec.height), source: 'pending', ...filmMeta(rec), warnings: rec.warnings || [] });
    }
    return out;
  }

  meta(src) {
    if (!src) return null;
    const p = parseMediaPath(src);
    if (p?.kind === 'film') return this.pending.get(p.hash) || this.index.films[p.hash] || null;
    if (p) return this.pending.get(p.hash) || this.index.media[p.hash] || null;
    const path = this.assetPath(src);
    if (path) return this.index.media[parseMediaPath(path).hash] || null;
    return null;
  }

  /** A film's record (pending or published) for a media/...mp4 path. */
  film(src) {
    const p = parseMediaPath(src);
    if (!p || p.kind !== 'film') return null;
    const rec = this.pending.get(p.hash);
    if (rec) return { hash: p.hash, path: src, source: 'pending', ...filmMeta(rec), warnings: rec.warnings || [] };
    const meta = this.index.films[p.hash];
    return meta ? { hash: p.hash, path: src, source: 'published', ...meta } : null;
  }

  /**
   * False for a media/ path the Builder has never heard of (deleted or from
   * elsewhere), or for a size the photo does not have (a -3840 copy exists
   * only for 4K slides; a film's height must match its record).
   */
  known(src) {
    if (!src) return true;
    const p = parseMediaPath(src);
    if (!p) return true; // bundled asset names and https URLs are the TV's business
    const rec = this.pending.get(p.hash);
    if (p.kind === 'film') {
      const meta = rec?.kind === 'film' ? rec : this.index.films[p.hash];
      return !!meta && (!meta.height || meta.height === p.height);
    }
    if (rec && rec.kind !== 'film') return !!rec.blobs?.[p.width];
    const meta = this.index.media[p.hash];
    if (!meta) return false;
    return (meta.sizes || SIZES).map(Number).includes(p.width);
  }

  /**
   * After a poster is re-captured: if `path` is a pending capture (poster:
   * true) that nothing references any more, drop it so it is never uploaded.
   * `uses` is model.imageUses(); films' own poster links count as uses.
   * Returns true when it was removed.
   */
  async dropUnusedCapture(path, uses) {
    const p = parseMediaPath(path || '');
    if (!p || p.kind !== 'photo') return false;
    const rec = this.pending.get(p.hash);
    if (!rec || rec.kind === 'film' || !rec.poster || rec.published) return false;
    for (const w of [3840, 1920, 800]) if ((uses.get(mediaPath(p.hash, w)) || []).length) return false;
    for (const other of this.pending.values()) if (other.kind === 'film' && other.poster && parseMediaPath(other.poster)?.hash === p.hash) return false;
    for (const meta of Object.values(this.index.films)) if (meta.poster && parseMediaPath(meta.poster)?.hash === p.hash) return false;
    await this.remove(p.hash);
    return true;
  }

  /** {width, height} of a photo (or film) if the Builder knows it, else null. */
  size(src) {
    const m = this.meta(src);
    return m && m.width ? { width: m.width, height: m.height } : null;
  }

  /** Display name for a page's image or film value. */
  label(src) {
    if (!src) return 'No photo';
    const m = this.meta(src);
    if (m) return m.name;
    const p = parseMediaPath(src);
    if (p) return p.kind === 'film' ? 'Film missing' : 'Photo missing';
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
    if (p?.kind === 'film') return this.filmURL(src);
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

  /** URL of a film file (object URL while pending, else the CDN). */
  filmURL(src) {
    const p = parseMediaPath(src);
    if (!p || p.kind !== 'film') return null;
    const rec = this.pending.get(p.hash);
    if (rec?.blob) {
      const key = `${p.hash}-film`;
      if (!this.objectURLs.has(key)) this.objectURLs.set(key, URL.createObjectURL(rec.blob));
      return this.objectURLs.get(key);
    }
    return this.github.mediaURL(src);
  }

  /** Marks a pending film as silent (no sound, or sound to be ignored); published films keep their flag. */
  async setSilent(hash, silent) {
    const rec = this.pending.get(hash);
    if (rec) { rec.silent = !!silent; await this.browser.putMedia(rec); return; }
    if (this.index.films[hash]) this.index.films[hash].silent = !!silent;
  }
}

/** The index entry for a film (what media/index.json carries). */
export function filmMeta(rec) {
  return {
    name: rec.name, width: rec.width, height: rec.height, seconds: rec.seconds, bytes: rec.bytes, mbps: rec.mbps,
    codec: rec.codec, audio: rec.audio, audioCodec: rec.audioCodec || undefined, silent: !!rec.silent, poster: rec.poster || null, addedAt: rec.addedAt,
  };
}
