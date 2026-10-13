import { ICONS } from './icons.js';
import { EXTRA_ICONS } from './icon-extras.js';

const ALL_ICONS = { ...ICONS, ...EXTRA_ICONS };

/**
 * Creates an element. Props: class, style (string or object), dataset, on<Event> handlers,
 * html (innerHTML), and anything else as an attribute (false/null skip it).
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      else if (key === 'style') {
        if (typeof value === 'string') el.style.cssText = value;
        else for (const [k, v] of Object.entries(value)) if (v != null) el.style.setProperty(k, v);
      } else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'html') el.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key in el && typeof value !== 'string') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function icon(name, cls) {
  const def = ALL_ICONS[name];
  const span = document.createElement('span');
  span.className = 'icon' + (cls ? ' ' + cls : '');
  span.setAttribute('aria-hidden', 'true');
  if (def) span.innerHTML = `<svg viewBox="${def.viewBox}" fill="currentColor">${def.body}</svg>`;
  return span;
}

/** An image that fades in when loaded and hides itself if it fails. */
export function img(src, props = {}) {
  const el = h('img', { ...props, alt: props.alt || '', decoding: 'async', loading: props.loading || 'lazy' });
  el.addEventListener('load', () => el.classList.add('loaded'), { once: true });
  el.addEventListener('error', () => el.classList.add('failed'), { once: true });
  if (src) el.src = src;
  else el.classList.add('failed');
  return el;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
