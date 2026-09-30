// Cave Builder configuration. The only file with addresses in it.
//
// Published content lives in the GitHub repository below and is served by
// GitHub Pages. The TV reads `baseURL`; the Builder reads the same files and
// publishes new ones through the GitHub API with the passcode (token) the
// user enters in Settings. Nothing secret belongs here.

const local = ['localhost', '127.0.0.1', '0.0.0.0', ''].includes(location.hostname);

export const config = {
  // Where publishing goes.
  owner: 'jamestory-cave',
  repo: 'cave-tv-demos',
  branch: 'main',
  contentPath: 'tv/s1',            // folder inside the repository
  apiBase: 'https://api.github.com',

  // Where the TV (and the Builder) read the published content from.
  // Served from localhost, read the local copy next to the Builder instead,
  // so the whole thing can be tested without touching GitHub.
  baseURL: local ? new URL('../tv/s1/', location.href).href
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
