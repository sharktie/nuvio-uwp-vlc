// Stremio addon protocol client: manifests, catalogs, metadata, streams and subtitles.
// https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md

import { getJson, HttpError } from '../core/http.js';
import { events, storage, profileKey } from '../core/store.js';

export const DEFAULT_ADDON_URLS = [
  'https://v3-cinemeta.strem.io/manifest.json',
  'https://opensubtitles-v3.strem.io/manifest.json',
];
const MANIFEST_REFRESH_MS = 6 * 60 * 60 * 1000;
const STREAM_TIMEOUT_MS = 30000;

let addons = null;

function load() {
  if (addons) return addons;
  addons = storage.get(profileKey('addons'), null);
  return addons;
}

function save() {
  storage.set(profileKey('addons'), addons);
  events.emit('addons', addons);
}

/** Reloads from storage, e.g. after switching profile or a sync pull. */
export function reloadAddons() {
  addons = null;
  load();
  events.emit('addons', addons);
}

export function normalizeAddonUrl(input) {
  let url = String(input || '').trim();
  if (!url) throw new Error('Enter an addon URL');
  url = url.replace(/^stremio:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const parsed = new URL(url);
  if (!/\/manifest\.json$/i.test(parsed.pathname)) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/manifest.json';
  }
  return parsed.toString();
}

export function addonBaseUrl(transportUrl) {
  const parsed = new URL(transportUrl);
  parsed.pathname = parsed.pathname.replace(/\/manifest\.json$/i, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

export async function fetchManifest(transportUrl) {
  const manifest = await getJson(transportUrl, { ttl: 0, timeout: 20000 });
  for (const field of ['id', 'name', 'version']) {
    if (!manifest || !manifest[field]) throw new Error(`Manifest missing "${field}"`);
  }
  if (!Array.isArray(manifest.resources)) manifest.resources = [];
  if (!Array.isArray(manifest.types)) manifest.types = [];
  if (!Array.isArray(manifest.catalogs)) manifest.catalogs = [];
  return manifest;
}

/** First run: install the default addons. */
export async function ensureDefaultAddons() {
  if (load()) return;
  addons = [];
  await Promise.all(DEFAULT_ADDON_URLS.map(async (url) => {
    try {
      const manifest = await fetchManifest(url);
      addons.push({ transportUrl: url, manifest, enabled: true, refreshedAt: Date.now() });
    } catch (error) {
      console.warn('Default addon failed to install', url, error);
    }
  }));
  addons.sort((a, b) => DEFAULT_ADDON_URLS.indexOf(a.transportUrl) - DEFAULT_ADDON_URLS.indexOf(b.transportUrl));
  save();
}

export function listAddons() {
  return load() || [];
}

// Built-in sources (Jellyfin/Emby servers, Trakt) that work like addons: they have a manifest and
// answer catalog, meta and stream requests, but in code. They aren't in the addon list, so they
// don't sync to the Nuvio account. Each provider is a function returning its current addons.
const providers = [];

export function registerProvider(getAddons) {
  providers.push(getAddons);
}

function providerAddons() {
  return providers.flatMap((get) => {
    try {
      return get() || [];
    } catch (error) {
      console.warn('Provider failed', error);
      return [];
    }
  });
}

/** Tells screens that the built-in sources changed (connected, disconnected, new libraries). */
export function providersChanged() {
  events.emit('addons', addons);
}

/** Built-in sources first, then the installed addons in their order. */
export function enabledAddons() {
  return [...providerAddons(), ...listAddons().filter((addon) => addon.enabled !== false && addon.manifest)];
}

/** One addon request: over HTTP, or answered in code by a built-in source. */
function request(addon, resource, type, id, extra, options) {
  if (addon.handler) return addon.handler(resource, type, id, extra || {});
  return getJson(resourceUrl(addon, resource, type, id, extra), options);
}

export async function installAddon(input) {
  const transportUrl = normalizeAddonUrl(input);
  load();
  addons = addons || [];
  if (addons.some((a) => a.transportUrl === transportUrl)) throw new Error('That addon is already installed.');
  const manifest = await fetchManifest(transportUrl);
  addons.push({ transportUrl, manifest, enabled: true, refreshedAt: Date.now() });
  save();
  return manifest;
}

/** Adds addons that aren't installed yet (e.g. from a Stremio account), keeping the existing ones. */
export function mergeAddons(entries) {
  load();
  addons = addons || [];
  const known = new Set(addons.map((a) => a.transportUrl));
  for (const { transportUrl, manifest } of entries) {
    if (known.has(transportUrl)) continue;
    known.add(transportUrl);
    if (!Array.isArray(manifest.resources)) manifest.resources = [];
    if (!Array.isArray(manifest.types)) manifest.types = [];
    if (!Array.isArray(manifest.catalogs)) manifest.catalogs = [];
    addons.push({ transportUrl, manifest, enabled: true, refreshedAt: Date.now() });
  }
  save();
}

export function removeAddon(transportUrl) {
  addons = listAddons().filter((a) => a.transportUrl !== transportUrl);
  save();
}

export function moveAddon(transportUrl, delta) {
  const list = [...listAddons()];
  const index = list.findIndex((a) => a.transportUrl === transportUrl);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= list.length) return;
  const [item] = list.splice(index, 1);
  list.splice(target, 0, item);
  addons = list;
  save();
}

export function setAddonEnabled(transportUrl, enabled) {
  addons = listAddons().map((a) => (a.transportUrl === transportUrl ? { ...a, enabled } : a));
  save();
}

/** Replaces the whole list, keeping manifests already known (used by account sync). */
export async function replaceAddons(entries) {
  const known = new Map(listAddons().map((a) => [a.transportUrl, a]));
  const next = await Promise.all(entries.map(async ({ url, enabled }) => {
    const transportUrl = normalizeAddonUrl(url);
    const existing = known.get(transportUrl);
    if (existing && existing.manifest) return { ...existing, enabled: enabled !== false };
    try {
      return { transportUrl, manifest: await fetchManifest(transportUrl), enabled: enabled !== false, refreshedAt: Date.now() };
    } catch (error) {
      console.warn('Addon unavailable', transportUrl, error);
      return { transportUrl, manifest: null, enabled: enabled !== false, error: error.message };
    }
  }));
  addons = next;
  save();
}

export async function refreshAddon(transportUrl) {
  const manifest = await fetchManifest(transportUrl);
  addons = listAddons().map((a) => (a.transportUrl === transportUrl ? { ...a, manifest, refreshedAt: Date.now(), error: null } : a));
  save();
}

/** Re-reads manifests that are more than a few hours old, in the background. */
export function refreshStaleManifests() {
  for (const addon of listAddons()) {
    if (Date.now() - (addon.refreshedAt || 0) < MANIFEST_REFRESH_MS) continue;
    refreshAddon(addon.transportUrl).catch((error) => console.warn('Manifest refresh failed', addon.transportUrl, error));
  }
}

export function addonName(addon) {
  return (addon.manifest && addon.manifest.name) || new URL(addon.transportUrl).host;
}

/** Whether an addon serves a resource ("meta", "stream", "subtitles") for this type and id. */
export function addonSupports(addon, resource, type, id) {
  const manifest = addon.manifest;
  if (!manifest) return false;
  const entry = manifest.resources.find((r) => (typeof r === 'string' ? r : r && r.name) === resource);
  if (!entry) return false;
  const types = (typeof entry === 'object' && entry.types) || manifest.types || [];
  if (type && types.length && !types.includes(type)) return false;
  const prefixes = (typeof entry === 'object' && entry.idPrefixes) || manifest.idPrefixes;
  if (id && Array.isArray(prefixes) && prefixes.length && !prefixes.some((p) => id.startsWith(p))) return false;
  return true;
}

export function resourceUrl(addon, resource, type, id, extra) {
  let url = `${addonBaseUrl(addon.transportUrl)}/${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
  const pairs = Object.entries(extra || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (pairs.length) url += '/' + pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return url + '.json';
}

// ---------- Catalogs ----------

function catalogExtras(catalog) {
  if (Array.isArray(catalog.extra)) return catalog.extra;
  // Old manifests list extras as extraSupported / extraRequired names.
  const required = catalog.extraRequired || [];
  return (catalog.extraSupported || []).map((name) => ({ name, isRequired: required.includes(name) }));
}

export function catalogExtra(catalog, name) {
  return catalogExtras(catalog).find((e) => e.name === name) || null;
}

/** Every catalog of the enabled addons, as { addon, catalog, key }. */
export function allCatalogs() {
  const result = [];
  for (const addon of enabledAddons()) {
    for (const catalog of addon.manifest.catalogs || []) {
      if (!catalog || !catalog.type || !catalog.id) continue;
      result.push({ addon, catalog, key: `${addon.transportUrl}|${catalog.type}|${catalog.id}` });
    }
  }
  return result;
}

/** Catalogs that can be shown as a row without extra input (no required search or genre). */
export function homeCatalogs() {
  return allCatalogs().filter(({ catalog }) => !catalogExtras(catalog).some((e) => e.isRequired));
}

export function searchCatalogs() {
  return allCatalogs().filter(({ catalog }) => {
    const extras = catalogExtras(catalog);
    return extras.some((e) => e.name === 'search') && !extras.some((e) => e.isRequired && e.name !== 'search');
  });
}

export function findCatalog(transportUrl, type, id) {
  return allCatalogs().find(({ addon, catalog }) => addon.transportUrl === transportUrl && catalog.type === type && catalog.id === id) || null;
}

export async function fetchCatalog(addon, catalog, { skip, genre, search } = {}) {
  const extra = {};
  if (search) extra.search = search;
  if (genre) extra.genre = genre;
  if (skip) extra.skip = skip;
  const data = await request(addon, 'catalog', catalog.type, catalog.id, extra, { ttl: search ? 2 * 60 * 1000 : 30 * 60 * 1000 });
  return ((data && data.metas) || []).filter((m) => m && m.id && m.name).map((m) => ({ ...m, type: m.type || catalog.type }));
}

// ---------- Metadata ----------

export async function fetchMeta(type, id) {
  const candidates = enabledAddons().filter((a) => addonSupports(a, 'meta', type, id));
  if (!candidates.length) throw new Error('No addon provides details for this title.');
  let lastError = null;
  for (const addon of candidates) {
    try {
      const data = await request(addon, 'meta', type, id, null, { ttl: 60 * 60 * 1000 });
      if (data && data.meta) return { ...data.meta, type: data.meta.type || type, id: data.meta.id || id, addon };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Could not load details from any addon.');
}

// ---------- Streams ----------

/** Addons that may have streams for this video. */
export function streamAddons(type, id) {
  return enabledAddons().filter((a) => addonSupports(a, 'stream', type, id));
}

/** Asks one addon for streams. Resolves to an array (possibly empty). */
export async function fetchStreams(addon, type, id) {
  const data = await request(addon, 'stream', type, id, null, { ttl: 10 * 60 * 1000, timeout: STREAM_TIMEOUT_MS });
  return ((data && data.streams) || []).filter(Boolean);
}

// ---------- Subtitles ----------

export async function fetchSubtitles(type, id, extra = {}) {
  const sources = enabledAddons().filter((a) => addonSupports(a, 'subtitles', type, id));
  const results = await Promise.allSettled(sources.map(async (addon) => {
    const data = await request(addon, 'subtitles', type, id, extra, { ttl: 30 * 60 * 1000, timeout: 15000 });
    return ((data && data.subtitles) || []).filter((s) => s && s.url).map((s) => ({ ...s, addonName: addonName(addon) }));
  }));
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

export { HttpError };
