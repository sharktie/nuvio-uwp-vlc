// JSON over HTTP with a small in-memory cache and de-duplication of identical requests in flight.
// Inside the app, a request the browser refuses (CORS) is retried through the native side.

import { bridge } from './bridge.js';

const cache = new Map(); // url -> { expires, value }
const inflight = new Map(); // url -> promise
const MAX_CACHE_ENTRIES = 400;

export class HttpError extends Error {
  constructor(message, status, retryAfter = null) {
    super(message);
    this.status = status;
    /** Seconds the server asked us to wait (Retry-After), if it said. */
    this.retryAfter = retryAfter;
  }
}

function retryAfterSeconds(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, (date - Date.now()) / 1000);
}

/**
 * GETs JSON. Options: timeout (ms), ttl (ms to cache, 0 = no cache), headers.
 */
export async function getJson(url, { timeout = 20000, ttl = 5 * 60 * 1000, headers } = {}) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (inflight.has(url)) return inflight.get(url);
  const promise = (async () => {
    try {
      const value = await requestJson(url, { timeout, headers });
      if (ttl > 0) {
        if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(url, { expires: Date.now() + ttl, value });
      }
      return value;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, promise);
  return promise;
}

export function invalidate(prefix) {
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

/** Any method; body is JSON-encoded. Not cached. */
/**
 * A JSON request. In the app, a request the browser refuses (usually CORS) is retried natively;
 * native: true goes natively straight away, for APIs that only allow listed browser origins, where
 * a request the browser sent but wasn't allowed to read would otherwise be sent twice.
 */
export async function requestJson(url, { method = 'GET', body, timeout = 20000, headers = {}, native = false } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!Object.keys(init.headers).some((k) => k.toLowerCase() === 'content-type')) init.headers['Content-Type'] = 'application/json';
  }
  const viaApp = async () => {
    const raw = await bridge.fetchRaw(url, { method, headers: init.headers, body: init.body || null, timeoutMs: timeout });
    return parse(raw.status, new TextDecoder().decode(raw.bytes), url, retryAfterSeconds(raw.headers['retry-after']));
  };
  if (native && bridge.native) return viaApp();
  let response;
  try {
    response = await fetchWithTimeout(url, init, timeout);
  } catch (error) {
    // Most likely CORS: the native side isn't bound by it.
    if (bridge.native && error.name !== 'AbortError') return viaApp();
    throw error.name === 'AbortError' ? new HttpError('The request timed out', 0) : error;
  }
  return parse(response.status, await response.text(), url, retryAfterSeconds(response.headers.get('retry-after')));
}

function parse(status, text, url, retryAfter = null) {
  if (status < 200 || status >= 300) {
    let message = `HTTP ${status}`;
    try {
      const data = JSON.parse(text);
      message = data.message || data.error_description || data.msg || data.error || message;
      if (typeof message !== 'string') message = JSON.stringify(message);
    } catch {}
    throw new HttpError(message, status, retryAfter);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError('Invalid response from ' + new URL(url).host, status);
  }
}

export async function fetchWithTimeout(url, init = {}, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches text such as a subtitle file, decoding it as UTF-8 or, failing that, Windows-1252. */
export async function getText(url, { timeout = 20000 } = {}) {
  let bytes;
  try {
    const response = await fetchWithTimeout(url, {}, timeout);
    if (!response.ok) throw new HttpError(`HTTP ${response.status}`, response.status);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (!bridge.native || error instanceof HttpError) throw error;
    const raw = await bridge.fetchRaw(url, { timeoutMs: timeout });
    if (raw.status < 200 || raw.status >= 300) throw new HttpError(`HTTP ${raw.status}`, raw.status);
    bytes = raw.bytes;
  }
  return decodeText(bytes);
}

export function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
