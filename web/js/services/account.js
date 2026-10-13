// Nuvio account: sign-in and sync of addons, library, watch progress and watched marks with a
// Nuvio server (the Supabase backend the Nuvio apps use; see NuvioMobile core/sync). A build can
// include a server to use by default (web/js/config.js); otherwise a self-hosted Nuvio server is
// found from its address (/.well-known/nuvio), or its URL and publishable key are entered directly.
//
// Like Nuvio's own apps, this stays gentle with the server: progress goes up at most once a minute
// while playing (straight away on pause or stop), and a "too many requests" answer pauses all
// requests for as long as the server asks (NuvioMobile core/network/BackendRateLimit.kt).

import { requestJson, HttpError } from '../core/http.js';
import config from '../config.js';
import { events, storage } from '../core/store.js';
import { bridge } from '../core/bridge.js';
import { listAddons, replaceAddons, addonName } from './addons.js';
import { libraryItems, replaceLibrary } from './library.js';
import { allProgress, replaceProgress, allWatched, replaceWatched, progressKey } from './progress.js';

const SERVER_KEY = 'server';
const SESSION_KEY = 'session';
const CLIENT_ID_KEY = 'syncClientId';
const PUSH_DEBOUNCE_MS = 1500;
const PROGRESS_PUSH_INTERVAL_MS = 60 * 1000;
const PULL_INTERVAL_MS = 15 * 60 * 1000;
const RESUME_PULL_AFTER_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 30 * 1000;
const OFFICIAL_LINK_URL = 'https://nuvio.tv/link';

let applyingRemote = false;
let pullTimer = 0;
let cooldownUntil = 0;
let lastProgressPush = 0;
const pending = { addons: false, library: new Map(), libraryDeletes: new Map(), progress: new Map(), progressDeletes: new Set(), watched: new Map(), watchedDeletes: new Map() };
let pushTimer = 0;

// ---------- Server ----------

/** The server built into this app, if any (see web/js/config.js). */
export function officialServer() {
  const official = config.officialServer;
  if (!official || !official.backendUrl || !official.publishableKey) return null;
  return {
    backendUrl: String(official.backendUrl).replace(/\/+$/, ''),
    publishableKey: String(official.publishableKey).trim(),
    emailPasswordAuth: true,
    tvLogin: true,
    linkUrl: official.linkUrl || OFFICIAL_LINK_URL,
    name: 'Nuvio',
    official: true,
  };
}

export function getServer() {
  return storage.get(SERVER_KEY, null) || officialServer();
}

export function setServer(server) {
  storage.set(SERVER_KEY, server || undefined);
  events.emit('account', {});
}

function normalizeUrl(value) {
  let url = String(value || '').trim();
  if (!url) throw new Error('Enter the server address.');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const parsed = new URL(url);
  return (parsed.origin + parsed.pathname).replace(/\/+$/, '');
}

/** Reads a self-hosted server's /.well-known/nuvio document. */
export async function discoverServer(address) {
  const base = normalizeUrl(address).replace(/\/\.well-known\/nuvio$/, '');
  const doc = await requestJson(`${base}/.well-known/nuvio`, { timeout: 15000 });
  if (!doc || doc.version !== 1 || String(doc.service).toLowerCase() !== 'nuvio') throw new Error('That address is not a Nuvio server.');
  if (!doc.backend_url || !doc.publishable_key) throw new Error('The server did not say how to connect to it.');
  return {
    backendUrl: normalizeUrl(doc.backend_url),
    publishableKey: String(doc.publishable_key).trim(),
    emailPasswordAuth: !!(doc.capabilities && doc.capabilities.email_password_auth),
    tvLogin: !!(doc.capabilities && doc.capabilities.tv_login),
    linkUrl: `${base}/link`,
    name: new URL(base).host,
  };
}

export function manualServer(url, key) {
  const backendUrl = normalizeUrl(url);
  if (!String(key || '').trim()) throw new Error('Enter the publishable key.');
  const official = /(^|\.)nuvio\.tv$|nuvioapp\.space$/i.test(new URL(backendUrl).host);
  return {
    backendUrl,
    publishableKey: String(key).trim(),
    emailPasswordAuth: true,
    tvLogin: true,
    linkUrl: official ? OFFICIAL_LINK_URL : `${backendUrl}/link`,
    name: new URL(backendUrl).host,
  };
}

// ---------- Session ----------

export function getSession() {
  return storage.get(SESSION_KEY, null);
}

function saveSession(data) {
  const session = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    user: data.user ? { id: data.user.id, email: data.user.email || null } : (getSession() || {}).user || null,
  };
  storage.set(SESSION_KEY, session);
  events.emit('account', {});
  return session;
}

export function isSignedIn() {
  return !!(getServer() && getSession());
}

function clientId() {
  let id = storage.get(CLIENT_ID_KEY, null);
  if (!id) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    id = 'nuvio-uwp-' + Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    storage.set(CLIENT_ID_KEY, id);
  }
  return id;
}

function headers(token) {
  const server = getServer();
  return {
    apikey: server.publishableKey,
    Authorization: `Bearer ${token || server.publishableKey}`,
    'X-Client-Info': 'nuvio-uwp/1.0',
  };
}

/**
 * Runs a request to the Nuvio server, waiting out any cooldown first. A 429 (or a 503 that says
 * when to come back) starts a cooldown for every request, as long as the server asks or with
 * backoff otherwise; the request is then retried a couple of times.
 */
async function backend(doRequest) {
  for (let attempt = 0; ; attempt++) {
    const wait = cooldownUntil - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await doRequest();
    } catch (error) {
      const limited = error instanceof HttpError && (error.status === 429 || (error.status === 503 && error.retryAfter != null));
      if (!limited) throw error;
      const delay = error.retryAfter != null ? error.retryAfter * 1000 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
      cooldownUntil = Math.max(cooldownUntil, Date.now() + delay + Math.random() * 1000);
      if (attempt >= 2) throw error;
    }
  }
}

async function accessToken() {
  const session = getSession();
  if (!session) throw new Error('Not signed in');
  if (session.expiresAt - Date.now() > 60000) return session.accessToken;
  const server = getServer();
  try {
    const data = await backend(() => requestJson(`${server.backendUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: headers(),
      body: { refresh_token: session.refreshToken },
    }));
    return saveSession(data).accessToken;
  } catch (error) {
    if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 429) {
      // The refresh token was revoked: the user has to sign in again.
      storage.set(SESSION_KEY, undefined);
      events.emit('account', { signedOut: true });
    }
    throw error;
  }
}

async function rpc(name, params = {}, { anonymous = false } = {}) {
  const server = getServer();
  if (!server) throw new Error('No Nuvio server is set up.');
  const token = anonymous ? null : await accessToken();
  return backend(() => requestJson(`${server.backendUrl}/rest/v1/rpc/${name}`, { method: 'POST', headers: headers(token), body: params }));
}

async function select(table, query) {
  const server = getServer();
  const token = await accessToken();
  return backend(() => requestJson(`${server.backendUrl}/rest/v1/${table}?${query}`, { headers: headers(token) }));
}

export async function signInWithEmail(email, password) {
  const server = getServer();
  const data = await backend(() => requestJson(`${server.backendUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: headers(),
    body: { email: email.trim(), password },
  }));
  saveSession(data);
  await afterSignIn();
}

export async function signOut() {
  const server = getServer();
  const session = getSession();
  if (server && session) {
    requestJson(`${server.backendUrl}/auth/v1/logout`, { method: 'POST', headers: headers(session.accessToken) }).catch(() => {});
  }
  storage.set(SESSION_KEY, undefined);
  storage.set('profiles', undefined);
  clearInterval(pullTimer);
  events.emit('account', { signedOut: true });
}

/**
 * Sign in on the TV by approving a code on another device. onCode({ code, url }) is called once
 * the code is ready; resolves once signed in. signal (AbortSignal) cancels.
 */
export async function signInWithCode(onCode, signal) {
  const server = getServer();
  const nonce = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
  const deviceName = bridge.platform === 'xbox' ? 'Xbox' : bridge.native ? 'Windows' : 'Web browser';
  const started = (await rpc('start_device_login_session', {
    p_device_nonce: nonce,
    p_redirect_base_url: server.linkUrl || OFFICIAL_LINK_URL,
    p_device_name: `Nuvio UWP (${deviceName})`,
    p_device_type: 'tv',
  }, { anonymous: true }) || [])[0];
  if (!started || !started.device_code || !started.user_code) throw new Error('Could not start sign-in.');
  const code = String(started.user_code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  onCode({ code: code.length > 3 ? `${code.slice(0, 3)}-${code.slice(3)}` : code, url: started.verification_uri_complete, linkUrl: server.linkUrl || OFFICIAL_LINK_URL });
  const interval = Math.min(10, Math.max(2, Number(started.poll_interval_seconds) || 3)) * 1000;
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    if (signal && signal.aborted) throw new Error('Cancelled');
    let status;
    try {
      status = String(((await rpc('poll_tv_login_session', { p_code: started.device_code, p_device_nonce: nonce }, { anonymous: true }) || [])[0] || {}).status || '').toLowerCase();
    } catch {
      continue;
    }
    if (status === 'pending') continue;
    if (status !== 'approved') throw new Error('This code expired. Try again.');
    const data = await backend(() => requestJson(`${server.backendUrl}/functions/v1/tv-logins-exchange`, {
      method: 'POST',
      headers: headers(),
      body: { code: started.device_code, device_nonce: nonce },
    }));
    saveSession(data);
    await afterSignIn();
    return;
  }
  throw new Error('This code expired. Try again.');
}

// ---------- Profiles ----------

export function cachedProfiles() {
  return storage.get('profiles', []);
}

export async function pullProfiles() {
  const profiles = (await rpc('sync_pull_profiles')) || [];
  profiles.sort((a, b) => a.profile_index - b.profile_index);
  storage.set('profiles', profiles);
  return profiles;
}

export function activeProfileIndex() {
  return storage.get('activeProfile', 1);
}

export async function verifyProfilePin(index, pin) {
  const result = ((await rpc('verify_profile_pin', { p_profile_id: index, p_pin: pin })) || [])[0] || {};
  return { unlocked: !!result.unlocked, message: result.message || null, retryAfter: result.retry_after_seconds || 0 };
}

/** Switches profile: each profile keeps its own addons, library and progress. Reloads the app. */
export function switchProfile(index) {
  storage.set('activeProfile', index);
  location.hash = '#/home';
  location.reload();
}

function addonsProfileIndex() {
  const index = activeProfileIndex();
  const profile = cachedProfiles().find((p) => p.profile_index === index);
  return profile && profile.uses_primary_addons ? 1 : index;
}

// ---------- Sync ----------

async function afterSignIn() {
  await pullProfiles().catch(() => {});
  await pullAll();
  startBackgroundSync();
}

/** Replaces local addons, library, progress and watched marks with the account's. */
export async function pullAll() {
  if (!isSignedIn()) return;
  const profile = activeProfileIndex();
  const [addonRows, library, progress, watched] = await Promise.all([
    select('addons', `select=url,name,enabled,sort_order&profile_id=eq.${addonsProfileIndex()}&order=sort_order.asc`).catch(() => null),
    pullPaged((limit, offset) => rpc('sync_pull_library', { p_profile_id: profile, p_limit: limit, p_offset: offset })).catch(() => null),
    rpc('sync_pull_watch_progress', { p_profile_id: profile }).catch(() => null),
    pullPaged((limit, offset) => rpc('sync_pull_watched_items', { p_profile_id: profile, p_page: offset / limit + 1, p_page_size: limit })).catch(() => null),
  ]);
  applyingRemote = true;
  try {
    if (addonRows && addonRows.length) {
      const seen = new Set();
      await replaceAddons(addonRows.filter((r) => r.url && !seen.has(r.url) && seen.add(r.url)).map((r) => ({ url: r.url, enabled: r.enabled !== false })));
    }
    if (library) replaceLibrary(library.map(libraryFromRow));
    if (progress) mergeProgress(progress);
    if (watched) mergeWatched(watched);
  } finally {
    applyingRemote = false;
  }
  storage.set('lastSync', Date.now());
  events.emit('account', { synced: true });
}

async function pullPaged(fetchPage, limit = 500) {
  const all = [];
  for (let offset = 0; offset < 20000; offset += limit) {
    const page = (await fetchPage(limit, offset)) || [];
    all.push(...page);
    if (page.length < limit) break;
  }
  return all;
}

function libraryFromRow(row) {
  return {
    id: row.content_id,
    type: row.content_type,
    name: row.name || '',
    poster: row.poster || null,
    posterShape: row.poster_shape || 'POSTER',
    background: row.background || null,
    logo: row.logo || null,
    description: row.description || null,
    releaseInfo: row.release_info || null,
    imdbRating: row.imdb_rating != null ? String(row.imdb_rating) : null,
    genres: row.genres || [],
    addonBaseUrl: row.addon_base_url || null,
    addedAt: row.added_at || Date.now(),
  };
}

function libraryToRow(item) {
  return {
    content_id: item.id,
    content_type: item.type,
    name: item.name || '',
    poster: item.poster || null,
    poster_shape: (item.posterShape || 'POSTER').toUpperCase(),
    background: item.background || null,
    logo: item.logo || null,
    description: item.description || null,
    release_info: item.releaseInfo || null,
    imdb_rating: item.imdbRating ? Number(item.imdbRating) || null : null,
    genres: item.genres || [],
    addon_base_url: item.addonBaseUrl || null,
    added_at: item.addedAt || Date.now(),
  };
}

// Newer entry wins; local display details (titles, artwork, last stream) are kept.
function mergeProgress(rows) {
  const local = new Map(allProgress().map((e) => [e.key, e]));
  for (const row of rows) {
    const key = row.progress_key || progressKey(row.content_id, row.season ?? null, row.episode ?? null);
    const mine = local.get(key);
    if (mine && mine.lastWatched >= epochMs(row.last_watched)) continue;
    local.set(key, {
      ...(mine || {}),
      key,
      contentId: row.content_id,
      contentType: row.content_type,
      videoId: row.video_id || row.content_id,
      season: row.season ?? null,
      episode: row.episode ?? null,
      position: row.position || 0,
      duration: row.duration || 0,
      lastWatched: epochMs(row.last_watched),
    });
  }
  replaceProgress([...local.values()]);
}

// Timestamps may come as seconds or milliseconds.
function epochMs(value) {
  const n = Number(value) || Date.now();
  return n < 1e12 ? n * 1000 : n;
}

function mergeWatched(rows) {
  const local = new Map(allWatched().map((w) => [`${w.contentId}:${w.season}:${w.episode}`, w]));
  for (const row of rows) {
    const item = { contentId: row.content_id, type: row.content_type || null, season: row.season ?? null, episode: row.episode ?? null, watchedAt: epochMs(row.watched_at), title: row.title || '' };
    local.set(`${item.contentId}:${item.season}:${item.episode}`, item);
  }
  replaceWatched([...local.values()]);
}

let progressTimer = 0;
let retryTimer = 0;

function schedulePush(delay = PUSH_DEBOUNCE_MS) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => push().catch((error) => console.warn('Sync push failed', error)), delay);
}

// Progress saved every few seconds during playback goes up at most once a minute; a save that
// matters (pause, stop, finished) goes straight away.
function scheduleProgressPush(important) {
  const due = lastProgressPush + PROGRESS_PUSH_INTERVAL_MS - Date.now();
  if (important || due <= PUSH_DEBOUNCE_MS) {
    clearTimeout(progressTimer);
    progressTimer = 0;
    schedulePush();
  } else if (!progressTimer) {
    progressTimer = setTimeout(() => {
      progressTimer = 0;
      schedulePush(0);
    }, due);
  }
}

async function push() {
  if (!isSignedIn()) return;
  const profile = activeProfileIndex();
  const origin = { p_origin_client_id: clientId() };
  const jobs = [];
  // A failed send goes back in the queue (unless something newer replaced it) and is retried.
  const send = (name, params, restore) => jobs.push(rpc(name, { p_profile_id: profile, ...params, ...origin }).catch((error) => {
    restore();
    throw error;
  }));
  if (pending.addons) {
    pending.addons = false;
    if (addonsProfileIndex() === profile) {
      send('sync_push_addons', {
        p_addons: listAddons().map((a, i) => ({ url: a.transportUrl, name: addonName(a), enabled: a.enabled !== false, sort_order: i })),
      }, () => (pending.addons = true));
    }
  }
  const takeAll = (map) => {
    const entries = [...map.entries()];
    map.clear();
    return entries;
  };
  const putBack = (map, entries) => () => entries.forEach(([key, value]) => !map.has(key) && map.set(key, value));
  if (pending.library.size) {
    const items = takeAll(pending.library);
    send('sync_push_library_items', { p_items: items.map(([, item]) => libraryToRow(item)) }, putBack(pending.library, items));
  }
  if (pending.libraryDeletes.size) {
    const keys = takeAll(pending.libraryDeletes);
    send('sync_delete_library_items', { p_keys: keys.map(([, key]) => key) }, putBack(pending.libraryDeletes, keys));
  }
  if (pending.progress.size) {
    lastProgressPush = Date.now();
    const entries = takeAll(pending.progress);
    send('sync_push_watch_progress', {
      p_entries: entries.map(([, e]) => ({
        content_id: e.contentId,
        content_type: e.contentType,
        video_id: e.videoId || e.contentId,
        season: e.season ?? null,
        episode: e.episode ?? null,
        position: Math.round(e.position || 0),
        duration: Math.round(e.duration || 0),
        last_watched: e.lastWatched || Date.now(),
        progress_key: e.key,
      })),
    }, putBack(pending.progress, entries));
  }
  if (pending.progressDeletes.size) {
    const keys = [...pending.progressDeletes];
    pending.progressDeletes.clear();
    send('sync_delete_watch_progress', { p_keys: keys }, () => keys.forEach((k) => pending.progressDeletes.add(k)));
  }
  if (pending.watched.size) {
    const items = takeAll(pending.watched);
    send('sync_push_watched_items', { p_items: items.map(([, item]) => item) }, putBack(pending.watched, items));
  }
  if (pending.watchedDeletes.size) {
    const keys = takeAll(pending.watchedDeletes);
    send('sync_delete_watched_items', { p_keys: keys.map(([, key]) => key) }, putBack(pending.watchedDeletes, keys));
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    console.warn('Some sync pushes failed; retrying in a minute', failed.map((f) => f.reason && f.reason.message));
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => schedulePush(0), Math.max(60000, cooldownUntil - Date.now()));
  }
}

function startBackgroundSync() {
  clearInterval(pullTimer);
  pullTimer = setInterval(() => {
    if (!document.hidden) pullAll().catch((error) => console.warn('Sync pull failed', error));
  }, PULL_INTERVAL_MS);
}

/** Called once at startup: watch local changes and pull the account's data. */
export function initAccountSync() {
  events.on('addons', () => {
    if (applyingRemote || !isSignedIn()) return;
    pending.addons = true;
    schedulePush();
  });
  events.on('library', (change) => {
    if (applyingRemote || !isSignedIn() || !change) return;
    if (change.added) {
      pending.libraryDeletes.delete(change.added.id);
      pending.library.set(change.added.id, change.added);
    }
    if (change.removed) {
      pending.library.delete(change.removed.id);
      pending.libraryDeletes.set(change.removed.id, { content_id: change.removed.id, content_type: change.removed.type });
    }
    schedulePush();
  });
  events.on('progress', (change) => {
    if (applyingRemote || !isSignedIn() || !change) return;
    if (change.entry) pending.progress.set(change.entry.key, change.entry);
    for (const entry of change.removed || []) {
      pending.progress.delete(entry.key);
      pending.progressDeletes.add(entry.key);
    }
    if (change.entry && !(change.removed || []).length) scheduleProgressPush(!!change.important);
    else schedulePush();
  });
  events.on('watched', (change) => {
    if (applyingRemote || !isSignedIn() || !change || !change.contentId) return;
    const key = `${change.contentId}:${change.season}:${change.episode}`;
    if (change.value) {
      pending.watchedDeletes.delete(key);
      const meta = libraryItems().find((i) => i.id === change.contentId);
      pending.watched.set(key, {
        content_id: change.contentId,
        content_type: change.type || (change.season != null ? 'series' : (meta ? meta.type : 'movie')),
        title: change.title || (meta ? meta.name : ''),
        season: change.season ?? null,
        episode: change.episode ?? null,
        watched_at: Date.now(),
      });
    } else {
      pending.watched.delete(key);
      pending.watchedDeletes.set(key, { content_id: change.contentId, season: change.season ?? null, episode: change.episode ?? null });
    }
    schedulePush();
  });
  // Push what's pending before the app goes to the background.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(pushTimer);
      push().catch(() => {});
    } else if (isSignedIn() && Date.now() - storage.get('lastSync', 0) > RESUME_PULL_AFTER_MS) {
      pullAll().catch(() => {});
    }
  });
  if (isSignedIn()) {
    pullAll().catch((error) => console.warn('Sync pull failed', error));
    startBackgroundSync();
  }
}
