import { h, img, icon, clear, append } from '../core/dom.js';
import { focus } from '../core/focus.js';
import { router } from '../core/router.js';
import { settings } from '../core/store.js';
import { formatEpisodeCode } from '../core/format.js';
import { streamAddons, fetchStreams, addonName } from '../services/addons.js';
import { fetchMeta, sortedVideos } from '../services/meta.js';
import { describeStream, sortStreams, isPlayable } from '../services/streams.js';
import { parseVideoId } from '../services/progress.js';
import { chip, spinner, emptyState, button, toast } from '../components/ui.js';
import { debridAccount, debridName, resolveTorrent, DEBRID_PROVIDERS } from '../services/debrid.js';

export function streamsView({ params, state }) {
  const [type, id, videoIdParam] = params;
  const videoId = videoIdParam || id;
  let meta = state.meta || null;
  let video = state.video || null;

  const backdrop = h('div', { class: 'details-backdrop dim' });
  const info = h('aside', { class: 'streams-info' });
  const filters = h('div', { class: 'stream-filters', 'data-scroll-x': '', 'data-nav-group': '' });
  const list = h('div', { class: 'stream-list', 'data-scroll-y': '', 'data-nav-group': '' });
  const status = h('div', { class: 'streams-status' });
  const el = h('div', { class: 'streams' }, backdrop, h('div', { class: 'details-shade' }),
    h('div', { class: 'streams-layout' }, info, h('main', { class: 'streams-main' }, filters, status, list)));

  const entries = []; // { addon, stream, info, order }
  const addonState = new Map(); // transportUrl -> { addon, status: 'loading' | 'done' | 'error', count, error }
  let filter = 'all';
  let firstRender = true;
  let closed = false;

  function renderInfo() {
    clear(info);
    if (!meta) return;
    if (meta.background) backdrop.style.backgroundImage = `url("${meta.background.replace(/"/g, '%22')}")`;
    append(info, [
      meta.logo ? img(meta.logo, { class: 'streams-logo', alt: meta.name, loading: 'eager' }) : h('h1', { class: 'streams-title' }, meta.name),
      video && h('div', { class: 'streams-episode' },
        h('span', { class: 'streams-code' }, formatEpisodeCode(video.season, video.episode)),
        video.name || video.title ? h('span', null, video.name || video.title) : null),
      video && video.thumbnail ? img(video.thumbnail, { class: 'streams-thumb' }) : null,
      h('p', { class: 'streams-description' }, (video && (video.overview || video.description)) || meta.description || '')]);
  }

  // Torrent results play through the user's debrid service when one is connected.
  const debrid = debridAccount();
  const canPlay = (e) => e.info.kind === 'http' || (e.info.kind === 'torrent' && !!debrid);

  function visibleEntries() {
    const showAll = settings.get('showUnsupportedStreams');
    let shown = entries.filter((e) => showAll || canPlay(e));
    if (filter !== 'all') shown = shown.filter((e) => e.addon.transportUrl === filter);
    return sortStreams(shown, settings.get('streamSort'));
  }

  function renderFilters() {
    const showAll = settings.get('showUnsupportedStreams');
    const counts = new Map();
    for (const e of entries) {
      if (!showAll && !canPlay(e)) continue;
      counts.set(e.addon.transportUrl, (counts.get(e.addon.transportUrl) || 0) + 1);
    }
    const focusedFilter = filters.contains(focus.current) ? focus.current.dataset.filter : null;
    clear(filters);
    const make = (key, label) => {
      const c = chip(label, { selected: filter === key, onClick: () => setFilter(key) });
      c.dataset.filter = key;
      return c;
    };
    filters.appendChild(make('all', 'All'));
    for (const [url, st] of addonState) {
      const count = counts.get(url) || 0;
      if (st.status === 'done' && !count) continue;
      const label = `${addonName(st.addon)}${st.status === 'loading' ? ' …' : ` (${count})`}`;
      filters.appendChild(make(url, label));
    }
    if (focusedFilter) {
      const again = [...filters.children].find((c) => c.dataset.filter === focusedFilter);
      if (again) focus.set(again, { scroll: false });
    }
  }

  function setFilter(key) {
    filter = key;
    renderFilters();
    renderList(true);
  }

  function renderStatus() {
    const states = [...addonState.values()];
    const loading = states.filter((s) => s.status === 'loading');
    const hidden = entries.filter((e) => !canPlay(e)).length;
    const parts = [];
    if (loading.length) parts.push(h('span', { class: 'status-loading' }, spinner('tiny'), `Loading from ${loading.map((s) => addonName(s.addon)).join(', ')}`));
    if (hidden && !settings.get('showUnsupportedStreams')) {
      parts.push(h('span', null, `${hidden} torrent result${hidden === 1 ? '' : 's'} hidden: connect a debrid service in Settings, or set one up in your addon, to play them here.`));
    }
    const failed = states.filter((s) => s.status === 'error');
    if (failed.length) parts.push(h('span', { class: 'status-error' }, `${failed.map((s) => addonName(s.addon)).join(', ')} failed to respond.`));
    clear(status).append(...parts);
  }

  function renderList(reset = false) {
    const shown = visibleEntries();
    const focusedEntry = list.contains(focus.current) ? focus.current.__entry : null;
    const scroll = list.scrollTop;
    clear(list);
    if (!shown.length) {
      const stillLoading = [...addonState.values()].some((s) => s.status === 'loading');
      if (stillLoading) list.appendChild(h('div', { class: 'center-fill' }, spinner()));
      else list.appendChild(emptyState({
        icon: 'warning',
        title: addonState.size ? 'No streams found' : 'No stream addons',
        message: addonState.size
          ? 'None of your addons returned a playable link for this. Debrid addons (Torrentio, Comet, AIOStreams with Real-Debrid, TorBox, AllDebrid...) give direct links that play here.'
          : 'Install an addon that provides streams, such as Torrentio or AIOStreams configured with your debrid service.',
        actions: [button('Manage Addons', { icon: 'puzzle', onClick: () => router.go('settings/addons') })],
      }));
      return;
    }
    let refocus = null;
    for (const entry of shown) {
      const item = streamItem(entry);
      if (entry === focusedEntry) refocus = item;
      list.appendChild(item);
    }
    if (!reset) list.scrollTop = scroll;
    if (refocus) focus.set(refocus, { scroll: false });
    else if (firstRender && !closed) {
      firstRender = false;
      // Land on the first result once some arrive, unless the user already moved.
      if (!focus.current || !el.contains(focus.current) || filters.contains(focus.current)) focus.set(list.firstChild);
    }
  }

  function streamItem(entry) {
    const { info: d } = entry;
    const playable = canPlay(entry);
    const side = [];
    if (d.kind === 'torrent' && debrid) side.push(h('span', { class: 'stream-debrid' }, `via ${DEBRID_PROVIDERS[debrid.provider].short}`));
    if (d.cached) side.push(h('span', { class: 'stream-cached' }, icon('bolt'), d.debrid ? d.debrid + '+' : 'Cached'));
    else if (d.debrid) side.push(h('span', { class: 'stream-debrid' }, d.debrid));
    if (d.sizeText) side.push(h('span', { class: 'stream-size' }, d.sizeText));
    if (!playable) side.push(h('span', { class: 'stream-unsupported' }, d.kind === 'torrent' ? 'Torrent' : 'Not playable'));
    const item = h('button', {
      class: ['stream-item', 'focusable', !playable && 'disabled'],
      type: 'button',
      onClick: (e) => play(entry, e.currentTarget),
    },
    h('div', { class: 'stream-addon' },
      d.resolution && h('span', { class: 'stream-res' }, d.resolution),
      h('span', { class: 'stream-addon-name' }, d.addonName)),
    h('div', { class: 'stream-main' },
      h('div', { class: 'stream-name' }, d.name),
      d.detail && h('div', { class: 'stream-detail' }, d.detail),
      d.badges.length ? h('div', { class: 'stream-badges' }, d.badges.map((b) => h('span', { class: 'badge' }, b))) : null),
    side.length ? h('div', { class: 'stream-side' }, side) : null);
    item.__entry = entry;
    return item;
  }

  let resolving = false;

  async function play(entry, item) {
    if (resolving) return;
    let stream = { ...entry.stream, addonUrl: entry.addon.transportUrl, addonName: entry.info.addonName };
    if (!isPlayable(entry.stream)) {
      if (entry.info.kind !== 'torrent' || !debrid) {
        toast(entry.info.kind === 'torrent'
          ? 'Torrents can\'t be played on this device. Connect a debrid service in Settings, or use one in your addon.'
          : 'This link can\'t be played here.', { kind: 'error' });
        return;
      }
      // Ask the debrid service for a direct link to this torrent's file.
      resolving = true;
      if (item) item.classList.add('resolving');
      toast(`Resolving with ${debridName()}…`);
      try {
        const link = await resolveTorrent(entry.stream, { season: video ? video.season : null, episode: video ? video.episode : null });
        stream = {
          ...stream,
          url: link.url,
          behaviorHints: { ...(entry.stream.behaviorHints || {}), filename: link.filename || undefined, videoSize: link.size || undefined },
        };
      } catch (error) {
        toast(error.message, { kind: 'error', duration: 4000 });
        return;
      } finally {
        resolving = false;
        if (item) item.classList.remove('resolving');
      }
      if (closed) return;
    }
    const others = sortStreams(entries.filter((e) => e.info.kind === 'http'), settings.get('streamSort'))
      .map((e) => ({ ...e.stream, addonUrl: e.addon.transportUrl, addonName: e.info.addonName }))
      .filter((s) => s.url !== stream.url);
    router.go('player', { meta, video, stream, streams: [stream, ...others], restart: !!state.restart });
  }

  async function loadStreams() {
    const addons = streamAddons(type, videoId);
    for (const addon of addons) addonState.set(addon.transportUrl, { addon, status: 'loading' });
    renderFilters();
    renderStatus();
    renderList();
    await Promise.all(addons.map(async (addon, order) => {
      try {
        const streams = await fetchStreams(addon, type, videoId);
        if (closed) return;
        const name = addonName(addon);
        streams.forEach((stream, index) => entries.push({ addon, stream, info: describeStream(stream, name), order: order * 1000 + index }));
        // Keep addon order (then each addon's own order) no matter who answers first.
        entries.sort((a, b) => a.order - b.order);
        addonState.set(addon.transportUrl, { addon, status: 'done' });
      } catch (error) {
        if (closed) return;
        addonState.set(addon.transportUrl, { addon, status: 'error', error });
      }
      renderFilters();
      renderStatus();
      renderList();
    }));
  }

  async function init() {
    if (!meta || !meta.name) {
      try {
        meta = { ...(meta || {}), ...(await fetchMeta(type, id)) };
      } catch {
        meta = meta || { id, type, name: '' };
      }
    }
    if (!video && type !== 'movie' && videoId !== id) {
      const parsed = parseVideoId(videoId, type);
      video = sortedVideos(meta).find((v) => v.id === videoId) || { id: videoId, season: parsed.season, episode: parsed.episode };
    }
    renderInfo();
  }

  renderInfo();
  init();
  loadStreams();
  setTimeout(() => {
    if (!list.contains(focus.current)) focus.restore(filters);
  }, 0);

  return {
    el,
    chrome: 'none',
    destroy() {
      closed = true;
    },
  };
}
