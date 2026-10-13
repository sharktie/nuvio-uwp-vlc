import { h, clear } from '../core/dom.js';
import { skeletonCards } from './cards.js';

// One observer per scrolling screen: rootMargin only reaches past the edges of the root itself,
// so the screen's scroller has to be the root for rows to start loading before they're visible.
const observers = new WeakMap();

function observe(section) {
  const root = section.closest('[data-scroll-y]');
  if (!('IntersectionObserver' in window) || !root) {
    section.__startLoad();
    return;
  }
  let observer = observers.get(root);
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        entry.target.__startLoad();
      }
    }, { root, rootMargin: '120% 0px' });
    observers.set(root, observer);
  }
  observer.observe(section);
}

/**
 * A titled horizontal row of cards. load() returns the items; render(item) makes a card.
 * The row loads when it gets near the screen and removes itself if there's nothing to show.
 */
export function cardRow({ title, subtitle, load, render, shape = 'poster', trailing, cls, eager = false, onEmpty }) {
  const track = h('div', { class: 'row-track', 'data-scroll-x': '', 'data-nav-group': '' }, skeletonCards(8, shape));
  const section = h('section', { class: ['row', `row-${shape}`, cls], 'data-nav-row': '' },
    h('header', { class: 'row-header' },
      h('h2', { class: 'row-title' }, title),
      subtitle && h('span', { class: 'row-subtitle' }, subtitle)),
    track);

  let loaded = false;
  const start = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const items = await load();
      if (!items || !items.length) {
        section.remove();
        if (onEmpty) onEmpty();
        return;
      }
      clear(track);
      for (const item of items) {
        const card = render(item);
        if (card) track.appendChild(card);
      }
      if (trailing) track.appendChild(trailing());
      section.classList.add('loaded');
    } catch (error) {
      console.warn('Row failed to load', title, error);
      section.remove();
      if (onEmpty) onEmpty(error);
    }
  };
  section.__startLoad = start;
  if (eager) setTimeout(start, 0);
  else requestAnimationFrame(() => (section.isConnected ? observe(section) : start()));
  section.reload = () => {
    loaded = false;
    start();
  };
  return section;
}
