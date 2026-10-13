// Persistent state in localStorage, an app-wide event bus and the settings object.

const PREFIX = 'nuvio:';

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === undefined) localStorage.removeItem(PREFIX + key);
      else localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (error) {
      console.warn('Saving', key, 'failed', error);
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {}
  },
};

/** Profile-scoped storage key, e.g. "p1:library" (Nuvio keeps data per profile). */
export function profileKey(name) {
  return `p${storage.get('activeProfile', 1)}:${name}`;
}

class Events {
  constructor() {
    this.handlers = new Map();
  }
  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
    return () => this.off(type, handler);
  }
  off(type, handler) {
    this.handlers.get(type)?.delete(handler);
  }
  emit(type, detail) {
    for (const handler of [...(this.handlers.get(type) || [])]) {
      try {
        handler(detail);
      } catch (error) {
        console.error('Event handler for', type, 'failed', error);
      }
    }
  }
}

export const events = new Events();

export const DEFAULT_SETTINGS = {
  // Playback
  preferredAudioLanguage: 'eng',
  preferredSubtitleLanguage: 'eng',
  secondarySubtitleLanguage: '',
  autoSelectSubtitles: false,
  autoplayNext: true,
  nextEpisodeCountdown: 10,
  resumePlayback: true,
  hardwareDecoding: true,
  // Streams
  showUnsupportedStreams: false,
  streamSort: 'addon', // addon | quality | size
  rememberLastStream: true,
  // Subtitle appearance (addon subtitles are drawn by the app)
  subtitleSize: 100, // percent
  subtitleColor: '#ffffff',
  subtitleBackground: 'none', // none | shadow | box
  subtitleOffset: 8, // percent of screen height from the bottom
  // Appearance
  amoled: false,
  showHero: true,
  showCatalogType: true,
  hideUnreleased: false,
  // Integrations
  tmdbApiKey: '',
  traktScrobble: true, // scrobble playback to Trakt
  traktImportHistory: true, // bring Trakt's watched history and paused progress in
  traktHomeRows: true, // watchlist and recommendations on Home
  traktClientId: '', // the user's own Trakt API app, when the build has none
  traktClientSecret: '',
  // Device
  controllerCursor: false,
  // Account
  askProfileAtLaunch: true, // "who's watching" at startup when the account has several profiles
};

const SETTINGS_KEY = 'settings';
let current = { ...DEFAULT_SETTINGS, ...storage.get(SETTINGS_KEY, {}) };

export const settings = {
  get(name) {
    return current[name];
  },
  all() {
    return { ...current };
  },
  set(name, value) {
    if (current[name] === value) return;
    current = { ...current, [name]: value };
    storage.set(SETTINGS_KEY, current);
    events.emit('settings', { name, value });
  },
  reset() {
    current = { ...DEFAULT_SETTINGS };
    storage.set(SETTINGS_KEY, current);
    events.emit('settings', {});
  },
};
