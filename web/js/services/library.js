// Saved titles ("Nuvio Library"). Items use the same fields as Nuvio's library sync.

import { events, storage, profileKey } from '../core/store.js';

let items = null;

function load() {
  if (!items) items = storage.get(profileKey('library'), {});
  return items;
}

function save(change) {
  storage.set(profileKey('library'), items);
  events.emit('library', change || {});
}

export function reloadLibrary() {
  items = null;
  load();
  events.emit('library', {});
}

export function libraryItems() {
  return Object.values(load()).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

export function inLibrary(id) {
  return !!load()[id];
}

export function libraryItemFromMeta(meta) {
  return {
    id: meta.id,
    type: meta.type,
    name: meta.name || '',
    poster: meta.poster || null,
    posterShape: (meta.posterShape || 'poster').toUpperCase(),
    background: meta.background || null,
    logo: meta.logo || null,
    description: meta.description || null,
    releaseInfo: meta.releaseInfo || (meta.year ? String(meta.year) : null),
    imdbRating: meta.imdbRating ? String(meta.imdbRating) : null,
    genres: meta.genres || meta.genre || [],
    addedAt: Date.now(),
  };
}

export function addToLibrary(meta) {
  load();
  items[meta.id] = libraryItemFromMeta(meta);
  save({ added: items[meta.id] });
}

export function removeFromLibrary(id) {
  load();
  const removed = items[id];
  if (!removed) return;
  delete items[id];
  save({ removed });
}

export function toggleLibrary(meta) {
  if (inLibrary(meta.id)) removeFromLibrary(meta.id);
  else addToLibrary(meta);
  return inLibrary(meta.id);
}

/** Replaces everything (account sync). */
export function replaceLibrary(list) {
  items = {};
  for (const item of list) items[item.id] = item;
  save({ replaced: true });
}
