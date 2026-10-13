// Watch progress (resume points, Continue Watching) and watched marks. Keys follow Nuvio:
// "tt123" for a movie, "tt123_s1e2" for an episode.

import { events, storage, profileKey } from '../core/store.js';

export const COMPLETED_FRACTION = 0.9;
const MIN_RESUME_MS = 30000;

let progress = null;
let watched = null;

function loadProgress() {
  if (!progress) progress = storage.get(profileKey('progress'), {});
  return progress;
}

function loadWatched() {
  if (!watched) watched = storage.get(profileKey('watched'), {});
  return watched;
}

export function reloadProgress() {
  progress = null;
  watched = null;
  events.emit('progress', {});
  events.emit('watched', {});
}

export function progressKey(contentId, season, episode) {
  return season != null && episode != null ? `${contentId}_s${season}e${episode}` : contentId;
}

export function watchedKey(contentId, season, episode) {
  return season != null && episode != null ? `${contentId}:${season}:${episode}` : contentId;
}

/** Parses a Stremio video id like "tt123:1:2" into its show id, season and episode. */
export function parseVideoId(videoId, type) {
  const parts = String(videoId).split(':');
  if (type === 'series' && parts.length >= 3) {
    const episode = Number(parts.pop());
    const season = Number(parts.pop());
    if (Number.isFinite(season) && Number.isFinite(episode)) return { contentId: parts.join(':'), season, episode };
  }
  return { contentId: videoId, season: null, episode: null };
}

export function getProgress(contentId, season, episode) {
  return loadProgress()[progressKey(contentId, season, episode)] || null;
}

export function isCompleted(entry) {
  return !!entry && entry.duration > 0 && entry.position / entry.duration >= COMPLETED_FRACTION;
}

/** Where to resume this video, in seconds (0 to start from the beginning). */
export function resumeSeconds(contentId, season, episode) {
  const entry = getProgress(contentId, season, episode);
  if (!entry || isCompleted(entry) || entry.position < MIN_RESUME_MS) return 0;
  return entry.position / 1000;
}

/**
 * Records progress. info: { contentId, contentType, videoId, season, episode, position (ms),
 * duration (ms), plus display fields (title, poster, background, logo, episodeTitle, thumbnail,
 * stream: { url, title, addonUrl, bingeGroup }) }.
 */
export function saveProgress(info, { important = false, keepTime = false } = {}) {
  loadProgress();
  const key = progressKey(info.contentId, info.season, info.episode);
  const previous = progress[key] || {};
  // keepTime: an import that already knows when it was watched.
  const lastWatched = keepTime && info.lastWatched ? info.lastWatched : Date.now();
  if (keepTime && previous.lastWatched > lastWatched) return previous;
  const entry = { ...previous, ...info, key, lastWatched };
  progress[key] = entry;
  storage.set(profileKey('progress'), progress);
  if (isCompleted(entry) && !isWatched(info.contentId, info.season, info.episode)) {
    markWatched(info.contentId, info.season, info.episode, true, { title: info.title, type: info.contentType });
  }
  // important: a pause, stop or finish, as opposed to the regular save during playback.
  events.emit('progress', { entry, important });
  return entry;
}

export function removeProgress(contentId) {
  loadProgress();
  const removed = [];
  for (const [key, entry] of Object.entries(progress)) {
    if (entry.contentId === contentId) {
      removed.push(entry);
      delete progress[key];
    }
  }
  storage.set(profileKey('progress'), progress);
  events.emit('progress', { removed });
}

export function allProgress() {
  return Object.values(loadProgress());
}

export function replaceProgress(entries) {
  progress = {};
  for (const entry of entries) progress[entry.key] = entry;
  storage.set(profileKey('progress'), progress);
  events.emit('progress', { replaced: true });
}

/**
 * Continue Watching: the latest entry per title. Unfinished ones resume; finished episodes of a
 * series are returned with nextUp set so the caller can look up the following episode.
 */
export function continueWatching() {
  const latest = new Map();
  for (const entry of allProgress()) {
    const current = latest.get(entry.contentId);
    if (!current || entry.lastWatched > current.lastWatched) latest.set(entry.contentId, entry);
  }
  const dismissed = storage.get(profileKey('cwDismissed'), {});
  return [...latest.values()]
    .filter((e) => !dismissed[e.contentId] || dismissed[e.contentId] < e.lastWatched)
    .map((e) => ({ ...e, nextUp: isCompleted(e) }))
    .filter((e) => (e.nextUp ? e.contentType === 'series' : e.position >= MIN_RESUME_MS))
    .sort((a, b) => b.lastWatched - a.lastWatched)
    .slice(0, 30);
}

export function dismissContinueWatching(contentId) {
  const dismissed = storage.get(profileKey('cwDismissed'), {});
  dismissed[contentId] = Date.now();
  storage.set(profileKey('cwDismissed'), dismissed);
  events.emit('progress', {});
}

// ---------- Watched ----------

export function isWatched(contentId, season, episode) {
  const map = loadWatched();
  if (map[watchedKey(contentId, season, episode)]) return true;
  return season == null && !!map[contentId];
}

export function markWatched(contentId, season, episode, value = true, { title = '', type = null } = {}) {
  loadWatched();
  const key = watchedKey(contentId, season, episode);
  if (value) watched[key] = { contentId, type: type || (season != null ? 'series' : null), season: season ?? null, episode: episode ?? null, watchedAt: Date.now(), title };
  else delete watched[key];
  storage.set(profileKey('watched'), watched);
  if (!value) {
    // Unwatching also clears the finished progress so it can be resumed or started again.
    const entry = getProgress(contentId, season, episode);
    if (entry && isCompleted(entry)) {
      delete progress[entry.key];
      storage.set(profileKey('progress'), progress);
      events.emit('progress', {});
    }
  }
  events.emit('watched', { contentId, season: season ?? null, episode: episode ?? null, value, title, type: type || (season != null ? 'series' : null) });
}

export function allWatched() {
  return Object.values(loadWatched());
}

/**
 * Adds watched marks from another service (Trakt history, a Jellyfin server) in one go. Marks
 * that already exist are kept, and the single event carries no title, so account sync and the
 * other integrations don't send them anywhere again. Returns how many were new.
 */
export function importWatched(items) {
  loadWatched();
  let added = 0;
  for (const item of items) {
    const key = watchedKey(item.contentId, item.season ?? null, item.episode ?? null);
    if (watched[key]) continue;
    watched[key] = {
      contentId: item.contentId,
      type: item.type || (item.season != null ? 'series' : 'movie'),
      season: item.season ?? null,
      episode: item.episode ?? null,
      watchedAt: item.watchedAt || Date.now(),
      title: item.title || '',
    };
    added++;
  }
  if (added) {
    storage.set(profileKey('watched'), watched);
    events.emit('watched', { imported: true });
  }
  return added;
}

export function replaceWatched(list) {
  watched = {};
  for (const item of list) watched[watchedKey(item.contentId, item.season, item.episode)] = item;
  storage.set(profileKey('watched'), watched);
  events.emit('watched', { replaced: true });
}
