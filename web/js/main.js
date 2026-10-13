import { h } from './core/dom.js';
import { bridge } from './core/bridge.js';
import { focus } from './core/focus.js';
import { router, registerView } from './core/router.js';
import { events, settings } from './core/store.js';
import { sidebar } from './components/sidebar.js';
import { toast } from './components/ui.js';
import { ensureDefaultAddons, refreshStaleManifests } from './services/addons.js';
import { initAccountSync } from './services/account.js';
import { homeView } from './views/home.js';
import { searchView } from './views/search.js';
import { libraryView } from './views/library.js';
import { settingsView } from './views/settings.js';
import { detailsView } from './views/details.js';
import { streamsView } from './views/streams.js';
import { playerView } from './views/player.js';
import { catalogView } from './views/catalog.js';

registerView('home', homeView);
registerView('search', searchView);
registerView('library', libraryView);
registerView('settings', settingsView);
registerView('details', detailsView);
registerView('streams', streamsView);
registerView('player', playerView);
registerView('catalog', catalogView);

function applyTheme() {
  document.documentElement.classList.toggle('amoled', !!settings.get('amoled'));
}

let exitArmedAt = 0;

// Back with nothing left to close: leave a sub-screen, return Home, or (in the app) exit on a
// second press.
function onBack() {
  if (router.back()) return;
  const current = router.current;
  if (current && current.route.name !== 'home') {
    router.root('home');
    return;
  }
  if (!bridge.native) return;
  if (Date.now() - exitArmedAt < 2500) {
    bridge.send('app.exit');
    return;
  }
  exitArmedAt = Date.now();
  toast('Press back again to exit');
}

async function boot() {
  const views = h('main', { class: 'views' });
  const shell = h('div', { id: 'app', class: 'shell' }, sidebar(), views);
  document.body.appendChild(shell);
  focus.init();

  await bridge.hello();
  const root = document.documentElement;
  root.dataset.platform = bridge.platform;
  if (bridge.platform === 'xbox') root.classList.add('tv');
  applyTheme();
  events.on('settings', applyTheme);
  if (bridge.native && settings.get('controllerCursor')) bridge.send('app.pointer', { enabled: true });
  events.on('nav:back', onBack);

  try {
    await ensureDefaultAddons();
  } catch (error) {
    console.warn('Default addons failed', error);
  }
  router.start(views, shell);
  refreshStaleManifests();
  initAccountSync();

  const splash = document.getElementById('splash');
  if (splash) {
    splash.classList.add('hide');
    setTimeout(() => splash.remove(), 400);
  }
  bridge.log(`Web app ready (${bridge.platform})`);
}

window.addEventListener('error', (e) => bridge.log(`Error: ${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => bridge.log(`Unhandled rejection: ${e.reason && (e.reason.stack || e.reason.message || e.reason)}`));

boot();
