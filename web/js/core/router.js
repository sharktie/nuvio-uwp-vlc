// Screens as a stack. Opening a screen hides the one below without destroying it, so going back
// returns instantly to the same scroll position and focused card. The address bar mirrors the
// top screen (#/details/movie/tt123) so a reload lands in the same place.

import { focus } from './focus.js';
import { events } from './store.js';

const factories = new Map();
const stack = [];
let container = null;
let shell = null;
let ignorePop = 0;

const ROOTS = ['home', 'search', 'library', 'settings'];

export function registerView(name, factory) {
  factories.set(name, factory);
}

function parse(path) {
  const [route, queryString] = String(path || '').replace(/^#?\/?/, '').split('?');
  const parts = route.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'home', params: parts.slice(1), query: new URLSearchParams(queryString || ''), path: route + (queryString ? '?' + queryString : '') };
}

function build(path, state) {
  const route = parse(path);
  const factory = factories.get(route.name) || factories.get('home');
  const view = factory({ params: route.params, query: route.query, state: state || {} });
  view.route = route;
  view.el.classList.add('view');
  view.el.dataset.view = route.name;
  view.el.setAttribute('data-nav-group', '');
  container.appendChild(view.el);
  return view;
}

function show(view) {
  for (const other of stack) if (other !== view) other.el.hidden = true;
  view.el.hidden = false;
  focus.setView(shell, {
    view: view.el,
    onBack: () => (view.onBack ? view.onBack() : false),
    onInput: view.onInput ? (action, repeat) => view.onInput(action, repeat) : undefined,
  });
  focus.restore(view.el);
  document.documentElement.dataset.chrome = view.chrome || 'sidebar';
  events.emit('route', { name: view.route.name, view });
  if (view.onShow) view.onShow();
}

function destroy(view) {
  try {
    if (view.destroy) view.destroy();
  } catch (error) {
    console.error('Closing view failed', error);
  }
  view.el.remove();
}

export const router = {
  get current() {
    return stack[stack.length - 1] || null;
  },
  get depth() {
    return stack.length;
  },

  /** views: where screens go; shellEl: everything focus may reach (sidebar and screens). */
  start(views, shellEl) {
    container = views;
    shell = shellEl;
    window.addEventListener('popstate', (e) => {
      if (ignorePop > 0) {
        ignorePop--;
        return;
      }
      const target = parse(location.hash).path;
      const depth = e.state && e.state.depth;
      // Back (or forward) to a screen still in the stack: close the ones above it.
      let index = -1;
      for (let i = stack.length - 2; i >= 0; i--) {
        if (stack[i].route.path === target && (!depth || depth === i + 1)) {
          index = i;
          break;
        }
      }
      if (index >= 0) {
        while (stack.length > index + 1) router.pop();
        return;
      }
      if (router.current && router.current.route.path === target) return;
      // A new address typed or linked: open it on top. Screens that need in-memory state
      // (player, streams) can't be opened that way.
      const route = parse(target);
      if (route.name === 'player') {
        history.replaceState({ depth: stack.length }, '', '#/' + router.current.route.path);
        return;
      }
      const view = build(target);
      const previous = router.current;
      if (previous && previous.onHide) previous.onHide();
      stack.push(view);
      history.replaceState({ depth: stack.length }, '', '#/' + view.route.path);
      show(view);
    });
    const initial = parse(location.hash);
    const hasStateless = initial.name === 'player' || initial.name === 'streams';
    if (ROOTS.includes(initial.name) && !initial.params.length) {
      router.root(initial.path);
    } else {
      router.root('home');
      if (!hasStateless) router.go(initial.path);
    }
  },

  /** Opens a screen on top. state can carry objects that don't fit in the address. */
  go(path, state) {
    const view = build(path, state);
    const previous = router.current;
    if (previous && previous.onHide) previous.onHide();
    stack.push(view);
    history.pushState({ depth: stack.length }, '', '#/' + view.route.path);
    show(view);
    return view;
  },

  /** Replaces the top screen. */
  replace(path, state) {
    const top = stack.pop();
    if (top) destroy(top);
    const view = build(path, state);
    stack.push(view);
    history.replaceState({ depth: stack.length }, '', '#/' + view.route.path);
    show(view);
    return view;
  },

  /** Clears the stack and opens a main section (Home, Search, Library, Settings). */
  root(path) {
    const target = parse(path);
    if (stack.length === 1 && stack[0].route.path === target.path) {
      show(stack[0]);
      return stack[0];
    }
    const extra = stack.length - 1;
    while (stack.length) destroy(stack.pop());
    if (extra > 0) {
      // Drop the history entries of the screens we just closed.
      ignorePop++;
      history.go(-extra);
    }
    const view = build(target.path);
    stack.push(view);
    const record = () => history.replaceState({ depth: 1 }, '', '#/' + view.route.path);
    // After history.go() the address only settles once its popstate has fired.
    if (extra > 0) setTimeout(() => stack[0] === view && stack.length === 1 && record(), 50);
    else record();
    show(view);
    return view;
  },

  back() {
    if (stack.length <= 1) return false;
    history.back();
    return true;
  },

  /** Closes the top screen without touching history (used by popstate). */
  pop() {
    if (stack.length <= 1) return;
    destroy(stack.pop());
    show(stack[stack.length - 1]);
  },

  isRoot(name) {
    return ROOTS.includes(name);
  },
};
