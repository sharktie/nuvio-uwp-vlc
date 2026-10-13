// Trakt: sign in with a code, scrobble what you play, bring your watched history and paused
// progress into the app, show your watchlist and recommendations on Home, and send watched marks
// you set in the app to Trakt. https://trakt.docs.apiary.io
//
// Needs a Trakt API app (client ID and secret): built in from config.js, or entered in Settings.

import config from '../config.js';
import { events, storage, profileKey, settings } from '../core/store.js';
import { requestJson, HttpError } from '../core/http.js';
import { sleep } from '../core/dom.js';
import { registerProvider, providersChanged } from './addons.js';
import { saveProgress, getProgress, importWatched, watchedKey } from './progress.js';
import { percentOf } from './playback.js';

const SYNC_EVERY_MS = 30 * 60 * 1000;
const LIST_TTL_MS = 10 * 60 * 1000;
const PAGE = 50;
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

/** The Trakt API app to sign in with, or null if this build has none and none was entered. */
export function traktApp() {
  const built = config.trakt || {};
  const own = settings.get('traktClientId') && settings.get('traktClientSecret');
  const clientId = own ? settings.get('traktClientId') : built.clientId;
  const clientSecret = own ? settings.get('traktClientSecret') : built.clientSecret;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, apiUrl: (built.apiUrl || 'https://api.trakt.tv').replace(/\/+$/, ''), builtIn: !own };
}

// ---------- Account ----------

/** { accessToken, refreshToken, expiresAt, user: { username, name }, activities, lastSync, error }. */
export function traktAccount() {
  return storage.get(profileKey('trakt'), null);
}

function saveAccount(account, { notify = false } = {}) {
  storage.set(profileKey('trakt'), account || undefined);
  if (notify) providersChanged();
  events.emit('trakt', {});
}

function updateAccount(changes, options) {
  const account = traktAccount();
  if (account) saveAccount({ ...account, ...changes }, options);
}

export function traktConnected() {
  const account = traktAccount();
  return !!(account && account.accessToken && traktApp());
}

function headers(app, token) {
  const result = { 'trakt-api-version': '2', 'trakt-api-key': app.clientId };
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

function tokenFields(data) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: ((data.created_at || Date.now() / 1000) + (data.expires_in || 0)) * 1000,
  };
}

let refreshing = null;

async function refreshToken() {
  const app = traktApp();
  const account = traktAccount();
  if (!refreshing) {
    refreshing = requestJson(`${app.apiUrl}/oauth/token`, {
      method: 'POST',
      headers: headers(app),
      native: true,
      body: { refresh_token: account.refreshToken, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: REDIRECT_URI, grant_type: 'refresh_token' },
    }).then((data) => updateAccount({ ...tokenFields(data), error: null })).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

/** A signed-in API request; renews the token when it's close to expiring or rejected once. */
async function api(path, { method = 'GET', body, retried = false } = {}) {
  const app = traktApp();
  let account = traktAccount();
  if (!app || !account || !account.accessToken) throw new Error('Not connected to Trakt');
  if (account.expiresAt && account.expiresAt - Date.now() < 24 * 60 * 60 * 1000) {
    await refreshToken();
    account = traktAccount();
  }
  try {
    return await requestJson(`${app.apiUrl}${path}`, { method, body, headers: headers(app, account.accessToken), timeout: 20000, native: true });
  } catch (error) {
    if (error instanceof HttpError && error.status === 401 && !retried) {
      try {
        await refreshToken();
      } catch {
        updateAccount({ error: 'Trakt signed this device out. Disconnect and connect again.' });
        throw error;
      }
      return api(path, { method, body, retried: true });
    }
    throw error;
  }
}

/**
 * Device sign-in: onCode({ code, url }) shows the code to enter at the URL. Resolves once the
 * user approves it on trakt.tv.
 */
export async function connectTrakt(onCode, signal) {
  const app = traktApp();
  if (!app) throw new Error('Add a Trakt API app first.');
  const start = await requestJson(`${app.apiUrl}/oauth/device/code`, { method: 'POST', headers: headers(app), body: { client_id: app.clientId }, native: true });
  onCode({ code: start.user_code, url: start.verification_url || 'https://trakt.tv/activate' });
  let interval = Math.max(1, Number(start.interval) || 5) * 1000;
  const until = Date.now() + (Number(start.expires_in) || 600) * 1000;
  while (Date.now() < until) {
    await sleep(interval);
    if (signal && signal.aborted) throw new Error('Cancelled');
    try {
      const data = await requestJson(`${app.apiUrl}/oauth/device/token`, {
        method: 'POST',
        headers: headers(app),
        native: true,
        body: { code: start.device_code, client_id: app.clientId, client_secret: app.clientSecret },
      });
      saveAccount({ ...tokenFields(data), user: null, activities: {}, connectedAt: Date.now() });
      try {
        const profile = await api('/users/settings');
        updateAccount({ user: { username: profile.user.username, name: profile.user.name || profile.user.username } });
      } catch (error) {
        console.warn('Trakt profile failed', error);
      }
      providersChanged();
      syncTrakt({ full: true }).catch((error) => console.warn('Trakt sync failed', error));
      return traktAccount();
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.status === 400) continue; // not approved yet
      if (error.status === 429) {
        interval += 1000;
        continue;
      }
      if (error.status === 418) throw new Error('The code was declined on Trakt.');
      if (error.status === 410 || error.status === 404) break;
      throw error;
    }
  }
  throw new Error('The code expired. Try again.');
}

export async function disconnectTrakt() {
  const app = traktApp();
  const account = traktAccount();
  saveAccount(null, { notify: true });
  lists.clear();
  if (app && account && account.accessToken) {
    requestJson(`${app.apiUrl}/oauth/revoke`, {
      method: 'POST',
      headers: headers(app),
      native: true,
      body: { token: account.accessToken, client_id: app.clientId, client_secret: app.clientSecret },
    }).catch(() => {});
  }
}

// ---------- Ids ----------

/** Trakt ids for an app content id: IMDb ("tt…") or TMDB ("tmdb:…"). */
function idsFor(contentId) {
  const id = String(contentId || '');
  if (/^tt\d+$/.test(id)) return { imdb: id };
  const tmdb = id.match(/^tmdb:(?:movie:|tv:|series:)?(\d+)$/);
  return tmdb ? { tmdb: Number(tmdb[1]) } : null;
}

function poster(imdb) {
  return `https://images.metahub.space/poster/medium/${imdb}/img`;
}

// ---------- Scrobbling ----------

let nowPlaying = null; // watched key of what's being scrobbled
const scrobbled = new Map(); // watched key -> when Trakt counted it as watched by a scrobble

events.on('playback', (info) => {
  if (!traktConnected() || !settings.get('traktScrobble')) return;
  const action = { start: 'start', resume: 'start', pause: 'pause', stop: 'stop' }[info.phase];
  const ids = idsFor(info.contentId);
  if (!action || !ids) return;
  const key = watchedKey(info.contentId, info.season, info.episode);
  const progress = Math.round(percentOf(info) * 100) / 100;
  const body = info.season != null
    ? { show: { ids }, episode: { season: info.season, number: info.episode }, progress }
    : { movie: { ids }, progress };
  nowPlaying = action === 'stop' ? null : key;
  // Trakt marks it watched when a scrobble stops at 80% or more.
  if (action === 'stop' && progress >= 80) scrobbled.set(key, Date.now());
  api(`/scrobble/${action}`, { method: 'POST', body }).catch((error) => {
    // 409: already scrobbled a moment ago.
    if (!(error instanceof HttpError && error.status === 409)) console.warn('Trakt scrobble failed', action, error.message);
  });
});

// ---------- Watched marks to Trakt ----------

const outbox = { add: new Map(), remove: new Map() };
let flushTimer = 0;

events.on('watched', (change) => {
  if (!traktConnected() || !change || !change.contentId || change.imported || !idsFor(change.contentId)) return;
  const key = watchedKey(change.contentId, change.season, change.episode);
  if (change.value && settings.get('traktScrobble')) {
    // Finished while scrobbling: Trakt already has it.
    const at = scrobbled.get(key);
    if (nowPlaying === key || (at && Date.now() - at < 10 * 60 * 1000)) return;
  }
  const entry = { contentId: change.contentId, season: change.season ?? null, episode: change.episode ?? null, at: new Date().toISOString() };
  (change.value ? outbox.remove : outbox.add).delete(key);
  (change.value ? outbox.add : outbox.remove).set(key, entry);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushOutbox, 2000);
});

function historyBody(entries, withDates) {
  const movies = [];
  const shows = new Map();
  for (const e of entries) {
    const ids = idsFor(e.contentId);
    if (e.season == null) {
      movies.push(withDates ? { ids, watched_at: e.at } : { ids });
      continue;
    }
    if (!shows.has(e.contentId)) shows.set(e.contentId, { ids, seasons: new Map() });
    const seasons = shows.get(e.contentId).seasons;
    if (!seasons.has(e.season)) seasons.set(e.season, []);
    seasons.get(e.season).push(withDates ? { number: e.episode, watched_at: e.at } : { number: e.episode });
  }
  return {
    movies,
    shows: [...shows.values()].map((s) => ({ ids: s.ids, seasons: [...s.seasons].map(([number, episodes]) => ({ number, episodes })) })),
  };
}

async function flushOutbox() {
  const add = [...outbox.add.values()];
  const remove = [...outbox.remove.values()];
  outbox.add.clear();
  outbox.remove.clear();
  try {
    if (add.length) await api('/sync/history', { method: 'POST', body: historyBody(add, true) });
    if (remove.length) await api('/sync/history/remove', { method: 'POST', body: historyBody(remove, false) });
  } catch (error) {
    console.warn('Trakt history update failed', error.message);
  }
}

// ---------- Importing from Trakt ----------

function activity(data, path) {
  return path.split('.').reduce((v, k) => (v ? v[k] : undefined), data) || null;
}

async function importHistory() {
  const items = [];
  const movies = (await api('/sync/watched/movies')) || [];
  for (const m of movies) {
    const imdb = m.movie && m.movie.ids && m.movie.ids.imdb;
    if (imdb) items.push({ contentId: imdb, type: 'movie', title: m.movie.title, watchedAt: Date.parse(m.last_watched_at) || Date.now() });
  }
  const shows = (await api('/sync/watched/shows')) || [];
  for (const s of shows) {
    const imdb = s.show && s.show.ids && s.show.ids.imdb;
    if (!imdb) continue;
    for (const season of s.seasons || []) {
      for (const ep of season.episodes || []) {
        items.push({ contentId: imdb, type: 'series', season: season.number, episode: ep.number, title: s.show.title, watchedAt: Date.parse(ep.last_watched_at) || Date.now() });
      }
    }
  }
  return importWatched(items);
}

/** Paused playback on Trakt becomes Continue Watching entries (when newer than this device's). */
async function importPlayback() {
  const movies = (await api('/sync/playback/movies?extended=full')) || [];
  const episodes = (await api('/sync/playback/episodes?extended=full')) || [];
  for (const p of [...movies, ...episodes]) {
    const isEpisode = p.type === 'episode';
    const imdb = isEpisode ? p.show && p.show.ids && p.show.ids.imdb : p.movie && p.movie.ids && p.movie.ids.imdb;
    if (!imdb) continue;
    const season = isEpisode ? p.episode.season : null;
    const episode = isEpisode ? p.episode.number : null;
    const lastWatched = Date.parse(p.paused_at) || Date.now();
    const existing = getProgress(imdb, season, episode);
    if (existing && existing.lastWatched >= lastWatched) continue;
    const runtime = isEpisode ? p.episode.runtime || (p.show && p.show.runtime) : p.movie.runtime;
    const duration = (existing && existing.duration) || (runtime ? runtime * 60000 : 0);
    if (!duration) continue;
    saveProgress({
      contentId: imdb,
      contentType: isEpisode ? 'series' : 'movie',
      videoId: isEpisode ? `${imdb}:${season}:${episode}` : imdb,
      season,
      episode,
      position: Math.round((p.progress / 100) * duration),
      duration,
      lastWatched,
      title: isEpisode ? p.show.title : p.movie.title,
      episodeTitle: isEpisode ? p.episode.title || null : null,
    }, { keepTime: true });
  }
}

/**
 * Brings Trakt's watched history and paused progress into the app. Only what Trakt says changed
 * since the last sync is fetched, unless full.
 */
export async function syncTrakt({ full = false } = {}) {
  if (!traktConnected()) return;
  const account = traktAccount();
  try {
    const activities = await api('/sync/last_activities');
    const seen = full ? {} : account.activities || {};
    const changed = (...paths) => paths.some((p) => activity(activities, p) !== activity(seen, p));
    if (settings.get('traktImportHistory')) {
      if (changed('movies.watched_at', 'episodes.watched_at')) await importHistory();
      if (changed('movies.paused_at', 'episodes.paused_at')) await importPlayback();
    }
    if (changed('movies.watchlisted_at', 'shows.watchlisted_at')) lists.clear();
    updateAccount({ activities, lastSync: Date.now(), error: null });
  } catch (error) {
    updateAccount({ error: error.message });
    throw error;
  }
}

// ---------- Watchlist and recommendations on Home ----------

const lists = new Map(); // catalog id -> { at, promise }

const CATALOGS = [
  { type: 'movie', id: 'trakt-watchlist-movies', name: 'Trakt Watchlist', path: '/sync/watchlist/movies', kind: 'movie' },
  { type: 'series', id: 'trakt-watchlist-shows', name: 'Trakt Watchlist', path: '/sync/watchlist/shows', kind: 'show' },
  { type: 'movie', id: 'trakt-recommended-movies', name: 'Recommended on Trakt', path: '/recommendations/movies?limit=50&ignore_collected=true', kind: 'movie' },
  { type: 'series', id: 'trakt-recommended-shows', name: 'Recommended on Trakt', path: '/recommendations/shows?limit=50&ignore_collected=true', kind: 'show' },
];

function loadList(catalog) {
  const hit = lists.get(catalog.id);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.promise;
  const promise = api(catalog.path).then((rows) => {
    const sorted = catalog.path.includes('watchlist')
      ? [...(rows || [])].sort((a, b) => Date.parse(b.listed_at || 0) - Date.parse(a.listed_at || 0))
      : rows || [];
    return sorted.map((row) => row[catalog.kind] || row).filter((item) => item && item.ids && item.ids.imdb).map((item) => ({
      id: item.ids.imdb,
      type: catalog.type,
      name: item.title,
      releaseInfo: item.year ? String(item.year) : null,
      poster: poster(item.ids.imdb),
    }));
  });
  lists.set(catalog.id, { at: Date.now(), promise });
  promise.catch(() => lists.delete(catalog.id));
  return promise;
}

registerProvider(() => {
  if (!traktConnected() || !settings.get('traktHomeRows')) return [];
  return [{
    transportUrl: 'nuvio://trakt',
    manifest: {
      id: 'trakt',
      name: 'Trakt',
      version: '',
      types: ['movie', 'series'],
      resources: ['catalog'],
      catalogs: CATALOGS.map(({ type, id, name }) => ({ type, id, name, extra: [{ name: 'skip' }] })),
    },
    async handler(resource, type, id, extra) {
      const catalog = CATALOGS.find((c) => c.id === id);
      if (resource !== 'catalog' || !catalog) return {};
      const skip = Number(extra.skip) || 0;
      return { metas: (await loadList(catalog)).slice(skip, skip + PAGE) };
    },
  }];
});

events.on('settings', ({ name } = {}) => {
  if (name === 'traktHomeRows') providersChanged();
});

export function initTrakt() {
  const run = () => {
    if (!document.hidden && traktConnected()) syncTrakt().catch((error) => console.warn('Trakt sync failed', error.message));
  };
  setTimeout(run, 5000);
  setInterval(run, SYNC_EVERY_MS);
}
