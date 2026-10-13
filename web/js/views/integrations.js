import { h, clear, append } from '../core/dom.js';
import { qrSvg } from '../core/qr.js';
import { focus } from '../core/focus.js';
import { events, settings } from '../core/store.js';
import config from '../config.js';
import {
  traktApp, traktAccount, traktConnected, connectTrakt, disconnectTrakt, syncTrakt,
} from '../services/trakt.js';
import {
  jellyfinServers, findServer, quickConnectAvailable, signInWithQuickConnect, signInWithPassword, removeServer,
  syncJellyfin, productName,
} from '../services/jellyfin.js';
import {
  settingRow, toggleRow, button, promptDialog, confirmDialog, toast, openDialog, spinner, choicePanel,
} from '../components/ui.js';

/** Settings > Integrations: Trakt, Jellyfin and Emby servers, TMDB. */
export function integrationsPage() {
  const list = h('div', { class: 'settings-list', 'data-nav-group': '' });
  const el = h('div', { class: 'settings-page' }, h('div', { class: 'view-scroll', 'data-scroll-y': '' },
    h('h1', { class: 'page-title' }, 'Integrations'), list));
  const add = (...nodes) => append(list, nodes);
  const synced = (at) => (at ? `Last synced ${new Date(at).toLocaleString()}` : 'Not synced yet');

  function render() {
    const focusedLabel = focus.current && list.contains(focus.current) ? focus.current.textContent : null;
    clear(list);
    traktSection();
    jellyfinSection();
    tmdbSection();
    if (focusedLabel) {
      const again = [...list.querySelectorAll('.focusable')].find((e) => e.textContent === focusedLabel);
      if (again) focus.set(again);
    }
  }

  // ---------- Trakt ----------

  function traktSection() {
    add(h('h2', { class: 'settings-section' }, 'TRAKT'));
    const account = traktAccount();
    if (traktConnected()) {
      const who = account.user ? account.user.name || account.user.username : 'your Trakt account';
      add(
        settingRow({
          label: 'Trakt',
          description: account.error ? account.error : `Signed in as ${who}. ${synced(account.lastSync)}.`,
          icon: 'link',
          value: account.error ? 'Problem' : 'Connected',
        }),
        toggleRow({
          label: 'Scrobble what you play',
          description: 'Trakt follows your progress and marks titles watched when you finish them',
          get: () => settings.get('traktScrobble'),
          set: (v) => settings.set('traktScrobble', v),
        }),
        toggleRow({
          label: 'Bring in your Trakt history',
          description: 'Watched marks, and paused progress for Continue Watching',
          get: () => settings.get('traktImportHistory'),
          set: (v) => settings.set('traktImportHistory', v),
        }),
        toggleRow({
          label: 'Watchlist on Home',
          description: 'Your Trakt watchlist and recommendations as rows on Home',
          get: () => settings.get('traktHomeRows'),
          set: (v) => settings.set('traktHomeRows', v),
        }),
        settingRow({
          label: 'Sync now',
          description: 'Bring in everything from Trakt again',
          icon: 'refresh',
          onClick: async () => {
            toast('Syncing with Trakt…');
            try {
              await syncTrakt({ full: true });
              toast('Synced with Trakt', { kind: 'success' });
            } catch (error) {
              toast(`Trakt sync failed: ${error.message}`, { kind: 'error' });
            }
          },
        }),
        settingRow({
          label: 'Disconnect Trakt',
          description: 'Watched marks already brought in stay on this device',
          icon: 'logout',
          onClick: async () => {
            if (await confirmDialog({ title: 'Disconnect Trakt?', message: 'Scrobbling and the Trakt rows on Home stop.', confirmLabel: 'Disconnect', danger: true })) disconnectTrakt();
          },
        }));
    } else {
      add(settingRow({
        label: 'Connect Trakt',
        description: traktApp()
          ? 'Scan a QR code or enter a code at trakt.tv/activate on your phone or computer'
          : 'This build has no Trakt API app. Select to enter your own app\'s client ID and secret first.',
        icon: 'link',
        onClick: () => (traktApp() ? traktSignIn() : setTraktApp()),
      }));
    }
    if (!traktConnected() && (settings.get('traktClientId') || !(config.trakt && config.trakt.clientId))) {
      add(settingRow({
        label: 'Trakt API app',
        description: settings.get('traktClientId')
          ? 'Using your own app. Select to change or remove it.'
          : 'Create one at trakt.tv/oauth/applications with the redirect URI urn:ietf:wg:oauth:2.0:oob',
        icon: 'code',
        value: settings.get('traktClientId') ? 'Your own' : 'Not set',
        onClick: setTraktApp,
      }));
    }
  }

  async function setTraktApp() {
    const clientId = await promptDialog({
      title: 'Trakt API app',
      message: 'Create an app at trakt.tv/oauth/applications (redirect URI: urn:ietf:wg:oauth:2.0:oob), then enter its Client ID. Leave it empty to remove your app.',
      label: 'Client ID',
      value: settings.get('traktClientId'),
      confirmLabel: 'Next',
    });
    if (clientId === null) return;
    if (!clientId.trim()) {
      settings.set('traktClientId', '');
      settings.set('traktClientSecret', '');
      render();
      return;
    }
    const secret = await promptDialog({ title: 'Trakt API app', label: 'Client Secret', value: settings.get('traktClientSecret'), confirmLabel: 'Save' });
    if (!secret || !secret.trim()) return;
    settings.set('traktClientId', clientId.trim());
    settings.set('traktClientSecret', secret.trim());
    render();
    traktSignIn();
  }

  function traktSignIn() {
    codeDialog({
      title: 'Connect Trakt',
      start: (show, signal) => connectTrakt(({ code, url }) => show({ code, url, hint: 'and enter this code:' }), signal),
      done: () => toast('Trakt connected', { kind: 'success' }),
    });
  }

  // ---------- Jellyfin and Emby ----------

  function jellyfinSection() {
    add(h('h2', { class: 'settings-section' }, 'JELLYFIN AND EMBY'));
    for (const server of jellyfinServers()) {
      add(settingRow({
        label: `${productName(server)} · ${server.name}`,
        description: server.error ? server.error : `${server.userName} on ${server.url.replace(/^https?:\/\//, '')}. ${synced(server.lastSync)}.`,
        icon: 'cloud',
        value: server.error ? 'Problem' : 'Connected',
        onClick: () => serverMenu(server),
      }));
    }
    add(settingRow({
      label: jellyfinServers().length ? 'Add another server' : 'Add a server',
      description: 'Your libraries become rows on Home and their files play here directly, original quality',
      icon: 'plus',
      onClick: addServer,
    }));
  }

  async function serverMenu(server) {
    const choice = await choicePanel({
      title: server.name,
      items: [
        { label: 'Sync now', description: 'Libraries, resume points and watched marks', value: 'sync' },
        { label: 'Remove server', description: 'Signs this device out of the server', value: 'remove' },
      ],
    });
    if (choice === 'sync') {
      toast(`Syncing with ${server.name}…`);
      try {
        await syncJellyfin(server.key);
        toast(`Synced with ${server.name}`, { kind: 'success' });
      } catch (error) {
        toast(`Sync failed: ${error.message}`, { kind: 'error' });
      }
    } else if (choice === 'remove') {
      if (await confirmDialog({ title: `Remove ${server.name}?`, message: 'Its rows and streams disappear from the app.', confirmLabel: 'Remove', danger: true })) removeServer(server.key);
    }
  }

  async function addServer() {
    const address = await promptDialog({
      title: 'Jellyfin or Emby server',
      message: 'The address you open your server at, e.g. 192.168.1.20:8096 or https://media.example.com',
      label: 'Server address',
      kind: 'url',
      confirmLabel: 'Next',
    });
    if (!address) return;
    toast('Looking for the server…');
    let server;
    try {
      server = await findServer(address);
    } catch (error) {
      toast(error.message, { kind: 'error', duration: 6000 });
      return;
    }
    let method = 'password';
    if (await quickConnectAvailable(server)) {
      method = await choicePanel({
        title: `Sign in to ${server.name}`,
        items: [
          { label: 'Quick Connect', description: 'Approve a code in the Jellyfin app on your phone or the web', value: 'quick' },
          { label: 'Username and password', value: 'password' },
        ],
      });
      if (!method) return;
    }
    if (method === 'quick') {
      codeDialog({
        title: `Quick Connect · ${server.name}`,
        start: (show, signal) => signInWithQuickConnect(server, (code) => show({
          code,
          text: 'In another Jellyfin app signed in as you (phone, or the web at your server\'s address), open Settings → Quick Connect and enter:',
        }), signal),
        done: () => toast(`Signed in to ${server.name}`, { kind: 'success' }),
      });
      return;
    }
    const username = await promptDialog({ title: `Sign in to ${server.name}`, label: 'Username', confirmLabel: 'Next' });
    if (!username) return;
    const password = await promptDialog({ title: `Password for ${username}`, message: 'Leave it empty if the user has no password.', label: 'Password', kind: 'password', confirmLabel: 'Sign in' });
    if (password === null) return;
    toast('Signing in…');
    try {
      await signInWithPassword(server, username.trim(), password);
      toast(`Signed in to ${server.name}`, { kind: 'success' });
    } catch (error) {
      toast(`Sign-in failed: ${error.message}`, { kind: 'error', duration: 5000 });
    }
  }

  // ---------- TMDB ----------

  function tmdbSection() {
    add(
      h('h2', { class: 'settings-section' }, 'TMDB'),
      settingRow({
        label: 'TMDB API key',
        description: 'Optional. Adds cast photos, "More like this", and logos and backdrops where addons lack them. Get a free key at themoviedb.org → Settings → API.',
        value: settings.get('tmdbApiKey') ? 'Set' : config.tmdbApiKey ? 'Built in' : 'Not set',
        onClick: async () => {
          const value = await promptDialog({ title: 'TMDB API key', label: 'API key (v3)', value: settings.get('tmdbApiKey'), confirmLabel: 'Save' });
          if (value === null) return;
          settings.set('tmdbApiKey', value.trim());
          render();
        },
      }));
  }

  const offs = [events.on('trakt', render), events.on('jellyfin', render)];
  render();
  el.__cleanup = () => offs.forEach((off) => off());
  return el;
}

/**
 * A sign-in code dialog. start(show, signal) begins sign-in and calls show({ code, url, hint, text })
 * to display the code (with a QR code when there's a URL); it resolves when approved.
 */
function codeDialog({ title, start, done }) {
  const controller = new AbortController();
  openDialog({
    title,
    build: (close) => {
      const body = h('div', { class: 'code-signin' }, spinner(), h('p', null, 'Getting a code…'));
      start(({ code, url, hint, text }) => {
        let qr = null;
        if (url) {
          try {
            qr = h('div', { class: 'code-qr', html: qrSvg(url) });
          } catch {}
        }
        clear(body).append(h('div', { class: 'code-layout' },
          qr,
          h('div', { class: 'code-text' },
            text ? h('p', null, text) : h('p', null, qr ? 'Scan with your phone, or open' : 'On your phone or computer, open'),
            url ? h('div', { class: 'code-link' }, url.replace(/^https?:\/\//, '')) : null,
            hint ? h('p', null, hint) : null,
            h('div', { class: 'code-value' }, code),
            h('p', { class: 'settings-hint' }, 'Waiting for approval…'))));
      }, controller.signal).then(() => {
        if (done) done();
        close(true);
      }).catch((error) => {
        if (controller.signal.aborted) return;
        clear(body).append(h('p', null, error.message || 'Sign-in failed.'));
      });
      return h('div', null, body, h('div', { class: 'dialog-actions' }, button('Cancel', { autofocus: true, onClick: () => close(null) })));
    },
  }).then(() => controller.abort());
}
