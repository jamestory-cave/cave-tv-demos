// ServerStore: the production adapter, not built yet. Same interface as the
// prototype pair (BrowserStore for the draft and media, GitHubStore for what
// is published), so swapping it in is a change to main.js, not a rewrite.
//
// What the hotel's server will provide (one small program, one SQLite file,
// one media folder, on a machine inside the hotel):
//
//   GET  /api/published            -> { version, bundle, history, mediaIndex }
//   GET  /api/draft                -> the shared draft (one draft for the whole team, not per browser)
//   PUT  /api/draft                -> save the draft; the server keeps who and when
//   POST /api/media                -> upload an original photo; the server makes 1920 and 800 wide copies
//   POST /api/films                -> upload an MP4 (checked as the browser does); the server keeps it as media/<hash>-<h>.mp4
//                                     and serves it with byte-range support so the TV can stream it
//   POST /api/publish              -> { note } ; the server builds the bundle, writes immutable files,
//                                     bumps version.json, appends history.json, returns the revision
//   POST /api/restore/{revision}   -> republishes an earlier bundle as a new revision
//   GET  /tv/version.json, /tv/bundles/..., /tv/media/...   what the TVs read
//
//   Sign-in by emailed link; roles editor/admin; the server, not the browser,
//   holds any secret. The TV's room identity comes from the network address.

export class ServerStore {
  constructor(baseURL) {
    this.baseURL = baseURL;
  }
  notReady() { throw new Error('ServerStore is a stub. The hotel server is not built yet; use BrowserStore + GitHubStore.'); }
  async loadPublished() { this.notReady(); }
  loadDraft() { this.notReady(); }
  saveDraft() { this.notReady(); }
  clearDraft() { this.notReady(); }
  async putMedia() { this.notReady(); }
  async listMedia() { return []; }
  async publish() { this.notReady(); }
  mediaURL(path) { return new URL(path, this.baseURL).href; }
}
