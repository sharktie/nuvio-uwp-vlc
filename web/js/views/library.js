import { h, clear } from '../core/dom.js';
import { focus } from '../core/focus.js';
import { events } from '../core/store.js';
import { router } from '../core/router.js';
import { libraryItems } from '../services/library.js';
import { isWatched, getProgress } from '../services/progress.js';
import { posterCard } from '../components/cards.js';
import { chip, emptyState, button } from '../components/ui.js';
import { openTitle } from '../services/navigation.js';

const SORTS = [
  ['added', 'Recently added'],
  ['title', 'Title A–Z'],
  ['released', 'Recently released'],
];

export function libraryView() {
  const filters = h('div', { class: 'chip-row library-filters', 'data-scroll-x': '', 'data-nav-group': '', 'data-nav-row': '', 'data-scroll-top': '' });
  const grid = h('div', { class: 'poster-grid', 'data-nav-group': '' });
  const el = h('div', { class: 'library' }, h('div', { class: 'view-scroll', 'data-scroll-y': '' },
    h('h1', { class: 'page-title' }, 'Library'), filters, grid));
  let type = 'all';
  let sort = 'added';

  function render() {
    const items = libraryItems();
    const types = [...new Set(items.map((i) => i.type))];
    clear(filters);
    filters.append(
      chip('All', { selected: type === 'all', onClick: () => set('all', sort) }),
      ...types.map((t) => chip(t === 'movie' ? 'Movies' : t === 'series' ? 'Series' : t, { selected: type === t, onClick: () => set(t, sort) })),
      h('span', { class: 'chip-divider' }),
      ...SORTS.map(([key, label]) => chip(label, { selected: sort === key, onClick: () => set(type, key) })));

    clear(grid);
    let shown = type === 'all' ? items : items.filter((i) => i.type === type);
    if (sort === 'title') shown = [...shown].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'released') shown = [...shown].sort((a, b) => String(b.releaseInfo || '').localeCompare(String(a.releaseInfo || '')));
    if (!shown.length) {
      grid.appendChild(emptyState({
        icon: 'bookmark',
        title: 'Your library is empty',
        message: 'Saved titles will appear here after you select Add to Library on a details screen.',
        actions: [button('Browse Home', { variant: 'primary', onClick: () => router.root('home') })],
      }));
      return;
    }
    for (const item of shown) {
      const entry = getProgress(item.id);
      grid.appendChild(posterCard(item, {
        onClick: () => openTitle(item),
        watched: isWatched(item.id),
        progress: entry && entry.duration ? entry.position / entry.duration : 0,
      }));
    }
  }

  function set(nextType, nextSort) {
    const index = [...filters.children].indexOf(focus.current);
    type = nextType;
    sort = nextSort;
    render();
    if (index >= 0 && filters.children[index]) focus.set(filters.children[index]);
  }

  let stale = false;
  const off = events.on('library', () => {
    if (el.hidden) stale = true;
    else render();
  });
  render();

  return {
    el,
    chrome: 'sidebar',
    onShow() {
      if (stale) {
        stale = false;
        render();
      }
    },
    destroy: off,
  };
}
