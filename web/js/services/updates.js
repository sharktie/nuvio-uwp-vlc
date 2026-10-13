// Tells the user when a newer release of the app is on GitHub. Xbox apps from outside the Store
// can't update themselves, so this only points at the download; installing it over the current
// version keeps sign-in and data.

import { bridge } from '../core/bridge.js';
import { storage } from '../core/store.js';
import { requestJson } from '../core/http.js';

const REPO = 'sharktie/nuvio-uwp-vlc';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;

/** "1.2.57" -> [1, 2, 57]. */
function parseVersion(text) {
  return String(text || '').replace(/^v/i, '').split('.').map((part) => parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

/**
 * "installed" (a build from GitHub), "dev" (built and deployed from Visual Studio, whose build
 * number is 0) or null in a browser, where there's nothing to update.
 */
export function installKind() {
  if (!bridge.native || !bridge.appVersion) return null;
  return parseVersion(bridge.appVersion)[2] ? 'installed' : 'dev';
}

/** The bullet points under "What's new" in the release notes. */
function whatsNew(body) {
  const lines = String(body || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^#+\s*what'?s new/i.test(line));
  if (start < 0) return [];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#+\s/.test(line)) break;
    const item = line.match(/^\s*[-*]\s+(.*)/);
    if (item) items.push(item[1].replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'));
  }
  return items;
}

function describe(release) {
  // Release notes carry the package version ("Package version: 1.2.57"); older releases only
  // have their tag, which is compared by major and minor version.
  const match = String(release.body || '').match(/package version:\s*v?([\d.]+)/i);
  const current = parseVersion(bridge.appVersion);
  let newer;
  if (match) {
    newer = compareVersions(parseVersion(match[1]), current) > 0;
  } else {
    newer = compareVersions(parseVersion(release.tag_name).slice(0, 2), current.slice(0, 2)) > 0;
  }
  return {
    tag: release.tag_name,
    version: match ? match[1] : String(release.tag_name || '').replace(/^v/i, ''),
    name: release.name || release.tag_name,
    publishedAt: release.published_at ? Date.parse(release.published_at) : null,
    notes: whatsNew(release.body),
    url: release.html_url || RELEASES_PAGE,
    newer,
  };
}

/**
 * Looks for a newer release, at most every 12 hours unless forced. Resolves with the latest
 * release's details ({ version, notes, url, newer, ... }) or null when there's nothing to check.
 */
export async function checkForUpdate({ force = false } = {}) {
  if (installKind() !== 'installed') return null;
  const cached = storage.get('updateCheck');
  if (!force && cached && cached.appVersion === bridge.appVersion && Date.now() - cached.checkedAt < CHECK_EVERY_MS) {
    return cached.release;
  }
  const release = describe(await requestJson(LATEST_API, {
    headers: { Accept: 'application/vnd.github+json' },
    timeout: 15000,
  }));
  storage.set('updateCheck', { checkedAt: Date.now(), appVersion: bridge.appVersion, release });
  return release;
}

/** The last check's result, without asking GitHub. */
export function lastUpdateCheck() {
  const cached = storage.get('updateCheck');
  return cached && cached.appVersion === bridge.appVersion ? cached : null;
}

/** True once per new version: whether to show the "update available" notice. */
export function shouldAnnounce(release) {
  if (!release || !release.newer) return false;
  return storage.get('updateAnnounced') !== release.version;
}

export function markAnnounced(release) {
  storage.set('updateAnnounced', release.version);
}
