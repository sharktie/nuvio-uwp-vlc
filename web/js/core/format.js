// Display formatting.

export function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const hrs = Math.floor(seconds / 3600);
  const mm = hrs > 0 ? String(m).padStart(2, '0') : String(m);
  return (hrs > 0 ? hrs + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

/** "1h 12m left" from milliseconds. */
export function formatTimeLeft(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'Almost done';
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return (hrs ? `${hrs}h ${mins}m` : `${mins}m`) + ' left';
}

export function formatRuntime(runtime) {
  if (!runtime) return '';
  const text = String(runtime);
  const minutes = parseInt(text, 10);
  if (!Number.isFinite(minutes) || /h/i.test(text)) return text;
  const hrs = Math.floor(minutes / 60);
  return hrs ? `${hrs}h ${minutes % 60}m` : `${minutes}m`;
}

export function formatEpisodeCode(season, episode) {
  if (season == null || episode == null) return '';
  return `S${season} E${episode}`;
}

export function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "Airs today", "Airs in 3 days", or a date, for unreleased episodes. */
export function formatAirs(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Upcoming';
  const days = Math.ceil((date.setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 0) return 'Airs today';
  if (days === 1) return 'Airs tomorrow';
  if (days < 14) return `Airs in ${days} days`;
  return 'Airs ' + formatDate(value);
}

export function typeLabel(type) {
  return { movie: 'Movie', series: 'Series', channel: 'Channel', tv: 'TV', anime: 'Anime' }[type] || (type ? type[0].toUpperCase() + type.slice(1) : '');
}

export function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many || one + 's'}`;
}
