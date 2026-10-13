// An in-memory stand-in for a Nuvio server, for testing account sign-in and sync locally. It
// answers the same endpoints the app uses (Supabase auth, PostgREST RPCs, the TV login
// function) with the payload shapes from NuvioMobile's sync code. Nothing is persisted.
//   node tools/dev-sync-server.mjs [port]
// In the app: Settings > Account > Server > Self-hosted server > http://localhost:7002
// Sign in with test@example.com / test, or with a code (approve it at http://localhost:7002/approve).
import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.argv[2] || 7002);
const KEY = 'dev-publishable-key';
const tokens = new Map(); // access token -> user id
const refresh = new Map(); // refresh token -> user id
const deviceSessions = new Map(); // device code -> { userCode, nonce, status }
let rateLimited = 0;
const db = {
  profiles: [
    { id: 'p1', user_id: 'u1', profile_index: 1, name: 'Main', avatar_color_hex: '#1E88E5', uses_primary_addons: false, pin_enabled: false },
    { id: 'p2', user_id: 'u1', profile_index: 2, name: 'Kids', avatar_color_hex: '#E53935', uses_primary_addons: true, pin_enabled: true },
  ],
  addons: [
    { profile_id: 1, url: 'https://v3-cinemeta.strem.io/manifest.json', name: 'Cinemeta', enabled: true, sort_order: 0 },
    { profile_id: 1, url: 'https://opensubtitles-v3.strem.io/manifest.json', name: 'OpenSubtitles v3', enabled: true, sort_order: 1 },
    { profile_id: 1, url: 'http://localhost:7001/manifest.json', name: 'Sample Streams (dev)', enabled: true, sort_order: 2 },
  ],
  library: [
    { profile_id: 1, content_id: 'tt0903747', content_type: 'series', name: 'Breaking Bad', poster: 'https://images.metahub.space/poster/medium/tt0903747/img', poster_shape: 'POSTER', added_at: Date.now() - 86400000 },
  ],
  progress: [
    { profile_id: 1, content_id: 'tt0903747', content_type: 'series', video_id: 'tt0903747:1:2', season: 1, episode: 2, position: 600000, duration: 2880000, last_watched: Date.now() - 3600000, progress_key: 'tt0903747_s1e2' },
  ],
  watched: [
    { profile_id: 1, content_id: 'tt0903747', content_type: 'series', title: 'Breaking Bad', season: 1, episode: 1, watched_at: Date.now() - 7200000 },
  ],
};

function issue(userId) {
  const access = crypto.randomBytes(16).toString('hex');
  const ref = crypto.randomBytes(16).toString('hex');
  tokens.set(access, userId);
  refresh.set(ref, userId);
  return { access_token: access, refresh_token: ref, token_type: 'bearer', expires_in: 3600, user: { id: userId, email: 'test@example.com' } };
}

// Change feed for delta sync: every change gets the next event id.
let eventSeq = 0;
const feed = { library: [], progress: [], watched: [] };
const record = (kind, operation, profile, row) => feed[kind].push({ ...row, profile_id: profile, operation, event_id: ++eventSeq });
const cursorOf = (kind, profile) => feed[kind].filter((e) => e.profile_id === profile).reduce((max, e) => Math.max(max, e.event_id), 0);
const changesSince = (kind, p) => feed[kind]
  .filter((e) => e.profile_id === p.p_profile_id && e.event_id > p.p_since_event_id)
  .sort((a, b) => a.event_id - b.event_id)
  .slice(0, p.p_limit);
for (const row of db.library) record('library', 'upsert', row.profile_id, row);
for (const row of db.progress) record('progress', 'upsert', row.profile_id, row);
for (const row of db.watched) record('watched', 'upsert', row.profile_id, row);

function upsert(list, items, profile, keyFields, kind) {
  for (const item of items) {
    const row = { ...item, profile_id: profile };
    const index = list.findIndex((r) => r.profile_id === profile && keyFields.every((k) => (r[k] ?? null) === (row[k] ?? null)));
    if (index >= 0) list[index] = row;
    else list.push(row);
    record(kind, 'upsert', profile, row);
  }
}

function remove(list, keys, profile, keyFields, kind) {
  for (const key of keys) {
    const match = (r) => r.profile_id === profile && keyFields.every((k) => (typeof key === 'string' ? r[k] === key : (r[k] ?? null) === (key[k] ?? null)));
    for (let i = list.length - 1; i >= 0; i--) if (match(list[i])) list.splice(i, 1);
    record(kind, 'delete', profile, typeof key === 'string' ? { [keyFields[0]]: key } : key);
  }
}

const rpcs = {
  start_device_login_session: (p) => {
    const deviceCode = crypto.randomBytes(12).toString('hex');
    const userCode = crypto.randomBytes(3).toString('hex').toUpperCase();
    deviceSessions.set(deviceCode, { userCode, nonce: p.p_device_nonce, status: 'pending' });
    console.log(`Device sign-in code ${userCode}: open http://localhost:${port}/approve?code=${userCode}`);
    return [{ device_code: deviceCode, user_code: userCode, verification_uri_complete: `${p.p_redirect_base_url}?code=${userCode}`, poll_interval_seconds: 2 }];
  },
  poll_tv_login_session: (p) => {
    const session = deviceSessions.get(p.p_code);
    return [{ status: session && session.nonce === p.p_device_nonce ? session.status : 'expired' }];
  },
  sync_pull_profiles: () => db.profiles,
  verify_profile_pin: (p) => [{ unlocked: p.p_pin === '1234', retry_after_seconds: 0, message: p.p_pin === '1234' ? null : 'Wrong PIN (dev server PIN is 1234)' }],
  sync_pull_library: (p) => db.library.filter((r) => r.profile_id === p.p_profile_id).slice(p.p_offset, p.p_offset + p.p_limit),
  sync_pull_watch_progress: (p) => db.progress.filter((r) => r.profile_id === p.p_profile_id),
  sync_pull_watched_items: (p) => db.watched.filter((r) => r.profile_id === p.p_profile_id).slice((p.p_page - 1) * p.p_page_size, p.p_page * p.p_page_size),
  sync_push_addons: (p) => {
    db.addons = db.addons.filter((r) => r.profile_id !== p.p_profile_id).concat(p.p_addons.map((a) => ({ ...a, profile_id: p.p_profile_id })));
    return null;
  },
  sync_push_library_items: (p) => upsert(db.library, p.p_items, p.p_profile_id, ['content_id'], 'library'),
  sync_delete_library_items: (p) => remove(db.library, p.p_keys, p.p_profile_id, ['content_id'], 'library'),
  sync_push_watch_progress: (p) => upsert(db.progress, p.p_entries, p.p_profile_id, ['progress_key'], 'progress'),
  sync_delete_watch_progress: (p) => remove(db.progress, p.p_keys, p.p_profile_id, ['progress_key'], 'progress'),
  sync_push_watched_items: (p) => upsert(db.watched, p.p_items, p.p_profile_id, ['content_id', 'season', 'episode'], 'watched'),
  sync_delete_watched_items: (p) => remove(db.watched, p.p_keys, p.p_profile_id, ['content_id', 'season', 'episode'], 'watched'),
  sync_get_library_delta_cursor: (p) => cursorOf('library', p.p_profile_id),
  sync_get_watch_progress_delta_cursor: (p) => cursorOf('progress', p.p_profile_id),
  sync_get_watched_items_delta_cursor: (p) => cursorOf('watched', p.p_profile_id),
  sync_pull_library_delta: (p) => changesSince('library', p),
  sync_pull_watch_progress_delta: (p) => changesSince('progress', p),
  sync_pull_watched_items_delta: (p) => changesSince('watched', p),
};

http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Expose-Headers': 'Retry-After' };
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, data) => {
    res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
    res.end(data === undefined || data === null ? '' : JSON.stringify(data));
  };
  if (req.method === 'OPTIONS') return send(204);
  let body = '';
  for await (const chunk of req) body += chunk;
  const json = body ? JSON.parse(body) : {};
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  const user = tokens.get(bearer);
  const path = url.pathname;
  console.log(req.method, path, path.includes('/rpc/') ? JSON.stringify(json).slice(0, 160) : '');

  if (path === '/.well-known/nuvio') {
    return send(200, { version: 1, service: 'nuvio', self_hosted: true, backend_url: `http://${req.headers.host}`, publishable_key: KEY, capabilities: { email_password_auth: true, tv_login: true } });
  }
  if (path === '/approve') {
    for (const session of deviceSessions.values()) if (session.userCode === url.searchParams.get('code')) session.status = 'approved';
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('Approved. Go back to the app.');
  }
  if (path === '/simulate') {
    // Another device: saves a title to the library and unmarks Breaking Bad S1E1 as watched.
    upsert(db.library, [{ content_id: 'tt0111161', content_type: 'movie', name: 'The Shawshank Redemption', poster: 'https://images.metahub.space/poster/medium/tt0111161/img', poster_shape: 'POSTER', added_at: Date.now() }], 1, ['content_id'], 'library');
    remove(db.watched, [{ content_id: 'tt0903747', season: 1, episode: 1 }], 1, ['content_id', 'season', 'episode'], 'watched');
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    return res.end('Simulated a change from another device.');
  }
  if (path === '/ratelimit') {
    // Test the app's backoff: the next N API requests get "429, retry after 2 seconds".
    rateLimited = Number(url.searchParams.get('count') || 3);
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    return res.end(`Next ${rateLimited} requests will be rate limited.`);
  }
  if (req.headers.apikey !== KEY) return send(401, { message: 'Invalid API key' });
  if (rateLimited > 0) {
    rateLimited--;
    console.log('  -> 429 (rate limited)');
    res.writeHead(429, { ...cors, 'Content-Type': 'application/json', 'Retry-After': '2', 'Access-Control-Expose-Headers': 'Retry-After' });
    return res.end(JSON.stringify({ message: 'Too many requests' }));
  }
  if (path === '/auth/v1/token') {
    if (url.searchParams.get('grant_type') === 'password') {
      return json.email === 'test@example.com' && json.password === 'test' ? send(200, issue('u1')) : send(400, { error_description: 'Invalid login credentials' });
    }
    const userId = refresh.get(json.refresh_token);
    return userId ? send(200, issue(userId)) : send(400, { error_description: 'Invalid refresh token' });
  }
  if (path === '/auth/v1/logout') return send(204);
  if (path === '/functions/v1/tv-logins-exchange') {
    const session = deviceSessions.get(json.code);
    if (!session || session.status !== 'approved' || session.nonce !== json.device_nonce) return send(400, { message: 'Not approved' });
    deviceSessions.delete(json.code);
    return send(200, issue('u1'));
  }
  if (path.startsWith('/rest/v1/rpc/')) {
    const name = path.slice('/rest/v1/rpc/'.length);
    const anonymous = name === 'start_device_login_session' || name === 'poll_tv_login_session';
    if (!anonymous && !user) return send(401, { message: 'JWT expired' });
    if (!rpcs[name]) return send(404, { message: `Unknown function ${name}` });
    const result = rpcs[name](json);
    return send(200, result === undefined ? null : result);
  }
  if (path === '/rest/v1/addons') {
    if (!user) return send(401, { message: 'JWT expired' });
    const profile = Number((url.searchParams.get('profile_id') || '').replace('eq.', ''));
    return send(200, db.addons.filter((r) => r.profile_id === profile).sort((a, b) => a.sort_order - b.sort_order));
  }
  if (path === '/dump') return send(200, db);
  send(404, { message: 'Not found' });
}).listen(port, () => console.log(`Dev Nuvio server on http://localhost:${port} (state at /dump)`));
