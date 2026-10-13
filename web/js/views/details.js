import { h, img, icon, clear } from '../core/dom.js';
import { focus } from '../core/focus.js';
import { events } from '../core/store.js';
import { formatRuntime, formatEpisodeCode, formatTimeLeft, formatAirs, typeLabel } from '../core/format.js';
import { fetchMeta, sortedVideos, seasonsOf, upNext, isReleased, yearText, genresOf } from '../services/meta.js';
import { inLibrary, toggleLibrary } from '../services/library.js';
import { getProgress, isWatched, markWatched, isCompleted } from '../services/progress.js';
import { playVideo } from '../services/navigation.js';
import { episodeCard } from '../components/cards.js';
import { button, chip, spinner, emptyState, choicePanel, toast } from '../components/ui.js';
import { router } from '../core/router.js';

export function detailsView({ params, state }) {
  const [type, rawId] = params;
  const id = rawId;
  const preview = state.preview || null;
  const backdropImg = h('div', { class: 'details-backdrop' });
  const body = h('div', { class: 'details-body' });
  const scroller = h('div', { class: 'view-scroll', 'data-scroll-y': '' }, body);
  const el = h('div', { class: 'details' }, backdropImg, h('div', { class: 'details-shade' }), scroller);
  const cleanups = [];
  let meta = null;
  let season = null;

  const setBackdrop = (url) => {
    if (url) backdropImg.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
  };

  function renderLoading() {
    clear(body);
    if (preview) {
      setBackdrop(preview.background);
      body.appendChild(heroBlock(preview, h('div', { class: 'details-actions' }, spinner('small'))));
    } else {
      body.appendChild(h('div', { class: 'center-fill' }, spinner()));
    }
  }

  function heroBlock(m, actions) {
    const facts = [
      yearText(m),
      formatRuntime(m.runtime),
      m.imdbRating && h('span', { class: 'rating' }, icon('star'), ` ${m.imdbRating}`),
      typeLabel(m.type),
    ].filter(Boolean);
    return h('section', { class: 'details-hero', 'data-nav-row': '', 'data-scroll-top': '' },
      m.logo ? img(m.logo, { class: 'details-logo', alt: m.name, loading: 'eager' }) : null,
      h('h1', { class: ['details-title', m.logo && 'has-logo'] }, m.name),
      h('div', { class: 'meta-line' }, facts.map((f) => h('span', null, f)), genresOf(m).slice(0, 4).map((g) => h('span', { class: 'genre' }, g))),
      m.description && h('p', { class: 'details-description' }, m.description),
      actions);
  }

  function playLabel() {
    if (type === 'movie') {
      const entry = getProgress(meta.id);
      if (entry && !isCompleted(entry) && entry.position > 30000) return { label: 'Resume', sub: formatTimeLeft(entry.duration - entry.position), video: null };
      return { label: 'Play', video: null };
    }
    const next = upNext(meta);
    if (!next.video) return { label: 'Play', video: null };
    const code = formatEpisodeCode(next.video.season, next.video.episode);
    if (next.resume) return { label: `Resume ${code}`, sub: formatTimeLeft(next.entry.duration - next.entry.position), video: next.video };
    return { label: `Play ${code}`, video: next.video };
  }

  function actionsBlock() {
    const play = playLabel();
    const saved = inLibrary(meta.id);
    const watched = type === 'movie' ? isWatched(meta.id) : false;
    const playButton = button(play.label, {
      variant: 'primary',
      icon: 'play',
      autofocus: true,
      onClick: () => playVideo(meta, play.video),
    });
    if (play.sub) playButton.appendChild(h('span', { class: 'btn-sub' }, play.sub));
    const libraryButton = button(saved ? 'In Library' : 'Add to Library', {
      icon: saved ? 'bookmark-filled' : 'bookmark',
      onClick: () => {
        const now = toggleLibrary(meta);
        toast(now ? 'Added to your library' : 'Removed from your library');
        refreshActions();
      },
    });
    const watchedButton = type === 'movie'
      ? button(watched ? 'Watched' : 'Mark Watched', {
        icon: watched ? 'check' : 'eye',
        onClick: () => {
          markWatched(meta.id, null, null, !watched, { title: meta.name, type: meta.type });
          refreshActions();
        },
      })
      : null;
    const trailerId = ((meta.trailers || []).find((t) => t && t.source) || {}).source ||
      ((meta.trailerStreams || []).find((t) => t && t.ytId) || {}).ytId;
    return h('div', { class: 'details-actions', 'data-nav-group': '' }, playButton, libraryButton, watchedButton,
      trailerId ? button('Trailer', { icon: 'movie', onClick: () => openTrailer(trailerId) }) : null);
  }

  function refreshActions() {
    const old = body.querySelector('.details-actions');
    if (!old) return;
    const hadFocus = old.contains(focus.current);
    const index = hadFocus ? [...old.children].indexOf(focus.current) : 0;
    const next = actionsBlock();
    old.replaceWith(next);
    if (hadFocus) focus.set(next.children[index] || next.firstChild);
  }

  function render() {
    clear(body);
    setBackdrop(meta.background || (preview && preview.background));
    body.appendChild(heroBlock(meta, actionsBlock()));
    if (type !== 'movie' && sortedVideos(meta).length) {
      body.appendChild(episodesBlock());
    }
    const credits = [
      ['Cast', meta.cast],
      ['Director', meta.director],
      ['Writer', meta.writer],
    ].filter(([, list]) => Array.isArray(list) && list.length);
    if (credits.length) {
      body.appendChild(h('section', { class: 'details-credits' },
        credits.map(([label, list]) => h('div', { class: 'credit' }, h('span', { class: 'credit-label' }, label), h('span', null, list.slice(0, 8).join(', '))))));
    }
  }

  function episodesBlock() {
    const seasons = seasonsOf(meta);
    if (season == null || !seasons.includes(season)) {
      const next = upNext(meta);
      season = next.video ? next.video.season : seasons[0];
    }
    const chips = h('div', { class: 'season-chips', 'data-scroll-x': '', 'data-nav-group': '' },
      seasons.map((s) => {
        const c = chip(s === 0 ? 'Specials' : `Season ${s}`, { selected: s === season, onClick: () => selectSeason(s) });
        c.dataset.season = s;
        return c;
      }));
    const track = h('div', { class: 'row-track', 'data-scroll-x': '', 'data-nav-group': '' });
    fillEpisodes(track);
    return h('div', { class: 'details-episodes' },
      h('section', { class: 'row', 'data-nav-row': '' }, h('header', { class: 'row-header' }, h('h2', { class: 'row-title' }, 'Episodes')), chips),
      h('section', { class: 'row row-episodes', 'data-nav-row': '' }, track));
  }

  function fillEpisodes(track) {
    clear(track);
    const videos = sortedVideos(meta).filter((v) => v.season === season);
    const next = upNext(meta);
    let focusTarget = null;
    for (const video of videos) {
      const entry = getProgress(meta.id, video.season, video.episode);
      const watched = isWatched(meta.id, video.season, video.episode);
      const card = episodeCard(video, {
        watched,
        progress: entry && entry.duration ? entry.position / entry.duration : 0,
        unreleased: isReleased(video) ? null : formatAirs(video.released),
        onClick: () => playVideo(meta, video),
      });
      card.__video = video;
      if (next.video && next.video.id === video.id) focusTarget = card;
      track.appendChild(card);
    }
    // Opening a season lands on the episode to watch next.
    if (focusTarget) focus.remember(track, focusTarget);
  }

  function selectSeason(s) {
    if (s === season) return;
    season = s;
    for (const c of body.querySelectorAll('.season-chips .chip')) c.classList.toggle('selected', Number(c.dataset.season) === s);
    const track = body.querySelector('.row-episodes .row-track');
    if (track) {
      fillEpisodes(track);
      track.scrollLeft = 0;
    }
  }

  async function load() {
    renderLoading();
    try {
      meta = await fetchMeta(type, id);
      if (preview) {
        // Catalog previews sometimes have better artwork than the meta addon.
        meta.logo = meta.logo || preview.logo;
        meta.background = meta.background || preview.background;
        meta.poster = meta.poster || preview.poster;
      }
      render();
      focus.restore(el);
    } catch (error) {
      clear(body);
      body.appendChild(h('div', { class: 'center-fill' }, emptyState({
        icon: 'warning',
        title: 'Failed to load',
        message: error.message || 'Could not load details from any addon.',
        actions: [button('Retry', { variant: 'primary', icon: 'refresh', onClick: load }), button('Back', { onClick: () => router.back() })],
      })));
      focus.restore(el);
    }
  }

  // Y / Menu on an episode: watched options.
  cleanups.push(events.on('nav:action', async ({ action }) => {
    if (el.hidden || (action !== 'menu' && action !== 'y')) return;
    const video = focus.current && focus.current.__video;
    if (!video || !meta) return;
    const watched = isWatched(meta.id, video.season, video.episode);
    const seasonName = video.season === 0 ? 'Specials' : `Season ${video.season}`;
    const choice = await choicePanel({
      title: `${formatEpisodeCode(video.season, video.episode)} ${video.name || ''}`,
      items: [
        { label: 'Play', value: 'play' },
        { label: watched ? 'Mark as unwatched' : 'Mark as watched', value: 'toggle' },
        { label: 'Mark previous as watched', value: 'previous' },
        { label: `Mark ${seasonName} as watched`, value: 'season' },
        { label: `Mark ${seasonName} as unwatched`, value: 'season-off' },
      ],
    });
    if (choice === 'play') playVideo(meta, video);
    else if (choice === 'toggle') markWatched(meta.id, video.season, video.episode, !watched, { title: meta.name, type: meta.type });
    else if (choice === 'previous' || choice === 'season' || choice === 'season-off') {
      const value = choice !== 'season-off';
      for (const v of sortedVideos(meta)) {
        const inScope = choice === 'previous'
          ? (v.season > 0 && (v.season < video.season || (v.season === video.season && v.episode < video.episode)))
          : v.season === video.season;
        if (inScope && isReleased(v)) markWatched(meta.id, v.season, v.episode, value, { title: meta.name, type: meta.type });
      }
    }
  }));

  let stale = false;
  const markStale = () => {
    if (el.hidden) stale = true;
    else if (meta) refreshAll();
  };
  const refreshAll = () => {
    refreshActions();
    const track = body.querySelector('.row-episodes .row-track');
    if (track) {
      const focusedId = focus.current && focus.current.__video && focus.current.__video.id;
      fillEpisodes(track);
      if (focusedId) {
        const card = [...track.children].find((c) => c.__video && c.__video.id === focusedId);
        if (card) focus.set(card, { scroll: false });
      }
    }
  };
  cleanups.push(events.on('progress', markStale), events.on('watched', markStale), events.on('library', markStale));

  load();

  return {
    el,
    chrome: 'none',
    onShow() {
      if (stale && meta) {
        stale = false;
        refreshAll();
      }
    },
    destroy() {
      cleanups.forEach((off) => off());
    },
  };
}

function openTrailer(ytId) {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(ytId)}`;
  import('../core/bridge.js').then(({ bridge }) => {
    if (bridge.native) bridge.send('app.openExternal', { url });
    else window.open(url, '_blank', 'noopener');
  });
}
