// What the player is playing, from its "playback" events. Trakt and Jellyfin report playback
// themselves (scrobbles, session reports), so a watched mark that comes from playback mustn't be
// sent to them a second time as a manual one.

import { events } from '../core/store.js';
import { watchedKey } from './progress.js';

const RECENT_MS = 10 * 60 * 1000;
const recent = new Map(); // watched key -> last time it was playing

events.on('playback', (info) => {
  recent.set(watchedKey(info.contentId, info.season, info.episode), Date.now());
});

/** True while this title or episode is playing, and for a few minutes after it stops. */
export function playedRecently(contentId, season, episode) {
  const at = recent.get(watchedKey(contentId, season ?? null, episode ?? null));
  return !!at && Date.now() - at < RECENT_MS;
}

/** Position and length in seconds as a percentage, for scrobbling. */
export function percentOf(info) {
  if (!info.duration) return 0;
  return Math.max(0, Math.min(100, (info.position / info.duration) * 100));
}
