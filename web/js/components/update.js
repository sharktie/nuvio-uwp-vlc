import { h } from '../core/dom.js';
import { qrSvg } from '../core/qr.js';
import { bridge } from '../core/bridge.js';
import { formatDate } from '../core/format.js';
import { openDialog, button } from './ui.js';

/** Explains how to get a newer release onto the console (there's no installing from inside the app). */
export function showUpdateDialog(release) {
  return openDialog({
    title: release.newer ? 'Update available' : 'Latest version',
    wide: true,
    build: (close) => {
      let qr = null;
      try {
        qr = h('div', { class: 'code-qr', html: qrSvg(release.url) });
      } catch {}
      const released = release.publishedAt ? ` (released ${formatDate(release.publishedAt)})` : '';
      return h('div', { class: 'update-dialog' },
        h('p', { class: 'dialog-message' }, release.newer
          ? `Nuvio ${release.version} is out${released}. This console has ${bridge.appVersion}.`
          : `Nuvio ${release.version}${released} is the newest release.`),
        release.notes.length ? h('div', { class: 'update-notes' },
          h('h3', null, 'What\'s new'),
          h('ul', null, release.notes.slice(0, 8).map((note) => h('li', null, note)))) : null,
        release.newer ? h('div', { class: 'code-layout' },
          qr || h('div'),
          h('div', { class: 'code-text' },
            h('p', null, qr ? 'Scan for the download, or on your PC open' : 'On your PC, open'),
            h('div', { class: 'code-link' }, release.url.replace(/^https?:\/\//, '')),
            h('p', null, 'Download NuvioUWPVLC-x64.zip and install it in the Device Portal the same way as before (the .msix, then the 5 files in Dependencies).'),
            h('p', { class: 'settings-hint' }, 'It installs over this version and keeps your sign-in, addons, library and settings.'))) : null,
        h('div', { class: 'dialog-actions' }, button('OK', { variant: 'primary', autofocus: true, onClick: () => close(true) })));
    },
  });
}
