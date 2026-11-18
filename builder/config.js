// Cave Builder configuration. The only file with addresses in it.
//
// Published content lives in the GitHub repository below and is served by
// GitHub Pages. The TV reads `baseURL`; the Builder reads the same files and
// publishes new ones through the GitHub API with the passcode (token) the
// user enters in Settings. Nothing secret belongs here.

const local = ['localhost', '127.0.0.1', '0.0.0.0', ''].includes(location.hostname);

// Served by the hotel's own Cave server (builder/server/), every page carries
// <meta name="cave-mode" content="server">: the Builder then signs in, shares
// one draft with the team and publishes to that server. Without the mark
// (GitHub Pages, or any plain file server) it is the prototype, unchanged.
const server = typeof document !== 'undefined' && !!document.querySelector('meta[name="cave-mode"][content="server"]');

export const config = {
  mode: server ? 'server' : 'github',

  // Where publishing goes.
  owner: 'jamestory-cave',
  repo: 'cave-tv-demos',
  branch: 'main',
  contentPath: 'tv/s1',            // folder inside the repository
  apiBase: 'https://api.github.com',

  // Where the TV (and the Builder) read the published content from.
  // Served from localhost, read the local copy next to the Builder instead,
  // so the whole thing can be tested without touching GitHub.
  // On the Cave server the content is at /tv/s1/ on the same address.
  baseURL: server ? new URL('/tv/s1/', location.origin).href
         : local ? new URL('../tv/s1/', location.href).href
                 : 'https://jamestory-cave.github.io/cave-tv-demos/tv/s1/',
  isLocal: local,

  // Contract: version.json is fetched with a cache-busting query.
  versionFile: 'version.json',
  historyFile: 'history.json',
  mediaIndexFile: 'media/index.json',
  historyLength: 20,

  // Hotel wording shown in the Builder's own chrome.
  hotelName: 'Cave Hotel & Golf Resort',
};
