// Spatial navigation for the controller, remote and keyboard.
//
// Anything with the "focusable" class can take focus. Arrow keys / the D-pad move to the nearest
// focusable in that direction; containers marked data-nav-group remember their last focused
// child, so moving back into a row returns to the same card. The focused element gets the
// "focused" class (the page isn't always "focused" as far as the browser is concerned on Xbox,
// so CSS :focus can't be relied on).
//
// Scopes: the current view is the base scope; dialogs, menus and the player push their own
// scope so focus can't leave them, and get first say over back and other buttons.

import { bridge } from './bridge.js';
import { events } from './store.js';

const KEY_ACTIONS = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'select',
  NumpadEnter: 'select',
  Escape: 'back',
  BrowserBack: 'back',
  GoBack: 'back',
  Backspace: 'back',
  MediaPlayPause: 'playpause',
  MediaPlay: 'playpause',
  MediaPause: 'playpause',
  ' ': 'playpause',
  MediaTrackNext: 'rb',
  MediaTrackPrevious: 'lb',
  MediaFastForward: 'rt',
  MediaRewind: 'lt',
  ContextMenu: 'menu',
};
const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
// The console may deliver a button both through the app and as a key; drop the echo.
const DEDUPE_MS = 150;
const TEXT_INPUT = /^(text|search|email|url|password|tel|number)$/i;

const scopes = [];
const groupMemory = new WeakMap();
const lastBySource = { native: new Map(), key: new Map() };
let current = null;
let usingPointer = false;

export const focus = {
  get current() {
    return current;
  },

  init() {
    // On the console the browser also turns the controller into a pointer (left stick moves it,
    // A clicks). The page can't switch that off, so while it's unwanted the pointer is hidden
    // (CSS on html.no-pointer) and its input ignored here, before anything else sees it: the
    // highlight is the only way around, and A doesn't also click whatever is under the pointer.
    // Clicks made by code (el.click()) aren't trusted events, so they still work.
    for (const type of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove',
      'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel']) {
      window.addEventListener(type, (e) => {
        if (!e.isTrusted || !document.documentElement.classList.contains('no-pointer')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      }, { capture: true, passive: false });
    }
    window.addEventListener('keydown', onKeyDown, true);
    events.on('native:input', ({ action, repeat }) => handle(action, !!repeat, 'native'));
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('mousemove', () => {
      if (!usingPointer) {
        usingPointer = true;
        document.documentElement.classList.add('pointer');
      }
    }, { passive: true });
    // Drop back actions the browser would do itself (mouse back button).
    window.addEventListener('mouseup', (e) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        handle('back', false, 'key');
      }
    }, true);
    // Screens fill in as data arrives; whenever nothing usable has focus, take the first thing
    // that can, so there is always a highlight to move with the controller.
    let pending = 0;
    new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = 0;
        ensureFocus();
      }, 80);
    }).observe(document.body, { childList: true, subtree: true });
  },

  /**
   * Sets the base scope: shell is everything reachable (sidebar and the current view), and
   * handlers.onBack / onInput belong to the view.
   */
  setView(shell, handlers = {}) {
    if (scopes.length && scopes[0].base) scopes.shift();
    scopes.unshift({ el: shell, base: true, ...handlers });
  },

  /** Makes el the element a group returns to, e.g. the active sidebar item. */
  remember(group, el) {
    if (group && el) groupMemory.set(group, el);
  },

  /** Pushes a modal scope. Returns a function that removes it and restores focus. */
  pushScope(el, handlers = {}) {
    const scope = { el, ...handlers, previous: current };
    scopes.push(scope);
    if (handlers.initial !== false) focus.restore(el, handlers.initial);
    return () => focus.popScope(scope);
  },

  popScope(scope) {
    const index = scopes.indexOf(scope);
    if (index < 0) return;
    scopes.splice(index, 1);
    if (index === scopes.length) {
      const target = scope.previous && scope.previous.isConnected && isVisible(scope.previous) ? scope.previous : null;
      const top = topScope();
      if (target) focus.set(target, { scroll: false });
      else if (top) focus.restore(top.view || top.el);
    }
  },

  /** Focuses the remembered element in el, the element marked data-autofocus, or the first focusable. */
  restore(el, preferred) {
    if (!el) return;
    // Already somewhere sensible inside it (e.g. a screen focused its own button while building).
    if (!preferred && current && current.isConnected && el.contains(current) && isVisible(current)) return;
    const remembered = groupMemory.get(el);
    const target =
      (preferred && preferred.isConnected && preferred) ||
      (remembered && remembered.isConnected && isVisible(remembered) && remembered) ||
      [...el.querySelectorAll('.focusable[data-autofocus]')].find(isVisible) ||
      focusables(el)[0];
    if (target) focus.set(target);
  },

  set(el, { scroll = true } = {}) {
    if (!el || el === current) {
      if (el && scroll) scrollIntoView(el);
      return;
    }
    if (current) current.classList.remove('focused');
    current = el;
    el.classList.add('focused');
    // Text boxes only take real focus where there's a keyboard; on Xbox they open the
    // on-screen keyboard dialog when selected instead.
    const isText = isTextInput(el);
    if (!isText || bridge.platform !== 'xbox') {
      try {
        el.focus({ preventScroll: true });
      } catch {}
    } else if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    for (let node = el.parentElement; node; node = node.parentElement) {
      if (node.hasAttribute('data-nav-group') || scopes.some((s) => s.el === node)) groupMemory.set(node, el);
    }
    if (scroll) scrollIntoView(el);
    el.dispatchEvent(new CustomEvent('nav-focus', { bubbles: true }));
  },

  move(direction) {
    const scope = topScope();
    if (!scope) return false;
    if (!current || !current.isConnected || !scope.el.contains(current) || !isVisible(current)) {
      focus.restore(scope.el);
      return true;
    }
    const target = findNext(current, direction, scope.el);
    if (target) {
      focus.set(target);
      return true;
    }
    current.dispatchEvent(new CustomEvent('nav-edge', { bubbles: true, detail: { direction } }));
    return false;
  },

  /** Runs an action as if it came from the controller. */
  dispatch(action) {
    handle(action, false, 'code');
  },
};

function ensureFocus() {
  const scope = topScope();
  if (!scope) return;
  if (current && current.isConnected && scope.el.contains(current) && isVisible(current)) return;
  focus.restore(scope.view || scope.el);
}

function topScope() {
  for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].el.isConnected) return scopes[i];
  return null;
}

function onKeyDown(e) {
  const action = KEY_ACTIONS[e.key];
  if (!action) return;
  const target = e.target;
  const typing = isTextInput(target) && document.activeElement === target;
  if (typing) {
    // Let the text box have the keys it needs.
    if (e.key === ' ' || e.key === 'Backspace') return;
    if ((e.key === 'ArrowLeft' && target.selectionStart > 0) ||
        (e.key === 'ArrowRight' && target.selectionEnd < target.value.length)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      target.dispatchEvent(new CustomEvent('text-submit', { bubbles: true }));
      return;
    }
  }
  e.preventDefault();
  e.stopPropagation();
  if (usingPointer) {
    usingPointer = false;
    document.documentElement.classList.remove('pointer');
  }
  handle(action, e.repeat, 'key');
}

function onPointerDown(e) {
  const el = e.target.closest && e.target.closest('.focusable');
  const scope = topScope();
  if (el && (!scope || scope.el.contains(el))) focus.set(el, { scroll: false });
}

function handle(action, repeat, source) {
  const now = performance.now();
  if (source !== 'code') {
    const other = source === 'native' ? lastBySource.key : lastBySource.native;
    lastBySource[source].set(action, now);
    if (now - (other.get(action) || -1e9) < DEDUPE_MS) return;
  }
  // The topmost scope, then the view, get first say.
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (!scope.el.isConnected) continue;
    if (scope.onInput && scope.onInput(action, repeat) === true) return;
    if (!scope.base && scope.modal !== false) break;
  }
  if (DIRECTIONS.has(action)) {
    focus.move(action);
  } else if (action === 'select') {
    if (!repeat) activate();
  } else if (action === 'back') {
    if (!repeat) goBack();
  } else {
    events.emit('nav:action', { action, repeat });
  }
}

async function activate() {
  const el = current;
  if (!el || !el.isConnected) return;
  if (isTextInput(el) && bridge.native && bridge.platform === 'xbox') {
    const label = el.getAttribute('aria-label') || el.placeholder || '';
    try {
      const result = await bridge.requestText({ label, value: el.type === 'password' ? '' : el.value, kind: el.type || 'text' });
      if (result) {
        el.value = result.text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (result.submitted) el.dispatchEvent(new CustomEvent('text-submit', { bubbles: true }));
      }
    } catch (error) {
      console.warn('Text entry failed', error);
    }
    return;
  }
  if (isTextInput(el)) {
    el.focus();
    return;
  }
  el.click();
}

function goBack() {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (!scope.el.isConnected) continue;
    if (scope.onBack && scope.onBack() === true) return;
    if (!scope.base) return; // Modal scopes without a handler swallow back.
  }
  events.emit('nav:back');
}

function isTextInput(el) {
  return !!el && ((el.tagName === 'INPUT' && TEXT_INPUT.test(el.type || 'text')) || el.tagName === 'TEXTAREA');
}

function isVisible(el) {
  if (el.closest('[hidden], .is-hidden, [inert]')) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function focusables(root) {
  return [...root.querySelectorAll('.focusable')].filter((el) => !el.disabled && isVisible(el));
}

function findNext(from, direction, root) {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const el of focusables(root)) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    // A candidate has to lie beyond the current element's edge in that direction; a little
    // overlap is allowed for the focused card's zoom.
    const slackX = Math.min(a.width, b.width) * 0.25;
    const slackY = Math.min(a.height, b.height) * 0.25;
    let primary;
    let secondary;
    switch (direction) {
      case 'right':
        if (b.left < a.right - slackX || bx <= ax) continue;
        primary = Math.max(0, b.left - a.right);
        secondary = rangeGap(a.top, a.bottom, b.top, b.bottom);
        break;
      case 'left':
        if (b.right > a.left + slackX || bx >= ax) continue;
        primary = Math.max(0, a.left - b.right);
        secondary = rangeGap(a.top, a.bottom, b.top, b.bottom);
        break;
      case 'down':
        if (b.top < a.bottom - slackY || by <= ay) continue;
        primary = Math.max(0, b.top - a.bottom);
        secondary = rangeGap(a.left, a.right, b.left, b.right);
        break;
      default:
        if (b.bottom > a.top + slackY || by >= ay) continue;
        primary = Math.max(0, a.top - b.bottom);
        secondary = rangeGap(a.left, a.right, b.left, b.right);
    }
    // Stay in line first; among items in line, the closest wins. Moving up or down picks
    // the item nearest the current one's centre.
    const horizontal = direction === 'left' || direction === 'right';
    const centreOffset = horizontal ? Math.abs(by - ay) : Math.abs(bx - ax);
    const score = primary + secondary * (horizontal ? 6 : 2) + centreOffset * 0.25;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) return null;
  // Entering another group: go back to where we were in it. The outermost group we're entering
  // decides, so coming in from the sidebar returns to the last card in the screen, while moving
  // between rows of the same screen returns to the last card of that row.
  let entered = null;
  for (let node = best.closest('[data-nav-group]'); node && root.contains(node) && node !== root; node = node.parentElement.closest('[data-nav-group]')) {
    if (node.contains(from)) break;
    entered = node;
  }
  if (entered) {
    const remembered = groupMemory.get(entered);
    if (remembered && remembered !== from && remembered.isConnected && isVisible(remembered) && entered.contains(remembered)) {
      return remembered;
    }
  }
  return best;
}

function rangeGap(a1, a2, b1, b2) {
  if (b2 < a1) return a1 - b2;
  if (b1 > a2) return b1 - a2;
  return 0;
}

function scrollIntoView(el) {
  // Horizontal rows: keep the item inside the row with some room either side.
  const row = el.closest('[data-scroll-x]');
  if (row) {
    const r = row.getBoundingClientRect();
    const e = el.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(row).scrollPaddingLeft) || r.width * 0.04;
    if (e.left < r.left + pad) row.scrollBy({ left: e.left - r.left - pad, behavior: 'smooth' });
    else if (e.right > r.right - pad) row.scrollBy({ left: e.right - r.right + pad, behavior: 'smooth' });
  }
  // The page: bring the item's section to a steady spot near the top, like a TV home screen.
  const page = el.closest('[data-scroll-y]');
  if (!page) return;
  if (el.closest('[data-scroll-top]')) {
    page.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const section = el.closest('[data-nav-row]') || el;
  const p = page.getBoundingClientRect();
  const s = section.getBoundingClientRect();
  const anchor = page.hasAttribute('data-scroll-center') ? (p.height - s.height) / 2 : p.height * 0.16;
  const topMargin = p.height * 0.08;
  const bottomMargin = p.height * 0.06;
  if (section.hasAttribute('data-nav-row') || s.top < p.top + topMargin || s.bottom > p.bottom - bottomMargin) {
    const delta = s.top - p.top - Math.max(topMargin, anchor);
    if (Math.abs(delta) > 2) page.scrollBy({ top: delta, behavior: 'smooth' });
  }
}
