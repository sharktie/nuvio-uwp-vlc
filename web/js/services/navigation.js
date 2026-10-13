// Shared "go to" actions used by several screens.

import { router } from '../core/router.js';
import { settings } from '../core/store.js';

export function openTitle(meta) {
  router.go(`details/${meta.type}/${encodeURIComponent(meta.id)}`, { preview: meta });
}

/** Opens the stream list for a movie (video null) or an episode. */
export function playVideo(meta, video, options = {}) {
  const videoId = video ? video.id : meta.id;
  router.go(`streams/${meta.type}/${encodeURIComponent(meta.id)}/${encodeURIComponent(videoId)}`, { meta, video, ...options });
}

/** Continue Watching: play the next episode, or resume with the last stream if we have it. */
export function resumeEntry(entry, { restart = false } = {}) {
  const meta = {
    id: entry.contentId,
    type: entry.contentType,
    name: entry.title,
    poster: entry.poster,
    background: entry.background,
    logo: entry.logo,
  };
  if (entry.nextUp && entry.next) {
    playVideo(meta, entry.next);
    return;
  }
  const video = entry.season != null
    ? { id: entry.videoId, season: entry.season, episode: entry.episode, name: entry.episodeTitle, thumbnail: entry.thumbnail }
    : null;
  if (!restart && settings.get('rememberLastStream') && entry.stream && entry.stream.url) {
    router.go('player', { meta, video, stream: entry.stream, fallbackToStreams: true });
    return;
  }
  playVideo(meta, video, { restart });
}
