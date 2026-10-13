import { h, clear } from '../core/dom.js';
import { focus } from '../core/focus.js';
import { typeLabel } from '../core/format.js';
import { findCatalog, fetchCatalog, catalogExtra, addonName } from '../services/addons.js';
import { isWatched } from '../services/progress.js';
import { posterCard } from '../components/cards.js';
import { chip, spinner, emptyState } from '../components/ui.js';
import { openTitle } from '../services/navigation.js';


/** "View All": one catalog as a grid, with genre filters and more pages as you scroll. */
export function catalogView({ params }) {
  const [transportUrl, type, id] = params;
  const found = findCatalog(transportUrl, type, id);
  const filters = h('div', { class: 'chip-row', 'data-scroll-x': '', 'data-nav-group': '', 'data-nav-row': '', 'data-scroll-top': '' });
  const grid = h('div', { class: 'poster-grid', 'data-nav-group': '' });
  const footer = h('div', { class: 'grid-footer' });
  const title = h('h1', { class: 'page-title' });
  const el = h('div', { class: 'catalog' }, h('div', { class: 'view-scroll', 'data-scroll-y': '' }, title, filters, grid, footer));

  if (!found) {
    grid.appendChild(emptyState({ icon: 'warning', title: 'Catalog unavailable', message: 'The addon for this catalog is no longer installed or enabled.' }));
    return { el, chrome: 'sidebar' };
  }
  const { addon, catalog } = found;
  title.append(`${catalog.name || catalog.id} - ${typeLabel(catalog.type)}`, h('span', { class: 'page-subtitle' }, addonName(addon)));
  const genreExtra = catalogExtra(catalog, 'genre');
  const genres = (genreExtra && genreExtra.options) || [];
  let genre = genreExtra && genreExtra.isRequired ? genres[0] : null;
  let skip = 0;
  let loading = false;
  let exhausted = false;
  let seen = new Set();
  let generation = 0;

  function renderFilters() {
    clear(filters);
    if (!genres.length) return;
    if (!(genreExtra && genreExtra.isRequired)) filters.appendChild(chip('All', { selected: !genre, onClick: () => setGenre(null) }));
    for (const g of genres) filters.appendChild(chip(g, { selected: genre === g, onClick: () => setGenre(g) }));
  }

  function setGenre(g) {
    if (g === genre) return;
    const index = [...filters.children].indexOf(focus.current);
    genre = g;
    renderFilters();
    if (index >= 0 && filters.children[index]) focus.set(filters.children[index], { scroll: false });
    reset();
  }

  function reset() {
    generation++;
    skip = 0;
    exhausted = false;
    seen = new Set();
    clear(grid);
    loadMore();
  }

  async function loadMore() {
    if (loading || exhausted) return;
    loading = true;
    const gen = generation;
    clear(footer).appendChild(spinner());
    try {
      const items = await fetchCatalog(addon, catalog, { skip: skip || undefined, genre: genre || undefined });
      if (gen !== generation) return;
      const fresh = items.filter((m) => !seen.has(m.id));
      fresh.forEach((m) => seen.add(m.id));
      skip += items.length;
      if (!fresh.length || !catalogExtra(catalog, 'skip')) exhausted = true;
      for (const meta of fresh) grid.appendChild(posterCard(meta, { onClick: () => openTitle(meta), watched: isWatched(meta.id) }));
      if (!grid.children.length) {
        grid.appendChild(emptyState({ icon: 'info', title: 'No titles found', message: 'This catalog did not return any items.' }));
      }
      if (gen === generation && skip <= fresh.length) setTimeout(() => focus.restore(el), 0);
    } catch (error) {
      if (gen === generation && !grid.children.length) {
        grid.appendChild(emptyState({ icon: 'warning', title: 'Couldn’t load this catalog', message: error.message }));
      }
      exhausted = true;
    } finally {
      if (gen === generation) {
        loading = false;
        clear(footer);
      }
    }
  }

  // More pages when focus gets near the end of the grid.
  el.addEventListener('nav-focus', (e) => {
    if (!grid.contains(e.target)) return;
    const cards = grid.children;
    const index = [...cards].indexOf(e.target);
    if (index >= cards.length - 14) loadMore();
  });
  const scroller = el.firstChild;
  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 600) loadMore();
  }, { passive: true });

  renderFilters();
  reset();
  return { el, chrome: 'sidebar' };
}
