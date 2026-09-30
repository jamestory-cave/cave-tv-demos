// GitHubStore: reads the published content from the Pages URL and publishes
// a new revision as ONE commit through the Git Data API:
//   read ref -> read commit (tree) -> check revision -> blobs -> tree -> commit -> update ref
//
// The token is held in memory and in this browser's localStorage only. It is
// never written to the repository, never logged, never sent anywhere but
// api.github.com. `transport` can be replaced by a fake for tests.

import { config } from '../../config.js';
import { blobToBase64, utf8ToBase64, base64ToUtf8, sha256Hex } from '../util.js';
import { bundleText } from '../bundle.js';

const TOKEN_KEY = 'cave-builder.token';

export class PublishConflict extends Error {}

/** A blob upload (photo or film) failed before the commit: nothing was published. */
export class UploadFailed extends Error {
  constructor(what, reason, isFilm) { super(`Uploading ${what} failed: ${reason}`); this.what = what; this.reason = reason; this.isFilm = isFilm; }
}

export class GitHubStore {
  constructor({ transport } = {}) {
    this.transport = transport || defaultTransport;
    this.token = localStorage.getItem(TOKEN_KEY) || '';
  }

  // ---- reading what is published (plain files on Pages, no token needed) ----

  async fetchJSON(rel, { bust = false } = {}) {
    const url = new URL(rel, config.baseURL);
    if (bust) url.searchParams.set('t', String(Date.now()));
    const res = await fetch(url, { cache: bust ? 'no-store' : 'default' });
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    return res.json();
  }

  async loadPublished() {
    const version = await this.fetchJSON(config.versionFile, { bust: true });
    const bundle = await this.fetchJSON(version.bundle);
    let history = [];
    let mediaIndex = { assets: {}, media: {} };
    try { history = await this.fetchJSON(config.historyFile, { bust: true }); } catch { /* first publish */ }
    try { mediaIndex = await this.fetchJSON(config.mediaIndexFile, { bust: true }); } catch { /* no index yet */ }
    return { version, bundle, history, mediaIndex };
  }

  async fetchBundle(path) { return this.fetchJSON(path); }

  mediaURL(path) { return new URL(path, config.baseURL).href; }

  // ---- token ----

  get hasToken() { return !!this.token; }
  get tokenHint() { return this.token ? '••••' + this.token.slice(-4) : ''; }

  setToken(token) {
    this.token = (token || '').trim();
    if (this.token) localStorage.setItem(TOKEN_KEY, this.token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  forgetToken() { this.setToken(''); }

  /** Read-only check that the token can see the repository and push to it. */
  async validateToken(token = this.token) {
    if (!token) return { ok: false, reason: 'No passcode entered' };
    try {
      const repo = await this.api('GET', `/repos/${config.owner}/${config.repo}`, null, token);
      if (!repo.permissions?.push) return { ok: false, reason: 'This passcode can read the repository but cannot write to it. It needs Contents: Read and write.' };
      return { ok: true, repo: repo.full_name };
    } catch (e) {
      if (e.status === 401) return { ok: false, reason: 'The passcode was not accepted. Check it was copied in full and has not expired.' };
      if (e.status === 404) return { ok: false, reason: `This passcode cannot see ${config.owner}/${config.repo}. It must be limited to that repository.` };
      return { ok: false, reason: e.message };
    }
  }

  // ---- publishing ----

  /**
   * Publishes one revision.
   * @param {object} p
   * @param {object} p.bundle       ContentBundle (its `version` is set to the new revision here)
   * @param {number} p.basedOnRevision  the revision the draft started from
   * @param {string[]} p.summary    plain-English lines for history.json
   * @param {string} p.by           name typed in the Builder
   * @param {string} [p.note]
   * @param {Array}  [p.media]      [{hash, name, width, height, bytes, blobs: {1920: Blob, 800: Blob}}] to upload
   * @param {Array}  [p.films]      [{hash, name, width, height, seconds, bytes, blob: Blob, ...}] to upload, one blob each
   * @param {object} [p.mediaIndex] current media/index.json (new media is added to it)
   * @param {function} [p.progress] (message, fraction?) => void
   * @returns {Promise<{revision, bundlePath, commit}>}
   */
  async publish(p) {
    const say = p.progress || (() => {});
    const base = `/repos/${config.owner}/${config.repo}/git`;
    const dir = config.contentPath.replace(/\/$/, '');

    say('Checking what is on GitHub now…');
    const ref = await this.api('GET', `${base}/ref/heads/${config.branch}`);
    const headSha = ref.object.sha;
    const head = await this.api('GET', `${base}/commits/${headSha}`);
    const baseTree = head.tree.sha;

    // The authoritative revision is the one in the repository, not the one
    // Pages happens to be serving (Pages lags by a minute or so).
    let current = null;
    try {
      const file = await this.api('GET', `/repos/${config.owner}/${config.repo}/contents/${dir}/${config.versionFile}?ref=${headSha}`);
      current = JSON.parse(base64ToUtf8(file.content));
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const currentRevision = current?.revision ?? 0;
    if (p.basedOnRevision !== undefined && p.basedOnRevision !== null && currentRevision !== p.basedOnRevision && !p.force) {
      throw new PublishConflict(`Someone else has published since you started (revision ${currentRevision}). Reload to see their changes; your draft is kept.`);
    }
    const revision = currentRevision + 1;

    // History: newest first, last N.
    let history = [];
    try {
      const file = await this.api('GET', `/repos/${config.owner}/${config.repo}/contents/${dir}/${config.historyFile}?ref=${headSha}`);
      history = JSON.parse(base64ToUtf8(file.content));
    } catch (e) { if (e.status !== 404) throw e; }

    const bundle = { ...p.bundle, version: revision };
    const text = bundleText(bundle);
    const hash8 = (await sha256Hex(text)).slice(0, 8);
    const bundlePath = `bundles/${revision}-${hash8}.json`;
    const publishedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const version = { schema: 1, revision, bundle: bundlePath, publishedAt, note: p.note || '' };
    const entry = { revision, bundle: bundlePath, publishedAt, by: p.by || '', summary: p.summary || [] };
    if (p.note) entry.note = p.note;
    history = [entry, ...history].slice(0, config.historyLength);

    const mediaIndex = p.mediaIndex ? JSON.parse(JSON.stringify(p.mediaIndex)) : { assets: {}, media: {}, films: {} };
    mediaIndex.media = mediaIndex.media || {};
    mediaIndex.films = mediaIndex.films || {};
    const tree = [];
    const blob = async (path, content, encoding, opts = {}) => {
      let b;
      try {
        b = await this.api('POST', `${base}/blobs`, { content, encoding }, this.token, opts);
      } catch (e) {
        if (opts.what) throw new UploadFailed(opts.what, e.message, !!opts.isFilm);
        throw e;
      }
      tree.push({ path: `${dir}/${path}`, mode: '100644', type: 'blob', sha: b.sha });
    };

    const media = p.media || [];
    for (let i = 0; i < media.length; i++) {
      const m = media[i];
      say(`Uploading photo ${i + 1} of ${media.length}: ${m.name}`);
      for (const [w, file] of Object.entries(m.blobs)) {
        await blob(`media/${m.hash}-${w}.jpg`, await blobToBase64(file), 'base64', { what: `photo "${m.name}"` });
      }
      mediaIndex.media[m.hash] = { name: m.name, width: m.width, height: m.height, sizes: Object.keys(m.blobs).map(Number), bytes: m.bytes, addedAt: publishedAt, by: p.by || '', poster: m.poster || undefined };
    }

    // Films: one blob each, base64, with progress per file. A failure here
    // stops the publish before anything is committed. The index records the
    // poster the bundle references for the film (a poster chosen from Media
    // is not on the film's own record).
    const posters = postersIn(p.bundle);
    const films = p.films || [];
    for (let i = 0; i < films.length; i++) {
      const f = films[i];
      const label = `film ${i + 1} of ${films.length}: ${f.name} (${Math.round(f.bytes / 1048576)} MB)`;
      say(`Encoding ${label}…`);
      const content = await blobToBase64(f.blob);
      say(`Uploading ${label}… 0%`, 0);
      await blob(`media/${f.hash}-${f.height}.mp4`, content, 'base64', {
        what: `film "${f.name}"`, isFilm: true,
        onProgress: (frac) => say(`Uploading ${label}… ${Math.round(frac * 100)}%`, frac),
      });
      mediaIndex.films[f.hash] = {
        name: f.name, width: f.width, height: f.height, seconds: f.seconds, bytes: f.bytes, mbps: f.mbps, codec: f.codec, audio: f.audio,
        audioCodec: f.audioCodec || undefined, silent: !!f.silent, poster: posters.get(`media/${f.hash}-${f.height}.mp4`) || f.poster || null, addedAt: publishedAt, by: p.by || '',
      };
    }

    say('Writing the content…');
    await blob(bundlePath, utf8ToBase64(text), 'base64');
    await blob(config.historyFile, utf8ToBase64(JSON.stringify(history, null, 2) + '\n'), 'base64');
    await blob(config.mediaIndexFile, utf8ToBase64(JSON.stringify(mediaIndex, null, 2) + '\n'), 'base64');
    await blob(config.versionFile, utf8ToBase64(JSON.stringify(version, null, 2) + '\n'), 'base64');

    const newTree = await this.api('POST', `${base}/trees`, { base_tree: baseTree, tree });
    const message = `Publish revision ${revision}${p.by ? ` (${p.by})` : ''}${p.note ? `: ${p.note}` : ''}\n\n${(p.summary || []).slice(0, 30).map((l) => '- ' + l).join('\n')}`;
    const commit = await this.api('POST', `${base}/commits`, { message, tree: newTree.sha, parents: [headSha] });

    say('Publishing…');
    try {
      await this.api('PATCH', `${base}/refs/heads/${config.branch}`, { sha: commit.sha, force: false });
    } catch (e) {
      if (e.status === 422 || e.status === 409) throw new PublishConflict('Someone else published at the same moment. Reload and try again; your draft is kept.');
      throw e;
    }
    return { revision, bundlePath, commit: commit.sha, version, historyEntry: entry, mediaIndex };
  }

  // ---- low level ----

  async api(method, path, body, token = this.token, opts = {}) {
    return this.transport(method, config.apiBase + path, body, token, opts);
  }
}

/** film path -> the poster path a bundle uses with it (film blocks, background films, film slides). */
export function postersIn(bundle) {
  const map = new Map();
  const walk = (page) => {
    for (const f of page.films || []) if (f.film && f.poster && !map.has(f.film)) map.set(f.film, f.poster);
    if (page.backgroundFilm?.film && page.backgroundFilm.poster && !map.has(page.backgroundFilm.film)) map.set(page.backgroundFilm.film, page.backgroundFilm.poster);
    for (const sl of page.slides || []) if (sl.film && sl.poster && !map.has(sl.film)) map.set(sl.film, sl.poster);
    for (const c of page.children || []) walk(c);
  };
  if (bundle?.home) walk(bundle.home);
  return map;
}

const FRIENDLY = { 401: 'The passcode was not accepted.', 403: 'The passcode is not allowed to do this.', 404: 'The repository could not be found with this passcode.', 413: 'GitHub refused the file as too large.', 422: 'GitHub could not accept the file.' };

function apiError(status, data) {
  const err = new Error(FRIENDLY[status] || (data?.message ? `GitHub said: ${data.message}` : `GitHub replied with an error (${status})`));
  err.status = status;
  return err;
}

/** fetch for small calls; XMLHttpRequest when upload progress is wanted (big film blobs). */
async function defaultTransport(method, url, body, token, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  if (opts.onProgress && body) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) opts.onProgress(e.loaded / e.total); };
      xhr.onerror = () => reject(new Error('The connection dropped during the upload.'));
      xhr.ontimeout = () => reject(new Error('The upload timed out.'));
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* no body */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(apiError(xhr.status, data));
      };
      xhr.timeout = 10 * 60 * 1000;
      xhr.send(JSON.stringify(body));
    });
  }
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw apiError(res.status, data);
  return data;
}
