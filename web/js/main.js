import { installArabicLocalization } from './core/i18n.js';
import { h } from './core/dom.js';
import { bridge } from './core/bridge.js';
import { focus } from './core/focus.js';
import { router, registerView } from './core/router.js';
import { events, settings } from './core/store.js';
import { sidebar } from './components/sidebar.js';
import { toast } from './components/ui.js';
import { ensureDefaultAddons, refreshStaleManifests } from './services/addons.js';
import { initAccountSync, activeProfileIndex, switchProfile } from './services/account.js';
import { checkForUpdate, shouldAnnounce, markAnnounced } from './services/updates.js';
import { initTrakt } from './services/trakt.js';
import { initJellyfin } from './services/jellyfin.js';
import { showUpdateDialog } from './components/update.js';
import { shouldAskProfile, whoIsWatching } from './views/profiles.js';
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
  const root = document.documentElement;
  const language = settings.get('appLanguage') === 'en' ? 'en' : 'ar';
  root.lang = language;
  root.dir = language === 'ar' ? 'rtl' : 'ltr';
  if (bridge.native) bridge.send('app.flowDirection', { direction: root.dir });
  root.classList.toggle('amoled', !!settings.get('amoled'));
  root.dataset.posterSize = settings.get('posterSize') || 'standard';
  // On the console the controller's pointer is off unless the user turns it on (see focus.js).
  root.classList.toggle('no-pointer', bridge.platform === 'xbox' && !settings.get('controllerCursor'));
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

function setSplashStatus(arabic, english) {
  const status = document.getElementById('splash-status');
  if (status) status.textContent = document.documentElement.lang === 'en' ? english : arabic;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function hideSplash() {
  const splash = document.getElementById('splash');
  if (!splash) return;
  splash.id = '';
  splash.classList.add('hide');
  setTimeout(() => splash.remove(), 400);
}

// Once per new release, a few seconds after startup (and not over the player or a dialog).
async function announceUpdate() {
  try {
    const release = await checkForUpdate();
    if (!shouldAnnounce(release)) return;
    if (document.querySelector('.overlay, .profile-picker') || (router.current && router.current.route.name === 'player')) return;
    markAnnounced(release);
    bridge.log(`Update available: ${release.version}`);
    showUpdateDialog(release);
  } catch (error) {
    console.warn('Update check failed', error);
  }
}

async function boot() {
  const views = h('main', { class: 'views' });
  const shell = h('div', { id: 'app', class: 'shell' }, sidebar(), views);
  document.body.appendChild(shell);
  focus.init();

  const root = document.documentElement;
  const applyPlatform = () => {
    root.dataset.platform = bridge.platform;
    root.classList.toggle('tv', bridge.platform === 'xbox');
    applyTheme();
  };
  // Continue painting even if the native hello message is delayed; update platform-specific
  // behavior as soon as the bridge replies.
  events.on('native:app.hello', applyPlatform);
  await Promise.race([
    bridge.hello(),
    new Promise((resolve) => setTimeout(resolve, 350)),
  ]);
  applyPlatform();
  installArabicLocalization();
  events.on('settings', applyTheme);
  if (bridge.native && settings.get('controllerCursor')) bridge.send('app.pointer', { enabled: true });
  events.on('nav:back', onBack);

  if (shouldAskProfile()) {
    hideSplash();
    const chosen = await whoIsWatching();
    if (chosen !== activeProfileIndex()) {
      switchProfile(chosen);
      return;
    }
  }

  router.start(views, shell);
  setSplashStatus('جارٍ تحميل الفهارس ومزامنة الحساب…', 'Loading catalogs and syncing your account…');
  bridge.log(`Web app initializing (${bridge.platform}${bridge.appVersion ? ' ' + bridge.appVersion : ''})`);

  // Render the shell underneath the branded loader, then wait for first-run catalog discovery
  // and the initial account sync before revealing the home screen.
  const addonReady = ensureDefaultAddons().catch((error) => {
    console.warn('Default addons failed', error);
  });
  refreshStaleManifests();
  const accountReady = initAccountSync();
  initTrakt();
  initJellyfin();

  await nextFrame();
  await nextFrame();
  let waitTimer;
  const ready = await Promise.race([
    Promise.allSettled([addonReady, accountReady]).then(() => true),
    new Promise((resolve) => {
      waitTimer = setTimeout(() => resolve(false), 25000);
    }),
  ]);
  clearTimeout(waitTimer);
  if (!ready) {
    setSplashStatus('ما زال الاتصال جارياً؛ سيتم فتح التطبيق ومواصلة التحميل في الخلفية.', 'Services are taking longer than expected. Opening the app while they continue in the background…');
    await new Promise((resolve) => setTimeout(resolve, 700));
  } else {
    setSplashStatus('اكتمل التحميل', 'Ready');
  }
  await nextFrame();
  hideSplash();
  bridge.log(`Web app ready (${bridge.platform}${bridge.appVersion ? ' ' + bridge.appVersion : ''})`);
  setTimeout(announceUpdate, 6000);
}

window.addEventListener('error', (e) => bridge.log(`Error: ${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => bridge.log(`Unhandled rejection: ${e.reason && (e.reason.stack || e.reason.message || e.reason)}`));

boot();
