// Jellyfin and Emby servers. Each signed-in server works like a built-in addon: its libraries are
// Home rows and searchable, its files are streams (the original file, played by VLC without the
// server converting it), and playback, resume points and watched marks go back to the server.
//
// Titles with an IMDb id use it ("tt…"), so they open with the usual details and also list the
// server's copy among your other addons' streams; anything else gets a "jf-<server>:<item>" id.

import { bridge } from '../core/bridge.js';
import { events, storage, profileKey } from '../core/store.js';
import { requestJson, HttpError } from '../core/http.js';
import { sleep } from '../core/dom.js';
import { registerProvider, providersChanged } from './addons.js';
import { saveProgress, getProgress, importWatched, parseVideoId, watchedKey } from './progress.js';

const SYNC_EVERY_MS = 15 * 60 * 1000;
const INDEX_TTL_MS = 30 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE = 50;
const TICKS_PER_SECOND = 10000000;
const PREVIEW_FIELDS = 'ProviderIds,ProductionYear,Overview,Genres,CommunityRating';
const LIBRARY_KINDS = new Set(['movies', 'tvshows', 'homevideos', 'mixed']);

// ---------- Servers ----------

/** Signed-in servers: { key, url, name, product, serverId, version, userId, userName, token, views }. */
export function jellyfinServers() {
  return storage.get(profileKey('jellyfin'), []);
}

function serverByKey(key) {
  return jellyfinServers().find((s) => s.key === key) || null;
}

function saveServers(list, { notify = true } = {}) {
  storage.set(profileKey('jellyfin'), list);
  if (notify) providersChanged();
  events.emit('jellyfin', {});
}

function updateServer(key, changes, options) {
  saveServers(jellyfinServers().map((s) => (s.key === key ? { ...s, ...changes } : s)), options);
}

export function productName(server) {
  return server.product === 'emby' ? 'Emby' : 'Jellyfin';
}

function deviceId() {
  let id = storage.get('jellyfinDeviceId');
  if (!id) {
    id = 'nuvio-' + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    storage.set('jellyfinDeviceId', id);
  }
  return id;
}

function authorization(token) {
  const device = { xbox: 'Xbox', desktop: 'Windows' }[bridge.platform] || 'Browser';
  const parts = ['Client="Nuvio"', `Device="${device}"`, `DeviceId="${deviceId()}"`, `Version="${bridge.appVersion || '1.0.0'}"`];
  if (token) parts.push(`Token="${token}"`);
  return 'MediaBrowser ' + parts.join(', ');
}

function headersFor(server) {
  const value = authorization(server.token);
  // Jellyfin 10.9 and later only read Authorization; Emby reads its own headers.
  if (server.product === 'emby') return { 'X-Emby-Authorization': value, ...(server.token ? { 'X-Emby-Token': server.token } : {}) };
  return { Authorization: value };
}

function api(server, path, { method = 'GET', body, query, timeout = 20000 } = {}) {
  let url = server.url + path;
  if (query) {
    const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
    if ([...params].length) url += (url.includes('?') ? '&' : '?') + params;
  }
  return requestJson(url, { method, body, headers: headersFor(server), timeout });
}

/** Addresses to try for what the user typed: Jellyfin and Emby listen on 8096 by default. */
function candidateUrls(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Enter the server\'s address');
  const clean = (url) => {
    const parsed = new URL(url);
    // Links copied from the web player end in /web/…
    return parsed.origin + parsed.pathname.replace(/\/web(\/.*)?$/i, '').replace(/\/+$/, '');
  };
  if (/^https?:\/\//i.test(text)) return [clean(text)];
  const [, host, rest] = text.match(/^([^/?#]+)(.*)$/);
  if (/:\d+$/.test(host)) return [clean(`http://${host}${rest}`), clean(`https://${host}${rest}`)];
  return [clean(`http://${host}:8096${rest}`), clean(`https://${host}${rest}`), clean(`http://${host}${rest}`)];
}

/** Finds the server at an address. Resolves with its details (not signed in yet). */
export async function findServer(input) {
  let lastError = null;
  for (const url of candidateUrls(input)) {
    try {
      const info = await requestJson(url + '/System/Info/Public', { timeout: 8000 });
      if (!info || !info.Id) throw new Error('Not a Jellyfin or Emby server');
      return {
        url,
        name: info.ServerName || new URL(url).host,
        serverId: info.Id,
        key: String(info.Id).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8),
        version: info.Version || '',
        product: /jellyfin/i.test(info.ProductName || '') ? 'jellyfin' : 'emby',
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Couldn't find a Jellyfin or Emby server at ${input}${lastError ? ` (${lastError.message})` : ''}.`);
}

export async function quickConnectAvailable(server) {
  if (server.product !== 'jellyfin') return false;
  try {
    return (await api(server, '/QuickConnect/Enabled', { timeout: 8000 })) === true;
  } catch {
    return false;
  }
}

/**
 * Quick Connect: onCode(code) is called with the code to approve in another Jellyfin app
 * (Settings > Quick Connect). Resolves with the signed-in server once it's approved.
 */
export async function signInWithQuickConnect(server, onCode, signal) {
  let start;
  try {
    start = await api(server, '/QuickConnect/Initiate', { method: 'POST' });
  } catch (error) {
    // Servers before 10.9 start it with GET.
    if (!(error instanceof HttpError) || ![404, 405].includes(error.status)) throw error;
    start = await api(server, '/QuickConnect/Initiate');
  }
  onCode(start.Code);
  const until = Date.now() + 10 * 60 * 1000;
  while (Date.now() < until) {
    await sleep(3000);
    if (signal && signal.aborted) throw new Error('Cancelled');
    const state = await api(server, '/QuickConnect/Connect', { query: { secret: start.Secret } });
    if (state && state.Authenticated) {
      const auth = await api(server, '/Users/AuthenticateWithQuickConnect', { method: 'POST', body: { Secret: start.Secret } });
      return addServer(server, auth);
    }
  }
  throw new Error('The code expired. Try again.');
}

export async function signInWithPassword(server, username, password) {
  let auth;
  try {
    auth = await api(server, '/Users/AuthenticateByName', { method: 'POST', body: { Username: username, Pw: password || '' } });
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) throw new Error('Wrong username or password.');
    throw error;
  }
  return addServer(server, auth);
}

function addServer(server, auth) {
  if (!auth || !auth.AccessToken || !auth.User) throw new Error('The server didn\'t sign you in.');
  const entry = { ...server, token: auth.AccessToken, userId: auth.User.Id, userName: auth.User.Name, views: [], addedAt: Date.now() };
  saveServers([...jellyfinServers().filter((s) => s.key !== entry.key), entry]);
  syncServer(entry).catch((error) => console.warn('Jellyfin sync failed', error));
  return entry;
}

export async function removeServer(key) {
  const server = serverByKey(key);
  saveServers(jellyfinServers().filter((s) => s.key !== key));
  indexes.delete(key);
  if (server) api(server, '/Sessions/Logout', { method: 'POST', timeout: 8000 }).catch(() => {});
}

// ---------- Libraries and items ----------

const cache = new Map(); // url -> { at, promise }
const indexes = new Map(); // server key -> { at, promise }

function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = load();
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

function providerId(item, name) {
  const ids = item.ProviderIds || {};
  const key = Object.keys(ids).find((k) => k.toLowerCase() === name);
  return key ? ids[key] : null;
}

function imdbOf(item) {
  const id = providerId(item, 'imdb');
  return id && /^tt\d+$/.test(id) ? id : null;
}

function image(server, itemId, kind, tag, size) {
  if (!itemId || !tag) return null;
  return `${server.url}/Items/${itemId}/Images/${kind}?tag=${tag}&${size}&quality=90`;
}

function localId(server, itemId) {
  return `jf-${server.key}:${itemId}`;
}

function previewOf(server, item) {
  const imdb = imdbOf(item);
  const tags = item.ImageTags || {};
  const backdrop = (item.BackdropImageTags || [])[0];
  return {
    id: imdb || localId(server, item.Id),
    type: item.Type === 'Series' ? 'series' : 'movie',
    name: item.Name,
    poster: image(server, item.Id, 'Primary', tags.Primary, 'maxHeight=450'),
    background: backdrop ? `${server.url}/Items/${item.Id}/Images/Backdrop/0?tag=${backdrop}&maxWidth=1920&quality=80` : null,
    logo: image(server, item.Id, 'Logo', tags.Logo, 'maxWidth=600'),
    description: item.Overview || null,
    releaseInfo: item.ProductionYear ? String(item.ProductionYear) : null,
    genres: item.Genres || [],
    imdbRating: item.CommunityRating ? Number(item.CommunityRating).toFixed(1) : null,
  };
}

async function loadViews(server) {
  const data = await api(server, `/Users/${server.userId}/Views`);
  const views = ((data && data.Items) || [])
    .filter((v) => LIBRARY_KINDS.has(v.CollectionType || 'mixed'))
    .map((v) => ({ id: v.Id, name: v.Name, kind: v.CollectionType || 'mixed' }));
  if (JSON.stringify(views) !== JSON.stringify(server.views || [])) updateServer(server.key, { views });
  return views;
}

async function catalog(server, id, extra) {
  const base = { Recursive: true, IncludeItemTypes: 'Movie,Series', Fields: PREVIEW_FIELDS, ImageTypeLimit: 1, EnableTotalRecordCount: false };
  let query;
  if (id === 'jf-search') {
    if (!extra.search) return [];
    query = { ...base, SearchTerm: extra.search, Limit: 30 };
  } else {
    query = { ...base, ParentId: id.replace(/^jf-/, ''), SortBy: 'DateCreated,SortName', SortOrder: 'Descending', StartIndex: Number(extra.skip) || 0, Limit: PAGE };
  }
  const data = await cached(`${server.key}|catalog|${JSON.stringify(query)}`, CACHE_TTL_MS, () => api(server, `/Users/${server.userId}/Items`, { query }));
  return ((data && data.Items) || []).map((item) => previewOf(server, item));
}

async function episodesOf(server, seriesId, season) {
  const query = { userId: server.userId, Fields: 'Overview,PremiereDate', season: season ?? undefined };
  const data = await cached(`${server.key}|episodes|${seriesId}|${season ?? ''}`, CACHE_TTL_MS, () => api(server, `/Shows/${seriesId}/Episodes`, { query }));
  return ((data && data.Items) || []).filter((e) => e.IndexNumber != null);
}

async function meta(server, id) {
  const itemId = id.slice(`jf-${server.key}:`.length).split(':')[0];
  const item = await api(server, `/Users/${server.userId}/Items/${itemId}`, { query: { Fields: PREVIEW_FIELDS } });
  const result = { ...previewOf(server, item), id };
  if (item.RunTimeTicks) result.runtime = `${Math.round(item.RunTimeTicks / TICKS_PER_SECOND / 60)} min`;
  if (item.Type === 'Series') {
    result.type = 'series';
    result.videos = (await episodesOf(server, item.Id)).map((e) => {
      const season = e.ParentIndexNumber ?? 1;
      return {
        id: `${id}:${season}:${e.IndexNumber}`,
        season,
        episode: e.IndexNumber,
        name: e.Name,
        overview: e.Overview || null,
        released: e.PremiereDate || null,
        thumbnail: image(server, e.Id, 'Primary', (e.ImageTags || {}).Primary, 'maxWidth=600'),
      };
    });
  }
  return result;
}

/** IMDb id -> { id, type } for the whole library, and series id -> IMDb id. */
function libraryIndex(server, { fresh = false } = {}) {
  const hit = indexes.get(server.key);
  if (hit && !fresh && Date.now() - hit.at < INDEX_TTL_MS) return hit.promise;
  const promise = api(server, `/Users/${server.userId}/Items`, {
    query: { Recursive: true, IncludeItemTypes: 'Movie,Series', Fields: 'ProviderIds', EnableImages: false, EnableUserData: false },
    timeout: 15000,
  }).then((data) => {
    const byImdb = new Map();
    const seriesImdb = new Map();
    for (const item of (data && data.Items) || []) {
      const imdb = imdbOf(item);
      if (!imdb) continue;
      byImdb.set(imdb, { id: item.Id, type: item.Type });
      if (item.Type === 'Series') seriesImdb.set(item.Id, imdb);
    }
    return { byImdb, seriesImdb };
  });
  indexes.set(server.key, { at: Date.now(), promise });
  promise.catch(() => indexes.delete(server.key));
  return promise;
}

/** The server's item for a movie or episode id ("tt…", "tt…:1:2", "jf-…"), or null. */
async function findItem(server, type, id) {
  const prefix = `jf-${server.key}:`;
  let seriesId = null;
  let season = null;
  let episode = null;
  if (id.startsWith(prefix)) {
    const parts = id.slice(prefix.length).split(':');
    if (parts.length < 3) return parts[0];
    [seriesId, season, episode] = [parts[0], Number(parts[1]), Number(parts[2])];
  } else if (/^tt\d+/.test(id)) {
    const parsed = parseVideoId(id, type);
    const entry = (await libraryIndex(server)).byImdb.get(parsed.contentId);
    if (!entry) return null;
    if (parsed.season == null) return entry.type === 'Movie' ? entry.id : null;
    [seriesId, season, episode] = [entry.id, parsed.season, parsed.episode];
  } else {
    return null;
  }
  const episodes = await episodesOf(server, seriesId, season);
  const match = episodes.find((e) => (e.ParentIndexNumber ?? 1) === season &&
    (e.IndexNumber === episode || (e.IndexNumberEnd && e.IndexNumber <= episode && episode <= e.IndexNumberEnd)));
  return match ? match.Id : null;
}

function resolutionOf(video) {
  if (!video) return null;
  const w = video.Width || 0;
  const hgt = video.Height || 0;
  if (w >= 3200 || hgt >= 1600) return '2160p';
  if (w >= 1800 || hgt >= 1000) return '1080p';
  if (w >= 1200 || hgt >= 700) return '720p';
  return hgt ? `${hgt}p` : null;
}

function withToken(server, url) {
  const params = new URLSearchParams({ api_key: server.token });
  // Jellyfin 10.11 and later only accept ApiKey; older ones and Emby use api_key.
  if (server.product === 'jellyfin') params.set('ApiKey', server.token);
  return url + (url.includes('?') ? '&' : '?') + params;
}

function streamFor(server, item, source) {
  const media = source.MediaStreams || [];
  const video = media.find((s) => s.Type === 'Video');
  const audios = media.filter((s) => s.Type === 'Audio');
  const audio = audios.find((s) => s.IsDefault) || audios[0];
  const resolution = resolutionOf(video);
  const container = /^[a-z0-9]+$/i.test(source.Container || '') ? '.' + source.Container : '';
  const url = withToken(server, `${server.url}/Videos/${item.Id}/stream${container}?static=true&mediaSourceId=${encodeURIComponent(source.Id)}`);
  const filename = source.Path ? source.Path.split(/[\\/]/).pop() : null;
  const subtitles = media
    .filter((s) => s.Type === 'Subtitle' && s.IsExternal && s.IsTextSubtitleStream !== false)
    .map((s) => ({
      id: `jf-${item.Id}-${s.Index}`,
      url: withToken(server, `${server.url}/Videos/${item.Id}/${source.Id}/Subtitles/${s.Index}/Stream.vtt`),
      lang: s.Language || 'und',
    }));
  return {
    name: [productName(server), resolution].filter(Boolean).join('\n'),
    title: [filename || source.Name || item.Name, [video && video.DisplayTitle, audio && audio.DisplayTitle].filter(Boolean).join(' · ')].filter(Boolean).join('\n'),
    url,
    subtitles,
    behaviorHints: {
      bingeGroup: `jellyfin-${server.key}-${resolution || 'file'}`,
      videoSize: source.Size || undefined,
      filename: filename || undefined,
    },
    jellyfin: { server: server.key, itemId: item.Id, mediaSourceId: source.Id },
  };
}

async function streams(server, type, id) {
  const itemId = await findItem(server, type, id);
  if (!itemId) return [];
  const item = await api(server, `/Users/${server.userId}/Items/${itemId}`, { query: { Fields: 'MediaSources,Path' } });
  return (item.MediaSources || []).map((source) => streamFor(server, item, source));
}

// ---------- As an addon ----------

function serverAddon(server) {
  const prefix = `jf-${server.key}:`;
  const label = `${productName(server)} · ${server.name}`;
  const catalogs = (server.views || []).map((view) => ({
    type: view.kind === 'tvshows' ? 'series' : view.kind === 'movies' ? 'movie' : 'all',
    id: `jf-${view.id}`,
    name: view.name,
    hideType: true,
    extra: [{ name: 'skip' }],
  }));
  catalogs.push({ type: 'all', id: 'jf-search', name: server.name, hideType: true, extra: [{ name: 'search', isRequired: true }] });
  return {
    transportUrl: `nuvio://jellyfin/${server.key}`,
    manifest: {
      id: `jellyfin.${server.key}`,
      name: label,
      version: server.version || '',
      description: `${server.userName} on ${server.url}`,
      types: ['movie', 'series'],
      resources: [
        'catalog',
        { name: 'meta', types: ['movie', 'series'], idPrefixes: [prefix] },
        { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt', prefix] },
      ],
      catalogs,
    },
    async handler(resource, type, id, extra) {
      const current = serverByKey(server.key) || server;
      if (resource === 'catalog') return { metas: await catalog(current, id, extra) };
      if (resource === 'meta') return { meta: await meta(current, id) };
      if (resource === 'stream') return { streams: await streams(current, type, id) };
      return {};
    },
  };
}

registerProvider(() => jellyfinServers().filter((s) => s.token).map(serverAddon));

// ---------- Playback reports ----------

const reported = new Map(); // watched key -> when it last played from a server
let session = null; // { key, itemId, mediaSourceId, playSessionId, lastProgress }

events.on('playback', (info) => {
  const ref = info.stream && info.stream.jellyfin;
  const server = ref && serverByKey(ref.server);
  if (!server) return;
  reported.set(watchedKey(info.contentId, info.season, info.episode), Date.now());
  if (info.phase === 'start' || !session || session.itemId !== ref.itemId) {
    session = { ...ref, playSessionId: Math.random().toString(16).slice(2), lastProgress: 0 };
  }
  const body = {
    ItemId: ref.itemId,
    MediaSourceId: ref.mediaSourceId,
    PlaySessionId: session.playSessionId,
    PositionTicks: Math.round((info.position || 0) * TICKS_PER_SECOND),
    IsPaused: !!info.paused,
    PlayMethod: 'DirectPlay',
    CanSeek: true,
  };
  let path = null;
  if (info.phase === 'start') path = '/Sessions/Playing';
  else if (info.phase === 'stop') path = '/Sessions/Playing/Stopped';
  else if (info.phase === 'pause' || info.phase === 'resume') {
    path = '/Sessions/Playing/Progress';
    body.EventName = info.phase === 'pause' ? 'Pause' : 'Unpause';
  } else if (Date.now() - session.lastProgress > 10000) {
    path = '/Sessions/Playing/Progress';
    body.EventName = 'TimeUpdate';
  }
  if (!path) return;
  session.lastProgress = Date.now();
  if (info.phase === 'stop') session = null;
  api(server, path, { method: 'POST', body, timeout: 10000 }).catch((error) => console.warn('Jellyfin report failed', path, error.message));
});

// Watched marks set in the app (or by finishing something from another source) go to the server.
events.on('watched', (change) => {
  if (!change || !change.contentId || change.imported) return;
  const playedAt = reported.get(watchedKey(change.contentId, change.season, change.episode));
  // Played from the server: it marks it itself when playback stops.
  if (change.value && playedAt && Date.now() - playedAt < 10 * 60 * 1000) return;
  for (const server of jellyfinServers().filter((s) => s.token)) {
    const type = change.season != null ? 'series' : 'movie';
    const id = change.season != null ? `${change.contentId}:${change.season}:${change.episode}` : change.contentId;
    findItem(server, type, id).then((itemId) => {
      if (!itemId) return null;
      return api(server, `/Users/${server.userId}/PlayedItems/${itemId}`, { method: change.value ? 'POST' : 'DELETE', timeout: 10000 });
    }).catch((error) => console.warn('Jellyfin watched update failed', error.message));
  }
});

// ---------- Sync from the server ----------

function contentIdFor(server, item, index) {
  if (item.Type === 'Episode') {
    return index.seriesImdb.get(item.SeriesId) || localId(server, item.SeriesId);
  }
  return imdbOf(item) || localId(server, item.Id);
}

/** A resume point on the server becomes a Continue Watching entry that resumes from it. */
function importResume(server, item, index) {
  const data = item.UserData || {};
  const position = (data.PlaybackPositionTicks || 0) / TICKS_PER_SECOND * 1000;
  const duration = (item.RunTimeTicks || 0) / TICKS_PER_SECOND * 1000;
  if (!position || !duration) return;
  const isEpisode = item.Type === 'Episode';
  const contentId = contentIdFor(server, item, index);
  const season = isEpisode ? item.ParentIndexNumber ?? 1 : null;
  const episode = isEpisode ? item.IndexNumber : null;
  if (isEpisode && episode == null) return;
  const lastWatched = Date.parse(data.LastPlayedDate || '') || Date.now();
  const existing = getProgress(contentId, season, episode);
  if (existing && existing.lastWatched >= lastWatched) return;
  const source = (item.MediaSources || [])[0];
  const stream = source ? streamFor(server, item, source) : null;
  const tags = item.ImageTags || {};
  saveProgress({
    contentId,
    contentType: isEpisode ? 'series' : 'movie',
    videoId: isEpisode ? `${contentId}:${season}:${episode}` : contentId,
    season,
    episode,
    position: Math.round(position),
    duration: Math.round(duration),
    lastWatched,
    title: isEpisode ? item.SeriesName : item.Name,
    episodeTitle: isEpisode ? item.Name : null,
    thumbnail: isEpisode ? image(server, item.Id, 'Primary', tags.Primary, 'maxWidth=600') : null,
    background: (item.ParentBackdropImageTags || [])[0] && item.ParentBackdropItemId
      ? `${server.url}/Items/${item.ParentBackdropItemId}/Images/Backdrop/0?tag=${item.ParentBackdropImageTags[0]}&maxWidth=1920&quality=80`
      : (item.BackdropImageTags || [])[0] ? `${server.url}/Items/${item.Id}/Images/Backdrop/0?tag=${item.BackdropImageTags[0]}&maxWidth=1920&quality=80` : null,
    poster: isEpisode ? null : image(server, item.Id, 'Primary', tags.Primary, 'maxHeight=450'),
    stream: stream && {
      url: stream.url,
      name: stream.name,
      title: stream.title,
      addonUrl: `nuvio://jellyfin/${server.key}`,
      addonName: `${productName(server)} · ${server.name}`,
      behaviorHints: stream.behaviorHints,
      jellyfin: stream.jellyfin,
    },
  }, { keepTime: true });
}

async function syncServer(server) {
  try {
    await loadViews(server);
    const index = await libraryIndex(server, { fresh: true });
    const resume = await api(server, `/Users/${server.userId}/Items/Resume`, {
      query: { MediaTypes: 'Video', Limit: 30, Fields: 'ProviderIds,MediaSources,Path', EnableTotalRecordCount: false },
    });
    for (const item of (resume && resume.Items) || []) importResume(server, item, index);
    const played = await api(server, `/Users/${server.userId}/Items`, {
      query: { Recursive: true, IsPlayed: true, IncludeItemTypes: 'Movie,Episode', Fields: 'ProviderIds', EnableImages: false, EnableTotalRecordCount: false },
      timeout: 30000,
    });
    importWatched(((played && played.Items) || []).filter((item) => item.Type === 'Movie' || item.IndexNumber != null).map((item) => ({
      contentId: contentIdFor(server, item, index),
      type: item.Type === 'Episode' ? 'series' : 'movie',
      season: item.Type === 'Episode' ? item.ParentIndexNumber ?? 1 : null,
      episode: item.Type === 'Episode' ? item.IndexNumber : null,
      title: item.Type === 'Episode' ? item.SeriesName : item.Name,
      watchedAt: Date.parse((item.UserData || {}).LastPlayedDate || '') || Date.now(),
    })));
    updateServer(server.key, { lastSync: Date.now(), error: null }, { notify: false });
  } catch (error) {
    const signedOut = error instanceof HttpError && error.status === 401;
    updateServer(server.key, { error: signedOut ? 'The server signed this device out. Remove it and sign in again.' : error.message }, { notify: false });
    throw error;
  }
}

/** Fetches libraries, resume points and watched marks from every server (or one). */
export async function syncJellyfin(key = null) {
  const servers = jellyfinServers().filter((s) => s.token && (!key || s.key === key));
  const results = await Promise.allSettled(servers.map((server) => syncServer(server)));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed && key) throw failed.reason;
}

export function initJellyfin() {
  const run = () => {
    if (!document.hidden && jellyfinServers().length) syncJellyfin().catch(() => {});
  };
  setTimeout(run, 4000);
  setInterval(run, SYNC_EVERY_MS);
}
