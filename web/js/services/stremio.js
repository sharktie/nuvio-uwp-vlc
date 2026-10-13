// One-off import from a Stremio account: its addons (already set up with debrid etc.), library and
// watch progress. Uses Stremio's public API (api.strem.io, as stremio-core does); the password is
// only sent there, and the session is closed again after the import.

import { requestJson } from '../core/http.js';
import { listAddons, mergeAddons } from './addons.js';
import { inLibrary, addImportedLibraryItems } from './library.js';
import { saveProgress, parseVideoId, markWatched, isWatched } from './progress.js';

const API = 'https://api.strem.io/api/';

async function call(method, body) {
  const data = await requestJson(API + method, { method: 'POST', body, timeout: 30000 });
  if (data && data.error) {
    const message = typeof data.error === 'string' ? data.error : data.error.message;
    throw new Error(message || 'Stremio refused the request.');
  }
  return data ? data.result : null;
}

/** Signs in, imports, signs out. Resolves to a summary { addons, library, progress }. */
export async function importFromStremio(email, password, onStep = () => {}) {
  onStep('Signing in to Stremio…');
  const login = await call('login', { type: 'Login', email: email.trim(), password, facebook: false });
  const authKey = login && login.authKey;
  if (!authKey) throw new Error('Stremio didn\'t accept that email and password.');
  try {
    onStep('Copying addons…');
    const collection = await call('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true });
    const before = listAddons().length;
    mergeAddons(((collection && collection.addons) || [])
      .filter((a) => a && a.transportUrl && a.manifest)
      // Stremio's own local-files addon only works next to a Stremio streaming server.
      .filter((a) => !/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(a.transportUrl))
      .map((a) => ({ transportUrl: a.transportUrl, manifest: a.manifest })));
    const addons = listAddons().length - before;

    onStep('Copying library…');
    const items = (await call('datastoreGet', { authKey, collection: 'libraryItem', ids: [], all: true })) || [];
    const library = [];
    let progress = 0;
    for (const item of items) {
      if (!item || !item._id || !item.type || item.removed && !(item.state && item.state.timeOffset)) continue;
      const added = Date.parse(item._ctime || item._mtime) || Date.now();
      if (!item.removed && !item.temp && !inLibrary(item._id)) {
        library.push({
          id: item._id,
          type: item.type,
          name: item.name || '',
          poster: item.poster || null,
          posterShape: (item.posterShape || 'poster').toUpperCase(),
          background: item.background || null,
          logo: null,
          description: null,
          releaseInfo: item.year ? String(item.year) : null,
          imdbRating: null,
          genres: [],
          addedAt: added,
        });
      }
      const state = item.state || {};
      if (state.timeOffset > 0 && state.duration > 0) {
        const video = parseVideoId(state.video_id || item._id, item.type);
        saveProgress({
          contentId: item._id,
          contentType: item.type,
          videoId: state.video_id || item._id,
          season: video.season,
          episode: video.episode,
          position: state.timeOffset,
          duration: state.duration,
          title: item.name || '',
          poster: item.poster || null,
          lastWatched: Date.parse(state.lastWatched) || added,
        }, { keepTime: true });
        progress++;
      } else if (item.type === 'movie' && (state.timesWatched > 0 || state.flaggedWatched) && !isWatched(item._id)) {
        markWatched(item._id, null, null, true, { title: item.name || '', type: 'movie' });
      }
    }
    addImportedLibraryItems(library);
    return { addons, library: library.length, progress };
  } finally {
    call('logout', { type: 'Logout', authKey }).catch(() => {});
  }
}
