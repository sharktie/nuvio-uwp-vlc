import { h, icon, clear } from '../core/dom.js';
import { focus } from '../core/focus.js';

export function button(label, { icon: iconName, onClick, variant = 'secondary', cls, title, autofocus, disabled } = {}) {
  return h('button', {
    class: ['btn', 'focusable', `btn-${variant}`, !label && 'btn-icon', cls],
    type: 'button',
    title: title || null,
    'aria-label': title || label || null,
    dataset: autofocus ? { autofocus: '' } : undefined,
    disabled: !!disabled,
    onClick: (e) => {
      e.preventDefault();
      if (onClick) onClick(e);
    },
  }, iconName && icon(iconName), label && h('span', { class: 'btn-label' }, label));
}

export function chip(label, { selected = false, onClick, cls } = {}) {
  return h('button', {
    class: ['chip', 'focusable', selected && 'selected', cls],
    type: 'button',
    onClick: (e) => {
      e.preventDefault();
      if (onClick) onClick(e);
    },
  }, label);
}

export function spinner(cls) {
  return h('div', { class: ['spinner', cls], role: 'progressbar' });
}

export function emptyState({ title, message, icon: iconName = 'info', actions = [] }) {
  return h('div', { class: 'empty-state' },
    icon(iconName, 'empty-icon'),
    h('h2', null, title),
    message && h('p', null, message),
    actions.length ? h('div', { class: 'empty-actions' }, actions) : null);
}

/** A settings-style row: label, description and a control or value on the right. */
export function settingRow({ label, description, value, onClick, control, icon: iconName, cls }) {
  return h('button', {
    class: ['setting-row', 'focusable', cls],
    type: 'button',
    onClick: (e) => {
      e.preventDefault();
      if (onClick) onClick(e);
    },
  },
  iconName && icon(iconName, 'setting-icon'),
  h('span', { class: 'setting-text' },
    h('span', { class: 'setting-label' }, label),
    description && h('span', { class: 'setting-description' }, description)),
  value != null && h('span', { class: 'setting-value' }, value),
  control || null);
}

export function toggle(on) {
  return h('span', { class: ['toggle', on && 'on'], 'aria-checked': String(!!on), role: 'switch' }, h('span', { class: 'toggle-knob' }));
}

/** A setting row that flips a boolean. */
export function toggleRow({ label, description, get, set }) {
  let value = get();
  const sw = toggle(value);
  const row = settingRow({
    label,
    description,
    control: sw,
    onClick: () => {
      value = !value;
      set(value);
      sw.classList.toggle('on', value);
      sw.setAttribute('aria-checked', String(value));
    },
  });
  return row;
}

// ---------- Toasts ----------

let toastHost = null;

export function toast(message, { duration = 3000, kind = 'info' } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const el = h('div', { class: ['toast', `toast-${kind}`] }, message);
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ---------- Dialogs ----------

/**
 * Shows a modal dialog. Returns a promise for the value passed to close(), or null when the user
 * backs out. build(close) returns the dialog body.
 */
export function openDialog({ title, message, build, cls, wide }) {
  return new Promise((resolve) => {
    let popScope = null;
    const close = (value) => {
      if (popScope) popScope();
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 200);
      resolve(value === undefined ? null : value);
    };
    const body = build ? build(close) : null;
    const panel = h('div', { class: ['dialog', wide && 'dialog-wide', cls], role: 'dialog', 'aria-modal': 'true' },
      title && h('h2', { class: 'dialog-title' }, title),
      message && h('p', { class: 'dialog-message' }, message),
      body);
    const overlay = h('div', { class: 'overlay' }, panel);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    popScope = focus.pushScope(panel, { onBack: () => (close(null), true) });
  });
}

export function confirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return openDialog({
    title,
    message,
    build: (close) => h('div', { class: 'dialog-actions' },
      button(cancelLabel, { onClick: () => close(false) }),
      button(confirmLabel, { variant: danger ? 'danger' : 'primary', autofocus: true, onClick: () => close(true) })),
  }).then((value) => value === true);
}

export function alertDialog({ title, message, label = 'OK' }) {
  return openDialog({
    title,
    message,
    build: (close) => h('div', { class: 'dialog-actions' }, button(label, { variant: 'primary', autofocus: true, onClick: () => close(true) })),
  });
}

/** Asks for text. On Xbox the box opens the console keyboard when selected. */
export function promptDialog({ title, message, label, value = '', placeholder = '', kind = 'text', confirmLabel = 'OK' }) {
  return openDialog({
    title,
    message,
    build: (close) => {
      const input = h('input', {
        class: 'text-input focusable',
        type: kind,
        value,
        placeholder,
        'aria-label': label || title,
        dataset: { autofocus: '' },
        autocomplete: 'off',
        spellcheck: false,
      });
      input.addEventListener('text-submit', () => close(input.value));
      return h('div', null,
        input,
        h('div', { class: 'dialog-actions' },
          button('Cancel', { onClick: () => close(null) }),
          button(confirmLabel, { variant: 'primary', onClick: () => close(input.value) })));
    },
  });
}

/**
 * A list of choices in a side panel (player menus, pickers). items: [{ label, description,
 * value, selected, icon }]. Resolves with the chosen item's value, or null.
 */
export function choicePanel({ title, items, side = 'right', footer }) {
  return new Promise((resolve) => {
    let popScope = null;
    const close = (value) => {
      if (popScope) popScope();
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 200);
      resolve(value === undefined ? null : value);
    };
    const list = h('div', { class: 'choice-list', 'data-scroll-y': '', 'data-scroll-center': '' });
    let selectedEl = null;
    for (const item of items) {
      if (item.header) {
        list.appendChild(h('div', { class: 'choice-header' }, item.header));
        continue;
      }
      const el = h('button', {
        class: ['choice', 'focusable', item.selected && 'selected'],
        type: 'button',
        onClick: () => close(item.value),
      },
      h('span', { class: 'choice-check' }, item.selected ? icon('check') : null),
      h('span', { class: 'choice-text' },
        h('span', { class: 'choice-label' }, item.label),
        item.description && h('span', { class: 'choice-description' }, item.description)),
      item.badge && h('span', { class: 'choice-badge' }, item.badge));
      if (item.selected && !selectedEl) selectedEl = el;
      list.appendChild(el);
    }
    const panel = h('div', { class: ['side-panel', `side-${side}`] },
      h('h2', { class: 'side-title' }, title),
      list,
      footer ? footer(close) : null);
    const overlay = h('div', { class: 'overlay overlay-side' }, panel);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    popScope = focus.pushScope(panel, { onBack: () => (close(null), true), initial: selectedEl || undefined });
  });
}

export function replaceChildren(el, ...children) {
  clear(el);
  for (const child of children.flat()) if (child) el.appendChild(child);
  return el;
}
