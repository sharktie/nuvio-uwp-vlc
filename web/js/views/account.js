import { h, clear, append } from '../core/dom.js';
import { qrSvg } from '../core/qr.js';
import { focus } from '../core/focus.js';
import { events, storage } from '../core/store.js';
import {
  getServer, setServer, discoverServer, manualServer, getSession, isSignedIn, signInWithEmail, signInWithCode,
  signOut, pullAll, pullProfiles, cachedProfiles, activeProfileIndex, switchProfile, verifyProfilePin, officialServer,
} from '../services/account.js';
import { importFromStremio } from '../services/stremio.js';
import { settingRow, button, promptDialog, confirmDialog, toast, openDialog, spinner, choicePanel } from '../components/ui.js';

/** Settings > Account: connect a Nuvio server, sign in, profiles and sync. */
export function accountPage() {
  const list = h('div', { class: 'settings-list', 'data-nav-group': '' });
  const el = h('div', { class: 'settings-page' }, h('div', { class: 'view-scroll', 'data-scroll-y': '' },
    h('h1', { class: 'page-title' }, 'Account'), list));

  const add = (...nodes) => append(list, nodes);

  function render() {
    const focusedLabel = focus.current && list.contains(focus.current) ? focus.current.textContent : null;
    clear(list);
    const server = getServer();
    const session = getSession();
    if (server && session) {
      const lastSync = storage.get('lastSync', 0);
      add(
        h('div', { class: 'about-card' },
          h('div', { class: 'account-email' }, session.user && session.user.email ? session.user.email : 'Signed in'),
          h('p', null, `Connected to ${server.name}. Your addons, library, Continue Watching and watched marks sync with your other Nuvio apps.`),
          h('p', { class: 'settings-hint' }, lastSync ? `Last synced ${new Date(lastSync).toLocaleString()}` : 'Not synced yet')),
        settingRow({
          label: 'Sync now',
          description: 'Replace what\'s on this device with your account\'s addons and library',
          icon: 'refresh',
          onClick: async () => {
            toast('Syncing…');
            try {
              await pullAll();
              toast('Synced', { kind: 'success' });
            } catch (error) {
              toast(`Sync failed: ${error.message}`, { kind: 'error' });
            }
          },
        }),
        profileRow(),
        settingRow({
          label: 'Sign out',
          description: 'Your addons and library stay on this device',
          icon: 'logout',
          onClick: async () => {
            if (await confirmDialog({ title: 'Sign out?', message: 'Sync stops until you sign in again.', confirmLabel: 'Sign out', danger: true })) signOut();
          },
        }));
    } else {
      add(h('p', { class: 'settings-hint' }, server
        ? 'Sign in with your Nuvio account to bring over the addons, library and progress from your phone or computer, without typing addon links on the TV.'
        : 'This app has no Nuvio server built in. Connect to a self-hosted Nuvio server, or import your addons and library from a Stremio account below.'));
      if (server) {
        add(
          h('h2', { class: 'settings-section' }, 'SIGN IN'),
          server.tvLogin !== false ? settingRow({
            label: 'Sign in with a code',
            description: 'Scan a QR code or enter a code on your phone or computer',
            icon: 'link',
            onClick: codeSignIn,
          }) : null,
          server.emailPasswordAuth !== false ? settingRow({
            label: 'Sign in with email',
            description: 'Use your Nuvio account email and password',
            icon: 'person',
            onClick: emailSignIn,
          }) : null);
      }
      add(
        h('h2', { class: 'settings-section' }, 'SERVER'),
        settingRow({
          label: server ? server.name : 'No server set up',
          description: server ? (server.official ? 'Built into this app' : server.backendUrl) : 'Connect to a Nuvio server to sign in',
          icon: 'cloud',
          value: server ? 'Change' : 'Set up',
          onClick: chooseServer,
        }));
    }
    add(
      h('h2', { class: 'settings-section' }, 'STREMIO'),
      settingRow({
        label: 'Import from Stremio',
        description: 'Copy the addons (with their debrid setup), library and Continue Watching from your Stremio account',
        icon: 'puzzle',
        onClick: stremioImport,
      }));
    if (focusedLabel) {
      const again = [...list.querySelectorAll('.focusable')].find((e) => e.textContent === focusedLabel);
      if (again) focus.set(again);
    }
  }

  function profileRow() {
    const profiles = cachedProfiles();
    if (profiles.length < 2) return null;
    const active = profiles.find((p) => p.profile_index === activeProfileIndex());
    return settingRow({
      label: 'Profile',
      description: 'Each profile has its own addons, library and progress',
      icon: 'person',
      value: active ? active.name : `Profile ${activeProfileIndex()}`,
      onClick: chooseProfile,
    });
  }

  async function chooseProfile() {
    let profiles = cachedProfiles();
    try {
      profiles = await pullProfiles();
    } catch {}
    const choice = await choicePanel({
      title: 'Switch profile',
      items: profiles.map((p) => ({
        label: p.name || `Profile ${p.profile_index}`,
        description: [p.pin_enabled ? 'PIN locked' : null, p.uses_primary_addons ? 'Uses the main profile\'s addons' : null].filter(Boolean).join(' · ') || null,
        value: p,
        selected: p.profile_index === activeProfileIndex(),
      })),
    });
    if (!choice || choice.profile_index === activeProfileIndex()) return;
    if (choice.pin_enabled) {
      const pin = await promptDialog({ title: `PIN for ${choice.name}`, label: 'PIN', kind: 'password', confirmLabel: 'Unlock' });
      if (!pin) return;
      try {
        const result = await verifyProfilePin(choice.profile_index, pin);
        if (!result.unlocked) {
          toast(result.message || (result.retryAfter ? `Too many tries. Wait ${result.retryAfter}s.` : 'Wrong PIN'), { kind: 'error' });
          return;
        }
      } catch (error) {
        toast(`Couldn't check the PIN: ${error.message}`, { kind: 'error' });
        return;
      }
    }
    switchProfile(choice.profile_index);
  }

  async function chooseServer() {
    const choice = await choicePanel({
      title: 'Nuvio server',
      items: [
        officialServer() ? { label: 'Nuvio', description: 'The server built into this app', value: 'official', selected: !!(getServer() && getServer().official) } : null,
        { label: 'Self-hosted server', description: 'Find it from its address', value: 'discover' },
        { label: 'Enter server details', description: 'Backend URL and publishable key', value: 'manual' },
        getServer() && !getServer().official ? { label: 'Remove server', value: 'remove' } : null,
      ].filter(Boolean),
    });
    try {
      if (choice === 'discover') {
        const address = await promptDialog({ title: 'Server address', label: 'Address', placeholder: 'https://nuvio.example.com', kind: 'url', confirmLabel: 'Connect' });
        if (!address) return;
        toast('Connecting…');
        setServer(await discoverServer(address));
        toast('Server connected', { kind: 'success' });
      } else if (choice === 'manual') {
        const current = getServer();
        const url = await promptDialog({ title: 'Backend URL', label: 'Backend URL', value: current ? current.backendUrl : 'https://', kind: 'url', confirmLabel: 'Next' });
        if (!url) return;
        const key = await promptDialog({ title: 'Publishable key', label: 'Publishable (anon) key', value: current ? current.publishableKey : '', confirmLabel: 'Save' });
        if (!key) return;
        setServer(manualServer(url, key));
        toast('Server saved', { kind: 'success' });
      } else if (choice === 'remove' || choice === 'official') {
        // Without a chosen server the built-in one (if any) is used.
        setServer(null);
      }
    } catch (error) {
      toast(error.message, { kind: 'error', duration: 5000 });
    }
  }

  async function emailSignIn() {
    const email = await promptDialog({ title: 'Sign in', label: 'Email', kind: 'email', confirmLabel: 'Next' });
    if (!email) return;
    const password = await promptDialog({ title: 'Password', label: 'Password', kind: 'password', confirmLabel: 'Sign in' });
    if (!password) return;
    toast('Signing in…');
    try {
      await signInWithEmail(email, password);
      toast('Signed in', { kind: 'success' });
    } catch (error) {
      toast(`Sign-in failed: ${error.message}`, { kind: 'error', duration: 5000 });
    }
  }

  function codeSignIn() {
    const controller = new AbortController();
    openDialog({
      title: 'Sign in with a code',
      build: (close) => {
        const body = h('div', { class: 'code-signin' }, spinner(), h('p', null, 'Starting secure sign-in…'));
        signInWithCode(({ code, url, linkUrl }) => {
          let qr = null;
          try {
            qr = h('div', { class: 'code-qr', html: qrSvg(url || linkUrl) });
          } catch {}
          clear(body).append(h('div', { class: 'code-layout' },
            qr || h('div'),
            h('div', { class: 'code-text' },
              h('p', null, qr ? 'Scan with your phone, or open' : 'On your phone or computer, open'),
              h('div', { class: 'code-link' }, linkUrl.replace(/^https?:\/\//, '')),
              h('p', null, 'and enter this code:'),
              h('div', { class: 'code-value' }, code),
              h('p', { class: 'settings-hint' }, 'Waiting for approval…'))));
        }, controller.signal).then(() => {
          toast('Signed in', { kind: 'success' });
          close(true);
        }).catch((error) => {
          if (controller.signal.aborted) return;
          clear(body).append(h('p', null, error.message || 'Could not start sign-in.'));
        });
        return h('div', null, body, h('div', { class: 'dialog-actions' }, button('Cancel', { autofocus: true, onClick: () => close(null) })));
      },
    }).then(() => controller.abort());
  }

  async function stremioImport() {
    const email = await promptDialog({ title: 'Import from Stremio', message: 'Your Stremio password is only sent to Stremio, and isn\'t kept.', label: 'Stremio email', kind: 'email', confirmLabel: 'Next' });
    if (!email) return;
    const password = await promptDialog({ title: 'Stremio password', label: 'Password', kind: 'password', confirmLabel: 'Import' });
    if (!password) return;
    try {
      const result = await importFromStremio(email, password, (step) => toast(step));
      const parts = [`${result.addons} new addon${result.addons === 1 ? '' : 's'}`, `${result.library} library title${result.library === 1 ? '' : 's'}`];
      if (result.progress) parts.push(`${result.progress} in progress`);
      toast(`Imported ${parts.join(', ')}`, { kind: 'success', duration: 5000 });
    } catch (error) {
      toast(`Import failed: ${error.message}`, { kind: 'error', duration: 5000 });
    }
  }

  const off = events.on('account', render);
  render();
  el.__cleanup = off;
  return el;
}
