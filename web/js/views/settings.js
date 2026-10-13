import { h, icon, img, clear } from '../core/dom.js';
import { focus } from '../core/focus.js';
import { router } from '../core/router.js';
import { bridge } from '../core/bridge.js';
import { events, settings } from '../core/store.js';
import {
  listAddons, installAddon, removeAddon, moveAddon, setAddonEnabled, refreshAddon, addonName,
  replaceAddons, DEFAULT_ADDON_URLS,
} from '../services/addons.js';
import { LANGUAGE_CHOICES } from '../services/subtitles.js';
import { accountPage } from './account.js';
import { DEBRID_PROVIDERS, debridAccount, setDebridAccount, validateDebridKey } from '../services/debrid.js';
import {
  settingRow, toggleRow, button, choicePanel, promptDialog, confirmDialog, toast, emptyState,
} from '../components/ui.js';

const SECTIONS = [
  { id: 'account', label: 'Account', description: 'Sign in to sync your addons, library and progress', icon: 'person' },
  { id: 'addons', label: 'Addons', description: 'Install, remove, refresh, and sort your content sources', icon: 'puzzle' },
  { id: 'debrid', label: 'Debrid', description: 'Play torrent results through Real-Debrid, TorBox or Premiumize', icon: 'bolt' },
  { id: 'playback', label: 'Playback', description: 'Languages, resume, next episode, streams', icon: 'play' },
  { id: 'subtitles', label: 'Subtitles', description: 'Size, colour and position of addon subtitles', icon: 'subs' },
  { id: 'appearance', label: 'Appearance', description: 'Home layout and theme', icon: 'palette' },
  { id: 'integrations', label: 'Integrations', description: 'TMDB metadata', icon: 'link' },
  { id: 'device', label: 'Device', description: 'Controller and app options', icon: 'gamepad' },
  { id: 'about', label: 'About', description: 'Versions and licences', icon: 'info' },
];

function page(title, ...content) {
  return h('div', { class: 'settings-page' }, h('div', { class: 'view-scroll', 'data-scroll-y': '' },
    h('h1', { class: 'page-title' }, title),
    h('div', { class: 'settings-list', 'data-nav-group': '' }, content)));
}

function sectionHeader(text) {
  return h('h2', { class: 'settings-section' }, text);
}

export function settingsView({ params }) {
  const section = params[0];
  if (section) {
    const el = sectionView(section);
    return { el, chrome: 'sidebar', destroy: () => el.__cleanup && el.__cleanup() };
  }
  return {
    el: page('Settings', SECTIONS.map((s) => settingRow({
      label: s.label,
      description: s.description,
      icon: s.icon,
      control: icon('chevron-right', 'setting-chevron'),
      onClick: () => router.go(`settings/${s.id}`),
    }))),
    chrome: 'sidebar',
  };
}

function sectionView(id) {
  switch (id) {
    case 'addons': return addonsPage();
    case 'playback': return playbackPage();
    case 'debrid': return debridPage();
    case 'subtitles': return subtitlesPage();
    case 'appearance': return appearancePage();
    case 'integrations': return integrationsPage();
    case 'device': return devicePage();
    case 'about': return aboutPage();
    case 'account': return accountPage();
    default: return page('Settings', emptyState({ title: 'Not found', message: 'That settings page does not exist.' }));
  }
}

/** A row that picks one of several values with a side panel. */
function choiceRow({ label, description, choices, get, set }) {
  const labelFor = (value) => (choices.find(([v]) => v === value) || [value, String(value)])[1];
  const valueEl = h('span', { class: 'setting-value' }, labelFor(get()));
  return settingRow({
    label,
    description,
    control: valueEl,
    onClick: async () => {
      const choice = await choicePanel({ title: label, items: choices.map(([value, text]) => ({ label: text, value, selected: value === get() })) });
      if (choice === null || choice === undefined) return;
      set(choice);
      valueEl.textContent = labelFor(choice);
    },
  });
}

function settingChoice(name, label, description, choices) {
  return choiceRow({ label, description, choices, get: () => settings.get(name), set: (v) => settings.set(name, v) });
}

function settingToggle(name, label, description) {
  return toggleRow({ label, description, get: () => settings.get(name), set: (v) => settings.set(name, v) });
}

// ---------- Addons ----------

function addonsPage() {
  const list = h('div', { class: 'addon-list' });
  const el = page('Addons',
    h('div', { class: 'settings-actions', 'data-nav-group': '' },
      button('Install Addon', { variant: 'primary', icon: 'plus', autofocus: true, onClick: () => promptInstall() }),
      button('Reset to Defaults', { icon: 'restart', onClick: () => resetDefaults() })),
    h('p', { class: 'settings-hint' }, 'Paste an addon\'s manifest URL (from its configure page). Debrid addons such as Torrentio, Comet, MediaFusion or AIOStreams set up with Real-Debrid, AllDebrid, Premiumize or TorBox give direct links that play on this device.'),
    list);

  async function promptInstall() {
    const url = await promptDialog({ title: 'Install Addon', label: 'Addon URL', placeholder: 'https://…/manifest.json', kind: 'url', confirmLabel: 'Install' });
    if (!url) return;
    toast('Checking addon…');
    try {
      const manifest = await installAddon(url);
      toast(`${manifest.name} installed`, { kind: 'success' });
    } catch (error) {
      toast(`Install failed: ${error.message}`, { kind: 'error', duration: 5000 });
    }
  }

  async function resetDefaults() {
    if (!await confirmDialog({ title: 'Reset addons?', message: 'This removes all your addons and installs Cinemeta and OpenSubtitles again.', confirmLabel: 'Reset', danger: true })) return;
    await replaceAddons(DEFAULT_ADDON_URLS.map((url) => ({ url, enabled: true })));
    toast('Addons reset');
  }

  function render() {
    const focusedKey = focus.current && list.contains(focus.current) ? focus.current.dataset.key : null;
    clear(list);
    const addons = listAddons();
    if (!addons.length) {
      list.appendChild(emptyState({ icon: 'puzzle', title: 'No addons installed yet.', message: 'Add a manifest URL to start loading catalogs, metadata, streams or subtitles into Nuvio.' }));
      return;
    }
    addons.forEach((addon, index) => {
      const m = addon.manifest || {};
      const resources = (m.resources || []).map((r) => (typeof r === 'string' ? r : r.name));
      const badges = [
        addon.enabled === false ? 'Disabled' : 'Active',
        m.catalogs && m.catalogs.length ? `${m.catalogs.length} catalogs` : null,
        ...resources.filter((r) => r !== 'catalog'),
        m.behaviorHints && m.behaviorHints.configurable ? 'Configurable' : null,
        addon.error ? 'Unavailable' : null,
      ].filter(Boolean);
      const key = (name) => `${addon.transportUrl}|${name}`;
      const action = (name, label, iconName, fn, disabled) => {
        const b = button(label, { icon: iconName, title: label, onClick: fn, disabled });
        b.dataset.key = key(name);
        return b;
      };
      const configureUrl = addon.transportUrl.replace(/manifest\.json$/i, 'configure');
      list.appendChild(h('div', { class: ['addon-card', addon.enabled === false && 'disabled'], 'data-nav-row': '' },
        h('div', { class: 'addon-head' },
          m.logo ? img(m.logo, { class: 'addon-logo' }) : h('div', { class: 'addon-logo placeholder' }, icon('puzzle')),
          h('div', { class: 'addon-text' },
            h('div', { class: 'addon-name' }, addonName(addon), h('span', { class: 'addon-version' }, m.version ? `v${m.version}` : '')),
            m.description && h('div', { class: 'addon-description' }, m.description),
            h('div', { class: 'addon-badges' }, badges.map((b) => h('span', { class: 'badge' }, b))),
            h('div', { class: 'addon-url' }, addon.transportUrl.replace(/^https?:\/\//, '').slice(0, 80)))),
        h('div', { class: 'addon-actions', 'data-nav-group': '' },
          action('up', '', 'arrow-up', () => moveAddon(addon.transportUrl, -1), index === 0),
          action('down', '', 'arrow-down', () => moveAddon(addon.transportUrl, 1), index === addons.length - 1),
          action('toggle', addon.enabled === false ? 'Enable' : 'Disable', addon.enabled === false ? 'eye' : 'eye-off', () => setAddonEnabled(addon.transportUrl, addon.enabled === false)),
          action('refresh', 'Refresh', 'refresh', async () => {
            try {
              await refreshAddon(addon.transportUrl);
              toast('Addon refreshed');
            } catch (error) {
              toast(`Refresh failed: ${error.message}`, { kind: 'error' });
            }
          }),
          m.behaviorHints && m.behaviorHints.configurable
            ? action('configure', 'Configure', 'tune', () => openExternal(configureUrl))
            : null,
          action('remove', 'Remove', 'trash', async () => {
            if (await confirmDialog({ title: 'Delete addon?', message: `Remove ${addonName(addon)}?`, confirmLabel: 'Remove', danger: true })) removeAddon(addon.transportUrl);
          }))));
    });
    if (focusedKey) {
      const again = list.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`);
      if (again && !again.disabled) focus.set(again);
      else if (again) focus.restore(again.parentElement);
    }
  }

  const off = events.on('addons', render);
  render();
  el.__cleanup = off;
  return el;
}

function openExternal(url) {
  if (bridge.native) bridge.send('app.openExternal', { url });
  else window.open(url, '_blank', 'noopener');
}

// ---------- Debrid ----------

function debridPage() {
  const list = h('div', { class: 'settings-list', 'data-nav-group': '' });
  const el = h('div', { class: 'settings-page' }, h('div', { class: 'view-scroll', 'data-scroll-y': '' },
    h('h1', { class: 'page-title' }, 'Debrid'), list));

  async function connect(provider) {
    const info = DEBRID_PROVIDERS[provider];
    const key = await promptDialog({
      title: `${info.name} API key`,
      message: `Find it at ${info.keyHelp}.`,
      label: 'API key',
      confirmLabel: 'Connect',
    });
    if (!key || !key.trim()) return;
    toast('Checking key…');
    try {
      if (!await validateDebridKey(provider, key)) {
        toast(`${info.name} didn't accept that key.`, { kind: 'error' });
        return;
      }
    } catch (error) {
      toast(`Couldn't reach ${info.name}: ${error.message}`, { kind: 'error' });
      return;
    }
    setDebridAccount({ provider, apiKey: key.trim() });
    toast(`${info.name} connected`, { kind: 'success' });
    render();
  }

  function render() {
    clear(list);
    const account = debridAccount();
    list.append(h('p', { class: 'settings-hint' },
      'Addons that already include your debrid service (Torrentio, Comet, AIOStreams...) work without this. ' +
      'Connect a service here to also play plain torrent results: the service fetches the torrent and this device plays the file it serves. Only results already cached by the service play straight away.'));
    if (account) {
      const info = DEBRID_PROVIDERS[account.provider];
      list.append(
        settingRow({ label: info.name, description: 'Connected. Torrent results show "via ' + info.short + '" and play through it.', icon: 'bolt', value: 'Connected' }),
        settingRow({
          label: `Disconnect ${info.name}`,
          icon: 'logout',
          onClick: async () => {
            if (await confirmDialog({ title: `Disconnect ${info.name}?`, message: 'Torrent results will be hidden again.', confirmLabel: 'Disconnect', danger: true })) {
              setDebridAccount(null);
              render();
            }
          },
        }));
    } else {
      list.append(h('h2', { class: 'settings-section' }, 'CONNECT A SERVICE'));
      for (const [id, info] of Object.entries(DEBRID_PROVIDERS)) {
        list.append(settingRow({ label: info.name, description: `API key from ${info.keyHelp}`, icon: 'bolt', value: 'Connect', onClick: () => connect(id) }));
      }
    }
    focus.restore(list);
  }

  render();
  return el;
}

// ---------- Playback ----------

function playbackPage() {
  const languages = [['', 'None'], ...LANGUAGE_CHOICES];
  return page('Playback',
    sectionHeader('LANGUAGES'),
    settingChoice('preferredAudioLanguage', 'Preferred audio language', 'Picked automatically when a file has several', LANGUAGE_CHOICES),
    settingToggle('autoSelectSubtitles', 'Turn on subtitles automatically', 'In your preferred language, from the file or your subtitle addons'),
    settingChoice('preferredSubtitleLanguage', 'Preferred subtitle language', null, LANGUAGE_CHOICES),
    settingChoice('secondarySubtitleLanguage', 'Second subtitle language', 'Used when the first isn\'t available', languages),
    sectionHeader('PLAYBACK'),
    settingToggle('resumePlayback', 'Resume where you left off', null),
    settingToggle('autoplayNext', 'Play next episode automatically', 'Shows a countdown at the end of an episode'),
    settingChoice('nextEpisodeCountdown', 'Next episode countdown', null, [[5, '5 seconds'], [10, '10 seconds'], [15, '15 seconds'], [30, '30 seconds']]),
    settingToggle('hardwareDecoding', 'Hardware decoding', 'Turn off if a video shows a green or corrupted picture'),
    sectionHeader('STREAMS'),
    settingChoice('streamSort', 'Sort streams', null, [['addon', 'Addon order'], ['quality', 'Best quality first'], ['size', 'Largest first']]),
    settingToggle('rememberLastStream', 'Continue with the last stream', 'Continue Watching reuses the link you played last'),
    settingToggle('showUnsupportedStreams', 'Show torrent results', 'Torrents can\'t play on this device; they\'re listed for reference only'));
}

// ---------- Subtitles ----------

function subtitlesPage() {
  const preview = h('div', { class: 'subtitle-preview' }, h('div', { class: 'player-subs' }, h('div', { class: 'sub-line' }, 'This is how subtitles will look.')));
  const apply = () => {
    const box = preview.firstChild;
    box.style.setProperty('--sub-size', `${2.4 * settings.get('subtitleSize') / 100}rem`);
    box.style.setProperty('--sub-color', settings.get('subtitleColor'));
    box.style.setProperty('--sub-offset', '20%');
    box.dataset.background = settings.get('subtitleBackground');
  };
  apply();
  const el = page('Subtitles',
    preview,
    settingChoice('subtitleSize', 'Size', null, [[70, 'Small'], [85, 'Medium'], [100, 'Default'], [120, 'Large'], [145, 'Extra large']]),
    settingChoice('subtitleColor', 'Colour', null, [['#ffffff', 'White'], ['#ffeb3b', 'Yellow'], ['#8be9fd', 'Cyan'], ['#a5d6a7', 'Green']]),
    settingChoice('subtitleBackground', 'Background', null, [['none', 'Outline'], ['shadow', 'Drop shadow'], ['box', 'Dark box']]),
    settingChoice('subtitleOffset', 'Position', 'Distance from the bottom of the screen', [[3, 'Lowest'], [8, 'Default'], [14, 'Higher'], [20, 'Highest']]),
    h('p', { class: 'settings-hint' }, 'These apply to subtitles from addons. Subtitles built into a video file are drawn by VLC in its own style.'));
  el.__cleanup = events.on('settings', apply);
  return el;
}

// ---------- Appearance ----------

function appearancePage() {
  return page('Appearance',
    sectionHeader('THEME'),
    settingToggle('amoled', 'AMOLED Black', 'Use pure black backgrounds for OLED screens'),
    sectionHeader('HOME'),
    settingToggle('showHero', 'Featured titles', 'The large banner at the top of Home'),
    settingToggle('showCatalogType', 'Show Catalog Type', 'Show type suffix next to catalog name (Movie/Series)'),
    settingToggle('hideUnreleased', 'Hide Unreleased Content', 'Hide movies and shows that haven\'t been released yet'));
}

// ---------- Integrations ----------

function integrationsPage() {
  const keyRow = () => settingRow({
    label: 'TMDB API key',
    description: 'Optional. Adds logos, backdrops and cast photos where addons lack them.',
    value: settings.get('tmdbApiKey') ? 'Set' : 'Not set',
    onClick: async () => {
      const value = await promptDialog({ title: 'TMDB API key', label: 'API key (v3)', value: settings.get('tmdbApiKey'), confirmLabel: 'Save' });
      if (value === null) return;
      settings.set('tmdbApiKey', value.trim());
      row.replaceWith(row = keyRow());
      focus.set(row);
    },
  });
  let row = keyRow();
  return page('Integrations', row,
    h('p', { class: 'settings-hint' }, 'Get a free key at themoviedb.org → Settings → API.'));
}

// ---------- Device ----------

function devicePage() {
  const rows = [];
  if (bridge.native) {
    rows.push(sectionHeader('CONTROLLER'),
      toggleRow({
        label: 'Controller cursor',
        description: 'Use the left stick as a mouse pointer instead of moving the highlight',
        get: () => settings.get('controllerCursor'),
        set: (v) => {
          settings.set('controllerCursor', v);
          bridge.send('app.pointer', { enabled: v });
          toast(v ? 'Left stick moves a pointer; A clicks under it' : 'Pointer off: use the D-pad');
        },
      }));
    rows.push(sectionHeader('DEVELOPER'),
      settingRow({
        label: 'Web app address',
        description: bridge.webAppUrl
          ? `Loading the web app from ${bridge.webAppUrl}`
          : 'Using the web app built into this package. Point this at a computer running tools/serve.mjs to try changes without reinstalling.',
        value: bridge.webAppUrl ? 'Custom' : 'Built-in',
        onClick: async () => {
          const value = await promptDialog({ title: 'Web app address', label: 'Address', value: bridge.webAppUrl || 'http://', kind: 'url', message: 'Leave empty to use the built-in app.', confirmLabel: 'Load' });
          if (value === null) return;
          const url = value.trim() === 'http://' ? '' : value.trim();
          bridge.send('app.setWebAppUrl', { url: url || null });
        },
      }));
  }
  rows.push(sectionHeader('DATA'),
    settingRow({
      label: 'Reset settings',
      description: 'Back to the default settings (keeps addons, library and progress)',
      onClick: async () => {
        if (await confirmDialog({ title: 'Reset settings?', message: 'Your addons, library and watch progress are kept.', confirmLabel: 'Reset', danger: true })) {
          settings.reset();
          toast('Settings reset');
        }
      },
    }),
    settingRow({
      label: 'Erase everything',
      description: 'Removes all addons, library, progress and settings from this device',
      onClick: async () => {
        if (!await confirmDialog({ title: 'Erase all data?', message: 'This cannot be undone.', confirmLabel: 'Erase', danger: true })) return;
        localStorage.clear();
        location.hash = '';
        location.reload();
      },
    }));
  if (bridge.native) {
    rows.push(settingRow({ label: 'Exit Nuvio', icon: 'logout', onClick: () => bridge.send('app.exit') }));
  }
  return page('Device', rows);
}

// ---------- About ----------

function aboutPage() {
  const facts = [
    ['Nuvio web app', '1.0.0'],
    ['App', bridge.native ? (bridge.appVersion || 'unknown') + ` (${bridge.platform})` : 'Browser'],
    ['Video player', bridge.native ? (bridge.vlcVersion ? `LibVLC ${bridge.vlcVersion}` : 'VLC (starting…)') : 'Browser <video>'],
    ['Addons', String(listAddons().length)],
  ];
  return page('About',
    h('div', { class: 'about-card' },
      img('assets/wordmark.png', { class: 'about-wordmark', alt: 'Nuvio', loading: 'eager' }),
      h('p', null, 'An unofficial Nuvio client for Xbox and the web, with VLC built in so MKV, HEVC, Dolby Vision/HDR and lossless audio streams from debrid services play directly.'),
      h('dl', { class: 'about-facts' }, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))),
    settingRow({ label: 'Licences', description: 'GPL-3.0. Based on Nuvio (NuvioMedia) and Stremio UWP; video by LibVLC (LGPL-2.1).', icon: 'info' }),
    h('p', { class: 'settings-hint' }, 'Not affiliated with NuvioMedia, Stremio or VideoLAN. Bring your own sources: Nuvio does not host or provide any content.'));
}


