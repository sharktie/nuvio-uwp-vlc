// Optional TMDB enrichment for the details screen: cast with photos, "More like this", and a logo
// or backdrop when the addon has none. Needs a TMDB key (Settings > Integrations, or built in via
// web/js/config.js); either a v3 API key or a v4 read access token works.

import config from '../config.js';
import { settings } from '../core/store.js';
import { getJson } from '../core/http.js';

const API = 'https://api.themoviedb.org/3';
const IMAGES = 'https://image.tmdb.org/t/p/';
const CACHE_MS = 6 * 60 * 60 * 1000;

export function tmdbKey() {
  return String(settings.get('tmdbApiKey') || config.tmdbApiKey || '').trim();
}

function request(path, params = {}) {
  const key = tmdbKey();
  const query = new URLSearchParams(params);
  const headers = {};
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  else query.set('api_key', key);
  return getJson(`${API}${path}?${query}`, { headers, ttl: CACHE_MS, timeout: 15000 });
}

const image = (size, path) => (path ? `${IMAGES}${size}${path}` : null);

/** TMDB extras for an addon meta with an IMDb id, or null if there's no key or no match. */
export async function tmdbExtras(meta) {
  const imdbId = String(meta.id || '').split(':')[0];
  if (!tmdbKey() || !/^tt\d+$/.test(imdbId)) return null;
  const found = await request(`/find/${imdbId}`, { external_source: 'imdb_id' });
  const preferTv = meta.type !== 'movie';
  const movie = (found.movie_results || [])[0];
  const tv = (found.tv_results || [])[0];
  const hit = preferTv ? tv || movie : movie || tv;
  if (!hit) return null;
  const kind = hit === movie ? 'movie' : 'tv';
  const details = await request(`/${kind}/${hit.id}`, {
    append_to_response: 'credits,recommendations,images',
    include_image_language: 'en,null',
  });
  const logos = (details.images && details.images.logos) || [];
  const logo = logos.find((l) => l.iso_639_1 === 'en') || logos[0];
  return {
    logo: logo ? image('w500', logo.file_path) : null,
    background: image('w1280', details.backdrop_path),
    cast: ((details.credits && details.credits.cast) || []).slice(0, 16).map((c) => ({
      name: c.name,
      character: c.character || '',
      photo: image('w185', c.profile_path),
    })),
    similar: ((details.recommendations && details.recommendations.results) || []).slice(0, 20).map((r) => ({
      tmdbId: r.id,
      kind,
      id: `tmdb:${kind}:${r.id}`,
      type: kind === 'movie' ? 'movie' : 'series',
      name: r.title || r.name || '',
      poster: image('w342', r.poster_path),
      background: image('w1280', r.backdrop_path),
      releaseInfo: String(r.release_date || r.first_air_date || '').slice(0, 4),
    })),
  };
}

/** The IMDb id addons use for a TMDB title (for opening a "More like this" pick). */
export async function imdbIdFor(kind, tmdbId) {
  const ids = await request(`/${kind}/${tmdbId}/external_ids`);
  return (ids && ids.imdb_id) || null;
}
