// An in-memory stand-in for the Trakt API, for testing the Trakt integration without a Trakt API
// app. It answers the endpoints the app uses with Trakt's payload shapes. Nothing is persisted.
//   node tools/dev-trakt-server.mjs [port]
// Point the app at it with web/js/config.local.js:
//   export default { trakt: { clientId: 'dev', clientSecret: 'dev', apiUrl: 'http://localhost:7003' } };
// Connect Trakt in Settings > Integrations, then approve the code at http://localhost:7003/activate.
// Scrobbles and history changes the app sends are listed at http://localhost:7003/log.
import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.argv[2] || 7003);
const CLIENT_ID = 'dev';
const devices = new Map(); // device code -> { userCode, approved }
const tokens = new Set();
const refreshTokens = new Set();
const log = [];
const now = () => new Date().toISOString();
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

const movie = (title, year, imdb, runtime) => ({ title, year, ids: { trakt: Number(imdb.slice(2)), slug: title.toLowerCase().replace(/\W+/g, '-'), imdb, tmdb: null }, runtime });
const show = (title, year, imdb, runtime) => ({ title, year, ids: { trakt: Number(imdb.slice(2)), slug: title.toLowerCase().replace(/\W+/g, '-'), imdb, tvdb: null, tmdb: null }, runtime });

const breakingBad = show('Breaking Bad', 2008, 'tt0903747', 47);
const db = {
  watchedMovies: [{ plays: 1, last_watched_at: hoursAgo(48), movie: movie('The Matrix', 1999, 'tt0133093', 136) }],
  watchedShows: [{
    plays: 3,
    last_watched_at: hoursAgo(30),
    show: breakingBad,
    seasons: [{ number: 1, episodes: [1, 2, 3].map((number) => ({ number, plays: 1, last_watched_at: hoursAgo(30 + number) })) }],
  }],
  playback: [
    { id: 1, progress: 42.5, paused_at: hoursAgo(2), type: 'movie', movie: movie('Inception', 2010, 'tt1375666', 148) },
    { id: 2, progress: 61, paused_at: hoursAgo(5), type: 'episode', episode: { season: 1, number: 4, title: 'Cancer Man', ids: {}, runtime: 48 }, show: breakingBad },
  ],
  watchlistMovies: [
    { listed_at: hoursAgo(10), type: 'movie', movie: movie('Dune: Part Two', 2024, 'tt15239678', 166) },
    { listed_at: hoursAgo(20), type: 'movie', movie: movie('Oppenheimer', 2023, 'tt15398776', 180) },
  ],
  watchlistShows: [{ listed_at: hoursAgo(12), type: 'show', show: show('Severance', 2022, 'tt11280740', 55) }],
  recommendedMovies: [movie('Interstellar', 2014, 'tt0816692', 169), movie('Arrival', 2016, 'tt2543164', 116)],
  recommendedShows: [show('Dark', 2017, 'tt5753856', 60)],
};
let activities = {
  all: now(),
  movies: { watched_at: hoursAgo(48), paused_at: hoursAgo(2), watchlisted_at: hoursAgo(10) },
  episodes: { watched_at: hoursAgo(30), paused_at: hoursAgo(5) },
  shows: { watchlisted_at: hoursAgo(12) },
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, trakt-api-key, trakt-api-version',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

function issue() {
  const access = crypto.randomBytes(16).toString('hex');
  const refresh = crypto.randomBytes(16).toString('hex');
  tokens.add(access);
  refreshTokens.add(refresh);
  return { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: 7776000, scope: 'public', created_at: Math.floor(Date.now() / 1000) };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const send = (status, data) => {
    res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
    res.end(data === undefined ? '' : JSON.stringify(data));
  };
  if (req.method === 'OPTIONS') return send(204);
  let body = '';
  for await (const chunk of req) body += chunk;
  const json = body ? JSON.parse(body) : {};
  console.log(req.method, path + url.search, body.slice(0, 200));

  if (path === '/activate') {
    const code = url.searchParams.get('code');
    let approved = 0;
    for (const device of devices.values()) {
      if (!code || device.userCode === code) {
        device.approved = true;
        approved++;
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(approved ? 'Approved. Go back to the app.' : 'No code waiting.');
  }
  if (path === '/log') return send(200, log);
  if (req.headers['trakt-api-key'] !== CLIENT_ID || req.headers['trakt-api-version'] !== '2') return send(403, { error: 'Invalid API key' });

  if (path === '/oauth/device/code') {
    const deviceCode = crypto.randomBytes(16).toString('hex');
    const userCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    devices.set(deviceCode, { userCode, approved: false });
    console.log(`  code ${userCode}: approve at http://localhost:${port}/activate`);
    return send(200, { device_code: deviceCode, user_code: userCode, verification_url: `http://localhost:${port}/activate`, expires_in: 600, interval: 2 });
  }
  if (path === '/oauth/device/token') {
    const device = devices.get(json.code);
    if (!device) return send(404);
    if (!device.approved) return send(400);
    devices.delete(json.code);
    return send(200, issue());
  }
  if (path === '/oauth/token') return refreshTokens.has(json.refresh_token) ? send(200, issue()) : send(401, { error: 'invalid_grant' });
  if (path === '/oauth/revoke') {
    tokens.delete(json.token);
    return send(200, {});
  }

  if (!tokens.has((req.headers.authorization || '').replace(/^Bearer /, ''))) return send(401, { error: 'invalid token' });
  if (path === '/users/settings') return send(200, { user: { username: 'tester', name: 'Test User', ids: { slug: 'tester' } } });
  if (path === '/sync/last_activities') return send(200, activities);
  if (path === '/sync/watched/movies') return send(200, db.watchedMovies);
  if (path === '/sync/watched/shows') return send(200, db.watchedShows);
  if (path === '/sync/playback/movies') return send(200, db.playback.filter((p) => p.type === 'movie'));
  if (path === '/sync/playback/episodes') return send(200, db.playback.filter((p) => p.type === 'episode'));
  if (path === '/sync/watchlist/movies') return send(200, db.watchlistMovies);
  if (path === '/sync/watchlist/shows') return send(200, db.watchlistShows);
  if (path === '/recommendations/movies') return send(200, db.recommendedMovies);
  if (path === '/recommendations/shows') return send(200, db.recommendedShows);
  if (path.startsWith('/scrobble/') || path.startsWith('/sync/history')) {
    log.push({ at: now(), path, body: json });
    if (path.startsWith('/sync/history')) {
      activities = { ...activities, all: now(), movies: { ...activities.movies, watched_at: now() }, episodes: { ...activities.episodes, watched_at: now() } };
    }
    return send(201, path.startsWith('/scrobble/') ? { id: log.length, action: path.split('/')[2], progress: json.progress } : { added: {}, deleted: {} });
  }
  send(404, { error: 'Not found' });
}).listen(port, () => console.log(`Dev Trakt API on http://localhost:${port} (requests the app sent at /log)`));
