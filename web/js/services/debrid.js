// Turns torrent results into direct links through the user's debrid service, the way Nuvio's
// "Resolve playable links" does (NuvioMobile features/debrid). Nothing is downloaded on this
// device: the debrid service fetches the torrent and serves the file over HTTP.

import { bridge } from '../core/bridge.js';
import { storage, events } from '../core/store.js';
import { decodeText } from '../core/http.js';

export const DEBRID_PROVIDERS = {
  torbox: { name: 'TorBox', short: 'TB', keyHelp: 'torbox.app/settings → API Key' },
  realdebrid: { name: 'Real-Debrid', short: 'RD', keyHelp: 'real-debrid.com/apitoken' },
  premiumize: { name: 'Premiumize', short: 'PM', keyHelp: 'premiumize.me/account → API Key' },
};

const VIDEO_EXTENSIONS = /\.(mkv|mp4|m4v|avi|mov|wmv|webm|ts|m2ts|mpg|mpeg|flv|ogv|3gp)$/i;
const CACHE_TTL_MS = 15 * 60 * 1000;
const resolved = new Map(); // cache key -> { at, result }

export class DebridError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // missing | not_cached | invalid_key | error
  }
}

export function debridAccount() {
  const account = storage.get('debrid', null);
  return account && account.provider && account.apiKey && DEBRID_PROVIDERS[account.provider] ? account : null;
}

export function setDebridAccount(account) {
  storage.set('debrid', account || undefined);
  resolved.clear();
  events.emit('debrid', account);
}

export function debridName() {
  const account = debridAccount();
  return account ? DEBRID_PROVIDERS[account.provider].name : null;
}

// ---------- HTTP (through the app when possible: these APIs don't all allow browser CORS) ----------

async function call(url, { method = 'GET', headers = {}, body = null } = {}) {
  const raw = await bridge.fetchRaw(url, { method, headers: { Accept: 'application/json', ...headers }, body, timeoutMs: 30000 });
  const text = decodeText(raw.bytes);
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: raw.status, ok: raw.status >= 200 && raw.status < 300, data, text };
}

function form(fields) {
  return fields.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

function multipart(fields) {
  const boundary = 'NuvioUWP' + Math.random().toString(36).slice(2);
  const body = fields.map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') + `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ---------- Key validation ----------

export async function validateDebridKey(provider, apiKey) {
  const key = apiKey.trim();
  const auth = { Authorization: `Bearer ${key}` };
  if (provider === 'torbox') return (await call('https://api.torbox.app/v1/api/user/me', { headers: auth })).ok;
  if (provider === 'realdebrid') return (await call('https://api.real-debrid.com/rest/1.0/user', { headers: auth })).ok;
  if (provider === 'premiumize') {
    const r = await call('https://www.premiumize.me/api/account/info', { headers: auth });
    return r.ok && r.data && String(r.data.status).toLowerCase() === 'success';
  }
  return false;
}

// ---------- Resolving ----------

export function magnetFor(stream) {
  if (!stream.infoHash) return null;
  let magnet = `magnet:?xt=urn:btih:${stream.infoHash}`;
  const filename = stream.behaviorHints && stream.behaviorHints.filename;
  if (filename) magnet += `&dn=${encodeURIComponent(filename)}`;
  for (const source of stream.sources || []) {
    const tracker = String(source).trim();
    if (!tracker || /^dht:/i.test(tracker)) continue;
    magnet += `&tr=${encodeURIComponent(tracker.replace(/^tracker:/i, ''))}`;
  }
  return magnet;
}

/**
 * Resolves a torrent result to a playable link. Resolves to { url, filename, size }; throws a
 * DebridError when there's no account, the torrent isn't cached, or the service refuses.
 */
export async function resolveTorrent(stream, { season = null, episode = null } = {}) {
  const account = debridAccount();
  if (!account) throw new DebridError('missing', 'Connect a debrid service in Settings to play torrent results.');
  const key = `${account.provider}|${stream.infoHash}|${stream.fileIdx ?? ''}|${season ?? ''}|${episode ?? ''}`;
  const hit = resolved.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  const magnet = magnetFor(stream);
  if (!magnet) throw new DebridError('error', 'This result has no torrent to resolve.');
  const want = {
    filename: stream.behaviorHints && stream.behaviorHints.filename,
    fileIdx: Number.isInteger(stream.fileIdx) ? stream.fileIdx : null,
    season,
    episode,
  };
  const apiKey = account.apiKey.trim();
  let result;
  if (account.provider === 'torbox') result = await resolveTorbox(apiKey, magnet, want);
  else if (account.provider === 'realdebrid') result = await resolveRealDebrid(apiKey, magnet, want);
  else result = await resolvePremiumize(apiKey, magnet, want);
  resolved.set(key, { at: Date.now(), result });
  return result;
}

function notCached() {
  return new DebridError('not_cached', `Not cached on ${debridName()}.`);
}

function failed(response, what) {
  if (response.status === 401 || response.status === 403) return new DebridError('invalid_key', `${debridName()} rejected your API key.`);
  const detail = response.data && (response.data.detail || response.data.error || response.data.message);
  return new DebridError('error', `${debridName()} couldn't ${what}${detail ? `: ${detail}` : '.'}`);
}

async function resolveTorbox(apiKey, magnet, want) {
  const auth = { Authorization: `Bearer ${apiKey}` };
  const { body, contentType } = multipart([['magnet', magnet], ['add_only_if_cached', 'true'], ['allow_zip', 'false']]);
  const create = await call('https://api.torbox.app/v1/api/torrents/createtorrent', { method: 'POST', headers: { ...auth, 'Content-Type': contentType }, body });
  const data = create.data && create.data.data;
  const torrentId = data && (data.torrent_id ?? data.id);
  if (!create.ok || !create.data || create.data.success === false || torrentId == null) {
    const detail = String((create.data && (create.data.detail || create.data.error)) || '').toLowerCase();
    if (create.status === 401 || create.status === 403) throw failed(create, 'add the torrent');
    if (detail.includes('cache') || create.status === 404) throw notCached();
    throw failed(create, 'add the torrent');
  }
  const info = await call(`https://api.torbox.app/v1/api/torrents/mylist?id=${encodeURIComponent(torrentId)}&bypass_cache=true`, { headers: auth });
  const files = (info.data && info.data.data && info.data.data.files) || [];
  const file = selectFile(files, want, {
    path: (f) => f.name || f.short_name || '',
    playable: (f) => /^video\//i.test(f.mimetype || '') || VIDEO_EXTENSIONS.test(f.short_name || f.name || ''),
    size: (f) => f.size || 0,
  });
  if (!file || file.id == null) throw new DebridError('error', 'No video file in this torrent matches.');
  const link = await call(`https://api.torbox.app/v1/api/torrents/requestdl?token=${encodeURIComponent(apiKey)}&torrent_id=${encodeURIComponent(torrentId)}&file_id=${encodeURIComponent(file.id)}&zip_link=false&redirect=false&append_name=false`, { headers: auth });
  const url = link.data && link.data.data;
  if (!link.ok || typeof url !== 'string' || !url) throw failed(link, 'make a link');
  return { url, filename: file.short_name || file.name || want.filename || null, size: file.size || null };
}

async function resolveRealDebrid(apiKey, magnet, want) {
  const base = 'https://api.real-debrid.com/rest/1.0';
  const auth = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  const add = await call(`${base}/torrents/addMagnet`, { method: 'POST', headers: auth, body: form([['magnet', magnet]]) });
  const id = add.data && add.data.id;
  if (!add.ok || !id) throw failed(add, 'add the torrent');
  let done = false;
  try {
    const before = await call(`${base}/torrents/info/${encodeURIComponent(id)}`, { headers: auth });
    const files = (before.data && before.data.files) || [];
    if (!files.length) throw notCached();
    const file = selectFile(files, want, {
      path: (f) => f.path || '',
      playable: (f) => VIDEO_EXTENSIONS.test(f.path || ''),
      size: (f) => f.bytes || 0,
    });
    if (!file) throw new DebridError('error', 'No video file in this torrent matches.');
    const select = await call(`${base}/torrents/selectFiles/${encodeURIComponent(id)}`, { method: 'POST', headers: auth, body: form([['files', String(file.id)]]) });
    if (!select.ok && select.status !== 202) throw failed(select, 'select the file');
    const after = await call(`${base}/torrents/info/${encodeURIComponent(id)}`, { headers: auth });
    const status = String((after.data && after.data.status) || '').toLowerCase();
    const link = after.data && (after.data.links || []).find(Boolean);
    if (status !== 'downloaded' || !link) throw notCached();
    const unrestrict = await call(`${base}/unrestrict/link`, { method: 'POST', headers: auth, body: form([['link', link]]) });
    const url = unrestrict.data && unrestrict.data.download;
    if (!unrestrict.ok || !url) throw failed(unrestrict, 'make a link');
    done = true;
    return { url, filename: unrestrict.data.filename || (file.path || '').split('/').pop() || null, size: unrestrict.data.filesize || file.bytes || null };
  } finally {
    // Don't leave half-added torrents in the user's account.
    if (!done) call(`${base}/torrents/delete/${encodeURIComponent(id)}`, { method: 'DELETE', headers: auth }).catch(() => {});
  }
}

async function resolvePremiumize(apiKey, magnet, want) {
  const response = await call('https://www.premiumize.me/api/transfer/directdl', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form([['src', magnet]]),
  });
  if (!response.ok || !response.data || String(response.data.status).toLowerCase() !== 'success') {
    const message = String((response.data && response.data.message) || '').toLowerCase();
    if (message.includes('cache') || message.includes('not found')) throw notCached();
    throw failed(response, 'make a link');
  }
  const file = selectFile(response.data.content || [], want, {
    path: (f) => f.path || '',
    playable: (f) => !!f.link && VIDEO_EXTENSIONS.test(f.path || ''),
    size: (f) => f.size || 0,
  });
  if (!file) throw notCached();
  return { url: file.link, filename: (file.path || '').split('/').pop() || null, size: file.size || null };
}

/** Same order as Nuvio: the addon's file name, then SxxEyy, then the file index, then the largest video. */
function selectFile(files, want, { path, playable, size }) {
  const videos = files.filter(playable);
  if (!videos.length) return null;
  const norm = (p) => String(p).trim().replace(/\\/g, '/').replace(/^\//, '');
  if (want.filename) {
    const name = norm(want.filename).toLowerCase();
    const base = name.split('/').pop();
    const match = videos.filter((f) => {
      const p = norm(path(f)).toLowerCase();
      return p === name || p.endsWith('/' + name) || p.split('/').pop() === base;
    });
    if (match.length) return match[0];
  }
  if (want.season != null && want.episode != null) {
    const s = Number(want.season);
    const e = Number(want.episode);
    const pattern = new RegExp(`(^|[^a-z0-9])(s0*${s}[ ._-]*e0*${e}|0*${s}x0*${e})(?![0-9])`, 'i');
    const match = videos.filter((f) => pattern.test(norm(path(f)).split('/').pop()));
    if (match.length) return match.sort((a, b) => size(b) - size(a))[0];
    return null;
  }
  if (want.fileIdx != null && files[want.fileIdx] && playable(files[want.fileIdx])) return files[want.fileIdx];
  return videos.sort((a, b) => size(b) - size(a))[0];
}
