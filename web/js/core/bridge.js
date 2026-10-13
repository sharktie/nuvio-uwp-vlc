// Messages between the web app and the native app around it (Nuvio UWP). Protocol: docs/bridge.md.
// In a normal browser there is no native side and everything falls back to web APIs.

import { events } from './store.js';

const webview = window.chrome && window.chrome.webview;
const pending = new Map();
let nextRequestId = 1;

export const bridge = {
  /** True inside the Nuvio UWP app. */
  native: !!webview,
  /** "xbox", "desktop" (UWP on a PC) or "web". */
  platform: 'web',
  appVersion: null,
  vlcVersion: null,
  webAppUrl: null,
  bundled: true,

  send(type, payload = {}) {
    if (!webview) return;
    try {
      webview.postMessage({ ...payload, type });
    } catch (error) {
      console.warn('Bridge send failed', error);
    }
  },

  /** Sends a request the native side answers with a "response" message. */
  request(type, payload = {}, timeoutMs = 0) {
    if (!webview) return Promise.reject(new Error('Not running in the app'));
    const requestId = String(nextRequestId++);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: 0 };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error('Timed out'));
        }, timeoutMs);
      }
      pending.set(requestId, entry);
      bridge.send(type, { ...payload, requestId });
    });
  },

  /** Waits for the native app to describe itself. Resolves immediately in a browser. */
  hello() {
    if (!webview) return Promise.resolve(bridge);
    return new Promise((resolve) => {
      const done = () => resolve(bridge);
      const off = events.on('native:app.hello', () => {
        off();
        clearTimeout(timer);
        done();
      });
      const timer = setTimeout(() => {
        off();
        done();
      }, 3000);
      bridge.send('app.hello');
    });
  },

  log(message) {
    bridge.send('app.log', { message: String(message) });
  },

  /** Asks the app for text with the console's on-screen keyboard. Null if cancelled. */
  async requestText({ label, value = '', kind = 'text' }) {
    const result = await bridge.request('app.textInput', { label, value, kind });
    return result || null;
  },

  /**
   * fetch() without CORS through the native app; falls back to window.fetch in a browser.
   * Returns { status, url, headers, bytes }.
   */
  async fetchRaw(url, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
    if (!webview) {
      const response = await fetch(url, { method, headers, body });
      const out = { status: response.status, url: response.url, headers: {} };
      response.headers.forEach((value, key) => (out.headers[key] = value));
      out.bytes = new Uint8Array(await response.arrayBuffer());
      return out;
    }
    const result = await bridge.request('net.fetch', { url, method, headers, body }, timeoutMs);
    const binary = atob(result.bodyBase64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { status: result.status, url: result.url, headers: result.headers || {}, bytes };
  },
};

if (webview) {
  webview.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'response') {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
      return;
    }
    if (message.type === 'app.hello') {
      bridge.platform = message.platform || 'desktop';
      bridge.appVersion = message.appVersion || null;
      bridge.vlcVersion = message.vlcVersion || null;
      bridge.webAppUrl = message.webAppUrl || null;
      bridge.bundled = message.bundled !== false;
    }
    events.emit('native:' + message.type, message);
  });
}
