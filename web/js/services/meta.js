// Helpers for addon metadata: episodes, seasons, next episode, what to play.

import { fetchMeta } from './addons.js';
import { allProgress, isCompleted, isWatched } from './progress.js';

export { fetchMeta };

export function isReleased(video) {
  if (!video || !video.released) return true;
  const date = new Date(video.released);
  return Number.isNaN(date.getTime()) || date.getTime() <= Date.now();
}

/** Episodes in order, with season/episode numbers filled in. */
export function sortedVideos(meta) {
  return (meta.videos || [])
    .filter((v) => v && v.id)
    .map((v) => ({ ...v, season: Number(v.season ?? 0), episode: Number(v.episode ?? v.number ?? 0) }))
    .sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
}

/** Season numbers, regular seasons first and specials (0) last. */
export function seasonsOf(meta) {
  const seasons = [...new Set(sortedVideos(meta).map((v) => v.season))];
  return seasons.filter((s) => s > 0).concat(seasons.filter((s) => s === 0));
}

export function nextEpisode(meta, season, episode) {
  const videos = sortedVideos(meta).filter((v) => v.season > 0);
  const index = videos.findIndex((v) => v.season === season && v.episode === episode);
  if (index < 0) return null;
  return videos[index + 1] || null;
}

export function firstEpisode(meta) {
  const videos = sortedVideos(meta);
  return videos.find((v) => v.season > 0) || videos[0] || null;
}

/**
 * What the Play button should play for a series: the episode in progress, the one after the
 * last finished one, or the first episode.
 */
export function upNext(meta) {
  const entries = allProgress().filter((e) => e.contentId === meta.id && e.season != null);
  entries.sort((a, b) => b.lastWatched - a.lastWatched);
  const latest = entries[0];
  if (latest) {
    if (!isCompleted(latest)) {
      const video = sortedVideos(meta).find((v) => v.season === latest.season && v.episode === latest.episode);
      if (video) return { video, resume: true, entry: latest };
    }
    const next = nextEpisode(meta, latest.season, latest.episode);
    if (next) return { video: next, resume: false };
  }
  // Nothing in progress: the first episode not marked watched.
  const unwatched = sortedVideos(meta).find((v) => v.season > 0 && !isWatched(meta.id, v.season, v.episode));
  return { video: unwatched || firstEpisode(meta), resume: false };
}

/** The year or year range shown for a title. */
export function yearText(meta) {
  return meta.releaseInfo || (meta.year ? String(meta.year) : '');
}

export function genresOf(meta) {
  return meta.genres || meta.genre || [];
}
