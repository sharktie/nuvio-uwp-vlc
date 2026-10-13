import { h, icon, img } from '../core/dom.js';
import { focus } from '../core/focus.js';
import { router } from '../core/router.js';
import { events } from '../core/store.js';

const ITEMS = [
  { route: 'home', label: 'Home', icon: 'nav-home' },
  { route: 'search', label: 'Search', icon: 'nav-search' },
  { route: 'library', label: 'Library', icon: 'nav-library' },
  { route: 'settings', label: 'Settings', icon: 'nav-settings' },
];

/** The left navigation rail. It widens to show labels while it has focus. */
export function sidebar() {
  const buttons = new Map();
  const nav = h('nav', { class: 'sidebar', 'data-nav-group': '', 'aria-label': 'Main' },
    h('div', { class: 'sidebar-logo' }, img('assets/icon.png', { alt: 'Nuvio', loading: 'eager' })),
    h('div', { class: 'sidebar-items' },
      ITEMS.map((item) => {
        const button = h('button', {
          class: 'sidebar-item focusable',
          type: 'button',
          'aria-label': item.label,
          onClick: () => router.root(item.route),
        }, icon(item.icon), h('span', { class: 'sidebar-label' }, item.label));
        buttons.set(item.route, button);
        return button;
      })));

  nav.addEventListener('nav-focus', () => document.documentElement.classList.add('sidebar-open'));
  document.addEventListener('nav-focus', (e) => {
    if (!nav.contains(e.target)) document.documentElement.classList.remove('sidebar-open');
  });
  nav.addEventListener('mouseenter', () => document.documentElement.classList.add('sidebar-open'));
  nav.addEventListener('mouseleave', () => {
    if (!nav.contains(focus.current)) document.documentElement.classList.remove('sidebar-open');
  });

  events.on('route', ({ name }) => {
    for (const [route, button] of buttons) button.classList.toggle('active', route === name);
    // Moving left into the rail lands on the current section.
    const active = buttons.get(name);
    if (active) focus.remember(nav, active);
  });
  return nav;
}
