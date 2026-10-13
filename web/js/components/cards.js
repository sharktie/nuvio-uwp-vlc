import { h, icon, img } from '../core/dom.js';
import { formatTimeLeft, formatEpisodeCode } from '../core/format.js';

/** A poster for a catalog item (meta preview). */
export function posterCard(meta, { onClick, watched = false, progress = 0 } = {}) {
  const shape = (meta.posterShape || 'poster').toLowerCase();
  return h('button', {
    class: ['card', 'poster-card', 'focusable', `shape-${shape}`],
    type: 'button',
    title: meta.name,
    onClick: (e) => {
      e.preventDefault();
      if (onClick) onClick(meta);
    },
  },
  h('div', { class: 'card-art' },
    h('div', { class: 'card-fallback' }, meta.name),
    img(meta.poster, { class: 'card-img' }),
    watched && h('span', { class: 'card-watched' }, icon('check')),
    progress > 0 && h('div', { class: 'card-progress' }, h('span', { style: { width: `${Math.min(100, progress * 100)}%` } }))),
  h('div', { class: 'card-title' }, meta.name));
}

/** A Continue Watching card: backdrop, logo, progress and what's next. */
export function continueCard(entry, { onClick } = {}) {
  const fraction = entry.duration > 0 ? entry.position / entry.duration : 0;
  const episode = entry.season != null ? formatEpisodeCode(entry.season, entry.episode) : null;
  const sub = entry.nextUp
    ? `Next Up${entry.next ? ' · ' + formatEpisodeCode(entry.next.season, entry.next.episode) : ''}`
    : [episode, formatTimeLeft(entry.duration - entry.position)].filter(Boolean).join(' · ');
  return h('button', {
    class: ['card', 'wide-card', 'focusable'],
    type: 'button',
    onClick: (e) => {
      e.preventDefault();
      if (onClick) onClick(entry);
    },
  },
  h('div', { class: 'card-art' },
    h('div', { class: 'card-fallback' }, entry.title || ''),
    img((entry.nextUp && entry.next && entry.next.thumbnail) || entry.thumbnail || entry.background || entry.poster, { class: 'card-img' }),
    h('div', { class: 'card-shade' }),
    entry.logo ? img(entry.logo, { class: 'card-logo' }) : h('div', { class: 'card-logo-text' }, entry.title || ''),
    !entry.nextUp && fraction > 0 && h('div', { class: 'card-progress' }, h('span', { style: { width: `${Math.min(100, fraction * 100)}%` } })),
    entry.nextUp && h('span', { class: 'card-tag' }, entry.next && entry.next.isNew ? 'New Episode' : 'Next Up')),
  h('div', { class: 'card-caption' },
    h('span', { class: 'card-title' }, entry.title || ''),
    h('span', { class: 'card-sub' }, sub)));
}

/** An episode in the details screen. */
export function episodeCard(video, { onClick, watched, progress, unreleased } = {}) {
  const code = formatEpisodeCode(video.season, video.episode);
  return h('button', {
    class: ['card', 'episode-card', 'focusable', unreleased && 'unreleased'],
    type: 'button',
    onClick: (e) => {
      e.preventDefault();
      if (onClick) onClick(video);
    },
  },
  h('div', { class: 'card-art' },
    h('div', { class: 'card-fallback' }, code),
    img(video.thumbnail, { class: 'card-img' }),
    watched && h('span', { class: 'card-watched' }, icon('check')),
    progress > 0 && !watched && h('div', { class: 'card-progress' }, h('span', { style: { width: `${Math.min(100, progress * 100)}%` } })),
    unreleased && h('span', { class: 'card-tag' }, unreleased)),
  h('div', { class: 'card-caption' },
    h('span', { class: 'card-sub' }, `E${video.episode}`),
    h('span', { class: 'card-title' }, video.name || video.title || `Episode ${video.episode}`),
    (video.overview || video.description) && h('span', { class: 'card-overview' }, video.overview || video.description)));
}

/** "View all" at the end of a row. */
export function viewAllCard({ onClick, shape = 'poster' }) {
  return h('button', {
    class: ['card', 'poster-card', 'view-all-card', 'focusable', `shape-${shape}`],
    type: 'button',
    onClick: (e) => {
      e.preventDefault();
      onClick();
    },
  }, h('div', { class: 'card-art' }, icon('chevron-right'), h('span', null, 'View All')));
}

export function skeletonCards(count, shape = 'poster') {
  return Array.from({ length: count }, () => h('div', { class: ['card', 'poster-card', 'skeleton', `shape-${shape}`] }, h('div', { class: 'card-art' })));
}
