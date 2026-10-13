import { h, icon, clear, debounce } from '../core/dom.js';
import { focus } from '../core/focus.js';
import { bridge } from '../core/bridge.js';
import { storage, profileKey } from '../core/store.js';
import { typeLabel } from '../core/format.js';
import { searchCatalogs, fetchCatalog, addonName } from '../services/addons.js';
import { isWatched } from '../services/progress.js';
import { posterCard } from '../components/cards.js';
import { cardRow } from '../components/rows.js';
import { chip, emptyState } from '../components/ui.js';
import { openTitle } from '../services/navigation.js';

const MAX_RECENT = 10;

export function searchView({ query }) {
  const input = h('input', {
    class: 'search-input focusable',
    type: 'search',
    placeholder: 'Search movies & series',
    'aria-label': 'Search movies & series',
    autocomplete: 'off',
    spellcheck: false,
    dataset: { autofocus: '' },
  });
  const bar = h('div', { class: 'search-bar', 'data-nav-row': '', 'data-scroll-top': '' }, icon('nav-search'), input);
  const recent = h('div', { class: 'search-recent', 'data-nav-row': '' });
  const results = h('div', { class: 'search-results' });
  const el = h('div', { class: 'search' }, h('div', { class: 'view-scroll', 'data-scroll-y': '' }, bar, recent, results));
  let lastQuery = '';

  function recentSearches() {
    return storage.get(profileKey('recentSearches'), []);
  }

  function renderRecent() {
    clear(recent);
    const list = recentSearches();
    if (!list.length || lastQuery) return;
    recent.append(
      h('h2', { class: 'row-title' }, 'Recent Searches'),
      h('div', { class: 'chip-row', 'data-scroll-x': '', 'data-nav-group': '' },
        list.map((q) => chip(q, { onClick: () => run(q, true) }))));
  }

  function remember(q) {
    const list = recentSearches().filter((x) => x.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    storage.set(profileKey('recentSearches'), list.slice(0, MAX_RECENT));
  }

  function run(q, fromChip = false) {
    q = q.trim();
    if (fromChip) input.value = q;
    if (q === lastQuery) return;
    lastQuery = q;
    history.replaceState(history.state, '', '#/search' + (q ? '?q=' + encodeURIComponent(q) : ''));
    clear(results);
    renderRecent();
    if (!q) return;
    remember(q);
    const catalogs = searchCatalogs();
    if (!catalogs.length) {
      results.appendChild(emptyState({ icon: 'puzzle', title: 'No search providers', message: 'None of your addons supports search. Cinemeta (installed by default) does.' }));
      return;
    }
    let remaining = catalogs.length;
    let found = 0;
    const done = (count) => {
      found += count;
      if (--remaining === 0 && !found) {
        results.appendChild(emptyState({ icon: 'nav-search', title: 'No results', message: `Nothing found for "${q}".` }));
      }
    };
    for (const { addon, catalog } of catalogs) {
      results.appendChild(cardRow({
        title: `${typeLabel(catalog.type)}`,
        subtitle: `${catalog.name || catalog.id} · ${addonName(addon)}`,
        eager: true,
        load: async () => {
          try {
            const items = await fetchCatalog(addon, catalog, { search: q });
            done(items.length);
            return items;
          } catch (error) {
            done(0);
            throw error;
          }
        },
        render: (meta) => posterCard(meta, { onClick: () => openTitle(meta), watched: isWatched(meta.id) }),
      }));
    }
    if (fromChip) setTimeout(() => focus.restore(results), 600);
  }

  // Typing on a keyboard searches as you go; the console keyboard searches when it closes.
  const live = debounce(() => run(input.value), 700);
  input.addEventListener('input', () => {
    if (bridge.platform !== 'xbox') live();
  });
  input.addEventListener('change', () => run(input.value));
  input.addEventListener('text-submit', () => {
    run(input.value);
    setTimeout(() => focus.move('down'), 800);
  });

  const initial = query.get('q') || '';
  input.value = initial;
  if (initial) run(initial);
  else renderRecent();

  return { el, chrome: 'sidebar' };
}
