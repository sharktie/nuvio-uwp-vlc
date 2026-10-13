import { h, img, clear } from '../core/dom.js';
import { router } from '../core/router.js';
import { events, settings } from '../core/store.js';
import { focus } from '../core/focus.js';
import { typeLabel } from '../core/format.js';
import { homeCatalogs, fetchCatalog, addonName, enabledAddons } from '../services/addons.js';
import { continueWatching, dismissContinueWatching, isWatched } from '../services/progress.js';
import { fetchMeta, nextEpisode, isReleased, genresOf, yearText } from '../services/meta.js';
import { posterCard, continueCard, viewAllCard } from '../components/cards.js';
import { cardRow } from '../components/rows.js';
import { button, emptyState, choicePanel } from '../components/ui.js';
import { openTitle, playVideo, resumeEntry } from '../services/navigation.js';

const HERO_ITEMS = 6;
const HERO_INTERVAL_MS = 9000;

export function homeView() {
  const backdrop = pageBackdrop();
  const content = h('div', { class: 'home-rows' });
  const scroller = h('div', { class: 'view-scroll', 'data-scroll-y': '' }, content);
  const el = h('div', { class: 'home' }, backdrop.el, scroller);
  const cleanups = [];
  let hero = null;
  let continueRow = null;

  function build() {
    if (hero) hero.destroy();
    hero = null;
    clear(content);
    const catalogs = homeCatalogs();
    if (!enabledAddons().length || !catalogs.length) {
      content.appendChild(h('div', { class: 'home-empty' }, emptyState({
        icon: 'puzzle',
        title: enabledAddons().length ? 'No Home content available' : 'Make Nuvio yours.',
        message: enabledAddons().length
          ? 'Your enabled addons do not provide catalogs that can be shown on Home.'
          : 'Add an addon to start building your library.',
        actions: [button('Manage Addons', { variant: 'primary', icon: 'puzzle', onClick: () => router.go('settings/addons') })],
      })));
      return;
    }
    if (settings.get('showHero')) {
      hero = heroSection(catalogs, backdrop);
      content.appendChild(hero.el);
    }
    continueRow = buildContinueRow();
    content.appendChild(continueRow);
    for (const { addon, catalog } of catalogs) {
      const title = settings.get('showCatalogType') && !catalog.hideType ? `${catalog.name || catalog.id} - ${typeLabel(catalog.type)}` : (catalog.name || catalog.id);
      const shape = catalog.posterShape || 'poster';
      content.appendChild(cardRow({
        title,
        subtitle: addonName(addon),
        shape,
        load: async () => {
          let items = await fetchCatalog(addon, catalog);
          if (settings.get('hideUnreleased')) items = items.filter((m) => !m.released || new Date(m.released) <= new Date());
          return items.slice(0, 30);
        },
        render: (meta) => {
          const card = posterCard(meta, { onClick: () => openTitle(meta), watched: isWatched(meta.id) });
          card.addEventListener('nav-focus', () => backdrop.show(meta.background));
          return card;
        },
        trailing: () => viewAllCard({ shape, onClick: () => router.go(`catalog/${encodeURIComponent(addon.transportUrl)}/${catalog.type}/${encodeURIComponent(catalog.id)}`) }),
      }));
    }
  }

  function buildContinueRow() {
    return cardRow({
      title: 'Continue Watching',
      shape: 'wide',
      cls: 'row-continue',
      eager: true,
      load: loadContinueWatching,
      render: (entry) => {
        const card = continueCard(entry, { onClick: () => resumeEntry(entry) });
        card.__entry = entry;
        card.addEventListener('nav-focus', () => backdrop.show(entry.background));
        return card;
      },
    });
  }

  function refreshContinueRow() {
    if (!continueRow) return;
    const next = buildContinueRow();
    const hadFocus = continueRow.contains(focus.current);
    continueRow.replaceWith(next);
    continueRow = next;
    if (hadFocus) setTimeout(() => focus.restore(el), 300);
  }

  // Y / Menu on a Continue Watching card: more options.
  cleanups.push(events.on('nav:action', async ({ action }) => {
    if (el.hidden || (action !== 'menu' && action !== 'y')) return;
    const entry = focus.current && focus.current.__entry;
    if (!entry) return;
    const choice = await choicePanel({
      title: entry.title,
      items: [
        { label: 'Go to details', value: 'details' },
        !entry.nextUp && { label: 'Start from beginning', value: 'restart' },
        { label: 'Remove', value: 'remove' },
      ].filter(Boolean),
    });
    if (choice === 'details') router.go(`details/${entry.contentType}/${encodeURIComponent(entry.contentId)}`);
    else if (choice === 'restart') resumeEntry(entry, { restart: true });
    else if (choice === 'remove') dismissContinueWatching(entry.contentId);
  }));

  let pendingRefresh = 0;
  let needsRefresh = false;
  let needsRebuild = false;
  cleanups.push(events.on('progress', () => {
    // Progress is saved every few seconds during playback; refresh once playback is over.
    clearTimeout(pendingRefresh);
    pendingRefresh = setTimeout(() => {
      if (!el.hidden) refreshContinueRow();
      else needsRefresh = true;
    }, 500);
  }));
  cleanups.push(events.on('addons', () => {
    if (el.hidden) needsRebuild = true;
    else build();
  }));

  build();

  return {
    el,
    chrome: 'sidebar',
    onShow() {
      if (needsRebuild) {
        needsRebuild = false;
        needsRefresh = false;
        build();
      } else if (needsRefresh) {
        needsRefresh = false;
        refreshContinueRow();
      }
      if (hero) hero.resume();
    },
    onHide() {
      if (hero) hero.pause();
    },
    destroy() {
      if (hero) hero.destroy();
      cleanups.forEach((off) => off());
    },
  };
}

async function loadContinueWatching() {
  const entries = continueWatching();
  const resolved = await Promise.all(entries.map(async (entry) => {
    // Entries synced from other devices only carry ids and positions; fill in the artwork.
    const needsMeta = entry.nextUp || !entry.title || !(entry.background || entry.poster);
    if (!needsMeta) return entry;
    let meta;
    try {
      meta = await fetchMeta(entry.contentType, entry.contentId);
    } catch {
      return entry.nextUp ? null : entry;
    }
    const filled = {
      ...entry,
      title: entry.title || meta.name,
      poster: entry.poster || meta.poster,
      background: entry.background || meta.background,
      logo: entry.logo || meta.logo,
    };
    if (entry.season != null && !entry.thumbnail) {
      const video = (meta.videos || []).find((v) => Number(v.season) === entry.season && Number(v.episode ?? v.number) === entry.episode);
      if (video) Object.assign(filled, { thumbnail: video.thumbnail || null, episodeTitle: entry.episodeTitle || video.name || video.title || null });
    }
    if (!entry.nextUp) return filled;
    const next = nextEpisode(meta, entry.season, entry.episode);
    if (!next || !isReleased(next)) return null;
    const isNew = next.released && Date.now() - new Date(next.released).getTime() < 7 * 86400000;
    return { ...filled, next: { ...next, isNew } };
  }));
  return resolved.filter(Boolean);
}

/** The full-screen art behind Home, following the focused title. */
function pageBackdrop() {
  const a = h('div', { class: 'backdrop-layer' });
  const b = h('div', { class: 'backdrop-layer' });
  const el = h('div', { class: 'page-backdrop' }, a, b, h('div', { class: 'backdrop-shade' }));
  let front = a;
  let currentUrl = null;
  let timer = 0;
  return {
    el,
    show(url) {
      if (!url || url === currentUrl) return;
      currentUrl = url;
      clearTimeout(timer);
      // Wait a moment so scrolling through a row doesn't load every backdrop.
      timer = setTimeout(() => {
        const image = new Image();
        image.onload = () => {
          if (currentUrl !== url) return;
          const back = front === a ? b : a;
          back.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
          back.classList.add('visible');
          front.classList.remove('visible');
          front = back;
        };
        image.src = url;
      }, 350);
    },
  };
}

function heroSection(catalogs, backdrop) {
  const slot = h('div', { class: 'hero-slot' });
  const dots = h('div', { class: 'hero-dots' });
  const el = h('section', { class: 'hero', 'data-scroll-top': '', 'data-nav-row': '' }, slot, dots);
  let items = [];
  let index = 0;
  let timer = 0;
  let paused = false;

  const render = () => {
    const meta = items[index];
    if (!meta) return;
    // The backdrop follows the highlighted card while the user browses the rows.
    const browsingRows = focus.current && !el.contains(focus.current) && focus.current.closest('.home-rows');
    if (!browsingRows) backdrop.show(meta.background || meta.poster);
    const hadFocus = el.contains(focus.current);
    const focusedLabel = hadFocus ? focus.current.dataset.heroAction : null;
    clear(slot);
    const info = [yearText(meta), meta.imdbRating && `★ ${meta.imdbRating}`, typeLabel(meta.type)].filter(Boolean);
    const actions = h('div', { class: 'hero-actions' },
      button(meta.type === 'movie' ? 'Play' : 'Watch', { variant: 'primary', icon: 'play', onClick: () => (meta.type === 'movie' ? playVideo(meta, null) : openTitle(meta)) }),
      button('Details', { icon: 'info', onClick: () => openTitle(meta) }));
    actions.children[0].dataset.heroAction = 'play';
    actions.children[1].dataset.heroAction = 'details';
    slot.appendChild(h('div', { class: 'hero-info' },
      meta.logo ? img(meta.logo, { class: 'hero-logo', alt: meta.name, loading: 'eager' }) : null,
      h('h1', { class: ['hero-title', meta.logo && 'has-logo'] }, meta.name),
      h('div', { class: 'meta-line' }, info.map((t) => h('span', null, t)), genresOf(meta).slice(0, 3).map((g) => h('span', { class: 'genre' }, g))),
      meta.description && h('p', { class: 'hero-description' }, meta.description),
      actions));
    const logo = slot.querySelector('.hero-logo');
    if (logo) logo.addEventListener('error', () => slot.querySelector('.hero-title').classList.remove('has-logo'));
    [...dots.children].forEach((d, i) => d.classList.toggle('active', i === index));
    if (hadFocus) focus.set(slot.querySelector(`[data-hero-action="${focusedLabel}"]`) || actions.firstChild);
  };

  const schedule = () => {
    clearTimeout(timer);
    if (paused || items.length < 2) return;
    timer = setTimeout(() => {
      // Don't change the title under the user's highlight.
      if (!el.contains(focus.current)) {
        index = (index + 1) % items.length;
        render();
      }
      schedule();
    }, HERO_INTERVAL_MS);
  };

  // Left/right on the hero buttons' edge flips between featured titles.
  el.addEventListener('nav-edge', (e) => {
    if (items.length < 2) return;
    if (e.detail.direction === 'right') index = (index + 1) % items.length;
    else if (e.detail.direction === 'left' && focus.current === slot.querySelector('.hero-actions').firstChild) return;
    else return;
    render();
    schedule();
  });

  (async () => {
    // Featured: the first catalogs' top items that have artwork.
    for (const { addon, catalog } of catalogs.slice(0, 3)) {
      try {
        const metas = await fetchCatalog(addon, catalog);
        for (const meta of metas) {
          if (items.length >= HERO_ITEMS) break;
          if ((meta.background || meta.poster) && !items.some((m) => m.id === meta.id)) items.push(meta);
        }
      } catch {}
      if (items.length >= HERO_ITEMS) break;
    }
    if (!items.length) {
      el.remove();
      return;
    }
    dots.append(...items.map(() => h('span', { class: 'hero-dot' })));
    render();
    schedule();
  })();

  return {
    el,
    pause() {
      paused = true;
      clearTimeout(timer);
    },
    resume() {
      paused = false;
      schedule();
    },
    destroy() {
      paused = true;
      clearTimeout(timer);
    },
  };
}

